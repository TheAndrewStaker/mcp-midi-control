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
}

/** Canonical, order-independent key for a quantized window (voice → grid chars). */
function patternKey(q: QuantizedDrums): string {
  const rows = Object.entries(q.voices)
    .map(([voice, steps]) => `${voice}:${steps.map(cellChar).join('')}`)
    .filter((row) => /[^.:]/.test(row.slice(row.indexOf(':') + 1))) // drop all-rest rows
    .sort();
  return rows.length ? rows.join('|') : `__silent_${q.steps}`;
}

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

  const patterns: QuantizedDrums[] = [];
  const keyToIndex = new Map<string, number>();
  const order: number[] = [];
  const windows: SongWindow[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < windowCount; i++) {
    const q = quantizeDrumEvents(buckets[i], { beats: beatsPerPattern, stepsPerBeat });
    const key = patternKey(q);
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
 * Re-cluster an exact decomposition with a fuzzy threshold. Greedy in song
 * order: each window joins the nearest existing cluster within `maxDistance`,
 * else seeds a new one — so a groove's FIRST appearance defines the cluster and
 * later near-variants fold in, while a genuinely new section starts fresh
 * (labels stay musical: A is the opening groove). Each cluster's stored pattern
 * is its medoid (the member with least total distance to the others).
 */
export function coalescePatterns(decomp: SongDecomposition, opts: CoalesceOptions = {}): CoalescedSong {
  const maxDistance = opts.maxDistance ?? 0.10;
  const W = decomp.windows;
  const seeds: number[] = [];      // window index that seeded each cluster
  const members: number[][] = [];
  const order: number[] = [];

  for (let i = 0; i < W.length; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < seeds.length; c++) {
      const d = gridDistance(W[seeds[c]], W[i]);
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
      for (const n of mem) if (n !== m) sum += gridDistance(W[m], W[n]);
      if (sum < bestSum) { bestSum = sum; medoid = m; }
    }
    const variants = new Set(mem.map((m) => patternKey(W[m])));
    return { pattern: stripWindowMeta(W[medoid]), members: mem, variantCount: variants.size };
  });

  const warnings: string[] = [];
  const flattened = clusters.filter((c) => c.variantCount > 1);
  if (flattened.length > 0) {
    const collapsed = flattened.reduce((s, c) => s + (c.members.length - 1), 0);
    warnings.push(`fuzzy(${maxDistance}): ${decomp.uniquePatternCount} → ${clusters.length} patterns; ${collapsed} window(s) folded into a near-variant (their individual fills are flattened to the cluster's representative bar).`);
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
