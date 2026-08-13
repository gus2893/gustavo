# Vercel Deployment Intake

## Request

Deploy Gustavo to Vercel.

## Classification

- Type: deployment / architecture change
- Primary user: Gustavo operator
- Current target: hybrid Vercel production web/data services plus a local-computer AI bridge

## Current constraints

- The Next.js web application can run on Vercel.
- The production runtime also depends on a persistent background worker, PostgreSQL, and Valkey.
- The persistent worker cannot be deployed unchanged as a Vercel Function.
- Production data services must be externally reachable and configured through managed secrets.
- Existing unrelated `AGENTS.md` changes must be preserved.
- Production begins with an empty database; local/private data will not be copied.
- Launch domain: `https://gustavo.lol`.
- The repository currently has no production AI-model or market-data adapter.
- The free deployment can operate account, storage, privacy, cache, scheduling, SSE infrastructure, and simulation surfaces without provider generation.
- This Codex/ChatGPT conversation is not a production API endpoint and cannot receive arbitrary requests from the deployed application.
- A free local-model bridge is possible through an authenticated tunnel, but the computer must remain online and it changes the target to a hybrid deployment.
- Local hardware includes an NVIDIA GeForce RTX 3080.
- Ollama and Cloudflare Tunnel are not currently installed.
- Selected AI path: unsupported local Codex CLI bridge rather than Ollama or the OpenAI API.
- The bridge must run in an isolated workspace with repository/filesystem/tool access disabled, signed requests, strict quotas, and fail-closed offline behavior.
- Codex/ChatGPT subscription limits and availability are not a production SLA.
- Codex bridge access is restricted to the single operator account.
- Live market data is included in deployment scope.
- Candidate free source changed from Twelve Data to Finnhub Free, limited to personal use and 60 API calls/minute.
- Live quotes are restricted to the authenticated operator and excluded from public output.
- Initial live-data universe: all supported symbols possible within the free quota; the current mapped universe contains 95 symbols.
- The 95-symbol universe can be refreshed within each five-minute window by the local bridge while remaining below Finnhub's free request-rate ceiling.
- Finnhub Free is approved as the operator-only market-data source.
- `gustavo.lol` currently uses Google Domains/Squarespace nameservers.
- Tailscale Funnel is the proposed free HTTPS tunnel, avoiding a DNS-provider migration.
- The Codex desktop app's packaged executable cannot be launched by an ordinary background process; a separate standalone Codex CLI is required.
- Installation of standalone Codex CLI and Tailscale is authorized.
- Vercel team `gustavo-evangelistas-projects` is connected.
- Existing Vercel project `gustavo` already owns `gustavo.lol` and `www.gustavo.lol`; its latest deployment is failed and its configured Node version is 18.x.
- Reuse and repair the existing Vercel `gustavo` project.
- When the local computer is offline, the hosted app remains available while Codex replies and market refreshes fail closed with a clear unavailable state.
- The local bridge, Finnhub poller, and Tailscale tunnel may start automatically at Windows sign-in.
- The Codex bridge powers all Gustavo model roles: Node, Main, and Evaluator.
- Codex work is serialized to one active request, with direct chat ahead of Main/Evaluator jobs.
- Fresh production account creation remains invitation-only.
- Every service must fail closed at its free-tier quota; no automatic paid upgrade or overage is permitted.

## Free-tier starting point

- Vercel Hobby for the Next.js web application; personal/non-commercial use only.
- Neon Free for PostgreSQL: 0.5 GB storage and 100 CU-hours per project/month.
- Upstash Redis Free: 256 MB, 500,000 commands/month, and 10 GB bandwidth/month.
- Upstash QStash Free for background dispatch: 1,000 messages/day and 10 schedules.
- Background work must be coalesced into bounded batches; Vercel Hobby Cron only runs daily and Functions are limited to 60 seconds.
- Free tiers provide no production SLA and may pause or rate-limit at their caps.

Selected: use the free-tier MVP architecture as the initial deployment target.

## Deployment options

Selected: full Vercel architecture with managed PostgreSQL and Valkey plus migration of the persistent worker to Vercel-compatible background execution.

## Open question

- None.

## Approved target summary

- Reuse the existing Vercel `gustavo` project and launch at `https://gustavo.lol`.
- Start with a fresh Neon Free database and Upstash Redis/QStash free services.
- Keep hosted web, auth, storage, privacy, caching, schedules, and simulation available when the local computer is offline.
- Run an explicitly unsupported, operator-only standalone Codex CLI bridge on the local Windows computer through Tailscale Funnel.
- Power Node, Main, and Evaluator with one serialized Codex request at a time; direct chat has priority.
- Poll all 95 supported US symbols from Finnhub Free within each five-minute window; data stays operator-only.
- Start the local bridge, poller, and tunnel at Windows sign-in.
- Never copy local/private data into production.
- Enforce a hard $0 cap and fail closed at provider quotas.

## Readiness checklist

- User and authorization boundary: ready.
- Deployment target and domain: ready.
- Data migration policy: ready.
- Storage and background execution direction: ready.
- AI bridge and offline behavior: ready.
- Market-data scope and licensing boundary: ready.
- Cost ceiling: ready.
- Known unsupported/degraded behavior disclosed: ready.

## Status

Intake approved on 2026-08-13. Next: `mcax-story`.
