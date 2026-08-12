[CmdletBinding()]
param(
  [Alias('ManifestPath')][string]$VerificationManifestPath,
  [Alias('KeyFile')][string]$VerificationKeyFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-SafeExistingFile {
  param([Parameter(Mandatory = $true)][string]$Path, [string]$Purpose = 'file')
  if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Purpose path is required." }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer) { throw "$Purpose must be a file." }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Purpose cannot be a symbolic link or reparse point."
  }
  $ancestor = $item.Directory
  while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Purpose cannot be reached through a symbolic link or reparse point."
    }
    $ancestor = $ancestor.Parent
  }
  return $item
}

function Get-BackupKeyBytes {
  param([string]$Path)
  $effectivePath = $Path
  if ([string]::IsNullOrWhiteSpace($effectivePath)) {
    $effectivePath = [Environment]::GetEnvironmentVariable('GUSTAVO_BACKUP_KEY_FILE')
  }
  $item = Get-SafeExistingFile -Path $effectivePath -Purpose 'backup key'
  $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
  if ($bytes.Length -ne 64) {
    [Array]::Clear($bytes, 0, $bytes.Length)
    throw 'The backup key file must contain exactly 64 random bytes.'
  }
  return $bytes
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  }
  finally {
    $sha.Dispose()
    $stream.Dispose()
  }
}

function Set-OwnerOnlyDirectoryPermissions {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ($env:OS -eq 'Windows_NT') {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetOwner($identity.User)
    $security.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $identity.User, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'
    )
    $security.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($Path, $security)
  }
  else {
    $null = & chmod 700 -- $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Unable to apply owner-only directory permissions.' }
  }
}

function New-OwnerOnlyDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (Test-Path -LiteralPath $Path) { throw 'Refusing to overwrite an existing protected work directory.' }
  $null = [IO.Directory]::CreateDirectory($Path)
  try { Set-OwnerOnlyDirectoryPermissions -Path $Path }
  catch {
    try { [IO.Directory]::Delete($Path, $true) } catch { }
    throw
  }
  return $Path
}

function New-OwnerOnlyFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    if ($env:OS -eq 'Windows_NT') {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      $security = New-Object Security.AccessControl.FileSecurity
      $security.SetOwner($identity.User)
      $security.SetAccessRuleProtection($true, $false)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'Allow')
      $security.AddAccessRule($rule)
      [IO.File]::SetAccessControl($Path, $security)
    }
    else {
      $null = & chmod 600 -- $Path 2>&1
      if ($LASTEXITCODE -ne 0) { throw 'Unable to apply owner-only file permissions.' }
    }
  }
  catch {
    $stream.Dispose()
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    throw
  }
  $stream.Dispose()
  return $Path
}

function Get-PostgresConnectionInfo {
  param([Parameter(Mandatory = $true)][string]$ConnectionUrl)
  if ($ConnectionUrl.IndexOfAny(@([char]0, [char]10, [char]13)) -ge 0) {
    throw 'PostgreSQL URL contains unsafe control characters.'
  }
  try { $uri = New-Object Uri($ConnectionUrl, [UriKind]::Absolute) }
  catch { throw 'PostgreSQL URL must be an absolute URI.' }
  if ($uri.Scheme -notin @('postgres', 'postgresql') -or -not [string]::IsNullOrEmpty($uri.Query) -or
      -not [string]::IsNullOrEmpty($uri.Fragment)) {
    throw 'PostgreSQL URL must use postgres/postgresql without query or fragment parameters.'
  }
  if ([string]::IsNullOrWhiteSpace($uri.UserInfo) -or $uri.UserInfo.IndexOf(':') -lt 1) {
    throw 'PostgreSQL URL must include an encoded username and password.'
  }
  $separator = $uri.UserInfo.IndexOf(':')
  $user = [Uri]::UnescapeDataString($uri.UserInfo.Substring(0, $separator))
  $password = [Uri]::UnescapeDataString($uri.UserInfo.Substring($separator + 1))
  $database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
  $hostName = $uri.Host
  if ($user -notmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,62}$' -or
      $database -notmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,62}$' -or
      ($hostName -notmatch '^[A-Za-z0-9.-]+$' -and $hostName -notmatch '^[A-Fa-f0-9:.]+$') -or
      [string]::IsNullOrEmpty($password) -or $password.IndexOfAny(@([char]0, [char]10, [char]13)) -ge 0) {
    throw 'PostgreSQL URL contains an unsupported or unsafe host, database, username, or password.'
  }
  $port = if ($uri.IsDefaultPort) { 5432 } else { $uri.Port }
  if ($port -lt 1 -or $port -gt 65535) { throw 'PostgreSQL URL port is invalid.' }
  return [PSCustomObject]@{ Host = $hostName; Port = $port; Database = $database; User = $user; Password = $password }
}

function New-PostgresPasswordFile {
  param([Parameter(Mandatory = $true)][object]$Connection, [Parameter(Mandatory = $true)][string[]]$DatabaseNames,
        [Parameter(Mandatory = $true)][string]$Directory)
  $credentialDirectory = Join-Path $Directory ('.pgcred-' + [Guid]::NewGuid().ToString('N'))
  $null = New-OwnerOnlyDirectory -Path $credentialDirectory
  $path = Join-Path $credentialDirectory 'pgpass'
  $escape = {
    param([string]$Value)
    return $Value.Replace('\', '\\').Replace(':', '\:')
  }
  $lines = foreach ($databaseName in $DatabaseNames) {
    if ($databaseName -notmatch '^[A-Za-z_][A-Za-z0-9_.-]{0,62}$') { throw 'PostgreSQL password-file database name is unsafe.' }
    (& $escape ([string]$Connection.Host)), [string]$Connection.Port, (& $escape $databaseName),
      (& $escape ([string]$Connection.User)), (& $escape ([string]$Connection.Password)) -join ':'
  }
  # The parent and file are owner-only before any secret bytes are written.
  $null = New-OwnerOnlyFile -Path $path
  $stream = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $content = [Text.Encoding]::UTF8.GetBytes((($lines -join [Environment]::NewLine) + [Environment]::NewLine))
    $stream.Write($content, 0, $content.Length)
    $stream.Flush($true)
    [Array]::Clear($content, 0, $content.Length)
  }
  finally {
    $stream.Dispose()
  }
  return $path
}

function Remove-PostgresPasswordFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return }
  try {
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -gt 0) { [IO.File]::WriteAllBytes($Path, (New-Object byte[] ([int]$length))) }
  }
  finally {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    $parent = Split-Path -Parent $Path
    if ((Split-Path -Leaf $parent) -like '.pgcred-*') {
      try { [IO.Directory]::Delete($parent, $false) } catch { }
    }
  }
}

function Test-FixedTimeEqual {
  param([byte[]]$Left, [byte[]]$Right)
  if ($null -eq $Left -or $null -eq $Right) { return $false }
  $difference = $Left.Length -bxor $Right.Length
  $length = [Math]::Max($Left.Length, $Right.Length)
  for ($index = 0; $index -lt $length; $index++) {
    $leftByte = if ($index -lt $Left.Length) { $Left[$index] } else { 0 }
    $rightByte = if ($index -lt $Right.Length) { $Right[$index] } else { 0 }
    $difference = $difference -bor ($leftByte -bxor $rightByte)
  }
  return $difference -eq 0
}

function Assert-ManifestText {
  param([object]$Value, [string]$Name, [int]$MaximumLength = 200)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value)) {
    throw "Manifest field '$Name' must be a non-empty string."
  }
  if ([string]$Value -notmatch '^[A-Za-z0-9._:-]+$' -or ([string]$Value).Length -gt $MaximumLength) {
    throw "Manifest field '$Name' contains unsafe characters or is too long."
  }
}

function Get-ManifestBindingBytes {
  param([Parameter(Mandatory = $true)][object]$Manifest)
  if ($Manifest.formatVersion -ne 'gustavo-backup-v1') { throw 'Unsupported backup manifest format.' }
  Assert-ManifestText $Manifest.artifact 'artifact' 100
  Assert-ManifestText $Manifest.generationId 'generationId' 100
  Assert-ManifestText $Manifest.schemaVersion 'schemaVersion'
  Assert-ManifestText $Manifest.eventHighWater 'eventHighWater'
  Assert-ManifestText $Manifest.keyVersion 'keyVersion'
  Assert-ManifestText $Manifest.encryption 'encryption' 100
  if ($Manifest.encryption -ne 'AES-256-CBC-HMAC-SHA256') { throw 'Unsupported authenticated encryption scheme.' }
  if ([string]$Manifest.payloadBytes -notmatch '^[0-9]+$') { throw "Manifest field 'payloadBytes' is invalid." }
  foreach ($name in @('ciphertextSha256', 'payloadSha256')) {
    if ([string]$Manifest.$name -notmatch '^[a-f0-9]{64}$') { throw "Manifest field '$name' is invalid." }
  }
  foreach ($name in @('dailyRetentionDays', 'weeklyRetentionWeeks', 'monthlyRetentionMonths')) {
    if ([string]$Manifest.retention.$name -notmatch '^[0-9]+$') { throw "Manifest retention field '$name' is invalid." }
  }
  $retentionBounds = @{
    dailyRetentionDays = @(1, 366)
    weeklyRetentionWeeks = @(1, 104)
    monthlyRetentionMonths = @(1, 120)
  }
  foreach ($name in $retentionBounds.Keys) {
    $value = [int64]([string]$Manifest.retention.$name)
    if ($value -lt $retentionBounds[$name][0] -or $value -gt $retentionBounds[$name][1]) {
      throw "Manifest retention field '$name' is outside supported bounds."
    }
  }
  foreach ($name in @('iv', 'authenticationTag')) {
    if ($Manifest.$name -isnot [string]) { throw "Manifest field '$name' is invalid." }
    try { $decoded = [Convert]::FromBase64String([string]$Manifest.$name) }
    catch { throw "Manifest field '$name' is not valid base64." }
    $expectedLength = if ($name -eq 'iv') { 16 } else { 32 }
    if ($decoded.Length -ne $expectedLength) { throw "Manifest field '$name' has the wrong length." }
  }
  $parts = @(
    [string]$Manifest.formatVersion,
    [string]$Manifest.artifact,
    [string]$Manifest.generationId,
    [string]$Manifest.schemaVersion,
    [string]$Manifest.eventHighWater,
    [string]$Manifest.keyVersion,
    [string]$Manifest.encryption,
    [string]$Manifest.payloadBytes,
    [string]$Manifest.payloadSha256,
    [string]$Manifest.ciphertextSha256,
    [string]$Manifest.iv,
    [string]$Manifest.retention.dailyRetentionDays,
    [string]$Manifest.retention.weeklyRetentionWeeks,
    [string]$Manifest.retention.monthlyRetentionMonths
  )
  return [Text.Encoding]::UTF8.GetBytes(($parts -join ([char]10)))
}

function Get-ArtifactPath {
  param([Parameter(Mandatory = $true)][string]$ManifestFile, [Parameter(Mandatory = $true)][string]$Artifact)
  if ([IO.Path]::IsPathRooted($Artifact) -or [IO.Path]::GetFileName($Artifact) -ne $Artifact -or
      $Artifact -eq '.' -or $Artifact -eq '..') {
    throw 'Manifest artifact must be a plain filename in the manifest directory.'
  }
  $manifestDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ManifestFile))
  $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($manifestDirectory, $Artifact))
  $prefix = $manifestDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Manifest artifact escapes the manifest directory.'
  }
  return (Get-SafeExistingFile -Path $candidate -Purpose 'encrypted backup artifact').FullName
}

function Get-AuthenticationTag {
  param([byte[]]$MacKey, [byte[]]$Binding, [string]$ArtifactPath)
  $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList (,$MacKey)
  $stream = [IO.File]::OpenRead($ArtifactPath)
  try {
    $null = $hmac.TransformBlock($Binding, 0, $Binding.Length, $Binding, 0)
    $buffer = New-Object byte[] 65536
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $null = $hmac.TransformBlock($buffer, 0, $count, $buffer, 0)
    }
    $null = $hmac.TransformFinalBlock((New-Object byte[] 0), 0, 0)
    return $hmac.Hash
  }
  finally {
    $stream.Dispose()
    $hmac.Dispose()
  }
}

function Expand-AuthenticatedBackup {
  param([object]$Manifest, [string]$ArtifactPath, [byte[]]$EncryptionKey, [string]$OutputPath)
  $outputItem = Get-SafeExistingFile -Path $OutputPath -Purpose 'protected restore payload'
  if ($outputItem.Length -ne 0) { throw 'Refusing to overwrite a non-empty restore payload.' }
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.KeySize = 256
  $aes.BlockSize = 128
  $aes.Mode = [System.Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [System.Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key = $EncryptionKey
  $aes.IV = [Convert]::FromBase64String([string]$Manifest.iv)
  $input = [IO.File]::OpenRead($ArtifactPath)
  $output = New-Object IO.FileStream($OutputPath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $decryptor = $aes.CreateDecryptor()
  $crypto = New-Object Security.Cryptography.CryptoStream($input, $decryptor, [Security.Cryptography.CryptoStreamMode]::Read)
  try { $crypto.CopyTo($output) }
  catch {
    $output.Dispose()
    Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
    throw 'Backup payload decryption failed.'
  }
  finally {
    $crypto.Dispose()
    $decryptor.Dispose()
    $output.Dispose()
    $input.Dispose()
    $aes.Dispose()
  }
}

function Test-BackupManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$ExternalKeyFile,
    [string]$PayloadOutputPath
  )
  $manifestItem = Get-SafeExistingFile -Path $Path -Purpose 'backup manifest'
  if ($manifestItem.Length -gt 65536) { throw 'Backup manifest is unexpectedly large.' }
  try { $manifest = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($manifestItem.FullName)) | ConvertFrom-Json }
  catch { throw 'Backup manifest is not valid JSON.' }
  $binding = Get-ManifestBindingBytes -Manifest $manifest
  $artifactPath = Get-ArtifactPath -ManifestFile $manifestItem.FullName -Artifact ([string]$manifest.artifact)
  $actualCiphertextChecksum = Get-Sha256Hex -Path $artifactPath
  if ($actualCiphertextChecksum -cne [string]$manifest.ciphertextSha256) {
    throw 'Encrypted artifact checksum mismatch.'
  }
  $allKeyBytes = Get-BackupKeyBytes -Path $ExternalKeyFile
  $encryptionKey = New-Object byte[] 32
  $macKey = New-Object byte[] 32
  [Array]::Copy($allKeyBytes, 0, $encryptionKey, 0, 32)
  [Array]::Copy($allKeyBytes, 32, $macKey, 0, 32)
  try {
    $expectedTag = Get-AuthenticationTag -MacKey $macKey -Binding $binding -ArtifactPath $artifactPath
    $actualTag = [Convert]::FromBase64String([string]$manifest.authenticationTag)
    if (-not (Test-FixedTimeEqual $expectedTag $actualTag)) { throw 'Backup authentication failed.' }
    $ownsPayload = [string]::IsNullOrWhiteSpace($PayloadOutputPath)
    $verificationDirectory = $null
    if ($ownsPayload) {
      $verificationDirectory = Join-Path ([IO.Path]::GetTempPath()) ("gustavo-verify-" + [Guid]::NewGuid().ToString('N'))
      $null = New-OwnerOnlyDirectory -Path $verificationDirectory
      $PayloadOutputPath = Join-Path $verificationDirectory 'verified.payload'
    }
    if (Test-Path -LiteralPath $PayloadOutputPath) { throw 'Refusing to overwrite a restore payload.' }
    $null = New-OwnerOnlyFile -Path $PayloadOutputPath
    try {
      Expand-AuthenticatedBackup -Manifest $manifest -ArtifactPath $artifactPath -EncryptionKey $encryptionKey -OutputPath $PayloadOutputPath
      $payloadItem = Get-Item -LiteralPath $PayloadOutputPath
      if ([string]$payloadItem.Length -cne [string]$manifest.payloadBytes -or
          (Get-Sha256Hex -Path $PayloadOutputPath) -cne [string]$manifest.payloadSha256) {
        throw 'Decrypted payload checksum or length mismatch.'
      }
    }
    finally {
      if ($ownsPayload) {
        Remove-Item -LiteralPath $PayloadOutputPath -Force -ErrorAction SilentlyContinue
        if ($null -ne $verificationDirectory) { try { [IO.Directory]::Delete($verificationDirectory, $false) } catch { } }
      }
    }
  }
  finally {
    [Array]::Clear($allKeyBytes, 0, $allKeyBytes.Length)
    [Array]::Clear($encryptionKey, 0, $encryptionKey.Length)
    [Array]::Clear($macKey, 0, $macKey.Length)
  }
  return [PSCustomObject]@{
    Manifest = $manifest
    ManifestPath = $manifestItem.FullName
    ArtifactPath = $artifactPath
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    if ([string]::IsNullOrWhiteSpace($VerificationManifestPath)) { throw 'ManifestPath is required.' }
    $verified = Test-BackupManifest -Path $VerificationManifestPath -ExternalKeyFile $VerificationKeyFile
    Write-Output ("BACKUP VERIFIED - schema: {0}; event high-water: {1}; key version: {2}" -f
      $verified.Manifest.schemaVersion, $verified.Manifest.eventHighWater, $verified.Manifest.keyVersion)
    exit 0
  }
  catch {
    Write-Error $_.Exception.Message
    exit 1
  }
}
