## Summary

<!-- One or two sentences describing what this PR does and why. -->

Closes #<!-- issue number -->

---

## Type of Change

<!-- Check all that apply -->

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `refactor` — code change with no behaviour change
- [ ] `docs` — documentation only
- [ ] `chore` — build, deps, config
- [ ] `contract` — Soroban smart contract change

---

## What Changed.

<!-- List the files/modules changed and what was done to each one. -->

| File | Change |
|------|--------|
| | |

---

## How to Test

<!-- Steps a reviewer can follow to verify this works. -->

```bash
# example
cd server
npm run dev
curl http://localhost:3001/health
```

---

## Checklist

### General
- [ ] Code compiles / builds without errors
- [ ] No new TypeScript errors (`tsc --noEmit`)
- [ ] Follows existing code style and patterns
- [ ] No secrets, keys, or credentials committed
- [ ] `.env.example` updated if new env vars were added

### API changes
- [ ] Request/response shapes documented in `docs/api-reference.md`
- [ ] Zod validation added for all request inputs
- [ ] Correct HTTP status codes returned
- [ ] Auth middleware applied where required

### Smart contract changes
- [ ] `require_auth()` called on all state-changing functions
- [ ] `extend_ttl()` called on all new persistent storage entries
- [ ] Contract rebuilt with `stellar contract build`
- [ ] Tested on testnet before merge
- [ ] `docs/smart-contract.md` updated
- [ ] New contract address added to `server/.env.example` if redeployed

### Database changes
- [ ] Migration script included
- [ ] Indexes added for queried columns

### Docs changes
- [ ] Relevant doc in `docs/` updated or created
- [ ] README updated if structure or setup changed

---

## Screenshots / Logs

<!-- Paste relevant output, curl responses, or screenshots if applicable. -->

---

## Notes for Reviewer

<!-- Anything the reviewer should pay special attention to, known limitations, or follow-up items. -->
