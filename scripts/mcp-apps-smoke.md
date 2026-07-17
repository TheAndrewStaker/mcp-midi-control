# MCP Apps render smoke test

A throwaway diagnostic to answer one question on YOUR Claude Desktop build: does
an interactive MCP App iframe from a **local stdio** server actually mount, or
does the host silently fall back to a text stub?

Research (2026-07-12) + Anthropic's own troubleshooting docs say a stdio server
**cannot** get a sandbox origin (there is no URL to hash), so this will almost
certainly show the **text stub**, not the rendered panel. This test confirms that
for your exact machine instead of assuming it. It uses the official
`@modelcontextprotocol/ext-apps` helpers, so a text-stub result is a *true*
negative (rendering blocked), not a bad-config false negative.

## 1. Add it as a second connector

Edit `claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows) and add an entry under
`mcpServers` (leave your existing `mcp-midi-control` entry as-is):

```json
{
  "mcpServers": {
    "openrig-smoke": {
      "command": "node",
      "args": ["C:\\dev\\mcp-midi-tools\\scripts\\mcp-apps-smoke.mjs"]
    }
  }
}
```

Use `node` + the `.mjs` (a plain-JS copy that node runs directly), NOT `tsx` or
`npx`. On Windows, Claude Desktop cannot spawn a `.cmd` shim like `tsx.cmd`, so a
`tsx`/`npx` command silently fails to load the connector. `node` is a real `.exe`
(the same launcher the main `mcp-midi-control` server uses), and node resolves the
imports from the repo's `node_modules` because the script lives inside the repo.

## 2. Fully relaunch Claude Desktop

Quit completely (the tray icon too, not just the window) and reopen, so the new
connector is picked up.

## 3. Run it

In a new chat, ask: **"run the openrig render smoke test"** (it calls the
`openrig_render_smoke_test` tool).

## 4. Read the result

- **You see a green "MCP App iframe rendered" panel** (with a button) inside the
  chat -> interactive MCP Apps WORK on your Desktop from a local stdio server.
  Surprising, and great: it means we can build the editable canvas as an MCP App.
- **You see only plain text** starting with "SMOKE TEST FALLBACK TEXT..." ->
  the iframe did NOT mount. This is the expected outcome for local stdio, and it
  confirms the editable-in-chat canvas is not viable on our current architecture
  (the durable path stays: the `edit_rig` tool by conversation, plus a local-web
  editor if you want a real drag canvas).

## 5. Clean up

Remove the `openrig-smoke` entry from the config and relaunch when done. Nothing
here touches your rig or the main server.

---

If the stub shows (likely), the only way to get an MCP App to render is a
**remote / Streamable-HTTP** server plus a custom connector (Claude paid plan;
the official build guide uses a `cloudflared` tunnel for exactly this). That is a
distribution change for a local-first product, so it stays an opt-in decision,
not the default. See `docs/design/OPENRIG-UI-RESEARCH.md`.
