# Story: deploy-vercel

## Vertical slice

Ship a usable single-operator Gustavo production instance at `https://gustavo.lol`: the operator can redeem a fresh invitation, sign in, chat through the local Codex bridge, and inspect operator-only five-minute market observations across the 95-symbol universe. The public site remains safe and available when the local computer is offline, while local-dependent features show an explicit unavailable state. All services remain within free-tier quotas.

## In scope

- Existing Vercel `gustavo` project and `gustavo.lol`/`www.gustavo.lol` domains.
- Fresh production database and cache/dispatch services.
- Production migrations and one-time invitation bootstrap.
- Operator sign-in, chat, memory/privacy controls, Challenge, public feed, SSE, schedules, and health surface.
- Operator-only Codex-backed Node, Main, and Evaluator responses.
- Operator-only Finnhub observations for the existing 95-symbol universe.
- Local Windows startup, secure tunnel, offline degradation, quota enforcement, and operational documentation.

## Out of scope

- Importing any local account, conversation, memory, market, or backup data.
- Public registration or multi-operator Codex access.
- Public redistribution of Finnhub quotes.
- Brokerage connections, order execution, or real trades.
- Paid provider plans, overages, SLAs, or automatic upgrades.
- Claiming the Codex CLI bridge is a supported OpenAI application backend.

## User stories

### Story 1: Reach the production application

**As a** Gustavo operator,
**I want** the existing Vercel project repaired at my custom domain,
**So that** I can use the app through a stable HTTPS production URL.

**Acceptance criteria**

- [ ] Opening `https://gustavo.lol` returns the Gustavo public home over valid HTTPS without a certificate warning.
- [ ] Opening `https://www.gustavo.lol` reaches the same canonical production application.
- [ ] Vercel reports the production deployment as Ready using a supported Node runtime.
- [ ] The public page visibly contains `SIMULATION ONLY — NOT A REAL TRADE`.
- [ ] Public HTML, RSC, and feed responses contain no operator chat, live quote payload, provider key, tunnel secret, or ciphertext.

### Story 2: Bootstrap and authenticate the operator

**As a** Gustavo operator,
**I want** to create the first account through a one-time invitation,
**So that** the fresh production instance remains closed to public registration.

**Acceptance criteria**

- [ ] A production invitation command prints one opaque redemption URL without printing database or encryption secrets.
- [ ] Redeeming the URL once at `/join` creates the operator account and signs it in.
- [ ] Reusing the same invitation is rejected with a generic invalid-invitation message.
- [ ] An unauthenticated request to `/chat` redirects to the sign-in boundary before private data is loaded.
- [ ] The fresh account contains no conversations or memories copied from the local development database.

### Story 3: Chat through the local Codex bridge

**As the** authenticated operator,
**I want** Node, Main, and Evaluator work to use my local Codex CLI,
**So that** Gustavo has AI behavior without API usage charges.

**Acceptance criteria**

- [ ] Sending a message on `/chat` persists the operator message and eventually displays a Node-attributed response after a reload.
- [ ] A production health view identifies Node, Main, and Evaluator as available without exposing prompts, credentials, or private content.
- [ ] Two overlapping requests execute one at a time, and the direct chat completes before queued Main/Evaluator work.
- [ ] Only the authenticated operator account can submit work to the bridge; other or unauthenticated requests are rejected before execution.
- [ ] The bridge process has no access to the Gustavo repository and cannot perform shell, filesystem, browser, plugin, or connector actions from chat input.
- [ ] Provider quota exhaustion returns a bounded unavailable response and does not switch to a paid API.

### Story 4: Inspect all supported market symbols

**As the** authenticated operator,
**I want** each supported symbol checked every five minutes,
**So that** the simulation can use fresh personal market observations.

**Acceptance criteria**

- [ ] During an open US market session, the operator view lists all 95 configured symbols with a source timestamp and freshness label.
- [ ] Within one five-minute observation window, every supported symbol receives a successful Finnhub observation or an explicit per-symbol unavailable result.
- [ ] Provider rate-limit responses pause or retry within the next bounded window without exceeding Finnhub's free rate ceiling.
- [ ] Live quote values are visible only after operator authentication and are absent from the public feed and public page payloads.
- [ ] When the free provider quota is unavailable, the UI shows stale/unavailable status instead of relabeling old data as live.

### Story 5: Degrade and recover safely

**As a** Gustavo operator,
**I want** hosted features to remain safe when my computer is offline,
**So that** an outage does not expose data or corrupt work.

**Acceptance criteria**

- [ ] With the local computer disconnected, `https://gustavo.lol` and authenticated stored history remain reachable.
- [ ] Chat submissions and market refreshes show an explicit local-bridge unavailable state without losing already committed messages or observations.
- [ ] Reconnecting and signing into Windows automatically restores the bridge, market poller, and tunnel without changing the production URL.
- [ ] Replayed or expired signed bridge requests are rejected and do not start Codex work.
- [ ] Operator health distinguishes hosted-service health from local-bridge health without returning secret values.

### Story 6: Stay at a hard zero-dollar ceiling

**As the** Gustavo operator,
**I want** all provider usage bounded by free-tier quotas,
**So that** deployment cannot create an unexpected bill.

**Acceptance criteria**

- [ ] Vercel, Neon, Upstash, Tailscale, and Finnhub are configured on free/personal tiers with no application-controlled upgrade path.
- [ ] Crossing an application quota stops or delays the affected feature and records a bounded operator-visible reason.
- [ ] No secret or configuration enables automatic paid fallback, overage, or provider substitution.
- [ ] The production runbook names each free quota and gives a manual command or dashboard path for checking current usage.

## Future stories (not in this mission)

- Replace the unsupported Codex bridge with a supported production model API.
- Acquire market-data redistribution rights for public live quotes.
- Add paid-plan resilience, multi-user access, and formal uptime objectives.

## Risks

- The Codex CLI is not a supported public application backend and may change, throttle, or stop working.
- A free tunnel and a home Windows computer have no production SLA.
- Finnhub personal-use licensing forbids public redistribution and may change.
- Free quotas may be too small for all existing background workloads.
- Existing Vercel project settings and failed deployment history may require repair before a clean release.
- Long-lived SSE and worker semantics may need observable behavior changes on serverless infrastructure.

## Assumptions

- The deployment remains personal and non-commercial.
- The operator retains control of `gustavo.lol`, the Vercel project, this Windows computer, and required provider accounts.
- The computer is normally online during intended AI and market-data use.
- All 95 mapped symbols are accepted by Finnhub or can display explicit unsupported status.

## Status

Story approved by the user on 2026-08-13. Next: `mcax-design`.
