/**
 * Classify a drum one-shot as kick / snare / hat by audio, so an audition pool can group like with
 * like when the vendor ships no role labels (Roland's sheets give pad number + volume only).
 * VALIDATED against the samples whose role we already trust (the lo-fi pack + Kit 40) before it is
 * allowed anywhere near the unlabelled City Soul / Melodic material.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function pcm(path: string): { rate: number; ch: number; data: Int16Array } | undefined {
  const b = readFileSync(path);
  let off = 12, rate = 0, ch = 0, bits = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') {
      if (bits !== 16) return undefined;
      const n = Math.floor(sz / 2);
      const d = new Int16Array(n);
      for (let i = 0; i < n; i++) d[i] = b.readInt16LE(off + 8 + i * 2);
      return { rate, ch, data: d };
    }
    off += 8 + sz + (sz & 1);
  }
  return undefined;
}
/** Energy below/above a cut, by zero-crossing-free band split via a 1-pole filter pair. */
export function features(path: string) {
  const w = pcm(path);
  if (!w) return undefined;
  const { rate, ch, data } = w;
  const n = Math.floor(data.length / ch);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += data[i * ch + c]; mono[i] = s / ch / 32768; }
  const dur = n / rate;
  // Three bands via cascaded one-pole lowpasses: low <200 Hz, mid 200-2k, high >2k.
  // A kick is low-dominant; a hat is high-dominant with little mid; a snare always carries
  // substantial MID, which is the axis a two-band split cannot see (it read bright lo-fi snares
  // as hats, 9 misses out of 34).
  const c1 = Math.exp(-2 * Math.PI * 200 / rate);
  const c2 = Math.exp(-2 * Math.PI * 2000 / rate);
  let l = 0, m = 0, lowE = 0, midE = 0, highE = 0, tot = 0;
  for (let i = 0; i < n; i++) {
    l = (1 - c1) * mono[i] + c1 * l;
    m = (1 - c2) * mono[i] + c2 * m;
    const lo = l, mid = m - l, hi = mono[i] - m;
    lowE += lo * lo; midE += mid * mid; highE += hi * hi; tot += mono[i] * mono[i];
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mono[i]));
  let last = 0; for (let i = 0; i < n; i++) if (Math.abs(mono[i]) > peak * 0.1) last = i;
  const t = tot || 1;
  return { dur, decay: last / rate, lowRatio: lowE / t, midRatio: midE / t, highRatio: highE / t, rate };
}
export function classify(f: NonNullable<ReturnType<typeof features>>): string {
  if (f.lowRatio > 0.5) return 'kick';
  if (f.highRatio > 0.55 && f.midRatio < 0.3) return 'hat';
  if (f.midRatio > 0.18 || f.lowRatio > 0.2) return 'snare';
  return 'hat';
}

if (process.argv[2] === 'validate') {
  const dirs = ['samples/drum-sources/roland-lofi-chill/page', 'samples/circuit-tracks/stoken_packed_kit_wire0', 'samples/drum-sources/roland-80s-rock/page'];
  let ok = 0, bad = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const fn of readdirSync(d).filter((x) => x.endsWith('.wav'))) {
      const want = /kick/i.test(fn) ? 'kick' : /snare(?!_roll)/i.test(fn) ? 'snare' : /hatC|closed_hat|busy_hat/i.test(fn) ? 'hat' : undefined;
      if (!want) continue;
      const f = features(join(d, fn)); if (!f) continue;
      const got = classify(f);
      if (got === want) ok++; else { bad++; console.log(`  MISS ${fn.padEnd(28)} want ${want} got ${got}  low=${f.lowRatio.toFixed(2)} mid=${f.midRatio.toFixed(2)} high=${f.highRatio.toFixed(2)}`); }
    }
  }
  console.log(`\nvalidation on KNOWN labels: ${ok} correct, ${bad} wrong (${((100 * ok) / (ok + bad)).toFixed(0)}%)`);
}
