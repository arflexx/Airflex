"use client";

/**
 * Global imperative toast notification system (#133).
 *
 * Distinct from NotificationTray (#24), which is a push-based UI for
 * server-driven trade status events specifically. This is a general
 * "call it from anywhere" feedback surface for ad hoc action feedback —
 * trade submitted, withdrawal failed, OTP sent, etc. NotificationTray is
 * untouched by this change.
 *
 * Renders using the existing <Toast> presentational component
 * (components/ui/Toast.tsx) rather than re-implementing its styling — that
 * component already covers the success/error/info/warning treatment this
 * issue asks for.
 */

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Toast, type ToastType } from "./ui/Toast";

const DEFAULT_DURATION_MS = 4_000;
const EXIT_TRANSITION_MS = 200;

interface ActiveToast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

export interface ToastContextValue {
  success: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

/** One toast's enter/exit lifecycle — plain Tailwind transition classes,
 * no animation library. Flips from a "hidden" state to a "visible" state on
 * the frame after mount (so the transition actually fires instead of
 * applying both states in the same render), and reverses on close before
 * telling the parent to actually remove it from the list. */
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ActiveToast;
  onDismiss: (id: string) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const requestClose = useCallback(() => {
    setVisible(false);
    setTimeout(() => onDismiss(toast.id), EXIT_TRANSITION_MS);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    if (toast.duration <= 0) return; // duration=0 means "stay until dismissed"
    const timer = setTimeout(requestClose, toast.duration);
    return () => clearTimeout(timer);
  }, [toast.duration, requestClose]);

  return (
    <div
      className={`transition-all duration-200 ease-out ${
        visible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-4"
      }`}
    >
      <Toast type={toast.type} message={toast.message} onClose={requestClose} />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const [mounted, setMounted] = useState(false);
  const nextId = useRef(0);

  // createPortal needs `document`, which doesn't exist during SSR — mirrors
  // the mounted-guard pattern already used in ThemeToggle.tsx.
  useEffect(() => setMounted(true), []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (type: ToastType, message: string, duration = DEFAULT_DURATION_MS) => {
      const id = `toast-${nextId.current++}`;
      setToasts((prev) => [...prev, { id, type, message, duration }]);
    },
    [],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (message, duration) => push("success", message, duration),
      error: (message, duration) => push("error", message, duration),
      info: (message, duration) => push("info", message, duration),
      warning: (message, duration) => push("warning", message, duration),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-live="polite"
            className="fixed top-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
          >
            {toasts.map((t) => (
              <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}