/**
 * Whole-song → pattern bank + arrangement (device-neutral, source-neutral).
 *
 * A single Circuit Tracks drum pattern holds at most 32 steps = two 4/4 bars at
 * a 16th grid. A real song is dozens of bars, so "play the whole song" means
 * DECOMPOSING it: chop the track into fixed-length windows (one window = one
 * pattern's worth of steps), quantize each, DEDUPLICATE identical windows (a
 * verse/chorus repeats — the same 2 bars recur), and record the play ORDER
 * (window index → unique-pattern index). The result is a small pattern bank
 * plus the song's bar-by-bar arrangement.
 *
 * This is the unblocked foundation for full-song playback. What each layer of
 * the device can express today vs. later (the SCENE-gated roadmap):
 *   - ONE pattern  → up to 2 bars.
 *   - patterns + CHAIN (a contiguous [start,end] loop over a track's 8 slots)
 *     → up to 8 unique patterns played in slot order = ~16 bars, then it loops.
 *   - patterns + SCENES + SCENE-CHAIN (song arrangement) → ANY length, reusing
 *     a small bank in arbitrary order (verse→chorus→verse→bridge→chorus). This
 *     is what `order` below feeds, and it unlocks once scene coding lands.
 *
 * So this module deliberately produces BOTH the deduped bank AND the full
 * `order`: today a caller realizes the first ≤8 patterns via chain; once scenes
 * exist the SAME decomposition drives an arbitrary-length arrangement with no
 * re-analysis. The device-specific "what fits now" decision stays out of here
 * (this module is neutral); the realizer / script owns it.
 *
 * Pure and dependency-free. Takes the same `DrumEvent[]` the Songsterr and MIDI
 * front-ends emit, so it serves every source.
 */

import type { Step } from './types.js';
import { quantizeDrumEvents, type DrumEvent, type QuantizedDrums } from './drumScore.js';

export interface DecomposeOptions {
  /** Steps in one pattern window. Default 32 (the Circuit max = two 4/4 bars). */
  stepsPerPattern?: number;
  /** Grid resolution (steps per quarter beat). 4 = 16ths (default), 8 = 32nds. */
  stepsPerBeat?: number;
  /**
   * Total quarter-note beats in the song (so trailing silence becomes real
   * empty windows instead of being dropped). Default: the last event's beat.
   */
  totalBeats?: number;
  /**
   * The OTHER sounding layers of the build, keyed into every window's identity.
   *
   * Without this, two windows with identical drums but DIFFERENT melodic/synth
   * content dedupe as "the same section" — the drum grid was the whole identity.
   * Amber (2026-07-29) survived that only because its pad happened to alternate
   * in lockstep with the drums; a build whose layers do not move in lockstep
   * loses scene compression or collapses genuinely different sections silently.
   * A layer contributes IDENTITY, not bank content: the bank patterns stay drum
   * grids, a layer only decides whether two windows may share one.
   *
   * Omitted or empty = the historical drum-only keying, byte-identical.
   */
  layers?: readonly DecomposeLayer[];
}

/**
 * One extra sounding layer of a multi-part build (a synth, a pad, a second
 * drum part), reduced to the onsets that define its identity per window.
 *
 * `token` is the canonical content of one onset: `pitch:gateSteps` for a
 * melodic note (gate included, so two windows differing only in held length do
 * not merge), or the voice name for a percussion hit. Several onsets landing on
 * one step are sorted and joined, so identity is order-independent per step.
 */
export interface DecomposeLayer {
  /** Display label for receipts ("Lead 5 (charang) \"Synthesizer I\""). */
  label: string;
  /** Every onset, in quarter-note beats from the track start. */
  onsets: { beat: number; token: string }[];
}

/** One window of the song, quantized, plus which unique pattern it resolved to. */
export interface SongWindow extends QuantizedDrums {
  /** 0-based position of this window in the song. */
  index: number;
  /** Index into `patterns` this window is identical to (dedup). */
  patternIndex: number;
}

export interface SongDecomposition {
  /** The deduped bank: each distinct pattern, in first-appearance order. */
  patterns: QuantizedDrums[];
  /** Per-window pattern index — the song's arrangement (length = windowCount). */
  order: number[];
  /** Every window (with its own quantize warnings), in song order. */
  windows: SongWindow[];
  windowCount: number;
  uniquePatternCount: number;
  stepsPerPattern: number;
  /** Quarter-note beats spanned by one window. */
  beatsPerPattern: number;
  warnings: string[];
  /**
   * Per-layer window cells when `layers` keyed this decomposition: `cells[w]`
   * is the layer's per-step token row for window w. Carried so
   * `coalescePatterns` can hold the fuzz threshold on EVERY layer (never the
   * drums alone) and so receipts can name what was compared. Absent on a
   * drum-only decomposition.
   */
  layers?: { label: string; cells: string[][] }[];
}

/** Canonical, order-independent key for a quantized window (voice → grid chars). */
function patternKey(q: QuantizedDrums): string {
  const rows = Object.entries(q.voices)
    .map(([voice, steps]) => `${voice}:${steps.map(cellChar).join('')}`)
    .filter((row) => /[^.:]/.test(row.slice(row.indexOf(':') + 1))) // drop all-rest rows
    .sort();
  return rows.length ? rows.join('|') : `__silent_${q.steps}`;
}

/**
 * Separator between the drum-grid key and each layer's cells in a composite
 * window identity. U+0001 cannot appear in a voice name, a pitch token or a
 * grid char, so the composite cannot collide with a differently-split one.
 */
const LAYER_KEY_SEP = String.fromCharCode(1);

/** A grid cell → its char (mirrors quantizedToGrids so dedup matches display). */
function cellChar(s: Step): string {
  if (!s.on) return '.';
  if (s.accent) return 'X';
  if (s.roll === 6) return '6';
  return 'x';
}

/**
 * Chop a whole-song event list into a deduped pattern bank + arrangement order.
 * Each window is quantized independently (so a window's off-grid warnings are
 * local), then keyed and deduped. An all-rest window is a real "silent" pattern,
 * kept so the arrangement stays gapless.
 */
export function decomposeToPatterns(events: readonly DrumEvent[], opts: DecomposeOptions = {}): SongDecomposition {
  const stepsPerPattern = opts.stepsPerPattern ?? 32;
  const stepsPerBeat = opts.stepsPerBeat ?? 4;
  const beatsPerPattern = stepsPerPattern / stepsPerBeat;
  if (!Number.isFinite(beatsPerPattern) || beatsPerPattern <= 0) {
    throw new RangeError(`invalid window: stepsPerPattern=${stepsPerPattern}, stepsPerBeat=${stepsPerBeat}`);
  }

  const lastBeat = events.length ? Math.max(...events.map((e) => e.beat)) : 0;
  const totalBeats = Math.max(opts.totalBeats ?? 0, lastBeat + 1e-6);
  const windowCount = Math.max(1, Math.ceil(totalBeats / beatsPerPattern - 1e-9));

  // Bucket events by window, rebasing each onset to the window's local 0.
  const buckets: DrumEvent[][] = Array.from({ length: windowCount }, () => []);
  for (const e of events) {
    const w = Math.floor((e.beat + 1e-9) / beatsPerPattern);
    if (w < 0 || w >= windowCount) continue;
    buckets[w].push({ ...e, beat: e.beat - w * beatsPerPattern });
  }

  // Bucket each extra layer the same way, into per-window per-step token rows.
  // A step holding several tokens (a chord) sorts and joins them, so a layer
  // cell is order-independent within its step.
  const layersIn = opts.layers ?? [];
  const layerCells: string[][][] = layersIn.map((layer) => {
    const acc: string[][][] = Array.from({ length: windowCount }, () =>
      Array.from({ length: stepsPerPattern }, () => []));
    for (const o of layer.onsets) {
      const w = Math.floor((o.beat + 1e-9) / beatsPerPattern);
      if (w < 0 || w >= windowCount) continue;
      const step = Math.min(stepsPerPattern - 1, Math.max(0, Math.round((o.beat - w * beatsPerPattern) * stepsPerBeat)));
      acc[w][step].push(o.token);
    }
    return acc.map((row) => row.map((cell) => cell.sort().join('+')));
  });

  const patterns: QuantizedDrums[] = [];
  const keyToIndex = new Map<string, number>();
  const order: number[] = [];
  const windows: SongWindow[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < windowCount; i++) {
    const q = quantizeDrumEvents(buckets[i], { beats: beatsPerPattern, stepsPerBeat });
    // The window's IDENTITY: the drum grid PLUS every layer's cells. With no
    // layers this is exactly the historical drum-only key, byte for byte.
    const key = layersIn.length === 0
      ? patternKey(q)
      : [patternKey(q), ...layerCells.map((c) => c[i].join(','))].join(LAYER_KEY_SEP);
    let patternIndex = keyToIndex.get(key);
    if (patternIndex === undefined) {
      patternIndex = patterns.length;
      keyToIndex.set(key, patternIndex);
      patterns.push(q);
    }
    order.push(patternIndex);
    windows.push({ ...q, index: i, patternIndex });
  }

  // Roll up the per-window quantize warnings (they otherwise sit unread in
  // windows[i].warnings). BOTH loss modes matter: off-grid placement limits AND
  // same-voice collisions — the latter silently DROPS hits and is the larger
  // loss on dense parts (a 64th-note hat roll), so surfacing only off-grid
  // understated the fidelity cost in the whole-song flow.
  const offGrid = windows.filter((w) => w.warnings.some((x) => x.includes('off-grid'))).length;
  if (offGrid > 0) {
    warnings.push(`${offGrid} of ${windowCount} window(s) had off-grid onsets (triplets / 32nds / swing) PLACED on micro-ticks (true micro-timing on every route: hardware-confirmed for both the note-track delay and the internal drum micro-mask).`);
  }
  const collided = windows.filter((w) => w.warnings.some((x) => x.includes('collided'))).length;
  if (collided > 0) {
    warnings.push(`${collided} of ${windowCount} window(s) DROPPED stacked same-voice hits (a roll/burst the grid can't place); see per-window warnings. A buzz roll or a baked roll sample is the faithful route.`);
  }

  return {
    patterns, order, windows,
    windowCount, uniquePatternCount: patterns.length,
    stepsPerPattern, beatsPerPattern, warnings,
    ...(layersIn.length > 0
      ? { layers: layersIn.map((l, li) => ({ label: l.label, cells: layerCells[li] })) }
      : {}),
  };
}

/** Render a decomposition's `order` as a compact run-length arrangement string,
 *  e.g. order [0,0,1,0,0,1] → "A×2 B A×2 B" (patterns labelled A,B,C…). */
export function arrangementSummary(decomp: Pick<SongDecomposition, 'order'>): string {
  const label = (n: number): string => {
    let s = '', x = n;
    do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
    return s;
  };
  const runs: string[] = [];
  for (let i = 0; i < decomp.order.length; ) {
    let j = i;
    while (j < decomp.order.length && decomp.order[j] === decomp.order[i]) j++;
    const n = j - i;
    runs.push(n > 1 ? `${label(decomp.order[i])}×${n}` : label(decomp.order[i]));
    i = j;
  }
  return runs.join(' ');
}

/** Pattern label A, B, …, Z, AA, AB … from a 0-based index (shared with the script). */
export function patternLabel(n: number): string {
  let s = '', x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
}

// ── Project plan ──────────────────────────────────────────────────────
//
// A real song does not fit one Circuit project: the device caps a project at 8
// pattern slots per track, while an ordinary track decomposes to 25 patterns
// over 33 plays (Blindside "Caught a Glimpse", 2026-07-16). So a song import
// always ends in the same manual chore: chunk the play order into projects
// that fit, keep them in song order, and hand each one to apply_pattern.
//
// Doing that by hand is the friction this closes. It is a PURE decomposition, not
// a workflow tool: it returns a plan and writes nothing, so the agent still drives
// the per-project apply_pattern calls and the overwrite gate still applies.
//
// What "fits" means changed on 2026-07-29. The old default budgeted by PLAY
// COUNT (`maxPlays: 8` = 16 bars per project), which assumed the pattern chain
// was the only advance mechanism and chopped songs into 2-8x more projects than
// their content needs (a 148-bar song at 16 bars/project = 10 projects from 17
// unique cells). The scene chain lifts that: a project holds up to 8 DISTINCT
// patterns, and its play order can be any sequence that compresses into <= 4
// scene steps of contiguous ascending slot ranges (up to 4 scenes x 8 plays =
// 64 bars per project), exactly the shapes apply_pattern's arrangement realizer
// accepts. So the default boundary is now CONTENT (distinct cells and the
// 8-slot ceiling) plus scene realizability, and `maxPlays` survives only as an
// explicit override with its old play-budget meaning.
//
// Section names are NOT used, deliberately. They are the obvious way to split a
// song, but Songsterr tabs frequently ship with `sections: []` (the Blindside tab
// has none at all), so a section-based split works on some songs and silently has
// nothing to work with on others. Chunking the ORDER always works.

export interface ProjectPlanEntry {
  /** 1-based project number within the song (not a device slot; the caller picks slots). */
  project: number;
  /** Labels of the distinct patterns this project needs, in first-use order. */
  patterns: string[];
  /** This project's slice of the play order, as labels. */
  order: string[];
  /** Run-length rendering of `order`, for the receipt. */
  summary: string;
  /**
   * True when this project's FIRST play is a silent pattern (a count-in / rest bar).
   *
   * Load-bearing for verification, not cosmetic: a stored-project read decodes only
   * pattern 1, so a project whose chain legitimately starts silent reads back as
   * "no content" and is indistinguishable from a failed write. Both the Stranglehold
   * intro and The Darkness project 1 hit this on 2026-07-16. Check this before
   * concluding an upload did not land.
   *
   * (It previously meant "every pattern is silent", which could never be true: such a
   * project is dropped before it is emitted, so the field was always false.)
   */
  starts_silent: boolean;
  /**
   * How this project's order advances on the device: 'chain' when the plays fit
   * a plain pattern chain (one slot per play), 'scenes' when they exceed it and
   * the order relies on a scene chain (<= 4 contiguous scene steps over the
   * deduped slots); the realizer picks the same layout from the same shape.
   */
  advance: 'chain' | 'scenes';
}

export interface ProjectPlan {
  projects: ProjectPlanEntry[];
  /**
   * Run-length summaries of the PROJECTS dropped for holding nothing but silence.
   *
   * Deliberately not a list of labels: the same silent pattern can be BOTH kept and
   * dropped (Blindside "Caught a Glimpse" plays its silent J inside project 2, which
   * has content, and again alone at the end, which is dropped). Reporting "J" as a
   * dropped label would claim J never plays, which is false.
   */
  dropped_silent_projects: string[];
  note: string;
}

/**
 * Chunk a decomposed song's play order into projects that FIT the device.
 *
 * Greedy and order-preserving: fill a project until the next play would not
 * fit, then start the next. Order is never reordered; a project boundary is a
 * foot-switch point, so the song must still play front-to-back across them.
 *
 * "Fits", by DEFAULT, is content-driven and scene-chain-aware: a project holds
 * at most `maxPatterns` (8) DISTINCT patterns, and its play order must be
 * realizable, either as a plain pattern chain (one slot per play, so <= 8
 * plays) or as a scene chain of <= `maxScenes` (4, the device-confirmed range)
 * steps, each a contiguous ascending run over the deduped slots in first-use
 * order. That is the same layout test apply_pattern's arrangement realizer
 * applies, so every emitted project is authorable as-is. Up to 4 scenes x 8
 * plays = 64 bars can land in one project when the order allows it; the old
 * default (`maxPlays: 8` = 16 bars) chopped by play count and produced 2-8x
 * more projects than the content needed.
 *
 * Passing `maxPlays` EXPLICITLY restores the pure play-budget behaviour with
 * exactly its old meaning (close at `maxPlays` plays or `maxPatterns` distinct
 * slots, scene realizability not consulted).
 *
 * Silent patterns (no hits at all — a count-in bar, or a tab's empty measures)
 * are kept when they share a project with real content, but a project that would
 * hold NOTHING BUT silence is dropped: it cannot be authored (the writer refuses
 * an upload with no routable events) and it would waste a project slot on silence
 * the player can produce by not starting the sequencer. Dropped labels are
 * reported rather than silently swallowed.
 */
export function planProjects(
  sections: readonly { name: string; voices: Record<string, string> }[],
  order: readonly string[],
  opts: { maxPlays?: number; maxPatterns?: number; maxBackoff?: number; maxScenes?: number } = {},
): ProjectPlan {
  const maxPatterns = opts.maxPatterns ?? 8;
  const maxScenes = opts.maxScenes ?? 4;
  // How many plays we will give up to avoid cutting through a repeated run.
  // Small on purpose: a project slot is scarce, so protect the phrase without
  // wasting half a project on it.
  const maxBackoff = opts.maxBackoff ?? 2;
  const hasHits = (v: Record<string, string>): boolean =>
    Object.values(v).some((line) => /[^\s.\-~]/.test(line));
  const silentLabels = new Set(sections.filter((s) => !hasHits(s.voices)).map((s) => s.name));

  const patternsIn = (c: readonly string[]): number => new Set(c).size;
  // Scene steps a chunk needs: assign slots in first-use order (how the
  // realizer lays sections into pattern slots), then count the maximal runs of
  // consecutive-ascending slots (how the realizer compresses the order into
  // scenes). Greedy maximal runs are the minimum, so this is exact.
  const sceneRuns = (c: readonly string[]): number => {
    const slotOf = new Map<string, number>();
    let runs = 0;
    let lastSlot = -2;
    for (const label of c) {
      let slot = slotOf.get(label);
      if (slot === undefined) { slot = slotOf.size; slotOf.set(label, slot); }
      if (slot !== lastSlot + 1) runs++;
      lastSlot = slot;
    }
    return runs;
  };
  // The fit predicate. Explicit maxPlays = the historical play budget,
  // unchanged; default = chain OR scene realizability (content-driven).
  const fits = opts.maxPlays !== undefined
    ? (c: readonly string[]): boolean => c.length <= opts.maxPlays! && patternsIn(c) <= maxPatterns
    : (c: readonly string[]): boolean =>
        c.length <= maxPatterns
        || (patternsIn(c) <= maxPatterns && sceneRuns(c) <= maxScenes);

  // Greedy, order-preserving: close a chunk only when the NEXT play would not
  // fit. But "fits the device" is not the only objective: a project boundary
  // is a FOOT-SWITCH point, so cutting through the middle of a repeated run
  // hands the player a stomp in the middle of one continuous idea. When a
  // close is forced mid-run, back off to the last pattern CHANGE so the run stays
  // whole in the next project, as long as the back-off is cheap (a couple of
  // plays). A long vamp that simply exceeds the budget (A x9) cannot be helped
  // and is cut at the limit.
  const chunks: string[][] = [];
  let cur: string[] = [];
  for (const label of order) {
    if (cur.length > 0 && !fits([...cur, label])) {
      let carry: string[] = [];
      // Only back off when the cut would land INSIDE a run (the next play repeats
      // the last one). If the next play is already a change, this cut is at a
      // musical boundary and nothing is gained.
      if (label === cur[cur.length - 1]) {
        let k = cur.length - 1;
        while (k > 0 && cur[k] === cur[k - 1]) k--;
        const backoff = cur.length - k;
        if (k > 0 && backoff <= maxBackoff) carry = cur.splice(k);
      }
      chunks.push(cur);
      cur = carry;
    }
    cur.push(label);
  }
  if (cur.length > 0) chunks.push(cur);

  const dropped: string[] = [];
  const projects: ProjectPlanEntry[] = [];
  for (const chunk of chunks) {
    const allSilent = chunk.every((l) => silentLabels.has(l));
    if (allSilent) {
      dropped.push(runLength(chunk));
      continue;
    }
    const patterns: string[] = [];
    for (const l of chunk) if (!patterns.includes(l)) patterns.push(l);
    projects.push({
      project: projects.length + 1,
      patterns,
      order: [...chunk],
      summary: runLength(chunk),
      starts_silent: silentLabels.has(chunk[0]),
      advance: chunk.length <= maxPatterns ? 'chain' : 'scenes',
    });
  }

  const fitDesc = opts.maxPlays !== undefined
    ? `each fits the device (<=${maxPatterns} patterns, <=${opts.maxPlays} chained plays)`
    : `each fits the device (<=${maxPatterns} distinct patterns; <=${maxPatterns} plays ride the pattern chain, ` +
      `longer spans a scene chain of <=${maxScenes} steps, see each entry's \`advance\`)`;
  const note = projects.length === 0
    ? 'The song produced no authorable project (every pattern is silent).'
    : `${projects.length} project(s), in song order; ${fitDesc}. ` +
      'Foot-switch between them in this order to play the song front-to-back.' +
      (dropped.length > 0
        ? ` Dropped ${dropped.length} silent-only project(s) (${dropped.join(', ')}): a project with no hits cannot be authored, and silence needs no slot. ` +
          'A silent pattern that shares a project with real content is KEPT and still plays.'
        : '');
  return { projects, dropped_silent_projects: dropped, note };
}

/** Run-length a label slice: ["A","A","B"] → "A×2 B". */
function runLength(labels: readonly string[]): string {
  const runs: string[] = [];
  for (let i = 0; i < labels.length; ) {
    let j = i;
    while (j < labels.length && labels[j] === labels[i]) j++;
    runs.push(j - i > 1 ? `${labels[i]}×${j - i}` : labels[i]);
    i = j;
  }
  return runs.join(' ');
}

// ── Fuzzy coalesce ────────────────────────────────────────────────────
//
// Exact dedup barely collapses a human-played track: a ghost note or a fill
// makes each "same" 2-bar groove a distinct grid (39 windows → 31 unique on the
// Tom Petty test). Fuzzy coalesce merges windows that are ALMOST identical so
// the bank shrinks toward the handful of real grooves — the size that has to fit
// the 8 pattern slots. The tradeoff: members of a cluster lose their individual
// fills (we play the cluster's representative bar everywhere), which is exactly
// the right call when the goal is "fit the song into the hardware", and is
// surfaced via `variantCount` so the caller knows how much was flattened.

export interface CoalesceOptions {
  /**
   * Max ONSET difference, as a fraction (0..1) of all (voice × step) cells, for
   * two windows to merge. 0 ≈ exact (onset-only); higher merges more aggressively.
   * Default 0.10 (≈ a couple of differing hits in a 32-step, ~3-voice bar).
   */
  maxDistance?: number;
}

export interface PatternCluster {
  /** The representative (medoid) pattern — the member most typical of the cluster. */
  pattern: QuantizedDrums;
  /** Window indices (song order) that collapsed here. */
  members: number[];
  /** Distinct EXACT variants among the members (1 = all identical; >1 = fills flattened). */
  variantCount: number;
}

export interface CoalescedSong {
  /** Medoid pattern per cluster, in first-appearance order. */
  patterns: QuantizedDrums[];
  /** Window → cluster index (the arrangement, now over the smaller bank). */
  order: number[];
  clusters: PatternCluster[];
  windowCount: number;
  uniquePatternCount: number;
  beatsPerPattern: number;
  stepsPerPattern: number;
  warnings: string[];
}

/** Onset-only Hamming distance between two windows, normalized to 0..1 over the
 *  union of their voices. Accents/ghosts/rolls are ignored — they don't change
 *  which groove a bar IS. Identical grooves → 0; a different section → large. */
export function gridDistance(a: QuantizedDrums, b: QuantizedDrums): number {
  const voices = new Set([...Object.keys(a.voices), ...Object.keys(b.voices)]);
  const steps = Math.max(a.steps, b.steps);
  if (voices.size === 0 || steps === 0) return 0;
  let diff = 0;
  for (const v of voices) {
    const ra = a.voices[v];
    const rb = b.voices[v];
    for (let i = 0; i < steps; i++) {
      const onA = ra?.[i]?.on ?? false;
      const onB = rb?.[i]?.on ?? false;
      if (onA !== onB) diff++;
    }
  }
  return diff / (voices.size * steps);
}

/**
 * Per-step difference between two layer rows, normalized 0..1.
 *
 * A layer is treated as ONE row (the way one drum voice is one row), so a
 * couple of differing cells in a 32-step window land near gridDistance's scale
 * and the same `maxDistance` threshold reads naturally on both.
 */
export function layerDistance(a: readonly string[], b: readonly string[]): number {
  const steps = Math.max(a.length, b.length);
  if (steps === 0) return 0;
  let diff = 0;
  for (let i = 0; i < steps; i++) if ((a[i] ?? '') !== (b[i] ?? '')) diff++;
  return diff / steps;
}

/**
 * Re-cluster an exact decomposition with a fuzzy threshold. Greedy in song
 * order: each window joins the nearest existing cluster within `maxDistance`,
 * else seeds a new one — so a groove's FIRST appearance defines the cluster and
 * later near-variants fold in, while a genuinely new section starts fresh
 * (labels stay musical: A is the opening groove). Each cluster's stored pattern
 * is its medoid (the member with least total distance to the others).
 *
 * When the decomposition carries `layers`, the merge distance is the WORST of
 * the drum distance and every layer's distance: two windows fold together only
 * when EVERY layer of the build is within `maxDistance`, never on the drums
 * alone. The weakest layer governs — drums within threshold but a synth layer
 * far apart is NO merge (the drum-only test silently flattened exactly that,
 * the 2026-07-29 Amber-plan defect).
 */
export function coalescePatterns(decomp: SongDecomposition, opts: CoalesceOptions = {}): CoalescedSong {
  const maxDistance = opts.maxDistance ?? 0.10;
  const W = decomp.windows;
  const L = decomp.layers ?? [];
  // Combined distance: the weakest layer governs the merge.
  const dist = (a: number, b: number): number => {
    let d = gridDistance(W[a], W[b]);
    for (const l of L) {
      const dl = layerDistance(l.cells[a], l.cells[b]);
      if (dl > d) d = dl;
    }
    return d;
  };
  // Full window identity, layers included (the same composite decompose keys by).
  const idOf = (m: number): string =>
    L.length === 0 ? patternKey(W[m]) : [patternKey(W[m]), ...L.map((l) => l.cells[m].join(','))].join(LAYER_KEY_SEP);
  const seeds: number[] = [];      // window index that seeded each cluster
  const members: number[][] = [];
  const order: number[] = [];

  for (let i = 0; i < W.length; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < seeds.length; c++) {
      const d = dist(seeds[c], i);
      if (d <= maxDistance && d < bestD) { bestD = d; best = c; }
    }
    if (best >= 0) { members[best].push(i); order.push(best); }
    else { seeds.push(i); members.push([i]); order.push(members.length - 1); }
  }

  const clusters: PatternCluster[] = members.map((mem) => {
    // Medoid: member minimizing summed distance to the rest (most typical bar).
    let medoid = mem[0];
    let bestSum = Infinity;
    for (const m of mem) {
      let sum = 0;
      for (const n of mem) if (n !== m) sum += dist(m, n);
      if (sum < bestSum) { bestSum = sum; medoid = m; }
    }
    const variants = new Set(mem.map(idOf));
    return { pattern: stripWindowMeta(W[medoid]), members: mem, variantCount: variants.size };
  });

  const warnings: string[] = [];
  const flattened = clusters.filter((c) => c.variantCount > 1);
  if (flattened.length > 0) {
    const collapsed = flattened.reduce((s, c) => s + (c.members.length - 1), 0);
    // When layers keyed the windows, say what a fold was checked against: the
    // receipt must name the layers compared, not imply a drums-only merge.
    const compared = L.length > 0
      ? ` Each fold held on EVERY layer of the build (drum grid + ${L.map((l) => l.label).join(' + ')}), each within ${maxDistance}.`
      : '';
    warnings.push(`fuzzy(${maxDistance}): ${decomp.uniquePatternCount} → ${clusters.length} patterns; ${collapsed} window(s) folded into a near-variant (their individual fills are flattened to the cluster's representative bar).${compared}`);
  }

  return {
    patterns: clusters.map((c) => c.pattern),
    order, clusters,
    windowCount: decomp.windowCount,
    uniquePatternCount: clusters.length,
    beatsPerPattern: decomp.beatsPerPattern,
    stepsPerPattern: decomp.stepsPerPattern,
    warnings,
  };
}

/** Drop the SongWindow-only fields so a cluster's pattern is a plain QuantizedDrums. */
function stripWindowMeta(w: QuantizedDrums): QuantizedDrums {
  return { voices: w.voices, steps: w.steps, warnings: w.warnings };
}

// ── Scene-chain arrangement plan (anticipates scene coding) ───────────
//
// The Circuit advances content on TWO axes:
//   • PATTERN advance — the chain auto-steps patterns 1→2→…→N within a project,
//     then loops. Linear, ≤8 slots. Good for the fine grain INSIDE a section
//     (a verse that alternates two 2-bar bars A B A B is a 2-pattern chain).
//   • SCENE advance — the scene-chain sequences scenes; each scene selects a
//     pattern (or a chain range) + per-track state. This is the SONG axis: it
//     moves verse→chorus→verse→bridge and is unbounded in length.
//
// So a long song compiles to: a small pattern BANK (must fit 8 slots → why fuzzy
// coalesce matters) + a SCENE-CHAIN that is the run-length of the arrangement.
// Each run (a maximal stretch of one pattern) becomes one scene that selects
// that pattern and holds for the run's length. When scene coding lands, this
// `scenes` list is the encoder's direct input; nothing here needs re-deriving.

export interface ArrangementScene {
  /** Index into the bank this scene selects. */
  patternIndex: number;
  /** Pattern label (A, B, …) for display. */
  label: string;
  /** Consecutive windows this scene holds. */
  windows: number;
  /** Bars this scene spans (windows × barsPerWindow), if barsPerWindow is known. */
  bars?: number;
}

export interface ArrangementPlan {
  /** The pattern bank (the coalesced/exact patterns to load into slots). */
  bank: QuantizedDrums[];
  bankSize: number;
  /** Scene-chain: run-length of the arrangement, one scene per section. */
  scenes: ArrangementScene[];
  sceneCount: number;
  maxPatterns: number;
  /** bankSize ≤ 1 — the whole song is one repeated bar. */
  fitsInOnePattern: boolean;
  /** bankSize ≤ maxPatterns — the bank loads into the pattern slots as-is. */
  fitsInPatternSlots: boolean;
  /** Arrangement is each pattern once, in order — a plain CHAIN reproduces it, no scenes. */
  fitsViaChainOnly: boolean;
  notes: string[];
}

/**
 * Compile a decomposition (exact or coalesced) into a bank + scene-chain plan.
 * Source-neutral and device-light: `maxPatterns` (default 8 = Circuit slots) is
 * the only hardware fact. The scene-chain reproduces ANY arrangement length by
 * reusing the bank — the moment the device's scene encoder exists, feed it
 * `scenes`.
 */
export function planArrangement(
  decomp: Pick<SongDecomposition, 'patterns' | 'order'> & Partial<Pick<SongDecomposition, 'beatsPerPattern' | 'stepsPerPattern'>>,
  opts: { maxPatterns?: number; barsPerWindow?: number } = {},
): ArrangementPlan {
  const maxPatterns = opts.maxPatterns ?? 8;
  const bank = decomp.patterns;
  const bankSize = bank.length;

  // Scene-chain = run-length of `order`.
  const scenes: ArrangementScene[] = [];
  for (let i = 0; i < decomp.order.length; ) {
    let j = i;
    while (j < decomp.order.length && decomp.order[j] === decomp.order[i]) j++;
    const windows = j - i;
    scenes.push({
      patternIndex: decomp.order[i],
      label: patternLabel(decomp.order[i]),
      windows,
      ...(opts.barsPerWindow ? { bars: windows * opts.barsPerWindow } : {}),
    });
    i = j;
  }

  // A plain chain only reproduces the song if each pattern plays once, in index
  // order (the run sequence is 0,1,2,…,bankSize-1).
  const runSeq = scenes.map((s) => s.patternIndex);
  const fitsViaChainOnly =
    runSeq.length === bankSize && runSeq.every((p, i) => p === i);

  const notes: string[] = [];
  if (bankSize > maxPatterns) notes.push(`Bank of ${bankSize} exceeds the ${maxPatterns} slots: coalesce harder (raise maxDistance) or split across projects; today only the first ${maxPatterns} realize via chain.`);
  else if (bankSize <= 1) notes.push('Whole song is one repeated bar; a single looping pattern covers it.');
  else if (fitsViaChainOnly) notes.push(`Bank of ${bankSize} plays once in order; a chain over slots 1..${bankSize} reproduces it (no scenes needed).`);
  else notes.push(`Bank of ${bankSize} fits the ${maxPatterns} slots; the ${scenes.length}-step scene-chain reuses them in song order (needs scene coding).`);

  return {
    bank, bankSize, scenes, sceneCount: scenes.length, maxPatterns,
    fitsInOnePattern: bankSize <= 1,
    fitsInPatternSlots: bankSize <= maxPatterns,
    fitsViaChainOnly,
    notes,
  };
}
