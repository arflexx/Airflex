/**
 * Content-Security-Policy builder for nonce-based script loading (#120).
 *
 * The directives live in ./cspPolicy.js, shared with next.config.js, which
 * applies the nonce-less variant to every response (#539). This module adds
 * the per-request nonce for HTML pages served through middleware.ts.
 */

import {
  buildContentSecurityPolicy as buildPolicy,
  reportingEndpoints,
  STATIC_SECURITY_HEADERS as SHARED_STATIC_HEADERS,
} from "./cspPolicy";

export function buildContentSecurityPolicy(nonce: string): string {
  return buildPolicy({ nonce });
}

export { reportingEndpoints };

export const STATIC_SECURITY_HEADERS: Array<{ key: string; value: string }> =
  SHARED_STATIC_HEADERS;
