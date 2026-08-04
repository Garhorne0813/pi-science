<#
.SYNOPSIS
    Installs Pi-Science dependencies and the Windows launcher.

.DESCRIPTION
    Installs the JavaScript workspace, reuses an existing Pi runtime when
    possible, prepares the Python backend, writes install.env, and installs a
    collision-safe pi-science.cmd in the user's .local\bin directory.
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir "runtime\pi"
$InstallStateDir = Join-Path $ProjectDir ".runtime\pi-science"
$InstallStateFile = Join-Path $InstallStateDir "install.env"

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

function Find-VenvPython {
    param([string]$Root)

    foreach ($candidate in @(
        (Join-Path $Root ".venv\Scripts\python.exe"),
        (Join-Path $Root ".venv\Scripts\python")
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = ""
    )

    $oldLocation = Get-Location
    try {
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
            Set-Location -LiteralPath $WorkingDirectory
        }
        & $FilePath @Arguments
        $exitCode = $LASTEXITCODE
    } finally {
        Set-Location $oldLocation
    }
    if ($exitCode -ne 0) {
        throw "$FilePath exited with code $exitCode."
    }
}

function Get-ProcessCommand {
    param([string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $null
    }
    if ($command.CommandType -eq "Application" -and $command.Source) {
        return $command.Source
    }
    return $command.Name
}

function To-PortablePath {
    param([string]$Path)

    if ($null -eq $Path) {
        return ""
    }
    return $Path.Replace("\", "/")
}

function Normalize-PathForCompare {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ""
    }
    try {
        return ([System.IO.Path]::GetFullPath($Path)).TrimEnd([char[]]@('\', '/'))
    } catch {
        return $Path.TrimEnd([char[]]@('\', '/'))
    }
}

function Read-RuntimeCli {
    param([hashtable]$InstallValues)

    $explicit = [Environment]::GetEnvironmentVariable("PI_CLI_PATH", "Process")
    if (-not [string]::IsNullOrWhiteSpace($explicit)) {
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) {
            throw "PI_CLI_PATH does not point to a file: $explicit"
        }
        return (Resolve-Path -LiteralPath $explicit).Path
    }

    if ($InstallValues.ContainsKey("PI_SCIENCE_INSTALL_PI_CLI")) {
        $fromState = [string]$InstallValues["PI_SCIENCE_INSTALL_PI_CLI"]
        if (Test-Path -LiteralPath $fromState -PathType Leaf) {
            return (Resolve-Path -LiteralPath $fromState).Path
        }
    }

    $cliMarker = Join-Path $RuntimeDir ".cli-path"
    if (Test-Path -LiteralPath $cliMarker -PathType Leaf) {
        $marked = (Get-Content -LiteralPath $cliMarker -Raw).Trim()
        if (Test-Path -LiteralPath $marked -PathType Leaf) {
            return (Resolve-Path -LiteralPath $marked).Path
        }
    }

    $devMarker = Join-Path $RuntimeDir ".dev-repo-path"
    if (Test-Path -LiteralPath $devMarker -PathType Leaf) {
        $repo = (Get-Content -LiteralPath $devMarker -Raw).Trim()
        $devCli = Join-Path $repo "packages\coding-agent\src\cli.ts"
        if (Test-Path -LiteralPath $devCli -PathType Leaf) {
            return (Resolve-Path -LiteralPath $devCli).Path
        }
    }

    $releasedCli = Join-Path $RuntimeDir "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
    if (Test-Path -LiteralPath $releasedCli -PathType Leaf) {
        return (Resolve-Path -LiteralPath $releasedCli).Path
    }
    return $null
}

Write-Host "==> Checking installation prerequisites..."
$NodePath = Get-ProcessCommand "node"
if (-not $NodePath) {
    throw "Node.js >=22.12.0 is required."
}
$NodeVersionCheck = Join-Path $ScriptDir "check-node-version.mjs"
& $NodePath $NodeVersionCheck
if ($LASTEXITCODE -ne 0) {
    throw "Node.js >=22.12.0 is required."
}
$PnpmPath = Get-ProcessCommand "pnpm"
if (-not $PnpmPath) {
    throw "pnpm is required. Enable it with: corepack enable pnpm"
}
Write-Host ("  Node.js: " + (& $NodePath --version))
Write-Host ("  pnpm:   " + (& $PnpmPath --version))

$installValues = Read-InstallEnv -Path $InstallStateFile
$PiCliPath = Read-RuntimeCli -InstallValues $installValues
if (-not $PiCliPath) {
    Write-Host "==> Installing Pi agent runtime..."
    $bashPath = Get-ProcessCommand "bash"
    if (-not $bashPath) {
        throw "A Git Bash installation is required for a new Pi runtime. Install Git for Windows or set PI_CLI_PATH to an existing runtime."
    }
    Invoke-Checked -FilePath $bashPath -Arguments @((Join-Path $ScriptDir "fetch-pi.sh")) -WorkingDirectory $ProjectDir
    $PiCliPath = Read-RuntimeCli -InstallValues @{}
    if (-not $PiCliPath) {
        throw "Pi installer did not produce a usable CLI under $RuntimeDir."
    }
} else {
    Write-Host "==> Reusing the existing Pi agent runtime"
}

Write-Host "==> Installing JavaScript workspace dependencies..."
$PnpmStoreDir = if ($env:PNPM_STORE_DIR) { $env:PNPM_STORE_DIR } else { Join-Path $ProjectDir ".cache\pnpm-store" }
New-Item -ItemType Directory -Path $PnpmStoreDir -Force | Out-Null
Invoke-Checked -FilePath $PnpmPath -Arguments @("--config.store-dir=$PnpmStoreDir", "install", "--frozen-lockfile") -WorkingDirectory $ProjectDir

Write-Host "==> Installing backend dependencies..."
$CondaEnv = if ($env:CONDA_ENV) { $env:CONDA_ENV } else { "langgraphv1" }
$PythonPath = $null
$usedUv = $false
$condaPath = Get-ProcessCommand "conda"
if ($condaPath) {
    try {
        $condaOutput = @(& $condaPath run -n $CondaEnv python -c "import sys; print(sys.executable)" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $condaOutput.Count -gt 0) {
            $candidate = ([string]$condaOutput[$condaOutput.Count - 1]).Trim()
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $PythonPath = (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    } catch {
        $PythonPath = $null
    }
}

if (-not $PythonPath) {
    $uvPath = Get-ProcessCommand "uv"
    if ($uvPath) {
        $uvCacheDir = if ($env:UV_CACHE_DIR) { $env:UV_CACHE_DIR } else { Join-Path $ProjectDir ".cache\uv" }
        New-Item -ItemType Directory -Path $uvCacheDir -Force | Out-Null
        $env:UV_CACHE_DIR = $uvCacheDir
        Invoke-Checked -FilePath $uvPath -Arguments @("sync", "--extra", "dev") -WorkingDirectory (Join-Path $ProjectDir "backend")
        $PythonPath = Find-VenvPython -Root (Join-Path $ProjectDir "backend")
        $usedUv = $true
    }
}

if (-not $PythonPath) {
    $explicitPython = [Environment]::GetEnvironmentVariable("PI_SCIENCE_PYTHON", "Process")
    if (-not [string]::IsNullOrWhiteSpace($explicitPython)) {
        $PythonPath = Resolve-Executable $explicitPython
    }
    if (-not $PythonPath) {
        $PythonPath = Resolve-Executable "python"
    }
    if (-not $PythonPath) {
        $PythonPath = Resolve-Executable "py"
    }
    if (-not $PythonPath) {
        throw "No usable Python interpreter found."
    }
}

$backendDir = Join-Path $ProjectDir "backend"
$backendVenvPython = Find-VenvPython -Root $backendDir
if (-not $usedUv -and -not $backendVenvPython) {
    $pipCacheDir = if ($env:PIP_CACHE_DIR) { $env:PIP_CACHE_DIR } else { Join-Path $ProjectDir ".cache\pip" }
    New-Item -ItemType Directory -Path $pipCacheDir -Force | Out-Null
    $env:PIP_CACHE_DIR = $pipCacheDir
    Invoke-Checked -FilePath $PythonPath -Arguments @("-m", "pip", "install", "-e", "$backendDir[dev]")
}

& $PythonPath -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.11 or newer is required."
}

New-Item -ItemType Directory -Path $InstallStateDir -Force | Out-Null
$pythonForState = To-PortablePath $PythonPath
$cliForState = To-PortablePath $PiCliPath
$stateLines = @(
    "PI_SCIENCE_INSTALL_PYTHON=$pythonForState",
    "PI_SCIENCE_INSTALL_PI_CLI=$cliForState"
)
[System.IO.File]::WriteAllLines($InstallStateFile, $stateLines, [System.Text.UTF8Encoding]::new($false))

$binDirValue = if ($env:PI_SCIENCE_BIN_DIR) { $env:PI_SCIENCE_BIN_DIR } else { Join-Path $HOME ".local\bin" }
$binDir = [System.IO.Path]::GetFullPath($binDirValue)
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
$launcherPath = Join-Path $binDir "pi-science.cmd"
$exeCollisionPath = Join-Path $binDir "pi-science.exe"
$launcherMarker = "REM pi-science-launcher-v1"
$projectMarker = "REM project: " + (To-PortablePath $ProjectDir)

if (Test-Path -LiteralPath $exeCollisionPath) {
    throw "Refusing to install pi-science.cmd because pi-science.exe already exists in $binDir. Remove the unrelated executable first."
}
if (Test-Path -LiteralPath $launcherPath -PathType Leaf) {
    $existingLauncher = Get-Content -LiteralPath $launcherPath -Raw
    if (-not $existingLauncher.Contains($launcherMarker) -or -not $existingLauncher.Contains($projectMarker)) {
        throw "Refusing to overwrite an unrelated launcher: $launcherPath"
    }
}

$launcherScript = To-PortablePath (Join-Path $ScriptDir "pi-science.ps1")
$launcherText = "@echo off`r`n$launcherMarker`r`n$projectMarker`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherScript`" %*`r`n"
$launcherTemp = "$launcherPath.$PID.tmp"
[System.IO.File]::WriteAllText($launcherTemp, $launcherText, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $launcherTemp -Destination $launcherPath -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$binForCompare = Normalize-PathForCompare $binDir
$pathAlreadyContainsBin = $false
foreach ($entry in @($userPath -split ";")) {
    if ((Normalize-PathForCompare $entry) -ieq $binForCompare) {
        $pathAlreadyContainsBin = $true
        break
    }
}
if (-not $pathAlreadyContainsBin) {
    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Host "  Added $binDir to the user PATH (open a new terminal to use it)."
}

Write-Host "==> Installation complete."
Write-Host "  Python:   $PythonPath"
Write-Host "  Pi CLI:   $PiCliPath"
Write-Host "  Launcher: $launcherPath"
Write-Host "  Start it with: pi-science"
