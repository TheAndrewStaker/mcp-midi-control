/**
 * Client-side MCP App script for the Rig Console panel (SEP-1865). Bundled by
 * esbuild at build time into a single self-contained script with a PINNED
 * `@modelcontextprotocol/ext-apps` dependency (see package.json), then
 * embedded inline into the resource HTML `apps.ts` serves. See that file's
 * header for why this is bundled rather than CDN-loaded (a dynamic
 * `import('https://esm.sh/...')` was found to throw a hard,
 * 100%-reproducible `TypeError: t.custom is not a function` from a zod
 * version conflict in esm.sh's dependency resolution).
 *
 * Grown back from the 2026-08-10 hello-world checkpoint into the original
 * device-list panel, now that the bundled bridge is confirmed rendering.
 *
 * Two DIFFERENT result shapes to parse, both real:
 *   - `show_rig_console`'s own result (delivered once via `ontoolresult` when
 *     the panel mounts, since MCP Apps auto-forwards the initiating tool
 *     call's result): a human line, then a fenced ```json block.
 *   - `describe_rig`'s result (what the Refresh button calls via
 *     `callServerTool`, `asText()` in tools/shared.ts): plain
 *     `JSON.stringify(payload)`, no prose, no fence.
 * `parsePayload` below handles both, plus `structuredContent` for hosts that
 * don't strip it.
 */
import { App } from '@modelcontextprotocol/ext-apps';

interface RigDevice {
  id: string;
  name: string;
  connected: boolean;
  via?: string;
  transport: string;
}

interface DescribeRigPayload {
  total_registered: number;
  connected_count: number;
  devices: RigDevice[];
  manifest?: { name?: string };
}

interface ToolResultLike {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

function parsePayload(result: ToolResultLike): DescribeRigPayload {
  if (result.structuredContent !== undefined) {
    return result.structuredContent as unknown as DescribeRigPayload;
  }
  const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
  const fenced = /```json\s*([\s\S]*?)```/.exec(text);
  return JSON.parse(fenced ? fenced[1] : text) as DescribeRigPayload;
}

const bodyEl = document.getElementById('body')!;
const refreshBtn = document.getElementById('refresh')!;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function render(p: DescribeRigPayload): void {
  let head = '';
  if (p.manifest?.name !== undefined) head += `<div class="rig">Rig: ${esc(p.manifest.name)}</div>`;
  head += `<div class="count">${Number(p.connected_count)} of ${Number(p.total_registered)} devices connected</div>`;
  const devs = p.devices ?? [];
  if (devs.length === 0) {
    bodyEl.innerHTML = `${head}<div class="empty">No devices registered.</div>`;
    return;
  }
  const rows = devs.map((d) => (
    `<li><span class="dot ${d.connected ? 'on' : 'off'}"></span>`
    + `<span class="name">${esc(d.name)}</span>`
    + `<span class="meta">${d.connected ? 'connected' : 'absent'} &middot; ${esc(d.transport)}</span></li>`
  )).join('');
  bodyEl.innerHTML = `${head}<ul>${rows}</ul>`;
}

function renderError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  bodyEl.innerHTML = `<div class="err">Could not read the rig: ${esc(msg)}</div>`;
}

const app = new App({ name: 'rig-console', version: '0.1.0' });

// The panel-opening `show_rig_console` call's own result arrives here once,
// automatically, on mount — this is the initial paint, no round trip needed.
app.ontoolresult = (result) => {
  try {
    render(parsePayload(result as ToolResultLike));
  } catch (e) {
    renderError(e);
  }
};

refreshBtn.addEventListener('click', async () => {
  bodyEl.innerHTML = '<div class="empty">Loading rig...</div>';
  try {
    const result = await app.callServerTool({ name: 'describe_rig', arguments: {} });
    render(parsePayload(result as ToolResultLike));
  } catch (e) {
    renderError(e);
  }
});

app.connect();
