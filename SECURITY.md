# Security Policy

AirFlex handles real user funds through Stellar-backed escrow contracts and
Paystack payment integrations. We take security seriously and are committed to
working with the security community to resolve vulnerabilities maintaince responsibly.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use one of the following private channels, in order of preference:

| Preference | Channel | Address |
|------------|---------|---------|
| 1 | GitHub Security Advisory (private) | [Report via GitHub →](https://github.com/arflexx/Airflex/security/advisories/new) |
| 2 | Security email | security@airflex.io |

GitHub Security Advisories are preferred: the report, discussion and eventual
fix stay in one private thread, and the advisory becomes the public record once
disclosure is permitted.

Encrypt sensitive reports with our PGP key (available on request via the email
above) if they contain credentials, exploit code, or private user data.

---

## What to Include

A high-quality report helps us triage and fix issues faster. Please include:

- **Description** — what the vulnerability is and why it is exploitable
- **Affected component** — API endpoint, contract function, auth flow, etc.
- **Steps to reproduce** — curl commands, scripts, or a minimal proof-of-concept
- **Impact assessment** — what an attacker could achieve
- **Suggested fix** (optional but appreciated)

---

## Response SLAs

All times run from the moment your report is received on one of the channels
above. "Business days" are Monday–Friday, excluding Nigerian public holidays.

| Stage | SLA | What happens |
|-------|-----|--------------|
| Acknowledgement | **48 hours** | A maintainer confirms receipt and assigns a tracking ID. |
| Triage | **5 business days** | The report is reproduced and given a severity (Critical / High / Medium / Low, see [Severity Classification](#severity-classification)). |
| Status updates | **Every 7 days** | You receive a progress update until the issue is resolved. |
| Resolution | **By severity, below** | A fix is deployed to production, or a mitigation is in place and documented. |

### Resolution SLA by severity

Measured from the end of triage.

| Severity | Resolution SLA | Notes |
|----------|----------------|-------|
| Critical | **7 days** | Affected functionality may be paused (e.g. escrow contract `pause`) within 24 hours while the fix ships. |
| High | **30 days** | |
| Medium | **60 days** | |
| Low | **90 days** | May be batched into a scheduled release. |

If an SLA will be missed — for example, a contract fix that needs redeployment
and an audit — we tell you before the deadline, explain why, and give a new date.

If you have not received an acknowledgement within 48 hours, please follow up
at security@airflex.io.

---

## Coordinated Disclosure

We follow coordinated disclosure. The timeline is:

1. **Day 0** — report received; acknowledgement within 48 hours.
2. **Within 5 business days** — triage complete and severity agreed with you.
3. **Within the resolution SLA** — fix deployed; we confirm with you that it
   resolves the issue.
4. **Fix + 7 days** — a GitHub Security Advisory (and CVE where applicable) is
   published, crediting you if you wish. The 7-day buffer lets operators and
   integrators update.

**Public disclosure is permitted** once the earliest of the following occurs:

- the GitHub Security Advisory for the issue has been published; or
- **90 days** have passed since the report was received, regardless of fix
  status, unless both parties agree in writing to an extension; or
- the vulnerability is already being actively exploited or has been publicly
  disclosed by a third party — in which case we will publish an advisory as
  soon as a mitigation is available and you may disclose at the same time.

Please do not disclose details (including to other parties) before one of these
conditions is met.

---

## Scope

### In Scope

| Target | Examples |
|--------|---------|
| Production API (`server/`) | Authentication bypass, SQL injection, insecure direct object references, JWT flaws |
| Soroban escrow contract | Re-entrancy, incorrect access control on `release_payment` / `cancel_and_refund`, fund-lock bypass |
| Authentication & OTP flow | Account takeover, OTP brute-force, session fixation |
| Stellar wallet generation & key handling | Private key exposure, key derivation weaknesses |
| Frontend (`frontend/`) | XSS leading to token theft, CSRF on state-changing actions |
| Paystack webhook handling | Signature bypass, replay attacks |

### Out of Scope

The following are **not** eligible for the responsible disclosure programme:

- Vulnerabilities in third-party dependencies not introduced by AirFlex code
  (report those directly to the upstream maintainer)
- Test / staging environments and demo data
- Denial-of-service attacks requiring significant infrastructure resources
- Social engineering or phishing attacks against AirFlex staff
- Missing security headers that do not lead to a practical exploit
- Rate limiting on non-sensitive endpoints
- Theoretical vulnerabilities without a working proof-of-concept

---

We will **not** pursue legal action against researchers who:

- Discover and report vulnerabilities in good faith
- Do not access, modify, or exfiltrate real user data beyond what is necessary
  to demonstrate the vulnerability
- Do not perform destructive testing (deleting data, disrupting service)
- Do not disclose the issue publicly before it is permitted under [Coordinated Disclosure](#coordinated-disclosure)

---

## Severity Classification

We use the [CVSS v3.1](https://www.first.org/cvss/calculator/3-1) scoring
system combined with the following business-impact guidelines:

| Severity | CVSS v3.1 | Description | Example | Resolution SLA |
|----------|-----------|-------------|---------|----------------|
| Critical | 9.0–10.0 | Direct loss of user funds or mass account takeover | Escrow contract fund drain | 7 days |
| High | 7.0–8.9 | Authenticated user can access or modify another user's data | IDOR on trade endpoint | 30 days |
| Medium | 4.0–6.9 | Security control bypass without immediate fund loss | OTP rate-limit bypass | 60 days |
| Low | 0.1–3.9 | Minor information disclosure or defence-in-depth gap | Stack trace in error response | 90 days |

---

## Acknowledgements

We credit researchers who responsibly disclose valid security issues. With your
permission, your name (or handle) will appear in the published security advisory.

Thank you for helping keep AirFlex and its users safe.
