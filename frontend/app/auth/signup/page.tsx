"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SignupPage() {
  const t = useTranslations("Auth");

  const [phone, setPhone] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  function validatePhone(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return t("phoneRequired");
    if (!/^\+?[1-9]\d{9,14}$/.test(trimmed)) {
      return t("phoneInvalid");
    }
    return null;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    const phoneError = validatePhone(phone);
    if (phoneError) {
      setFieldError(phoneError);
      return;
    }
    setFieldError(null);
    setLoading(true);

    try {
      const res = await fetch(`${apiUrl}/api/v1/auth/request-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });

      const data = (await res.json()) as {
        message?: string;
        error?: string;
        details?: Record<string, string[]>;
      };

      if (!res.ok) {
        const detail = data.details
          ? Object.values(data.details).flat()[0]
          : data.error;
        setServerError(detail ?? t("somethingWentWrong"));
        return;
      }

      const encoded = encodeURIComponent(phone.trim());
      window.location.href = `/auth/verify?phone=${encoded}`;
    } catch {
      setServerError(t("networkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Heading */}
      <div className="mb-8">
        <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
          {t("createAccount")}
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Enter your phone number and we&apos;ll send a 6-digit OTP to verify it.
        </p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
        {/* Phone field */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="phone"
            className="text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            {t("phoneNumber")}
          </label>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            placeholder="+2348012345678"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              if (fieldError) setFieldError(null);
            }}
            disabled={loading}
            aria-describedby={fieldError ? "phone-error" : undefined}
            aria-invalid={fieldError ? "true" : undefined}
            className={`w-full rounded-xl border px-4 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none transition-colors focus:ring-2 focus:ring-violet-500 disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400 dark:text-gray-100 dark:placeholder-gray-500 dark:disabled:bg-gray-700 dark:disabled:text-gray-500 ${
              fieldError
                ? "border-red-400 bg-red-50 focus:ring-red-400 dark:border-red-500 dark:bg-red-900/20"
                : "border-gray-200 bg-white hover:border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-gray-500"
            }`}
          />
          {fieldError && (
            <p id="phone-error" role="alert" className="text-xs text-red-600 dark:text-red-400">
              {fieldError}
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

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
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
              {t("sendingOtp")}
            </>
          ) : (
            t("sendOtp")
          )}
        </button>
      </form>

      {/* Sign-in link */}
      <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
        {t("alreadyHaveAccount")}{" "}
        <Link
          href="/auth/verify"
          className="font-semibold text-violet-600 hover:text-violet-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-500 rounded dark:text-violet-400 dark:hover:text-violet-300"
        >
          {t("signIn")}
        </Link>
      </p>
    </>
  );
}