# Local MVP operations

The public hybrid deployment is operated separately. Use
[`VERCEL_DEPLOYMENT.md`](./VERCEL_DEPLOYMENT.md) for the exact Free-resource,
staged-production, local-worker, quota, degraded-mode, and rollback sequence.
This file remains the authority for the isolated local Compose MVP and its
encrypted backup/restore workflow.

This Compose stack is for a single-operator local MVP. It binds the web app only to the loopback interface; PostgreSQL and Valkey have no host ports and remain solely on the internal backend network. Web and worker also use a separate outbound-capable network for provider access. It does not configure public TLS, DNS, or cloud backup credentials.

## Configure

Node.js 24, pnpm 11, Docker Engine, and Docker Compose are required. Copy `infra/env.example` to `infra/.env`, then fill `POSTGRES_PASSWORD`, `DATABASE_URL`, and every blank Gustavo cryptographic key with independently generated values. `DATABASE_URL` must use the Compose hostname `postgres`, for example `postgresql://gustavo:<password>@postgres:5432/gustavo`. Generate each application key as 32 random bytes encoded as base64. Never commit `infra/.env` or paste its values into Compose.

Run repository commands through KnownFolder-derived absolute executables, not
`PATH`, aliases, or wrappers:

```powershell
$KnownProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$KnownWindows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$TrustedNode = Join-Path $KnownProgramFiles 'nodejs\node.exe'
$TrustedCorepackScript = Join-Path $KnownProgramFiles 'nodejs\node_modules\corepack\dist\corepack.js'
$TrustedDocker = Join-Path $KnownProgramFiles 'Docker\Docker\resources\bin\docker.exe'
$TrustedPowerShell = Join-Path $KnownWindows 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TrustedPostgresBin = Join-Path $KnownProgramFiles 'PostgreSQL\17\bin'
$TrustedPsql = Join-Path $TrustedPostgresBin 'psql.exe'
$TrustedPgDump = Join-Path $TrustedPostgresBin 'pg_dump.exe'
$TrustedCreatedb = Join-Path $TrustedPostgresBin 'createdb.exe'
$TrustedPgRestore = Join-Path $TrustedPostgresBin 'pg_restore.exe'
$TrustedDropdb = Join-Path $TrustedPostgresBin 'dropdb.exe'
```

The `local-mvp-v1` Compose profile intentionally boots in no-provider mode:
existing UI, authentication, durable message storage, privacy, cache, and SSE
infrastructure run, but it does not start the separately operated hybrid Codex
or Finnhub adapters. The optional role metadata in `infra/env.example` can
remain blank. Compose does not claim or forward provider credentials.

Compose selects the versioned `local-mvp-v1` deployment profile. That profile permits a non-Secure session cookie only for an exact HTTP loopback origin (`localhost`, `127.0.0.1`, or `[::1]`). Normal production remains fixed to `https://gustavo.lol` with a Secure `__Host-` cookie; do not use the local profile for public exposure.

## Start and verify health

Run the complete stack from the repository root:

```powershell
& $TrustedNode $TrustedCorepackScript pnpm mvp:start
& $TrustedDocker compose --env-file infra/.env -f infra/compose.yaml ps
```

The first command builds pinned Node 24 web and worker images, starts PostgreSQL and Valkey, applies each pending database migration exactly once, prewarms cache projections, and starts the continuous cache/privacy/SSE worker loops. Worker health is published only after prewarm and all three loops start; web startup waits for that readiness marker. Wait until `web`, `worker`, `postgres`, and `valkey` report healthy. Open [http://localhost:3000](http://localhost:3000) in the local browser. Challenge screens must retain the label `SIMULATION ONLY — NOT A REAL TRADE`.

PostgreSQL is authoritative and uses the named `postgres-data` volume. Valkey uses `valkey-data` for local restart continuity, but remains disposable: losing it must not lose source history because cache projections and stream notifications rebuild from PostgreSQL.

## Logs

Follow application and dependency logs without exposing environment values:

```powershell
& $TrustedDocker compose --env-file infra/.env -f infra/compose.yaml logs -f web worker postgres valkey migrate
```

## Shutdown

A normal shutdown allows the web and worker processes up to 30 seconds to stop cleanly and preserves both named volumes:

```powershell
& $TrustedDocker compose --env-file infra/.env -f infra/compose.yaml down
```

Do not add `--volumes` unless intentionally destroying all local MVP state.

## Encrypted backup and recovery

Backups are an improvement boundary outside the live request path. `infra/backup/create.ps1` takes a database-consistent custom-format `pg_dump`, encrypts it locally with AES-256-CBC plus encrypt-then-MAC HMAC-SHA256 authentication, verifies the ciphertext and decrypted payload, then atomically promotes the temporary directory. The manifest binds the ciphertext and payload checksums, byte length, schema version, event high-water, key version, algorithm, IV, and retention settings. It contains no key material, database credentials, `.env` content, or plaintext database rows.

Create a 64-byte random key in an OS-protected file outside the repository. Pass its path with `-KeyFile` or set `GUSTAVO_BACKUP_KEY_FILE`; set the credential-bearing PostgreSQL URL in `GUSTAVO_BACKUP_DATABASE_URL`. Never place the key, provider credentials, or database password in the archive, manifest, command arguments, logs, shell history, or repository. Keep old key versions available under the same access controls until every backup encrypted with them expires. A typical local command is:

```powershell
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File infra/backup/create.ps1 `
  -DestinationDirectory D:\gustavo-backups\2026-08-12 `
  -KeyFile D:\gustavo-secrets\backup-k1.bin `
  -KeyVersion backup-k1 -PgDumpPath $TrustedPgDump -PsqlPath $TrustedPsql
```

The script opens a read-only repeatable-read transaction, drains database-tool diagnostics asynchronously, exports its PostgreSQL snapshot under a bounded timeout, derives `SchemaVersion` from `schema_migrations` and `EventHighWater` from `events.ingested_sequence` inside that transaction, and makes `pg_dump` consume the same snapshot. Optional `-ExpectedSchemaVersion` and `-ExpectedEventHighWater` values are assertions only; they cannot populate the manifest and a mismatch prevents finalization. The restore drill compares both authenticated values to the restored database.

Database passwords travel only through a temporary `PGPASSFILE` created inside an owner-only credential directory before secret bytes are written; both are overwritten/removed after the database tools finish. PostgreSQL URLs are strictly parsed from environment variables only: creation uses `GUSTAVO_BACKUP_DATABASE_URL`, while restore uses `GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL`. The scripts consume and clear those URL variables, exclude them from database-tool child environments, and never pass credentials in process arguments or logs. All temporary directories that can contain a plaintext dump, decrypted payload, fixture, or key are owner-only before file creation; plaintext files receive owner-only permissions before their first content write. The command refuses an existing destination and never invokes a shell expression. Always pass reviewed trusted absolute paths for `psql`, `pg_dump`, `createdb`, `pg_restore`, `dropdb`, and any optional object-storage CLI; ambient `PATH` is not authority.

For provider-neutral S3-compatible storage, add `-S3Uri s3://bucket/prefix`. Upload is optional and occurs only after local verification. Each run publishes conditionally-created immutable objects under `prefix/<generationId>/backup.gbackup` and `prefix/<generationId>/backup.manifest.json`; it prints the immutable manifest URI and never overwrites a fixed key or publishes a mutable “latest” pointer. If the manifest upload fails, the encrypted artifact can remain as an unreferenced orphan, while every previously completed generation remains untouched. Configure the provider's S3 endpoint through its CLI profile/environment, not in this repository. Give the backup identity access only to create objects under the one backup prefix (and object-lock/retention operations if used); give the separately held restore identity only the read access needed for drills. It must not administer the bucket, application, database, DNS, or encryption keys.

Retention is operational configuration with bounded script defaults: 14 daily days, 8 weekly weeks, and 12 monthly months. Adjust `-DailyRetentionDays` (1–366), `-WeeklyRetentionWeeks` (1–104), and `-MonthlyRetentionMonths` (1–120) to the approved policy. Apply lifecycle removal only after a newer generation has passed verification and a restore drill. Versioning and immutable/object-lock retention are recommended where supported.

Verify any downloaded pair locally before restore:

```powershell
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File infra/backup/verify.ps1 `
  -ManifestPath D:\gustavo-backups\2026-08-12\backup.manifest.json `
  -KeyFile D:\gustavo-secrets\backup-k1.bin
```

Run a monthly restore drill (and after PostgreSQL, schema, or key changes) into a new, separately named database. Set its credential-bearing maintenance URL in `GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL`. The script rejects the active database name, refuses an existing target through `createdb`, verifies authenticated metadata before `pg_restore`, and drops its isolated drill database unless `-KeepRestoredDatabase` is explicitly supplied:

```powershell
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File infra/backup/restore-drill.ps1 `
  -ManifestPath D:\gustavo-backups\2026-08-12\backup.manifest.json `
  -KeyFile D:\gustavo-secrets\backup-k1.bin `
  -ActiveDatabaseName gustavo `
  -RestoreDatabaseName gustavo_restore_20260812 `
  -CreatedbPath $TrustedCreatedb -PgRestorePath $TrustedPgRestore `
  -PsqlPath $TrustedPsql -DropdbPath $TrustedDropdb
```

Record the drill date, backup generation, authenticated schema/high-water/key versions, row-count/hash comparisons, result, and cleanup confirmation without recording protected text or credentials. Test fixture plumbing without Docker or network access with `infra/backup/restore-drill.ps1 -UseFixture`.

Before public exposure, complete recovery verification first, then configure authenticated HTTPS through a hardened reverse proxy or outbound tunnel and update Squarespace DNS. Do not expose PostgreSQL, Valkey, backup endpoints, or router port-forwarding directly to the internet.
