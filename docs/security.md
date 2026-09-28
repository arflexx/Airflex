# Security Policy

AirFlex handles real user funds through Stellar-backed escrow contracts and
Paystack payment integrations. We take security seriously and are committed to
working with the security community to resolve vulnerabilities responsibly.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use one of the following private channels:

| Channel | Address |
|---------|---------|
| Email | security@airflex.io |
| GitHub Private Advisory | [Report via GitHub →](https://github.com/arflexx/Airflex/security/advisories/new) |

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

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | Within **48 hours** of receiving your report |
| Triage & severity assessment | Within **7 days** |
| Fix timeline communicated | Within **14 days** |
| Fix deployed & CVE/advisory published | Dependent on severity; critical issues are prioritised |

We will keep you updated throughout the process. If you have not received an
acknowledgement within 48 hours, please follow up at security@airflex.io.

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
- Do not disclose the issue publicly before a fix is available

---

## Severity Classification

We use the [CVSS v3.1](https://www.first.org/cvss/calculator/3-1) scoring
system combined with the following business-impact guidelines:

| Severity | Description | Example |
|----------|-------------|---------|
| Critical | Direct loss of user funds or mass account takeover | Escrow contract fund drain |
| High | Authenticated user can access or modify another user's data | IDOR on trade endpoint |
| Medium | Security control bypass without immediate fund loss | OTP rate-limit bypass |
| Low | Minor information disclosure or defence-in-depth gap | Stack trace in error response |

---

## Acknowledgements

We credit researchers who responsibly disclose valid security issues. With your
permission, your name (or handle) will appear in the published security advisory.

Thank you for helping keep AirFlex and its users safe.
