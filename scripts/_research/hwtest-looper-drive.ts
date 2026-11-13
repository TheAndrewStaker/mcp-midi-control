#!/usr/bin/env tsx
/**
 * Interactive looper driver: send one looper transport command via set_param so
 * we can watch the device react (resolves the read-indeterminate offset).
 *
 *   npx tsx scripts/_research/hwtest-looper-drive.ts <name> <value>
 *   e.g.  ... record 1   |   ... play 1   |   ... reverse 1   |   ... reverse 0
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER = path.join(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'axe-fx-ii';

const name = process.argv[2] ?? 'record';
const value = Number(process.argv[3] ?? '1');

function textOf(res: unknown): string {
  const r = res as { content?: { text?: string }[] };
  return (r.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function main() {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER], env: { ...process.env } });
  const client = new Client({ name: 'looper-drive', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  console.log(`>> set_param looper.${name} = ${value}\n`);
  try {
    const res = await client.callTool({
      name: 'set_param',
      arguments: { port: PORT, block: 'looper', name, value, save_authorized: false },
    });
    console.log(textOf(res).replace(/\s+/g, ' ').slice(0, 400));
  } catch (e) {
    console.log('ERROR:', (e as Error).message.slice(0, 300));
  }
  await client.close();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
