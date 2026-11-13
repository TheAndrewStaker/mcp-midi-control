/** Momentary-max peak + short-window RMS, the measure this project uses for drum leveling
 *  (integrated LUFS cannot see a one-shot: it told us to boost a ride 12 dB the wrong way). */
import { readFileSync } from 'node:fs';
function mono(path: string) {
  const b = readFileSync(path);
  let off = 12, rate = 0, ch = 0, bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4); const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') {
      const n = Math.floor(sz / 2 / ch); const out = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += b.readInt16LE(off + 8 + (i * ch + c) * 2); out[i] = s / ch / 32768; }
      return { rate, d: out };
    }
    off += 8 + sz + (sz & 1);
  }
  throw new Error('no data chunk: ' + path);
}
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
for (const p of process.argv.slice(2)) {
  const { rate, d } = mono(p);
  let peak = 0; for (const v of d) peak = Math.max(peak, Math.abs(v));
  // momentary-max: loudest 100 ms window
  const w = Math.floor(rate * 0.1); let best = 0, acc = 0;
  for (let i = 0; i < d.length; i++) { acc += d[i] * d[i]; if (i >= w) acc -= d[i - w] * d[i - w]; if (i >= w) best = Math.max(best, acc / w); }
  console.log(`${p.split(/[\/]/).pop()!.padEnd(26)} peak ${db(peak).toFixed(1)} dB   momentary-max ${db(Math.sqrt(best)).toFixed(1)} dB   ${(d.length / rate).toFixed(2)}s`);
}
