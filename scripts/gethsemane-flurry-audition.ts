/**
 * gethsemane-flurry-audition — place the engine-bounced cicada flurry into the
 * Gethsemane groove so the flurry speed/level can be judged BEFORE the SPD-SX
 * round-trip. Uses the shared audioMockup helpers (no new synthesis; just mixes
 * the real kit one-shots + the Kontakt-rendered flurry on the 74 bpm timeline).
 *
 * Flurry: C:/dev/bouncer/out/gethsemane-flurry/flurry_raw.wav — 9 closed-hat
 * hits at 64th spacing rendered through the ST II Kontakt engine (round-robins).
 * Its 9 hits span ~0.405 s, so it is triggered 2 sixteenths (one 8th) before each
 * snare, landing its final hit ON the snare — the corpus placement.
 *
 * Run: npx tsx scripts/gethsemane-flurry-audition.ts
 */
import path from 'node:path';
import { readWav, writeWavMono16, resampleLinear, mix, type Placement, type Wav } from './_shared/audioMockup.js';

const KIT = 'samples/mixwave/gethsemane-kit/spdsx-ready';
const FLURRY = 'C:/dev/bouncer/out/gethsemane-flurry/flurry_raw.wav';
const OUT = 'samples/mixwave/gethsemane-kit/audition_flurry_engine.wav';

const BPM = 74;
const STEP_MS = 60000 / BPM / 4; // 16th = 202.7 ms
const LOOPS = 2;
const RATE = 48000;

function at(rate: number, w: Wav): Wav {
  return w.rate === rate ? w : { rate, samples: resampleLinear(w.samples, w.rate, rate) };
}

function main(): void {
  const kick = at(RATE, readWav(path.join(KIT, 'GKICK.wav')));
  const snare = at(RATE, readWav(path.join(KIT, 'GSNARE.wav')));
  const hat = at(RATE, readWav(path.join(KIT, 'GHATCL.wav')));
  const flurry = at(RATE, readWav(FLURRY)); // already 48k

  // Groove (16th grid, 2 bars = 32 steps). Kick beat 1, snare beat 3. Light plain
  // hats away from the flurry zone so the cicada reads clearly. Flurry lands into
  // each snare (snares at steps 8, 24).
  const kickSteps = [0, 16];
  const snareSteps = [8, 24];
  const hatSteps = [0, 4, 12, 16, 20, 28]; // avoid 6-8 / 22-24 (flurry zone)
  const FLURRY_HITSPAN_MS = 8 * ((60000 / BPM) / 16); // 9 hits => 8 gaps of a 64th
  const loopMs = 32 * STEP_MS;
  const totalMs = loopMs * LOOPS + 1000;

  const placements: Placement[] = [];
  for (let loop = 0; loop < LOOPS; loop++) {
    const base = loop * loopMs;
    for (const s of kickSteps) placements.push({ atMs: base + s * STEP_MS, wav: kick, gain: 0.9 });
    for (const s of snareSteps) {
      placements.push({ atMs: base + s * STEP_MS, wav: snare, gain: 0.85 });
      // Flurry: final hit lands ON the snare, so start = snareTime - hitspan.
      placements.push({ atMs: base + s * STEP_MS - FLURRY_HITSPAN_MS, wav: flurry, gain: 0.95, family: 'hat' });
    }
    for (const s of hatSteps) placements.push({ atMs: base + s * STEP_MS, wav: hat, gain: 0.55, family: 'hat' });
  }

  const buf = mix(RATE, placements, totalMs);
  const meta = writeWavMono16(OUT, RATE, buf);
  console.log(`${OUT}: dur=${(buf.length / RATE).toFixed(2)}s peak=${meta.peak.toFixed(3)}${meta.normalized ? ' (normalized)' : ''}`);
  console.log(`flurry hit-span ${FLURRY_HITSPAN_MS.toFixed(1)} ms (9 hits @ 64th, ${BPM} bpm); lands into snares at steps ${snareSteps.join(', ')}`);
}

main();
