/**
 * One-off HARDWARE drive for the cold-start write retry (real AM4, no mock).
 *
 * The cold-start ack drop is a non-deterministic USB warm-up artifact, so
 * it can't be forced on hardware. What this DOES verify on the device:
 * after forcing a fresh (cold) handle via reconnect_midi, a normal
 * set_param write still acks under the new cold-handle code path — i.e. no
 * regression. Non-destructive: reads amp.gain, writes the SAME value back.
 *
 * Spawns a FRESH server so it loads the current dist (the long-lived
 * session MCP handle may be running an older build). Run:
 *   npx tsx scripts/_research/hw-verify-cold-start.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

interface CallResult { content?: Array<{ type?: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean; }
const text = (r: unknown) => ((r as CallResult)?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const sc = (r: unknown) => (r as CallResult)?.structuredContent;
const err = (r: unknown) => !!(r as CallResult)?.isError;

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  transport.stderr?.on('data', (b: Buffer) => { const s = b.toString(); if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const client = new Client({ name: 'hw-verify-cold-start', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  try {
    console.log('1. reconnect_midi(am4) → force a fresh COLD handle');
    const rc = await client.callTool({ name: 'reconnect_midi', arguments: { port: 'am4' } });
    console.log(`   isError=${err(rc)} ${text(rc).slice(0, 160)}`);

    console.log('2. get_param(am4, amp.gain) → read current value (cold handle stays cold on reads)');
    const g = await client.callTool({ name: 'get_param', arguments: { port: 'am4', block: 'amp', name: 'gain' } });
    const cur = sc(g)?.['display_value'];
    console.log(`   isError=${err(g)} display_value=${JSON.stringify(cur)} ${text(g).slice(0, 160)}`);

    console.log('3. set_param(am4, amp.gain, <same value>) → FIRST WRITE on cold handle, must ack (non-destructive)');
    const writeVal = typeof cur === 'number' ? cur : 5;
    const s = await client.callTool({ name: 'set_param', arguments: { port: 'am4', block: 'amp', name: 'gain', value: writeVal } });
    console.log(`   isError=${err(s)} acked=${JSON.stringify(sc(s)?.['acked'])} ${text(s).slice(0, 200)}`);

    const pass = !err(s) && sc(s)?.['acked'] === true;
    console.log(`\n${pass ? '✓ PASS' : '✗ FAIL'} — cold-handle first write acked on real AM4 (no regression)`);
    process.exit(pass ? 0 : 1);
  } finally {
    await client.close();
  }
}
main().catch((e) => { console.error('Fatal:', e); process.exit(99); });
