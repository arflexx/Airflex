import request from "supertest";
import jwt from "jsonwebtoken";
import app from "./index";
import pool from "../db";

jest.mock("../db", () => ({ query: jest.fn(), connect: jest.fn() }));

describe("profile endpoints", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const token = jwt.sign({ sub: userId, stellarPublicKey: "GTEST" }, "test-secret");
  const query = pool.query as jest.Mock;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    query.mockReset();
  });

  it("requires authentication", async () => {
    const response = await request(app).get("/api/v1/profile");
    expect(response.status).toBe(401);
  });

  it("rejects invalid profile updates", async () => {
    const response = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ alias: "not valid!" });
    expect(response.status).toBe(422);
  });

  it("updates only supplied profile fields", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: userId, alias: "Alice", notifications_enabled: false }] });
    const response = await request(app)
      .patch("/api/v1/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ alias: "Alice", notificationsEnabled: false });
    expect(response.status).toBe(200);
    expect(response.body.data.alias).toBe("Alice");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE users SET"), ["Alice", false, userId]);
  });

  it("rejects invalid trade-history status", async () => {
    const response = await request(app)
      .get("/api/v1/profile/trades?status=unknown")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(400);
  });
});
