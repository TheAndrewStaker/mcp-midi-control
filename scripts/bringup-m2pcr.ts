/**
 * M>PCR bring-up: MicroFreak MIDI Out -> VE-500 MIDI In pitch correction.
 *
 * Standalone (runs from SOURCE via tsx, no dist build). Three phases, chosen by
 * argv[2]:
 *
 *   ports  - enumerate every MIDI port, flag the MicroFreak + VE-500 matches.
 *   read   - SAFETY READ. Reads (never writes) the five bring-up params plus a
 *            few diagnostics. This is the rollback record; two of the five are
 *            GLOBAL system settings on the VE-500 so their pre-value matters.
 *   write  - apply the five values, then read every one of them back.
 *
 * Nothing here saves a patch: the VE-500 SYSTEM region persists on its own, and
 * the per-patch copies live in the active edit buffer. A STORE (which would need
 * the editor comm-mode handshake first) is deliberately NOT issued.
 */
import { listMidiPorts, connect } from '../packages/core/src/midi/transport.js';
import {
  buildGlobalRead,
  buildGlobalWrite,
  globalReplyMatcher,
  decodeGlobalReply,
} from '../packages/arturia/src/codec/sysex.js';
import {
  findParam,
  buildSetParam,
  buildGetParam,
  paramReplyMatcher,
  decodeParamReply,
} from '../packages/roland-midi/src/ve-500/index.js';

const mode = (process.argv[2] ?? 'ports') as 'ports' | 'read' | 'write';

const MF_NEEDLES = ['microfreak', 'arturia'];
const VE_NEEDLES = ['ve-500', 've500'];

const hex = (a: readonly number[]) =>
  a.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// ── ports ────────────────────────────────────────────────────────────────────
function ports(): void {
  const { inputs, outputs } = listMidiPorts();
  const tag = (name: string) => {
    const n = name.toLowerCase();
    if (MF_NEEDLES.some((x) => n.includes(x))) return '  <- MicroFreak';
    if (VE_NEEDLES.some((x) => n.includes(x))) return '  <- VE-500';
    return '';
  };
  console.log('INPUTS');
  inputs.forEach((p, i) => console.log(`  [${i}] ${p.name}${tag(p.name)}`));
  console.log('OUTPUTS');
  outputs.forEach((p, i) => console.log(`  [${i}] ${p.name}${tag(p.name)}`));
}

// ── MicroFreak globals ───────────────────────────────────────────────────────
const MF_MIDI_THRU = 0x3b;
let mfSeq = 0;

async function mfRead(conn: ReturnType<typeof connect>, param: number): Promise<number | undefined> {
  const s = mfSeq; mfSeq = (mfSeq + 1) & 0x7f;
  const waiter = conn.receiveSysExMatching(globalReplyMatcher(param), 600).catch(() => undefined);
  conn.send(buildGlobalRead(s, param));
  const reply = await waiter;
  return reply === undefined ? undefined : decodeGlobalReply(reply);
}

function mfWrite(conn: ReturnType<typeof connect>, param: number, value: number): number[] {
  const s = mfSeq; mfSeq = (mfSeq + 1) & 0x7f;
  const frame = buildGlobalWrite(s, param, value);
  conn.send(frame);
  return frame;
}

// ── VE-500 params ────────────────────────────────────────────────────────────
async function veRead(
  conn: ReturnType<typeof connect>,
  block: string,
  name: string,
): Promise<{ wire?: number; display?: string; err?: string }> {
  const def = findParam(block, name);
  if (!def) return { err: `UNRESOLVED param '${block}.${name}'` };
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def), 600).catch(() => undefined);
  conn.send(buildGetParam(def));
  const reply = await waiter;
  if (reply === undefined) return { err: 'no DT1 reply within 600ms' };
  const v = decodeParamReply(def, reply);
  if (typeof v !== 'number') return { err: 'malformed DT1 reply' };
  const label = def.enum_values?.[v];
  return { wire: v, display: label ?? String(v) };
}

function veWrite(
  conn: ReturnType<typeof connect>,
  block: string,
  name: string,
  value: number,
): { frame?: number[]; err?: string } {
  const def = findParam(block, name);
  if (!def) return { err: `UNRESOLVED param '${block}.${name}'` };
  if (value < def.min || value > def.max) {
    return { err: `value ${value} out of range [${def.min}..${def.max}]` };
  }
  const frame = buildSetParam(def, value);
  conn.send(frame);
  return { frame };
}

/** The bring-up set + read-only diagnostics that explain whether it can work. */
const VE_TARGETS: Array<{ block: string; name: string; value?: number; why: string }> = [
  { block: 'pitch_correct', name: 'switch', value: 1, why: 'PITCH CORRECT block ON (per-patch)' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr', value: 2, why: 'M>PCR = Ch.3 (per-patch copy)' },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr', value: 2, why: 'M>PCR = Ch.3 (SYSTEM copy, kept coherent so flipping the preference back still routes)' },
  // 0 = PATCH. NOT a guess: the editor's temp.js branches on the SAME selector
  // two ways — `GetValue('pref-key') === 'PATCH'` (line 125) and
  // `$('#pref-key-0').is(':checked')` (line 797) — and both take the *patch*
  // control, pinning radio index 0 to PATCH. item.json's pref-midi2pcr init "1"
  // matches the catalog's init 1, i.e. SYSTEM.
  //
  // Why PATCH and not SYSTEM: on THIS unit the SYSTEM zone is narrowed to
  // 27..43 while the PATCH zone is the full 0..103 the bring-up spec settled on.
  // Routing through SYSTEM would silently drop every note outside a 17-semitone
  // window, or force clobbering a global the maintainer deliberately narrowed.
  { block: 'system_pref', name: 'preference_m2pcr', value: 0, why: 'point M>PCR at the PATCH copy (0 = PATCH)' },
  { block: 'system_midi', name: 'midi_program_change_in', value: 0, why: 'PC IN OFF so a stray Program Change cannot recall another patch' },
];

const VE_DIAGNOSTIC: Array<{ block: string; name: string; why: string }> = [
  { block: 'system_key', name: 'key_recognition_source', why: 'the editor hides M>PCR entirely when this is INST' },
  { block: 'key', name: 'key_recognition_source', why: 'per-patch equivalent of the above' },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr_zone_lower', why: 'zone floor' },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr_zone_uppder', why: 'zone ceiling' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr_zone_lower', why: 'zone floor (patch)' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr_zone_uppder', why: 'zone ceiling (patch)' },
  { block: 'system_midi', name: 'midi_rx_channel', why: 'global RX channel (vocoder + PC follow this)' },
  { block: 'pitch_correct', name: 'shift', why: 'the fallback the VE-500 uses when no MIDI note is held' },
  { block: 'pitch_correct', name: 'scale', why: 'CHROMATIC vs KEY' },
];

async function main(): Promise<void> {
  if (mode === 'ports') { ports(); return; }

  const mf = connect({ needles: MF_NEEDLES, notFoundLeadIn: 'MicroFreak not found.' });
  const ve = connect({ needles: VE_NEEDLES, notFoundLeadIn: 'VE-500 not found.' });

  const doWrite = mode === 'write';

  // ── phase 1: read everything, always (safety read precedes any write) ──────
  console.log(`\n=== ${doWrite ? 'PRE-WRITE ' : ''}SAFETY READ ===`);
  const mfThruPre = await mfRead(mf, MF_MIDI_THRU);
  console.log(
    `MicroFreak system.midi_thru (0x3b): ${mfThruPre === undefined ? 'NO REPLY' : `${mfThruPre} (${mfThruPre ? 'On' : 'Off'})`}`,
  );

  const pre: Record<string, string> = {};
  for (const t of [...VE_TARGETS, ...VE_DIAGNOSTIC]) {
    const key = `${t.block}.${t.name}`;
    const r = await veRead(ve, t.block, t.name);
    pre[key] = r.err ?? `${r.wire} (${r.display})`;
    console.log(`VE-500 ${key.padEnd(46)} = ${pre[key]}`);
  }

  if (!doWrite) { mf.close(); ve.close(); return; }

  // ── phase 2: write ────────────────────────────────────────────────────────
  console.log('\n=== WRITE ===');
  const thruFrame = mfWrite(mf, MF_MIDI_THRU, 1);
  console.log(`MicroFreak system.midi_thru = 1 (On)   frame: ${hex(thruFrame)}`);

  for (const t of VE_TARGETS) {
    const r = veWrite(ve, t.block, t.name, t.value!);
    console.log(
      r.err
        ? `REFUSED ${t.block}.${t.name}: ${r.err}`
        : `VE-500 ${`${t.block}.${t.name}`.padEnd(46)} = ${t.value}   frame: ${hex(r.frame!)}`,
    );
  }

  // ── phase 3: read back ────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 250));
  console.log('\n=== READ BACK ===');
  const mfThruPost = await mfRead(mf, MF_MIDI_THRU);
  console.log(
    `MicroFreak system.midi_thru: pre=${mfThruPre} post=${mfThruPost}  ${mfThruPost === 1 ? 'CONFIRMED' : 'NOT CONFIRMED'}`,
  );
  for (const t of VE_TARGETS) {
    const key = `${t.block}.${t.name}`;
    const r = await veRead(ve, t.block, t.name);
    const ok = r.wire === t.value;
    console.log(
      `VE-500 ${key.padEnd(46)} pre=${pre[key]} post=${r.err ?? `${r.wire} (${r.display})`}  ${ok ? 'CONFIRMED' : 'NOT CONFIRMED'}`,
    );
  }

  mf.close();
  ve.close();
}

await main();
process.exit(0);
