# Credential-free ownership and retry regression tests; CIM mocks are portable.
$ErrorActionPreference = "Stop"
$env:PI_SCIENCE_SOURCE_ONLY = "1"
try { . (Join-Path $PSScriptRoot "pi-science.ps1") } finally { Remove-Item Env:PI_SCIENCE_SOURCE_ONLY }
$checkout = Join-Path ([System.IO.Path]::GetTempPath()) "pi science checkout"
$entry = Join-Path $checkout "apps/server/dist/app/main.js"
$token = "a" * 32
$created = [datetime]::UtcNow
$script:stops = 0
$script:cimFails = $false
$script:killFails = $false
$script:waitFails = $false
$script:lookupFails = $false
$script:pathFails = $false
$script:absent = $false
$script:replaceStateOnKill = $false
$script:childEnabled = $false
$script:childKillFails = $false
$script:extraProcesses = @()
$script:rootSnapshotOffset = 0
$script:listeningPorts = @()
$script:portsChecked = @()
$script:child = [pscustomobject]@{ StartTime = $created.AddSeconds(1); Path = "node.exe"; HasExited = $false }
$script:child | Add-Member -MemberType ScriptMethod -Name Kill -Value { if ($script:childKillFails) { throw "simulated descendant failure" }; $this.HasExited = $true }
$script:child | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout); return $this.HasExited }
$script:process = [pscustomobject]@{ StartTime = $created; Path = "node.exe"; HasExited = $false }
$script:process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
    if ($script:killFails) { throw "simulated kill failure" }
    $script:stops++
    if (-not $script:waitFails) { $this.HasExited = $true }
    if ($script:replaceStateOnKill) {
        $script:childEnabled = $true
        $updated = $original | ConvertFrom-Json
        $updated.frontend_pid = 456
        $updated | Add-Member -MemberType NoteProperty -Name frontend_started -Value $created.AddSeconds(1).ToUniversalTime().Ticks.ToString()
        $updated | Add-Member -MemberType NoteProperty -Name frontend_executable -Value "node.exe"
        [System.IO.File]::WriteAllText($StateFile, ($updated | ConvertTo-Json -Compress))
    }
}
$script:process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout); return $this.HasExited }
$script:command = 'node.exe "' + (Join-Path $checkout 'scripts/run-service.mjs') + '" --launch-token ' + $token + ' "' + $entry + '"'
function Get-Process {
    [CmdletBinding()]param($Id)
    if ($script:lookupFails) { throw "simulated process lookup failure" }
    if ($script:absent) {
        $errorRecord = [System.Management.Automation.ErrorRecord]::new([ArgumentException]::new("No process"), "NoProcessFoundForGivenId", [System.Management.Automation.ErrorCategory]::ObjectNotFound, $Id)
        $PSCmdlet.ThrowTerminatingError($errorRecord)
    }
    foreach ($extra in $script:extraProcesses) { if ($extra.ProcessId -eq $Id) { return $extra.process } }
    if ($Id -eq 456) { return $script:child }
    $script:process.Path = if ($script:pathFails) { $null } else { "node.exe" }
    return $script:process
}
function Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    if ($script:cimFails) { throw "simulated CIM failure" }
    if ($Filter -like "*456") {
        $frontendCommand = 'node.exe "' + (Join-Path $checkout 'scripts/run-service.mjs') + '" --launch-token ' + $token + ' "' + (Join-Path $checkout 'frontend/node_modules/vite/bin/vite.js') + '"'
        return [pscustomobject]@{ ProcessId = 456; ParentProcessId = 123; CreationDate = $created.AddSeconds(1); CommandLine = $frontendCommand }
    }
    if (-not $Filter -and $script:childEnabled) { [pscustomobject]@{ ProcessId = 456; ParentProcessId = 123; CreationDate = $created.AddSeconds(1) } }
    if (-not $Filter) {
        foreach ($extra in $script:extraProcesses) { [pscustomobject]@{ ProcessId = $extra.ProcessId; ParentProcessId = $extra.ParentProcessId; CreationDate = $extra.CreationDate } }
    }
    [pscustomobject]@{ ProcessId = 123; ParentProcessId = 0; CreationDate = $created.AddTicks($script:rootSnapshotOffset); CommandLine = $script:command }
}
function Test-PortListening { param($Port); $script:portsChecked += $Port; return $script:listeningPorts -contains $Port }
function New-ExtraProcess {
    param([int]$Id, [int]$Parent, $Born)
    $process = [pscustomobject]@{ StartTime = if ($null -ne $Born) { $Born } else { $created }; HasExited = $false }
    $process | Add-Member -MemberType ScriptMethod -Name Kill -Value { $this.HasExited = $true }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($Timeout); return $this.HasExited }
    return [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $Parent; CreationDate = $Born; process = $process }
}
$state = [pscustomobject]@{ checkout = $checkout; mode = "production"; launch_token = $token; control_pid = 123; frontend_pid = 0; control_started = $created.ToUniversalTime().Ticks.ToString(); control_executable = "node.exe" }
function Assert-True { param($Value, $Message); if (-not $Value) { throw $Message } }
Assert-True (Test-OwnedPiProcess $state "control" $checkout) "Valid owned process rejected"
$state.control_started = "0"
Assert-True ((Stop-OwnedPiProcess $state "control" $checkout).status -eq "already_exited") "Reused PID record was not identified as stale"
$state.control_started = $created.ToUniversalTime().Ticks.ToString()
Assert-True ((Stop-OwnedPiProcess $state "control" ($checkout + "-other")).status -eq "unverified") "Different checkout was stopped"
$state.control_executable = "other-node.exe"
Assert-True ((Stop-OwnedPiProcess $state "control" $checkout).status -eq "already_exited") "Different executable was stopped"
$state.control_executable = "node.exe"
$script:command = $script:command.Replace($entry, ($entry + ".other"))
Assert-True ((Stop-OwnedPiProcess $state "control" $checkout).status -eq "unverified") "Different entry point was stopped"
$script:command = $script:command.Replace(($entry + ".other"), $entry).Replace($token, ("b" * 32))
Assert-True ((Stop-OwnedPiProcess $state "control" $checkout).status -eq "unverified") "Different launch token was stopped"
$script:command = $script:command.Replace(("b" * 32), $token)
Assert-True ((Stop-OwnedPiProcess $null "control" $checkout).status -eq "unverified") "Missing state was accepted"
Assert-True ($script:stops -eq 0) "An unverified process was killed"

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("pi science stop tests " + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporary | Out-Null
$ProjectDir = $checkout
$RuntimeDir = $temporary
$StateFile = Join-Path $temporary "run.state"
$original = $state | ConvertTo-Json -Compress
try {
    foreach ($failure in @("cimFails", "lookupFails", "pathFails", "killFails", "waitFails")) {
        $script:process.HasExited = $false
        [System.IO.File]::WriteAllText($StateFile, $original)
        Set-Variable -Scope Script -Name $failure -Value $true
        Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Stop failure returned success: $failure"
        Assert-True ((Get-Content -LiteralPath $StateFile -Raw) -eq $original) "Stop failure lost identity state: $failure"
        Set-Variable -Scope Script -Name $failure -Value $false
        Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Retry did not succeed: $failure"
        Assert-True (-not (Test-Path -LiteralPath $StateFile)) "Successful retry left state: $failure"
    }
    $script:process.HasExited = $false
    $script:childEnabled = $true
    $script:childKillFails = $true
    $before = $script:stops
    [System.IO.File]::WriteAllText($StateFile, $original)
    Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Descendant failure returned success"
    Assert-True ($script:stops -eq $before -and -not $script:process.HasExited) "Descendant failure killed the root"
    Assert-True ((Get-Content -LiteralPath $StateFile -Raw) -eq $original) "Descendant failure lost identity"
    $script:childKillFails = $false
    Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Descendant stop retry failed"
    Assert-True ($script:child.HasExited -and -not (Test-Path -LiteralPath $StateFile)) "Descendant retry left processes or state"
    # start.ps1 can publish a frontend PID under the same launch marker while
    # stop is in flight. The refreshed record must also be confirmed exited.
    $script:process.HasExited = $false
    $script:child.HasExited = $false
    $script:childEnabled = $false
    $script:replaceStateOnKill = $true
    [System.IO.File]::WriteAllText($StateFile, $original)
    Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Changed launch state was treated as stopped"
    Assert-True ((Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json).frontend_pid -eq 456) "Newly published identity was deleted"
    Assert-True (-not $script:child.HasExited) "An unrecorded frontend was stopped"
    $script:replaceStateOnKill = $false
    Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Changed launch state could not be retried"
    Assert-True ($script:child.HasExited -and -not (Test-Path -LiteralPath $StateFile)) "Changed-state retry left process or state"
    # A reused root PPID and an invalid intermediate edge must exclude entire
    # foreign branches, while genuine child and grandchild cleanup still works.
    $script:process.HasExited = $false
    $script:child.HasExited = $false
    $script:childEnabled = $true
    $script:extraProcesses = @(
        (New-ExtraProcess 789 123 $created.AddSeconds(-1)),
        (New-ExtraProcess 790 789 $created.AddSeconds(2)),
        (New-ExtraProcess 791 456 $created.AddMilliseconds(500)),
        (New-ExtraProcess 792 791 $created.AddSeconds(3)),
        (New-ExtraProcess 793 456 $created.AddSeconds(2)),
        (New-ExtraProcess 794 123 $null)
    )
    [System.IO.File]::WriteAllText($StateFile, $original)
    Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Valid tree did not stop"
    foreach ($foreign in @($script:extraProcesses | Where-Object { $_.ProcessId -ne 793 })) {
        Assert-True (-not $foreign.process.HasExited) "A foreign or unverifiable branch was killed"
    }
    Assert-True ($script:extraProcesses[4].process.HasExited -and $script:child.HasExited -and $script:process.HasExited) "Genuine descendant cleanup failed"
    $script:extraProcesses = @()
    $script:childEnabled = $false
    $script:process.HasExited = $false
    $script:rootSnapshotOffset = -10000000
    [System.IO.File]::WriteAllText($StateFile, $original)
    $before = $script:stops
    Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Stale root snapshot was accepted"
    Assert-True ($script:stops -eq $before -and (Test-Path -LiteralPath $StateFile)) "Stale snapshot signaled root or lost state"
    $script:rootSnapshotOffset = 0
    Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Fresh root snapshot could not be retried"
    # A parent recycled after enumeration must not authorize killing a leaf.
    $script:process.HasExited = $false
    $script:childEnabled = $true
    $script:child.HasExited = $false
    $script:child.StartTime = $created.AddSeconds(2)
    $script:extraProcesses = @((New-ExtraProcess 795 456 $created.AddSeconds(3)))
    [System.IO.File]::WriteAllText($StateFile, $original)
    Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Recycled ancestor was accepted"
    Assert-True (-not $script:extraProcesses[0].process.HasExited -and -not $script:child.HasExited -and -not $script:process.HasExited) "Recycled ancestor's branch was killed"
    Assert-True (Test-Path -LiteralPath $StateFile) "Recycled ancestor lost retry state"
    $script:child.StartTime = $created.AddSeconds(1)
    Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Stable ancestor retry failed"
    $script:extraProcesses = @()
    $script:childEnabled = $false
    $script:process.HasExited = $false
    $script:absent = $true
    [System.IO.File]::WriteAllText($StateFile, $original)
    Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Exited process was not handled"
    Assert-True (-not (Test-Path -LiteralPath $StateFile)) "Exited process left stale state"
    # Port diagnostics follow the deployment mode, never ownership by port.
    $previousMode = $env:PI_SCIENCE_MODE
    try {
        $env:PI_SCIENCE_MODE = "production"
        $script:listeningPorts = @(5173)
        $script:portsChecked = @()
        Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Production stop treated a foreign Vite port as relevant"
        Assert-True ($script:portsChecked -notcontains 5173) "Production stop probed a development port"
        $env:PI_SCIENCE_MODE = "dev"
        Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Development stop missed the relevant Vite conflict"
        $env:PI_SCIENCE_MODE = "production"
        $script:listeningPorts = @(8787)
        Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Unverified control listener was silently treated as ours"
        $expired = $original | ConvertFrom-Json
        $expired | Add-Member -MemberType NoteProperty -Name control_plane_port -Value 41001
        $expired | Add-Member -MemberType NoteProperty -Name frontend_port -Value 41002
        $script:listeningPorts = @(5173, 41002)
        $script:portsChecked = @()
        $env:PI_SCIENCE_MODE = "dev"
        [System.IO.File]::WriteAllText($StateFile, ($expired | ConvertTo-Json -Compress))
        Assert-True ((Stop-PiScience 8787 5173) -eq 0) "Stored production mode did not override caller mode"
        Assert-True ($script:portsChecked.Count -eq 1 -and $script:portsChecked[0] -eq 41001) "Stored production port was not used"
        $expired.mode = "dev"
        $env:PI_SCIENCE_MODE = "production"
        [System.IO.File]::WriteAllText($StateFile, ($expired | ConvertTo-Json -Compress))
        Assert-True ((Stop-PiScience 8787 5173) -eq 1) "Stored development port was ignored"
        Assert-True ($script:portsChecked -contains 41002) "Stored development mode was not used"
    } finally { $env:PI_SCIENCE_MODE = $previousMode; $script:listeningPorts = @(); $script:portsChecked = @() }
    $script:absent = $false
    [System.IO.File]::WriteAllText((Join-Path $temporary "control-plane.log"), "stdout-marker")
    [System.IO.File]::WriteAllText((Join-Path $temporary "control-plane.log.err"), "stderr-marker")
    [System.IO.File]::WriteAllText((Join-Path $temporary "frontend.log.err"), "frontend-error-marker")
    $logs = Show-PiLogs | Out-String
    Assert-True ($logs.Contains("stdout-marker") -and $logs.Contains("stderr-marker") -and $logs.Contains("frontend-error-marker")) "Default logs omitted output"
    $errors = Show-PiLogs -Options @("--stderr") | Out-String
    Assert-True ($errors.Contains("stderr-marker") -and -not $errors.Contains("stdout-marker")) "stderr selection is incorrect"
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force }
Write-Output "Windows process ownership, stop retry and log tests passed."
