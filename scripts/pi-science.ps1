<#
.SYNOPSIS
    Command-line launcher for a Pi-Science checkout on Windows.

.DESCRIPTION
    Supports start, stop, status, and help. The run.state file is written by
    start.ps1 after both services are healthy, so stop can target the exact
    processes started by this checkout. If state is unavailable, stop falls
    back to the configured listening ports.
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

function Get-ListeningProcessIds {
    param([int]$Port)

    $ids = @()
    $netTcp = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
    if ($null -ne $netTcp) {
        try {
            $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess)
        } catch {
            $ids = @()
        }
    }

    if ($ids.Count -eq 0) {
        try {
            foreach ($line in @(netstat.exe -ano -p tcp 2>$null)) {
                if ($line -match ("^\s*TCP\s+\S+:" + $Port + "\s+\S+\s+LISTENING\s+(\d+)\s*$")) {
                    $ids += [int]$matches[1]
                }
            }
        } catch {
            # netstat may be unavailable in a restricted environment.
        }
    }
    return @($ids | Sort-Object -Unique)
}

function Stop-PiProcessId {
    param([int]$ProcessId)

    if ($ProcessId -le 0) {
        return $false
    }
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Remove-RunState {
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    }
}

function Stop-PiScience {
    param([int]$ControlPlanePort, [int]$FrontendPort, [int]$ScientificRuntimePort)

    $state = Read-RunState
    $stopped = $false
    if ($null -ne $state) {
        foreach ($property in @("frontend_pid", "control_pid")) {
            $value = $state.$property
            $processId = 0
            if ([int]::TryParse([string]$value, [ref]$processId)) {
                if (Stop-PiProcessId -ProcessId $processId) {
                    $stopped = $true
                }
            }
        }
        Remove-RunState
    }

    # A state file can be absent after a crash, or the process can have been
    # started by start.ps1 before it had a chance to persist state. In that
    # case use the local service ports as the recovery signal.
    if (-not $stopped) {
        $fallbackIds = @()
        foreach ($port in @($ControlPlanePort, $FrontendPort, $ScientificRuntimePort)) {
            $fallbackIds += @(Get-ListeningProcessIds -Port $port)
        }
        foreach ($processId in @($fallbackIds | Sort-Object -Unique)) {
            if (Stop-PiProcessId -ProcessId ([int]$processId)) {
                $stopped = $true
            }
        }
    }

    if ($stopped) {
        Write-Output "Pi-Science stopped."
    } else {
        Write-Output "Pi-Science is not running."
    }
}

function Show-PiStatus {
    param([int]$ControlPlanePort, [int]$FrontendPort, [int]$ScientificRuntimePort)

    $state = Read-RunState
    $controlReady = Test-PortListening -Port $ControlPlanePort
    $frontendReady = Test-PortListening -Port $FrontendPort
    $runtimeReady = Test-PortListening -Port $ScientificRuntimePort
    $stateProcess = $false
    if ($null -ne $state) {
        foreach ($property in @("control_pid", "frontend_pid")) {
            $processId = 0
            if ([int]::TryParse([string]$state.$property, [ref]$processId) -and $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                $stateProcess = $true
            }
        }
    }

    if (($null -ne $state -and $stateProcess) -or ($controlReady -and $frontendReady)) {
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
    if ($runtimeReady) {
        Write-Output "Python worker: listening on port $ScientificRuntimePort"
    } else {
        Write-Output "Python worker: idle (started on demand)"
    }
    if ($null -ne $state) {
        Write-Output "State: $StateFile"
    }
    Write-Output "Checkout: $ProjectDir"
}

function Show-PiHelp {
    Write-Output @"
pi-science - Scientific AI Workbench

Usage:
  pi-science [start]       Start the control plane and frontend
  pi-science stop          Stop services started from this checkout
  pi-science status        Report what is currently running
  pi-science help          Show this message
"@
}

$command = "start"
$remaining = @()
if ($args.Count -gt 0) {
    $command = [string]$args[0]
    if ($args.Count -gt 1) {
        $remaining = @($args[1..($args.Count - 1)])
    }
}

switch ($command.ToLowerInvariant()) {
    "start" {
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
        $frontendPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
        $runtimePort = Get-PositivePort -EnvironmentName "PI_SCIENCE_RUNTIME_PORT" -Default 8788
        Stop-PiScience -ControlPlanePort $controlPort -FrontendPort $frontendPort -ScientificRuntimePort $runtimePort
        exit 0
    }
    "status" {
        $controlPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
        $frontendPort = Get-PositivePort -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
        $runtimePort = Get-PositivePort -EnvironmentName "PI_SCIENCE_RUNTIME_PORT" -Default 8788
        Show-PiStatus -ControlPlanePort $controlPort -FrontendPort $frontendPort -ScientificRuntimePort $runtimePort
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
