/**
 * Bench: export the II active working buffer as a .syx fixture for the
 * Y-channel effect_type decode bug (drive X=T808 OD / Y=BLACKGLASS 7K,
 * hardware-confirmed on the front panel 2026-07-10).
 * Read-only: export_preset does not mutate the buffer.
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
  const c = new Client({ name: 'bench-ii-export-fixture', version: '1' }, { capabilities: {} });
  await c.connect(t);
  try {
    const r = await c.callTool({ name: 'export_preset', arguments: { port: 'Fractal Axe-Fx II XL+' } });
    console.log(ext(r).slice(0, 600));
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
