<#
.SYNOPSIS
    Starts the Pi-Science control plane and frontend on Windows.

.DESCRIPTION
    This is the PowerShell equivalent of start.sh. It deliberately uses
    node.exe directly instead of .cmd shims so paths containing spaces work in
    both Windows PowerShell 5.1 and PowerShell 7.
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir ".runtime\pi-science"
$InstallStateFile = Join-Path $RuntimeDir "install.env"
$StateFile = Join-Path $RuntimeDir "run.state"

function Read-InstallEnv {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $values
    }

    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            continue
        }
        $key = $matches[1].ToUpperInvariant()
        $value = $matches[2]
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq "'" -and $last -eq "'") -or ($first -eq '"' -and $last -eq '"')) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        $values[$key] = $value
    }
    return $values
}

function Get-ConfiguredValue {
    param(
        [string]$EnvironmentName,
        [string]$InstallName,
        [hashtable]$InstallValues,
        [string]$Default = ""
    )

    $current = [Environment]::GetEnvironmentVariable($EnvironmentName, "Process")
    if (-not [string]::IsNullOrWhiteSpace($current)) {
        return $current
    }
    if ($InstallValues.ContainsKey($InstallName) -and -not [string]::IsNullOrWhiteSpace([string]$InstallValues[$InstallName])) {
        return [string]$InstallValues[$InstallName]
    }
    return $Default
}

function Resolve-Executable {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }
    if (Test-Path -LiteralPath $Value -PathType Leaf) {
        return (Resolve-Path -LiteralPath $Value).Path
    }
    $command = Get-Command $Value -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $null
    }
    if ($command.CommandType -eq "Application" -and $command.Source) {
        return $command.Source
    }
    return $command.Name
}

function Get-PositiveInteger {
    param(
        [string]$EnvironmentName,
        [int]$Default
    )

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

function Test-PortAvailable {
    param([int]$Port)

    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

function Test-HttpReady {
    param([string]$Uri)

    try {
        $null = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Stop-PiProcess {
    param([System.Diagnostics.Process]$Process)

    if ($null -eq $Process) {
        return
    }
    try {
        if (-not $Process.HasExited) {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # The process may have exited between HasExited and Stop-Process.
    }
}

function Write-RunState {
    param(
        [System.Diagnostics.Process]$ControlPlane,
        [System.Diagnostics.Process]$Frontend,
        [int]$ControlPlanePort,
        [int]$FrontendPort
    )

    $state = [ordered]@{
        control_pid = $ControlPlane.Id
        frontend_pid = $Frontend.Id
        control_plane_port = $ControlPlanePort
        frontend_port = $FrontendPort
        started_at = (Get-Date).ToUniversalTime().ToString("o")
    }
    $temporary = "$StateFile.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $StateFile -Force
}

$installValues = Read-InstallEnv -Path $InstallStateFile
$piCliValue = Get-ConfiguredValue -EnvironmentName "PI_CLI_PATH" -InstallName "PI_SCIENCE_INSTALL_PI_CLI" -InstallValues $installValues
$nodeValue = Get-ConfiguredValue -EnvironmentName "PI_NODE_PATH" -InstallName "PI_NODE_PATH" -InstallValues @{}

$PiCliPath = Resolve-Executable $piCliValue
$NodePath = Resolve-Executable $nodeValue
if (-not $NodePath) {
    $NodePath = Resolve-Executable "node"
}

if (-not $PiCliPath) {
    throw "Pi runtime is not installed. Run: powershell -File scripts/install.ps1"
}
if (-not $NodePath) {
    throw "Node.js >=22.12.0 is required. Run: powershell -File scripts/install.ps1"
}

$NodeVersionCheck = Join-Path $ScriptDir "check-node-version.mjs"
& $NodePath $NodeVersionCheck
if ($LASTEXITCODE -ne 0) {
    throw "Node.js >=22.12.0 is required."
}

$ControlPlaneCli = Join-Path $ProjectDir "apps\server\node_modules\tsx\dist\cli.mjs"
$ViteScript = Join-Path $ProjectDir "frontend\node_modules\vite\bin\vite.js"
if (-not (Test-Path -LiteralPath $ControlPlaneCli -PathType Leaf)) {
    throw "Server dependencies are not installed. Run: powershell -File scripts/install.ps1"
}
if (-not (Test-Path -LiteralPath $ViteScript -PathType Leaf)) {
    throw "Frontend dependencies are not installed. Run: powershell -File scripts/install.ps1"
}

$ControlPlanePort = Get-PositiveInteger -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
$FrontendPort = Get-PositiveInteger -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
$StartupTimeout = Get-PositiveInteger -EnvironmentName "PI_SCIENCE_STARTUP_TIMEOUT_SECONDS" -Default 90

if (-not (Test-PortAvailable -Port $ControlPlanePort)) {
    throw "Port $ControlPlanePort is already in use."
}
if (-not (Test-PortAvailable -Port $FrontendPort)) {
    throw "Port $FrontendPort is already in use."
}

$env:PI_CLI_PATH = $PiCliPath
$env:PI_NODE_PATH = $NodePath
$env:PI_SCIENCE_HOME = if ($env:PI_SCIENCE_HOME) { $env:PI_SCIENCE_HOME } else { Join-Path $HOME ".pi-science" }
$env:PI_SCIENCE_WORKSPACES = if ($env:PI_SCIENCE_WORKSPACES) { $env:PI_SCIENCE_WORKSPACES } else { Join-Path $HOME "pi-science-workspaces" }
$env:PI_SCIENCE_INTERNAL_TOKEN = if ($env:PI_SCIENCE_INTERNAL_TOKEN) { $env:PI_SCIENCE_INTERNAL_TOKEN } else { [guid]::NewGuid().ToString("N") }
$env:PI_SCIENCE_REQUIRE_INTERNAL_TOKEN = if ($env:PI_SCIENCE_REQUIRE_INTERNAL_TOKEN) { $env:PI_SCIENCE_REQUIRE_INTERNAL_TOKEN } else { "1" }
$env:PI_SCIENCE_PORT = "$ControlPlanePort"
$env:PI_SCIENCE_BACKEND_URL = if ($env:PI_SCIENCE_BACKEND_URL) { $env:PI_SCIENCE_BACKEND_URL } else { "http://127.0.0.1:$ControlPlanePort" }
$env:PI_SCIENCE_NODE_SESSIONS = if ($env:PI_SCIENCE_NODE_SESSIONS) { $env:PI_SCIENCE_NODE_SESSIONS } else { "1" }
$env:PI_SCIENCE_NODE_SSE = if ($env:PI_SCIENCE_NODE_SSE) { $env:PI_SCIENCE_NODE_SSE } else { "1" }
$env:PI_SCIENCE_NODE_PI_MANAGER = if ($env:PI_SCIENCE_NODE_PI_MANAGER) { $env:PI_SCIENCE_NODE_PI_MANAGER } else { "1" }

New-Item -ItemType Directory -Path (Join-Path $env:PI_SCIENCE_HOME "sessions") -Force | Out-Null
New-Item -ItemType Directory -Path $env:PI_SCIENCE_WORKSPACES -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

$ControlLog = Join-Path $RuntimeDir "control-plane.log"
$ControlErrorLog = Join-Path $RuntimeDir "control-plane.log.err"
$FrontendLog = Join-Path $RuntimeDir "frontend.log"
$FrontendErrorLog = Join-Path $RuntimeDir "frontend.log.err"
[System.IO.File]::WriteAllText($ControlLog, "")
[System.IO.File]::WriteAllText($ControlErrorLog, "")
[System.IO.File]::WriteAllText($FrontendLog, "")
[System.IO.File]::WriteAllText($FrontendErrorLog, "")

$ControlPlaneProcess = $null
$FrontendProcess = $null
$StateWritten = $false

try {
    Write-Host "==> Starting Node control plane on http://127.0.0.1:$ControlPlanePort"
    $controlArguments = '"' + $ControlPlaneCli + '" watch src/app/main.ts'
    $ControlPlaneProcess = Start-Process -FilePath $NodePath -ArgumentList $controlArguments -WorkingDirectory (Join-Path $ProjectDir "apps\server") -RedirectStandardOutput $ControlLog -RedirectStandardError $ControlErrorLog -NoNewWindow -PassThru

    $controlDeadline = (Get-Date).AddSeconds($StartupTimeout)
    do {
        if ($ControlPlaneProcess.HasExited) {
            throw "Control plane exited during startup. See $ControlLog and $ControlErrorLog"
        }
        if (Test-HttpReady -Uri "http://127.0.0.1:$ControlPlanePort/api/health") {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $controlDeadline)
    if (-not (Test-HttpReady -Uri "http://127.0.0.1:$ControlPlanePort/api/health")) {
        throw "Control plane did not become ready within ${StartupTimeout}s. See $ControlLog"
    }

    Write-Host "==> Starting frontend on http://127.0.0.1:$FrontendPort"
    if (-not (Test-PortAvailable -Port $FrontendPort)) {
        throw "Port $FrontendPort is already in use; refusing to reuse an unverified frontend."
    }
    $frontendArguments = '"' + $ViteScript + '" --host 127.0.0.1 --port ' + $FrontendPort + ' --strictPort'
    $FrontendProcess = Start-Process -FilePath $NodePath -ArgumentList $frontendArguments -WorkingDirectory (Join-Path $ProjectDir "frontend") -RedirectStandardOutput $FrontendLog -RedirectStandardError $FrontendErrorLog -NoNewWindow -PassThru

    $frontendDeadline = (Get-Date).AddSeconds($StartupTimeout)
    do {
        if ($FrontendProcess.HasExited) {
            throw "Frontend exited during startup. See $FrontendLog and $FrontendErrorLog"
        }
        if (Test-HttpReady -Uri "http://127.0.0.1:$FrontendPort") {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $frontendDeadline)
    if (-not (Test-HttpReady -Uri "http://127.0.0.1:$FrontendPort")) {
        throw "Frontend did not become ready within ${StartupTimeout}s. See $FrontendLog"
    }

    Write-RunState -ControlPlane $ControlPlaneProcess -Frontend $FrontendProcess -ControlPlanePort $ControlPlanePort -FrontendPort $FrontendPort
    $StateWritten = $true
    Write-Host ""
    Write-Host "Pi-Science is running:"
    Write-Host "  Frontend:            http://127.0.0.1:$FrontendPort"
    Write-Host "  Node control plane:  http://127.0.0.1:$ControlPlanePort"
    Write-Host "  Logs:                $RuntimeDir"
    Write-Host "Press Ctrl+C to stop."

    while ($true) {
        Start-Sleep -Seconds 1
        if ($ControlPlaneProcess.HasExited) {
            throw "Control plane exited. See $ControlLog and $ControlErrorLog"
        }
        if ($FrontendProcess.HasExited) {
            throw "Frontend exited. See $FrontendLog and $FrontendErrorLog"
        }
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    Stop-PiProcess -Process $FrontendProcess
    Stop-PiProcess -Process $ControlPlaneProcess
    if (-not $StateWritten -and (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    }
}
