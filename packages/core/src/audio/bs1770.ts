/**
 * ITU-R BS.1770-4 loudness measurement, dependency-free.
 *
 * Implements the full measurement chain: K-weighting (two fixed biquads:
 * stage 1 high-shelf, stage 2 RLB high-pass), 400 ms momentary blocks at
 * 75% overlap, and the two-stage gate (absolute -70 LUFS, then relative
 * -10 LU) for integrated loudness. True peak is the BS.1770-4 Annex 2
 * approach: 4x oversampling through a polyphase windowed-sinc
 * interpolator, peak over the interpolated samples.
 *
 * Coefficients are computed from the published filter parameterization so
 * any sample rate works; at 48 kHz they reproduce the BS.1770-4 table
 * values exactly (golden-checked in scripts/verify-bs1770.ts against the
 * spec constants and cross-checked against ffmpeg's ebur128 filter).
 *
 * Channel model: mono ([x]) or stereo ([L, R]), both weighted 1.0 per
 * BS.1770 (we never see surround channels from a guitar rig capture).
 * Note the standard's mono convention: a single channel measured alone
 * reads ~3 LU lower than the same signal duplicated on L+R. Callers doing
 * scene-to-scene deltas are unaffected (the offset cancels).
 */

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface Bs1770Result {
  /** Gated integrated loudness, LUFS. `null` when no block passed the absolute gate (silence). */
  lufsIntegrated: number | null;
  /** Loudest 400 ms momentary block, LUFS. `null` on silence. */
  lufsMomentaryMax: number | null;
  /** True peak (4x oversampled), dBTP. */
  truePeakDbtp: number;
  /** Raw sample peak, dBFS (no oversampling). */
  samplePeakDbfs: number;
  /** Momentary blocks that survived BOTH gates (what integrated loudness averaged over). */
  gatedBlockCount: number;
  /** Total momentary blocks in the capture. */
  totalBlockCount: number;
}

const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;
const BLOCK_MS = 400;
const BLOCK_OVERLAP = 0.75;

/**
 * Stage 1 K-weighting pre-filter (high shelf). Parameterization reproduces
 * the BS.1770-4 published 48 kHz coefficient table (b0=1.53512485958697...).
 */
export function kWeightingStage1(sampleRate: number): BiquadCoefficients {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Stage 2 K-weighting RLB high-pass. Same 48 kHz-table-exact property as stage 1. */
export function kWeightingStage2(sampleRate: number): BiquadCoefficients {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;

  const k = Math.tan((Math.PI * f0) / sampleRate);
  const a0 = 1 + k / q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** Direct-form-II-transposed biquad over a copy of the input. */
function biquad(input: Float64Array, c: BiquadCoefficients): Float64Array {
  const out = new Float64Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = c.b0 * x + z1;
    z1 = c.b1 * x - c.a1 * y + z2;
    z2 = c.b2 * x - c.a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * 4x-oversampled true peak of one channel, linear (not dB).
 *
 * Polyphase windowed-sinc interpolator: 4 phases x 12 taps (48-tap
 * prototype, Blackman window, cutoff at the original Nyquist). Phase 0 is
 * the identity tap set, so the raw sample peak is always included.
 */
function truePeakLinear(channel: Float64Array): number {
  const PHASES = 4;
  const TAPS_PER_PHASE = 12;
  const N = PHASES * TAPS_PER_PHASE;
  const center = (N - 1) / 2;

  // Prototype lowpass: sinc at the upsampled rate with cutoff pi/PHASES,
  // scaled by PHASES so each polyphase branch has unity DC-ish gain.
  const proto = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const t = n - center;
    const sinc = t === 0 ? 1 : Math.sin((Math.PI * t) / PHASES) / ((Math.PI * t) / PHASES);
    // Blackman window
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * n) / (N - 1)) +
      0.08 * Math.cos((4 * Math.PI * n) / (N - 1));
    proto[n] = sinc * w;
  }

  let peak = 0;
  for (let i = 0; i < channel.length; i++) {
    for (let p = 0; p < PHASES; p++) {
      let acc = 0;
      for (let k = 0; k < TAPS_PER_PHASE; k++) {
        const idx = i - k;
        if (idx >= 0) acc += channel[idx] * proto[k * PHASES + p];
      }
      const mag = Math.abs(acc);
      if (mag > peak) peak = mag;
    }
    // Raw sample too (phase alignment means the identity sample is only
    // approximated by the FIR; take the max of both).
    const raw = Math.abs(channel[i]);
    if (raw > peak) peak = raw;
  }
  return peak;
}

function meanSquare(x: Float64Array, start: number, len: number): number {
  let acc = 0;
  for (let i = start; i < start + len; i++) acc += x[i] * x[i];
  return acc / len;
}

const toDb = (linear: number): number => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);

/**
 * Measure a deinterleaved capture. `channels` is 1 (mono) or 2 (stereo)
 * equal-length arrays; every channel is weighted 1.0.
 */
export function measureBs1770(
  channels: readonly Float64Array[],
  sampleRate: number,
): Bs1770Result {
  if (channels.length === 0 || channels.length > 2) {
    throw new Error(`measureBs1770 expects 1 or 2 channels, got ${channels.length}`);
  }
  const length = channels[0].length;
  for (const ch of channels) {
    if (ch.length !== length) throw new Error('measureBs1770: channel length mismatch');
  }

  const stage1 = kWeightingStage1(sampleRate);
  const stage2 = kWeightingStage2(sampleRate);
  const weighted = channels.map((ch) => biquad(biquad(ch, stage1), stage2));

  // Momentary blocks: 400 ms, 75% overlap (100 ms hop).
  const blockLen = Math.round((BLOCK_MS / 1000) * sampleRate);
  const hop = Math.max(1, Math.round(blockLen * (1 - BLOCK_OVERLAP)));
  const blockPowers: number[] = [];
  for (let start = 0; start + blockLen <= length; start += hop) {
    let power = 0;
    for (const ch of weighted) power += meanSquare(ch, start, blockLen);
    blockPowers.push(power);
  }

  const blockLoudness = (power: number): number =>
    power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;

  let momentaryMax: number | null = null;
  for (const p of blockPowers) {
    const l = blockLoudness(p);
    if (l > ABSOLUTE_GATE_LUFS && (momentaryMax === null || l > momentaryMax)) momentaryMax = l;
  }

  // Two-stage gate for integrated loudness.
  const aboveAbsolute = blockPowers.filter((p) => blockLoudness(p) > ABSOLUTE_GATE_LUFS);
  let integrated: number | null = null;
  let gatedCount = 0;
  if (aboveAbsolute.length > 0) {
    const meanAbs = aboveAbsolute.reduce((a, b) => a + b, 0) / aboveAbsolute.length;
    const relativeGate = blockLoudness(meanAbs) + RELATIVE_GATE_LU;
    const gated = aboveAbsolute.filter((p) => blockLoudness(p) > relativeGate);
    if (gated.length > 0) {
      const meanGated = gated.reduce((a, b) => a + b, 0) / gated.length;
      integrated = blockLoudness(meanGated);
      gatedCount = gated.length;
    }
  }

  let truePeak = 0;
  let samplePeak = 0;
  for (const ch of channels) {
    const tp = truePeakLinear(ch);
    if (tp > truePeak) truePeak = tp;
    for (let i = 0; i < ch.length; i++) {
      const mag = Math.abs(ch[i]);
      if (mag > samplePeak) samplePeak = mag;
    }
  }

  return {
    lufsIntegrated: integrated,
    lufsMomentaryMax: momentaryMax,
    truePeakDbtp: toDb(truePeak),
    samplePeakDbfs: toDb(samplePeak),
    gatedBlockCount: gatedCount,
    totalBlockCount: blockPowers.length,
  };
}
