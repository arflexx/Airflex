# Runbook: Updating Load Test Performance Baselines

**Service:** AirFlex API & Backend Load Testing  
**Workflow:** `.github/workflows/load-test.yml`  
**Baseline file:** [`tests/load/baseline.json`](file:///tests/load/baseline.json)  
**Comparison tool:** [`tests/load/compare-baseline.mjs`](file:///tests/load/compare-baseline.mjs)  
**Enforcement thresholds:** p95 latency degradation > 20% or error rate > 1.0%  

---

## Table of Contents

1. [Overview & Architecture](#1-overview--architecture)
2. [Baseline Benchmark Schema](#2-baseline-benchmark-schema)
3. [Regression Thresholds & CI Enforcement](#3-regression-thresholds--ci-enforcement)
4. [When to Update the Baseline](#4-when-to-update-the-baseline)
5. [Step-by-Step Procedure to Update Baseline](#5-step-by-step-procedure-to-update-baseline)
6. [Local Testing & Verification](#6-local-testing--verification)
7. [Pull Request Checklist](#7-pull-request-checklist)
8. [Troubleshooting & FAQ](#8-troubleshooting--faq)

---

## 1. Overview & Architecture

AirFlex runs k6 load test suites on-demand against staging environments via GitHub Actions (`.github/workflows/load-test.yml`).

```
GitHub Actions (workflow_dispatch)
        │
        ▼
   k6 execution (`tests/load/run-all.sh`)
        │
        ▼
   Summary export JSON (`load-results/<scenario>-summary.json`)
        │
        ▼
   Baseline comparison (`tests/load/compare-baseline.mjs`)
        │
        ├─► p95 degradation > 20% OR error rate > 1.0%? ──► [FAIL CI]
        │
        ▼
   Post GitHub step summary & PR discussion comment
```

A committed baseline file at `tests/load/baseline.json` provides reference metrics (p95 response time, error rate, RPS) for each load test scenario. Every CI load test run compares its exported summary metrics against this baseline to catch performance regressions early.

---

## 2. Baseline Benchmark Schema

The baseline file is located at `tests/load/baseline.json`:

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-09-24",
  "thresholds": {
    "maxP95DegradationPercent": 20,
    "maxErrorRate": 0.01
  },
  "scenarios": {
    "marketplace": {
      "p95Ms": 150,
      "errorRate": 0.0,
      "rps": 95.0
    },
    "otp-burst": {
      "p95Ms": 120,
      "errorRate": 0.0,
      "rps": 85.0
    },
    "trade-create": {
      "p95Ms": 220,
      "errorRate": 0.0,
      "rps": 10.0
    }
  }
}
```

### Metrics Tracked per Scenario

| Field | Description |
|---|---|
| `p95Ms` | 95th percentile response duration in milliseconds (`http_req_duration.p(95)`) |
| `errorRate` | Fraction of failed HTTP requests (`http_req_failed.rate`), e.g., `0.01` = 1.0% |
| `rps` | Average throughput in requests per second (`http_reqs.rate`) |

---

## 3. Regression Thresholds & CI Enforcement

The load test comparison script (`tests/load/compare-baseline.mjs`) evaluates every executed scenario against the baseline:

1. **p95 Latency Degradation:**
   $$\text{Degradation \%} = \frac{\text{Current p95} - \text{Baseline p95}}{\text{Baseline p95}} \times 100$$
   If $\text{Degradation \%} > 20\%$, the test **FAILS**.

2. **Error Rate Threshold:**
   If $\text{Current Error Rate} > 1.0\%$ ($0.01$), the test **FAILS**.

When a regression is detected:
- An annotation `::error::[<scenario>] <reason>` is emitted for GitHub Actions.
- The summary table highlights failed scenarios with `:x: FAIL`.
- The workflow step exits with code `1`, blocking CI.

---

## 4. When to Update the Baseline

Update `tests/load/baseline.json` only when:
- **Legitimate architecture or database optimizations** intentionally improve benchmark numbers (e.g., query indexing, Redis caching).
- **New business logic or cryptographic validations** were added with intentional and accepted latency trade-offs that have been approved by the backend team.
- **Load test scenarios were modified** (e.g., virtual user count changed, new endpoints included in the workflow).
- **Infrastructure or staging environment specs changed**.

> **Warning:** Never update the baseline to hide an unexplained regression. All baseline updates require peer review and staging benchmark evidence.

---

## 5. Step-by-Step Procedure to Update Baseline

### Step 1: Execute load tests against staging

Trigger the load test workflow on staging with representative load:

```bash
# Set required environment variables
export LOAD_TEST_BASE_URL="https://staging-api.airflex.network"
export LOAD_TEST_AUTH_TOKEN="<jwt_staging_auth_token>"
export LOAD_TEST_OUTPUT_DIR="./load-results"

# Run all load tests
bash tests/load/run-all.sh
```

Alternatively, run via GitHub Actions: **Actions → Load tests → Run workflow** (supplying `base_url` and `auth_token`).

### Step 2: Extract new benchmark metrics

Inspect generated summary files in `load-results/`:
- `marketplace-summary.json`
- `otp-burst-summary.json`
- `trade-create-summary.json`

Extract the values:
- `http_req_duration.values["p(95)"]`
- `http_req_failed.values.rate`
- `http_reqs.values.rate`

### Step 3: Update `tests/load/baseline.json`

Update the numbers and set `lastUpdated` to the current date:

```json
{
  "version": "1.0.0",
  "lastUpdated": "YYYY-MM-DD",
  "thresholds": {
    "maxP95DegradationPercent": 20,
    "maxErrorRate": 0.01
  },
  "scenarios": {
    "marketplace": {
      "p95Ms": <NEW_P95>,
      "errorRate": <NEW_ERROR_RATE>,
      "rps": <NEW_RPS>
    },
    ...
  }
}
```

---

## 6. Local Testing & Verification

Run the comparison script locally to ensure the new baseline evaluates correctly against the exported summaries:

```bash
# Run comparison tool
node tests/load/compare-baseline.mjs

# Or via npm/pnpm script
pnpm load:compare

# Run test suite
node --test tests/load/compare-baseline.test.mjs
```

Expected output:
```markdown
## k6 Load Test Baseline Comparison

| Scenario | p95 (ms) | Baseline p95 | p95 Δ | Error Rate | Baseline Error | RPS | Baseline RPS | Status |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **marketplace** | 148 ms | 150 ms | -1.3% | 0.00% | 0.00% | 95.5 | 95.0 | :white_check_mark: PASS |
| **otp-burst** | 119 ms | 120 ms | -0.8% | 0.00% | 0.00% | 85.0 | 85.0 | :white_check_mark: PASS |
| **trade-create** | 215 ms | 220 ms | -2.3% | 0.00% | 0.00% | 10.1 | 10.0 | :white_check_mark: PASS |

Thresholds: Max p95 degradation: +20% | Max error rate: 1.00%

:white_check_mark: All executed scenarios within baseline performance thresholds.
```

---

## 7. Pull Request Checklist

When opening a PR with updated baseline metrics:

- [ ] Provide the workflow run link or staging benchmark execution output in the PR description.
- [ ] Explain the technical reason for the performance metric change.
- [ ] Ensure `node --test tests/load/compare-baseline.test.mjs` passes.
- [ ] Tag the backend tech lead for review.

---

## 8. Troubleshooting & FAQ

### CI failed with `p95 response time degraded by X%`
1. Check staging health and database load during the test window.
2. Profile the endpoint locally using EXPLAIN ANALYZE or tracing tools.
3. Check for recent query regressions, missing indexes, or unoptimized network calls.
4. If the regression is due to external noise or transient staging slowness, re-run the workflow.

### `trade-create.js` shows as `Skipped`
`trade-create.js` requires authenticated user requests. Provide `LOAD_TEST_AUTH_TOKEN` input in the GitHub Actions dispatch modal to execute this scenario.
