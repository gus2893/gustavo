import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOperatorHealthHandler } from "../../app/api/operator/health/route";
import {
  collectHybridHealth,
  HYBRID_HEALTH_POLICY,
  projectHybridHealth,
} from "../../lib/server/bridge/health";
import { postgresPoolPolicy } from "../../lib/server/db/postgres";
import type { EventDatabase } from "../../lib/server/events/types";
import {
  bootstrapProduction,
  readProductionBootstrapEnvironment,
} from "../../scripts/bootstrap-production";
import {
  createInvitationRedemptionUrl,
  issueInvitationRedemptionUrl,
} from "../../scripts/issue-invitation";
import { runProductionMigrations } from "../../scripts/migrate-production";
import { testContext } from "../helpers/postgres";

describe("hybrid deployment runbook", () => {
  it("uses executable authorities for deploy, maintenance, market shutdown, backup, and rollback", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    const operations = readFileSync("docs/OPERATIONS.md", "utf8");
    const checklist = readFileSync("docs/PRODUCTION_CHECKLIST.md", "utf8");
    const smoke = readFileSync("docs/SMOKE_TEST.md", "utf8");
    const combined = [deploy, operations, checklist, smoke].join("\n");

    expect(deploy).toContain("vercel: 58.4.0");
    expect(deploy).toContain("trusted absolute Corepack");
    expect(deploy).toContain("[Environment]::GetFolderPath");
    expect(deploy).toContain("Invoke-TrustedVercel");
    expect(deploy).not.toContain("pnpm exec vercel");
    expect(combined).not.toMatch(/^\s*(?:pnpm|npx|vercel|powershell)(?:\.exe)?\s/mu);
    expect(combined).not.toMatch(/^\s*(?:docker|tailscale)(?:\.exe)?\s/mu);
    expect(deploy).not.toMatch(/\$env:(?:LOCALAPPDATA|ProgramFiles)[\s\S]{0,240}(?:Move-Item|volume\s+rm)/u);
    expect(deploy).not.toMatch(/(?:Move-Item|\bvolume\s+rm\b)/u);
    expect(deploy).toContain("scripts/setup-hybrid-worker.ps1 -MaintenanceRebuild");
    expect(deploy).toContain("-MaintenanceRebuild -RotateCodexAuthVolume");
    expect(deploy).toContain("GUSTAVO_HYBRID_WAKE_URL");
    expect(deploy).toContain("GUSTAVO_HYBRID_PUBLIC_WAKE_URL");
    expect(combined).not.toContain("GUSTAVO_MARKET_POLLER_ENABLED");

    const migrate = deploy.indexOf("production:migrate");
    const empty = deploy.indexOf("migrated authority-only empty inventory");
    const backup = deploy.indexOf("create.ps1");
    const bootstrap = deploy.indexOf("production:bootstrap");
    expect(migrate).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(migrate);
    expect(backup).toBeGreaterThan(empty);
    expect(bootstrap).toBeGreaterThan(backup);

    expect(deploy).toContain("git status --porcelain");
    expect(deploy).toContain("reviewed pushed HEAD");
    expect(deploy).toContain("deployment source metadata");
    expect(deploy).toContain("Project Settings > Domains");
    expect(deploy).toContain("www.gustavo.lol -> gustavo.lol");
    expect(deploy).toContain("--prod --skip-domain");
    expect(deploy).toContain("Invoke-TrustedVercel promote $StagedProductionUrl --yes");
    expect(deploy).toContain("same deployment ID and git SHA");

    const rollback = deploy.indexOf("## 11. Bridge disable, market shutdown, and rollback");
    expect(rollback).toBeGreaterThan(-1);
    const bridgeDisabled = deploy.indexOf("GUSTAVO_HYBRID_BRIDGE_ENABLED=false", rollback);
    const pauseMarket = deploy.indexOf("pause the exact five-minute market schedule", bridgeDisabled);
    const stopWorker = deploy.indexOf("$StopProof = Stop-ReviewedHybridWorker", pauseMarket);
    const settleActive = deploy.indexOf("settles admitted and claimed work", stopWorker);
    const pendingDurable = deploy.indexOf("durable PENDING jobs remain queued for reconnect recovery", settleActive);
    expect(pauseMarket).toBeGreaterThan(bridgeDisabled);
    expect(stopWorker).toBeGreaterThan(pauseMarket);
    expect(settleActive).toBeGreaterThan(stopWorker);
    expect(pendingDurable).toBeGreaterThan(settleActive);
    expect(deploy.slice(pauseMarket, stopWorker)).not.toMatch(/Close local admission|zero CLAIMED/iu);
    expect(deploy).toContain('{"kind":"MARKET_CURRENT"}');
    expect(deploy).toContain("PostgreSQL current five-minute bucket");
    expect(deploy).toContain("no independent timer, poller, or schedule");

    expect(deploy).toContain("GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL");
    expect(deploy).toContain("must never be set in Vercel");
    expect(deploy).toContain("must never be forwarded to Codex, Finnhub, or QStash");
    expect(deploy).toContain("1,000 messages/day provider ceiling");
    expect(deploy).toContain("900 messages/day application cap");
    expect(deploy).toContain("SIMULATION ONLY — NOT A REAL TRADE");
    expect(combined).not.toMatch(/^(?:OPENAI_API_KEY|FINNHUB_API_KEY|DATABASE_URL|GUSTAVO_EVENT_ROOT_KEY_V1|QSTASH_(?:TOKEN|CURRENT_SIGNING_KEY|NEXT_SIGNING_KEY))\s*=\s*\S+/mu);
  });

  it.runIf(process.platform === "win32")(
    "executes the documented inventory probe as a stdin async IIFE",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const match = deploy.match(/\$InventoryProbe = @'\r?\n([\s\S]*?)\r?\n'@/u);
      expect(match).not.toBeNull();
      const probe = match![1]!;
      expect(probe).toContain("void (async () => {");
      expect(probe).toMatch(/\}\)\(\)\.catch\(\(error: unknown\) => \{/u);
      expect(deploy).toMatch(/\$InventoryProbe\s*\|\s*& \$TrustedNode \$TrustedCorepackScript pnpm exec tsx -/u);
      expect(deploy).not.toContain("tsx -e $InventoryProbe");

      const harness = probe
        .replace(
          /import \{ bootstrapProduction, readProductionBootstrapEnvironment \} from "\.\/scripts\/bootstrap-production";/u,
          `const readProductionBootstrapEnvironment = () => ({
            databaseUrl: "postgresql://fixture.invalid/gustavo",
            canonicalOrigin: "https://gustavo.lol",
            deploymentProfile: "public-production-v1",
          });
          const bootstrapProduction = async (options: any) => {
            await options.query("preflight");
            await options.issueInvitation();
          };`,
        )
        .replace(
          /import \{ closeDatabase, getDatabase \} from "\.\/lib\/server\/db\/postgres";/u,
          `const closeDatabase = async () => undefined;
          const getDatabase = () => ({
            transaction: async (work: (transaction: any) => Promise<void>) =>
              work({ query: async () => [{ safe_code: null }] }),
          });`,
        );
      const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
      const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      const powerShell = resolve(
        windowsRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
      const powerShellProgram = `$Probe = @'\r\n${harness}\r\n'@\r\n`
        + `$Probe | & '${quotePowerShell(process.execPath)}' '${quotePowerShell(tsxCli)}' -\r\n`
        + "exit $LASTEXITCODE\r\n";
      const result = spawnSync(
        powerShell,
        [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-Command", powerShellProgram,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, FORCE_COLOR: "0" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("MIGRATED_AUTHORITY_ONLY_EMPTY\n");
      expect(result.stderr).toBe("");
      expect(deploy).toMatch(/\$InventoryOutput = @\(\$InventoryProbe\s*\|\s*& \$TrustedNode \$TrustedCorepackScript pnpm exec tsx -\)\r?\n\$InventoryExitCode = \$LASTEXITCODE\r?\nif \(\$InventoryExitCode -ne 0 -or \$InventoryOutput\.Count -ne 1 -or\r?\n\s*\[string\]\$InventoryOutput\[0\] -cne 'MIGRATED_AUTHORITY_ONLY_EMPTY'\)/u);
    },
  );

  it("loads exact production authority without printing it before inventory and bootstrap", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    for (const name of [
      "DATABASE_URL",
      "GUSTAVO_APP_ORIGIN",
      "GUSTAVO_DEPLOYMENT_PROFILE",
      "GUSTAVO_EVENT_ROOT_KEY_VERSION",
      "GUSTAVO_EVENT_ROOT_KEY_V1",
    ]) expect(deploy).toContain(`Read-ProtectedProcessValue '${name}'`);
    expect(deploy).toContain("Read-Host -AsSecureString");
    expect(deploy).toContain("ZeroFreeBSTR");
    expect(deploy).toContain("PROTECTED_PRODUCTION_AUTHORITY_LOADED");
    expect(deploy).toContain("GUSTAVO_DEPLOYMENT_PROFILE', 'Process') -cne 'public-production-v1'");
    expect(deploy).not.toMatch(/Write-(?:Host|Output)[^\n]*(?:DATABASE_URL|GUSTAVO_APP_ORIGIN|GUSTAVO_DEPLOYMENT_PROFILE|GUSTAVO_EVENT_ROOT_KEY)/iu);
    expect(deploy.indexOf("PROTECTED_PRODUCTION_AUTHORITY_LOADED"))
      .toBeLessThan(deploy.indexOf("$InventoryProbe = @'"));
    expect(deploy.indexOf("$InventoryProbe = @'"))
      .toBeLessThan(deploy.indexOf("pnpm production:bootstrap"));
  });

  it("reproves exact reviewed source before each upload and inspects source metadata", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    const helper = deploy.match(/function Assert-ReviewedPushedHead[\s\S]*?^\}/mu)?.[0];
    expect(helper).toBeDefined();
    expect(helper).toMatch(/fetch --prune origin[\s\S]*\$LASTEXITCODE[\s\S]*status --porcelain[\s\S]*\$LASTEXITCODE[\s\S]*rev-parse HEAD[\s\S]*\$LASTEXITCODE[\s\S]*rev-parse '@\{upstream\}'[\s\S]*\$LASTEXITCODE/u);
    expect(helper).toContain("REVIEWED_PUSHED_HEAD_REQUIRED");
    expect(deploy).toMatch(/\$PreviewHead = Assert-ReviewedPushedHead\r?\nif \(\$PreviewHead -cne \$ReviewedHead\) \{ throw 'REVIEWED_HEAD_CHANGED' \}\r?\n\$PreviewDeployOutput = @\(Invoke-TrustedVercel deploy\)/u);
    expect(deploy).toMatch(/\$StagedHead = Assert-ReviewedPushedHead\r?\nif \(\$StagedHead -cne \$ReviewedHead\) \{ throw 'REVIEWED_HEAD_CHANGED' \}\r?\n\$StagedProductionDeployOutput = @\(Invoke-TrustedVercel --prod --skip-domain\)/u);
    expect(deploy).toContain("deployment source metadata");
    expect(deploy).toContain("exactly matches $PreviewHead");
    expect(deploy).toContain("exactly matches $StagedHead");
  });

  it("sanitizes PATH with trusted Git for pinned Vercel source metadata", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    const pinnedVercelSource = readFileSync(
      "node_modules/vercel/dist/chunks/chunk-PVWXPWLQ.js",
      "utf8",
    );
    expect(pinnedVercelSource).toContain('"git --no-optional-locks status -s"');
    const pathLine = deploy.match(/^\$env:PATH = .*$/mu)?.[0];
    expect(pathLine).toBe(
      '$env:PATH = "$(Split-Path -Parent $TrustedNode);$(Split-Path -Parent $TrustedGit);$TrustedSystem32"',
    );
    expect(pathLine).not.toContain("$env:PATH;");
  });

  it("validates and imports the exact pinned Vercel CLI behind a trusted boundary", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    expect(deploy).toContain("$VercelLink = Get-Item -LiteralPath $VercelLinkPath -Force");
    expect(deploy).toContain("$VercelLink.LinkType -cne 'SymbolicLink'");
    expect(deploy).toContain("vercel@58\\.4\\.0_[^\\\\]+\\\\node_modules\\\\vercel$");
    expect(deploy).toContain("$TrustedVercelPackage.version -cne '58.4.0'");
    expect(deploy).toContain("$TrustedVercelCli = Join-Path $CanonicalVercelRoot 'dist\\index.js'");
    expect(deploy).toContain("$TrustedVercelCliItem.PSIsContainer");
    expect(deploy).toContain("function Invoke-TrustedVercel");
    expect(deploy).toContain("pnpm exec -- $TrustedNode --input-type=module --eval $TrustedVercelBootstrap --");
    expect(deploy).not.toContain("pnpm exec vercel");
    for (const operation of [
      "--version",
      "link",
      "project inspect",
      "env add GUSTAVO_HYBRID_WAKE_URL preview",
      "env add GUSTAVO_HYBRID_WAKE_URL production",
      "deploy",
      "--prod --skip-domain",
      "inspect $PreviewUrl --json",
      "api \"/v13/deployments/$($PreviewInspection.id)\" --raw",
      "promote $StagedProductionUrl --yes",
    ]) expect(deploy).toContain(`Invoke-TrustedVercel ${operation}`);
  });

  it.runIf(process.platform === "win32")(
    "resets the effective inner Vercel PATH before CLI import",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const match = deploy.match(/\$TrustedVercelBootstrap = @'\r?\n([\s\S]*?)\r?\n'@/u);
      expect(match).not.toBeNull();
      const bootstrap = match?.[1] ?? "";
      expect(bootstrap).toContain("if (key.toUpperCase() === 'PATH') delete process.env[key];");
      expect(bootstrap).toContain("process.env.PATH = trustedChildPath;");
      expect(bootstrap).toContain("await import(pathToFileURL(cliPath).href);");
      const harness = bootstrap.replace(
        "await import(pathToFileURL(cliPath).href);",
        'const { execFileSync } = await import("node:child_process"); const matches = execFileSync("where.exe", ["git.exe"], { encoding: "utf8" }).trim().split(/\\r?\\n/u); process.stdout.write(JSON.stringify({ path: process.env.PATH, git: matches[0] }));',
      );
      expect(harness).not.toBe(bootstrap);

      const pnpmCli = resolve(
        process.execPath,
        "..", "..", "node_modules/pnpm/bin/pnpm.cjs",
      );
      const trustedGit = "C:\\Program Files\\Git\\cmd\\git.exe";
      const trustedChildPath = [
        resolve(trustedGit, ".."),
        resolve(process.execPath, ".."),
        "C:\\Windows\\System32",
      ].join(";");
      const result = spawnSync(
        process.execPath,
        [
          pnpmCli, "exec", "--", process.execPath,
          "--input-type=module", "--eval", harness, "--",
          trustedChildPath, "C:\\fixture\\vercel\\dist\\index.js", "--version",
        ],
        { cwd: resolve("."), encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } },
      );
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout) as { path: string; git: string };
      expect(observed.path).toBe(trustedChildPath);
      expect(observed.path).not.toMatch(/(?:^|[\\/;])node_modules[\\/]\.bin(?:[\\/;]|$)/iu);
      expect(observed.git.toLowerCase()).toBe(trustedGit.toLowerCase());
    },
  );

  it.runIf(process.platform === "win32")(
    "executes the documented trusted Vercel function through PowerShell 5.1",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const bootstrapMatch = deploy.match(
        /\$TrustedVercelBootstrap = @'\r?\n([\s\S]*?)\r?\n'@/u,
      );
      const functionMatch = deploy.match(/function Invoke-TrustedVercel \{[\s\S]*?^\}/mu);
      expect(bootstrapMatch).not.toBeNull();
      expect(functionMatch).not.toBeNull();
      const bootstrap = bootstrapMatch?.[1] ?? "";
      const harness = bootstrap.replace(
        "await import(pathToFileURL(cliPath).href);",
        "const { execFileSync } = await import('node:child_process'); const matches = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\\r?\\n/u); process.stdout.write(JSON.stringify({ path: process.env.PATH, git: matches[0] }));",
      );
      expect(harness).not.toBe(bootstrap);

      const pnpmCli = resolve(
        process.execPath,
        "..", "..", "node_modules/pnpm/bin/pnpm.cjs",
      );
      const trustedGit = "C:\\Program Files\\Git\\cmd\\git.exe";
      const trustedChildPath = [
        resolve(trustedGit, ".."),
        resolve(process.execPath, ".."),
        "C:\\Windows\\System32",
      ].join(";");
      const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
      const program = [
        `$TrustedNode = '${quotePowerShell(process.execPath)}'`,
        `$TrustedCorepackScript = '${quotePowerShell(pnpmCli)}'`,
        `$TrustedChildPath = '${quotePowerShell(trustedChildPath)}'`,
        "$TrustedVercelCli = 'C:\\fixture\\vercel\\dist\\index.js'",
        "$TrustedVercelBootstrap = @'",
        harness,
        "'@",
        functionMatch?.[0] ?? "",
        "$Proof = @(Invoke-TrustedVercel --version)",
        "$ProofExitCode = $LASTEXITCODE",
        "if ($ProofExitCode -ne 0 -or $Proof.Count -ne 1) { throw 'TRUSTED_VERCEL_PS51_FAILED' }",
        "[Console]::Out.Write([string]$Proof[0])",
        "exit 0",
      ].join("\r\n");
      const powerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const result = spawnSync(
        powerShell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program],
        { cwd: resolve("."), encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } },
      );
      expect(result.status, result.stderr).toBe(0);
      const observed = JSON.parse(result.stdout) as { path: string; git: string };
      expect(observed.path).toBe(trustedChildPath);
      expect(observed.path).not.toMatch(/(?:^|[\\/;])node_modules[\\/]\.bin(?:[\\/;]|$)/iu);
      expect(observed.git.toLowerCase()).toBe(trustedGit.toLowerCase());
    },
  );

  it.runIf(process.platform === "win32")(
    "clears hostile Node execution authority before the first Node process",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const functionMatch = deploy.match(/function Reset-NodeEnvironmentAuthority \{[\s\S]*?^\}/mu);
      expect(functionMatch).not.toBeNull();
      for (const name of [
        "NODE_OPTIONS",
        "NODE_PATH",
        "NODE_REPL_EXTERNAL_MODULE",
        "NODE_EXTRA_CA_CERTS",
        "OPENSSL_CONF",
        "SSL_CERT_DIR",
        "SSL_CERT_FILE",
        "COREPACK_HOME",
        "COREPACK_NPM_REGISTRY",
        "COREPACK_INTEGRITY_KEYS",
        "npm_config_userconfig",
      ]) expect(functionMatch?.[0]).toContain(`'${name}'`);
      const reset = deploy.indexOf("\nReset-NodeEnvironmentAuthority\n");
      const runtimeGate = deploy.indexOf("\nAssert-TrustedRuntimeVersions\n", reset);
      expect(reset).toBeGreaterThan(-1);
      expect(runtimeGate).toBeGreaterThan(reset);
      expect(deploy.slice(reset, runtimeGate)).not.toContain("& $TrustedNode");

      const injectedModule = Buffer.from(
        'process.stdout.write("NODE_OPTIONS_INJECTED\\n")',
      ).toString("base64");
      const program = [
        functionMatch?.[0] ?? "",
        "Reset-NodeEnvironmentAuthority",
        "if ([Environment]::GetEnvironmentVariable('npm_config_userconfig', 'Process') -cne 'NUL' -or [Environment]::GetEnvironmentVariable('NPM_CONFIG_GLOBALCONFIG', 'Process') -cne 'NUL') { throw 'AMBIENT_NPM_CONFIG_NOT_REJECTED' }",
        `$NodeVersionOutput = @(& '${process.execPath.replaceAll("'", "''")}' --version)`,
        "$NodeExitCode = $LASTEXITCODE",
        "if ($NodeExitCode -ne 0 -or $NodeVersionOutput.Count -ne 1) { throw 'NODE_AUTHORITY_TEST_FAILED' }",
        "[Console]::Out.Write([string]$NodeVersionOutput[0])",
        "exit 0",
      ].join("\r\n");
      const result = spawnSync(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=data:text/javascript;base64,${injectedModule}`,
            NODE_PATH: "C:\\hostile-node-path",
            COREPACK_HOME: "C:\\hostile-corepack-home",
            npm_config_userconfig: "C:\\hostile-npmrc",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(process.version);
      expect(result.stdout).not.toContain("NODE_OPTIONS_INJECTED");
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects alternate Git repository and config environment injection",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const functionMatch = deploy.match(/function Reset-GitEnvironmentAuthority \{[\s\S]*?^\}/mu);
      expect(functionMatch).not.toBeNull();
      expect(functionMatch?.[0]).toContain("-like 'GIT_*'");
      expect(functionMatch?.[0]).toContain("GIT_CONFIG_NOSYSTEM");
      expect(functionMatch?.[0]).toContain("GIT_CONFIG_GLOBAL");
      expect(functionMatch?.[0]).toContain("GIT_TERMINAL_PROMPT");
      const reset = deploy.indexOf("\nReset-GitEnvironmentAuthority\n");
      expect(reset).toBeGreaterThan(-1);
      expect(deploy.indexOf("$ReviewedHead = Assert-ReviewedPushedHead")).toBeGreaterThan(reset);
      expect(deploy.indexOf("Invoke-TrustedVercel --version")).toBeGreaterThan(reset);

      const alternate = mkdtempSync(resolve(tmpdir(), "gustavo-git-env-"));
      const trustedGit = "C:\\Program Files\\Git\\cmd\\git.exe";
      try {
        const initialized = spawnSync(trustedGit, ["init", "--quiet", alternate], {
          encoding: "utf8",
        });
        expect(initialized.status, initialized.stderr).toBe(0);
        const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
        const program = [
          functionMatch?.[0] ?? "",
          "Reset-GitEnvironmentAuthority",
          `$Root = (& '${quotePowerShell(trustedGit)}' rev-parse --show-toplevel).Trim()`,
          "$RootExitCode = $LASTEXITCODE",
          "if ($RootExitCode -ne 0) { throw 'GIT_ROOT_AUTHORITY_TEST_FAILED' }",
          `$InjectedConfig = @(& '${quotePowerShell(trustedGit)}' config --get test.stageBInjected)`,
          "$InjectedConfigExitCode = $LASTEXITCODE",
          "if ($InjectedConfigExitCode -eq 0 -or $InjectedConfig.Count -ne 0) { throw 'GIT_CONFIG_AUTHORITY_TEST_FAILED' }",
          "[Console]::Out.Write($Root)",
          "exit 0",
        ].join("\r\n");
        const result = spawnSync(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program],
          {
            cwd: resolve("."),
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_DIR: resolve(alternate, ".git"),
              GIT_WORK_TREE: alternate,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "test.stageBInjected",
              GIT_CONFIG_VALUE_0: "yes",
            },
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.replaceAll("/", "\\").toLowerCase())
          .toBe(resolve(".").replaceAll("/", "\\").toLowerCase());
      } finally {
        expect(alternate.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())).toBe(true);
        rmSync(alternate, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "clears every ambient pnpm and npm config variable before trusted pnpm",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const functionMatch = deploy.match(/function Reset-NodeEnvironmentAuthority \{[\s\S]*?^\}/mu);
      expect(functionMatch).not.toBeNull();
      const pnpmCli = resolve(
        process.execPath,
        "..", "..", "node_modules/pnpm/bin/pnpm.cjs",
      );
      const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
      const program = [
        `$TrustedNode = '${quotePowerShell(process.execPath)}'`,
        `$TrustedPnpmCli = '${quotePowerShell(pnpmCli)}'`,
        functionMatch?.[0] ?? "",
        "Reset-NodeEnvironmentAuthority",
        "$ScriptShellOutput = @(& $TrustedNode $TrustedPnpmCli config get script-shell)",
        "$ScriptShellExitCode = $LASTEXITCODE",
        "if ($ScriptShellExitCode -ne 0 -or $ScriptShellOutput.Count -ne 1 -or [string]$ScriptShellOutput[0] -cne 'undefined') { throw 'PNPM_SCRIPT_SHELL_INJECTION_SURVIVED' }",
        "$PnpmfileOutput = @(& $TrustedNode $TrustedPnpmCli config get pnpmfile)",
        "$PnpmfileExitCode = $LASTEXITCODE",
        "if ($PnpmfileExitCode -ne 0 -or $PnpmfileOutput.Count -ne 1 -or [string]$PnpmfileOutput[0] -cne 'undefined') { throw 'PNPMFILE_INJECTION_SURVIVED' }",
        "[Console]::Out.Write('PACKAGE_CONFIG_AUTHORITY_OK')",
        "exit 0",
      ].join("\r\n");
      const result = spawnSync(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program],
        {
          cwd: resolve("."),
          encoding: "utf8",
          env: {
            ...process.env,
            PNPM_CONFIG_PNPMFILE: "C:\\hostile-pnpmfile.cjs",
            PNPM_CONFIG_SCRIPT_SHELL: "C:\\hostile-pnpm-shell.exe",
            NPM_CONFIG_SCRIPT_SHELL: "C:\\hostile-npm-shell.exe",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("PACKAGE_CONFIG_AUTHORITY_OK");

      const resetFunction = functionMatch?.[0] ?? "";
      const pnpmReset = resetFunction.indexOf("-ilike 'PNPM_CONFIG_*'");
      const npmReset = resetFunction.indexOf("-ilike 'NPM_CONFIG_*'");
      const controlled = resetFunction.indexOf("$ControlledPackageConfig");
      expect(pnpmReset).toBeGreaterThan(-1);
      expect(npmReset).toBeGreaterThan(-1);
      expect(controlled).toBeGreaterThan(pnpmReset);
      expect(controlled).toBeGreaterThan(npmReset);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when pnpm store content integrity is not clean",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const functionMatch = deploy.match(/function Assert-TrustedPnpmStoreIntegrity \{[\s\S]*?^\}/mu);
      expect(functionMatch).not.toBeNull();
      expect(functionMatch?.[0]).toContain("pnpm store status");
      expect(functionMatch?.[0]).toContain("PNPM_STORE_INTEGRITY_FAILED");
      const install = deploy.indexOf("pnpm install --frozen-lockfile");
      const reviewed = deploy.indexOf("$ReviewedHead = Assert-ReviewedPushedHead");
      const store = deploy.indexOf("Assert-TrustedPnpmStoreIntegrity", install);
      const cli = deploy.indexOf("$VercelLinkPath =", store);
      expect(reviewed).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(reviewed);
      expect(store).toBeGreaterThan(install);
      expect(cli).toBeGreaterThan(store);

      const fixture = mkdtempSync(resolve(tmpdir(), "gustavo-store-status-"));
      try {
        const failingCorepack = resolve(fixture, "corepack-failure.cjs");
        writeFileSync(failingCorepack, "process.exitCode = 23;\n", "utf8");
        const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
        const program = [
          `$TrustedNode = '${quotePowerShell(process.execPath)}'`,
          `$TrustedCorepackScript = '${quotePowerShell(failingCorepack)}'`,
          functionMatch?.[0] ?? "",
          "Assert-TrustedPnpmStoreIntegrity",
          "[Console]::Out.Write('UNEXPECTED_STORE_ACCEPTANCE')",
          "exit 0",
        ].join("\r\n");
        const result = spawnSync(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program],
          { cwd: resolve("."), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("PNPM_STORE_INTEGRITY_FAILED");
        expect(result.stdout).not.toContain("UNEXPECTED_STORE_ACCEPTANCE");
      } finally {
        expect(fixture.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase())).toBe(true);
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "enforces exact approved Node and pnpm runtime versions through PowerShell 5.1",
    () => {
      const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
      const functionMatch = deploy.match(/function Assert-TrustedRuntimeVersions \{[\s\S]*?^\}/mu);
      expect(functionMatch).not.toBeNull();
      expect(functionMatch?.[0]).toContain("-cne 'v24.19.0'");
      expect(functionMatch?.[0]).toContain("-cne '11.16.0'");
      expect(deploy).toContain("The current Program Files Node 22 installation is not authority");
      const pnpmCli = resolve(
        process.execPath,
        "..", "..", "node_modules/pnpm/bin/pnpm.cjs",
      );
      const quotePowerShell = (value: string): string => value.replaceAll("'", "''");
      const program = [
        `$TrustedNode = '${quotePowerShell(process.execPath)}'`,
        `$TrustedCorepackScript = '${quotePowerShell(pnpmCli)}'`,
        functionMatch?.[0] ?? "",
        "Assert-TrustedRuntimeVersions",
        "[Console]::Out.Write('TRUSTED_RUNTIME_VERSIONS_OK')",
        "exit 0",
      ].join("\r\n");
      const result = spawnSync(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", program],
        { cwd: resolve("."), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("TRUSTED_RUNTIME_VERSIONS_OK");
    },
  );

  it("requires fail-closed scheduled-task and worker proof after start", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    const start = deploy.indexOf(
      "Start-ScheduledTask -TaskPath '\\' -TaskName 'Gustavo Hybrid Worker' -ErrorAction Stop",
    );
    const task = deploy.indexOf(
      "Get-ScheduledTask -TaskPath '\\' -TaskName 'Gustavo Hybrid Worker' -ErrorAction Stop",
      start,
    );
    const taskInfo = deploy.indexOf(
      "Get-ScheduledTaskInfo -TaskPath '\\' -TaskName 'Gustavo Hybrid Worker' -ErrorAction Stop",
      task,
    );
    const validation = deploy.indexOf(
      "scripts/start-hybrid-worker.ps1 -ValidateOnly",
      taskInfo,
    );
    const marker = deploy.indexOf("HYBRID_WORKER_VALIDATION_COMPLETE", validation);
    const readiness = deploy.indexOf("authenticated operator health proves", marker);
    expect(start).toBeGreaterThan(-1);
    expect(task).toBeGreaterThan(start);
    expect(taskInfo).toBeGreaterThan(task);
    expect(validation).toBeGreaterThan(taskInfo);
    expect(marker).toBeGreaterThan(validation);
    expect(readiness).toBeGreaterThan(marker);
    expect(deploy.slice(start, readiness)).toContain("$StartedTask.State -cne 'Running'");
    expect(deploy.slice(start, readiness)).toContain("POST_START_WORKER_PROOF_FAILED");
  });

  it("keeps the reviewed head immutable across uploads and rollback review", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    for (const [head, output] of [
      ["PreviewHead", "PreviewDeployOutput"],
      ["StagedHead", "StagedProductionDeployOutput"],
      ["BridgeDisabledHead", "BridgeDisabledDeployOutput"],
    ]) {
      expect(deploy).toMatch(new RegExp(
        `\\$${head} = Assert-ReviewedPushedHead\\r?\\n`
        + `if \\(\\$${head} -cne \\$ReviewedHead\\) \\{ throw 'REVIEWED_HEAD_CHANGED' \\}\\r?\\n`
        + `\\$${output} =`,
      ));
    }

    const priorCheckout = deploy.indexOf("Otherwise check out the exact reviewed previous");
    expect(priorCheckout).toBeGreaterThan(-1);
    const priorAuthority = deploy.slice(priorCheckout);
    const approved = priorAuthority.indexOf("$ApprovedRollbackHead = Read-Host");
    const validated = priorAuthority.indexOf("$ApprovedRollbackHead -cnotmatch '^[a-f0-9]{40}$'", approved);
    const observed = priorAuthority.indexOf("$ObservedRollbackHead = Assert-ReviewedPushedHead", validated);
    const equality = priorAuthority.indexOf("$ObservedRollbackHead -cne $ApprovedRollbackHead", observed);
    const immutable = priorAuthority.indexOf("$ReviewedHead = $ApprovedRollbackHead", equality);
    expect(approved).toBeGreaterThan(-1);
    expect(validated).toBeGreaterThan(approved);
    expect(observed).toBeGreaterThan(validated);
    expect(equality).toBeGreaterThan(observed);
    expect(immutable).toBeGreaterThan(equality);
    expect(priorAuthority).not.toContain("$ReviewedHead = Assert-ReviewedPushedHead");
  });

  it("uses the reviewed PowerShell 5.1 maintenance stop and bans forceful operator cleanup", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    const operations = readFileSync("docs/OPERATIONS.md", "utf8");
    const smoke = readFileSync("docs/SMOKE_TEST.md", "utf8");
    const combined = [deploy, operations, smoke].join("\n");
    expect(combined).toContain("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(combined).not.toContain("PowerShell\\7\\pwsh.exe");
    expect(deploy).toContain("scripts/start-hybrid-worker.ps1 -StopForMaintenance");
    expect(deploy).toContain("HYBRID_WORKER_MAINTENANCE_STOPPED");
    expect(deploy).not.toMatch(/Stop-ScheduledTask|taskkill|TerminateProcess/iu);
    expect(deploy).not.toMatch(/&\s*\$TrustedTailscale\s+funnel|^\s*docker\s+(?:kill|rm)\b/imu);
  });

  it("checks each Vercel deployment authority and canonicalizes one URL", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    expect(deploy).toMatch(/function Assert-SingleCanonicalDeploymentUrl[\s\S]*?Count -ne 1[\s\S]*?^\}/mu);
    for (const prefix of ["Preview", "StagedProduction", "BridgeDisabled"]) {
      expect(deploy).toContain(`$${prefix}DeployExitCode = $LASTEXITCODE`);
      expect(deploy).toContain(`$${prefix}Url = Assert-SingleCanonicalDeploymentUrl`);
      expect(deploy).toContain(`$${prefix}InspectExitCode = $LASTEXITCODE`);
    }
    for (const prefix of ["StagedProduction", "BridgeDisabled"]) {
      expect(deploy).toContain(`$${prefix}PromoteExitCode = $LASTEXITCODE`);
    }
    expect(deploy).toMatch(/\$PreviewHead = Assert-ReviewedPushedHead\r?\nif \(\$PreviewHead -cne \$ReviewedHead\) \{ throw 'REVIEWED_HEAD_CHANGED' \}\r?\n\$PreviewDeployOutput = @\(Invoke-TrustedVercel deploy\)/u);
    expect(deploy).toMatch(/\$StagedHead = Assert-ReviewedPushedHead\r?\nif \(\$StagedHead -cne \$ReviewedHead\) \{ throw 'REVIEWED_HEAD_CHANGED' \}\r?\n\$StagedProductionDeployOutput = @\(Invoke-TrustedVercel --prod --skip-domain\)/u);
    expect(deploy).toMatch(/\$BridgeDisabledHead = Assert-ReviewedPushedHead\r?\nif \(\$BridgeDisabledHead -cne \$ReviewedHead\) \{ throw 'REVIEWED_HEAD_CHANGED' \}\r?\n\$BridgeDisabledDeployOutput = @\(Invoke-TrustedVercel --prod --skip-domain\)/u);
  });

  it("proves inspected deployment source and preserves it across promotion", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    expect(deploy).toContain("Vercel CLI 58.4.0 omits `meta` from `inspect --json`");
    expect(deploy).toMatch(/function ConvertFrom-StrictJsonObject[\s\S]*?ConvertFrom-Json -InputObject \$JsonText -ErrorAction Stop[\s\S]*?^\}/mu);
    const inspectionHelper = deploy.match(/function Assert-DeploymentInspection[\s\S]*?^\}/mu)?.[0];
    expect(inspectionHelper).toBeDefined();
    expect(inspectionHelper).toContain("$Inspection.readyState -cne 'READY'");
    expect(inspectionHelper).toContain("$Inspection.id -cnotmatch '^dpl_[A-Za-z0-9]+$'");
    expect(inspectionHelper).toContain("$Inspection.url -cne $ExpectedHost");
    const sourceHelper = deploy.match(/function Assert-DeploymentSource[\s\S]*?^\}/mu)?.[0];
    expect(sourceHelper).toBeDefined();
    expect(sourceHelper).toContain("projectId");
    expect(sourceHelper).toContain("prj_HoIxQexO64tsgXrNI6m89g3P87TB");
    expect(sourceHelper).toContain("ownerId");
    expect(sourceHelper).toContain("team_2ZsWunVLuTIHx2h2zmWEAvAH");
    expect(sourceHelper).toContain("meta.githubCommitSha");
    expect(sourceHelper).toContain("-cne $ExpectedHead");

    for (const prefix of ["Preview", "StagedProduction", "BridgeDisabled"]) {
      expect(deploy).toContain(`Invoke-TrustedVercel inspect $${prefix}Url --json`);
      expect(deploy).toContain(`$${prefix}Inspection = Assert-DeploymentInspection`);
      expect(deploy).toContain(`Invoke-TrustedVercel api "/v13/deployments/$($${prefix}Inspection.id)" --raw`);
      expect(deploy).toContain(`$${prefix}Source = Assert-DeploymentSource`);
      const head = prefix === "Preview" ? "PreviewHead"
        : prefix === "StagedProduction" ? "StagedHead" : "BridgeDisabledHead";
      expect(deploy).toContain(`$${prefix}Inspection $${head}`);
    }
    expect(deploy).toContain("$PromotedStagedProductionInspection.id -cne $StagedProductionInspection.id");
    expect(deploy).toContain("$PromotedStagedProductionSource.meta.githubCommitSha -cne $StagedProductionSource.meta.githubCommitSha");
    expect(deploy).toContain("$PromotedBridgeDisabledInspection.id -cne $BridgeDisabledInspection.id");
    expect(deploy).toContain("$PromotedBridgeDisabledSource.meta.githubCommitSha -cne $BridgeDisabledSource.meta.githubCommitSha");
  });

  it("fails closed on every critical native child before the next mutation", () => {
    const deploy = readFileSync("docs/VERCEL_DEPLOYMENT.md", "utf8");
    for (const exitVariable of [
      "NodeVersionExitCode",
      "PnpmVersionExitCode",
      "InstallExitCode",
      "StoreStatusExitCode",
      "VercelVersionExitCode",
      "LinkExitCode",
      "ProjectInspectExitCode",
      "PreviewWakeEnvExitCode",
      "ProductionWakeEnvExitCode",
      "PreviewSourceExitCode",
      "StagedProductionSourceExitCode",
      "PromotedStagedProductionInspectExitCode",
      "PromotedStagedProductionSourceExitCode",
      "BridgeDisabledSourceExitCode",
      "PromotedBridgeDisabledInspectExitCode",
      "PromotedBridgeDisabledSourceExitCode",
      "MigrationExitCode",
      "BackupCreateExitCode",
      "BackupVerifyExitCode",
      "BootstrapExitCode",
      "SetupExitCode",
      "ValidateStartExitCode",
      "PostStartValidationExitCode",
      "MaintenanceRebuildExitCode",
      "MaintenanceRotateExitCode",
    ]) {
      expect(deploy).toContain(`$${exitVariable} = $LASTEXITCODE`);
      expect(deploy).toMatch(new RegExp(`if \\\(\\$${exitVariable} -ne 0[^)]*\\\) \\\{`));
    }
  });
});

describe("hybrid operator health", () => {
  it("separates hosted and local components with durable bounded quota state", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY" },
      heartbeats: [
        { component: "CODEX", observedAt: "2026-08-13T12:00:00.000Z", safeCode: null },
        { component: "MARKET", observedAt: "2026-08-13T11:55:00.000Z", safeCode: "RATE_LIMITED" },
        { component: "TUNNEL", observedAt: "2026-08-13T12:00:00.000Z", safeCode: null },
      ],
      quotas: [
        { name: "CODEX_JOBS", used: 4, limit: 100 },
        { name: "QSTASH_MESSAGES", used: 20, limit: 900 },
        { name: "FINNHUB_CALLS", used: 96, limit: 96 },
      ],
      pendingJobs: 2,
      now: new Date("2026-08-13T12:01:00.000Z"),
    });

    expect(dto).toMatchObject({
      hosted: { database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY" },
      local: { codex: "AVAILABLE", market: "DEGRADED", tunnel: "AVAILABLE" },
      bridge: { pendingJobs: 2 },
    });
    expect(JSON.stringify(dto)).not.toMatch(/hostname|url|prompt|price|token|ciphertext|providerKey/i);
  });

  it("uses the database-clock 12-minute CODEX lease and rejects future heartbeats", async () => {
    const atBoundary = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T11:48:00.000Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const stale = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T11:47:59.999Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const future = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T12:00:00.001Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });

    expect(HYBRID_HEALTH_POLICY.codexLeaseSeconds).toBe(12 * 60);
    expect(atBoundary.local.codex).toBe("AVAILABLE");
    expect(atBoundary.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 720, safeCode: null });
    expect(stale.local.codex).toBe("OFFLINE");
    expect(future.local.codex).toBe("OFFLINE");
    expect(future.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 0, safeCode: "WORKER_OFFLINE" });
  });

  it("lets the fixed current-UTC CODEX quota override a fresh heartbeat", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{
        component: "CODEX",
        status: "HEALTHY",
        observedAt: "2026-08-13T12:00:00.000Z",
        safeCode: null,
      }],
      quotas: [{ name: "CODEX_JOBS", used: 100, limit: 100 }],
      pendingJobs: 1,
      now: new Date("2026-08-13T12:01:00.000Z"),
    });

    expect(dto.local.codex).toBe("DEGRADED");
    expect(dto.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ safeCode: "QUOTA_EXHAUSTED" });
    expect(dto.quotas).toContainEqual({
      name: "CODEX_JOBS",
      used: 100,
      limit: 100,
      exhausted: true,
    });
  });

  it("reads only fixed durable rows with database time and current UTC quotas", async () => {
    const queries: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [
          { component: "CODEX", heartbeat_status: "HEALTHY", safe_code: null,
            age_seconds: 60, codex_lease_healthy: true,
            quota_name: "CODEX_JOBS", used: 100, quota_limit: 100, pending_jobs: 2 },
          { component: "MARKET", heartbeat_status: "DEGRADED", safe_code: "RATE_LIMITED",
            age_seconds: 360, codex_lease_healthy: null,
            quota_name: "QSTASH_MESSAGES", used: 20, quota_limit: 900, pending_jobs: 2 },
          { component: "TUNNEL", heartbeat_status: "HEALTHY", safe_code: null,
            age_seconds: 60, codex_lease_healthy: null,
            quota_name: "FINNHUB_CALLS", used: 96, quota_limit: 27_648, pending_jobs: 2 },
        ];
      }),
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_SPLIT_READ"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "DEGRADED", stream: "HEALTHY",
    });

    expect(dto).toMatchObject({
      local: { codex: "DEGRADED" },
      bridge: { pendingJobs: 2 },
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/hybrid_worker_heartbeats[\s\S]*deployment_quota_counters/iu);
    expect(queries[0]).toMatch(/status='PENDING'[\s\S]*status='CLAIMED'/iu);
    expect(db.one).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("uses one materialized database clock across a UTC quota rollover", async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes("database_clock as materialized")) {
        throw new Error("HYBRID_HEALTH_DATABASE_CLOCK_NOT_COHERENT");
      }
      return [
        { component: "CODEX", heartbeat_status: "HEALTHY", safe_code: null,
          age_seconds: 1, codex_lease_healthy: true,
          quota_name: "CODEX_JOBS", used: 100, quota_limit: 100, pending_jobs: 0 },
        { component: "MARKET", heartbeat_status: "HEALTHY", safe_code: null,
          age_seconds: 1, codex_lease_healthy: null,
          quota_name: "QSTASH_MESSAGES", used: 0, quota_limit: 900, pending_jobs: 0 },
        { component: "TUNNEL", heartbeat_status: "HEALTHY", safe_code: null,
          age_seconds: 1, codex_lease_healthy: null,
          quota_name: "FINNHUB_CALLS", used: 0, quota_limit: 27_648, pending_jobs: 0 },
      ];
    });
    const db = {
      query,
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_SPLIT_CLOCK_READ"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";

    expect(query).toHaveBeenCalledOnce();
    expect(dto.local.codex).toBe("DEGRADED");
    expect(dto.quotas.find(({ name }) => name === "CODEX_JOBS"))
      .toMatchObject({ used: 100, limit: 100, exhausted: true });
    expect(sql).toMatch(/with database_clock as materialized\s*\(\s*select clock_timestamp\(\) observed_now/iu);
    expect(sql).toMatch(/bucket_date\s*=\s*\(database_clock\.observed_now at time zone 'UTC'\)::date/iu);
    expect(db.one).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("keeps the PostgreSQL microsecond CODEX lease decision authoritative", async () => {
    const roundedByJavaScript = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY" },
      heartbeats: [{ component: "CODEX", status: "HEALTHY",
        observedAt: "2026-08-13T11:48:00.000Z", safeCode: null }],
      quotas: [{ name: "CODEX_JOBS", used: 99, limit: 100 }],
      pendingJobs: 0,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    expect(roundedByJavaScript.local.codex).toBe("AVAILABLE");

    const query = vi.fn(async (_sql: string, _parameters?: readonly unknown[]) => [
      { component: "CODEX", heartbeat_status: "HEALTHY", safe_code: null,
        age_seconds: 720, codex_lease_healthy: false,
        quota_name: "CODEX_JOBS", used: 99, quota_limit: 100, pending_jobs: 0 },
      { component: "MARKET", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "QSTASH_MESSAGES", used: 0, quota_limit: 900, pending_jobs: 0 },
      { component: "TUNNEL", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "FINNHUB_CALLS", used: 0, quota_limit: 27_648, pending_jobs: 0 },
    ]);
    const db = {
      query,
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_JAVASCRIPT_CLOCK_USED"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";
    const parameters = query.mock.calls[0]?.[1] ?? [];

    expect(dto.local.codex).toBe("OFFLINE");
    expect(dto.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 720, safeCode: "WORKER_OFFLINE" });
    expect(parameters.slice(0, 2)).toEqual([
      HYBRID_HEALTH_POLICY.codexLeaseSeconds,
      HYBRID_HEALTH_POLICY.maximumHeartbeatAgeSeconds,
    ]);
    expect(sql).toMatch(/observed_at between\s+database_clock\.observed_now\s*-\s*make_interval\(secs => \$1::double precision\)\s+and database_clock\.observed_now/isu);
    expect(sql).toMatch(/extract\(epoch from\s+\(database_clock\.observed_now-heartbeat\.observed_at\)\)/iu);
    expect(db.one).not.toHaveBeenCalled();
  });

  it("bounds the pending scan at maximumPendingJobs plus one before counting", async () => {
    const query = vi.fn(async (_sql: string, _parameters?: readonly unknown[]) => [
      { component: "CODEX", heartbeat_status: "OFFLINE", safe_code: "WORKER_OFFLINE",
        age_seconds: 1, codex_lease_healthy: false,
        quota_name: "CODEX_JOBS", used: 0, quota_limit: 100, pending_jobs: 10_001 },
      { component: "MARKET", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "QSTASH_MESSAGES", used: 0, quota_limit: 900, pending_jobs: 10_001 },
      { component: "TUNNEL", heartbeat_status: null, safe_code: null,
        age_seconds: null, codex_lease_healthy: null,
        quota_name: "FINNHUB_CALLS", used: 0, quota_limit: 27_648, pending_jobs: 10_001 },
    ]);
    const db = {
      query,
      one: vi.fn(async () => { throw new Error("HYBRID_HEALTH_UNBOUNDED_PENDING_READ"); }),
      transaction: vi.fn(),
    } as unknown as EventDatabase;

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";
    const parameters = query.mock.calls[0]?.[1] ?? [];
    const scanLimit = HYBRID_HEALTH_POLICY.maximumPendingJobs + 1;

    expect(dto.bridge.pendingJobs).toBe(HYBRID_HEALTH_POLICY.maximumPendingJobs);
    expect(parameters[2]).toBe(scanLimit);
    expect(sql).toMatch(/bounded_pending as materialized[\s\S]*limit \$3[\s\S]*count\(\*\)/iu);
    expect(sql).not.toMatch(/select count\(\*\)::text pending_jobs\s+from bridge_model_jobs/iu);
    expect(query).toHaveBeenCalledOnce();
    expect(db.one).not.toHaveBeenCalled();
  });

  it("executes the coherent health authority against PostgreSQL microsecond timestamps", async () => {
    const { db } = await testContext();
    await db.query(
      `insert into hybrid_worker_heartbeats (component,status,safe_code)
       values ('CODEX','HEALTHY',null)`,
    );
    await db.query(
      "alter table hybrid_worker_heartbeats disable trigger hybrid_worker_heartbeats_are_bounded",
    );
    try {
      await db.query(
        `update hybrid_worker_heartbeats
            set observed_at=clock_timestamp()-interval '12 minutes 0.0001 seconds',
                updated_at=clock_timestamp()
          where component='CODEX'`,
      );
    } finally {
      await db.query(
        "alter table hybrid_worker_heartbeats enable trigger hybrid_worker_heartbeats_are_bounded",
      );
    }
    await db.query(
      `insert into deployment_quota_counters
         (quota_name,bucket_date,used_count,limit_count)
       values ('CODEX_JOBS',(clock_timestamp() at time zone 'UTC')::date,99,100)`,
    );

    const dto = await collectHybridHealth(db, {
      database: "HEALTHY", cache: "HEALTHY", stream: "HEALTHY",
    });

    expect(dto.local.codex).toBe("OFFLINE");
    expect(dto.components.find(({ component }) => component === "CODEX"))
      .toMatchObject({ ageSeconds: 720, safeCode: "WORKER_OFFLINE" });
    expect(dto.quotas.find(({ name }) => name === "CODEX_JOBS"))
      .toMatchObject({ used: 99, limit: 100, exhausted: false });
    expect(dto.bridge.pendingJobs).toBe(0);
  }, 20_000);

  it("returns a fixed bounded DTO and drops every sensitive or identifying input field", async () => {
    const dto = await projectHybridHealth({
      hosted: { database: "HEALTHY", cache: "HEALTHY", stream: "DEGRADED" },
      heartbeats: [{
        component: "CODEX",
        status: "DEGRADED",
        observedAt: "2026-08-13T11:59:59.999Z",
        safeCode: "PROVIDER_UNAVAILABLE",
        hostname: "private-host-canary",
        url: "https://private-funnel.invalid",
        prompt: "private-prompt-canary",
        price: "123.45",
        token: "private-token-canary",
        ciphertext: "private-ciphertext-canary",
        providerKey: "private-provider-key-canary",
        containerId: "private-container-canary",
        imageDigest: "private-image-canary",
        volumeName: "private-volume-canary",
        accountId: "private-account-canary",
        jobId: "private-job-canary",
      } as never],
      quotas: [{
        name: "CODEX_JOBS", used: 4, limit: 100, providerAccountId: "private-provider-account",
      } as never],
      pendingJobs: Number.MAX_SAFE_INTEGER,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const serialized = JSON.stringify(dto);

    expect(dto.bridge.pendingJobs).toBe(HYBRID_HEALTH_POLICY.maximumPendingJobs);
    expect(dto.components).toHaveLength(3);
    expect(dto.quotas).toHaveLength(3);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(4 * 1024);
    expect(serialized).not.toMatch(
      /private-|hostname|https?:|prompt|price|token|ciphertext|providerKey|containerId|imageDigest|volumeName|accountId|jobId/iu,
    );
  });

  it("authenticates before protected reads and keeps private generic bounded failures", async () => {
    const resolveDatabase = vi.fn(() => ({ marker: "private-db" }) as never);
    const collect = vi.fn(async () => ({ privateState: "never-returned" }) as never);
    const handler = createOperatorHealthHandler({
      resolveDatabase,
      token: "operator-health-token-that-is-at-least-32-bytes",
      collect,
    });

    const denied = await handler(new Request("http://localhost/api/operator/health"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await denied.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(resolveDatabase).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();

    const failing = createOperatorHealthHandler({
      resolveDatabase: vi.fn(() => { throw new Error("private-host-canary"); }),
      token: "operator-health-token-that-is-at-least-32-bytes",
    });
    const unavailable = await failing(new Request("http://localhost/api/operator/health", {
      headers: { authorization: "Bearer operator-health-token-that-is-at-least-32-bytes" },
    }));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(await unavailable.json()).toEqual({ error: "OPERATOR_HEALTH_UNAVAILABLE" });

    const oversized = createOperatorHealthHandler({
      resolveDatabase,
      token: "operator-health-token-that-is-at-least-32-bytes",
      collect: vi.fn(async () => ({ payload: "x".repeat(70 * 1024) }) as never),
    });
    const bounded = await oversized(new Request("http://localhost/api/operator/health", {
      headers: { authorization: "Bearer operator-health-token-that-is-at-least-32-bytes" },
    }));
    expect(bounded.status).toBe(503);
    expect(Number(bounded.headers.get("content-length"))).toBeLessThan(1024);
    expect(await bounded.json()).toEqual({ error: "OPERATOR_HEALTH_RESPONSE_TOO_LARGE" });
  });
});

describe("production migrations", () => {
  it("takes one advisory lock and applies each ordered migration once", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("select name, checksum_sha256")
        ? [{
          name: "0001_events.sql",
          checksum_sha256: createHash("sha256")
            .update("-- 0001_events.sql", "utf8")
            .digest("hex"),
        }]
        : [],
    }));

    const result = await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_event_metadata.sql"],
      readMigration: (name) => `-- ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    expect(query.mock.calls[0]?.[0]).toBe("begin");
    expect(query.mock.calls[1]?.[0]).toContain("pg_advisory_xact_lock");
    expect(result).toEqual({ applied: ["0002_event_metadata.sql"], skipped: ["0001_events.sql"] });
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("replays recorded checksums and rejects changed migration contents", async () => {
    const ledger = new Map<string, string>();
    const appliedSql: string[] = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes("select name, checksum_sha256")) {
        return {
          rows: [...ledger].map(([name, checksum_sha256]) => ({
            name,
            checksum_sha256,
          })),
        };
      }
      if (sql.includes("insert into") && values.length === 2) {
        ledger.set(String(values[0]), String(values[1]));
      }
      if (sql.startsWith("-- migration ")) appliedSql.push(sql);
      return { rows: [] };
    });
    let changed = false;
    const run = () => runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0002_event_metadata.sql", "0001_events.sql"],
      readMigration: (name: string) => [
        `-- migration ${name}`,
        changed && name === "0002_event_metadata.sql" ? "-- changed" : "",
      ].filter(Boolean).join("\n"),
      withClient: async (work) => work({ query } as never),
    });

    await expect(run()).resolves.toEqual({
      applied: ["0001_events.sql", "0002_event_metadata.sql"],
      skipped: [],
    });
    await expect(run()).resolves.toEqual({
      applied: [],
      skipped: ["0001_events.sql", "0002_event_metadata.sql"],
    });
    expect(appliedSql).toEqual([
      "-- migration 0001_events.sql",
      "-- migration 0002_event_metadata.sql",
    ]);
    const transactionCalls = query.mock.calls.map(([sql]) => sql);
    expect(transactionCalls.filter((sql) => sql === "begin")).toHaveLength(2);
    expect(transactionCalls.filter((sql) => sql === "commit")).toHaveLength(2);

    changed = true;
    await expect(run())
      .rejects.toThrow("MIGRATION_CHECKSUM_CHANGED:0002_event_metadata.sql");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(query.mock.calls[1]?.[0]).toContain("gustavo:production-migrations:v1");
  });

  it("rejects a ledger row without its durable checksum", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("select name, checksum_sha256")
        ? [{ name: "0001_events.sql" }]
        : [],
    }));

    await expect(runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql"],
      readMigration: (name) => `-- ${name}`,
      withClient: async (work) => work({ query } as never),
    })).rejects.toThrow("MIGRATION_LEDGER_INVALID:0001_events.sql");
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("holds one transaction-scoped advisory lock across the complete batch", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_identity.sql"],
      readMigration: (name) => `-- migration ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    const sql = query.mock.calls.map(([statement]) => statement);
    const beginIndex = sql.indexOf("begin");
    const lockIndex = sql.findIndex((statement) => statement.includes(
      "pg_advisory_xact_lock(hashtextextended('gustavo:production-migrations:v1', 0))",
    ));
    const commitIndex = sql.indexOf("commit");
    expect(sql.filter((statement) => statement === "begin")).toHaveLength(1);
    expect(lockIndex).toBe(beginIndex + 1);
    expect(sql.filter((statement) => statement === "commit")).toHaveLength(1);
    expect(sql.filter((statement) => statement.includes("-- migration ")))
      .toHaveLength(2);
    expect(sql.slice(lockIndex + 1, commitIndex).filter((statement) => statement
      .includes("insert into schema_migrations"))).toHaveLength(2);
    expect(sql.join("\n")).not.toMatch(/pg_advisory_lock\(|pg_advisory_unlock\(/u);
  });

  it("shares the checksum-aware schema ledger used by backup and restore", async () => {
    const backup = readFileSync("infra/backup/create.ps1", "utf8");
    const restore = readFileSync("infra/backup/restore-drill.ps1", "utf8");
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql"],
      readMigration: (name) => `-- migration ${name}`,
      withClient: async (work) => work({ query } as never),
    });

    expect(backup).toContain("from schema_migrations");
    expect(restore).toContain("from schema_migrations");
    const sql = query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("create table if not exists schema_migrations");
    expect(sql).toContain("alter table schema_migrations add column if not exists checksum_sha256 char(64)");
    expect(sql).toContain("select name, checksum_sha256");
    expect(sql).toContain("insert into schema_migrations");
    expect(sql).not.toContain("production_migration_ledger");
  });

  it("hashes and executes one canonical LF form across checkout line endings", async () => {
    const inspect = async (migrationSql: string) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      await runProductionMigrations({
        databaseUrl: "postgresql://example.invalid/db",
        migrationFiles: ["0001_events.sql"],
        readMigration: () => migrationSql,
        withClient: async (work) => work({ query } as never),
      });
      const insert = query.mock.calls.find(([statement]) => statement
        .includes("insert into"));
      const executed = query.mock.calls.find(([statement]) => statement.startsWith("select 1;"));
      return {
        checksum: insert?.[1]?.[1],
        sql: executed?.[0],
      };
    };

    const forms = await Promise.all([
      inspect("select 1;\nselect 2;\n"),
      inspect("select 1;\r\nselect 2;\r\n"),
      inspect("select 1;\rselect 2;\r"),
    ]);
    expect(new Set(forms.map(({ checksum }) => checksum)).size).toBe(1);
    expect(forms[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(forms.map(({ sql }) => sql)).toEqual([
      "select 1;\nselect 2;\n",
      "select 1;\nselect 2;\n",
      "select 1;\nselect 2;\n",
    ]);
  });

  it("rolls back the whole batch when a later migration fails", async () => {
    let transaction: string[] | null = null;
    const durableLedger: string[] = [];
    let commits = 0;
    let rollbacks = 0;
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql === "begin") {
        transaction = [];
      } else if (sql === "commit") {
        commits += 1;
        durableLedger.push(...(transaction ?? []));
        transaction = null;
      } else if (sql === "rollback") {
        rollbacks += 1;
        transaction = null;
      } else if (sql.includes("select filename, checksum_sha256")
          || sql.includes("select name, checksum_sha256")) {
        return { rows: [] };
      } else if (sql.includes("insert into") && values.length === 2) {
        transaction?.push(String(values[0]));
      } else if (sql === "-- migration two") {
        throw new Error("MIGRATION_TWO_FAILED");
      }
      return { rows: [] };
    });

    await expect(runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql", "0002_identity.sql"],
      readMigration: (name) => name.startsWith("0001")
        ? "-- migration one"
        : "-- migration two",
      withClient: async (work) => work({ query } as never),
    })).rejects.toThrow("MIGRATION_TWO_FAILED");
    expect(commits).toBe(0);
    expect(rollbacks).toBe(1);
    expect(durableLedger).toEqual([]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("does not let concurrent migration runs enter the protected body together", async () => {
    let locked = false;
    const waiters: Array<() => void> = [];
    const blockedBodies: Array<() => void> = [];
    let activeBodies = 0;
    let bodyEntries = 0;
    let maximumActiveBodies = 0;
    const acquire = async () => {
      if (!locked) {
        locked = true;
        return;
      }
      const available = new Promise<void>((resolve) => waiters.push(resolve));
      blockedBodies.shift()?.();
      await available;
      locked = true;
    };
    const release = () => {
      locked = false;
      waiters.shift()?.();
    };
    const withClient = async <T,>(work: (client: never) => Promise<T>): Promise<T> => {
      let ownsLock = false;
      const query = async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock")) {
          await acquire();
          ownsLock = true;
        } else if (sql === "commit" || sql === "rollback") {
          if (ownsLock) release();
          ownsLock = false;
        } else if (sql.startsWith("-- protected migration")) {
          activeBodies += 1;
          bodyEntries += 1;
          maximumActiveBodies = Math.max(maximumActiveBodies, activeBodies);
          if (bodyEntries === 1 && waiters.length === 0) {
            await new Promise<void>((resolve) => blockedBodies.push(resolve));
          } else if (activeBodies === 2) {
            blockedBodies.shift()?.();
          }
          activeBodies -= 1;
        }
        return { rows: [] };
      };
      return work({ query } as never);
    };
    const run = () => runProductionMigrations({
      databaseUrl: "postgresql://example.invalid/db",
      migrationFiles: ["0001_events.sql"],
      readMigration: () => "-- protected migration",
      withClient,
    });

    await Promise.all([run(), run()]);
    expect(maximumActiveBodies).toBe(1);
  });
});

const EXPECTED_ACTIVE_ENV_KEYS = [
  "CODEX_HOME",
  "DATABASE_URL",
  "ENABLE_EXPERIMENTAL_COREPACK",
  "FINNHUB_API_KEY",
  "GUSTAVO_APP_ORIGIN",
  "GUSTAVO_BACKGROUND_WORKER_OWNER",
  "GUSTAVO_CACHE_ENCRYPTION_KEY",
  "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
  "GUSTAVO_CURSOR_SIGNING_KEY",
  "GUSTAVO_DATABASE_SSL",
  "GUSTAVO_DEPLOYMENT_PROFILE",
  "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
  "GUSTAVO_EVENT_ROOT_KEY_V1",
  "GUSTAVO_EVENT_ROOT_KEY_VERSION",
  "GUSTAVO_HYBRID_BRIDGE_ENABLED",
  "GUSTAVO_HYBRID_WAKE_URL",
  "GUSTAVO_OPERATOR_HEALTH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "QSTASH_TOKEN",
  "VALKEY_URL",
] as const;

function activeAssignments(env: string): ReadonlyArray<readonly [string, string]> {
  return env.split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator < 0) throw new Error(`ENV_ASSIGNMENT_INVALID:${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)] as const;
    });
}

function assertExactActiveKeyMultiset(
  assignments: ReadonlyArray<readonly [string, string]>,
): void {
  const actual = assignments.map(([key]) => key).sort();
  const expected = [...EXPECTED_ACTIVE_ENV_KEYS].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw new Error("ENV_KEY_SET_INVALID");
  }
}

function activeValues(env: string, name: string): string[] {
  const active = activeAssignments(env);
  assertExactActiveKeyMultiset(active);
  return active
    .filter(([key]) => key === name)
    .map(([, value]) => value);
}

describe("Vercel hybrid deployment contract", () => {
  it("pins the deployment CLI and exposes only real hosted and local controls", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const local = readFileSync("infra/env.example", "utf8");
    const hosted = readFileSync("infra/vercel.env.example", "utf8");

    expect(manifest.devDependencies.vercel).toBe("58.4.0");
    expect(local).toContain("GUSTAVO_HYBRID_PUBLIC_WAKE_URL=");
    expect(local).not.toContain("GUSTAVO_HYBRID_WAKE_URL=");
    expect(local).not.toContain("GUSTAVO_HYBRID_BRIDGE_ENABLED");
    expect(hosted).toContain("GUSTAVO_HYBRID_WAKE_URL=");
    expect(hosted).not.toContain("GUSTAVO_HYBRID_PUBLIC_WAKE_URL=");
    expect(hosted).toContain("GUSTAVO_HYBRID_BRIDGE_ENABLED=false");
    expect(`${local}\n${hosted}`).not.toContain("GUSTAVO_MARKET_POLLER_ENABLED");
  });

  it("pins Node 24, pnpm 11, bounded functions, and explicit free-tier flags", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    const env = readFileSync("infra/vercel.env.example", "utf8");

    expect(pkg.packageManager).toBe("pnpm@11.16.0");
    expect(pkg.engines.node).toBe(">=24.7.0 <25");
    expect(pkg.dependencies).toMatchObject({
      "@upstash/qstash": expect.any(String),
      "@vercel/functions": expect.any(String),
    });
    expect(vercel.functions).toEqual({
      "app/api/feed/stream/route.ts": { maxDuration: 60 },
      "app/api/internal/maintenance/route.ts": { maxDuration: 60 },
    });
    const bridgeFlag = "GUSTAVO_HYBRID_BRIDGE_ENABLED";
    const corepackFlag = "ENABLE_EXPERIMENTAL_COREPACK";
    expect(activeValues(env, corepackFlag)).toEqual(["1"]);
    expect(activeValues(env, "GUSTAVO_BACKGROUND_WORKER_OWNER")).toEqual(["worker"]);
    expect(activeValues(env, "GUSTAVO_DEPLOYMENT_PROFILE")).toEqual(["public-production-v1"]);
    expect(activeValues(env, "GUSTAVO_APP_ORIGIN")).toEqual(["https://gustavo.lol"]);
    expect(activeValues(env, "GUSTAVO_DATABASE_SSL")).toEqual(["require"]);
    expect(activeValues(env, "GUSTAVO_EVENT_ROOT_KEY_VERSION")).toEqual(["1"]);
    expect(activeValues(env, bridgeFlag)).toEqual(["false"]);
    expect(() => activeValues(
      env.replace("DATABASE_URL=", "DATABASE_URL"),
      "DATABASE_URL",
    )).toThrow("ENV_ASSIGNMENT_INVALID:DATABASE_URL");
    expect(() => activeValues(
      `${env}\nANTHROPIC_API_KEY=paid-secret`,
      "DATABASE_URL",
    )).toThrow("ENV_KEY_SET_INVALID");
    for (const secret of [
      "DATABASE_URL",
      "VALKEY_URL",
      "GUSTAVO_EVENT_ROOT_KEY_V1",
      "GUSTAVO_CURSOR_SIGNING_KEY",
      "GUSTAVO_CACHE_ENCRYPTION_KEY",
      "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
      "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
      "GUSTAVO_OPERATOR_HEALTH_TOKEN",
      "GUSTAVO_HYBRID_WAKE_URL",
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
      "FINNHUB_API_KEY",
      "CODEX_HOME",
    ]) {
      expect(activeValues(env, secret), secret).toEqual([""]);
    }
    expect(activeValues(`# ${bridgeFlag}=true\n${env}`, bridgeFlag)).toEqual(["false"]);
    expect(() => activeValues(`${env}\n${bridgeFlag}=false`, bridgeFlag))
      .toThrow("ENV_KEY_SET_INVALID");
    expect(() => activeValues(`${env}\n${bridgeFlag}=true`, bridgeFlag))
      .toThrow("ENV_KEY_SET_INVALID");
    const suffixed = env.replace(
      `${bridgeFlag}=false`,
      `${bridgeFlag}=false=true`,
    );
    expect(activeValues(suffixed, bridgeFlag)).toEqual(["false=true"]);
    expect(activeValues(
      env.replace(`${corepackFlag}=1`, `${corepackFlag}=1=0`),
      corepackFlag,
    )).toEqual(["1=0"]);
    expect(env).not.toMatch(
      /OPENAI_API_KEY|PAID_FALLBACK|OVERAGE_ENABLED|GUSTAVO_EVENT_ENCRYPTION_KEY|GUSTAVO_INVITATION_HMAC_KEY|GUSTAVO_MEMORY_ENCRYPTION_KEY|GUSTAVO_NODE_SEED_ENCRYPTION_KEY|GUSTAVO_PASSWORD_PEPPER|GUSTAVO_SESSION_HMAC_KEY|GUSTAVO_THOUGHT_ENCRYPTION_KEY/,
    );
  });
});

describe("Vercel PostgreSQL policy", () => {
  it("uses a bounded Vercel pool and attaches exactly that pool", () => {
    const attach = vi.fn();
    const policy = postgresPoolPolicy(
      { VERCEL: "1", DATABASE_URL: "postgresql://example.invalid/db" },
      attach,
    );

    expect(policy.options).toMatchObject({
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 5_000,
    });
    policy.attach({ marker: "pool" } as never);
    expect(attach).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledWith({ marker: "pool" });
  });
});

type BootstrapTestDatabase = Awaited<ReturnType<typeof testContext>>["db"];

function migrationNames(): string[] {
  return readdirSync("db/migrations")
    .filter((name) => /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/u.test(name))
    .sort();
}

async function installExactMigrationLedger(db: BootstrapTestDatabase): Promise<void> {
  await db.query(`create table schema_migrations (
    name text primary key,
    checksum_sha256 char(64) not null
  )`);
  for (const name of migrationNames()) {
    const checksum = createHash("sha256")
      .update(readFileSync(`db/migrations/${name}`, "utf8").replace(/\r\n?/gu, "\n"), "utf8")
      .digest("hex");
    await db.query(
      "insert into schema_migrations (name,checksum_sha256) values ($1,$2)",
      [name, checksum],
    );
  }
}

function migratedApplicationTables(): string[] {
  const names = new Set<string>();
  for (const migration of migrationNames()) {
    const sql = readFileSync(`db/migrations/${migration}`, "utf8");
    for (const match of sql.matchAll(/^create table ([a-z0-9_]+)/gmu)) names.add(match[1]!);
  }
  return [...names].sort();
}

function runBootstrapTransaction(
  db: BootstrapTestDatabase,
  issueInvitation: () => Promise<{ readonly redemptionUrl: string; readonly expiresAt: string }>,
  write: (value: string) => void = vi.fn(),
): Promise<void> {
  return db.transaction((transaction) => bootstrapProduction({
    databaseUrl: "postgresql://secret.invalid/gustavo",
    canonicalOrigin: "https://gustavo.lol",
    query: (sql, parameters) => transaction.query(sql, parameters),
    issueInvitation,
    write,
  }));
}

describe("fresh production bootstrap", () => {
  it("seeds authority only and prints one secret-free expiring redemption URL", async () => {
    const write = vi.fn();
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: "https://gustavo.lol/join?token=opaque-once",
      expiresAt: "2026-08-14T12:00:00.000Z",
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("production-bootstrap-preflight")) return [{ safe_code: null }];
      if (sql.includes("from accounts")) return [];
      if (sql.includes("from events")) return [];
      if (sql.includes("from conversations")) return [];
      if (sql.includes("from memory_records")) return [];
      if (sql.includes("from market_latest_quotes")) return [];
      return [];
    });

    await bootstrapProduction({
      databaseUrl: "postgresql://secret.invalid/gustavo",
      canonicalOrigin: "https://gustavo.lol",
      query,
      issueInvitation,
      write,
    });

    expect(issueInvitation).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toBe("https://gustavo.lol/join?token=opaque-once\n");
    expect(write.mock.calls[0][0]).not.toMatch(
      /postgresql|DATABASE_URL|encryption|opaque-once.*opaque-once/i,
    );
  });

  it("rejects every non-production authority before querying or issuing", async () => {
    const validEnvironment = {
      DATABASE_URL: "postgresql://secret.invalid/gustavo",
      GUSTAVO_APP_ORIGIN: "https://gustavo.lol",
      GUSTAVO_DEPLOYMENT_PROFILE: "public-production-v1",
      GUSTAVO_EVENT_ROOT_KEY_VERSION: "1",
      GUSTAVO_EVENT_ROOT_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
    };

    expect(readProductionBootstrapEnvironment(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      canonicalOrigin: "https://gustavo.lol",
      deploymentProfile: "public-production-v1",
    });

    for (const environment of [
      { ...validEnvironment, DATABASE_URL: "" },
      { ...validEnvironment, GUSTAVO_APP_ORIGIN: "https://www.gustavo.lol" },
      { ...validEnvironment, GUSTAVO_DEPLOYMENT_PROFILE: "local-mvp-v1" },
      { ...validEnvironment, GUSTAVO_EVENT_ROOT_KEY_VERSION: "2" },
      { ...validEnvironment, GUSTAVO_EVENT_ROOT_KEY_V1: "" },
    ]) {
      expect(() => readProductionBootstrapEnvironment(environment)).toThrow(
        /PRODUCTION_BOOTSTRAP_ENV_INVALID/,
      );
    }

    const query = vi.fn().mockResolvedValue([{ safe_code: null }]);
    const issueInvitation = vi.fn();
    const write = vi.fn();
    await expect(bootstrapProduction({
      databaseUrl: validEnvironment.DATABASE_URL,
      canonicalOrigin: "http://localhost:3000",
      deploymentProfile: "local-mvp-v1",
      query,
      issueInvitation,
      write,
    })).rejects.toThrow("PRODUCTION_BOOTSTRAP_AUTHORITY_INVALID");
    expect(query).not.toHaveBeenCalled();
    expect(issueInvitation).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("checks the full migration, empty private data, and exact fixed seed authority", async () => {
    const query = vi.fn().mockResolvedValue([{ safe_code: null }]);
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: "https://gustavo.lol/join?token=opaque-once",
      expiresAt: "2026-08-15T12:00:00.000Z",
    });

    await bootstrapProduction({
      databaseUrl: "postgresql://secret.invalid/gustavo",
      canonicalOrigin: "https://gustavo.lol",
      deploymentProfile: "public-production-v1",
      query,
      issueInvitation,
      write: vi.fn(),
    });

    expect(query).toHaveBeenCalledTimes(3);
    const [advisorySql] = query.mock.calls[0]!;
    const [lockSql] = query.mock.calls[1]!;
    const [sql, parameters] = query.mock.calls[2]!;
    expect(advisorySql).toMatch(/^select pg_advisory_xact_lock/iu);
    expect(lockSql).toMatch(/^lock table /iu);
    for (const relation of [
      "schema_migrations",
      "accounts",
      "conversations",
      "events",
      "memory_records",
      "market_latest_quotes",
      "bridge_model_jobs",
      "invitations",
    ]) expect(sql).toContain(relation);
    for (const authority of [
      "00000000-0000-4000-8000-000000001200",
      "00000000-0000-4000-8000-000000001201",
      "gustavo-main",
      "memory-graph-worker",
      "privacy-forget-production",
      "privacy-worker-test",
      "market_symbol_catalog",
    ]) expect(sql).toContain(authority);
    expect(parameters[0]).toHaveLength(24);
    expect(parameters[0].at(-1)).toMatch(
      /^0022_hybrid_deployment\.sql:[a-f0-9]{64}$/u,
    );
    expect(parameters[1]).toHaveLength(95);
    expect(parameters[3]).toEqual(migratedApplicationTables());
    for (const table of migratedApplicationTables()) expect(lockSql).toContain(table);
    expect(sql).not.toMatch(/\b(delete|insert|truncate|update)\b/i);
  });

  it("executes the fail-closed preflight against a freshly migrated PostgreSQL schema", async () => {
    const { db } = await testContext();
    await installExactMigrationLedger(db);
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: `https://gustavo.lol/join?token=${"a".repeat(43)}`,
      expiresAt: "2026-08-15T12:00:00.000Z",
    });
    const write = vi.fn();
    await runBootstrapTransaction(db, issueInvitation, write);
    expect(issueInvitation).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();

    await db.query(
      "insert into accounts (id,display_name) values ($1,'unsafe local account')",
      ["00000000-0000-4000-8000-000000009999"],
    );
    await expect(runBootstrapTransaction(db, issueInvitation, write))
      .rejects.toThrow("PRODUCTION_DATABASE_NOT_EMPTY");
    expect(issueInvitation).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
  }, 20_000);

  it("fails closed for every unsafe database state without mutation or invitation output", async () => {
    for (const safeCode of [
      "SCHEMA_NOT_FULLY_MIGRATED",
      "PRODUCTION_DATABASE_NOT_EMPTY",
      "PRODUCTION_AUTHORITY_INVALID",
    ]) {
      const query = vi.fn().mockResolvedValue([{ safe_code: safeCode }]);
      const issueInvitation = vi.fn();
      const write = vi.fn();
      await expect(bootstrapProduction({
        databaseUrl: "postgresql://secret.invalid/gustavo",
        canonicalOrigin: "https://gustavo.lol",
        deploymentProfile: "public-production-v1",
        query,
        issueInvitation,
        write,
      })).rejects.toThrow(safeCode);
      expect(issueInvitation).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("builds one canonical opaque redemption URL without duplicating the token", () => {
    const token = "a".repeat(43);
    const redemptionUrl = createInvitationRedemptionUrl("https://gustavo.lol", token);
    expect(redemptionUrl).toBe(`https://gustavo.lol/join?token=${token}`);
    expect(redemptionUrl.match(new RegExp(token, "g"))).toHaveLength(1);
    expect(() => createInvitationRedemptionUrl("http://localhost:3000", token))
      .toThrow("INVITATION_CANONICAL_ORIGIN_INVALID");
  });

  it.each([
    "http://localhost:3000",
    "https://www.gustavo.lol",
  ])("rejects invitation URL origin %s before creating invitation authority", async (origin) => {
    const { db } = await testContext();
    const before = await db.one<{ invitations: string; events: string }>(
      `select (select count(*)::text from invitations) invitations,
              (select count(*)::text from events) events`,
    );

    await expect(issueInvitationRedemptionUrl(
      { db, operator: { id: "gustavo-operator", role: "OPERATOR" } },
      { expiresAt: new Date("2030-01-01T00:00:00.000Z") },
      origin,
    )).rejects.toThrow("INVITATION_CANONICAL_ORIGIN_INVALID");

    expect(await db.one<{ invitations: string; events: string }>(
      `select (select count(*)::text from invitations) invitations,
              (select count(*)::text from events) events`,
    )).toEqual(before);
  }, 20_000);

  it("rejects the materializer authority when it is itself a member of another role", async () => {
    const { db } = await testContext();
    await installExactMigrationLedger(db);
    const parentRole = `bootstrap_parent_${randomUUID().replaceAll("-", "")}`;
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: `https://gustavo.lol/join?token=${"a".repeat(43)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await db.query(`create role ${parentRole} nologin`);
    try {
      await db.query(`grant ${parentRole} to gustavo_market_materializer`);
      await expect(runBootstrapTransaction(db, issueInvitation))
        .rejects.toThrow("PRODUCTION_AUTHORITY_INVALID");
      expect(issueInvitation).not.toHaveBeenCalled();
    } finally {
      await db.query(`revoke ${parentRole} from gustavo_market_materializer`);
      await db.query(`drop role ${parentRole}`);
    }
  }, 20_000);

  it("rejects omitted historical market, Challenge, and hybrid runtime state", async () => {
    const { db } = await testContext();
    await installExactMigrationLedger(db);
    await db.query(
      "insert into market_instrument_allowlist(symbol,asset_class) values ('AAPL','US_STOCK')",
    );
    await db.query(
      `insert into market_data_sources(provider,license_id,licensed,redistribution)
       values ('bootstrap-fixture','fixture-v1',true,'INTERNAL_ONLY')`,
    );
    await db.query(
      `insert into market_observations (
         id,symbol,asset_class,price,observed_at,received_at,provider,license_id,
         raw_source_ref,feed_status,delay_seconds,redistribution,session_state
       ) values ($1,'AAPL','US_STOCK','100.00','2026-08-14T12:00:00Z',
         '2026-08-14T12:00:01Z','bootstrap-fixture','fixture-v1','historical:1',
         'REALTIME',0,'INTERNAL_ONLY','OPEN')`,
      [randomUUID()],
    );
    await db.query(
      `insert into challenge_stages (
         id,challenge_portfolio_id,profile_version_id,stage_profile_id,ordinal,created_at
       ) values ($1,'00000000-0000-4000-8000-000000001200',
         '00000000-0000-4000-8000-000000001201',
         '00000000-0000-4000-8000-000000001211',1,clock_timestamp())`,
      [randomUUID()],
    );
    await db.query(
      "insert into hybrid_worker_heartbeats(component,status) values ('CODEX','HEALTHY')",
    );
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: `https://gustavo.lol/join?token=${"a".repeat(43)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    await expect(runBootstrapTransaction(db, issueInvitation))
      .rejects.toThrow("PRODUCTION_DATABASE_NOT_EMPTY");
    expect(issueInvitation).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects semantic corruption of cache and privacy seed authorities", async () => {
    const { db } = await testContext();
    await installExactMigrationLedger(db);
    const frozenPrivacy = await db.one<{ digest: string }>(
      `select recall_manifest_digest(coalesce(jsonb_agg(jsonb_build_object(
         'projectionType',projection_type,'ordinal',ordinal,'relationName',relation_name,
         'forgetBehavior',forget_behavior,'rebuildBehavior',rebuild_behavior,
         'forgetExecutor',forget_executor,'rebuildExecutor',rebuild_executor
       ) order by ordinal),'[]'::jsonb)) digest from privacy_projection_registry`,
    );
    expect(frozenPrivacy.digest)
      .toBe("4d9149750a281db78a84426c190559b791248a707945cd0b4cce27a151250ade");
    await db.query("update cache_outbox_backfill_state set completed=false");
    await db.query(
      "alter table privacy_projection_registry disable trigger privacy_projection_registry_is_immutable",
    );
    try {
      await db.query(
        `update privacy_projection_registry set rebuild_behavior='REBUILD',
           rebuild_executor='REBUILD_TYPED' where projection_type='CONSOLIDATION_RUN'`,
      );
    } finally {
      await db.query(
        "alter table privacy_projection_registry enable trigger privacy_projection_registry_is_immutable",
      );
    }
    const issueInvitation = vi.fn().mockResolvedValue({
      redemptionUrl: `https://gustavo.lol/join?token=${"a".repeat(43)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });

    await expect(runBootstrapTransaction(db, issueInvitation))
      .rejects.toThrow("PRODUCTION_AUTHORITY_INVALID");
    expect(issueInvitation).not.toHaveBeenCalled();
  }, 20_000);

  it("serializes two real bootstrap transactions so exactly one invitation commits", async () => {
    const { db } = await testContext();
    await installExactMigrationLedger(db);
    const outputs: string[] = [];
    const run = async (): Promise<void> => {
      let buffered: string | undefined;
      await db.transaction((transaction) => bootstrapProduction({
        databaseUrl: "postgresql://secret.invalid/gustavo",
        canonicalOrigin: "https://gustavo.lol",
        query: (sql, parameters) => transaction.query(sql, parameters),
        issueInvitation: () => issueInvitationRedemptionUrl(
          { db: transaction, operator: { id: "gustavo-operator", role: "OPERATOR" } },
          { expiresAt: new Date("2030-01-01T00:00:00.000Z") },
          "https://gustavo.lol",
        ),
        write: (value) => { buffered = value; },
      }));
      if (buffered) outputs.push(buffered);
    };

    const settled = await Promise.allSettled([run(), run()]);
    expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(await db.one<{ invitations: string; events: string }>(
      `select (select count(*)::text from invitations) invitations,
              (select count(*)::text from events where type='invitation.issued') events`,
    )).toEqual({ invitations: "1", events: "1" });
  }, 20_000);

  it("holds checked table locks through invitation settlement against non-cooperating writes", async () => {
    const { db } = await testContext();
    await installExactMigrationLedger(db);
    let markIssueEntered!: () => void;
    let releaseIssue!: () => void;
    const issueEntered = new Promise<void>((resolve) => { markIssueEntered = resolve; });
    const issueReleased = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const bootstrap = db.transaction((transaction) => bootstrapProduction({
      databaseUrl: "postgresql://secret.invalid/gustavo",
      canonicalOrigin: "https://gustavo.lol",
      query: (sql, parameters) => transaction.query(sql, parameters),
      issueInvitation: async () => {
        markIssueEntered();
        await issueReleased;
        return {
          redemptionUrl: `https://gustavo.lol/join?token=${"a".repeat(43)}`,
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
      write: vi.fn(),
    }));
    await issueEntered;
    try {
      await expect(db.transaction(async (writer) => {
        await writer.query("set local lock_timeout='100ms'");
        await writer.query(
          "insert into hybrid_worker_heartbeats(component,status) values ('CODEX','HEALTHY')",
        );
      })).rejects.toThrow(/lock timeout/iu);
    } finally {
      releaseIssue();
    }
    await bootstrap;
  }, 20_000);

  it("uses an exact package command and a safe unambiguous CLI failure channel", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const source = readFileSync("scripts/bootstrap-production.ts", "utf8");
    expect(packageJson.scripts["production:bootstrap"])
      .toBe("tsx scripts/bootstrap-production.ts");
    expect(source).toContain('process.stderr.write("PRODUCTION_BOOTSTRAP_FAILED\\n")');
    expect(source).toContain("process.exitCode = 1");
    expect(source).not.toMatch(/process\.exit\s*\(/);
    expect(source).not.toMatch(/process\.argv\[(?:2|3|4)\]/);
    expect(source).not.toMatch(/console\.(?:log|error)/);
  });
});
