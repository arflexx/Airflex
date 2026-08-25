import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { registerRoutes } from "./routes";
import { errorHandler } from "./middleware/errorHandler";

/**
 * Builds and configures the Express application (middleware + routes +
 * global error handler) without binding a port or validating environment
 * variables — those concerns belong to index.ts, which starts the server.
 *
 * Keeping app construction separate from server startup makes the API fully
 * testable via supertest: tests import createApp() instead of index.ts, so
 * no listener is opened and no process.exit() can fire on missing env vars.
 */
export function createApp(): express.Express {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS — tighten origins in production via CORS_ORIGIN env var
  app.use(
    cors({
      origin: process.env["CORS_ORIGIN"] ?? "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  );

  // Request logging (silenced under Jest to keep test output readable)
  if (process.env["NODE_ENV"] !== "test") {
    app.use(morgan(process.env["NODE_ENV"] === "production" ? "combined" : "dev"));
  }

  // JSON body parsing
  app.use(express.json());

  /** Health-check — used by load balancers and uptime monitors */
  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Register all API routes
  registerRoutes(app);

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
