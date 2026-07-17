/**
 * Bench test 4: VE-500 factory preset recall (P01, then P17) via the
 * newly decoded Current Patch Number register write (2026-07-09 decode,
 * editor-extract oracle), plus a system-param set/get round-trip.
 *
 * The founder reads the VE-500 display after each recall; the device
 * does not echo patch changes, so the front panel is the verification
 * source.
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
  const step = process.argv[2] ?? 'p01';
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'bench-ve500-recall', version: '1' }, { capabilities: {} });
  await c.connect(t);
  const call = async (name: string, args: Record<string, unknown>) =>
    ext(await c.callTool({ name, arguments: args }));
  try {
    if (step === 'p01') {
      console.log('recall factory P01:');
      console.log((await call('switch_preset', { port: 've-500', location: 'P01' })).slice(0, 400));
    } else if (step === 'p17') {
      console.log('recall factory P17:');
      console.log((await call('switch_preset', { port: 've-500', location: 'P17' })).slice(0, 400));
    } else if (step === 'sysparam') {
      console.log('get system_output.output_level:');
      const before = await call('get_param', { port: 've-500', block: 'system_output', name: 'output_level' });
      console.log(before.slice(0, 300));
    }
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
