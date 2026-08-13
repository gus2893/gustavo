# Verify: public-market-commentary

**Status:** partial
**Verified at:** 2026-08-13 / `5a58cb4`

## Automated checks

| Check | Command | Exit code | Result |
|---|---|---:|---|
| Full test suite | `pnpm test` | 1 | One late-running recall file failed: six clock/load-sensitive cases plus its 30-second teardown hook. No other suite failed. |
| Exact recall failures | `pnpm vitest run tests/recall/planner.test.ts -t 'rechecks a proposal created\|persists typed zero-memory\|separates every behavior-changing\|refuses a protected consolidation\|binds the Node state version\|fails context-only recall' --testTimeout=30000` | 0 | 6/6 passed fresh in 19.31 seconds. |
| Production-readiness browser proof | `pnpm exec playwright test tests/e2e/gustavo-production-readiness.spec.ts` | 0 | 4/4 passed against real PostgreSQL, Next, backup/restore, and pinned Valkey. |
| Recovery/runtime/policy/security slice | `pnpm vitest run tests/infra/backup-restore.test.ts tests/infra/local-runtime.test.ts tests/repository/product-policy.test.ts tests/security/static-boundaries.test.ts` | 0 | 27 passed, 1 daemon-only test skipped. |
| Type check | `pnpm exec tsc --noEmit` | 0 | Clean. |
| Production build | `pnpm build` | 0 | Next production build succeeded; `/`, `/join`, `/chat`, `/challenge`, and API routes built. |
| Static safety validator | `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/validate.ps1` | 0 | 117 active source/config files and 32 public build artifacts validated. |
| Diff hygiene | `git diff --check` | 0 | Clean. |
| Lint | Not available | — | The repository has no lint command. |

## Acceptance criteria coverage

- **AC1–AC14 (identity, public boundary, advice/execution exclusions, payload validation):** covered by `tests/repository/product-policy.test.ts`, `tests/ui/public-home.test.tsx`, `tests/security/feed-boundaries.test.ts`, `tests/security/static-boundaries.test.ts`, and the T32/T36 browser proofs. The exact public simulation label and canonical Gustavo identity are present.
- **AC15–AC24 (append-only history, derived memory, privacy scopes, async jobs):** covered by `tests/events/event-store.test.ts`, `tests/conversations/native-history.test.ts`, `tests/thoughts/atomic-thought.test.ts`, `tests/memory/consolidation.test.ts`, `tests/cache/postgres.test.ts`, and `tests/privacy/forget-propagation.test.ts`.
- **AC25 (million-source-event latency): partial.** The event-log million run passed earlier, and the fully authoritative 10,003-memory calibration passed with warm recall p95 207.23 ms and cached handoff p95 0.9557 ms. The required fully projected 1,000,000-memory run did not reach measurement within the ten-minute gate and remains explicitly unverified.
- **AC26–AC27 (bounded recall and account memory controls):** covered by `tests/recall/planner.test.ts`, `tests/privacy/forget-propagation.test.ts`, and `tests/ui/account-surfaces.test.tsx`; the six late full-suite cases passed fresh.
- **AC28–AC42 (single shared Challenge, stage progression, ledger, risk, evaluator, baseline arbitration):** covered by the profile, cost, risk, ledger, order-lifecycle, trading-days, decision-window, and evaluator suites under `tests/challenge/` and `tests/orchestration/`.
- **AC43–AC50 (Main/Node authority, routing, scheduled authorship, disclosure):** covered by `tests/node-brains/router.test.ts`, `tests/broadcasts/main-authorship.test.ts`, `tests/broadcasts/scheduler.test.ts`, and `tests/ui/account-surfaces.test.tsx`.
- **AC51–AC59 (PostgreSQL authority, ThoughtRecords, rebuildable cache, observability):** covered by event/thought/cache suites and `tests/performance/recall-latency.test.ts`. Operator health is authenticated, no-store, bounded, and backed by durable commit/cache/queue/model observations.
- **AC60–AC68 (source-grounded bootstrap import and prohibited execution quarantine):** covered by `tests/import/bootstrap.test.ts` and the static safety validator, including idempotency, byte-range provenance, classifications, lifecycle review, archive verification, and fail-closed removal.
- **AC69–AC77 (native/external chat ingestion and layered cross-chat memory):** covered by `tests/chats/incremental.test.ts`, memory consolidation/conflict suites, recall provenance tests, import cursors, and privacy propagation.
- **AC78 (recall at verified scale): partial** for the same fully projected million-memory limitation as AC25. Bounded/indexed plans and the 10,003-memory calibration pass.
- **AC79–AC80 (temporal conflicts and non-sentience claims):** covered by `tests/memory/conflicts.test.ts`, recall tests, public-home tests, and static policy validation.
- **AC81 (invitation-only identity):** covered by invitation redemption, boundary, route, and runtime-compatibility tests under `tests/auth/`.
- **AC82 (licensed/delayed market scope):** covered by `tests/market-data/observation-policy.test.ts` and the T32 browser proof, which renders AAPL with its exact delay and observation time.
- **AC83–AC86 (Challenge limits, qualifying days, and cost model):** covered by `tests/challenge/risk-gates.test.ts`, `tests/challenge/trading-days.test.ts`, `tests/challenge/order-lifecycle.test.ts`, and `tests/challenge/cost-model.test.ts`.
- **AC87 (provider-neutral audited model layer):** covered by `tests/models/gateway-audit.test.ts` and the static fake-provider production gate.
- **AC88 (working local MVP):** passed separately at T32 through the real invitation-to-public-redaction Chromium path, Compose/config checks, authenticated SSE, public/private UI, and safety validator.
- **AC89 (post-MVP improvements): partial.** Encrypted restore, scheduled broadcasts, operator health, real Valkey recovery, and production-readiness E2E pass. The fully projected million-memory benchmark remains open.
- **AC90 (separate MVP and improvement gates):** represented in `02-design.md`, `03-plan.md`, `04-execution-log.md`, and this verification report.

## Manual smoke test

### Setup

1. Install Node 24, pnpm 11, Docker Desktop, PostgreSQL 17 tools, and Chromium (`pnpm exec playwright install chromium`).
2. Copy `infra/env.example` to `infra/.env` and set fresh values for the database password/URL, event root key, cursor key, cache key, pseudonym keys, and `GUSTAVO_OPERATOR_HEALTH_TOKEN`.
3. From the repository root, run `pnpm install --frozen-lockfile`, then `pnpm mvp:start`.
4. Wait until `docker compose --env-file infra/.env -f infra/compose.yaml ps` shows web, worker, PostgreSQL, and Valkey healthy.
5. Set `GUSTAVO_OPERATOR_ID`, run `$expiry=(Get-Date).ToUniversalTime().AddHours(1).ToString('o'); pnpm invitation:issue $expiry`, and copy the one-time token.

### Golden path

1. Open `http://localhost:3000/join?token=<token>`.
2. Enter a display name and a passphrase of at least 12 characters, then click **Create account**.
3. Confirm `/chat` shows **Your Node Brain**, Main/Node attribution surfaces, the proposal disclosure, and **Inspect memories**.
4. Send a unique sentence, reload the page, and confirm the sentence remains in private history without appearing in the URL.
5. Open `/challenge`; confirm **SIMULATION ONLY — NOT A REAL TRADE** is visible.
6. Call `GET /api/operator/health` with the configured bearer token and confirm `200`, `Cache-Control: private, no-store`, bounded aggregates, and no account IDs, symbols, source text, ciphertext, or secrets.
7. Run `pnpm exec playwright test tests/e2e/gustavo-production-readiness.spec.ts`; confirm all four tests pass, including encrypted restore, Valkey loss/rebuild, scheduled Main cycle, health authorization, and public redaction.

### Edge case: authorization loss

1. In the browser, clear the Gustavo session cookie.
2. Open `/chat` and `/challenge` directly.
3. Expected: protected pages do not expose account content and require authentication.
4. Request `/api/operator/health` without its bearer token.
5. Expected: `401`; no health metrics or identifiers are returned.

### Regression check: public redaction

1. While signed in, send another unique private phrase and verify it appears after a private-page reload.
2. Clear site cookies and open `http://localhost:3000/`.
3. Inspect the page and `/api/public/feed` response in browser developer tools.
4. Expected: the unique phrase, protected field names, ciphertext, and execution language are absent; the public shell shows safe metadata/placeholders and the exact simulation warning.

## Notes

- Final status is **partial**, not passed, because AC25/AC78/AC89 still require a successful fully projected million-memory benchmark.
- The exact full suite remains load-sensitive: after roughly 22 minutes, six recall fixtures exceed their frozen module-time horizon or 75 ms concurrency assumption. All six passed together in a fresh 19.31-second process. This is recorded in `debug-t36-full-suite.md`.
- One disposable PostgreSQL cluster left by the timed-out recall teardown was stopped and moved recoverably to `D:\gustavo-test-fixture-cleanup-20260812-final`; no test-owned Node, PostgreSQL, Valkey container, or temp cluster remains active.
- Because verification is partial, the next step is user acceptance of the limitation or a new debug/design pass. `mcax-finish` is not entered automatically.
