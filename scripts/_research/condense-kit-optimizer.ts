/**
 * RESEARCH: pick the BEST 4-lane condense kit per song, instead of the default.
 *
 * `condenseToKit(pattern, kit)` takes the kit as a parameter, but every build so
 * far used DEFAULT_CONDENSE_KIT (kick/snare/closed_hat/ride). The loss sweep
 * (condense-loss-sweep.ts) showed the default drops ~20% of hits on real grooves
 * — not because 4 voices is too few, but because the WRONG four families own the
 * lanes (perc folded onto a busy 16th hat lane; crash folded onto a busy ride).
 *
 * This brute-forces all C(13,4)=715 kits per groove and scores them on
 * (hits dropped, then worst choke ratio). Read-only, no device, no network.
 *
 *   npx tsx scripts/_research/condense-kit-optimizer.ts
 */
import { condenseToKit } from '../../packages/core/src/protocol-generic/patterns/drumCondense.js';
import type { DrumRole } from '../../packages/core/src/protocol-generic/patterns/drumRoles.js';
import type { NeutralPattern, Step } from '../../packages/core/src/protocol-generic/patterns/types.js';

const KIT40_ROLES = [
  'kick', 'snare', 'closed_hat', 'ride', 'open_hat', 'busy_hat', 'snare_roll',
  'crash', 'tom', 'ride_bell', 'sticks', 'china', 'perc',
] as const;

const DECAY_S: Readonly<Record<string, number>> = {
  kick: 0.35, snare: 0.40, closed_hat: 0.12, busy_hat: 0.12, sticks: 0.08,
  open_hat: 0.90, ride: 1.80, ride_bell: 1.60, crash: 3.00, china: 2.60,
  tom: 0.70, snare_roll: 0.60, perc: 0.40, clap: 0.30,
};

const hit = (): Step => ({ on: true, velocity: 100 });
const rest = (): Step => ({ on: false });

interface Groove { name: string; bpm: number; steps: number; voices: Record<string, string> }

const GROOVES: readonly Groove[] = [
  {
    name: 'Soul-shape (soul 16ths, hat timekeeper)', bpm: 80, steps: 16,
    voices: {
      kick: 'x-----x---x-----', snare: '----x-------x---',
      closed_hat: 'x-x-x-x-x-x-x-x-', perc: '--x---x---x---x-',
    },
  },
  {
    name: 'Reggae-shape (reggae-rock, ride timekeeper + crash)', bpm: 83, steps: 16,
    voices: {
      kick: 'x-------x-------', snare: '----x-------x---',
      ride: 'x-x-x-x-x-x-x-x-', crash: 'x---------------',
    },
  },
  {
    name: '9-voice set (documented full vocabulary)', bpm: 72, steps: 16,
    voices: {
      kick: 'x-----x---x-----', snare: '----x-------x---', clap: '----x-----------',
      closed_hat: 'x-x-x-x-x-x-x-x-', open_hat: '------x---------', crash: 'x---------------',
      tom: '------------x-x-', ride: '--------x-x-x-x-', perc: '--x-------x-----',
    },
  },
];

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

function toPattern(g: Groove): NeutralPattern {
  const voices: Record<string, { steps: Step[] }> = {};
  for (const [v, s] of Object.entries(g.voices)) {
    voices[v] = { steps: [...s].map((c) => (c === 'x' ? hit() : rest())) };
  }
  return { name: g.name, steps: g.steps, voices };
}

interface Score { dropped: number; worstChoke: number; detail: string[] }

function score(g: Groove, kit: readonly string[]): Score {
  const res = condenseToKit(toPattern(g), kit as unknown as readonly DrumRole[]);
  const dropped = res.routings.reduce((a, r) => a + r.dropped, 0) + res.unroutable.length;
  const secPerStep = (60 / g.bpm) / (g.steps / 4);

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

  let worstChoke = 0;
  const detail: string[] = [];
  for (const [track, raw] of [...laneOnsets.entries()].sort((a, b) => a[0] - b[0])) {
    const onsets = [...new Set(raw)].sort((a, b) => a - b);
    const roles = [...(laneRoles.get(track) ?? [])];
    if (onsets.length < 2) {
      detail.push(`lane ${track + 1} (${kit[track]}) [${roles.join(', ')}]: single hit, clean`);
      continue;
    }
    let minGap = Infinity;
    for (let i = 1; i < onsets.length; i++) minGap = Math.min(minGap, onsets[i] - onsets[i - 1]);
    minGap = Math.min(minGap, (onsets[0] + g.steps) - onsets[onsets.length - 1]);
    const gapMs = minGap * secPerStep * 1000;
    const decayMs = Math.max(...roles.map((r) => DECAY_S[r] ?? 0.3)) * 1000;
    const ratio = decayMs / gapMs;
    worstChoke = Math.max(worstChoke, ratio);
    detail.push(
      `lane ${track + 1} (${kit[track]}) [${roles.join(', ')}]: gap ${gapMs.toFixed(0)} ms vs decay ${decayMs.toFixed(0)} ms = ${ratio.toFixed(1)}x`,
    );
  }
  return { dropped, worstChoke, detail };
}

for (const g of GROOVES) {
  console.log('\n' + '='.repeat(78));
  console.log(g.name);
  console.log('='.repeat(78));

  const base = score(g, ['kick', 'snare', 'closed_hat', 'ride']);
  console.log(`  DEFAULT kit [kick, snare, closed_hat, ride]: dropped ${base.dropped}, worst choke ${base.worstChoke.toFixed(1)}x`);

  const ranked = [...combinations(KIT40_ROLES, 4)]
    .map((kit) => ({ kit, s: score(g, kit) }))
    .sort((a, b) => (a.s.dropped - b.s.dropped) || (a.s.worstChoke - b.s.worstChoke));

  const zeroLoss = ranked.filter((r) => r.s.dropped === 0);
  console.log(`  ${zeroLoss.length} of ${ranked.length} kits are ZERO-LOSS. Best 3 by choke:`);
  ranked.slice(0, 3).forEach((r, i) => {
    console.log(`\n   ${i + 1}. [${r.kit.join(', ')}]  dropped ${r.s.dropped}, worst choke ${r.s.worstChoke.toFixed(1)}x`);
    r.s.detail.forEach((d) => console.log(`        ${d}`));
  });
}

console.log('\nDone.');
