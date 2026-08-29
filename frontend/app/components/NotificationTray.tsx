"use client";

/**
 * Notification toasts and tray (Issue #24).
 *
 * Two surfaces over one source of truth: a transient toast for the moment a
 * status changes, and a persistent tray so a user who missed the toast — or
 * dismissed it — can still find out what happened.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  useTradeNotifications,
  type TradeNotification,
} from "../hooks/useTradeNotifications";

/** How long a toast stays on screen. */
const TOAST_TTL_MS = 6_000;

/** Most toasts visible at once, so a burst cannot cover the page. */
const MAX_VISIBLE_TOASTS = 3;

function statusLabel(status: string): string {
  switch (status) {
    case "locked":
      return "Trade locked";
    case "completed":
      return "Trade completed";
    case "refunded":
      return "Trade refunded";
    case "disputed":
      return "Trade disputed";
    case "cancelled":
      return "Trade cancelled";
    default:
      return `Trade ${status}`;
  }
}

function statusTone(status: string): string {
  switch (status) {
    case "completed":
      return "border-emerald-400/40 bg-emerald-500/10 text-emerald-100";
    case "disputed":
    case "cancelled":
      return "border-red-400/40 bg-red-500/10 text-red-100";
    case "refunded":
      return "border-amber-400/40 bg-amber-500/10 text-amber-100";
    default:
      return "border-sky-400/40 bg-sky-500/10 text-sky-100";
  }
}

export function NotificationTray(): JSX.Element {
  const [toasts, setToasts] = useState<TradeNotification[]>([]);
  const [open, setOpen] = useState(false);

  const handleNotify = useCallback((notification: TradeNotification) => {
    setToasts((prev) => [notification, ...prev].slice(0, MAX_VISIBLE_TOASTS));
  }, []);

  const { notifications, unreadCount, connectionState, markAllRead, clearAll } =
    useTradeNotifications(handleNotify);

  // Expire toasts on a single interval rather than one timer per toast: a
  // timer per toast leaks if the component unmounts mid-flight, and the
  // cleanup for a growing set of them is easy to get wrong.
  useEffect(() => {
    if (toasts.length === 0) return;

    const interval = setInterval(() => {
      const cutoff = Date.now() - TOAST_TTL_MS;
      setToasts((prev) => prev.filter((t) => t.receivedAt > cutoff));
    }, 1_000);

    return () => clearInterval(interval);
  }, [toasts.length]);

  return (
    <>
      {/* ── Toasts ─────────────────────────────────────────────────────── */}
      <div
        className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col gap-2"
        // Announced politely: a trade update is worth hearing, but not worth
        // interrupting whatever a screen reader is currently saying.
        role="status"
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <Link
            key={toast.id}
            href={`/trades/${toast.tradeId}`}
            onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
            className={`pointer-events-auto w-72 rounded-lg border px-4 py-3 shadow-lg backdrop-blur transition-opacity hover:brightness-110 ${statusTone(
              toast.newStatus
            )}`}
          >
            <p className="text-sm font-semibold">{statusLabel(toast.newStatus)}</p>
            <p className="mt-0.5 text-xs opacity-80">
              Trade {toast.tradeId.slice(0, 8)}… · view details
            </p>
          </Link>
        ))}
      </div>

      {/* ── Tray ───────────────────────────────────────────────────────── */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setOpen((prev) => !prev);
            if (!open) markAllRead();
          }}
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : "Notifications"
          }
          aria-expanded={open}
          className="relative rounded-lg p-2 text-zinc-300 transition-colors hover:bg-white/10"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>

          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-white/10 bg-zinc-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
              <span className="text-sm font-semibold text-white">Notifications</span>
              <div className="flex items-center gap-2">
                {/* Surfaced rather than hidden: a user wondering why updates
                    stopped should be able to see that the stream dropped. */}
                <span
                  className={`text-[10px] uppercase tracking-wide ${
                    connectionState === "open"
                      ? "text-emerald-400"
                      : connectionState === "failed"
                        ? "text-red-400"
                        : "text-zinc-500"
                  }`}
                >
                  {connectionState}
                </span>
                {notifications.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-[11px] text-zinc-400 hover:text-zinc-200"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            <ul className="max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <li className="px-4 py-6 text-center text-xs text-zinc-500">
                  No notifications yet.
                </li>
              ) : (
                notifications.map((n) => (
                  <li key={n.id} className="border-b border-white/5 last:border-0">
                    <Link
                      href={`/trades/${n.tradeId}`}
                      onClick={() => setOpen(false)}
                      className="block px-4 py-3 transition-colors hover:bg-white/5"
                    >
                      <p className="text-sm text-zinc-100">{statusLabel(n.newStatus)}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        Trade {n.tradeId.slice(0, 8)}… ·{" "}
                        {new Date(n.receivedAt).toLocaleTimeString()}
                      </p>
                    </Link>
                  </li>
                ))
              )}
            </ul>

            {connectionState === "failed" && (
              <p className="border-t border-white/10 px-4 py-2 text-[11px] text-red-300">
                Live updates disconnected. Reload the page to reconnect.
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export default NotificationTray;
