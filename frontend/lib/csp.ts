/**
 * Content-Security-Policy builder for nonce-based script loading (#120).
 */

function apiConnectOrigins(): string {
  const api = process.env.NEXT_PUBLIC_API_URL;
  if (!api) return "";
  try {
    return new URL(api).origin;
  } catch {
    return "";
  }
}

export function buildContentSecurityPolicy(nonce: string): string {
  const apiOrigin = apiConnectOrigins();
  const connectSrc = ["'self'", apiOrigin, "https://api.paystack.co"].filter(Boolean);

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' https://js.paystack.co`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc.join(" ")}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "frame-src https://checkout.paystack.com https://js.paystack.co",
    "form-action 'self'",
  ].join("; ");
}

export const STATIC_SECURITY_HEADERS: Array<{ key: string; value: string }> = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(self)",
  },
];
