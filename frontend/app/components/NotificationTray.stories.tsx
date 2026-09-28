import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

/**
 * NotificationTray stories.
 *
 * The component owns its own SSE connection and persisted state, so stories
 * use a thin wrapper that mocks the hook and renders only the dropdown panel —
 * the part users actually see — without opening a real EventSource.
 */

// ---------------------------------------------------------------------------
// Inline panel extracted from NotificationTray for isolated story rendering.
// We render the open tray directly instead of clicking the bell, so every
// story shows the correct state without requiring interaction.
// ---------------------------------------------------------------------------

interface PanelProps {
  notifications: Array<{ id: string; tradeId: string; newStatus: string; receivedAt: number }>;
  connectionState?: "open" | "connecting" | "reconnecting" | "failed" | "idle";
}

function connectionLabel(state: PanelProps["connectionState"]): string {
  switch (state) {
    case "open":         return "Live";
    case "connecting":   return "Connecting…";
    case "reconnecting": return "Reconnecting…";
    case "failed":       return "Disconnected";
    default:             return "Idle";
  }
}

function connectionTone(state: PanelProps["connectionState"]): string {
  switch (state) {
    case "open":         return "text-emerald-400";
    case "failed":       return "text-red-400";
    case "connecting":
    case "reconnecting": return "text-amber-400";
    default:             return "text-zinc-500";
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    locked:    "Trade locked",
    completed: "Trade completed",
    refunded:  "Trade refunded",
    disputed:  "Trade disputed",
    cancelled: "Trade cancelled",
  };
  return map[status] ?? `Trade ${status}`;
}

function TrayPanel({ notifications, connectionState = "open" }: PanelProps) {
  return (
    <div className="w-80 rounded-xl border border-white/10 bg-zinc-950 shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="text-sm font-semibold text-white">Notifications</span>
        <div className="flex items-center gap-2">
          <span
            role="status"
            aria-live="polite"
            className={`text-[10px] uppercase tracking-wide ${connectionTone(connectionState)}`}
          >
            {connectionLabel(connectionState)}
          </span>
          {notifications.length > 0 && (
            <button type="button" className="text-[11px] text-zinc-400 hover:text-zinc-200">
              Clear
            </button>
          )}
        </div>
      </div>

      <ul className="max-h-80 overflow-y-auto">
        {notifications.length === 0 ? (
          <li className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <svg
              className="h-8 w-8 text-zinc-600"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-xs font-medium text-zinc-400">
              You&#39;re all caught up &mdash; no new notifications.
            </p>
          </li>
        ) : (
          notifications.map((n) => (
            <li key={n.id} className="border-b border-white/5 last:border-0">
              <div className="block px-4 py-3 transition-colors hover:bg-white/5 cursor-pointer">
                <p className="text-sm text-zinc-100">{statusLabel(n.newStatus)}</p>
                <p className="mt-0.5 text-[11px] text-zinc-500">
                  Trade {n.tradeId.slice(0, 8)}… · {new Date(n.receivedAt).toLocaleTimeString()}
                </p>
              </div>
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
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta: Meta<typeof TrayPanel> = {
  title: "Components/NotificationTray",
  component: TrayPanel,
  tags: ["autodocs"],
  parameters: {
    // Dark panel needs a dark canvas for accurate visual review.
    backgrounds: { default: "dark" },
    layout: "centered",
  },
  argTypes: {
    connectionState: {
      control: { type: "select" },
      options: ["open", "connecting", "reconnecting", "failed", "idle"],
      description: "Simulated SSE connection state",
    },
  },
};

export default meta;
type Story = StoryObj<typeof TrayPanel>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** Empty tray — the "all caught up" state with no notifications. */
export const Empty: Story = {
  name: "Empty state",
  args: {
    notifications: [],
    connectionState: "open",
  },
};

/** Empty tray on a dark canvas for dark-mode verification. */
export const EmptyDark: Story = {
  name: "Empty state (dark canvas)",
  args: {
    notifications: [],
    connectionState: "open",
  },
  parameters: {
    backgrounds: { default: "dark" },
  },
};

/** Tray populated with several trade status updates. */
export const WithNotifications: Story = {
  name: "With notifications",
  args: {
    connectionState: "open",
    notifications: [
      { id: "1", tradeId: "abc12345-0001", newStatus: "locked",    receivedAt: Date.now() - 30_000 },
      { id: "2", tradeId: "abc12345-0002", newStatus: "completed", receivedAt: Date.now() - 90_000 },
      { id: "3", tradeId: "abc12345-0003", newStatus: "disputed",  receivedAt: Date.now() - 200_000 },
    ],
  },
};

/** Tray shown while the SSE stream is reconnecting after a server restart. */
export const Reconnecting: Story = {
  args: {
    notifications: [],
    connectionState: "reconnecting",
  },
};

/** Tray shown after all reconnection attempts have been exhausted. */
export const Disconnected: Story = {
  args: {
    notifications: [],
    connectionState: "failed",
  },
};
