import "dotenv/config";
import "express-async-errors";
// Load contract IDs early — emits startup warnings if addresses are missing
import "./config/contracts";
import express, { Request, Response } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { registerRoutes } from "./routes";
import { initJobQueue } from "./jobs";
import logger from "./utils/logger";
import { errorHandler } from "./middleware/errorHandler";
import { apiVersion } from "./middleware/apiVersion";
import { requestId } from "./middleware/requestId";
import { pool, query } from "./db/pool";
import { cache } from "./services/cache";
import { checkHealth } from "./services/health";

import { assertEnvValid } from "./config/validateEnv";
import { corsMiddleware } from "./config/cors";

const isTest =
  process.env["NODE_ENV"] === "test" ||
  process.env["JEST_WORKER_ID"] !== undefined;

try {
  assertEnvValid();
} catch (envErr) {
  if (!isTest) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Database connection test on startup
// ---------------------------------------------------------------------------

if (!isTest) {
  const testQueryText = "SELECT 1";
  pool.query(testQueryText)
    .then(() => {
      logger.info({ query: testQueryText }, "Database connection validated");
    })
    .catch((err) => {
      logger.error(
        `[startup] Database connection failed: ${err.message}\n` +
          "Verify DATABASE_URL is correct and PostgreSQL is reachable.\n" +
          "Server exiting."
      );
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// Redis connection test on startup
// ---------------------------------------------------------------------------

if (!isTest && (process.env["NODE_ENV"] === "production" || process.env["REDIS_URL"])) {
  cache
    .checkReady()
    .then(() => {
      logger.info("[cache] Redis connection validated at startup");
    })
    .catch((err) => {
      logger.fatal(
        `[startup] FATAL: Redis is unavailable at startup: ${(err as Error).message}\n` +
          "Verify REDIS_URL is reachable. Server exiting."
      );
      console.error(`[FATAL] Redis is unavailable at startup: ${(err as Error).message}`);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
if (!Number.isFinite(PORT) || !Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(
    `[startup] Invalid PORT value: "${process.env["PORT"] ?? ""}". Must be an integer between 1024 and 65535.`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Generate per-request UUID for correlation (must be first middleware)
app.use(requestId);

// Security headers
app.use(helmet());

// CORS — explicit origin allowlist from CORS_ALLOWED_ORIGINS; wildcard is
// rejected in production (see config/cors.ts). Preflights are terminated in
// routes/index.ts.
app.use(corsMiddleware());

// Request logging with X-Request-Id token
// Define custom token to include request ID in logs
morgan.token("request-id", (_req: Request, res: Response) => {
  return (res.locals as { requestId?: string }).requestId ?? "-";
});

app.use(
  morgan(
    process.env["NODE_ENV"] === "production"
      ? 'combined :request-id'
      : 'dev :request-id'
  )
);

// JSON body parsing.
//
// `verify` stashes the exact bytes received. The Paystack webhook signs the
// raw body, and re-serialising the parsed object reorders keys and changes
// whitespace, producing a different HMAC for a genuine request - so the
// signature check needs the original bytes, not req.body. See routes/webhooks.
app.use(
  express.json({
    // Cap JSON payloads at 10kb (asserted by index.test.ts). Webhooks and API
    // bodies are all small; file uploads (KYC documents) go through busboy as
    // multipart and are not affected.
    limit: "10kb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

// Inject X-Api-Version header on every response
app.use(apiVersion);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/ready", async (_req: Request, res: Response) => {
  try {
    await query("SELECT 1");
    res.status(200).json({ status: "ready", db: "ok" });
  } catch {
    res.status(503).json({ status: "not ready", db: "error" });
  }
});

registerRoutes(app);

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ---------------------------------------------------------------------------
// Global error handler  (must be last)
// ---------------------------------------------------------------------------

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (!isTest) {
  app.listen(PORT, () => {
    logger.info(
      { port: PORT, env: process.env["NODE_ENV"] ?? "development" },
      "AirFlex API started"
    );

    // Initialise background job queue (Redis-backed or in-process fallback)
    initJobQueue();
  });
}

export default app;
