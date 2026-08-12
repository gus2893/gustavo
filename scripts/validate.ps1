param(
  [string]$AdditionalScanFixture,
  [string]$AdditionalScanFixtureVirtualPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$pathComparison = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
  [StringComparison]::OrdinalIgnoreCase
} else {
  [StringComparison]::Ordinal
}
$javaScriptTokenPattern = New-Object Text.RegularExpressions.Regex(
  '("(?:\\.|[^"\\])*")|(''(?:\\.|[^''\\])*'')|(`(?:\\.|[^`\\])*`)|(/\*[\s\S]*?\*/|//[^\r\n]*)',
  ([Text.RegularExpressions.RegexOptions]::CultureInvariant -bor
    [Text.RegularExpressions.RegexOptions]::Compiled)
)
$javaScriptCommentReplacement = [Text.RegularExpressions.MatchEvaluator]{
  param([Text.RegularExpressions.Match]$Token)
  if ($Token.Groups[4].Success) {
    return [Text.RegularExpressions.Regex]::Replace($Token.Value, '[^\r\n]', ' ')
  }
  return $Token.Value
}

if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot '.git') -PathType Container) -or
    -not (Test-Path -LiteralPath (Join-Path $repositoryRoot 'package.json') -PathType Leaf)) {
  throw 'Validation must run from a Gustavo repository checkout.'
}

function Get-RepositoryPath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  if ([IO.Path]::IsPathRooted($RelativePath)) {
    throw "Repository path must be relative: $RelativePath"
  }

  $fullPath = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $RelativePath))
  if (-not $fullPath.StartsWith($repositoryPrefix, $pathComparison)) {
    throw "Repository path escaped the checkout: $RelativePath"
  }
  return $fullPath
}

function Get-RelativeRepositoryPath {
  param([Parameter(Mandatory = $true)][string]$FullPath)

  $canonical = [IO.Path]::GetFullPath($FullPath)
  if (-not $canonical.StartsWith($repositoryPrefix, $pathComparison)) {
    throw 'Discovered a file outside the repository root.'
  }
  return $canonical.Substring($repositoryPrefix.Length).Replace('\', '/')
}

function Read-RepositoryText {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $path = Get-RepositoryPath $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Missing required file: $RelativePath"
  }
  return Get-Content -LiteralPath $path -Raw -Encoding UTF8
}

function Assert-NoPattern {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Files,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Pattern
  )

  $regex = New-Object Text.RegularExpressions.Regex(
    $Pattern,
    ([Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
      [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  )
  foreach ($file in $Files) {
    if ($regex.IsMatch($file.Source)) {
      throw "Safety violation ($Label) in $($file.Path)."
    }
  }
}

function Get-ShannonEntropy {
  param([Parameter(Mandatory = $true)][string]$Value)

  if ($Value.Length -eq 0) {
    return 0.0
  }
  $counts = @{}
  foreach ($character in $Value.ToCharArray()) {
    $key = [string]$character
    $counts[$key] = 1 + [int]($counts[$key])
  }
  $entropy = 0.0
  foreach ($count in $counts.Values) {
    $probability = [double]$count / [double]$Value.Length
    $entropy -= $probability * [Math]::Log($probability, 2)
  }
  return $entropy
}

function Assert-NoHighEntropyLiteral {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Files)

  $literalPattern = New-Object Text.RegularExpressions.Regex('["'']([A-Za-z0-9+/_=-]{32,})["'']')
  foreach ($file in $Files) {
    foreach ($match in $literalPattern.Matches($file.Source)) {
      $value = $match.Groups[1].Value
      if ($value -cmatch '[a-z]' -and $value -cmatch '[A-Z]' -and $value -match '[0-9]' -and
          (Get-ShannonEntropy $value) -ge 4.3) {
        throw "Safety violation (high-entropy literal) in $($file.Path)."
      }
    }
  }
}

function Assert-ExactFakeProviderGuard {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Source
  )

  if ($Path -cne 'lib/server/models/gateway.ts') {
    throw "Unsafe fake-provider guard path: $Path"
  }
  $allFakeAuthority = New-Object Text.RegularExpressions.Regex(
    'providerId\s*(===|:)\s*["'']fake["'']',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  $exactProductionGuard = New-Object Text.RegularExpressions.Regex(
    'if\s*\(\s*production\s*&&\s*config\.providerId\s*===\s*["'']fake["'']\s*\)\s*\{\s*throw\s+new\s+Error\s*\(\s*`PRODUCTION_MODEL_PROVIDER_INVALID:\$\{role\}`\s*\)\s*;?\s*\}',
    [Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if ($allFakeAuthority.Matches($Source).Count -ne 1 -or
      $exactProductionGuard.Matches($Source).Count -ne 1) {
    throw "Safety violation (fake provider authority) in $Path."
  }
}

function Remove-JavaScriptCommentsPreservingStrings {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Source)

  # Match strings before comments so comment-looking text inside a literal is preserved.
  return $javaScriptTokenPattern.Replace($Source, $javaScriptCommentReplacement)
}

function Get-NormalModuleTarget {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$Specifier
  )

  $target = $Specifier.Replace('\', '/') -replace '[?#].*$', ''
  $target = $target -replace '\.[cm]?[jt]sx?$', ''
  $target = $target -replace '/index$', ''
  if (-not $target.StartsWith('.')) {
    return $target
  }

  $sourceDirectory = [IO.Path]::GetDirectoryName(
    $SourcePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
  )
  if ([string]::IsNullOrEmpty($sourceDirectory)) {
    $sourceDirectory = '.'
  }
  $combined = [IO.Path]::GetFullPath((Join-Path $repositoryRoot (Join-Path $sourceDirectory $target)))
  if (-not $combined.StartsWith($repositoryPrefix, $pathComparison)) {
    return ''
  }
  return (Get-RelativeRepositoryPath $combined)
}

function Test-ImportsFakeProvider {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Source
  )

  $uncommented = Remove-JavaScriptCommentsPreservingStrings $Source
  $modulePattern = New-Object Text.RegularExpressions.Regex(
    '\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'']([^"''\r\n]+)["'']',
    ([Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
      [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  )
  foreach ($match in $modulePattern.Matches($uncommented)) {
    $target = Get-NormalModuleTarget -SourcePath $Path -Specifier $match.Groups[1].Value
    if ($target -ceq 'lib/server/models/fake' -or
        (-not $target.StartsWith('.') -and $target -match '(^|/)models/fake$')) {
      return $true
    }
  }
  return $false
}

$requiredFiles = @(
  'README.md',
  'AGENTS.md',
  'docs/SECURITY.md',
  'docs/PRIVACY.md',
  'docs/TERMS.md',
  'docs/DATA_POLICY.md',
  'policy/editorial-policy.json',
  'package.json'
)
foreach ($relativePath in $requiredFiles) {
  $null = Read-RepositoryText $relativePath
}

# Historical migration evidence is excluded by exact path only. Active application,
# worker, component, and configuration paths can never be added to this allowlist.
$AuditOnlyPathAllowlist = @(
  'docs/API_CONTRACTS.md',
  'docs/DECISION_HISTORY.md',
  'docs/ETH_CONTEXT.md',
  'docs/EXPORTS_AND_SYMBOLS.md',
  'docs/GRADING_AND_RISK.md',
  'docs/MECHANISM.md',
  'policy/lab-policy.json',
  'state/current-profile.json',
  'state/latest-market-context.json'
)
foreach ($relativePath in $AuditOnlyPathAllowlist) {
  if ($relativePath -match '^(app|components|db|lib|scripts|worker|tests?|fixtures?|debug)(/|$)') {
    throw "Unsafe audit-only allowlist entry: $relativePath"
  }
  $null = Read-RepositoryText $relativePath
}

# The deterministic fake provider is the sole production-tree test-support file.
# Production entrypoints may not import it, and startup rejects enabled fixtures.
$TestSupportPathAllowlist = @('lib/server/models/fake.ts')
foreach ($relativePath in $TestSupportPathAllowlist) {
  if ($relativePath -notmatch '^lib/server/models/fake\.ts$') {
    throw "Unsafe test-support allowlist entry: $relativePath"
  }
  $null = Read-RepositoryText $relativePath
}

$FakeProviderGuardAllowlist = [PSCustomObject]@{
  Path = 'lib/server/models/gateway.ts'
  Occurrence = 'production && config.providerId === "fake"'
}
$gatewaySource = Read-RepositoryText $FakeProviderGuardAllowlist.Path
if (-not $gatewaySource.Contains($FakeProviderGuardAllowlist.Occurrence)) {
  throw 'The exact fake-provider production guard is missing.'
}
Assert-ExactFakeProviderGuard -Path $FakeProviderGuardAllowlist.Path -Source $gatewaySource

$FakeProviderTestPathAllowlist = @('tests/models/gateway-audit.test.ts')
foreach ($relativePath in $FakeProviderTestPathAllowlist) {
  if ($relativePath -cne 'tests/models/gateway-audit.test.ts') {
    throw "Unsafe fake-provider test allowlist entry: $relativePath"
  }
  $testSource = Read-RepositoryText $relativePath
  if ($testSource -notmatch 'from\s+["'']\.\./\.\./lib/server/models/fake["'']') {
    throw "Approved fake-provider test no longer uses the exact test module: $relativePath"
  }
}

# No debug path is allowed in the production tree. Keeping this explicit prevents
# a directory-wide fixture exception from being introduced silently.
$DebugPathAllowlist = @()
if ($DebugPathAllowlist.Count -ne 0) {
  throw 'Debug path allowlist must remain empty.'
}

# These exact SQL tokens are authoritative schema/filter vocabulary, not executable
# broker behavior. The files remain fully scanned with contextual execution rules.
$MigrationEvidenceAllowlist = @(
  [PSCustomObject]@{ Path = 'db/migrations/0002_identity.sql'; Pattern = 'password_credentials' },
  [PSCustomObject]@{ Path = 'db/migrations/0010_challenge_ledger.sql'; Pattern = 'EXCHANGE_FEE' },
  [PSCustomObject]@{ Path = 'db/migrations/0019_privacy_controls.sql'; Pattern = 'position|execution' }
)
foreach ($evidence in $MigrationEvidenceAllowlist) {
  $source = Read-RepositoryText $evidence.Path
  if (-not $source.Contains($evidence.Pattern)) {
    throw "Missing exact migration evidence in $($evidence.Path)."
  }
}

$ValidatorSelfAllowlist = @('scripts/validate.ps1')
if ($ValidatorSelfAllowlist.Count -ne 1 -or
    $ValidatorSelfAllowlist[0] -cne 'scripts/validate.ps1') {
  throw 'Validator self-allowlist must contain one exact path.'
}

$jsonPaths = @('package.json', 'policy/editorial-policy.json')
foreach ($relativePath in $jsonPaths) {
  try {
    $null = Read-RepositoryText $relativePath | ConvertFrom-Json
  } catch {
    throw "Invalid JSON in $relativePath."
  }
}

$policy = Read-RepositoryText 'policy/editorial-policy.json' | ConvertFrom-Json
$expectedSimulationLabel = "SIMULATION ONLY $([char]0x2014) NOT A REAL TRADE"
if ($policy.realExecutionEnabled -ne $false) {
  throw 'Safety violation: realExecutionEnabled must be false.'
}
if ($policy.claimsSentience -ne $false) {
  throw 'Safety violation: claimsSentience must be false.'
}
if ($policy.simulationDisclaimer -cne $expectedSimulationLabel) {
  throw 'Safety violation: the exact simulation disclaimer is missing.'
}

$SafetyScanRoots = @(
  'app',
  'components',
  'db/migrations',
  'lib',
  'scripts',
  'worker',
  'infra/compose.yaml',
  'infra/env.example',
  'instrumentation.ts',
  'next.config.ts',
  'package.json',
  'policy/editorial-policy.json'
)
$textExtensions = @('.cjs', '.env', '.js', '.json', '.mjs', '.ps1', '.sql', '.ts', '.tsx', '.yaml', '.yml')
$sourceFiles = New-Object Collections.Generic.List[object]
foreach ($relativeRoot in $SafetyScanRoots) {
  $absoluteRoot = Get-RepositoryPath $relativeRoot
  if (-not (Test-Path -LiteralPath $absoluteRoot)) {
    throw "Missing safety scan root: $relativeRoot"
  }

  $candidates = if (Test-Path -LiteralPath $absoluteRoot -PathType Leaf) {
    @(Get-Item -LiteralPath $absoluteRoot)
  } else {
    @(Get-ChildItem -LiteralPath $absoluteRoot -Recurse -File)
  }

  foreach ($candidate in $candidates) {
    if ($textExtensions -notcontains $candidate.Extension.ToLowerInvariant()) {
      continue
    }
    if ($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw "Symbolic links are not permitted in active scan roots: $relativeRoot"
    }
    $relativePath = Get-RelativeRepositoryPath $candidate.FullName
    if ($ValidatorSelfAllowlist -contains $relativePath) {
      continue
    }
    if ($AuditOnlyPathAllowlist -contains $relativePath) {
      throw "Audit-only evidence overlaps an active scan root: $relativePath"
    }
    $sourceFiles.Add([PSCustomObject]@{
      Path = $relativePath
      Source = Get-Content -LiteralPath $candidate.FullName -Raw -Encoding UTF8
    })
  }
}

if ($AdditionalScanFixture) {
  $fixturePath = Get-RepositoryPath $AdditionalScanFixture
  $fixtureRelativePath = Get-RelativeRepositoryPath $fixturePath
  if ($fixtureRelativePath -notmatch '^\.tmp-test/security-validator/[A-Za-z0-9._-]+\.(js|ts|json|env)$' -or
      -not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
    throw 'Additional scan fixture must be a regular file in .tmp-test/security-validator.'
  }
  $fixture = Get-Item -LiteralPath $fixturePath
  if ($fixture.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Additional scan fixture cannot be a symbolic link.'
  }
  $scanPath = $fixtureRelativePath
  if ($AdditionalScanFixtureVirtualPath) {
    if ($AdditionalScanFixtureVirtualPath -notmatch '^lib/server/models/[A-Za-z0-9._-]+\.ts$' -or
        (Test-Path -LiteralPath (Get-RepositoryPath $AdditionalScanFixtureVirtualPath))) {
      throw 'Additional scan fixture virtual path must be a nonexistent TypeScript file in lib/server/models.'
    }
    $scanPath = $AdditionalScanFixtureVirtualPath
  }
  $sourceFiles.Add([PSCustomObject]@{
    Path = $scanPath
    Source = Get-Content -LiteralPath $fixturePath -Raw -Encoding UTF8
  })
} elseif ($AdditionalScanFixtureVirtualPath) {
  throw 'Additional scan fixture virtual path requires an additional scan fixture.'
}

$forbiddenPatterns = @(
  @('real-order function', '\b(place|submit|execute|route|send|export)(Real|Live|External)(Order|Trade)s?\b'),
  @('execution connector import', '\b(from|require\s*\()\s*["''][^"'']*(alpaca|ibkr|interactive-brokers|binance|coinbase-pro|broker|exchange|execution)[^"'']*["'']'),
  @('broker or exchange endpoint', 'https?://[^\s"'']*(api\.)?(alpaca\.markets|interactivebrokers\.com|binance\.com|coinbase\.com)\b'),
  @('external execution command', '\b(curl|wget|Invoke-RestMethod|Invoke-WebRequest)\b[^\r\n]*(broker|exchange|orders?|trades?|execution)'),
  @('NEXT_PUBLIC secret', '\bNEXT_PUBLIC_[A-Z0-9_]*(API_?)?(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?\b'),
  @('copy-trade language', '\b(copy[ -]?trade|buy now|sell now|execute this trade)\b'),
  @('guaranteed outcome claim', '\b(guaranteed?|promise[sd]?)\s+(profit|returns?|accuracy|performance)\b'),
  @('sentience claim', '\b(is|am|are|becomes?)\s+(truly\s+)?(sentient|conscious|self-aware)\b'),
  @('perfect-memory claim', '\b((can|does|will|Gustavo)\s+(perfect(ly)?|always)\s+(recall|remember)(s|ed|ing)?|(has|offers?)\s+perfect recall)\b'),
  @('OpenAI-style secret', '\bsk-[A-Za-z0-9_-]{20,}\b'),
  @('GitHub secret', '\bgh[pousr]_[A-Za-z0-9]{20,}\b'),
  @('AWS access key', '\b(AKIA|ASIA)[A-Z0-9]{16}\b'),
  @('private key material', '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'),
  @('assigned high-entropy secret', '\b(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)\s*[:=]\s*["'']?[A-Za-z0-9+/_=-]{20,}["'']?')
)
foreach ($check in $forbiddenPatterns) {
  Assert-NoPattern -Files $sourceFiles -Label $check[0] -Pattern $check[1]
}
Assert-NoHighEntropyLiteral -Files $sourceFiles

$package = Read-RepositoryText 'package.json' | ConvertFrom-Json
$dependencyNames = @($package.dependencies.PSObject.Properties.Name) +
  @($package.devDependencies.PSObject.Properties.Name)
$forbiddenPackages = @('alpaca', 'ib', 'ibkr', 'interactive-brokers', 'binance', 'coinbase-pro')
foreach ($dependency in $dependencyNames) {
  if ($forbiddenPackages -contains $dependency.ToLowerInvariant()) {
    throw "Safety violation (execution dependency) in package.json: $dependency."
  }
}

$routeFiles = $sourceFiles | Where-Object { $_.Path -match '^app/api/' }
foreach ($route in $routeFiles) {
  if ($route.Path -match '/(broker|exchange|execution|real-orders?|live-orders?|credentials?|test|debug|fixtures?|seed)(/|\.)') {
    throw "Safety violation (prohibited API route) in $($route.Path)."
  }
}

$nonFakeSources = @($sourceFiles | Where-Object {
  $TestSupportPathAllowlist -notcontains $_.Path
})
foreach ($file in $nonFakeSources) {
  if (Test-ImportsFakeProvider -Path $file.Path -Source $file.Source) {
    throw "Safety violation (fake provider import outside exact test-support file) in $($file.Path)."
  }
}
Assert-NoPattern -Files $nonFakeSources -Label 'fake provider use outside exact test-support file' `
  -Pattern '\bfakeModelProvider\b'
$nonFakeAuthority = @($nonFakeSources | Where-Object {
  $_.Path -cne $FakeProviderGuardAllowlist.Path
})
Assert-NoPattern -Files $nonFakeAuthority -Label 'fake provider authority outside exact guard file' `
  -Pattern 'providerId\s*:\s*["'']fake["'']'
Assert-ExactFakeProviderGuard -Path $FakeProviderGuardAllowlist.Path -Source $gatewaySource

$composeSource = Read-RepositoryText 'infra/compose.yaml'
if ($composeSource -notmatch 'GUSTAVO_TEST_FIXTURES_ENABLED:\s*["'']?false["'']?' -or
    $composeSource -match 'GUSTAVO_TEST_FIXTURES_ENABLED:\s*["'']?true["'']?') {
  throw 'Safety violation: production test fixtures must be explicitly disabled.'
}
$instrumentationSource = Read-RepositoryText 'instrumentation.ts'
if ($instrumentationSource -notmatch 'assertProductionFixturesDisabled' -or
    $instrumentationSource -notmatch 'PRODUCTION_TEST_FIXTURES_FORBIDDEN') {
  throw 'Safety violation: production startup lacks a fail-closed fixture guard.'
}

$rootBuildConfigPattern = '^(Dockerfile|instrumentation\.ts|next-env\.d\.ts|next\.config\.[cm]?[jt]s|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.[A-Za-z0-9_-]+)?\.json)$'
$BuildFreshnessInputs = @(
  @($sourceFiles | Where-Object { $_.Path -notmatch '^\.tmp-test/' } | ForEach-Object { $_.Path })
  @(Get-ChildItem -LiteralPath $repositoryRoot -File | Where-Object {
    $_.Name -match $rootBuildConfigPattern
  } | ForEach-Object { Get-RelativeRepositoryPath $_.FullName })
) | Sort-Object -Unique
$buildInputFiles = New-Object Collections.Generic.List[IO.FileInfo]
foreach ($relativePath in $BuildFreshnessInputs) {
  $absolutePath = Get-RepositoryPath $relativePath
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
    throw "Missing build freshness input: $relativePath"
  }
  $file = Get-Item -LiteralPath $absolutePath
  if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Symbolic links are not permitted in build freshness inputs: $relativePath"
  }
  $buildInputFiles.Add($file)
}

$buildMarkerPath = Get-RepositoryPath '.next/BUILD_ID'
$buildCompletionMarkerPath = Get-RepositoryPath '.next/export-marker.json'
$buildManifestPath = Get-RepositoryPath '.next/build-manifest.json'
$prerenderManifestPath = Get-RepositoryPath '.next/prerender-manifest.json'
foreach ($requiredBuildFile in @(
  $buildMarkerPath, $buildCompletionMarkerPath, $buildManifestPath, $prerenderManifestPath
)) {
  if (-not (Test-Path -LiteralPath $requiredBuildFile -PathType Leaf)) {
    throw 'A fresh completed Next build is required before validation.'
  }
}
$buildId = (Get-Content -LiteralPath $buildMarkerPath -Raw -Encoding UTF8).Trim()
if ($buildId -notmatch '^[A-Za-z0-9_-]{8,128}$') {
  throw 'Next build marker is empty or invalid.'
}
$buildCompletionMarker = Get-Item -LiteralPath $buildCompletionMarkerPath
$latestBuildInput = $buildInputFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($null -eq $latestBuildInput -or
    $buildCompletionMarker.LastWriteTimeUtc -lt $latestBuildInput.LastWriteTimeUtc) {
  throw 'Next build artifacts are stale; run pnpm build before validation.'
}

$publicArtifactRoots = @(
  '.next/static',
  '.next/server/app/index.segments',
  '.next/server/app/page',
  '.next/server/app/api/public/feed/route'
)
$publicArtifactFiles = @(
  '.next/build-manifest.json',
  '.next/prerender-manifest.json',
  '.next/server/app/index.html',
  '.next/server/app/index.rsc',
  '.next/server/app/page.js',
  '.next/server/app/page.js.map',
  '.next/server/app/page_client-reference-manifest.js',
  '.next/server/app/api/public/feed/route.js',
  '.next/server/app/api/public/feed/route.js.map',
  '.next/server/app/api/public/feed/route_client-reference-manifest.js'
)
$publicArtifactExtensions = @('.html', '.js', '.json', '.map', '.meta', '.rsc')
$publicArtifactPaths = @{}
foreach ($relativePath in $publicArtifactRoots) {
  $absolutePath = Get-RepositoryPath $relativePath
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Container)) {
    throw "Missing public build artifact directory: $relativePath"
  }
  foreach ($file in Get-ChildItem -LiteralPath $absolutePath -Recurse -File) {
    if ($publicArtifactExtensions -notcontains $file.Extension.ToLowerInvariant()) {
      continue
    }
    $relativeFile = Get-RelativeRepositoryPath $file.FullName
    $publicArtifactPaths[$relativeFile] = $file.FullName
  }
}
foreach ($relativePath in $publicArtifactFiles) {
  $absolutePath = Get-RepositoryPath $relativePath
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
    throw "Missing required public build artifact: $relativePath"
  }
  $publicArtifactPaths[$relativePath] = $absolutePath
}

$publicFiles = New-Object Collections.Generic.List[object]
foreach ($entry in $publicArtifactPaths.GetEnumerator()) {
  $publicFiles.Add([PSCustomObject]@{
    Path = $entry.Key
    Source = Get-Content -LiteralPath $entry.Value -Raw -Encoding UTF8
  })
}
if ($publicFiles.Count -lt 10) {
  throw 'Public build artifact set is unexpectedly incomplete.'
}
foreach ($check in $forbiddenPatterns | Where-Object { $_[0] -match 'secret|key material|NEXT_PUBLIC' }) {
  Assert-NoPattern -Files $publicFiles -Label "public artifact $($check[0])" -Pattern $check[1]
}
Assert-NoPattern -Files $publicFiles -Label 'browser secret name' `
  -Pattern '\b(NEXT_PUBLIC_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?|GUSTAVO_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)S?|DATABASE_URL|VALKEY_URL|POSTGRES_PASSWORD)\b'
Assert-NoHighEntropyLiteral -Files $publicFiles

$ProtectedPublicMarkers = @(
  't31-private-thesis-never-public',
  't31-ciphertext-envelope-never-public',
  't31-root-key-material-never-public',
  'private thesis text',
  'cross-account protected thesis',
  'ciphertext:private-thesis-envelope',
  'secret thesis'
)
foreach ($marker in $ProtectedPublicMarkers) {
  foreach ($file in $publicFiles) {
    if ($file.Source.Contains($marker)) {
      throw "Safety violation (protected public marker) in $($file.Path)."
    }
  }
}

Write-Output "Validated $($requiredFiles.Count) required files and $($sourceFiles.Count) active source/config files."
Write-Output "Checked $($publicFiles.Count) public build artifacts without exposing matched values."
Write-Output 'Gustavo MVP static safety boundary is intact.'
