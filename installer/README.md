# Installer build

This directory contains the install/uninstall wrappers used in the
release ZIP.

## Distribution shape: ZIP + `setup.cmd`

The release is a ZIP that users download, extract, and run `setup.cmd`
from. See `docs/DECISIONS.md` for the rationale.

## Files

- `setup.cmd` - bundled at the ZIP root. User double-clicks after
  extracting. Calls `merge-mcp-config.ps1` with the extract path so
  Claude Desktop's config points at the right bundled Node runtime and
  `dist\src\server\index.js`.
- `uninstall.cmd` - bundled at the ZIP root. Calls
  `unmerge-mcp-config.ps1` to remove the entry, then tells the user
  to delete the folder.
- `instructions.txt` - bundled at the ZIP root. Plain-text
  walkthrough for users browsing the extracted folder.
- `merge-mcp-config.ps1` - bundled at `install/` inside the ZIP.
  Idempotently adds the `mcp-midi-control` entry to Claude Desktop's
  `claude_desktop_config.json`, preserving any other MCP servers the
  user has configured. Handles both the direct-download and Microsoft
  Store variants of Claude Desktop.
- `unmerge-mcp-config.ps1` - bundled at `install/` inside the ZIP.
  Removes our entry (leaves other MCP servers alone).

## How to build the release ZIP

```
npm run build:installer
```

This compiles TypeScript, downloads + caches the pinned Node version,
populates `build/staging/` with the bundled Node runtime + `dist/` +
production-only `node_modules/` + the wrappers above, then packages it
into `build/dist/mcp-midi-control-v<version>.zip` (~25–40 MB
compressed). See `docs/RELEASE-RUNBOOK.md` for the full release flow
including smoke testing.

## Troubleshooting

- **"node-midi failed to load"** at runtime - almost always means the
  bundled native binary's V8 ABI does not match the bundled Node
  runtime. Make sure the `node --version` on PATH at build time
  matches `NODE_VERSION` in `scripts/build-installer.ts` (currently
  v24.13.1), and re-run `npm run build:installer -- --clean` to start
  fresh.
- **PowerShell ExecutionPolicy errors** during the post-install merge
  - the install script uses `-ExecutionPolicy Bypass` which works
  regardless of system policy. If you see policy errors anyway, the
  user's environment may have AppLocker or similar blocking
  PowerShell entirely.
- **Claude Desktop does not see the tool** after install - quit
  Claude Desktop fully (system tray right-click → Quit, not just close
  the window) and relaunch. Claude Desktop only reads the config file
  at startup.
