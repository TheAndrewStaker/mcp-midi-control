/**
 * Golden: BS.1770 loudness module (BK-105 phase 1).
 *
 * Three layers of evidence, strongest first:
 *   1. Spec anchor: the computed K-weighting coefficients at 48 kHz must
 *      reproduce the ITU-R BS.1770-4 published table byte-for-byte (1e-6).
 *   2. Self-evident synthetic signals: sine loudness identity (997 Hz
 *      stereo sine at -X dBFS reads -X LUFS), absolute + relative gate
 *      behavior, mono convention, inter-sample true peak.
 *   3. Cross-implementation oracle: ffmpeg's ebur128 filter over the same
 *      samples (skipped with a warning when ffmpeg is not on PATH; layers
 *      1-2 still gate).
 *
 * Run via:  npx tsx scripts/verify-bs1770.ts
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  kWeightingStage1,
  kWeightingStage2,
  measureBs1770,
} from '@mcp-midi-control/core/audio/bs1770.js';

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const assertClose = (actual: number | null, expected: number, tol: number, msg: string) => {
  if (actual === null || !Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    fail(`${msg}: expected ${expected} +/- ${tol}, got ${actual}`);
  } else {
    ok(`${msg}: ${actual.toFixed(3)} (expected ${expected} +/- ${tol})`);
  }
};

const SR = 48000;

/** Stereo/mono sine generator. dbfs is the PEAK level convention (EBU test-signal convention). */
function sine(freq: number, dbfs: number, seconds: number, phase = 0): Float64Array {
  const amp = Math.pow(10, dbfs / 20);
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
}

function concat(...parts: Float64Array[]): Float64Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float64Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
console.log('1. K-weighting coefficients at 48 kHz vs the BS.1770-4 table:');
{
  // ITU-R BS.1770-4, Table 1 (stage 1 pre-filter) and Table 2 (RLB), 48 kHz.
  const s1 = kWeightingStage1(SR);
  const table1 = {
    b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285,
    a1: -1.69065929318241, a2: 0.73248077421585,
  };
  for (const [k, v] of Object.entries(table1)) {
    assertClose(s1[k as keyof typeof table1], v, 1e-6, `stage1 ${k}`);
  }
  const s2 = kWeightingStage2(SR);
  assertClose(s2.a1, -1.99004745483398, 1e-6, 'stage2 a1');
  assertClose(s2.a2, 0.99007225036621, 1e-6, 'stage2 a2');
}

// ---------------------------------------------------------------------------
console.log('\n2. Sine loudness identity (997 Hz stereo, EBU 3341 case 1/2 shape):');
{
  const l = sine(997, -23, 20);
  const m = measureBs1770([l, l], SR);
  assertClose(m.lufsIntegrated, -23.0, 0.1, 'integrated, -23 dBFS stereo sine');
  assertClose(m.lufsMomentaryMax, -23.0, 0.1, 'momentary max, steady sine');

  const q = sine(997, -33, 20);
  const m2 = measureBs1770([q, q], SR);
  assertClose(m2.lufsIntegrated, -33.0, 0.1, 'integrated, -33 dBFS stereo sine');
}

console.log('\n3. Mono convention (single channel weighs 1.0, reads ~3 LU low):');
{
  const m = measureBs1770([sine(997, -23, 10)], SR);
  assertClose(m.lufsIntegrated, -26.0, 0.15, 'integrated, -23 dBFS MONO sine');
}

console.log('\n4. Absolute gate (-70 LUFS): trailing silence must not dilute:');
{
  const l = concat(sine(997, -23, 5), new Float64Array(5 * SR));
  const m = measureBs1770([l, l], SR);
  // Ungated this would read ~-26; the gate must hold it at -23.
  assertClose(m.lufsIntegrated, -23.0, 0.15, 'integrated, 5 s tone + 5 s silence');
}

console.log('\n5. Relative gate (-10 LU): a quiet tail above -70 must be gated out:');
{
  const l = concat(sine(997, -23, 20), sine(997, -45, 20));
  const m = measureBs1770([l, l], SR);
  // First-pass mean is ~-26 -> relative gate ~-36 -> the -45 dBFS segment
  // (~-45 LUFS blocks, above the absolute gate) drops. Ungated: ~-26.
  assertClose(m.lufsIntegrated, -23.0, 0.15, 'integrated, -23 dBFS + -45 dBFS halves');
  if (m.gatedBlockCount >= m.totalBlockCount) {
    fail('relative gate dropped nothing (gatedBlockCount == totalBlockCount)');
  } else {
    ok(`relative gate dropped blocks (${m.gatedBlockCount}/${m.totalBlockCount} kept)`);
  }
}

console.log('\n6. True peak (4x oversampled):');
{
  const full = sine(997, 0, 2);
  const m = measureBs1770([full, full], SR);
  assertClose(m.truePeakDbtp, 0.0, 0.15, 'full-scale 997 Hz sine ~= 0 dBTP');

  // Inter-sample peak: fs/4 sine with 45 deg phase never SAMPLES its peak.
  // Samples sit at amp/sqrt(2) (-9.03 dBFS) while the waveform peaks at
  // -6.02 dBTP. A raw sample peak would miss it by 3 dB.
  const isp = sine(SR / 4, -6.0206, 2, Math.PI / 4);
  const m2 = measureBs1770([isp], SR);
  assertClose(m2.samplePeakDbfs, -9.03, 0.1, 'fs/4 sine sample peak (proves the trap exists)');
  assertClose(m2.truePeakDbtp, -6.02, 0.3, 'fs/4 sine TRUE peak (oversampler catches it)');
}

console.log('\n7. Silence handling:');
{
  const m = measureBs1770([new Float64Array(2 * SR)], SR);
  if (m.lufsIntegrated !== null || m.lufsMomentaryMax !== null) {
    fail(`digital silence must read null, got I=${m.lufsIntegrated} M=${m.lufsMomentaryMax}`);
  } else {
    ok('digital silence reads lufsIntegrated=null, momentary=null');
  }
}

// ---------------------------------------------------------------------------
console.log('\n8. ffmpeg ebur128 oracle (cross-implementation):');
{
  let ffmpeg: string | undefined = 'ffmpeg';
  try {
    execFileSync(ffmpeg, ['-version'], { stdio: 'pipe' });
  } catch {
    ffmpeg = undefined;
  }
  if (ffmpeg === undefined) {
    console.log('  SKIP ffmpeg not on PATH; spec + synthetic layers above still gate.');
  } else {
    // Composite: level step + quiet tail, non-trivial for the gates.
    const l = concat(sine(997, -23, 8), sine(997, -33, 8), sine(997, -60, 4));
    const r = l;
    const m = measureBs1770([l, r], SR);

    // Write a float32 WAV and ask ffmpeg's ebur128 for I + true peak.
    // ebur128 logs its summary to STDERR, so spawnSync (execFileSync only
    // hands back stdout on success).
    const wav = wavFloat32Stereo(l, r, SR);
    const tmp = path.join(os.tmpdir(), `bs1770-oracle-${process.pid}.wav`);
    fs.writeFileSync(tmp, wav);
    try {
      const run = spawnSync(ffmpeg, [
        '-nostats', '-i', tmp,
        '-filter_complex', 'ebur128=peak=true',
        '-f', 'null', '-',
      ], { encoding: 'utf8' });
      const stderr = run.stderr ?? '';
      // Parse the trailing Summary block: "I: -23.0 LUFS" and, under
      // "True peak:", "Peak: -6.0 dBFS". The filter also logs periodic
      // per-frame lines with an I: field, so take the LAST match (the
      // summary), never the first (t~0.1 s reads -70).
      const lastMatch = (re: RegExp): RegExpExecArray | null => {
        let m: RegExpExecArray | null = null;
        for (const hit of stderr.matchAll(re)) m = hit as RegExpExecArray;
        return m;
      };
      const iMatch = lastMatch(/I:\s*(-?[\d.]+)\s*LUFS/g);
      const peakMatch = lastMatch(/Peak:\s*(-?[\d.]+)\s*dBFS/g);
      if (!iMatch || !peakMatch) {
        fail(`could not parse ffmpeg ebur128 summary (stderr tail: ${stderr.slice(-400)})`);
      } else {
        const ffI = Number(iMatch[1]);
        const ffPeak = Number(peakMatch[1]);
        assertClose(m.lufsIntegrated, ffI, 0.2, `integrated vs ffmpeg (${ffI} LUFS)`);
        assertClose(m.truePeakDbtp, ffPeak, 0.5, `true peak vs ffmpeg (${ffPeak} dBTP)`);
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

/** Minimal float32 stereo WAV (RIFF, fmt chunk format 3). */
function wavFloat32Stereo(l: Float64Array, r: Float64Array, sampleRate: number): Buffer {
  const frames = l.length;
  const dataBytes = frames * 2 * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2 * 4, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeFloatLE(l[i], 44 + i * 8);
    buf.writeFloatLE(r[i], 48 + i * 8);
  }
  return buf;
}

// ---------------------------------------------------------------------------
console.log('');
if (failures > 0) {
  console.error(`verify-bs1770: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-bs1770: all checks passed');
