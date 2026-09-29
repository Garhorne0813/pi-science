<#
.SYNOPSIS
    Installs the pi-runtime packages and their extensions on Windows.

.DESCRIPTION
    Installs the pinned @earendil-works/pi-* packages plus the Pi extensions
    from npm and writes the same .cli-path marker used by fetch-pi.sh. A local
    PI_RUNTIME_REPO checkout remains available as an explicit development
    override.
#>

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir ".."))
$RuntimeDir = Join-Path $ProjectDir "runtime\pi"
$CliMarker = Join-Path $RuntimeDir ".cli-path"
$RuntimeCli = Join-Path $RuntimeDir "node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"

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

function Assert-InstalledVersion {
    param([string]$PackageName, [string]$ExpectedVersion)

    $packageManifest = Join-Path $RuntimeDir "node_modules\$PackageName\package.json"
    $actual = ""
    if (Test-Path -LiteralPath $packageManifest -PathType Leaf) {
        $actual = (Get-Content -LiteralPath $packageManifest -Raw | ConvertFrom-Json).version
    }
    if ($actual -ne $ExpectedVersion) {
        throw "$PackageName $actual was installed instead of the pinned $ExpectedVersion."
    }
}

function Assert-PinnedVersions {
    Assert-InstalledVersion -PackageName "@earendil-works/pi-coding-agent" -ExpectedVersion $PiRuntimeVersion
    Assert-InstalledVersion -PackageName "@earendil-works/pi-agent-core" -ExpectedVersion $PiRuntimeVersion
    Assert-InstalledVersion -PackageName "pi-mcp-adapter" -ExpectedVersion $PiMcpAdapterVersion
    Assert-InstalledVersion -PackageName "pi-subagents" -ExpectedVersion $PiSubagentsVersion
    Assert-InstalledVersion -PackageName "pi-web-access" -ExpectedVersion $PiWebAccessVersion
    Assert-InstalledVersion -PackageName "context-mode" -ExpectedVersion $ContextModeVersion
    Assert-InstalledVersion -PackageName "@juicesharp/rpiv-ask-user-question" -ExpectedVersion $AskUserQuestionVersion
    Assert-InstalledVersion -PackageName "@juicesharp/rpiv-todo" -ExpectedVersion $TodoVersion
}

# The runtime and its extensions go into a single npm invocation: npm reifies
# the whole runtime\pi prefix on every install, so a second `npm install
# --no-save` into the same prefix evicts the packages of the first one.
function Install-PiRuntime {
    $npmPath = Get-CommandPath "npm"
    if (-not $npmPath) {
        throw "npm is required to install the Pi runtime and its extensions."
    }

    # A manifest left by an older install carries ranges (^0.80.6, ^2.16.0) that
    # npm re-resolves instead of keeping the pins below, so drop it first.
    foreach ($staleManifest in @("package.json", "package-lock.json")) {
        Remove-Item -LiteralPath (Join-Path $RuntimeDir $staleManifest) -Force -ErrorAction SilentlyContinue
    }

    $arguments = @(
        "install",
        "--prefix", $RuntimeDir,
        "--no-save",
        "--no-package-lock",
        "--omit=dev",
        "--cache", (Join-Path $RuntimeDir ".npm-cache"),
        "@earendil-works/pi-coding-agent@$PiRuntimeVersion",
        "@earendil-works/pi-agent-core@$PiRuntimeVersion",
        "pi-mcp-adapter@$PiMcpAdapterVersion",
        "pi-subagents@$PiSubagentsVersion",
        "pi-web-access@$PiWebAccessVersion",
        "context-mode@$ContextModeVersion",
        "@juicesharp/rpiv-ask-user-question@$AskUserQuestionVersion",
        "@juicesharp/rpiv-todo@$TodoVersion"
    )
    Write-Host "==> Installing pi-runtime $PiRuntimeVersion and its extensions..."
    & $npmPath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm exited with code $LASTEXITCODE while installing the Pi runtime and its extensions."
    }

    $nodePath = Get-CommandPath "node"
    if (-not $nodePath) {
        throw "node is required to apply MCP adapter security patches."
    }
    # The MCP adapter patches must land on the freshly installed adapter, so the
    # patch run stays the last write to the extension tree.
    & $nodePath (Join-Path $ScriptDir "patch-mcp-adapter.mjs")
    if ($LASTEXITCODE -ne 0) {
        throw "node exited with code $LASTEXITCODE while applying MCP adapter security patches."
    }

    Assert-PinnedVersions
}

function Install-LocalRuntime {
    param([string]$Repository)

    $cli = Join-Path $Repository "packages\coding-agent\src\cli.ts"
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw "PI_RUNTIME_REPO is not a pi-runtime source checkout: $Repository"
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
        throw "pi-runtime source dependencies are missing. Run npm install in: $Repository"
    }

    New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
    Write-TextFile -Path $CliMarker -Content ((Resolve-Path -LiteralPath $cli).Path + [Environment]::NewLine)
    Write-TextFile -Path (Join-Path $RuntimeDir ".dev-repo-path") -Content ((Resolve-Path -LiteralPath $Repository).Path + [Environment]::NewLine)
    Install-PiRuntime
    Write-Host "==> pi-runtime dev runtime ready: $Repository"
}

# Pinned versions live here only: a version bump is a single edit per package.
$PiRuntimeVersion = Get-Setting "PI_RUNTIME_VERSION" "0.84.4"
$PiMcpAdapterVersion = Get-Setting "PI_MCP_ADAPTER_VERSION" "2.18.0"
$PiSubagentsVersion = Get-Setting "PI_SUBAGENTS_VERSION" "0.40.0"
$PiWebAccessVersion = Get-Setting "PI_WEB_ACCESS_VERSION" "0.18.0"
$ContextModeVersion = Get-Setting "CONTEXT_MODE_VERSION" "1.0.169"
$AskUserQuestionVersion = Get-Setting "RPIV_ASK_USER_QUESTION_VERSION" "2.3.1"
$TodoVersion = Get-Setting "RPIV_TODO_VERSION" "2.4.0"

$localRepository = Get-Setting "PI_RUNTIME_REPO" ""
if (-not [string]::IsNullOrWhiteSpace($localRepository)) {
    Install-LocalRuntime -Repository $localRepository
    exit 0
}

Install-PiRuntime

if (-not (Test-Path -LiteralPath $RuntimeCli -PathType Leaf)) {
    throw "$RuntimeCli was not produced by the pi-runtime npm install."
}

$nodePath = Get-CommandPath "node"
if (-not $nodePath) {
    throw "node is required to verify the pi-runtime CLI."
}
$null = @(& $nodePath $RuntimeCli --help 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw "Installed pi-runtime CLI did not answer --help: $RuntimeCli"
}

Write-TextFile -Path $CliMarker -Content ($RuntimeCli + [Environment]::NewLine)
Write-Host "==> pi-runtime $PiRuntimeVersion ready: $RuntimeCli"
