import express from "express";
import cors from "cors";
import request from "supertest";
import {
  buildCorsOptions,
  isOriginAllowed,
  parseAllowedOrigins,
  validateCorsEnv,
  strictOriginError,
} from "./cors";
import { validateEnv } from "./validateEnv";

// ---------------------------------------------------------------------------
// Minimal valid production env — shared across validateEnv integration tests.
// Includes JWT_ISSUER and JWT_AUDIENCE added in the iss/aud hardening change
// so those checks don't cause unrelated failures here.
// ---------------------------------------------------------------------------
const BASE_PROD_ENV: Record<string, string> = {
  JWT_SECRET: "a_long_random_string_at_least_32_chars",
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/airflex",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  STELLAR_SERVER_SECRET: "S000000000000000000000000000000000000000000000000000000",
  PLATFORM_TREASURY_USER_ID: "00000000-0000-0000-0000-000000000000",
  PAYSTACK_SECRET_KEY: "sk_test_1234567890",
  TERMII_API_KEY: "TL12345678901234567890",
  REDIS_URL: "redis://localhost:6379",
  NODE_ENV: "production",
  JWT_ISSUER: "airflex-server",
  JWT_AUDIENCE: "airflex-client",
};

describe("CORS allowlist (issue #539)", () => {
  // ---------------------------------------------------------------------------
  // strictOriginError — the strict format validator
  // ---------------------------------------------------------------------------
  describe("strictOriginError", () => {
    it("returns null for a valid bare HTTPS origin", () => {
      expect(strictOriginError("https://airflex.app")).toBeNull();
    });

    it("returns null for a valid bare HTTP origin (dev use)", () => {
      expect(strictOriginError("http://localhost:3000")).toBeNull();
    });

    it("returns null for a valid origin with a non-standard port", () => {
      expect(strictOriginError("https://airflex.app:8443")).toBeNull();
    });

    it("returns an error for a trailing slash", () => {
      const err = strictOriginError("https://airflex.app/");
      expect(err).not.toBeNull();
      expect(err).toMatch(/trailing slash|pathname/i);
    });

    it("returns an error for an origin with a path", () => {
      const err = strictOriginError("https://airflex.app/api/v1");
      expect(err).not.toBeNull();
      expect(err).toMatch(/path/i);
    });

    it("returns an error for an origin with a query string", () => {
      const err = strictOriginError("https://airflex.app?foo=bar");
      expect(err).not.toBeNull();
      expect(err).toMatch(/query string/i);
    });

    it("returns an error for an origin with a fragment", () => {
      const err = strictOriginError("https://airflex.app#section");
      expect(err).not.toBeNull();
      expect(err).toMatch(/fragment/i);
    });

    it("returns an error for a scheme-less value", () => {
      const err = strictOriginError("airflex.app");
      expect(err).not.toBeNull();
    });

    it("returns an error for a non-http(s) scheme", () => {
      const err = strictOriginError("ftp://airflex.app");
      expect(err).not.toBeNull();
      expect(err).toMatch(/http/i);
    });
  });

  // ---------------------------------------------------------------------------
  // validateCorsEnv
  // ---------------------------------------------------------------------------
  describe("validateCorsEnv", () => {
    it("returns no errors for a valid bare origin", () => {
      expect(validateCorsEnv({ CORS_ALLOWED_ORIGINS: "https://airflex.app" })).toHaveLength(0);
    });

    it("returns no errors for multiple valid bare origins", () => {
      expect(
        validateCorsEnv({ CORS_ALLOWED_ORIGINS: "https://airflex.app,https://www.airflex.app" }),
      ).toHaveLength(0);
    });

    it("returns no errors when CORS_ALLOWED_ORIGINS is unset", () => {
      expect(validateCorsEnv({})).toHaveLength(0);
    });

    it("errors on a trailing slash", () => {
      const errs = validateCorsEnv({ CORS_ALLOWED_ORIGINS: "https://airflex.app/" });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/\[startup\] Invalid CORS origin/);
    });

    it("errors on a path after the host", () => {
      const errs = validateCorsEnv({ CORS_ALLOWED_ORIGINS: "https://airflex.app/foo" });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/\[startup\] Invalid CORS origin/);
    });

    it("errors on a query string", () => {
      const errs = validateCorsEnv({ CORS_ALLOWED_ORIGINS: "https://airflex.app?x=1" });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/\[startup\] Invalid CORS origin/);
    });

    it("errors on a wildcard in production", () => {
      const errs = validateCorsEnv({ NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "*" });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/Wildcard CORS origin/);
    });

    it("allows a wildcard outside production", () => {
      expect(
        validateCorsEnv({ NODE_ENV: "development", CORS_ALLOWED_ORIGINS: "*" }),
      ).toHaveLength(0);
    });

    it("reports one error per malformed entry", () => {
      const errs = validateCorsEnv({
        CORS_ALLOWED_ORIGINS: "https://airflex.app/,https://good.example,https://bad.example/path",
      });
      // Two bad entries, one good
      expect(errs).toHaveLength(2);
    });

    it("errors on a scheme-less entry", () => {
      const errs = validateCorsEnv({ CORS_ALLOWED_ORIGINS: "airflex.app" });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(/\[startup\] Invalid CORS origin/);
    });
  });

  // ---------------------------------------------------------------------------
  // parseAllowedOrigins
  // ---------------------------------------------------------------------------
  describe("parseAllowedOrigins", () => {
    it("parses and normalises a comma-separated allowlist", () => {
      const allowed = parseAllowedOrigins({
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: " https://airflex.app , https://www.airflex.app,https://airflex.app",
      });
      expect(allowed).toEqual({
        allowAll: false,
        origins: ["https://airflex.app", "https://www.airflex.app"],
      });
    });

    it("falls back to the legacy CORS_ORIGIN variable", () => {
      expect(parseAllowedOrigins({ CORS_ORIGIN: "https://airflex.app" }).origins).toEqual([
        "https://airflex.app",
      ]);
    });

    it("throws on a wildcard in production", () => {
      expect(() =>
        parseAllowedOrigins({ NODE_ENV: "production", CORS_ALLOWED_ORIGINS: "*" })
      ).toThrow(/not allowed in production/);
    });

    it("honours a wildcard outside production", () => {
      expect(
        parseAllowedOrigins({ NODE_ENV: "development", CORS_ALLOWED_ORIGINS: "*" }).allowAll,
      ).toBe(true);
    });

    it("fails closed in production when unset, defaults to localhost in development", () => {
      expect(parseAllowedOrigins({ NODE_ENV: "production" }).origins).toEqual([]);
      expect(parseAllowedOrigins({ NODE_ENV: "development" }).origins).toEqual([
        "http://localhost:3000",
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // isOriginAllowed
  // ---------------------------------------------------------------------------
  describe("isOriginAllowed", () => {
    const allowed = { allowAll: false, origins: ["https://airflex.app"] };

    it("matches exact origins only", () => {
      expect(isOriginAllowed("https://airflex.app", allowed)).toBe(true);
      expect(isOriginAllowed("https://evil.airflex.app", allowed)).toBe(false);
      expect(isOriginAllowed("http://airflex.app", allowed)).toBe(false);
      expect(isOriginAllowed("https://airflex.app.evil.com", allowed)).toBe(false);
      expect(isOriginAllowed("null", allowed)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // validateEnv integration
  // ---------------------------------------------------------------------------
  describe("validateEnv integration", () => {
    it("refuses to boot with a wildcard origin in production", () => {
      const result = validateEnv({ ...BASE_PROD_ENV, CORS_ALLOWED_ORIGINS: "https://airflex.app,*" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Wildcard CORS origin"))).toBe(true);
    });

    it("refuses to boot with a trailing slash in production", () => {
      const result = validateEnv({ ...BASE_PROD_ENV, CORS_ALLOWED_ORIGINS: "https://airflex.app/" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Invalid CORS origin"))).toBe(true);
    });

    it("refuses to boot with a path in production", () => {
      const result = validateEnv({ ...BASE_PROD_ENV, CORS_ALLOWED_ORIGINS: "https://airflex.app/api" });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Invalid CORS origin"))).toBe(true);
    });

    it("rejects malformed origins (scheme-less)", () => {
      expect(validateCorsEnv({ CORS_ALLOWED_ORIGINS: "airflex.app" })[0]).toMatch(
        /Invalid CORS origin/,
      );
    });

    it("accepts an explicit bare allowlist in production", () => {
      expect(
        validateEnv({ ...BASE_PROD_ENV, CORS_ALLOWED_ORIGINS: "https://airflex.app" }).valid,
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // middleware behaviour
  // ---------------------------------------------------------------------------
  describe("middleware behaviour", () => {
    function buildApp() {
      const app = express();
      app.use(
        cors(
          buildCorsOptions({
            NODE_ENV: "production",
            CORS_ALLOWED_ORIGINS: "https://airflex.app",
          }),
        ),
      );
      app.options("*", (_req, res) => {
        res.status(204).end();
      });
      app.get("/api/v1/profile", (req, res) => {
        if (!req.headers.authorization) {
          res.status(401).json({ error: "Missing or invalid Authorization header" });
          return;
        }
        res.json({ ok: true });
      });
      return app;
    }

    it("answers a preflight from an allowlisted origin with 204 and CORS headers", async () => {
      const res = await request(buildApp())
        .options("/api/v1/profile")
        .set("Origin", "https://airflex.app")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "authorization,idempotency-key");

      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("https://airflex.app");
      expect(res.headers["access-control-allow-headers"]).toMatch(/Authorization/);
      expect(res.headers["access-control-allow-headers"]).toMatch(/Idempotency-Key/);
      expect(res.headers["vary"]).toMatch(/Origin/);
    });

    it("omits CORS headers for an unlisted origin", async () => {
      const res = await request(buildApp())
        .options("/api/v1/profile")
        .set("Origin", "https://evil.example")
        .set("Access-Control-Request-Method", "GET");

      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("reflects the exact allowlisted origin, never a wildcard", async () => {
      const res = await request(buildApp())
        .get("/api/v1/profile")
        .set("Origin", "https://airflex.app")
        .set("Authorization", "Bearer x");

      expect(res.headers["access-control-allow-origin"]).toBe("https://airflex.app");
    });
  });
});
