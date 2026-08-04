/** Stranglehold addendum: m1-8 grids, ending grids, off-grid bar census, m6 letter-A content. Read-only. */
import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s403';
const kit = flattenSongsterrDrums(JSON.parse(readFileSync(`${CACHE}/part-8.json`, 'utf8')) as SongsterrPart);
const measures = kit.measures;
const barStart = (mi: number): number => measures[mi].startBeat;
const barOf = (b: number): number => { let mi = 0; while (mi < 152 && barStart(mi + 1) <= b + 1e-9) mi++; return mi + 1; };
const GM_STORED: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63, clap: 50, perc: 68 };
function grid2(mFrom: number, label: string): void {
  const b0 = barStart(mFrom - 1);
  const cells: string[] = [];
  for (const e of kit.events) {
    const rel = (e.beat - b0) * 4;
    if (rel < -1e-6 || rel >= 32 - 1e-6) continue;
    cells.push(`${Math.round(rel * 2) / 2}:${GM_STORED[e.voice] ?? -1}${e.velocity !== undefined ? `v${e.velocity}` : ''}${e.accent === true ? '!' : ''}`);
  }
  cells.sort((a, b) => parseFloat(a) - parseFloat(b));
  console.log(`  ${label} (m${mFrom}-${mFrom + 1}): ${cells.join(' ') || '(rest)'}`);
}
console.log('── intro + ending grids ──');
grid2(1, 'm1-2'); grid2(3, 'm3-4'); grid2(5, 'm5-6'); grid2(7, 'm7-8');
grid2(149, 'm149-150'); grid2(151, 'm151-152'); grid2(153, 'm153-154(=last bar only)');
console.log('\n── off-grid census by frac class, per bar ──');
const byBar = new Map<number, Map<string, number>>();
for (const e of kit.events) {
  const s = e.beat * 4;
  if (Math.abs(s - Math.round(s)) > 1e-6) {
    const b = barOf(e.beat);
    const frac = (Math.round((s - Math.floor(s)) * 1000) / 1000).toFixed(3);
    if (!byBar.has(b)) byBar.set(b, new Map());
    byBar.get(b)!.set(frac, (byBar.get(b)!.get(frac) ?? 0) + 1);
  }
}
for (const [b, fr] of [...byBar.entries()].sort((a, c) => a[0] - c[0])) {
  console.log(`  m${b}: ${[...fr.entries()].map(([f, n]) => `${f}x${n}`).join(' ')}`);
}
console.log('\nDone.');
