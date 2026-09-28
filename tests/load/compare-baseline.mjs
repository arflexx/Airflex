#!/usr/bin/env node
/**
 * Compare k6 load test results against committed baseline metrics.
 * Fails CI if:
 * - p95 response time degrades by more than 20%
 * - error rate exceeds 1% (0.01)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SCRIPTS = ["marketplace", "otp-burst", "trade-create"];
export const DEFAULT_BASELINE_PATH = path.join(__dirname, "baseline.json");

export function loadBaseline(baselinePath = DEFAULT_BASELINE_PATH) {
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline file not found at ${baselinePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const thresholds = {
    maxP95DegradationPercent: raw.thresholds?.maxP95DegradationPercent ?? 20,
    maxErrorRate: raw.thresholds?.maxErrorRate ?? 0.01,
  };
  const scenarios = raw.scenarios ?? raw;
  return { thresholds, scenarios };
}

export function readMetrics(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const metrics = raw.metrics ?? raw;

  const p95 = metrics.http_req_duration?.values?.["p(95)"] ?? null;
  const failRate = metrics.http_req_failed?.values?.rate ?? null;
  const rps = metrics.http_reqs?.values?.rate ?? null;

  return {
    p95Ms: p95 != null ? Math.round(p95 * 10) / 10 : null,
    errorRate: failRate != null ? failRate : null,
    rps: rps != null ? Math.round(rps * 10) / 10 : null,
  };
}

export function evaluateScenario(name, currentMetrics, baselineMetrics, thresholds) {
  if (!currentMetrics) {
    return {
      scenario: name,
      status: "SKIPPED",
      reasons: [],
      current: null,
      baseline: baselineMetrics || null,
      p95DegradationPercent: null,
    };
  }

  const reasons = [];
  let status = "PASS";

  const { maxP95DegradationPercent, maxErrorRate } = thresholds;

  // Check p95 degradation
  let p95DegradationPercent = null;
  if (currentMetrics.p95Ms != null && baselineMetrics?.p95Ms != null && baselineMetrics.p95Ms > 0) {
    p95DegradationPercent = ((currentMetrics.p95Ms - baselineMetrics.p95Ms) / baselineMetrics.p95Ms) * 100;
    if (p95DegradationPercent > maxP95DegradationPercent) {
      status = "FAIL";
      reasons.push(
        `p95 response time degraded by ${p95DegradationPercent.toFixed(1)}% (${currentMetrics.p95Ms}ms vs baseline ${baselineMetrics.p95Ms}ms, max allowed: +${maxP95DegradationPercent}%)`
      );
    }
  }

  // Check error rate
  if (currentMetrics.errorRate != null) {
    if (currentMetrics.errorRate > maxErrorRate) {
      status = "FAIL";
      reasons.push(
        `error rate ${(currentMetrics.errorRate * 100).toFixed(2)}% exceeds threshold ${(maxErrorRate * 100).toFixed(2)}%`
      );
    }
  }

  return {
    scenario: name,
    status,
    reasons,
    current: currentMetrics,
    baseline: baselineMetrics || null,
    p95DegradationPercent,
  };
}

export function generateReport({
  results,
  thresholds,
}) {
  let md = `## k6 Load Test Baseline Comparison\n\n`;
  md += `| Scenario | p95 (ms) | Baseline p95 | p95 &Delta; | Error Rate | Baseline Error | RPS | Baseline RPS | Status |\n`;
  md += `| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |\n`;

  for (const item of results) {
    const { scenario, current, baseline, status, p95DegradationPercent } = item;

    const currentP95 = current?.p95Ms != null ? `${current.p95Ms} ms` : "—";
    const baseP95 = baseline?.p95Ms != null ? `${baseline.p95Ms} ms` : "—";

    let p95Delta = "—";
    if (p95DegradationPercent != null) {
      const sign = p95DegradationPercent > 0 ? "+" : "";
      p95Delta = `${sign}${p95DegradationPercent.toFixed(1)}%`;
    }

    const currentErr = current?.errorRate != null ? `${(current.errorRate * 100).toFixed(2)}%` : "—";
    const baseErr = baseline?.errorRate != null ? `${(baseline.errorRate * 100).toFixed(2)}%` : "—";

    const currentRps = current?.rps != null ? current.rps.toFixed(1) : "—";
    const baseRps = baseline?.rps != null ? baseline.rps.toFixed(1) : "—";

    let statusBadge = ":white_check_mark: PASS";
    if (status === "FAIL") {
      statusBadge = ":x: FAIL";
    } else if (status === "SKIPPED") {
      statusBadge = ":fast_forward: Skipped";
    }

    md += `| **${scenario}** | ${currentP95} | ${baseP95} | ${p95Delta} | ${currentErr} | ${baseErr} | ${currentRps} | ${baseRps} | ${statusBadge} |\n`;
  }

  const failures = results.filter((r) => r.status === "FAIL");
  md += `\n**Thresholds:** Max p95 degradation: **+${thresholds.maxP95DegradationPercent}%** | Max error rate: **${(thresholds.maxErrorRate * 100).toFixed(2)}%**\n`;

  if (failures.length > 0) {
    md += `\n### :x: Regressions Detected\n\n`;
    for (const failure of failures) {
      md += `- **${failure.scenario}**:\n`;
      for (const reason of failure.reasons) {
        md += `  - ${reason}\n`;
      }
    }
  } else {
    md += `\n:white_check_mark: All executed scenarios within baseline performance thresholds.\n`;
  }

  return md;
}

export function runComparison(options = {}) {
  const outDir = options.outDir || process.env.LOAD_TEST_OUTPUT_DIR || "./load-results";
  const baselinePath = options.baselinePath || process.env.LOAD_TEST_BASELINE_FILE || DEFAULT_BASELINE_PATH;
  const scripts = options.scripts || DEFAULT_SCRIPTS;

  const { thresholds, scenarios: baselineScenarios } = loadBaseline(baselinePath);

  const results = [];
  for (const name of scripts) {
    const filePath = path.join(outDir, `${name}-summary.json`);
    const currentMetrics = readMetrics(filePath);
    const baselineMetrics = baselineScenarios[name] || null;
    results.push(evaluateScenario(name, currentMetrics, baselineMetrics, thresholds));
  }

  const report = generateReport({ results, thresholds });
  const failures = results.filter((r) => r.status === "FAIL");

  return {
    results,
    thresholds,
    report,
    failures,
    hasFailures: failures.length > 0,
  };
}

// CLI Execution
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const reportOnly = process.argv.includes("--report-only") || process.argv.includes("--no-exit");
  const comparison = runComparison();

  console.log(comparison.report);

  if (comparison.hasFailures) {
    for (const failure of comparison.failures) {
      for (const reason of failure.reasons) {
        console.error(`::error::[${failure.scenario}] ${reason}`);
      }
    }

    if (!reportOnly) {
      process.exit(1);
    }
  }
}
