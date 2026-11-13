/**
 * Focused reproducer for the launch-verify dirty-gate failure.
 *
 * Walks the exact sequence launch-verify uses, plus dumps the working
 * buffer before/after the set_param so we can see whether the fingerprint
 * pipeline observes the change.
 *
 * Run: npm run build && npx tsx scripts/_research/probe-dirty-gate.ts
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '<no response>';
  const c = r as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  return (c.content ?? [])
    .filter((x) => x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text!)
    .join('\n') + (c.isError ? '\n[isError=true]' : '');
}

function hashChunks(payload: string): string {
  try {
    const obj = JSON.parse(payload) as { chunkBytes?: number[][] };
    if (!obj.chunkBytes) return '<no chunkBytes>';
    const h = createHash('sha256');
    for (const chunk of obj.chunkBytes) h.update(Uint8Array.from(chunk));
    return h.digest('hex').slice(0, 32);
  } catch (e) {
    return `<parse-error: ${(e as Error).message}>`;
  }
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) transport.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const client = new Client({ name: 'probe-dirty-gate', version: '0.1.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);

  console.log('Step 1: switch_preset Z3, discard (establishes baseline cache)');
  const r1 = await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'Z3', on_active_preset_edited: 'discard' },
  });
  console.log('  →', extractText(r1).slice(0, 200));

  await new Promise((res) => setTimeout(res, 600));

  console.log('\nStep 2: dump active buffer (baseline #1)');
  const d1 = await client.callTool({ name: 'am4_request_active_buffer_dump', arguments: {} });
  const d1text = extractText(d1);
  console.log('  raw:', d1text.slice(0, 400));
  console.log('  hash:', hashChunks(d1text));

  console.log('\nStep 3: dump active buffer (baseline #2 — same state, should match)');
  const d2 = await client.callTool({ name: 'am4_request_active_buffer_dump', arguments: {} });
  const d2text = extractText(d2);
  console.log('  hash:', hashChunks(d2text));

  console.log('\nStep 4: set_param amp.gain 7 (dirty the buffer)');
  await client.callTool({
    name: 'set_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain', value: 7 },
  });
  await new Promise((res) => setTimeout(res, 250));

  console.log('\nStep 5: dump active buffer (should differ from baseline if dirty)');
  const d3 = await client.callTool({ name: 'am4_request_active_buffer_dump', arguments: {} });
  const d3text = extractText(d3);
  console.log('  hash:', hashChunks(d3text));

  console.log('\nStep 6: switch_preset A1 (no flag → mode=warn → should REFUSE)');
  const r3 = await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'A1' },
  });
  console.log('  →', extractText(r3).slice(0, 400));

  // Cleanup.
  await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'Z3', on_active_preset_edited: 'discard' },
  });
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
