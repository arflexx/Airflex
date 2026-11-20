"use client";

import { useState, useEffect, type FormEvent, type ChangeEvent } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { getToken, isAuthenticated } from "../lib/auth";
import type { TradeOffer } from "../../../server/src/types/trade";
import { CurrencyInput } from "../../components/CurrencyInput";
import { toStroops } from "@airflex/shared/units";
import { getCachedConversionRate, setCachedConversionRate } from "./ratesCache";
import { OfflineOrderList } from "./OfflineOrderList";
import { ASSET_TYPES, NAIRA_FORMAT, assetLabel, durationLabel } from "./assetLabels";
import { enqueueOrder, newIdempotencyKey } from "../offline/orderQueue";
import { useOfflineOrderQueue } from "../offline/useOfflineOrderQueue";

/** Remembers the last KYC status the API returned, so the form still works offline. */
const KYC_STATUS_STORAGE_KEY = "airflex:sell-kyc-status";

function readStoredKycStatus(): string | null {
  try {
    return window.localStorage.getItem(KYC_STATUS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeKycStatus(status: string): void {
  try {
    window.localStorage.setItem(KYC_STATUS_STORAGE_KEY, status);
  } catch {
    // Storage unavailable: the form simply cannot be used offline next time.
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Listing durations offered, in hours. */
const EXPIRY_HOURS = [1, 6, 12, 24, 48, 72, 168] as const;

/** Largest amount a single listing may ask for, in naira. */
const MAX_LISTING_NAIRA = 1_000_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormFields {
  assetType: string;
  amount: string;
  expiresInHours: number;
}

/**
 * Validation errors are held as message keys under `Sell.errors`, not as
 * text, so they re-render in the new language when the locale changes.
 */
type FieldErrorKey =
  | "assetTypeRequired"
  | "amountRequired"
  | "amountPositive"
  | "amountMax"
  | "expiryRequired";

interface FieldErrors {
  assetType?: FieldErrorKey;
  amount?: FieldErrorKey;
  expiresInHours?: FieldErrorKey;
}

/** A message key of ours, or an error message the API sent back verbatim. */
type ServerError =
  | { key: "kycRequired" | "generic" | "unexpectedResponse" }
  | { text: string };

type QueuedNotice = "queuedOffline" | "queuedConnectionLost";

interface CreateTradeResponse {
  data?: TradeOffer;
  error?: string;
  details?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(fields: FormFields): FieldErrors {
  const errors: FieldErrors = {};

  if (!fields.assetType) {
    errors.assetType = "assetTypeRequired";
  }

  const numericAmount = parseFloat(fields.amount);
  if (!fields.amount.trim()) {
    errors.amount = "amountRequired";
  } else if (isNaN(numericAmount) || numericAmount <= 0) {
    errors.amount = "amountPositive";
  } else if (numericAmount > MAX_LISTING_NAIRA) {
    errors.amount = "amountMax";
  }

  if (!fields.expiresInHours || fields.expiresInHours < 1) {
    errors.expiresInHours = "expiryRequired";
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner({ label }: { label: string }) {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
    </svg>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {label}
      </label>
      {hint && <p className="text-xs text-gray-400 dark:text-gray-500">{hint}</p>}
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

const inputBase =
  "w-full rounded-xl border px-4 py-3 text-sm text-gray-900 outline-none transition-colors " +
  "focus:ring-2 focus:ring-violet-500 disabled:cursor-not-allowed disabled:bg-gray-50 " +
  "disabled:text-gray-400 placeholder-gray-400 " +
  "dark:text-gray-100 dark:placeholder-gray-500 dark:disabled:bg-gray-800 dark:disabled:text-gray-500";

const inputNormal =
  "border-gray-200 bg-white hover:border-gray-300 " +
  "dark:border-gray-600 dark:bg-gray-700 dark:hover:border-gray-500";

const inputError =
  "border-red-400 bg-red-50 focus:ring-red-400 " +
  "dark:border-red-500 dark:bg-red-900/20 dark:focus:ring-red-500";

// ---------------------------------------------------------------------------
// Success confirmation panel
// ---------------------------------------------------------------------------

function SuccessPanel({ trade }: { trade: TradeOffer }) {
  const t = useTranslations("Sell");
  const format = useFormatter();
  const statusKey = `tradeStatus.${trade.status}`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-6 rounded-2xl border border-green-200 bg-green-50 px-8 py-10 dark:border-green-800 dark:bg-green-900/20"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span aria-hidden="true" className="text-5xl">🎉</span>
        <h2 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
          {t("success.title")}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t("success.body")}
        </p>
      </div>

      <dl className="divide-y divide-green-100 rounded-xl border border-green-200 bg-white dark:divide-green-800 dark:border-green-800 dark:bg-gray-800">
        <DetailRow label={t("success.tradeId")}>
          <span className="break-all font-mono text-xs text-gray-700 dark:text-gray-300">
            {trade.id}
          </span>
        </DetailRow>
        <DetailRow label={t("success.asset")}>{assetLabel(t, trade.asset_type)}</DetailRow>
        <DetailRow label={t("success.amount")}>
          {format.number(Number(trade.amount), NAIRA_FORMAT)}
        </DetailRow>
        <DetailRow label={t("success.status")}>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/40 dark:text-green-300">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
            {t.has(statusKey) ? t(statusKey) : trade.status}
          </span>
        </DetailRow>
        <DetailRow label={t("success.expires")}>
          {format.dateTime(new Date(trade.expires_at), {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </DetailRow>
      </dl>

      <div className="flex flex-col gap-3 sm:flex-row">
        <a
          href="/"
          className="flex-1 inline-flex items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
        >
          {t("success.viewMarketplace")}
        </a>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex-1 inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          {t("success.createAnother")}
        </button>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-3">
      <dt className="shrink-0 text-xs font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-right text-sm text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SellPage() {
  const t = useTranslations("Sell");
  const format = useFormatter();
  const naira = (value: number) => format.number(value, NAIRA_FORMAT);

  const [authChecked, setAuthChecked] = useState(false);
  const [kycStatus, setKycStatus] = useState<string>("unverified");
  const [kycLoading, setKycLoading] = useState(true);
  const [conversionRate, setConversionRate] = useState<number | null>(getCachedConversionRate());
  const [fields, setFields] = useState<FormFields>({
    assetType: "",
    amount: "",
    expiresInHours: 24,
  });
  const [errors, setErrors]             = useState<FieldErrors>({});
  const [serverError, setServerError]   = useState<ServerError | null>(null);
  const [loading, setLoading]           = useState(false);
  const [createdTrade, setCreatedTrade] = useState<TradeOffer | null>(null);
  const [offline, setOffline]           = useState(false);
  const [queuedNotice, setQueuedNotice] = useState<QueuedNotice | null>(null);
  // Number of queued listings sent on reconnect; shown as a notice.
  const [flushedCount, setFlushedCount] = useState<number | null>(null);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  const offlineQueue = useOfflineOrderQueue({
    apiUrl,
    getToken,
    onFlushed: (result) => {
      setQueuedNotice(null);
      setFlushedCount(result.sentKeys.length);
    },
  });

  useEffect(() => {
    setOffline(!window.navigator.onLine);
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, []);

  useEffect(() => {
    const cached = getCachedConversionRate();
    if (cached !== null) {
      setConversionRate(cached);
      return;
    }

    let isMounted = true;
    fetch(`${apiUrl}/api/v1/rates`)
      .then((r) => {
        if (!r.ok) throw new Error("Rates unavailable");
        return r.json() as Promise<{ rate?: number; data?: { rate?: number } }>;
      })
      .then((data) => {
        const rate = data.rate ?? data.data?.rate;
        if (typeof rate === "number" && rate > 0) {
          setCachedConversionRate(rate);
          if (isMounted) setConversionRate(rate);
        }
      })
      .catch(() => {
        // If conversion rate is unavailable, keep conversionRate null (preview remains hidden)
      });

    return () => {
      isMounted = false;
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!isAuthenticated()) {
      const returnTo = encodeURIComponent("/sell");
      window.location.href = `/auth/signup?returnTo=${returnTo}`;
      return;
    }
    setAuthChecked(true);

    const token = getToken();
    if (!token) return;

    fetch(`${apiUrl}/api/v1/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json() as Promise<{ data?: { kycStatus?: string } }>)
      .then((data) => {
        const status = data.data?.kycStatus ?? "unverified";
        storeKycStatus(status);
        setKycStatus(status);
      })
      .catch(() => {
        // Offline, the profile request cannot succeed: fall back to the last
        // status seen so a verified seller can still queue a listing. The
        // server checks KYC again when the queued order is sent.
        const stored = window.navigator.onLine ? null : readStoredKycStatus();
        setKycStatus(stored ?? "unverified");
      })
      .finally(() => setKycLoading(false));
  }, [apiUrl]);

  function handleChange(e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setFields((prev) => ({
      ...prev,
      [name]: name === "expiresInHours" ? parseInt(value, 10) : value,
    }));
    if (errors[name as keyof FieldErrors]) {
      setErrors((prev) => ({ ...prev, [name]: undefined }));
    }
    if (serverError) setServerError(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    if (kycStatus !== "verified") {
      setServerError({ key: "kycRequired" });
      return;
    }

    const fieldErrors = validate(fields);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      const firstErrorId = Object.keys(fieldErrors)[0];
      document.getElementById(firstErrorId ?? "")?.focus();
      return;
    }
    setErrors({});

    const token = getToken();
    if (!token) {
      window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/sell");
      return;
    }

    // The API speaks the escrow contract's unit: the naira the seller typed is
    // converted to stroops exactly once, here, with the shared helper (issue
    // #292). `Number(...)` is what JSON can carry — the value is a safe integer
    // well under 2^53 (capped at ₦1,000,000).
    const amountNaira = parseFloat(fields.amount);
    const amount = Number(toStroops(amountNaira));
    // One key per submit, reused if the order has to be queued, so a request
    // that did reach the server is never listed twice when the queue replays it.
    const idempotencyKey = newIdempotencyKey();

    function queueOrder(notice: QueuedNotice) {
      enqueueOrder({
        idempotencyKey,
        assetType: fields.assetType,
        amount,
        amountNaira,
        expiresInHours: fields.expiresInHours,
      });
      setFlushedCount(null);
      setQueuedNotice(notice);
      setFields({ assetType: "", amount: "", expiresInHours: 24 });
    }

    if (!window.navigator.onLine) {
      queueOrder("queuedOffline");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${apiUrl}/api/v1/trades`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          assetType: fields.assetType,
          amount,
          expiresInHours: fields.expiresInHours,
        }),
      });

      const data = (await res.json()) as CreateTradeResponse;

      if (res.status === 401) {
        window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/sell");
        return;
      }

      if (!res.ok) {
        const detail = data.details
          ? Object.values(data.details).flat()[0]
          : data.error;
        setServerError(detail ? { text: detail } : { key: "generic" });
        return;
      }

      if (!data.data) {
        setServerError({ key: "unexpectedResponse" });
        return;
      }

      setCreatedTrade(data.data);
    } catch {
      // The request never got an answer. Keep the order instead of losing it:
      // it is replayed with the same idempotency key once we are online.
      queueOrder("queuedConnectionLost");
    } finally {
      setLoading(false);
    }
  }

  if (!authChecked || kycLoading) {
    return (
      <div className="flex items-center justify-center py-32" aria-label={t("checkingAuth")}>
        <Spinner label={t("checkingAuth")} />
      </div>
    );
  }

  const kycBlocked = kycStatus !== "verified";

  const numericAmount = parseFloat(fields.amount) || 0;
  const usdcPreview =
    conversionRate && conversionRate > 0
      ? (numericAmount / conversionRate).toFixed(2)
      : "0.00";

  const fieldError = (key: FieldErrorKey | undefined) =>
    key ? t(`errors.${key}`, { max: naira(MAX_LISTING_NAIRA) }) : undefined;

  if (createdTrade) {
    return <SuccessPanel trade={createdTrade} />;
  }

  return (
    <>
      {offline && (
        <div
          role="status"
          data-testid="offline-banner"
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-5 py-3 text-sm font-medium text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300"
        >
          {t("offlineBanner")}
        </div>
      )}
      {queuedNotice && (
        <div
          role="status"
          data-testid="queued-notice"
          className="mb-6 rounded-xl border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
        >
          {t(queuedNotice)}
        </div>
      )}
      {flushedCount !== null && (
        <div
          role="status"
          data-testid="flushed-notice"
          className="mb-6 rounded-xl border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
        >
          {t("flushedNotice", { count: flushedCount })}
        </div>
      )}
      <OfflineOrderList
        orders={offlineQueue.queue}
        offline={offline}
        onRetry={(key) => void offlineQueue.retry(key)}
        onDiscard={offlineQueue.discard}
      />

      {/* Page header */}
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          {t("eyebrow")}
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
          {t("title")}
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t("intro")}
        </p>
      </div>

      {/* KYC gate */}
      {kycBlocked && (
        <div
          role="alert"
          className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-800/60 dark:bg-amber-950/30"
        >
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            {kycStatus === "pending" ? t("kycPending") : t("kycRequired")}
          </p>
          {kycStatus !== "pending" && (
            <a
              href="/kyc"
              className="mt-2 inline-block text-sm font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
            >
              {t("completeKyc")}
            </a>
          )}
        </div>
      )}

      {/* How it works */}
      <div className="mb-8 flex flex-col gap-2 rounded-xl border border-violet-100 bg-violet-50 px-5 py-4 dark:border-violet-800 dark:bg-violet-900/20">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">
          {t("howItWorks")}
        </p>
        <ol className="mt-1 flex flex-col gap-1 text-sm text-violet-800 list-decimal list-inside dark:text-violet-300">
          <li>{t("step1")}</li>
          <li>{t("step2")}</li>
          <li>{t("step3")}</li>
          <li>{t("step4")}</li>
        </ol>
      </div>

      {/* Form */}
      <form
        onSubmit={handleSubmit}
        noValidate
        className="flex flex-col gap-6 rounded-2xl border border-gray-100 bg-white px-8 py-8 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        {/* Asset type */}
        <Field
          id="assetType"
          label={t("assetTypeLabel")}
          hint={t("assetTypeHint")}
          error={fieldError(errors.assetType)}
        >
          <select
            id="assetType"
            name="assetType"
            value={fields.assetType}
            onChange={handleChange}
            disabled={loading || kycBlocked}
            aria-describedby={errors.assetType ? "assetType-error" : undefined}
            aria-invalid={errors.assetType ? "true" : undefined}
            className={`${inputBase} ${errors.assetType ? inputError : inputNormal} appearance-none bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")] bg-no-repeat bg-[right_1rem_center]`}
          >
            <option value="" disabled>{t("assetTypePlaceholder")}</option>
            {ASSET_TYPES.map((value) => (
              <option key={value} value={value}>{assetLabel(t, value)}</option>
            ))}
          </select>
        </Field>

        {/* Amount */}
        <Field
          id="amount"
          label={t("amountLabel")}
          hint={t("amountHint")}
          error={fieldError(errors.amount)}
        >
          <CurrencyInput
            id="amount"
            name="amount"
            value={fields.amount}
            decimalPlaces={0}
            onChange={(val) => {
              setFields((prev) => ({ ...prev, amount: val ? String(val) : "" }));
              if (errors.amount) setErrors((prev) => ({ ...prev, amount: undefined }));
              if (serverError) setServerError(null);
            }}
            disabled={loading || kycBlocked}
            placeholder="500"
          />
          {conversionRate !== null && (
            <p
              data-testid="conversion-preview"
              aria-live="polite"
              className="mt-1 text-xs font-medium text-gray-500 dark:text-gray-400"
            >
              {t("conversionPreview", { amount: usdcPreview })}
            </p>
          )}
        </Field>

        {/* Expiry */}
        <Field
          id="expiresInHours"
          label={t("durationLabel")}
          hint={t("durationHint")}
          error={fieldError(errors.expiresInHours)}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {EXPIRY_HOURS.map((hours) => (
              <label
                key={hours}
                className={`flex cursor-pointer items-center justify-center rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  fields.expiresInHours === hours
                    ? "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-500"
                    : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:border-violet-500 dark:hover:text-violet-400"
                } ${loading || kycBlocked ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="expiresInHours"
                  value={hours}
                  checked={fields.expiresInHours === hours}
                  onChange={handleChange}
                  disabled={loading || kycBlocked}
                  className="sr-only"
                />
                {durationLabel(t, hours)}
              </label>
            ))}
          </div>
        </Field>

        <hr className="border-gray-100 dark:border-gray-700" />

        {/* Summary preview */}
        {fields.assetType && fields.amount && parseFloat(fields.amount) > 0 && (
          <div
            aria-live="polite"
            className="rounded-xl border border-gray-100 bg-gray-50 px-5 py-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-700/50 dark:text-gray-400"
          >
            <p className="font-medium text-gray-700 dark:text-gray-300">{t("previewTitle")}</p>
            <p className="mt-1">
              {t.rich("previewBody", {
                asset: assetLabel(t, fields.assetType),
                amount: naira(parseFloat(fields.amount)),
                duration: durationLabel(t, fields.expiresInHours),
                strong: (chunks) => (
                  <strong className="text-gray-900 dark:text-gray-100">{chunks}</strong>
                ),
              })}
            </p>
          </div>
        )}

        {/* Server error */}
        {serverError && (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
          >
            {"key" in serverError ? t(`errors.${serverError.key}`) : serverError.text}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || kycBlocked}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-violet-300 dark:focus-visible:ring-offset-gray-800 dark:disabled:bg-violet-800"
        >
          {loading ? (
            <>
              <Spinner label={t("submitting")} />
              {t("submitting")}
            </>
          ) : offline ? (
            t("submitOffline")
          ) : (
            t("submit")
          )}
        </button>
      </form>
    </>
  );
}
