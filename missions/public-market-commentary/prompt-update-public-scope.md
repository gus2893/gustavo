# Prompt update: public stock-commentary scope

**Date:** 2026-08-08
**Triggered by:** user request
**Approval status before:** implementation in progress under the original local paper-lab scope
**Approval status after:** needs re-approval

## Change description

The user first changed the project from a private CFT-specific paper-trading knowledge base into a marketable public stock-commentary product. The user then added the core product loop: sponsors purchase seats donated to public participants; each participant chats with a stable Seat Brain; that Brain transmits ideas to the Core Brain; the Brains debate and select the strongest idea; and every interaction is preserved. The public homepage streams proof of activity without shipping protected words, while authorized content is projected through a Next.js BFF.

## Sections of 02-design.md updated

- **R — Requirements**
  - **Was:** Preserve local paper-trade mechanics, grades, risk gates, order APIs, and CFT symbol mappings.
  - **Now:** Publish stock-price commentary with no order, account, broker, or prop-firm behavior.
- **E — Evidence model**
  - **Was:** Evidence promoted candidates into STANDARD, ELITE, or GREAT ELITE order eligibility.
  - **Now:** Evidence supports commentary, uncertainty, and observable conditions only.
- **A — Architecture**
  - **Was:** Policy, state, schemas, and docs centered on paper trades and passive exports.
  - **Now:** Editorial policy, public voice, data freshness, commentary templates, and current commentary state.
- **S — Safety**
  - **Was:** Block real execution while preserving local paper-order and export workflows.
  - **Now:** Remove order/export workflows entirely and prohibit personalized financial advice.
- **C — Content protection**
  - **Was:** No protected-feed design existed.
  - **Now:** Public HTML receives safe metadata and placeholders only; authenticated streams use server-side authorization and least-data DTOs.
- **I — Interaction model**
  - **Was:** One assistant published commentary entries.
  - **Now:** Sponsored participants, Seat Brains, the Core Brain, transmissions, debates, scoring, and winner decisions form an append-only event chain.

## Sections of 01-story.md updated

- Replaced the paper-lab operator story with a public reader seeking understandable price commentary.
- Removed order quality, account risk, leverage, and export acceptance criteria.
- Added branding, freshness, editorial, and non-advisory acceptance criteria.
- Added sponsor, seat allocation, stable Brain, transmission, debate, winner-rubric, visibility, and event-provenance acceptance criteria.

## Impact

### Plan tasks invalidated

- Original task 2: all CFT/paper-trade mechanism documentation must be replaced.
- Original task 3: paper-order and passive-export schemas must be removed; editorial policy and commentary templates take their place.
- Original task 4: validation must change from checking local execution safety fields to checking editorial boundaries and absence of legacy execution terms.

### Tests that must change

- `scripts/validate.ps1` — replace CFT mapping and export-directory assertions with public-scope file checks and forbidden-legacy-term checks.
- JSON parsing validation remains valid but must target the new editorial policy and commentary state.

### Files that must change after approval

- `README.md` — replace the product identity, audience, repository map, and safety boundary.
- `AGENTS.md` — replace paper-lab contributor rules with editorial-product rules.
- `docs/*.md` — remove the paper-trade/CFT documents and add editorial, voice, freshness, and methodology documents.
- `policy/lab-policy.json` — replace with `policy/editorial-policy.json`.
- `state/*.json` — replace profile/trade state with stock commentary state.
- `schemas/*.json` — remove paper-order/export schemas and add a stock-commentary schema.
- `templates/*.md` — replace decision/order and symbol-verification templates with a stock-commentary template.
- `scripts/validate.ps1` — validate new structure and reject legacy product terms.
- Repository directory — rename to `tapethoughts`.
- New Next.js application files — marketing shell, authenticated seat workspace, BFF routes, server-only DAL, orchestration, encryption, and event storage.

### Verification status

- Existing validation has not been run because the product design is now stale.
- Full validation is required after the approved migration.

## Naming note

Working choice: **TapeThoughts** — short, memorable, relevant to market-price commentary, and compatible with the updated tagline “The market thinks out loud.” A preliminary web collision search did not surface an obvious stock-commentary product using the exact joined name, but this is not trademark or domain clearance.

## Security design note

Blurred protected text is not accepted as a security boundary. The public response must never contain the original words. Next.js Route Handlers remain publicly reachable endpoints, so authorization is repeated in the BFF and centralized in a server-only DAL that returns minimal role-specific DTOs. TLS protects transport; message bodies are encrypted at rest; decryption happens server-side after authorization. An authorized browser can always copy text it is allowed to display, so the product will not make impossible anti-copy promises.

## Re-approval

- Presented to user: 2026-08-08
- Confirmed approved: pending

## Next skill

`mcax-plan` after explicit approval, then the invalidated repository tasks can be rewritten and executed.
