import React, { forwardRef, useId } from "react";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * Optional label displayed above the input field.
   */
  label?: string;

  /**
   * Error message displayed below the input. When present, marks the input as invalid.
   */
  error?: string;

  /**
   * Supporting instructional text displayed below the input when not in error state.
   */
  helperText?: string;

  /**
   * Optional icon or element to render on the left side inside the input.
   */
  leftAddon?: React.ReactNode;

  /**
   * Optional icon or element to render on the right side inside the input.
   */
  rightAddon?: React.ReactNode;
}

/**
 * Airflex primitive Input with label, validation errors, helper text, dark mode, and accessibility support.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      leftAddon,
      rightAddon,
      id,
      disabled,
      required,
      className = "",
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const errorId = `${inputId}-error`;
    const helperId = `${inputId}-helper`;

    const hasError = Boolean(error);

    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300"
          >
            {label}
            {required && <span className="text-red-500 ml-1" aria-hidden="true">*</span>}
          </label>
        )}

        <div className="relative flex items-center w-full">
          {leftAddon && (
            <div className="absolute left-3.5 flex items-center pointer-events-none text-gray-400 dark:text-gray-500">
              {leftAddon}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            required={required}
            aria-invalid={hasError}
            aria-describedby={hasError ? errorId : helperText ? helperId : undefined}
            className={`w-full rounded-xl border px-3.5 py-2.5 text-sm transition-colors outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60 dark:disabled:bg-gray-800 ${
              leftAddon ? "pl-10" : ""
            } ${rightAddon ? "pr-10" : ""} ${
              hasError
                ? "border-red-500 bg-red-50/30 text-gray-900 focus:border-red-500 focus:ring-red-500/20 dark:border-red-500 dark:bg-red-950/20 dark:text-gray-100"
                : "border-gray-300 bg-white text-gray-900 focus:border-violet-600 focus:ring-violet-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-violet-400 dark:focus:ring-violet-400/20"
            } ${className}`}
            {...props}
          />

          {rightAddon && (
            <div className="absolute right-3.5 flex items-center pointer-events-none text-gray-400 dark:text-gray-500">
              {rightAddon}
            </div>
          )}
        </div>

        {hasError ? (
          <p
            id={errorId}
            role="alert"
            className="text-xs font-medium text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        ) : helperText ? (
          <p
            id={helperId}
            className="text-xs text-gray-500 dark:text-gray-400"
          >
            {helperText}
          </p>
        ) : null}
      </div>
    );
  }
);

Input.displayName = "Input";
export default Input;
