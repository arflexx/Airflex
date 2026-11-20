/**
 * wallet.deposit.idempotency.test.ts
 *
 * Integration tests for X-Idempotency-Key handling on POST /api/v1/wallet/deposit
 * (issue #621).
 */

process.env["JWT_SECRET"] = "test-secret-at-least-32-chars-long!";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
process.env["ESCROW_CONTRACT_ADDRESS"] =
  "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP";
process.env["ENCRYPTION_KEY"] =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
process.env["STELLAR_SERVER_SECRET"] =
  "SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

jest.mock("../db", () => ({
  __esModule: true,
  default: {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT token_version FROM users")) {
        return { rows: [{ token_version: 1 }] };
      }
      return { rows: [] };
    }),
    connect: jest.fn(),
  },
}));

jest.mock("../jobs", () => ({
  QueueService: { enqueue: jest.fn().mockResolvedValue(undefined) },
  initJobQueue: jest.fn(),
}));

jest.mock("../services/notifications", () => ({
  NotificationService: {
    send: jest.fn(),
    sendToMany: jest.fn(),
    sendToAdmins: jest.fn(),
  },
}));

import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../index";
import { cache } from "../services/cache";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

function makeJwt(userId: string): string {
  return jwt.sign(
    { sub: userId, stellarPublicKey: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX" },
    process.env["JWT_SECRET"]!,
    { expiresIn: "1h" }
  );
}

describe("POST /api/v1/wallet/deposit idempotency (issue #621)", () => {
  it("rejects request without X-Idempotency-Key with HTTP 400", async () => {
    const token = makeJwt(USER_A);
    const res = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/X-Idempotency-Key header is required/i);
  });

  it("processes first request and returns 200 with deposit info", async () => {
    const token = makeJwt(USER_A);
    const key = "dep-key-gf-1001";
    const res = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.amount).toBe(5000);
    expect(res.body.reference).toBeDefined();

    // Verify stored in Redis / cache
    const cacheKey = `idempotency:deposit:${USER_A}:${key}`;
    const cached = await cache.get(cacheKey);
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached!);
    expect(parsed.reference).toBe(res.body.reference);
  });

  it("replays cached response on duplicate request within TTL without re-processing", async () => {
    const token = makeJwt(USER_A);
    const key = "dep-key-gf-repeat";

    const res1 = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 2500 });

    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 2500 });

    expect(res2.status).toBe(200);
    expect(res2.header["idempotent-replayed"]).toBe("true");
    expect(res2.body.reference).toBe(res1.body.reference);
    expect(res2.body.amount).toBe(res1.body.amount);
  });

  it("scopes keys per user to prevent cross-user collision", async () => {
    const key = "shared-idempotency-key-gf";

    const resA = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${makeJwt(USER_A)}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 1000 });

    const resB = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${makeJwt(USER_B)}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 1000 });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.reference).not.toBe(resB.body.reference);
  });

  it("re-processes when key is expired", async () => {
    const token = makeJwt(USER_A);
    const key = "dep-key-gf-expiring";

    const res1 = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 3000 });

    const cacheKey = `idempotency:deposit:${USER_A}:${key}`;
    // Simulate expiration
    await cache.set(cacheKey, "", -1);

    const res2 = await request(app)
      .post("/api/v1/wallet/deposit")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Idempotency-Key", key)
      .send({ amount: 3000 });

    expect(res2.status).toBe(200);
    expect(res2.body.reference).not.toBe(res1.body.reference);
  });
});
