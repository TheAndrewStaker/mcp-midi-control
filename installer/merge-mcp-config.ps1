# Idempotently add or update the mcp-midi-control entry inside
# Claude Desktop's claude_desktop_config.json files.
#
# Detects both Claude Desktop variants:
#   - Direct download: %APPDATA%\Claude\claude_desktop_config.json
#   - Microsoft Store:  %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
#
# Writes our entry to whichever location(s) exist. If neither exists,
# writes to the direct-download location and creates the directory.
#
# Argument: -InstallDir   Absolute path to the installation directory
#                         (where node.exe and dist\ live).
#
# Exit codes:
#   0  = wrote to at least one config file
#   1  = invalid arguments
#   2  = unexpected error (PowerShell exception)

param(
    [Parameter(Mandatory=$true)]
    [string]$InstallDir,

    # Skip the smoke-boot step. Useful for source-install development
    # where the layout intentionally differs from the shipped ZIP.
    [switch]$SkipSmokeBoot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $InstallDir)) {
    Write-Error "InstallDir does not exist: $InstallDir"
    exit 1
}

# --------------------------------------------------------------------------
# Pre-flight: verify the extraction produced the files we expect.
#
# The user-visible failure mode this guards against is a cryptic Node.js
# stack trace ("ERR_MODULE_NOT_FOUND: Cannot find package 'fractal-midi'")
# at first launch, which happens when:
#   (a) The ZIP tool extracted into a nested folder (Windows Explorer does
#       this when the destination name matches the ZIP's top-level dir).
#   (b) Antivirus quarantined some files during extraction.
#   (c) The download was truncated or corrupted.
#
# We catch all three by checking for specific files that must exist in a
# healthy install. The diagnostic names the missing file so the user has
# a concrete target to investigate.
#
# Source-install layout (developer running `npm run setup-claude-desktop`
# after `npm run build`) is detected by the presence of packages\ and
# absence of node.exe -in that case we skip the bundle-shaped checks.
# --------------------------------------------------------------------------

$bundledNodeExe = Join-Path $InstallDir 'node.exe'
$packagesDir = Join-Path $InstallDir 'packages'
$isSourceInstall = (-not (Test-Path $bundledNodeExe)) -and (Test-Path $packagesDir)

function Write-IncompleteExtractionDiagnostic {
    param([string]$MissingPath)
    Write-Host ''
    Write-Host 'SETUP FAILED -incomplete extraction.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Expected files were not found in:'
    Write-Host "  $InstallDir"
    Write-Host ''
    Write-Host 'This usually means:'
    Write-Host '  (a) Your ZIP tool extracted into a nested folder. Check if there is a'
    Write-Host '      "mcp-midi-control-v0.1.0" folder INSIDE your install directory. If so,'
    Write-Host '      move its contents up one level and try setup.cmd again.'
    Write-Host '  (b) Your antivirus removed files during extraction. Try extracting again,'
    Write-Host '      or temporarily disable AV during the extract.'
    Write-Host '  (c) The ZIP itself is incomplete. Re-download and try again.'
    Write-Host ''
    Write-Host "Missing: $MissingPath"
    Write-Host ''
}

if (-not $isSourceInstall) {
    # Bundle layout: every required file must exist or the server will
    # fail at first launch with a cryptic stack trace.
    $requiredFiles = @(
        @{ Rel = 'node.exe'; Why = 'bundled Node runtime' },
        @{ Rel = 'node_modules\fractal-midi\package.json'; Why = 'fractal-midi codec package' },
        @{ Rel = 'node_modules\@mcp-midi-control\server-all\dist\server\index.js'; Why = 'MCP server entry point' },
        @{ Rel = 'node_modules\@mcp-midi-control\core\package.json'; Why = 'core device-registry package' },
        @{ Rel = 'node_modules\@mcp-midi-control\am4\package.json'; Why = 'AM4 device adapter' },
        @{ Rel = 'node_modules\@mcp-midi-control\axe-fx-ii\package.json'; Why = 'Axe-Fx II device adapter' },
        @{ Rel = 'node_modules\@mcp-midi-control\axe-fx-iii\package.json'; Why = 'Axe-Fx III device adapter' },
        @{ Rel = 'node_modules\@mcp-midi-control\hydrasynth\package.json'; Why = 'Hydrasynth device adapter' }
    )

    foreach ($req in $requiredFiles) {
        $abs = Join-Path $InstallDir $req.Rel
        if (-not (Test-Path $abs)) {
            Write-IncompleteExtractionDiagnostic -MissingPath $req.Rel
            Write-Host "(This file is the $($req.Why).)"
            Write-Host ''
            exit 1
        }
    }

    Write-Host 'Pre-flight check: all required files present.'
}

# Three layouts are supported -the script auto-detects (in priority order):
#
#   1. Installer ZIP layout (v0.1.x post-workspace-split):
#      $InstallDir\node.exe           (bundled Node runtime)
#      $InstallDir\node_modules\@mcp-midi-control\server-all\dist\server\index.js
#      (Each workspace package is copied as a real directory under
#       node_modules\@mcp-midi-control\ -no symlinks, ZIP-safe.)
#
#   2. Source-install layout (developer running `npm run setup-claude-
#      desktop` after `npm run build`):
#      $InstallDir\packages\server-all\dist\server\index.js
#      (no bundled node.exe; uses the system `node` on PATH)
#
#   3. Legacy v0.1.0 ZIP layout (pre-workspace-split):
#      $InstallDir\node.exe
#      $InstallDir\dist\server\index.js
#
# Each workspace package is built independently to its own `dist/`;
# cross-package imports resolve via Node's normal node_modules
# resolution against the real per-package directories. No path-alias
# rewriting happens at build time.

$installerEntry = Join-Path $InstallDir 'node_modules\@mcp-midi-control\server-all\dist\server\index.js'
$workspaceEntry = Join-Path $InstallDir 'packages\server-all\dist\server\index.js'
$legacyEntry = Join-Path $InstallDir 'dist\server\index.js'

if (Test-Path $installerEntry) {
    $entryJs = $installerEntry
} elseif (Test-Path $workspaceEntry) {
    $entryJs = $workspaceEntry
} elseif (Test-Path $legacyEntry) {
    $entryJs = $legacyEntry
} else {
    Write-Error "Server entry point not found at $installerEntry (nor $workspaceEntry, nor legacy $legacyEntry). Did you run ``npm run build`` first?"
    exit 1
}

if (Test-Path $bundledNodeExe) {
    $nodeCommand = $bundledNodeExe
} else {
    # Source-install path -use the user's system Node.
    $nodeCommand = 'node'
}

# --------------------------------------------------------------------------
# Smoke-boot: spawn the server process briefly to surface boot-time
# failures (e.g. node-midi native binding load error, missing transitive
# import) BEFORE writing the Claude Desktop config. If we write the
# config first and the server can't boot, the user only sees a generic
# "MCP server failed" toast and has to dig through %LOCALAPPDATA%\...\
# Claude\logs\mcp-server-*.log to learn why. Surfacing it here points
# at the cause while the install context is still fresh.
#
# Timeout: 8 seconds. Build-time smoke uses 15s to absorb AV scan latency
# on freshly-written node_modules, but install-time runs against files
# the user already extracted (AV has had time to settle), so 8s is plenty
# for the device-registry to finish initializing on typical hardware.
# --------------------------------------------------------------------------

if (-not $SkipSmokeBoot -and -not $isSourceInstall) {
    Write-Host 'Smoke-booting server (8s timeout)...'
    $smokeStdoutFile = [System.IO.Path]::GetTempFileName()
    $smokeStderrFile = [System.IO.Path]::GetTempFileName()
    # PowerShell's Start-Process -RedirectStandardInput resolves a bare 'NUL'
    # as a relative path against the working directory, then fails with
    # FileNotFoundException. Create an empty file for stdin instead.
    $smokeStdinFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath $nodeCommand -ArgumentList @($entryJs) `
            -NoNewWindow -PassThru `
            -RedirectStandardInput $smokeStdinFile `
            -RedirectStandardOutput $smokeStdoutFile `
            -RedirectStandardError $smokeStderrFile

        $exited = $proc.WaitForExit(8000)
        if (-not $exited) {
            # Server reached steady-state and is waiting on JSON-RPC stdin.
            # That's the success signal -kill it and proceed.
            try { $proc.Kill() } catch { }
            $proc.WaitForExit(2000) | Out-Null
        }

        $smokeStderr = ''
        if (Test-Path $smokeStderrFile) {
            $smokeStderr = Get-Content -Path $smokeStderrFile -Raw -ErrorAction SilentlyContinue
            if ($null -eq $smokeStderr) { $smokeStderr = '' }
        }

        # ERR_MODULE_NOT_FOUND is the headline regression. It shouldn't
        # happen if the pre-flight passed, but a malformed package.json
        # or partially-written file can still trip it.
        if ($smokeStderr -match 'ERR_MODULE_NOT_FOUND') {
            Write-Host ''
            Write-Host 'SETUP FAILED -server could not load its modules.' -ForegroundColor Red
            Write-Host ''
            Write-Host 'The bundled files appear to be present but Node could not resolve'
            Write-Host 'one of the package imports. This usually means a file was corrupted'
            Write-Host 'or truncated during extraction. Try re-extracting the ZIP.'
            Write-Host ''
            Write-Host 'Node stderr:'
            Write-Host $smokeStderr
            Write-Host ''
            exit 1
        }

        # node-midi native binding load failures show up as a bindings or
        # node-gyp-build error. Surface the stderr so the user can act.
        if ($smokeStderr -match 'bindings|node-gyp-build|was compiled against a different Node' `
            -or $smokeStderr -match 'The specified module could not be found') {
            Write-Host ''
            Write-Host 'SETUP FAILED -native MIDI binding could not load.' -ForegroundColor Red
            Write-Host ''
            Write-Host 'The server reached startup but the node-midi native binary failed'
            Write-Host 'to load. This usually means:'
            Write-Host '  (a) The Microsoft Visual C++ Redistributable is missing. Install'
            Write-Host '      it from: https://aka.ms/vs/17/release/vc_redist.x64.exe'
            Write-Host '  (b) Your antivirus quarantined node_modules\midi\build\Release\nodemidi.node'
            Write-Host ''
            Write-Host 'Node stderr:'
            Write-Host $smokeStderr
            Write-Host ''
            exit 1
        }

        # Banner means the server reached MCP initialization. If we don't
        # see it AND the process exited with a non-zero code, something
        # else went wrong -surface stderr so the user has a starting point.
        if ($smokeStderr -notmatch 'MCP MIDI Control MCP server running on stdio' `
            -and $proc.ExitCode -ne 0 -and $proc.ExitCode -ne $null) {
            Write-Host ''
            Write-Host 'SETUP WARNING -smoke-boot did not see the startup banner.' -ForegroundColor Yellow
            Write-Host ''
            Write-Host 'The server may still work, but it did not signal a clean startup'
            Write-Host 'during the 8-second check. Proceeding with config write; if the'
            Write-Host 'server fails to appear in Claude Desktop, check the MCP log at:'
            Write-Host '  %LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\logs\'
            Write-Host ''
            Write-Host 'Node stderr (first 1000 chars):'
            $tail = if ($smokeStderr.Length -gt 1000) { $smokeStderr.Substring(0, 1000) } else { $smokeStderr }
            Write-Host $tail
            Write-Host ''
        } else {
            Write-Host 'Smoke-boot: OK.'
        }
    } finally {
        Remove-Item -Path $smokeStdoutFile -ErrorAction SilentlyContinue
        Remove-Item -Path $smokeStderrFile -ErrorAction SilentlyContinue
        Remove-Item -Path $smokeStdinFile -ErrorAction SilentlyContinue
    }
}

# Candidate Claude Desktop config locations.
$candidates = @(
    (Join-Path $env:APPDATA 'Claude'),
    (Join-Path $env:LOCALAPPDATA 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude')
)

$writtenAny = $false

foreach ($claudeDir in $candidates) {
    $configPath = Join-Path $claudeDir 'claude_desktop_config.json'
    $parentExists = Test-Path $claudeDir

    # Skip the Store location entirely if its parent doesn't exist;
    # the user doesn't have the Store version of Claude Desktop.
    if (-not $parentExists -and $claudeDir -like '*\Packages\Claude_pzs8sxrjxfjjc\*') {
        continue
    }

    # Direct-download location: create the directory if missing so the
    # user can install Claude Desktop afterward and our entry is
    # already there waiting.
    if (-not $parentExists) {
        New-Item -Path $claudeDir -ItemType Directory -Force | Out-Null
    }

    # Read the existing config, or start a fresh one.
    if (Test-Path $configPath) {
        try {
            $raw = Get-Content -Path $configPath -Raw -Encoding UTF8
            if ([string]::IsNullOrWhiteSpace($raw)) {
                $config = [pscustomobject]@{}
            } else {
                $config = $raw | ConvertFrom-Json
            }
        } catch {
            Write-Warning "Could not parse existing $configPath. Backing up to .bak and starting fresh."
            Copy-Item $configPath "$configPath.bak" -Force
            $config = [pscustomobject]@{}
        }
    } else {
        $config = [pscustomobject]@{}
    }

    # Ensure mcpServers property exists.
    if (-not ($config.PSObject.Properties.Name -contains 'mcpServers')) {
        $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{}) -Force
    } elseif ($null -eq $config.mcpServers) {
        $config.mcpServers = [pscustomobject]@{}
    }

    # Build our server entry.
    $serverEntry = [pscustomobject]@{
        command = $nodeCommand
        args = @($entryJs)
        env = [pscustomobject]@{}
    }

    # Add or update mcp-midi-control.
    if ($config.mcpServers.PSObject.Properties.Name -contains 'mcp-midi-control') {
        $config.mcpServers.'mcp-midi-control' = $serverEntry
    } else {
        $config.mcpServers | Add-Member -NotePropertyName 'mcp-midi-control' -NotePropertyValue $serverEntry -Force
    }

    # Write back as UTF-8 without BOM (matches what Claude Desktop expects).
    $json = $config | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($configPath, $json, [System.Text.UTF8Encoding]::new($false))

    Write-Host "Wrote mcp-midi-control entry to $configPath"
    $writtenAny = $true
}

if (-not $writtenAny) {
    Write-Error "No Claude Desktop config locations could be updated."
    exit 2
}

Write-Host "Done. Restart Claude Desktop if it was running."
exit 0
