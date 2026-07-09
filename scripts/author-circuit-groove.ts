/**
 * author-circuit-groove — pack reduced groove(s) into ONE Circuit Tracks .ncs as
 * swappable patterns (1..8), for live performance flipping.
 *
 * Input: the *.circuit.json files produced by groove_to_pattern.py (each has
 * {steps, tracks:{<4 voices>:[velocity per 32 steps]}}). Track order maps to
 * Circuit drum tracks D1..D4 (load kick/snare/hat/accent samples accordingly).
 *
 *   npx tsx scripts/author-circuit-groove.ts out.ncs g1.circuit.json [g2 ... up to 8]
 * Then upload:
 *   npx tsx scripts/circuit-ncs-upload-file.ts out.ncs <slot>
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  setDrumPattern,
  decodeDrumPattern,
  drumPatternToString,
} from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';

const out = process.argv[2];
const grooveFiles = process.argv.slice(3);
if (!out || grooveFiles.length === 0) {
  console.error('usage: tsx scripts/author-circuit-groove.ts out.ncs g1.circuit.json [g2 ...]');
  process.exit(2);
}
if (grooveFiles.length > 8) {
  console.error(`max 8 patterns per project; got ${grooveFiles.length}`);
  process.exit(2);
}

const buf = new Uint8Array(readFileSync(TEMPLATE));

grooveFiles.forEach((gf, pat) => {
  const g = JSON.parse(readFileSync(gf, 'utf8')) as { tracks: Record<string, number[]> };
  const trackNames = Object.keys(g.tracks).slice(0, 4); // D1..D4
  trackNames.forEach((name, trackIdx) => {
    const grid = g.tracks[name].map((v) =>
      v > 0 ? { active: true, velocity: Math.min(127, v) } : { active: false },
    );
    setDrumPattern(buf, trackIdx, pat, grid);
  });
});

writeFileSync(out, buf);
console.log(`wrote ${out} with ${grooveFiles.length} pattern(s):`);
grooveFiles.forEach((gf, p) => {
  console.log(`\n  pattern ${p + 1}  (${gf.split(/[\\/]/).pop()})`);
  for (let t = 0; t < 4; t++) {
    console.log(`    D${t + 1}: ${drumPatternToString(decodeDrumPattern(buf, t, p))}`);
  }
});
console.log(`\nupload:  npx tsx scripts/circuit-ncs-upload-file.ts ${out} <slot>`);
