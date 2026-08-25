import request from "supertest";
import { app, API } from "./helpers/testApp";
import { setupTestDatabase } from "./helpers/testDb";
import { setupMsw } from "./helpers/mockHttp";

/**
 * The webhook routes are 501 stubs at this stage of the project. The suite
 * still pins down their current contract (status code + body shape) so any
 * accidental change is caught, and verifies the JSON body parser in front of
 * them. Auth/validation/404 scenarios are not applicable until real handlers
 * are implemented — documented here as an accepted deviation from the
 * standard per-file matrix.
 */
setupMsw();
setupTestDatabase();

describe("POST /api/v1/webhooks/stellar", () => {
  it("501 — stub responds with Not Implemented for any payload", async () => {
    const res = await request(app)
      .post(`${API}/webhooks/stellar`)
      .send({ type: "transaction" });

    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: "Not Implemented" });
  });

  it("400 — malformed JSON is rejected by the body parser before routing", async () => {
    const res = await request(app)
      .post(`${API}/webhooks/stellar`)
      .set("Content-Type", "application/json")
      .send('{"broken": ');

    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/webhooks/payment", () => {
  it("501 — stub responds with Not Implemented", async () => {
    const res = await request(app)
      .post(`${API}/webhooks/payment`)
      .send({ event: "charge.success" });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Not Implemented");
  });

  it("400 — malformed JSON is rejected by the body parser", async () => {
    const res = await request(app)
      .post(`${API}/webhooks/payment`)
      .set("Content-Type", "application/json")
      .send("not json at all");

    expect(res.status).toBe(400);
  });
});
