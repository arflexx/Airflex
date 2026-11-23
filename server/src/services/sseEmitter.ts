import { Response } from "express";
import { cache } from "./cache";

/**
 * sseEmitter.ts — Lightweight Server-Sent Events (SSE) hub.
 *
 * Each authenticated client opens GET /api/v1/events and receives a persistent
 * text/event-stream connection. The server pushes trade status change events
 * without needing the client to poll.
 *
 * Persists connection state and buffered events per user in Redis (with a 5-minute TTL)
 * so that reconnecting clients replaying Last-Event-ID recover missed events (issue #619).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to write a keep-alive comment line to each connected client. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Default number of recent events retained per user for Last-Event-ID replay. */
export const DEFAULT_MAX_USER_EVENTS = 50;

/** TTL in seconds for buffered events in Redis (5 minutes). */
export const SSE_EVENT_TTL_SECONDS = 300;

/** Legacy alias for compatibility */
export const REPLAY_BUFFER_SIZE = DEFAULT_MAX_USER_EVENTS;

/** Queued-but-unsent bytes after which a connection is considered stalled. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** Resolves configurable max events per user. */
export function getMaxUserEvents(): number {
  const env = Number(process.env["SSE_MAX_USER_EVENTS"]);
  return Number.isSafeInteger(env) && env > 0 ? env : DEFAULT_MAX_USER_EVENTS;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

interface SseClient {
  userId: string;
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

export interface StoredUserEvent {
  id: number;
  event: SseEvent;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** All currently connected SSE clients. */
const clients: SseClient[] = [];

/** In-memory cache of events per user (synced with Redis). */
const userEventsMap = new Map<string, StoredUserEvent[]>();

/** Monotonically increasing event ID counter per user. */
const userCounterMap = new Map<string, number>();

/** Test helper: reset state */
function reset(): void {
  closeAll();
  userEventsMap.clear();
  userCounterMap.clear();
}

/**
 * Registers an Express Response as an SSE stream for the given user.
 */
function addClient(userId: string, res: Response, lastSeenEventId?: string): void {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx proxy buffering
    res.flushHeaders();
  }

  try {
    // Guide client reconnect timing if not already written
    res.write("retry: 3000\n\n");

    // Send an immediate confirmation so the client knows it is connected
    writeEvent(res, { type: "connected", userId });

    // Replay missed events
    replayMissed(userId, res, lastSeenEventId);
  } catch {
    // The socket died before the stream was set up (e.g. EPIPE). Don't
    // register it: a dead connection must never affect other consumers.
    try {
      res.end();
    } catch {
      // already closed
    }
    return;
  }

  // Heartbeat: a comment line every 30s prevents proxies from closing idle connections
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
      if (typeof (res as Response & { flush?: () => void }).flush === "function") {
        (res as Response & { flush: () => void }).flush();
      }
    } catch {
      // Client disconnected mid-write
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const client: SseClient = { userId, res, heartbeat };
  clients.push(client);

  res.on("close", () => removeClient(client));
}

/**
 * Next event ID for a given user.
 */
function nextEventIdForUser(userId: string): number {
  const current = userCounterMap.get(userId) ?? 0;
  const next = current + 1;
  userCounterMap.set(userId, next);
  return next;
}

/**
 * Stores an event for a user in the local buffer and Redis with a 5-minute TTL.
 */
function storeUserEvent(userId: string, id: number, event: SseEvent): void {
  const now = Date.now();
  const ttlMs = SSE_EVENT_TTL_SECONDS * 1000;
  const maxEvents = getMaxUserEvents();

  let events = userEventsMap.get(userId) ?? [];
  // Silently drop events older than the 5-minute TTL
  events = events.filter((e) => now - e.timestamp < ttlMs);

  events.push({ id, event, timestamp: now });
  if (events.length > maxEvents) {
    events = events.slice(events.length - maxEvents);
  }
  userEventsMap.set(userId, events);

  // Persist to Redis asynchronously
  void cache.set(`sse:events:${userId}`, JSON.stringify(events), SSE_EVENT_TTL_SECONDS).catch(() => undefined);
}

/**
 * Emits an SSE event to all connections belonging to the specified user IDs.
 * Increments event ID per user.
 */
function emit(userIds: string[], event: SseEvent): void {
  if (userIds.length === 0) return;
  for (const userId of userIds) {
    const id = nextEventIdForUser(userId);
    storeUserEvent(userId, id, event);

    for (const client of [...clients]) {
      if (client.userId === userId) {
        deliver(client, event, id);
      }
    }
  }
}

/**
 * Emits an SSE event to ALL currently connected clients and known users.
 */
function emitAll(event: SseEvent): void {
  const targetUserIds = new Set<string>();
  for (const client of clients) {
    targetUserIds.add(client.userId);
  }
  for (const userId of userEventsMap.keys()) {
    targetUserIds.add(userId);
  }
  for (const userId of userCounterMap.keys()) {
    targetUserIds.add(userId);
  }
  for (const userId of targetUserIds) {
    emit([userId], event);
  }
}

/** Returns the count of currently open SSE connections. */
function connectionCount(): number {
  return clients.length;
}

/** Ends every open stream and releases its heartbeat timer. */
function closeAll(): void {
  for (const client of [...clients]) {
    removeClient(client);
    try {
      client.res.end();
    } catch {
      // Already closed
    }
  }
}

/** Writes buffered events newer than `lastSeenEventId` that target `userId`. */
function replayMissed(userId: string, res: Response, lastSeenEventId?: string): void {
  if (lastSeenEventId === undefined || !/^\d+$/.test(lastSeenEventId)) return;
  const since = Number(lastSeenEventId);
  const now = Date.now();
  const ttlMs = SSE_EVENT_TTL_SECONDS * 1000;

  let events = userEventsMap.get(userId) ?? [];
  // Silently drop events older than the 5-minute TTL
  events = events.filter((e) => now - e.timestamp < ttlMs);
  userEventsMap.set(userId, events);

  for (const entry of events) {
    if (entry.id <= since) continue;
    writeEvent(res, entry.event, entry.id);
  }
}

/** Writes an event to one client, dropping the client if it has stalled. */
function deliver(client: SseClient, event: SseEvent, id: number): void {
  writeEvent(client.res, event, id);
  if ((client.res.writableLength ?? 0) > MAX_BUFFERED_BYTES) {
    removeClient(client);
    try {
      client.res.destroy();
    } catch {
      // Already closed
    }
  }
}

/** Unregisters a client and stops its heartbeat. */
function removeClient(client: SseClient): void {
  clearInterval(client.heartbeat);
  const idx = clients.indexOf(client);
  if (idx !== -1) clients.splice(idx, 1);
}

/**
 * Writes a single SSE message frame to the given response stream.
 */
function writeEvent(res: Response, event: SseEvent, id?: number): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (typeof (res as Response & { flush?: () => void }).flush === "function") {
      (res as Response & { flush: () => void }).flush();
    }
  } catch {
    // Client disconnected
  }
}

export const SseEmitter = {
  addClient,
  emit,
  emitAll,
  connectionCount,
  closeAll,
  reset,
} as const;
