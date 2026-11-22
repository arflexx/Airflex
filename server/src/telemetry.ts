/**
 * telemetry.ts
 *
 * OpenTelemetry SDK initialisation for AirFlex server.
 *
 * This file MUST be required before any other imports so that auto-instrumentation
 * patches are applied before the modules it instruments are first loaded.
 *
 * Usage — add to the start script in package.json:
 *   "start": "node --require ./dist/telemetry.js dist/index.js"
 *   "dev":   "ts-node-dev --require tsconfig-paths/register -r ./src/telemetry.ts ..."
 *
 * Required packages (install with npm):
 *   @opentelemetry/sdk-node
 *   @opentelemetry/auto-instrumentations-node
 *   @opentelemetry/exporter-otlp-http
 *
 * Environment variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  OTLP HTTP endpoint (default: http://localhost:4318)
 *   OTEL_SERVICE_NAME            Service name reported in traces (default: airflex-server)
 *   OTEL_ENABLED                 Set to "false" to disable telemetry entirely (useful in test)
 *
 * It also exports the trade lifecycle tracing helpers (issue #482). Those use
 * only `@opentelemetry/api`, so when the SDK above is not started (tests,
 * OTEL_ENABLED=false) every span is a no-op and nothing is exported.
 *
 * It also exports withQueueJobSpan(), used by jobs/queue.ts to wrap each job
 * in a span carrying queue depth and worker concurrency attributes (#684).
 */

import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import logger from "./utils/logger";
import { getRequestId } from "./utils/requestContext";

// Guard: skip telemetry in test environments or when explicitly disabled
if (
  process.env["NODE_ENV"] === "test" ||
  process.env["OTEL_ENABLED"] === "false"
) {
  // Nothing to initialise — exit the module cleanly
} else {
  // Dynamic require so TypeScript doesn't complain about missing types at
  // build time if the packages haven't been installed yet. In practice, the
  // packages must be installed before this file is executed.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const {
    getNodeAutoInstrumentations,
  } = require("@opentelemetry/auto-instrumentations-node");
  const {
    OTLPTraceExporter,
  } = require("@opentelemetry/exporter-trace-otlp-http");
  const { Resource } = require("@opentelemetry/resources");
  const {
    SEMRESATTRS_SERVICE_NAME,
    SEMRESATTRS_SERVICE_VERSION,
    SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  } = require("@opentelemetry/semantic-conventions");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const OTLP_ENDPOINT =
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? "http://localhost:4318";

  const SERVICE_NAME =
    process.env["OTEL_SERVICE_NAME"] ?? "airflex-server";

  const traceExporter = new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: SERVICE_NAME,
      [SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]:
        process.env["NODE_ENV"] ?? "development",
    }),
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Express HTTP spans — captures route, method, status code
        "@opentelemetry/instrumentation-express": { enabled: true },
        // HTTP/fetch spans — captures outbound calls to Paystack, Stellar, Termii
        "@opentelemetry/instrumentation-http": { enabled: true },
        // pg database query spans — captures SQL query text and latency
        "@opentelemetry/instrumentation-pg": { enabled: true },
        // node-fetch is covered by the http instrumentation above
        // Disable noisy fs instrumentation to keep traces clean
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Gracefully shut down the SDK on process exit to flush any pending spans
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => logger.info("[otel] SDK shut down successfully"))
      .catch((err: Error) =>
        logger.error({ err }, "[otel] Error shutting down SDK")
      )
      .finally(() => process.exit(0));
  });

  logger.info(
    { endpoint: `${OTLP_ENDPOINT}/v1/traces`, serviceName: SERVICE_NAME },
    "[otel] OpenTelemetry initialised"
  );
}

// ---------------------------------------------------------------------------
// Trade lifecycle tracing (issue #482)
// ---------------------------------------------------------------------------

const TRACER_NAME = "airflex-trades";
const TRACER_VERSION = "1.0.0";

/** The stages of a trade, each traced as its own span. */
export type TradeStage = "create" | "fund" | "release" | "dispute";

export const TRADE_SPAN_NAMES: Readonly<Record<TradeStage, string>> = {
  create: "trade.create",
  fund: "trade.fund",
  release: "trade.release",
  dispute: "trade.dispute",
};

/** Attribute keys recorded on trade spans. */
export const TRADE_ATTRIBUTES = {
  stage: "trade.stage",
  tradeId: "trade_id",
  userId: "user_id",
  status: "status",
  /** Request correlation id (X-Request-Id), shared with the structured logs. */
  requestId: "request.id",
} as const;

/**
 * Dotted (namespaced) aliases for the domain attributes, following the
 * OpenTelemetry attribute naming guidelines. They are written alongside the
 * original keys above so existing dashboards and queries keep working.
 */
export const TRADE_ATTRIBUTE_ALIASES = {
  tradeId: "trade.id",
  userId: "user.id",
  status: "trade.status",
} as const;

export interface TradeSpanAttributes {
  tradeId?: string | null;
  userId?: string | null;
  /** The trade's status, e.g. the status this stage moved it to. */
  status?: string | null;
}

function toAttributes(attrs: TradeSpanAttributes): Attributes {
  const out: Attributes = {};
  if (attrs.tradeId) {
    out[TRADE_ATTRIBUTES.tradeId] = attrs.tradeId;
    out[TRADE_ATTRIBUTE_ALIASES.tradeId] = attrs.tradeId;
  }
  if (attrs.userId) {
    out[TRADE_ATTRIBUTES.userId] = attrs.userId;
    out[TRADE_ATTRIBUTE_ALIASES.userId] = attrs.userId;
  }
  if (attrs.status) {
    out[TRADE_ATTRIBUTES.status] = attrs.status;
    out[TRADE_ATTRIBUTE_ALIASES.status] = attrs.status;
  }
  return out;
}

/**
 * Correlation attributes for the current request: the X-Request-Id opened by
 * the requestId middleware (issue #481). Spans started outside a request —
 * background jobs, the system-raised dispute path — simply omit it.
 */
function correlationAttributes(): Attributes {
  const requestId = getRequestId();
  return requestId ? { [TRADE_ATTRIBUTES.requestId]: requestId } : {};
}

/**
 * Looked up on every call rather than cached, so spans go to whichever
 * provider is registered at the time (the SDK in production, an in-memory
 * provider in tests, the no-op provider otherwise).
 */
function tracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/**
 * Records `err` on `span` as an exception event and marks the span failed.
 * Use it wherever an error is handled rather than rethrown, so it still
 * shows up in the trace instead of being swallowed.
 */
export function recordSpanError(span: Span, err: unknown): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

/** Records `err` on the currently active span, if there is one. */
export function recordActiveSpanError(err: unknown): void {
  const span = trace.getActiveSpan();
  if (span) recordSpanError(span, err);
}

/**
 * Runs `fn` inside a new span that is the active span for everything `fn`
 * calls, so spans started further down (services, pg, outbound HTTP) become
 * its children. A thrown error is recorded on the span and rethrown.
 */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      recordSpanError(span, err);
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Runs `fn` inside the span for one trade lifecycle stage. */
export function withTradeSpan<T>(
  stage: TradeStage,
  attrs: TradeSpanAttributes,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    TRADE_SPAN_NAMES[stage],
    { [TRADE_ATTRIBUTES.stage]: stage, ...correlationAttributes(), ...toAttributes(attrs) },
    fn
  );
}

/**
 * Sets trade attributes on the active span — for values only known part-way
 * through a stage, such as the id of a trade being created or the status it
 * ends in.
 */
export function setTradeAttributes(attrs: TradeSpanAttributes): void {
  trace.getActiveSpan()?.setAttributes(toAttributes(attrs));
}

// ---------------------------------------------------------------------------
// Queue worker telemetry (issue #684)
// ---------------------------------------------------------------------------

/** Attribute keys emitted on every `queue.process <name>` span. */
export const QUEUE_SPAN_ATTRIBUTES = {
  queue: "queue.name",
  depth: "queue.depth",
  active: "queue.worker.active",
  concurrency: "queue.worker.concurrency",
  jobId: "queue.job.id",
  attempt: "queue.job.attempt",
} as const;

export interface QueueJobTelemetry {
  queue: string;
  /** Jobs still waiting in the queue when this one started. */
  depth: number;
  /** Jobs running on this queue, including this one. */
  active: number;
  /** Worker concurrency limit; null for unbounded queues. */
  concurrency: number | null;
  jobId: string;
  attempt: number;
}

export function queueJobAttributes(t: QueueJobTelemetry): Attributes {
  const attrs: Attributes = {
    [QUEUE_SPAN_ATTRIBUTES.queue]: t.queue,
    [QUEUE_SPAN_ATTRIBUTES.depth]: t.depth,
    [QUEUE_SPAN_ATTRIBUTES.active]: t.active,
    [QUEUE_SPAN_ATTRIBUTES.jobId]: t.jobId,
    [QUEUE_SPAN_ATTRIBUTES.attempt]: t.attempt,
  };
  if (t.concurrency !== null) {
    attrs[QUEUE_SPAN_ATTRIBUTES.concurrency] = t.concurrency;
  }
  return attrs;
}

/** Runs `fn` inside a `queue.process <queue>` span with queue/worker attributes. */
export function withQueueJobSpan<T>(t: QueueJobTelemetry, fn: () => Promise<T>): Promise<T> {
  return withSpan(`queue.process ${t.queue}`, queueJobAttributes(t), () => fn());
}
