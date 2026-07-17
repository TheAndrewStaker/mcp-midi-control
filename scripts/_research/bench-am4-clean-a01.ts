/**
 * Bench: discard the AM4 working-buffer edits (suite leftovers), move to
 * A01, then round-trip a scene switch (2 -> 1) to confirm navigation and
 * scene switching post-fix.
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
  const c = new Client({ name: 'bench-am4-clean-a01', version: '1' }, { capabilities: {} });
  await c.connect(t);
  try {
    console.log('1) switch_preset -> A01 (discard unsaved edits)');
    const sw = await c.callTool({ name: 'switch_preset', arguments: { port: 'am4', location: 'A01', on_active_preset_edited: 'discard' } });
    console.log(ext(sw).slice(0, 400));

    console.log('\n2) switch_scene -> 2');
    const s2 = await c.callTool({ name: 'switch_scene', arguments: { port: 'am4', scene: 2 } });
    console.log(ext(s2).slice(0, 300));

    console.log('\n3) switch_scene -> 1');
    const s1 = await c.callTool({ name: 'switch_scene', arguments: { port: 'am4', scene: 1 } });
    console.log(ext(s1).slice(0, 300));
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
