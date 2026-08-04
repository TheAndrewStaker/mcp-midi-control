/**
 * SURGICAL PASS 2026-07-30 — offline audit of the three target songs.
 *
 * READ-ONLY. Decodes the canonical card backup for Breakdown (35-39),
 * I Believe (19-25) and The Offering (57-63) and reports, per project:
 * name, colour, synth1/synth2 mixer levels, and the note-step counts on
 * every track (so a nonzero level can be judged load-bearing or not).
 *
 * Usage: npx tsx samples/_scratch/surgical-audit-2026-07-30.ts
 */
import { readFileSync } from 'node:fs';
import {
  PROJECT_NAME_OFFSET, PROJECT_NAME_LEN, PROJECT_COLOUR_OFFSET, projectColourName,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  noteStepBase, NOTE_STEP_BYTES, STEPS_PER_PATTERN, PATTERNS_PER_TRACK,
  checkNcsStructure,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const CANON = 'samples/circuit-ncs/card-backup-2026-07-29/pack5';

const GROUPS: Array<{ song: string; slots: number[] }> = [
  { song: 'I Believe', slots: [19, 20, 21, 22, 23, 24, 25] },
  { song: 'Breakdown', slots: [35, 36, 37, 38, 39] },
  { song: 'The Offering', slots: [57, 58, 59, 60, 61, 62, 63] },
];

const canonPath = (slot: number): string =>
  `${CANON}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`;

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(PROJECT_NAME_OFFSET, PROJECT_NAME_OFFSET + PROJECT_NAME_LEN))
    .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function steps(b: Uint8Array, track: 'synth1' | 'synth2' | 'midi1' | 'midi2'): number {
  let n = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const base = noteStepBase(track, p);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) if (b[base + s * NOTE_STEP_BYTES] !== 0) n++;
  }
  return n;
}

for (const g of GROUPS) {
  console.log(`\n=== ${g.song} ===`);
  console.log('slot | name                       | colour        | s1lvl s2lvl | s1steps s2steps m1steps m2steps | struct');
  for (const slot of g.slots) {
    const b = readFileSync(canonPath(slot));
    const st = checkNcsStructure(b);
    const col = b[PROJECT_COLOUR_OFFSET];
    console.log(
      `${String(slot).padStart(4)} | ${nameOf(b).padEnd(26)} | ${`${col}=${projectColourName(col)}`.padEnd(13)} | ` +
      `${String(b[MIXER_SYNTH1_LEVEL]).padStart(5)} ${String(b[MIXER_SYNTH2_LEVEL]).padStart(5)} | ` +
      `${String(steps(b, 'synth1')).padStart(7)} ${String(steps(b, 'synth2')).padStart(7)} ` +
      `${String(steps(b, 'midi1')).padStart(7)} ${String(steps(b, 'midi2')).padStart(7)} | ${st.ok ? 'ok' : st.faults.join('; ')}`,
    );
  }
}
