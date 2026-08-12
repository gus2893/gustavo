# Local MVP operations

This Compose stack is for a single-operator local MVP. It binds the web app only to the loopback interface; PostgreSQL and Valkey have no host ports and remain solely on the internal backend network. Web and worker also use a separate outbound-capable network for provider access. It does not configure public TLS, DNS, or cloud backup credentials.

## Configure

Node.js 24, pnpm 11, Docker Engine, and Docker Compose are required. Copy `infra/env.example` to `infra/.env`, then fill `POSTGRES_PASSWORD`, `DATABASE_URL`, and every blank Gustavo cryptographic key with independently generated values. `DATABASE_URL` must use the Compose hostname `postgres`, for example `postgresql://gustavo:<password>@postgres:5432/gustavo`. Generate each application key as 32 random bytes encoded as base64. Never commit `infra/.env` or paste its values into Compose.

There is no production model or market-data adapter in the repository yet. T30 therefore boots in no-provider local mode: existing UI, authentication, durable message storage, privacy, cache, and SSE infrastructure run, but model generation and live market-data ingestion are unavailable until separately reviewed adapters are implemented. The optional role metadata in `infra/env.example` can remain blank. Compose does not claim or forward unsupported provider credential variables.

Compose selects the versioned `local-mvp-v1` deployment profile. That profile permits a non-Secure session cookie only for an exact HTTP loopback origin (`localhost`, `127.0.0.1`, or `[::1]`). Normal production remains fixed to `https://gustavo.lol` with a Secure `__Host-` cookie; do not use the local profile for public exposure.

## Start and verify health

Run the complete stack from the repository root:

```powershell
pnpm mvp:start
docker compose --env-file infra/.env -f infra/compose.yaml ps
```

The first command builds pinned Node 24 web and worker images, starts PostgreSQL and Valkey, applies each pending database migration exactly once, prewarms cache projections, and starts the continuous cache/privacy/SSE worker loops. Worker health is published only after prewarm and all three loops start; web startup waits for that readiness marker. Wait until `web`, `worker`, `postgres`, and `valkey` report healthy. Open [http://localhost:3000](http://localhost:3000) in the local browser. Challenge screens must retain the label `SIMULATION ONLY — NOT A REAL TRADE`.

PostgreSQL is authoritative and uses the named `postgres-data` volume. Valkey uses `valkey-data` for local restart continuity, but remains disposable: losing it must not lose source history because cache projections and stream notifications rebuild from PostgreSQL.

## Logs

Follow application and dependency logs without exposing environment values:

```powershell
docker compose --env-file infra/.env -f infra/compose.yaml logs -f web worker postgres valkey migrate
```

## Shutdown

A normal shutdown allows the web and worker processes up to 30 seconds to stop cleanly and preserves both named volumes:

```powershell
docker compose --env-file infra/.env -f infra/compose.yaml down
```

Do not add `--volumes` unless intentionally destroying all local MVP state. The later backup milestone must be completed and restore-tested before public production use; this local task contains no backup credentials or public-exposure setup.
