"use client";

import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from "react";
import { getToken, isAuthenticated } from "../lib/auth";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Spinner } from "../../components/ui/Spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KycStep = 1 | 2 | 3;

interface Step1Fields {
  legalName: string;
  dateOfBirth: string;
}

interface Step2Fields {
  nin: string;
}

interface FieldErrors {
  legalName?: string;
  dateOfBirth?: string;
  nin?: string;
  document?: string;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/jpeg", "image/png"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateStep1(fields: Step1Fields): FieldErrors {
  const errors: FieldErrors = {};
  const name = fields.legalName.trim();

  if (!name) {
    errors.legalName = "Full legal name is required.";
  } else if (name.split(/\s+/).filter(Boolean).length < 2) {
    errors.legalName = "Enter your full name (at least first and last name).";
  }

  if (!fields.dateOfBirth) {
    errors.dateOfBirth = "Date of birth is required.";
  } else {
    const dob = new Date(fields.dateOfBirth);
    const now = new Date();
    if (Number.isNaN(dob.getTime()) || dob >= now) {
      errors.dateOfBirth = "Enter a valid date of birth in the past.";
    }
  }

  return errors;
}

function validateStep2(fields: Step2Fields): FieldErrors {
  const errors: FieldErrors = {};
  const nin = fields.nin.trim();

  if (!nin) {
    errors.nin = "NIN is required.";
  } else if (!/^\d{11}$/.test(nin)) {
    errors.nin = "NIN must be exactly 11 digits.";
  }

  return errors;
}

function validateDocument(file: File | null): FieldErrors {
  const errors: FieldErrors = {};

  if (!file) {
    errors.document = "Please upload a selfie or identity document photo.";
    return errors;
  }

  if (!ACCEPTED_TYPES.includes(file.type)) {
    errors.document = "Only JPEG or PNG images are accepted.";
  }

  if (file.size > MAX_FILE_BYTES) {
    errors.document = "File size must not exceed 5 MB.";
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current }: { current: KycStep }) {
  const steps = [
    { num: 1, label: "Identity" },
    { num: 2, label: "NIN" },
    { num: 3, label: "Document" },
  ] as const;

  return (
    <nav aria-label="KYC progress" className="mb-8">
      <ol className="flex items-center justify-between gap-2">
        {steps.map((step, idx) => {
          const done = current > step.num;
          const active = current === step.num;

          return (
            <li key={step.num} className="flex flex-1 items-center gap-2">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  done
                    ? "bg-green-500 text-white"
                    : active
                      ? "bg-violet-600 text-white"
                      : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                }`}
                aria-current={active ? "step" : undefined}
              >
                {done ? "✓" : step.num}
              </span>
              <span
                className={`hidden text-xs font-medium sm:block ${
                  active ? "text-violet-700 dark:text-violet-300" : "text-gray-500 dark:text-gray-400"
                }`}
              >
                {step.label}
              </span>
              {idx < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mx-1 hidden h-px flex-1 sm:block ${
                    done ? "bg-green-400" : "bg-gray-200 dark:bg-gray-700"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KycPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [step, setStep] = useState<KycStep>(1);
  const [step1, setStep1] = useState<Step1Fields>({ legalName: "", dateOfBirth: "" });
  const [step2, setStep2] = useState<Step2Fields>({ nin: "" });
  const [document, setDocument] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiUrl = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

  useEffect(() => {
    if (!isAuthenticated()) {
      window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/kyc");
      return;
    }
    setAuthChecked(true);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleDocumentChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setDocument(file);
    setErrors((prev) => ({ ...prev, document: undefined }));
    setServerError(null);

    if (previewUrl) URL.revokeObjectURL(previewUrl);

    if (file && ACCEPTED_TYPES.includes(file.type) && file.size <= MAX_FILE_BYTES) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }
  }

  function goToStep2(e: FormEvent) {
    e.preventDefault();
    const fieldErrors = validateStep1(step1);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setStep(2);
  }

  function goToStep3(e: FormEvent) {
    e.preventDefault();
    const fieldErrors = validateStep2(step2);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setStep(3);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);

    const fieldErrors = validateDocument(document);
    if (Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      return;
    }
    setErrors({});

    const token = getToken();
    if (!token) {
      window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/kyc");
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("legalName", step1.legalName.trim());
      formData.append("dateOfBirth", step1.dateOfBirth);
      formData.append("nin", step2.nin.trim());
      if (document) {
        formData.append("document", document);
      }

      const res = await fetch(`${apiUrl}/api/kyc/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const data = (await res.json()) as { error?: string; message?: string };

      if (res.status === 401) {
        window.location.href = "/auth/signup?returnTo=" + encodeURIComponent("/kyc");
        return;
      }

      if (!res.ok) {
        setServerError(data.error ?? "Submission failed. Please try again.");
        return;
      }

      setSubmitted(true);
    } catch {
      setServerError("Network error. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!authChecked) {
    return (
      <div className="flex items-center justify-center py-32">
        <Spinner label="Checking authentication…" />
      </div>
    );
  }

  if (submitted) {
    return (
      <div
        role="status"
        className="flex flex-col gap-4 rounded-2xl border border-amber-200 bg-amber-50 px-8 py-10 text-center dark:border-amber-800 dark:bg-amber-950/30"
      >
        <span aria-hidden="true" className="text-4xl">⏳</span>
        <h1 className="text-2xl font-extrabold text-gray-900 dark:text-gray-100">
          KYC Pending Review
        </h1>
        <p className="text-sm text-amber-800 dark:text-amber-300">
          Your documents have been submitted. An admin will review your application shortly.
          You&apos;ll be notified once verification is complete.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <a
            href="/profile"
            className="inline-flex items-center justify-center rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-700"
          >
            View profile
          </a>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            Back to marketplace
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-violet-500 dark:text-violet-400">
          Seller verification
        </p>
        <h1 className="text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
          Complete KYC
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Nigerian financial regulations require identity verification before you can sell on AirFlex.
        </p>
      </div>

      <StepIndicator current={step} />

      {step === 1 && (
        <form
          onSubmit={goToStep2}
          noValidate
          className="flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white px-8 py-8 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <Input
            id="legalName"
            label="Full legal name"
            name="legalName"
            value={step1.legalName}
            onChange={(e) => {
              setStep1((prev) => ({ ...prev, legalName: e.target.value }));
              if (errors.legalName) setErrors((prev) => ({ ...prev, legalName: undefined }));
            }}
            error={errors.legalName}
            helperText="As it appears on your government ID (first and last name required)."
            placeholder="Ada Okonkwo"
            autoComplete="name"
          />
          <Input
            id="dateOfBirth"
            label="Date of birth"
            name="dateOfBirth"
            type="date"
            value={step1.dateOfBirth}
            onChange={(e) => {
              setStep1((prev) => ({ ...prev, dateOfBirth: e.target.value }));
              if (errors.dateOfBirth) setErrors((prev) => ({ ...prev, dateOfBirth: undefined }));
            }}
            error={errors.dateOfBirth}
          />
          <Button type="submit" className="w-full">
            Continue
          </Button>
        </form>
      )}

      {step === 2 && (
        <form
          onSubmit={goToStep3}
          noValidate
          className="flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white px-8 py-8 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <Input
            id="nin"
            label="National Identification Number (NIN)"
            name="nin"
            inputMode="numeric"
            maxLength={11}
            value={step2.nin}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 11);
              setStep2({ nin: digits });
              if (errors.nin) setErrors((prev) => ({ ...prev, nin: undefined }));
            }}
            error={errors.nin}
            helperText="Your 11-digit NIN issued by NIMC."
            placeholder="12345678901"
          />
          <div className="flex gap-3">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button type="submit" className="flex-1">
              Continue
            </Button>
          </div>
        </form>
      )}

      {step === 3 && (
        <form
          onSubmit={handleSubmit}
          noValidate
          className="flex flex-col gap-5 rounded-2xl border border-gray-100 bg-white px-8 py-8 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="document" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Selfie or identity document photo
            </label>
            <p id="document-hint" className="text-xs text-gray-400 dark:text-gray-500">
              Upload a clear photo of yourself or your ID document. Accepts JPEG or PNG up to 5 MB.
            </p>
            <input
              ref={fileInputRef}
              id="document"
              name="document"
              type="file"
              accept="image/jpeg,image/png"
              onChange={handleDocumentChange}
              disabled={loading}
              aria-describedby="document-hint"
              aria-invalid={errors.document ? "true" : undefined}
              className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-violet-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-violet-700 hover:file:bg-violet-100 dark:text-gray-300 dark:file:bg-violet-900/40 dark:file:text-violet-300"
            />
            {errors.document && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {errors.document}
              </p>
            )}
          </div>

          {previewUrl && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-700/50">
              <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Preview</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Selected document preview"
                className="mx-auto max-h-48 rounded-lg object-contain"
              />
            </div>
          )}

          {serverError && (
            <div
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400"
            >
              {serverError}
            </div>
          )}

          <div className="flex gap-3">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setStep(2)} disabled={loading}>
              Back
            </Button>
            <Button type="submit" className="flex-1" isLoading={loading}>
              Submit for review
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
