/** Where does the material actually change across the Bridge? Per-bar identity for every layer. */
import { readFileSync } from 'node:fs';
import { flattenSongsterrMelodic, importSongsterrDrums } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
const FIX = 'scripts/fixtures/offering';
const load = (i: number) => JSON.parse(readFileSync(`${FIX}/part-${i}.json`, 'utf8'));
const NAMES: Record<number, string> = {
  3: 'gtr Rhythm1 (8str)', 4: 'gtr Rhythm2 (8str)', 5: 'gtr Rhy1 F-std (7str)', 6: 'gtr Rhy2 F-std (7str)',
  7: 'bass', 8: 'pad Kbd#1', 9: 'piano Kbd#2', 10: 'pad Kbd#3', 11: 'sax Kbd#4',
};
const FROM = Number(process.argv[2] ?? 97), TO = Number(process.argv[3] ?? 124);

/** A letter per bar: bars with identical note content share a letter. */
function letters(sig: string[]): string[] {
  const seen = new Map<string, string>(); const out: string[] = [];
  for (const s of sig) {
    if (s === '') { out.push('.'); continue; }
    if (!seen.has(s)) seen.set(s, String.fromCharCode(65 + seen.size));
    out.push(seen.get(s)!);
  }
  return out;
}
const rows: [string, string[]][] = [];
for (const [id, name] of Object.entries(NAMES)) {
  const f = flattenSongsterrMelodic(load(Number(id)), {});
  const sig: string[] = [];
  for (let m = FROM; m <= TO; m++) {
    const a = f.measures[m - 1].startBeat, b = f.measures[m] ? f.measures[m].startBeat : f.totalBeats;
    const ns = f.notes.filter((n) => n.beat >= a && n.beat < b);
    sig.push(ns.map((n) => `${(n.beat - a).toFixed(2)}:${n.pitch}`).join('|'));
  }
  rows.push([name, letters(sig)]);
}
// drums
{
  const d = load(14);
  const sig: string[] = [];
  for (let m = FROM; m <= TO; m++) {
    const r = importSongsterrDrums(d, { fromMeasure: m, toMeasure: m, splitToms: true, stepsPerBeat: 4 });
    sig.push(Object.entries(r.voices).flatMap(([v, c]) =>
      (c as any[]).map((x, i) => (x?.on ? `${v}${i}` : '')).filter(Boolean)).sort().join('|'));
  }
  rows.push(['DRUMS', letters(sig)]);
}
const hdr = Array.from({ length: TO - FROM + 1 }, (_, i) => String(FROM + i).slice(-2));
console.log('bar'.padEnd(24) + hdr.join(' '));
for (const [n, l] of rows) console.log(n.padEnd(24) + l.map((x) => ` ${x}`).join(' '));
console.log();
// Where does each layer change?
for (const [n, l] of rows) {
  const ch: number[] = [];
  for (let i = 1; i < l.length; i++) if (l[i] !== l[i - 1]) ch.push(FROM + i);
  console.log(`${n.padEnd(24)} changes at: ${ch.join(', ') || '(never)'}`);
}
