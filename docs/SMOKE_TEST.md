# Working MVP smoke test

This smoke proves the local invitation, authenticated chat, memory, Challenge,
and public-redaction path in a real Chromium browser. It does not enable a
production model or market-data fixture. The automated test starts a disposable
PostgreSQL cluster, seeds one licensed delayed AAPL observation directly in that
test database, starts a real Next server, and removes the isolated database when
the run ends. Docker and Valkey are not required for this bounded reload-based
smoke.

## Automated browser smoke

Use Node.js 24 and pnpm 11 from `package.json`. PostgreSQL 17 client/server
binaries must be installed locally; set `GUSTAVO_TEST_POSTGRES_BIN` when they are
not in a standard installation directory.

Install dependencies and Chromium once:

```powershell
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Run the smoke headlessly, or add `--headed` to watch the same path:

```powershell
pnpm playwright test tests/e2e/gustavo-mvp.spec.ts
```

The browser issues a single-use invitation, opens `/join`, creates Ada's
account, and reaches **Your Node Brain**. It seeds a licensed AAPL observation
marked **DELAYED** by 900 seconds, persists the private text
`private completed-close thesis`, and confirms the private chat exposes Node
Brain and Main Brain attribution surfaces. It then opens `/challenge`, confirms
the seeded paper position renders **AAPL**, **DELAYED — 900 seconds**, and its
observation timestamp, and requires the exact label
**SIMULATION ONLY — NOT A REAL TRADE**. It returns to `/chat` and confirms
**Inspect memories** is available. Finally it clears the session cookie and
verifies the private thesis is absent from the public page's DOM and captured
public response payloads.

Fixture mode is test-process-only. The Compose production profile fixes
`GUSTAVO_TEST_FIXTURES_ENABLED` to `false`, and production startup fails closed
if that value is enabled.

## Human local-stack check

Start and health-check the local MVP as described in `docs/OPERATIONS.md`. With
`GUSTAVO_OPERATOR_ID` set to the issuing operator, create an invitation whose
expiry is in the future:

```powershell
$expiry = (Get-Date).ToUniversalTime().AddHours(1).ToString("o")
pnpm invitation:issue $expiry
```

Open `http://localhost:3000/join?token=<issued-token>` and repeat these visible
checks:

1. Enter a display name and a passphrase of at least 12 characters, then choose
   **Create account**.
2. Confirm `/chat` shows **Your Node Brain**, the private-message form, the Main
   Brain proposal disclosure, and **Inspect memories**.
3. Send a unique private sentence and confirm it remains visible after the page
   reloads.
4. Open `/challenge` and confirm **SIMULATION ONLY — NOT A REAL TRADE**.
5. Clear site cookies, open `/`, and confirm the unique private sentence is not
   present in the public activity shell or browser network response bodies.

The production local stack has no model or live market-data adapter yet. Do not
turn on test fixtures to simulate one; the deterministic licensed observation is
owned only by the automated isolated smoke.

## Production-readiness improvement smoke

Run the integrated improvement proof with Node 24, PostgreSQL 17 tools, a
running Docker Engine, the locked dependencies, and installed Chromium. The
harness runs the Compose-pinned `valkey/valkey:8.1.3-bookworm` image. On
non-Windows hosts, PowerShell 7 (`pwsh`) is also required to run the production
backup scripts:

```powershell
pnpm playwright test tests/e2e/gustavo-production-readiness.spec.ts
```

The test uses one disposable PostgreSQL cluster and a real Next server. It
creates protected account history, runs the production encrypted backup and
shared verifier, restores into a separately named database, and compares the
authenticated schema version and event high-water. It destroys a disposable
Valkey container, confirms the replacement starts empty, and rebuilds/prewarms
it through PostgreSQL-authoritative production cache APIs. It opens a due Main
Brain broadcast through the production scheduler,
and authenticates the bounded operator-health route. It then clears cookies and
checks the public page and API for private text, ciphertext fields, execution
language, and false live-post labeling. The isolated restore database, backup
directory, web process, and PostgreSQL cluster are removed after the run.

This smoke proves integration and recovery behavior, not the projected-million
performance budget. `docs/PERFORMANCE.md` records that only the smaller
projected calibration has passed; the full projected-million benchmark remains
required before public launch. Complete every item in
`docs/PRODUCTION_CHECKLIST.md` before changing Squarespace DNS or enabling public
ingress.
