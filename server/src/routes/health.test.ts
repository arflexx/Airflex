/**
 * health.test.ts
 *
 * Tests for GET /health endpoint reporting DB and Redis connectivity (issue #626).
 */

import request from "supertest";
import app from "../index";
import * as poolModule from "../db/pool";
import { cache } from "../services/cache";

describe("GET /health (issue #626)", () => {
  let querySpy: jest.SpyInstance;
  let cachePingSpy: jest.SpyInstance;

  beforeEach(() => {
    querySpy = jest.spyOn(poolModule, "query").mockImplementation(async () => {
      return { rows: [{ "?column?": 1 }] } as any;
    });
    cachePingSpy = jest.spyOn(cache, "ping").mockResolvedValue(true);
  });

  afterEach(() => {
    querySpy.mockRestore();
    cachePingSpy.mockRestore();
  });

  it("returns 200 with status, db ok, redis ok, uptime, and version when healthy", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("ok");
    expect(res.body.redis).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.version).toBeDefined();
    expect(querySpy).toHaveBeenCalledWith("SELECT 1");
    expect(cachePingSpy).toHaveBeenCalled();
  });

  it("returns 503 with db error when DB is unreachable", async () => {
    querySpy.mockRejectedValueOnce(new Error("Database connection refused"));

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.db).toBe("error");
    expect(res.body.redis).toBe("ok");
  });

  it("returns 503 with redis error when Redis is unreachable", async () => {
    cachePingSpy.mockResolvedValueOnce(false);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.db).toBe("ok");
    expect(res.body.redis).toBe("error");
  });
});
