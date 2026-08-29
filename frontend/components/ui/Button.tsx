import React, { forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style variant of the button.
   * @default "primary"
   */
  variant?: ButtonVariant;

  /**
   * Size of the button padding and text.
   * @default "md"
   */
  size?: ButtonSize;

  /**
   * If true, displays a loading spinner and disables user interaction.
   * @default false
   */
  isLoading?: boolean;

  /**
   * Optional accessible text displayed alongside the spinner while loading.
   */
  loadingText?: string;

  /**
   * Optional icon to show before the label.
   */
  leftIcon?: React.ReactNode;

  /**
   * Optional icon to show after the label.
   */
  rightIcon?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-violet-600 text-white hover:bg-violet-700 focus-visible:ring-violet-500 dark:bg-violet-600 dark:hover:bg-violet-500 dark:focus-visible:ring-violet-400 disabled:bg-violet-300 dark:disabled:bg-violet-900/50",
  secondary:
    "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus-visible:ring-violet-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 dark:focus-visible:ring-violet-400 disabled:opacity-50",
  danger:
    "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 dark:bg-red-600 dark:hover:bg-red-500 dark:focus-visible:ring-red-400 disabled:bg-red-300 dark:disabled:bg-red-900/50",
  ghost:
    "text-gray-700 hover:bg-gray-100 focus-visible:ring-violet-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:focus-visible:ring-violet-400 disabled:opacity-50",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs rounded-lg gap-1.5",
  md: "px-4 py-2 text-sm rounded-xl gap-2",
  lg: "px-6 py-3 text-base rounded-xl gap-2.5",
};

/**
 * Airflex primitive Button supporting primary, secondary, danger, and ghost variants,
 * accessible states, loading indicator, and dark mode.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      isLoading = false,
      loadingText,
      disabled,
      className = "",
      children,
      leftIcon,
      rightIcon,
      type = "button",
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || isLoading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={isLoading}
        className={`inline-flex items-center justify-center font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 disabled:cursor-not-allowed select-none ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {isLoading ? (
          <>
            <svg
              className="h-4 w-4 animate-spin shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              role="status"
              aria-label={loadingText ?? "Loading"}
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z"
              />
            </svg>
            {loadingText ? <span>{loadingText}</span> : children}
          </>
        ) : (
          <>
            {leftIcon && <span className="shrink-0">{leftIcon}</span>}
            <span>{children}</span>
            {rightIcon && <span className="shrink-0">{rightIcon}</span>}
          </>
        )}
      </button>
    );
  }
);

Button.displayName = "Button";
export default Button;
