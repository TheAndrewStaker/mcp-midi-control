/**
 * Live verification — AM4 stored-location export via the shipped MCP
 * server (real USB transport). Exports two stored locations (A01 and
 * Z04) without touching the working buffer, asserting the new
 * fn 0x03 [bank, sub, 0x00] path end-to-end.
 *
 * Read-only: no apply, no save, no buffer mutation.
 *
 * Run: npm run build && npx tsx scripts/mcp-hwtest-am4-stored-export.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'am4-stored-export-verify', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await c.connect(t);
  try {
    for (const [loc, code] of [[0, 'A01'], [103, 'Z04']] as const) {
      console.log(`export_preset(am4, location=${loc}) — stored ${code} …`);
      const r = await c.callTool({ name: 'export_preset', arguments: { port: 'am4', location: loc } });
      const text = ext(r);
      let p: { ok?: boolean; source?: string; byte_length?: number; name?: string; file_path?: string } = {};
      try { p = JSON.parse(text); } catch { /* checked below */ }
      check(`${code}: ok + 12352 bytes, got ${p.byte_length}`, !isError(r) && p.ok === true && p.byte_length === 12352, text.slice(0, 250));
      check(`${code}: source says stored ${code}, got "${p.source}"`, (p.source ?? '').includes(`stored preset at location ${code}`));
      console.log(`  name="${p.name}" file=${p.file_path}`);
    }
  } finally {
    await c.close();
  }
  console.log(failed === 0 ? '\nALL CHECKS PASS' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`hwtest failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
