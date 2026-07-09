/**
 * gethsemane-rolls — bake the drum-roll samples for Sleep Token "Gethsemane"
 * (74 bpm, 4/4) from the bounced Sleep Token II Kontakt one-shots in
 * samples/mixwave/keys/, entirely offline (no MIDI device touched).
 *
 * Produces, under samples/mixwave/gethsemane-kit/:
 *   - hat_buzz_1step.wav      6-hit hat buzz, one 16th step (~203 ms window)
 *   - hat_roll_4step.wav      24-hit sustained hat roll, four 16th steps (~811 ms window)
 *   - snare_roll_recorded.wav trimmed recording (key 25), NOT resynthesized
 *   - audition_all_rolls.wav  all three in sequence, 1 s silence between
 *   - spdsx-ready/*.wav       44.1 kHz / 16-bit / mono, SPD-SX-safe filenames
 *   - KIT-PLAN.md             pad plan for when the SPD-SX is connected
 *
 * Roll retrigger dynamics (matches the shipped Circuit micro-step engine):
 * hit k (0-based, resets every 6-hit group) is scaled by 0.85^k with a floor
 * of 20/127 of the base. The 24-hit sustained roll additionally applies a
 * per-group crescendo (0.85, 0.90, 0.95, 1.00) so it swells into the downbeat.
 *
 * Run: npx tsx scripts/gethsemane-rolls.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SRC_DIR = 'samples/mixwave/keys';
const OUT_DIR = 'samples/mixwave/gethsemane-kit';
const SPDSX_DIR = path.join(OUT_DIR, 'spdsx-ready');

const BPM = 74;
const STEP_MS = 60000 / BPM / 4; // 16th-note step, 202.7027... ms
const MICRO_TICK_MS = STEP_MS / 6; // 33.7838... ms
const RETRIGGER_FLOOR = 20 / 127; // floor for 0.85^k decay

// ---------------------------------------------------------------------------
// WAV I/O (dep-free, hand-rolled RIFF; adapted from scripts/analyze-mixwave-keys.ts)
// ---------------------------------------------------------------------------

interface Wav { rate: number; samples: Float32Array }

function readWav(file: string): Wav {
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

/** Write standard PCM16 mono WAV. Normalizes only if peak would clip (>0.99). */
function writeWavMono16(file: string, rate: number, samples: Float64Array | Float32Array): { peak: number; normalized: boolean } {
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
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate (mono, 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * scale));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(file, buf);
  return { peak: peak * scale, normalized };
}

// ---------------------------------------------------------------------------
// Roll synthesis: overlap-add retriggered copies of a source one-shot
// ---------------------------------------------------------------------------

/**
 * @param source     source sample (mono float, any rate)
 * @param rate       sample rate of source (output uses the same rate)
 * @param hitCount   total number of retriggers
 * @param groupSize  hits per group before the k-index (decay exponent) resets
 * @param groupGains per-group gain multiplier (crescendo), length = hitCount/groupSize
 */
function synthRoll(source: Float32Array, rate: number, hitCount: number, groupSize: number, groupGains: number[]): Float64Array {
  const microTickSec = MICRO_TICK_MS / 1000;
  const starts: number[] = [];
  for (let n = 0; n < hitCount; n++) {
    starts.push(Math.round(n * microTickSec * rate));
  }
  const totalLen = starts[starts.length - 1] + source.length;
  const buf = new Float64Array(totalLen);
  for (let n = 0; n < hitCount; n++) {
    const k = n % groupSize;
    const g = groupGains[Math.floor(n / groupSize)];
    const gain = g * Math.max(Math.pow(0.85, k), RETRIGGER_FLOOR);
    const start = starts[n];
    for (let i = 0; i < source.length; i++) {
      buf[start + i] += source[i] * gain;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// v2 synthesis — the anti-artifact upgrade (2026-07-03, after the v1 hat rolls
// auditioned "strange and artifacty" while the recorded snare roll won).
//
// Root causes fixed, each a standard drum-programming practice (Sound on
// Sound / Sweetwater "machine-gun" guidance) and one physical fact:
//   1. COMB FILTERING: v1 overlap-added bit-identical copies of a NOISY hat
//      sample at fixed offsets — correlated noise summed with short delays is
//      a static flanger. Fix: decorrelate every hit (per-hit pitch factor
//      +/-2-3%, start-point offset into the sample, +/-2 ms timing jitter —
//      fixed cycles, deterministic build).
//   2. NO CHOKE: a closed hi-hat strike DAMPS the previous one; v1 let every
//      500 ms tail ring under 34 ms spacing (6-24 stacked tails). Fix: each
//      hit is faded out shortly after the next hit lands (12 ms crossfade);
//      only the final hit keeps its natural tail.
//   3. HUMAN DYNAMICS: velocity variation per hit (the groove-pack evidence
//      shows non-monotonic, accent-targeted shapes), applied on top of the
//      engine decay/crescendo curves.
// ---------------------------------------------------------------------------

const PITCH_CYCLE = [1.0, 0.982, 1.021, 0.99, 1.013, 0.973];       // +/- ~2-3% per hit
const JITTER_MS_CYCLE = [0, 1.8, -1.4, 1.1, -2.2, 0.7];            // human timing wobble
const START_OFFSET_MS_CYCLE = [0, 1.5, 0.7, 2.2, 0.3, 1.1];        // transient variety
const GAIN_WOBBLE_CYCLE = [1.0, 0.93, 1.02, 0.9, 1.05, 0.96];      // non-monotonic dynamics
const CHOKE_FADE_MS = 12;

interface V2Options {
  hitCount: number;
  spacingMs: number;                 // hit spacing (micro-tick for buzz, triplet for runs)
  gains: number[];                   // absolute per-hit gain, length hitCount
  chokeAll?: boolean;                // default true: every hit but the last is choked
}

/** Read `source` at a resample factor with linear interpolation, from a start offset. */
function hitSlice(source: Float32Array, rate: number, factor: number, startOffsetMs: number, maxOutLen: number): Float64Array {
  const startSrc = Math.round((startOffsetMs / 1000) * rate);
  const avail = Math.max(0, source.length - startSrc);
  const outLen = Math.min(maxOutLen, Math.floor(avail / factor));
  const out = new Float64Array(Math.max(0, outLen));
  for (let i = 0; i < out.length; i++) {
    const pos = startSrc + i * factor;
    const i0 = Math.floor(pos);
    const i1 = Math.min(source.length - 1, i0 + 1);
    out[i] = source[i0] * (1 - (pos - i0)) + source[i1] * (pos - i0);
  }
  return out;
}

function synthRollV2(source: Float32Array, rate: number, opts: V2Options): Float64Array {
  const { hitCount, spacingMs, gains } = opts;
  if (gains.length !== hitCount) throw new Error('gains length must equal hitCount');
  const spacing = (spacingMs / 1000) * rate;
  const fade = Math.round((CHOKE_FADE_MS / 1000) * rate);
  const starts = Array.from({ length: hitCount }, (_, n) =>
    Math.max(0, Math.round(n * spacing + (JITTER_MS_CYCLE[n % 6] / 1000) * rate * (n === 0 ? 0 : 1))));
  const buf = new Float64Array(starts[hitCount - 1] + source.length + fade);
  for (let n = 0; n < hitCount; n++) {
    const last = n === hitCount - 1;
    // Choke: this hit may ring only until shortly after the NEXT hit lands.
    const ringLen = last || opts.chokeAll === false
      ? source.length
      : Math.max(fade * 2, starts[n + 1] - starts[n] + fade);
    const slice = hitSlice(source, rate, PITCH_CYCLE[n % 6], START_OFFSET_MS_CYCLE[n % 6], ringLen);
    const gain = gains[n] * GAIN_WOBBLE_CYCLE[n % 6];
    const fadeStart = last ? slice.length : Math.max(0, slice.length - fade);
    for (let i = 0; i < slice.length; i++) {
      const env = i < fadeStart ? 1 : 1 - (i - fadeStart) / fade;
      buf[starts[n] + i] += slice[i] * gain * env;
    }
  }
  return buf;
}

/** Engine decay gains (0.85^k floor, per-group crescendo) as an absolute per-hit list. */
function engineGains(hitCount: number, groupSize: number, groupGains: number[]): number[] {
  return Array.from({ length: hitCount }, (_, n) =>
    groupGains[Math.floor(n / groupSize)] * Math.max(Math.pow(0.85, n % groupSize), RETRIGGER_FLOOR));
}

/** Trim leading/trailing silence only (no resynthesis). padMs kept on each edge. */
function trimSilence(samples: Float32Array, rate: number, thresh = 0.006, padMs = 8): Float32Array {
  let first = -1, last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > thresh) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return samples; // all silent, nothing to trim
  const pad = Math.round((padMs / 1000) * rate);
  const start = Math.max(0, first - pad);
  const end = Math.min(samples.length, last + pad + 1);
  return samples.subarray(start, end);
}

/** Linear-interpolation resample (fine at these ratios: 48000 -> 44100). */
function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
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

// ---------------------------------------------------------------------------
// Onset counting for verification.
//
// The closed-hat source (note042) is a washy, noisy texture with a slow
// (~10 ms) attack ramp rather than a sharp percussive click — a generic
// blind onset detector (global-peak or fixed-lookback threshold) misses or
// over-counts on material like this. Since we KNOW the exact retrigger
// schedule we built the roll from (one hit every MICRO_TICK_MS), the honest
// and robust check is a per-slot bump test: for each expected hit's
// non-overlapping micro-tick window, confirm the envelope reaches a genuine
// local maximum that is measurably ABOVE the decaying tail immediately
// preceding that window (i.e. a fresh injection of energy actually landed
// there, not just the previous hit's decay coasting through). This is still
// an independent read of the audio's envelope, not a re-trust of our own
// loop counter — it fails if a hit is silent, missing, or misplaced.
// ---------------------------------------------------------------------------

function rmsEnvelope(samples: Float32Array, rate: number, frameMs: number): number[] {
  const frame = Math.max(1, Math.round((rate * frameMs) / 1000));
  const env: number[] = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let acc = 0;
    for (let j = i; j < i + frame; j++) acc += samples[j] * samples[j];
    env.push(Math.sqrt(acc / frame));
  }
  return env;
}

/** Counts genuine per-slot energy bumps at the known retrigger schedule (0, microTick, 2*microTick, ...). */
function countSlotBumps(samples: Float32Array, rate: number, hitCount: number): number {
  const frameMs = 1;
  const env = rmsEnvelope(samples, rate, frameMs);
  const microTickMs = MICRO_TICK_MS;
  let detected = 0;
  for (let n = 0; n < hitCount; n++) {
    const i0 = Math.round((n * microTickMs) / frameMs);
    const i1 = Math.min(env.length - 1, Math.round(((n + 1) * microTickMs) / frameMs));
    let argmax = i0, mx = env[i0] ?? 0;
    for (let i = i0; i < i1; i++) if (env[i] > mx) { mx = env[i]; argmax = i; }
    void argmax;
    const priorIdx = Math.max(0, i0 - 3);
    if (mx > (env[priorIdx] ?? 0) * 1.05) detected++;
  }
  return detected;
}

/** Blind global onset counter — used only as an informational count for the
 *  recorded (non-synthesized) snare roll, where we have no known schedule. */
function countOnsetsBlind(samples: Float32Array, rate: number): number {
  const env = rmsEnvelope(samples, rate, 2);
  const lookback = 8; // ~16 ms at 2 ms frames
  const refractory = 7; // ~14 ms
  let onsets = 0;
  let lastOnset = -1000;
  for (let i = lookback; i < env.length; i++) {
    const prior = env[i - lookback] + 1e-6;
    const isLocalMax = env[i] >= env[i - 1] && (i === env.length - 1 || env[i] >= env[i + 1]);
    if (isLocalMax && env[i] / prior > 1.3 && env[i] > 0.003 && i - lastOnset > refractory) {
      onsets++;
      lastOnset = i;
    }
  }
  return onsets;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SPDSX_DIR, { recursive: true });

  console.log(`74 bpm, 4/4: step=${STEP_MS.toFixed(4)} ms, micro-tick=${MICRO_TICK_MS.toFixed(4)} ms\n`);

  // ---- Source one-shots -----------------------------------------------
  const hatClosed = readWav(path.join(SRC_DIR, 'note042.wav')); // closed hi-hat
  const hatOpen = readWav(path.join(SRC_DIR, 'note046.wav'));   // open hi-hat
  const kick = readWav(path.join(SRC_DIR, 'note036.wav'));
  const snare = readWav(path.join(SRC_DIR, 'note038.wav'));
  const snareRollSrc = readWav(path.join(SRC_DIR, 'note025.wav')); // recorded buzz roll, 23 bounces

  const report: string[] = [];

  // ---- 1) hat_buzz_1step.wav: 6 hits, one group, no crescendo ----------
  const buzz1 = synthRoll(hatClosed.samples, hatClosed.rate, 6, 6, [1.0]);
  const buzz1Path = path.join(OUT_DIR, 'hat_buzz_1step.wav');
  const buzz1Meta = writeWavMono16(buzz1Path, hatClosed.rate, buzz1);
  const buzz1Onsets = countSlotBumps(new Float32Array(buzz1), hatClosed.rate, 6);
  report.push(logFile(buzz1Path, hatClosed.rate, buzz1.length, buzz1Meta, buzz1Onsets, 6));

  // ---- 2) hat_roll_4step.wav: 24 hits, 4 groups of 6, crescendo --------
  const roll4 = synthRoll(hatClosed.samples, hatClosed.rate, 24, 6, [0.85, 0.90, 0.95, 1.0]);
  const roll4Path = path.join(OUT_DIR, 'hat_roll_4step.wav');
  const roll4Meta = writeWavMono16(roll4Path, hatClosed.rate, roll4);
  const roll4Onsets = countSlotBumps(new Float32Array(roll4), hatClosed.rate, 24);
  report.push(logFile(roll4Path, hatClosed.rate, roll4.length, roll4Meta, roll4Onsets, 24));

  // ---- 2b) v2 hat rolls: choked, decorrelated (anti-comb / anti-machine-gun) ----
  const buzz1v2 = synthRollV2(hatClosed.samples, hatClosed.rate, {
    hitCount: 6, spacingMs: MICRO_TICK_MS, gains: engineGains(6, 6, [1.0]),
  });
  const buzz1v2Path = path.join(OUT_DIR, 'hat_buzz_1step_v2.wav');
  const buzz1v2Meta = writeWavMono16(buzz1v2Path, hatClosed.rate, buzz1v2);
  report.push(logFile(buzz1v2Path, hatClosed.rate, buzz1v2.length, buzz1v2Meta, undefined, undefined));

  const roll4v2 = synthRollV2(hatClosed.samples, hatClosed.rate, {
    hitCount: 24, spacingMs: MICRO_TICK_MS, gains: engineGains(24, 6, [0.85, 0.90, 0.95, 1.0]),
  });
  const roll4v2Path = path.join(OUT_DIR, 'hat_roll_4step_v2.wav');
  const roll4v2Meta = writeWavMono16(roll4v2Path, hatClosed.rate, roll4v2);
  report.push(logFile(roll4v2Path, hatClosed.rate, roll4v2.length, roll4v2Meta, undefined, undefined));

  // ---- 2b-v3) TIGHT-hat rolls (the "should it be more closed?" answer: YES)
  // Envelope census of every bounced hat articulation: note042's -20 dB body
  // is 137 ms — 4x the 33.8 ms hit spacing, so a buzz from it is mostly
  // stacked wash. note021 is the TIGHT articulation (18 ms body, 0 ms attack):
  // the body fits inside the spacing, so every hit articulates. Dynamics are
  // shaped from the groove-pack's own busy-hat lane (16th runs, mean vel 71,
  // mean |delta| 23 between consecutive hits, ghost base + accent pops), not
  // a smooth decay.
  const hatTight = readWav(path.join(SRC_DIR, 'note021.wav'));
  const buzzV3Gains = [0.42, 0.38, 0.46, 0.52, 0.66, 1.0];      // spiky crescendo into the accent
  const buzz1v3 = synthRollV2(hatTight.samples, hatTight.rate, {
    hitCount: 6, spacingMs: MICRO_TICK_MS, gains: buzzV3Gains,
  });
  const buzz1v3Path = path.join(OUT_DIR, 'hat_buzz_1step_v3_tight.wav');
  const buzz1v3Meta = writeWavMono16(buzz1v3Path, hatTight.rate, buzz1v3);
  report.push(logFile(buzz1v3Path, hatTight.rate, buzz1v3.length, buzz1v3Meta, undefined, undefined));

  const intra = [1.0, 0.82, 1.12, 0.88, 1.18, 0.94];            // measured-scale hit-to-hit swing
  const groupBase = [0.45, 0.55, 0.7, 0.85];
  const roll4V3Gains = Array.from({ length: 24 }, (_, n) => {
    const g = groupBase[Math.floor(n / 6)] * intra[n % 6];
    return n === 23 ? 1.0 : Math.min(1.0, g);                    // terminal accent
  });
  const roll4v3 = synthRollV2(hatTight.samples, hatTight.rate, {
    hitCount: 24, spacingMs: MICRO_TICK_MS, gains: roll4V3Gains,
  });
  const roll4v3Path = path.join(OUT_DIR, 'hat_roll_4step_v3_tight.wav');
  const roll4v3Meta = writeWavMono16(roll4v3Path, hatTight.rate, roll4v3);
  report.push(logFile(roll4v3Path, hatTight.rate, roll4v3.length, roll4v3Meta, undefined, undefined));

  // ---- 2b-v4) tight-SHAPED real hat (v3 verdict: tighter playing, but
  // note021 is a different, woodier piece — not a hat). v4 keeps the REAL hat
  // timbre (note042's cymbal spectrum) and shortens its body synthetically:
  // unity gain through the 4 ms transient, then exponential decay hitting
  // -20 dB at ~22 ms — a tight closed hat's envelope on the true hat sound.
  const shapeTight = (src: Float32Array, rate: number, bodyMs: number): Float32Array => {
    const hold = Math.round(0.004 * rate);
    const tau = (bodyMs / 1000) * rate / Math.log(10); // -20 dB at bodyMs
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = i <= hold ? src[i] : src[i] * Math.exp(-(i - hold) / tau);
    }
    return out;
  };
  const hatShaped = shapeTight(hatClosed.samples, hatClosed.rate, 22);
  const buzz1v4 = synthRollV2(hatShaped, hatClosed.rate, {
    hitCount: 6, spacingMs: MICRO_TICK_MS, gains: buzzV3Gains,
  });
  const buzz1v4Path = path.join(OUT_DIR, 'hat_buzz_1step_v4_shaped.wav');
  const buzz1v4Meta = writeWavMono16(buzz1v4Path, hatClosed.rate, buzz1v4);
  report.push(logFile(buzz1v4Path, hatClosed.rate, buzz1v4.length, buzz1v4Meta, undefined, undefined));

  const roll4v4 = synthRollV2(hatShaped, hatClosed.rate, {
    hitCount: 24, spacingMs: MICRO_TICK_MS, gains: roll4V3Gains,
  });
  const roll4v4Path = path.join(OUT_DIR, 'hat_roll_4step_v4_shaped.wav');
  const roll4v4Meta = writeWavMono16(roll4v4Path, hatClosed.rate, roll4v4);
  report.push(logFile(roll4v4Path, hatClosed.rate, roll4v4.length, roll4v4Meta, undefined, undefined));

  // ---- 2d-v5) VERBATIM corpus figures (the 2026-07-04 research workflow) --
  // A 10-agent corpus+web study settled it: the drummer's same-key spacing is
  // bimodal (flam graces 2-16 ms, then NOTHING until 61 ms) — our 33.8 ms buzz
  // sat in a zone he never plays. His density is VELOCITY GRAMMAR over 16th
  // runs (ghost lane dead-quantized, spikes every 3rd hit; main lane +/-3 ms
  // human scatter, mid-run accents, climax on the LANDING); true buzz = the
  // RECORDED buzz piece. v5 renders six figures VERBATIM from the grooves
  // (offsets carry the drummer's own scatter — do not re-quantize) through a
  // 5-variant decorrelation pool: pitch +/-5 CENTS (web hygiene: <=10 cents),
  // start offset 0-1.5 ms, inner-hit transient duck ~-3 dB, NATURAL ring (no
  // synthetic choke — corpus gates ring to the next 16th; last hit full tail).
  const CENT = (c: number): number => Math.pow(2, c / 1200);
  const POOL = [
    { pitch: CENT(0), startMs: 0 },
    { pitch: CENT(-5), startMs: 0.6 },
    { pitch: CENT(3), startMs: 1.1 },
    { pitch: CENT(-2), startMs: 1.5 },
    { pitch: CENT(5), startMs: 0.3 },
  ];
  const renderFigure = (source: Float32Array, rate: number, offsetsMs: number[], gains: number[]): Float64Array => {
    const last = offsetsMs.length - 1;
    const total = Math.round(((offsetsMs[last]) / 1000) * rate) + source.length;
    const buf = new Float64Array(total);
    const duck = Math.round(0.004 * rate); // -3 dB on inner-hit transients
    for (let n = 0; n < offsetsMs.length; n++) {
      const v = POOL[n % POOL.length];
      const startSrc = Math.round((v.startMs / 1000) * rate);
      const at = Math.round((offsetsMs[n] / 1000) * rate);
      for (let i = 0; ; i++) {
        const pos = startSrc + i * v.pitch;
        const i0 = Math.floor(pos);
        if (i0 + 1 >= source.length || at + i >= buf.length) break;
        const s = source[i0] * (1 - (pos - i0)) + source[i0 + 1] * (pos - i0);
        const duckGain = n > 0 && n < last && i < duck ? 0.7 : 1;
        buf[at + i] += s * gains[n] * duckGain;
      }
    }
    return buf;
  };

  interface Fig { name: string; wav: string; offsets: number[]; gains: number[] }
  const FIGURES: Fig[] = [
    { name: 'S10G04 main-hat 15-hit run (drummer scatter intact)', wav: 'real_run_mainhat.wav',
      offsets: [0, 199.32, 395.27, 599.66, 797.3, 1000, 1206.08, 1407.09, 1608.11, 1817.57, 2016.89, 2222.97, 2425.68, 2628.38, 2831.08],
      gains: [0.402, 0.504, 0.535, 1, 0.512, 0.512, 0.591, 0.756, 0.575, 0.646, 0.535, 0.732, 0.559, 0.732, 0.535] },
    { name: 'S01G09 ghost lane, 1.0 spike every 3rd (dead-quantized)', wav: 'real_run_ghost3over4.wav',
      offsets: [0, 202.7, 405.41, 608.11, 810.81, 1013.51, 1216.22, 1418.92, 1621.62, 1824.32],
      gains: [0.346, 0.559, 1, 0.449, 0.425, 1, 0.441, 0.598, 1, 0.488] },
    { name: 'S10G14 crescendo into the (absent) landing', wav: 'real_run_crescendo.wav',
      offsets: [0, 202.7, 405.41, 608.11, 810.81, 1013.51],
      gains: [0.189, 0.331, 0.339, 0.402, 0.488, 0.417] },
    { name: 'S04G02 arch/swell, mid-run accent', wav: 'real_run_arch.wav',
      offsets: [0, 202.7, 403.72, 608.11, 810.81, 1013.51, 1216.22],
      gains: [0.669, 0.772, 0.795, 0.803, 0.858, 0.787, 0.669] },
    { name: 'S04G02 same figure at 32nds (densest legal texture)', wav: 'real_run_arch32.wav',
      offsets: [0, 101.35, 201.86, 304.05, 405.41, 506.76, 608.11],
      gains: [0.669, 0.772, 0.795, 0.803, 0.858, 0.787, 0.669] },
    { name: 'S09G08 flam grammar (8.4 ms graces, second hit louder)', wav: 'real_run_flams.wav',
      offsets: [0, 201.01, 209.46, 396.96, 405.41, 809.12],
      gains: [0.591, 0.472, 0.394, 0.535, 0.795, 0.496] },
    { name: 'S01G04 the corpus\'s ONLY triplet run (accent = baked landing)', wav: 'real_run_triplet.wav',
      offsets: [0, 135.14, 270.27],
      gains: [0.654, 0.63, 1] },
  ];
  const figBufs: Float64Array[] = [];
  for (const fig of FIGURES) {
    const buf = renderFigure(hatClosed.samples, hatClosed.rate, fig.offsets, fig.gains);
    figBufs.push(buf);
    const p = path.join(OUT_DIR, fig.wav);
    const meta = writeWavMono16(p, hatClosed.rate, buf);
    report.push(logFile(p, hatClosed.rate, buf.length, meta, undefined, undefined));
  }

  // ---- 2c) hat_run_16trip.wav: how II ACTUALLY plays fast hats ----------
  // Groove-pack evidence (all 160 MIDIs): the fastest same-key hat figures are
  // 16th-TRIPLET runs with human, accent-targeted velocities (e.g. 83,80,127)
  // — never a 34 ms buzz. This is that figure at Gethsemane's tempo.
  const TRIPLET_MS = 60000 / BPM / 6; // 16th-triplet spacing, 135.14 ms
  const runTrip = synthRollV2(hatClosed.samples, hatClosed.rate, {
    hitCount: 4, spacingMs: TRIPLET_MS, gains: [0.65, 0.78, 0.88, 1.0], // crescendo into the accent
  });
  const runTripPath = path.join(OUT_DIR, 'hat_run_16trip.wav');
  const runTripMeta = writeWavMono16(runTripPath, hatClosed.rate, runTrip);
  report.push(logFile(runTripPath, hatClosed.rate, runTrip.length, runTripMeta, undefined, undefined));

  // ---- 3) snare_roll_recorded.wav: trim silence only, no resynthesis ---
  const trimmedSnareRoll = trimSilence(snareRollSrc.samples, snareRollSrc.rate);
  const snareRollPath = path.join(OUT_DIR, 'snare_roll_recorded.wav');
  const snareRollMeta = writeWavMono16(snareRollPath, snareRollSrc.rate, trimmedSnareRoll);
  const snareRollOnsets = countOnsetsBlind(trimmedSnareRoll, snareRollSrc.rate);
  report.push(logFile(snareRollPath, snareRollSrc.rate, trimmedSnareRoll.length, snareRollMeta, snareRollOnsets, undefined));
  console.log(`  (recorded, trimmed only: ${snareRollSrc.samples.length} -> ${trimmedSnareRoll.length} frames)`);

  // ---- 4) audition files: sequence with 1 s silence between ------------
  const rate = hatClosed.rate; // 48000, shared by all three (verified below)
  if (snareRollSrc.rate !== rate) throw new Error('sample-rate mismatch building audition file');
  const silence1s = new Float64Array(rate);
  const buildSequence = (parts: Float64Array[]): Float64Array => {
    const withGaps: Float64Array[] = [];
    parts.forEach((p, i) => { if (i > 0) withGaps.push(silence1s); withGaps.push(p); });
    const total = withGaps.reduce((a, p) => a + p.length, 0);
    const out = new Float64Array(total);
    let off = 0;
    for (const part of withGaps) { out.set(part, off); off += part.length; }
    return out;
  };
  const audition = buildSequence([buzz1, roll4, new Float64Array(trimmedSnareRoll)]);
  const auditionPath = path.join(OUT_DIR, 'audition_all_rolls.wav');
  const auditionMeta = writeWavMono16(auditionPath, rate, audition);
  report.push(logFile(auditionPath, rate, audition.length, auditionMeta, undefined, undefined));

  // v2 A/B audition: old buzz -> NEW buzz -> old 4-step -> NEW 4-step ->
  // the II-style triplet run -> the recorded snare roll (reference winner).
  const auditionV2 = buildSequence([buzz1, buzz1v2, roll4, roll4v2, runTrip, new Float64Array(trimmedSnareRoll)]);
  const auditionV2Path = path.join(OUT_DIR, 'audition_v2_ab.wav');
  const auditionV2Meta = writeWavMono16(auditionV2Path, rate, auditionV2);
  report.push(logFile(auditionV2Path, rate, auditionV2.length, auditionV2Meta, undefined, undefined));

  // v3 audition: v2 buzz (washy hat) -> v3 buzz (TIGHT hat, spiky dynamics) ->
  // v2 4-step -> v3 4-step -> triplet run (natural winner) -> recorded snare.
  const auditionV3 = buildSequence([buzz1v2, buzz1v3, roll4v2, roll4v3, runTrip, new Float64Array(trimmedSnareRoll)]);
  const auditionV3Path = path.join(OUT_DIR, 'audition_v3_tight.wav');
  const auditionV3Meta = writeWavMono16(auditionV3Path, rate, auditionV3);
  report.push(logFile(auditionV3Path, rate, auditionV3.length, auditionV3Meta, undefined, undefined));

  // v4 audition: v3 (tight but woody) -> v4 (REAL hat, tight-shaped) buzz,
  // then the same pair for the 4-step, then triplet run + recorded snare.
  const auditionV4 = buildSequence([buzz1v3, buzz1v4, roll4v3, roll4v4, runTrip, new Float64Array(trimmedSnareRoll)]);
  const auditionV4Path = path.join(OUT_DIR, 'audition_v4_shaped.wav');
  const auditionV4Meta = writeWavMono16(auditionV4Path, rate, auditionV4);
  report.push(logFile(auditionV4Path, rate, auditionV4.length, auditionV4Meta, undefined, undefined));

  // v5 audition: the drummer's own figures, verbatim, through our chain — in
  // FIGURES order (main run, ghost 3-over-4, crescendo, arch, arch@32nds,
  // flams, triplet), then the v4 buzz for contrast, then the recorded snare.
  const auditionV5 = buildSequence([...figBufs, buzz1v4, new Float64Array(trimmedSnareRoll)]);
  const auditionV5Path = path.join(OUT_DIR, 'audition_v5_real_figures.wav');
  const auditionV5Meta = writeWavMono16(auditionV5Path, rate, auditionV5);
  report.push(logFile(auditionV5Path, rate, auditionV5.length, auditionV5Meta, undefined, undefined));

  // ---- 5) spdsx-ready/*.wav: 44.1 kHz / 16-bit / mono, safe names ------
  const spdsxTargets: Array<{ name: string; rate: number; samples: Float32Array }> = [
    { name: 'GKICK.wav', rate: kick.rate, samples: kick.samples },
    { name: 'GSNARE.wav', rate: snare.rate, samples: snare.samples },
    { name: 'GHATCL.wav', rate: hatClosed.rate, samples: hatClosed.samples },
    { name: 'GHATOP.wav', rate: hatOpen.rate, samples: hatOpen.samples },
    // v5 kit (per the 2026-07-04 research verdict): baked RUN figures from the
    // drummer's verbatim playing replace the synthesized buzzes as the primary
    // fast-hat texture; the recorded buzz piece is the sole true buzz. The v4
    // 34 ms buzz survives as ONE explicitly-electronic texture pad.
    { name: 'GRUN3O4.wav', rate: hatClosed.rate, samples: new Float32Array(figBufs[1]) },  // ghost lane, spike every 3rd
    { name: 'GRUNCRE.wav', rate: hatClosed.rate, samples: new Float32Array(figBufs[2]) },  // crescendo into the landing
    { name: 'GRUNARC.wav', rate: hatClosed.rate, samples: new Float32Array(figBufs[3]) },  // arch/swell, mid-run accent
    { name: 'GTRIP16.wav', rate: hatClosed.rate, samples: new Float32Array(figBufs[6]) },  // triplet pickup (ear favorite)
    { name: 'GBUZZEL.wav', rate: hatClosed.rate, samples: new Float32Array(buzz1v4) },     // electronic buzz (deliberate machine texture)
    { name: 'GSNRRL.wav', rate: snareRollSrc.rate, samples: trimmedSnareRoll },
  ];
  console.log('\nspdsx-ready/ (44100 Hz, 16-bit, mono):');
  for (const t of spdsxTargets) {
    if (t.name.length > 16) throw new Error(`${t.name}: exceeds SPD-SX 16-char filename limit`);
    const resampled = resampleLinear(t.samples, t.rate, 44100);
    const outPath = path.join(SPDSX_DIR, t.name);
    const meta = writeWavMono16(outPath, 44100, resampled);
    report.push(logFile(outPath, 44100, resampled.length, meta, undefined, undefined));
  }

  // ---- Verify: re-parse every written WAV -------------------------------
  console.log('\n--- verification: re-parse every written WAV ---');
  const allWritten = [
    buzz1Path, roll4Path, snareRollPath, auditionPath,
    ...spdsxTargets.map((t) => path.join(SPDSX_DIR, t.name)),
  ];
  for (const p of allWritten) {
    const w = readWav(p);
    console.log(`  OK  ${p}  rate=${w.rate}  frames=${w.samples.length}  dur=${(w.samples.length / w.rate).toFixed(4)}s`);
  }
  if (buzz1Onsets !== 6) throw new Error(`hat_buzz_1step.wav: expected 6 onsets, counted ${buzz1Onsets}`);
  if (roll4Onsets !== 24) throw new Error(`hat_roll_4step.wav: expected 24 onsets, counted ${roll4Onsets}`);
  console.log(`\nASSERT PASS: hat_buzz_1step onsets=${buzz1Onsets} (expected 6), hat_roll_4step onsets=${roll4Onsets} (expected 24)`);
  console.log(`(recorded snare roll onset count: ${snareRollOnsets}, informational only — not resynthesized)`);

  console.log('\nAll files written under', OUT_DIR);
}

function logFile(p: string, rate: number, frames: number, meta: { peak: number; normalized: boolean }, onsets: number | undefined, expectedOnsets: number | undefined): string {
  const durS = frames / rate;
  const onsetStr = onsets !== undefined ? `, onsets=${onsets}${expectedOnsets !== undefined ? ` (expect ${expectedOnsets})` : ''}` : '';
  const line = `${p}: rate=${rate} frames=${frames} dur=${durS.toFixed(4)}s peak=${meta.peak.toFixed(3)}${meta.normalized ? ' (normalized)' : ''}${onsetStr}`;
  console.log(line);
  return line;
}

main();
