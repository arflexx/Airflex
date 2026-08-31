import { Response } from "express";

/**
 * sseEmitter.ts — Lightweight Server-Sent Events (SSE) hub.
 *
 * Each authenticated client opens GET /api/v1/events and receives a persistent
 * text/event-stream connection. The server pushes trade status change events
 * without needing the client to poll.
 *
 * SSE is chosen over WebSockets because:
 *  - It is unidirectional (server → client), which matches our use-case exactly.
 *  - It works over plain HTTP/1.1 with automatic reconnection built into browsers.
 *  - No extra library is needed; Express can write chunked responses natively.
 *
 * Usage
 * -----
 *  // Register a client connection (called from the /api/v1/events route):
 *  SseEmitter.addClient(userId, res);
 *
 *  // Push an event to specific users (called from tradeVerification):
 *  SseEmitter.emit(
 *    [sellerId, buyerId],
 *    { type: "trade_completed", tradeId: "...", status: "Completed" }
 *  );
 *
 *  // Push a broadcast admin alert:
 *  SseEmitter.emitAdmin({ type: "admin_alert", message: "..." });
 *
 * Heartbeat
 * ---------
 * While a client is connected the server writes an SSE comment line
 * (`: heartbeat`) every 30 seconds. Comment lines are ignored by EventSource
 * but keep the TCP connection alive through proxies and load balancers that
 * would otherwise close idle connections.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to write a keep-alive comment line to each connected client. */
const HEARTBEAT_INTERVAL_MS = 30_000;

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
}

// ---------------------------------------------------------------------------
// Module-level client registry
// ---------------------------------------------------------------------------

/** All currently connected SSE clients. */
const clients: SseClient[] = [];

/**
 * Registers an Express Response as an SSE stream for the given user.
 *
 * Sets the required headers and sends an initial "connected" event so the
 * client knows the stream is alive. Also removes the client from the registry
 * when the connection closes (browser tab closed, network drop, etc.).
 */
function addClient(userId: string, res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx proxy buffering
  res.flushHeaders();

  // Send an immediate confirmation so the client knows it is connected
  writeEvent(res, { type: "connected", userId });

  clients.push({ userId, res });

  // Heartbeat: a comment line every 30s prevents proxies from closing idle
  // connections. Per-client interval so it stops when this connection closes.
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
      if (typeof (res as Response & { flush?: () => void }).flush === "function") {
        (res as Response & { flush: () => void }).flush();
      }
    } catch {
      // Client disconnected mid-write — the "close" handler will clean up
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive just for an open SSE stream
  heartbeat.unref?.();

  // Clean up when the client disconnects
  res.on("close", () => {
    clearInterval(heartbeat);
    const idx = clients.findIndex((c) => c.res === res);
    if (idx !== -1) clients.splice(idx, 1);
  });
}

/**
 * Emits an SSE event to all connections belonging to the specified user IDs.
 * Safe to call with an empty array — it simply no-ops.
 */
function emit(userIds: string[], event: SseEvent): void {
  for (const { userId, res } of clients) {
    if (userIds.includes(userId)) {
      writeEvent(res, event);
    }
  }
}

/**
 * Emits an SSE event to ALL currently connected clients.
 * Used for admin alerts and system-wide broadcasts.
 */
function emitAll(event: SseEvent): void {
  for (const { res } of clients) {
    writeEvent(res, event);
  }
}

/** Returns the count of currently open SSE connections (useful for health checks). */
function connectionCount(): number {
  return clients.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Writes a single SSE message frame to the given response stream.
 *
 * SSE wire format:
 *   event: <type>\n
 *   data: <json>\n
 *   \n
 */
function writeEvent(res: Response, event: SseEvent): void {
  try {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Express will flush automatically for chunked encoding, but calling
    // flush() explicitly ensures delivery when response compression is active.
    if (typeof (res as Response & { flush?: () => void }).flush === "function") {
      (res as Response & { flush: () => void }).flush();
    }
  } catch {
    // Client disconnected mid-write — the "close" handler will clean up
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SseEmitter = {
  addClient,
  emit,
  emitAll,
  connectionCount,
} as const;
