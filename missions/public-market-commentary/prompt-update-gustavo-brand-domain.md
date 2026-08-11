# Prompt update: Gustavo brand and domain

**Date:** 2026-08-09
**Triggered by:** user request
**Approval status before:** needs re-approval
**Approval status after:** needs re-approval

## Change description

The user renamed Tape to Gustavo and supplied the canonical domain `gustavo.lol`, which the user owns through Squarespace. The application remains local-first, while Squarespace remains the initial registrar/DNS control point. Public routing is treated as a replaceable deployment edge rather than part of the core account, Brain, history, or backup model.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Product name Tape with no canonical domain.
  - **Now:** Product name Gustavo, canonical origin `https://gustavo.lol`, registrar/DNS control through Squarespace.
- **A — Architecture**
  - **Was:** Repository rename target `tape`.
  - **Now:** Repository rename target `gustavo`.
- **D — Local deployment**
  - **Was:** Local runtime and cloud backup were defined without a public domain edge.
  - **Now:** Squarespace DNS connects the canonical domain only after verification; public access uses HTTPS through a hardened reverse proxy or outbound tunnel without exposing data services.

## Sections of 01-story.md updated

- Replaced active Tape references with Gustavo.
- Added `gustavo.lol` to the self-hosting story and acceptance criteria.

## Impact

### Plan tasks invalidated

- Branding task: package metadata, page copy, social metadata, email identity, and generated assets must use Gustavo.
- Repository migration task: target directory and package slug change from `tape` to `gustavo`.
- Deployment task: add canonical-origin configuration and a Squarespace DNS operator runbook.
- Security task: add trusted-origin, cookie-domain, proxy-header, TLS, and public-edge validation for `gustavo.lol`.

### Tests that must change

- Branding tests must assert Gustavo and reject stale Tape/TapeThoughts output.
- Canonical URL tests must assert `https://gustavo.lol` in metadata and absolute links.
- Host validation tests must reject untrusted forwarded hosts.
- Deployment smoke tests must verify HTTPS redirect and secure-cookie behavior at the canonical origin.

### Code files that must change after approval

- `package.json`, `README.md`, and application metadata — rename product/package references to Gustavo.
- `app/layout.tsx` and marketing pages — use Gustavo branding and canonical metadata.
- `lib/server/config/*` — define and validate the canonical origin.
- `infra/proxy/*` — configure HTTPS edge or tunnel integration without exposing PostgreSQL/queue services.
- `docs/deployment/squarespace-dns.md` — document required operator-controlled DNS changes without storing credentials.

### Verification status

- No implementation verification exists; full verification will be required after execution.

## Re-approval

- Presented to user: 2026-08-09
- Confirmed approved: pending

## Next skill

`mcax-plan` after the user explicitly approves the combined Gustavo brand, durable-history, local-deployment, backup, and scale design.
