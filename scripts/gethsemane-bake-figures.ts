/**
 * gethsemane-bake-figures — the "auto-bake fast figures" analysis for the
 * Gethsemane bridge groove. Detects runs of fast (forbidden-zone) hat onsets
 * that a single-sample SPD-SX pad would machine-gun/comb, and splits the hat
 * lane into: (a) NORMAL hats (8th/16th, fine as single triggers on the closed-
 * hat pad) and (b) FLURRY figures (fast runs → each baked through the engine as
 * one sample, triggered once).
 *
 * Source: Songsterr 1467797 "Programmed Drums", measures 129-130, 74 bpm, at
 * 64th resolution (16 steps/beat). Kick/snare are beat-1 / beat-3 (never fast).
 *
 * Run: npx tsx scripts/gethsemane-bake-figures.ts
 */

const BPM = 74;
const SIXTYFOURTH_MS = (60000 / BPM) / 16; // 50.68 ms
const STEPS_PER_BAR_64 = 64;

// 64th-resolution hat lanes (from import_songsterr steps:16).
const HAT_64 = [
  'x.......x.......x.......xxxxxxxxx...x...x...x...x...x.x.x...x...', // bar 1 (measure 129)
  'x.x..x..x...x...x...x...xxxxxx..x.......x...x...x.......x.x.x.x.', // bar 2 (measure 130)
];
// Snare onsets (64th step within bar) — beat 3 = step 32.
const SNARE_64 = [32, 32];

/** A run of onsets whose consecutive gaps are all <= maxGapSteps (in 64th steps). */
interface Run { bar: number; startStep: number; onsets: number[]; }

function onsetsOf(lane: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < lane.length; i++) if (lane[i] === 'x') out.push(i);
  return out;
}

/** Group onsets into runs where each gap <= maxGap; a run of length >= minLen at
 *  fast spacing is a "figure" to bake. */
function detectRuns(onsets: number[], bar: number, maxGap: number): Run[] {
  const runs: Run[] = [];
  let cur: number[] = [];
  for (let i = 0; i < onsets.length; i++) {
    if (cur.length === 0) { cur = [onsets[i]]; continue; }
    if (onsets[i] - cur[cur.length - 1] <= maxGap) cur.push(onsets[i]);
    else { runs.push({ bar, startStep: cur[0], onsets: cur.slice() }); cur = [onsets[i]]; }
  }
  if (cur.length) runs.push({ bar, startStep: cur[0], onsets: cur.slice() });
  return runs;
}

// Forbidden-zone rule: a FLURRY = >=4 onsets whose internal gaps are all <=2
// 64th-steps (i.e. 32nd-and-faster, ~<=101 ms — the zone where a single SPD-SX
// sample machine-guns). Everything else is a normal hat.
const FLURRY_MIN_LEN = 4;
const FLURRY_MAX_GAP = 2;

function main(): void {
  console.log(`74 bpm: 64th=${SIXTYFOURTH_MS.toFixed(2)}ms, 32nd=${(SIXTYFOURTH_MS * 2).toFixed(1)}ms, 16th=${(SIXTYFOURTH_MS * 4).toFixed(1)}ms\n`);

  const flurries: Run[] = [];
  const normalHat16: Set<number>[] = [new Set(), new Set()]; // per-bar set of 16th steps

  HAT_64.forEach((lane, bar) => {
    const onsets = onsetsOf(lane);
    const runs = detectRuns(onsets, bar, FLURRY_MAX_GAP);
    for (const run of runs) {
      const isFlurry = run.onsets.length >= FLURRY_MIN_LEN;
      if (isFlurry) {
        flurries.push(run);
      } else {
        // Normal hats: collapse each onset to its 16th step (64th/4).
        for (const o of run.onsets) normalHat16[bar].add(Math.round(o / 4));
      }
    }
  });

  // Report figures to bake.
  console.log(`Detected ${flurries.length} FLURRY figure(s) to bake through the engine:`);
  flurries.forEach((f, i) => {
    const n = f.onsets.length;
    const spanMs = (f.onsets[n - 1] - f.onsets[0]) * SIXTYFOURTH_MS;
    const gaps = f.onsets.slice(1).map((o, k) => o - f.onsets[k]);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const rateHz = 1000 / (avgGap * SIXTYFOURTH_MS);
    const snare = SNARE_64[f.bar];
    const landsOnSnare = f.onsets[n - 1] === snare;
    console.log(
      `  [${i}] bar ${f.bar + 1}: ${n} hits, span ${spanMs.toFixed(0)}ms, ~${rateHz.toFixed(1)}Hz` +
      ` (avg gap ${avgGap.toFixed(1)}x64th), start 64th-step ${f.startStep} (=16th step ${(f.startStep / 4).toFixed(2)})` +
      `, ${landsOnSnare ? 'LANDS ON snare' : `ends ${((snare - f.onsets[n - 1]) * SIXTYFOURTH_MS).toFixed(0)}ms before snare`}`,
    );
  });

  // Build the 32-step (2-bar, 16th) NORMAL-hat lane + FLURRY-trigger lane.
  const normalHatLane = Array.from({ length: 32 }, () => '.');
  const flurryLane = Array.from({ length: 32 }, () => '.');
  normalHat16.forEach((set, bar) => {
    for (const s16 of set) { const step = bar * 16 + s16; if (step < 32) normalHatLane[step] = 'x'; }
  });
  for (const f of flurries) {
    // Trigger the flurry so its LAST hit lands where the run's last hit is (its
    // tail rings past). Trigger step = the run's first onset, as a 16th step.
    const step = f.bar * 16 + Math.round(f.startStep / 4);
    if (step < 32) flurryLane[step] = 'x';
  }

  console.log('\nPattern voices for apply_pattern (2 bars, 16th grid, 32 steps):');
  console.log(`  kick   : "x...............x..............."`);
  console.log(`  snare  : "........x...............x......."`);
  console.log(`  hat    : "${normalHatLane.join('')}"   (normal 8th/16th hats → closed-hat pad)`);
  console.log(`  flurry : "${flurryLane.join('')}"   (→ baked flurry pad, one trigger each)`);

  console.log('\nBounce list (one engine render per distinct figure):');
  flurries.forEach((f, i) => {
    const gaps = f.onsets.slice(1).map((o, k) => o - f.onsets[k]);
    console.log(`  figure[${i}] bar${f.bar + 1}: ${f.onsets.length} hits, gaps(64th)=[${gaps.join(',')}]`);
  });
}

main();
