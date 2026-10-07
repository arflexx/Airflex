import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadBaseline,
  readMetrics,
  evaluateScenario,
  generateReport,
  runComparison,
} from "./compare-baseline.mjs";

test("loadBaseline parses thresholds and scenarios correctly", () => {
  const { thresholds, scenarios } = loadBaseline();
  assert.equal(thresholds.maxP95DegradationPercent, 20);
  assert.equal(thresholds.maxErrorRate, 0.01);
  assert.ok(scenarios.marketplace);
  assert.ok(scenarios["otp-burst"]);
  assert.ok(scenarios["trade-create"]);
  assert.equal(typeof scenarios.marketplace.p95Ms, "number");
  assert.equal(typeof scenarios.marketplace.errorRate, "number");
  assert.equal(typeof scenarios.marketplace.rps, "number");
});

test("evaluateScenario passes on normal/improved performance", () => {
  const thresholds = { maxP95DegradationPercent: 20, maxErrorRate: 0.01 };
  const baseline = { p95Ms: 150, errorRate: 0.0, rps: 95.0 };
  const current = { p95Ms: 160, errorRate: 0.005, rps: 96.0 };

  const result = evaluateScenario("marketplace", current, baseline, thresholds);
  assert.equal(result.status, "PASS");
  assert.equal(result.reasons.length, 0);
  assert.ok(result.p95DegradationPercent < 20);
});

test("evaluateScenario fails when p95 degrades by more than 20%", () => {
  const thresholds = { maxP95DegradationPercent: 20, maxErrorRate: 0.01 };
  const baseline = { p95Ms: 150, errorRate: 0.0, rps: 95.0 };
  // 150 * 1.25 = 187.5 (> 20% degradation)
  const current = { p95Ms: 187.5, errorRate: 0.0, rps: 80.0 };

  const result = evaluateScenario("marketplace", current, baseline, thresholds);
  assert.equal(result.status, "FAIL");
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /p95 response time degraded by 25.0%/);
});

test("evaluateScenario fails when error rate exceeds 1%", () => {
  const thresholds = { maxP95DegradationPercent: 20, maxErrorRate: 0.01 };
  const baseline = { p95Ms: 150, errorRate: 0.0, rps: 95.0 };
  const current = { p95Ms: 140, errorRate: 0.015, rps: 95.0 }; // 1.5% > 1.0%

  const result = evaluateScenario("marketplace", current, baseline, thresholds);
  assert.equal(result.status, "FAIL");
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /error rate 1.50% exceeds threshold 1.00%/);
});

test("evaluateScenario fails on both p95 degradation and error rate threshold breach", () => {
  const thresholds = { maxP95DegradationPercent: 20, maxErrorRate: 0.01 };
  const baseline = { p95Ms: 150, errorRate: 0.0, rps: 95.0 };
  const current = { p95Ms: 200, errorRate: 0.03, rps: 70.0 };

  const result = evaluateScenario("marketplace", current, baseline, thresholds);
  assert.equal(result.status, "FAIL");
  assert.equal(result.reasons.length, 2);
});

test("evaluateScenario marks missing/skipped metrics as SKIPPED", () => {
  const thresholds = { maxP95DegradationPercent: 20, maxErrorRate: 0.01 };
  const baseline = { p95Ms: 220, errorRate: 0.0, rps: 10.0 };

  const result = evaluateScenario("trade-create", null, baseline, thresholds);
  assert.equal(result.status, "SKIPPED");
  assert.equal(result.reasons.length, 0);
});

test("generateReport produces formatted markdown table with pass & fail indicators", () => {
  const thresholds = { maxP95DegradationPercent: 20, maxErrorRate: 0.01 };
  const results = [
    {
      scenario: "marketplace",
      status: "PASS",
      reasons: [],
      current: { p95Ms: 145, errorRate: 0.0, rps: 96.2 },
      baseline: { p95Ms: 150, errorRate: 0.0, rps: 95.0 },
      p95DegradationPercent: -3.33,
    },
    {
      scenario: "otp-burst",
      status: "FAIL",
      reasons: ["error rate 2.00% exceeds threshold 1.00%"],
      current: { p95Ms: 120, errorRate: 0.02, rps: 85.0 },
      baseline: { p95Ms: 120, errorRate: 0.0, rps: 85.0 },
      p95DegradationPercent: 0,
    },
    {
      scenario: "trade-create",
      status: "SKIPPED",
      reasons: [],
      current: null,
      baseline: { p95Ms: 220, errorRate: 0.0, rps: 10.0 },
      p95DegradationPercent: null,
    },
  ];

  const report = generateReport({ results, thresholds });
  assert.match(report, /## k6 Load Test Baseline Comparison/);
  assert.match(report, /marketplace/);
  assert.match(report, /:white_check_mark: PASS/);
  assert.match(report, /:x: FAIL/);
  assert.match(report, /:fast_forward: Skipped/);
  assert.match(report, /### :x: Regressions Detected/);
  assert.match(report, /error rate 2.00% exceeds threshold 1.00%/);
});

test("runComparison reads k6 export files and performs full evaluation", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "load-test-test-"));
  try {
    const mockMarketplaceSummary = {
      metrics: {
        http_req_duration: {
          values: { "p(95)": 142.5 },
        },
        http_req_failed: {
          values: { rate: 0.002 },
        },
        http_reqs: {
          values: { rate: 98.4 },
        },
      },
    };

    fs.writeFileSync(
      path.join(tmpDir, "marketplace-summary.json"),
      JSON.stringify(mockMarketplaceSummary)
    );

    const comparison = runComparison({
      outDir: tmpDir,
      scripts: ["marketplace", "otp-burst"],
    });

    assert.equal(comparison.results.length, 2);
    const marketplaceResult = comparison.results.find((r) => r.scenario === "marketplace");
    assert.equal(marketplaceResult.status, "PASS");
    assert.equal(marketplaceResult.current.p95Ms, 142.5);
    assert.equal(marketplaceResult.current.errorRate, 0.002);
    assert.equal(marketplaceResult.current.rps, 98.4);

    const otpResult = comparison.results.find((r) => r.scenario === "otp-burst");
    assert.equal(otpResult.status, "SKIPPED");
    assert.equal(comparison.hasFailures, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
