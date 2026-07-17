/**
 * Offline regression for the AM4 DEVICE-TRUE dirty bit (GET_PATCH byte[21]).
 *
 * The AM4 navigation dirty-gate prefers the device-true "edited" bit —
 * read via a GET_PATCH descriptor read (`byte[21] & 0x04`) — over the
 * in-memory `markDirty`/`isDirty` tracker, falling back to the tracker only
 * if the read fails. Confirmed on hardware 2026-06-03
 * (`scripts/_research/probe-am4-edit-counter.ts`): the bit holds 0x00 at
 * rest, flips to 0x04 on any working-buffer edit (ours, front-panel, or
 * AM4-Edit), and returns to 0x00 on save.
 *
 * This drives the SHIPPED server with MCP_MOCK_TRANSPORT=1 (so it exercises
 * the real dispatcher gate → writer.guardActiveBufferOrSave →
 * readActiveBufferEditedBit), and proves the property the in-memory tracker
 * alone CANNOT: an out-of-band edit (no agent write at all, so isDirty is
 * clean) is still caught and refused because the device reports the buffer
 * edited.
 *
 * Two scenarios, each in its own server process (the mock's edited-bit
 * state and fixture are per-process):
 *
 *   A. MOCK_FIXTURE=front-panel-edited — GET_PATCH always reports edited.
 *      A FRESH session (no agent writes → isDirty=false) navigating with
 *      on_active_preset_edited='warn' must REFUSE. Only the device bit can
 *      produce this; the in-memory tracker would say clean and proceed.
 *
 *   B. default fixture — drives the edit→save→navigate sequence through the
 *      device bit: set_param dirties (GET_PATCH=edited → refuse), then
 *      save_preset clears the device bit (GET_PATCH=clean → proceed).
 *
 *   C. MOCK_FIXTURE=edited-bit-lag — GET_PATCH always reports CLEAR, even
 *      immediately after an acked write (simulating the device-side bit
 *      lagging our own write, caught live 2026-07-10 as an
 *      audition-then-switch gate slip). set_param (marks the in-memory
 *      tracker dirty, mock acks) followed IMMEDIATELY by
 *      switch_preset(warn) must REFUSE — only the propagation-race guard
 *      in `isActiveBufferDirty` (packages/am4/src/tools/safeEdit.ts) can
 *      produce this, since the device bit itself reads clean. A second,
 *      fresh process under the SAME fixture with NO write proves the
 *      negative side: tracker clean + device clean → 'warn' proceeds
 *      (this also stands in for window-expiry, without sleeping 2s in
 *      the test).
 *
 * Run: `npm run build && npx tsx scripts/verify-am4-edited-bit.ts`
 * Status: offline, no hardware required.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
const REFUSAL = /REFUSING TO NAVIGATE/i;

let failures = 0;
function record(name: string, pass: boolean, notes: string[]): void {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

async function withClient(
  fixture: string | undefined,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_MOCK_TRANSPORT: '1',
  };
  if (fixture) env.MOCK_FIXTURE = fixture;
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
  const client = new Client({ name: 'verify-am4-edited-bit', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close();
  }
}

const switchPreset = (
  client: Client,
  location: string,
  mode?: 'warn' | 'discard' | 'save_active_first',
) =>
  client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location, ...(mode ? { on_active_preset_edited: mode } : {}) },
  });
const setParam = (client: Client, value: number) =>
  client.callTool({
    name: 'set_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain', value },
  });
const savePreset = (client: Client, location: string) =>
  client.callTool({ name: 'save_preset', arguments: { port: 'am4', location } });

async function main(): Promise<void> {
  // A. Out-of-band edit: device reports edited, in-memory tracker is clean.
  await withClient('front-panel-edited', async (client) => {
    const r = await switchPreset(client, 'A02', 'warn');
    const text = extractText(r);
    record(
      'front-panel edit (isDirty clean, device bit set) → switch_preset(warn) REFUSES',
      REFUSAL.test(text),
      [`isError=${isError(r)}`, `text: ${text.slice(0, 140)}`],
    );
  });

  // B. Device bit drives edit → save → navigate (default fixture).
  await withClient(undefined, async (client) => {
    // Fresh/clean: device bit reports clean, navigation proceeds.
    {
      const r = await switchPreset(client, 'A02', 'warn');
      record(
        'fresh session → device bit clean → switch_preset proceeds',
        !isError(r) && !REFUSAL.test(extractText(r)),
        [`isError=${isError(r)}`],
      );
    }
    // set_param flips the device bit → next navigation refuses.
    {
      await setParam(client, 5);
      const r = await switchPreset(client, 'A03', 'warn');
      record(
        'set_param → device bit edited → switch_preset(warn) REFUSES',
        REFUSAL.test(extractText(r)),
        [`text: ${extractText(r).slice(0, 120)}`],
      );
    }
    // save_preset clears the device bit → navigation proceeds (no false refusal).
    {
      const s = await savePreset(client, 'Z04');
      const r = await switchPreset(client, 'A04', 'warn');
      record(
        'save_preset clears device bit → switch_preset(warn) proceeds',
        !isError(s) && !isError(r) && !REFUSAL.test(extractText(r)),
        [`save isError=${isError(s)}`, `switch isError=${isError(r)}`],
      );
    }
  });

  // C. Propagation-race guard: device bit permanently lags (always reads
  //    clear), so only the in-memory tracker's trust window can catch a
  //    just-landed write.
  await withClient('edited-bit-lag', async (client) => {
    await setParam(client, 5);
    const r = await switchPreset(client, 'A03', 'warn');
    const text = extractText(r);
    record(
      'set_param then IMMEDIATE switch_preset(warn) under a lagging device bit → REFUSES',
      REFUSAL.test(text),
      [`isError=${isError(r)}`, `text: ${text.slice(0, 140)}`],
    );
  });

  // C-negative: same lagging-bit fixture, but a fresh process with NO write —
  // tracker clean + device bit clean → 'warn' proceeds. Stands in for the
  // trust-window EXPIRING without sleeping 2s in the test.
  await withClient('edited-bit-lag', async (client) => {
    const r = await switchPreset(client, 'A02', 'warn');
    const text = extractText(r);
    record(
      'fresh session under a lagging device bit, no write → switch_preset(warn) proceeds',
      !isError(r) && !REFUSAL.test(text),
      [`isError=${isError(r)}`, `text: ${text.slice(0, 120)}`],
    );
  });

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'am4 edited-bit gate: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
