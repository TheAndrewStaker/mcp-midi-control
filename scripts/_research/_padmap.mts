/** Map every extracted Roland sample back to its NAS original by DURATION, so the role labels we
 *  invented can be checked against Roland's own pad numbering instead of trusted. */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const NAS = '//HomeNAS/RAIDShare/Music Production/Device Preset Banks/Roland SPD-SX/Roland-SPD-SX-Kits';
const PACKS = [
  { id: 'lofi', dir: 'TDZ600_LofiChill', wave: 'LoFi', local: 'samples/drum-sources/roland-lofi-chill/page', pre: 'lofi' },
  { id: 'citysoul', dir: 'TDZ601_CitySoul', wave: 'CitySoul', local: 'samples/drum-sources/roland-citysoul/page', pre: 'citysoul' },
  { id: 'melodic', dir: 'TDZ606_MelodicAmbience1', wave: 'Melodic_Ambience', local: 'samples/drum-sources/roland-melodic/page', pre: 'melodic' },
  { id: '80s', dir: 'TDZ603_80sRock1', wave: '80sRock1', local: 'samples/drum-sources/roland-80s-rock/page', pre: '80s' },
];
function secs(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const b = readFileSync(path);
  // walk RIFF chunks for fmt + data
  let off = 12, rate = 0, ch = 0, bits = 0, data = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') { data = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  if (!rate || !ch || !bits || !data) return undefined;
  return data / (rate * ch * (bits / 8));
}
for (const p of PACKS) {
  console.log(`\n### ${p.id}`);
  const locals = existsSync(p.local) ? readdirSync(p.local).filter((f) => f.endsWith('.wav')) : [];
  for (let kit = 1; kit <= 5; kit++) {
    const nas: { pad: number; s: number }[] = [];
    for (let pad = 1; pad <= 9; pad++) {
      const s = secs(join(NAS, p.dir, 'SPD-SX', 'KitData', `Kit${kit}`, `${p.wave}_Kit${kit}_P${pad}.wav`));
      if (s !== undefined) nas.push({ pad, s });
    }
    const mine = locals.filter((f) => new RegExp(`^${p.pre}_${kit}_`).test(f));
    for (const f of mine.sort()) {
      const s = secs(join(p.local, f));
      if (s === undefined) { console.log(`  ${f}: unreadable`); continue; }
      const hit = nas.find((n) => Math.abs(n.s - s) < 0.02);
      console.log(`  ${f.padEnd(30)} ${s.toFixed(3)}s  -> ${hit ? `PAD ${hit.pad}` : 'NO MATCH'}`);
    }
  }
}
