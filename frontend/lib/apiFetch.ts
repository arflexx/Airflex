/**
 * apiFetch.ts — Centralized API fetch wrapper and error type for frontend.
 */

import { getToken } from "../app/lib/auth";

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

  const response = await fetch(url, {
    ...options,
    headers,
  });

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

    throw new ApiError(errorMessage, response.status, errorData);
  }

  return response.json() as Promise<T>;
}
