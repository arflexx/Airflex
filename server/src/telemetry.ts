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
 */

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
      .then(() => console.log("[otel] SDK shut down successfully"))
      .catch((err: Error) =>
        console.error("[otel] Error shutting down SDK:", err)
      )
      .finally(() => process.exit(0));
  });

  console.log(
    `[otel] OpenTelemetry initialised — exporting to ${OTLP_ENDPOINT}`
  );
}
