import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the AirFlex frontend (Issue #30).
 *
 * Every spec runs against mocked API responses via `page.route` intercepts —
 * no live server, no blockchain. That keeps the suite deterministic in CI and
 * means a failure points at the frontend rather than at whatever the backend
 * happened to be doing.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: process.env["PLAYWRIGHT_BASE_URL"] ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  // Two servers: the app, and a stub API for it to talk to. Server Components
  // fetch from Node, where browser-level route intercepts cannot reach them, so
  // SSR pages need a real endpoint. Client-side calls are still intercepted
  // per-test, which is where per-test control belongs.
  webServer: [
    {
      command: "node e2e/support/mock-api.mjs",
      url: "http://localhost:3001/health",
      reuseExistingServer: !process.env["CI"],
      timeout: 30_000,
    },
    {
      command: "pnpm dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
  ],
});
