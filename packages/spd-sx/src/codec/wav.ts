/**
 * Minimal RIFF/WAVE reader + canonical writer for SPD-SX wave import.
 *
 * The SPD-SX requires a plain 44.1 kHz / 16-bit PCM WAV with NO extra chunks:
 * a stray JUNK/metadata chunk is the known "acked but silent" failure mode
 * (a bouncer WAV that imported as silence had a 60-byte JUNK chunk). So on
 * import we VALIDATE the format and REWRITE the file with only `fmt ` + `data`,
 * matching `scripts/spdsx/spdsx_wave.py::canonical_wav`.
 *
 * Self-contained (does not import Circuit's resampling WAV codec): SPD-SX does
 * format-passthrough + chunk-strip, not Circuit's 48k-mono resample.
 */

export const REQUIRED_RATE = 44100;
export const REQUIRED_BITS = 16;

export interface WavData {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  audioFormat: number; // 1 = PCM
  /** Raw PCM bytes of the data chunk. */
  data: Uint8Array;
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Parse a RIFF/WAVE file by scanning chunks (tolerates LIST/JUNK/fact/bext before `data`). */
export function parseWav(bytes: Uint8Array): WavData {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let fmt: Omit<WavData, 'data'> | undefined;
  let data: Uint8Array | undefined;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(bytes, o);
    const size = u32(bytes, o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: u16(bytes, body),
        channels: u16(bytes, body + 2),
        sampleRate: u32(bytes, body + 4),
        bitsPerSample: u16(bytes, body + 14),
      };
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    o = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (!data) throw new Error('WAV has no data chunk');
  return { ...fmt, data };
}

/** Build a clean canonical WAV (fmt + data only) from a parsed source. */
export function canonicalWavBytes(w: WavData): Uint8Array {
  const dataLen = w.data.length;
  const byteRate = (w.sampleRate * w.channels * w.bitsPerSample) / 8;
  const blockAlign = (w.channels * w.bitsPerSample) / 8;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const ascii = (s: string, o: number) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  ascii('RIFF', 0);
  dv.setUint32(4, 36 + dataLen, true);
  ascii('WAVE', 8);
  ascii('fmt ', 12);
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, w.channels, true);
  dv.setUint32(24, w.sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, w.bitsPerSample, true);
  ascii('data', 36);
  dv.setUint32(40, dataLen, true);
  out.set(w.data, 44);
  return out;
}

// ── Normalize-on-upload: resample + requantize any PCM WAV to 44.1k/16 ────────
//
// The SPD-SX wants 44.1 kHz / 16-bit. Rather than refuse other formats (which
// forced a manual pre-convert + re-download), we normalize on upload the way
// Circuit's sample upload does. Channel count is PRESERVED (the SPD-SX accepts
// mono AND stereo waves), unlike Circuit which folds to mono. Resampling is
// linear interpolation: fine for drum one-shots, adequate for most material;
// for tonal/sustained samples a pre-convert (bouncer / ffmpeg) is higher quality.

const u8ToView = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

/** Decode a PCM/float WAV into one Float32Array per channel, in [-1, 1). */
function decodeChannels(w: WavData): Float32Array[] {
  const { data, bitsPerSample, channels, audioFormat } = w;
  const bytesPer = bitsPerSample >> 3;
  if (bytesPer === 0) throw new Error(`bad bit depth ${bitsPerSample}`);
  const frames = Math.floor(data.length / (bytesPer * channels));
  const dv = u8ToView(data);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bytesPer;
      let v: number;
      if (audioFormat === 3 && bitsPerSample === 32) v = dv.getFloat32(p, true);
      else if (bitsPerSample === 16) v = dv.getInt16(p, true) / 32768;
      else if (bitsPerSample === 24) v = (((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8) >> 8) / 8388608;
      else if (bitsPerSample === 32) v = dv.getInt32(p, true) / 2147483648; // 32-bit int PCM
      else if (bitsPerSample === 8) v = (data[p] - 128) / 128; // 8-bit WAV is unsigned
      else throw new Error(`unsupported WAV bit depth ${bitsPerSample} (need 8/16/24/32 int or 32 float)`);
      out[c][f] = v;
    }
  }
  return out;
}

/** Linear resample one channel from `fromRate` to `toRate`. */
function resampleChannel(sig: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || sig.length === 0) return sig; // empty stays empty (no phantom frame)
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(sig.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const a = sig[i0] ?? 0;
    const b = sig[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Encode per-channel float signals to an interleaved 44.1k/16-bit PCM WAV. */
function encodeSpdsxWav(channels: Float32Array[]): Uint8Array {
  const ch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataLen = frames * ch * 2;
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const ascii = (s: string, o: number) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ascii('RIFF', 0); dv.setUint32(4, 36 + dataLen, true); ascii('WAVE', 8);
  ascii('fmt ', 12); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, ch, true);
  dv.setUint32(24, REQUIRED_RATE, true);
  dv.setUint32(28, REQUIRED_RATE * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, REQUIRED_BITS, true);
  ascii('data', 36); dv.setUint32(40, dataLen, true);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][f]));
      dv.setInt16(44 + (f * ch + c) * 2, Math.round(s * 32767), true);
    }
  }
  return out;
}

export interface NormalizeResult {
  /** A clean 44.1k/16-bit PCM WAV (fmt + data only), ready for the device. */
  bytes: Uint8Array;
  /** False when the input was already 44.1k/16 PCM (only chunk-stripped). */
  converted: boolean;
  /** Human summary of what changed (empty when not converted). */
  note: string;
}

/**
 * Normalize any PCM/float WAV to the SPD-SX target (44.1 kHz / 16-bit, channels
 * preserved). Already-target input is just chunk-stripped (converted: false);
 * otherwise it is resampled + requantized. Throws only on a WAV we cannot decode.
 */
export function normalizeToSpdsx(bytes: Uint8Array, label = 'wav'): NormalizeResult {
  let w: WavData;
  try {
    w = parseWav(bytes);
  } catch (e) {
    throw new Error(`${label}: not a decodable WAV (${e instanceof Error ? e.message : String(e)})`);
  }
  if (w.audioFormat !== 1 && w.audioFormat !== 3) {
    throw new Error(`${label}: SPD-SX needs an uncompressed PCM/float WAV (audioFormat 1 or 3), got ${w.audioFormat}`);
  }
  // IEEE float (audioFormat 3) is only defined for 32-bit samples here; a
  // mislabeled non-32-bit float would otherwise fall through to the int decode
  // and read garbage. (64-bit float has no decoder and is rejected downstream.)
  if (w.audioFormat === 3 && w.bitsPerSample !== 32) {
    throw new Error(`${label}: float WAV must be 32-bit, got ${w.bitsPerSample}-bit`);
  }
  if (w.audioFormat === 1 && w.sampleRate === REQUIRED_RATE && w.bitsPerSample === REQUIRED_BITS) {
    return { bytes: canonicalWavBytes(w), converted: false, note: '' }; // already target; just strip chunks
  }
  const resampled = decodeChannels(w).map((sig) => resampleChannel(sig, w.sampleRate, REQUIRED_RATE));
  const changes: string[] = [];
  if (w.sampleRate !== REQUIRED_RATE) changes.push(`${w.sampleRate}->${REQUIRED_RATE}Hz (linear resample)`);
  if (w.bitsPerSample !== REQUIRED_BITS || w.audioFormat === 3) changes.push(`${w.audioFormat === 3 ? 'float32' : `${w.bitsPerSample}-bit`}->16-bit`);
  return { bytes: encodeSpdsxWav(resampled), converted: true, note: `resampled/requantized: ${changes.join(', ')} (${w.channels === 1 ? 'mono' : `${w.channels}ch`} preserved)` };
}
