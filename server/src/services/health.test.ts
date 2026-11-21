import { checkHealth, type HealthDeps } from "./health";

const deps = (overrides: Partial<HealthDeps> = {}): HealthDeps => ({
  pingDb: jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
  pingRedis: jest.fn().mockResolvedValue("PONG"),
  redisConfigured: true,
  version: "1.0.0",
  ...overrides,
});

describe("checkHealth (#633)", () => {
  it("returns 200 with every component ok", async () => {
    const report = await checkHealth(deps());
    expect(report.httpStatus).toBe(200);
    expect(report.body).toMatchObject({ status: "ok", db: "ok", redis: "ok", version: "1.0.0" });
    expect(Number.isInteger(report.body.uptime)).toBe(true);
  });

  it("returns 503 and marks db as error when SELECT 1 fails", async () => {
    const report = await checkHealth(deps({ pingDb: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")) }));
    expect(report.httpStatus).toBe(503);
    expect(report.body).toMatchObject({ status: "error", db: "error", redis: "ok" });
  });

  it("returns 503 and marks redis as error when PING fails", async () => {
    const report = await checkHealth(deps({ pingRedis: jest.fn().mockRejectedValue(new Error("down")) }));
    expect(report.httpStatus).toBe(503);
    expect(report.body).toMatchObject({ status: "error", db: "ok", redis: "error" });
  });

  it("treats a non-PONG reply as a redis error", async () => {
    const report = await checkHealth(deps({ pingRedis: jest.fn().mockResolvedValue(null) }));
    expect(report.body.redis).toBe("error");
  });

  it("reports redis as disabled, not failing, when it is not configured", async () => {
    const pingRedis = jest.fn();
    const report = await checkHealth(deps({ redisConfigured: false, pingRedis }));
    expect(report.httpStatus).toBe(200);
    expect(report.body.redis).toBe("disabled");
    expect(pingRedis).not.toHaveBeenCalled();
  });

  it("marks a hung dependency as error after the timeout", async () => {
    const report = await checkHealth(
      deps({ pingDb: () => new Promise(() => undefined), timeoutMs: 10 })
    );
    expect(report.httpStatus).toBe(503);
    expect(report.body.db).toBe("error");
  });
});
