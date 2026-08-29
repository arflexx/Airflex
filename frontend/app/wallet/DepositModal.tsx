"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/auth";
import { CurrencyInput } from "../../components/CurrencyInput";

// ---------------------------------------------------------------------------
// Paystack inline checkout (Issue #25)
//
// Paystack's popup is a script loaded from their CDN that attaches a global.
// It is loaded on demand rather than in the app shell: most sessions never
// deposit, and a payment provider's script is not something to put on every
// page load for everyone.
// ---------------------------------------------------------------------------

const PAYSTACK_SCRIPT_SRC = "https://js.paystack.co/v2/inline.js";

/** Smallest deposit Paystack will accept for this integration, in naira. */
export const MIN_DEPOSIT_NAIRA = 100;

interface PaystackPopup {
  resumeTransaction: (
    accessCode: string,
    callbacks?: {
      onSuccess?: (transaction: { reference?: string }) => void;
      onCancel?: () => void;
      onError?: (error: { message?: string }) => void;
    },
  ) => void;
}

declare global {
  interface Window {
    PaystackPop?: new () => PaystackPopup;
  }
}

interface InitializeResponse {
  access_code?: string;
  reference?: string;
  error?: string;
}

interface DepositModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called once the deposit has been confirmed, so the page can refresh. */
  onDepositSuccess: () => void;
}

type Status = "idle" | "initializing" | "awaiting_payment" | "confirming" | "success";

/** How long to keep polling for the credited balance before giving up. */
const CONFIRM_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Validate the amount field.
 *
 * Returns the reason it is invalid, or null when it is fine. Separated from the
 * component so the rules can be unit tested without rendering.
 */
export function validateDepositAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "Enter an amount to deposit.";

  // Reject anything that is not a plain decimal number. `Number()` alone would
  // happily accept "0x10", "1e5" and " 12 ", none of which a user meant to type.
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return "Enter a valid amount, for example 500 or 500.50.";
  }

  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "Enter a valid amount.";
  if (value < MIN_DEPOSIT_NAIRA) {
    return `The minimum deposit is ₦${MIN_DEPOSIT_NAIRA.toLocaleString()}.`;
  }

  return null;
}

/** Load the Paystack inline script once, reusing it across opens. */
export function loadPaystackScript(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Paystack can only load in the browser"));
  }
  if (window.PaystackPop) return Promise.resolve();

  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${PAYSTACK_SCRIPT_SRC}"]`,
  );
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("Could not load the Paystack checkout.")),
      );
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PAYSTACK_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the Paystack checkout."));
    document.body.appendChild(script);
  });
}

export default function DepositModal({
  isOpen,
  onClose,
  onDepositSuccess,
}: DepositModalProps) {
  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Timers are cleared on unmount and on close so a dismissed modal cannot keep
  // polling in the background.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    if (pollDeadline.current) clearTimeout(pollDeadline.current);
    pollTimer.current = null;
    pollDeadline.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // Reset when the modal is closed so it does not reopen showing the last
  // attempt's error or success.
  useEffect(() => {
    if (!isOpen) {
      stopPolling();
      setAmount("");
      setStatus("idle");
      setError(null);
    }
  }, [isOpen, stopPolling]);

  /**
   * Poll the wallet until the deposit lands.
   *
   * Paystack confirms to the browser before the webhook has necessarily reached
   * the server, so the balance is not guaranteed to be current the moment the
   * popup closes. Polling briefly closes that window without the UI claiming a
   * balance it has not seen.
   */
  const confirmDeposit = useCallback(() => {
    setStatus("confirming");
    stopPolling();

    pollTimer.current = setInterval(() => {
      onDepositSuccess();
    }, POLL_INTERVAL_MS);

    pollDeadline.current = setTimeout(() => {
      stopPolling();
      setStatus("success");
      onDepositSuccess();
    }, CONFIRM_TIMEOUT_MS);
  }, [onDepositSuccess, stopPolling]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const invalid = validateDepositAmount(amount);
    if (invalid) {
      setError(invalid);
      return;
    }

    const token = getToken();
    if (!token) {
      setError("Your session has expired. Please sign in again.");
      return;
    }

    setStatus("initializing");

    try {
      const response = await fetch(`${apiUrl}/api/wallet/deposit/initialize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: Number(amount) }),
      });

      const data = (await response.json()) as InitializeResponse;

      if (!response.ok || !data.access_code) {
        throw new Error(data.error ?? "Could not start the deposit. Please try again.");
      }

      await loadPaystackScript();
      if (!window.PaystackPop) {
        throw new Error("Could not load the Paystack checkout.");
      }

      setStatus("awaiting_payment");

      const popup = new window.PaystackPop();
      popup.resumeTransaction(data.access_code, {
        onSuccess: () => confirmDeposit(),
        // Dismissal and failure both leave the modal open with an explanation:
        // closing it would lose the amount the user already typed.
        onCancel: () => {
          setStatus("idle");
          setError("Payment cancelled. Your wallet has not been charged.");
        },
        onError: (err) => {
          setStatus("idle");
          setError(err?.message ?? "The payment could not be completed. Please try again.");
        },
      });
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    }
  }

  if (!isOpen) return null;

  const busy = status === "initializing" || status === "awaiting_payment" || status === "confirming";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="deposit-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-start justify-between">
          <h2
            id="deposit-modal-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Deposit Funds
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close deposit dialog"
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        {status === "success" ? (
          <div className="py-6 text-center" data-testid="deposit-success">
            <p className="text-base font-semibold text-green-600 dark:text-green-400">
              Deposit successful
            </p>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Your wallet balance has been updated.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <label
              htmlFor="deposit-amount"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Amount
            </label>
            <CurrencyInput
              id="deposit-amount"
              name="amount"
              value={amount}
              min={MIN_DEPOSIT_NAIRA}
              onChange={(val) => {
                setAmount(val ? String(val) : "");
                if (error) setError(null);
              }}
              placeholder={`${MIN_DEPOSIT_NAIRA}`}
              disabled={busy}
            />
            <p
              id="deposit-amount-hint"
              className="mt-1 text-xs text-gray-500 dark:text-gray-400"
            >
              Minimum deposit ₦{MIN_DEPOSIT_NAIRA.toLocaleString()} (NGN)
            </p>

            {error && (
              <p
                role="alert"
                data-testid="deposit-error"
                className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
              >
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {status === "initializing" && "Starting…"}
              {status === "awaiting_payment" && "Waiting for payment…"}
              {status === "confirming" && "Confirming…"}
              {status === "idle" && "Continue to Payment"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
