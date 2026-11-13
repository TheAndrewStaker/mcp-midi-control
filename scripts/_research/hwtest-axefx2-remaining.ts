#!/usr/bin/env tsx
/** Final II read: the category-A disagreements in the placed delay/chorus/rotary blocks. */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
const SERVER = path.join(path.resolve(import.meta.dirname, '..', '..'), 'packages', 'server-all', 'dist', 'server', 'index.js');
const READS = [
  { b: 'delay', n: 'effect_type', spec: 'DELAY_MODEL' },
  { b: 'delay', n: 'feedback_l_r', spec: 'FEEDLR' },
  { b: 'delay', n: 'feedback_r_l', spec: 'FEEDRL' },
  { b: 'chorus', n: 'lfo_2_rate', spec: 'LF02RATE' },
  { b: 'rotary', n: 'hi_level', spec: 'HFLEVEL' },
  { b: 'rotary', n: 'stereo_spread', spec: 'LFWIDTH' },
];
function tx(r: unknown): string { return ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join(' '); }
async function main() {
  const t = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env } });
  const c = new Client({ name: 'rem', version: '0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await c.connect(t);
  for (const r of READS) {
    try {
      const res = await c.callTool({ name: 'get_param', arguments: { port: 'axe-fx-ii', block: r.b, name: r.n } });
      const s = tx(res);
      const live = !/Timeout|no response/i.test(s);
      const w = s.match(/wire_value"?:\s*(\d+)/);
      const d = s.match(/display_value"?:\s*("?[^,}]+"?)/);
      console.log(`${(r.b + '.' + r.n).padEnd(24)} (vs ${r.spec})  ${live ? 'LIVE  wire=' + (w?.[1] ?? '?') + ' display=' + (d?.[1] ?? '?') : 'TIMEOUT'}`);
    } catch (e) { console.log(`${(r.b + '.' + r.n).padEnd(24)} ERR ${(e as Error).message.slice(0, 60)}`); }
  }
  await c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
