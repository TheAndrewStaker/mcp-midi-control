/**
 * Offline regression for the AM4 deterministic dirty gate.
 *
 * The AM4 navigation dirty-gate was re-based (2026-06-03) off the
 * non-deterministic working-buffer fingerprint and onto the in-memory
 * `markDirty`/`markClean`/`isDirty` tracker (packages/core/src/server-shared/
 * bufferDirty.ts) — the same model Axe-Fx II and fractal-gen3 use.
 * `markDirty` fires on every acked AM4 edit-class write; `markClean` on
 * save / switch.
 *
 * This drives the SHIPPED server with MCP_MOCK_TRANSPORT=1 and exercises the
 * real tool surface + dispatcher gating (executeSwitchPreset →
 * writer.guardActiveBufferOrSave), so it proves the call-site wiring end to
 * end, not just the guard in isolation. It reproduces the v0.1.0 user's exact
 * failure (server-log id 11): a navigation refused for "unsaved edits"
 * immediately after a clean save. Asserted POSITIVE here — the save must
 * leave the buffer clean so the next navigation proceeds.
 *
 * Cases (sequenced; the in-server flag persists across calls):
 *   1. Fresh/clean buffer → switch_preset proceeds (isDirty=false).
 *   2. set_param (acked) → switch_preset(warn) REFUSES ("unsaved …").
 *   3. …still dirty → switch_preset(discard) proceeds.
 *   4. set_param → switch_preset(save_active_first) proceeds (saves first).
 *   5. THE REGRESSION: set_param → save_preset → switch_preset(warn) PROCEEDS.
 *
 * Run: `npm run build && npx tsx scripts/verify-am4-dirty-gate.ts`
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
// The unambiguous refusal marker. NOT "unsaved working-buffer edits" — that
// phrase also appears in the BENIGN switch success info ("Any unsaved
// working-buffer edits were discarded"), which would false-positive.
const REFUSAL = /REFUSING TO NAVIGATE/i;

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
    { name: 'verify-am4-dirty-gate', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  const setParam = (value: number) =>
    client.callTool({
      name: 'set_param',
      arguments: { port: 'am4', block: 'amp', name: 'gain', value },
    });
  const switchPreset = (
    location: string,
    mode?: 'warn' | 'discard' | 'save_active_first',
  ) =>
    client.callTool({
      name: 'switch_preset',
      arguments: {
        port: 'am4',
        location,
        ...(mode ? { on_active_preset_edited: mode } : {}),
      },
    });
  const savePreset = (location: string) =>
    client.callTool({
      name: 'save_preset',
      arguments: { port: 'am4', location },
    });

  try {
    await client.connect(transport);

    // 1. Clean buffer (fresh session, no edits) → switch proceeds.
    {
      const r = await switchPreset('A02');
      const text = extractText(r);
      record(
        'clean buffer → switch_preset proceeds (no false refusal)',
        !isError(r) && !REFUSAL.test(text),
        [`isError=${isError(r)}`, `text: ${text.slice(0, 120)}`],
      );
    }

    // 2. An acked edit dirties the buffer → next switch (warn) refuses.
    {
      const e = await setParam(5);
      const r = await switchPreset('A03');
      const text = extractText(r);
      record(
        'set_param then switch_preset(warn) → REFUSES with "unsaved working-buffer edits"',
        REFUSAL.test(text),
        [`set_param isError=${isError(e)}`, `switch isError=${isError(r)}`, `text: ${text.slice(0, 160)}`],
      );
    }

    // 3. Still dirty → discard mode proceeds (and switch_preset markClean's).
    {
      const r = await switchPreset('A03', 'discard');
      const text = extractText(r);
      record(
        'switch_preset(discard) on a dirty buffer → proceeds',
        !isError(r) && !REFUSAL.test(text),
        [`isError=${isError(r)}`, `text: ${text.slice(0, 120)}`],
      );
    }

    // 4. Edit → save_active_first saves the buffer first, then proceeds.
    {
      await setParam(6);
      const r = await switchPreset('B01', 'save_active_first');
      const text = extractText(r);
      record(
        'switch_preset(save_active_first) on a dirty buffer → proceeds (saves first)',
        !isError(r) && !REFUSAL.test(text),
        [`isError=${isError(r)}`, `text: ${text.slice(0, 160)}`],
      );
    }

    // 5. THE REGRESSION (server-log id 11): edit → save_preset → the next
    //    navigation must NOT be refused. markClean fires on the save ack.
    {
      await setParam(7);
      const s = await savePreset('Z04');
      const r = await switchPreset('A04');
      const text = extractText(r);
      record(
        'REGRESSION: set_param → save_preset → switch_preset(warn) PROCEEDS (no false "edited" refusal)',
        !isError(s) && !isError(r) && !REFUSAL.test(text),
        [`save isError=${isError(s)}`, `switch isError=${isError(r)}`, `text: ${text.slice(0, 160)}`],
      );
    }
  } finally {
    await client.close();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'am4 dirty gate: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
