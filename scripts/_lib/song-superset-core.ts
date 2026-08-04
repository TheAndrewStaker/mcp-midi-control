/**
 * Superset-analysis core, factored out of `scripts/song-superset.ts` so that
 * `scripts/song-interview-brief.ts` can run the SAME analysis without spawning
 * the CLI.
 *
 * WHY A COPY AND NOT AN IMPORT
 * ----------------------------
 * `song-superset.ts` is a self-executing CLI: it runs `main()` at module load
 * and every analysis function in it is module-private, so it cannot be imported
 * without both running its network fetch and getting nothing back. The bodies
 * below are VERBATIM copies of that script's functions (2026-07-29), with
 * `export` added and nothing else changed. `song-superset.ts` remains the
 * canonical statement of WHY each verdict rung is safe (its module header);
 * if the algorithm changes there, change it here in the same session, and the
 * interview-brief validation against a hand-written briefing is the drift alarm.
 *
 * Everything in this file is pure and network-free: it takes already-flattened
 * Songsterr parts and a chop plan, and compares authored images at the target
 * grid. See `song-superset.ts` for the tolerance ladder (EXACT / PREFIX /
 * NEAR / TRANSPOSE) and why percentage similarity is deliberately not offered.
 */

import {
  flattenSongsterrDrums, flattenSongsterrMelodic, isMelodicPart,
  type SongsterrPart, type MeasureInfo,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';
import {
  type SongChopPlan, type ChopProject,
} from '@mcp-midi-control/core/protocol-generic/patterns/songChop.js';

// ── canonical content ────────────────────────────────────────────────

/**
 * One bar of one part, as the AUTHORED IMAGE would look at the target grid.
 *
 * The signature is part of the token so that in mixed metre two bars of
 * different length can never compare equal by accident: a 5/8 bar and a 7/8 bar
 * holding the same first ten steps are not the same bar.
 *
 * Melodic: `step:pitch:gate` per note, sorted. Gate is the quantised sounding
 * length in steps (ties already folded in by the flattener), clamped to at least
 * one step. Drum: `step:voice` per hit, sorted and de-duplicated.
 */
export interface BarToken { sig: string; body: string }

export interface PartWindow {
  partId: number;
  label: string;
  melodic: boolean;
  /** Bar tokens, one per measure of the song, index-aligned to the measure walk. */
  bars: BarToken[];
  /** Onsets whose quantised step moved by more than half a step. */
  quantMoved: number;
  /** Notes carrying a dynamic the authored image cannot express. */
  velocityBlind: number;
}

export const sigOf = (m: MeasureInfo): string => `${m.signature[0]}/${m.signature[1]}`;

export function measureSteps(m: MeasureInfo, spb: number): number {
  return Math.max(1, Math.round(((m.signature[0] * 4) / m.signature[1]) * spb));
}

/** Index of the measure containing `beat`. */
export function measureOf(measures: readonly MeasureInfo[], beat: number): number {
  let lo = 0; let hi = measures.length - 1; let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measures[mid].startBeat <= beat + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function buildPartWindow(
  partId: number, label: string, part: SongsterrPart, measures: readonly MeasureInfo[], spb: number,
): PartWindow {
  const melodic = isMelodicPart(part);
  const cells: string[][] = measures.map(() => []);
  let quantMoved = 0;
  let velocityBlind = 0;

  const place = (beat: number, make: (step: number) => string): void => {
    const mi = measureOf(measures, beat);
    if (mi < 0 || mi >= measures.length) return;
    const raw = (beat - measures[mi].startBeat) * spb;
    const step = Math.round(raw);
    if (Math.abs(raw - step) > 0.001) quantMoved++;
    const cap = measureSteps(measures[mi], spb);
    cells[mi].push(make(Math.min(Math.max(step, 0), cap - 1)));
  };

  if (melodic) {
    const flat = flattenSongsterrMelodic(part);
    for (const n of flat.notes) {
      if (n.velocity !== undefined) velocityBlind++;
      const gate = Math.max(1, Math.round(n.durationBeats * spb));
      place(n.beat, (s) => `${s}:${n.pitch}:${gate}`);
    }
  } else {
    const flat = flattenSongsterrDrums(part);
    for (const e of flat.events) place(e.beat, (s) => `${s}:${e.voice}`);
  }

  return {
    partId, label, melodic, quantMoved, velocityBlind,
    bars: measures.map((m, i) => ({ sig: sigOf(m), body: [...new Set(cells[i])].sort().join(' ') })),
  };
}

/** Same token with every pitch shifted down to a zero-based root: the transpose-blind form. */
export function transposeBlindBar(t: BarToken): string {
  const notes = t.body.split(' ').filter(Boolean);
  const pitches = notes.map((n) => Number(n.split(':')[1])).filter((p) => Number.isFinite(p));
  if (pitches.length === 0) return t.body;
  const base = Math.min(...pitches);
  return notes.map((n) => {
    const [s, p, g] = n.split(':');
    return g === undefined ? n : `${s}:${Number(p) - base}:${g}`;
  }).sort().join(' ');
}

// ── window comparison ────────────────────────────────────────────────

export interface Window {
  /** 1-based project number from the chop. */
  project: number;
  name: string;
  section: string;
  /** 0-based inclusive measure indices. */
  from: number;
  to: number;
  bars: number;
  steps: number;
  /** partId → joined bar tokens over this window (empty string when silent). */
  content: Map<number, string>;
  /** partId → transpose-blind joined bar tokens. */
  shape: Map<number, string>;
  /** Parts that SOUND here. */
  sounding: number[];
  /** Metre sequence, so two windows of equal bar count but different metre never match. */
  metre: string;
  /** Smallest bar-period the whole window repeats on, or undefined when it does not. */
  period?: number;
  /** Bars of DISTINCT content: the period when the window loops, else its full length. */
  cellBars: number;
  /** partId → bar tokens over the CELL only. */
  cell: Map<number, string>;
  /** Metre sequence of the cell. */
  cellMetre: string;
  /** The window is not a whole number of cells, so the last cycle is cut short. */
  partialCycle: boolean;
}

export type Verdict = 'IDENTICAL' | 'EXACT' | 'PREFIX' | 'NEAR' | 'TRANSPOSE';

export interface Pair {
  /** The window that could be DROPPED. */
  subject: number;
  /** The window that would be AUTHORED and reached by muting. */
  cover: number;
  verdict: Verdict;
  /** Parts to mute on `cover` to hear `subject`. */
  mute: string[];
  /** For NEAR: the parts that do not match. */
  differs: string[];
  /** For TRANSPOSE: semitone offset, when one constant explains every part. */
  semitones?: number;
  /** For PREFIX: cover's surplus bars are silent on every part subject uses. */
  tail_clear?: boolean;
  /** Set when the merge holds on the CELL but the two windows run for different bar counts. */
  loop_lengths?: [number, number];
  saves: boolean;
}

export function joinBars(w: { from: number; to: number }, bars: readonly BarToken[]): string {
  const out: string[] = [];
  for (let i = w.from; i <= w.to; i++) out.push(`${bars[i].sig}|${bars[i].body}`);
  return out.join('||');
}

export const barRow = (i: number, parts: readonly PartWindow[]): string =>
  parts.map((p) => `${p.bars[i].sig}|${p.bars[i].body}`).join('#');

/**
 * Smallest bar-period the window repeats on, allowing a PARTIAL final cycle.
 * Every bar still has to match its counterpart exactly, so this loosens the
 * WINDOW, never the content.
 */
export function detectPeriod(from: number, to: number, parts: readonly PartWindow[]): number | undefined {
  const n = to - from + 1;
  const rows = Array.from({ length: n }, (_, i) => barRow(from + i, parts));
  for (let p = 1; p < n; p++) {
    let ok = true;
    for (let i = p; i < n && ok; i++) if (rows[i] !== rows[i % p]) ok = false;
    if (ok) return p;
  }
  return undefined;
}

/**
 * How much DISTINCT content the song actually holds, at bar granularity.
 * A song whose 107 bars are 12 distinct bars is a scene-arrangement problem,
 * not a 10-project problem.
 */
export function census(parts: readonly PartWindow[], measureCount: number): {
  bars: number; distinct_rows: number; per_part: { label: string; distinct: number; sounding: number }[];
} {
  const rows = new Set<string>();
  for (let i = 0; i < measureCount; i++) rows.add(barRow(i, parts));
  return {
    bars: measureCount,
    distinct_rows: rows.size,
    per_part: parts.map((p) => {
      const s = new Set<string>();
      let sounding = 0;
      for (const b of p.bars) { s.add(`${b.sig}|${b.body}`); if (b.body !== '') sounding++; }
      return { label: p.label, distinct: s.size, sounding };
    }),
  };
}

export function buildWindows(plan: SongChopPlan, parts: readonly PartWindow[]): Window[] {
  return plan.projects.map((proj: ChopProject) => {
    const from = proj.from_measure - 1;
    const to = proj.to_measure - 1;
    const content = new Map<number, string>();
    const shape = new Map<number, string>();
    const sounding: number[] = [];
    for (const p of parts) {
      const c = joinBars({ from, to }, p.bars);
      content.set(p.partId, c);
      const sh: string[] = [];
      for (let i = from; i <= to; i++) sh.push(`${p.bars[i].sig}|${transposeBlindBar(p.bars[i])}`);
      shape.set(p.partId, sh.join('||'));
      let any = false;
      for (let i = from; i <= to && !any; i++) if (p.bars[i].body !== '') any = true;
      if (any) sounding.push(p.partId);
    }
    const metre: string[] = [];
    for (let i = from; i <= to; i++) metre.push(parts[0]?.bars[i].sig ?? '?');
    const period = detectPeriod(from, to, parts);
    const cellBars = period ?? proj.bars;
    const cellTo = from + cellBars - 1;
    const cell = new Map<number, string>();
    for (const p of parts) cell.set(p.partId, joinBars({ from, to: cellTo }, p.bars));
    return {
      project: proj.project, name: proj.name, section: proj.section,
      from, to, bars: proj.bars, steps: proj.steps,
      content, shape, sounding, metre: metre.join(','),
      ...(period !== undefined ? { period } : {}),
      cellBars, cell, cellMetre: metre.slice(0, cellBars).join(','),
      partialCycle: proj.bars % cellBars !== 0,
    };
  });
}

/** Constant semitone offset that turns `a`'s pitches into `b`'s, or undefined. */
export function constantOffset(a: string, b: string): number | undefined {
  const pa = [...a.matchAll(/\d+:(-?\d+):\d+/g)].map((m) => Number(m[1]));
  const pb = [...b.matchAll(/\d+:(-?\d+):\d+/g)].map((m) => Number(m[1]));
  if (pa.length === 0 || pa.length !== pb.length) return undefined;
  const k = pb[0] - pa[0];
  for (let i = 1; i < pa.length; i++) if (pb[i] - pa[i] !== k) return undefined;
  return k;
}

export function classify(subject: Window, cover: Window, parts: readonly PartWindow[], label: (id: number) => string): Pair | undefined {
  if (subject.project === cover.project) return undefined;

  // Compare CELLS, not raw windows: a window that repeats on a bar-period is
  // reproduced exactly by authoring one period and letting the project loop.
  const mismatched = subject.sounding.filter((p) => subject.cell.get(p) !== cover.cell.get(p));
  const sameShape = subject.cellBars === cover.cellBars && subject.cellMetre === cover.cellMetre;

  if (sameShape && mismatched.length === 0) {
    const mute = cover.sounding.filter((p) => !subject.sounding.includes(p)).map(label);
    const identical = mute.length === 0 && cover.sounding.length === subject.sounding.length;
    return {
      subject: subject.project, cover: cover.project,
      verdict: identical ? 'IDENTICAL' : 'EXACT',
      mute, differs: [], saves: true,
      ...(subject.bars !== cover.bars ? { loop_lengths: [subject.bars, cover.bars] as [number, number] } : {}),
    };
  }

  // PREFIX: subject's bars equal cover's opening bars, part for part.
  if (subject.bars < cover.bars) {
    const head = { from: cover.from, to: cover.from + subject.bars - 1 };
    let ok = true;
    for (const p of subject.sounding) {
      const part = parts.find((x) => x.partId === p);
      if (part === undefined) { ok = false; break; }
      if (subject.content.get(p) !== joinBars(head, part.bars)) { ok = false; break; }
    }
    const metreOk = subject.metre === cover.metre.split(',').slice(0, subject.bars).join(',');
    if (ok && metreOk) {
      let tailClear = true;
      for (const p of subject.sounding) {
        const part = parts.find((x) => x.partId === p);
        if (part === undefined) continue;
        for (let i = head.to + 1; i <= cover.to && tailClear; i++) if (part.bars[i].body !== '') tailClear = false;
      }
      return {
        subject: subject.project, cover: cover.project, verdict: 'PREFIX',
        mute: cover.sounding.filter((p) => !subject.sounding.includes(p)).map(label),
        differs: [], tail_clear: tailClear, saves: tailClear,
      };
    }
  }

  if (!sameShape) return undefined;

  // TRANSPOSE: identical shape, one constant semitone offset across every part.
  if (mismatched.length > 0) {
    const offsets = subject.sounding.map((p) => constantOffset(subject.cell.get(p) ?? '', cover.cell.get(p) ?? ''));
    const shapesMatch = subject.bars === cover.bars && subject.sounding.every((p) => subject.shape.get(p) === cover.shape.get(p));
    if (shapesMatch && offsets.every((o) => o !== undefined && o === offsets[0]) && offsets[0] !== 0) {
      return {
        subject: subject.project, cover: cover.project, verdict: 'TRANSPOSE',
        mute: [], differs: [], semitones: offsets[0], saves: false,
      };
    }
  }

  if (mismatched.length > 0 && mismatched.length <= 2) {
    return {
      subject: subject.project, cover: cover.project, verdict: 'NEAR',
      mute: cover.sounding.filter((p) => !subject.sounding.includes(p)).map(label),
      differs: mismatched.map(label), saves: false,
    };
  }
  return undefined;
}

/**
 * Greedy set cover over the "reachable by muting" relation. Greedy is not
 * guaranteed optimal, so the number it produces is an ACHIEVABLE saving and
 * never a proven minimum.
 */
export function cover(windows: readonly Window[], pairs: readonly Pair[]): { authored: number[]; absorbed: Map<number, number> } {
  const reach = new Map<number, Set<number>>();
  for (const w of windows) reach.set(w.project, new Set([w.project]));
  for (const p of pairs) if (p.saves) reach.get(p.cover)?.add(p.subject);

  const remaining = new Set(windows.map((w) => w.project));
  const authored: number[] = [];
  const absorbed = new Map<number, number>();
  while (remaining.size > 0) {
    let best = -1; let bestGain = -1;
    for (const w of windows) {
      const gain = [...(reach.get(w.project) ?? [])].filter((x) => remaining.has(x)).length;
      if (gain > bestGain || (gain === bestGain && best !== -1 && w.project < best)) { bestGain = gain; best = w.project; }
    }
    if (best === -1 || bestGain <= 0) break;
    authored.push(best);
    for (const x of reach.get(best) ?? []) {
      if (!remaining.has(x)) continue;
      remaining.delete(x);
      if (x !== best) absorbed.set(x, best);
    }
  }
  authored.sort((a, b) => a - b);
  return { authored, absorbed };
}

/**
 * Rank pairs, keep only the strongest verdict per (subject, cover), and return
 * them sorted the way `song-superset.ts` reports them. Verbatim from the CLI's
 * inline dedupe, wrapped as a function.
 */
export function dedupePairs(pairs: readonly Pair[]): Pair[] {
  const rank: Record<Verdict, number> = { IDENTICAL: 0, EXACT: 1, PREFIX: 2, TRANSPOSE: 3, NEAR: 4 };
  const best = new Map<string, Pair>();
  for (const p of pairs) {
    const k = `${p.subject}>${p.cover}`;
    const prev = best.get(k);
    if (prev === undefined || rank[p.verdict] < rank[prev.verdict]) best.set(k, p);
  }
  return [...best.values()].sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.subject - b.subject);
}

/**
 * PATTERN census: distinct 2-bar blocks per part, at even bar alignment.
 *
 * A Circuit pattern is 32 steps, which in 4/4 at 16ths is exactly two bars, and
 * a note track holds 8 of them. Reported only when the metre is uniform, because
 * in mixed metre a bar is not a fixed number of steps and a 2-bar block is not a
 * pattern. Verbatim from the CLI's main().
 */
export function patternCensus(
  parts: readonly PartWindow[], blockBars: number,
): { label: string; distinct_blocks: number; sounding_blocks: number }[] {
  return parts.map((p) => {
    const blocks = new Set<string>();
    let sounding = 0;
    for (let i = 0; i + blockBars <= p.bars.length; i += blockBars) {
      const b = p.bars.slice(i, i + blockBars).map((x) => `${x.sig}|${x.body}`).join('||');
      if (p.bars.slice(i, i + blockBars).every((x) => x.body === '')) continue;
      sounding++;
      blocks.add(b);
    }
    return { label: p.label, distinct_blocks: blocks.size, sounding_blocks: sounding };
  }).sort((a, b) => a.distinct_blocks - b.distinct_blocks);
}

/**
 * Per-part window entropy: over the SHARED window boundaries, how many distinct
 * things does each part actually play? A part with 4 distinct window cells
 * across 31 windows is nearly free; a part with 31 distinct cells is the one
 * setting the project count. Verbatim from the CLI's main().
 */
export function windowEntropy(
  parts: readonly PartWindow[], windows: readonly Window[],
): { label: string; distinct_window_cells: number; silent_windows: number }[] {
  return parts.map((p) => {
    const seen = new Set<string>();
    let silent = 0;
    for (const w of windows) {
      const c = w.cell.get(p.partId) ?? '';
      if (c.replace(/[^|]*\|\|?/g, '') === '' && !w.sounding.includes(p.partId)) { silent++; continue; }
      seen.add(c);
    }
    return { label: p.label, distinct_window_cells: seen.size, silent_windows: silent };
  }).sort((a, b) => a.distinct_window_cells - b.distinct_window_cells);
}

/**
 * "Distortion Guitar (Ludwig | Fender | Lead Guitar 1)" -> "Lead Guitar 1".
 * Contributors put the useful name last; the instrument alone collides (two
 * parts both read "Distortion Guitar", which makes a mute list ambiguous).
 * Verbatim from the CLI's interview generator.
 */
export function shortLabel(s: string): string {
  const m = s.match(/\(([^)]*)\)\s*$/);
  const tail = m?.[1].split('|').pop()?.trim();
  return tail !== undefined && tail !== '' ? tail : s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}
