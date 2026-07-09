/**
 * author-circuit-groove-packed — author a packed groove set (from pack_groove.py)
 * into ONE Circuit Tracks .ncs, using per-step SAMPLE FLIP (drum_choice).
 *
 * Each groove is a FULL 4-bar beat split across a PATTERN PAIR (bars 1-2, 3-4);
 * chain the pair on the device for the complete auto-advancing groove. 4 grooves
 * => patterns 1-2, 3-4, 5-6, 7-8.
 *
 *   npx tsx scripts/author-circuit-groove-packed.ts _packed.json out.ncs
 * Then upload with upload_project (slot) and load the 1..12 sample layout.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  setDrumPattern, decodeDrumPattern, drumPatternToString,
} from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';

interface Step { velocity: number; flip_slot: number | null }
interface Packed {
  song: string;
  sample_layout: Record<string, number>;
  track_base: string[];
  grooves: { name: string; source: string; patterns: { track: number; base: string; steps: (Step | null)[] }[][] }[];
}

const jsonPath = process.argv[2] ?? 'scripts/groove-analysis/_packed.json';
const out = process.argv[3] ?? 'samples/circuit-tracks/grooves/the_summoning_packed.ncs';

const packed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Packed;
const buf = new Uint8Array(readFileSync(TEMPLATE));

const totalPatterns = packed.grooves.reduce((n, g) => n + g.patterns.length, 0);
if (totalPatterns > 8) throw new Error(`max 8 patterns per project; got ${totalPatterns}`);

let pattern = 0; // running slot 0..7 across all grooves
const grooveStart: number[] = [];
packed.grooves.forEach((groove) => {
  grooveStart.push(pattern);
  groove.patterns.forEach((ptracks) => {
    for (const tr of ptracks) {
      const grid = tr.steps.map((s) =>
        s === null
          ? { active: false }
          : {
              active: true,
              velocity: Math.min(127, s.velocity),
              // flip_slot is a 1..64 device slot in the layout; codec wants wire 0..63.
              ...(s.flip_slot != null ? { sampleSlot: s.flip_slot - 1 } : {}),
            },
      );
      setDrumPattern(buf, tr.track, pattern, grid);
    }
    pattern++;
  });
});

writeFileSync(out, buf);
console.log(`Wrote ${out}: ${packed.grooves.length} grooves, ${totalPatterns} patterns.\n`);
packed.grooves.forEach((g, gi) => {
  const start = grooveStart[gi];
  const pats = g.patterns.map((_, h) => start + h + 1);
  const chain = pats.length > 1 ? `  → chain patterns ${pats.join('+')}` : `  → pattern ${pats[0]}`;
  console.log(`Groove ${gi + 1} "${g.name}"${chain}`);
  for (let t = 0; t < 4; t++) {
    const rows = g.patterns.map((_, h) => drumPatternToString(decodeDrumPattern(buf, t, start + h))).join('|');
    console.log(`  T${t + 1} [${packed.track_base[t].padEnd(10)}] |${rows}|`);
  }
});
console.log('\nSample layout to load on the device (Drum > Preset positions):');
for (const [piece, slot] of Object.entries(packed.sample_layout)) console.log(`  slot ${String(slot).padStart(2)}  ${piece}`);
console.log(`\nUpload:  upload_project(file:"${out}", slot:48)   # Project 49`);
