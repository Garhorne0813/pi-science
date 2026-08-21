<#
.SYNOPSIS
    Installs Pi-Science dependencies and the Windows launcher.

.DESCRIPTION
    Installs the JavaScript workspace, reuses an existing Pi runtime when
    possible, writes install.env, and installs a collision-safe pi-science.cmd
    in the user's .local\bin directory.
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
    throw "Node.js >=24.16.0 is required."
}
$NodeVersionCheck = Join-Path $ScriptDir "check-node-version.mjs"
& $NodePath $NodeVersionCheck
if ($LASTEXITCODE -ne 0) {
    throw "Node.js >=24.16.0 is required."
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
    $fetchScript = Join-Path $ScriptDir "fetch-pi.ps1"
    if (-not (Test-Path -LiteralPath $fetchScript -PathType Leaf)) {
        throw "Windows Pi runtime installer is missing: $fetchScript"
    }
    & $fetchScript
    if ($LASTEXITCODE -ne 0) {
        throw "Pi runtime installer exited with code $LASTEXITCODE."
    }
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

New-Item -ItemType Directory -Path $InstallStateDir -Force | Out-Null
$cliForState = To-PortablePath $PiCliPath
$stateLines = @(
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
Write-Host "  Pi CLI:   $PiCliPath"
Write-Host "  Launcher: $launcherPath"
Write-Host "  Start it with: pi-science"
