/**
 * Euclidean (Bjorklund) rhythm generator.
 *
 * `euclid(k, n, rotation)` spreads `k` hits as evenly as possible across
 * `n` steps, the canonical Euclidean rhythm. `E(3,8)` = tresillo
 * (`x..x..x.`), `E(5,16)` = a common offbeat hat, etc. The output is
 * rotated to START on a hit (canonical form), then optionally rotated
 * LEFT by `rotation` steps.
 *
 * Implementation is true Bjorklund (the recursive count/remainder method),
 * verified against the `E(3,8)=x..x..x.` golden in verify-patterns.ts.
 */

import type { Step } from './types.js';
import { PatternError } from './types.js';

/** Raw Bjorklund: returns an array of 0/1 of length `steps`, starting on a hit. */
function bjorklund(pulses: number, steps: number): number[] {
  if (pulses <= 0) return new Array(steps).fill(0);
  if (pulses >= steps) return new Array(steps).fill(1);

  const counts: number[] = [];
  const remainders: number[] = [pulses];
  let divisor = steps - pulses;
  let level = 0;
  for (;;) {
    counts.push(Math.floor(divisor / remainders[level]));
    remainders.push(divisor % remainders[level]);
    divisor = remainders[level];
    level += 1;
    if (remainders[level] <= 1) break;
  }
  counts.push(divisor);

  const pattern: number[] = [];
  const build = (lvl: number): void => {
    if (lvl === -1) {
      pattern.push(0);
    } else if (lvl === -2) {
      pattern.push(1);
    } else {
      for (let i = 0; i < counts[lvl]; i++) build(lvl - 1);
      if (remainders[lvl] !== 0) build(lvl - 2);
    }
  };
  build(level);

  // Rotate so the sequence starts on a hit (canonical Euclidean form).
  const first = pattern.indexOf(1);
  return first <= 0 ? pattern : pattern.slice(first).concat(pattern.slice(0, first));
}

/**
 * Euclidean rhythm as a Step[]. `rotation` rotates the canonical pattern
 * LEFT by that many steps (positive = earlier).
 */
export function euclid(k: number, n: number, rotation = 0): Step[] {
  if (!Number.isInteger(n) || n <= 0) {
    throw new PatternError('bad_grid', `Euclid steps must be a positive integer, got ${n}.`);
  }
  if (!Number.isInteger(k) || k < 0 || k > n) {
    throw new PatternError('bad_grid', `Euclid pulses must be 0..${n}, got ${k}.`);
  }
  if (!Number.isInteger(rotation)) {
    throw new PatternError('bad_grid', `Euclid rotation must be an integer, got ${rotation}.`);
  }
  const raw = bjorklund(k, n);
  const r = ((rotation % n) + n) % n;
  const rotated = r === 0 ? raw : raw.slice(r).concat(raw.slice(0, r));
  return rotated.map((bit) => ({ on: bit === 1 }));
}

/** Render a Step[] to the `x..x..x.` form (for goldens + display). */
export function euclidToString(steps: readonly Step[]): string {
  return steps.map((s) => (s.on ? 'x' : '.')).join('');
}
