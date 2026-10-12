<#
.SYNOPSIS
    Command-line launcher for a Pi-Science checkout on Windows.

.DESCRIPTION
    Supports install, doctor, start, stop, status, logs and help. The run.state
    file is written by start.ps1 as processes launch, so stop can target the exact
    processes started by this checkout. Missing or stale identity never permits
    terminating a process solely because it occupies a configured port.
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir ".runtime\pi-science"
$StateFile = Join-Path $RuntimeDir "run.state"

function Get-PositivePort {
    param([string]$EnvironmentName, [int]$Default)

    $raw = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $Default
    }
    $value = 0
    if (-not [int]::TryParse($raw, [ref]$value) -or $value -lt 1 -or $value -gt 65535) {
        throw "$EnvironmentName must be an integer between 1 and 65535."
    }
    return $value
}

function Read-RunState {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        return $null
    }
    try {
        return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Test-PortListening {
    param([int]$Port)

    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect("127.0.0.1", $Port)
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $client) {
            $client.Close()
        }
    }
}

. (Join-Path $ScriptDir "process-identity.ps1")

function Remove-RunState {
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    }
}

function Stop-PiScience {
    param([int]$ControlPlanePort, [int]$FrontendPort)

    $state = Read-RunState
    $stopped = $false
    if ($null -ne $state) {
        $results = @()
        foreach ($role in @("frontend", "control")) {
            $result = Stop-OwnedPiProcess -State $state -Role $role -Checkout $ProjectDir
            $results += $result
            if ($result.status -eq "stopped") { $stopped = $true }
            if ($result.status -in @("unverified", "failed")) { Write-Host ("Cannot stop ${role}: " + $result.reason) }
        }
        if (@($results | Where-Object { $_.status -notin @("stopped", "already_exited") }).Count -gt 0) {
            Write-Host "Stop incomplete; process identity state was preserved. Retry pi-science stop."
            return 1
        }
        # Do not remove a newer launch's state if the pathname was replaced.
        $current = Read-RunState
        if ($null -ne $current -and $current.launch_token -eq $state.launch_token) {
            $currentIdentities = @("frontend", "control") | ForEach-Object { Get-PiProcessIdentity -State $current -Role $_ -Checkout $ProjectDir }
            if (@($currentIdentities | Where-Object { $_.status -ne "already_exited" }).Count -gt 0) {
                Write-Host "Process state changed during stop; identity was preserved. Retry pi-science stop."
                return 1
            }
            Remove-RunState
        }
    }
    if (-not $stopped) {
        $mode = if ($env:PI_SCIENCE_MODE -eq "dev") { "dev" } else { "production" }
        if ($null -ne $state -and $state.checkout -ieq $ProjectDir -and $state.mode -in @("production", "dev") -and $state.launch_token -match '^[a-f0-9]{32}$') {
            $mode = $state.mode
            $recordedPort = 0
            if ([int]::TryParse([string]$state.control_plane_port, [ref]$recordedPort) -and $recordedPort -ge 1 -and $recordedPort -le 65535) { $ControlPlanePort = $recordedPort }
            if ([int]::TryParse([string]$state.frontend_port, [ref]$recordedPort) -and $recordedPort -ge 1 -and $recordedPort -le 65535) { $FrontendPort = $recordedPort }
        }
        $ports = @($ControlPlanePort)
        if ($mode -eq "dev") { $ports += $FrontendPort }
        $occupied = @($ports | Sort-Object -Unique | Where-Object { Test-PortListening $_ })
        if ($occupied.Count -gt 0) {
            Write-Host ("No verified Pi-Science instance is running. Relevant ports occupied by unverified listeners: " + ($occupied -join ", ") + "; no process was stopped.")
            return 1
        }
    }
    if ($stopped) { Write-Host "Pi-Science stopped." } else { Write-Host "Pi-Science is not running." }
    return 0
}

function Show-PiStatus {
    param([int]$ControlPlanePort, [int]$FrontendPort)

    $state = Read-RunState
    if ($null -ne $state -and $state.checkout -ieq $ProjectDir) {
        $ControlPlanePort = [int]$state.control_plane_port
        $FrontendPort = if ($state.mode -eq "production") { $ControlPlanePort } else { [int]$state.frontend_port }
    }
    $controlReady = Test-PortListening -Port $ControlPlanePort
    $frontendReady = Test-PortListening -Port $FrontendPort
    $stateProcess = $false
    if ($null -ne $state) {
        foreach ($property in @("control_pid", "frontend_pid")) {
            $processId = 0
            if (Test-OwnedPiProcess -State $state -Role ($property -replace "_pid$", "") -Checkout $ProjectDir) {
                $stateProcess = $true
            }
        }
    }

    if ($stateProcess) {
        Write-Output "Pi-Science: RUNNING"
    } else {
        Write-Output "Pi-Science: stopped"
    }
    if ($controlReady) {
        Write-Output "Node control plane: ready on port $ControlPlanePort"
    } else {
        Write-Output "Node control plane: not responding on port $ControlPlanePort"
    }
    if ($frontendReady) {
        Write-Output "Frontend: ready on port $FrontendPort"
    } else {
        Write-Output "Frontend: not responding on port $FrontendPort"
    }
    if ($null -ne $state) {
        Write-Output "State: $StateFile"
    }
    Write-Output "Checkout: $ProjectDir"
}

function Show-PiLogs {
    param([string[]]$Options = @())
    if ($Options.Count -gt 1 -or ($Options.Count -eq 1 -and $Options[0] -notin @("--all", "--stderr"))) {
        throw "Usage: pi-science logs [--all|--stderr]"
    }
    $files = if ($Options -contains "--stderr") { @("control-plane.log.err", "frontend.log.err") } else { @("control-plane.log", "control-plane.log.err", "frontend.log", "frontend.log.err") }
    $found = $false
    foreach ($file in $files) {
        $path = Join-Path $RuntimeDir $file
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $found = $true
            Write-Output "==> $file"
            Get-Content -LiteralPath $path
        }
    }
    if (-not $found) { Write-Output "No runtime logs found in $RuntimeDir." }
}

function Show-PiHelp {
    Write-Output @"
pi-science - Scientific AI Workbench

Usage:
  pi-science [start]       Start the production build on port 8787
  pi-science start --dev   Start source code and Vite on port 5173
  pi-science install       Install dependencies and build
  pi-science doctor        Check prerequisites without downloads
  pi-science logs [--stderr]  Print stdout/stderr logs (or stderr only)
  pi-science stop          Stop services started from this checkout
  pi-science status        Report what is currently running
  pi-science help          Show this message
"@
}

if ($env:PI_SCIENCE_SOURCE_ONLY -eq "1") { return }

$command = "start"
$remaining = @()
if ($args.Count -gt 0) {
    $command = [string]$args[0]
    if ($args.Count -gt 1) {
        $remaining = @($args[1..($args.Count - 1)])
    }
}

switch ($command.ToLowerInvariant()) {
    "install" { & (Join-Path $ScriptDir "install.ps1") @remaining; exit $LASTEXITCODE }
    "doctor" {
        $node = if ($env:PI_NODE_PATH) { $env:PI_NODE_PATH } else { "node" }
        & $node (Join-Path $ScriptDir "doctor.mjs") @remaining
        exit $LASTEXITCODE
    }
    "logs" { Show-PiLogs -Options $remaining; exit 0 }
    "start" {
        if ($remaining -contains "--dev") {
            $remaining = @($remaining | Where-Object { $_ -ne "--dev" })
            & (Join-Path $ScriptDir "start.ps1") -Dev @remaining
            exit $LASTEXITCODE
        }
        $startScript = Join-Path $ScriptDir "start.ps1"
        if ($remaining.Count -gt 0) {
            & $startScript @remaining
        } else {
            & $startScript
        }
        exit $LASTEXITCODE
    }
    "stop" {
        $controlPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
        $stopState = Read-RunState
        $devMode = $env:PI_SCIENCE_MODE -eq "dev" -or ($null -ne $stopState -and $stopState.checkout -ieq $ProjectDir -and $stopState.mode -eq "dev")
        $frontendPort = if ($devMode) { Get-PositivePort -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173 } else { 5173 }
        exit (Stop-PiScience -ControlPlanePort $controlPort -FrontendPort $frontendPort)
    }
    "status" {
        $controlPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
        $frontendPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
        Show-PiStatus -ControlPlanePort $controlPort -FrontendPort $frontendPort
        exit 0
    }
    "help" { Show-PiHelp; exit 0 }
    "-h" { Show-PiHelp; exit 0 }
    "--help" { Show-PiHelp; exit 0 }
    default {
        Write-Error "Unknown command: $command"
        Show-PiHelp
        exit 2
    }
}
