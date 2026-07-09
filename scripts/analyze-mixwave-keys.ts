/**
 * analyze-mixwave-keys — classify the bounced Sleep Token II per-key WAVs into
 * a candidate drum map (the audio IS the oracle; Kontakt's mapping UI is
 * blocked). For each key WAV:
 *
 *   - silence test        → key not mapped at all (definitive)
 *   - onset count         → >= 3 onsets from ONE note = a ROLL articulation
 *   - band energy ratios  → kick (sub), snare (body+crack), hat/cymbal (top)
 *   - decay time          → closed hat (short) vs crash/ride/china (long ring)
 *
 * Prints an evidence table + a draft drum_map (voice guesses flagged for ear
 * confirmation; silence and roll detection are hard evidence, voice labels are
 * strong inference).
 *
 *   npx tsx scripts/analyze-mixwave-keys.ts [dir=samples/mixwave/keys]
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] ?? 'samples/mixwave/keys';

interface Wav { rate: number; samples: Float32Array }
function readWav(file: string): Wav {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV`);
  let pos = 12;
  let rate = 0, bits = 0, channels = 1;
  let data: Buffer | undefined;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(pos + 10);
      rate = b.readUInt32LE(pos + 12);
      bits = b.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      data = b.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size & 1);
  }
  if (!data || rate === 0) throw new Error(`${file}: no fmt/data`);
  const bytesPer = bits / 8;
  const frames = Math.floor(data.length / bytesPer / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) {
      const off = (i * channels + c) * bytesPer;
      v += bits === 16 ? data.readInt16LE(off) / 32768
        : bits === 24 ? ((data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)) << 8 >> 8) / 8388608
          : data.readInt32LE(off) / 2147483648;
    }
    out[i] = v / channels;
  }
  return { rate, samples: out };
}

interface Features {
  key: number; file: string; peakDb: number; silent: boolean;
  onsets: number; decayS: number; sub: number; body: number; crack: number; top: number;
}

function analyze(file: string, key: number): Features {
  const { rate, samples } = readWav(file);
  let peak = 0;
  for (const s of samples) { const a = Math.abs(s); if (a > peak) peak = a; }
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
  if (peakDb < -60) return { key, file, peakDb, silent: true, onsets: 0, decayS: 0, sub: 0, body: 0, crack: 0, top: 0 };

  // Envelope at 1 kHz frames (1 ms), RMS over 5 ms.
  const frame = Math.round(rate / 1000);
  const env: number[] = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let acc = 0;
    for (let j = i; j < i + frame; j++) acc += samples[j] * samples[j];
    env.push(Math.sqrt(acc / frame));
  }
  const sm: number[] = env.map((_, i) => {
    let a = 0, n = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(env.length - 1, i + 2); k++) { a += env[k]; n++; }
    return a / n;
  });
  const envPeak = Math.max(...sm);

  // Onsets: rises above 25% of peak that follow a dip below 60% of the local
  // max, 30 ms refractory (a 16-hits/s roll spaces ~62 ms).
  let onsets = 0;
  let armed = true;
  let last = -100;
  for (let i = 1; i < sm.length; i++) {
    if (armed && sm[i] > envPeak * 0.25 && sm[i] > sm[i - 1] && i - last > 30) { onsets++; last = i; armed = false; }
    if (!armed && sm[i] < envPeak * 0.15) armed = true;
  }

  // Decay: last envelope frame above -40 dB rel peak.
  const floor = envPeak * 0.01;
  let lastLoud = 0;
  for (let i = 0; i < sm.length; i++) if (sm[i] > floor) lastLoud = i;
  const decayS = lastLoud / 1000;

  // Band energies over the first 300 ms after the first onset, via one-pole
  // low-pass cascades: sub <120 Hz, body 120-700, crack 700-4k, top >4k.
  const start = Math.max(0, (last >= 0 ? 0 : 0));
  const n0 = 0;
  const n1 = Math.min(samples.length, n0 + Math.round(rate * 0.3));
  const lp = (cut: number): Float32Array => {
    const a = 1 - Math.exp((-2 * Math.PI * cut) / rate);
    const out = new Float32Array(n1 - n0);
    let y = 0;
    for (let i = n0; i < n1; i++) { y += a * (samples[i] - y); out[i - n0] = y; }
    return out;
  };
  const e = (xs: Float32Array): number => { let a = 0; for (const x of xs) a += x * x; return a; };
  const l120 = lp(120), l700 = lp(700), l4k = lp(4000);
  const total = e(samples.subarray(n0, n1)) + 1e-12;
  const sub = e(l120) / total;
  const body = Math.max(0, (e(l700) - e(l120)) / total);
  const crack = Math.max(0, (e(l4k) - e(l700)) / total);
  const top = Math.max(0, (total - e(l4k)) / total);
  void start;
  return { key, file, peakDb, silent: false, onsets, decayS, sub, body, crack, top };
}

function classify(f: Features): string {
  if (f.silent) return '(unmapped / silent)';
  if (f.onsets >= 3) return f.top > 0.4 ? 'ROLL (cymbal/hat)' : 'ROLL (snare!)';
  if (f.sub > 0.55 && f.decayS < 1.2) return 'kick';
  if (f.top > 0.55) return f.decayS > 1.0 ? 'cymbal (crash/ride/china)' : 'hat (closed)';
  if (f.top > 0.3 && f.decayS > 1.5) return 'cymbal (crash/ride/china)';
  if (f.sub + f.body > 0.6 && f.decayS >= 0.25) return f.crack > 0.15 ? 'snare' : 'tom';
  if (f.crack > 0.3) return 'snare (crack)';
  return 'perc/other';
}

function main(): void {
  const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.wav'));
  const rows: Features[] = [];
  for (const f of files) {
    const m = /(\d{1,3})/.exec(f);
    if (!m) continue;
    rows.push(analyze(path.join(DIR, f), Number(m[1])));
  }
  rows.sort((a, b) => a.key - b.key);
  console.log('key | peak dB | onsets | decay s |  sub | body | crack | top | verdict');
  const map: Record<number, string> = {};
  for (const r of rows) {
    const v = classify(r);
    if (!r.silent) map[r.key] = v;
    console.log(
      `${String(r.key).padStart(3)} | ${r.peakDb.toFixed(1).padStart(6)} | ${String(r.onsets).padStart(4)} | ${r.decayS.toFixed(2).padStart(6)} | ` +
      `${r.sub.toFixed(2)} | ${r.body.toFixed(2)} | ${r.crack.toFixed(2)} | ${r.top.toFixed(2)} | ${v}`,
    );
  }
  console.log(`\n${rows.filter((r) => !r.silent).length} sounding keys, ${rows.filter((r) => r.silent).length} silent; ROLLs: ${rows.filter((r) => !r.silent && r.onsets >= 3).map((r) => r.key).join(', ') || '(none)'}`);
  console.log('\ndraft map (audio-evidence; confirm voices by ear):');
  console.log(JSON.stringify(map, null, 1));
}
main();
