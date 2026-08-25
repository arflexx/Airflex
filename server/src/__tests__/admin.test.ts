import request from "supertest";
import { app, API } from "./helpers/testApp";
import { setupTestDatabase } from "./helpers/testDb";
import { setupMsw } from "./helpers/mockHttp";

/**
 * The admin routes are 501 stubs at this stage of the project. The suite pins
 * their current contract; once real handlers land (with admin auth), the
 * 401/403 and data scenarios extend these files. Documented deviation: no
 * auth middleware exists on admin routes yet.
 */
setupMsw();
setupTestDatabase();

describe("GET /api/v1/admin/users", () => {
  it("501 — stub", async () => {
    const res = await request(app).get(`${API}/admin/users`);
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Not Implemented" });
  });
});

describe("GET /api/v1/admin/trades", () => {
  it("501 — stub", async () => {
    const res = await request(app).get(`${API}/admin/trades`);
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Not Implemented");
  });
});

describe("PATCH /api/v1/admin/users/:id", () => {
  it("501 — stub", async () => {
    const res = await request(app)
      .patch(`${API}/admin/users/11111111-1111-1111-1111-111111111111`)
      .send({ banned: true });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Not Implemented");
  });
});
