"use client";

import React, { type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from "react";

export interface CurrencyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max"> {
  value: number | string;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /**
   * Maximum number of digits allowed after the decimal point (issue #602).
   *
   * Defaults to 0 (whole-number amounts), matching every existing call site
   * (`frontend/app/wallet/`, `frontend/app/sell/`), which all deal in whole
   * Naira. Pass a higher value for asset types that need fractional
   * precision.
   */
  decimalPlaces?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  errorText?: string;
  /**
   * Optional available-balance caption rendered above the input (issue #447).
   * Pass the (possibly optimistic) balance string so the caption stays in sync
   * with the displayed wallet balance.
   */
  availableAmount?: string;
}

/**
 * Strips a raw input/paste string down to digits plus, when `decimalPlaces`
 * is greater than 0, a single decimal point. Extra decimal points beyond the
 * first are dropped. Fractional digits past `decimalPlaces` are intentionally
 * *not* truncated here — that overflow is surfaced as a validation error
 * instead of being silently cut off while the user is typing.
 */
function sanitizeRawInput(raw: string, decimalPlaces: number): string {
  if (decimalPlaces <= 0) return raw.replace(/[^0-9]/g, "");

  let cleaned = raw.replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  }
  return cleaned;
}

/** Parses a sanitized amount string into the numeric value passed to `onChange`. */
function parseAmountString(raw: string, decimalPlaces: number): number {
  const cleaned = sanitizeRawInput(raw, decimalPlaces);
  if (!cleaned || cleaned === ".") return 0;
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Formats a raw value (number or in-progress text) for display, applying a
 * thousands separator to the whole-number part while preserving the
 * fractional part (including an in-progress trailing ".") as typed.
 */
export function formatAmountDisplay(val: number | string, decimalPlaces = 0): string {
  const raw = String(val ?? "");

  if (decimalPlaces <= 0) {
    const digits = raw.replace(/\D/g, "");
    if (!digits) return "";
    const num = parseInt(digits, 10);
    return isNaN(num) ? "" : num.toLocaleString("en-NG");
  }

  const cleaned = sanitizeRawInput(raw, decimalPlaces);
  if (!cleaned) return "";

  const [wholePart, fractionPart] = cleaned.split(".");
  const wholeNum = wholePart ? parseInt(wholePart, 10) : 0;
  const formattedWhole = isNaN(wholeNum) ? "0" : wholeNum.toLocaleString("en-NG");

  return fractionPart !== undefined ? `${formattedWhole}.${fractionPart}` : formattedWhole;
}

/** @deprecated use {@link formatAmountDisplay} — kept for backward compatibility. */
export function formatNairaDisplay(val: number | string): string {
  return formatAmountDisplay(val, 0);
}

export function CurrencyInput({
  value,
  onChange,
  min,
  max,
  decimalPlaces = 0,
  disabled = false,
  className = "",
  id = "currency-input",
  name,
  placeholder = "0",
  errorText,
  availableAmount,
  ...rest
}: CurrencyInputProps) {
  const displayValue = formatAmountDisplay(value, decimalPlaces);
  const numericValue = parseAmountString(String(value ?? ""), decimalPlaces);

  const fractionDigits =
    decimalPlaces > 0 ? (displayValue.split(".")[1]?.length ?? 0) : 0;
  const hasTooManyDecimals = decimalPlaces > 0 && fractionDigits > decimalPlaces;

  const isBelowMin = numericValue > 0 && min !== undefined && numericValue < min;
  const isAboveMax = max !== undefined && numericValue > max;

  // Priority: decimal-precision errors, then range errors, then any
  // caller-supplied generic error text.
  const builtInErrorMessage = hasTooManyDecimals
    ? `Enter up to ${decimalPlaces} decimal place${decimalPlaces === 1 ? "" : "s"}`
    : isAboveMax
      ? `Maximum amount is ₦${max.toLocaleString("en-NG")}`
      : isBelowMin
        ? `Minimum amount is ₦${min.toLocaleString("en-NG")}`
        : null;

  const validationMessage = builtInErrorMessage ?? errorText ?? null;
  const isInvalid = Boolean(validationMessage);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const cleaned = sanitizeRawInput(e.target.value, decimalPlaces);
    onChange(parseAmountString(cleaned, decimalPlaces));
  };

  /**
   * Sanitises pasted text before it reaches the input.
   *
   * Mobile keyboards (and desktop paste) can inject currency symbols, commas,
   * letters, or other non-numeric characters. We strip them here so
   * parseFloat / parseInt never receives garbage and returns NaN.
   */
  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    const cleaned = sanitizeRawInput(pasted, decimalPlaces);
    onChange(parseAmountString(cleaned, decimalPlaces));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    const step = decimalPlaces > 0 ? Math.pow(10, -decimalPlaces) : 100;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      let next = numericValue + step;
      if (max !== undefined && next > max) next = max;
      onChange(next);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(0, numericValue - step);
      onChange(next);
    }
  };

  const baseInputStyle =
    "w-full rounded-xl border py-2.5 pl-8 pr-4 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-2 disabled:opacity-60";
  const normalInputStyle =
    "border-gray-200 bg-white text-gray-900 focus:border-violet-500 focus:ring-violet-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100";
  const errorInputStyle =
    "border-red-400 bg-red-50 text-gray-900 focus:border-red-500 focus:ring-red-400 " +
    "dark:border-red-500 dark:bg-red-900/20 dark:text-gray-100 dark:focus:ring-red-500";

  const inputStyle = `${baseInputStyle} ${isInvalid ? errorInputStyle : normalInputStyle}`;

  return (
    <div className="w-full flex flex-col gap-1">
      {availableAmount !== undefined && (
        <p
          data-testid="currency-input-available"
          className="text-xs font-medium text-gray-500 dark:text-gray-400"
        >
          Available: ₦{availableAmount}
        </p>
      )}
      <div className="relative w-full">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-500 dark:text-gray-400"
        >
          ₦
        </span>
        <input
          id={id}
          name={name}
          type="text"
          role="spinbutton"
          inputMode={decimalPlaces > 0 ? "decimal" : "numeric"}
          value={displayValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={rest["aria-label"] ?? "Amount in Nigerian naira"}
          aria-valuemin={min ?? 0}
          aria-valuemax={max}
          aria-valuenow={numericValue}
          aria-valuetext={`₦${displayValue || "0"}`}
          aria-invalid={isInvalid ? "true" : undefined}
          aria-describedby={
            validationMessage ? `${id}-error` : rest["aria-describedby"]
          }
          className={`${inputStyle} ${className}`}
          {...rest}
        />
      </div>

      {validationMessage && (
        <p id={`${id}-error`} role="alert" aria-live="assertive" className="text-xs font-medium text-red-600 dark:text-red-400">
          {validationMessage}
        </p>
      )}
    </div>
  );
}
