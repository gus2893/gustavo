[CmdletBinding()]
param(
  [string]$DedicatedAccount = "GustavoHybridWorker",
  [string]$TaskName = "Gustavo Hybrid Worker",
  [string]$ConfigPath = "$env:LOCALAPPDATA\Gustavo\hybrid-worker.env",
  [switch]$ConfirmDockerDesktopPersonal
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AuthVolume = "gustavo-codex-auth-v1"
$ImageTag = "gustavo-codex:0.146.0"
# The nested Dockerfile pins the exact package @openai/codex@0.146.0.
$ContainerSource = Join-Path $PSScriptRoot "..\worker\hybrid\codex-container"
$StartScript = Join-Path $PSScriptRoot "start-hybrid-worker.ps1"
$RequiredSecrets = @(
  "DATABASE_URL",
  "GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL",
  "GUSTAVO_EVENT_ROOT_KEY_V1",
  "GUSTAVO_CURSOR_SIGNING_KEY",
  "GUSTAVO_CACHE_ENCRYPTION_KEY",
  "GUSTAVO_COUNCIL_PSEUDONYM_KEY",
  "GUSTAVO_EVALUATOR_PSEUDONYM_KEY",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
  "GUSTAVO_HYBRID_PUBLIC_WAKE_URL",
  "FINNHUB_API_KEY"
)

function Stop-Safely([string]$Code) {
  throw $Code
}

function Get-RequiredEnvironmentValue([string]$Name) {
  $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains("`0")) {
    Stop-Safely "HYBRID_CONFIG_VALUE_INVALID"
  }
  return $Value
}

function Assert-NoReparsePath([string]$Path, [bool]$RequireLeaf = $true) {
  $FullPath = [IO.Path]::GetFullPath($Path)
  $Root = [IO.Path]::GetPathRoot($FullPath)
  if ([string]::IsNullOrWhiteSpace($Root)) { Stop-Safely "HYBRID_PATH_INVALID" }
  $Current = $Root
  $Segments = $FullPath.Substring($Root.Length).Split(
    [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
    [StringSplitOptions]::RemoveEmptyEntries
  )
  for ($Index = 0; $Index -lt $Segments.Length; $Index += 1) {
    $Current = Join-Path $Current $Segments[$Index]
    if (-not (Test-Path -LiteralPath $Current)) {
      if ($RequireLeaf -or $Index -lt $Segments.Length - 1) {
        Stop-Safely "HYBRID_PATH_INVALID"
      }
      return $FullPath
    }
    $Item = Get-Item -Force -LiteralPath $Current
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Stop-Safely "HYBRID_REPARSE_PATH_REJECTED"
    }
  }
  return $FullPath
}

function Set-OwnerOnlyAcl(
  [string]$Path,
  [bool]$Container,
  [Security.Principal.SecurityIdentifier]$Owner
) {
  # Exact ACL intent of icacls /inheritance:r, expressed without an ambient executable.
  $System = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
  )
  if ($Container) {
    $Security = [Security.AccessControl.DirectorySecurity]::new()
    $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $Security = [Security.AccessControl.FileSecurity]::new()
    $Inheritance = [Security.AccessControl.InheritanceFlags]::None
  }
  $Security.SetOwner($Owner)
  $Security.SetAccessRuleProtection($true, $false)
  foreach ($Identity in @($Owner, $System)) {
    $Rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $Identity,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $Inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$Security.AddAccessRule($Rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $Security
}

function Assert-OwnerOnlyAcl(
  [string]$Path,
  [Security.Principal.SecurityIdentifier]$Owner
) {
  $System = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
  )
  $Acl = Get-Acl -LiteralPath $Path
  $OwnerSid = ([Security.Principal.NTAccount]$Acl.Owner).Translate(
    [Security.Principal.SecurityIdentifier]
  )
  $Rules = @($Acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
  $Allowed = @($Owner.Value, $System.Value)
  if (-not $Acl.AreAccessRulesProtected -or $OwnerSid.Value -ne $Owner.Value -or $Rules.Count -ne 2) {
    Stop-Safely "HYBRID_CONFIG_ACL_INVALID"
  }
  foreach ($Rule in $Rules) {
    if ($Allowed -notcontains $Rule.IdentityReference.Value -or
        $Rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        ($Rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
      Stop-Safely "HYBRID_CONFIG_ACL_INVALID"
    }
  }
}

function Assert-TrustedExecutable([string]$ActualPath, [string]$ExpectedPath) {
  $Actual = [IO.Path]::GetFullPath($ActualPath)
  $Expected = [IO.Path]::GetFullPath($ExpectedPath)
  if (-not $Actual.Equals($Expected, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely "HYBRID_EXECUTABLE_PROVENANCE_INVALID"
  }
  [void](Assert-NoReparsePath $Actual $true)
  $Item = Get-Item -Force -LiteralPath $Actual
  if ($Item.PSIsContainer) { Stop-Safely "HYBRID_EXECUTABLE_PROVENANCE_INVALID" }
  return $Actual
}

function ConvertTo-TrustedArguments([string[]]$Arguments) {
  $Encoded = [Collections.Generic.List[string]]::new()
  foreach ($Argument in $Arguments) {
    if ($null -eq $Argument -or $Argument.Contains("`0")) {
      Stop-Safely "HYBRID_PROCESS_ARGUMENT_INVALID"
    }
    if ($Argument -notmatch '[\s"]') {
      $Encoded.Add($Argument)
      continue
    }
    $Builder = [Text.StringBuilder]::new()
    [void]$Builder.Append('"')
    $Backslashes = 0
    foreach ($Character in $Argument.ToCharArray()) {
      if ($Character -eq '\') {
        $Backslashes += 1
        continue
      }
      if ($Character -eq '"') {
        for ($Index = 0; $Index -lt (2 * $Backslashes + 1); $Index += 1) {
          [void]$Builder.Append('\')
        }
        [void]$Builder.Append('"')
      } else {
        for ($Index = 0; $Index -lt $Backslashes; $Index += 1) {
          [void]$Builder.Append('\')
        }
        [void]$Builder.Append($Character)
      }
      $Backslashes = 0
    }
    for ($Index = 0; $Index -lt (2 * $Backslashes); $Index += 1) {
      [void]$Builder.Append('\')
    }
    [void]$Builder.Append('"')
    $Encoded.Add($Builder.ToString())
  }
  return ($Encoded -join ' ')
}

function Invoke-TrustedProcess(
  [string]$FilePath,
  [string[]]$Arguments,
  [Collections.IDictionary]$Environment,
  [string]$WorkingDirectory = "",
  [switch]$CaptureOutput,
  [switch]$Interactive
) {
  $CanonicalFilePath = [IO.Path]::GetFullPath($FilePath)
  if (-not [IO.Path]::IsPathRooted($FilePath) -or
      -not $CanonicalFilePath.Equals($FilePath, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely "HYBRID_EXECUTABLE_PROVENANCE_INVALID"
  }
  $ProcessInfo = [Diagnostics.ProcessStartInfo]::new()
  $ProcessInfo.FileName = $CanonicalFilePath
  $ProcessInfo.Arguments = ConvertTo-TrustedArguments $Arguments
  $ProcessInfo.UseShellExecute = $false
  $ProcessInfo.CreateNoWindow = -not $Interactive
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $ProcessInfo.WorkingDirectory = [IO.Path]::GetFullPath($WorkingDirectory)
  }
  $ProcessInfo.EnvironmentVariables.Clear()
  foreach ($Name in $Environment.Keys) {
    $ProcessInfo.EnvironmentVariables[[string]$Name] = [string]$Environment[$Name]
  }
  $ProcessInfo.RedirectStandardOutput = $CaptureOutput
  $ProcessInfo.RedirectStandardError = $CaptureOutput
  $Process = [Diagnostics.Process]::new()
  $Process.StartInfo = $ProcessInfo
  if (-not $Process.Start()) { Stop-Safely "HYBRID_PROCESS_START_FAILED" }
  try {
    $Stdout = if ($CaptureOutput) { $Process.StandardOutput.ReadToEndAsync() } else { $null }
    $Stderr = if ($CaptureOutput) { $Process.StandardError.ReadToEndAsync() } else { $null }
    $Process.WaitForExit()
    return [PSCustomObject]@{
      ExitCode = $Process.ExitCode
      Stdout = if ($null -eq $Stdout) { "" } else { $Stdout.GetAwaiter().GetResult() }
      Stderr = if ($null -eq $Stderr) { "" } else { $Stderr.GetAwaiter().GetResult() }
    }
  } finally {
    $Process.Dispose()
  }
}

if (-not $ConfirmDockerDesktopPersonal) {
  Stop-Safely "DOCKER_DESKTOP_PERSONAL_CONFIRMATION_REQUIRED"
}

$LocalUser = Get-LocalUser -Name $DedicatedAccount -ErrorAction Stop
$CurrentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$ExpectedIdentityName = "$env:COMPUTERNAME\$DedicatedAccount"
if (-not $LocalUser.Enabled -or
    $LocalUser.SID.Value -ne $CurrentIdentity.User.Value -or
    -not $CurrentIdentity.Name.Equals($ExpectedIdentityName, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Safely "DEDICATED_WINDOWS_ACCOUNT_REQUIRED"
}

$KnownLocalAppData = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::LocalApplicationData
)
$KnownProgramFiles = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::ProgramFiles
)
$KnownWindows = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::Windows
)
$KnownUserProfile = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::UserProfile
)
$KnownProgramData = [Environment]::GetFolderPath(
  [Environment+SpecialFolder]::CommonApplicationData
)
if ([string]::IsNullOrWhiteSpace($KnownLocalAppData) -or
    [string]::IsNullOrWhiteSpace($KnownProgramFiles) -or
    [string]::IsNullOrWhiteSpace($KnownWindows) -or
    [string]::IsNullOrWhiteSpace($KnownUserProfile) -or
    [string]::IsNullOrWhiteSpace($KnownProgramData)) {
  Stop-Safely "HYBRID_KNOWN_FOLDER_INVALID"
}
$ExpectedConfigPath = [IO.Path]::GetFullPath(
  (Join-Path (Join-Path $KnownLocalAppData "Gustavo") "hybrid-worker.env")
)
$ConfigFullPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not $ConfigFullPath.Equals($ExpectedConfigPath, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Safely "HYBRID_CONFIG_PATH_INVALID"
}
$ConfigDirectory = Split-Path -Parent $ConfigFullPath
$ConfigParent = Split-Path -Parent $ConfigDirectory
[void](Assert-NoReparsePath $ConfigParent $true)
if (Test-Path -LiteralPath $ConfigFullPath) { Stop-Safely "HYBRID_CONFIG_ALREADY_EXISTS" }
if (Test-Path -LiteralPath $ConfigDirectory) {
  [void](Assert-NoReparsePath $ConfigDirectory $true)
} else {
  [void][IO.Directory]::CreateDirectory($ConfigDirectory)
  [void](Assert-NoReparsePath $ConfigDirectory $true)
}
# Seal the exact direct-child directory before any secret bytes are assembled.
Set-OwnerOnlyAcl $ConfigDirectory $true $LocalUser.SID
Assert-OwnerOnlyAcl $ConfigDirectory $LocalUser.SID

$DockerExecutable = Assert-TrustedExecutable `
  (Join-Path $KnownProgramFiles "Docker\Docker\resources\bin\docker.exe") `
  (Join-Path $KnownProgramFiles "Docker\Docker\resources\bin\docker.exe")
$NodeExecutable = Assert-TrustedExecutable `
  (Join-Path $KnownProgramFiles "nodejs\node.exe") `
  (Join-Path $KnownProgramFiles "nodejs\node.exe")
$CorepackExecutable = Assert-TrustedExecutable `
  (Join-Path $KnownProgramFiles "nodejs\corepack.cmd") `
  (Join-Path $KnownProgramFiles "nodejs\corepack.cmd")
$TailscaleExecutable = Assert-TrustedExecutable `
  (Join-Path $KnownProgramFiles "Tailscale\tailscale.exe") `
  (Join-Path $KnownProgramFiles "Tailscale\tailscale.exe")
$PowerShellExecutable = Assert-TrustedExecutable `
  (Join-Path $PSHOME "powershell.exe") `
  (Join-Path $PSHOME "powershell.exe")
$CorepackScript = [IO.Path]::GetFullPath(
  (Join-Path $KnownProgramFiles "nodejs\node_modules\corepack\dist\corepack.js")
)
[void](Assert-NoReparsePath $CorepackScript $true)
$System32 = [IO.Path]::GetFullPath((Join-Path $KnownWindows "System32"))
[void](Assert-NoReparsePath $System32 $true)
$BaseChildEnvironment = [ordered]@{
  SystemRoot = $KnownWindows
  WINDIR = $KnownWindows
  USERPROFILE = $KnownUserProfile
  LOCALAPPDATA = $KnownLocalAppData
  ProgramData = $KnownProgramData
  TEMP = [IO.Path]::GetTempPath()
  TMP = [IO.Path]::GetTempPath()
  PATH = $System32
}
$NodeChildEnvironment = [ordered]@{}
$DockerChildEnvironment = [ordered]@{}
$TailscaleChildEnvironment = [ordered]@{}
foreach ($Entry in $BaseChildEnvironment.GetEnumerator()) {
  $NodeChildEnvironment[$Entry.Key] = $Entry.Value
  $DockerChildEnvironment[$Entry.Key] = $Entry.Value
  $TailscaleChildEnvironment[$Entry.Key] = $Entry.Value
}
$NodeChildEnvironment["PATH"] = "$(Split-Path -Parent $NodeExecutable);$System32"
$DockerChildEnvironment["PATH"] = "$(Split-Path -Parent $DockerExecutable);$System32"
$TailscaleChildEnvironment["PATH"] = "$(Split-Path -Parent $TailscaleExecutable);$System32"

$NodeVersionResult = Invoke-TrustedProcess $NodeExecutable @("--version") `
  $NodeChildEnvironment -CaptureOutput
$NodeVersion = $NodeVersionResult.Stdout.Trim()
if ($NodeVersionResult.ExitCode -ne 0 -or $NodeVersion -notmatch '^v24\.') {
  Stop-Safely "NODE_24_REQUIRED"
}
$PnpmVersionResult = Invoke-TrustedProcess $NodeExecutable `
  @($CorepackScript, "pnpm", "--version") $NodeChildEnvironment -CaptureOutput
$PnpmVersion = $PnpmVersionResult.Stdout.Trim()
if ($PnpmVersionResult.ExitCode -ne 0 -or $PnpmVersion -notmatch '^11\.') {
  Stop-Safely "PNPM_11_REQUIRED"
}

$DockerVersion = Invoke-TrustedProcess $DockerExecutable @("version") `
  $DockerChildEnvironment -CaptureOutput
if ($DockerVersion.ExitCode -ne 0) { Stop-Safely "DOCKER_DESKTOP_UNAVAILABLE" }

$TailscaleStatus = Invoke-TrustedProcess $TailscaleExecutable @("status") `
  $TailscaleChildEnvironment -CaptureOutput
if ($TailscaleStatus.ExitCode -ne 0) { Stop-Safely "TAILSCALE_SIGN_IN_REQUIRED" }

foreach ($Name in $RequiredSecrets) {
  [void](Get-RequiredEnvironmentValue $Name)
}
$OrdinaryUri = [Uri](Get-RequiredEnvironmentValue "DATABASE_URL")
$MaterializerUri = [Uri](Get-RequiredEnvironmentValue "GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL")
if ($OrdinaryUri.Scheme -notmatch '^postgres(?:ql)?$' -or $MaterializerUri.Scheme -notmatch '^postgres(?:ql)?$') {
  Stop-Safely "NEON_DATABASE_URL_INVALID"
}
if ($OrdinaryUri.AbsoluteUri -eq $MaterializerUri.AbsoluteUri -or
    $OrdinaryUri.Host -notmatch '-pooler\.' -or $MaterializerUri.Host -notmatch '-pooler\.') {
  Stop-Safely "NEON_POOLED_ROLE_SEPARATION_REQUIRED"
}

# The nested directory is the entire build context. The repository, infra config,
# Docker socket, provider secrets, and host Codex home cannot enter this image.
# The exact argument array below is equivalent to: docker build --pull --no-cache.
$DockerBuild = Invoke-TrustedProcess $DockerExecutable @(
  "build", "--pull", "--no-cache", "--file", (Join-Path $ContainerSource "Dockerfile"),
  "--tag", $ImageTag, $ContainerSource
) $DockerChildEnvironment
if ($DockerBuild.ExitCode -ne 0) { Stop-Safely "CODEX_IMAGE_BUILD_FAILED" }
# Equivalent fixed executable form: docker image inspect --format '{{.Id}}'.
$ImageInspect = Invoke-TrustedProcess $DockerExecutable @(
  "image", "inspect", "--format", "{{.Id}}", $ImageTag
) $DockerChildEnvironment -CaptureOutput
$ImageDigest = $ImageInspect.Stdout.Trim()
if ($ImageInspect.ExitCode -ne 0 -or $ImageDigest -notmatch '^sha256:[a-f0-9]{64}$') {
  Stop-Safely "CODEX_IMAGE_DIGEST_INVALID"
}
$PinnedVersionResult = Invoke-TrustedProcess $DockerExecutable @(
  "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt",
  "no-new-privileges", $ImageDigest, "codex", "--version"
) $DockerChildEnvironment -CaptureOutput
$PinnedVersion = $PinnedVersionResult.Stdout.Trim()
if ($PinnedVersionResult.ExitCode -ne 0 -or $PinnedVersion -notmatch '@openai/codex@0\.146\.0|codex-cli 0\.146\.0') {
  Stop-Safely "CODEX_IMAGE_VERSION_INVALID"
}

$VolumeList = Invoke-TrustedProcess $DockerExecutable @(
  "volume", "ls", "--quiet", "--filter", "name=^${AuthVolume}$"
) $DockerChildEnvironment -CaptureOutput
$ExistingVolume = $VolumeList.Stdout
if ($VolumeList.ExitCode -ne 0) { Stop-Safely "CODEX_AUTH_VOLUME_INVALID" }
if ([string]::IsNullOrWhiteSpace($ExistingVolume)) {
  $VolumeCreate = Invoke-TrustedProcess $DockerExecutable @(
    "volume", "create", $AuthVolume
  ) $DockerChildEnvironment -CaptureOutput
  $CreatedVolume = $VolumeCreate.Stdout.Trim()
  if ($VolumeCreate.ExitCode -ne 0 -or $CreatedVolume -ne $AuthVolume) {
    Stop-Safely "CODEX_AUTH_VOLUME_CREATE_FAILED"
  }
} elseif ($ExistingVolume.Trim() -ne $AuthVolume) {
  Stop-Safely "CODEX_AUTH_VOLUME_INVALID"
}
$VolumeInspect = Invoke-TrustedProcess $DockerExecutable @(
  "volume", "inspect", $AuthVolume
) $DockerChildEnvironment -CaptureOutput
if ($VolumeInspect.ExitCode -ne 0) { Stop-Safely "CODEX_AUTH_VOLUME_INVALID" }

# Interactive ChatGPT device authentication is the only Codex credential path.
# No OpenAI API key or application secret is forwarded to this one-shot container.
$CodexLogin = Invoke-TrustedProcess $DockerExecutable @(
  "run", "--rm", "--interactive", "--tty", "--read-only", "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--mount", "type=volume,source=$AuthVolume,target=/codex-home",
  $ImageDigest, "codex", "login", "--device-auth"
) $DockerChildEnvironment -Interactive
if ($CodexLogin.ExitCode -ne 0) { Stop-Safely "CODEX_CHATGPT_AUTH_FAILED" }

$ConfigLines = [System.Collections.Generic.List[string]]::new()
foreach ($Name in $RequiredSecrets) {
  $ConfigLines.Add("$Name=$(Get-RequiredEnvironmentValue $Name)")
}
$ConfigLines.Add("GUSTAVO_HYBRID_IMAGE_DIGEST=$ImageDigest")
$ConfigLines.Add("GUSTAVO_DOCKER_EXECUTABLE=$DockerExecutable")
$ConfigLines.Add("GUSTAVO_NODE_EXECUTABLE=$NodeExecutable")
$ConfigLines.Add("GUSTAVO_COREPACK_EXECUTABLE=$CorepackExecutable")
$ConfigLines.Add("GUSTAVO_TAILSCALE_EXECUTABLE=$TailscaleExecutable")
$ConfigLines.Add("GUSTAVO_HYBRID_PORT=4318")
$ConfigBytes = [Text.UTF8Encoding]::new($false).GetBytes(($ConfigLines -join "`r`n") + "`r`n")
$CreationStream = [IO.FileStream]::new(
  $ConfigFullPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::Write,
  [IO.FileShare]::None,
  4096,
  [IO.FileOptions]::WriteThrough
)
try {
  $CreationStream.Flush($true)
} finally {
  $CreationStream.Dispose()
}
[void](Assert-NoReparsePath $ConfigFullPath $true)
# The empty file inherits only trusted principals; make its final ACL explicit
# before the first secret byte is written.
Set-OwnerOnlyAcl $ConfigFullPath $false $LocalUser.SID
Assert-OwnerOnlyAcl $ConfigFullPath $LocalUser.SID
$ConfigStream = [IO.FileStream]::new(
  $ConfigFullPath,
  [IO.FileMode]::Open,
  [IO.FileAccess]::Write,
  [IO.FileShare]::None,
  4096,
  [IO.FileOptions]::WriteThrough
)
try {
  $ConfigStream.Write($ConfigBytes, 0, $ConfigBytes.Length)
  $ConfigStream.Flush($true)
} finally {
  $ConfigStream.Dispose()
}
[void](Assert-NoReparsePath $ConfigFullPath $true)
Assert-OwnerOnlyAcl $ConfigFullPath $LocalUser.SID

# Validate the two database identities before installing the exact logon task.
$RoleValidation = Invoke-TrustedProcess $PowerShellExecutable @(
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned",
  "-File", $StartScript, "-ConfigPath", $ConfigFullPath, "-ValidateOnly"
) $BaseChildEnvironment -CaptureOutput
if ($RoleValidation.ExitCode -ne 0) { Stop-Safely "HYBRID_ROLE_VALIDATION_FAILED" }

$Action = New-ScheduledTaskAction -Execute $PowerShellExecutable -Argument (
  "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$StartScript`" -ConfigPath `"$ConfigFullPath`""
)
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $ExpectedIdentityName
$Principal = New-ScheduledTaskPrincipal -UserId $ExpectedIdentityName -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force *> $null

Write-Output "HYBRID_WORKER_SETUP_COMPLETE"
