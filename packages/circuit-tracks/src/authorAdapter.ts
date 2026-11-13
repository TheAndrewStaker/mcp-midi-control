/**
 * authorAdapter — the Novation Circuit Tracks adapter for the deterministic song
 * authoring engine (BK-AUTHORING-ENGINE, Item C).
 *
 * The engine core emits a TARGET-NEUTRAL `Operation[]` (author a project / place a
 * sample / clear a slot); this adapter turns each Operation into the EXACT argument
 * object one Circuit tool call takes:
 *
 *   authorProject → apply_pattern    (single `voices` or an `arrangement` chain)
 *   placeSample   → upload_sample    (one baked WAV into a pool slot)
 *   clearSlot     → delete_project   (erase orphan project slots)
 *
 * Everything Circuit-specific lives HERE, never in the neutral contract:
 *  - sample NAME → wire slot for `drum_binding` (resolved against the pool);
 *  - sample NAME → DEVICE slot for `upload_sample`, where `slot = wireSlot + 1`
 *    (the 14-vs-13 trap: the pool/binding layer is 0-based, upload is 1-based, and
 *    that +1 lives ONLY here);
 *  - the pattern shape (top-level `voices` for one pattern, `arrangement.sections[]`
 *    for a chain), the bass line landing on `synth1`, and the SPD-SX `external_targets`
 *    / `condense_drums` vs `drum_binding` layout choice.
 *
 * Pure mapping: no device, no I/O. The pool is passed in so name resolution is explicit.
 */

import type {
  Operation,
  PatternSpec,
  Playback,
  PoolItem,
  ResolvedProject,
  SectionAuthoring,
} from '@mcp-midi-control/core/protocol-generic/patterns/songAuthorTypes.js';
import { resolveVariants } from '@mcp-midi-control/core/protocol-generic/patterns/songAuthor.js';

/** Circuit's MCP port id — the default target for every emitted call. */
const DEFAULT_PORT = 'circuit';
/** The only realizer mode that persists a stored project (see apply_pattern). */
const NCS_UPLOAD_MODE = 'ncs_upload';
/** Authored bass lines route to the Circuit's Synth 1 track. */
const BASS_VOICE_KEY = 'synth1';

/** Thrown when an Operation cannot be resolved against the pool (e.g. an unknown binding name). */
export class AuthorAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorAdapterError';
  }
}

/** What the adapter needs beyond the Operation itself: the pool (for names) and the target port. */
export interface AdapterContext {
  /** The sample pool declared by the recipe; resolves binding NAMES → wire slots. */
  pool: PoolItem[];
  /** MCP port id for the Circuit. Defaults to `'circuit'`. */
  port?: string;
}

/** apply_pattern's argument object, in the exact shape the tool takes (ncs_upload). */
export interface ApplyPatternArgs {
  port: string;
  mode: typeof NCS_UPLOAD_MODE;
  pack: number;
  ncs_slot: number;
  ncs_template: string;
  confirm_overwrite: boolean;
  backup_first: boolean;
  project_name: string;
  bpm: number;
  colour: string;
  sounding_pitch: boolean;
  mixer_levels: Record<string, number>;
  /** condense+external layout: the groove condensed onto the internal drum tracks. */
  condense_drums?: boolean;
  /** condense+external layout: mirror the drums out to an external device (SPD-SX). */
  external_targets?: { device: string; track: string }[];
  /** explicit-binding layout: each of the 4 drum tracks pinned to a wire slot. */
  drum_binding?: number[];
  /** Single-pattern only: total step count. */
  steps?: number;
  /** Single-pattern only: per-voice step strings (drum voices + `synth1` bass). */
  voices?: Record<string, string>;
  /** Arrangement chain: one section per device pattern. */
  arrangement?: { sections: { name: string; steps: number; voices: Record<string, string> }[] };
  /**
   * patterns-mechanism variants (single-pattern section only): the extra pattern slots the performer
   * swaps live on ONE track. The base occupies pattern slot 1 (the top-level `voices`); each entry
   * here adds the alternate slots on its `track`. NOT a global `arrangement` chain — the other tracks
   * keep their one pattern while this one track offers several. See `renderVariantPatterns`.
   */
  variant_patterns?: VariantPatternRender[];
}

/** One alternate pattern slot the performer can select on a track. */
export interface VariantPatternSlot {
  name: string;
  steps: string;
}

/** apply_pattern rendering of one patterns-mechanism variant group (extra slots on one track). */
export interface VariantPatternRender {
  /** What varies, e.g. "fill". */
  element: string;
  /** The ONE Circuit track whose active pattern the performer swaps (e.g. drum3 / synth2 / midi1). */
  track: string;
  mechanism: 'patterns';
  /** The base variation on `track`: pattern slot 1 (the default that loads). */
  base: VariantPatternSlot;
  /** The alternate pattern slots (slot 2..N), one per named variation. */
  slots: VariantPatternSlot[];
  /** The live swap gesture, worded for the section's playback mode (loop vs one-shot). */
  swap: string;
}

/** upload_sample's argument object (Circuit slot-addressed pool). */
export interface UploadSampleArgs {
  port: string;
  pack: number;
  /** DEVICE slot 1..64 = wireSlot + 1. */
  slot: number;
  file: string;
  name: string;
  confirm_overwrite: boolean;
}

/** delete_project's argument object. */
export interface DeleteProjectArgs {
  port: string;
  pack: number;
  slots: number[];
  confirm_delete: boolean;
}

export interface ApplyPatternCall { tool: 'apply_pattern'; args: ApplyPatternArgs; }
export interface UploadSampleCall { tool: 'upload_sample'; args: UploadSampleArgs; }
export interface DeleteProjectCall { tool: 'delete_project'; args: DeleteProjectArgs; }

/** One resolved Circuit tool call: the tool name plus its literal argument object. */
export type CircuitToolCall = ApplyPatternCall | UploadSampleCall | DeleteProjectCall;

const port = (ctx: AdapterContext): string => ctx.port ?? DEFAULT_PORT;

/**
 * A pattern's device `voices` map: the drum voices, plus the bass line on `synth1`
 * when the pattern carries one. (A neutral `PatternSpec` keeps the bass separate;
 * on the Circuit it is just another track key.)
 */
function buildVoices(pattern: PatternSpec): Record<string, string> {
  const voices: Record<string, string> = { ...pattern.drumVoices };
  if (pattern.bassVoice !== undefined) voices[BASS_VOICE_KEY] = pattern.bassVoice;
  // Melodic voices land on their chosen note track (synth1/synth2/midi1/midi2); the channel follows
  // the track. bass→synth1, pad→midi1, etc. A later value on the same track would override; the
  // caller assigns distinct tracks per voice.
  if (pattern.melodic !== undefined) {
    for (const voice of Object.values(pattern.melodic)) {
      voices[voice.target.track] = voice.steps;
    }
  }
  return voices;
}

/**
 * Resolve four binding NAMES to their wire slots against the pool. Refuses (never
 * guesses) if a name has no pool entry — the same contract as the tool's own
 * name-resolution path.
 */
function resolveBinding(names: readonly string[], pool: PoolItem[]): number[] {
  const bySlot = new Map(pool.map((item) => [item.name, item.wireSlot]));
  return names.map((name) => {
    const slot = bySlot.get(name);
    if (slot === undefined) {
      throw new AuthorAdapterError(
        `drum_binding references sample "${name}", which is not in the pool. ` +
        `Pool names: ${[...bySlot.keys()].join(', ') || '(empty)'}.`,
      );
    }
    return slot;
  });
}

/** authorProject → apply_pattern args. */
function adaptAuthorProject(project: ResolvedProject, pack: number, slot: number, overwrite: boolean, backupFirst: boolean, ctx: AdapterContext): ApplyPatternCall {
  const args: ApplyPatternArgs = {
    port: port(ctx),
    mode: NCS_UPLOAD_MODE,
    pack,
    ncs_slot: slot,
    ncs_template: project.template,
    confirm_overwrite: overwrite,
    backup_first: backupFirst,
    project_name: project.projectName,
    bpm: project.tempo,
    colour: project.colour,
    sounding_pitch: project.soundingPitch,
    mixer_levels: project.levels,
  };

  // Drum layout. A binding pins the 4 drum tracks internally (voice-abuse / doubled
  // toms, no external mirror); otherwise the groove is condensed onto the internal
  // tracks and mirrored to an external device.
  if (project.binding !== undefined) {
    args.drum_binding = resolveBinding(project.binding, ctx.pool);
  } else if (project.external !== undefined) {
    args.condense_drums = true;
    args.external_targets = [{ device: project.external.device, track: project.external.track }];
  } else if (project.internalCondense) {
    // SPD-SX-mirror: condense onto the internal drum tracks, NO external route (drums stored up
    // via the section's levels).
    args.condense_drums = true;
  }

  // Pattern shape: one pattern → top-level voices + steps; a chain → arrangement.sections.
  if (project.patterns.length === 1) {
    const only = project.patterns[0];
    args.steps = only.steps;
    args.voices = buildVoices(only);
  } else {
    args.arrangement = {
      sections: project.patterns.map((pattern) => ({
        name: pattern.name,
        steps: pattern.steps,
        voices: buildVoices(pattern),
      })),
    };
  }

  return { tool: 'apply_pattern', args };
}

/**
 * The device sample name is the WAV's basename (sans extension), NOT the pool alias. The alias
 * (`sample.name`) is the binding-resolution key; the device shows the file's own name. Keeping
 * these distinct is what lets a section bind by a logical name while the upload carries the file's.
 */
function deviceSampleName(file: string): string {
  return (file.split(/[\\/]/).pop() ?? file).replace(/\.wav$/i, '');
}

/** placeSample → upload_sample args (the 14-vs-13 slot trap lives here). */
function adaptPlaceSample(sample: { name: string; wireSlot: number; file: string }, pack: number, overwrite: boolean, ctx: AdapterContext): UploadSampleCall {
  return {
    tool: 'upload_sample',
    args: {
      port: port(ctx),
      pack,
      slot: sample.wireSlot + 1,
      file: sample.file,
      name: deviceSampleName(sample.file),
      confirm_overwrite: overwrite,
    },
  };
}

/** clearSlot → delete_project args. */
function adaptClearSlot(slots: number[], pack: number, confirmDelete: boolean, ctx: AdapterContext): DeleteProjectCall {
  return {
    tool: 'delete_project',
    args: {
      port: port(ctx),
      pack,
      slots,
      confirm_delete: confirmDelete,
    },
  };
}

/** Map ONE neutral Operation to its concrete Circuit tool call. */
export function adaptOp(op: Operation, ctx: AdapterContext): CircuitToolCall {
  switch (op.kind) {
    case 'authorProject':
      return adaptAuthorProject(op.project, op.pack, op.slot, op.overwrite, op.backupFirst, ctx);
    case 'placeSample':
      return adaptPlaceSample(op.sample, op.pack, op.overwrite, ctx);
    case 'clearSlot':
      return adaptClearSlot(op.slots, op.pack, op.confirmDelete, ctx);
  }
}

/** Map a whole Operation[] to Circuit tool calls, in order. */
export function adaptOps(ops: Operation[], ctx: AdapterContext): CircuitToolCall[] {
  return ops.map((op) => adaptOp(op, ctx));
}

// ── Variant patterns (BK-SONG-AUTHOR-2, Item D — patterns-mechanism, Phase 1) ──

/**
 * The live swap gesture for one variant group, worded for the section's playback mode. Looping parts
 * are swapped mid-loop (queued to the next cycle); a one-shot part is PRE-selected before Play, so
 * the fill fires once as the part runs through. `playback` omitted = loop (the device default).
 */
function swapGesture(track: string, element: string, playback: Playback | undefined): string {
  const pick = `Patterns view → select the ${track} track → tap the ${element} pattern`;
  return playback === 'one-shot'
    ? `${pick} BEFORE Play (one-shot: pre-select; the ${element} fires once as the part plays through)`
    : `${pick} while it loops (queues to the next cycle)`;
}

/**
 * Render a section's patterns-mechanism variant groups into the apply_pattern extra-pattern-slot
 * shape: each group becomes one alternate-slot set on its single differing track, plus the swap
 * gesture. The base stays pattern slot 1 (authored by the engine's `authorProject`); this only adds
 * the swappable slots.
 *
 * Delegates the split + validation to the engine's `resolveVariants` (one source of truth for the
 * single-pattern / one-track-per-group rules), so a mode conflict throws the SAME `SongAuthorError`
 * the engine's `buildProjectOps` raises. scenes-mechanism groups are Phase 2 and yield nothing here.
 */
export function renderVariantPatterns(section: SectionAuthoring): VariantPatternRender[] {
  const { patternPlans } = resolveVariants(section);
  return patternPlans.map((plan) => ({
    element: plan.element,
    track: plan.track,
    mechanism: 'patterns',
    base: { name: plan.base.name, steps: plan.base.steps },
    slots: plan.slots.map((s) => ({ name: s.name, steps: s.steps })),
    swap: swapGesture(plan.track, plan.element, section.playback),
  }));
}

/** Attach rendered variant slots to an apply_pattern call (the base project + its swappable slots). */
export function attachVariantPatterns(call: ApplyPatternCall, renders: VariantPatternRender[]): ApplyPatternCall {
  if (renders.length === 0) return call;
  return { tool: 'apply_pattern', args: { ...call.args, variant_patterns: renders } };
}

/** Human-readable preview of a section's variant groups (patterns rendered; scenes noted Phase 2). */
export function previewVariantPatterns(section: SectionAuthoring): string {
  const { patternPlans, scenesDeferred } = resolveVariants(section);
  const lines: string[] = [];
  for (const p of patternPlans) {
    lines.push(
      `variant "${p.element}" on ${p.track}: base "${p.base.name}" + ${p.slots.length} fill slot(s) [${p.slots.map((s) => s.name).join(', ')}]`,
    );
    lines.push(`    swap: ${swapGesture(p.track, p.element, section.playback)}`);
  }
  for (const el of scenesDeferred) lines.push(`variant "${el}" (scenes): Phase 2 — authored as a scene by Item E, not here.`);
  return lines.join('\n');
}

// ── Human-readable preview ──────────────────────────────────────────────

function previewAuthor(project: ResolvedProject, slot: number, pool?: PoolItem[]): string {
  const form = project.patterns.length === 1
    ? `single pattern (${project.patterns[0].steps} steps)`
    : `arrangement: ${project.patterns.map((p) => p.name).join(' → ')} (${project.patterns.length} patterns)`;

  let layout: string;
  if (project.binding !== undefined) {
    const resolved = pool ? ` = [${resolveBinding(project.binding, pool).join(', ')}]` : '';
    layout = `drum_binding ${project.binding.join(', ')}${resolved}`;
  } else if (project.external !== undefined) {
    layout = `condense+external → ${project.external.device}/${project.external.track}`;
  } else {
    layout = 'no drum layout';
  }

  const beta = project.chainBeyondConfirmed ? '  [WARN: chain > 2 patterns, decoded-beta]' : '';
  return `apply_pattern    Project ${slot}  "${project.projectName}"  ${form}  ${layout}  bpm ${project.tempo}  ${project.colour}${beta}`;
}

/**
 * Render an Operation[] as a human-readable preview (one line per op). Pass the pool
 * to show binding names resolved to their wire slots; without it, names are shown raw.
 */
export function previewOps(ops: Operation[], ctx?: { pool?: PoolItem[]; port?: string }): string {
  const lines = ops.map((op) => {
    switch (op.kind) {
      case 'authorProject':
        return previewAuthor(op.project, op.slot, ctx?.pool);
      case 'placeSample':
        return `upload_sample    Sample ${op.sample.wireSlot + 1} (wire slot ${op.sample.wireSlot})  "${op.sample.name}"  ← ${op.sample.file}`;
      case 'clearSlot':
        return `delete_project   slots [${op.slots.join(', ')}]  (backed up first)`;
    }
  });
  return lines.join('\n');
}
