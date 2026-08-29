"use client";

import React, { useState } from "react";
import { getToken } from "../../../lib/auth";
import { Modal } from "../../../../components/ui/Modal";
import { Button } from "../../../../components/ui/Button";

export interface DisputeModalProps {
  /**
   * Whether the dispute modal is open.
   */
  isOpen: boolean;

  /**
   * Callback fired when closing the modal without submitting.
   */
  onClose: () => void;

  /**
   * Unique ID of the trade being disputed.
   */
  tradeId: string;

  /**
   * Callback fired when the dispute is successfully submitted to the server.
   */
  onDisputeSuccess: () => void;

  /**
   * Optional callback to emit error messages for external toast notifications.
   */
  onError?: (errorMessage: string) => void;
}

const MAX_REASON_CHARS = 500;

export function DisputeModal({
  isOpen,
  onClose,
  tradeId,
  onDisputeSuccess,
  onError,
}: DisputeModalProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const handleReasonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (val.length <= MAX_REASON_CHARS) {
      setReason(val);
      if (validationError) setValidationError(null);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    setReason("");
    setValidationError(null);
    onClose();
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    const trimmed = reason.trim();
    if (!trimmed) {
      setValidationError("Please describe why you are raising a dispute.");
      return;
    }

    if (trimmed.length > MAX_REASON_CHARS) {
      setValidationError(`Dispute reason cannot exceed ${MAX_REASON_CHARS} characters.`);
      return;
    }

    setIsSubmitting(true);
    setValidationError(null);

    const token = getToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    try {
      // Primary: POST /api/trades/:id/dispute as specified in criteria.
      // Fallback: `${apiUrl}/api/v1/trades/:id/dispute` if running against standalone backend.
      let res: Response;
      try {
        res = await fetch(`/api/trades/${encodeURIComponent(tradeId)}/dispute`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: trimmed }),
        });
        if (res.status === 404) {
          // If Next.js internal route isn't hit, try the backend API url
          res = await fetch(`${apiUrl}/api/v1/trades/${encodeURIComponent(tradeId)}/dispute`, {
            method: "POST",
            headers,
            body: JSON.stringify({ reason: trimmed }),
          });
        }
      } catch {
        res = await fetch(`${apiUrl}/api/v1/trades/${encodeURIComponent(tradeId)}/dispute`, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason: trimmed }),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errorMsg =
          data.error ||
          (res.status === 409
            ? "This trade has already been disputed."
            : "Failed to submit dispute. Please try again.");
        setValidationError(errorMsg);
        onError?.(errorMsg);
        return;
      }

      setReason("");
      onDisputeSuccess();
      onClose();
    } catch {
      const networkMsg = "Network error. Please check your connection and try again.";
      setValidationError(networkMsg);
      onError?.(networkMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Raise a Trade Dispute"
      description="Freeze escrow and request arbitration from the AirFlex team."
      maxWidth="max-w-lg"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={handleSubmit}
            isLoading={isSubmitting}
            loadingText="Filing Dispute…"
          >
            Confirm Dispute
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Dispute Explanation Banner */}
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300">
          <p className="font-semibold mb-1">Important consequences:</p>
          <ul className="list-disc list-inside space-y-0.5 opacity-90">
            <li>The Soroban escrow contract will be frozen to protect your funds.</li>
            <li>An AirFlex administrator will review on-chain logs and evidence within 24 hours.</li>
            <li>Both buyer and seller will receive notifications regarding updates.</li>
          </ul>
        </div>

        {/* Reason Textarea */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="dispute-reason-input"
              className="text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300"
            >
              Reason for dispute <span className="text-red-500">*</span>
            </label>
            <span
              className={`text-xs ${
                reason.length >= MAX_REASON_CHARS
                  ? "text-red-500 font-semibold"
                  : "text-gray-400 dark:text-gray-500"
              }`}
            >
              {`${reason.length}/${MAX_REASON_CHARS}`}
            </span>
          </div>

          <textarea
            id="dispute-reason-input"
            rows={4}
            maxLength={MAX_REASON_CHARS}
            value={reason}
            onChange={handleReasonChange}
            disabled={isSubmitting}
            placeholder="Explain what went wrong (e.g. airtime/data not received, wrong amount sent, seller unresponsive)..."
            aria-invalid={Boolean(validationError)}
            aria-describedby={validationError ? "dispute-error-msg" : undefined}
            className="w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-red-400"
          />

          {validationError && (
            <p
              id="dispute-error-msg"
              role="alert"
              className="text-xs font-medium text-red-600 dark:text-red-400"
            >
              {validationError}
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}

export default DisputeModal;
