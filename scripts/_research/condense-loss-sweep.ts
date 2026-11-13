/**
 * RESEARCH: how lossy is `condense_drums` really?
 *
 * Answers the SPD-SX-removal question ("would internal drums miss hits?") with
 * an exhaustive sweep rather than a handful of sampled grooves:
 *
 *  A. SIMULTANEITY SWEEP. For every subset of the 13 Kit-40 roles, fire the whole
 *     subset on ONE step and condense onto the 4-voice kit. Counts dropped hits.
 *     This maps the complete failure surface: the exact role-sets that lose a hit.
 *  B. CHOKE EXPOSURE. For representative grooves, compute per-lane inter-onset
 *     intervals and flag lanes where a RINGING role (ride/crash/china/open hat)
 *     retriggers faster than its natural decay — the "mechanical" risk, which is
 *     separate from hit loss and invisible to a drop count.
 *
 * Read-only, no device, no network. `npx tsx scripts/_research/condense-loss-sweep.ts`
 */
import { condenseToKit, DEFAULT_CONDENSE_KIT } from '../../packages/core/src/protocol-generic/patterns/drumCondense.js';
import type { DrumRole } from '../../packages/core/src/protocol-generic/patterns/drumRoles.js';
import type { NeutralPattern, Step } from '../../packages/core/src/protocol-generic/patterns/types.js';

/** The 13 roles Kit 40 actually addresses over MIDI (see wiki spdsx-drum-voice-note-map). */
const KIT40_ROLES: readonly DrumRole[] = [
  'kick', 'snare', 'closed_hat', 'ride', 'open_hat', 'busy_hat', 'snare_roll',
  'crash', 'tom', 'ride_bell', 'sticks', 'china', 'perc',
] as unknown as readonly DrumRole[];

const hit = (velocity = 100): Step => ({ on: true, velocity });
const rest = (): Step => ({ on: false });

/** A 1-step pattern in which every named role fires at once. */
function simultaneous(roles: readonly string[]): NeutralPattern {
  const voices: Record<string, { steps: Step[] }> = {};
  for (const r of roles) voices[r] = { steps: [hit()] };
  return { name: `sim-${roles.length}`, steps: 1, voices };
}

function* combinations<T>(pool: readonly T[], k: number): Generator<T[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  if (k > pool.length) return;
  for (;;) {
    yield idx.map((i) => pool[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === i + pool.length - k) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// ─────────────────────────── A. simultaneity sweep ───────────────────────────
console.log('='.repeat(74));
console.log('A. SIMULTANEITY SWEEP — every role subset fired on one step');
console.log(`   kit = [${DEFAULT_CONDENSE_KIT.join(', ')}]  vocabulary = ${KIT40_ROLES.length} roles`);
console.log('='.repeat(74));
console.log('  k  subsets  lossless   lossy   hits_in  dropped  worst_case');

/** role -> how many times it was the one dropped. */
const blameCount = new Map<string, number>();
const lossyExamplesByK = new Map<number, string[]>();

for (let k = 1; k <= 8; k++) {
  let subsets = 0, lossless = 0, hitsIn = 0, dropped = 0, worst = 0;
  const examples: string[] = [];
  for (const combo of combinations(KIT40_ROLES, k)) {
    subsets++;
    const res = condenseToKit(simultaneous(combo as string[]));
    const lost = res.routings.reduce((a, r) => a + r.dropped, 0)
      + res.unroutable.length; // unroutable placed nothing at all
    hitsIn += k;
    dropped += lost;
    if (lost === 0) lossless++;
    else {
      worst = Math.max(worst, lost);
      for (const c of res.collisions) blameCount.set(c.loser, (blameCount.get(c.loser) ?? 0) + 1);
      if (examples.length < 4) examples.push(`{${(combo as string[]).join('+')}} -${lost}`);
    }
  }
  lossyExamplesByK.set(k, examples);
  const pct = ((lossless / subsets) * 100).toFixed(1);
  console.log(
    `  ${String(k).padStart(1)}  ${String(subsets).padStart(7)}  ${String(lossless).padStart(8)} ${String(subsets - lossless).padStart(7)}` +
    `  ${String(hitsIn).padStart(8)} ${String(dropped).padStart(8)}  ${pct}% lossless`,
  );
}

console.log('\n  First lossy examples per simultaneity k:');
for (const [k, ex] of lossyExamplesByK) {
  if (ex.length) console.log(`    k=${k}: ${ex.join('   ')}`);
}

console.log('\n  Which role LOSES when there is contention (drop count across sweep):');
[...blameCount.entries()].sort((a, b) => b[1] - a[1])
  .forEach(([role, n]) => console.log(`    ${role.padEnd(12)} ${n}`));

// ─────────────────── A2. realistic-simultaneity restriction ──────────────────
// A human drummer has two hands and two feet, so >4 truly simultaneous strikes
// are not playable. Restrict the sweep to physically playable co-hits.
console.log('\n' + '='.repeat(74));
console.log('A2. PHYSICALLY PLAYABLE subsets only (k <= 4, the two-hands-two-feet cap)');
console.log('='.repeat(74));
let pSubsets = 0, pLossless = 0, pDropped = 0;
const lossyPlayable: string[] = [];
for (let k = 1; k <= 4; k++) {
  for (const combo of combinations(KIT40_ROLES, k)) {
    pSubsets++;
    const res = condenseToKit(simultaneous(combo as string[]));
    const lost = res.routings.reduce((a, r) => a + r.dropped, 0) + res.unroutable.length;
    pDropped += lost;
    if (lost === 0) pLossless++;
    else lossyPlayable.push(`{${(combo as string[]).join('+')}} -${lost}`);
  }
}
console.log(`  ${pSubsets} playable subsets, ${pLossless} lossless (${((pLossless / pSubsets) * 100).toFixed(1)}%), ${pDropped} hits dropped total`);
if (lossyPlayable.length) {
  console.log(`  The ${lossyPlayable.length} lossy playable combinations:`);
  lossyPlayable.forEach((e) => console.log(`    ${e}`));
} else {
  console.log('  NO playable subset loses a hit.');
}

// ───────────────────────── B. choke exposure analysis ────────────────────────
/** Approximate natural decay of each role, seconds, at typical kit levels. */
const DECAY_S: Readonly<Record<string, number>> = {
  kick: 0.35, snare: 0.40, closed_hat: 0.12, busy_hat: 0.12, sticks: 0.08,
  open_hat: 0.90, ride: 1.80, ride_bell: 1.60, crash: 3.00, china: 2.60,
  tom: 0.70, snare_roll: 0.60, perc: 0.40, clap: 0.30,
};

interface Groove { name: string; bpm: number; steps: number; voices: Record<string, string> }

/** `x` = hit, `-` = rest. One bar, `steps` columns. */
const GROOVES: readonly Groove[] = [
  {
    name: 'Soul-shape (soul 16ths, hat timekeeper)', bpm: 80, steps: 16,
    voices: {
      kick:       'x-----x---x-----',
      snare:      '----x-------x---',
      closed_hat: 'x-x-x-x-x-x-x-x-',
      perc:       '--x---x---x---x-',
    },
  },
  {
    name: 'Reggae-shape (reggae-rock, ride timekeeper + crash)', bpm: 83, steps: 16,
    voices: {
      kick:       'x-------x-------',
      snare:      '----x-------x---',
      ride:       'x-x-x-x-x-x-x-x-',
      crash:      'x---------------',
    },
  },
  {
    name: 'Rock 8ths, crash on 1 (worst realistic cymbal case)', bpm: 120, steps: 16,
    voices: {
      kick:       'x---x---x---x---',
      snare:      '----x-------x---',
      closed_hat: 'x-x-x-x-x-x-x-x-',
      crash:      'x-------x-------',
    },
  },
  {
    name: '9-voice set (documented full vocabulary)', bpm: 72, steps: 16,
    voices: {
      kick:       'x-----x---x-----',
      snare:      '----x-------x---',
      clap:       '----x-----------',
      closed_hat: 'x-x-x-x-x-x-x-x-',
      open_hat:   '------x---------',
      crash:      'x---------------',
      tom:        '------------x-x-',
      ride:       '--------x-x-x-x-',
      perc:       '--x-------x-----',
    },
  },
];

console.log('\n' + '='.repeat(74));
console.log('B. CHOKE EXPOSURE — does a lane retrigger faster than its sample decays?');
console.log('='.repeat(74));

for (const g of GROOVES) {
  const secPerStep = (60 / g.bpm) / (g.steps / 4); // 4 beats per bar
  const voices: Record<string, { steps: Step[] }> = {};
  for (const [v, s] of Object.entries(g.voices)) {
    voices[v] = { steps: [...s].map((c) => (c === 'x' ? hit() : rest())) };
  }
  const pattern: NeutralPattern = { name: g.name, steps: g.steps, voices };
  const res = condenseToKit(pattern);

  const hitsIn = Object.values(g.voices).reduce((a, s) => a + [...s].filter((c) => c === 'x').length, 0);
  const placed = res.routings.reduce((a, r) => a + r.placed, 0);
  const drops = res.routings.reduce((a, r) => a + r.dropped, 0);

  console.log(`\n  ${g.name}`);
  console.log(`    ${g.bpm} bpm, ${g.steps} steps, one step = ${(secPerStep * 1000).toFixed(0)} ms`);
  console.log(`    hits in ${hitsIn} -> placed ${placed}, dropped ${drops}, collisions ${res.collisions.length}`);
  for (const c of res.collisions) {
    console.log(`      step ${c.step + 1}: ${c.winner} kept, ${c.loser} DROPPED (track ${c.track + 1})`);
  }

  // Per condensed lane: min inter-onset interval vs the decay of what plays there.
  for (const [trackIdx, voice] of Object.entries(res.pattern.voices)) {
    void trackIdx;
    void voice;
  }
  res.routings.forEach(() => { /* per-routing detail printed below */ });

  const laneOnsets = new Map<number, number[]>();
  const laneRoles = new Map<number, Set<string>>();
  for (const r of res.routings) {
    const src = g.voices[r.voice];
    if (!src) continue;
    const onsets = laneOnsets.get(r.track) ?? [];
    [...src].forEach((c, i) => { if (c === 'x') onsets.push(i); });
    laneOnsets.set(r.track, onsets);
    const roles = laneRoles.get(r.track) ?? new Set<string>();
    roles.add(r.role);
    laneRoles.set(r.track, roles);
  }

  for (const [track, onsetsRaw] of [...laneOnsets.entries()].sort((a, b) => a[0] - b[0])) {
    const onsets = [...new Set(onsetsRaw)].sort((a, b) => a - b);
    if (onsets.length < 2) continue;
    let minGap = Infinity;
    for (let i = 1; i < onsets.length; i++) minGap = Math.min(minGap, onsets[i] - onsets[i - 1]);
    // wrap-around gap (the loop repeats)
    minGap = Math.min(minGap, (onsets[0] + g.steps) - onsets[onsets.length - 1]);
    const gapMs = minGap * secPerStep * 1000;
    const roles = [...(laneRoles.get(track) ?? [])];
    const worstDecay = Math.max(...roles.map((r) => DECAY_S[r] ?? 0.3)) * 1000;
    const ratio = worstDecay / gapMs;
    const verdict = ratio <= 1 ? 'clean'
      : ratio <= 2 ? `mild truncation (${ratio.toFixed(1)}x)`
        : `HARD CHOKE (${ratio.toFixed(1)}x)`;
    console.log(
      `    lane ${track + 1} (${DEFAULT_CONDENSE_KIT[track]}) carries [${roles.join(', ')}]: ` +
      `min gap ${gapMs.toFixed(0)} ms vs decay ${worstDecay.toFixed(0)} ms -> ${verdict}`,
    );
  }
}

console.log('\nDone.');
