# Debug: T30 worker readiness and provider-mode documentation
**Originated during:** mcax-execute T30 Stage B
**Status:** fixed

## Symptom (one sentence)

Compose reported the worker healthy whenever PID 1 existed, even before cache prewarm and continuous worker startup, while operations documentation implied unsupported provider credentials could be used.

## Reproduction

1. Inspect the worker healthcheck in `infra/compose.yaml` and worker startup order in `worker/runtime.ts`.
2. Inspect production model and market-data adapters and compare them with `docs/OPERATIONS.md`.

Result: the healthcheck used only `kill -0 1`; there was no readiness lifecycle, and the repository had provider-neutral interfaces/test fakes but no production network adapter or credential names.

## Hypotheses

- H1: liveness was being mistaken for readiness. Confirmed because the probe passed from process start, before prewarm and controller creation.
- H2: supported provider secrets existed but were omitted from Compose. Refuted by repository-wide adapter/environment-variable inspection.
- H3: cleanup could exceed the declared shutdown budget. Confirmed because runtime and database close occurred outside the bounded promise.

## Root cause

The runtime exposed no process-specific readiness state, and shutdown bounding covered only controller stops. Documentation described a future provider configuration as if an adapter already consumed it.

## Fix attempts (counter)

1. Added a PID readiness marker after successful prewarm/controller startup, removal on startup/shutdown/failure, a process-specific Compose probe, web dependency on worker health, bounded full cleanup, and accurate no-provider documentation; focused regression passed.

## Regression test

File: `tests/infra/local-runtime.test.ts`.

The test exercises marker create/remove lifecycle and structurally verifies ordering, health probing, web readiness gating, bounded cleanup, and honest no-provider documentation.

## Fix

- `worker/runtime.ts` owns marker lifecycle and bounds controllers, Valkey, cache runtime, and PostgreSQL pool cleanup together.
- `infra/compose.yaml` validates the recorded worker PID and holds web startup until worker health succeeds.
- `docs/OPERATIONS.md` and `infra/env.example` describe the current no-provider local mode without inventing secret variables.

## Wider check

- Node 24.7 focused and related cache/privacy/SSE suites: 89 assertions passed; one optional duplicate config assertion was skipped in that combined run.
- Node 24.7 TypeScript and production Next build: passed.
- Docker Compose config parsing and `git diff --check`: passed.
