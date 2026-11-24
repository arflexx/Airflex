import { NextResponse } from "next/server";

/**
 * CSP violation report endpoint (Issue #670).
 *
 * Browsers send reports in two formats:
 *   - report-uri: `Content-Type: application/csp-report` with a JSON body
 *     containing a top-level `csp-report` key.
 *   - Reporting API (report-to): `Content-Type: application/reports+json` with
 *     an array of report objects, each with `type`, `url`, and `body`.
 *
 * Both are accepted. Unknown or malformed bodies are silently dropped with
 * HTTP 204 to prevent log flooding from malformed or third-party submissions.
 *
 * Production logging is at `info` level, rate-limited conceptually by only
 * logging the structured fields (no raw body echo) to avoid log flooding.
 * Debug-level verbosity is explicitly skipped in production.
 */

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Minimum fields expected in a report-uri CSP report body. */
interface CspReportBody {
  "document-uri"?: string;
  "violated-directive"?: string;
  "effective-directive"?: string;
  "blocked-uri"?: string;
  "status-code"?: number;
  "source-file"?: string;
  "line-number"?: number;
  "column-number"?: number;
  "original-policy"?: string;
  disposition?: string;
}

/** report-to envelope. */
interface ReportingApiEntry {
  type?: string;
  url?: string;
  age?: number;
  body?: Record<string, unknown>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function logViolation(fields: Record<string, unknown>): void {
  // In production skip debug-verbosity; only emit a single structured line.
  if (IS_PRODUCTION) {
    // Structured log — omit large fields like `original-policy` to cap line length.
    const { "original-policy": _omit, ...compact } = fields as CspReportBody & Record<string, unknown>;
    console.warn(JSON.stringify({ event: "csp_violation", ...compact }));
  } else {
    // Development: surface the full report for debugging.
    console.warn("[CSP violation]", JSON.stringify(fields, null, 2));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const text = await request.text();

    if (!text) {
      return new NextResponse(null, { status: 204 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Unparseable body — drop silently.
      return new NextResponse(null, { status: 204 });
    }

    // report-uri format: { "csp-report": { ... } }
    if (isObject(parsed) && "csp-report" in parsed) {
      const report = parsed["csp-report"];
      if (isObject(report)) {
        logViolation(report as Record<string, unknown>);
      }
      return new NextResponse(null, { status: 204 });
    }

    // Reporting API format: array of report objects
    if (
      Array.isArray(parsed) ||
      contentType.includes("application/reports+json")
    ) {
      const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        if (!isObject(entry)) continue;
        const typed = entry as ReportingApiEntry;
        if (typed.type !== "csp-violation") continue;
        if (isObject(typed.body)) {
          logViolation({ url: typed.url, age: typed.age, ...typed.body });
        }
      }
      return new NextResponse(null, { status: 204 });
    }

    // Unknown format — drop silently.
    return new NextResponse(null, { status: 204 });
  } catch {
    // Never surface server errors to the reporter.
    return new NextResponse(null, { status: 204 });
  }
}
