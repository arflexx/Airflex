import request from "supertest";
import jwt from "jsonwebtoken";
import app from "./index";
import pool from "../db";

jest.mock("../db", () => ({ query: jest.fn(), connect: jest.fn() }));

describe("admin KYC endpoint", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const token = jwt.sign({ sub: userId, stellarPublicKey: "GTEST" }, "test-secret");
  const query = pool.query as jest.Mock;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    query.mockReset();
  });

  it("requires admin role", async () => {
    query.mockResolvedValueOnce({ rows: [{ role: "user" }] });
    const response = await request(app)
      .patch(`/api/v1/admin/users/${userId}/kyc`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "verified" });
    expect(response.status).toBe(403);
  });

  it("validates KYC status", async () => {
    query.mockResolvedValueOnce({ rows: [{ role: "admin" }] });
    const response = await request(app)
      .patch(`/api/v1/admin/users/${userId}/kyc`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });
    expect(response.status).toBe(422);
  });

  it("updates a user's KYC status", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ role: "admin" }] })
      .mockResolvedValueOnce({ rows: [{ id: userId, kyc_status: "verified" }] });
    const response = await request(app)
      .patch(`/api/v1/admin/users/${userId}/kyc`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "verified" });
    expect(response.status).toBe(200);
    expect(response.body.data.kyc_status).toBe("verified");
  });
});
