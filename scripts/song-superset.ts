/**
 * Superset analysis: which of a song's projects can be reached by MUTING another,
 * instead of being authored into a slot of their own.
 *
 * WHY THIS EXISTS
 * ---------------
 * `songChop.ts` answers "how many projects does this song need if every section
 * gets one?". On a long song that number is brutal: Pneuma is 400 bars and chops
 * to ~31 projects, half a 64-slot Circuit pack for one song. The compression the
 * maintainer asked for is not a smarter chop, it is a different question:
 *
 *   "if section B contains everything section A has plus more, author B once and
 *    reach A by pulling faders down at the mixer."
 *
 * That is a SUPERSET relation, and it is per-TRACK, not per-window, because the
 * mixer is per-track. Two windows merge when every part that SOUNDS in A plays
 * exactly the same thing in B; B's extra parts are silenced with a fader.
 *
 * WHY EXACT SECTION HASHING FOUND NOTHING (2026-07-27, Schism / The Pot / Pneuma)
 * ------------------------------------------------------------------------------
 * The earlier pass hashed each section over bass + guitars + drums AS ONE STRING
 * and found zero identical pairs in three songs. That result is correct and it is
 * also the wrong test, twice over:
 *
 *   1. It hashed the WHOLE window. One differing part destroys the match even
 *      when the mixer could have silenced exactly that part. The relation we want
 *      is a per-part containment, not a whole-window equality.
 *   2. It hashed the SOURCE notation. What gets written to the device is the
 *      POST-QUANTISATION image at the target grid. Two sections that differ only
 *      in ways a 16th grid discards produce byte-identical device content. The
 *      right artifact to compare is the one we would author.
 *
 * So the fix is not to loosen the comparison, it is to compare the right thing
 * exactly. That distinction is the whole safety argument: see TOLERANCE below.
 *
 * TOLERANCE, AND WHY EACH RUNG IS SAFE
 * ------------------------------------
 * Four verdicts, in descending confidence. Only the first two are ever proposed
 * as an automatic merge; the rest are interview material.
 *
 *   EXACT      Same bar count, same metre sequence, and for every part sounding
 *              in A the authored image is identical to B's. Safe by construction:
 *              the device literally cannot tell the two apart, so the merge costs
 *              nothing musically. This is an EQUALITY, not a similarity score.
 *
 *   PREFIX     A's bars equal B's FIRST bars(A) bars, part for part. Reachable by
 *              authoring B and stopping early, but a Circuit project LOOPS, so it
 *              is only loop-safe when B's remaining bars are silent on every part
 *              A uses. That condition is computed and reported per pair
 *              (`tail_clear`); a PREFIX without it is a proposal, not a merge.
 *
 *   NEAR(k)    A ⊆ B except on exactly k parts. NEVER auto-merged. It is the
 *              interview question: "Chorus 3 is Chorus 1 with a different bass
 *              fill in the last bar. Same project, or its own?" k and the offending
 *              part are named so the answer is a word, not a research task.
 *
 *   TRANSPOSE  Same shape, every pitch offset by a constant k semitones. Named
 *              because it is musically interesting and because it SAVES NOTHING
 *              TODAY: the mixer cannot transpose. Counting it as a saving would
 *              be a lie, so it is reported in its own column and excluded from
 *              the slot arithmetic.
 *
 * What is deliberately NOT offered: percentage similarity, rhythm-only matching,
 * pitch-class-only matching, and any threshold of the form "90% the same". A 90%
 * correct bassline is a wrong bassline, and a tolerance that cannot say what it
 * discarded cannot be trusted with a slot. The comparison stays exact; only the
 * ARTIFACT being compared was wrong before.
 *
 * WHAT IS IGNORED, ON PURPOSE, AND REPORTED
 * -----------------------------------------
 *   - velocity / dynamics / accents: the note-track authoring path has no
 *     per-note velocity (`velocity-melodic` is UNMET across the repertoire), so a
 *     dynamic difference cannot reach the device. Counted as `velocity_blind`.
 *   - off-grid placement finer than the grid: quantisation is the authoring
 *     reality, and the number of notes it moved is reported per song so a merge
 *     resting on a heavy quantisation is visible.
 *   - ties are LENGTH, already folded by the flattener, so a tie is compared as
 *     gate length and not as a phantom second attack.
 *
 * ALSO COMPUTED
 * -------------
 *   - INTERNAL PERIOD per window: the smallest bar-period the window repeats on.
 *     A 16-bar project that is a 4-bar loop x4 does not save a PROJECT, but it
 *     saves pattern slots and it tells the maintainer the section is a loop.
 *   - The greedy cover: the minimum authored set, and therefore the slot saving
 *     against the naive chop. Greedy set cover, which is not guaranteed optimal;
 *     the number is reported as an achievable saving, never as a proven minimum.
 *
 * Read-only. Network reads Songsterr's public JSON; no device is touched.
 *
 * Usage:
 *   npx tsx scripts/song-superset.ts <url-or-id> [--parts 0,2,4,7] [--cache DIR]
 *                                    [--steps-per-beat 4] [--json OUT.json] [--md OUT.md]
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, isMelodicPart, pitchToken,
  type SongsterrPart, type MeasureInfo,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';
import {
  planSongChop, toChopPart, type ChopPartFlat, type SongChopPlan, type ChopProject,
} from '@mcp-midi-control/core/protocol-generic/patterns/songChop.js';
import {
  fetchSongsterrTracks, fetchSongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterrFetch.js';

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
interface BarToken { sig: string; body: string }

interface PartWindow {
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

const sigOf = (m: MeasureInfo): string => `${m.signature[0]}/${m.signature[1]}`;

function measureSteps(m: MeasureInfo, spb: number): number {
  return Math.max(1, Math.round(((m.signature[0] * 4) / m.signature[1]) * spb));
}

/** Index of the measure containing `beat`. */
function measureOf(measures: readonly MeasureInfo[], beat: number): number {
  let lo = 0; let hi = measures.length - 1; let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measures[mid].startBeat <= beat + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function buildPartWindow(
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
function transposeBlindBar(t: BarToken): string {
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

interface Window {
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

type Verdict = 'IDENTICAL' | 'EXACT' | 'PREFIX' | 'NEAR' | 'TRANSPOSE';

interface Pair {
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

function joinBars(w: { from: number; to: number }, bars: readonly BarToken[]): string {
  const out: string[] = [];
  for (let i = w.from; i <= w.to; i++) out.push(`${bars[i].sig}|${bars[i].body}`);
  return out.join('||');
}

const barRow = (i: number, parts: readonly PartWindow[]): string =>
  parts.map((p) => `${p.bars[i].sig}|${p.bars[i].body}`).join('#');

/**
 * Smallest bar-period the window repeats on, allowing a PARTIAL final cycle.
 *
 * Requiring `n % p === 0` was too strict and it hid the thing worth finding: a
 * 10-bar Intro that is a 4-bar loop played twice and cut off at bar 2 is still a
 * 4-bar loop, and the section markers on a real tab almost never land on a
 * multiple of the loop. A partial final cycle is allowed; every bar still has to
 * match its counterpart exactly, so this loosens the WINDOW, never the content.
 */
function detectPeriod(from: number, to: number, parts: readonly PartWindow[]): number | undefined {
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
 *
 * A project's real ceiling is 8 patterns x 32 steps of distinct content per
 * track; scenes then re-select those patterns. So "how many distinct bars does
 * this song contain" is a different and larger compression question from "which
 * sections are supersets of which", and it is cheap to answer. A song whose 107
 * bars are 12 distinct bars is a scene-arrangement problem, not a 10-project
 * problem.
 */
function census(parts: readonly PartWindow[], measureCount: number): {
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

function buildWindows(plan: SongChopPlan, parts: readonly PartWindow[]): Window[] {
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
function constantOffset(a: string, b: string): number | undefined {
  const pa = [...a.matchAll(/\d+:(-?\d+):\d+/g)].map((m) => Number(m[1]));
  const pb = [...b.matchAll(/\d+:(-?\d+):\d+/g)].map((m) => Number(m[1]));
  if (pa.length === 0 || pa.length !== pb.length) return undefined;
  const k = pb[0] - pa[0];
  for (let i = 1; i < pa.length; i++) if (pb[i] - pa[i] !== k) return undefined;
  return k;
}

function classify(subject: Window, cover: Window, parts: readonly PartWindow[], label: (id: number) => string): Pair | undefined {
  if (subject.project === cover.project) return undefined;

  // Compare CELLS, not raw windows. A window that repeats on a bar-period is
  // reproduced exactly by authoring one period and letting the project loop, so
  // the cell IS the content and a 12-bar window that is a 6-bar cell x2 is the
  // same project as a 36-bar window that is the same 6-bar cell x6. The only
  // thing that differs is when the performer switches out of it, which is
  // already how the rig plays (`project-select-midi`, queued to the boundary).
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
 * Greedy set cover over the "reachable by muting" relation.
 *
 * Greedy is not guaranteed optimal, so the number it produces is an ACHIEVABLE
 * saving and never a proven minimum. Said plainly in the output.
 */
function cover(windows: readonly Window[], pairs: readonly Pair[]): { authored: number[]; absorbed: Map<number, number> } {
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

// ── CLI ──────────────────────────────────────────────────────────────

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadParts(ref: string, cacheDir: string | undefined): Promise<{
  songId: number; revisionId: number; title: string; artist: string;
  tracks: { partId: number; label: string; instrument: string; isDrums: boolean }[];
  raw: Map<number, SongsterrPart>;
}> {
  const list = await fetchSongsterrTracks(ref);
  const raw = new Map<number, SongsterrPart>();
  if (cacheDir !== undefined) mkdirSync(cacheDir, { recursive: true });
  for (const t of list.allTracks) {
    const f = cacheDir !== undefined ? `${cacheDir}/part-${t.partId}.json` : undefined;
    if (f !== undefined && existsSync(f)) { raw.set(t.partId, JSON.parse(readFileSync(f, 'utf8')) as SongsterrPart); continue; }
    const got = await fetchSongsterrPart(String(list.songId), { track: t.partId });
    raw.set(t.partId, got.part);
    if (f !== undefined) writeFileSync(f, JSON.stringify(got.part));
  }
  return {
    songId: list.songId, revisionId: list.revisionId, title: list.title, artist: list.artist,
    tracks: list.allTracks.map((t) => ({
      partId: t.partId,
      label: t.name !== '' ? `${t.instrument} (${t.name})` : t.instrument,
      instrument: t.instrument, isDrums: t.isDrums,
    })),
    raw,
  };
}

async function main(): Promise<void> {
  const ref = process.argv[2];
  if (ref === undefined || ref.startsWith('--')) {
    console.error('usage: npx tsx scripts/song-superset.ts <url-or-id> [--parts 0,2,4] [--cache DIR] [--steps-per-beat 4] [--json OUT] [--md OUT]');
    process.exit(1);
  }
  const spb = Number(argVal('--steps-per-beat') ?? 4);
  const wanted = argVal('--parts')?.split(',').map(Number);
  const song = await loadParts(ref, argVal('--cache'));

  const chosen = song.tracks.filter((t) => wanted === undefined || wanted.includes(t.partId));
  const chopParts: ChopPartFlat[] = chosen.map((t) => toChopPart(t.partId, t.label, song.raw.get(t.partId)!));
  const plan = planSongChop(chopParts, { stepsPerBeat: spb });

  // The measure walk the chop anchored on: the longest part's.
  let anchor = chopParts[0];
  for (const p of chopParts) if (p.measures.length > anchor.measures.length) anchor = p;
  const measures = anchor.measures;

  const parts = chosen.map((t) => buildPartWindow(t.partId, t.label, song.raw.get(t.partId)!, measures, spb));
  const label = (id: number): string => parts.find((p) => p.partId === id)?.label ?? `part ${id}`;
  const windows = buildWindows(plan, parts);

  const pairs: Pair[] = [];
  for (const subject of windows) {
    for (const c of windows) {
      const p = classify(subject, c, parts, label);
      if (p !== undefined) pairs.push(p);
    }
  }
  // Keep only the strongest verdict per (subject, cover), and for a mutual
  // IDENTICAL pair keep one direction so the cover arithmetic stays sane.
  const rank: Record<Verdict, number> = { IDENTICAL: 0, EXACT: 1, PREFIX: 2, TRANSPOSE: 3, NEAR: 4 };
  const best = new Map<string, Pair>();
  for (const p of pairs) {
    const k = `${p.subject}>${p.cover}`;
    const prev = best.get(k);
    if (prev === undefined || rank[p.verdict] < rank[prev.verdict]) best.set(k, p);
  }
  const merged = [...best.values()].sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.subject - b.subject);
  const { authored, absorbed } = cover(windows, merged);

  const totalQuantMoved = parts.reduce((s, p) => s + p.quantMoved, 0);
  const totalVelocityBlind = parts.reduce((s, p) => s + p.velocityBlind, 0);
  const cen = census(parts, measures.length);

  /**
   * PATTERN census: distinct 2-bar blocks per part, at even bar alignment.
   *
   * A Circuit pattern is 32 steps, which in 4/4 at 16ths is exactly two bars, and
   * a note track holds 8 of them. So "how many distinct 2-bar blocks does this
   * part play" is the number that decides whether a whole song's worth of a part
   * fits inside ONE project's eight pattern slots, with scenes re-selecting the
   * ranges. It is a strictly finer compression lever than the project-level
   * superset and it is where these two songs actually have room.
   *
   * Reported only when the metre is uniform, because in mixed metre a bar is not
   * a fixed number of steps and a 2-bar block is not a pattern.
   */
  const uniformMetre = new Set(measures.map(sigOf)).size === 1;
  const blockBars = Number(argVal('--block-bars') ?? 2);
  const patternCensus = !uniformMetre ? undefined : parts.map((p) => {
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

  /**
   * Per-part window entropy: over the SHARED window boundaries, how many
   * distinct things does each part actually play?
   *
   * This is the number the interview turns on. A part with 4 distinct window
   * cells across 31 windows is nearly free: it is the same content re-selected.
   * A part with 31 distinct cells is the one setting the project count, and if
   * it is the reason a merge fails it is also the first candidate to hand back
   * to the human or to simplify. It is computed over the shared boundaries so
   * the parts are directly comparable.
   */
  const entropy = parts.map((p) => {
    const seen = new Set<string>();
    let silent = 0;
    for (const w of windows) {
      const c = w.cell.get(p.partId) ?? '';
      if (c.replace(/[^|]*\|\|?/g, '') === '' && !w.sounding.includes(p.partId)) { silent++; continue; }
      seen.add(c);
    }
    return { label: p.label, distinct_window_cells: seen.size, silent_windows: silent };
  }).sort((a, b) => a.distinct_window_cells - b.distinct_window_cells);

  const result = {
    song: { id: song.songId, revision: song.revisionId, title: song.title, artist: song.artist },
    grid: { steps_per_beat: spb, quantised_onsets_moved: totalQuantMoved, velocity_marks_ignored: totalVelocityBlind },
    census: cen,
    pattern_census: patternCensus,
    per_part_window_entropy: entropy,
    parts: parts.map((p) => ({ partId: p.partId, label: p.label, melodic: p.melodic })),
    naive_projects: windows.length,
    authored_projects: authored.length,
    projects_saved: windows.length - authored.length,
    windows: windows.map((w) => ({
      project: w.project, name: w.name, section: w.section,
      from_measure: w.from + 1, to_measure: w.to + 1, bars: w.bars, steps: w.steps,
      sounding: w.sounding.map(label), period_bars: w.period, cell_bars: w.cellBars, partial_cycle: w.partialCycle,
      authored: authored.includes(w.project),
      reached_by_muting: absorbed.get(w.project),
    })),
    pairs: merged,
  };

  const jsonOut = argVal('--json');
  if (jsonOut !== undefined) writeFileSync(jsonOut, JSON.stringify(result, null, 1));

  // ── console report ────────────────────────────────────────────────
  console.log(`\n${song.artist} - ${song.title}   s${song.songId} rev ${song.revisionId}`);
  console.log(`${measures.length} bars, ${chosen.length} part(s), ${spb} steps/beat`);
  console.log(`quantisation moved ${totalQuantMoved} onset(s); ${totalVelocityBlind} dynamic mark(s) the authored image cannot carry\n`);
  console.log(`naive chop: ${windows.length} project(s)   ->   authored: ${authored.length}   SAVED: ${windows.length - authored.length}`);
  console.log('(greedy cover: an achievable saving, not a proven minimum)\n');
  console.log(`DISTINCT-CONTENT CENSUS: ${cen.distinct_rows} distinct bar-rows across ${cen.bars} bars`);
  for (const p of cen.per_part) console.log(`  ${String(p.distinct).padStart(4)} distinct / ${String(p.sounding).padStart(4)} sounding bars  ${p.label}`);
  console.log('');
  if (patternCensus !== undefined) {
    console.log(`PATTERN CENSUS: distinct ${blockBars}-bar blocks (a Circuit pattern holds ${blockBars} bars here; a track holds 8)`);
    for (const p of patternCensus) console.log(`  ${String(p.distinct_blocks).padStart(4)} distinct / ${String(p.sounding_blocks).padStart(4)} sounding blocks  ${p.label}`);
    console.log('');
  } else {
    console.log('PATTERN CENSUS: skipped, the metre is not uniform so a bar is not a fixed number of steps.\n');
  }
  console.log(`PER-PART WINDOW ENTROPY (distinct cells across the ${windows.length} shared windows)`);
  for (const e of entropy) console.log(`  ${String(e.distinct_window_cells).padStart(3)} distinct, ${String(e.silent_windows).padStart(3)} silent   ${e.label}`);
  console.log('');

  const byVerdict = (v: Verdict): Pair[] => merged.filter((p) => p.verdict === v);
  for (const v of ['IDENTICAL', 'EXACT', 'PREFIX', 'TRANSPOSE', 'NEAR'] as Verdict[]) {
    const rows = byVerdict(v);
    if (rows.length === 0) continue;
    console.log(`${v}  (${rows.length})`);
    for (const p of rows.slice(0, 40)) {
      const s = windows.find((w) => w.project === p.subject)!;
      const c = windows.find((w) => w.project === p.cover)!;
      const extra = p.verdict === 'TRANSPOSE' ? ` ${p.semitones! > 0 ? '+' : ''}${p.semitones} semitones`
        : p.verdict === 'NEAR' ? ` differs on: ${p.differs.join('; ')}`
          : p.verdict === 'PREFIX' ? ` tail_clear=${p.tail_clear}`
            : p.loop_lengths !== undefined ? ` same ${s.cellBars}-bar cell, looped ${p.loop_lengths[0]} vs ${p.loop_lengths[1]} bars` : '';
      console.log(`  P${p.subject} "${s.name}" (m${s.from + 1}-${s.to + 1}) <= P${p.cover} "${c.name}" (m${c.from + 1}-${c.to + 1})${extra}`);
      if (p.mute.length > 0 && (p.verdict === 'EXACT' || p.verdict === 'PREFIX')) console.log(`      mute: ${p.mute.join('; ')}`);
    }
    if (rows.length > 40) console.log(`  ... ${rows.length - 40} more`);
    console.log('');
  }

  console.log('WINDOWS');
  for (const w of windows) {
    const tag = authored.includes(w.project) ? 'AUTHOR' : `mute<-P${absorbed.get(w.project) ?? '?'}`;
    console.log(`  P${String(w.project).padStart(2)} ${tag.padEnd(12)} m${w.from + 1}-${w.to + 1} ${String(w.bars).padStart(3)} bars ${String(w.steps).padStart(4)} steps  cell=${w.cellBars}${w.partialCycle ? '*' : ''}  ${w.name}`);
    console.log(`      parts: ${w.sounding.map(label).join('; ') || '(silent)'}`);
  }

  // ── interview blocks ──────────────────────────────────────────────
  // The per-project question blocks defined by docs/_private/rig/SONG-INTERVIEW-SCHEMA.md,
  // generated rather than typed, so every bar number and every deep link comes
  // from the same run as the analysis above.
  const interviewOut = argVal('--interview');
  if (interviewOut !== undefined) {
    const link = (partId: number, m: number): string => `https://www.songsterr.com/a/wsa/s${song.songId}t${partId}?measure=${m}`;
    /** "Distortion Guitar (Ludwig Göransson | Fender Telecaster | Lead Guitar 1)" -> "Lead Guitar 1".
     *  Contributors put the useful name last; the instrument alone collides (two
     *  parts both read "Distortion Guitar", which makes a mute list ambiguous). */
    const short = (s: string): string => {
      const m = s.match(/\(([^)]*)\)\s*$/);
      const tail = m?.[1].split('|').pop()?.trim();
      return tail !== undefined && tail !== '' ? tail : s.replace(/\s*\([^)]*\)\s*$/, '').trim();
    };
    const L: string[] = [];
    L.push(`<!-- generated by scripts/song-superset.ts, s${song.songId} rev ${song.revisionId} -->`, '');
    for (const w of windows) {
      const coverOf = absorbed.get(w.project);
      if (coverOf !== undefined) continue;  // merged windows share their cover's block
      const alsoCovers = [...absorbed.entries()].filter(([, c]) => c === w.project).map(([s]) => s);
      L.push(`### P${w.project}  ${w.name}  m${w.from + 1}-${w.to + 1}  (${w.bars} bars, ${w.steps} steps)`);
      const linkParts = w.sounding.slice(0, 4).map((id) => `[${short(label(id))}](${link(id, w.from + 1)})`);
      L.push(linkParts.join(' . ') || '(silent)');
      L.push('');
      L.push('```');
      L.push('WHAT IS HERE');
      L.push(`  ${w.sounding.length} of ${parts.length} part(s) sound: ${w.sounding.map((id) => short(label(id))).join(', ') || 'none'}`);
      const silentHere = parts.filter((p) => !w.sounding.includes(p.partId)).map((p) => short(p.label));
      if (silentHere.length > 0) L.push(`  silent: ${silentHere.join(', ')}`);
      L.push(w.period !== undefined
        ? `  loop: a ${w.period}-bar cell, repeated${w.partialCycle ? ' (last cycle cut short)' : ''}. Author ${w.period} bars, let it run.`
        : `  loop: none. ${w.bars} distinct bars.`);
      if (alsoCovers.length > 0) {
        L.push(`  MERGED: this project also covers ${alsoCovers.map((p) => `P${p} "${windows.find((x) => x.project === p)!.name}" (m${windows.find((x) => x.project === p)!.from + 1}-${windows.find((x) => x.project === p)!.to + 1})`).join(', ')}.`);
        for (const a of alsoCovers) {
          const pr = merged.find((m) => m.subject === a && m.cover === w.project);
          if (pr !== undefined && pr.mute.length > 0) L.push(`    to hear P${a}, mute: ${pr.mute.map(short).join(', ')}`);
        }
      }
      const near = merged.filter((m) => m.subject === w.project && m.verdict === 'NEAR');
      if (near.length > 0) {
        const n = near[0];
        L.push(`  NEAR-MISS: identical to P${n.cover} "${windows.find((x) => x.project === n.cover)!.name}" except on ${n.differs.map(short).join(' and ')}.`);
      }
      L.push('');
      L.push('DEFAULT');
      L.push('  Mapping unchanged.');
      L.push('');
      L.push('THE CHOICE');
      L.push(near.length > 0
        ? `  Merge with P${near[0].cover} and accept the ${near[0].differs.map(short).join(' / ')} difference, or keep both?`
        : w.period !== undefined && w.period < w.bars
          ? `  Author the ${w.period}-bar cell and loop it, or write all ${w.bars} bars out?`
          : '  None. Default is fine.');
      L.push('');
      L.push('ANSWER: ______');
      L.push('```');
      L.push('');
    }
    writeFileSync(interviewOut, L.join('\n'));
  }

  const mdOut = argVal('--md');
  if (mdOut !== undefined) {
    const lines: string[] = [];
    lines.push(`| Project | Section | Bars | Loop period | Parts sounding | Slot |`);
    lines.push(`|---|---|---:|---:|---|---|`);
    for (const w of windows) {
      lines.push(`| P${w.project} | ${w.name} (m${w.from + 1}-${w.to + 1}) | ${w.bars} | ${w.period ?? '-'} | ${w.sounding.map(label).join(', ') || '(silent)'} | ${authored.includes(w.project) ? 'author' : `mute from P${absorbed.get(w.project)}`} |`);
    }
    writeFileSync(mdOut, lines.join('\n') + '\n');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
