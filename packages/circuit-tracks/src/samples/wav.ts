/**
 * WAV codec + device-format normalizer for Circuit Tracks sample upload.
 *
 * The device wants a STANDARD WAV sent verbatim, at its native format
 * (confirmed by capture, docs/design/circuit-sample-upload.md):
 *   48000 Hz, MONO, 16-bit PCM.
 * Bounced samples that differ (e.g. the Sleep Token set is 44100 Hz) are
 * channel-folded, resampled, and re-quantized to that target here BEFORE the
 * transport sees them. PCM/integer WAV only (audioFormat 1); compressed WAV is
 * refused rather than silently mangled.
 *
 * The resampler is linear interpolation — fine for one-shot drum hits (transient
 * material), and clearly flagged. A windowed-sinc upgrade is a follow-on if a
 * tonal/sustained sample reveals aliasing.
 */

export const DEVICE_SAMPLE_RATE = 48000;
export const DEVICE_CHANNELS = 1;
export const DEVICE_BITS = 16;

export interface WavInfo {
  audioFormat: number; // 1 = PCM/integer
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Raw PCM bytes of the data chunk. */
  data: Uint8Array;
}

const tag = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Parse a RIFF/WAVE file by scanning chunks (tolerates extended headers: LIST/bext/fact before `data`). */
export function parseWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < 12 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file.');
  }
  let fmt: Omit<WavInfo, 'data'> | undefined;
  let data: Uint8Array | undefined;
  let o = 12;
  while (o + 8 <= bytes.length) {
    const id = tag(bytes, o);
    const size = u32(bytes, o + 4);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = { audioFormat: u16(bytes, body), channels: u16(bytes, body + 2), sampleRate: u32(bytes, body + 4), bitsPerSample: u16(bytes, body + 14) };
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    o = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk.');
  if (!data) throw new Error('WAV has no data chunk.');
  return { ...fmt, data };
}

/** True when the WAV is already exactly the device's target format. */
export function isDeviceFormat(w: WavInfo): boolean {
  return w.audioFormat === 1 && w.sampleRate === DEVICE_SAMPLE_RATE && w.channels === DEVICE_CHANNELS && w.bitsPerSample === DEVICE_BITS;
}

/** Decode integer PCM (8/16/24-bit, mono/stereo) to interleaved Float32 in [-1,1). */
function pcmToFloat(w: WavInfo): Float32Array {
  const { data, bitsPerSample } = w;
  const bytesPerSample = bitsPerSample >> 3;
  const n = Math.floor(data.length / bytesPerSample);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * bytesPerSample;
    if (bitsPerSample === 16) {
      out[i] = ((data[p] | (data[p + 1] << 8)) << 16 >> 16) / 32768;
    } else if (bitsPerSample === 24) {
      out[i] = ((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8 >> 8) / 8388608;
    } else if (bitsPerSample === 8) {
      out[i] = (data[p] - 128) / 128; // 8-bit WAV is unsigned
    } else {
      throw new Error(`Unsupported WAV bit depth ${bitsPerSample} (need 8/16/24).`);
    }
  }
  return out;
}

/** Fold interleaved frames to mono by averaging channels. */
function toMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += interleaved[f * channels + c];
    out[f] = s / channels;
  }
  return out;
}

/** Linear resample a mono float signal from `fromRate` to `toRate`. */
function resampleLinear(mono: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return mono;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(mono.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const a = mono[i0] ?? 0;
    const b = mono[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Build a 48 kHz mono 16-bit WAV from a mono float signal. */
function encodeDeviceWav(mono: Float32Array): Uint8Array {
  const dataLen = mono.length * 2;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const wstr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);                                  // PCM
  dv.setUint16(22, DEVICE_CHANNELS, true);
  dv.setUint32(24, DEVICE_SAMPLE_RATE, true);
  dv.setUint32(28, DEVICE_SAMPLE_RATE * DEVICE_CHANNELS * 2, true); // byte rate
  dv.setUint16(32, DEVICE_CHANNELS * 2, true);                // block align
  dv.setUint16(34, DEVICE_BITS, true);
  wstr(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < mono.length; i++) {
    const s = Math.max(-1, Math.min(1, mono[i]));
    dv.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}

export interface NormalizeResult {
  wav: Uint8Array;           // a 48k/mono/16-bit WAV ready for the device
  converted: boolean;        // false when the input was already device-format (sent verbatim)
  note: string;              // human summary of what changed
}

/**
 * Normalize any PCM WAV to the device target (48k/mono/16-bit). Returns the
 * input verbatim when it already matches, else folds/resamples/requantizes and
 * notes what changed. Refuses non-PCM (compressed) WAV.
 */
export function normalizeToDevice(bytes: Uint8Array): NormalizeResult {
  const w = parseWav(bytes);
  if (w.audioFormat !== 1) throw new Error(`WAV audioFormat ${w.audioFormat} is not PCM; export an uncompressed/PCM WAV.`);
  if (isDeviceFormat(w)) {
    return { wav: bytes, converted: false, note: 'already 48 kHz mono 16-bit; sent verbatim.' };
  }
  const mono = toMono(pcmToFloat(w), w.channels);
  const resampled = resampleLinear(mono, w.sampleRate, DEVICE_SAMPLE_RATE);
  const changes: string[] = [];
  if (w.channels !== DEVICE_CHANNELS) changes.push(`${w.channels}ch->mono`);
  if (w.sampleRate !== DEVICE_SAMPLE_RATE) changes.push(`${w.sampleRate}->${DEVICE_SAMPLE_RATE}Hz (linear resample)`);
  if (w.bitsPerSample !== DEVICE_BITS) changes.push(`${w.bitsPerSample}->16bit`);
  return { wav: encodeDeviceWav(resampled), converted: true, note: `normalized: ${changes.join(', ')}.` };
}
