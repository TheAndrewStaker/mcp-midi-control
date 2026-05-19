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
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $InstallDir)) {
    Write-Error "InstallDir does not exist: $InstallDir"
    exit 1
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

$bundledNodeExe = Join-Path $InstallDir 'node.exe'
if (Test-Path $bundledNodeExe) {
    $nodeCommand = $bundledNodeExe
} else {
    # Source-install path -use the user's system Node.
    $nodeCommand = 'node'
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
