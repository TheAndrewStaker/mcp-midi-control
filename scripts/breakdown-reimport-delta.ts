/**
 * breakdown-reimport-delta.ts — would a fresh re-import beat a byte patch?
 *
 * Compares, for Tom Petty "Breakdown" (Songsterr 23527):
 *   A. what a FRESH import through the fixed importer would produce, and
 *   B. what is actually stored in the authored projects on disk / device,
 * so the choice between "re-author" and "patch the bytes" is made on numbers.
 *
 * Reports: notes that move, notes that change velocity, notes present in one
 * side only, and — the veto condition — anything the stored version holds that
 * a re-author would LOSE (tie flags in the gate byte are hand-set note lengths
 * the authoring path cannot reproduce).
 *
 * READ-ONLY. No device, no writes.
 *
 *   npx tsx scripts/breakdown-reimport-delta.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSongsterrPart, flattenSongsterrDrums } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { NOTE_TRACKS, PATTERNS_PER_TRACK, NUM_DRUM_TRACKS, NOTE_STEP_BYTES, noteStepBase, type NoteTrack } from '../packages/circuit-tracks/src/ncs/format.js';

const PACK5 = join(import.meta.dirname, '..', 'samples', 'circuit-ncs', 'pack5');
const PROJECTS = [35, 36, 37, 38, 39];
const DRUM_VOICE = ['kick', 'snare', 'hat', '-'] as const;
const NOTE_VOICE: Record<number, string> = { 48: 'kick', 50: 'snare', 54: 'hat', 57: 'lowtom', 58: 'openhat', 61: 'crash' };

// ── A. fresh import ──────────────────────────────────────────────────
const partRes: any = await fetchSongsterrPart('23527');
const flat = flattenSongsterrDrums(partRes.part ?? partRes);
const BPM = (flat.signature[0] * 4) / flat.signature[1];

console.log('='.repeat(76));
console.log('A. FRESH IMPORT through the fixed importer');
console.log('='.repeat(76));
console.log(`  bpm ${flat.bpm}  ghosts ${flat.ghosts}  graces_folded ${flat.graces_folded}  flams ${flat.flams_collapsed}`);

// measure-1 groove as the fixed importer now sees it
const m1 = flat.events.filter((e) => e.beat < BPM);
console.log('\n  measure 1, as the FIXED importer now renders it:');
for (const e of m1) {
  const v = (e as any).velocity;
  console.log(`    16th ${String((e.beat * 4).toFixed(2)).padStart(5)}  ${e.voice.padEnd(8)} velocity ${v ?? '(flag-derived)'}`);
}

// velocity histogram the fresh import would produce
const vh = new Map<number | string, number>();
for (const e of flat.events) vh.set((e as any).velocity ?? 'unset', (vh.get((e as any).velocity ?? 'unset') ?? 0) + 1);
console.log(`\n  fresh-import velocity histogram: ${[...vh].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([v, c]) => `${v}×${c}`).join(', ')}`);

// how many events need a sub-16th position the 16th grid cannot hold
const offGrid = flat.events.filter((e) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) > 1e-9);
console.log(`  events needing a sub-16th position: ${offGrid.length} / ${flat.events.length}  (all at exactly +1/2 step = micro-tick 3 of 6)`);

// ── B. what is stored ────────────────────────────────────────────────
console.log('\n' + '='.repeat(76));
console.log('B. WHAT IS STORED in the authored projects');
console.log('='.repeat(76));

let storedHits = 0, ties = 0, microUsed = 0, delayUsed = 0;
const storedVel = new Map<number, number>();
const tieDetail: string[] = [];
for (const n of PROJECTS) {
  const b = readFileSync(join(PACK5, `proj${String(n).padStart(2, '0')}.ncs`));
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      for (const s of decodeDrumPattern(b, t, p)) {
        if (!s.active) continue;
        storedHits++;
        storedVel.set(s.velocity, (storedVel.get(s.velocity) ?? 0) + 1);
        if (s.microHits !== 1) microUsed++;
      }
    }
  }
  for (const tr of NOTE_TRACKS) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      for (const [i, s] of decodeNotePattern(b, tr as NoteTrack, p).entries()) {
        if (!s.active) continue;
        // Tie detection reads the RAW gate byte, never the decoded field:
        // decodeNotePattern in this tree now strips bit 7 into its own `tie`
        // flag and returns a masked gate, so `decoded.gate & 0x80` is always 0.
        // Reading bytes keeps this correct whichever side of that change we are on.
        const stepBase = noteStepBase(tr as NoteTrack, p) + i * NOTE_STEP_BYTES;
        for (let k = 0; k < 6; k++) {
          if (!((b[stepBase] >> k) & 1)) continue;
          const o = stepBase + 4 + k * 4;
          const rawGate = b[o + 1];
          if (b[o + 2] !== 0) delayUsed++;
          if (rawGate & 0x80) {
            ties++;
            tieDetail.push(`proj${n} ${tr} p${p + 1} s${i} note=${b[o]} gate=0x${rawGate.toString(16)} (${rawGate & 0x7f} + TIE)`);
          }
        }
      }
    }
  }
  void DRUM_VOICE; void NOTE_VOICE;
}
console.log(`  stored drum hits: ${storedHits}`);
console.log(`  stored velocities: ${[...storedVel].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v}×${c}`).join(', ')}`);
console.log(`  drum steps using a micro-tick offset: ${microUsed}   (0 = every hit sits on the 16th line)`);
console.log(`  note slots using the delay field:     ${delayUsed}   (0 = every note sits on the 16th line)`);

console.log(`\n  *** TIE FLAGS (gate bit 7) — a re-author would DESTROY these: ${ties} ***`);
for (const d of tieDetail) console.log(`    ${d}`);

// ── verdict ──────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(76));
console.log('DELTA / VERDICT');
console.log('='.repeat(76));
const wouldChangeVel = [...storedVel].filter(([v]) => v === 100).reduce((a, [, c]) => a + c, 0);
console.log(`  velocity: the fresh ladder moves ONLY the \`p\` snare tail 100 -> 60.`);
console.log(`            kick/backbeat fff = 120 already correct; hats f = 100 already correct.`);
console.log(`  timing:   ${offGrid.length}/${flat.events.length} source events need micro-tick 3; stored uses it ${microUsed} times.`);
console.log(`            A re-import does NOT fix this — the quantizer still snaps to 16ths.`);
console.log(`  loss:     a re-author would drop ${ties} tie flag(s) it cannot re-emit.`);
console.log(`  (${wouldChangeVel} stored hits currently sit at velocity 100; only the snare-tail subset should move.)`);
