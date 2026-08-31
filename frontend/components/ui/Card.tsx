import React, { forwardRef } from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Optional boolean to remove outer padding from the Card container.
   * @default false
   */
  noPadding?: boolean;
}

/**
 * Airflex primitive Card container with light/dark surface, border, and elevation styling.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ noPadding = false, className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`rounded-2xl border border-gray-100 bg-white shadow-sm transition-colors dark:border-gray-700 dark:bg-gray-800 ${
          noPadding ? "" : "p-6"
        } ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);
Card.displayName = "Card";

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`flex flex-col gap-1.5 border-b border-gray-50 pb-4 dark:border-gray-700/60 ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);
CardHeader.displayName = "CardHeader";

export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
}

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ as: Component = "h3", className = "", children, ...props }, ref) => {
    return (
      <Component
        ref={ref}
        className={`text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100 ${className}`}
        {...props}
      >
        {children}
      </Component>
    );
  }
);
CardTitle.displayName = "CardTitle";

export interface CardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {}

export const CardDescription = forwardRef<HTMLParagraphElement, CardDescriptionProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <p
        ref={ref}
        className={`text-sm text-gray-500 dark:text-gray-400 ${className}`}
        {...props}
      >
        {children}
      </p>
    );
  }
);
CardDescription.displayName = "CardDescription";

export interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <div ref={ref} className={`pt-4 ${className}`} {...props}>
        {children}
      </div>
    );
  }
);
CardContent.displayName = "CardContent";

export interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {}

export const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(
  ({ className = "", children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`flex items-center justify-end gap-3 pt-6 border-t border-gray-50 dark:border-gray-700/60 ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);
CardFooter.displayName = "CardFooter";

export default Card;
