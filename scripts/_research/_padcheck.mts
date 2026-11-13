import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { features, classify } from './_classify.mts';
const PADMAP: Record<string, Record<string, number>> = {};
const SETS = [
  { pre: 'lofi', dir: 'samples/drum-sources/roland-lofi-chill/page', pad: (f: string) => ({ '01': 7, '02': 8, '03': 9, '04': 6 } as any)[f.split('_')[2]?.slice(0, 2) ?? ''] },
  { pre: 'citysoul', dir: 'samples/drum-sources/roland-citysoul/page', pad: (f: string) => Number(f.split('_')[2]) },
  { pre: 'melodic', dir: 'samples/drum-sources/roland-melodic/page', pad: (f: string) => Number(f.split('_')[2]) },
];
const tally: Record<string, Record<number, Record<string, number>>> = {};
for (const s of SETS) {
  if (!existsSync(s.dir)) continue;
  tally[s.pre] = {};
  for (const fn of readdirSync(s.dir).filter((x) => x.endsWith('.wav')).sort()) {
    const pad = s.pad(fn);
    if (!pad) continue;
    const f = features(join(s.dir, fn));
    if (!f) continue;
    const c = classify(f);
    (tally[s.pre][pad] ??= {})[c] = ((tally[s.pre][pad] ??= {})[c] ?? 0) + 1;
    if (pad >= 6) console.log(`${s.pre.padEnd(9)} PAD${pad}  ${fn.padEnd(26)} ${f.dur.toFixed(2)}s  -> ${c}`);
  }
}
console.log('\n=== does PAD 7 = kick, PAD 8 = snare, PAD 9 = hat hold per pack? ===');
for (const [pre, pads] of Object.entries(tally)) {
  for (const pad of [7, 8, 9]) {
    const t = pads[pad]; if (!t) continue;
    const top = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
    const want = pad === 7 ? 'kick' : pad === 8 ? 'snare' : 'hat';
    console.log(`  ${pre.padEnd(9)} PAD${pad}: ${JSON.stringify(t)}  majority=${top[0]}  ${top[0] === want ? 'MATCHES' : 'DOES NOT MATCH'} the lo-fi convention (${want})`);
  }
}
