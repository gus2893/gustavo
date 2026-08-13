# Performance and operator-health verification

Gustavo measures source durability and derived-system health without treating caches, projections, or benchmark summaries as authoritative data. Performance results are valid only with the machine profile, source row count, cold/warm separation, query-plan evidence, and exact command that produced them.

## Budgets

On a documented local reference machine with at least 1,000,000 actual rows in both
`events` and `memory_records`:

- warm, account-scoped recall p95 must be at most 250 ms;
- an already-authorized cached handoff load p95 must be at most 100 ms;
- recall candidate SQL must retain its limits and indexed access evidence;
- memory projection freshness should remain below 5 seconds under normal load; and
- model generation is excluded from the recall benchmark and reported separately.

The test uses a smaller 10,000-row projected calibration by default. That calibration
creates at least 10,000 actual `events` and `memory_records` rows and always exercises the
real PostgreSQL recall path, all production projection authority/completeness triggers,
encryption/body authorization, correction semantics, a foreign-account permission trap, a
real scoped cache read, percentile math, and `EXPLAIN (FORMAT JSON)` evidence over the exact
captured recall-channel SQL and parameters under normal PostgreSQL planner settings. It is a
structural regression test, not proof of the million-projected-row latency budgets.

Run the full reference benchmark from the repository root with Node 24 and the locked pnpm version:

```powershell
$env:GUSTAVO_RUN_MILLION_BENCHMARK='1'
pnpm vitest run tests/performance/recall-latency.test.ts --testTimeout=600000
Remove-Item Env:GUSTAVO_RUN_MILLION_BENCHMARK
```

The opt-in target is exactly 1,000,000 source events and 1,000,000 projected memories. The
fixture is deterministic and set-based, uses an isolated test schema, retains normal indexes
and projection authority/completeness triggers, and records both actual database counts.
Never publish a result that substitutes a requested count for `count(*)`, times a no-op,
combines cold and warm samples, or omits failed iterations.

The August 12, 2026 reference-machine verification is partial. A prior event-log-only run
counted 1,000,227 actual events and passed 200 measured recalls with warm p95 128.22 ms and
cached-handoff p95 0.1845 ms, but it had only three projected memories and therefore does not
prove projected-scale recall. The fully triggered projected calibration passed at 10,003
`memory_records` / 10,043 `events`, with nine exact captured plans root-limited and indexed,
zero unbounded candidate scans, and a latest warm p95 of 207.23 ms. Three full projected-
million attempts did not reach measurement within the ten-minute gate: one exceeded the
gate during projection, one exhausted the C: test cluster's WAL space, and the D:-backed run
confirmed source-event seeding but exceeded the gate during indexed projection. The million
projected latency budget is therefore unverified, not passed. Run the opt-in command on a
larger/faster PostgreSQL fixture host before using this as release evidence.

## Operational metrics

`lib/server/observability/metrics.ts` defines bounded series for:

- database commit latency and outcome;
- transactional queue age;
- memory projection freshness;
- cache hit/miss/filter/stale/eviction/contention state by fixed namespace;
- cache fallback latency, rebuild rows per second, and cache/PostgreSQL divergence;
- model latency and estimated cost by fixed role/status; and
- provider-reported versus estimated model-cost divergence.

The production PostgreSQL adapter measures the real transaction `COMMIT`, the cache worker publishes bounded cache/queue deltas, and the model gateway records latency/cost/divergence only after its finalization transaction commits. The operator-health request does not substitute a synthetic probe for these measurements.

Metric labels are allowlisted. Account IDs, conversation IDs, Node IDs, symbols, queries, source text, ciphertext, secrets, and arbitrary provider/model strings are prohibited as labels. High-cardinality evidence belongs in protected traces or logs, not metric dimensions.

## Operator health

`GET /api/operator/health` requires `Authorization: Bearer <token>`, where the server-only `GUSTAVO_OPERATOR_HEALTH_TOKEN` is 32–512 characters. Authentication finishes before the database factory is resolved. Responses are `private, no-store`, capped at 64 KiB, and contain only bounded aggregates plus a machine profile; they contain no protected text or identifiers.

The health document includes durable database-commit histogram percentiles, queue age,
projection freshness, durable cache aggregates, verified rebuild throughput, bounded
persisted recall and model p50/p95/p99 latency, model cost divergence, Node/PostgreSQL
versions, CPU model/count, and memory capacity. Empty projection, rebuild, verification,
recall, model, or fallback evidence is reported as `null`/absent rather than as fabricated
zero-latency success. Cache fallback exposes exact bounded sample count, average, and maximum;
it does not claim that a percentile over per-batch averages is a valid request percentile.

For comparable measurements, stop unrelated CPU- or disk-heavy tasks, retain the same power mode, record whether PostgreSQL data was already in the operating-system page cache, and run at least three full benchmark trials. Keep the raw Vitest output with the deployed revision and do not compare runs from materially different machines as if they were the same baseline.
