/**
 * Deterministic song → Circuit-projects PLANNER (BK-SONG-PROJECTS-PLANNER).
 *
 * `import_songsterr whole_song` (`planSongChop`) already gives the STRUCTURE: the
 * section chop, the 8-pattern / 16-bar ceiling, per-part occupancy, the shared
 * boundary set. The owner then corrects five things BY HAND every time before the
 * sections become Circuit projects, and this module is those five corrections,
 * made deterministic so the chop can be regenerated instead of hand-edited:
 *
 *   1. DROP "what I play live"     — a section whose only backing is a live part
 *      (the guitarist) plus decorative vocals needs no Circuit project. Fed the
 *      NON-LIVE parts, `planSongChop`'s silent-head trim already drops guitar-only
 *      lead-in bars (one song's Intro trims m1-5 → m6 where the oohs enter); this
 *      module adds the section-level drop (the Outro: oohs + guitar, no rhythm).
 *   2. DEDUP / superset            — Verse I and Verse II share a groove and differ
 *      only in their fills; Chorus I/II/III likewise. Author one, reuse it in the
 *      play order, bake the differing fills per use.
 *   3. FILL detection             — per section, flag the bars that are fills
 *      (candidates for the owner to confirm, NEVER auto-applied) and, across
 *      repeats, WHICH bars differ → the `bake-song-fills` worklist.
 *   4. STACKED-TOM preservation   — the importer folds GM 41/43/45/47/48/50 to one
 *      `tom`, so a doubled-tom breakdown drive collapses to one lane. This reads
 *      the RAW notes and reports the distinct GM tom lanes per section so the
 *      author binds one tom sample per lane.
 *   5. OVER-CEILING split         — surfaced from `planSongChop` as a note.
 *
 * Dedup REUSES the post-quantization per-part per-bar `BarToken` from
 * `buildPartWindow` (the "compare the authored image, not the source notation"
 * artifact `scripts/song-superset.ts` established) and the `classify` verdict
 * engine, then layers fill-bar exclusion so "shared groove, differing fills"
 * separates from "different section". It deliberately does NOT invent a fresh
 * quarter-beat-onset fingerprint; that re-introduces the false positive the
 * superset header documents.
 *
 * Pure and network-free: it takes already-flattened `ChopPartFlat`s (occupancy +
 * timeline) plus the RAW `SongsterrPart`s (for the GM-numbered tom/fill reading).
 * READ-ONLY, like the chop: it emits a plan to show the user before authoring.
 */

import {
  flattenSongsterrDrums,
  flattenSongsterrMelodic,
  isMelodicPart,
  type MeasureInfo,
  type SongsterrPart,
} from './songsterr.js';
import {
  planSongChop,
  type ChopOptions,
  type ChopProject,
  type ChopPartFlat,
  type SongChopPlan,
} from './songChop.js';

// ═══════════════════════════════════════════════════════════════════════
// REUSABLE WINDOW MACHINERY (extracted from scripts/song-superset.ts so both
// the superset script and this planner share ONE implementation of the
// post-quantization per-part per-bar comparison. Moved verbatim; the superset
// script now imports these instead of carrying its own copies.)
// ═══════════════════════════════════════════════════════════════════════

/**
 * One bar of one part, as the AUTHORED IMAGE would look at the target grid.
 *
 * The signature is part of the token so that in mixed metre two bars of
 * different length can never compare equal by accident. Melodic: `step:pitch:gate`
 * per note, sorted. Drum: `step:voice` per hit, sorted and de-duplicated.
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

function joinBars(w: { from: number; to: number }, bars: readonly BarToken[]): string {
  const out: string[] = [];
  for (let i = w.from; i <= w.to; i++) out.push(`${bars[i].sig}|${bars[i].body}`);
  return out.join('||');
}

export const barRow = (i: number, parts: readonly PartWindow[]): string =>
  parts.map((p) => `${p.bars[i].sig}|${p.bars[i].body}`).join('#');

/** Smallest bar-period the window repeats on, allowing a PARTIAL final cycle. */
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
function constantOffset(a: string, b: string): number | undefined {
  const pa = [...a.matchAll(/\d+:(-?\d+):\d+/g)].map((m) => Number(m[1]));
  const pb = [...b.matchAll(/\d+:(-?\d+):\d+/g)].map((m) => Number(m[1]));
  if (pa.length === 0 || pa.length !== pb.length) return undefined;
  const k = pb[0] - pa[0];
  for (let i = 1; i < pa.length; i++) if (pb[i] - pa[i] !== k) return undefined;
  return k;
}

export function classify(subject: Window, cover: Window, parts: readonly PartWindow[], label: (id: number) => string): Pair | undefined {
  if (subject.project === cover.project) return undefined;

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

// ═══════════════════════════════════════════════════════════════════════
// RAW DRUM READING (GM numbers preserved: tom lanes + fill events need the
// number the flattener folds away, e.g. 45 vs 47 both collapse to `tom`).
// ═══════════════════════════════════════════════════════════════════════

/** GM percussion tom numbers (floor → high tom). The flattener folds all six to `tom`. */
export const GM_TOMS: ReadonlySet<number> = new Set([41, 43, 45, 47, 48, 50]);
/** GM crash / china / splash numbers (all fold to `crash`). */
const GM_CRASHES: ReadonlySet<number> = new Set([49, 57, 52, 55]);
const GM_KICKS: ReadonlySet<number> = new Set([35, 36]);

/** One raw drum hit: the GM number the source wrote, its beat, and its ghost flag. */
export interface RawHit { gm: number; beat: number; ghost: boolean }

/**
 * Walk a drum part's measures → voices → beats → notes keeping the GM NUMBER and
 * the beat position (quarter beats from track start). Positions match the
 * flattener exactly (same grace / duration handling); a repeated fret in one beat
 * (a flam) folds to a single hit, and an identical (gm, beat) pair is de-duped so
 * a two-voice unison reads as one hit.
 */
export function rawDrumHits(part: SongsterrPart, measures: readonly MeasureInfo[]): RawHit[] {
  const out: RawHit[] = [];
  const seenGlobal = new Set<string>();
  for (let mi = 0; mi < part.measures.length && mi < measures.length; mi++) {
    const mStart = measures[mi].startBeat;
    for (const voice of part.measures[mi].voices ?? []) {
      let pos = mStart;
      for (const beat of voice.beats ?? []) {
        const isGrace = beat.graceNote !== undefined && beat.graceNote !== false && beat.graceNote !== '';
        const dur = isGrace ? 0 : (beat.duration[0] / beat.duration[1]) * 4;
        if (!beat.rest) {
          const seenBeat = new Set<number>();
          for (const n of beat.notes ?? []) {
            if (n.rest === true || typeof n.fret !== 'number' || seenBeat.has(n.fret)) continue;
            seenBeat.add(n.fret);
            const key = `${n.fret}@${pos.toFixed(4)}`;
            if (seenGlobal.has(key)) continue;
            seenGlobal.add(key);
            out.push({ gm: n.fret, beat: pos, ghost: n.ghost === true });
          }
        }
        pos += dur;
      }
    }
  }
  return out.sort((a, b) => a.beat - b.beat || a.gm - b.gm);
}

// ═══════════════════════════════════════════════════════════════════════
// PLANNER TYPES
// ═══════════════════════════════════════════════════════════════════════

/** One drum event inside a fill, ready for the SMF encoder. */
export interface FillEvent {
  /** General-MIDI percussion number (36 = kick, 46 = open hi-hat, 48/47/45/43 = toms …). */
  gm: number;
  /** Beat offset from the START of the fill's first bar (quarter beats). */
  beat: number;
  /** MIDI velocity 1..127. */
  vel: number;
}

/** One fill to bake: a bar (or run of bars) whose drum content is rendered to a phrase. */
export interface FillWorkItem {
  section: string;
  /** 1-based displayed measure numbers of the fill, inclusive. */
  from_measure: number;
  to_measure: number;
  /** The drum hits, beat-relative to `from_measure`'s downbeat. */
  events: FillEvent[];
  /** Why this bar was flagged (density / tom-lane / crash-into-next-section). */
  reasons: string[];
  /** Optional Circuit sample-pool slot the baked phrase should land in. */
  target_pool_slot?: number;
}

export type ProjectRelation = 'unique' | 'identical' | 'shared-groove' | 'superset';

/** One project of the plan: a chop project annotated with the five corrections. */
export interface SongProject {
  /** 1-based project number in song order (from the chop). */
  project: number;
  section: string;
  name: string;
  from_measure: number;
  to_measure: number;
  bars: number;
  patterns: number;
  /** This project should NOT be authored (only live / decorative content backs it). */
  drop: boolean;
  drop_reason?: string;
  /** The chop trimmed silent (here: live-only) bars off the head/tail to fit the ceiling. */
  trimmed?: { head_bars: number; tail_bars: number; source_from: number; source_to: number };
  /** This section was longer than one project could hold and split / trimmed. */
  over_ceiling: boolean;
  /** How this project relates to an earlier one. */
  relation: ProjectRelation;
  /** The earlier project this one reuses (identical / shared-groove / superset). */
  reuse_of?: number;
  /** Agreement (0..1) with `reuse_of` over the instrumental-groove parts. */
  groove_agreement?: number;
  /** Bars (1-based measures) that DIFFER from `reuse_of` → per-use bake candidates. */
  differing_bars: number[];
  /** Measures flagged as fill candidates (for owner confirm, never auto-applied). */
  fill_candidates: number[];
  /** Distinct GM tom lanes struck in this project's bars. */
  tom_lanes: number[];
  /** More than one tom lane → the author binds >1 tom sample (stacked-tom drive). */
  doubled_toms: boolean;
}

export interface SongProjectPlan {
  /** The partIds treated as LIVE (performed, not authored). */
  live: number[];
  steps_per_beat: number;
  /** The chop's ceiling block, passed through. */
  ceiling: SongChopPlan['ceiling'];
  measures: number;
  /** The song's section spine (the source's own markers), before any drop/dedup. */
  section_spine: { name: string; from_measure: number; to_measure: number; bars: number }[];
  /** The parts, with their role classification. */
  parts: { partId: number; label: string; melodic: boolean; live: boolean; vocal: boolean; backing: boolean }[];
  /** Every project of the chop, annotated. */
  projects: SongProject[];
  /** Projects to author (kept, deduped to their first occurrence), in play order. */
  authored_projects: number[];
  /** Sections dropped (live-only / decorative-only), with the reason. */
  dropped: { project: number; section: string; measures: string; reason: string }[];
  /** Human-readable trim decisions from the chop, plus which trims were live-only. */
  live_only_trims: string[];
  /** Over-ceiling split decisions from the chop. */
  splits: string[];
  /** The bake worklist: one entry per detected fill bar across authored projects. */
  fill_worklist: FillWorkItem[];
  warnings: string[];
  note: string;
}

export interface PlanOptions extends ChopOptions {
  /** partIds performed live (guitars). Their bars do not, on their own, justify a project. */
  live?: number[];
  /**
   * OPT-IN, default OFF. Fill-tolerant reuse: when the strict backing agreement leaves a section
   * `unique`, retry against each earlier authored project EXCLUDING the detected fill bars — if the
   * two windows are identical on every NON-fill bar and differ ONLY on detected fill bars, treat it as
   * a shared groove and record those fill bars as `differing_bars` (the variation set the surviving
   * project carries). This NEVER loosens the default: with the flag off the dedup is byte-for-byte the
   * strict behavior the planner golden and the existing song builds depend on. It also does NOT over-merge a
   * genuinely different section: the disagreement must be confined to fill bars, so a pervasive
   * per-bar difference (a whole-section cymbal-voice swap, a pad that is present in one section and
   * absent in another, a different bassline) keeps both projects. See the chorus measurement
   * in `scripts/verify-song-author-variants.ts`: those choruses stay separate even with this ON,
   * because their difference is not confined to fills.
   */
  fillTolerantReuse?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// FILL DETECTION + TOM LANES
// ═══════════════════════════════════════════════════════════════════════

const VOCAL_RE = /\b(voice|vocal|ooh|aah|choir|sing|backing vox|bgv)\b/i;

/** Is this part a decorative vocal line (oohs / aahs) rather than an instrument the Circuit backs? */
function isVocalPart(label: string): boolean {
  return VOCAL_RE.test(label);
}

interface DrumTimeline {
  hits: RawHit[];
  measures: readonly MeasureInfo[];
}

/** The [start, end) quarter-beat range of measure index `mi`. */
function barRange(measures: readonly MeasureInfo[], mi: number): [number, number] {
  return [measures[mi].startBeat, mi + 1 < measures.length ? measures[mi + 1].startBeat : Infinity];
}

/** Hits inside a bar (measure index). */
function hitsInBar(dt: DrumTimeline, mi: number): RawHit[] {
  const [s, e] = barRange(dt.measures, mi);
  return dt.hits.filter((h) => h.beat + 1e-9 >= s && h.beat < e - 1e-9);
}

/**
 * Flag the fill bars of a section, as 0-based measure indices.
 *
 * Density ALONE is insufficient (a breakdown's [12,0,12,8] has median 12, so
 * 1.5× = 18 and nothing qualifies, yet the last bar IS a fill), so a bar is
 * flagged when ANY of three clauses fires — all three load-bearing:
 *
 *   (a) DENSITY   — its hit count ≥ 1.5× the section's median non-empty-bar
 *       density (guarded: skipped when the median is 0, i.e. a rest-only section).
 *   (b) TOM LANE  — it contains a tom AND toms are EXCEPTIONAL in this section
 *       (present in a minority of bars). A tom-DRIVEN section (the breakdown) is
 *       groove, not a fill, so a tom in most bars does not flag.
 *   (c) CRASH-IN  — it is the section's LAST bar and a crash lands on the NEXT
 *       section's downbeat (the fill resolving into the change, e.g. m97 → m98).
 *
 * Reasons are collected per bar so the owner sees WHY each candidate flagged.
 */
function detectFills(dt: DrumTimeline, fromIdx: number, toIdx: number): Map<number, string[]> {
  const flagged = new Map<number, string[]>();
  const add = (mi: number, reason: string): void => {
    const cur = flagged.get(mi) ?? [];
    if (!cur.includes(reason)) cur.push(reason);
    flagged.set(mi, cur);
  };
  const nBars = toIdx - fromIdx + 1;
  const densities: number[] = [];
  const hasTom: boolean[] = [];
  for (let mi = fromIdx; mi <= toIdx; mi++) {
    const inBar = hitsInBar(dt, mi);
    densities.push(inBar.length);
    hasTom.push(inBar.some((h) => GM_TOMS.has(h.gm)));
  }
  const nz = densities.filter((d) => d > 0).sort((a, b) => a - b);
  const median = nz.length > 0 ? nz[Math.floor(nz.length / 2)] : 0;
  const tomCount = hasTom.filter(Boolean).length;
  const tomExceptional = tomCount > 0 && tomCount <= Math.floor(nBars / 2);

  for (let i = 0; i < nBars; i++) {
    const mi = fromIdx + i;
    if (median > 0 && densities[i] > 0 && densities[i] >= median * 1.5) add(mi, `density ${densities[i]} >= 1.5x median ${median}`);
    if (tomExceptional && hasTom[i]) add(mi, 'distinct tom lane (toms exceptional in section)');
  }
  // Clause (c): the section's last bar, if a crash lands on the next section's downbeat.
  const nextStart = toIdx + 1 < dt.measures.length ? dt.measures[toIdx + 1].startBeat : Infinity;
  if (Number.isFinite(nextStart)
    && dt.hits.some((h) => GM_CRASHES.has(h.gm) && Math.abs(h.beat - nextStart) < 0.26)) {
    add(toIdx, 'crash on next section downbeat');
  }
  return flagged;
}

/** Distinct GM tom numbers struck in [fromIdx, toIdx]. */
function tomLanesIn(dt: DrumTimeline, fromIdx: number, toIdx: number): number[] {
  const lanes = new Set<number>();
  for (let mi = fromIdx; mi <= toIdx; mi++) for (const h of hitsInBar(dt, mi)) if (GM_TOMS.has(h.gm)) lanes.add(h.gm);
  return [...lanes].sort((a, b) => a - b);
}

/** The drum hits of a fill bar (or run), beat-relative to the fill's first downbeat. */
function fillEventsOf(dt: DrumTimeline, fromIdx: number, toIdx: number): FillEvent[] {
  const start = dt.measures[fromIdx].startBeat;
  const events: FillEvent[] = [];
  for (let mi = fromIdx; mi <= toIdx; mi++) {
    for (const h of hitsInBar(dt, mi)) {
      events.push({ gm: h.gm, beat: h.beat - start, vel: h.ghost ? 60 : 100 });
    }
  }
  events.sort((a, b) => a.beat - b.beat || a.gm - b.gm);
  return events;
}

// ═══════════════════════════════════════════════════════════════════════
// THE PLANNER
// ═══════════════════════════════════════════════════════════════════════

/** Agreement threshold: two equal-length sections whose backing parts agree on at
 *  least this fraction of bars are the SAME groove. Chosen inside the measured gap
 *  on one song (peers 0.63-0.81, different sections 0.00-0.13). Reported so a
 *  borderline call is visible. */
const SHARED_GROOVE_THRESHOLD = 0.5;

/**
 * Turn a chop into a project plan with the five owner corrections applied.
 *
 * `parts` are the flattened parts (occupancy + timeline); `rawParts` the raw
 * `SongsterrPart`s keyed by partId (the GM-numbered tom/fill reading). `live`
 * names the performed partIds. See the module header.
 */
export function planSongProjects(
  parts: readonly ChopPartFlat[],
  rawParts: ReadonlyMap<number, SongsterrPart>,
  opts: PlanOptions = {},
): SongProjectPlan {
  if (parts.length === 0) throw new Error('planSongProjects needs at least one part.');
  const spb = opts.stepsPerBeat ?? 4;
  const live = new Set(opts.live ?? []);
  const fillTolerantReuse = opts.fillTolerantReuse === true;

  // Role classification. A live part is performed (the guitarist); a vocal part is
  // decorative (oohs) and does not, on its own, back a section; a backing part is
  // the non-live, non-vocal instrumental groove the Circuit authors.
  const roleOf = (p: ChopPartFlat): { live: boolean; vocal: boolean; backing: boolean } => {
    const isLive = live.has(p.partId);
    const vocal = isVocalPart(p.label);
    return { live: isLive, vocal, backing: !isLive && !vocal };
  };
  const backingIds = parts.filter((p) => roleOf(p).backing).map((p) => p.partId);
  const nonLive = parts.filter((p) => !live.has(p.partId));

  // ── the chop, fed the NON-LIVE parts so guitar-only lead-ins read silent and
  //    the chop's own silent-head trim drops them (Intro m1-5 → m6). ───────────
  const chopInput = nonLive.length > 0 ? nonLive : [...parts];
  const plan = planSongChop(chopInput, opts);

  // The measure walk the chop anchored on (its longest part's).
  let anchor = chopInput[0];
  for (const p of chopInput) if (p.measures.length > anchor.measures.length) anchor = p;
  const measures = anchor.measures;

  // ── per-part windows for the DEDUP comparison (post-quantization BarTokens) ──
  const label = (id: number): string => parts.find((p) => p.partId === id)?.label ?? `part ${id}`;
  const partWindows = parts.map((p) => buildPartWindow(p.partId, p.label, rawParts.get(p.partId)!, measures, spb));
  const winById = new Map(partWindows.map((w) => [w.partId, w]));
  const backingWindows = backingIds.map((id) => winById.get(id)!).filter(Boolean);
  // classify over the chop projects (full content) surfaces the strong verdicts.
  const windows = buildWindows(plan, partWindows);

  // ── drum timeline (the GM-numbered reading, for fills + tom lanes) ──────────
  const drumRawPart = parts.find((p) => !p.melodic && !live.has(p.partId));
  const dt: DrumTimeline | undefined = drumRawPart !== undefined && rawParts.has(drumRawPart.partId)
    ? { hits: rawDrumHits(rawParts.get(drumRawPart.partId)!, measures), measures }
    : undefined;

  // ── section spine (the source's markers, union across parts) ────────────────
  const spine = plan.sections.map((s) => ({
    name: s.name, from_measure: s.from_measure, to_measure: s.to_measure, bars: s.bars,
  }));

  // ── per-project annotation ──────────────────────────────────────────────────
  const projById = new Map(plan.projects.map((p) => [p.project, p]));
  const projects: SongProject[] = [];
  const authored: number[] = [];
  const dropped: SongProjectPlan['dropped'] = [];
  const fillWorklist: FillWorkItem[] = [];

  // Bar-token agreement over the backing (instrumental) parts, per bar.
  const grooveTok = new Map<number, string[]>();
  for (const w of backingWindows) grooveTok.set(w.partId, w.bars.map((b) => `${b.sig}|${b.body}`));
  const agreement = (a: ChopProject, b: ChopProject): { ratio: number; diffLocal: number[] } => {
    const nA = a.to_measure - a.from_measure + 1;
    const nB = b.to_measure - b.from_measure + 1;
    if (nA !== nB || nA === 0) return { ratio: -1, diffLocal: [] };
    const fa = a.from_measure - 1; const fb = b.from_measure - 1;
    let same = 0; const diff: number[] = [];
    for (let i = 0; i < nA; i++) {
      let eq = true;
      for (const id of backingIds) { const t = grooveTok.get(id); if (t && t[fa + i] !== t[fb + i]) { eq = false; break; } }
      if (eq) same++; else diff.push(i);
    }
    return { ratio: same / nA, diffLocal: diff };
  };

  for (const proj of plan.projects) {
    const win = windows.find((w) => w.project === proj.project)!;
    const fromIdx = proj.from_measure - 1;
    const toIdx = proj.to_measure - 1;

    // (1) DROP: only live / decorative content backs this section. A backing part
    //     must SOUND here for the section to earn a project.
    const backingSounds = backingIds.some((id) => (winById.get(id)?.bars.slice(fromIdx, toIdx + 1).some((b) => b.body !== '')) ?? false);
    let drop = false;
    let dropReason: string | undefined;
    if (!backingSounds) {
      drop = true;
      const soundingVocal = parts.filter((p) => roleOf(p).vocal && (winById.get(p.partId)?.bars.slice(fromIdx, toIdx + 1).some((b) => b.body !== '') ?? false));
      dropReason = soundingVocal.length > 0
        ? `only live + decorative (${soundingVocal.map((p) => p.label).join(', ')}) content here; no rhythm-section backing to author`
        : 'only the live-performed part(s) sound here; no backing to author';
    }

    // (4) TOM LANES + (3/5) FILLS from the raw drum timeline.
    const tomLanes = dt !== undefined ? tomLanesIn(dt, fromIdx, toIdx) : [];
    const fillMap = !drop && dt !== undefined ? detectFills(dt, fromIdx, toIdx) : new Map<number, string[]>();
    const fillCandidates = [...fillMap.keys()].sort((a, b) => a - b).map((i) => i + 1);

    // (2) DEDUP: compare to EARLIER kept projects. classify surfaces IDENTICAL /
    //     EXACT / PREFIX; the shared-groove agreement (fills excluded implicitly
    //     by tolerance) catches "same groove, differing fills".
    let relation: ProjectRelation = 'unique';
    let reuseOf: number | undefined;
    let grooveAgreement: number | undefined;
    let differingBars: number[] = [];
    if (!drop) {
      for (const earlier of projects) {
        if (earlier.drop) continue;
        const ep = projById.get(earlier.project)!;
        // strong verdict via classify (full content, both directions)
        const cw = windows.find((w) => w.project === earlier.project)!;
        const strong = classify(win, cw, partWindows, label);
        if (strong !== undefined && (strong.verdict === 'IDENTICAL' || strong.verdict === 'EXACT')) {
          relation = 'identical'; reuseOf = earlier.project; grooveAgreement = 1; differingBars = [];
          break;
        }
        if (strong !== undefined && strong.verdict === 'PREFIX' && strong.saves) {
          relation = 'superset'; reuseOf = earlier.project; differingBars = [];
          break;
        }
        // shared-groove: equal length + backing agreement over threshold.
        const ag = agreement(ep, proj);
        if (ag.ratio >= SHARED_GROOVE_THRESHOLD) {
          relation = ag.ratio === 1 ? 'identical' : 'shared-groove';
          reuseOf = earlier.project;
          grooveAgreement = ag.ratio;
          differingBars = ag.diffLocal.map((i) => proj.from_measure + i);
          break;
        }
      }
    }

    // (2b) FILL-TOLERANT reuse (OPT-IN, default off). Only when the strict pass left this section
    //      `unique`: retry against each earlier authored project, EXCLUDING the detected fill bars.
    //      The merge holds ONLY when every non-fill bar is identical across all backing parts and the
    //      whole difference is confined to detected fill bars — so a pervasive per-bar difference (a
    //      cymbal-voice swap, a pad present in one section and absent in the other, a different bass)
    //      is NOT merged. The fill bars become `differing_bars` (the variation set). See PlanOptions.
    if (fillTolerantReuse && !drop && relation === 'unique') {
      const nA = toIdx - fromIdx + 1;
      const projFillLocal = new Set(fillCandidates.map((m) => m - proj.from_measure));
      for (const earlier of projects) {
        if (earlier.drop || earlier.reuse_of !== undefined) continue; // reuse only an authored base
        const ep = projById.get(earlier.project)!;
        const nB = ep.to_measure - ep.from_measure + 1;
        if (nA !== nB || nA === 0) continue;
        const fa = ep.from_measure - 1; // earlier window base (0-based measure index)
        const fillLocal = new Set(projFillLocal);
        for (const m of earlier.fill_candidates) fillLocal.add(m - ep.from_measure);
        let nonFillIdentical = true;
        let nonFillBars = 0;
        const diff: number[] = [];
        for (let i = 0; i < nA; i++) {
          let eq = true;
          for (const id of backingIds) { const t = grooveTok.get(id); if (t && t[fromIdx + i] !== t[fa + i]) { eq = false; break; } }
          if (!eq) diff.push(i);
          if (!fillLocal.has(i)) { nonFillBars++; if (!eq) nonFillIdentical = false; }
        }
        const diffConfinedToFills = diff.every((i) => fillLocal.has(i));
        if (nonFillBars > 0 && nonFillIdentical && diffConfinedToFills && diff.length > 0) {
          relation = 'shared-groove';
          reuseOf = earlier.project;
          grooveAgreement = Math.round(((nA - diff.length) / nA) * 100) / 100;
          differingBars = diff.map((i) => proj.from_measure + i);
          break;
        }
      }
    }

    const sp: SongProject = {
      project: proj.project,
      section: proj.section,
      name: proj.name,
      from_measure: proj.from_measure,
      to_measure: proj.to_measure,
      bars: proj.bars,
      patterns: proj.patterns,
      drop,
      ...(dropReason !== undefined ? { drop_reason: dropReason } : {}),
      ...(proj.trimmed !== undefined
        ? { trimmed: { head_bars: proj.trimmed.head_bars, tail_bars: proj.trimmed.tail_bars, source_from: proj.trimmed.source_from, source_to: proj.trimmed.source_to } }
        : {}),
      over_ceiling: plan.sections.find((s) => s.name === proj.section && s.from_measure <= proj.from_measure && s.to_measure >= proj.to_measure)?.over_ceiling ?? false,
      relation,
      ...(reuseOf !== undefined ? { reuse_of: reuseOf } : {}),
      ...(grooveAgreement !== undefined ? { groove_agreement: Math.round(grooveAgreement * 100) / 100 } : {}),
      differing_bars: differingBars,
      fill_candidates: fillCandidates,
      tom_lanes: tomLanes,
      doubled_toms: tomLanes.length > 1,
    };
    projects.push(sp);

    if (drop) {
      dropped.push({ project: proj.project, section: proj.section, measures: `m${proj.from_measure}-${proj.to_measure}`, reason: dropReason ?? '' });
      continue;
    }
    // Author this project only if it is NOT a reuse of an earlier one.
    if (reuseOf === undefined) authored.push(proj.project);

    // (5) FILL WORKLIST: one entry per detected fill bar in an authored/kept project.
    if (dt !== undefined) {
      for (const miKey of [...fillMap.keys()].sort((a, b) => a - b)) {
        fillWorklist.push({
          section: proj.section,
          from_measure: miKey + 1,
          to_measure: miKey + 1,
          events: fillEventsOf(dt, miKey, miKey),
          reasons: fillMap.get(miKey) ?? [],
        });
      }
    }
  }

  // ── live-only trims: the chop's silent-head/tail trims, which under a NON-LIVE
  //    occupancy are exactly the bars only the live part(s) played. ─────────────
  const liveOnlyTrims = plan.trims.slice();

  const warnings = plan.warnings.slice();
  if (dt === undefined) warnings.push('No non-live drum part found; tom-lane and fill detection were skipped.');
  if (backingIds.length === 0) warnings.push('No backing (non-live, non-vocal) part; every section reads as live-only and would drop. Check the --live selection.');

  const keptCount = projects.filter((p) => !p.drop).length;
  const reusedCount = projects.filter((p) => !p.drop && p.reuse_of !== undefined).length;
  const note =
    `${plan.projects.length} chop project(s): ${dropped.length} dropped as live-only, `
    + `${keptCount} kept, of which ${reusedCount} reuse an earlier project (author ${authored.length}). `
    + `${fillWorklist.length} fill candidate(s) to confirm and bake. `
    + 'Fills are CANDIDATES for owner confirm, never auto-applied; dedup reuse is a proposal to check by ear.';

  return {
    live: [...live].sort((a, b) => a - b),
    steps_per_beat: spb,
    ceiling: plan.ceiling,
    measures: plan.measures,
    section_spine: spine,
    parts: parts.map((p) => { const r = roleOf(p); return { partId: p.partId, label: p.label, melodic: p.melodic, live: r.live, vocal: r.vocal, backing: r.backing }; }),
    projects,
    authored_projects: authored,
    dropped,
    live_only_trims: liveOnlyTrims,
    splits: plan.splits.slice(),
    fill_worklist: fillWorklist,
    warnings,
    note,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HUMAN-READABLE REPORT
// ═══════════════════════════════════════════════════════════════════════

/** Render a plan as the console report the CLI prints. */
export function formatSongProjectPlan(plan: SongProjectPlan, songLabel?: string): string {
  const L: string[] = [];
  if (songLabel !== undefined) L.push(`\n=== SONG → CIRCUIT PROJECTS: ${songLabel} ===`);
  const partLine = plan.parts.map((p) => `${p.partId}=${p.label}${p.live ? ' [LIVE]' : p.vocal ? ' [vox]' : ''}`).join(', ');
  L.push(`parts: ${partLine}`);
  L.push(`live (performed, not authored): [${plan.live.join(', ')}]   ${plan.measures} bars, ${plan.steps_per_beat} steps/beat`);
  L.push('');
  L.push('SECTION SPINE:');
  for (const s of plan.section_spine) L.push(`  ${s.name.padEnd(12)} m${s.from_measure}-${s.to_measure} (${s.bars}b)`);
  L.push('');
  L.push('PROJECTS:');
  for (const p of plan.projects) {
    const tags: string[] = [];
    if (p.drop) tags.push('DROP');
    else if (p.relation === 'identical') tags.push(`= reuse P${p.reuse_of}`);
    else if (p.relation === 'shared-groove') tags.push(`~ shared-groove P${p.reuse_of}${p.groove_agreement !== undefined ? ` (${Math.round(p.groove_agreement * 100)}%)` : ''}`);
    else if (p.relation === 'superset') tags.push(`⊆ superset of P${p.reuse_of}`);
    else tags.push('AUTHOR');
    if (p.trimmed && (p.trimmed.head_bars > 0 || p.trimmed.tail_bars > 0)) tags.push(`trim head${p.trimmed.head_bars}/tail${p.trimmed.tail_bars}`);
    if (p.over_ceiling) tags.push('over-ceiling');
    if (p.doubled_toms) tags.push(`DOUBLED TOMS {${p.tom_lanes.join('+')}}`);
    else if (p.tom_lanes.length === 1) tags.push(`tom {${p.tom_lanes[0]}}`);
    if (p.fill_candidates.length > 0) tags.push(`fills @m${p.fill_candidates.join(',')}`);
    if (p.differing_bars.length > 0) tags.push(`differs @m${p.differing_bars.join(',')}`);
    L.push(`  P${String(p.project).padStart(2)} ${p.name.padEnd(13)} m${p.from_measure}-${p.to_measure} ${String(p.bars).padStart(2)}b ${p.patterns}pat  ${tags.join('  |  ')}`);
    if (p.drop && p.drop_reason) L.push(`        ↳ ${p.drop_reason}`);
  }
  L.push('');
  L.push(`AUTHOR ${plan.authored_projects.length} project(s): ${plan.authored_projects.map((n) => `P${n}`).join(', ')}`);
  if (plan.dropped.length > 0) {
    L.push('');
    L.push('DROPPED (live-only):');
    for (const d of plan.dropped) L.push(`  P${d.project} ${d.section} ${d.measures}: ${d.reason}`);
  }
  if (plan.live_only_trims.length > 0) {
    L.push('');
    L.push('LIVE-ONLY HEAD/TAIL TRIMS:');
    for (const t of plan.live_only_trims) L.push(`  ${t}`);
  }
  if (plan.splits.length > 0) {
    L.push('');
    L.push('OVER-CEILING SPLITS:');
    for (const s of plan.splits) L.push(`  ${s}`);
  }
  if (plan.fill_worklist.length > 0) {
    L.push('');
    L.push(`FILL WORKLIST (${plan.fill_worklist.length} candidate(s), bake per-use, owner confirms):`);
    for (const f of plan.fill_worklist) {
      const toms = f.events.filter((e) => GM_TOMS.has(e.gm)).map((e) => e.gm);
      L.push(`  ${f.section.padEnd(12)} m${f.from_measure}${f.to_measure !== f.from_measure ? `-${f.to_measure}` : ''}  ${f.events.length} hit(s)${toms.length ? ` toms[${toms.join('→')}]` : ''}  (${f.reasons.join('; ')})`);
    }
  }
  if (plan.warnings.length > 0) {
    L.push('');
    L.push('WARNINGS:');
    for (const w of plan.warnings) L.push(`  ${w}`);
  }
  L.push('');
  L.push(plan.note);
  return L.join('\n');
}
