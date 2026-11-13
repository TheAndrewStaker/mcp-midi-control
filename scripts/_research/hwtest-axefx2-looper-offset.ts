#!/usr/bin/env tsx
/**
 * Hardware test: resolve the Axe-Fx II Looper paramId offset flagged by the
 * 2014-spec diff. Our catalog has a GAP at paramId 14 and puts `record` at 15;
 * the spec has no gap (record=14, contiguous). This reads the device to decide.
 *
 * Read-only. Drives the live MCP server exactly as the agent would.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER = path.join(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');

// Our catalog's looper params, by paramId, in the disputed region.
const LOOPER_READS: { name: string; pid: number }[] = [
  { name: 'record_beats', pid: 13 }, // last param before the gap
  { name: 'record', pid: 15 },
  { name: 'play', pid: 16 },
  { name: 'once', pid: 17 },
  { name: 'dub', pid: 18 },
  { name: 'undo', pid: 19 },
  { name: 'reverse', pid: 20 },
  { name: 'halfspeed', pid: 21 },
];

function textOf(res: unknown): string {
  const r = res as { content?: { type: string; text?: string }[] };
  return (r.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env } });
  const client = new Client({ name: 'looper-offset-hwtest', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  console.log('=== connected ===\n');

  console.log('[1] list_midi_ports (axe-fx)');
  const ports = await client.callTool({ name: 'list_midi_ports', arguments: { pattern: ['axe-fx', 'axefx'] } });
  console.log(textOf(ports).slice(0, 1200), '\n');

  // Resolve by descriptor id; the connection layer opens the matching OS port.
  const PORT = 'axe-fx-ii';

  console.log('[2] describe_device — confirm the II port did NOT get shadowed by gen-1');
  try {
    const d = await client.callTool({ name: 'describe_device', arguments: { port: PORT } });
    const t = textOf(d);
    const idLine = t.split('\n').find((l) => /"id"|display_name|Axe-Fx/i.test(l)) ?? t.slice(0, 200);
    console.log('   ', idLine.trim(), '\n');
  } catch (e) {
    console.log('   ERROR:', (e as Error).message, '\n');
  }

  console.log('[3] get_param each Looper param in the disputed region');
  console.log('    (compare the on/off toggles — reverse/halfspeed — to the FRONT PANEL)\n');
  for (const r of LOOPER_READS) {
    try {
      const res = await client.callTool({
        name: 'get_param',
        arguments: { port: PORT, block: 'looper', name: r.name },
      });
      console.log(`   pid ${String(r.pid).padStart(2)}  looper.${r.name.padEnd(13)} -> ${textOf(res).replace(/\s+/g, ' ').slice(0, 220)}`);
    } catch (e) {
      console.log(`   pid ${String(r.pid).padStart(2)}  looper.${r.name.padEnd(13)} -> ERROR: ${(e as Error).message.slice(0, 160)}`);
    }
  }

  console.log('\n[4] get_preset (atomic fn=0x1F) — raw indexed snapshot, to inspect index 14 directly');
  try {
    const res = await client.callTool({ name: 'get_preset', arguments: { port: PORT } });
    const t = textOf(res);
    // Print only looper-related lines to keep it readable.
    const lines = t.split('\n').filter((l) => /looper/i.test(l));
    console.log(lines.length ? lines.slice(0, 30).join('\n') : '   (no looper lines surfaced; full length ' + t.length + ' chars)');
  } catch (e) {
    console.log('   ERROR:', (e as Error).message.slice(0, 200));
  }

  await client.close();
  console.log('\n=== done ===');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
