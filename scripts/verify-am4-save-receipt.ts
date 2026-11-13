/**
 * Offline regression for the AM4 save_preset RECEIPT + overwrite GATE.
 *
 * Drives the SHIPPED server with MCP_MOCK_TRANSPORT=1, so it exercises the
 * real tool surface + dispatcher + AM4 writer end to end (the same path the
 * agent hits), not the writer in isolation.
 *
 * WHY: a v0.1.0 user's save acked but stored what they believe was the wrong
 * preset, and nobody — not even the agent — could confirm what landed, because
 * save_preset returned only "saved to X". P3 adds two deterministic features:
 *
 *  1. RECEIPT (always): after the save acks, the writer reads back the
 *     persisted working buffer with TARGETED deterministic reads (block-slot
 *     reads + amp/drive type-param reads + preset-name read — never the
 *     non-deterministic fn-0x1F bulk dump) and returns saved_snapshot
 *     { block_chain, amp_model, drive_model, preset_name } in the WriteResult.
 *
 *  2. OVERWRITE GATE (confirmable): before persisting, the writer reads the
 *     TARGET location's name + the active-location index and refuses (with the
 *     occupying name surfaced) ONLY when the target is occupied AND is not the
 *     currently-active location AND confirm_overwrite was not passed. Saving to
 *     the active location, or to an empty location, proceeds silently.
 *
 * Mock fixture (default 'clean-scratch'):
 *   - active location index = 103 (Z04).
 *   - A..X banks (indices 0..79) report a fabricated "Factory NNN" name
 *     (occupied); Y/Z banks (80..103) report empty.
 *   - amp.type / drive.type reads return wire 0 → AMP_TYPES[0] / DRIVE_TYPES[0]
 *     (so the receipt shows a real model name, not an out-of-range index).
 *   - default placement: amp / chorus / reverb / delay (NO drive placed), so
 *     drive_model is correctly omitted from the receipt.
 *
 * Run: `npm run build && npx tsx scripts/verify-am4-save-receipt.ts`
 * Status: offline, no hardware required.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AMP_TYPES } from 'fractal-midi/am4';

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

interface SavedSnapshot {
  block_chain?: unknown;
  amp_model?: unknown;
  drive_model?: unknown;
  preset_name?: unknown;
}

function extractText(r: unknown): string {
  const x = r as CallResult;
  return (x?.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
}
function extractStructured(r: unknown): Record<string, unknown> {
  return ((r as CallResult)?.structuredContent ?? {}) as Record<string, unknown>;
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}

// The unambiguous overwrite-refusal marker.
const OVERWRITE_REFUSAL = /REFUSING TO OVERWRITE/i;

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
    { name: 'verify-am4-save-receipt', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  const savePreset = (location: string, confirm_overwrite?: boolean) =>
    client.callTool({
      name: 'save_preset',
      arguments: {
        port: 'am4',
        location,
        ...(confirm_overwrite !== undefined ? { confirm_overwrite } : {}),
      },
    });

  try {
    await client.connect(transport);

    // ── Case 1: RECEIPT shape after a save to the active location (Z04). ──
    // Z04 == active (index 103), so the gate is silent; the receipt reads
    // back via targeted deterministic reads. Default placement has an amp but
    // NO drive, so amp_model is present and drive_model is absent.
    {
      const r = await savePreset('Z04');
      const text = extractText(r);
      const sc = extractStructured(r);
      const snap = (sc.saved_snapshot ?? {}) as SavedSnapshot;
      const chain = snap.block_chain;
      const chainOk =
        Array.isArray(chain)
        && chain.length === 4
        && JSON.stringify(chain) === JSON.stringify(['amp', 'chorus', 'reverb', 'delay']);
      const ampOk = snap.amp_model === AMP_TYPES[0] && typeof snap.amp_model === 'string';
      const driveAbsent = snap.drive_model === undefined;
      const infoOk = typeof sc.info === 'string' && /Saved chain:/i.test(sc.info as string);
      record(
        'RECEIPT: save returns saved_snapshot { block_chain, amp_model } via targeted reads; drive omitted (not placed)',
        !isError(r)
          && sc.acked === true
          && chainOk
          && ampOk
          && driveAbsent
          && infoOk,
        [
          `acked=${sc.acked}`,
          `block_chain=${JSON.stringify(chain)}`,
          `amp_model=${String(snap.amp_model)} (expected "${AMP_TYPES[0]}")`,
          `drive_model present=${!driveAbsent}`,
          `info: ${String(sc.info ?? '').slice(0, 120)}`,
          `text: ${text.slice(0, 80)}`,
        ],
      );
    }

    // ── Case 2: GATE FIRES on an occupied, non-active target. ────────────
    // A01 (index 0) reports "Factory 001" (occupied) and != active (Z04).
    {
      const r = await savePreset('A01');
      const text = extractText(r);
      const sc = extractStructured(r);
      record(
        'GATE: save to occupied non-active A01 (no confirm) REFUSES with the occupying name',
        !isError(r)
          && OVERWRITE_REFUSAL.test(text)
          && /Factory 001/.test(text)
          && sc.acked === false,
        [`acked=${sc.acked}`, `text: ${text.slice(0, 180)}`],
      );
    }

    // ── Case 3: GATE SILENT on save-to-active (refresh). ─────────────────
    // Z04 == active; nothing to clobber from the user's POV.
    {
      const r = await savePreset('Z04');
      const text = extractText(r);
      const sc = extractStructured(r);
      record(
        'GATE: save to the ACTIVE location (Z04) proceeds silently (refresh, no refusal)',
        !isError(r)
          && !OVERWRITE_REFUSAL.test(text)
          && sc.acked === true
          && (sc.saved_snapshot ?? undefined) !== undefined,
        [`acked=${sc.acked}`, `saved_snapshot present=${(sc.saved_snapshot ?? undefined) !== undefined}`],
      );
    }

    // ── Case 4: GATE SILENT on an empty, non-active target. ──────────────
    // Z03 (index 102) is empty and != active; the empty-target branch proceeds.
    {
      const r = await savePreset('Z03');
      const text = extractText(r);
      const sc = extractStructured(r);
      record(
        'GATE: save to an EMPTY non-active location (Z03) proceeds silently (no refusal)',
        !isError(r)
          && !OVERWRITE_REFUSAL.test(text)
          && sc.acked === true,
        [`acked=${sc.acked}`, `text: ${text.slice(0, 120)}`],
      );
    }

    // ── Case 5: confirm_overwrite:true OVERRIDES the gate (batch-ready). ──
    // A01 occupied + != active, but the single boolean clears the gate.
    {
      const r = await savePreset('A01', true);
      const text = extractText(r);
      const sc = extractStructured(r);
      record(
        'GATE: confirm_overwrite:true clears the gate on occupied non-active A01 (single boolean, batch-ready)',
        !isError(r)
          && !OVERWRITE_REFUSAL.test(text)
          && sc.acked === true
          && (sc.saved_snapshot ?? undefined) !== undefined,
        [`acked=${sc.acked}`, `saved_snapshot present=${(sc.saved_snapshot ?? undefined) !== undefined}`],
      );
    }
  } finally {
    await client.close();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'am4 save receipt + overwrite gate: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
