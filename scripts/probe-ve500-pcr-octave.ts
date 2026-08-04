/**
 * VE-500 PITCH CORRECT / M>PCR read-only inspection.
 *
 * Answers "how is this unit actually configured for MIDI-to-Pitch-Correct, and
 * which note range will it accept?" It issues RQ1 reads ONLY (`buildGetParam`);
 * `buildSetParam` is deliberately not imported, so this script cannot alter the
 * maintainer's live vocal chain.
 *
 * Zone values are rendered as note names AND MIDI note numbers. The VE-500's
 * zone list runs C1..G9 over 104 steps (0..103); C1 is 32.7 Hz, i.e. MIDI 24,
 * so wire value N == MIDI note N + 24. That mapping is what tells you whether a
 * sequenced line sits inside the acceptance window.
 *
 * Run: npx tsx scripts/probe-ve500-pcr-octave.ts
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam,
  buildGetParam,
  paramReplyMatcher,
  decodeParamReply,
} from '../packages/roland-midi/src/ve-500/index.js';

const VE_NEEDLES = ['ve-500', 've500'];

/** Zone wire value -> MIDI note number. Wire 0 = C1 = MIDI 24, wire 103 = G9 = MIDI 127. */
const ZONE_WIRE_TO_MIDI = 24;
const PITCH_CLASS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Roland VE-500 note naming: C4 = middle C = MIDI 60 (matches C1 = 32.7 Hz). */
function noteName(midi: number): string {
  return `${PITCH_CLASS[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function zoneLabel(wire: number): string {
  const midi = wire + ZONE_WIRE_TO_MIDI;
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  return `${noteName(midi)} (MIDI ${midi}, ${hz.toFixed(1)} Hz)`;
}

type Row = { block: string; name: string; why: string; render?: (wire: number) => string };

const ROWS: Row[] = [
  { block: 'system_pref', name: 'preference_m2pcr', why: 'which copy of the M>PCR settings is LIVE (0=PATCH, 1=SYSTEM)' },
  { block: 'pitch_correct', name: 'switch', why: 'PITCH CORRECT block on/off' },
  { block: 'pitch_correct', name: 'type', why: 'SOFT / HARD / ELECTRIC / ROBOT' },
  { block: 'pitch_correct', name: 'scale', why: 'CHROMATIC (nearest semitone) vs KEY' },
  { block: 'pitch_correct', name: 'note', why: 'ROBOT target pitch. PITCH CLASS ONLY (C..B), no octave' },
  { block: 'pitch_correct', name: 'shift', why: 'interval fallback used when NO MIDI note is being received' },
  { block: 'pitch_correct', name: 'speed', why: 'how fast the correction chases' },
  { block: 'pitch_correct', name: 'stability', why: 'how hard it is to move off the corrected pitch' },
  { block: 'pitch_correct', name: 'formant', why: 'formant shift, tells you if the unit is voicing-compensating' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr', why: 'PATCH copy: 0..15=Ch.1..16, 16=RX, 17=OFF' },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr_zone_lower', why: 'PATCH copy: lowest note ACCEPTED', render: zoneLabel },
  { block: 'pitch_correct_midi', name: 'midi_to_pcr_zone_uppder', why: 'PATCH copy: highest note ACCEPTED', render: zoneLabel },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr', why: 'SYSTEM copy channel' },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr_zone_lower', why: 'SYSTEM copy: lowest note accepted', render: zoneLabel },
  { block: 'system_pitch_correct_midi', name: 'midi_to_pcr_zone_uppder', why: 'SYSTEM copy: highest note accepted', render: zoneLabel },
  { block: 'system_midi', name: 'midi_rx_channel', why: 'global RX channel (what "RX" resolves to)' },
  { block: 'system_key', name: 'key_recognition_source', why: 'M>PCR is disabled entirely when this is INST' },
  { block: 'key', name: 'key_recognition_source', why: 'per-patch equivalent' },
];

async function veRead(
  conn: ReturnType<typeof connect>,
  block: string,
  name: string,
): Promise<{ wire?: number; display?: string; err?: string }> {
  const def = findParam(block, name);
  if (!def) return { err: `UNRESOLVED param '${block}.${name}'` };
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(def), 600).catch(() => undefined);
  conn.send(buildGetParam(def)); // RQ1 read. No write path exists in this script.
  const reply = await waiter;
  if (reply === undefined) return { err: 'no DT1 reply within 600ms' };
  const v = decodeParamReply(def, reply);
  if (typeof v !== 'number') return { err: 'malformed DT1 reply' };
  return { wire: v, display: def.enum_values?.[v] };
}

const ve = connect({ needles: VE_NEEDLES, notFoundLeadIn: 'VE-500 not found.' });

console.log('\n=== VE-500 PITCH CORRECT / M>PCR (READ-ONLY) ===\n');
for (const row of ROWS) {
  const r = await veRead(ve, row.block, row.name);
  const key = `${row.block}.${row.name}`;
  let shown: string;
  if (r.err) shown = r.err;
  else if (row.render) shown = `${r.wire} = ${row.render(r.wire!)}`;
  else shown = r.display ? `${r.wire} (${r.display})` : String(r.wire);
  console.log(`${key.padEnd(48)} ${shown}`);
  console.log(`${''.padEnd(48)} ^ ${row.why}\n`);
}

ve.close();
process.exit(0);
