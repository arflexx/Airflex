/**
 * Issue #675: every structured log entry written inside a request context
 * carries that request's `requestId`, read from AsyncLocalStorage, and the
 * same id is stamped on OpenTelemetry spans started in the context.
 */
import { trace } from "@opentelemetry/api";
import logger from "./logger";
import { runWithRequestContext } from "./requestContext";
import {
  REQUEST_ID_ATTRIBUTE,
  RequestIdSpanProcessor,
  annotateSpanWithResponseRequestId,
} from "../telemetry";

describe("logger requestId (issue #675)", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  let lines: string[];

  beforeEach(() => {
    process.env["NODE_ENV"] = "production"; // JSON output
    lines = [];
    jest.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env["NODE_ENV"] = originalNodeEnv;
  });

  const entries = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

  it("attaches the context requestId to every entry, across async hops", async () => {
    await runWithRequestContext({ requestId: "req-675-abcdef" }, async () => {
      logger.info("plain message");
      await new Promise((r) => setTimeout(r, 1));
      logger.warn({ step: "after-await" }, "context message");
      logger.error({ err: new Error("boom") }, "error message");
    });

    const logged = entries();
    expect(logged).toHaveLength(3);
    for (const entry of logged) expect(entry["requestId"]).toBe("req-675-abcdef");
  });

  it("does not mutate the caller's context object", () => {
    const ctx = { step: "x" };
    runWithRequestContext({ requestId: "req-675-immutable" }, () => logger.info(ctx, "m"));
    expect(ctx).toEqual({ step: "x" });
  });

  it("omits requestId for background logs outside a request", () => {
    logger.info({ job: "cron" }, "background");
    expect(entries()[0]).not.toHaveProperty("requestId");
  });
});

describe("span requestId (issue #675)", () => {
  function fakeSpan() {
    const attrs: Record<string, unknown> = {};
    return {
      attrs,
      span: { setAttribute: (k: string, v: unknown) => ((attrs[k] = v), undefined) } as unknown as Parameters<
        RequestIdSpanProcessor["onStart"]
      >[0],
    };
  }

  it("stamps request.id on spans started inside a request context", () => {
    const { attrs, span } = fakeSpan();
    runWithRequestContext({ requestId: "req-675-span" }, () => new RequestIdSpanProcessor().onStart(span));
    expect(attrs[REQUEST_ID_ATTRIBUTE]).toBe("req-675-span");
  });

  it("leaves spans started outside a request untouched", () => {
    const { attrs, span } = fakeSpan();
    new RequestIdSpanProcessor().onStart(span);
    expect(attrs).toEqual({});
  });

  it("copies X-Request-ID from the response onto the HTTP server span", () => {
    const { attrs, span } = fakeSpan();
    annotateSpanWithResponseRequestId(span, { getHeader: () => "req-675-http" });
    expect(attrs[REQUEST_ID_ATTRIBUTE]).toBe("req-675-http");
  });

  it("is a no-op API when no tracer is registered", () => {
    expect(() => trace.getActiveSpan()?.setAttribute(REQUEST_ID_ATTRIBUTE, "x")).not.toThrow();
  });
});
