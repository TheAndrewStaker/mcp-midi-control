/**
 * Re-bar a range of a Songsterr part: play it at a different notated tempo without changing
 * how it sounds. A tab notated half-time (80 BPM where the record is 160) or
 * double-time (verses at 141 BPM against the song's 72) becomes a target whose
 * tempo is the musical one, so a clock-synced looper or pedal sees the right BPM.
 *
 * factor 2: every beat in the range lasts twice as many beats at twice the bpm (same seconds).
 *   A bar becomes two bars of its own metre, or one bar of the doubled metre when the
 *   denominator allows it (3/8 -> 3/4).
 * factor 0.5: two bars of one metre become one bar of that metre at half the bpm. A bar left
 *   without a partner (an odd count, or a metre change) halves alone (2/4 -> 1/4, 3/4 -> 3/8).
 *
 * Measures are the tab's, 1-based inclusive. The result maps every tab measure to the bars it
 * became, so section ranges written in tab measures can be translated (`translateRange`).
 */

import type { MeasureInfo, SongsterrFlat, SongsterrMelodicFlat, TempoMark } from './songsterr.js';

export interface RebarRange {
  /** First tab measure, 1-based. */
  from: number;
  /** Last tab measure, inclusive. */
  to: number;
  factor: 2 | 0.5;
}

export interface RebarMap {
  /** tab measure (0-based) -> [first, last] new bar (0-based). Two tab bars merged by x0.5 share one. */
  bars: [number, number][];
  /** tab measure (0-based) -> its factor (1 outside every range). */
  factors: number[];
  /** Old beat -> new beat (piecewise linear). */
  beat: (b: number) => number;
}

interface Piece { oldStart: number; oldEnd: number; newStart: number; k: number }

const lengthOf = (sig: [number, number]) => (sig[0] * 4) / sig[1];

/** Plan the new bar list and the beat map from one part's measures. */
export function planRebar(measures: readonly MeasureInfo[], totalBeats: number, ranges: readonly RebarRange[]): {
  map: RebarMap; measures: MeasureInfo[]; totalBeats: number; pieces: Piece[];
} {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  sorted.forEach((r, i) => {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from < 1 || r.to < r.from || r.to > measures.length) {
      throw new Error(`rebar m${r.from}-${r.to} is outside the song (1..${measures.length})`);
    }
    if (r.factor !== 2 && r.factor !== 0.5) throw new Error(`rebar factor must be 2 or 0.5: ${r.factor}`);
    if (i > 0 && r.from <= sorted[i - 1].to) throw new Error(`rebar ranges overlap at m${r.from}`);
  });
  const rangeAt = (m: number) => sorted.findIndex((r) => m + 1 >= r.from && m + 1 <= r.to);
  const factorAt = (m: number): number => sorted[rangeAt(m)]?.factor ?? 1;
  const endOf = (m: number) => (m + 1 < measures.length ? measures[m + 1].startBeat : totalBeats);

  const out: MeasureInfo[] = [];
  const bars: [number, number][] = [];
  const pieces: Piece[] = [];
  let at = 0;
  const push = (sig: [number, number], src: MeasureInfo, k: number) => {
    out.push({ ...src, index: out.length, startBeat: at, signature: sig, ...(src.bpm !== undefined ? { bpm: src.bpm * k } : {}) });
    at += lengthOf(sig);
    return out.length - 1;
  };
  for (let m = 0; m < measures.length; m++) {
    const src = measures[m];
    const len = endOf(m) - src.startBeat;
    const k = factorAt(m);
    const start = at;
    pieces.push({ oldStart: src.startBeat, oldEnd: endOf(m), newStart: start, k });
    if (k === 1) {
      const i = push(src.signature, src, 1);
      bars.push([i, i]);
    } else if (k === 2) {
      const [n, d] = src.signature;
      if (len * 2 <= lengthOf(src.signature) + 1e-9) {          // a short last bar: one bar, as written
        const i = push(src.signature, src, 2);
        bars.push([i, i]);
      } else if (d >= 8) {
        const i = push([n, d / 2], src, 2);
        bars.push([i, i]);
      } else {
        const i = push([n, d], src, 2);
        const j = push([n, d], { ...src, marker: undefined }, 2);
        bars.push([i, j]);
      }
    } else {
      const next = measures[m + 1];
      const pair = next && rangeAt(m + 1) === rangeAt(m) && next.signature[0] === src.signature[0] && next.signature[1] === src.signature[1];
      if (pair) {
        const i = push(src.signature, src, 0.5);
        bars.push([i, i], [i, i]);
        pieces.push({ oldStart: next.startBeat, oldEnd: endOf(m + 1), newStart: start + len * 0.5, k: 0.5 });
        at = start + (endOf(m + 1) - src.startBeat) * 0.5;
        m++;
        continue;
      } else {
        const [n, d] = src.signature;
        const i = push(n % 2 === 0 ? [n / 2, d] : [n, d * 2], src, 0.5);
        bars.push([i, i]);
      }
    }
    at = start + len * k;          // the bar's real length (a short last bar stays as written)
  }
  const beat = (b: number): number => {
    const p = pieces.find((x) => b >= x.oldStart && b < x.oldEnd) ?? (b >= totalBeats ? pieces[pieces.length - 1] : pieces[0]);
    return p.newStart + (b - p.oldStart) * p.k;
  };
  const factors = measures.map((_, m) => factorAt(m));
  return { map: { bars, factors, beat }, measures: out, totalBeats: at, pieces };
}

function rebarTempos(given: readonly TempoMark[], plan: ReturnType<typeof planRebar>, fallbackBpm?: number): TempoMark[] {
  if (!given.length && fallbackBpm === undefined) throw new Error('rebar needs a tempo: the part has no tempo map and no bpm');
  const tempos = given.length ? given : [{ measure: 0, beat: 0, bpm: fallbackBpm! }];
  const kAt = (b: number) => plan.pieces.find((p) => b >= p.oldStart - 1e-9 && b < p.oldEnd - 1e-9)?.k ?? 1;
  const bpmAt = (b: number) => [...tempos].reverse().find((t) => t.beat <= b + 1e-9)?.bpm ?? tempos[0].bpm;
  const marks = new Map<number, number>();
  for (const t of tempos) marks.set(t.beat, t.bpm);
  // Every place the factor changes needs a mark, so the bpm in force is scaled exactly there.
  for (let i = 0; i < plan.pieces.length; i++) {
    const p = plan.pieces[i];
    if (i === 0 || plan.pieces[i - 1].k !== p.k) if (!marks.has(p.oldStart)) marks.set(p.oldStart, bpmAt(p.oldStart));
  }
  const out = [...marks.entries()].sort((a, b) => a[0] - b[0]).map(([b, bpm]) => {
    const nb = plan.map.beat(b);
    const measure = plan.measures.findIndex((m, i) => nb >= m.startBeat - 1e-9 && (i + 1 === plan.measures.length || nb < plan.measures[i + 1].startBeat - 1e-9));
    return { measure: Math.max(0, measure), beat: nb, bpm: Math.round(bpm * kAt(b) * 1000) / 1000 };
  });
  return out.filter((t, i) => i === 0 || t.bpm !== out[i - 1].bpm);
}

/** A drum part re-barred. */
export function rebarDrums(flat: SongsterrFlat, ranges: readonly RebarRange[]): { flat: SongsterrFlat; map: RebarMap } {
  const plan = planRebar(flat.measures, flat.totalBeats, ranges);
  const tempos = rebarTempos(flat.tempos, plan, flat.bpm);
  return {
    map: plan.map,
    flat: {
      ...flat, measures: plan.measures, totalBeats: plan.totalBeats, tempos, bpm: tempos[0]?.bpm ?? flat.bpm,
      events: flat.events.map((e) => ({ ...e, beat: plan.map.beat(e.beat) })),
    },
  };
}

/** A pitched part re-barred: onsets and lengths both follow the beat map. */
export function rebarMelodic(flat: SongsterrMelodicFlat, ranges: readonly RebarRange[]): { flat: SongsterrMelodicFlat; map: RebarMap } {
  const plan = planRebar(flat.measures, flat.totalBeats, ranges);
  const tempos = rebarTempos(flat.tempos, plan, flat.bpm);
  return {
    map: plan.map,
    flat: {
      ...flat, measures: plan.measures, totalBeats: plan.totalBeats, tempos, bpm: tempos[0]?.bpm ?? flat.bpm,
      notes: flat.notes.map((n) => {
        const a = plan.map.beat(n.beat);
        // The bend envelope's span goes through the same beat map, or its ramps play in the wrong time.
        const span = n.bendBeats === undefined ? {} : { bendBeats: plan.map.beat(n.beat + n.bendBeats) - a };
        const vib = n.vibrato === undefined ? {} : {
          vibrato: { ...n.vibrato, from: plan.map.beat(n.beat + n.vibrato.from) - a, to: plan.map.beat(n.beat + n.vibrato.to) - a },
        };
        return { ...n, beat: a, durationBeats: plan.map.beat(n.beat + n.durationBeats) - a, ...span, ...vib };
      }),
    },
  };
}

/**
 * A borrow (a part's material taken from tab measure `at` for a section of tab measures
 * `from..to`) -> the new start bar. The borrowed window must re-bar exactly like the section,
 * bar for bar, or the borrowed material would play another number of tab bars at another speed.
 */
export function translateBorrow(map: RebarMap, at: number, from: number, to: number, what: string): number {
  const n = to - from;
  const win = translateRange(map, at, at + n, `${what} (its source m${at}-${at + n})`);
  for (let i = 0; i <= n; i++) {
    if (map.factors[at - 1 + i] !== map.factors[from - 1 + i]) {
      throw new Error(`${what}: m${at + i} re-bars x${map.factors[at - 1 + i]} but the section's m${from + i} re-bars x${map.factors[from - 1 + i]}`);
    }
  }
  return win.from;
}

/**
 * A section written in tab measures -> the new bars. Refuses a boundary that falls inside a pair
 * of tab bars that x0.5 merged into one bar (it would cut the new bar in half).
 */
export function translateRange(map: RebarMap, from: number, to: number, what: string): { from: number; to: number } {
  const b = map.bars;
  if (from < 1 || to > b.length || to < from) throw new Error(`${what} m${from}-${to} is outside the song (1..${b.length})`);
  if (from > 1 && b[from - 1][0] === b[from - 2][1]) throw new Error(`${what} starts at m${from}, inside a bar the x0.5 re-bar merged with m${from - 1}`);
  if (to < b.length && b[to - 1][1] === b[to][0]) throw new Error(`${what} ends at m${to}, inside a bar the x0.5 re-bar merged with m${to + 1}`);
  return { from: b[from - 1][0] + 1, to: b[to - 1][1] + 1 };
}
