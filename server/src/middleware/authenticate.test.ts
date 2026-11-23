/**
 * authenticate.test.ts
 *
 * Unit tests for the `authenticate` middleware, focused on JWT `iss` and `aud`
 * claim enforcement (issue — JWT audience/issuer validation).
 *
 * Cases covered:
 *   1. Valid token (correct iss + aud + unexpired) — passes through to next().
 *   2. Wrong `iss` claim — HTTP 401.
 *   3. Wrong `aud` claim — HTTP 401.
 *   4. Both `iss` and `aud` wrong — HTTP 401.
 *   5. Missing `iss` claim (token signed without issuer option) — HTTP 401.
 *   6. Missing `aud` claim (token signed without audience option) — HTTP 401.
 *   7. Expired token — HTTP 401 (baseline; unaffected by this change).
 *   8. Token version mismatch (revoked) — HTTP 401 (revocation path not affected).
 *
 * The DB pool and logger are mocked so no real Postgres connection is required.
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { authenticate } from "./authenticate";

// ---------------------------------------------------------------------------
// Constants shared across tests
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-secret-key-must-be-at-least-32-chars!";
const ISSUER = "airflex-server-test";
const AUDIENCE = "airflex-client-test";

// Pin env vars before the module under test is loaded.
process.env["JWT_SECRET"] = JWT_SECRET;
process.env["JWT_ISSUER"] = ISSUER;
process.env["JWT_AUDIENCE"] = AUDIENCE;

// ---------------------------------------------------------------------------
// Mock the DB pool so isTokenVersionCurrent() doesn't need a real database.
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
jest.mock("../db", () => ({
  __esModule: true,
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal valid JWT payload. */
function makeToken(overrides: jwt.SignOptions & { payload?: Record<string, unknown> } = {}): string {
  const { payload = {}, ...signOpts } = overrides;
  return jwt.sign(
    { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1, ...payload },
    JWT_SECRET,
    { issuer: ISSUER, audience: AUDIENCE, expiresIn: "1h", ...signOpts },
  );
}

/** Builds an Express-like mock request with the given Authorization header value. */
function makeReq(authorization?: string): Request {
  return {
    headers: { authorization },
  } as unknown as Request;
}

/** Captures the status code and JSON body passed to res.status().json(). */
function makeRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return { res: { status } as unknown as Response, status, json };
}

// ---------------------------------------------------------------------------
// 1. Valid token
// ---------------------------------------------------------------------------

describe("authenticate — valid token", () => {
  it("calls next() and attaches req.user when iss and aud are correct", async () => {
    // DB returns a matching token_version.
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 1 }] });

    const token = makeToken();
    const req = makeReq(`Bearer ${token}`);
    const { res } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).user.sub).toBe("user-123");
  });
});

// ---------------------------------------------------------------------------
// 2. Wrong `iss`
// ---------------------------------------------------------------------------

describe("authenticate — wrong iss", () => {
  it("returns 401 when the token was issued by a different service", async () => {
    const token = jwt.sign(
      { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1 },
      JWT_SECRET,
      { issuer: "staging-server", audience: AUDIENCE, expiresIn: "1h" },
    );

    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token is invalid or expired" });
  });
});

// ---------------------------------------------------------------------------
// 3. Wrong `aud`
// ---------------------------------------------------------------------------

describe("authenticate — wrong aud", () => {
  it("returns 401 when the token targets a different audience", async () => {
    const token = jwt.sign(
      { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1 },
      JWT_SECRET,
      { issuer: ISSUER, audience: "different-client", expiresIn: "1h" },
    );

    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token is invalid or expired" });
  });
});

// ---------------------------------------------------------------------------
// 4. Both iss and aud wrong
// ---------------------------------------------------------------------------

describe("authenticate — both iss and aud wrong", () => {
  it("returns 401 when both claims are wrong", async () => {
    const token = jwt.sign(
      { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1 },
      JWT_SECRET,
      { issuer: "wrong-issuer", audience: "wrong-audience", expiresIn: "1h" },
    );

    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token is invalid or expired" });
  });
});

// ---------------------------------------------------------------------------
// 5. Missing `iss` claim
// ---------------------------------------------------------------------------

describe("authenticate — missing iss claim", () => {
  it("returns 401 when the token was signed without an issuer", async () => {
    // No issuer option — token has no `iss` field.
    const token = jwt.sign(
      { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1 },
      JWT_SECRET,
      { audience: AUDIENCE, expiresIn: "1h" },
    );

    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token is invalid or expired" });
  });
});

// ---------------------------------------------------------------------------
// 6. Missing `aud` claim
// ---------------------------------------------------------------------------

describe("authenticate — missing aud claim", () => {
  it("returns 401 when the token was signed without an audience", async () => {
    const token = jwt.sign(
      { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1 },
      JWT_SECRET,
      { issuer: ISSUER, expiresIn: "1h" },
    );

    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token is invalid or expired" });
  });
});

// ---------------------------------------------------------------------------
// 7. Expired token (baseline — unaffected by this change)
// ---------------------------------------------------------------------------

describe("authenticate — expired token", () => {
  it("returns 401 for an expired token regardless of correct iss/aud", async () => {
    const token = jwt.sign(
      { sub: "user-123", stellarPublicKey: "GPUB", tokenVersion: 1 },
      JWT_SECRET,
      { issuer: ISSUER, audience: AUDIENCE, expiresIn: 0 }, // expires immediately
    );

    // Small delay to ensure the token is past its `exp`.
    await new Promise((r) => setTimeout(r, 10));

    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token is invalid or expired" });
  });
});

// ---------------------------------------------------------------------------
// 8. Revoked token (token_version mismatch) — revocation logic unchanged
// ---------------------------------------------------------------------------

describe("authenticate — revoked token", () => {
  it("returns 401 when the DB token_version is ahead of the token's version", async () => {
    // Token carries version 1 but DB has been bumped to 2 (POST /auth/revoke was called).
    mockQuery.mockResolvedValueOnce({ rows: [{ token_version: 2 }] });

    const token = makeToken(); // tokenVersion: 1
    const req = makeReq(`Bearer ${token}`);
    const { res, status, json } = makeRes();
    const next: NextFunction = jest.fn();

    await authenticate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Token has been revoked" });
  });
});
