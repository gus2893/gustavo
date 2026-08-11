$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$requiredFiles = @(
  'README.md',
  'AGENTS.md',
  'docs\MECHANISM.md',
  'docs\GRADING_AND_RISK.md',
  'docs\RUNBOOK.md',
  'docs\API_CONTRACTS.md',
  'docs\EXPORTS_AND_SYMBOLS.md',
  'docs\DECISION_HISTORY.md',
  'policy\lab-policy.json',
  'state\current-profile.json',
  'state\latest-market-context.json'
)

foreach ($relativePath in $requiredFiles) {
  $absolutePath = Join-Path $repositoryRoot $relativePath
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
    throw "Missing required file: $relativePath"
  }
}

$jsonFiles = Get-ChildItem -LiteralPath $repositoryRoot -Recurse -File -Filter '*.json' |
  Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' }

foreach ($jsonFile in $jsonFiles) {
  try {
    $null = Get-Content -LiteralPath $jsonFile.FullName -Raw | ConvertFrom-Json
  } catch {
    throw "Invalid JSON in $($jsonFile.FullName): $($_.Exception.Message)"
  }
}

$policyPath = Join-Path $repositoryRoot 'policy\lab-policy.json'
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json

if ($policy.scope.realAccountConnectivity -ne $false) {
  throw 'Safety violation: realAccountConnectivity must be false.'
}
if ($policy.scope.realOrderPlacement -ne $false) {
  throw 'Safety violation: realOrderPlacement must be false.'
}
if ($policy.exports.invokeTradeCmd -ne $false) {
  throw 'Safety violation: invokeTradeCmd must be false.'
}
if ($policy.exports.directory -match '[\\/]Trade[\\/]New([\\/]|$)') {
  throw 'Safety violation: passive exports cannot target the active Trade\New inbox.'
}
if ($policy.verifiedCftMappings.USOIL -ne 'USOUSD.cft') {
  throw 'Verified mapping mismatch for USOIL.'
}
if ($policy.verifiedCftMappings.'AVAX-USD' -ne 'AVAXUSDT.cft') {
  throw 'Verified mapping mismatch for AVAX-USD.'
}

Write-Output "Validated $($requiredFiles.Count) required files and $($jsonFiles.Count) JSON files."
Write-Output 'Local-only safety policy is intact.'

