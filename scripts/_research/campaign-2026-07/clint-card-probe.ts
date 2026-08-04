/**
 * Clint Eastwood OLD-build card probe (plan-time, READ-ONLY, disk only).
 * Decodes Pack 5 slots 27-34 from samples/circuit-ncs/card-backup-2026-07-29/
 * for the 2026-07-30 re-author plan. No device contact. Re-runnable.
 *
 * Answers:
 *  1. Header facts per slot: name, colour, tempo, swing, scale root/type,
 *     synth levels, drum levels, drum binding, chain tables, scene end.
 *  2. Which tracks hold content; per-track pattern cell census (global letters).
 *  3. The midi1 pad (the OLD harmonic layer, dropped by the new mapping):
 *     per-pattern chord decode -> verify the crash-rule (Emaj vs Ebm stabs).
 *  4. midi2 drum lane: note range, crash (61) presence per pattern, tom (?)
 *     from the timbale fold, velocity census.
 *  5. Internal drums: any content? (old build was dual-external, check.)
 *  6. Synth patch bodies vs blank template.
 *
 * Run: npx tsx samples/_scratch/clint-card-probe.ts
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  getProjectName, getProjectColour, getProjectTempo, getProjectSwing,
  getSynthLevel, getDrumLevel, META_OFFSETS, noteBlockIndex, drumBlockIndex,
  NOTE_TRACKS, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { getProjectScale } from '../../packages/circuit-tracks/src/ncs/scale.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { getNoteChain } from '../../packages/circuit-tracks/src/ncs/chain.js';

const DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const BLANK = readFileSync('C:/dev/mcp-midi-tools/samples/circuit-tracks/blank_slot20.ncs');
const FILES: Array<[number, string]> = [
  [27, 'proj27__26_SESSION.ncs'], [28, 'proj28__27_SESSION.ncs'],
  [29, 'proj29__28_SESSION.ncs'], [30, 'proj30__29_SESSION.ncs'],
  [31, 'proj31__30_SESSION.ncs'], [32, 'proj32__31_SESSION.ncs'],
  [33, 'proj33__32_SESSION.ncs'], [34, 'proj34__33_SESSION.ncs'],
];

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (n: number): string => `${NAMES[n % 12].toLowerCase()}${Math.floor(n / 12) - 2}`;

// global cell-letter registries per track
const registries = new Map<string, Map<string, string>>();
const letterFor = (track: string, sig: string): string => {
  if (sig === '') return '.';
  let reg = registries.get(track);
  if (!reg) { reg = new Map(); registries.set(track, reg); }
  let l = reg.get(sig);
  if (!l) { l = String.fromCharCode(65 + reg.size); reg.set(sig, l); }
  return l;
};

for (const [slot, file] of FILES) {
  const buf = readFileSync(`${DIR}/${file}`);
  const scale = getProjectScale(buf);
  console.log(`\n===== SLOT ${slot}  "${getProjectName(buf)}" =====`);
  console.log(`colour=${getProjectColour(buf)} tempo=${getProjectTempo(buf)} swing=${getProjectSwing(buf)} ` +
    `scale=${scale.rootName} ${scale.name} (root=${scale.root} type=${scale.type})`);
  console.log(`synthLevels=${getSynthLevel(buf, 1)}/${getSynthLevel(buf, 2)} ` +
    `drumLevels=[${[0, 1, 2, 3].map((t) => getDrumLevel(buf, t)).join(',')}] binding=[${getDrumSampleBinding(buf).join(',')}]`);
  // chains
  const chains: string[] = [];
  for (const t of NOTE_TRACKS) {
    const c = getNoteChain(buf, t as NoteTrack);
    chains.push(`${t}=${c ? `[${c.start},${c.end}]` : 'none'}`);
  }
  console.log(`chains: ${chains.join(' ')}  raw@0x2c4: ${Buffer.from(buf.subarray(0x2c4, 0x2e4)).toString('hex')}`);
  console.log(`sceneTable@0x2e4..0x30b: ${Buffer.from(buf.subarray(0x2e4, 0x30c)).toString('hex')}`);
  // patch bodies vs blank
  const s1same = Buffer.from(buf.subarray(0x26d14, 0x26d14 + 340)).equals(Buffer.from(BLANK.subarray(0x26d14, 0x26d14 + 340)));
  const s2same = Buffer.from(buf.subarray(0x26e68, 0x26e68 + 340)).equals(Buffer.from(BLANK.subarray(0x26e68, 0x26e68 + 340)));
  console.log(`patch bodies == blank template: synth1=${s1same} synth2=${s2same}`);

  // note tracks census
  for (const t of NOTE_TRACKS) {
    const track = t as NoteTrack;
    const cells: string[] = [];
    const lens: number[] = [];
    let notes = 0; let lo = 128; let hi = -1;
    const pitchSets = new Set<string>();
    for (let p = 0; p < 8; p++) {
      const steps = decodeNotePattern(buf, track, p);
      lens.push(buf[META_OFFSETS[noteBlockIndex(track, p)]] + 1);
      const toks: string[] = [];
      steps.forEach((st, si) => {
        for (const slotN of st.notes) {
          notes++;
          lo = Math.min(lo, slotN.note); hi = Math.max(hi, slotN.note);
          toks.push(`${si}:${slotN.note}:${slotN.gate}${slotN.tie ? 'T' : ''}:${slotN.velocity}`);
        }
      });
      const sig = toks.sort().join(',');
      cells.push(letterFor(t, sig));
      if (sig !== '') {
        const pcs = [...new Set(toks.map((x) => Number(x.split(':')[1]) % 12))].sort((a, b) => a - b);
        pitchSets.add(`p${p + 1}:{${pcs.map((pc) => NAMES[pc]).join(',')}}`);
      }
    }
    if (notes > 0) {
      console.log(`${t}: ${notes} notes range ${pitchName(lo)}..${pitchName(hi)} (${lo}..${hi}) cells=${cells.join(' ')} lens=[${lens.join(',')}]`);
      if (t === 'midi1' || t === 'synth1' || t === 'synth2') console.log(`  pc-sets: ${[...pitchSets].join('  ')}`);
    } else {
      console.log(`${t}: EMPTY  lens=[${lens.join(',')}]`);
    }
  }
  // midi1 pad chord detail (crash-rule layer) + midi2 crash presence per pattern
  for (let p = 0; p < 8; p++) {
    const padSteps = decodeNotePattern(buf, 'midi1', p);
    const chords: string[] = [];
    padSteps.forEach((st, si) => {
      const ns = st.notes.map((s) => s.note);
      if (ns.length > 0) chords.push(`st${si + 1}[${ns.map(pitchName).join('+')}]v${st.notes[0].velocity}g${st.notes[0].gate}${st.notes[0].tie ? 'T' : ''}`);
    });
    const m2 = decodeNotePattern(buf, 'midi2', p);
    const m2notes = m2.flatMap((st) => st.notes.map((s) => s.note));
    const crash = m2notes.includes(61);
    if (chords.length > 0 || m2notes.length > 0) {
      console.log(`  pat${p + 1}: pad=${chords.join(' ') || '(none)'}  midi2 ${m2notes.length} hits crash61=${crash ? 'YES' : 'no'} notes={${[...new Set(m2notes)].sort((a, b) => a - b).join(',')}}`);
    }
  }
  // internal drums
  const drumCells: string[] = [];
  let drumHits = 0;
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < 8; p++) {
      const steps = decodeDrumPattern(buf, t, p);
      const hits = steps.filter((s) => s.on);
      drumHits += hits.length;
      const sig = hits.map((h) => `${h.step}:${h.velocity}`).join(',');
      drumCells.push(sig === '' ? '.' : letterFor(`drum${t + 1}`, sig));
    }
  }
  console.log(`internal drums: ${drumHits} hits total; cells d1..d4: ${drumCells.join(' ')}`);
  console.log(`sha256 ${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
}

// distinct-cell summary
console.log('\n===== GLOBAL DISTINCT CELLS PER TRACK (across all 8 slots) =====');
for (const [track, reg] of registries) console.log(`${track}: ${reg.size} distinct non-empty cells`);
