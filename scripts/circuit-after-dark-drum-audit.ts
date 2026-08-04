/**
 * circuit-after-dark-drum-audit.ts — READ-ONLY. Answer, per project, whether the
 * condensed internal drum copy is present AND whether it points at sounds that
 * make sense. No device contact, no `--apply`, and no write path exists here.
 *
 * ## The question this exists to answer
 *
 * The maintainer, 2026-07-28: *"the condensed version on the drum tracks. I still
 * haven't gotten to see that."* and *"I also think it's possible that I don't have
 * any drum samples on those packs, is that true?"*
 *
 * Three separate things can each make a correct condensed part inaudible or
 * wrong, and they are usually confused with one another:
 *
 *  1. **No content.** The drum tracks hold nothing. Checked here by decoding all
 *     4 tracks x 8 patterns and counting hits.
 *  2. **Level 0.** `condense_drums` stores the four drum-track levels at 0 BY
 *     DESIGN (the internal kit is a blend layer under the SPD-SX, not the drums),
 *     so a perfectly correct part is SILENT until the faders come up. This is the
 *     most likely reason it has never been heard.
 *  3. **Wrong sample bound.** Each drum track points at ONE pool slot
 *     (`drumBinding.ts`, 0x1a278..0x1a27b, 0-based). Slot numbers are
 *     PACK-RELATIVE, so the same index is a different sound in every pack. The
 *     condenser's role order is `DRUM_TRACK_BASE_VOICES` = kick / snare /
 *     closed_hat / ride, and `CIRCUIT_VOICE_SLOT` says those want slots 0/1/2/3
 *     of a ROLE-ORDERED pool. Pack 2's pool is a clone of Pack 1's, which is NOT
 *     role-ordered, so this script prints the binding against the actual pool
 *     names and says whether they agree.
 *
 * ## Where the data comes from, and why offline is sound
 *
 * Projects: a directory of `.ncs` files. The default is the pre-edit backup taken
 * by tonight's Synth 2 write, which is a full device download taken minutes ago;
 * every write that session was verified to change ONLY synth2's own bytes with
 * zero collateral, so the drum regions in those files ARE the device's current
 * drum regions. Pool names: the card backup's per-slot filenames.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-drum-audit.ts
 *   npx tsx scripts/circuit-after-dark-drum-audit.ts --dir <ncs-dir> --pool <pack-samples-dir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  DRUM_BINDING_OFFSET, DRUM_TRACK_BASE_VOICES, CIRCUIT_VOICE_SLOT, NUM_DRUM_TRACKS,
} from '../packages/circuit-tracks/src/ncs/drumBinding.js';
import { PATTERNS_PER_TRACK, getDrumLevel } from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const DIR = flag('--dir') ?? 'samples/circuit-ncs/restore-afterdark-synth2-square-2026-07-28T23-11-49-681Z';
/** Pack 2's pool is an index-for-index clone of Pack 1's, so Pack 1's names ARE Pack 2's. */
const POOL = flag('--pool') ?? 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z/pack1/samples';

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** slot -> filename, read from the backup's `sNN__<device filename>` convention. */
function poolNames(dir: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const m = /^s(\d{2})__(.+)$/.exec(f);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

const pool = poolNames(POOL);
console.log('After Dark, Pack 2 — condensed internal drums: content, level, and what sample each track plays');
console.log(`  projects : ${DIR}`);
console.log(`  pool     : ${POOL}  (${pool.size} slot name(s) recovered)`);
console.log('  READ-ONLY. No device contact.\n');

console.log('What the condenser EXPECTS (drumBinding.ts is the authority):');
for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
  const role = DRUM_TRACK_BASE_VOICES[t];
  console.log(`  Drum ${t + 1}  role "${role}"  -> CIRCUIT_VOICE_SLOT says pool slot ${CIRCUIT_VOICE_SLOT[role]}`);
}
console.log('');

const files = readdirSync(DIR).filter((f) => f.endsWith('.ncs')).sort();
let anyMismatch = false;
for (const f of files) {
  const b = new Uint8Array(readFileSync(join(DIR, f)));
  const rows: string[] = [];
  let totalHits = 0;
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    let hits = 0;
    const flips = new Set<number>();
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      for (const st of decodeDrumPattern(b, t, p)) {
        if (!st.active) continue;
        hits++;
        if (st.drumChoice !== 0xff) flips.add(st.drumChoice);
      }
    }
    totalHits += hits;
    const bound = b[DRUM_BINDING_OFFSET + t];
    const role = DRUM_TRACK_BASE_VOICES[t];
    const wantSlot = CIRCUIT_VOICE_SLOT[role];
    const boundName = pool.get(bound) ?? '(slot name unknown)';
    const wantName = pool.get(wantSlot) ?? '(slot name unknown)';
    const agree = bound === wantSlot;
    if (!agree) anyMismatch = true;
    rows.push(
      `    Drum ${t + 1} role ${role.padEnd(11)} ${String(hits).padStart(3)} hit(s)  level ${String(getDrumLevel(b, t)).padStart(3)}`
      + `  -> bound slot ${String(bound).padStart(2)} "${boundName}"`
      + `${agree ? '' : `   MISMATCH: role wants slot ${wantSlot} "${wantName}"`}`
      + `${flips.size > 0 ? `  [per-step flips to ${[...flips].join(',')}]` : ''}`,
    );
  }
  console.log(`  ${f}  "${nameOf(b)}"  ${totalHits} internal drum hit(s)${totalHits === 0 ? '   <- NO CONDENSED CONTENT' : ''}`);
  for (const r of rows) console.log(r);
}

console.log('');
console.log(anyMismatch
  ? 'BINDING MISMATCH: at least one drum track plays a sample its role did not ask for. See above.'
  : 'Every drum track is bound to the slot its role asks for.');
console.log('');
console.log('Reminder: `condense_drums` stores these levels at 0 on purpose (blend layer under the');
console.log('SPD-SX). A level of 0 is SILENCE, not a failed write, and it is the most likely reason');
console.log('the condensed part has never been heard. Raising the faders on the device is enough to');
console.log('hear it; a hand-Save with the faders up will also bake the new level into the project.');
