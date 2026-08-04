import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s211';
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
for (const [name, part, opts] of [['p15', load(15), { drumMap: { 27: 'kick', 28: 'snare' } }], ['p14', load(14), {}]] as const) {
  const f = flattenSongsterrDrums(part, opts as any);
  const fracHist = new Map<string, number>();
  const velHist = new Map<string, number>();
  for (const e of f.events) {
    const exact = e.beat * 4;
    const frac = exact - Math.floor(exact);
    const key = frac.toFixed(3);
    if (Math.abs(exact - Math.round(exact)) > 0.02 * 4 * 0.25) { /* not used */ }
    fracHist.set(key, (fracHist.get(key) ?? 0) + 1);
    const vel = e.velocity !== undefined ? String(e.velocity) : (e.ghost ? 'ghost(40)' : 'PLAIN(undef)');
    velHist.set(vel, (velHist.get(vel) ?? 0) + 1);
  }
  console.log(`${name}: ${f.events.length} events, unmapped ${f.unmapped}`);
  console.log(`  frac hist: ${[...fracHist.entries()].sort().map(([k, v]) => `${k} x${v}`).join(', ')}`);
  console.log(`  vel hist: ${[...velHist.entries()].sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k} x${v}`).join(', ')}`);
}
