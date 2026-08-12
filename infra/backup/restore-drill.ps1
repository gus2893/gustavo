[CmdletBinding(DefaultParameterSetName = 'Database')]
param(
  [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][switch]$UseFixture,
  [Parameter(ParameterSetName = 'Database', Mandatory = $true)][string]$ManifestPath,
  [Parameter(ParameterSetName = 'Database')][string]$KeyFile,
  [string]$RestoreDatabaseName = 'gustavo_restore_drill',
  [string]$ActiveDatabaseName = 'gustavo',
  [string]$CreatedbPath = 'createdb',
  [string]$PgRestorePath = 'pg_restore',
  [string]$PsqlPath = 'psql',
  [string]$DropdbPath = 'dropdb',
  [switch]$KeepRestoredDatabase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'verify.ps1')

function Assert-SafeDatabaseName {
  param([string]$Name, [string]$Purpose)
  if ($Name -notmatch '^[A-Za-z][A-Za-z0-9_]{0,62}$') {
    throw "$Purpose must be a simple PostgreSQL identifier of at most 63 characters."
  }
}

function Resolve-RestoreExecutable {
  param([string]$Command, [string]$Purpose)
  if ([string]::IsNullOrWhiteSpace($Command) -or $Command.IndexOfAny(@([char]10, [char]13, [char]0)) -ge 0) {
    throw "$Purpose path is invalid."
  }
  $resolved = Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
  return (Get-SafeExistingFile -Path $resolved.Source -Purpose $Purpose).FullName
}

function Invoke-RestoreCommand {
  param([string]$Executable, [string[]]$Arguments, [string]$FailureMessage, [string]$PasswordFile, [switch]$IgnoreFailure)
  $priorPasswordFile = [Environment]::GetEnvironmentVariable('PGPASSFILE')
  $priorDatabaseUrl = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL')
  $priorCreateUrl = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL')
  try {
    [Environment]::SetEnvironmentVariable('PGPASSFILE', $PasswordFile)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $null)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $null)
    $null = & $Executable @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -and -not $IgnoreFailure) { throw "$FailureMessage (exit code $code)." }
    return $code
  }
  finally {
    [Environment]::SetEnvironmentVariable('PGPASSFILE', $priorPasswordFile)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $priorDatabaseUrl)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $priorCreateUrl)
  }
}

function Invoke-CapturedRestoreCommand {
  param([string]$Executable, [string[]]$Arguments, [string]$FailureMessage, [string]$PasswordFile)
  $priorPasswordFile = [Environment]::GetEnvironmentVariable('PGPASSFILE')
  $priorDatabaseUrl = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL')
  $priorCreateUrl = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL')
  try {
    [Environment]::SetEnvironmentVariable('PGPASSFILE', $PasswordFile)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $null)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $null)
    $output = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit code $LASTEXITCODE)." }
    return (($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -ne '' }) -join '')
  }
  finally {
    [Environment]::SetEnvironmentVariable('PGPASSFILE', $priorPasswordFile)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $priorDatabaseUrl)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $priorCreateUrl)
  }
}

$workingDirectory = $null
$databaseCreated = $false
$createdb = $null
$dropdb = $null
$restorePasswordFile = $null
$maintenanceConnection = $null
try {
  Assert-SafeDatabaseName -Name $RestoreDatabaseName -Purpose 'RestoreDatabaseName'
  Assert-SafeDatabaseName -Name $ActiveDatabaseName -Purpose 'ActiveDatabaseName'
  if ($RestoreDatabaseName.Equals($ActiveDatabaseName, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RestoreDatabaseName must not be the active database name.'
  }

  $workingDirectory = Join-Path ([IO.Path]::GetTempPath()) ('gustavo-restore-' + [Guid]::NewGuid().ToString('N'))
  $null = New-OwnerOnlyDirectory -Path $workingDirectory
  $payloadPath = Join-Path $workingDirectory 'verified.payload'

  if ($UseFixture) {
    $fixtureInput = Join-Path $workingDirectory 'fixture.json'
    $fixtureKey = Join-Path $workingDirectory 'fixture.key'
    $fixtureBackup = Join-Path $workingDirectory 'fixture-backup'
    $fixtureObject = [ordered]@{
      schemaVersion = 'fixture-schema-1'
      eventHighWater = 'fixture-event-0002'
      events = @('fixture-event-0001', 'fixture-event-0002')
    }
    $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
    $null = New-OwnerOnlyFile -Path $fixtureInput
    [IO.File]::WriteAllText($fixtureInput, ($fixtureObject | ConvertTo-Json -Depth 3), $utf8WithoutBom)
    $fixtureKeyBytes = New-Object byte[] 64
    for ($index = 0; $index -lt $fixtureKeyBytes.Length; $index++) { $fixtureKeyBytes[$index] = [byte](($index * 17 + 29) % 256) }
    $null = New-OwnerOnlyFile -Path $fixtureKey
    [IO.File]::WriteAllBytes($fixtureKey, $fixtureKeyBytes)
    [Array]::Clear($fixtureKeyBytes, 0, $fixtureKeyBytes.Length)

    $hostExecutable = (Get-Process -Id $PID).Path
    & $hostExecutable -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create.ps1') `
      -FixturePayloadPath $fixtureInput -DestinationDirectory $fixtureBackup -KeyFile $fixtureKey `
      -SchemaVersion 'fixture-schema-1' -EventHighWater 'fixture-event-0002' -KeyVersion 'fixture-key-v1'
    if ($LASTEXITCODE -ne 0) { throw "Fixture backup creation failed (exit code $LASTEXITCODE)." }
    $ManifestPath = Join-Path $fixtureBackup 'backup.manifest.json'
    $KeyFile = $fixtureKey
  }

  $verified = Test-BackupManifest -Path $ManifestPath -ExternalKeyFile $KeyFile -PayloadOutputPath $payloadPath
  if ($UseFixture) {
    try { $restoredFixture = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($payloadPath)) | ConvertFrom-Json }
    catch { throw 'Restored fixture payload is not valid JSON.' }
    if ([string]$restoredFixture.schemaVersion -cne [string]$verified.Manifest.schemaVersion -or
        [string]$restoredFixture.eventHighWater -cne [string]$verified.Manifest.eventHighWater) {
      throw 'Restored fixture schema version or event high-water does not match its authenticated manifest.'
    }
  }
  else {
    $maintenanceDatabaseUrlFromEnvironment = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL')
    if ([string]::IsNullOrWhiteSpace($maintenanceDatabaseUrlFromEnvironment)) { throw 'GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL is required.' }
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $null)
    $maintenanceConnection = Get-PostgresConnectionInfo -ConnectionUrl $maintenanceDatabaseUrlFromEnvironment
    $maintenanceDatabaseUrlFromEnvironment = $null
    $restorePasswordFile = New-PostgresPasswordFile -Connection $maintenanceConnection -DatabaseNames @(
      $maintenanceConnection.Database, $RestoreDatabaseName
    ) -Directory $workingDirectory
    $connectionArguments = @(
      "--host=$($maintenanceConnection.Host)", "--port=$($maintenanceConnection.Port)",
      "--username=$($maintenanceConnection.User)"
    )
    $createdb = Resolve-RestoreExecutable -Command $CreatedbPath -Purpose 'createdb executable'
    $pgRestore = Resolve-RestoreExecutable -Command $PgRestorePath -Purpose 'pg_restore executable'
    $psql = Resolve-RestoreExecutable -Command $PsqlPath -Purpose 'psql executable'
    $dropdb = Resolve-RestoreExecutable -Command $DropdbPath -Purpose 'dropdb executable'
    $null = Invoke-RestoreCommand -Executable $createdb -Arguments ($connectionArguments + @('--no-password', "--maintenance-db=$($maintenanceConnection.Database)", $RestoreDatabaseName)) -FailureMessage 'Refusing to overwrite or create the isolated restore database' -PasswordFile $restorePasswordFile
    $databaseCreated = $true
    $null = Invoke-RestoreCommand -Executable $pgRestore -Arguments ($connectionArguments + @('--exit-on-error', '--no-owner', '--no-acl', "--dbname=$RestoreDatabaseName", $payloadPath)) -FailureMessage 'Isolated pg_restore failed' -PasswordFile $restorePasswordFile
    $restoredSchema = Invoke-CapturedRestoreCommand -Executable $psql -Arguments ($connectionArguments + @('--tuples-only', '--no-align', '--quiet', '--no-password', "--dbname=$RestoreDatabaseName", '--command=select coalesce((select name from schema_migrations order by applied_at desc,name desc limit 1),''none'')')) -FailureMessage 'Restored schema-version verification failed' -PasswordFile $restorePasswordFile
    $restoredHighWater = Invoke-CapturedRestoreCommand -Executable $psql -Arguments ($connectionArguments + @('--tuples-only', '--no-align', '--quiet', '--no-password', "--dbname=$RestoreDatabaseName", '--command=select coalesce(max(ingested_sequence)::text,''0'') from events')) -FailureMessage 'Restored event high-water verification failed' -PasswordFile $restorePasswordFile
    if ($restoredSchema -cne [string]$verified.Manifest.schemaVersion -or
        $restoredHighWater -cne [string]$verified.Manifest.eventHighWater) {
      throw 'Restored database schema version or event high-water does not match its authenticated manifest.'
    }
  }

  Write-Output ("RESTORE DRILL PASSED - isolated database: {0}; schema: {1}; event high-water: {2}" -f
    $RestoreDatabaseName, $verified.Manifest.schemaVersion, $verified.Manifest.eventHighWater)
  exit 0
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($databaseCreated -and -not $KeepRestoredDatabase -and $null -ne $dropdb) {
    $cleanupArguments = @(
      "--host=$($maintenanceConnection.Host)", "--port=$($maintenanceConnection.Port)",
      "--username=$($maintenanceConnection.User)", '--if-exists', '--no-password',
      "--maintenance-db=$($maintenanceConnection.Database)", $RestoreDatabaseName
    )
    $cleanupCode = Invoke-RestoreCommand -Executable $dropdb -Arguments $cleanupArguments -FailureMessage 'Isolated restore cleanup failed' -PasswordFile $restorePasswordFile -IgnoreFailure
    if ($cleanupCode -ne 0) {
      Write-Error "Isolated restore cleanup failed (exit code $cleanupCode)."
      exit 1
    }
  }
  if ($null -ne $maintenanceConnection) { $maintenanceConnection.Password = $null }
  Remove-PostgresPasswordFile -Path $restorePasswordFile
  if ($null -ne $workingDirectory -and (Test-Path -LiteralPath $workingDirectory)) {
    try { [IO.Directory]::Delete($workingDirectory, $true) } catch { }
  }
}
