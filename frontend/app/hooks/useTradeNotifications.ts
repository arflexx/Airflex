"use client";

/**
 * Real-time trade status notifications (Issue #24).
 *
 * Connects to the server's SSE stream and surfaces status transitions as they
 * happen, so a user watching a trade does not have to refresh to learn it was
 * locked or completed.
 *
 * # Why SSE rather than WebSockets
 *
 * The traffic is one-directional: the server tells the client a trade moved,
 * and the client never pushes back over the same channel. SSE gives that for
 * free over plain HTTP — it reconnects on its own, survives proxies that mangle
 * WebSocket upgrades (common on mobile networks), and needs no separate
 * server-side connection lifecycle. The repo already has an `sseEmitter`
 * service, so this consumes what exists.
 *
 * # Why reconnection is hand-rolled
 *
 * `EventSource` retries automatically, but at a fixed interval and forever. On
 * a server outage that means every client hammering it at the same cadence,
 * which is precisely when it can least afford the load. The native retry is
 * therefore disabled (by closing the stream on error) and replaced with capped
 * exponential backoff plus jitter, and a bounded number of attempts.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useAuth } from "./useAuth";

/** A trade status change pushed by the server. */
export interface TradeNotification {
  id: string;
  tradeId: string;
  newStatus: string;
  receivedAt: number;
  read: boolean;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "failed" | "idle";

export interface UseTradeNotificationsResult {
  notifications: TradeNotification[];
  unreadCount: number;
  connectionState: ConnectionState;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

/** Reconnection attempts made after an error before the stream is given up on. */
export const MAX_RETRIES = 10;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;

/**
 * Share of the delay that jitter may add on top of the schedule.
 *
 * Kept small deliberately: the schedule below is the contract (1s, 2s, 4s …
 * capped at 30s) and jitter only smears the arrival times of clients that were
 * all disconnected by the same event.
 */
const JITTER_RATIO = 0.1;

/** Cap on the retained tray, so a long session cannot grow without bound. */
const MAX_TRAY_ENTRIES = 50;

const STORAGE_KEY = "airflex.notifications";

/**
 * Exponential backoff with jitter.
 *
 * The schedule doubles from `BASE_DELAY_MS` and is capped at `MAX_DELAY_MS`:
 * 1s, 2s, 4s, 8s, 16s, then 30s for every attempt after that.
 *
 * On top of that sits a small amount of jitter. Without it, every client
 * disconnected by the same server restart retries in lockstep and arrives as a
 * synchronised thundering herd; randomising spreads the reconnection out. It is
 * additive and capped so it never pushes a delay past `MAX_DELAY_MS`.
 */
export function backoffDelay(attempt: number): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  const jitter = Math.random() * exponential * JITTER_RATIO;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

function loadPersisted(): TradeNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TradeNotification[]) : [];
  } catch {
    // Corrupt or unavailable storage (private mode, cleared site data) must
    // not stop notifications working - the tray is a convenience.
    return [];
  }
}

function persist(entries: TradeNotification[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or a blocking browser setting; not worth failing the UI over.
  }
}

export function useTradeNotifications(
  onNotify?: (notification: TradeNotification) => void
): UseTradeNotificationsResult {
  const { token } = useAuth();

  const [notifications, setNotifications] = useState<TradeNotification[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Held in a ref so a changing callback identity does not tear down and
  // rebuild the connection on every render.
  const onNotifyRef = useRef(onNotify);

  useEffect(() => {
    onNotifyRef.current = onNotify;
  }, [onNotify]);

  // Restore the tray once on mount.
  useEffect(() => {
    setNotifications(loadPersisted());
  }, []);

  const push = useCallback((tradeId: string, newStatus: string) => {
    const entry: TradeNotification = {
      id: `${tradeId}-${newStatus}-${Date.now()}`,
      tradeId,
      newStatus,
      receivedAt: Date.now(),
      read: false,
    };

    setNotifications((prev) => {
      const next = [entry, ...prev].slice(0, MAX_TRAY_ENTRIES);
      persist(next);
      return next;
    });

    onNotifyRef.current?.(entry);
  }, []);

  useEffect(() => {
    // No token means no stream to authenticate against; stay idle rather than
    // opening a connection that will be rejected and retried ten times.
    if (!token) {
      setConnectionState("idle");
      return;
    }

    let cancelled = false;

    // A fresh token is a fresh stream: start its budget at zero so a session
    // that previously exhausted its attempts is not stuck in "failed".
    retryRef.current = 0;

    const connect = (): void => {
      if (cancelled) return;

      setConnectionState(retryRef.current === 0 ? "connecting" : "reconnecting");

      // EventSource cannot set headers, so the token goes in the query string.
      // Acceptable for a same-origin GET; the server treats it as a bearer.
      const url = `/api/v1/events?token=${encodeURIComponent(token)}`;
      const source = new EventSource(url);
      sourceRef.current = source;

      source.onopen = () => {
        if (cancelled) return;
        // Reset only on a *successful* open, so a flapping connection still
        // backs off rather than retrying at full speed forever.
        retryRef.current = 0;
        setConnectionState("open");
      };

      source.onmessage = (event: MessageEvent<string>) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            tradeId?: string;
            newStatus?: string;
          };
          if (payload.type === "trade_status" && payload.tradeId && payload.newStatus) {
            push(payload.tradeId, payload.newStatus);
          }
        } catch {
          // A malformed frame is not worth dropping the stream over.
        }
      };

      source.onerror = () => {
        if (cancelled) return;

        // Close before retrying. EventSource would otherwise reconnect on its
        // own schedule *as well as* ours, doubling the load we are trying to
        // reduce.
        source.close();
        sourceRef.current = null;

        if (retryRef.current >= MAX_RETRIES) {
          setConnectionState("failed");
          return;
        }

        const delay = backoffDelay(retryRef.current);
        retryRef.current += 1;
        setConnectionState("reconnecting");
        timerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    // Tear down both the stream and any scheduled retry. Missing the timer is
    // the subtle half: the EventSource would be closed but a pending timeout
    // would still fire and open a new one after unmount.
    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [token, push]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      persist(next);
      return next;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => {
      const next = prev.filter((n) => n.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    persist([]);
  }, []);

  return {
    notifications,
    unreadCount: notifications.filter((n) => !n.read).length,
    connectionState,
    markAllRead,
    dismiss,
    clearAll,
  };
}
