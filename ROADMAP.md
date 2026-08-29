# 🗺️ AirFlex Roadmap

This roadmap is the public, issue-driven plan for AirFlex. It maps the work in
the [GitHub issue tracker](https://github.com/arflexx/Airflex/issues) to
distinct milestones so contributors can see what the project is building next,
and users can understand what is coming.

- **Status legend:** ✅ shipped · 🚧 in progress · 📋 planned
- **Target dates** are quarter-based and indicative, not commitments.

---

## Milestones

### v0.1.0 — Foundation
> Monorepo, CI/CD, Docker, core server scaffold.
> **Target: Q3 2026**

| Status | Issue | Work |
|--------|-------|------|
| ✅ | [#92](https://github.com/arflexx/Airflex/issues/92) | pnpm monorepo with workspaces and shared tooling |
| ✅ | [#91](https://github.com/arflexx/Airflex/issues/91) | Docker and Docker Compose setup for local development |
| ✅ | [#123](https://github.com/arflexx/Airflex/issues/123) | Next.js 14 App Router scaffold |
| ✅ | [#141](https://github.com/arflexx/Airflex/issues/141) | PostgreSQL connection pool (`pg`) |
| ✅ | [#78](https://github.com/arflexx/Airflex/issues/78) | Server CI pipeline (lint, test, build) |
| ✅ | [#69](https://github.com/arflexx/Airflex/issues/69) | Frontend CI pipeline |
| ✅ | [#93](https://github.com/arflexx/Airflex/issues/93) | ESLint and Prettier across workspaces |
| ✅ | [#100](https://github.com/arflexx/Airflex/issues/100) | Performance monitoring with OpenTelemetry |
| ✅ | [#95](https://github.com/arflexx/Airflex/issues/95) | Dependabot for automated dependency updates |
| ✅ | [#96](https://github.com/arflexx/Airflex/issues/96) | Secret scanning and SAST with CodeQL |
| ✅ | [#94](https://github.com/arflexx/Airflex/issues/94) | `SECURITY.md` with responsible disclosure policy |
| ✅ | [#80](https://github.com/arflexx/Airflex/issues/80) | API versioning strategy (`/api/v1/`) |
| ✅ | [#81](https://github.com/arflexx/Airflex/issues/81) | OpenAPI 3.1 specification + Swagger UI |
| ✅ | [#84](https://github.com/arflexx/Airflex/issues/84) | Health and readiness probes |
| ✅ | [#99](https://github.com/arflexx/Airflex/issues/99) | Railway / Render deployment guide |
| ✅ | [#101](https://github.com/arflexx/Airflex/issues/101) | Documentation site (Nextra) |
| ✅ | [#139](https://github.com/arflexx/Airflex/issues/139)–[#148](https://github.com/arflexx/Airflex/issues/148) | Server scaffold hardening (env validation, logger, middleware, request IDs, async errors) |
| 🚧 | [#157](https://github.com/arflexx/Airflex/issues/157) | Migration CLI script (`server/src/db/migrate.ts`) |
| 🚧 | [#98](https://github.com/arflexx/Airflex/issues/98) | Husky and lint-staged pre-commit hooks |
| 🚧 | [#121](https://github.com/arflexx/Airflex/issues/121) | Monorepo-wide type coverage reporting |
| 🚧 | [#97](https://github.com/arflexx/Airflex/issues/97) | `CHANGELOG.md` (Keep a Changelog) |
| 🚧 | [#111](https://github.com/arflexx/Airflex/issues/111) | This roadmap document |

### v0.2.0 — Auth & Wallets
> OTP, Stellar wallet, virtual accounts, Paystack deposits, recovery.
> **Target: Q4 2026**

| Status | Issue | Work |
|--------|-------|------|
| ✅ | [#7](https://github.com/arflexx/Airflex/issues/7) | OTP authentication API (Termii) |
| ✅ | [#9](https://github.com/arflexx/Airflex/issues/9) | Paystack webhook deposit processing |
| ✅ | [#125](https://github.com/arflexx/Airflex/issues/125) | Auth context and `useAuth` hook |
| ✅ | [#126](https://github.com/arflexx/Airflex/issues/126) | Next.js middleware for route protection |
| ✅ | [#114](https://github.com/arflexx/Airflex/issues/114) | Seller onboarding KYC flow UI |
| 🚧 | [#108](https://github.com/arflexx/Airflex/issues/108) | 2FA recovery flow (one-time backup codes) |
| 🚧 | [#109](https://github.com/arflexx/Airflex/issues/109) | Display recovery codes post-signup + management UI |
| 🚧 | [#74](https://github.com/arflexx/Airflex/issues/74) | User profile API (phone, settings, KYC status) |
| 🚧 | [#115](https://github.com/arflexx/Airflex/issues/115) | KYC submission storage and admin review API |

### v0.3.0 — Marketplace MVP
> Trade listings, buy flow, escrow integration, marketplace UI.
> **Target: Q1 2027**

| Status | Issue | Work |
|--------|-------|------|
| ✅ | [#63](https://github.com/arflexx/Airflex/issues/63) | Onboarding wizard for first-time users |
| ✅ | [#67](https://github.com/arflexx/Airflex/issues/67) | Reusable UI component library (Storybook) |
| ✅ | [#62](https://github.com/arflexx/Airflex/issues/62) | Marketplace search and filter controls |
| ✅ | [#64](https://github.com/arflexx/Airflex/issues/64) | Referral programme UI and code sharing |
| ✅ | [#75](https://github.com/arflexx/Airflex/issues/75) | Referral programme API |
| ✅ | [#66](https://github.com/arflexx/Airflex/issues/66) | Stellar explorer deep-link component |
| 🚧 | [#127](https://github.com/arflexx/Airflex/issues/127) | `TradeCard` component for listing grid |
| 🚧 | [#128](https://github.com/arflexx/Airflex/issues/128) | Skeleton loading state for marketplace grid |
| 🚧 | [#129](https://github.com/arflexx/Airflex/issues/129) | `AssetTypeBadge` with carrier branding |
| 🚧 | [#130](https://github.com/arflexx/Airflex/issues/130) | `next.config.js` env variable validation |
| 🚧 | [#131](https://github.com/arflexx/Airflex/issues/131) | Typed base fetch client (`lib/api.ts`) |
| 🚧 | [#132](https://github.com/arflexx/Airflex/issues/132) | `useTradeList` / `useTrade` data-fetching hooks |
| 🚧 | [#133](https://github.com/arflexx/Airflex/issues/133) | Toast notification system |
| 🚧 | [#134](https://github.com/arflexx/Airflex/issues/134) | `CurrencyInput` with Naira formatting |
| 🚧 | [#103](https://github.com/arflexx/Airflex/issues/103)–[#106](https://github.com/arflexx/Airflex/issues/106) | `@airflex/*` SDK packages (shared types, wallet, API client, Soroban client) |

### v0.4.0 — Full Trade Lifecycle
> Dispute resolution, delivery confirmation, notifications, analytics, platform ops.
> **Target: Q2 2027**

| Status | Issue | Work |
|--------|-------|------|
| ✅ | [#70](https://github.com/arflexx/Airflex/issues/70) | Admin trade resolution API |
| ✅ | [#71](https://github.com/arflexx/Airflex/issues/71) | Notification service (SMS/email) |
| ✅ | [#82](https://github.com/arflexx/Airflex/issues/82) | Platform fee deduction on trade completion |
| ✅ | [#83](https://github.com/arflexx/Airflex/issues/83) | GDPR/NDPR-compliant data deletion |
| ✅ | [#77](https://github.com/arflexx/Airflex/issues/77) | Background job queue |
| 🚧 | [#110](https://github.com/arflexx/Airflex/issues/110) | Platform analytics dashboard (trade volume metrics) |
| 🚧 | [#72](https://github.com/arflexx/Airflex/issues/72) | Server-Sent Events for real-time updates |
| 🚧 | [#73](https://github.com/arflexx/Airflex/issues/73) | Horizon event listener for on-chain events |
| 🚧 | [#76](https://github.com/arflexx/Airflex/issues/76) | Redis caching layer for hot endpoints |
| 🚧 | [#118](https://github.com/arflexx/Airflex/issues/118) | Webhook retry logic and dead-letter queue |
| 🚧 | [#112](https://github.com/arflexx/Airflex/issues/112) | AML/fraud detection: transaction velocity checks |
| 🚧 | [#119](https://github.com/arflexx/Airflex/issues/119) | Seller rating system after trade completion |
| 🚧 | [#79](https://github.com/arflexx/Airflex/issues/79) | Integration test suite for all API routes |
| 🚧 | [#117](https://github.com/arflexx/Airflex/issues/117) | Load testing suite with k6 |

### v0.5.0 — Polish & Launch
> Admin dashboard, PWA, i18n, docs, security hardening.
> **Target: Q3 2027**

| Status | Issue | Work |
|--------|-------|------|
| ✅ | [#23](https://github.com/arflexx/Airflex/issues/23) | Admin dashboard (trade and user management) |
| ✅ | [#89](https://github.com/arflexx/Airflex/issues/89) | Contracts published to testnet with documented addresses |
| 🚧 | [#107](https://github.com/arflexx/Airflex/issues/107) | Mobile-responsive PWA manifest and service worker |
| 🚧 | [#65](https://github.com/arflexx/Airflex/issues/65) | Accessibility audit — WCAG 2.1 AA compliance |
| 🚧 | [#68](https://github.com/arflexx/Airflex/issues/68) | i18n for Yoruba, Igbo, and Hausa |
| 🚧 | [#120](https://github.com/arflexx/Airflex/issues/120) | Content Security Policy and security headers audit |
| 🚧 | [#135](https://github.com/arflexx/Airflex/issues/135) | Session expiry detection and auto-logout |
| 🚧 | [#113](https://github.com/arflexx/Airflex/issues/113) | Escrow contract audit preparation document |
| 🚧 | [#102](https://github.com/arflexx/Airflex/issues/102) | Database backup and point-in-time recovery |
| 🚧 | [#124](https://github.com/arflexx/Airflex/issues/124) | Root app layout with providers and global styles |

---

## Won't Fix (for now)

Deliberately deferred features, with rationale. Revisit these when the
underlying assumption changes.

- **Native mobile apps** — AirFlex targets mobile-first users in Nigeria where
  app-store distribution can be a barrier. The PWA ([#107](https://github.com/arflexx/Airflex/issues/107))
  delivers an installable, offline-capable experience without store approval or
  platform-specific code. Native apps add significant maintenance cost for
  little user benefit at this stage.
- **GraphQL subscription layer ([#116](https://github.com/arflexx/Airflex/issues/116))** —
  the SSE endpoint ([#72](https://github.com/arflexx/Airflex/issues/72)) already
  covers real-time trade updates with far less infrastructure. Revisit only if
  clients demonstrate a concrete need for queryable subscriptions.
- **End-to-end encryption for trade chat ([#122](https://github.com/arflexx/Airflex/issues/122))** —
  there is no chat feature yet. E2E encryption is only meaningful once
  messaging exists, and premature key-management complexity would slow the
  marketplace MVP.

---

## Community Requests

Feature ideas are collected and upvoted on the
[GitHub Discussions](https://github.com/arflexx/Airflex/discussions) page.
(Note: discussions must be enabled by the maintainers before the page is
live — until then, please open a feature-request issue instead.) The most
upvoted requests are candidates for the next milestone.

---

## Maintenance

- This roadmap is updated as part of **each release**: closed issues are moved
  to ✅, completed milestones are marked shipped, and new issues are assigned
  to the appropriate milestone.
- Milestone target dates are quarter-based. A milestone slips when its issues
  slip; update the dates here when a milestone is re-planned.
- PRs that close issues referenced in this document should keep the issue's
  status in the roadmap table in sync.
