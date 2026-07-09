/**
 * gethsemane-figures-audition — the FULL Gethsemane bridge groove with EVERY
 * fast figure baked through the ST II engine (flurry9_64, flurry6_64, run4_32)
 * placed exactly where scripts/gethsemane-bake-figures.ts detected them, and the
 * normal 8th/16th hats on the closed-hat one-shot. This is the "sound like that
 * on the sequencer" preview: what the SPD-SX will play once these figures are
 * pads triggered by the Circuit.
 *
 * Run: npx tsx scripts/gethsemane-figures-audition.ts
 */
import path from 'node:path';
import { readWav, writeWavMono16, resampleLinear, mix, type Placement, type Wav } from './_shared/audioMockup.js';

const KIT = 'samples/mixwave/gethsemane-kit/spdsx-ready';
const FIG = 'C:/dev/bouncer/out/gethsemane-flurry';
const LEVELED = 'C:/dev/bouncer/out/gethsemane-leveled'; // hat + figures loudness-matched to -23 LUFS
const OUT = 'samples/mixwave/gethsemane-kit/audition_full_baked_leveled.wav';

const BPM = 74;
const STEP_MS = 60000 / BPM / 4; // 16th = 202.7 ms
const LOOPS = 2;
const RATE = 48000;

const at = (rate: number, w: Wav): Wav => (w.rate === rate ? w : { rate, samples: resampleLinear(w.samples, w.rate, rate) });

// Detected pattern (from gethsemane-bake-figures.ts).
const KICK_STEPS = [0, 16];
const SNARE_STEPS = [8, 24];
const HAT_LANE = 'x.x.x....xxxxxxxxxxxxx..x.xxx...'; // normal hats -> closed-hat pad
// Baked figures: [16th trigger step, wav]. Placed so the WAV starts at that step.
const FIGURE_STEPS: Array<[number, string]> = [
  [6, 'flurry9_64.wav'],  // bar1: lands on snare (step 8)
  [22, 'flurry6_64.wav'], // bar2: ends just before snare (step 24)
  [30, 'run4_32.wav'],    // bar2: 32nd run into the loop
];

function main(): void {
  const kick = at(RATE, readWav(path.join(KIT, 'GKICK.wav')));
  const snare = at(RATE, readWav(path.join(KIT, 'GSNARE.wav')));
  const hat = at(RATE, readWav(path.join(LEVELED, 'GHATCL.wav')));       // -23 LUFS
  const figs = new Map(FIGURE_STEPS.map(([, f]) => [f, at(RATE, readWav(path.join(LEVELED, f)))])); // -23 LUFS

  const hatSteps: number[] = [];
  for (let i = 0; i < HAT_LANE.length; i++) if (HAT_LANE[i] === 'x') hatSteps.push(i);

  const loopMs = 32 * STEP_MS;
  const totalMs = loopMs * LOOPS + 1000;
  const placements: Placement[] = [];
  for (let loop = 0; loop < LOOPS; loop++) {
    const base = loop * loopMs;
    for (const s of KICK_STEPS) placements.push({ atMs: base + s * STEP_MS, wav: kick, gain: 0.9 });
    for (const s of SNARE_STEPS) placements.push({ atMs: base + s * STEP_MS, wav: snare, gain: 0.85 });
    for (const s of hatSteps) placements.push({ atMs: base + s * STEP_MS, wav: hat, gain: 0.5, family: 'hat' });
    for (const [step, f] of FIGURE_STEPS) placements.push({ atMs: base + step * STEP_MS, wav: figs.get(f)!, gain: 0.95, family: 'hat' });
  }

  const buf = mix(RATE, placements, totalMs);
  const meta = writeWavMono16(OUT, RATE, buf);
  console.log(`${OUT}: dur=${(buf.length / RATE).toFixed(2)}s peak=${meta.peak.toFixed(3)}${meta.normalized ? ' (normalized)' : ''}`);
  console.log(`figures placed at 16th steps: ${FIGURE_STEPS.map(([s, f]) => `${s}:${f}`).join(', ')}`);
}

main();
