/**
 * MCP Apps RENDER SMOKE TEST (throwaway diagnostic).
 *
 * Purpose: on YOUR Claude Desktop build, does an interactive MCP App iframe from
 * a LOCAL stdio server actually mount, or does the host silently fall back to a
 * text stub? Research (2026-07-12) + Anthropic's own docs say stdio cannot get a
 * sandbox origin (no URL to hash), so this should show the TEXT stub, not the
 * rendered panel. This confirms that for your machine instead of assuming it.
 *
 * Uses the OFFICIAL @modelcontextprotocol/ext-apps helpers so the wire shape is
 * exactly right, and a text-stub result is a TRUE negative (rendering blocked),
 * not a bad-config false negative.
 *
 * Run it by adding this to claude_desktop_config.json (see scripts/mcp-apps-smoke.md),
 * fully quitting + relaunching Claude Desktop, then asking Claude to
 * "run the openrig render smoke test". See scripts/mcp-apps-smoke.md for what to look for.
 *
 * stdio discipline: this is a stdio MCP server, so stdout is the JSON-RPC channel.
 * NEVER write to stdout here (no console.log). Diagnostics go to stderr only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

/** A self-contained page. If you SEE this green panel, the iframe mounted (the good outcome). */
const HTML = `<!doctype html><html><head><meta charset="utf-8" />
<style>
  body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0e1116;color:#e6edf3;
    display:flex;align-items:center;justify-content:center;min-height:220px;padding:20px;text-align:center}
  .card{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:26px 24px;max-width:420px;
    box-shadow:0 8px 30px rgba(0,0,0,.35)}
  .big{font-size:20px;font-weight:700;color:#3fb950;margin-bottom:8px}
  .sub{color:#8b949e;font-size:13px}
  button{margin-top:16px;background:#a371f7;color:#fff;border:none;border-radius:9px;padding:9px 16px;
    font:inherit;font-weight:600;cursor:pointer}
  #echo{margin-top:12px;color:#2dd4bf;font-size:13px;min-height:18px}
</style></head><body>
<div class="card">
  <div class="big">&#9989; MCP App iframe rendered</div>
  <div class="sub">If you can see this panel inside the Claude chat, interactive MCP Apps WORK on your Desktop build from a local stdio server. That would be great (and unexpected) news.</div>
  <button id="b">Ping the server tool</button>
  <div id="echo"></div>
</div>
<script type="module">
  // Progressive: try the ext-apps bridge if it is reachable; the panel renders regardless.
  try {
    const { App } = await import('https://esm.sh/@modelcontextprotocol/ext-apps');
    const app = new App({ name: 'openrig-smoke', version: '0.0.1' });
    app.connect();
    document.getElementById('b').addEventListener('click', async () => {
      try { const r = await app.callServerTool({ name: 'openrig_render_smoke_test', arguments: {} });
        document.getElementById('echo').textContent = 'server replied: ' + (r.content?.find(c=>c.type==='text')?.text ?? '(no text)').slice(0,60);
      } catch (e) { document.getElementById('echo').textContent = 'tool call failed: ' + e.message; }
    });
  } catch (e) {
    document.getElementById('echo').textContent = '(bridge import blocked by CSP, but the panel rendered, which is the thing we are testing)';
  }
</script></body></html>`;

const server = new McpServer({ name: 'openrig-mcp-apps-smoke', version: '0.0.1' });
const resourceUri = 'ui://openrig-smoke/smoke.html';

registerAppResource(
  server,
  resourceUri,
  resourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => ({ contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: HTML }] }),
);

registerAppTool(
  server,
  'openrig_render_smoke_test',
  {
    title: 'OpenRig render smoke test',
    description:
      'Diagnostic: renders a tiny MCP App panel to test whether interactive MCP App UI mounts on this host from a local stdio server. '
      + 'If you see a green "MCP App iframe rendered" panel, it works. If you see only this sentence as plain text, the iframe did NOT mount (expected for local stdio).',
    inputSchema: {},
    _meta: { ui: { resourceUri } },
  },
  async () => ({
    content: [{
      type: 'text',
      text: 'SMOKE TEST FALLBACK TEXT. If you are reading THIS instead of a rendered green panel, the interactive MCP App iframe did NOT mount on your Claude Desktop from this local stdio server. That is the expected result per the 2026-07-12 research (stdio has no URL to hash into a sandbox origin). A green panel instead would mean it DOES render, contradicting the research, which we would want to know.',
    }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[openrig-mcp-apps-smoke] connected over stdio; call the "openrig_render_smoke_test" tool in Claude Desktop.\n');
