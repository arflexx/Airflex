"use client";

import { useState, useEffect, type FormEvent, type ChangeEvent } from "react";
import { getToken, isAuthenticated } from "../lib/auth";
import type { TradeOffer } from "../../../server/src/types/trade";
import { CurrencyInput } from "../../components/CurrencyInput";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASSET_OPTIONS = [
  { value: "MTN_AIRTIME",     label: "MTN — Airtime" },
  { value: "MTN_DATA",        label: "MTN — Data" },
  { value: "GLO_AIRTIME",     label: "Glo — Airtime" },
  { value: "GLO_DATA",        label: "Glo — Data" },
  { value: "AIRTEL_AIRTIME",  label: "Airtel — Airtime" },
  { value: "AIRTEL_DATA",     label: "Airtel — Data" },
  { value: "9MOBILE_AIRTIME", label: "9mobile — Airtime" },
  { value: "9MOBILE_DATA",    label: "9mobile — Data" },
] as const;

const EXPIRY_OPTIONS = [
  { value: 1,   label: "1 hour" },
  { value: 6,   label: "6 hours" },
  { value: 12,  label: "12 hours" },
  { value: 24,  label: "24 hours" },
  { value: 48,  label: "2 days" },
  { value: 72,  label: "3 days" },
  { value: 168, label: "7 days" },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FormFields {
  assetType: string;
  amount: string;
  expiresInHours: number;
}

interface FieldErrors {
  assetType?: string;
  amount?: string;
  expiresInHours?: string;
}

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
    errors.assetType = "Please select an asset type.";
  }

  const numericAmount = parseFloat(fields.amount);
  if (!fields.amount.trim()) {
    errors.amount = "Amount is required.";
  } else if (isNaN(numericAmount) || numericAmount <= 0) {
    errors.amount = "Amount must be greater than zero.";
  } else if (numericAmount > 1_000_000) {
    errors.amount = "Amount cannot exceed ₦1,000,000 per listing.";
  }

  if (!fields.expiresInHours || fields.expiresInHours < 1) {
    errors.expiresInHours = "Please select an expiry duration.";
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
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
  const assetLabel =
    ASSET_OPTIONS.find((o) => o.value === trade.asset_type)?.label ??
    trade.asset_type;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-6 rounded-2xl border border-green-200 bg-green-50 px-8 py-10 dark:border-green-800 dark:bg-green-900/20"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span aria-hidden="true" className="text-5xl">🎉</span>
        <h2 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
          Listing Created!
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Your trade offer is now live on the AirFlex marketplace.
        </p>
      </div>

      <dl className="divide-y divide-green-100 rounded-xl border border-green-200 bg-white dark:divide-green-800 dark:border-green-800 dark:bg-gray-800">
        <DetailRow label="Trade ID">
          <span className="break-all font-mono text-xs text-gray-700 dark:text-gray-300">
            {trade.id}
          </span>
        </DetailRow>
        <DetailRow label="Asset">{assetLabel}</DetailRow>
        <DetailRow label="Amount">₦{trade.amount.toLocaleString()}</DetailRow>
        <DetailRow label="Status">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/40 dark:text-green-300">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-500 inline-block" />
            {trade.status}
          </span>
        </DetailRow>
        <DetailRow label="Expires">
          {new Date(trade.expires_at).toLocaleString("en-NG", {
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
          View marketplace
        </a>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex-1 inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          Create another listing
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
  const [authChecked, setAuthChecked] = useState(false);
  const [kycStatus, setKycStatus] = useState<string>("unverified");
  const [kycLoading, setKycLoading] = useState(true);
  const [fields, setFields] = useState<FormFields>({
    assetType: "",
    amount: "",
    expiresInHours: 24,
  });
  const [errors, setErrors]             = useState<FieldErrors>({});
  const [serverError, setServerError]   = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);
  const [createdTrade, setCreatedTrade] = useState<TradeOffer | null>(null);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

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
        setKycStatus(data.data?.kycStatus ?? "unverified");
      })
      .catch(() => setKycStatus("unverified"))
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
      setServerError("Complete KYC verification before creating a listing.");
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

    setLoading(true);

    try {
      const res = await fetch(`${apiUrl}/api/v1/trades`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          assetType:      fields.assetType,
          amount:         parseFloat(fields.amount),
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
        setServerError(detail ?? "Something went wrong. Please try again.");
        return;
      }

      if (!data.data) {
        setServerError("Unexpected server response. Please try again.");
        return;
      }

      setCreatedTrade(data.data);
    } catch {
      setServerError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!authChecked || kycLoading) {
    return (
      <div className="flex items-center justify-center py-32" aria-label="Checking authentication">
        <Spinner />
      </div>
    );
  }

  const kycBlocked = kycStatus !== "verified";

  if (createdTrade) {
    return <SuccessPanel trade={createdTrade} />;
  }

  return (
    <>
      {/* Page header */}
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          New listing
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
          Sell Airtime or Data
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Fill in the details below. Your listing will be registered on the
          Stellar escrow contract and visible to buyers immediately.
        </p>
      </div>

      {/* KYC gate */}
      {kycBlocked && (
        <div
          role="alert"
          className="mb-8 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-800/60 dark:bg-amber-950/30"
        >
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            {kycStatus === "pending"
              ? "KYC Pending Review — listing creation is disabled until your verification is approved."
              : "Seller verification required — complete KYC before creating a listing."}
          </p>
          {kycStatus !== "pending" && (
            <a
              href="/kyc"
              className="mt-2 inline-block text-sm font-semibold text-violet-600 hover:text-violet-700 dark:text-violet-400"
            >
              Complete KYC verification →
            </a>
          )}
        </div>
      )}

      {/* How it works */}
      <div className="mb-8 flex flex-col gap-2 rounded-xl border border-violet-100 bg-violet-50 px-5 py-4 dark:border-violet-800 dark:bg-violet-900/20">
        <p className="text-xs font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">
          How it works
        </p>
        <ol className="mt-1 flex flex-col gap-1 text-sm text-violet-800 list-decimal list-inside dark:text-violet-300">
          <li>Submit this form — your listing goes live on-chain.</li>
          <li>A buyer accepts and deposits funds into escrow.</li>
          <li>Send the airtime / data to the buyer.</li>
          <li>Platform confirms delivery and releases your payment.</li>
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
          label="Asset type"
          hint="The network and type of telecom value you are selling."
          error={errors.assetType}
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
            <option value="" disabled>Select an asset type…</option>
            {ASSET_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </Field>

        {/* Amount */}
        <Field
          id="amount"
          label="Amount (₦)"
          hint="How much the buyer will pay. Must be greater than zero."
          error={errors.amount}
        >
          <CurrencyInput
            id="amount"
            name="amount"
            value={fields.amount}
            onChange={(val) => {
              setFields((prev) => ({ ...prev, amount: val ? String(val) : "" }));
              if (errors.amount) setErrors((prev) => ({ ...prev, amount: undefined }));
              if (serverError) setServerError(null);
            }}
            disabled={loading || kycBlocked}
            placeholder="500"
          />
        </Field>

        {/* Expiry */}
        <Field
          id="expiresInHours"
          label="Listing duration"
          hint="How long your listing stays active. Buyers can only purchase before this expires."
          error={errors.expiresInHours}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {EXPIRY_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-center justify-center rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                  fields.expiresInHours === opt.value
                    ? "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-500"
                    : "border-gray-200 bg-white text-gray-600 hover:border-violet-300 hover:text-violet-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:border-violet-500 dark:hover:text-violet-400"
                } ${loading || kycBlocked ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="expiresInHours"
                  value={opt.value}
                  checked={fields.expiresInHours === opt.value}
                  onChange={handleChange}
                  disabled={loading || kycBlocked}
                  className="sr-only"
                />
                {opt.label}
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
            <p className="font-medium text-gray-700 dark:text-gray-300">Listing preview</p>
            <p className="mt-1">
              Selling{" "}
              <strong className="text-gray-900 dark:text-gray-100">
                {ASSET_OPTIONS.find((o) => o.value === fields.assetType)?.label ?? fields.assetType}
              </strong>{" "}
              for{" "}
              <strong className="text-gray-900 dark:text-gray-100">
                ₦{parseFloat(fields.amount).toLocaleString()}
              </strong>
              , expires in{" "}
              <strong className="text-gray-900 dark:text-gray-100">
                {EXPIRY_OPTIONS.find((o) => o.value === fields.expiresInHours)?.label}
              </strong>
              .
            </p>
          </div>
        )}

        {/* Server error */}
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
          disabled={loading || kycBlocked}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-violet-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-violet-300 dark:focus-visible:ring-offset-gray-800 dark:disabled:bg-violet-800"
        >
          {loading ? (
            <>
              <Spinner />
              Creating listing…
            </>
          ) : (
            "Create listing"
          )}
        </button>
      </form>
    </>
  );
}
