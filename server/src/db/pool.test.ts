import { DB_POOL_DEFAULTS, getPoolStats, resolvePoolConfig } from "./pool";

describe("resolvePoolConfig (issue #680)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const name of [
      "DB_POOL_MAX",
      "DB_IDLE_TIMEOUT_MS",
      "DB_CONNECT_TIMEOUT_MS",
      "DB_POOL_IDLE_TIMEOUT_MS",
      "DB_POOL_CONN_TIMEOUT_MS",
    ]) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses the documented defaults when nothing is configured", () => {
    expect(resolvePoolConfig()).toEqual({
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    expect(resolvePoolConfig()).toEqual(DB_POOL_DEFAULTS);
  });

  it("reads DB_POOL_MAX, DB_IDLE_TIMEOUT_MS and DB_CONNECT_TIMEOUT_MS", () => {
    process.env["DB_POOL_MAX"] = "25";
    process.env["DB_IDLE_TIMEOUT_MS"] = "10000";
    process.env["DB_CONNECT_TIMEOUT_MS"] = "2000";

    expect(resolvePoolConfig()).toEqual({
      max: 25,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 2_000,
    });
  });

  it("still honours the legacy variable names", () => {
    process.env["DB_POOL_IDLE_TIMEOUT_MS"] = "15000";
    process.env["DB_POOL_CONN_TIMEOUT_MS"] = "3000";

    expect(resolvePoolConfig()).toMatchObject({ idleTimeoutMillis: 15_000, connectionTimeoutMillis: 3_000 });
  });

  it("prefers the new names over the legacy ones", () => {
    process.env["DB_IDLE_TIMEOUT_MS"] = "12000";
    process.env["DB_POOL_IDLE_TIMEOUT_MS"] = "15000";

    expect(resolvePoolConfig().idleTimeoutMillis).toBe(12_000);
  });

  it.each(["abc", "-5", "0"])("falls back to the default for an invalid value (%s)", (value) => {
    process.env["DB_POOL_MAX"] = value;
    process.env["DB_CONNECT_TIMEOUT_MS"] = value;

    expect(resolvePoolConfig()).toMatchObject({ max: 10, connectionTimeoutMillis: 5_000 });
  });
});

describe("getPoolStats (issue #680)", () => {
  it("reports max, total, active, idle and waiting counts", () => {
    const stats = getPoolStats();

    expect(stats).toEqual({
      max: expect.any(Number),
      total: expect.any(Number),
      active: expect.any(Number),
      idle: expect.any(Number),
      waiting: expect.any(Number),
    });
    expect(stats.active).toBe(stats.total - stats.idle);
  });
});
