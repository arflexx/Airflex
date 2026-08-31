import React from "react";

export type BadgeStatusVariant =
  | "Open"
  | "Active"
  | "Locked"
  | "Completed"
  | "Cancelled"
  | "Disputed";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * The status variant of the badge.
   * Required status variants: Open, Locked, Completed, Cancelled, Disputed.
   * "Active" is accepted as an alias for "Open".
   * @default "Open"
   */
  variant?: BadgeStatusVariant;

  /**
   * Optional boolean to show a status indicator dot.
   * @default true
   */
  showDot?: boolean;

  /**
   * Optional custom text or children. If omitted, the variant name is used.
   */
  children?: React.ReactNode;
}

const statusConfig: Record<
  BadgeStatusVariant,
  { container: string; dot: string; defaultLabel: string }
> = {
  Open: {
    container: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800/60",
    dot: "bg-green-500",
    defaultLabel: "Open",
  },
  Active: {
    container: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300 border-green-200 dark:border-green-800/60",
    dot: "bg-green-500",
    defaultLabel: "Active",
  },
  Locked: {
    container: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800/60",
    dot: "bg-amber-500",
    defaultLabel: "Locked",
  },
  Completed: {
    container: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-blue-200 dark:border-blue-800/60",
    dot: "bg-blue-500",
    defaultLabel: "Completed",
  },
  Cancelled: {
    container: "bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-400 border-gray-200 dark:border-gray-600/60",
    dot: "bg-gray-400",
    defaultLabel: "Cancelled",
  },
  Disputed: {
    container: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-800/60",
    dot: "bg-rose-500",
    defaultLabel: "Disputed",
  },
};

/**
 * Airflex primitive Badge for trade lifecycle states and category indicators,
 * supporting Open, Locked, Completed, Cancelled, and Disputed status variants with dark mode.
 */
export function Badge({
  variant = "Open",
  showDot = true,
  className = "",
  children,
  ...props
}: BadgeProps) {
  const config = statusConfig[variant] ?? statusConfig.Open;
  const content = children ?? config.defaultLabel;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide transition-colors ${config.container} ${className}`}
      {...props}
    >
      {showDot && (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full inline-block shrink-0 ${config.dot}`}
        />
      )}
      <span>{content}</span>
    </span>
  );
}

export default Badge;
