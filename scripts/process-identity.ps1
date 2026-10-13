# Shared Windows process ownership checks. A PID or port alone is never identity.
function Get-PiProcessIdentity {
    param($State, [string]$Role, [string]$Checkout)
    try {
        if ($null -eq $State -or $State.checkout -ine $Checkout -or $State.launch_token -notmatch '^[a-f0-9]{32}$') {
            return [pscustomobject]@{ status = "unverified"; reason = "invalid checkout or launch marker" }
        }
        $processId = 0
        if (-not [int]::TryParse([string]$State.($Role + "_pid"), [ref]$processId) -or $processId -lt 0 -or ($Role -eq "control" -and $processId -eq 0)) {
            return [pscustomobject]@{ status = "unverified"; reason = "invalid process record" }
        }
        if ($processId -eq 0) { return [pscustomobject]@{ status = "already_exited"; reason = "service not started" } }
        try { $process = Get-Process -Id $processId -ErrorAction Stop }
        catch {
            if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') {
                return [pscustomobject]@{ status = "already_exited"; reason = "process no longer exists" }
            }
            throw
        }
        if ($process.HasExited) { return [pscustomobject]@{ status = "already_exited"; reason = "process exited" } }
        if (-not $State.($Role + "_started") -or -not $State.($Role + "_executable")) {
            return [pscustomobject]@{ status = "unverified"; reason = "missing process identity" }
        }
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $State.($Role + "_started")) {
            return [pscustomobject]@{ status = "already_exited"; reason = "recorded process identity is stale" }
        }
        $executable = $process.Path
        if (-not $executable) { return [pscustomobject]@{ status = "unverified"; reason = "process executable could not be read" } }
        if ($executable -ine $State.($Role + "_executable")) {
            return [pscustomobject]@{ status = "already_exited"; reason = "recorded executable identity is stale" }
        }
        $entry = if ($Role -eq "frontend") { "frontend\node_modules\vite\bin\vite.js" } elseif ($State.mode -eq "production") { "apps\server\dist\app\main.js" } elseif ($State.mode -eq "dev") { "apps\server\src\app\main.ts" } else {
            return [pscustomobject]@{ status = "unverified"; reason = "invalid deployment mode" }
        }
        $command = (Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop).CommandLine
        if ($command -and $command.IndexOf(('"' + (Join-Path $Checkout $entry) + '"'), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command.Contains("--launch-token " + $State.launch_token + " ") -and $command.IndexOf(('"' + (Join-Path $Checkout "scripts/run-service.mjs") + '"'), [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return [pscustomobject]@{ status = "owned"; process = $process }
        }
        return [pscustomobject]@{ status = "unverified"; reason = "entry point or launch marker could not be verified" }
    } catch { return [pscustomobject]@{ status = "unverified"; reason = $_.Exception.Message } }
}

function Test-OwnedPiProcess {
    param($State, [string]$Role, [string]$Checkout)
    return (Get-PiProcessIdentity -State $State -Role $Role -Checkout $Checkout).status -eq "owned"
}

function Stop-OwnedPiProcess {
    param($State, [string]$Role, [string]$Checkout)
    $identity = Get-PiProcessIdentity -State $State -Role $Role -Checkout $Checkout
    if ($identity.status -ne "owned") { return $identity }
    $root = [int]$State.($Role + "_pid")
    try {
        # Capture descendants only while the root's identity is verified.
        $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        $byId = @{}
        foreach ($item in $all) {
            $itemId = [int]$item.ProcessId
            if ($byId.ContainsKey($itemId)) { throw "Process snapshot has duplicate identities; retry stop." }
            $byId[$itemId] = $item
        }
        $rootSnapshot = $byId[$root]
        if ($null -eq $rootSnapshot -or $rootSnapshot.CreationDate -isnot [datetime] -or [Math]::Abs($rootSnapshot.CreationDate.ToUniversalTime().Ticks - $identity.process.StartTime.ToUniversalTime().Ticks) -ge 10) {
            throw "Root snapshot identity could not be verified; retry stop."
        }
        $parents = @{}
        $ids = @($root)
        do {
            $previousCount = $ids.Count
            foreach ($item in $all) {
                $parentId = [int]$item.ParentProcessId
                $itemId = [int]$item.ProcessId
                if ($ids -contains $parentId -and $ids -notcontains $itemId) {
                    $parent = $byId[$parentId]
                    # PPID alone can refer to a former owner of a recycled PID.
                    # Validate each edge, including below intermediate parents.
                    if ($item.CreationDate -is [datetime] -and $parent.CreationDate -is [datetime] -and $item.CreationDate.ToUniversalTime().Ticks -ge $parent.CreationDate.ToUniversalTime().Ticks) {
                        $parents[$itemId] = $parentId
                        $ids += $itemId
                    }
                }
            }
        } while ($ids.Count -gt $previousCount)
        $identity = Get-PiProcessIdentity -State $State -Role $Role -Checkout $Checkout
        if ($identity.status -ne "owned") { return $identity }
        [array]::Reverse($ids)
        foreach ($processId in $ids) {
            $snapshot = $all | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1
            try { $current = Get-Process -Id $processId -ErrorAction Stop }
            catch {
                if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { continue }
                throw
            }
            if ($current.HasExited) { continue }
            if ($null -eq $snapshot) { throw "Process snapshot is incomplete; retry stop." }
            # Ignore reused descendant PIDs. If the root changed, do not signal it.
            if ([Math]::Abs($current.StartTime.ToUniversalTime().Ticks - $snapshot.CreationDate.ToUniversalTime().Ticks) -ge 10) {
                if ($processId -eq $root) { return [pscustomobject]@{ status = "already_exited"; reason = "recorded root identity is stale" } }
                continue
            }
            # Fence ancestor identities too: a non-atomic CIM enumeration or
            # later PID reuse must not connect a foreign branch to our root.
            $ancestorId = $processId
            while ($parents.ContainsKey($ancestorId)) {
                $ancestorId = $parents[$ancestorId]
                $ancestor = Get-Process -Id $ancestorId -ErrorAction Stop
                if ($ancestor.HasExited -or [Math]::Abs($ancestor.StartTime.ToUniversalTime().Ticks - $byId[$ancestorId].CreationDate.ToUniversalTime().Ticks) -ge 10) {
                    throw "Ancestor identity changed; retry stop without signaling this branch."
                }
            }
            $current.Kill()
            if (-not $current.WaitForExit(5000)) { throw "Process $processId did not exit; retry stop." }
            # A descendant failure aborts before killing the root, keeping its
            # identity and parent relationship available for the next attempt.
        }
        return [pscustomobject]@{ status = "stopped" }
    } catch { return [pscustomobject]@{ status = "failed"; reason = $_.Exception.Message } }
}
