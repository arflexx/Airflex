import request from "supertest";
import {
  PAYSTACK_BANKS_URL,
  PAYSTACK_RESOLVE_URL,
  HORIZON_ACCOUNT_URL,
  horizonAccount,
} from "./helpers/mockHttp";
import { setupMsw, server } from "./helpers/mockHttp";
import { app, API, seedUser } from "./helpers/testApp";
import { setupTestDatabase } from "./helpers/testDb";
import { http, HttpResponse } from "msw";

setupMsw();
setupTestDatabase();

// =============================================================================
// GET /api/v1/wallet
// =============================================================================
describe("GET /api/v1/wallet", () => {
  it("200 — returns the public key and live XLM balance (Horizon mocked)", async () => {
    const user = await seedUser({ withWallet: true });

    const res = await request(app).get(`${API}/wallet`).set({
      Authorization: `Bearer ${user.token}`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      publicKey: user.publicKey,
      balance: "10000.0000000",
      asset: "XLM",
      network: "testnet",
    });
    // The secret key must never be part of the response
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("401 — missing Authorization header", async () => {
    const res = await request(app).get(`${API}/wallet`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authorization/i);
  });

  it("401 — invalid token", async () => {
    const res = await request(app)
      .get(`${API}/wallet`)
      .set({ Authorization: "Bearer garbage.token.here" });
    expect(res.status).toBe(401);
  });

  it("404 — user has no wallet provisioned yet", async () => {
    const user = await seedUser(); // no wallet

    const res = await request(app)
      .get(`${API}/wallet`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/wallet not found/i);
  });

  it("502 — Horizon outage is surfaced as a bad gateway", async () => {
    const user = await seedUser({ withWallet: true });
    server.use(
      http.get(HORIZON_ACCOUNT_URL, () =>
        HttpResponse.json({ title: "InternalServerError" }, { status: 500 })
      )
    );

    const res = await request(app)
      .get(`${API}/wallet`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/balance/i);
  });

  it("200 — unfunded account reports a zero balance", async () => {
    const user = await seedUser({ withWallet: true });
    server.use(
      http.get(HORIZON_ACCOUNT_URL, ({ params }) =>
        HttpResponse.json(horizonAccount(params["publicKey"] as string, "0.0000000"))
      )
    );

    const res = await request(app)
      .get(`${API}/wallet`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe("0.0000000");
  });
});

// =============================================================================
// GET /api/v1/wallet/banks
// =============================================================================
describe("GET /api/v1/wallet/banks", () => {
  it("200 — returns the Paystack bank list", async () => {
    const user = await seedUser();

    const res = await request(app)
      .get(`${API}/wallet/banks`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.banks).toHaveLength(2);
    expect(res.body.banks[0]).toMatchObject({ name: "Access Bank", code: "044" });
  });

  it("401 — unauthenticated", async () => {
    const res = await request(app).get(`${API}/wallet/banks`);
    expect(res.status).toBe(401);
  });

  it("502 — Paystack failure", async () => {
    const user = await seedUser();
    server.use(
      http.get(PAYSTACK_BANKS_URL, () =>
        HttpResponse.json({}, { status: 500 })
      )
    );

    const res = await request(app)
      .get(`${API}/wallet/banks`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(502);
  });
});

// =============================================================================
// GET /api/v1/wallet/resolve-account
// =============================================================================
describe("GET /api/v1/wallet/resolve-account", () => {
  function resolve(user: { token: string }, qs = "?account_number=0123456789&bank_code=058") {
    return request(app)
      .get(`${API}/wallet/resolve-account${qs}`)
      .set({ Authorization: `Bearer ${user.token}` });
  }

  it("200 — resolves an account number to the holder's name", async () => {
    const user = await seedUser();

    const res = await resolve(user);

    expect(res.status).toBe(200);
    expect(res.body.account_name).toBe("JANE DOE");
  });

  it("401 — unauthenticated", async () => {
    const res = await request(app).get(`${API}/wallet/resolve-account?account_number=1&bank_code=2`);
    expect(res.status).toBe(401);
  });

  it("400 — missing query parameters", async () => {
    const user = await seedUser();

    const res = await resolve(user, "");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("502 — account cannot be resolved via Paystack", async () => {
    const user = await seedUser();
    server.use(
      http.get(PAYSTACK_RESOLVE_URL, () =>
        HttpResponse.json({ status: false }, { status: 400 })
      )
    );

    const res = await resolve(user);

    expect(res.status).toBe(502);
  });
});

// =============================================================================
// POST /api/v1/wallet/withdraw
// =============================================================================
describe("POST /api/v1/wallet/withdraw", () => {
  const validBody = {
    amount: "100",
    bank_code: "058",
    account_number: "0123456789",
    account_name: "JANE DOE",
  };

  function withdraw(token: string, body: Record<string, unknown>) {
    return request(app)
      .post(`${API}/wallet/withdraw`)
      .set({ Authorization: `Bearer ${token}` })
      .send(body);
  }

  it("200 — accepts a valid withdrawal request", async () => {
    const user = await seedUser({ withWallet: true }); // Horizon balance 10 000 XLM

    const res = await withdraw(user.token, validBody);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("401 — unauthenticated", async () => {
    const res = await request(app).post(`${API}/wallet/withdraw`).send(validBody);
    expect(res.status).toBe(401);
  });

  it("400 — missing required fields", async () => {
    const user = await seedUser({ withWallet: true });

    const res = await withdraw(user.token, { amount: "100" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/all fields are required/i);
  });

  it("400 — invalid amount (non-positive)", async () => {
    const user = await seedUser({ withWallet: true });

    for (const amount of ["0", "-5", "abc"]) {
      const res = await withdraw(user.token, { ...validBody, amount });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/amount/i);
    }
  });

  it("404 — wallet not found", async () => {
    const user = await seedUser(); // without wallet

    const res = await withdraw(user.token, validBody);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/wallet not found/i);
  });

  it("400 — insufficient balance", async () => {
    const user = await seedUser({ withWallet: true }); // balance is 10 000

    const res = await withdraw(user.token, { ...validBody, amount: "999999" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });

  it("502 — balance lookup failure aborts the withdrawal", async () => {
    const user = await seedUser({ withWallet: true });
    server.use(
      http.get(HORIZON_ACCOUNT_URL, () =>
        HttpResponse.json({ title: "InternalServerError" }, { status: 500 })
      )
    );

    const res = await withdraw(user.token, validBody);

    expect(res.status).toBe(502);
  });
});
