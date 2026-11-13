/**
 * songAuthorTypes — the frozen contract for the deterministic song authoring engine
 * (BK-AUTHORING-ENGINE). Types ONLY; no logic, no device, no Circuit tool names.
 *
 * Three consumers build against this: the engine core `buildProjectOps` (recipe → operations),
 * the per-part relations + seeder (plan → recipe proposal under a policy), and the per-target
 * adapter (operations → concrete tool calls). A web UI edits a `SongRecipe`; the engine turns it
 * into `Operation[]`; the adapter runs them.
 *
 * Design rules this file encodes (see docs/_private/PLAN-authoring-engine-2026-09-05.md):
 *  - The recipe is TARGET-NEUTRAL. No `drum_binding` / `synth1` / `midi2` here; those are the
 *    adapter's job. Samples are named, never wire-slot numbers, in the section layer.
 *  - `patterns.length === 1` is a single pattern; `>= 2` is an arrangement chain (each entry one
 *    <=32-step device pattern). A `[1,2]` chain is HW-confirmed; longer is decoded-beta and the
 *    engine FLAGS rather than refuses it. `steps` is a total step count, not a rate.
 *  - The engine is POLICY-FREE: the recipe is truth. All opinion (dedup / drop-live / reuse) lives
 *    in the seeder and is captured as concrete `role` decisions on each section before it gets here.
 */

/** A per-voice step string: a char grid ("X.X...") or mini-notation ("c1:2@120 ~ ..."). */
export type StepString = string;

/**
 * Where a melodic voice is authored: a Circuit note track. The transmit CHANNEL follows the track
 * (the device's fixed per-port convention, e.g. synth1=ch1..midi2=ch4), so it is NOT stated here.
 * Which external synth hears it is a rig fact (what listens on that channel), never hardcoded in the
 * engine: routing a part to a synth = choosing its `track` + the section's stored level for that
 * track (0 = external-only, raised = the internal synth too). Reassigning a synth later is a recipe
 * edit, not a code change.
 */
export interface MelodicTarget {
  track: 'synth1' | 'synth2' | 'midi1' | 'midi2';
}

/** One device pattern slot's worth of content (<=32 steps). */
export interface PatternSpec {
  /** Section-local name, e.g. "IntroA" / "BreakFill". Shown on-device and in the receipt. */
  name: string;
  /** Total step count for this pattern (2 bars at a 16th grid = 32). Not a step rate. */
  steps: number;
  /** Drum voices → step strings (kick/snare/hat/openhat/crash/tom/ride/perc, or split tom_* lanes). */
  drumVoices: Record<string, StepString>;
  /**
   * Melodic voices with per-voice track targets (bass, pad, arp, ...). Each is a pitch row on its
   * `target.track`; internal-vs-external-vs-both is the section's stored level for that track.
   */
  melodic?: Record<string, { steps: StepString; target: MelodicTarget }>;
  /**
   * LEGACY shorthand for a bass line on synth1 (== `melodic.bass` with `track:'synth1'`). Kept so the
   * legacy golden still passes; new recipes use `melodic`. The engine treats it as synth1 content.
   */
  bassVoice?: StepString;
}

/** A sample the sections reference by NAME. `wireSlot` is the pool position the adapter resolves to. */
export interface PoolItem {
  name: string;
  /** 0-based wire slot in the pack pool (adapter maps to the device's 1-based "Sample N" as N+1). */
  wireSlot: number;
  /** 'kit' = must already be on the pack (a precondition); a baked source emits a placeSample op. */
  source: 'kit' | { bakedFrom: string };
}

export type DrumLayout =
  /** Fold onto 4 tracks + mirror to an external device; the normal case. */
  | 'condense+external'
  /** Explicit per-track sample binding (doubled toms / voice-abuse), internal-only. */
  | 'explicit-binding'
  /** Fold onto the 4 internal drum tracks, stored UP, NO external route (the SPD-SX-mirror path). */
  | 'internal-condense';

export interface ExternalRoute {
  device: string;
  track: string;
}

export interface SectionDrums {
  layout: DrumLayout;
  /** For explicit-binding: exactly four sample NAMES (Drum1..Drum4). Undefined for condense. */
  binding?: [string, string, string, string];
  external?: ExternalRoute;
  /** Stored mixer levels 0..127 by track key (drum1..drum4 / synth1 / synth2). Drums-up lives here. */
  levels: Record<string, number>;
}

export type SectionRole = 'author' | 'reuse' | 'drop';

/** How a part plays back. Per-section, never a global assumption. */
export type Playback = 'loop' | 'one-shot';

/**
 * A swappable element of a section (a fill; a whole chorus variation): a base plus named variations
 * the performer selects live. `mechanism` is the device swap primitive: `patterns` (per-track pattern
 * select, single-pattern sections only) or `scenes` (one-tap whole-snapshot, multi-pattern sections).
 * Target-neutral; the adapter maps it to the device.
 */
export interface VariantGroup {
  /** What varies, e.g. "fill". */
  element: string;
  /** The base variation's name (authored as the section's default patterns). */
  base: string;
  /** Named alternatives; `differingBars` records which bars each changes (from the relations). */
  variants: { name: string; differingBars?: number[] }[];
  mechanism: 'patterns' | 'scenes';
}

export interface SectionAuthoring {
  /** Section name from the plan's spine, e.g. "Chorus I". */
  section: string;
  role: SectionRole;
  /** When role === 'reuse': the section whose project slot the play order points at. */
  reuseOf?: string;
  /** Target project slot (1-based), as the device shows it. */
  slot: number;
  /** Stored project name, e.g. "MySong Breakdown". */
  projectName: string;
  drums: SectionDrums;
  /** One entry = single pattern; two or more = an arrangement chain in this order. */
  patterns: PatternSpec[];
  /** How the part plays. Omitted = loop (the device default). A one-shot is advanced by the performer. */
  playback?: Playback;
  /** Swappable elements (fills / whole variations). Omitted = none. */
  variants?: VariantGroup[];
}

/** Project-wide settings; shared across every section (not per-section). */
export interface SongGlobals {
  pack: number;
  template: string;
  tempo: number;
  colour: string;
  soundingPitch: boolean;
}

/** The whole authoring input: what a web UI produces and edits. */
export interface SongRecipe {
  globals: SongGlobals;
  pool: PoolItem[];
  sections: SectionAuthoring[];
  /**
   * Slots to erase (orphans left by a previous, larger build that this recipe supersedes). Not
   * derivable from the recipe alone (it depends on what is currently on the pack), so it is stated
   * here; the seeder proposes it and the UI edits it. Each becomes a `clearSlot` op. Optional.
   */
  clearSlots?: number[];
}

/** Per-part comparison of two sections; the UI's indicator data AND the reuse evidence. */
export interface PartRelation {
  a: string;
  b: string;
  part: string;
  relation: 'identical' | 'superset' | 'prefix' | 'different';
  differingBars: number[];
}

/** Seeder policy: opinion defaults ON; the 'chronological' preset turns it all OFF. */
export type SeedPolicy =
  | {
      dedup: boolean;
      dropLive: boolean;
      reuseAcrossLiveDiff: boolean;
      splitToms: boolean;
      bakeFills: boolean;
    }
  | 'chronological';

/**
 * A target-neutral, fully-resolved project payload (the adapter turns it into apply_pattern args).
 * Sample names stay names here; the adapter resolves them to wire slots.
 */
export interface ResolvedProject {
  projectName: string;
  colour: string;
  tempo: number;
  soundingPitch: boolean;
  template: string;
  patterns: PatternSpec[];
  binding?: [string, string, string, string];
  external?: ExternalRoute;
  /** Condense the drums onto the 4 internal tracks with NO external mirror (the internal-condense layout). */
  internalCondense?: boolean;
  levels: Record<string, number>;
  /** True when the chain is longer than the HW-confirmed [1,2] range (decoded-beta); a warning, not a block. */
  chainBeyondConfirmed?: boolean;
}

/** One authoring step. Target-neutral; the adapter maps each to exactly one tool call. */
export type Operation =
  | {
      kind: 'authorProject';
      pack: number;
      slot: number;
      project: ResolvedProject;
      overwrite: boolean;
      backupFirst: boolean;
    }
  | {
      kind: 'placeSample';
      pack: number;
      sample: { name: string; wireSlot: number; file: string };
      overwrite: boolean;
    }
  | {
      kind: 'clearSlot';
      pack: number;
      slots: number[];
      confirmDelete: boolean;
    };
