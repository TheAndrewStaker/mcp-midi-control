/**
 * MCP App (SEP-1865) registration for the Rig Console panel.
 *
 * HELLO-WORLD CHECKPOINT (RIG-CONSOLE-NEXT.md, 2026-08-10). The previous
 * version dynamically imported `@modelcontextprotocol/ext-apps` from
 * `https://esm.sh/...` inside the iframe at load time. That was found to
 * throw a hard, 100%-reproducible `TypeError: t.custom is not a function`
 * (a zod version conflict inside esm.sh's dependency resolution) — confirmed
 * by constructing the same `App` class directly in a real browser via
 * Playwright, three separate times, identical crash every time, with no
 * Claude Desktop involved at all. Every server that actually rendered during
 * live testing that day (Anthropic's own hosted reference server, and this
 * project's `pneuma-local-gate` probe) uses a real bundled dependency with a
 * PINNED `@modelcontextprotocol/ext-apps` version, never a runtime CDN fetch.
 *
 * The fix: `src/server/webapp-client/rig-console-app.ts` is bundled at build
 * time by esbuild (`npm run build:webapp`, pinned deps in package.json) into
 * `dist/webapp-client/rig-console-app.js`, a single self-contained script
 * with zero remaining imports. This file reads that bundle once at module
 * load and inlines it directly into the resource HTML — no `<script src>`,
 * so there is no relative-path resolution to get wrong inside a sandboxed
 * iframe either. Re-verified in the same Playwright harness after the fix:
 * construction and the `ui/initialize` send both proceed with no crash.
 *
 * Grown back from the hello-world checkpoint into the full device-list panel
 * (RIG-CONSOLE-NEXT.md, 2026-08-10) after confirming the bundled bridge
 * renders on the maintainer's Desktop. See `rig-console-app.ts` for the
 * client-side rendering code.
 *
 * Contract notes (why the shapes below look the way they do):
 *   - The resource is the panel HTML under the MCP Apps profile MIME type
 *     `text/html;profile=mcp-app`. Supporting hosts mount it in a sandboxed
 *     iframe when the tool below returns.
 *   - The tool carries `_meta.ui.resourceUri` (the NESTED shape; the flat
 *     'ui/resourceUri' key is deprecated). `_meta.ui.domain` is deliberately
 *     never set: wrong values kill the mount, omitting it mounts fine.
 *   - Claude Desktop strips `structuredContent` from ui tool results, so the
 *     payload the iframe needs is mirrored into the text content block as a
 *     fenced json block. That text block is also the normative fallback for
 *     hosts without MCP Apps support, so it leads with a human summary line.
 *   - Read-only: the tool runs the same dispatcher call `describe_rig` makes
 *     (a non-opening port scan plus a mounted-drive check) and writes nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/server';

import { executeDescribeRig } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

const RESOURCE_URI = 'ui://mcp-midi-control/rig-console.html';
const RESOURCE_MIME = 'text/html;profile=mcp-app';

/** The bundled client script (see the file header for why it's bundled, not CDN-loaded). */
const BUNDLED_APP_JS = readFileSync(
  fileURLToPath(new URL('../webapp-client/rig-console-app.js', import.meta.url)),
  'utf8',
);

/** The panel shell: the device-list DOM the bundled script above renders into. */
const RIG_CONSOLE_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0e1116;color:#e6edf3;padding:16px}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  h1{font-size:15px;margin:0;font-weight:700}
  button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer}
  button:hover{background:#30363d}
  .rig{color:#8b949e;font-size:12px;margin-bottom:2px}
  .count{font-weight:600;margin-bottom:8px}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid #21262d}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .on{background:#3fb950}.off{background:#6e7681}
  .name{flex:1}
  .meta{color:#8b949e;font-size:12px}
  .empty{color:#8b949e;padding:12px 0}
  .err{color:#f85149;padding:12px 0}
</style></head><body>
<div class="top"><h1>Rig Console</h1><button id="refresh">Refresh</button></div>
<div id="body"><div class="empty">Loading rig...</div></div>
<script type="module">${BUNDLED_APP_JS}</script>
</body></html>`;

export function registerRigConsoleApp(server: McpServer): void {
  server.registerResource(
    'Rig Console',
    RESOURCE_URI,
    {
      title: 'Rig Console',
      description: 'Read-only MCP App panel: registered vs connected devices, from describe_rig.',
      mimeType: RESOURCE_MIME,
    },
    async () => ({
      contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME, text: RIG_CONSOLE_HTML }],
    }),
  );

  server.registerTool('show_rig_console', {
    title: 'Show Rig Console',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Opens a live rig panel in hosts that support MCP Apps: registered vs connected devices, read-only. '
      + 'Other hosts get the same summary as plain text. Carries NO cabling, channel, or topology detail; '
      + 'never infer wiring from this result. For the actual signal-flow diagram, call open_rig_editor instead. '
      + 'Changes nothing on any device.',
    inputSchema: {},
    _meta: { ui: { resourceUri: RESOURCE_URI } },
  }, async () => {
    try {
      const payload = executeDescribeRig();
      const line = `Rig: ${payload.total_registered} devices, ${payload.connected_count} connected. `
        + 'No cabling/channel data here (this call only reports device presence) — call open_rig_editor for the wiring diagram.';
      // One text block: human line first (the normative fallback), then the
      // full payload as fenced json so the iframe can recover it on hosts
      // that strip structuredContent from ui tool results.
      const text = `${line}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: payload as unknown as Record<string, unknown>,
      };
    } catch (err) {
      return asError(err);
    }
  });
}
