<#
.SYNOPSIS
    Installs the Pi Orbit runtime and its extensions on Windows.

.DESCRIPTION
    Downloads the Windows ZIP release, verifies it against SHA256SUMS, and
    writes the same .cli-path marker used by fetch-pi.sh. A local PI_ORBIT_REPO
    checkout remains available as an explicit development override.
#>

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir "runtime\pi"
$CliMarker = Join-Path $RuntimeDir ".cli-path"

function Get-CommandPath {
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

function Get-Setting {
    param([string]$Name, [string]$Default)

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Default
    }
    return $value
}

function Write-TextFile {
    param([string]$Path, [string]$Content)

    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Install-RuntimeExtensions {
    $npmPath = Get-CommandPath "npm"
    if (-not $npmPath) {
        throw "npm is required to install Pi runtime extensions."
    }

    $piAiVersion = Get-Setting "PI_AI_VERSION" "0.84.3"
    $piMcpAdapterVersion = Get-Setting "PI_MCP_ADAPTER_VERSION" "2.18.0"
    $piSubagentsVersion = Get-Setting "PI_SUBAGENTS_VERSION" "0.40.0"
    $piWebAccessVersion = Get-Setting "PI_WEB_ACCESS_VERSION" "0.18.0"
    $contextModeVersion = Get-Setting "CONTEXT_MODE_VERSION" "1.0.169"
    $askUserQuestionVersion = Get-Setting "RPIV_ASK_USER_QUESTION_VERSION" "2.3.1"
    $todoVersion = Get-Setting "RPIV_TODO_VERSION" "2.4.0"
    $arguments = @(
        "install",
        "--prefix", $RuntimeDir,
        "--no-save",
        "--no-package-lock",
        "--omit=dev",
        "--cache", (Join-Path $RuntimeDir ".npm-cache"),
        "@earendil-works/pi-ai@$piAiVersion",
        "pi-mcp-adapter@$piMcpAdapterVersion",
        "pi-subagents@$piSubagentsVersion",
        "pi-web-access@$piWebAccessVersion",
        "context-mode@$contextModeVersion",
        "@juicesharp/rpiv-ask-user-question@$askUserQuestionVersion",
        "@juicesharp/rpiv-todo@$todoVersion"
    )
    Write-Host "==> Installing Pi runtime extensions..."
    & $npmPath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm exited with code $LASTEXITCODE while installing Pi runtime extensions."
    }
}

function Get-ReleaseArchitecture {
    $raw = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $raw = $env:PROCESSOR_ARCHITECTURE
    }
    switch ([string]$raw.ToUpperInvariant()) {
        "AMD64" { return "x64" }
        "X86_64" { return "x64" }
        "ARM64" { return "arm64" }
        default { throw "Unsupported Windows architecture: $raw" }
    }
}

function Get-ExpectedHash {
    param([string]$ChecksumFile, [string]$ArchiveName)

    foreach ($line in [System.IO.File]::ReadAllLines($ChecksumFile)) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(.+?)\s*$') {
            if ($matches[2].Trim() -eq $ArchiveName) {
                return $matches[1].ToLowerInvariant()
            }
        }
    }
    throw "$ArchiveName is missing from SHA256SUMS."
}

function Install-LocalRuntime {
    param([string]$Repository)

    $cli = Join-Path $Repository "packages\coding-agent\src\cli.ts"
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw "PI_ORBIT_REPO is not a Pi Orbit source checkout: $Repository"
    }
    $tsxCandidates = @(
        (Join-Path $Repository "node_modules\.bin\tsx.cmd"),
        (Join-Path $Repository "node_modules\.bin\tsx")
    )
    $hasTsx = $false
    foreach ($candidate in $tsxCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $hasTsx = $true
            break
        }
    }
    if (-not $hasTsx) {
        throw "Pi Orbit source dependencies are missing. Run npm install in: $Repository"
    }

    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    Write-TextFile -Path $CliMarker -Content ((Resolve-Path -LiteralPath $cli).Path + [Environment]::NewLine)
    Write-TextFile -Path (Join-Path $RuntimeDir ".dev-repo-path") -Content ((Resolve-Path -LiteralPath $Repository).Path + [Environment]::NewLine)
    Install-RuntimeExtensions
    Write-Host "==> Pi Orbit dev runtime ready: $Repository"
}

$localRepository = Get-Setting "PI_ORBIT_REPO" ""
if (-not [string]::IsNullOrWhiteSpace($localRepository)) {
    Install-LocalRuntime -Repository $localRepository
    exit 0
}

$version = Get-Setting "PI_ORBIT_VERSION" "0.3.0"
$releaseRepository = Get-Setting "PI_ORBIT_RELEASE_REPO" "Garhorne0813/pi-orbit"
$architecture = Get-ReleaseArchitecture
$archiveName = "pi-orbit-windows-$architecture.zip"
$tag = "pi-orbit-v$version"
$releaseUrl = "https://github.com/$releaseRepository/releases/download/$tag"
$installDirectory = Join-Path $RuntimeDir "releases\pi-orbit-$version"
$expectedCli = Join-Path $installDirectory "pi-orbit\pi-orbit.exe"
$downloadDirectory = Join-Path $RuntimeDir (".pi-orbit-download-$PID")

try {
    if (-not (Test-Path -LiteralPath $expectedCli -PathType Leaf)) {
        New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
        $archivePath = Join-Path $downloadDirectory $archiveName
        $checksumPath = Join-Path $downloadDirectory "SHA256SUMS"
        Write-Host "==> Downloading Pi Orbit $version (windows-$architecture)..."
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/$archiveName" -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumPath

        $expectedHash = Get-ExpectedHash -ChecksumFile $checksumPath -ArchiveName $archiveName
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "SHA-256 verification failed for $archiveName."
        }

        New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $installDirectory -Force
    }

    if (-not (Test-Path -LiteralPath $expectedCli -PathType Leaf)) {
        $discoveredCli = Get-ChildItem -LiteralPath $installDirectory -Filter "pi-orbit.exe" -File -Recurse | Select-Object -First 1
        if ($null -ne $discoveredCli) {
            $expectedCli = $discoveredCli.FullName
        }
    }
    if (-not (Test-Path -LiteralPath $expectedCli -PathType Leaf)) {
        throw "Pi Orbit archive did not contain pi-orbit.exe under $installDirectory."
    }

    $helpOutput = @(& $expectedCli --help 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -or ([string]$helpOutput -notmatch "--web-app-managed")) {
        throw "Installed Pi Orbit does not support app-managed Web Mode: $expectedCli"
    }
    Install-RuntimeExtensions
    Write-TextFile -Path $CliMarker -Content ($expectedCli + [Environment]::NewLine)
    Write-Host "==> Pi Orbit $version ready: $expectedCli"
} finally {
    if (Test-Path -LiteralPath $downloadDirectory) {
        Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
