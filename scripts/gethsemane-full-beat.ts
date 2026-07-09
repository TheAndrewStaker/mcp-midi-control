/**
 * gethsemane-full-beat — assemble the actual 2-bar Gethsemane electronic groove
 * (same 32-step lane data as author-gethsemane-gm.ts) into ONE playable audio
 * mockup, using the already-baked pieces under samples/mixwave/gethsemane-kit/
 * and spdsx-ready/ (no new synthesis — this script only places existing WAVs
 * on the song timeline and mixes them). Entirely offline, no MIDI device.
 *
 * Answers: "which pieces would we use in Gethsemane, and what does the whole
 * beat sound like with them in place?" Renders TWO full-beat versions so the
 * choice is audible, not asserted:
 *
 *   - full_beat_v5_runs.wav   RECOMMENDED: isolated hat buzzes -> GTRIP16
 *     (the triplet pickup, the corpus's own figure + your consistent ear
 *     favorite); the dense end-fill (4 consecutive 16ths) -> GRUNCRE
 *     ("crescendo into the landing" — built to resolve exactly where the
 *     fill sits, into the next bar's kick).
 *   - full_beat_electronic.wav  the machine-precision alternative for
 *     comparison: isolated buzzes -> GBUZZEL (kept as a deliberate synth
 *     texture), fill -> hat_roll_4step_v4_shaped (decayed sustained roll).
 *
 * Both loop the 2-bar pattern twice (~13 s) so the groove has time to settle
 * before judging it. Plain hat 8ths, kick, and snare are identical in both —
 * only the roll/buzz treatment differs.
 *
 * Run: npx tsx scripts/gethsemane-full-beat.ts
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { readWav, writeWavMono16, resampleLinear, mix, chokeSampleFamily, type Wav, type Placement } from './_shared/audioMockup.js';

const KIT_DIR = 'samples/mixwave/gethsemane-kit';
const SPDSX_DIR = path.join(KIT_DIR, 'spdsx-ready');
const OUT_DIR = KIT_DIR;

const BPM = 74;
const STEP_MS = 60000 / BPM / 4; // 202.7027... ms, matches author-gethsemane-gm.ts
const LOOPS = 2;

// Same 32-step lanes as author-gethsemane-gm.ts LANES (duplicated here — this
// is a one-off audio mockup, not shipped product code; keep the two in sync
// by eye if the groove changes).
const KICK = 'x...............x...............';
const SNARE = '........x...............x.......';
const HAT = 'x.x.x.x.6...6...x.x.6.6.6.6.6666';

function idx(s: string, ch: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) if (s[i] === ch) out.push(i);
  return out;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const kick = readWav(path.join(SPDSX_DIR, 'GKICK.wav'));
  const snare = readWav(path.join(SPDSX_DIR, 'GSNARE.wav'));
  const hatCl = readWav(path.join(SPDSX_DIR, 'GHATCL.wav'));
  const tripPickup = readWav(path.join(SPDSX_DIR, 'GTRIP16.wav'));
  const crescendo = readWav(path.join(SPDSX_DIR, 'GRUNCRE.wav'));
  const buzzEl = readWav(path.join(SPDSX_DIR, 'GBUZZEL.wav'));
  const rollV4Raw = readWav(path.join(KIT_DIR, 'hat_roll_4step_v4_shaped.wav'));

  const rate = kick.rate;
  const rollV4: Wav = { rate, samples: resampleLinear(rollV4Raw.samples, rollV4Raw.rate, rate) };
  for (const [name, w] of [['snare', snare], ['hatCl', hatCl], ['tripPickup', tripPickup],
    ['crescendo', crescendo], ['buzzEl', buzzEl], ['rollV4', rollV4]] as [string, Wav][]) {
    if (w.rate !== rate) throw new Error(`${name}: sample-rate mismatch (${w.rate} vs ${rate})`);
  }

  const kickSteps = idx(KICK, 'x');
  const snareSteps = idx(SNARE, 'x');
  const hatPlainSteps = idx(HAT, 'x');
  const hatBuzzSteps = idx(HAT, '6');

  // Group consecutive buzz steps: isolated (len 1) vs the dense run (len 4+).
  const buzzGroups: number[][] = [];
  for (const s of hatBuzzSteps) {
    const last = buzzGroups[buzzGroups.length - 1];
    if (last && s === last[last.length - 1] + 1) last.push(s);
    else buzzGroups.push([s]);
  }
  console.log('Buzz groups (steps):', buzzGroups.map((g) => `[${g.join(',')}]`).join(' '));

  const loopMs = 32 * STEP_MS;
  const totalMs = loopMs * LOOPS + 1200; // trailing pad for the last figure's tail

  function buildVariant(isolatedWav: Wav, fillWav: Wav): Float64Array {
    const placements: Placement[] = [];
    for (let loop = 0; loop < LOOPS; loop++) {
      const base = loop * loopMs;
      for (const s of kickSteps) placements.push({ atMs: base + s * STEP_MS, wav: kick, gain: 0.9 });
      for (const s of snareSteps) placements.push({ atMs: base + s * STEP_MS, wav: snare, gain: 0.85 });
      for (const s of hatPlainSteps) placements.push({ atMs: base + s * STEP_MS, wav: hatCl, gain: 0.6, family: 'hat' });
      for (const g of buzzGroups) {
        const wav = g.length === 1 ? isolatedWav : fillWav;
        placements.push({ atMs: base + g[0] * STEP_MS, wav, gain: 0.7, family: 'hat' });
      }
    }
    return mix(rate, chokeSampleFamily(placements, rate, 'hat'), totalMs);
  }

  const recommended = buildVariant(tripPickup, crescendo);
  const recPath = path.join(OUT_DIR, 'full_beat_v5_runs.wav');
  const recMeta = writeWavMono16(recPath, rate, recommended);
  console.log(`${recPath}: dur=${(recommended.length / rate).toFixed(2)}s peak=${recMeta.peak.toFixed(3)}${recMeta.normalized ? ' (normalized)' : ''}`);

  const electronic = buildVariant(buzzEl, rollV4);
  const elPath = path.join(OUT_DIR, 'full_beat_electronic.wav');
  const elMeta = writeWavMono16(elPath, rate, electronic);
  console.log(`${elPath}: dur=${(electronic.length / rate).toFixed(2)}s peak=${elMeta.peak.toFixed(3)}${elMeta.normalized ? ' (normalized)' : ''}`);

  // Short "pieces used" back-to-back reference, 0.6 s gaps, RECOMMENDED set only.
  const gapMs = 600;
  const gap = new Float64Array(Math.round((gapMs / 1000) * rate));
  const parts = [kick, snare, hatCl, tripPickup, crescendo].map((w) => new Float64Array(w.samples));
  const withGaps: Float64Array[] = [];
  parts.forEach((p, i) => { if (i > 0) withGaps.push(gap); withGaps.push(p); });
  const piecesTotal = withGaps.reduce((a, p) => a + p.length, 0);
  const pieces = new Float64Array(piecesTotal);
  let off = 0;
  for (const p of withGaps) { pieces.set(p, off); off += p.length; }
  const piecesPath = path.join(OUT_DIR, 'pieces_used_back_to_back.wav');
  const piecesMeta = writeWavMono16(piecesPath, rate, pieces);
  console.log(`${piecesPath}: dur=${(pieces.length / rate).toFixed(2)}s peak=${piecesMeta.peak.toFixed(3)} (order: kick, snare, hat, triplet pickup, crescendo fill)`);

  // ---- verify: re-parse every written file --------------------------------
  for (const p of [recPath, elPath, piecesPath]) {
    const w = readWav(p);
    console.log(`  OK ${p} rate=${w.rate} frames=${w.samples.length}`);
  }
}

main();
