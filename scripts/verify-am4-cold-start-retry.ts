/**
 * Offline regression for the AM4 cold-start write retry.
 *
 * A freshly-opened USB-MIDI handle frequently drops its very first
 * outbound transaction during driver warm-up, so the first write's ack
 * goes missing even though the handle is healthy. `sendAndAwaitAck`
 * (packages/am4/src/shared/wireOps.ts) resends ONCE on the same open
 * handle when the first write on a COLD handle (isColdHandle, see
 * packages/core/src/server-shared/connections.ts) gets no ack.
 *
 * This test spawns the shipped MCP server with MCP_MOCK_TRANSPORT=1 and
 * MOCK_FIXTURE=drop-first-ack. That fixture makes the AM4 mock swallow the
 * FIRST SET_PARAM write-echo (no ack), then ack normally. So:
 *   - WITHOUT the cold-start resend, the first set_param would come back
 *     acked:false (the writer surfaces "no ack within 300 ms").
 *   - WITH the resend, the second send lands and the write acks.
 * Asserting acked:true on a write whose first echo was definitively
 * dropped is the proof the resend fired and recovered the cold start.
 *
 * A second set_param (handle now warm, fixture disarmed) must also ack —
 * guarding against a resend that somehow consumed the handle's only ack.
 *
 * Run: `npm run build && npx tsx scripts/verify-am4-cold-start-retry.ts`
 * Status: offline, no hardware required.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(
  process.cwd(),
  'packages',
  'server-all',
  'dist',
  'server',
  'index.js',
);

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function extractText(r: unknown): string {
  const x = r as CallResult;
  return (x?.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}
function structured(r: unknown): Record<string, unknown> | undefined {
  return (r as CallResult)?.structuredContent;
}

let failures = 0;
function record(name: string, pass: boolean, notes: string[]): void {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

async function main(): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_MOCK_TRANSPORT: '1',
    MOCK_FIXTURE: 'drop-first-ack',
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'verify-am4-cold-start-retry', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  try {
    await client.connect(transport);

    // First write: the mock drops its write-echo (cold-start drop). The
    // cold-start resend must recover it so the write acks.
    {
      const r = await client.callTool({
        name: 'set_param',
        arguments: { port: 'am4', block: 'amp', name: 'gain', value: 5 },
      });
      const sc = structured(r);
      const acked = sc?.['acked'];
      const notes = [
        `isError=${isError(r)}`,
        `structuredContent.acked=${JSON.stringify(acked)}`,
      ];
      if (acked === undefined) notes.push(`text: ${extractText(r).slice(0, 200)}`);
      // The defining assertion: the first write-echo was dropped by the
      // fixture, yet the write acked — only possible via the resend.
      record(
        'set_param(am4, amp.gain) on a cold handle whose first ack was dropped → write acks via resend',
        !isError(r) && acked === true,
        notes,
      );
    }

    // Second write: handle is warm, fixture disarmed — must ack normally.
    {
      const r = await client.callTool({
        name: 'set_param',
        arguments: { port: 'am4', block: 'amp', name: 'gain', value: 6 },
      });
      const sc = structured(r);
      record(
        'set_param(am4, amp.gain) second call (warm handle) → acks normally',
        !isError(r) && sc?.['acked'] === true,
        [`isError=${isError(r)}`, `structuredContent.acked=${JSON.stringify(sc?.['acked'])}`],
      );
    }
  } finally {
    await client.close();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'cold-start retry: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
