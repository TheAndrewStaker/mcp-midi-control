/**
 * songAuthorMerge — the CONTENT MERGE that closes the "empty grids" gap (D7) in the
 * deterministic song authoring engine (BK-SONG-AUTHOR-2, Item C).
 *
 * The seeder (`seedAuthoringFromPlan`) produces recipe STRUCTURE with EMPTY grids:
 * every `role:'author'` section carries `patterns[].drumVoices = {}` and no `melodic`,
 * because the seeder knows the section SHAPE (bar count → 1 pattern or an A/B chain) but
 * not the note CONTENT. This module takes the per-section imported voices (drums + the
 * melodic lines) and fills those grids, so the recipe the engine consumes is COMPLETE.
 *
 * Two jobs, both target-neutral (the adapter, not this file, maps to Circuit tool calls):
 *
 *  1. FILL. Each authored section's `patterns[].drumVoices` gets the imported drum grids,
 *     and `patterns[].melodic` gets each imported melodic voice paired with its routing
 *     target (`bass → synth1`, `pad → midi1`, ...; the voice→track map is a USER choice,
 *     configurable, never hardcoded here). Drums are stored as the SPD-SX-mirror layout
 *     `internal-condense`: condensed onto the 4 internal drum tracks, mixed UP (100), with
 *     NO external route. The synth tracks default stored-silent (0) so a synth track that
 *     merely TRANSMITS its channel to an external synth stays quiet internally; a voice the
 *     routing marks `internalAudible` raises its synth track's stored level instead.
 *
 *  2. RECONCILE STRUCTURE vs CONTENT. The seeder GUESSES the pattern shape (e.g. a 2-pattern
 *     A/B chain for a >2-bar section). The imported content has its OWN real shape: a section
 *     given ONE content window is ONE pattern; given N windows it is an N-pattern arrangement.
 *     The window structure WINS over the seeder's guess — we do not blindly paste an A/B guess
 *     onto content that is really one loop, nor keep a single seeded pattern when the content
 *     arrives as two windows. When the two counts already agree, the seeded pattern names +
 *     step counts are preserved; when they differ, names/steps are derived from the windows.
 *
 * PURE and POLICY-FREE, like the rest of the engine: it fills what the caller imported and
 * leaves `reuse` / `drop` sections (and any authored section with no imported content)
 * untouched. Opinion about WHICH section reuses which lives in the seeder, upstream.
 */

import { STEPS_PER_PATTERN } from './songChop.js';
import {
  type MelodicTarget,
  type PatternSpec,
  type SectionAuthoring,
  type SectionDrums,
  type StepString,
} from './songAuthorTypes.js';

// ── Input shapes ────────────────────────────────────────────────────────────

/**
 * One device pattern's worth of imported content: the drum grids plus the melodic
 * step strings, each keyed by its voice NAME (`bass`, `pad`, `arp`, ...). The routing
 * maps the name to a note track; the window itself is target-neutral. `steps` is the
 * window's own step count, used when reconciliation invents a pattern the seeder did
 * not have (otherwise the seeded pattern's count, or an inferred one, is kept).
 */
export interface ContentWindow {
  /** Drum voices → step strings (kick/snare/hat/openhat/crash/tom/ride/perc/…). */
  drumVoices: Record<string, StepString>;
  /** Melodic voices → step strings, keyed by voice NAME. The routing maps name → track. */
  melodic?: Record<string, StepString>;
  /** This window's total step count (<=32). Optional; falls back to the seeded/inferred count. */
  steps?: number;
}

/**
 * A section's imported content: ONE window (the section is a single pattern) or an ORDERED
 * array of windows (an N-pattern arrangement, one window per device pattern). Which form the
 * caller supplies IS the structure decision the merge reconciles against the seeder's guess.
 */
export type SectionWindows = ContentWindow | ContentWindow[];

/** section name → its imported content (per section, or per pattern via an array). */
export type SectionContent = Record<string, SectionWindows>;

/**
 * How one melodic voice routes: the note track it is authored on, and whether the internal
 * synth on that track is stored audible. A bare track name is shorthand for external-only
 * (stored silent). `internalAudible` only affects a `synth1`/`synth2` track (the MIDI tracks
 * have no internal audio); it raises that track's stored mixer level so the internal synth
 * sounds alongside the transmitted channel.
 */
export type VoiceRoute =
  | MelodicTarget['track']
  | { track: MelodicTarget['track']; internalAudible?: boolean };

/**
 * melodic voice NAME → its route. A USER choice, configurable; the owner's default is
 * `bass → synth1` (transmits ch1 → the Hydra), `pad → midi1` (transmits ch3 → the MicroFreak).
 * Reassigning a synth later is a routing edit, never a code change.
 */
export type RoutingConfig = Record<string, VoiceRoute>;

/** The owner's default voice→track map (configurable; pass your own to `mergeContent`). */
export const DEFAULT_ROUTING: RoutingConfig = { bass: 'synth1', pad: 'midi1' };

/** Thrown when a merge cannot resolve (an imported melodic voice with no routing entry). */
export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

// ── Levels ──────────────────────────────────────────────────────────────────

/** Drums stored UP; a synth track audible when a route asks for it. */
const DRUMS_UP = 100;
const INTERNAL_AUDIBLE_LEVEL = 100;
const STORED_SILENT = 0;

interface ResolvedRoute {
  track: MelodicTarget['track'];
  internalAudible: boolean;
}

function normalizeRoute(route: VoiceRoute): ResolvedRoute {
  if (typeof route === 'string') return { track: route, internalAudible: false };
  return { track: route.track, internalAudible: route.internalAudible ?? false };
}

/**
 * The stored mixer levels for the internal-condense layout: drums up (100), the synth
 * tracks stored-silent (0) by default, raised to audible only where a route marks
 * `internalAudible`. The MIDI tracks carry no internal audio, so they take no level.
 */
function mergedLevels(routes: readonly ResolvedRoute[]): Record<string, number> {
  const levels: Record<string, number> = {
    drum1: DRUMS_UP, drum2: DRUMS_UP, drum3: DRUMS_UP, drum4: DRUMS_UP,
    synth1: STORED_SILENT, synth2: STORED_SILENT,
  };
  for (const r of routes) {
    if ((r.track === 'synth1' || r.track === 'synth2') && r.internalAudible) {
      levels[r.track] = INTERNAL_AUDIBLE_LEVEL;
    }
  }
  return levels;
}

// ── Structure reconciliation ─────────────────────────────────────────────────

/** Normalize a section's content to an ordered list of windows (one window = one pattern). */
function toWindowList(windows: SectionWindows): ContentWindow[] {
  return Array.isArray(windows) ? windows : [windows];
}

/**
 * The name for pattern `index` of `total`. When the window count matches the seeder's,
 * the seeded name is kept (it may carry a custom label); otherwise a bare section name
 * for a lone pattern, or a lettered `A`/`B`/`C` suffix for a reconciled chain.
 */
function patternName(section: string, index: number, total: number, seeded?: PatternSpec): string {
  if (seeded !== undefined) return seeded.name;
  if (total <= 1) return section;
  return `${section}${String.fromCharCode(65 + index)}`;
}

/** Longest char-grid drum voice length (mini-notation with spaces/colons is skipped). */
function inferStepsFromGrids(win: ContentWindow): number | undefined {
  let max = 0;
  for (const grid of Object.values(win.drumVoices)) {
    if (/[\s:]/.test(grid)) continue; // a char grid has neither; mini-notation does
    max = Math.max(max, grid.length);
  }
  return max > 0 ? Math.min(max, STEPS_PER_PATTERN) : undefined;
}

/**
 * The step count for a reconciled pattern. The window's own `steps` wins; then a matching
 * seeded pattern's count; then the section's first seeded pattern; then an inference from
 * the drum grids; finally a full 2-bar pattern. Always capped to one device pattern.
 */
function patternSteps(win: ContentWindow, seeded: PatternSpec | undefined, section: SectionAuthoring): number {
  if (win.steps !== undefined) return Math.min(win.steps, STEPS_PER_PATTERN);
  if (seeded !== undefined) return seeded.steps;
  if (section.patterns.length > 0) return section.patterns[0].steps;
  return inferStepsFromGrids(win) ?? STEPS_PER_PATTERN;
}

// ── The merge ─────────────────────────────────────────────────────────────────

/**
 * Fill a seeded `SectionAuthoring[]` with imported content, closing the empty-grids gap.
 *
 * For each `role:'author'` section that has an entry in `content`:
 *  - the pattern COUNT is reconciled to the imported window count (structure vs content);
 *  - each pattern's `drumVoices` is the window's imported drum grids;
 *  - each pattern's `melodic` is the window's melodic voices, each routed to its
 *    `target.track` via `routing` (an unrouted voice is refused, never guessed);
 *  - the drums block becomes `internal-condense` with drums-up levels and stored-silent
 *    synth tracks (a route may raise a synth track to audible).
 *
 * `reuse` / `drop` sections, and any authored section with no imported content, are returned
 * unchanged. The input array is not mutated; a new array of sections is returned.
 */
export function mergeContent(
  sections: readonly SectionAuthoring[],
  content: SectionContent,
  routing: RoutingConfig,
): SectionAuthoring[] {
  return sections.map((section) => {
    if (section.role !== 'author') return section;
    const raw = content[section.section];
    if (raw === undefined) return section; // nothing imported for this authored section
    const windows = toWindowList(raw);
    if (windows.length === 0) return section;

    const sameCount = windows.length === section.patterns.length;
    const usedRoutes: ResolvedRoute[] = [];

    const patterns: PatternSpec[] = windows.map((win, i) => {
      const seeded = sameCount ? section.patterns[i] : undefined;
      const spec: PatternSpec = {
        name: patternName(section.section, i, windows.length, seeded),
        steps: patternSteps(win, seeded, section),
        drumVoices: { ...win.drumVoices },
      };
      if (win.melodic !== undefined && Object.keys(win.melodic).length > 0) {
        const melodic: NonNullable<PatternSpec['melodic']> = {};
        for (const [voiceName, steps] of Object.entries(win.melodic)) {
          const route = routing[voiceName];
          if (route === undefined) {
            throw new MergeError(
              `melodic voice "${voiceName}" in section "${section.section}" has no routing entry. ` +
              `Routed voices: ${Object.keys(routing).join(', ') || '(none)'}.`,
            );
          }
          const resolved = normalizeRoute(route);
          usedRoutes.push(resolved);
          melodic[voiceName] = { steps, target: { track: resolved.track } };
        }
        spec.melodic = melodic;
      }
      return spec;
    });

    const drums: SectionDrums = {
      layout: 'internal-condense',
      levels: mergedLevels(usedRoutes),
    };

    return { ...section, patterns, drums };
  });
}
