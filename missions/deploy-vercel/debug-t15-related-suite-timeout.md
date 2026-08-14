# Debug: T15 related-suite timeout
**Originated during:** mcax-execute T15 Stage B
**Status:** fixed

## Symptom (one sentence)

The combined trusted Vitest gate for the T6/T7/T14 related files produced no reporter output and the enclosing shell command reached its 120,000 millisecond bound with exit code 124.

## Reproduction

1. Prepend the trusted Node 24 runtime directory to `PATH`.
2. Run the trusted Node executable and trusted pnpm JS entrypoint with `exec vitest run tests/bridge/qstash.test.ts tests/bridge/codex-cli.test.ts tests/market-data/finnhub-poller.test.ts --reporter=dot` under a 120,000 millisecond shell bound.

Result: no Vitest output before the enclosing command returned exit 124 after approximately 124 seconds.

## Immediate safety check

- A read-only `Win32_Process` query found no Node process whose command line referenced this repository or Vitest after the timeout.
- A read-only repository scan excluding `.git` and `node_modules` found no `*.tmp` or `*.temp` residue.
- Repository status contained only the already-known mission/implementation files; no new runtime artifact appeared.

## Hypotheses

- H1: One related file has a proportionately long deterministic suite duration that exceeds the combined shell bound. Confirmed: the isolated Finnhub file passed but took 112.56 seconds; QStash took 17.42 seconds and Codex CLI took 5.78 seconds, exceeding 120 seconds in aggregate.
- H2: The Stage B production change introduced a related assertion failure. Refuted by all three isolated suites passing.
- H3: The killed runner left an owned process or temporary artifact. Refuted by the immediate safety checks above.

## Fix attempts (counter)

1. Varied only suite composition by running the three already-approved files separately with proportionate bounds: fixed the gate-observation problem without a production change.

## Regression test

Files: `tests/bridge/qstash.test.ts`, `tests/bridge/codex-cli.test.ts`, `tests/market-data/finnhub-poller.test.ts`
Pre-isolation result: combined command timed out at the enclosing 120-second bound without output.
Post-isolation result: QStash 7/7 passed, Codex CLI 79 passed/3 live tests skipped, and Finnhub 74/74 passed; aggregate 160 passed/3 skipped.

## Fix

No code fix was warranted. The combined bound was shorter than the deterministic aggregate suite duration, so the related gate is run as three independently bounded files.

## Wider check

All T6/T7/T14 related assertions passed, and none of the skipped live Docker cases was enabled.
