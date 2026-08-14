[CmdletBinding()]
param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\Gustavo\hybrid-worker.env",
  [switch]$ValidateOnly,
  [switch]$StopForMaintenance
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ExactTaskName = "Gustavo Hybrid Worker"
$ExactTaskPath = "\"
$MaintenancePipeName = "gustavo-hybrid-maintenance-v1"

function Stop-Safely([string]$Code) {
  throw $Code
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
  if (-not $Acl.AreAccessRulesProtected -or $OwnerSid.Value -ne $Owner.Value -or $Rules.Count -ne 2) {
    Stop-Safely "HYBRID_CONFIG_ACL_INVALID"
  }
  $OwnerRuleCount = 0
  $SystemRuleCount = 0
  foreach ($Rule in $Rules) {
    if ($Rule.IdentityReference.Value -eq $Owner.Value) {
      $OwnerRuleCount += 1
    } elseif ($Rule.IdentityReference.Value -eq $System.Value) {
      $SystemRuleCount += 1
    } else {
      Stop-Safely "HYBRID_CONFIG_ACL_INVALID"
    }
    if ($Rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $Rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) {
      Stop-Safely "HYBRID_CONFIG_ACL_INVALID"
    }
  }
  if ($OwnerRuleCount -ne 1 -or $SystemRuleCount -ne 1) {
    Stop-Safely "HYBRID_CONFIG_ACL_INVALID"
  }
}

function New-MaintenancePipeSecurity(
  [Security.Principal.SecurityIdentifier]$Owner
) {
  $PipeSecurity = [IO.Pipes.PipeSecurity]::new()
  $PipeSecurity.SetAccessRuleProtection($true, $false)
  $PipeSecurity.SetOwner($Owner)
  [void]$PipeSecurity.AddAccessRule([IO.Pipes.PipeAccessRule]::new(
    $Owner,
    [IO.Pipes.PipeAccessRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  ))
  $SystemSid = [Security.Principal.SecurityIdentifier]::new(
    [Security.Principal.WellKnownSidType]::LocalSystemSid,
    $null
  )
  [void]$PipeSecurity.AddAccessRule([IO.Pipes.PipeAccessRule]::new(
    $SystemSid,
    [IO.Pipes.PipeAccessRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  ))
  return $PipeSecurity
}

function New-MaintenancePipeServer(
  [string]$PipeName,
  [Security.Principal.SecurityIdentifier]$Owner
) {
  try {
    return [IO.Pipes.NamedPipeServerStream]::new(
      $PipeName,
      [IO.Pipes.PipeDirection]::InOut,
      1,
      [IO.Pipes.PipeTransmissionMode]::Message,
      [IO.Pipes.PipeOptions]::Asynchronous,
      128,
      128,
      (New-MaintenancePipeSecurity $Owner)
    )
  } catch {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
}

function Receive-MaintenancePipeRequest(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [int]$TimeoutMilliseconds = 2000
) {
  $Buffer = [byte[]]::new(128)
  $Read = $Pipe.ReadAsync($Buffer, 0, $Buffer.Length)
  if (-not $Read.Wait($TimeoutMilliseconds)) { return $false }
  $Count = $Read.GetAwaiter().GetResult()
  if ($Count -lt 1 -or -not $Pipe.IsMessageComplete) { return $false }
  $Request = [Text.UTF8Encoding]::new($false, $true).GetString($Buffer, 0, $Count)
  return $Request.Equals("HYBRID_MAINTENANCE_STOP_REQUEST", [StringComparison]::Ordinal)
}

function Write-MaintenancePipeProof(
  [IO.Pipes.PipeStream]$Pipe,
  [string]$Proof
) {
  $Bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes($Proof)
  $Pipe.Write($Bytes, 0, $Bytes.Length)
  $Pipe.Flush()
}

function Wait-MaintenancePipeProofAcknowledgement(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [string]$Proof,
  [int]$TimeoutMilliseconds = 2000
) {
  try {
    $Buffer = [byte[]]::new(128)
    $Read = $Pipe.ReadAsync($Buffer, 0, $Buffer.Length)
    if (-not $Read.Wait($TimeoutMilliseconds)) { return $false }
    $Count = $Read.GetAwaiter().GetResult()
    if ($Count -lt 1 -or -not $Pipe.IsMessageComplete) { return $false }
    $Acknowledgement = [Text.UTF8Encoding]::new($false, $true).GetString(
      $Buffer,
      0,
      $Count
    )
    return $Acknowledgement.Equals(
      "HYBRID_MAINTENANCE_PROOF_RECEIVED:$Proof",
      [StringComparison]::Ordinal
    )
  } catch {
    return $false
  }
}

function Write-MaintenancePipeProofAcknowledgement(
  [IO.Pipes.NamedPipeClientStream]$Pipe,
  [string]$Proof
) {
  $Bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(
    "HYBRID_MAINTENANCE_PROOF_RECEIVED:$Proof"
  )
  $Pipe.Write($Bytes, 0, $Bytes.Length)
  $Pipe.Flush()
}

function Read-MaintenancePipeProof(
  [IO.Pipes.NamedPipeClientStream]$Pipe,
  [int]$TimeoutMilliseconds
) {
  try {
    $Pipe.ReadMode = [IO.Pipes.PipeTransmissionMode]::Message
    $Buffer = [byte[]]::new(128)
    $Read = $Pipe.ReadAsync($Buffer, 0, $Buffer.Length)
    if (-not $Read.Wait($TimeoutMilliseconds)) {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
    $Count = $Read.GetAwaiter().GetResult()
    if ($Count -lt 1 -or -not $Pipe.IsMessageComplete) {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
    return [Text.UTF8Encoding]::new($false, $true).GetString($Buffer, 0, $Count)
  } catch {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
}

function Assert-MaintenancePipeSecurity(
  [IO.Pipes.NamedPipeClientStream]$Pipe,
  [Security.Principal.SecurityIdentifier]$Owner
) {
  try {
    $System = [Security.Principal.SecurityIdentifier]::new(
      [Security.Principal.WellKnownSidType]::LocalSystemSid,
      $null
    )
    $Acl = $Pipe.GetAccessControl()
    $OwnerSid = $Acl.GetOwner([Security.Principal.SecurityIdentifier])
    $Rules = @($Acl.GetAccessRules(
      $true,
      $false,
      [Security.Principal.SecurityIdentifier]
    ))
    if (-not $Acl.AreAccessRulesProtected -or
        $OwnerSid.Value -ne $Owner.Value -or
        $Rules.Count -ne 2) {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
    $OwnerRuleCount = 0
    $SystemRuleCount = 0
    foreach ($Rule in $Rules) {
      if ($Rule.IdentityReference.Value -eq $Owner.Value) {
        $OwnerRuleCount += 1
      } elseif ($Rule.IdentityReference.Value -eq $System.Value) {
        $SystemRuleCount += 1
      } else {
        throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
      }
      if ($Rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          $Rule.PipeAccessRights -ne [IO.Pipes.PipeAccessRights]::FullControl) {
        throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
      }
    }
    if ($OwnerRuleCount -ne 1 -or $SystemRuleCount -ne 1) {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
  } catch {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
}

function Reset-MaintenancePipeConnection(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [ref]$ConnectionTask
) {
  try {
    if ($Pipe.IsConnected) { $Pipe.Disconnect() }
  } catch {}
  $ConnectionTask.Value = $Pipe.WaitForConnectionAsync()
}

function Receive-PendingMaintenanceRequest(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [ref]$ConnectionTask
) {
  if (-not $ConnectionTask.Value.IsCompleted) { return $false }
  $Valid = $false
  try {
    [void]$ConnectionTask.Value.GetAwaiter().GetResult()
    $Valid = Receive-MaintenancePipeRequest $Pipe
  } catch {
    $Valid = $false
  }
  if ($Valid) { return $true }
  try {
    if ($Pipe.IsConnected) {
      Write-MaintenancePipeProof $Pipe "HYBRID_MAINTENANCE_STOP_UNPROVEN"
      [void](Wait-MaintenancePipeProofAcknowledgement `
        $Pipe "HYBRID_MAINTENANCE_STOP_UNPROVEN")
    }
  } catch {}
  Reset-MaintenancePipeConnection $Pipe $ConnectionTask
  return $false
}

function New-LauncherCleanupState {
  return [PSCustomObject]@{
    StopAttempted = $false
    RuntimeSettled = $false
    FunnelSettled = $false
    WorkerReleased = $false
    ProofAcknowledged = $false
    NaturalCleanupSettled = $false
  }
}

function Assert-MaintenanceRuntimeProof([object]$RuntimeProof) {
  $RuntimeProperties = @($RuntimeProof.PSObject.Properties.Name)
  if ($RuntimeProperties.Count -ne 3 -or
      $RuntimeProof.service -ne "gustavo-hybrid-worker-v1" -or
      $RuntimeProof.stopped -ne $true -or
      $RuntimeProof.containerAbsent -ne $true) {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
}

function Invoke-MaintenanceStopTransaction(
  [string]$Request,
  [object]$State,
  [scriptblock]$RequestStop,
  [scriptblock]$FunnelStop
) {
  try {
    if (-not $Request.Equals(
      "HYBRID_MAINTENANCE_STOP_REQUEST",
      [StringComparison]::Ordinal
    )) {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
    $State.StopAttempted = $true
    if (-not $State.RuntimeSettled) {
      $RuntimeProof = & $RequestStop
      Assert-MaintenanceRuntimeProof $RuntimeProof
      $State.RuntimeSettled = $true
    }
    if (-not $State.FunnelSettled) {
      $FunnelProof = & $FunnelStop
      if ($FunnelProof -ne $true) {
        throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
      }
      $State.FunnelSettled = $true
    }
    return "HYBRID_WORKER_MAINTENANCE_STOPPED"
  } catch {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
}

function Invoke-MaintenanceConnection(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [ref]$ConnectionTask,
  [object]$State,
  [object]$Worker,
  [scriptblock]$RequestStop,
  [scriptblock]$FunnelStop
) {
  if (-not (Receive-PendingMaintenanceRequest $Pipe $ConnectionTask)) {
    return $false
  }
  $State.StopAttempted = $true
  try {
    $Proof = Invoke-MaintenanceStopTransaction `
      "HYBRID_MAINTENANCE_STOP_REQUEST" $State $RequestStop $FunnelStop
  } catch {
    try {
      if ($Pipe.IsConnected) {
        Write-MaintenancePipeProof $Pipe "HYBRID_MAINTENANCE_STOP_UNPROVEN"
        [void](Wait-MaintenancePipeProofAcknowledgement `
          $Pipe "HYBRID_MAINTENANCE_STOP_UNPROVEN")
      }
    } catch {}
    Reset-MaintenancePipeConnection $Pipe $ConnectionTask
    return $false
  }
  try {
    if (-not $State.WorkerReleased) {
      $Worker.Dispose()
      $State.WorkerReleased = $true
    }
  } catch {
    Reset-MaintenancePipeConnection $Pipe $ConnectionTask
    return $false
  }
  $Acknowledged = $false
  try {
    Write-MaintenancePipeProof $Pipe $Proof
    $Acknowledged = Wait-MaintenancePipeProofAcknowledgement $Pipe $Proof
  } catch {
    $Acknowledged = $false
  }
  if (-not $Acknowledged) {
    Reset-MaintenancePipeConnection $Pipe $ConnectionTask
    return $false
  }
  $State.ProofAcknowledged = $true
  return $true
}

function Wait-ForMaintenanceSettlement(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [ref]$ConnectionTask,
  [object]$State,
  [object]$Worker,
  [scriptblock]$RequestStop,
  [scriptblock]$FunnelStop
) {
  while ($true) {
    if ($ConnectionTask.Value.IsCompleted -and
        (Invoke-MaintenanceConnection $Pipe $ConnectionTask $State $Worker `
          $RequestStop $FunnelStop)) {
      return
    }
    [void]$ConnectionTask.Value.Wait(250)
  }
}

function Complete-PendingMaintenanceStop(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [ref]$ConnectionTask,
  [object]$State,
  [object]$Worker,
  [scriptblock]$RequestStop,
  [scriptblock]$FunnelStop
) {
  if (-not $ConnectionTask.Value.IsCompleted) { return $false }
  if (Invoke-MaintenanceConnection $Pipe $ConnectionTask $State $Worker `
      $RequestStop $FunnelStop) {
    return $true
  }
  if ($State.StopAttempted) {
    Wait-ForMaintenanceSettlement $Pipe $ConnectionTask $State $Worker `
      $RequestStop $FunnelStop
    return $true
  }
  return $false
}

function Close-MaintenanceAuthority(
  [IO.Pipes.NamedPipeServerStream]$Pipe,
  [object]$State
) {
  $ReleaseProven = $State.ProofAcknowledged -or $State.NaturalCleanupSettled
  if (-not $State.RuntimeSettled -or
      -not $State.FunnelSettled -or
      -not $State.WorkerReleased -or
      -not $ReleaseProven) {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
  try {
    if ($Pipe.IsConnected) { $Pipe.Disconnect() }
  } catch {
  } finally {
    $Pipe.Dispose()
  }
}

function Get-ExactWorkerTask(
  [Security.Principal.SecurityIdentifier]$DedicatedSid,
  [string]$ExpectedPowerShell,
  [string]$ExpectedStartScript,
  [string]$ExpectedConfigPath
) {
  try {
    $Task = Get-ScheduledTask -TaskName $ExactTaskName -TaskPath $ExactTaskPath -ErrorAction Stop
  } catch {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
  $Actions = @($Task.Actions)
  $ExpectedArguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File `"$ExpectedStartScript`" -ConfigPath `"$ExpectedConfigPath`""
  try {
    $TaskSid = ([Security.Principal.NTAccount]$Task.Principal.UserId).Translate(
      [Security.Principal.SecurityIdentifier]
    )
  } catch {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
  if ($null -eq $Task -or
      -not $Task.TaskName.Equals($ExactTaskName, [StringComparison]::Ordinal) -or
      -not $Task.TaskPath.Equals($ExactTaskPath, [StringComparison]::Ordinal) -or
      $TaskSid.Value -ne $DedicatedSid.Value -or
      $Actions.Count -ne 1 -or
      -not ([IO.Path]::GetFullPath([string]$Actions[0].Execute)).Equals(
        $ExpectedPowerShell,
        [StringComparison]::OrdinalIgnoreCase
      ) -or
      -not ([string]$Actions[0].Arguments).Equals(
        $ExpectedArguments,
        [StringComparison]::Ordinal
      ) -or
      @("Ready", "Running", "Queued", "Disabled") -notcontains [string]$Task.State) {
    Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
  }
  return $Task
}

function Wait-ExactWorkerTaskNonRunning(
  [Security.Principal.SecurityIdentifier]$DedicatedSid,
  [string]$ExpectedPowerShell,
  [string]$ExpectedStartScript,
  [string]$ExpectedConfigPath,
  [int]$TimeoutMilliseconds = 5000
) {
  $TaskStopwatch = [Diagnostics.Stopwatch]::StartNew()
  while ($TaskStopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
    $Task = Get-ExactWorkerTask $DedicatedSid $ExpectedPowerShell `
      $ExpectedStartScript $ExpectedConfigPath
    if ([string]$Task.State -notin @("Running", "Queued")) { return }
    Start-Sleep -Milliseconds 100
  }
  Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
}

function Invoke-MaintenanceStopClient(
  [Security.Principal.SecurityIdentifier]$DedicatedSid,
  [string]$ExpectedPowerShell,
  [string]$ExpectedStartScript,
  [string]$ExpectedConfigPath
) {
  $ConnectTimeoutMilliseconds = 5000
  $ProofTimeoutMilliseconds = 50000
  $Pipe = $null
  $Succeeded = $false
  try {
    $Task = Get-ExactWorkerTask $DedicatedSid $ExpectedPowerShell `
      $ExpectedStartScript $ExpectedConfigPath
    if ([string]$Task.State -ne "Running") {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
    $Pipe = [IO.Pipes.NamedPipeClientStream]::new(
      ".",
      "gustavo-hybrid-maintenance-v1",
      [IO.Pipes.PipeDirection]::InOut,
      [IO.Pipes.PipeOptions]::Asynchronous
    )
    $Pipe.Connect($ConnectTimeoutMilliseconds)
    $Pipe.ReadMode = [IO.Pipes.PipeTransmissionMode]::Message
    Assert-MaintenancePipeSecurity $Pipe $DedicatedSid
    $RequestBytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(
      "HYBRID_MAINTENANCE_STOP_REQUEST"
    )
    $Pipe.Write($RequestBytes, 0, $RequestBytes.Length)
    $Pipe.Flush()
    $Proof = Read-MaintenancePipeProof $Pipe $ProofTimeoutMilliseconds
    Write-MaintenancePipeProofAcknowledgement $Pipe $Proof
    if (-not $Proof.Equals(
      "HYBRID_WORKER_MAINTENANCE_STOPPED",
      [StringComparison]::Ordinal
    )) {
      throw "HYBRID_MAINTENANCE_STOP_UNPROVEN"
    }
    Wait-ExactWorkerTaskNonRunning $DedicatedSid $ExpectedPowerShell `
      $ExpectedStartScript $ExpectedConfigPath
    $Succeeded = $true
  } catch {
    $Succeeded = $false
  } finally {
    if ($null -ne $Pipe) { $Pipe.Dispose() }
  }
  if (-not $Succeeded) { Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN" }
  Write-Output "HYBRID_WORKER_MAINTENANCE_STOPPED"
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
  [int]$TimeoutMilliseconds = 0
) {
  if ($TimeoutMilliseconds -lt 0) { Stop-Safely "HYBRID_PROCESS_TIMEOUT_INVALID" }
  $CanonicalFilePath = [IO.Path]::GetFullPath($FilePath)
  if (-not [IO.Path]::IsPathRooted($FilePath) -or
      -not $CanonicalFilePath.Equals($FilePath, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely "HYBRID_EXECUTABLE_PROVENANCE_INVALID"
  }
  $ProcessInfo = [Diagnostics.ProcessStartInfo]::new()
  $ProcessInfo.FileName = $CanonicalFilePath
  $ProcessInfo.Arguments = ConvertTo-TrustedArguments $Arguments
  $ProcessInfo.UseShellExecute = $false
  $ProcessInfo.CreateNoWindow = $true
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
    $TimedOut = $false
    if ($TimeoutMilliseconds -gt 0 -and -not $Process.WaitForExit($TimeoutMilliseconds)) {
      $TimedOut = $true
      try {
        # Kill only the exact Process instance started above; never scan or kill by name.
        $Process.Kill()
      } catch {
        Stop-Safely "HYBRID_PROCESS_TERMINATION_FAILED"
      }
      if (-not $Process.WaitForExit(2000)) {
        Stop-Safely "HYBRID_PROCESS_TERMINATION_FAILED"
      }
    } else {
      $Process.WaitForExit()
    }
    if ($TimedOut) {
      # Do not await redirected output after a timeout: a descendant could keep
      # an inherited pipe open after the exact helper process has terminated.
      return [PSCustomObject]@{
        ExitCode = -1
        Stdout = ""
        Stderr = ""
        TimedOut = $true
      }
    }
    return [PSCustomObject]@{
      ExitCode = $Process.ExitCode
      Stdout = if ($null -eq $Stdout) { "" } else { $Stdout.GetAwaiter().GetResult() }
      Stderr = if ($null -eq $Stderr) { "" } else { $Stderr.GetAwaiter().GetResult() }
      TimedOut = $false
    }
  } finally {
    $Process.Dispose()
  }
}

$CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($ValidateOnly -and $StopForMaintenance) {
  Stop-Safely "HYBRID_MAINTENANCE_STOP_UNPROVEN"
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
[void](Assert-NoReparsePath $ConfigDirectory $true)
[void](Assert-NoReparsePath $ConfigFullPath $true)
if (-not (Test-Path -LiteralPath $ConfigFullPath -PathType Leaf)) {
  Stop-Safely "HYBRID_CONFIG_MISSING"
}
Assert-OwnerOnlyAcl $ConfigDirectory $CurrentSid
Assert-OwnerOnlyAcl $ConfigFullPath $CurrentSid

if ($StopForMaintenance) {
  $ExpectedPowerShell = [IO.Path]::GetFullPath(
    (Join-Path $KnownWindows "System32\WindowsPowerShell\v1.0\powershell.exe")
  )
  $ExpectedStartScript = [IO.Path]::GetFullPath($PSCommandPath)
  [void](Assert-NoReparsePath $ExpectedPowerShell $true)
  [void](Assert-NoReparsePath $ExpectedStartScript $true)
  Invoke-MaintenanceStopClient $CurrentSid $ExpectedPowerShell `
    $ExpectedStartScript $ConfigFullPath
  exit 0
}

$AllowedNames = @(
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
  "FINNHUB_API_KEY",
  "GUSTAVO_HYBRID_IMAGE_DIGEST",
  "GUSTAVO_DOCKER_EXECUTABLE",
  "GUSTAVO_NODE_EXECUTABLE",
  "GUSTAVO_COREPACK_EXECUTABLE",
  "GUSTAVO_TAILSCALE_EXECUTABLE",
  "GUSTAVO_HYBRID_PORT"
)
$WorkerEnvironmentNames = @(
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
  "FINNHUB_API_KEY",
  "GUSTAVO_HYBRID_IMAGE_DIGEST",
  "GUSTAVO_DOCKER_EXECUTABLE",
  "GUSTAVO_HYBRID_PORT"
)
$Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($Line in [IO.File]::ReadAllLines($ConfigFullPath)) {
  $Separator = $Line.IndexOf('=')
  if ($Separator -lt 1) { Stop-Safely "HYBRID_CONFIG_INVALID" }
  $Name = $Line.Substring(0, $Separator)
  $Value = $Line.Substring($Separator + 1)
  if ($AllowedNames -notcontains $Name -or -not $Seen.Add($Name) -or [string]::IsNullOrWhiteSpace($Value)) {
    Stop-Safely "HYBRID_CONFIG_INVALID"
  }
  [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}
if ($Seen.Count -ne $AllowedNames.Count) { Stop-Safely "HYBRID_CONFIG_INCOMPLETE" }

$DockerExecutable = [Environment]::GetEnvironmentVariable("GUSTAVO_DOCKER_EXECUTABLE", "Process")
$NodeExecutable = [Environment]::GetEnvironmentVariable("GUSTAVO_NODE_EXECUTABLE", "Process")
$CorepackExecutable = [Environment]::GetEnvironmentVariable("GUSTAVO_COREPACK_EXECUTABLE", "Process")
$TailscaleExecutable = [Environment]::GetEnvironmentVariable("GUSTAVO_TAILSCALE_EXECUTABLE", "Process")
$ImageDigest = [Environment]::GetEnvironmentVariable("GUSTAVO_HYBRID_IMAGE_DIGEST", "Process")
$PortText = [Environment]::GetEnvironmentVariable("GUSTAVO_HYBRID_PORT", "Process")
$PublicWakeUrl = [Environment]::GetEnvironmentVariable("GUSTAVO_HYBRID_PUBLIC_WAKE_URL", "Process")
if ($ImageDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
    $PortText -notmatch '^[0-9]{4,5}$') {
  Stop-Safely "HYBRID_RUNTIME_CONFIG_INVALID"
}
$DockerExecutable = Assert-TrustedExecutable $DockerExecutable `
  (Join-Path $KnownProgramFiles "Docker\Docker\resources\bin\docker.exe")
$NodeExecutable = Assert-TrustedExecutable $NodeExecutable `
  (Join-Path $KnownProgramFiles "nodejs\node.exe")
$CorepackExecutable = Assert-TrustedExecutable $CorepackExecutable `
  (Join-Path $KnownProgramFiles "nodejs\corepack.cmd")
$TailscaleExecutable = Assert-TrustedExecutable $TailscaleExecutable `
  (Join-Path $KnownProgramFiles "Tailscale\tailscale.exe")
$CorepackScript = [IO.Path]::GetFullPath(
  (Join-Path $KnownProgramFiles "nodejs\node_modules\corepack\dist\corepack.js")
)
$System32 = [IO.Path]::GetFullPath((Join-Path $KnownWindows "System32"))
[void](Assert-NoReparsePath $CorepackScript $true)
[void](Assert-NoReparsePath $System32 $true)
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$TsxCli = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot "node_modules\tsx\dist\cli.mjs"))
$WakeServerScript = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot "worker\hybrid\wake-server.ts"))
[void](Assert-NoReparsePath $RepositoryRoot $true)
[void](Assert-NoReparsePath $TsxCli $true)
[void](Assert-NoReparsePath $WakeServerScript $true)
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
$PnpmVersionResult = Invoke-TrustedProcess $NodeExecutable `
  @($CorepackScript, "pnpm", "--version") $NodeChildEnvironment -CaptureOutput
$NodeVersion = $NodeVersionResult.Stdout.Trim()
$PnpmVersion = $PnpmVersionResult.Stdout.Trim()
if ($NodeVersionResult.ExitCode -ne 0 -or $PnpmVersionResult.ExitCode -ne 0 -or
    $NodeVersion -notmatch '^v24\.' -or $PnpmVersion -notmatch '^11\.') {
  Stop-Safely "HYBRID_NODE_TOOLCHAIN_INVALID"
}
$Port = [int]$PortText
if ($Port -lt 1024 -or $Port -gt 65535) { Stop-Safely "HYBRID_PORT_INVALID" }
$WakeUri = [Uri]$PublicWakeUrl
if ($WakeUri.Scheme -ne "https" -or $WakeUri.AbsolutePath -ne "/wake" -or -not [string]::IsNullOrEmpty($WakeUri.Query)) {
  Stop-Safely "HYBRID_WAKE_URL_INVALID"
}

$DockerVersion = Invoke-TrustedProcess $DockerExecutable @("version") `
  $DockerChildEnvironment -CaptureOutput
if ($DockerVersion.ExitCode -ne 0) { Stop-Safely "DOCKER_DESKTOP_UNAVAILABLE" }
$ImageInspect = Invoke-TrustedProcess $DockerExecutable @(
  "image", "inspect", "--format", "{{.Id}}", $ImageDigest
) $DockerChildEnvironment -CaptureOutput
$InspectedDigest = $ImageInspect.Stdout.Trim()
if ($ImageInspect.ExitCode -ne 0 -or $InspectedDigest -ne $ImageDigest) {
  Stop-Safely "CODEX_IMAGE_DIGEST_MISMATCH"
}
$VolumeInspect = Invoke-TrustedProcess $DockerExecutable @(
  "volume", "inspect", "gustavo-codex-auth-v1"
) $DockerChildEnvironment -CaptureOutput
if ($VolumeInspect.ExitCode -ne 0) { Stop-Safely "CODEX_AUTH_VOLUME_MISSING" }
# Container inspection/reconciliation is exclusively T7-owned while its fixed
# named-pipe lease is held. This launcher performs no container-state query.

# Validate least privilege without printing either pooled connection string,
# login name, database host, or PostgreSQL error detail.
$RoleCheck = @'
import { Pool } from "pg";
const ordinaryUrl = process.env.DATABASE_URL;
const materializerUrl = process.env.GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL;
if (!ordinaryUrl || !materializerUrl || ordinaryUrl === materializerUrl) throw new Error("ROLE_URL_INVALID");
const options = (connectionString) => ({ connectionString, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000 });
const ordinary = new Pool(options(ordinaryUrl));
const materializer = new Pool(options(materializerUrl));
const checkedQuery = async (pool, sql) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await client.query(sql);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
try {
  const ordinaryCheck = await checkedQuery(ordinary, `select current_user,pg_has_role(current_user,'gustavo_market_materializer','MEMBER') member`);
  const scoped = await checkedQuery(materializer, `
    select current_user,
           pg_has_role(current_user,'gustavo_market_materializer','MEMBER') member,
           login.rolcanlogin login,login.rolinherit inherit,
           login.rolsuper superuser,login.rolcreatedb createdb,
           login.rolcreaterole createrole,login.rolreplication replication,
           login.rolbypassrls bypassrls,
           permission.rolcanlogin permission_login,
           permission.rolinherit permission_inherit,
           permission.rolsuper permission_superuser,
           permission.rolcreatedb permission_createdb,
           permission.rolcreaterole permission_createrole,
           permission.rolreplication permission_replication,
           permission.rolbypassrls permission_bypassrls,
           (select count(*)::int from pg_auth_members membership
             join pg_roles granted on granted.oid=membership.roleid
            where membership.member=login.oid
              and granted.rolname<>'gustavo_market_materializer') login_other_memberships,
           (select count(*)::int from pg_auth_members membership
              where membership.member=permission.oid) permission_other_memberships,
           (select count(*)::int from pg_auth_members membership
              where membership.roleid=permission.oid) permission_member_count
      from pg_roles login cross join pg_roles permission
     where login.rolname=current_user and permission.rolname='gustavo_market_materializer'`);
  const ordinaryRow = ordinaryCheck.rows[0];
  const row = scoped.rows[0];
  if (!ordinaryRow || ordinaryRow.member || !row || row.current_user === 'gustavo_market_materializer'
      || !row.member || !row.login || !row.inherit || row.superuser || row.createdb
      || row.createrole || row.replication || row.bypassrls || row.permission_login
      || row.permission_inherit || row.permission_superuser || row.permission_createdb
       || row.permission_createrole || row.permission_replication || row.permission_bypassrls
       || row.login_other_memberships !== 0 || row.permission_other_memberships !== 0
       || row.permission_member_count !== 1) {
    throw new Error("ROLE_SCOPE_INVALID");
  }
} finally {
  await Promise.allSettled([ordinary.end(), materializer.end()]);
}
'@
$RoleStartInfo = [Diagnostics.ProcessStartInfo]::new()
$RoleStartInfo.FileName = $NodeExecutable
$RoleStartInfo.Arguments = ConvertTo-TrustedArguments @($TsxCli, "--eval", $RoleCheck)
$RoleStartInfo.WorkingDirectory = $RepositoryRoot
$RoleStartInfo.UseShellExecute = $false
$RoleStartInfo.CreateNoWindow = $true
$RoleStartInfo.RedirectStandardOutput = $true
$RoleStartInfo.RedirectStandardError = $true
$RoleStartInfo.EnvironmentVariables.Clear()
foreach ($Entry in $NodeChildEnvironment.GetEnumerator()) {
  $RoleStartInfo.EnvironmentVariables[[string]$Entry.Key] = [string]$Entry.Value
}
$RoleStartInfo.EnvironmentVariables["DATABASE_URL"] = `
  [Environment]::GetEnvironmentVariable("DATABASE_URL", "Process")
$RoleStartInfo.EnvironmentVariables["GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL"] = `
  [Environment]::GetEnvironmentVariable("GUSTAVO_MARKET_MATERIALIZER_DATABASE_URL", "Process")
$RoleProcess = [Diagnostics.Process]::new()
$RoleProcess.StartInfo = $RoleStartInfo
if (-not $RoleProcess.Start()) { Stop-Safely "MARKET_MATERIALIZER_ROLE_INVALID" }
try {
  $RoleStdout = $RoleProcess.StandardOutput.ReadToEndAsync()
  $RoleStderr = $RoleProcess.StandardError.ReadToEndAsync()
  $RoleProcess.WaitForExit()
  [void]$RoleStdout.GetAwaiter().GetResult()
  [void]$RoleStderr.GetAwaiter().GetResult()
  $RoleExitCode = $RoleProcess.ExitCode
} finally {
  $RoleProcess.Dispose()
}
if ($RoleExitCode -ne 0) { Stop-Safely "MARKET_MATERIALIZER_ROLE_INVALID" }

if ($ValidateOnly) {
  Write-Output "HYBRID_WORKER_VALIDATION_COMPLETE"
  exit 0
}

$TailscaleStatus = Invoke-TrustedProcess $TailscaleExecutable @("status") `
  $TailscaleChildEnvironment -CaptureOutput
if ($TailscaleStatus.ExitCode -ne 0) { Stop-Safely "TAILSCALE_SIGN_IN_REQUIRED" }
$FunnelCommandTimeoutMilliseconds = 5000
function Invoke-FunnelOff {
  return Invoke-TrustedProcess $TailscaleExecutable @(
    "funnel", "off"
  ) $TailscaleChildEnvironment -CaptureOutput `
    -TimeoutMilliseconds $FunnelCommandTimeoutMilliseconds
}

# Funnel forwards only to the already-started loopback listener. The foreground
# process owns cleanup; no repository, secret file, auth socket, or Docker socket
# is mounted into the Codex container.
$NonceBytes = [byte[]]::new(32)
$Random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $Random.GetBytes($NonceBytes)
} finally {
  $Random.Dispose()
}
$ControlNonce = [Convert]::ToBase64String($NonceBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
function ConvertTo-Base64Url([byte[]]$Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Get-ControlTag([string]$Domain, [string]$Method, [string]$Path, [string]$Challenge) {
  $Hmac = [Security.Cryptography.HMACSHA256]::new(
    [Text.Encoding]::UTF8.GetBytes($ControlNonce)
  )
  try {
    $Message = "$Domain`n$Method`n$Path`n$Challenge"
    $TagBytes = $Hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Message))
    return ConvertTo-Base64Url $TagBytes
  } finally {
    $Hmac.Dispose()
  }
}
function New-ControlRequest([string]$Method, [string]$Path) {
  $ChallengeBytes = [byte[]]::new(32)
  $ChallengeRandom = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $ChallengeRandom.GetBytes($ChallengeBytes)
  } finally {
    $ChallengeRandom.Dispose()
  }
  $Challenge = ConvertTo-Base64Url $ChallengeBytes
  return [PSCustomObject]@{
    Headers = @{
      "x-gustavo-worker-challenge" = $Challenge
      "x-gustavo-worker-control" = Get-ControlTag "request" $Method $Path $Challenge
    }
    ExpectedProof = Get-ControlTag "response" $Method $Path $Challenge
  }
}
function Test-ControlProof([object]$Actual, [string]$Expected) {
  if ($Actual -isnot [string] -or $Actual -notmatch '^[A-Za-z0-9_-]{43}$') {
    return $false
  }
  $ActualBytes = [Text.Encoding]::UTF8.GetBytes([string]$Actual)
  $ExpectedBytes = [Text.Encoding]::UTF8.GetBytes($Expected)
  if ($ActualBytes.Length -ne $ExpectedBytes.Length) { return $false }
  $Difference = 0
  for ($Index = 0; $Index -lt $ActualBytes.Length; $Index += 1) {
    $Difference = $Difference -bor ($ActualBytes[$Index] -bxor $ExpectedBytes[$Index])
  }
  return $Difference -eq 0
}

function Invoke-WorkerStopProof(
  [Diagnostics.Process]$Worker,
  [string]$StopUri,
  [string]$StopPath
) {
  $StopDeadlineMilliseconds = 25000
  $Stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while ($Stopwatch.ElapsedMilliseconds -lt $StopDeadlineMilliseconds) {
    if ($Worker.HasExited) { Stop-Safely "HYBRID_WORKER_STOP_UNPROVEN" }
    $RemainingMilliseconds = [Math]::Max(
      0,
      $StopDeadlineMilliseconds - [int]$Stopwatch.ElapsedMilliseconds
    )
    if ($RemainingMilliseconds -lt 1) { break }
    $RequestTimeoutSeconds = [int][Math]::Max(
      1,
      [Math]::Min(2, [Math]::Ceiling($RemainingMilliseconds / 1000))
    )
    try {
      $StopControl = New-ControlRequest "POST" $StopPath
      $StopProof = Invoke-RestMethod -Method Post -Uri $StopUri `
        -Headers $StopControl.Headers -Body "" -TimeoutSec $RequestTimeoutSeconds
      $StopProperties = @($StopProof.PSObject.Properties.Name)
      if ($StopProperties.Count -ne 4 -or
          $StopProof.service -ne "gustavo-hybrid-worker-v1" -or
          $StopProof.stopped -ne $true -or
          $StopProof.containerAbsent -ne $true -or
          -not (Test-ControlProof $StopProof.proof $StopControl.ExpectedProof)) {
        throw "HYBRID_WORKER_STOP_UNPROVEN"
      }
      $RemainingMilliseconds = [Math]::Max(
        0,
        $StopDeadlineMilliseconds - [int]$Stopwatch.ElapsedMilliseconds
      )
      if (-not $Worker.WaitForExit([int]$RemainingMilliseconds) -or
          $Worker.ExitCode -ne 0) {
        throw "HYBRID_WORKER_STOP_UNPROVEN"
      }
      return [PSCustomObject]@{
        service = "gustavo-hybrid-worker-v1"
        stopped = $true
        containerAbsent = $true
      }
    } catch {}
    $RemainingMilliseconds = [Math]::Max(
      0,
      $StopDeadlineMilliseconds - [int]$Stopwatch.ElapsedMilliseconds
    )
    if ($RemainingMilliseconds -gt 0) {
      Start-Sleep -Milliseconds ([Math]::Min(100, $RemainingMilliseconds))
    }
  }
  Stop-Safely "HYBRID_WORKER_STOP_UNPROVEN"
}

function Invoke-BoundedFunnelStop {
  for ($Attempt = 0; $Attempt -lt 2; $Attempt += 1) {
    $FunnelStopNeedsRetry = $true
    try {
      $FunnelStop = Invoke-FunnelOff
      $FunnelStopNeedsRetry = $FunnelStop.TimedOut -or $FunnelStop.ExitCode -ne 0
    } catch {
      $FunnelStopNeedsRetry = $true
    }
    if (-not $FunnelStopNeedsRetry) { return $true }
  }
  return $false
}

function Invoke-LauncherCleanup(
  [object]$State,
  [object]$Worker,
  [scriptblock]$RequestStop,
  [scriptblock]$FunnelStop
) {
  try {
    [void](Invoke-MaintenanceStopTransaction `
      "HYBRID_MAINTENANCE_STOP_REQUEST" $State $RequestStop $FunnelStop)
  } catch {
    if ($State.RuntimeSettled -and -not $State.FunnelSettled) {
      Stop-Safely "TAILSCALE_FUNNEL_STOP_FAILED"
    }
    throw
  }
  if (-not $State.WorkerReleased) {
    $Worker.Dispose()
    $State.WorkerReleased = $true
  }
  $State.NaturalCleanupSettled = $true
}

$StartInfo = [Diagnostics.ProcessStartInfo]::new()
$StartInfo.FileName = $NodeExecutable
$StartInfo.Arguments = "`"$TsxCli`" `"$WakeServerScript`""
$StartInfo.WorkingDirectory = $RepositoryRoot
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = $true
$StartInfo.EnvironmentVariables.Clear()
$StartInfo.EnvironmentVariables["SystemRoot"] = $KnownWindows
$StartInfo.EnvironmentVariables["WINDIR"] = $KnownWindows
$StartInfo.EnvironmentVariables["LOCALAPPDATA"] = $KnownLocalAppData
foreach ($SystemName in @("TEMP", "TMP", "USERPROFILE", "ProgramData")) {
  $SystemValue = [Environment]::GetEnvironmentVariable($SystemName, "Process")
  if (-not [string]::IsNullOrWhiteSpace($SystemValue)) {
    $StartInfo.EnvironmentVariables[$SystemName] = $SystemValue
  }
}
foreach ($Name in $WorkerEnvironmentNames) {
  $StartInfo.EnvironmentVariables[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
}
$StartInfo.EnvironmentVariables["GUSTAVO_HYBRID_CONTROL_NONCE"] = $ControlNonce
$StartInfo.EnvironmentVariables["PATH"] = @(
  (Split-Path -Parent $NodeExecutable),
  (Split-Path -Parent $DockerExecutable),
  (Join-Path $KnownWindows "System32")
) -join ";"
$MaintenancePipe = New-MaintenancePipeServer $MaintenancePipeName $CurrentSid
$MaintenanceConnectionTask = $MaintenancePipe.WaitForConnectionAsync()
$Worker = [Diagnostics.Process]::new()
$Worker.StartInfo = $StartInfo
$ReadyPath = "/_gustavo/ready"
$StopPath = "/_gustavo/stop"
$ReadyUri = "http://127.0.0.1:$Port$ReadyPath"
$StopUri = "http://127.0.0.1:$Port$StopPath"
$WorkerStarted = $false
$CleanupCompleted = $false
$MaintenanceRequested = $false
$CleanupState = New-LauncherCleanupState
$RequestStop = {
  return Invoke-WorkerStopProof $Worker $StopUri $StopPath
}.GetNewClosure()
$FunnelStop = {
  return Invoke-BoundedFunnelStop
}.GetNewClosure()
try {
  if (-not $Worker.Start()) { Stop-Safely "HYBRID_WORKER_START_FAILED" }
  $WorkerStarted = $true
  $Ready = $false
  # Frozen startup caps: 100 * 300s model execution, 2016 * 12 * 5s
  # market-recovery DB statements, 100 * 100 * 5s model DB statements,
  # plus 300s for container, materializer, heartbeat, and scheduling overhead.
  # The 100-statement/job allowance conservatively exceeds every fixed role path.
  # Total: 201,260,000ms (55h 54m 20s), finite and distinct from the 25s stop bound.
  $MaximumStartupModelJobs = 100
  $MaximumModelRoleMilliseconds = 300000
  $MaximumRecoveryWindows = 2016
  $MaximumDatabaseStatementsPerRecoveryWindow = 12
  $MaximumDatabaseStatementsPerModelJob = 100
  $MaximumDatabaseStatementMilliseconds = 5000
  $FixedStartupOverheadMilliseconds = 300000
  $ReadinessTimeoutMilliseconds = [long](
    $MaximumStartupModelJobs * $MaximumModelRoleMilliseconds +
    $MaximumRecoveryWindows * $MaximumDatabaseStatementsPerRecoveryWindow *
      $MaximumDatabaseStatementMilliseconds +
    $MaximumStartupModelJobs * $MaximumDatabaseStatementsPerModelJob *
      $MaximumDatabaseStatementMilliseconds +
    $FixedStartupOverheadMilliseconds
  )
  $ReadinessPollMilliseconds = 5000
  $ReadyStopwatch = [Diagnostics.Stopwatch]::StartNew()
  while ($ReadyStopwatch.ElapsedMilliseconds -lt $ReadinessTimeoutMilliseconds) {
    if ($MaintenanceConnectionTask.IsCompleted -and
        (Complete-PendingMaintenanceStop $MaintenancePipe `
          ([ref]$MaintenanceConnectionTask) $CleanupState $Worker `
          $RequestStop $FunnelStop)) {
      $MaintenanceRequested = $true
      break
    }
    if ($Worker.HasExited) { Stop-Safely "HYBRID_WORKER_START_FAILED" }
    $RemainingReadinessMilliseconds = [long](
      $ReadinessTimeoutMilliseconds - $ReadyStopwatch.ElapsedMilliseconds
    )
    if ($RemainingReadinessMilliseconds -lt 1000) { break }
    $ReadyRequestTimeoutSeconds = [int][Math]::Min(
      2,
      [Math]::Floor($RemainingReadinessMilliseconds / 1000)
    )
    try {
      $ReadyControl = New-ControlRequest "GET" $ReadyPath
      $ReadyProof = Invoke-RestMethod -Method Get -Uri $ReadyUri `
        -Headers $ReadyControl.Headers -TimeoutSec $ReadyRequestTimeoutSeconds
      $ReadyProperties = @($ReadyProof.PSObject.Properties.Name)
      if ($ReadyProperties.Count -eq 3 -and
          $ReadyProperties -contains "service" -and
          $ReadyProperties -contains "state" -and
          $ReadyProperties -contains "proof" -and
          $ReadyProof.service -eq "gustavo-hybrid-worker-v1" -and
          $ReadyProof.state -eq "READY" -and
          (Test-ControlProof $ReadyProof.proof $ReadyControl.ExpectedProof)) {
        $Ready = $true
        break
      }
      if ($ReadyProperties.Count -eq 3 -and
          $ReadyProperties -contains "service" -and
          $ReadyProperties -contains "state" -and
          $ReadyProperties -contains "proof" -and
          $ReadyProof.service -eq "gustavo-hybrid-worker-v1" -and
          $ReadyProof.state -eq "STARTING" -and
          (Test-ControlProof $ReadyProof.proof $ReadyControl.ExpectedProof)) {
        if ($MaintenanceConnectionTask.IsCompleted -and
            (Complete-PendingMaintenanceStop $MaintenancePipe `
              ([ref]$MaintenanceConnectionTask) $CleanupState $Worker `
              $RequestStop $FunnelStop)) {
          $MaintenanceRequested = $true
          break
        }
        Start-Sleep -Milliseconds ([Math]::Min(
          $ReadinessPollMilliseconds,
          [int][Math]::Max(
            0,
            $ReadinessTimeoutMilliseconds - $ReadyStopwatch.ElapsedMilliseconds
          )
        ))
        continue
      }
    } catch {}
    $RemainingReadinessMilliseconds = [long](
      $ReadinessTimeoutMilliseconds - $ReadyStopwatch.ElapsedMilliseconds
    )
    if (-not $Ready -and $RemainingReadinessMilliseconds -gt 0) {
      Start-Sleep -Milliseconds ([Math]::Min(
        $ReadinessPollMilliseconds,
        [int]$RemainingReadinessMilliseconds
      ))
    }
  }
  if ($MaintenanceRequested) {
    $CleanupCompleted = $true
    exit 0
  }
  if (-not $Ready) { Stop-Safely "HYBRID_WORKER_START_TIMEOUT" }
  # Trusted-absolute equivalent of: tailscale funnel --bg <loopback-url>.
  $FunnelStart = Invoke-TrustedProcess $TailscaleExecutable @(
    "funnel", "--bg", "http://127.0.0.1:$Port"
  ) $TailscaleChildEnvironment -CaptureOutput `
    -TimeoutMilliseconds $FunnelCommandTimeoutMilliseconds
  if ($FunnelStart.TimedOut -or $FunnelStart.ExitCode -ne 0) {
    Stop-Safely "TAILSCALE_FUNNEL_FAILED"
  }
  Write-Output "HYBRID_WORKER_READY"
  while (-not $Worker.HasExited) {
    if ($MaintenanceConnectionTask.IsCompleted -and
        (Complete-PendingMaintenanceStop $MaintenancePipe `
          ([ref]$MaintenanceConnectionTask) $CleanupState $Worker `
          $RequestStop $FunnelStop)) {
      $MaintenanceRequested = $true
      break
    }
    [void]$Worker.WaitForExit(250)
  }
  if ($MaintenanceRequested) {
    $CleanupCompleted = $true
    exit 0
  }
  if ($Worker.ExitCode -ne 0) { Stop-Safely "HYBRID_WORKER_EXITED" }
} finally {
  try {
    if ($WorkerStarted -and -not $CleanupCompleted) {
      try {
        Invoke-LauncherCleanup $CleanupState $Worker $RequestStop $FunnelStop
      } catch {
        Wait-ForMaintenanceSettlement $MaintenancePipe `
          ([ref]$MaintenanceConnectionTask) $CleanupState $Worker `
          $RequestStop $FunnelStop
      }
      $CleanupCompleted = $true
    } elseif (-not $WorkerStarted) {
      $Worker.Dispose()
    }
  } finally {
    if ($WorkerStarted) {
      Close-MaintenanceAuthority $MaintenancePipe $CleanupState
    } else {
      $MaintenancePipe.Dispose()
    }
  }
}
