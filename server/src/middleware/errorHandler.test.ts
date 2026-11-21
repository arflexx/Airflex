import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import { errorHandler } from "./errorHandler";

describe("errorHandler", () => {
  it("includes stack trace in development mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const app = express();
    app.get("/error", (req, res, next) => {
      const err = new Error("Test error");
      err.stack = "test stack trace";
      next(err);
    });
    app.use(errorHandler);

    return request(app).get("/error").expect(500).then((res) => {
      expect(res.body).toHaveProperty("error", "Test error");
      expect(res.body).toHaveProperty("stack", "test stack trace");
      expect(res.body).toHaveProperty("code");
    }).finally(() => {
      process.env.NODE_ENV = originalEnv;
    });
  });

  it("omits stack trace in production mode", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const app = express();
    app.get("/error", (req, res, next) => {
      const err = new Error("Test error");
      err.stack = "test stack trace";
      next(err);
    });
    app.use(errorHandler);

    return request(app).get("/error").expect(500).then((res) => {
      expect(res.body).toHaveProperty("error", "Internal server error");
      expect(res.body).toHaveProperty("code");
      expect(res.body).not.toHaveProperty("stack");
    }).finally(() => {
      process.env.NODE_ENV = originalEnv;
    });
  });

  it("includes custom error code in both environments", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const app = express();
    app.get("/error", (req, res, next) => {
      const err = new Error("Custom error") as Error & { code: string };
      err.code = "CUSTOM_ERROR";
      err.status = 400;
      next(err);
    });
    app.use(errorHandler);

    return request(app).get("/error").expect(400).then((res) => {
      expect(res.body).toHaveProperty("code", "CUSTOM_ERROR");
    }).finally(() => {
      process.env.NODE_ENV = originalEnv;
    });
  });
});
