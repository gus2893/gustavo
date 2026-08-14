# Vercel hybrid deployment and operations

This is the command-ordered authority for Gustavo's invitation-only hybrid
production. Stop on any mismatch. Record only plan names, regions, schedule and
deployment IDs, git SHA, dashboard paths, command exit codes, and redacted
results. Never record credentials, invitation tokens, database URLs, Funnel
URLs, protected text, quotes, ciphertext, or container output.

The public safety label remains exact:

`SIMULATION ONLY — NOT A REAL TRADE`

## 1. Establish executable authority and the $0 boundary

Use an approved Windows console to derive executables from Windows KnownFolder
APIs. Environment variables, `PATH`, command aliases, and shell wrappers are not
authority. The release workstation's reviewed installation uses these exact
locations; adjust only through a separately reviewed workstation change:

The current Program Files Node 22 installation is not authority. Before this
runbook, an approved workstation change must replace it at the same
KnownFolder-derived path with exact Node `v24.19.0` and Corepack-selected pnpm
`11.16.0`; the commands below stop before install if either version differs.

```powershell
$KnownProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$KnownWindows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
$TrustedGit = Join-Path $KnownProgramFiles 'Git\cmd\git.exe'
$TrustedNode = Join-Path $KnownProgramFiles 'nodejs\node.exe'
$TrustedCorepackScript = Join-Path $KnownProgramFiles 'nodejs\node_modules\corepack\dist\corepack.js'
$TrustedPowerShell = Join-Path $KnownWindows 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TrustedPsql = Join-Path $KnownProgramFiles 'PostgreSQL\17\bin\psql.exe'
$TrustedPgDump = Join-Path $KnownProgramFiles 'PostgreSQL\17\bin\pg_dump.exe'
$TrustedSystem32 = Join-Path $KnownWindows 'System32'

function Assert-NoReparsePath([string]$Path) {
  $FullPath = [IO.Path]::GetFullPath($Path)
  $Root = [IO.Path]::GetPathRoot($FullPath)
  $Current = $Root
  foreach ($Segment in $FullPath.Substring($Root.Length).Split(
    [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
    [StringSplitOptions]::RemoveEmptyEntries
  )) {
    $Current = Join-Path $Current $Segment
    $Part = Get-Item -LiteralPath $Current -Force -ErrorAction Stop
    if (($Part.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'TRUSTED_EXECUTABLE_REPARSE_PATH'
    }
  }
}

foreach ($Executable in @(
  $TrustedGit, $TrustedNode, $TrustedCorepackScript, $TrustedPowerShell,
  $TrustedPsql, $TrustedPgDump
)) {
  Assert-NoReparsePath $Executable
  $Item = Get-Item -LiteralPath $Executable -Force -ErrorAction Stop
  if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "TRUSTED_EXECUTABLE_INVALID"
  }
}

function Assert-ReviewedPushedHead {
  & $TrustedGit fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw 'REVIEWED_PUSHED_HEAD_REQUIRED' }

  $Dirty = @(& $TrustedGit status --porcelain)
  if ($LASTEXITCODE -ne 0 -or $Dirty.Count -ne 0) {
    throw 'REVIEWED_PUSHED_HEAD_REQUIRED'
  }

  $Head = (& $TrustedGit rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Head -notmatch '^[a-f0-9]{40}$') {
    throw 'REVIEWED_PUSHED_HEAD_REQUIRED'
  }

  $Upstream = (& $TrustedGit rev-parse '@{upstream}').Trim()
  if ($LASTEXITCODE -ne 0 -or $Upstream -notmatch '^[a-f0-9]{40}$' -or
      $Head -cne $Upstream) {
    throw 'REVIEWED_PUSHED_HEAD_REQUIRED'
  }
  return $Head
}

function Reset-NodeEnvironmentAuthority {
  foreach ($Entry in [Environment]::GetEnvironmentVariables('Process').Keys) {
    $Name = [string]$Entry
    if ($Name -ilike 'PNPM_CONFIG_*' -or $Name -ilike 'NPM_CONFIG_*') {
      [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
  }
  foreach ($Entry in [Environment]::GetEnvironmentVariables('Process').Keys) {
    $Name = [string]$Entry
    if ($Name -ilike 'PNPM_CONFIG_*' -or $Name -ilike 'NPM_CONFIG_*') {
      throw 'PACKAGE_CONFIG_ENVIRONMENT_AUTHORITY_FAILED'
    }
  }
  $NodeAuthorityNames = @(
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE',
    'NODE_EXTRA_CA_CERTS', 'OPENSSL_CONF', 'SSL_CERT_DIR', 'SSL_CERT_FILE',
    'COREPACK_HOME', 'COREPACK_NPM_REGISTRY', 'COREPACK_INTEGRITY_KEYS',
    'COREPACK_DEFAULT_TO_LATEST', 'COREPACK_ENABLE_DOWNLOAD_PROMPT',
    'COREPACK_ENABLE_PROJECT_SPEC', 'npm_config_userconfig',
    'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_NODE_OPTIONS', 'PNPM_HOME'
  )
  foreach ($Name in $NodeAuthorityNames) {
    [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
  }
  foreach ($Name in $NodeAuthorityNames) {
    if ($null -ne [Environment]::GetEnvironmentVariable($Name, 'Process')) {
      throw 'NODE_ENVIRONMENT_AUTHORITY_FAILED'
    }
  }
  $ControlledPackageConfig = @{
    npm_config_userconfig = 'NUL'
    NPM_CONFIG_GLOBALCONFIG = 'NUL'
  }
  foreach ($Name in $ControlledPackageConfig.Keys) {
    [Environment]::SetEnvironmentVariable(
      $Name, [string]$ControlledPackageConfig[$Name], 'Process'
    )
  }
  foreach ($Name in $ControlledPackageConfig.Keys) {
    if ([Environment]::GetEnvironmentVariable($Name, 'Process') -cne 'NUL') {
      throw 'NODE_ENVIRONMENT_AUTHORITY_FAILED'
    }
  }
}

function Reset-GitEnvironmentAuthority {
  foreach ($Entry in [Environment]::GetEnvironmentVariables('Process').Keys) {
    $Name = [string]$Entry
    if ($Name -like 'GIT_*') {
      [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
  }
  $ControlledGitEnvironment = @{
    GIT_CONFIG_NOSYSTEM = '1'
    GIT_CONFIG_GLOBAL = 'NUL'
    GIT_CONFIG_SYSTEM = 'NUL'
    GIT_TERMINAL_PROMPT = '0'
  }
  foreach ($Name in $ControlledGitEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable(
      $Name, [string]$ControlledGitEnvironment[$Name], 'Process'
    )
  }
  foreach ($Entry in [Environment]::GetEnvironmentVariables('Process').Keys) {
    $Name = [string]$Entry
    if ($Name -like 'GIT_*' -and
        -not $ControlledGitEnvironment.ContainsKey($Name)) {
      throw 'GIT_ENVIRONMENT_AUTHORITY_FAILED'
    }
  }
}

function Assert-TrustedRuntimeVersions {
  $NodeVersionOutput = @(& $TrustedNode --version)
  $NodeVersionExitCode = $LASTEXITCODE
  if ($NodeVersionExitCode -ne 0 -or $NodeVersionOutput.Count -ne 1 -or
      [string]$NodeVersionOutput[0] -cne 'v24.19.0') {
    throw 'TRUSTED_NODE_VERSION_FAILED'
  }
  $PnpmVersionOutput = @(& $TrustedNode $TrustedCorepackScript pnpm --version)
  $PnpmVersionExitCode = $LASTEXITCODE
  if ($PnpmVersionExitCode -ne 0 -or $PnpmVersionOutput.Count -ne 1 -or
      [string]$PnpmVersionOutput[0] -cne '11.16.0') {
    throw 'TRUSTED_PNPM_VERSION_FAILED'
  }
}

function Assert-TrustedPnpmStoreIntegrity {
  $StoreStatusOutput = @(& $TrustedNode $TrustedCorepackScript pnpm store status)
  $StoreStatusExitCode = $LASTEXITCODE
  if ($StoreStatusExitCode -ne 0) { throw 'PNPM_STORE_INTEGRITY_FAILED' }
}

$env:PATH = "$(Split-Path -Parent $TrustedNode);$(Split-Path -Parent $TrustedGit);$TrustedSystem32"
Reset-NodeEnvironmentAuthority
Reset-GitEnvironmentAuthority
$ReviewedHead = Assert-ReviewedPushedHead
Assert-TrustedRuntimeVersions
& $TrustedNode $TrustedCorepackScript pnpm install --frozen-lockfile
$InstallExitCode = $LASTEXITCODE
if ($InstallExitCode -ne 0) { throw 'FROZEN_INSTALL_FAILED' }
Assert-TrustedPnpmStoreIntegrity

$RepositoryRoot = [IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\')
$VercelLinkPath = Join-Path $RepositoryRoot 'node_modules\vercel'
$VercelLink = Get-Item -LiteralPath $VercelLinkPath -Force
$VercelTargets = @($VercelLink.Target)
if ($VercelLink.LinkType -cne 'SymbolicLink' -or $VercelTargets.Count -ne 1 -or
    [IO.Path]::IsPathRooted([string]$VercelTargets[0])) {
  throw 'PINNED_VERCEL_LINK_INVALID'
}
$CanonicalVercelRoot = [IO.Path]::GetFullPath((
  Join-Path (Split-Path -Parent $VercelLinkPath) ([string]$VercelTargets[0])
))
$ExpectedVercelRootPattern = '^' + [Regex]::Escape($RepositoryRoot) +
  '\\node_modules\\\.pnpm\\vercel@58\.4\.0_[^\\]+\\node_modules\\vercel$'
if ($CanonicalVercelRoot -cnotmatch $ExpectedVercelRootPattern) {
  throw 'PINNED_VERCEL_ROOT_INVALID'
}
$CanonicalVercelRootItem = Get-Item -LiteralPath $CanonicalVercelRoot -Force
if (-not $CanonicalVercelRootItem.PSIsContainer -or
    ($CanonicalVercelRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'PINNED_VERCEL_ROOT_INVALID'
}
$TrustedVercelPackagePath = Join-Path $CanonicalVercelRoot 'package.json'
$TrustedVercelCli = Join-Path $CanonicalVercelRoot 'dist\index.js'
$TrustedVercelPackageItem = Get-Item -LiteralPath $TrustedVercelPackagePath -Force
$TrustedVercelCliItem = Get-Item -LiteralPath $TrustedVercelCli -Force
if ($TrustedVercelPackageItem.PSIsContainer -or $TrustedVercelCliItem.PSIsContainer -or
    ($TrustedVercelPackageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($TrustedVercelCliItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  throw 'PINNED_VERCEL_FILES_INVALID'
}
$TrustedVercelPackage = Get-Content -LiteralPath $TrustedVercelPackagePath -Raw |
  ConvertFrom-Json -ErrorAction Stop
if ($TrustedVercelPackage.name -cne 'vercel' -or
    $TrustedVercelPackage.version -cne '58.4.0') {
  throw 'PINNED_VERCEL_VERSION_INVALID'
}

$TrustedChildPath = "$(Split-Path -Parent $TrustedGit);$(Split-Path -Parent $TrustedNode);$TrustedSystem32"
$TrustedVercelBootstrap = @'
import { pathToFileURL } from 'node:url'; const [trustedChildPath, cliPath, ...cliArgs] = process.argv.slice(1); if (!trustedChildPath || !cliPath) throw new Error('TRUSTED_VERCEL_ARGUMENTS_INVALID'); for (const key of Object.keys(process.env)) { if (key.toUpperCase() === 'PATH') delete process.env[key]; } process.env.PATH = trustedChildPath; process.argv = [process.execPath, cliPath, ...cliArgs]; await import(pathToFileURL(cliPath).href);
'@

function Invoke-TrustedVercel {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$VercelArguments)
  & $TrustedNode $TrustedCorepackScript pnpm exec -- $TrustedNode --input-type=module --eval $TrustedVercelBootstrap -- $TrustedChildPath $TrustedVercelCli @VercelArguments
}

Invoke-TrustedVercel --version
$VercelVersionExitCode = $LASTEXITCODE
if ($VercelVersionExitCode -ne 0) { throw 'PINNED_VERCEL_VERSION_FAILED' }

function Stop-ReviewedHybridWorker {
  $StopOutput = @(& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/start-hybrid-worker.ps1 -StopForMaintenance)
  $StopExitCode = $LASTEXITCODE
  if ($StopExitCode -ne 0 -or $StopOutput.Count -ne 1 -or
      [string]$StopOutput[0] -cne 'HYBRID_WORKER_MAINTENANCE_STOPPED') {
    throw 'HYBRID_MAINTENANCE_STOP_UNPROVEN'
  }
  return [string]$StopOutput[0]
}

function Assert-SingleCanonicalDeploymentUrl([object[]]$Output, [string]$FailureCode) {
  if ($Output.Count -ne 1) { throw $FailureCode }
  $Candidate = ([string]$Output[0]).Trim()
  if ($Candidate -cnotmatch '^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$') {
    throw $FailureCode
  }
  return $Candidate
}

function ConvertFrom-StrictJsonObject([object[]]$Output, [string]$FailureCode) {
  if ($Output.Count -eq 0) { throw $FailureCode }
  $JsonText = [string]::Join("`n", [string[]]$Output)
  try {
    $Parsed = ConvertFrom-Json -InputObject $JsonText -ErrorAction Stop
  } catch {
    throw $FailureCode
  }
  if ($null -eq $Parsed -or $Parsed -is [Array] -or
      $Parsed.PSObject.Properties.Count -eq 0) {
    throw $FailureCode
  }
  return $Parsed
}

function Assert-DeploymentInspection(
  [object]$Inspection, [string]$ExpectedUrl, [string]$FailureCode
) {
  $ExpectedHost = $ExpectedUrl.Substring('https://'.Length)
  if ($Inspection.readyState -cne 'READY' -or
      $Inspection.id -cnotmatch '^dpl_[A-Za-z0-9]+$' -or
      $Inspection.url -cne $ExpectedHost) {
    throw $FailureCode
  }
  return $Inspection
}

function Assert-DeploymentSource(
  [object]$Source, [object]$Inspection, [string]$ExpectedHead,
  [string]$FailureCode
) {
  if ($Source.id -cne $Inspection.id -or
      $Source.url -cne $Inspection.url -or
      $Source.projectId -cne 'prj_HoIxQexO64tsgXrNI6m89g3P87TB' -or
      $Source.ownerId -cne 'team_2ZsWunVLuTIHx2h2zmWEAvAH' -or
      $Source.meta.githubCommitSha -cne $ExpectedHead) {
    throw $FailureCode
  }
  return $Source
}
```

Require Node 24, pnpm 11.16.0, and record `vercel: 58.4.0`. Invoke every
repository command with the trusted absolute Node executable and the trusted
absolute Corepack JavaScript entry above (the trusted absolute Corepack
authority). Invoke Vercel only through `Invoke-TrustedVercel`, which retains
Corepack/pnpm admission but resets the child PATH before importing the exact
pinned CLI. Invoke repository
PowerShell scripts only with `$TrustedPowerShell`. Never use a bare `pnpm`,
`npx`, `vercel`, PowerShell, Docker, Tailscale, Git, or a mutable
environment-derived executable.

Vercel CLI 58.4.0 omits `meta` from `inspect --json`. Therefore deployment
authority always uses two independently checked calls: strict inspection JSON
for Ready/id/URL, followed by authenticated raw deployment API JSON for the
same id/URL, exact linked project/team, and `meta.githubCommitSha`.

Confirm these plans before creating resources, with overage and automatic
upgrades disabled:

- Vercel Hobby
- Neon Free in the selected US East region
- Upstash Redis Free
- QStash Free
- Tailscale Free personal
- Finnhub Free personal
- Docker Desktop Personal
- the existing ChatGPT entitlement for standalone Codex

There is no OpenAI API key, paid model fallback, alternate market provider, or
paid-capacity escape hatch.

## 2. Prove the reviewed source, link the project, and configure domains

The source helper checks every Git result independently and fails closed unless
the tree is clean and the checked-out SHA is the reviewed pushed HEAD at its
upstream. It is the trusted absolute equivalent of `git status --porcelain`
plus a fetched upstream comparison. Section 1 runs that helper before the
frozen install, so the lockfile and subsequent store-integrity proof are tied
to the immutable `$ReviewedHead` before any dependency or Vercel CLI import.

The review record must name `$ReviewedHead`; otherwise stop. Link only existing project
`prj_HoIxQexO64tsgXrNI6m89g3P87TB` in team
`team_2ZsWunVLuTIHx2h2zmWEAvAH`, then inspect `.vercel/project.json` and the
dashboard identifiers:

```powershell
Invoke-TrustedVercel link
$LinkExitCode = $LASTEXITCODE
if ($LinkExitCode -ne 0) { throw 'VERCEL_LINK_FAILED' }
Invoke-TrustedVercel project inspect
$ProjectInspectExitCode = $LASTEXITCODE
if ($ProjectInspectExitCode -ne 0) { throw 'VERCEL_PROJECT_INSPECT_FAILED' }
```

In Vercel **Project Settings > Domains**, add both `gustavo.lol` and
`www.gustavo.lol`, and configure `www.gustavo.lol -> gustavo.lol`. This explicit
redirect configuration must exist before TLS or redirect verification.

Set project Node.js to 24.x and set `ENABLE_EXPERIMENTAL_COREPACK=1` in Preview
and Production. Use `infra/vercel.env.example` as the hosted name inventory.
Enter all values through the Vercel dashboard or the CLI's interactive standard
input prompt, never in an argument or checked-in file. For example:

```powershell
Invoke-TrustedVercel env add GUSTAVO_HYBRID_WAKE_URL preview
$PreviewWakeEnvExitCode = $LASTEXITCODE
if ($PreviewWakeEnvExitCode -ne 0) { throw 'PREVIEW_WAKE_ENV_FAILED' }
Invoke-TrustedVercel env add GUSTAVO_HYBRID_WAKE_URL production
$ProductionWakeEnvExitCode = $LASTEXITCODE
if ($ProductionWakeEnvExitCode -ne 0) { throw 'PRODUCTION_WAKE_ENV_FAILED' }
```

`GUSTAVO_HYBRID_WAKE_URL` is hosted publication authority for direct chat wakes.
`GUSTAVO_HYBRID_PUBLIC_WAKE_URL` is local-only and belongs only in the protected
worker configuration. Neither value may be printed. Keep
`GUSTAVO_HYBRID_BRIDGE_ENABLED=false` in Preview. Confirm every Vercel
environment omits `GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL`.

## 3. Provision fresh Free resources

1. Create a fresh Neon Free database. Do not import a local database, backup,
   account, conversation, memory, event, quote, poll, or bridge job.
2. Create an empty Upstash Redis Free database and put its TLS URL in hosted
   `VALKEY_URL` through the secret channel.
3. Create QStash Free. Put the token and current/next signing keys only in the
   secret stores that require them.
4. Create a Finnhub Free personal key for the local worker only.
5. Install Docker Desktop Personal and sign the dedicated Windows worker account
   into Tailscale Free personal. Do not open Funnel yet.

Record plan names, nonsecret resource IDs, and regions. Do not provision paid
fallbacks or copy data from the local MVP.

## 4. Migrate, prove empty authority, back up, then bootstrap

Load the exact production authority from the approved protected secret store
through nonprinting prompts. The helper never writes a value and clears its
unmanaged conversion buffer. Do not transcript this console:

```powershell
function Read-ProtectedProcessValue([string]$Name) {
  $SecureValue = Read-Host -AsSecureString -Prompt "Load protected value for $Name"
  if ($null -eq $SecureValue -or $SecureValue.Length -eq 0) {
    throw 'PROTECTED_PRODUCTION_AUTHORITY_INVALID'
  }
  $Buffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  $Plaintext = $null
  try {
    $Plaintext = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Buffer)
    if ([string]::IsNullOrWhiteSpace($Plaintext) -or
        $Plaintext.IndexOfAny(@([char]0, [char]10, [char]13)) -ge 0) {
      throw 'PROTECTED_PRODUCTION_AUTHORITY_INVALID'
    }
    [Environment]::SetEnvironmentVariable($Name, $Plaintext, 'Process')
  } finally {
    $Plaintext = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Buffer)
  }
}

Read-ProtectedProcessValue 'DATABASE_URL'
Read-ProtectedProcessValue 'GUSTAVO_APP_ORIGIN'
Read-ProtectedProcessValue 'GUSTAVO_DEPLOYMENT_PROFILE'
Read-ProtectedProcessValue 'GUSTAVO_EVENT_ROOT_KEY_VERSION'
Read-ProtectedProcessValue 'GUSTAVO_EVENT_ROOT_KEY_V1'
if ([Environment]::GetEnvironmentVariable('GUSTAVO_APP_ORIGIN', 'Process') -cne 'https://gustavo.lol' -or
    [Environment]::GetEnvironmentVariable('GUSTAVO_DEPLOYMENT_PROFILE', 'Process') -cne 'public-production-v1') {
  throw 'PROTECTED_PRODUCTION_AUTHORITY_INVALID'
}
Write-Output 'PROTECTED_PRODUCTION_AUTHORITY_LOADED'
```

The protected process now holds the fresh ordinary pooled Neon URL, canonical
origin, exact deployment profile, and event-root key version/key required by
both the probe and bootstrap. Apply all migrations under the application's
advisory lock:

```powershell
& $TrustedNode $TrustedCorepackScript pnpm production:migrate
$MigrationExitCode = $LASTEXITCODE
if ($MigrationExitCode -ne 0) { throw 'PRODUCTION_MIGRATION_FAILED' }
```

Next run the exact bootstrap preflight in a rollback-only transaction. This
executes the reviewed migration ledger, full application-table, fixed seed,
95-symbol, materializer-role, and empty-private-table checks, but deliberately
throws before invitation issuance:

```powershell
$InventoryProbe = @'
import { bootstrapProduction, readProductionBootstrapEnvironment } from "./scripts/bootstrap-production";
import { closeDatabase, getDatabase } from "./lib/server/db/postgres";
const marker = "MIGRATED_AUTHORITY_ONLY_EMPTY";
void (async () => {
  const database = getDatabase();
  let reachedInvitation = false;
  try {
    await database.transaction(async (transaction) => {
      await bootstrapProduction({
        ...readProductionBootstrapEnvironment(process.env),
        query: (sql, parameters) => transaction.query(sql, parameters),
        issueInvitation: async () => {
          reachedInvitation = true;
          throw new Error(marker);
        },
        write: () => { throw new Error("UNEXPECTED_INVITATION_OUTPUT"); },
      });
    });
    throw new Error("EMPTY_PREFLIGHT_DID_NOT_ABORT");
  } catch (error) {
    if (!reachedInvitation || !(error instanceof Error) || error.message !== marker) throw error;
    process.stdout.write(`${marker}\n`);
  } finally {
    await closeDatabase();
  }
})().catch((error: unknown) => {
  process.stderr.write("MIGRATED_AUTHORITY_ONLY_EMPTY_FAILED\n");
  process.exitCode = 1;
});
'@
$InventoryOutput = @($InventoryProbe | & $TrustedNode $TrustedCorepackScript pnpm exec tsx -)
$InventoryExitCode = $LASTEXITCODE
if ($InventoryExitCode -ne 0 -or $InventoryOutput.Count -ne 1 -or
    [string]$InventoryOutput[0] -cne 'MIGRATED_AUTHORITY_ONLY_EMPTY') {
  throw 'MIGRATED_AUTHORITY_ONLY_EMPTY_FAILED'
}
```

The single `MIGRATED_AUTHORITY_ONLY_EMPTY` line is the
migrated authority-only empty inventory proof. Stop on any other result. Only now create and independently
verify the migrated-empty encrypted backup. Load
`GUSTAVO_BACKUP_DATABASE_URL` from the same approved secret channel and select
new, owner-protected absolute paths outside the repository:

```powershell
$BackupDestination = 'D:\gustavo-backups\<new-generation>'
$BackupKeyFile = 'D:\gustavo-secrets\<backup-key-file>'
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File infra/backup/create.ps1 `
  -DestinationDirectory $BackupDestination -KeyFile $BackupKeyFile `
  -KeyVersion 'production-k1' -PgDumpPath $TrustedPgDump -PsqlPath $TrustedPsql `
  -ExpectedSchemaVersion '0022_hybrid_deployment.sql' -ExpectedEventHighWater '0'
$BackupCreateExitCode = $LASTEXITCODE
if ($BackupCreateExitCode -ne 0) { throw 'ENCRYPTED_BACKUP_CREATE_FAILED' }
$BackupManifest = Join-Path $BackupDestination 'backup.manifest.json'
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File infra/backup/verify.ps1 `
  -ManifestPath $BackupManifest -KeyFile $BackupKeyFile
$BackupVerifyExitCode = $LASTEXITCODE
if ($BackupVerifyExitCode -ne 0) { throw 'ENCRYPTED_BACKUP_VERIFY_FAILED' }
```

Keep the key outside Neon, Vercel, the repository, and application environment.
Do not proceed unless `create.ps1` and `verify.ps1` authenticate and decrypt the
same schema `0022_hybrid_deployment.sql`, event high-water `0` generation.

Finally issue exactly one invitation. Capture stdout directly into the operator
password manager; never print, log, screenshot, or commit it:

```powershell
$InvitationOutput = @(& $TrustedNode $TrustedCorepackScript pnpm production:bootstrap)
$BootstrapExitCode = $LASTEXITCODE
if ($BootstrapExitCode -ne 0 -or $InvitationOutput.Count -ne 1) {
  throw 'PRODUCTION_BOOTSTRAP_FAILED'
}
$InvitationUrl = ([string]$InvitationOutput[0]).Trim()
if ($InvitationUrl -notmatch '^https://gustavo\.lol/join\?token=') {
  throw 'PRODUCTION_BOOTSTRAP_FAILED'
}
# Paste $InvitationUrl directly into the operator password manager, then clear it.
$InvitationUrl = $null
foreach ($Name in @(
  'DATABASE_URL', 'GUSTAVO_APP_ORIGIN', 'GUSTAVO_DEPLOYMENT_PROFILE',
  'GUSTAVO_EVENT_ROOT_KEY_VERSION', 'GUSTAVO_EVENT_ROOT_KEY_V1'
)) {
  [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
}
```

## 5. Create the local materializer identity and worker

Migration 0022 creates the NOLOGIN role `gustavo_market_materializer`. In Neon,
create a separate local-only login with an independently generated credential,
grant it only that role, and verify both sides:

- the local login is a member of `gustavo_market_materializer`;
- the ordinary Vercel login is not a member and cannot insert a consumption
  binding.

Its pooled `GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL` must never be set in Vercel and must never be forwarded to Codex, Finnhub, or QStash. Load it and the
other names from `infra/env.example` into the dedicated worker process without
echoing them. The protected local input uses
`GUSTAVO_HYBRID_PUBLIC_WAKE_URL`; it does not use the hosted variable.
If the materializer credential is missing or misgranted, quote consumption
degrades safely to unavailable and never falls back to the ordinary login. To
rotate it, create and validate a new role-only login, replace the protected value
through maintenance, smoke materialization, and only then revoke the old login.

Run initial setup only through the trusted script authority:

```powershell
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hybrid-worker.ps1 `
  -ConfirmDockerDesktopPersonal
$SetupExitCode = $LASTEXITCODE
if ($SetupExitCode -ne 0) { throw 'HYBRID_WORKER_SETUP_FAILED' }
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/start-hybrid-worker.ps1 `
  -ValidateOnly
$ValidateStartExitCode = $LASTEXITCODE
if ($ValidateStartExitCode -ne 0) { throw 'HYBRID_WORKER_VALIDATE_FAILED' }
$TaskStartObservedAt = Get-Date
Start-ScheduledTask -TaskPath '\' -TaskName 'Gustavo Hybrid Worker' -ErrorAction Stop
$TaskProofDeadline = (Get-Date).AddSeconds(60)
do {
  $StartedTask = Get-ScheduledTask -TaskPath '\' -TaskName 'Gustavo Hybrid Worker' -ErrorAction Stop
  $StartedTaskInfo = Get-ScheduledTaskInfo -TaskPath '\' -TaskName 'Gustavo Hybrid Worker' -ErrorAction Stop
  if ($StartedTask.State -ceq 'Running' -and
      $StartedTaskInfo.LastRunTime -ge $TaskStartObservedAt.AddSeconds(-2)) {
    break
  }
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $TaskProofDeadline)
if ($StartedTask.State -cne 'Running' -or
    $StartedTaskInfo.LastRunTime -lt $TaskStartObservedAt.AddSeconds(-2)) {
  throw 'POST_START_WORKER_PROOF_FAILED'
}
$PostStartValidationOutput = @(& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/start-hybrid-worker.ps1 -ValidateOnly)
$PostStartValidationExitCode = $LASTEXITCODE
if ($PostStartValidationExitCode -ne 0 -or
    $PostStartValidationOutput.Count -ne 1 -or
    [string]$PostStartValidationOutput[0] -cne 'HYBRID_WORKER_VALIDATION_COMPLETE') {
  throw 'POST_START_WORKER_PROOF_FAILED'
}
```

The setup owns the KnownFolder config path, reparse/ACL validation, exact
executables, pinned Codex image/digest, dedicated auth volume, device login,
role validation, and exact task. The worker binds loopback first and Funnel only
after readiness. It runs one fixed labeled Codex container at a time with no
repository, Docker socket, or application-secret mount. Do not continue to
cutover until authenticated operator health proves fresh `CODEX`, `MARKET`, and
`TUNNEL` availability, the expected task and single labeled container, and a
ready Funnel; a merely running scheduled task is insufficient authority.

## 6. Create exactly two paused schedules

Use the Upstash dashboard to create exactly these schedules and record their
nonsecret IDs. Leave both paused:

1. Every 15 minutes, QStash sends `POST` to
   `https://gustavo.lol/api/internal/maintenance` with exact body
   `{"operation":"maintenance"}`.
2. Every five minutes, QStash sends `POST` to the protected Funnel `/wake`
   endpoint with exact fixed body `{"kind":"MARKET_CURRENT"}`.

QStash signs fixed bytes and supplies no timestamp. After signature, exact
URL/body, replay-receipt, and quota checks pass, the local worker derives the
PostgreSQL current five-minute bucket. Reservation rechecks that bucket before
provider work; a boundary crossing skips without a provider call, quota change,
latest mutation, or historical poll. There is no dynamic schedule timestamp,
host-clock market authority, hosted relay, or third schedule. Direct chat
publishes an additional signed opaque job wake, not another schedule.

## 7. Deploy and smoke Preview

Re-run the clean reviewed pushed HEAD proof immediately before deployment.
Create Preview with the pinned CLI and record its URL without printing secrets:

```powershell
$PreviewHead = Assert-ReviewedPushedHead
if ($PreviewHead -cne $ReviewedHead) { throw 'REVIEWED_HEAD_CHANGED' }
$PreviewDeployOutput = @(Invoke-TrustedVercel deploy)
$PreviewDeployExitCode = $LASTEXITCODE
if ($PreviewDeployExitCode -ne 0) { throw 'PREVIEW_DEPLOY_FAILED' }
$PreviewUrl = Assert-SingleCanonicalDeploymentUrl $PreviewDeployOutput 'PREVIEW_URL_INVALID'
$PreviewInspectOutput = @(Invoke-TrustedVercel inspect $PreviewUrl --json)
$PreviewInspectExitCode = $LASTEXITCODE
if ($PreviewInspectExitCode -ne 0) { throw 'PREVIEW_INSPECT_FAILED' }
$PreviewInspectJson = ConvertFrom-StrictJsonObject $PreviewInspectOutput 'PREVIEW_INSPECT_JSON_INVALID'
$PreviewInspection = Assert-DeploymentInspection $PreviewInspectJson $PreviewUrl 'PREVIEW_INSPECTION_INVALID'
$PreviewSourceOutput = @(Invoke-TrustedVercel api "/v13/deployments/$($PreviewInspection.id)" --raw)
$PreviewSourceExitCode = $LASTEXITCODE
if ($PreviewSourceExitCode -ne 0) { throw 'PREVIEW_SOURCE_FAILED' }
$PreviewSourceJson = ConvertFrom-StrictJsonObject $PreviewSourceOutput 'PREVIEW_SOURCE_JSON_INVALID'
$PreviewSource = Assert-DeploymentSource $PreviewSourceJson $PreviewInspection $PreviewHead 'PREVIEW_SOURCE_INVALID'
```

In the CLI inspection and Vercel dashboard, prove Ready, Node 24, pnpm 11.16.0,
the deployment ID, and deployment source metadata whose commit SHA exactly
matches the upload authority and exactly matches $PreviewHead. Preview is an
early hosted gate with the bridge disabled. Run
the Preview checks in [SMOKE_TEST.md](./SMOKE_TEST.md); never promote Preview as
the production artifact.

## 8. Stage Production, smoke it, and promote without rebuild

Before the staged build, put the hosted `GUSTAVO_HYBRID_WAKE_URL` in Production
and set `GUSTAVO_HYBRID_BRIDGE_ENABLED=true` through the dashboard or interactive
stdin. This activates direct-chat publication in the artifact about to be
built. Recurring market admission remains disabled because the exact market
schedule is paused.

Create a production-environment artifact without assigning domains:

```powershell
$StagedHead = Assert-ReviewedPushedHead
if ($StagedHead -cne $ReviewedHead) { throw 'REVIEWED_HEAD_CHANGED' }
$StagedProductionDeployOutput = @(Invoke-TrustedVercel --prod --skip-domain)
$StagedProductionDeployExitCode = $LASTEXITCODE
if ($StagedProductionDeployExitCode -ne 0) { throw 'STAGED_PRODUCTION_DEPLOY_FAILED' }
$StagedProductionUrl = Assert-SingleCanonicalDeploymentUrl $StagedProductionDeployOutput 'STAGED_PRODUCTION_URL_INVALID'
$StagedProductionInspectOutput = @(Invoke-TrustedVercel inspect $StagedProductionUrl --json)
$StagedProductionInspectExitCode = $LASTEXITCODE
if ($StagedProductionInspectExitCode -ne 0) { throw 'STAGED_PRODUCTION_INSPECT_FAILED' }
$StagedProductionInspectJson = ConvertFrom-StrictJsonObject $StagedProductionInspectOutput 'STAGED_PRODUCTION_INSPECT_JSON_INVALID'
$StagedProductionInspection = Assert-DeploymentInspection $StagedProductionInspectJson $StagedProductionUrl 'STAGED_PRODUCTION_INSPECTION_INVALID'
$StagedProductionSourceOutput = @(Invoke-TrustedVercel api "/v13/deployments/$($StagedProductionInspection.id)" --raw)
$StagedProductionSourceExitCode = $LASTEXITCODE
if ($StagedProductionSourceExitCode -ne 0) { throw 'STAGED_PRODUCTION_SOURCE_FAILED' }
$StagedProductionSourceJson = ConvertFrom-StrictJsonObject $StagedProductionSourceOutput 'STAGED_PRODUCTION_SOURCE_JSON_INVALID'
$StagedProductionSource = Assert-DeploymentSource $StagedProductionSourceJson $StagedProductionInspection $StagedHead 'STAGED_PRODUCTION_SOURCE_INVALID'
```

Prove its deployment source metadata exactly matches $StagedHead. Against that staged URL,
run public leakage, invitation/session, authenticated chat/market/health,
95-result, one-active-container, lease/quota, PC-offline/reconnect,
retained-window recovery, and rollback smoke. Use bounded signed one-shot wakes
while both recurring schedules remain paused. Stop on any leak, paid fallback,
source mismatch, unsafe recovery, or unproven container absence.

Promote only the same smoked URL:

```powershell
Invoke-TrustedVercel promote $StagedProductionUrl --yes
$StagedProductionPromoteExitCode = $LASTEXITCODE
if ($StagedProductionPromoteExitCode -ne 0) { throw 'STAGED_PRODUCTION_PROMOTE_FAILED' }
$PromotedStagedProductionInspectOutput = @(Invoke-TrustedVercel inspect $StagedProductionUrl --json)
$PromotedStagedProductionInspectExitCode = $LASTEXITCODE
if ($PromotedStagedProductionInspectExitCode -ne 0) { throw 'PROMOTED_PRODUCTION_INSPECT_FAILED' }
$PromotedStagedProductionInspectJson = ConvertFrom-StrictJsonObject $PromotedStagedProductionInspectOutput 'PROMOTED_PRODUCTION_INSPECT_JSON_INVALID'
$PromotedStagedProductionInspection = Assert-DeploymentInspection $PromotedStagedProductionInspectJson $StagedProductionUrl 'PROMOTED_PRODUCTION_INSPECTION_INVALID'
$PromotedStagedProductionSourceOutput = @(Invoke-TrustedVercel api "/v13/deployments/$($PromotedStagedProductionInspection.id)" --raw)
$PromotedStagedProductionSourceExitCode = $LASTEXITCODE
if ($PromotedStagedProductionSourceExitCode -ne 0) { throw 'PROMOTED_PRODUCTION_SOURCE_FAILED' }
$PromotedStagedProductionSourceJson = ConvertFrom-StrictJsonObject $PromotedStagedProductionSourceOutput 'PROMOTED_PRODUCTION_SOURCE_JSON_INVALID'
$PromotedStagedProductionSource = Assert-DeploymentSource $PromotedStagedProductionSourceJson $PromotedStagedProductionInspection $StagedHead 'PROMOTED_PRODUCTION_SOURCE_INVALID'
if ($PromotedStagedProductionInspection.id -cne $StagedProductionInspection.id -or
    $PromotedStagedProductionSource.meta.githubCommitSha -cne $StagedProductionSource.meta.githubCommitSha) {
  throw 'PRODUCTION_PROMOTION_REBUILT'
}
```

Prove the same deployment ID and git SHA survived promotion—there must be no
rebuild. Verify apex TLS and the configured `www` redirect. Then unpause the
maintenance schedule, verify one delivery, unpause the market schedule, verify
one exact `MARKET_CURRENT` delivery, and repeat public/authenticated smoke.

## 9. Daily limits, offline behavior, and recovery

Check the provider dashboards and authenticated operator health daily:

- QStash Free: 1,000 messages/day provider ceiling; Gustavo enforces the
  900 messages/day application cap.
- Codex: 100 jobs/current UTC day and one active container/job.
- Finnhub: at most 96 calls/window and exactly 95 result states/window.
- Redis: protected TTL 300 seconds, negative TTL 30 seconds, and only the
  bounded `gustavo-cache:v1:` topology.
- Neon: exactly 95 latest quote rows/account and poll summaries retained seven
  days; verify Free compute/storage and the migration ledger.

At a limit, only that feature degrades. Never enable overage, paid capacity, a
second Codex job, faster Finnhub pacing, or a fallback provider.

If the PC, Funnel, Docker, Codex login, or worker is offline, the public site and
stored history remain hosted. Messages remain durable and queued, market data
becomes stale, and local health becomes offline. Existing accepted five-minute
and direct wakes coalesce a database-clock CODEX lease refresh; there is no independent timer, poller, or schedule. Two missed five-minute wake intervals
make a heartbeat older than 12 minutes and offline. A fresh heartbeat with the
current-day Codex counter at 100 is quota-limited.

On reconnect, startup reconciles the exact container and drains durable jobs
exactly once. A retained prior incomplete market window becomes `FAILED` once
before its seven-day `prune_after` with no provider calls, quota re-reservation,
or latest-row mutation. An already pruned row is cleanup-only. Only a newly
reserved current window may call Finnhub; reconnect never re-polls history.

## 10. Reviewed worker maintenance

For an image rebuild, Codex re-authentication, or worker-secret rotation, first
materialize the bridge-disabled artifact, pause the exact schedules, and settle
claimed/active work as described in section 11. Then use the reviewed operator
stop and require its exact proof before loading replacement values:

```powershell
$StopProof = Stop-ReviewedHybridWorker
if ($StopProof -cne 'HYBRID_WORKER_MAINTENANCE_STOPPED') {
  throw 'HYBRID_MAINTENANCE_STOP_UNPROVEN'
}
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hybrid-worker.ps1 -MaintenanceRebuild `
  -ConfirmDockerDesktopPersonal
$MaintenanceRebuildExitCode = $LASTEXITCODE
if ($MaintenanceRebuildExitCode -ne 0) { throw 'HYBRID_MAINTENANCE_REBUILD_FAILED' }
```

For a suspected Codex credential compromise, use the sole reviewed rotation
entry point:

```powershell
& $TrustedPowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-hybrid-worker.ps1 -MaintenanceRebuild -RotateCodexAuthVolume `
  -ConfirmDockerDesktopPersonal
$MaintenanceRotateExitCode = $LASTEXITCODE
if ($MaintenanceRotateExitCode -ne 0) { throw 'HYBRID_MAINTENANCE_ROTATE_FAILED' }
```

Do not move or copy the protected configuration, call Docker manually, remove
an auth volume yourself, or create a plaintext backup of worker secrets. The
maintenance authority holds the fixed named-pipe lease, refuses a running task
or present exact container, rebuilds and validates the pinned image/login,
writes an ACL-sealed same-directory temporary config, atomically replaces it,
validates it, and only then registers the exact task. After new config, worker,
and smoke succeed, revoke/retire the replaced Neon, Finnhub, QStash, Funnel, or
Codex credential at its provider. Failure remains bridge-disabled and
schedule-paused.

## 11. Bridge disable, market shutdown, and rollback

An environment edit is not a deployed control. First set
`GUSTAVO_HYBRID_BRIDGE_ENABLED=false`, create a new staged Production artifact
with the trusted pinned CLI, smoke public/history/auth/queued behavior, and
exact-promote that same bridge-disabled artifact. Confirm the canonical domains
serve its unchanged deployment ID and SHA.

```powershell
$BridgeDisabledHead = Assert-ReviewedPushedHead
if ($BridgeDisabledHead -cne $ReviewedHead) { throw 'REVIEWED_HEAD_CHANGED' }
$BridgeDisabledDeployOutput = @(Invoke-TrustedVercel --prod --skip-domain)
$BridgeDisabledDeployExitCode = $LASTEXITCODE
if ($BridgeDisabledDeployExitCode -ne 0) { throw 'BRIDGE_DISABLED_DEPLOY_FAILED' }
$BridgeDisabledUrl = Assert-SingleCanonicalDeploymentUrl $BridgeDisabledDeployOutput 'BRIDGE_DISABLED_URL_INVALID'
$BridgeDisabledInspectOutput = @(Invoke-TrustedVercel inspect $BridgeDisabledUrl --json)
$BridgeDisabledInspectExitCode = $LASTEXITCODE
if ($BridgeDisabledInspectExitCode -ne 0) { throw 'BRIDGE_DISABLED_INSPECT_FAILED' }
$BridgeDisabledInspectJson = ConvertFrom-StrictJsonObject $BridgeDisabledInspectOutput 'BRIDGE_DISABLED_INSPECT_JSON_INVALID'
$BridgeDisabledInspection = Assert-DeploymentInspection $BridgeDisabledInspectJson $BridgeDisabledUrl 'BRIDGE_DISABLED_INSPECTION_INVALID'
$BridgeDisabledSourceOutput = @(Invoke-TrustedVercel api "/v13/deployments/$($BridgeDisabledInspection.id)" --raw)
$BridgeDisabledSourceExitCode = $LASTEXITCODE
if ($BridgeDisabledSourceExitCode -ne 0) { throw 'BRIDGE_DISABLED_SOURCE_FAILED' }
$BridgeDisabledSourceJson = ConvertFrom-StrictJsonObject $BridgeDisabledSourceOutput 'BRIDGE_DISABLED_SOURCE_JSON_INVALID'
$BridgeDisabledSource = Assert-DeploymentSource $BridgeDisabledSourceJson $BridgeDisabledInspection $BridgeDisabledHead 'BRIDGE_DISABLED_SOURCE_INVALID'
# Run the complete bridge-disabled staged smoke before the next command.
Invoke-TrustedVercel promote $BridgeDisabledUrl --yes
$BridgeDisabledPromoteExitCode = $LASTEXITCODE
if ($BridgeDisabledPromoteExitCode -ne 0) { throw 'BRIDGE_DISABLED_PROMOTE_FAILED' }
$PromotedBridgeDisabledInspectOutput = @(Invoke-TrustedVercel inspect $BridgeDisabledUrl --json)
$PromotedBridgeDisabledInspectExitCode = $LASTEXITCODE
if ($PromotedBridgeDisabledInspectExitCode -ne 0) { throw 'PROMOTED_BRIDGE_DISABLED_INSPECT_FAILED' }
$PromotedBridgeDisabledInspectJson = ConvertFrom-StrictJsonObject $PromotedBridgeDisabledInspectOutput 'PROMOTED_BRIDGE_DISABLED_INSPECT_JSON_INVALID'
$PromotedBridgeDisabledInspection = Assert-DeploymentInspection $PromotedBridgeDisabledInspectJson $BridgeDisabledUrl 'PROMOTED_BRIDGE_DISABLED_INSPECTION_INVALID'
$PromotedBridgeDisabledSourceOutput = @(Invoke-TrustedVercel api "/v13/deployments/$($PromotedBridgeDisabledInspection.id)" --raw)
$PromotedBridgeDisabledSourceExitCode = $LASTEXITCODE
if ($PromotedBridgeDisabledSourceExitCode -ne 0) { throw 'PROMOTED_BRIDGE_DISABLED_SOURCE_FAILED' }
$PromotedBridgeDisabledSourceJson = ConvertFrom-StrictJsonObject $PromotedBridgeDisabledSourceOutput 'PROMOTED_BRIDGE_DISABLED_SOURCE_JSON_INVALID'
$PromotedBridgeDisabledSource = Assert-DeploymentSource $PromotedBridgeDisabledSourceJson $PromotedBridgeDisabledInspection $BridgeDisabledHead 'PROMOTED_BRIDGE_DISABLED_SOURCE_INVALID'
if ($PromotedBridgeDisabledInspection.id -cne $BridgeDisabledInspection.id -or
    $PromotedBridgeDisabledSource.meta.githubCommitSha -cne $BridgeDisabledSource.meta.githubCommitSha) {
  throw 'BRIDGE_DISABLED_PROMOTION_REBUILT'
}
```

Only after bridge disable owns the domains:

1. In Upstash, pause the exact five-minute market schedule. Also pause the exact
   15-minute maintenance schedule for full rollback.
2. Invoke the reviewed `-StopForMaintenance` client and require the exact proof:

   ```powershell
   $StopProof = Stop-ReviewedHybridWorker
   if ($StopProof -cne 'HYBRID_WORKER_MAINTENANCE_STOPPED') {
     throw 'HYBRID_MAINTENANCE_STOP_UNPROVEN'
   }
   ```

   The reviewed launcher authenticates the owner/SYSTEM-only local pipe, closes
   worker admission, settles admitted and claimed work, proves the exact container absent,
   turns Funnel off, and rechecks the exact root task before returning
   `HYBRID_WORKER_MAINTENANCE_STOPPED`. An unproven stop remains fail-closed.
   Never terminate the task/process, invoke Funnel directly, or issue a forced
   container command.

   Do not wait for or delete unclaimed work after that proof: durable PENDING jobs remain queued for reconnect recovery.

3. Delete only the two recorded mission schedule IDs if this is a real rollback;
   a rehearsal keeps them paused.

A prior Vercel artifact is eligible only when it is Ready, already
bridge-disabled, publicly leak-free, and schema-compatible, with its deployment
ID and reviewed SHA recorded. Otherwise check out the exact reviewed previous
commit—or safe-shell commit
`a0c90dc15390e5accbb42869965e5347f7576b3f`—in a clean operator checkout,
create and push a rollback branch whose upstream is that exact reviewed source,
then start a new approved console with the trusted authorities and helpers from
sections 1 and 2. Enter the separately approved reviewed/pushed SHA; do not
silently resample it into the immutable record:

```powershell
$ApprovedRollbackHead = Read-Host -Prompt 'Enter exact reviewed and pushed rollback SHA'
if ($ApprovedRollbackHead -cnotmatch '^[a-f0-9]{40}$') {
  throw 'ROLLBACK_REVIEWED_HEAD_INVALID'
}
$ObservedRollbackHead = Assert-ReviewedPushedHead
if ($ObservedRollbackHead -cne $ApprovedRollbackHead) {
  throw 'ROLLBACK_REVIEWED_HEAD_CHANGED'
}
$ReviewedHead = $ApprovedRollbackHead
```

Treat that `$ReviewedHead` as immutable. Repeat the bridge-disabled artifact
commands above; their immediate observed-head equality must pass. Materialize
bridge-disabled Production authority, build with
`--prod --skip-domain`, smoke the staged URL, and exact-promote it without a
rebuild. Never roll back to an enabled or unproven artifact.

Migration 0022 is additive and forward-only. Leave it and its tables in place;
never edit historical migrations. Resource deletion is a separate approved
decommission after encrypted-backup and retention review. Restoration repeats
the full staged bridge-enabled smoke and exact promotion before recreating or
unpausing schedules.
