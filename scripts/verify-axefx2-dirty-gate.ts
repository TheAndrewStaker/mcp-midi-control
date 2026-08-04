/**
 * Offline regression for the Axe-Fx II navigation dirty gate.
 *
 * II's dirty signal is the deterministic in-memory markDirty/isDirty tracker
 * (core/server-shared/bufferDirty.ts): markDirty fires on outbound edit-class
 * SysEx (and the device's 0x74 state broadcast), markClean on the switch /
 * store envelope. The dispatcher's executeSwitchPreset consults
 * guardActiveBufferOrSave -> isDirty('axe-fx-ii').
 *
 * This drives the SHIPPED server with MCP_MOCK_TRANSPORT=1 and the REAL tool
 * surface + dispatcher gating — the agent's "make an edit, then navigate"
 * behavior, no manual front-panel action. Mirrors verify-am4-dirty-gate.ts so
 * the cross-device safe-edit contract is tested the same way on both Fractal
 * devices.
 *
 * Cases (sequenced; the in-server flag persists across calls):
 *   1. Fresh/clean buffer  → switch_preset proceeds.
 *   2. set_param (acked)   → switch_preset(warn) REFUSES.
 *   3. …still dirty        → switch_preset(discard) proceeds.
 *   4. set_param → save    → switch_preset(warn) PROCEEDS (markClean on store).
 *
 * Run: `npm run build && npx tsx scripts/verify-axefx2-dirty-gate.ts`
 * Status: offline, no hardware required.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
function extractText(r: unknown): string {
  const x = r as CallResult;
  return (x?.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!).join('\n');
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}
// The unambiguous refusal marker — NOT "unsaved working-buffer edits", which
// also appears in the benign switch-success info ("Any unsaved … discarded").
const REFUSAL = /REFUSING TO NAVIGATE/i;

let failures = 0;
function record(name: string, pass: boolean, notes: string[]): void {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

async function main(): Promise<void> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), MCP_MOCK_TRANSPORT: '1' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: 'pipe' });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client({ name: 'verify-axefx2-dirty-gate', version: '1.0.0' }, { capabilities: {} });

  const setParam = (value: number) =>
    client.callTool({ name: 'set_param', arguments: { port: 'axe-fx-ii', block: 'amp', name: 'gain', value } });
  const switchPreset = (location: number, mode?: 'warn' | 'discard' | 'save_active_first') =>
    client.callTool({ name: 'switch_preset', arguments: { port: 'axe-fx-ii', location, ...(mode ? { on_active_preset_edited: mode } : {}) } });
  const savePreset = (location: number, confirm_overwrite?: boolean) =>
    client.callTool({
      name: 'save_preset',
      arguments: { port: 'axe-fx-ii', location, ...(confirm_overwrite ? { confirm_overwrite } : {}) },
    });

  try {
    await client.connect(transport);

    // 1. Clean buffer (fresh session) → switch proceeds.
    {
      const r = await switchPreset(2);
      record('clean buffer → switch_preset proceeds (no false refusal)', !isError(r) && !REFUSAL.test(extractText(r)),
        [`isError=${isError(r)}`, `text: ${extractText(r).slice(0, 120)}`]);
    }
    // 2. An acked edit dirties the buffer → next switch (warn) refuses.
    {
      const e = await setParam(5);
      const r = await switchPreset(3);
      record('set_param then switch_preset(warn) → REFUSES', REFUSAL.test(extractText(r)),
        [`set_param isError=${isError(e)}`, `switch isError=${isError(r)}`, `text: ${extractText(r).slice(0, 160)}`]);
    }
    // 3. Still dirty → discard proceeds (and the switch markClean's).
    {
      const r = await switchPreset(3, 'discard');
      record('switch_preset(discard) on a dirty buffer → proceeds', !isError(r) && !REFUSAL.test(extractText(r)),
        [`isError=${isError(r)}`, `text: ${extractText(r).slice(0, 120)}`]);
    }
    // 4. THE REGRESSION: edit → save_preset → the next navigation must NOT be
    //    refused (markClean fires on the store envelope).
    //
    //    `confirm_overwrite: true` added 2026-08-03, and the reason matters
    //    because the bare call now legitimately refuses. The II gained an
    //    overwrite gate: it can read which preset is ACTIVE but has no decoded
    //    read for what is stored at an arbitrary location, so saving to a
    //    NON-ACTIVE target refuses until the caller confirms. The mock reports
    //    active wire preset 0, so slot 5 is non-active and this save was
    //    refused, no store envelope went out, markClean never fired, and this
    //    case failed on the navigation. That is the new gate working, not a
    //    regression. This case is about markClean-on-store, so it confirms the
    //    overwrite and keeps testing what it was written to test. The gate
    //    itself is covered by case 5 below.
    {
      await setParam(6);
      const s = await savePreset(5, true);
      const r = await switchPreset(4);
      record('REGRESSION: set_param → save_preset → switch_preset(warn) PROCEEDS', !isError(r) && !REFUSAL.test(extractText(r)),
        [`save isError=${isError(s)}`, `switch isError=${isError(r)}`, `text: ${extractText(r).slice(0, 160)}`]);
    }
    // 5. THE OVERWRITE GATE. The II contradicted two absolute rules in
    //    CLAUDE.md ("never write to a preset location without reading it
    //    first"; "before overwriting a non-empty location, surface what's
    //    there and ask") on a `verified`-tier device: the store landed
    //    acked:true and a caution rode the RECEIPT. A warning after a flash
    //    write is not a gate. The AM4 refuses the identical call.
    //
    //    Three branches, because the interesting property is not "it refuses"
    //    but "it refuses the right call and lets the common one through".
    {
      const bare = await savePreset(9);
      const t = extractText(bare);
      record('save_preset to a NON-ACTIVE location without confirm_overwrite REFUSES',
        /REFUSING TO SAVE/i.test(t) && /no decoded way to read what is stored there/i.test(t),
        [`text: ${t.slice(0, 200)}`]);
      // The refusal must not imply a check happened and found the slot free.
      record('the refusal says nothing was sent and does not claim the target was checked',
        /Nothing was sent/i.test(t) && !/appears (free|empty)/i.test(t),
        [`text: ${t.slice(0, 200)}`]);
    }
    {
      // Saving back to the location being edited is a refresh, not a clobber,
      // and is the common case. It must stay friction-free. The mock's active
      // preset is wire 0 = display slot 1.
      const active = await savePreset(1);
      record('save_preset to the ACTIVE location proceeds with no confirmation',
        !isError(active) && !/REFUSING TO SAVE/i.test(extractText(active)),
        [`text: ${extractText(active).slice(0, 160)}`]);
    }
    {
      const confirmed = await savePreset(9, true);
      record('save_preset to a non-active location WITH confirm_overwrite proceeds',
        !isError(confirmed) && !/REFUSING TO SAVE/i.test(extractText(confirmed)),
        [`text: ${extractText(confirmed).slice(0, 160)}`]);
    }
    // 6. THE SCAN GATE. `scan_locations` on this device reads each name by
    //    SWITCHING to that preset, ~64 times for a full bank, and restores only
    //    the preset NUMBER afterwards, which reloads from flash. So it destroys
    //    unsaved edits exactly as switch_preset would, and until 2026-08-04 it
    //    consulted no guard at all.
    //
    //    This is not hypothetical. A real Claude Desktop session on 2026-08-03
    //    ran three scans on the II (widest 16.3 s), then carefully warned the
    //    user that its NEXT call would discard their edits, having already
    //    discarded them three calls earlier in silence. The gate fired on the
    //    small navigation and not the large one.
    {
      await setParam(4);
      const r = await client.callTool({ name: 'scan_locations', arguments: { port: 'axe-fx-ii', from: 1, to: 4 } });
      const t = extractText(r);
      record('scan_locations on a DIRTY buffer REFUSES (it navigates per slot)',
        isError(r) && /discard those edits|unsaved/i.test(t),
        [`isError=${isError(r)}`, `text: ${t.slice(0, 200)}`]);
      record('the refusal explains the restore does not bring edits back',
        /reloads from flash|restores afterwards reloads|flash rather than/i.test(t),
        [`text: ${t.slice(0, 240)}`]);
    }
    {
      // ...and 'discard' lets it through, so the gate is an override, not a wall.
      const r = await client.callTool({ name: 'scan_locations', arguments: { port: 'axe-fx-ii', from: 1, to: 4, on_active_preset_edited: 'discard' } });
      record("scan_locations with on_active_preset_edited:'discard' PROCEEDS",
        !isError(r) && !/REFUS/i.test(extractText(r)),
        [`isError=${isError(r)}`, `text: ${extractText(r).slice(0, 160)}`]);
    }
    {
      // The AM4 reads a stored name without moving, so it must NOT gain this
      // friction. A gate that fires on the non-navigating device is measuring
      // the wrong thing.
      const r = await client.callTool({ name: 'scan_locations', arguments: { port: 'am4', from: 'A1', to: 'A2' } });
      record('AM4 scan_locations is NOT gated (it reads names without navigating)',
        !/discard those edits/i.test(extractText(r)),
        [`text: ${extractText(r).slice(0, 160)}`]);
    }
  } finally {
    await client.close();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'axe-fx-ii dirty gate: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(99); });
