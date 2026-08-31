import React from "react";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastProps {
  id?: string;
  type?: ToastType;
  message: string;
  onClose?: () => void;
}

const typeStyles: Record<ToastType, { bg: string; text: string; icon: string }> = {
  success: {
    bg: "bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800",
    text: "text-green-800 dark:text-green-200",
    icon: "text-green-500",
  },
  error: {
    bg: "bg-red-50 border-red-200 dark:bg-red-950/40 dark:border-red-800",
    text: "text-red-800 dark:text-red-200",
    icon: "text-red-500",
  },
  warning: {
    bg: "bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:border-amber-800",
    text: "text-amber-800 dark:text-amber-200",
    icon: "text-amber-500",
  },
  info: {
    bg: "bg-blue-50 border-blue-200 dark:bg-blue-950/40 dark:border-blue-800",
    text: "text-blue-800 dark:text-blue-200",
    icon: "text-blue-500",
  },
};

export function Toast({ type = "info", message, onClose }: ToastProps) {
  const style = typeStyles[type];

  return (
    <div
      role="alert"
      className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 shadow-lg ${style.bg} ${style.text} transition-all`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`text-base font-bold ${style.icon}`}>
          {type === "success" && "✓"}
          {type === "error" && "✕"}
          {type === "warning" && "⚠"}
          {type === "info" && "ℹ"}
        </span>
        <p className="text-sm font-medium">{message}</p>
      </div>

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss toast"
          className="ml-2 rounded-lg p-1 opacity-70 hover:opacity-100 focus:outline-none"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default Toast;
