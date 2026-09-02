"use client";

import { useState, useEffect, useRef, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { saveToken, saveUser } from "../../lib/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VerifyResponse {
  token?: string;
  user?: { id: string; phone: string; stellarPublicKey: string };
  error?: string;
  details?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Resend cooldown (60 s)
// ---------------------------------------------------------------------------

const RESEND_COOLDOWN_SECONDS = 60;

function useResendCooldown() {
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function start() {
    setSeconds(RESEND_COOLDOWN_SECONDS);
  }

  useEffect(() => {
    if (seconds <= 0) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [seconds]);

  return { cooldown: seconds, startCooldown: start };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VerifyPage() {
  const t = useTranslations("Auth");

  const [phone, setPhone]                   = useState("");
  const [otp, setOtp]                       = useState("");
  const [otpError, setOtpError]             = useState<string | null>(null);
  const [serverError, setServerError]       = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [loading, setLoading]               = useState(false);
  const [resending, setResending]           = useState(false);

  const { cooldown, startCooldown } = useResendCooldown();

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("phone");
    if (p) setPhone(decodeURIComponent(p));
  }, []);

  function validateOtp(value: string): string | null {
    if (!value.trim()) return t("otpRequired");
    if (!/^\d{6}$/.test(value.trim())) return t("otpInvalid");
    return null;
  }

  // ---------------------------------------------------------------------------
  // Verify OTP
  // ---------------------------------------------------------------------------
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);
    setSuccessMessage(null);

    const otpValidation = validateOtp(otp);
    if (otpValidation) {
      setOtpError(otpValidation);
      return;
    }
    setOtpError(null);

    if (!phone) {
      setServerError(t("phoneMissing"));
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${apiUrl}/api/v1/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, otp: otp.trim() }),
      });

      const data = (await res.json()) as VerifyResponse;

      if (!res.ok) {
        const detail = data.details
          ? Object.values(data.details).flat()[0]
          : data.error;
        setServerError(detail ?? t("verificationFailed"));
        return;
      }

      if (!data.token || !data.user) {
        setServerError(t("unexpectedResponse"));
        return;
      }

      saveToken(data.token);
      saveUser(data.user);

      setSuccessMessage(t("verified"));

      setTimeout(() => {
        window.location.href = "/";
      }, 1200);
    } catch {
      setServerError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Resend OTP
  // ---------------------------------------------------------------------------
  async function handleResend() {
    if (cooldown > 0 || resending) return;
    if (!phone) {
      setServerError(t("phoneMissing"));
      return;
    }

    setServerError(null);
    setResending(true);

    try {
      const res = await fetch(`${apiUrl}/api/v1/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setServerError(data.error ?? t("resendFailed"));
        return;
      }

      setSuccessMessage(t("newOtpSent"));
      startCooldown();
      setOtp("");
    } catch {
      setServerError(t("networkError"));
    } finally {
      setResending(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <>
      {/* Heading */}
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
          {t("enterOtp")}
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t("otpSentTo")}{" "}
          <span className="font-semibold text-gray-700 dark:text-gray-300">
            {phone || t("yourPhone")}
          </span>
          {t("otpExpiry")}
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        {/* OTP field */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="otp"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t("verificationCode")}
          </label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            maxLength={6}
            value={otp}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, "").slice(0, 6);
              setOtp(val);
              if (otpError) setOtpError(null);
              if (serverError) setServerError(null);
            }}
            disabled={loading || !!successMessage}
            aria-describedby={otpError ? "otp-error" : undefined}
            aria-invalid={otpError ? "true" : undefined}
            className={`w-full rounded-xl border px-4 py-3 text-center text-2xl font-bold tracking-[0.5em] text-gray-900 placeholder-gray-300 outline-none transition-colors focus:ring-2 focus:ring-violet-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 dark:text-gray-100 dark:placeholder-gray-600 dark:disabled:bg-gray-700 dark:disabled:text-gray-500 ${
              otpError
                ? "border-red-400 bg-red-50 focus:ring-red-400 dark:border-red-500 dark:bg-red-900/20"
                : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-gray-500"
            }`}
          />
          {otpError && (
            <p id="otp-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
              {otpError}
            </p>
          )}
        </div>

        {/* Server error banner */}
        {serverError && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            {serverError}
          </div>
        )}

        {/* Success banner */}
        {successMessage && (
          <div
            role="status"
            className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400"
          >
            {successMessage}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !!successMessage}
          className="mt-1 inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-violet-300 dark:focus-visible:ring-offset-gray-800 dark:disabled:bg-violet-800"
        >
          {loading ? (
            <>
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
              </svg>
              {t("verifying")}
            </>
          ) : (
            t("verifyOtp")
          )}
        </button>
      </form>

      {/* Resend */}
      <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
        {t("didntReceive")}{" "}
        <button
          type="button"
          onClick={handleResend}
          disabled={cooldown > 0 || resending || !!successMessage}
          className="font-semibold text-violet-600 hover:text-violet-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500 rounded disabled:cursor-not-allowed disabled:text-gray-400 dark:text-violet-400 dark:hover:text-violet-300 dark:disabled:text-gray-600"
        >
          {resending
            ? t("sending")
            : cooldown > 0
            ? t("resendIn", { seconds: cooldown })
            : t("resendOtp")}
        </button>
      </div>

      {/* Back link */}
      <p className="mt-4 text-center text-sm text-gray-400 dark:text-gray-500">
        {t("wrongNumber")}{" "}
        <a
          href="/auth/signup"
          className="font-semibold text-violet-600 hover:text-violet-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500 rounded dark:text-violet-400 dark:hover:text-violet-300"
        >
          {t("goBack")}
        </a>
      </p>
    </>
  );
}
