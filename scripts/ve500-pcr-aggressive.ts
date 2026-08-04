/**
 * VE-500 PITCH CORRECT aggressiveness bring-up (edit buffer ONLY, no STORE).
 *
 * Standalone (runs from SOURCE via tsx). Two phases, chosen by argv[2]:
 *
 *   read   - SAFETY READ. RQ1 only. The rollback record.
 *   write  - apply the target set, then read every one of them back.
 *
 * Nothing here stores: every write lands in the active edit buffer, so a patch
 * recall on the front panel undoes the lot. `buildSavePreset` / `buildCommMode`
 * are deliberately NOT imported, so this script cannot persist anything.
 *
 * Display conversions are taken from the editor's own control table
 * (js/product/assign.js): STABILITY disp = 'Range -10 to +10' (wire-10),
 * FORMANT disp = 'Range -50 to +50' (wire-50), SPEED disp = undefined (wire).
 * MIDI-to-PCR channel labels from js/config/resource.js:59.
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam,
  buildSetParam,
  buildGetParam,
  paramReplyMatcher,
  decodeParamReply,
} from '../packages/roland-midi/src/ve-500/index.js';
import type { Ve500ParamDef } from '../packages/roland-midi/src/ve-500/catalog.generated.js';
import { Size } from '../packages/roland-midi/src/shared/index.js';

const mode = (process.argv[2] ?? 'read') as 'read' | 'write';
const VE_NEEDLES = ['ve-500', 've500'];

const hex = (a: readonly number[]) =>
  a.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// ── display renderers ────────────────────────────────────────────────────────
const PITCH_CLASS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const ZONE_WIRE_TO_MIDI = 24; // wire 0 = C1 = MIDI 24
const zone = (w: number) =>
  `${PITCH_CLASS[(w + ZONE_WIRE_TO_MIDI) % 12]}${Math.floor((w + ZONE_WIRE_TO_MIDI) / 12) - 1} (MIDI ${w + ZONE_WIRE_TO_MIDI})`;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const chan = (w: number) => (w <= 15 ? `Ch.${w + 1}` : w === 16 ? 'RX' : 'OFF');
const onOff = (w: number) => (w ? 'ON' : 'OFF');
const patchLabel = (n: number) =>
  n <= 98 ? `U${String(n + 1).padStart(2, '0')}` : `P${String(n - 98).padStart(2, '0')}`;

type Row = {
  block: string;
  name: string;
  disp: (w: number) => string;
  /** target wire value; omitted rows are read-only diagnostics */
  target?: number;
  /** what the target reads as on the panel */
  targetDisp?: string;
  why: string;
};

const ROWS: Row[] = [
  // ── the patch-level fix: make PCR live on whatever patch is loaded now ─────
  { block: 'pitch_correct', name: 'switch', disp: onOff, target: 1, targetDisp: 'ON', why: 'PITCH CORRECT block ON (per-patch)' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr', disp: chan, target: 2, targetDisp: 'Ch.3', why: 'M>PCR listens on Ch.3 (per-patch copy)' },
  // ── the aggressiveness set ────────────────────────────────────────────────
  { block: 'pitch_correct', name: 'type', disp: (w) => ['SOFT', 'HARD', 'ELECTRIC', 'ROBOT'][w] ?? String(w), target: 2, targetDisp: 'ELECTRIC', why: 'stair-step pitch change' },
  { block: 'pitch_correct', name: 'speed', disp: String, target: 10, targetDisp: '10', why: 'fastest chase' },
  { block: 'pitch_correct', name: 'stability', disp: (w) => signed(w - 10), target: 15, targetDisp: '+5', why: 'holds a note, lurches to the next (direction UNVERIFIED)' },
  // ── left alone, reported for the record ───────────────────────────────────
  { block: 'pitch_correct', name: 'scale', disp: (w) => ['CHROMATIC', 'KEY'][w] ?? String(w), why: 'leave at CHROMATIC' },
  { block: 'pitch_correct', name: 'shift', disp: (w) => findParam('pitch_correct', 'shift')?.enum_values?.[w] ?? String(w), why: 'leave at 0 (no-note-held fallback)' },
  { block: 'pitch_correct', name: 'formant', disp: (w) => signed(w - 50), why: 'leave at 0 (+30 is test A, by hand)' },
  { block: 'pitch_correct', name: 'note', disp: (w) => PITCH_CLASS[w] ?? String(w), why: 'ROBOT-only target pitch class' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr_zone_lower', disp: zone, why: 'PATCH zone floor' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr_zone_uppder', disp: zone, why: 'PATCH zone ceiling' },
  { block: 'system_pref', name: 'preference_m2pcr', disp: (w) => ['PATCH', 'SYSTEM'][w] ?? String(w), why: 'which copy is LIVE' },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr', disp: chan, why: 'SYSTEM copy (not live while pref=PATCH)' },
  { block: 'system_key', name: 'key_recognition_source', disp: (w) => findParam('system_key', 'key_recognition_source')?.enum_values?.[w] ?? String(w), why: 'M>PCR vanishes when INST' },
  { block: 'key', name: 'key_recognition_source', disp: (w) => findParam('key', 'key_recognition_source')?.enum_values?.[w] ?? String(w), why: 'per-patch equivalent' },
  { block: 'system_midi', name: 'midi_rx_channel', disp: (w) => `Ch.${w + 1}`, why: 'global RX channel' },
  { block: 'system_midi', name: 'midi_program_change_in', disp: onOff, why: 'PC IN (deliberately OFF)' },
];

/** Synthesised def for the absolute "Current Patch Number" register (Setup > SetupCommon, addr 0). */
const CURRENT_PATCH_DEF: Ve500ParamDef = {
  block: 'setup_common', param: 'current_patch_number', display_name: 'Current Patch Number',
  section: 'SetupCommon', addr: 0x00000000, size: Size.INTEGER2x4, ofs: 0, min: 0, max: 148, init: 0,
  region: 'system', // region:'system' => base 0, i.e. the ABSOLUTE address the editor uses
} as Ve500ParamDef;

const PATCH_NAME_DEF = findParam('common', 'patch_name');

async function veRead(
  conn: ReturnType<typeof connect>,
  def: Ve500ParamDef,
): Promise<{ wire?: number | string; err?: string }> {
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def), 700).catch(() => undefined);
  conn.send(buildGetParam(def));
  const reply = await waiter;
  if (reply === undefined) return { err: 'no DT1 reply within 700ms' };
  const v = decodeParamReply(def, reply);
  if (v === undefined) return { err: 'malformed DT1 reply' };
  return { wire: v };
}

async function readRow(conn: ReturnType<typeof connect>, r: Row): Promise<string> {
  const def = findParam(r.block, r.name);
  if (!def) return `UNRESOLVED ${r.block}.${r.name}`;
  const got = await veRead(conn, def);
  if (got.err) return got.err;
  return `${r.disp(got.wire as number)}   [wire ${got.wire}]`;
}

async function main(): Promise<void> {
  const ve = connect({ needles: VE_NEEDLES, notFoundLeadIn: 'VE-500 not found.' });
  const doWrite = mode === 'write';

  console.log(`\n=== ${doWrite ? 'PRE-WRITE ' : ''}SAFETY READ (RQ1 only) ===`);

  const cp = await veRead(ve, CURRENT_PATCH_DEF);
  console.log(
    `LOADED PATCH${''.padEnd(38)} = ${cp.err ?? `${patchLabel(cp.wire as number)}   [index ${cp.wire}]`}`,
  );
  if (PATCH_NAME_DEF) {
    const nm = await veRead(ve, PATCH_NAME_DEF);
    console.log(`PATCH NAME${''.padEnd(40)} = ${nm.err ?? `"${nm.wire}"`}`);
  }
  console.log('');

  const pre: Record<string, string> = {};
  for (const r of ROWS) {
    const key = `${r.block}.${r.name}`;
    pre[key] = await readRow(ve, r);
    console.log(`${key.padEnd(50)} = ${pre[key]}`);
  }

  if (!doWrite) { ve.close(); return; }

  console.log('\n=== WRITE (edit buffer only, no STORE) ===');
  for (const r of ROWS) {
    if (r.target === undefined) continue;
    const def = findParam(r.block, r.name);
    if (!def) { console.log(`REFUSED ${r.block}.${r.name}: unresolved`); continue; }
    if (r.target < def.min || r.target > def.max) {
      console.log(`REFUSED ${r.block}.${r.name}: ${r.target} out of [${def.min}..${def.max}]`);
      continue;
    }
    const frame = buildSetParam(def, r.target);
    ve.send(frame);
    console.log(`${`${r.block}.${r.name}`.padEnd(50)} <- ${r.targetDisp} [wire ${r.target}]   ${hex(frame)}`);
    await new Promise((res) => setTimeout(res, 40));
  }

  await new Promise((res) => setTimeout(res, 300));
  console.log('\n=== READ BACK ===');
  let allOk = true;
  for (const r of ROWS) {
    const key = `${r.block}.${r.name}`;
    const def = findParam(r.block, r.name);
    if (!def) continue;
    const got = await veRead(ve, def);
    const actual = got.err ?? `${r.disp(got.wire as number)} [wire ${got.wire}]`;
    if (r.target === undefined) {
      console.log(`${key.padEnd(50)} unchanged: pre=${pre[key]} post=${actual}`);
      continue;
    }
    const ok = got.wire === r.target;
    if (!ok) allOk = false;
    console.log(
      `${key.padEnd(50)} intended=${r.targetDisp} actual=${actual}  ${ok ? 'CONFIRMED' : '*** NOT CONFIRMED ***'}`,
    );
  }
  console.log(`\n${allOk ? 'ALL TARGETS CONFIRMED' : 'ONE OR MORE TARGETS DID NOT LAND'}`);

  ve.close();
}

await main();
process.exit(0);
