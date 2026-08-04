/** One-shot pack-4 pool read (read-only). Run: npx tsx samples/_scratch/smooth-pool-read.ts */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve('C:/dev/mcp-midi-tools', 'packages', 'server-all', 'dist', 'server', 'index.js');
const ext = (r: unknown): string => {
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c?.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
};
async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: 'C:/dev/mcp-midi-tools' });
  const c = new Client({ name: 'pool-read', version: '1' }, { capabilities: {} });
  await c.connect(t);
  try {
    const r = await c.callTool({ name: 'list_samples', arguments: { port: 'circuit-tracks', pack: 4 } }, undefined, { timeout: 60_000 });
    console.log(ext(r));
  } finally { await c.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
