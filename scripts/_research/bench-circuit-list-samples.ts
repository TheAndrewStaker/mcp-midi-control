/**
 * Bench: Circuit Tracks list_samples via the re-decoded non-destructive
 * directory listing (DIR_CONTROL sub 0x0b). First hardware run of the
 * rewritten read path. Read-only by construction (goldens assert the
 * sent-frame list carries no WRITE ops).
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve('C:/dev/mcp-midi-tools', 'packages', 'server-all', 'dist', 'server', 'index.js');

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'bench-circuit-list-samples', version: '1' }, { capabilities: {} });
  await c.connect(t);
  try {
    const started = Date.now();
    const r = await c.callTool({ name: 'list_samples', arguments: { port: 'circuit' } });
    const elapsed = Date.now() - started;
    const text = ext(r);
    console.log('elapsed_ms:', elapsed);
    let p: { occupied?: number; total?: number; capacity_note?: string; slots?: Array<{ slot: number; name?: string }> } = {};
    try { p = JSON.parse(text); } catch { console.log(text.slice(0, 1200)); return; }
    console.log('occupied:', p.occupied, '/', p.total);
    if (p.capacity_note) console.log('note:', p.capacity_note);
    for (const s of p.slots ?? []) {
      if (s.name !== undefined) console.log(`  slot ${s.slot}: ${s.name}`);
    }
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
