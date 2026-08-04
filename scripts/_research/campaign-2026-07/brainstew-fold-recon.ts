// Reconcile stored-window drum event count vs staged cells. Read-only.
import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const p6 = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/songsterr-cache/s8644/part-6.json', 'utf8')) as SongsterrPart;
const f = flattenSongsterrDrums(p6);
const stored: Array<[number, number]> = [[13, 14], [25, 26], [29, 36], [41, 48], [49, 63]];
let n = 0; let v112 = 0; let gh = 0;
for (const e of f.events) {
  const m = Math.floor(e.beat / 4) + 1;
  if (stored.some(([a, b]) => m >= a && m <= b)) { n++; if (e.velocity === 112) v112++; else if (e.ghost === true) gh++; }
}
console.log(`events inside STORED windows: ${n} (@112 ${v112}, ghosts ${gh})`);
console.log(`staged cells 562 => ${n - 562} same-step fold(s) within stored windows`);
const byStep = new Map<string, number>();
for (const e of f.events) {
  const m = Math.floor(e.beat / 4) + 1;
  if (!stored.some(([a, b]) => m >= a && m <= b)) continue;
  const k = `${e.voice}|m${m}|step${Math.floor((e.beat - (m - 1) * 4) * 4 + 1e-9)}`;
  byStep.set(k, (byStep.get(k) ?? 0) + 1);
}
for (const [k, c] of byStep) if (c > 1) console.log(`  fold: ${k} x${c}`);
