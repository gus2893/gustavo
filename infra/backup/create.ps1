[CmdletBinding(DefaultParameterSetName = 'Database')]
param(
  [Parameter(Mandatory = $true)][string]$DestinationDirectory,
  [string]$KeyFile,
  [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$SchemaVersion,
  [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$EventHighWater,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$KeyVersion,
  [Parameter(ParameterSetName = 'Database')][string]$PgDumpPath = 'pg_dump',
  [Parameter(ParameterSetName = 'Database')][string]$PsqlPath = 'psql',
  [Parameter(ParameterSetName = 'Database')][ValidateRange(1, 600)][int]$SnapshotTimeoutSeconds = 30,
  [Parameter(ParameterSetName = 'Database')][ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$ExpectedSchemaVersion,
  [Parameter(ParameterSetName = 'Database')][ValidatePattern('^[A-Za-z0-9._:-]+$')][string]$ExpectedEventHighWater,
  [Parameter(ParameterSetName = 'Fixture', Mandatory = $true)][string]$FixturePayloadPath,
  [ValidateRange(1, 366)][int]$DailyRetentionDays = 14,
  [ValidateRange(1, 104)][int]$WeeklyRetentionWeeks = 8,
  [ValidateRange(1, 120)][int]$MonthlyRetentionMonths = 12,
  [string]$S3Uri,
  [string]$AwsCliPath = 'aws'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'verify.ps1')

function Resolve-SafeExecutable {
  param([Parameter(Mandatory = $true)][string]$Command, [Parameter(Mandatory = $true)][string]$Purpose)
  if ($Command.IndexOfAny(@([char]10, [char]13, [char]0)) -ge 0) { throw "$Purpose path is invalid." }
  $resolved = Get-Command $Command -CommandType Application -ErrorAction Stop | Select-Object -First 1
  $item = Get-SafeExistingFile -Path $resolved.Source -Purpose $Purpose
  return $item.FullName
}

function Assert-SafeDirectoryChain {
  param([Parameter(Mandatory = $true)][string]$Path)
  $current = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Backup destination cannot be reached through a symbolic link or reparse point.'
    }
    $current = $current.Parent
  }
}

function Write-EncryptedPayload {
  param([string]$InputPath, [string]$OutputPath, [byte[]]$EncryptionKey, [byte[]]$InitializationVector)
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.BlockSize = 128
  $aes.Mode = [Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $EncryptionKey
  $aes.IV = $InitializationVector
  $input = [IO.File]::OpenRead($InputPath)
  $output = New-Object IO.FileStream($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $encryptor = $aes.CreateEncryptor()
  $crypto = New-Object Security.Cryptography.CryptoStream($output, $encryptor, [Security.Cryptography.CryptoStreamMode]::Write)
  try {
    $input.CopyTo($crypto)
    $crypto.FlushFinalBlock()
  }
  finally {
    $crypto.Dispose()
    $encryptor.Dispose()
    $output.Dispose()
    $input.Dispose()
    $aes.Dispose()
  }
}

function Invoke-CheckedCommand {
  param([string]$Executable, [string[]]$Arguments, [string]$FailureMessage, [string]$PasswordFile)
  # Suppress provider/database tool output so connection strings and protected rows cannot enter logs.
  $priorPasswordFile = [Environment]::GetEnvironmentVariable('PGPASSFILE')
  $priorDatabaseUrl = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL')
  $priorMaintenanceUrl = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL')
  try {
    [Environment]::SetEnvironmentVariable('PGPASSFILE', $PasswordFile)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $null)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $null)
    $null = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$FailureMessage (exit code $LASTEXITCODE)." }
  }
  finally {
    [Environment]::SetEnvironmentVariable('PGPASSFILE', $priorPasswordFile)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $priorDatabaseUrl)
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL', $priorMaintenanceUrl)
  }
}

function Start-DatabaseSnapshot {
  param([string]$PsqlExecutable, [object]$Connection, [string]$PasswordFile, [int]$TimeoutSeconds)
  # Values used below are strictly parsed identifiers/host/port, so PS 5.1's Arguments string cannot inject switches.
  $arguments = @(
    '--no-psqlrc', '--quiet', '--no-align', '--tuples-only', '--no-password',
    "--host=$($Connection.Host)", "--port=$($Connection.Port)",
    "--username=$($Connection.User)", "--dbname=$($Connection.Database)"
  ) -join ' '
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $PsqlExecutable
  $start.Arguments = $arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['PGPASSFILE'] = $PasswordFile
  $start.EnvironmentVariables.Remove('GUSTAVO_BACKUP_DATABASE_URL')
  $start.EnvironmentVariables.Remove('GUSTAVO_BACKUP_MAINTENANCE_DATABASE_URL')
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Unable to start psql snapshot session.' }
  # Drain stderr immediately so a verbose/failing psql cannot fill its pipe and deadlock stdout.
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $sql = @"
\set ON_ERROR_STOP on
begin isolation level repeatable read read only;
select pg_export_snapshot();
select coalesce((select name from schema_migrations order by applied_at desc,name desc limit 1),'none');
select coalesce(max(ingested_sequence)::text,'0') from events;
"@
  $process.StandardInput.WriteLine($sql)
  $process.StandardInput.Flush()
  $lines = New-Object Collections.Generic.List[string]
  try {
    for ($index = 0; $index -lt 3; $index++) {
      $remaining = [int][Math]::Max(0, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      $lineTask = $process.StandardOutput.ReadLineAsync()
      if ($remaining -eq 0 -or -not $lineTask.Wait($remaining)) { throw 'Snapshot metadata query timed out.' }
      $line = $lineTask.Result
      if ($null -eq $line) { throw 'Snapshot metadata query ended before returning all fields.' }
      $lines.Add($line)
    }
  }
  catch {
    try { $process.StandardInput.Close() } catch { }
    try { if (-not $process.HasExited) { $process.Kill() } } catch { }
    try { $process.WaitForExit(5000) | Out-Null } catch { }
    $process.Dispose()
    throw
  }
  $snapshot = $lines[0]
  $schema = $lines[1]
  $highWater = $lines[2]
  if ($snapshot -notmatch '^[0-9]+-[0-9]+$' -or $schema -notmatch '^[A-Za-z0-9._:-]+$' -or
      $highWater -notmatch '^[A-Za-z0-9._:-]+$') {
    try { $process.Kill() } catch { }
    $process.Dispose()
    throw 'Snapshot metadata query returned an invalid snapshot, schema version, or event high-water.'
  }
  return [PSCustomObject]@{
    Process = $process
    StderrTask = $stderrTask
    TimeoutMilliseconds = $TimeoutSeconds * 1000
    Snapshot = $snapshot
    SchemaVersion = $schema
    EventHighWater = $highWater
  }
}

function Close-DatabaseSnapshot {
  param([object]$Session)
  if ($null -eq $Session -or $null -eq $Session.Process) { return }
  try {
    $Session.Process.StandardInput.WriteLine('rollback;')
    $Session.Process.StandardInput.Close()
    if (-not $Session.Process.WaitForExit($Session.TimeoutMilliseconds)) {
      $Session.Process.Kill()
      throw 'psql snapshot rollback timed out.'
    }
    $null = $Session.StderrTask.Wait($Session.TimeoutMilliseconds)
    if ($Session.Process.ExitCode -ne 0) { throw "psql snapshot session failed (exit code $($Session.Process.ExitCode))." }
  }
  finally { $Session.Process.Dispose() }
}

$stagingDirectory = $null
$keyBytes = $null
$encryptionKey = $null
$macKey = $null
$passwordFile = $null
$snapshotSession = $null
try {
  $destinationFullPath = [IO.Path]::GetFullPath($DestinationDirectory)
  if (Test-Path -LiteralPath $destinationFullPath) { throw 'Refusing to overwrite an existing backup destination.' }
  $destinationParent = Split-Path -Parent $destinationFullPath
  if ([string]::IsNullOrWhiteSpace($destinationParent)) { throw 'Backup destination must have a parent directory.' }
  if (-not (Test-Path -LiteralPath $destinationParent)) {
    $null = [IO.Directory]::CreateDirectory($destinationParent)
  }
  $parentItem = Get-Item -LiteralPath $destinationParent -Force
  if (-not $parentItem.PSIsContainer -or ($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Backup destination parent must be a real directory, not a reparse point.'
  }
  Assert-SafeDirectoryChain -Path $parentItem.FullName
  $stagingDirectory = Join-Path $destinationParent ('.gustavo-backup-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $null = New-OwnerOnlyDirectory -Path $stagingDirectory
  $payloadPath = Join-Path $stagingDirectory 'database.payload.tmp'
  $null = New-OwnerOnlyFile -Path $payloadPath

  if ($PSCmdlet.ParameterSetName -eq 'Fixture') {
    $fixture = Get-SafeExistingFile -Path $FixturePayloadPath -Purpose 'fixture payload'
    try { $fixtureMetadata = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($fixture.FullName)) | ConvertFrom-Json }
    catch { throw 'Fixture payload must be valid JSON.' }
    if ([string]$fixtureMetadata.schemaVersion -cne $SchemaVersion -or
        [string]$fixtureMetadata.eventHighWater -cne $EventHighWater) {
      throw 'Fixture metadata does not match the manifest schema version and event high-water.'
    }
    [IO.File]::Copy($fixture.FullName, $payloadPath, $true)
  }
  else {
    $databaseUrlFromEnvironment = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL')
    if ([string]::IsNullOrWhiteSpace($databaseUrlFromEnvironment)) { throw 'GUSTAVO_BACKUP_DATABASE_URL is required.' }
    [Environment]::SetEnvironmentVariable('GUSTAVO_BACKUP_DATABASE_URL', $null)
    $pgDump = Resolve-SafeExecutable -Command $PgDumpPath -Purpose 'pg_dump executable'
    $psql = Resolve-SafeExecutable -Command $PsqlPath -Purpose 'psql executable'
    $connection = Get-PostgresConnectionInfo -ConnectionUrl $databaseUrlFromEnvironment
    $databaseUrlFromEnvironment = $null
    $passwordFile = New-PostgresPasswordFile -Connection $connection -DatabaseNames @($connection.Database) -Directory $stagingDirectory
    # Keep the exporting read-only transaction open while pg_dump consumes that exact MVCC snapshot.
    $snapshotSession = Start-DatabaseSnapshot -PsqlExecutable $psql -Connection $connection -PasswordFile $passwordFile -TimeoutSeconds $SnapshotTimeoutSeconds
    $SchemaVersion = [string]$snapshotSession.SchemaVersion
    $EventHighWater = [string]$snapshotSession.EventHighWater
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSchemaVersion) -and $SchemaVersion -cne $ExpectedSchemaVersion) {
      throw 'Snapshot-derived schema version does not match ExpectedSchemaVersion.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedEventHighWater) -and $EventHighWater -cne $ExpectedEventHighWater) {
      throw 'Snapshot-derived event high-water does not match ExpectedEventHighWater.'
    }
    Invoke-CheckedCommand -Executable $pgDump -Arguments @(
      '--format=custom', '--no-owner', '--no-acl', '--no-password',
      "--host=$($connection.Host)", "--port=$($connection.Port)", "--username=$($connection.User)",
      "--dbname=$($connection.Database)", "--snapshot=$($snapshotSession.Snapshot)", "--file=$payloadPath"
    ) -FailureMessage 'pg_dump failed' -PasswordFile $passwordFile
    Close-DatabaseSnapshot -Session $snapshotSession
    $snapshotSession = $null
    Remove-PostgresPasswordFile -Path $passwordFile
    $passwordFile = $null
    $connection.Password = $null
  }

  $payloadItem = Get-SafeExistingFile -Path $payloadPath -Purpose 'database-consistent payload'
  $payloadChecksum = Get-Sha256Hex -Path $payloadItem.FullName
  $keyBytes = Get-BackupKeyBytes -Path $KeyFile
  $encryptionKey = New-Object byte[] 32
  $macKey = New-Object byte[] 32
  [Array]::Copy($keyBytes, 0, $encryptionKey, 0, 32)
  [Array]::Copy($keyBytes, 32, $macKey, 0, 32)
  $iv = New-Object byte[] 16
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($iv) } finally { $rng.Dispose() }

  $artifactName = 'backup.gbackup'
  $artifactPath = Join-Path $stagingDirectory $artifactName
  Write-EncryptedPayload -InputPath $payloadItem.FullName -OutputPath $artifactPath -EncryptionKey $encryptionKey -InitializationVector $iv
  Remove-Item -LiteralPath $payloadItem.FullName -Force

  $manifest = [PSCustomObject][ordered]@{
    formatVersion = 'gustavo-backup-v1'
    artifact = $artifactName
    generationId = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N'))
    schemaVersion = $SchemaVersion
    eventHighWater = $EventHighWater
    keyVersion = $KeyVersion
    encryption = 'AES-256-CBC-HMAC-SHA256'
    payloadBytes = [string]$payloadItem.Length
    payloadSha256 = $payloadChecksum
    ciphertextSha256 = Get-Sha256Hex -Path $artifactPath
    iv = [Convert]::ToBase64String($iv)
    authenticationTag = [Convert]::ToBase64String((New-Object byte[] 32))
    retention = [PSCustomObject][ordered]@{
      dailyRetentionDays = [string]$DailyRetentionDays
      weeklyRetentionWeeks = [string]$WeeklyRetentionWeeks
      monthlyRetentionMonths = [string]$MonthlyRetentionMonths
    }
  }
  $binding = Get-ManifestBindingBytes -Manifest $manifest
  $manifest.authenticationTag = [Convert]::ToBase64String((Get-AuthenticationTag -MacKey $macKey -Binding $binding -ArtifactPath $artifactPath))
  $manifestPath = Join-Path $stagingDirectory 'backup.manifest.json'
  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8WithoutBom)

  # A backup is never finalized or uploaded until the shared validator decrypts and verifies it.
  $null = Test-BackupManifest -Path $manifestPath -ExternalKeyFile $KeyFile
  Move-Item -LiteralPath $stagingDirectory -Destination $destinationFullPath
  $stagingDirectory = $null

  if (-not [string]::IsNullOrWhiteSpace($S3Uri)) {
    if ($S3Uri -notmatch '^s3://[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._/-]+$' -or $S3Uri.Contains('..')) {
      throw 'S3Uri must be a safe s3:// bucket/prefix URI.'
    }
    $aws = Resolve-SafeExecutable -Command $AwsCliPath -Purpose 'object storage CLI'
    $withoutScheme = $S3Uri.Substring(5).TrimEnd('/')
    $separator = $withoutScheme.IndexOf('/')
    $bucket = $withoutScheme.Substring(0, $separator)
    $prefix = $withoutScheme.Substring($separator + 1).Trim('/')
    $generationPrefix = "$prefix/$($manifest.generationId)"
    # Immutable, conditional generation objects: an interrupted upload can only leave an orphan,
    # never overwrite a previous healthy generation. There is intentionally no mutable latest pointer.
    Invoke-CheckedCommand -Executable $aws -Arguments @(
      's3api', 'put-object', "--bucket=$bucket", "--key=$generationPrefix/$artifactName",
      "--body=$(Join-Path $destinationFullPath $artifactName)", '--if-none-match=*'
    ) -FailureMessage 'Encrypted artifact upload failed'
    Invoke-CheckedCommand -Executable $aws -Arguments @(
      's3api', 'put-object', "--bucket=$bucket", "--key=$generationPrefix/backup.manifest.json",
      "--body=$(Join-Path $destinationFullPath 'backup.manifest.json')", '--if-none-match=*'
    ) -FailureMessage 'Manifest upload failed'
    Write-Output ("IMMUTABLE MANIFEST: s3://{0}/{1}/backup.manifest.json" -f $bucket, $generationPrefix)
  }
  Write-Output ("BACKUP CREATED AND VERIFIED - schema: {0}; event high-water: {1}; key version: {2}" -f $SchemaVersion, $EventHighWater, $KeyVersion)
  exit 0
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($null -ne $snapshotSession) {
    try { Close-DatabaseSnapshot -Session $snapshotSession } catch { }
  }
  Remove-PostgresPasswordFile -Path $passwordFile
  if ($null -ne $stagingDirectory -and (Test-Path -LiteralPath $stagingDirectory)) {
    try { [IO.Directory]::Delete($stagingDirectory, $true) } catch { }
  }
  foreach ($sensitive in @($keyBytes, $encryptionKey, $macKey)) {
    if ($null -ne $sensitive) { [Array]::Clear($sensitive, 0, $sensitive.Length) }
  }
}
