/**
 * Section-marker chop: ONE project layout for a whole song, shared by every part.
 *
 * The drum path (`songStructure.ts`) INFERS structure: it chops the track into
 * fixed windows, dedups them, and reads the arrangement back out of the groove.
 * That works because a drum grid can be compared to another drum grid. A pitch
 * row cannot be clustered that way, which is why `whole_song` used to refuse a
 * melodic part outright.
 *
 * It does not need to be. A Songsterr tab already carries the structure as
 * `marker` text on the measures that begin a section (Intro / Verse / Chorus /
 * Bridge), so a melodic part needs no clustering at all: chop it on the markers
 * the source already wrote. That is what this module does.
 *
 * **The chop is computed ONCE FOR THE SONG, not once per part.** A song is not
 * one part. "After Dark" is a bass, a pad, two leads, two pianos and a drum kit,
 * and if each part were windowed on its own the projects would not line up: the
 * bass's project 3 would start at a different bar from the pad's, and a
 * foot-switch would land mid-phrase on five of seven tracks. So every input part
 * contributes to one shared timeline (measures, markers, per-bar occupancy) and
 * the SAME bar boundaries are applied to all of them. `boundaries` is that one
 * answer; a part that rests through a project simply lists as silent there.
 *
 * **The hard ceiling is 8 patterns x 32 steps = 256 steps.** One Circuit Tracks
 * note track holds exactly that, which at a 16th grid in 4/4 is 16 bars. That
 * single number decides the whole chop, so it is stated in the plan output
 * rather than left for the caller to rediscover:
 *
 *   - a section AT or UNDER the ceiling becomes one project of its own length.
 *     A 12-bar section makes a 12-bar project; it does NOT borrow four bars from
 *     the next section to fill up, because a project boundary is a foot-switch
 *     point and it belongs where the music changes.
 *   - a section OVER the ceiling has to give. It gives in one of two ways, and
 *     which one is a musical decision, not an arithmetic one (see below).
 *
 * **Over-length sections: trim silence if you can, split if you cannot.** After
 * Dark's Intro is 18 bars against a 16-bar ceiling. The right answer is to drop
 * m17-18, because those two bars are silent on every part, so the trim costs
 * nothing. The WRONG answer is "take the first 16": measures 17-18 are the tail,
 * and trimming the head instead would have thrown away 10 piano onsets. So the
 * rule is occupancy-driven, never positional:
 *
 *   1. prefer trimming the TAIL, one silent bar at a time, until it fits;
 *   2. then the HEAD, same way (a silent lead-in is as free as a silent tail;
 *      the tail goes first because the marker names where the section STARTS,
 *      and a pickup bar lives at the head);
 *   3. trim only if it makes the section fit in ONE project. A trim is lossless
 *      in CONTENT but not in TIME (dropping a silent bar makes the next section
 *      arrive early), so it is worth paying to save a project slot and not worth
 *      paying otherwise;
 *   4. if neither end has enough silence, NOTHING is dropped: the section splits
 *      into the fewest equal pieces that each fit. A 20-bar section with content
 *      throughout becomes two 10-bar projects, not 16 + 4.
 *
 * **"Fits" is a PATTERN count, not a step total, and the difference is a whole
 * project on a metre-changing song.** A project's real constraint is 8 pattern
 * slots, each holding at most 32 steps, and a pattern boundary is a BAR line: a
 * pattern that started mid-bar would put the device's own advance somewhere the
 * music has no edge. So the pattern lengths are PACKED, greedily, bar by bar,
 * using each bar's OWN time signature, and a project fits when that packing needs
 * 8 patterns or fewer. `ceil(steps / 32)` is only a lower bound on that count and
 * it is wrong wherever a bar is not a divisor of 32. On Tool's Schism (238 bars,
 * ten signatures, 198 metre changes) the division reports 97 patterns against a
 * true 114 and undercounts 13 of its 19 sections; its one plan consequence is the
 * m102-117 Bridge, which reads as 8 patterns and really needs 9, so it splits and
 * the song costs 20 projects rather than 19. In 4/4 at a 16th grid the two answers
 * agree exactly (a bar is 16 steps, two to a pattern), which is why every song
 * shipped before Schism never noticed.
 *
 * Each project therefore emits `pattern_steps` (the chain the device plays) and
 * `pattern_windows` (which bars each pattern covers), and every SOUNDING part
 * repeats its own copy of the lengths plus its per-pattern onset counts, because
 * the device stores a length byte per (track, pattern slot) and two tracks are
 * hardware-confirmed free to disagree (2026-07-29, Test B). This chop deliberately
 * does not use that freedom: one bar timeline means one boundary set, which is
 * what makes a foot-switch land on every track at once.
 *
 * Pure and network-free: it takes already-flattened parts. `toChopPart` is the
 * convenience wrapper that flattens one Songsterr part into the shape this wants.
 */

import {
  flattenSongsterrDrums,
  flattenSongsterrMelodic,
  isMelodicPart,
  pitchToken,
  type MeasureInfo,
  type SectionInfo,
  type SongsterrPart,
} from './songsterr.js';

/** Pattern slots one Circuit Tracks note track holds. */
export const PATTERN_SLOTS_PER_TRACK = 8;
/** Steps in one Circuit Tracks pattern. */
export const STEPS_PER_PATTERN = 32;
/**
 * The hard ceiling on one project's length, in steps: 8 patterns x 32 steps.
 * At a 16th grid in 4/4 that is 16 bars, and it is the number the whole chop
 * turns on. It appears in the plan output because the audit found it stated
 * nowhere on the tool surface.
 */
export const MAX_PROJECT_STEPS = PATTERN_SLOTS_PER_TRACK * STEPS_PER_PATTERN;

/** One part, flattened to the two things the chop needs: a timeline and onsets. */
export interface ChopPartFlat {
  /** Songsterr part index; the value `import_songsterr`'s `track` takes. */
  partId: number;
  /** Display label (the instrument, plus the contributor's name when there is one). */
  label: string;
  /** This part reads as pitches (`tuning[string] + fret`), not GM percussion. */
  melodic: boolean;
  /** The part's own measure walk (start beat + signature per measure). */
  measures: MeasureInfo[];
  /** The part's own section markers (Songsterr writes them per part). */
  sections: SectionInfo[];
  /** Every onset in quarter-note beats from the track start; `pitch` on melodic parts. */
  onsets: { beat: number; pitch?: number }[];
  /** Hits the GM-percussion reading could not map (they do NOT count as occupancy). */
  unmapped?: number;
}

/**
 * Flatten one Songsterr part into `ChopPartFlat`, picking the reading off the
 * part's own `tuning` exactly as the import path does.
 *
 * A drum part's occupancy is its MAPPED hits: a percussion number outside GM is
 * dropped by the flattener, so a bar holding nothing but exotic percussion reads
 * as silent here. `unmapped` carries the count so the plan can say so rather
 * than quietly trimming a bar that is not actually empty.
 */
export function toChopPart(partId: number, label: string, part: SongsterrPart): ChopPartFlat {
  if (isMelodicPart(part)) {
    const m = flattenSongsterrMelodic(part);
    return {
      partId, label, melodic: true, measures: m.measures, sections: m.sections,
      onsets: m.notes.map((n) => ({ beat: n.beat, pitch: n.pitch })),
    };
  }
  const d = flattenSongsterrDrums(part);
  return {
    partId, label, melodic: false, measures: d.measures, sections: d.sections,
    onsets: d.events.map((e) => ({ beat: e.beat })),
    ...(d.unmapped > 0 ? { unmapped: d.unmapped } : {}),
  };
}

/**
 * One pattern slot of a project: a run of WHOLE bars that fits in one pattern.
 *
 * The boundary is a bar line by construction. A pattern that began mid-bar would
 * make the device advance where the music has no edge, and there would be no
 * measure number to hand back for the per-pattern import call.
 */
export interface ChopPatternWindow {
  /** 1-based pattern slot inside its project (1..8). */
  slot: number;
  /** DISPLAYED measure numbers (1-based), inclusive. */
  from_measure: number;
  to_measure: number;
  bars: number;
  /** Steps this pattern holds: the sum of its bars' own signatures. */
  steps: number;
  /** This single bar is wider than one pattern, so it could not be packed. */
  oversize?: boolean;
}

/** What a part does inside one project. */
export interface ChopProjectPart {
  partId: number;
  label: string;
  melodic: boolean;
  /** Onsets this part plays inside this project's bars. */
  onsets: number;
  /**
   * This track's chain lengths, one per pattern slot, in play order.
   *
   * Same numbers as the project's `pattern_steps`, because one shared bar
   * timeline means one shared boundary set. It is repeated per track anyway
   * because the device stores a length byte per (track, pattern slot) and this is
   * the list that gets written; two tracks holding DIFFERENT lengths is
   * hardware-confirmed to play in sync (2026-07-29), so a caller that wants to
   * diverge from the shared boundaries may, knowing what it gives up.
   */
  pattern_steps: number[];
  /** This part's onsets in each pattern slot; a 0 is a pattern it rests through. */
  pattern_onsets: number[];
  /** Lowest / highest MIDI note (melodic parts with onsets only). */
  low?: number;
  high?: number;
  low_name?: string;
  high_name?: string;
}

/** One project of the chop: a bar range every part shares. */
export interface ChopProject {
  /** 1-based project number in song order (NOT a device slot; the caller picks slots). */
  project: number;
  /** Display name: the section, plus "(2/3)" when one section needed several projects. */
  name: string;
  /** The source's own marker text for the section this came from. */
  section: string;
  /** DISPLAYED measure numbers (1-based), inclusive: what to pass as from_measure/to_measure. */
  from_measure: number;
  to_measure: number;
  bars: number;
  /** Steps at the planned grid; always <= the ceiling. */
  steps: number;
  /**
   * Pattern slots this fills: the BAR-ALIGNED packed count, always <= 8.
   *
   * NOT `ceil(steps / 32)`. That division assumes a bar divides a pattern, which
   * only holds in 4/4 at a 16th grid; see the module header.
   */
  patterns: number;
  /** The chain the device plays: one step count per pattern slot, in order. */
  pattern_steps: number[];
  /** Where each of those patterns starts and ends, in DISPLAYED measure numbers. */
  pattern_windows: ChopPatternWindow[];
  /**
   * Every pattern in this project is the same length.
   *
   * The distinction is a hardware one. A uniform chain was already licensed by
   * the 2026-07-29 Test A (a chained pattern advances at its own length, and two
   * tracks carrying the same sequence stay together); a MIXED chain under tracks
   * that could disagree needed Test B, which passed the same day.
   */
  uniform_patterns: boolean;
  /** The parts that SOUND here, with their onset counts and pitch range. */
  parts: ChopProjectPart[];
  /** Selected parts that rest through this project entirely. */
  silent_parts: { partId: number; label: string }[];
  /** Set when the section was longer than the ceiling and silent bars were dropped. */
  trimmed?: { head_bars: number; tail_bars: number; source_from: number; source_to: number; reason: string };
  /**
   * No part sounds in this project's FIRST pattern (its first 32 steps).
   *
   * Load-bearing for verification, the same way `ProjectPlanEntry.starts_silent`
   * is: a stored-project read decodes pattern 1, so a project that legitimately
   * opens on a rest bar reads back as "no content" and is indistinguishable from
   * a failed write.
   */
  starts_silent: boolean;
}

/** A section of the song, as the source's markers define it. */
export interface ChopSection {
  name: string;
  from_measure: number;
  to_measure: number;
  bars: number;
  steps: number;
  /** Bar-aligned pattern slots this section needs across all its projects. */
  patterns: number;
  /** This section is longer than one project can hold, so it trimmed or split. */
  over_ceiling: boolean;
  /** How many projects it became (0 when it was dropped for holding no onsets). */
  projects: number;
}

export interface SongChopPlan {
  /** The device fact the whole chop turns on, spelled out. */
  ceiling: {
    pattern_slots: number;
    steps_per_pattern: number;
    max_steps: number;
    steps_per_beat: number;
    /** Steps in one bar of the song's opening meter. */
    steps_per_bar: number;
    /**
     * Bars one project holds IN THAT OPENING METER, and only there.
     *
     * On a song whose metre changes (`mixed_metre`) this is a headline number and
     * not the constraint: read `projects[].patterns` instead, which is packed from
     * each bar's own signature.
     */
    max_bars: number;
    signature: string;
    /** The song uses more than one time signature, so `max_bars` is indicative only. */
    mixed_metre: boolean;
    note: string;
  };
  /** Measures in the song (the longest part's measure walk). */
  measures: number;
  /** The parts this chop was computed over, and what each plays across the song. */
  parts: {
    partId: number; label: string; melodic: boolean; onsets: number;
    first_measure?: number; last_measure?: number; sounding_bars: number;
  }[];
  /** The source's own sections, before the ceiling was applied. */
  sections: ChopSection[];
  /** The chop: one entry per project, in song order. */
  projects: ChopProject[];
  /**
   * The shared cut points, as 1-based measure numbers. Every part is cut here
   * and only here, which is what makes the projects line up.
   */
  boundaries: number[];
  /** Bars covered by the projects (the song's measure count minus trims and drops). */
  bars_planned: number;
  /** Bar-aligned pattern slots the whole plan needs, summed over its projects. */
  patterns_planned: number;
  /**
   * The distinct pattern lengths the plan uses, ascending.
   *
   * One entry means the whole song authors at a single length; several mean the
   * chains are mixed, which is what the 2026-07-29 hardware tests licensed.
   */
  pattern_lengths: number[];
  /** Human-readable trim decisions ("Intro: 18 bars, dropped 2 silent tail bar(s) m17-18"). */
  trims: string[];
  /** Human-readable split decisions, for sections no trim could rescue. */
  splits: string[];
  /** Sections dropped because no selected part sounds in them at all. */
  dropped_silent: string[];
  warnings: string[];
  note: string;
}

export interface ChopOptions {
  /** Grid resolution (steps per quarter beat). 4 = 16ths (default), 8 = 32nds. */
  stepsPerBeat?: number;
  /** Pattern slots per track. Default 8 (Circuit Tracks). */
  patternSlots?: number;
  /** Steps per pattern. Default 32 (Circuit Tracks). */
  stepsPerPattern?: number;
}

/** Steps one measure spends, from its own signature. */
function measureSteps(m: MeasureInfo, stepsPerBeat: number): number {
  return Math.max(1, Math.round(((m.signature[0] * 4) / m.signature[1]) * stepsPerBeat));
}

/** Index of the measure containing `beat` (last measure starting at or before it). */
function measureOf(measures: readonly MeasureInfo[], beat: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measures[mid].startBeat <= beat + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Pack `[from..to]` (0-based measure indices) into pattern-sized runs of WHOLE
 * bars, greedily, left to right.
 *
 * A bar is never split, so a pattern boundary is always a bar line, and a bar's
 * width comes from its OWN signature rather than from the song's opening one.
 * The greedy left-to-right walk is the right rule and not merely the easy one:
 * a pattern boundary is where the device advances, so it should fall as LATE as
 * the 32-step budget allows, keeping consecutive bars in the same pattern where
 * they can be. Re-balancing to make the lengths prettier would move edges off the
 * places the music arrives at.
 *
 * A single bar WIDER than one pattern cannot be packed at all (at 12 steps per
 * quarter a 7/8 bar is 42 steps, and a pattern holds 32). It is emitted as its
 * own `oversize` window rather than silently truncated, and the caller warns.
 */
export function packPatternsOnBarLines(
  measures: readonly MeasureInfo[],
  from: number,
  to: number,
  stepsPerBeat: number,
  stepsPerPattern: number,
): ChopPatternWindow[] {
  const out: ChopPatternWindow[] = [];
  let start = from;
  let acc = 0;
  const flush = (end: number, oversize: boolean): void => {
    out.push({
      slot: out.length + 1,
      from_measure: start + 1,
      to_measure: end + 1,
      bars: end - start + 1,
      steps: acc,
      ...(oversize ? { oversize: true } : {}),
    });
    start = end + 1;
    acc = 0;
  };
  for (let i = from; i <= to; i++) {
    const s = measureSteps(measures[i], stepsPerBeat);
    if (s > stepsPerPattern) {
      // Wider than a whole pattern on its own. Close whatever was accumulating,
      // then emit this bar alone and flagged.
      if (acc > 0) flush(i - 1, false);
      start = i;
      acc = s;
      flush(i, true);
      continue;
    }
    if (acc > 0 && acc + s > stepsPerPattern) flush(i - 1, false);
    acc += s;
    if (acc === stepsPerPattern) flush(i, false);
  }
  if (acc > 0) flush(to, false);
  return out;
}

/**
 * Split `[from..to]` into `n` near-equal measure runs. Used only when no trim
 * can rescue an over-length section: an even split (10 + 10) keeps two playable
 * halves, where filling to the ceiling first (16 + 4) leaves a runt project that
 * is awkward to foot-switch into.
 */
function balancedSplit(from: number, to: number, n: number): { from: number; to: number }[] {
  const len = to - from + 1;
  const base = Math.floor(len / n);
  const extra = len % n;
  const out: { from: number; to: number }[] = [];
  let at = from;
  for (let i = 0; i < n; i++) {
    const take = base + (i < extra ? 1 : 0);
    out.push({ from: at, to: at + take - 1 });
    at += take;
  }
  return out;
}

/**
 * Chop a whole song into projects that FIT, on the source's own section markers,
 * with one boundary set shared by every part.
 *
 * See the module header for the ceiling rule, the trim-before-split rule, and
 * why the trim is occupancy-driven rather than positional.
 */
export function planSongChop(parts: readonly ChopPartFlat[], opts: ChopOptions = {}): SongChopPlan {
  if (parts.length === 0) throw new Error('planSongChop needs at least one part.');
  const stepsPerBeat = opts.stepsPerBeat ?? 4;
  const patternSlots = opts.patternSlots ?? PATTERN_SLOTS_PER_TRACK;
  const stepsPerPattern = opts.stepsPerPattern ?? STEPS_PER_PATTERN;
  const maxSteps = patternSlots * stepsPerPattern;
  const warnings: string[] = [];

  // ── one shared timeline ────────────────────────────────────────────
  // The longest part anchors it. Songsterr writes the same measure grid on every
  // part of a tab, so a disagreement is worth saying out loud rather than
  // silently truncating a part that runs longer than the anchor.
  let anchor = parts[0];
  for (const p of parts) if (p.measures.length > anchor.measures.length) anchor = p;
  const measures = anchor.measures;
  const measureCount = measures.length;
  const odd = parts.filter((p) => p.measures.length !== measureCount);
  if (odd.length > 0) {
    warnings.push(
      `${odd.length} part(s) carry a different measure count from the ${measureCount}-measure anchor `
      + `(part ${odd.map((p) => `${p.partId}:${p.measures.length}`).join(', ')}). The chop uses the longest walk; `
      + 'a part that ends early simply reads as silent in the later projects.',
    );
  }
  const unmapped = parts.filter((p) => (p.unmapped ?? 0) > 0);
  if (unmapped.length > 0) {
    warnings.push(
      `${unmapped.map((p) => `part ${p.partId} x${p.unmapped}`).join(', ')}: hit(s) on non-GM percussion numbers do NOT `
      + 'count as occupancy here, so a bar holding only those reads as silent and could be trimmed. Re-import that part '
      + 'with drum_map first if a trim looks wrong.',
    );
  }

  // ── per-bar occupancy, per part ────────────────────────────────────
  const counts: number[][] = parts.map(() => Array.from({ length: measureCount }, () => 0));
  const lows: (number | undefined)[][] = parts.map(() => Array.from({ length: measureCount }, () => undefined));
  const highs: (number | undefined)[][] = parts.map(() => Array.from({ length: measureCount }, () => undefined));
  for (let pi = 0; pi < parts.length; pi++) {
    for (const o of parts[pi].onsets) {
      const mi = measureOf(measures, o.beat);
      if (mi < 0 || mi >= measureCount) continue;
      counts[pi][mi]++;
      if (o.pitch === undefined) continue;
      const lo = lows[pi][mi];
      const hi = highs[pi][mi];
      lows[pi][mi] = lo === undefined ? o.pitch : Math.min(lo, o.pitch);
      highs[pi][mi] = hi === undefined ? o.pitch : Math.max(hi, o.pitch);
    }
  }
  /** A bar no SELECTED part plays in: the only kind a trim may drop. */
  const silentBar = (mi: number): boolean => parts.every((_, pi) => counts[pi][mi] === 0);

  // ── the source's own sections, unioned across the parts ────────────
  // Songsterr writes markers per part, and a tab does not always put them on
  // every part. Taking the union means the chop sees every boundary the source
  // knows about, whichever staff carries it, and it is the same set for all
  // parts by construction.
  const markerName = new Map<number, string>();
  for (const p of parts) {
    for (const s of p.sections) {
      if (s.startMeasure >= 0 && s.startMeasure < measureCount && !markerName.has(s.startMeasure)) {
        markerName.set(s.startMeasure, s.name);
      }
    }
  }
  const starts = [...markerName.keys()].sort((a, b) => a - b);
  if (starts.length === 0) {
    warnings.push(
      'This tab carries NO section markers on any selected part, so there is no structure to chop on. '
      + `The song is laid out in fixed ${maxSteps}-step projects from measure 1 instead; the boundaries are arithmetic, `
      + 'not musical, so check them against the song before authoring.',
    );
    starts.push(0);
    markerName.set(0, 'Song');
  } else if (starts[0] > 0) {
    starts.unshift(0);
    markerName.set(0, '(unmarked)');
  }

  const sectionSpans = starts.map((from, i) => ({
    name: markerName.get(from) ?? 'Song',
    from,
    to: i + 1 < starts.length ? starts[i + 1] - 1 : measureCount - 1,
  }));

  // ── chop each section, then number the projects ────────────────────
  const trims: string[] = [];
  const splits: string[] = [];
  const droppedSilent: string[] = [];
  const sections: ChopSection[] = [];
  const windows: { section: string; name: string; from: number; to: number; trimmed?: ChopProject['trimmed'] }[] = [];

  const stepsBetween = (from: number, to: number): number => {
    let n = 0;
    for (let i = from; i <= to; i++) n += measureSteps(measures[i], stepsPerBeat);
    return n;
  };
  const dsp = (i: number): number => i + 1;  // 0-based index to DISPLAYED measure number

  // THE FIT TEST, and it is a pattern count rather than a step total. See the
  // module header: `ceil(steps / 32)` is a lower bound that is only exact when a
  // bar divides a pattern, so a metre-changing song needs the real packing.
  const packOf = (from: number, to: number): ChopPatternWindow[] =>
    packPatternsOnBarLines(measures, from, to, stepsPerBeat, stepsPerPattern);
  const patternsIn = (from: number, to: number): number => packOf(from, to).length;
  const fits = (from: number, to: number): boolean => patternsIn(from, to) <= patternSlots;

  // A bar wider than one pattern cannot be authored at this grid at all, and no
  // amount of splitting rescues it. Say so ONCE, up front, naming the bars: it is
  // a grid decision (drop to a coarser stepsPerBeat, or accept the truncation),
  // not something the chop can decide.
  const oversizeBars = measures
    .map((m, i) => ({ m: dsp(i), steps: measureSteps(m, stepsPerBeat), sig: `${m.signature[0]}/${m.signature[1]}` }))
    .filter((b) => b.steps > stepsPerPattern);
  if (oversizeBars.length > 0) {
    warnings.push(
      `${oversizeBars.length} bar(s) are WIDER than one ${stepsPerPattern}-step pattern at ${stepsPerBeat} steps/beat and `
      + `cannot be authored whole: ${oversizeBars.slice(0, 8).map((b) => `m${b.m} ${b.sig} = ${b.steps} steps`).join(', ')}`
      + `${oversizeBars.length > 8 ? `, +${oversizeBars.length - 8} more` : ''}. A pattern boundary is a bar line, so those `
      + 'bars get a pattern of their own that overruns the slot. Re-plan at a coarser grid (a lower steps parameter) or '
      + 'accept that those bars lose their tail.',
    );
  }

  for (const sec of sectionSpans) {
    const bars = sec.to - sec.from + 1;
    const total = stepsBetween(sec.from, sec.to);
    let anySound = false;
    for (let mi = sec.from; mi <= sec.to && !anySound; mi++) if (!silentBar(mi)) anySound = true;
    if (!anySound) {
      droppedSilent.push(`${sec.name} (m${dsp(sec.from)}-${dsp(sec.to)}, ${bars} bar(s))`);
      sections.push({
        name: sec.name, from_measure: dsp(sec.from), to_measure: dsp(sec.to), bars, steps: total,
        patterns: patternsIn(sec.from, sec.to), over_ceiling: !fits(sec.from, sec.to), projects: 0,
      });
      continue;
    }

    const need = patternsIn(sec.from, sec.to);
    if (need <= patternSlots) {
      windows.push({ section: sec.name, name: sec.name, from: sec.from, to: sec.to });
      sections.push({
        name: sec.name, from_measure: dsp(sec.from), to_measure: dsp(sec.to), bars, steps: total,
        patterns: need, over_ceiling: false, projects: 1,
      });
      continue;
    }

    // Over the ceiling. Try to make it fit by dropping SILENT bars, tail first,
    // then head; a trim is only worth its timing cost if it saves a project.
    let from = sec.from;
    let to = sec.to;
    let tail = 0;
    while (!fits(from, to) && to > from && silentBar(to)) { to--; tail++; }
    let head = 0;
    while (!fits(from, to) && from < to && silentBar(from)) { from++; head++; }

    if (fits(from, to)) {
      const why =
        `${sec.name} is ${bars} bars (${total} steps, ${need} bar-aligned pattern(s)) against the ${patternSlots}-pattern `
        + `budget, so ${head + tail} bar(s) silent on all ${parts.length} selected part(s) were dropped: `
        + `${tail > 0 ? `tail m${dsp(to + 1)}-${dsp(sec.to)}` : ''}${tail > 0 && head > 0 ? ' and ' : ''}${head > 0 ? `head m${dsp(sec.from)}-${dsp(from - 1)}` : ''}. `
        + 'Lossless in content; the next section arrives that much earlier in time.';
      trims.push(why);
      windows.push({
        section: sec.name, name: sec.name, from, to,
        trimmed: { head_bars: head, tail_bars: tail, source_from: dsp(sec.from), source_to: dsp(sec.to), reason: why },
      });
      sections.push({
        name: sec.name, from_measure: dsp(sec.from), to_measure: dsp(sec.to), bars, steps: total,
        patterns: patternsIn(from, to), over_ceiling: true, projects: 1,
      });
      continue;
    }

    // No trim can rescue it: split the WHOLE section (nothing dropped) into the
    // fewest equal pieces that each fit. `n` grows until every piece packs inside
    // the budget, and stops at one-bar pieces, because a bar is the smallest
    // thing a boundary may fall between (an oversize bar is already warned about
    // above and no split can help it).
    let n = Math.max(2, Math.ceil(need / patternSlots));
    let pieces = balancedSplit(sec.from, sec.to, n);
    while (n < bars && pieces.some((p) => !fits(p.from, p.to))) {
      n++;
      pieces = balancedSplit(sec.from, sec.to, n);
    }
    splits.push(
      `${sec.name} is ${bars} bars (${total} steps) needing ${need} bar-aligned pattern(s) against the ${patternSlots}-pattern `
      + `budget, and NEITHER end is silent on all ${parts.length} selected part(s), so nothing is dropped: it splits into `
      + `${n} project(s) of ${pieces.map((p) => `${p.to - p.from + 1}`).join(' + ')} bars. Those cuts fall inside the section, `
      + 'so they are foot-switch points mid-phrase; move one with from_measure/to_measure if the music wants it elsewhere.',
    );
    pieces.forEach((p, i) => windows.push({ section: sec.name, name: `${sec.name} (${i + 1}/${n})`, from: p.from, to: p.to }));
    sections.push({
      name: sec.name, from_measure: dsp(sec.from), to_measure: dsp(sec.to), bars, steps: total,
      patterns: pieces.reduce((s, p) => s + patternsIn(p.from, p.to), 0), over_ceiling: true, projects: n,
    });
  }

  // ── materialize the projects ───────────────────────────────────────
  const patternBeats = stepsPerPattern / stepsPerBeat;
  const projects: ChopProject[] = windows.map((w, i) => {
    const steps = stepsBetween(w.from, w.to);
    const patternWindows = packOf(w.from, w.to);
    const patternSteps = patternWindows.map((q) => q.steps);
    const active: ChopProjectPart[] = [];
    const silent: { partId: number; label: string }[] = [];
    for (let pi = 0; pi < parts.length; pi++) {
      let onsets = 0;
      let low: number | undefined;
      let high: number | undefined;
      for (let mi = w.from; mi <= w.to; mi++) {
        onsets += counts[pi][mi];
        const lo = lows[pi][mi];
        const hi = highs[pi][mi];
        if (lo !== undefined) low = low === undefined ? lo : Math.min(low, lo);
        if (hi !== undefined) high = high === undefined ? hi : Math.max(high, hi);
      }
      const p = parts[pi];
      if (onsets === 0) { silent.push({ partId: p.partId, label: p.label }); continue; }
      active.push({
        partId: p.partId, label: p.label, melodic: p.melodic, onsets,
        pattern_steps: [...patternSteps],
        pattern_onsets: patternWindows.map((q) => {
          let n = 0;
          for (let mi = q.from_measure - 1; mi <= q.to_measure - 1; mi++) n += counts[pi][mi];
          return n;
        }),
        ...(low !== undefined ? { low, low_name: pitchToken(low) } : {}),
        ...(high !== undefined ? { high, high_name: pitchToken(high) } : {}),
      });
    }
    // Pattern 1 is the project's FIRST PACKED pattern, which is a whole number of
    // bars and not necessarily `stepsPerPattern` wide. Deriving it from a fixed
    // width would mis-answer `starts_silent` on exactly the songs this packing
    // exists for.
    const startBeat = measures[w.from].startBeat;
    const firstPattern = patternWindows[0];
    const firstPatternEnd = firstPattern === undefined
      ? startBeat + patternBeats
      : startBeat + (firstPattern.steps / stepsPerBeat);
    const startsSilent = !parts.some((p) => p.onsets.some((o) => o.beat >= startBeat - 1e-6 && o.beat < firstPatternEnd));
    return {
      project: i + 1,
      name: w.name,
      section: w.section,
      from_measure: dsp(w.from),
      to_measure: dsp(w.to),
      bars: w.to - w.from + 1,
      steps,
      patterns: patternWindows.length,
      pattern_steps: patternSteps,
      pattern_windows: patternWindows,
      uniform_patterns: patternSteps.every((s) => s === patternSteps[0]),
      parts: active,
      silent_parts: silent,
      ...(w.trimmed !== undefined ? { trimmed: w.trimmed } : {}),
      starts_silent: startsSilent,
    };
  });

  const short = projects.filter((p) => p.patterns < patternSlots && p.trimmed === undefined);
  if (short.length > 0) {
    warnings.push(
      `${short.length} project(s) use FEWER than the ${patternSlots} pattern slots a track holds `
      + `(${short.map((p) => `${p.name} ${p.bars} bar(s), ${p.patterns} pattern(s)`).join(', ')}). That is deliberate: a `
      + 'project ends where its section ends, and is never padded out of the next section, because the boundary is a '
      + 'foot-switch point.',
    );
  }

  const mixed = projects.filter((p) => !p.uniform_patterns);
  if (mixed.length > 0) {
    warnings.push(
      `${mixed.length} of ${projects.length} project(s) need a MIXED-length pattern chain, because their bars change metre `
      + `(${mixed.slice(0, 6).map((p) => `${p.name} [${p.pattern_steps.join(',')}]`).join('; ')}`
      + `${mixed.length > 6 ? `; +${mixed.length - 6} more` : ''}). The Circuit plays that: a chained pattern advances when `
      + 'its OWN length elapses rather than padding to the full slot, and two tracks holding DIFFERENT lengths stay in '
      + 'sync, both owner-confirmed by ear on 2026-07-29. Author each pattern as its own arrangement section with its '
      + 'own `steps`; do NOT collapse the chain to one length.',
    );
  }

  const sig = measures[0]?.signature ?? [4, 4];
  const stepsPerBar = measureSteps(measures[0] ?? { index: 0, startBeat: 0, signature: [4, 4] }, stepsPerBeat);
  const partSummaries = parts.map((p, pi) => {
    let onsets = 0;
    let first: number | undefined;
    let last: number | undefined;
    let soundingBars = 0;
    for (let mi = 0; mi < measureCount; mi++) {
      const c = counts[pi][mi];
      if (c === 0) continue;
      onsets += c;
      soundingBars++;
      if (first === undefined) first = dsp(mi);
      last = dsp(mi);
    }
    return {
      partId: p.partId, label: p.label, melodic: p.melodic, onsets, sounding_bars: soundingBars,
      ...(first !== undefined ? { first_measure: first } : {}),
      ...(last !== undefined ? { last_measure: last } : {}),
    };
  });

  const barsPlanned = projects.reduce((s, p) => s + p.bars, 0);
  const patternsPlanned = projects.reduce((s, p) => s + p.patterns, 0);
  const patternLengths = [...new Set(projects.flatMap((p) => p.pattern_steps))].sort((a, b) => a - b);
  const mixedMetre = measures.some((m) => m.signature[0] !== sig[0] || m.signature[1] !== sig[1]);
  return {
    ceiling: {
      pattern_slots: patternSlots,
      steps_per_pattern: stepsPerPattern,
      max_steps: maxSteps,
      steps_per_beat: stepsPerBeat,
      steps_per_bar: stepsPerBar,
      max_bars: Math.floor(maxSteps / stepsPerBar),
      signature: `${sig[0]}/${sig[1]}`,
      mixed_metre: mixedMetre,
      note:
        `One note track holds ${patternSlots} patterns x ${stepsPerPattern} steps = ${maxSteps} steps, `
        + `which at ${stepsPerBeat} steps/beat in ${sig[0]}/${sig[1]} is ${Math.floor(maxSteps / stepsPerBar)} bars. `
        + 'That is the hard ceiling on one project and it is what every decision below turns on. '
        + (mixedMetre
          ? `This song CHANGES METRE, so read ${patternSlots} patterns (each at most ${stepsPerPattern} steps, each starting `
            + `on a bar line) as the real constraint and treat the ${Math.floor(maxSteps / stepsPerBar)}-bar figure as `
            + 'indicative: the packing uses every bar\'s own signature, and each project\'s `pattern_steps` is the chain to author.'
          : 'Every bar of this song carries the same signature, so the bar figure is exact.'),
    },
    measures: measureCount,
    parts: partSummaries,
    sections,
    projects,
    boundaries: projects.map((p) => p.from_measure),
    bars_planned: barsPlanned,
    patterns_planned: patternsPlanned,
    pattern_lengths: patternLengths,
    trims,
    splits,
    dropped_silent: droppedSilent,
    warnings,
    note:
      `${projects.length} project(s) and ${patternsPlanned} pattern(s), cut on the source's own section markers and ALIGNED `
      + `across all ${parts.length} part(s): every part is cut at the same bars `
      + `(${projects.map((p) => `m${p.from_measure}`).join(', ')}), so the projects line up musically and a foot-switch moves `
      + 'the whole rig at once. '
      + `Each fits the ${patternSlots}-pattern budget, with every pattern boundary on a BAR line and at most `
      + `${stepsPerPattern} steps; the plan uses ${patternLengths.length} distinct pattern length(s) `
      + `(${patternLengths.join(', ')}). ${barsPlanned} of ${measureCount} bar(s) are covered`
      + (trims.length > 0 || droppedSilent.length > 0
        ? `; the rest is silent bar(s) dropped at a trim or a silent-only section (see trims / dropped_silent).`
        : '.')
      + ' Nothing is written: this is a plan to show the user before authoring.',
  };
}
