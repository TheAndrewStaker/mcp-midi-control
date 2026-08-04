/**
 * Phase 4: authoring-grade enumeration of the missing loop-wrap bars.
 * Read-only. Run: npx tsx samples/_scratch/schism-tail-notes.ts
 */
import { readFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, pitchToken, describe, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js' with {};

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700';
const loadPart = (id: number) => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const part2 = loadPart(2); // S1
const part3 = loadPart(3); // M1
const part5 = loadPart(5); // DR

function mel(part: SongsterrPart, label: string, from: number, to: number): void {
  const imp = importSongsterrMelodic(part, { fromMeasure: from, toMeasure: to });
  const cells = imp.steps.map((s: any, i: number) => (s.on
    ? `s${i}:${(Array.isArray(s.notes) ? s.notes : [s.notes]).map(pitchToken).join('+')}` +
      `${s.gate_sixths !== undefined ? `:g${s.gate_sixths}` : ''}${s.velocity !== undefined ? `@${s.velocity}` : ''}${s.tie ? '_' : ''}`
    : undefined)).filter(Boolean);
  console.log(`${label} m${from}${to !== from ? '-' + to : ''} (${imp.steps.length} steps): ${cells.join(' ')}`);
  console.log(`  notation: ${(imp as any).notation}`);
}
function drums(label: string, from: number, to: number): void {
  const imp = importSongsterrDrums(part5, { fromMeasure: from, toMeasure: to });
  for (const [voice, grid] of Object.entries(imp.voices)) {
    const on = (grid as any[]).map((s, i) => (s.on ? `s${i}${s.velocity !== undefined ? '@' + s.velocity : ''}` : undefined)).filter(Boolean);
    if (on.length > 0) console.log(`${label} m${from}-${to} ${voice} (${imp.steps} steps): ${on.join(' ')}`);
  }
}

console.log('== slot 17 fix content: S1 closing 3/4 bar ==');
mel(part2, 'S1', 137, 137);
console.log('\n== slot 18 fix content: closing 3/8 bar ==');
mel(part2, 'S1', 156, 156);
mel(part3, 'M1', 156, 156);
console.log('\n== slot 18 M1 residual (cannot fit): the close ==');
mel(part3, 'M1', 157, 158);
console.log('\n== slot 19 fix content: the provable D bar ==');
mel(part2, 'S1', 174, 174);
mel(part3, 'M1', 174, 174);
console.log('\n== slot 23 fix content: the 7/8 closer ==');
mel(part2, 'S1', 227, 227);
drums('DR', 227, 227);
