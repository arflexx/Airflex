import { Express } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import express from "express";
import { Request, Response } from "express";
import { requestId } from "./requestId";
import { apiVersion } from "./apiVersion";

export function applyMiddleware(app: Express): void {
  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: process.env["CORS_ORIGIN"] ?? "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      exposedHeaders: ["X-Api-Version"],
    })
  );
  morgan.token("request-id", (_req: Request, res: Response) => {
    return (res.locals as { requestId?: string }).requestId ?? "-";
  });
  app.use(
    morgan(
      process.env["NODE_ENV"] === "production"
        ? "combined :request-id"
        : "dev :request-id"
    )
  );
  app.use(express.json({ limit: "10kb" }));
  app.use(express.urlencoded({ extended: false, limit: "10kb" }));
  app.use(apiVersion);
}
