# Debug: Packaged Codex execution

**Originated during:** deployment intake
**Status:** open

## Symptom

Running the Codex desktop application's packaged executable from PowerShell was expected to print its version, but Windows returned `Access is denied`.

## Reproduction

1. Resolve `codex` with `Get-Command`.
2. Invoke the resolved `.exe` and the adjacent extensionless binary with `--version`.
3. Both invocations fail with `Access is denied`.

## Hypotheses

- H1: The Microsoft Store/MSIX-packaged desktop binary is not an ordinary background-process entrypoint. Confirmed by both packaged entrypoints failing while their ACLs include execute rights.

## Root cause

The only discovered `codex` command resolves inside the protected desktop application package. It is unsuitable as a service executable outside that application context.

## Fix attempts

None. The deployment design will use the separately distributed `@openai/codex` standalone CLI instead of changing the desktop package.

## Regression test

Pending implementation-stage service preflight.

## Lessons / design implications

Do not couple the bridge to the desktop application's installation path or lifecycle.
