import React from "react";

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps extends React.SVGAttributes<SVGSVGElement> {
  /**
   * Size of the spinner.
   * @default "md"
   */
  size?: SpinnerSize;

  /**
   * Accessible screen-reader label for the loading state.
   * @default "Loading…"
   */
  label?: string;
}

const sizeClasses: Record<SpinnerSize, string> = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

/**
 * Airflex primitive Spinner for loading and async operations,
 * supporting accessible announcements and dark mode.
 */
export function Spinner({
  size = "md",
  label = "Loading…",
  className = "text-violet-600 dark:text-violet-400",
  ...props
}: SpinnerProps) {
  return (
    <svg
      className={`animate-spin ${sizeClasses[size]} ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
      {...props}
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
      <span className="sr-only">{label}</span>
    </svg>
  );
}

export default Spinner;
