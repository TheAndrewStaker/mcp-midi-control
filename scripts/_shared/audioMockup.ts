/**
 * audioMockup — shared helpers for assembling song-level audio mockups from
 * baked one-shot / roll samples (offline, no MIDI device). Extracted from
 * scripts/gethsemane-full-beat.ts after that script's first full-beat render
 * exposed a loop-seam comb-filter bug (2026-07-04): a fresh hi-hat hit landed
 * on top of a still-ringing crescendo fill from the previous bar, and two
 * overlapping copies of the same-family sample source is audible as phasing.
 *
 * The fix (chokeSampleFamily) generalizes the same principle already used
 * INSIDE individual baked figures (a real strike physically damps whatever
 * of the same instrument is still ringing) to the whole song assembly: any
 * placement tagged with a `family` gets truncated + faded when a later
 * same-family placement's onset would otherwise overlap it. Any future
 * per-song full-beat render (Like That, etc.) should import this instead of
 * re-deriving the choke pass — the bug is easy to reintroduce because it only
 * shows up at specific overlaps (loop seams, adjacent fills), not on casual
 * listening to an isolated figure.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface Wav { rate: number; samples: Float32Array }

export function readWav(file: string): Wav {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: not a WAV`);
  }
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
  if (!data || rate === 0) throw new Error(`${file}: no fmt/data chunk`);
  const bytesPer = bits / 8;
  const frames = Math.floor(data.length / bytesPer / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) {
      const off = (i * channels + c) * bytesPer;
      v += bits === 16 ? data.readInt16LE(off) / 32768
        : bits === 24 ? (((data[off] | (data[off + 1] << 8) | (data[off + 2] << 16)) << 8) >> 8) / 8388608
          : data.readInt32LE(off) / 2147483648;
    }
    out[i] = v / channels;
  }
  return { rate, samples: out };
}

export function writeWavMono16(file: string, rate: number, samples: Float64Array): { peak: number; normalized: boolean } {
  let peak = 0;
  for (const s of samples) { const a = Math.abs(s); if (a > peak) peak = a; }
  let scale = 1;
  let normalized = false;
  if (peak > 0.99) { scale = 0.99 / peak; normalized = true; }

  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * scale));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
  return { peak: peak * scale, normalized };
}

export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

export interface Placement { atMs: number; wav: Wav; gain: number; family?: string }

const CHOKE_FADE_MS = 15;

/**
 * A fresh strike physically damps whatever of the SAME instrument family is
 * still ringing (e.g. a hi-hat strike damps a ringing hi-hat texture — the
 * same acoustic fact synthRoll-style figure builders already model inside a
 * single baked figure). At song-assembly scale this matters most at loop
 * seams and adjacent fills: a long fill can still be ringing when the next
 * bar's fresh hit of the same family lands. Two overlapping copies of a
 * correlated sample source, offset in time, is a comb filter — audible as
 * "phasing." This truncates any `family`-tagged placement's audible length
 * (with a short fade) to end at the next same-family onset, so a fresh hit
 * always silences whatever came before it in that family. Placements with no
 * `family` (or a unique one) are left untouched — only apply a family tag to
 * sample groups that share correlated spectral content (e.g. all hi-hat
 * articulations), not across unrelated instruments (kick vs. hat has no comb
 * risk and should NOT share a family).
 */
export function chokeSampleFamily(placements: Placement[], rate: number, family: string): Placement[] {
  const events = placements
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.family === family)
    .sort((a, b) => a.p.atMs - b.p.atMs);

  const out = placements.slice();
  for (let n = 0; n < events.length - 1; n++) {
    const cur = events[n].p;
    const next = events[n + 1].p;
    const gapMs = next.atMs - cur.atMs;
    const naturalLenMs = (cur.wav.samples.length / rate) * 1000;
    if (gapMs >= naturalLenMs) continue; // no overlap, nothing to choke
    const fade = Math.round((CHOKE_FADE_MS / 1000) * rate);
    const ringLen = Math.max(fade * 2, Math.round((gapMs / 1000) * rate));
    const src = cur.wav.samples;
    const trimmed = new Float32Array(Math.min(ringLen, src.length));
    const fadeStart = Math.max(0, trimmed.length - fade);
    for (let i = 0; i < trimmed.length; i++) {
      const env = i < fadeStart ? 1 : 1 - (i - fadeStart) / fade;
      trimmed[i] = src[i] * env;
    }
    out[events[n].i] = { ...cur, wav: { rate, samples: trimmed } };
  }
  return out;
}

export function mix(rate: number, placements: Placement[], totalMs: number): Float64Array {
  const totalLen = Math.round((totalMs / 1000) * rate);
  const buf = new Float64Array(totalLen);
  for (const p of placements) {
    if (p.wav.rate !== rate) throw new Error('sample-rate mismatch in mix()');
    const start = Math.round((p.atMs / 1000) * rate);
    for (let i = 0; i < p.wav.samples.length; i++) {
      const at = start + i;
      if (at < 0 || at >= buf.length) continue;
      buf[at] += p.wav.samples[i] * p.gain;
    }
  }
  return buf;
}
