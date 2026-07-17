/**
 * Bench: VE-500 SYSTEM-region write leg. Sets system_output.output_level
 * to 130, reads it back, then restores 137 (the founder-confirmed prior
 * value) and reads back again. Founder watches the unit's menu page.
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
  const c = new Client({ name: 'bench-ve500-sys-set', version: '1' }, { capabilities: {} });
  await c.connect(t);
  const call = async (name: string, args: Record<string, unknown>) =>
    ext(await c.callTool({ name, arguments: args }));
  const readLevel = async (label: string) => {
    const r = await call('get_param', { port: 've-500', block: 'system_output', name: 'output_level' });
    const m = r.match(/"display_value":\s*(\d+)/);
    console.log(`${label}: display_value=${m?.[1] ?? '?'}`);
  };
  try {
    const target = Number(process.argv[2] ?? 130);
    console.log(`set output_level -> ${target} (no restore; founder re-enters the menu page to check)`);
    const s = await call('set_param', { port: 've-500', block: 'system_output', name: 'output_level', value: target });
    console.log(s.match(/"acked":\s*\w+/)?.[0] ?? s.slice(0, 200));
    await readLevel('read-back');
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
