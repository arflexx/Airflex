import React, { forwardRef, useId } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * Optional label displayed above the select element.
   */
  label?: string;

  /**
   * Optional error message displayed below the select element.
   */
  error?: string;

  /**
   * Supporting instructional text displayed below the select when not in error state.
   */
  helperText?: string;

  /**
   * Array of options to render in the dropdown. Can also pass <option> elements as children.
   */
  options?: SelectOption[];
}

/**
 * Airflex primitive Select dropdown supporting structured options or option children,
 * validation feedback, accessible labeling, and dark mode.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      error,
      helperText,
      options,
      children,
      id,
      disabled,
      required,
      className = "",
      ...props
    },
    ref
  ) => {
    const generatedId = useId();
    const selectId = id ?? generatedId;
    const errorId = `${selectId}-error`;
    const helperId = `${selectId}-helper`;

    const hasError = Boolean(error);

    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label
            htmlFor={selectId}
            className="text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300"
          >
            {label}
            {required && <span className="text-red-500 ml-1" aria-hidden="true">*</span>}
          </label>
        )}

        <div className="relative flex items-center w-full">
          <select
            ref={ref}
            id={selectId}
            disabled={disabled}
            required={required}
            aria-invalid={hasError}
            aria-describedby={hasError ? errorId : helperText ? helperId : undefined}
            className={`w-full appearance-none rounded-xl border px-3.5 py-2.5 pr-10 text-sm transition-colors outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:opacity-60 dark:disabled:bg-gray-800 ${
              hasError
                ? "border-red-500 bg-red-50/30 text-gray-900 focus:border-red-500 focus:ring-red-500/20 dark:border-red-500 dark:bg-red-950/20 dark:text-gray-100"
                : "border-gray-300 bg-white text-gray-900 focus:border-violet-600 focus:ring-violet-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-violet-400 dark:focus:ring-violet-400/20"
            } ${className}`}
            {...props}
          >
            {options
              ? options.map((opt) => (
                  <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                  </option>
                ))
              : children}
          </select>

          <div className="pointer-events-none absolute right-3.5 flex items-center text-gray-400 dark:text-gray-500">
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
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

Select.displayName = "Select";
export default Select;
