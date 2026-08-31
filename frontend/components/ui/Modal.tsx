import React, { useEffect, useRef, useCallback, useId } from "react";

export interface ModalProps {
  /**
   * Whether the modal dialog is currently open and visible.
   */
  isOpen: boolean;

  /**
   * Callback fired when the modal requests closure (via ESC key, backdrop click, or close button).
   */
  onClose: () => void;

  /**
   * Optional title displayed in the modal header.
   */
  title?: React.ReactNode;

  /**
   * Optional description text displayed under the title.
   */
  description?: React.ReactNode;

  /**
   * Main dialog contents.
   */
  children: React.ReactNode;

  /**
   * Optional footer actions (e.g. Cancel and Confirm buttons).
   */
  footer?: React.ReactNode;

  /**
   * Optional max width styling for the modal dialog.
   * @default "max-w-lg"
   */
  maxWidth?: string;

  /**
   * Whether clicking the backdrop closes the modal.
   * @default true
   */
  closeOnBackdropClick?: boolean;
}

/**
 * Accessible Modal dialog primitive with focus trap, ESC listener, ARIA role="dialog",
 * smooth backdrop transition, and dark mode support.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = "max-w-lg",
  closeOnBackdropClick = true,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // Handle ESC key to close
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      // Accessible Focus Trap
      if (e.key === "Tab" && modalRef.current) {
        const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusableElements.length) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement?.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", handleKeyDown);

      // Focus first focusable element or modal container
      requestAnimationFrame(() => {
        if (modalRef.current) {
          const focusable = modalRef.current.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          focusable ? focusable.focus() : modalRef.current.focus();
        }
      });
    } else {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    }

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto"
      role="region"
      aria-live="polite"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        aria-hidden="true"
        onClick={closeOnBackdropClick ? onClose : undefined}
      />

      {/* Dialog */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative z-10 w-full ${maxWidth} rounded-2xl border border-gray-100 bg-white p-6 shadow-2xl transition-all outline-none dark:border-gray-700 dark:bg-gray-800`}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            {title && (
              <h2
                id={titleId}
                className="text-lg font-bold text-gray-900 dark:text-gray-100"
              >
                {title}
              </h2>
            )}
            {description && (
              <p id={descId} className="text-sm text-gray-500 dark:text-gray-400">
                {description}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-violet-500 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body Content */}
        <div className="mt-4">{children}</div>

        {/* Footer */}
        {footer && <div className="mt-6 flex items-center justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

export default Modal;
