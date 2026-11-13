/**
 * Offline regression for the AM4 apply_preset total-operation budget (FIX B).
 *
 * A v0.1.0 user's rebuild apply hung the server for ~4 minutes: when the AM4
 * goes silent mid-burst, each write waits the full 300 ms WRITE_ECHO_TIMEOUT_MS
 * and nothing capped the total, so ~80 silent writes ground for ~25-30 s and,
 * with client retries, presented as a multi-minute hang. FIX B adds an in-loop
 * total budget (APPLY_BUDGET_MS, default 50 s, MCP_APPLY_BUDGET_MS-overridable)
 * that aborts the burst with a structured partial result.
 *
 * This drives the SHIPPED server with:
 *   - MCP_MOCK_TRANSPORT=1
 *   - MOCK_FIXTURE=slow-response  → mock acks arrive at 1500 ms, i.e. AFTER the
 *     300 ms write-echo timeout, so EVERY write times out (a silent device).
 *   - MCP_APPLY_BUDGET_MS=200     → the budget trips after ~1 timed-out write.
 *
 * Without FIX B, an apply over a silent device walks every write and the call
 * does not return for ~N × 300 ms. With FIX B, the apply aborts in well under a
 * second and the response says the budget was exceeded. We assert BOTH: the
 * call returns quickly (proving no grind/hang) AND the response surfaces the
 * budget abort.
 *
 * Run: `npm run build && npx tsx scripts/verify-am4-apply-budget.ts`
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

let failures = 0;
function record(name: string, pass: boolean, notes: string[]): void {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

// A 4-block placement spec — enough writes that, over a silent device, an
// un-budgeted apply would walk several 300 ms timeouts. The budget (200 ms)
// trips after ~1 write.
const SPEC = {
  name: 'Budget Test',
  slots: [
    { slot: 1, block_type: 'drive' },
    { slot: 2, block_type: 'amp' },
    { slot: 3, block_type: 'reverb' },
    { slot: 4, block_type: 'delay' },
  ],
};

async function main(): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_MOCK_TRANSPORT: '1',
    MOCK_FIXTURE: 'slow-response',
    MCP_APPLY_BUDGET_MS: '200',
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
    { name: 'verify-am4-apply-budget', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  try {
    await client.connect(transport);

    // apply_preset audition (no target_location, no save) → the working-buffer
    // path → runApplyPresetWires, where the budget lives. Over the silent
    // device it must ABORT (not grind), and surface the budget.
    {
      const t0 = Date.now();
      const r = await client.callTool({
        name: 'apply_preset',
        arguments: { port: 'am4', spec: SPEC },
      });
      const elapsed = Date.now() - t0;
      const text = extractText(r).toLowerCase();
      const mentionsBudget = /budget/.test(text) && /(exceeded|went silent|aborted)/.test(text);
      record(
        'apply_preset over a silent device → aborts on the budget (not a multi-minute grind)',
        mentionsBudget && elapsed < 8000,
        [`elapsed=${elapsed} ms (budget=200 ms)`, `mentionsBudget=${mentionsBudget}`, `text: ${extractText(r).slice(0, 220)}`],
      );
    }
  } finally {
    await client.close();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'am4 apply budget: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
