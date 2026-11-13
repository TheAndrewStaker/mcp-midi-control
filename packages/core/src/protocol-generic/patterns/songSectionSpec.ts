/**
 * songSectionSpec — build the authoring engine's `SectionAuthoring[]` from an explicit SECTION TABLE
 * plus a ROUTING, with no planner heuristics in between.
 *
 * This is the shape every hand-mapped song has ended up in: the owner (or a measure→pad mapping UI) states, per section, which measures are stored
 * and in which project slot; the routing states which source part feeds which note track. Each of
 * those scripts then re-implemented the same ~120 lines: split the stored window into <=2-bar device
 * patterns, read the drums per window, read each melodic part per window, carry a genuinely silent
 * bar as a rest lane, and guard the stored names. This module is that code, once, tested.
 *
 * What it owns:
 *  - WINDOWING. A section's stored window `[from, to]` (1-based measures, inclusive) splits into
 *    `barsPerPattern`-bar patterns; the step count of each comes from the source's own measures, so a
 *    3/4 bar is 12 steps, never an assumed 16.
 *  - DRUM UNION. Several drum parts (a kit plus a cymbal overdub, the way Songsterr often splits
 *    "Drums" and "Drums (additional)") are unioned per step. A hit on any part is a hit; an accent on
 *    any part is an accent.
 *  - MELODIC ROUTING. Each route names a source part, a note track, and its own import options (a
 *    sustained pad wants `sustainRepeats`, a lead wants `pitchGestures`). A row may restrict which
 *    routes play (`voices`) and may BORROW a route's content from another window (the unified chorus
 *    bass: every chorus plays the figure read from Chorus 2).
 *  - SILENCE. A window with no voice at all becomes an all-rest kick lane, because `apply_pattern`
 *    refuses a voiceless pattern and a silent bar in a song (a stop) is content, not an error.
 *  - NAMES. With `nameMax`, a stored name over the cap, or two names that read identically, refuses
 *    the build instead of producing two projects nobody can tell apart on the card.
 *
 * What it does NOT own: slot occupancy (the adapter + the device read decide that), tempo / colour /
 * pool (the `SongRecipe` globals), and any opinion about which sections to author (that is the table).
 */

import {
  importSongsterrDrums,
  importSongsterrMelodic,
  type MelodicImportOptions,
  type SongsterrImportOptions,
  type SongsterrPart,
} from './songsterr.js';
import type { MelodicTarget, PatternSpec, Playback, SectionAuthoring, SectionDrums } from './songAuthorTypes.js';

/** One row of the section table: what a mapping UI produces per project. */
export interface SectionSpecRow {
  /** Section display name, e.g. "Main Riff". */
  name: string;
  /** Stored on-device project name. */
  stored: string;
  /** Target project slot, 1-based as the device shows it. */
  slot: number;
  /** First stored measure (1-based, as the tab shows it). */
  from: number;
  /** Last stored measure (inclusive). */
  to: number;
  /** How the project plays back. Omitted = loop. */
  playback?: Playback;
  /** Routing keys that play in this section. Omitted = every melodic route. Drums always play. */
  voices?: string[];
  /**
   * Read a route from a DIFFERENT window of the same length: route key → the first measure of the
   * borrowed window. The unified-chorus case: `{ bass: 45 }` plays the bass read from m45 onward.
   */
  borrow?: Record<string, number>;
  /** Free text for the report (why this window, what it replaces). */
  note?: string;
}

/** Import options a route may set; the window fields are the builder's job, never the route's. */
export type RouteImportOptions = Omit<MelodicImportOptions, 'fromMeasure' | 'toMeasure' | 'fromBeat' | 'beats' | 'section'>;

/** One melodic source routed to a note track. */
export interface MelodicRoute {
  /** Routing key, used by rows (`voices`, `borrow`) and as the pattern's melodic voice name. */
  key: string;
  part: SongsterrPart;
  target: MelodicTarget;
  import?: RouteImportOptions;
}

/** Drum import options a routing may set. */
export type DrumImportOptions = Pick<SongsterrImportOptions, 'drumMap' | 'splitToms' | 'ghostVelocity' | 'dynamicVelocity' | 'stepsPerBeat'>;

export interface SongRouting {
  /** Drum parts, unioned per step. Empty = no drums (every pattern then relies on its melodic voices). */
  drums: SongsterrPart[];
  drumImport?: DrumImportOptions;
  melodic: MelodicRoute[];
  /** Drum layout + stored mixer levels, shared by every section. */
  drumLayout: SectionDrums;
}

export interface SectionSpecOptions {
  /** Bars per device pattern. Default 2 (a 32-step pattern at a 16th grid in 4/4). */
  barsPerPattern?: number;
  /**
   * The device's stored-name cap. When set, a longer name or two names that are identical (they
   * would read the same on the card) refuse the build. Omit to skip the check.
   */
  nameMax?: number;
  /** Pattern name prefix; default the section name with non-alphanumerics removed. */
  patternName?: (row: SectionSpecRow, index: number) => string;
}

/** What one section became, for the owner-review report. */
export interface SectionBuildReport {
  slot: number;
  name: string;
  stored: string;
  from: number;
  to: number;
  bars: number;
  patterns: number;
  /** Which voices sounded somewhere in the section (drum lanes collapse to 'drums'). */
  voices: string[];
  /** Pattern indices (1-based) carried as a silent rest lane. */
  silentPatterns: number[];
  /** A chain longer than the hardware-confirmed [1,2]; worth an ear check on load. */
  longChain: boolean;
  /** Distinct importer warnings for this section's melodic reads, prefixed with the route key. */
  warnings: string[];
  note?: string;
}

export class SectionSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SectionSpecError';
  }
}

/** A drum `Step`'s rendering in the char grid the engine takes. */
function gridChar(on: boolean, accent: boolean): string {
  return on ? (accent ? 'X' : 'x') : '.';
}

/**
 * Union several drum parts over one window into char-grid voices. The step count is the source's
 * own for that window, so a part in a different metre cannot silently mis-align.
 */
function drumUnion(parts: readonly SongsterrPart[], from: number, to: number, opts: DrumImportOptions): { voices: Record<string, string>; steps: number } {
  const lanes = new Map<string, { on: boolean[]; accent: boolean[] }>();
  let steps = 0;
  for (const part of parts) {
    const d = importSongsterrDrums(part, { ...opts, fromMeasure: from, toMeasure: to });
    if (steps === 0) steps = d.steps;
    else if (d.steps !== steps) {
      throw new SectionSpecError(`drum parts disagree on m${from}-${to}: ${steps} vs ${d.steps} steps. They are not the same song grid.`);
    }
    for (const [voice, cells] of Object.entries(d.voices)) {
      const lane = lanes.get(voice) ?? { on: new Array<boolean>(d.steps).fill(false), accent: new Array<boolean>(d.steps).fill(false) };
      cells.forEach((c, i) => {
        if (c.on) lane.on[i] = true;
        if (c.on && c.accent === true) lane.accent[i] = true;
      });
      lanes.set(voice, lane);
    }
  }
  const voices: Record<string, string> = {};
  for (const [voice, lane] of lanes) {
    if (!lane.on.some(Boolean)) continue;
    voices[voice] = lane.on.map((on, i) => gridChar(on, lane.accent[i])).join('');
  }
  return { voices, steps };
}

/** A notation row that actually carries a pitch (an all-rest row is not a voice). */
const hasPitch = (row: string | undefined): row is string => row !== undefined && /[a-g]#?-?\d/.test(row);

/**
 * Build the sections. Pure: parts in, `SectionAuthoring[]` + a report out. Throws
 * `SectionSpecError` on a malformed table (overlapping slot, window past the song, bad name) rather
 * than authoring something the owner did not describe.
 */
export function buildSectionsFromSpec(
  rows: readonly SectionSpecRow[],
  routing: SongRouting,
  opts: SectionSpecOptions = {},
): { sections: SectionAuthoring[]; report: SectionBuildReport[] } {
  const barsPer = opts.barsPerPattern ?? 2;
  if (!Number.isInteger(barsPer) || barsPer < 1) throw new SectionSpecError(`barsPerPattern must be a positive integer, got ${barsPer}`);
  validateTable(rows, routing, opts);

  const drumOpts: DrumImportOptions = routing.drumImport ?? {};
  const sections: SectionAuthoring[] = [];
  const report: SectionBuildReport[] = [];

  for (const row of rows) {
    const bars = row.to - row.from + 1;
    const nPat = Math.ceil(bars / barsPer);
    const routes = routing.melodic.filter((r) => row.voices === undefined || row.voices.includes(r.key));
    const patterns: PatternSpec[] = [];
    const silent: number[] = [];
    const sounded = new Set<string>();
    const warnings = new Set<string>();

    for (let i = 0; i < nPat; i++) {
      const wFrom = row.from + i * barsPer;
      const wTo = Math.min(wFrom + barsPer - 1, row.to);
      const drums = routing.drums.length > 0 ? drumUnion(routing.drums, wFrom, wTo, drumOpts) : { voices: {}, steps: 0 };
      let steps = drums.steps;
      const melodic: NonNullable<PatternSpec['melodic']> = {};

      for (const route of routes) {
        const shift = row.borrow?.[route.key] !== undefined ? (row.borrow[route.key] as number) - row.from : 0;
        const r = importSongsterrMelodic(route.part, { ...route.import, fromMeasure: wFrom + shift, toMeasure: wTo + shift });
        if (steps === 0) steps = r.step_count;
        else if (r.step_count !== steps) {
          throw new SectionSpecError(
            `"${row.name}" pattern ${i + 1}: route "${route.key}" reads ${r.step_count} steps where the drums read ${steps}. `
            + (shift !== 0 ? `Its borrowed window (m${wFrom + shift}-${wTo + shift}) has a different length or metre.` : 'The parts disagree on the grid.'),
          );
        }
        // Track-wide notes repeat on every window, and a route RESTING in a window is the section
        // working as written, so neither belongs in a per-section report.
        for (const w of r.warnings) {
          if (w.startsWith('TRACK-WIDE') || w.startsWith('DROPPED FIDELITY') || w.startsWith('This window holds no notes')) continue;
          warnings.add(`${route.key}: ${w}`);
        }
        if (hasPitch(r.notation)) {
          melodic[route.key] = { steps: r.notation, target: route.target };
          sounded.add(route.key);
        }
      }

      const drumVoices = { ...drums.voices };
      if (Object.keys(drumVoices).length > 0) sounded.add('drums');
      // A genuinely silent window (a stop) has no voice at all. apply_pattern refuses a voiceless
      // pattern, so carry the silence as one all-rest lane: the pattern is legal and plays nothing.
      if (Object.keys(drumVoices).length === 0 && Object.keys(melodic).length === 0) {
        drumVoices.kick = '.'.repeat(steps);
        silent.push(i + 1);
      }
      patterns.push({
        name: opts.patternName !== undefined ? opts.patternName(row, i) : `${row.name.replace(/[^A-Za-z0-9]/g, '')}${String.fromCharCode(65 + i)}`,
        steps,
        drumVoices,
        ...(Object.keys(melodic).length > 0 ? { melodic } : {}),
      });
    }

    sections.push({
      section: row.name,
      role: 'author',
      slot: row.slot,
      projectName: row.stored,
      drums: routing.drumLayout,
      patterns,
      playback: row.playback ?? 'loop',
    });
    report.push({
      slot: row.slot, name: row.name, stored: row.stored, from: row.from, to: row.to, bars,
      patterns: nPat,
      voices: [...sounded],
      silentPatterns: silent,
      longChain: nPat > 2,
      warnings: [...warnings],
      ...(row.note !== undefined ? { note: row.note } : {}),
    });
  }
  return { sections, report };
}

/** Refuse a table the owner could not have meant: duplicate slots, bad windows, unreadable names. */
function validateTable(rows: readonly SectionSpecRow[], routing: SongRouting, opts: SectionSpecOptions): void {
  const measures = routing.drums[0]?.measures?.length ?? routing.melodic[0]?.part.measures?.length ?? 0;
  const slots = new Map<number, string>();
  const keys = new Set(routing.melodic.map((r) => r.key));
  if (keys.size !== routing.melodic.length) throw new SectionSpecError('two melodic routes share a key; each route needs its own');
  for (const row of rows) {
    // Two routes MAY share a track (one synth fed by different source parts in different sections,
    // as one mapped song does), but never in the same section: one track carries one voice at a time.
    const tracks = new Map<string, string>();
    for (const r of routing.melodic) {
      if (row.voices !== undefined && !row.voices.includes(r.key)) continue;
      const prev = tracks.get(r.target.track);
      if (prev !== undefined) {
        throw new SectionSpecError(
          `"${row.name}": routes "${prev}" and "${r.key}" both play on ${r.target.track}; one track carries one voice, so restrict the row with \`voices\``,
        );
      }
      tracks.set(r.target.track, r.key);
    }
    if (!Number.isInteger(row.from) || !Number.isInteger(row.to) || row.from < 1 || row.to < row.from) {
      throw new SectionSpecError(`"${row.name}": window m${row.from}-${row.to} is not a forward range of measures`);
    }
    if (measures > 0 && row.to > measures) throw new SectionSpecError(`"${row.name}": m${row.to} is past the song's last measure (${measures})`);
    const prev = slots.get(row.slot);
    if (prev !== undefined) throw new SectionSpecError(`"${prev}" and "${row.name}" both claim slot ${row.slot}`);
    slots.set(row.slot, row.name);
    for (const key of [...(row.voices ?? []), ...Object.keys(row.borrow ?? {})]) {
      if (!keys.has(key)) throw new SectionSpecError(`"${row.name}" names route "${key}", which the routing does not define (${[...keys].join(', ') || 'none'})`);
    }
    if (measures > 0) {
      for (const [key, start] of Object.entries(row.borrow ?? {})) {
        const end = start + (row.to - row.from);
        if (start < 1 || end > measures) throw new SectionSpecError(`"${row.name}": borrowed ${key} window m${start}-${end} is outside the song`);
      }
    }
  }
  if (opts.nameMax !== undefined) {
    const long = rows.filter((r) => r.stored.length > opts.nameMax!);
    if (long.length > 0) {
      throw new SectionSpecError(
        `stored name(s) over ${opts.nameMax} characters: ${long.map((r) => `"${r.stored}" (${r.stored.length})`).join(', ')}. `
        + 'Shorten them; a name cut on the device reads like its neighbour.',
      );
    }
    const seen = new Map<string, string>();
    for (const r of rows) {
      const k = r.stored.trimEnd();
      const prev = seen.get(k);
      if (prev !== undefined) throw new SectionSpecError(`"${prev}" and "${r.name}" would both be stored as "${k}"`);
      seen.set(k, r.name);
    }
  }
}

/**
 * The performer's STOMP MAP: what a single "next part" footswitch has to send to walk this song.
 *
 * The target selects a part by Program Change on its project channel, and the QUEUED range (64..127
 * on the Circuit Tracks, per Novation's own Programmer's Reference: "select project (queued)") lands
 * the change on a musical boundary instead of instantly. So project N is `pcQueued = 63 + N`.
 *
 * The property that makes one pedal enough is that the table's ROW ORDER is the performance order and
 * the slots ascend by one. When that holds, "next project" IS "next section" and the walk is
 * `presses = rows - 1`. It is checked rather than assumed: a song that revisits a section (two rows
 * pointing at one slot, or a slot that steps backwards) needs a controller that can send an absolute
 * PC, and this says so.
 */
export interface StompMap {
  /** Rows in performance order: the part, its slot, and the queued PC that selects it. */
  steps: { name: string; slot: number; pcQueued: number; pcInstant: number }[];
  /** Presses needed to get from the first part to the last, when the walk is monotonic. */
  presses: number;
  /** True when every slot ascends by exactly one, so a bare "next" pedal plays the whole song. */
  monotonic: boolean;
  /** Why `monotonic` is false, when it is. */
  note?: string;
}

export interface StompMapOptions {
  /**
   * The slots in PERFORMANCE order, when that is not simply the table's row order. A song that
   * REVISITS a part repeats its slot (for example 25, 26, 27, 28, 26, 29, 28, 30), which a bare "+1"
   * pedal cannot do: that walk is what a sequence-capable controller gets programmed with.
   */
  playOrder?: readonly number[];
}

export function buildStompMap(rows: readonly SectionSpecRow[], opts: StompMapOptions = {}): StompMap {
  const nameOf = new Map(rows.map((r) => [r.slot, r.name]));
  const order = opts.playOrder ?? rows.map((r) => r.slot);
  const unknown = order.filter((s) => !nameOf.has(s));
  if (unknown.length > 0) {
    throw new SectionSpecError(`playOrder names slot(s) ${unknown.join(', ')}, which this table does not author`);
  }
  const steps = order.map((slot) => ({ name: nameOf.get(slot) as string, slot, pcQueued: 63 + slot, pcInstant: slot - 1 }));
  const gaps = steps.slice(1).map((s, i) => s.slot - steps[i].slot);
  const monotonic = gaps.every((g) => g === 1);
  const revisited = [...new Set(order.filter((s, i) => order.indexOf(s) !== i))];
  const note = monotonic
    ? undefined
    : (revisited.length > 0
      ? `part(s) at slot ${revisited.join(', ')} are REVISITED, so the walk is not +1 and a bare "next project" pedal cannot play this song: it needs a controller that steps through this exact PC list (or an absolute PC per part)`
      : `slots do not ascend by one in performance order (${gaps.map((g, i) => (g === 1 ? undefined : `${steps[i].slot}->${steps[i + 1].slot}`)).filter(Boolean).join(', ')}), so those changes need an absolute PC`);
  return { steps, presses: Math.max(0, steps.length - 1), monotonic, ...(note !== undefined ? { note } : {}) };
}

/** One line per part: the pedal press, the project, and the PC a controller sends. */
export function formatStompMap(map: StompMap): string {
  const lines = map.steps.map((s, i) => `  ${i === 0 ? 'load ' : `press ${String(i).padStart(2)}`}  P${String(s.slot).padEnd(3)} ${s.name.padEnd(14)} PC ${s.pcQueued} queued (${s.pcInstant} instant)${map.steps.findIndex((x) => x.slot === s.slot) !== i ? '  [revisit]' : ''}`);
  lines.push(`  ${map.presses} press(es) per run-through${map.monotonic ? ', slots consecutive in performance order: one "next project" pedal plays the song' : `. WARNING: ${map.note}`}`);
  return lines.join('\n');
}

/** Render the report as the fixed-width table the map scripts print for owner review. */
export function formatSectionReport(report: readonly SectionBuildReport[]): string {
  const lines: string[] = [];
  for (const r of report) {
    const chain = r.longChain ? '*' : ' ';
    const silent = r.silentPatterns.length > 0 ? ` silent pat ${r.silentPatterns.join(',')}` : '';
    lines.push(
      `P${String(r.slot).padEnd(3)} ${r.stored.padEnd(17)} m${String(r.from).padStart(3)}-${String(r.to).padEnd(3)} `
      + `${String(r.bars).padStart(2)}b ${r.patterns}pat${chain} ${r.voices.join(' + ').padEnd(24)}${silent}${r.note !== undefined ? `  ${r.note}` : ''}`,
    );
  }
  return lines.join('\n');
}
