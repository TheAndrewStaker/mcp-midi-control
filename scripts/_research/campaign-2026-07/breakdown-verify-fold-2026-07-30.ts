/** Probe 2: does the shipped whole_song decompose+coalesce path reproduce the card's fold? READ-ONLY. */
import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { decomposeToPatterns, coalescePatterns } from '../../packages/core/src/protocol-generic/patterns/songStructure.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { META_OFFSETS, noteBlockIndex, type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const drums = flattenSongsterrDrums(load(6));

const decomp = decomposeToPatterns(drums.events, { stepsPerPattern: 32, stepsPerBeat: 4, totalBeats: 77 * 4 });
console.log(`=== decompose (32-step / 2-bar windows) ===`);
console.log(`windows ${decomp.windowCount}, EXACT unique patterns ${decomp.uniquePatternCount}`);
console.log(`order: [${decomp.order.join(',')}]`);

for (const md of [0.05, 0.10, 0.15]) {
  const co = coalescePatterns(decomp, { maxDistance: md });
  console.log(`\n--- coalesce maxDistance ${md}: clusters ${co.clusters.length}`);
  console.log(`order: [${co.order.join(',')}]`);
  // which windows got folded into a medoid that is NOT themselves?
  let folded = 0;
  for (const c of co.clusters) for (const m of c.members) if (m !== c.medoid) folded++;
  console.log(`windows replaced by a medoid: ${folded}/${decomp.windowCount}`);
  // window 3 = bars 7-8 (crash bar); window 10 = bars 21-22; window 11 = bars 23-24
  for (const w of [3, 10, 11]) {
    const cl = co.clusters[co.order[w]];
    console.log(`  window ${w} (bars ${w * 2 + 1}-${w * 2 + 2}): cluster ${co.order[w]}, medoid=window ${cl.medoid}, members ${cl.members.length}, ${cl.medoid === w ? 'IS medoid' : 'REPLACED by bars ' + (cl.medoid * 2 + 1) + '-' + (cl.medoid * 2 + 2)}`);
  }
}

console.log('\n=== card structural signature: distinct 2-bar window images per slot ===');
const PROJECTS = [35, 36, 37, 38, 39];
for (const slot of PROJECTS) {
  const buf = readFileSync(`${ORACLE}/proj${slot}__${slot - 1}_SESSION.ncs`);
  const chainEnd = buf[0x2c4 + 3 * 4 + 1];
  const sigs: string[] = [];
  for (let p = 0; p <= chainEnd; p++) {
    const len = buf[META_OFFSETS[noteBlockIndex('midi2' as NoteTrack, p)]] + 1;
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2' as NoteTrack, p);
    const cells: string[] = [];
    for (let si = 0; si < len; si++) if (steps[si].active) for (const n of steps[si].notes) cells.push(`${si}|${n.note}|${n.delay}`);
    sigs.push(cells.sort().join(','));
  }
  console.log(`slot ${slot}: ${sigs.length} patterns, ${new Set(sigs).size} distinct`);
}

console.log('\n=== Pack-1 groove conversion vs Pack-5 P1 (plan attribution claim) ===');
const p1 = readFileSync('C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack1/proj49__48_TP_Breakdown.ncs');
const p5 = readFileSync(`${ORACLE}/proj35__34_SESSION.ncs`);
for (const [label, buf] of [['pack1 TP_Breakdown', p1], ['pack5 P1', p5]] as [string, Buffer][]) {
  const chainEnd = buf[0x2c4 + 3 * 4 + 1];
  const out: string[] = [];
  for (let p = 0; p <= Math.min(chainEnd, 1); p++) {
    const len = buf[META_OFFSETS[noteBlockIndex('midi2' as NoteTrack, p)]] + 1;
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2' as NoteTrack, p);
    const cells: string[] = [];
    for (let si = 0; si < len; si++) if (steps[si].active) for (const n of steps[si].notes) cells.push(`${si}:${n.note}+${n.delay}v${n.velocity}`);
    out.push(`p${p}(len${len}) ${cells.join(' ')}`);
  }
  console.log(`${label}: chainEnd ${chainEnd}`);
  for (const l of out) console.log(`   ${l}`);
}
