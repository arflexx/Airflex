"use client";

import React, { type KeyboardEvent, type ChangeEvent } from "react";

export interface CurrencyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "min" | "max"> {
  value: number | string;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  errorText?: string;
}

export function formatNairaDisplay(val: number | string): string {
  const digits = String(val ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const num = parseInt(digits, 10);
  return isNaN(num) ? "" : num.toLocaleString("en-NG");
}

export function CurrencyInput({
  value,
  onChange,
  min,
  max,
  disabled = false,
  className = "",
  id = "currency-input",
  name,
  placeholder = "0",
  errorText,
  ...rest
}: CurrencyInputProps) {
  const rawDigits = String(value ?? "").replace(/\D/g, "");
  const numericValue = rawDigits ? parseInt(rawDigits, 10) : 0;
  const displayValue = formatNairaDisplay(value);

  const isBelowMin = numericValue > 0 && min !== undefined && numericValue < min;
  const minErrorMessage = isBelowMin ? `Minimum amount is ₦${min.toLocaleString("en-NG")}` : null;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const cleaned = e.target.value.replace(/\D/g, "");
    const parsed = cleaned ? parseInt(cleaned, 10) : 0;
    onChange(parsed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      let next = numericValue + 100;
      if (max !== undefined && next > max) next = max;
      onChange(next);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      let next = Math.max(0, numericValue - 100);
      onChange(next);
    }
  };

  const inputStyle =
    "w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-8 pr-4 text-sm text-gray-900 placeholder:text-gray-400 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/20 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100";

  return (
    <div className="w-full flex flex-col gap-1">
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
          inputMode="numeric"
          value={displayValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={isBelowMin || Boolean(errorText) ? "true" : undefined}
          aria-describedby={
            minErrorMessage || errorText ? `${id}-error` : rest["aria-describedby"]
          }
          className={`${inputStyle} ${className}`}
          {...rest}
        />
      </div>

      {(minErrorMessage || errorText) && (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {minErrorMessage || errorText}
        </p>
      )}
    </div>
  );
}
