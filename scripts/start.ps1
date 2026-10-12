<#
.SYNOPSIS
    Starts the Pi-Science control plane and frontend on Windows.

.DESCRIPTION
    This is the PowerShell equivalent of start.sh. It deliberately uses
    node.exe directly instead of .cmd shims so paths containing spaces work in
    both Windows PowerShell 5.1 and PowerShell 7.
#>

param([switch]$Dev)

$ErrorActionPreference = "Stop"
$DeploymentMode = if ($Dev -or $env:PI_SCIENCE_MODE -eq "dev") { "dev" } else { "production" }
if ($args.Count -gt 0) { throw "Usage: start.ps1 [-Dev]" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir ".runtime\pi-science"
$InstallStateFile = Join-Path $RuntimeDir "install.env"
$StateFile = Join-Path $RuntimeDir "run.state"
. (Join-Path $ScriptDir "process-identity.ps1")
$LaunchToken = [guid]::NewGuid().ToString("N")

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
            $Process.Kill()
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
        frontend_pid = if ($null -ne $Frontend) { $Frontend.Id } else { 0 }
        control_started = $ControlPlane.StartTime.ToUniversalTime().Ticks.ToString()
        frontend_started = if ($null -ne $Frontend) { $Frontend.StartTime.ToUniversalTime().Ticks.ToString() } else { "" }
        control_executable = $ControlPlane.Path
        frontend_executable = if ($null -ne $Frontend) { $Frontend.Path } else { "" }
        checkout = $ProjectDir
        launch_token = $LaunchToken
        mode = $DeploymentMode
        control_plane_port = $ControlPlanePort
        frontend_port = $FrontendPort
        started_at = (Get-Date).ToUniversalTime().ToString("o")
    }
    $script:OwnedState = [pscustomobject]$state
    $temporary = "$StateFile.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $StateFile -Force
}

$installValues = Read-InstallEnv -Path $InstallStateFile
$nodeValue = Get-ConfiguredValue -EnvironmentName "PI_NODE_PATH" -InstallName "PI_NODE_PATH" -InstallValues @{}

$NodePath = Resolve-Executable $nodeValue
if (-not $NodePath) {
    $NodePath = Resolve-Executable "node"
}

if (-not $NodePath) {
    throw "Node.js >=24.16.0 is required. Run: powershell -File scripts/install.ps1"
}

$NodeVersionCheck = Join-Path $ScriptDir "check-node-version.mjs"
& $NodePath $NodeVersionCheck
if ($LASTEXITCODE -ne 0) {
    throw "Node.js >=24.16.0 is required."
}

$ControlPlaneCli = Join-Path $ProjectDir "apps\server\node_modules\tsx\dist\cli.mjs"
$ViteScript = Join-Path $ProjectDir "frontend\node_modules\vite\bin\vite.js"
$ControlPlaneBuild = Join-Path $ProjectDir "apps\server\dist\app\main.js"
if ($DeploymentMode -eq "dev") {
    if (-not (Test-Path -LiteralPath $ControlPlaneCli -PathType Leaf)) { throw "Server dependencies missing. Run scripts/install.ps1" }
    if (-not (Test-Path -LiteralPath $ViteScript -PathType Leaf)) { throw "Frontend dependencies missing. Run scripts/install.ps1" }
} else {
    $frontendDist = & $NodePath (Join-Path $ScriptDir "resolve-frontend-dist.mjs") $env:PI_SCIENCE_FRONTEND_DIST
    if ($LASTEXITCODE -ne 0 -or -not $frontendDist) { throw "Unable to resolve frontend build directory." }
    $env:PI_SCIENCE_FRONTEND_DIST = $frontendDist
    if (-not (Test-Path -LiteralPath $ControlPlaneBuild -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $frontendDist "index.html") -PathType Leaf)) { throw "Production build missing. Run scripts/install.ps1" }
}
$watch = if ($env:PI_SCIENCE_SERVER_WATCH) { $env:PI_SCIENCE_SERVER_WATCH } else { "0" }
if ($watch -notin @("0", "1")) { throw "PI_SCIENCE_SERVER_WATCH must be 0 or 1." }

$ControlPlanePort = Get-PositiveInteger -EnvironmentName "PI_SCIENCE_CONTROL_PLANE_PORT" -Default 8787
$FrontendPort = Get-PositiveInteger -EnvironmentName "PI_SCIENCE_FRONTEND_PORT" -Default 5173
$StartupTimeout = Get-PositiveInteger -EnvironmentName "PI_SCIENCE_STARTUP_TIMEOUT_SECONDS" -Default 90

if (-not (Test-PortAvailable -Port $ControlPlanePort)) {
    throw "Port $ControlPlanePort is already in use."
}
if ($DeploymentMode -eq "dev" -and -not (Test-PortAvailable -Port $FrontendPort)) {
    throw "Port $FrontendPort is already in use."
}

$AppPort = if ($DeploymentMode -eq "dev") { $FrontendPort } else { $ControlPlanePort }
$env:PI_SCIENCE_HOST = "127.0.0.1"
$env:PI_SCIENCE_OPEN_BROWSER = "0"
$env:PI_NODE_PATH = $NodePath
$env:PI_SCIENCE_HOME = if ($env:PI_SCIENCE_HOME) { $env:PI_SCIENCE_HOME } else { Join-Path $HOME ".pi-science" }
$env:PI_SCIENCE_WORKSPACES = if ($env:PI_SCIENCE_WORKSPACES) { $env:PI_SCIENCE_WORKSPACES } else { Join-Path $HOME "pi-science-workspaces" }
if (-not $env:PI_SCIENCE_INTERNAL_TOKEN) {
    $generatedToken = & $NodePath (Join-Path $ScriptDir "generate-token.mjs")
    if ($LASTEXITCODE -ne 0 -or $generatedToken -notmatch '^[a-f0-9]{64}$') {
        throw "Internal token generation failed."
    }
    $env:PI_SCIENCE_INTERNAL_TOKEN = $generatedToken
}
$env:PI_SCIENCE_REQUIRE_INTERNAL_TOKEN = if ($env:PI_SCIENCE_REQUIRE_INTERNAL_TOKEN) { $env:PI_SCIENCE_REQUIRE_INTERNAL_TOKEN } else { "1" }
$env:PI_SCIENCE_PORT = "$ControlPlanePort"
$env:PI_SCIENCE_BACKEND_URL = if ($env:PI_SCIENCE_BACKEND_URL) { $env:PI_SCIENCE_BACKEND_URL } else { "http://127.0.0.1:$ControlPlanePort" }
$env:PI_SCIENCE_NODE_SESSIONS = if ($env:PI_SCIENCE_NODE_SESSIONS) { $env:PI_SCIENCE_NODE_SESSIONS } else { "1" }
$env:PI_SCIENCE_NODE_SSE = if ($env:PI_SCIENCE_NODE_SSE) { $env:PI_SCIENCE_NODE_SSE } else { "1" }
$env:PI_SCIENCE_NODE_PI_MANAGER = if ($env:PI_SCIENCE_NODE_PI_MANAGER) { $env:PI_SCIENCE_NODE_PI_MANAGER } else { "1" }

New-Item -ItemType Directory -Path (Join-Path $env:PI_SCIENCE_HOME "sessions") -Force | Out-Null
New-Item -ItemType Directory -Path $env:PI_SCIENCE_WORKSPACES -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

$LaunchLock = [System.IO.File]::Open((Join-Path $RuntimeDir "start.windows.lock"), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
$OwnedState = $null

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

try {
    $StartupDeadline = (Get-Date).AddSeconds($StartupTimeout)
    Write-Host "==> Starting Node control plane on http://127.0.0.1:$ControlPlanePort"
    $controlArguments = '"' + $ControlPlaneCli + '" "' + (Join-Path $ProjectDir 'apps\server\src\app\main.ts') + '"'
    if ($DeploymentMode -eq "production") {
        $controlArguments = '"' + $ControlPlaneBuild + '"'
    } elseif ($watch -eq "1") {
        $controlArguments = '"' + $ControlPlaneCli + '" watch "' + (Join-Path $ProjectDir 'apps\server\src\app\main.ts') + '"'
    }
    $controlArguments = '"' + (Join-Path $ScriptDir 'run-service.mjs') + '" --launch-token ' + $LaunchToken + ' ' + $controlArguments
    $ControlPlaneProcess = Start-Process -FilePath $NodePath -ArgumentList $controlArguments -WorkingDirectory (Join-Path $ProjectDir "apps\server") -RedirectStandardOutput $ControlLog -RedirectStandardError $ControlErrorLog -NoNewWindow -PassThru

    Write-RunState -ControlPlane $ControlPlaneProcess -Frontend $null -ControlPlanePort $ControlPlanePort -FrontendPort $FrontendPort

    $controlDeadline = $StartupDeadline
    do {
        if ($ControlPlaneProcess.HasExited) {
            throw "Control plane exited during startup. See $ControlLog and $ControlErrorLog"
        }
        if (Test-HttpReady -Uri "http://127.0.0.1:$ControlPlanePort/internal/ready") {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $controlDeadline)
    if (-not (Test-HttpReady -Uri "http://127.0.0.1:$ControlPlanePort/internal/ready")) {
        throw "Control plane did not become ready within ${StartupTimeout}s. See $ControlLog"
    }

    if ($DeploymentMode -eq "dev") {
        Write-Host "==> Starting frontend on http://127.0.0.1:$FrontendPort"
        if (-not (Test-PortAvailable -Port $FrontendPort)) {
            throw "Port $FrontendPort is already in use; refusing to reuse an unverified frontend."
        }
        $frontendArguments = '"' + $ViteScript + '" --host 127.0.0.1 --port ' + $FrontendPort + ' --strictPort'
        $frontendArguments = '"' + (Join-Path $ScriptDir 'run-service.mjs') + '" --launch-token ' + $LaunchToken + ' ' + $frontendArguments
        $FrontendProcess = Start-Process -FilePath $NodePath -ArgumentList $frontendArguments -WorkingDirectory (Join-Path $ProjectDir "frontend") -RedirectStandardOutput $FrontendLog -RedirectStandardError $FrontendErrorLog -NoNewWindow -PassThru

        Write-RunState -ControlPlane $ControlPlaneProcess -Frontend $FrontendProcess -ControlPlanePort $ControlPlanePort -FrontendPort $FrontendPort

        $frontendDeadline = $StartupDeadline
        do {
            if ($null -ne $FrontendProcess -and $FrontendProcess.HasExited) {
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

    } elseif (-not (Test-HttpReady -Uri "http://127.0.0.1:$ControlPlanePort")) {
        throw "Frontend build is not available on the control-plane port."
    }

    Write-RunState -ControlPlane $ControlPlaneProcess -Frontend $FrontendProcess -ControlPlanePort $ControlPlanePort -FrontendPort $FrontendPort
    Write-Host ""
    Write-Host "Pi-Science is running:"
    Write-Host "  Frontend:            http://127.0.0.1:$AppPort ($DeploymentMode)"
    Write-Host "  Node control plane:  http://127.0.0.1:$ControlPlanePort"
    Write-Host "  Logs:                $RuntimeDir"
    Write-Host "Press Ctrl+C to stop."

    while ($true) {
        Start-Sleep -Seconds 1
        if ($ControlPlaneProcess.HasExited) {
            throw "Control plane exited. See $ControlLog and $ControlErrorLog"
        }
        if ($null -ne $FrontendProcess -and $FrontendProcess.HasExited) {
            throw "Frontend exited. See $FrontendLog and $FrontendErrorLog"
        }
    }
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($null -ne $OwnedState) {
        foreach ($role in @("frontend", "control")) {
            $result = Stop-OwnedPiProcess -State $OwnedState -Role $role -Checkout $ProjectDir
            if ($result.status -in @("unverified", "failed")) { Write-Warning "Cleanup incomplete for $role; identity state retained. Retry pi-science stop." }
        }
    } else {
        # Handles cover the short interval before identity state is established.
        Stop-PiProcess -Process $FrontendProcess
        Stop-PiProcess -Process $ControlPlaneProcess
    }
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        try {
            $currentState = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
            if ($currentState.launch_token -eq $LaunchToken) {
                $remainingIdentity = @("frontend", "control") | ForEach-Object { Get-PiProcessIdentity -State $currentState -Role $_ -Checkout $ProjectDir }
                if (@($remainingIdentity | Where-Object { $_.status -ne "already_exited" }).Count -eq 0) { Remove-Item -LiteralPath $StateFile -Force }
            }
        } catch { }
    }
    $LaunchLock.Dispose()
}
