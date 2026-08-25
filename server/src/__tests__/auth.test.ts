import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import pool from "../db";
import {
  TERMII_SEND_URL,
  TERMII_VERIFY_URL,
  FRIENDBOT_URL,
  captured,
  server,
} from "./helpers/mockHttp";
import { setupMsw } from "./helpers/mockHttp";
import { app, API, seedUser, signToken } from "./helpers/testApp";
import { setupTestDatabase, queryOne } from "./helpers/testDb";
import { decryptSecret } from "../services/stellar";
import { http, HttpResponse } from "msw";

setupMsw();
setupTestDatabase();

// =============================================================================
// POST /api/v1/auth/request-otp
// =============================================================================
describe("POST /api/v1/auth/request-otp", () => {
  it("200 — sends an OTP via Termii and stores the pin id (new user)", async () => {
    const phone = "+2348012345678";

    const res = await request(app).post(`${API}/auth/request-otp`).send({ phone });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: "OTP sent successfully" });

    // User row was created
    const user = await queryOne<{ id: string; phone: string }>(
      `SELECT id, phone FROM users WHERE phone = $1`,
      [phone]
    );
    expect(user).toBeDefined();

    // Termii received the send request and the pinId was persisted
    expect(captured.termiiSend?.["to"]).toBe(phone);
    const updated = await queryOne<{ otp_pin_id: string }>(
      `SELECT otp_pin_id FROM users WHERE phone = $1`,
      [phone]
    );
    expect(updated?.otp_pin_id).toBe("test-pin-id-123");
  });

  it("200 — reuses the existing user row for a returning phone number", async () => {
    const existing = await seedUser();

    const res = await request(app)
      .post(`${API}/auth/request-otp`)
      .send({ phone: existing.phone });

    expect(res.status).toBe(200);

    const { rows } = await pool.query(`SELECT id FROM users WHERE phone = $1`, [
      existing.phone,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existing.id);
  });

  it("422 — rejects a missing phone", async () => {
    const res = await request(app).post(`${API}/auth/request-otp`).send({});

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "phone" }),
      ])
    );
  });

  it("422 — rejects a malformed phone number", async () => {
    const res = await request(app)
      .post(`${API}/auth/request-otp`)
      .send({ phone: "not-a-phone!" });

    expect(res.status).toBe(422);
    expect(res.body.errors[0].field).toBe("phone");
  });

  it("502 — surfaces a Termii outage without leaking internals", async () => {
    server.use(
      http.post(TERMII_SEND_URL, () => HttpResponse.json({}, { status: 500 }))
    );

    const res = await request(app)
      .post(`${API}/auth/request-otp`)
      .send({ phone: "+2348012345678" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/failed to send otp/i);
  });

  it("502 — responds with 502 when Termii returns no pinId", async () => {
    server.use(http.post(TERMII_SEND_URL, () => HttpResponse.json({ status: "success" })));

    const res = await request(app)
      .post(`${API}/auth/request-otp`)
      .send({ phone: "+2348099999999" });

    expect(res.status).toBe(502);
  });
});

// =============================================================================
// POST /api/v1/auth/verify-otp
// =============================================================================
describe("POST /api/v1/auth/verify-otp", () => {
  const validOtp = "123456";

  async function seedPendingUser(opts?: { expired?: boolean }) {
    return seedUser({
      otpPinId: "pending-pin-id",
      otpExpiresAt: opts?.expired
        ? new Date(Date.now() - 60_000)
        : new Date(Date.now() + 10 * 60_000),
    });
  }

  it("200 — verifies the OTP, provisions a Stellar wallet and issues a JWT", async () => {
    const user = await seedPendingUser();
    let friendbotCalls = 0;
    server.use(
      http.get(FRIENDBOT_URL, () => {
        friendbotCalls += 1;
        return HttpResponse.json({ ok: true });
      })
    );

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: validOtp });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");

    // JWT payload matches the authenticated-user shape
    const payload = jwt.verify(res.body.token, process.env["JWT_SECRET"]!) as {
      sub: string;
      stellarPublicKey: string;
    };
    expect(payload.sub).toBe(user.id);

    expect(payload.stellarPublicKey).toBe(res.body.user.stellarPublicKey);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.phone).toBe(user.phone);
    expect(res.body.user.stellarPublicKey).toMatch(/^G[A-Z2-7]{55}$/);

    // Wallet persisted with an ENCRYPTED secret key + mirrored public key
    const wallet = await queryOne<{
      stellar_public_key: string;
      stellar_secret_key: string;
    }>(`SELECT stellar_public_key, stellar_secret_key FROM wallets WHERE user_id = $1`, [
      user.id,
    ]);
    expect(wallet).toBeDefined();
    expect(wallet!.stellar_public_key).toBe(res.body.user.stellarPublicKey);
    expect(wallet!.stellar_secret_key).not.toMatch(/^S/); // must not be plaintext
    expect(decryptSecret(wallet!.stellar_secret_key)).toMatch(/^S[A-Z2-7]{55}$/);

    // OTP fields cleared after successful verification
    const cleared = await queryOne<{ otp_pin_id: string | null }>(
      `SELECT otp_pin_id FROM users WHERE id = $1`,
      [user.id]
    );
    expect(cleared?.otp_pin_id).toBeNull();

    // Termii received the exact submitted pin, Friendbot funded the wallet
    expect(captured.termiiVerify?.["pin"]).toBe(validOtp);
    expect(friendbotCalls).toBe(1);
  });

  it("200 — does not provision a second wallet when one already exists", async () => {
    const user = await seedUser({ withWallet: true });
    await pool.query(
      `UPDATE users SET otp_pin_id = 'pin', otp_expires_at = NOW() + INTERVAL '10 minutes'
       WHERE id = $1`,
      [user.id]
    );

    let friendbotCalls = 0;
    server.use(
      http.get(FRIENDBOT_URL, () => {
        friendbotCalls += 1;
        return HttpResponse.json({ ok: true });
      })
    );

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: validOtp });

    expect(res.status).toBe(200);
    expect(friendbotCalls).toBe(0);
    expect(res.body.user.stellarPublicKey).toBe(user.publicKey);

    const wallets = await pool.query(`SELECT * FROM wallets WHERE user_id = $1`, [
      user.id,
    ]);
    expect(wallets.rows).toHaveLength(1);
  });

  it("200 — still logs the user in when wallet provisioning fails", async () => {
    const user = await seedPendingUser();
    server.use(http.get(FRIENDBOT_URL, () => HttpResponse.json({}, { status: 500 })));

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: validOtp });

    expect(res.status).toBe(200);
    expect(res.body.user.stellarPublicKey).toBe("");

    const wallet = await queryOne(`SELECT * FROM wallets WHERE user_id = $1`, [user.id]);
    expect(wallet).toBeUndefined();
  });

  it("400 — unknown phone number gets a generic error (no user enumeration)", async () => {
    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: "+2348011111111", otp: validOtp });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid phone number or OTP");
  });

  it("400 — no pending OTP for the number", async () => {
    const user = await seedUser(); // no otp_pin_id set

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: validOtp });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no pending otp/i);
  });

  it("400 — expired OTP is rejected before hitting Termii", async () => {
    const user = await seedPendingUser({ expired: true });

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: validOtp });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
    expect(captured.termiiVerify).toBeNull();
  });

  it("400 — wrong OTP code", async () => {
    const user = await seedPendingUser();
    server.use(
      http.post(TERMII_VERIFY_URL, () => HttpResponse.json({ verified: false }))
    );

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired otp/i);
  });

  it("502 — verification service failure", async () => {
    const user = await seedPendingUser();
    // A network-level failure (fetch rejects) rather than an HTTP error status
    server.use(http.post(TERMII_VERIFY_URL, () => HttpResponse.error()));

    const res = await request(app)
      .post(`${API}/auth/verify-otp`)
      .send({ phone: user.phone, otp: validOtp });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unavailable/i);
  });

  it("422 — missing fields", async () => {
    const res = await request(app).post(`${API}/auth/verify-otp`).send({});
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveLength(2); // both phone and otp missing
  });

  it("422 — malformed OTP (wrong length / non-digits)", async () => {
    const user = await seedPendingUser();

    for (const bad of ["12345", "abcdef", "1234567"]) {
      const res = await request(app)
        .post(`${API}/auth/verify-otp`)
        .send({ phone: user.phone, otp: bad });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe("otp");
    }
  });

  it("401-equivalent guard — token issued by another secret is rejected later", async () => {
    // Sanity check on the JWT contract shared between auth and authenticate:
    // tokens signed with a different secret never pass middleware.
    const forged = jwt.sign({ sub: uuidv4(), stellarPublicKey: "" }, "other-secret");
    const res = await request(app)
      .get(`${API}/profile`)
      .set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });
});
