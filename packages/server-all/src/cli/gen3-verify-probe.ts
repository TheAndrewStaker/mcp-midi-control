#!/usr/bin/env node
/**
 * Gen-3 Fractal WRITE-VERIFY probe (CLI), a tester-runnable round-trip
 * diagnostic for the FM9, FM3, and Axe-Fx III.
 *
 * The read-only `gen3-readback-probe` confirms we can READ the device. This
 * probe confirms the device ACCEPTS AND APPLIES OUR WRITES: it sends each
 * shipped write op against the loaded preset, then reads the result back. The
 * headline result is whether set_param works for continuous knobs (it tests
 * both the typed and the editor float forms).
 *
 * SAFE: it NEVER saves; it establishes a restore point first (reads the active
 * preset number) and reloads that preset at the end (and on Ctrl-C / errors),
 * which discards every working-buffer change, so your device ends exactly where
 * it started. It does discard any UNSAVED edits you had open before running, so
 * store or abandon those first. Quit the editor first so it is not holding the
 * MIDI port. Core logic + the full safety contract live in
 * `gen3-verify-probe-core.ts`.
 *
 * Usage:
 *   node dist/cli/gen3-verify-probe.js <fm9|fm3|axe-fx-iii> [output.json]
 *
 * Exit codes: 0 = ran and wrote the report; 1 = bad device / no port found.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  connectFM9,
  connectFM3,
  connectAxeFxIII,
  type MidiConnection,
} from '@mcp-midi-control/fractal-gen3/midi.js';
import { buildSwitchPresetSysEx, PARAMS_BY_FAMILY } from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';
import { runVerifyProbe, type VerifyProbeReverbIds } from './gen3-verify-probe-core.js';

/**
 * Resolve the device-true reverb Mix/Type paramIds from the device's own
 * catalog. paramIds are DEVICE-SPECIFIC across the gen-3 family (FM9: mix=0,
 * type=10; III + FM3: type=0, mix=13) — hardcoded FM9-shaped ids mis-addressed
 * the 2026-06-12 FM3 field test (the "mix" test set reverb TYPE; the "type"
 * test set REVERB_LOWCUT).
 */
function reverbIdsFrom(
  byFamily: Readonly<Record<string, readonly { name: string; paramId: number }[]>>,
): VerifyProbeReverbIds {
  const reverb = byFamily['REVERB'] ?? [];
  const idOf = (name: string): number => {
    const p = reverb.find((x) => x.name === name);
    if (!p) throw new Error(`device catalog has no REVERB.${name} — cannot run the reverb write tests`);
    return p.paramId;
  };
  return { mixParamId: idOf('REVERB_MIX'), typeParamId: idOf('REVERB_TYPE') };
}

interface DeviceSpec {
  label: string;
  modelByte: number;
  connect: () => MidiConnection;
  gridRows: number;
  reverbIds: VerifyProbeReverbIds;
}
const DEVICES: Record<string, DeviceSpec> = {
  fm9: { label: 'FM9', modelByte: 0x12, connect: connectFM9, gridRows: 6, reverbIds: reverbIdsFrom(FM9_PARAMS_BY_FAMILY) },
  fm3: { label: 'FM3', modelByte: 0x11, connect: connectFM3, gridRows: 4, reverbIds: reverbIdsFrom(FM3_PARAMS_BY_FAMILY) },
  'axe-fx-iii': { label: 'Axe-Fx III', modelByte: 0x10, connect: connectAxeFxIII, gridRows: 6, reverbIds: reverbIdsFrom(PARAMS_BY_FAMILY) },
};

const deviceKey = (process.argv[2] ?? '').toLowerCase();
const device = DEVICES[deviceKey];
if (!device) {
  console.error('Usage: gen3-verify-probe <fm9|fm3|axe-fx-iii> [output.json]');
  console.error(`Unknown device "${process.argv[2] ?? '(none)'}".`);
  process.exit(1);
}
const outArg = process.argv[3] ?? `${deviceKey}-verify-output.json`;
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);

console.error(`${device.label} WRITE-VERIFY probe`);
console.error('Safe: never saves; reloads your preset at the end to discard all changes.');
console.error('Note: this DISCARDS any unsaved working-buffer edits you had open. Store them first.');

let conn: MidiConnection;
try {
  conn = device.connect();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!conn.hasInput) {
  console.error(`\nFound a ${device.label} output port but no input port; the probe needs`);
  console.error('to read replies. Unplug/replug the USB cable and try again.');
  conn.close();
  process.exit(1);
}

// Once the probe reads the active preset number we keep it here so a Ctrl-C
// mid-run can still reload (discard the working buffer) before exiting.
let restorePreset: number | undefined;
process.on('SIGINT', () => {
  void (async () => {
    let restoreSent = false;
    try {
      // SysEx sub=0x27 switch: full 14-bit preset number (a bare PC truncates
      // presets >127 to mod 128 — FM3 fw 12.00 field test, 2026-06-12).
      if (restorePreset !== undefined) {
        conn.send(buildSwitchPresetSysEx(restorePreset, device.modelByte));
        restoreSent = true;
        // Let the transport actually flush the restore frame before tearing
        // the port down: on the FM3 the connection is USB-CDC serial, and a
        // close() + process.exit() immediately after send() races the OS
        // write buffer — the frame can die on the host without ever reaching
        // the device.
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch { /* ignore */ }
    try { conn.close(); } catch { /* ignore */ }
    console.error('\nInterrupted.' + (restoreSent
      ? ` Sent a reload of preset ${restorePreset} to discard working-buffer changes — confirm on the device.`
      : ' No writes had been made; nothing to undo.'));
    process.exit(130);
  })();
});

async function main(): Promise<void> {
  const report = await runVerifyProbe({
    conn,
    modelByte: device.modelByte,
    gridRows: device.gridRows,
    label: device.label,
    reverbIds: device.reverbIds,
    log: (line) => console.error(line),
    onRestorePoint: (n) => { restorePreset = n; },
  });
  fs.writeFileSync(outPath, JSON.stringify(report, undefined, 2));
  conn.close();
  console.error(`\n✓ Wrote ${outPath}`);
  console.error(`  ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`);
  console.error('\nPlease attach this JSON file to a new GitHub issue (see docs/contributing/SUBMITTING.md). Thank you!');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  try { conn?.close(); } catch { /* ignore */ }
  process.exit(1);
});
