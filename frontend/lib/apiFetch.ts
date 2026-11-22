/**
 * apiFetch.ts — Centralized API fetch wrapper and error type for frontend.
 *
 * GET responses honour `Cache-Control` and `ETag` via the per-session cache in
 * ./httpCache (Issue #681): fresh entries are served from memory, stale ones
 * with an ETag are revalidated with `If-None-Match` and reused on a 304.
 * A successful POST/PUT/PATCH/DELETE invalidates cached GETs for the same
 * resource. Pass `cache: "no-store"` in options to bypass the cache.
 */

import { clearToken, getToken } from "../app/lib/auth";
import {
  cacheKey,
  getCachedResponse,
  invalidateResource,
  isFresh,
  sessionScope,
  storeResponse,
} from "./httpCache";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerOf(response: Response, name: string): string | null {
  // Test doubles (and some polyfills) may omit `headers`.
  return typeof response.headers?.get === "function" ? response.headers.get(name) : null;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;

  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  if (token && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const method = (options.method ?? "GET").toUpperCase();
  const useCache = method === "GET" && options.cache !== "no-store";
  const key = cacheKey(sessionScope(token), url);
  const cached = useCache ? getCachedResponse(key) : undefined;

  if (cached && isFresh(cached)) {
    return cached.data as T;
  }
  if (cached?.etag && !headers["If-None-Match"]) {
    headers["If-None-Match"] = cached.etag;
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (response.status === 304 && cached) {
    // Not modified: keep the stored body, refresh freshness from new headers.
    storeResponse(
      key,
      cached.data,
      headerOf(response, "Cache-Control"),
      headerOf(response, "ETag") ?? cached.etag,
    );
    return cached.data as T;
  }

  if (!response.ok) {
    let errorData: unknown;
    let errorMessage = `HTTP ${response.status} ${response.statusText}`;

    try {
      errorData = await response.json();
      if (
        errorData &&
        typeof errorData === "object" &&
        "error" in errorData &&
        typeof (errorData as { error: unknown }).error === "string"
      ) {
        errorMessage = (errorData as { error: string }).error;
      } else if (
        errorData &&
        typeof errorData === "object" &&
        "message" in errorData &&
        typeof (errorData as { message: unknown }).message === "string"
      ) {
        errorMessage = (errorData as { message: string }).message;
      }
    } catch {
      // response was not JSON
    }

    if (response.status === 401 && typeof window !== "undefined") {
      clearToken();
      window.dispatchEvent(new CustomEvent("airflex:session-expired"));

      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (!window.location.pathname.startsWith("/auth/signup")) {
        window.location.assign(`/auth/signup?returnTo=${encodeURIComponent(returnTo)}`);
      }
    }

    throw new ApiError(errorMessage, response.status, errorData);
  }

  if (MUTATION_METHODS.has(method)) {
    invalidateResource(url);
  }

  // 204 No Content (common for DELETE) has no body to parse.
  if (response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json()) as T;

  if (useCache) {
    storeResponse(key, data, headerOf(response, "Cache-Control"), headerOf(response, "ETag"));
  }

  return data;
}
