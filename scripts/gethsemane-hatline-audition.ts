/**
 * gethsemane-hatline-audition — the "one long figure" test. The ENTIRE 2-bar hat
 * line is a SINGLE engine-rendered clip (hatline_2bar.wav, round-robins + dynamics
 * across the whole phrase), triggered once per 2-bar loop; only kick + snare (the
 * separated, half-note-apart hits) are individual pads. Compare to the pieced-
 * together audition_full_baked_leveled.wav.
 *
 * Run: npx tsx scripts/gethsemane-hatline-audition.ts
 */
import path from 'node:path';
import { readWav, writeWavMono16, resampleLinear, mix, type Placement, type Wav } from './_shared/audioMockup.js';

const KIT = 'samples/mixwave/gethsemane-kit/spdsx-ready';
const HATLINE = 'C:/dev/bouncer/out/gethsemane-hatline/hatline_2bar.wav';
const OUT = 'samples/mixwave/gethsemane-kit/audition_hatline_onepass.wav';

const BPM = 74;
const STEP_MS = 60000 / BPM / 4; // 16th = 202.7 ms
const LOOPS = 2;
const RATE = 48000;

const at = (rate: number, w: Wav): Wav => (w.rate === rate ? w : { rate, samples: resampleLinear(w.samples, w.rate, rate) });

function main(): void {
  const kick = at(RATE, readWav(path.join(KIT, 'GKICK.wav')));
  const snare = at(RATE, readWav(path.join(KIT, 'GSNARE.wav')));
  const hatclip = at(RATE, readWav(HATLINE)); // the whole 2-bar hat line, one clip

  const KICK_STEPS = [0, 16];  // beat 1 each bar (2-bar loop = 32 steps)
  const SNARE_STEPS = [8, 24]; // beat 3 each bar
  const loopMs = 32 * STEP_MS;
  const totalMs = loopMs * LOOPS + 800;

  const placements: Placement[] = [];
  for (let loop = 0; loop < LOOPS; loop++) {
    const base = loop * loopMs;
    for (const s of KICK_STEPS) placements.push({ atMs: base + s * STEP_MS, wav: kick, gain: 0.9 });
    for (const s of SNARE_STEPS) placements.push({ atMs: base + s * STEP_MS, wav: snare, gain: 0.85 });
    // The one hat clip, triggered once at the loop start.
    placements.push({ atMs: base, wav: hatclip, gain: 1.0 });
  }

  const buf = mix(RATE, placements, totalMs);
  const meta = writeWavMono16(OUT, RATE, buf);
  console.log(`${OUT}: dur=${(buf.length / RATE).toFixed(2)}s peak=${meta.peak.toFixed(3)}${meta.normalized ? ' (normalized)' : ''}`);
  console.log('hat = ONE 2-bar engine clip per loop; kick/snare individual.');
}

main();
