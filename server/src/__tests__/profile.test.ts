import request from "supertest";
import { v4 as uuidv4 } from "uuid";
import { app, API, seedUser, seedTrade, signToken } from "./helpers/testApp";
import { setupTestDatabase } from "./helpers/testDb";
import { setupMsw } from "./helpers/mockHttp";

setupMsw();
setupTestDatabase();

// =============================================================================
// GET /api/v1/profile
// =============================================================================
describe("GET /api/v1/profile", () => {
  it("200 — returns masked phone and completed-trade count", async () => {
    const user = await seedUser({ phone: "+2348012345678", withWallet: true });
    const other = await seedUser();

    // 2 completed as seller + 1 completed as buyer + noise that must not count
    await seedTrade({ sellerId: user.id, status: "Completed", createdAtOffsetMs: -3_000 });
    await seedTrade({ sellerId: user.id, status: "Completed", createdAtOffsetMs: -2_000 });
    await seedTrade({ sellerId: other.id, buyerId: user.id, status: "Completed", createdAtOffsetMs: -1_000 });
    await seedTrade({ sellerId: user.id, status: "Active" });
    await seedTrade({ sellerId: other.id, buyerId: user.id, status: "Disputed" });

    const res = await request(app)
      .get(`${API}/profile`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: user.id,
      maskedPhone: "+234 *** *** 5678",
      totalTradesCompleted: 3,
      stellarPublicKey: user.publicKey ?? "",
    });
    expect(res.body.data.createdAt).toBeDefined();
    // The raw phone number must never be exposed
    expect(JSON.stringify(res.body)).not.toContain("+2348012345678");
  });

  it("401 — missing token", async () => {
    const res = await request(app).get(`${API}/profile`);
    expect(res.status).toBe(401);
  });

  it("401 — invalid token", async () => {
    const res = await request(app)
      .get(`${API}/profile`)
      .set({ Authorization: "Bearer invalid.token.value" });
    expect(res.status).toBe(401);
  });

  it("404 — token subject no longer exists (deleted account)", async () => {
    const ghostToken = signToken(uuidv4());

    const res = await request(app)
      .get(`${API}/profile`)
      .set({ Authorization: `Bearer ${ghostToken}` });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/i);
  });
});

// =============================================================================
// GET /api/v1/profile/trades
// =============================================================================
describe("GET /api/v1/profile/trades", () => {
  it("200 — lists trades where the user is seller or buyer, newest first", async () => {
    const user = await seedUser();
    const other = await seedUser();

    await seedTrade({ sellerId: user.id, assetType: "t-oldest", createdAtOffsetMs: -2_000 });
    await seedTrade({ sellerId: other.id, buyerId: user.id, assetType: "t-middle", createdAtOffsetMs: -1_000 });
    await seedTrade({ sellerId: user.id, assetType: "t-newest", createdAtOffsetMs: 0 });
    // Belongs to someone else entirely:
    await seedTrade({ sellerId: other.id, assetType: "not-mine" });

    const res = await request(app)
      .get(`${API}/profile/trades`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { asset_type: string }) => t.asset_type)).toEqual([
      "t-newest",
      "t-middle",
      "t-oldest",
    ]);
    expect(res.body.pagination.total).toBe(3);
  });

  it("200 — filters by status", async () => {
    const user = await seedUser();

    await seedTrade({ sellerId: user.id, status: "Completed" });
    await seedTrade({ sellerId: user.id, status: "Locked" });
    await seedTrade({ sellerId: user.id, status: "Disputed" });

    const res = await request(app)
      .get(`${API}/profile/trades?status=Completed`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("Completed");
    expect(res.body.pagination.total).toBe(1);
  });

  it("200 — clamps out-of-range pagination values instead of failing", async () => {
    const user = await seedUser();
    for (let i = 0; i < 3; i++) {
      await seedTrade({ sellerId: user.id, createdAtOffsetMs: -i * 100 });
    }

    const res = await request(app)
      .get(`${API}/profile/trades?page=abc&limit=99999`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(50); // max clamp
    expect(res.body.data).toHaveLength(3);
  });

  it("401 — unauthenticated", async () => {
    const res = await request(app).get(`${API}/profile/trades`);
    expect(res.status).toBe(401);
  });

  it("200 — empty history for a brand new account", async () => {
    const user = await seedUser();

    const res = await request(app)
      .get(`${API}/profile/trades`)
      .set({ Authorization: `Bearer ${user.token}` });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.totalPages).toBe(0);
  });
});
