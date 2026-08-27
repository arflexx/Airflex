import "dotenv/config";
import "express-async-errors";
import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { registerRoutes } from "./routes";
import logger from "./utils/logger";
import { errorHandler } from "./middleware/errorHandler";
import { apiVersion } from "./middleware/apiVersion";
import { requestId } from "./middleware/requestId";
import { pool, query } from "./db/pool";
import { initJobQueue } from "./jobs";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const REQUIRED_ENV_VARS = [
  "JWT_SECRET",
  "DATABASE_URL",
  "ESCROW_CONTRACT_ADDRESS",
  "ENCRYPTION_KEY",
  "STELLAR_SERVER_SECRET",
  "PLATFORM_TREASURY_USER_ID",
] as const;

const missingVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

if (missingVars.length > 0) {
  // Use console.error here — logger may not be fully initialised yet
  console.error(
    `[startup] Missing required environment variables: ${missingVars.join(", ")}\n` +
      `Copy server/.env.example to server/.env and fill in the values.`
  );
  if (process.env["NODE_ENV"] !== "test" && process.env["JEST_WORKER_ID"] === undefined) process.exit(1);
}

// Validate ENCRYPTION_KEY format: must be exactly 64 hex characters
const encryptionKey = process.env["ENCRYPTION_KEY"];
if (encryptionKey && !/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  console.error(
    "[startup] ENCRYPTION_KEY must be a 64-character hex string"
  );
  if (process.env["NODE_ENV"] !== "test" && process.env["JEST_WORKER_ID"] === undefined) process.exit(1);
}

// ---------------------------------------------------------------------------
// Database connection test on startup
// ---------------------------------------------------------------------------

const testQueryText = "SELECT 1";
if (process.env["NODE_ENV"] !== "test") pool.query(testQueryText)
  .then(() => {
    logger.info({ query: testQueryText }, "Database connection validated");
  })
  .catch((err) => {
    console.error(
      `[startup] Database connection failed: ${err.message}\n` +
        "Verify DATABASE_URL is correct and PostgreSQL is reachable.\n" +
        "Server exiting."
    );
    if (process.env["NODE_ENV"] !== "test" && process.env["JEST_WORKER_ID"] === undefined) process.exit(1);
  });

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = parseInt(process.env["PORT"] ?? "3001", 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Generate per-request UUID for correlation (must be first middleware)
app.use(requestId);

// Security headers
app.use(helmet());

// CORS — tighten origins in production via CORS_ORIGIN env var
app.use(
  cors({
    origin: process.env["CORS_ORIGIN"] ?? "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Api-Version"],
  })
);

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

// JSON body parsing
app.use(express.json());

// Inject X-Api-Version header on every response
app.use(apiVersion);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health-check — used by load balancers and uptime monitors */
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

/** Readiness probe — confirms DB connectivity before accepting traffic */
app.get("/ready", async (_req: Request, res: Response) => {
  try {
    await query("SELECT 1");
    res.status(200).json({ status: "ready", db: "ok" });
  } catch {
    res.status(503).json({ status: "not ready", db: "error" });
  }
});

// Register all API routes
registerRoutes(app);

// ---------------------------------------------------------------------------
// Global error handler  (must be last)
// ---------------------------------------------------------------------------

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (process.env["NODE_ENV"] !== "test") app.listen(PORT, () => {
  logger.info(
    { port: PORT, env: process.env["NODE_ENV"] ?? "development" },
    "AirFlex API started"
  );

  // Initialise background job queue (Redis-backed or in-process fallback)
  initJobQueue();
});

export default app;
