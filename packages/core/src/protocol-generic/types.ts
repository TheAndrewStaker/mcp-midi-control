/**
 * BK-051 unified tool surface — type contracts.
 *
 * The generic dispatcher layer that lets a single set of MCP tools
 * (`set_param`, `get_param`, `apply_preset`, etc.) work against every
 * registered device, dispatched by `port`. Per-device behavior lives in
 * a `DeviceDescriptor` each device package registers at bootstrap.
 *
 * Design reference: Session 63 (2026-05-11) — see STATE.md Recent
 * breakthroughs entry. Spec lives in `docs/_private/04-BACKLOG.md`
 * BK-051. This module is the type-only foundation; runtime registry
 * is `./registry.ts`, dispatch logic is `./dispatcher.ts`.
 *
 * Coexists with the older Fractal-only `FractalDevice` interface in
 * `src/fractal/shared/device.ts`. That stays as the wire-protocol
 * contract for Fractal devices; `DeviceDescriptor` here is the MCP
 * tool-surface contract that wraps any device (Fractal or otherwise).
 */

import type { MidiConnection } from '../midi/transport.js';

// ── Canonical vocabulary ────────────────────────────────────────────

/**
 * The Fractal-anchored terms the LLM-facing surface uses everywhere.
 * Per-device descriptors map them to the device's native display word
 * (e.g. Hydrasynth's "module" instead of "block"); the LLM still types
 * "block" and the dispatcher resolves via `block_aliases`.
 *
 * Anti-pattern: never write "preset slot" — `slot` is the signal-chain
 * position INSIDE a preset, `location` is where a preset is stored.
 * The CLAUDE.md terminology rule applies to descriptor authors too.
 */
export type CanonicalTerm =
  | 'block'
  | 'slot'
  | 'preset'
  | 'scene'
  | 'channel'
  | 'location';

export interface CanonicalTermMap {
  block: string;     // AM4: 'block', Hydra: 'module'
  slot: string;      // AM4: 'slot', Axe-Fx II: 'grid position'
  preset: string;    // AM4/AFII: 'preset', Hydra: 'patch'
  scene: string;     // AM4: 'scene', Hydra: '(no scenes)'
  channel: string;   // AM4: 'channel (A/B/C/D)', AFII: 'channel (X/Y)'
  location: string;  // AM4: 'preset location (A01..Z04)'
}

// ── Capabilities ───────────────────────────────────────────────────

/**
 * Drives validation gates + the `describe_device` payload. A capability
 * absence (e.g. `has_scenes=false` on Hydrasynth) is the difference
 * between an alias-resolvable input and a hard-fail error.
 */
export interface DeviceCapabilities {
  slot_model: 'linear' | 'grid';
  slot_count?: number;                          // linear: 4 for AM4
  grid?: { rows: number; cols: number };        // grid: 4×8 for Axe-Fx II
  has_scenes: boolean;
  scene_count?: number;
  has_channels: boolean;
  channel_names?: readonly string[];            // ['A','B','C','D'] or ['X','Y']
  channel_blocks?: readonly string[];           // which blocks expose channels
  preset_location_format?: RegExp;
  supports_save: boolean;
  supports_factory_restore: boolean;
  supports_lineage: boolean;
  has_macros?: boolean;
}

// ── Param / block schema ────────────────────────────────────────────

/**
 * Display-unit label surfaced to the LLM in `describe_device` and
 * `list_params` output. Stored as a string so per-device descriptors
 * can pass their native unit names through verbatim rather than
 * lossy-collapsing into a generic taxonomy.
 *
 * Standard cross-device values (use these when they fit so the LLM
 * sees consistent vocabulary across devices):
 *   'knob' | 'db' | 'ms' | 'percent' | 'hz' | 'seconds' | 'enum' |
 *   'bool' | 'count' | 'semitones' | 'ratio' | 'degrees' |
 *   'bipolar_percent' | 'opaque'
 *
 * Device-native values are accepted unchanged. AM4 ships with
 * 'knob_0_10', 'knob_0_20', 'pf', 'rotary_mic_spacing', 'amp_geq_band'
 * which the manual / front panel use directly — the LLM should see
 * those words, not a coarsened generic substitute. The encode/decode
 * closures on each `ParamSchema` handle the scaling correctly
 * regardless of what `unit` reports.
 *
 * Session 63 cont (Session B chunk 1, 2026-05-11) — was a closed enum
 * collapsing AM4 units lossily; widened to `string` to fix open item
 * #4 carried from Session A.
 */
export type Unit = string;

/** The standard cross-device unit values — provided for editor autocomplete
 *  + as a discoverability anchor in code reviews. Not enforced. */
export const STANDARD_UNITS = [
  'knob',
  'db',
  'ms',
  'percent',
  'hz',
  'seconds',
  'enum',
  'bool',
  'count',
  'semitones',
  'ratio',
  'degrees',
  'bipolar_percent',
  'opaque',
] as const;

export interface ParamSchema {
  display_name: string;
  unit: Unit;
  display_min?: number;
  display_max?: number;
  /** For `unit: 'enum'` only — wire index → display name. */
  enum_values?: Readonly<Record<number, string>>;
  /**
   * Display → wire conversion. Throws on out-of-range or unresolvable enum.
   * The dispatcher invokes this in step 4 of the request lifecycle; the
   * writer/reader below only ever sees wire values.
   */
  encode: (display: number | string) => number;
  /** Wire → display conversion. Used by readers + by enum reporting. */
  decode: (wire: number) => number | string;

  // ── Optional host/device annotations ──────────────────────────────
  //
  // Carried in `list_params` and `describe_device` output when present.
  // Devices populate these from their authoring tools' metadata
  // (manufacturer's editor UI labels, type-gating tables) so the LLM
  // can match user vocabulary to the right knob AND avoid writing
  // type-gated params on the wrong block model.

  /**
   * The label the manufacturer's authoring app uses for this param
   * on its UI (e.g. AM4-Edit's "Master Volume" for `amp.master`, or
   * "Big Muff Drive" for a specific drive type's gain knob). The
   * LLM should prefer this wording when discussing the param with
   * the user. Optional — devices that don't have an authoring app or
   * stable UI vocabulary omit it.
   */
  host_label?: string;

  /**
   * The firmware-internal symbolic identifier for this param (e.g.
   * `DISTORT_MASTER`, `REVERB_TIME`). Useful for cross-referencing
   * against vendor docs or PDFs. Optional.
   */
  parameter_name?: string;

  /**
   * Per-block-type applicability — names which `block_type` values
   * expose this param. The LLM uses this to avoid writing type-gated
   * params on incompatible types (e.g. AM4's `amp.bias_x` only
   * applies on triode amp types; writing it on a solid-state amp
   * model is silently ignored).
   *
   * Format: free-form prose describing the constraint, since the
   * shape of "which types" varies per device. E.g. "applies only
   * when amp.type ∈ [Plexi100W, 1959SLP]" or "applies to any type
   * (special-cased on Twin Verb: shows as 'Vibrato Speed')". When
   * absent, treat as "always applies."
   */
  applies_only_when?: string;
}

export interface BlockSchema {
  display_name: string;
  params: Readonly<Record<string, ParamSchema>>;
  /** Param-name aliases. e.g. `{ decay: 'time' }` so `reverb.decay` resolves to `reverb.time`. */
  aliases?: Readonly<Record<string, string>>;
}

export interface BlockTypeMeta {
  /** Wire value for `set_block(block_type=...)`. */
  wire_value: number;
  display_name: string;
}

// ── Slot / location refs ────────────────────────────────────────────

/**
 * Discriminated by `capabilities.slot_model`. Linear devices use a
 * 1-based slot index; grid devices use `{ row, col }`.
 */
export type SlotRef = number | { row: number; col: number };

/**
 * Devices accept different location encodings. The descriptor's
 * `parse_location` / `format_location` adapters convert at the
 * dispatcher boundary so writer/reader code only ever sees the
 * device's canonical form (often a number index).
 */
export type LocationRef = string | number;

// ── Reader / writer adapter contracts ───────────────────────────────

export interface DispatchCtx {
  /** Live MIDI handle, scoped to this device's connection label. */
  conn: MidiConnection;
  /** The descriptor the dispatcher resolved. */
  descriptor: DeviceDescriptor;
}

export interface ReadResult {
  block: string;
  name: string;
  wire_value: number;
  display_value: number | string;
  unit: Unit;
  /** Raw wire bytes that produced this read, for diagnostics. */
  raw_response?: number[];
}

export interface BatchReadResult {
  reads: readonly ReadResult[];
  /** Indices in the original `queries[]` that failed to read; reason in `errors`. */
  failed_indices: readonly number[];
  errors?: Readonly<Record<number, string>>;
}

export interface WriteResult {
  /** What operation produced this result — 'set_param', 'switch_preset', etc.
   *  Optional for back-compat with the param-only Session B chunk 1. */
  op?: string;
  /** Target of the op — e.g. 'amp.gain' for set_param, 'M03' for switch_preset.
   *  Optional for back-compat. */
  target?: string;
  /** Operation acked on the wire. The semantics of "ack" vary per op —
   *  set_param's echo, switch_preset's write-echo, save's command-ack. */
  acked: boolean;
  /** Soft-warning when ack succeeded but the side effect may not have
   *  landed (e.g. block not placed in active preset). Also used for
   *  no-ack timeouts and partial-failure cases. Reserve for genuine
   *  concerns — routine post-success advisory text goes in `info`. */
  warning?: string;
  /** Routine post-success advisory text — e.g. "switched to Z03, any
   *  unsaved buffer edits were discarded". Distinct from `warning` so
   *  callers (and agents) can tell a successful navigation's normal
   *  footnote apart from a genuine "something is off" warning. */
  info?: string;
  // ── Param-write specific (only populated by set_param / set_params) ──
  block?: string;
  name?: string;
  wire_value?: number;
  display_value?: number | string;
  channel?: string;
}

export interface BatchWriteResult {
  writes: readonly WriteResult[];
  acked_count: number;
  unacked_count: number;
}

export interface BlockChange {
  block_type?: string;          // canonical block name, e.g. "amp", or "none" to clear
  bypassed?: boolean;
  channel?: string | number;    // 'A'..'D' / 'X'..'Y' / 0..3
}

export interface PresetSpec {
  /**
   * Per-slot block placement + per-channel params. Device-validated.
   *
   * v0.4: extended with optional `id` and `instance` fields per block
   * for multi-instance routing on grid devices. AM4 (linear, single-
   * instance per type) ignores both; the existing slot+block_type
   * shape continues to work unchanged for back-compat.
   */
  slots: readonly PresetSlotSpec[];
  /** Per-scene channel/bypass selections. Devices without scenes ignore this. */
  scenes?: readonly SceneSpec[];
  name?: string;
  /**
   * Scene the device lands on AFTER the build (1-indexed, device-clamped).
   * Default 1. Lets the agent preview a specific scene-section
   * (e.g. land on solo scene for an immediate lead test). Devices without
   * scenes ignore this field. Restored v0.3 parity audit — was a top-level
   * field on the removed `axefx2_apply_preset_at` / `axefx2_apply_setlist`.
   */
  landingScene?: number;
  /**
   * v0.4: explicit routing edges for grid devices. Each edge cables a
   * source block's output into a destination block's input.
   *
   * Block references use the `id` field on the source / destination
   * `slots[]` entries; when `id` is omitted, the descriptor auto-
   * derives one from `<block_type>_<instance>` (e.g. `amp_1`,
   * `drive_2`). Two blocks of the same type WITHOUT `instance` are
   * ambiguous — the descriptor errors during validation.
   *
   * Linear devices (AM4) error if this field is set: routing is
   * implicit by slot order. Grid devices (Axe-Fx II/III, FM*) use
   * this verbatim when present, OR infer a row-2 linear chain when
   * omitted (current Level 1 behavior).
   *
   * See `docs/FRACTAL-PRESET-SCHEMA.md` for the wet/dry and dual-amp
   * worked examples.
   */
  routing?: readonly RoutingEdge[];
}

export interface PresetSlotSpec {
  slot: SlotRef;
  block_type: string;
  /**
   * Block params. Two shapes accepted, picked by block:
   *   - Flat: `{ rate: 0.8, depth: 35 }` — for non-channel blocks.
   *   - Channel-nested: `{ A: { gain: 6 } }` — for channel blocks
   *     (`describe_device.capabilities.channel_blocks`).
   *
   * Dispatchers detect shape per slot (any value is an object → nested)
   * and route to the device executor's flat or per-channel input. AM4
   * rejects nested params on non-channel blocks because the executor
   * has no register to write them to; the flat form is the only valid
   * shape for filter/chorus/comp/etc.
   */
  params?:
    | Readonly<Record<string, number | string>>
    | Readonly<Record<string, Readonly<Record<string, number | string>>>>;
  bypassed?: boolean;
  /**
   * v0.4: stable identifier for this block within the preset. Used by
   * `routing` edges and `scenes[].channels` / `scenes[].bypassed` to
   * reference this specific block when multiple instances of the same
   * type exist (e.g. `id: "rhythm_amp"` vs `id: "lead_amp"`).
   *
   * When omitted, the descriptor auto-derives `<block_type>_<instance>`
   * (e.g. `amp_1`, `drive_2`). Explicit ids are recommended for any
   * preset with two instances of the same block_type — auto-derived
   * ids are stable but harder to read in routing edges.
   */
  id?: string;
  /**
   * v0.4: instance number (1-indexed) for grid devices that support
   * multiple of the same block type (Axe-Fx II/III: "Amp 1" + "Amp 2";
   * AM4 has just "the amp"). Defaults to 1. AM4 rejects anything other
   * than 1 with `capability_not_supported`.
   */
  instance?: number;
}

export interface SceneSpec {
  scene: number;
  /** Per-block channel selection on this scene. */
  channels: Readonly<Record<string, string | number>>;
  /** Per-block bypass selection on this scene. */
  bypassed?: Readonly<Record<string, boolean>>;
  name?: string;
}

/**
 * v0.4: a directed cable between two placed blocks. Source and target
 * are block ids (explicit `id` or auto-derived `<block_type>_<instance>`
 * from the entry in `PresetSpec.slots`).
 *
 * Grid devices translate each edge into a `fn 0x06 SET_CELL_ROUTING`
 * write (Axe-Fx II) — the dst cell's input mask gets a bit set for
 * each src row that feeds it. `connect: false` removes the cable; the
 * default is `true` (add).
 */
export interface RoutingEdge {
  /** Source block id (or auto-derived `<block_type>_<instance>`). */
  from: string;
  /** Destination block id. */
  to: string;
  /**
   * Add the cable (default) or remove it. Removing edges is for
   * surgical routing tweaks; whole-preset builds typically don't need
   * `connect: false`.
   */
  connect?: boolean;
}

export interface ApplyResult {
  ok: boolean;
  steps: number;
  duration_ms: number;
  failed_step?: { index: number; description: string; error: string };
  /** Optional warning carried through to the LLM (e.g. unack count) when ok=true. */
  warning?: string;
  /**
   * For target-location applies: whether the save step ran AND acked.
   * Audition-at-target mode (save:false) sets this to false. For
   * working-buffer-only applies (no target), undefined.
   */
  saved?: boolean;
  /**
   * BK-059: structured pre-flight validation errors. Populated when the
   * dispatcher's spec walk surfaces any of unknown block, unknown param,
   * out-of-range enum value, bad channel letter, malformed slot ref, or
   * scene-index range failure. Returning this array means zero wire ops
   * fired — the agent gets every error at once and can fix the whole
   * spec in a single follow-up call.
   */
  validation_errors?: readonly ValidationError[];
  /**
   * BK-065 + BK-066 phase 1: informational notices from the preflight
   * walker for silent auto-resolutions (cross-device param aliases and
   * case/whitespace-tolerant enum matches). Surfaced on the success
   * path (`ok: true`) so the agent can learn the canonical vocabulary
   * for next time. Absent or empty when no resolutions occurred.
   */
  validation_info?: readonly ValidationInfo[];
  /**
   * BK-057: structured read-after-write chain integrity check. Present
   * only when the caller passed `verify_chain: true` AND the device
   * descriptor implements `writer.verifyChain`. Devices without chain
   * integrity semantics (AM4 linear slots, Hydrasynth) return a
   * trivial-pass shape; grid devices (II / III) walk the read-back
   * grid and surface every cell with `routing_mask == 0` past col 1.
   */
  chain_integrity?: ChainIntegrityResult;
}

/**
 * BK-057: result envelope for `verify_chain: true` apply_preset calls.
 * `ok` is false only when the device's read-back found broken signal
 * routing AFTER the apply ops acked successfully. `breaks` lists each
 * dropped cable so the agent can report the exact slot that didn't
 * land. `extra_round_trips` counts the wire ops the verify step added
 * on top of the base apply.
 */
export interface ChainIntegrityResult {
  ok: boolean;
  breaks: ReadonlyArray<{ slot_ref: SlotRef; reason: string }>;
  summary: string;
  extra_round_trips: number;
}

/**
 * BK-059: one entry in `ApplyResult.validation_errors[]`. Identifies the
 * exact path in the apply_preset spec that failed and, where useful,
 * carries `suggestions[]` (closest valid names / values) so the agent
 * can retry with a verbatim choice.
 */
export interface ValidationError {
  /** Index into `spec.slots[]` when the error is slot-scoped. */
  slot_index?: number;
  /** Index into `spec.scenes[]` when the error is scene-scoped. */
  scene_index?: number;
  /** Index into `spec.routing[]` when the error is routing-scoped. */
  routing_index?: number;
  /**
   * Dot-path into the spec where the error lives, e.g.
   * "slots[2].params.Y.effect_type" or "scenes[0].channels.amp".
   */
  path: string;
  /** Human-readable message. */
  error: string;
  /** Up to ~5 closest valid names / values for the agent to retry with. */
  suggestions?: readonly string[];
  /**
   * BK-066 phase 1: when a fuzzy enum match was found but rejected
   * (certainty: 'fuzzy'), this is the single best candidate the
   * agent can retry with verbatim. Distinct from `suggestions[]`,
   * which carries the top-3 list; `suggested_substitution` is the
   * dispatcher's "did you mean exactly this?" answer.
   */
  suggested_substitution?: string;
}

/**
 * BK-065 + BK-066 phase 1: informational notice from the preflight
 * walker. Mirrors `ValidationError` in shape but is NOT a failure
 * the agent must retry; instead it records a silent auto-resolution
 * the dispatcher made on the agent's behalf (an alias substitution
 * or a case/whitespace-tolerant enum match). Surfacing these so the
 * agent can learn the canonical vocabulary on the next call.
 */
export interface ValidationInfo {
  /** Index into `spec.slots[]` when the notice is slot-scoped. */
  slot_index?: number;
  /** Index into `spec.scenes[]` when the notice is scene-scoped. */
  scene_index?: number;
  /**
   * Dot-path into the spec where the resolution happened, e.g.
   * "slots[2].params.Y.volume" (alias) or
   * "slots[0].params.A.type" (case/whitespace).
   */
  path: string;
  /** Human-readable message describing the resolution. */
  info: string;
  /**
   * When the resolution was a cross-device param alias, the original
   * foreign-vocabulary name the agent typed. The canonical name is
   * already reflected on the path; this lets the agent grep "I sent
   * X, the dispatcher used Y" without parsing the message.
   */
  alias_used?: string;
  /**
   * When the resolution was a case/whitespace-tolerant enum match,
   * the original value the agent typed. The canonical value the
   * writer received is in `info`.
   */
  original_value?: string;
  /** The canonical name/value the dispatcher used downstream. */
  canonical?: string;
}

/**
 * Optional behavior knobs for `apply_preset` when `target_location` is
 * supplied. Working-buffer-only mode (no target) ignores these.
 */
export interface ApplyPresetOptions {
  /**
   * True = run switch + apply + save (persists to the target location,
   * destructive). False = run switch + apply only (audition at the
   * target; reversible by switching presets). Defaults to false: the
   * dispatcher gates save on explicit save-language from the user.
   *
   * Setlist flows (apply_setlist) imply save and never pass false.
   */
  save?: boolean;
}

export interface SetlistEntrySpec {
  location: LocationRef;
  spec: PresetSpec;
}

export interface SetlistApplyOptions {
  /** "stop" (default) halts on first failure; "continue" logs each error. */
  on_error?: 'stop' | 'continue';
  /** Validate every entry without sending wire bytes. */
  dry_run?: boolean;
  /** After each successful apply, read the preset name back and compare. */
  verify?: boolean;
}

export interface SetlistEntryResult {
  location: string;
  status: 'ok' | 'error';
  error?: string;
  wallTimeMs: number;
}

export interface ApplySetlistResult {
  ok: boolean;
  total: number;
  applied: number;
  failed: number;
  remaining: readonly string[];
  results: readonly SetlistEntryResult[];
  totalWallTimeMs: number;
  finalActiveLocation?: string;
}

export interface RestoreDefaultsOptions {
  verify?: boolean;
}

export interface RestoreDefaultsRangeOptions extends SetlistApplyOptions {
  /** Same on_error / dry_run / verify shape as SetlistApplyOptions. */
}

export interface RestoreDefaultsResult {
  ok: boolean;
  location: string;
  message?: string;
  wallTimeMs: number;
  verified?: boolean;
  preRestoreName?: string;
  postRestoreName?: string;
  totalBytes?: number;
  messageCount?: number;
}

export interface RestoreDefaultsRangeResult {
  ok: boolean;
  total: number;
  restored: number;
  failed: number;
  remaining: readonly string[];
  results: readonly {
    location: string;
    status: 'ok' | 'error';
    error?: string;
    preRestoreName?: string;
    postRestoreName?: string;
    wallTimeMs: number;
  }[];
  totalWallTimeMs: number;
}

export interface ParamQuery {
  block: string;
  name: string;
  channel?: string | number;
}

export interface WriteOp extends ParamQuery {
  value: number | string;
}

/**
 * Reader contract. The dispatcher calls these after step-5 connection
 * setup. Inputs are pre-validated (block/name resolved to canonical,
 * channel resolved to the device's native form).
 */
export interface ScannedLocation {
  location: string;
  name: string;
  is_empty: boolean;
}

export interface LineageQuery {
  block_type: string;
  name?: string;
  real_gear?: string;
  manufacturer?: string;
  model?: string;
  include_quotes?: boolean;
}

export interface DeviceReader {
  getParam(ctx: DispatchCtx, block: string, name: string, channel?: string | number): Promise<ReadResult>;
  getParams(ctx: DispatchCtx, queries: readonly ParamQuery[]): Promise<BatchReadResult>;
  /** Bulk-scan stored preset locations for their names. */
  scanLocations?(ctx: DispatchCtx, from: string | number, to: string | number): Promise<{
    scanned: readonly ScannedLocation[];
    failed_at?: string;
    failed_reason?: string;
  }>;
  /** Educational/discovery lookup (Fractal lineage corpus, manufacturer
   *  catalog, etc.). Pure data lookup — no MIDI I/O. */
  lookupLineage?(query: LineageQuery): { ok: boolean; text: string };
  /**
   * Return the full lineage corpus this device exposes, keyed by
   * block-type display name. Each value is a formatted text block
   * suitable for `mimeType: 'text/plain'` resource delivery — i.e.
   * the same shape `lookupLineage` returns but for the entire corpus
   * of a block type rather than a single query.
   *
   * Returns undefined when the device has no lineage corpus. The
   * `agent_guidance`-as-resources counterpart (`registerDeviceResources`
   * in `resources.ts`) reads this to surface one resource per
   * `(device, block-type)` pair via `lineage://<deviceId>/<block-type>`.
   *
   * Pure data — no MIDI I/O. Called at server boot during resource
   * registration.
   */
  lineageCorpus?(): Readonly<Record<string, string>> | undefined;
}

/**
 * Rename target — either the working-buffer preset itself or one of
 * its scenes. Scene targets use the `'scene:N'` form (1-indexed to
 * match user-facing scene numbering).
 */
export type RenameTarget = 'preset' | `scene:${number}`;

/**
 * Writer contract. Two layers:
 *
 *   - **Pure builders** (`build*`) return wire bytes without sending.
 *     Used by `verify-dispatcher.ts` and other byte-equality goldens.
 *     Available for every supported op so tests can assert wire-output
 *     identity with the pre-dispatcher path.
 *
 *   - **Execute methods** (`setParam`, `setBlock`, `applyPreset`, ...)
 *     send bytes + await ack + return result envelopes. Used by the
 *     unified MCP tool handlers (Session B). Optional in Session A — a
 *     descriptor can ship pure builders only and add execute methods
 *     in a follow-up session without breaking the dispatcher.
 */
export interface DeviceWriter {
  // ── Pure builders (no I/O) ────────────────────────────────────
  /** Returns the wire bytes for a `set_param` write. Inputs are pre-validated. */
  buildSetParam(block: string, name: string, wireValue: number): number[];
  /**
   * Returns the wire bytes for a channel-switch write. Returns an empty
   * array when the device doesn't expose channels for this block.
   */
  buildChannelSwitch?(block: string, channel: number): number[];
  buildSetBlock?(slot: SlotRef, change: BlockChange): readonly number[][];
  buildSwitchPreset?(location: LocationRef): number[];
  buildSavePreset?(location: LocationRef, name?: string): number[];
  buildSwitchScene?(scene: number): number[];

  /**
   * Pre-MIDI validation hook for `apply_preset`. Optional. When present,
   * the dispatcher calls it BEFORE opening the MIDI handle so spec-shape
   * errors surface without a "device not found" mask when the hardware
   * isn't connected. Throw a plain Error (or DispatchError) with the
   * human-facing rejection message. v0.3 — AM4 implements this so the
   * smoke test can exercise validation without a connected device.
   */
  validatePreset?(spec: PresetSpec, target?: LocationRef): void;

  // ── Execute (I/O — optional for Session A) ────────────────────
  setParam?(ctx: DispatchCtx, block: string, name: string, wireValue: number, channel?: string | number): Promise<WriteResult>;
  setParams?(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult>;
  setBlock?(ctx: DispatchCtx, slot: SlotRef, change: BlockChange): Promise<WriteResult>;
  setBypass?(ctx: DispatchCtx, block: string, bypassed: boolean): Promise<WriteResult>;
  /**
   * Nudge a continuous param up or down by one device-defined step.
   * Maps to the AM4 MESSAGE_INCR / DECR / INCR_COARSE / DECR_COARSE
   * actions; the device knows its own quantum per param, so no value
   * is sent on the wire. "fine" = 1× quantum (~0.01 on a 0..10 knob);
   * "coarse" = 10× quantum (~0.1). Optional — devices without a wire
   * nudge primitive (II, III) omit this and the dispatcher errors
   * with capability_not_supported.
   */
  nudgeParam?(
    ctx: DispatchCtx,
    block: string,
    name: string,
    direction: 'up' | 'down',
    granularity: 'fine' | 'coarse',
    channel?: string | number,
  ): Promise<WriteResult>;
  /**
   * Flip a block's bypass state atomically. Maps to the AM4
   * MESSAGE_TOGGLE action (0x07). Single wire round-trip — agents
   * no longer need to read bypass state and write the inverse.
   * Optional — devices that lack an atomic toggle opcode omit this
   * and the dispatcher falls back to `set_bypass` semantics or
   * errors with capability_not_supported.
   */
  toggleBypass?(ctx: DispatchCtx, block: string): Promise<WriteResult>;
  applyPreset?(
    ctx: DispatchCtx,
    spec: PresetSpec,
    target?: LocationRef,
    options?: ApplyPresetOptions,
  ): Promise<ApplyResult>;
  /**
   * BK-057: optional read-after-write chain integrity check. Called by
   * the dispatcher after `applyPreset` returned ok=true, only when the
   * caller passed `verify_chain: true`. Implementations read the
   * device's current routing state and return a structured pass/fail.
   *
   * Devices without chain-routing semantics omit this method; the
   * dispatcher surfaces `chain_integrity: { ok: true, breaks: [],
   * summary: 'not applicable on <device>', extra_round_trips: 0 }`.
   */
  verifyChain?(ctx: DispatchCtx, spec: PresetSpec): Promise<ChainIntegrityResult>;
  applySetlist?(
    ctx: DispatchCtx,
    entries: readonly SetlistEntrySpec[],
    options?: SetlistApplyOptions,
  ): Promise<ApplySetlistResult>;
  switchPreset?(ctx: DispatchCtx, location: LocationRef): Promise<WriteResult>;
  savePreset?(ctx: DispatchCtx, location: LocationRef, name?: string): Promise<WriteResult>;
  switchScene?(ctx: DispatchCtx, scene: number): Promise<WriteResult>;
  rename?(ctx: DispatchCtx, target: RenameTarget, name: string): Promise<WriteResult>;
  /**
   * Audition the active patch/preset by playing a single note. Default
   * implementation in the dispatcher sends MIDI Note On + Note Off via
   * `ctx.conn.send`; descriptors override only when they need device-
   * specific behavior (e.g. multiplexing to a synth block on a non-
   * default MIDI channel, or capturing inbound MIDI during the note).
   *
   * Whether the note produces audible sound is per-device — synthesizers
   * (Hydrasynth) respond; audio processors (AM4, Axe-Fx II) usually do
   * not unless a synth block is placed in the active preset (Axe-Fx III).
   * Surface that distinction via `agent_guidance.note_response` so the
   * agent knows what to expect before calling.
   */
  playNote?(
    ctx: DispatchCtx,
    note: number,
    velocity: number,
    durationMs: number,
    channel: number,
  ): Promise<WriteResult>;
  /**
   * Audition the active patch by playing a chord (multiple simultaneous
   * notes). Default implementation in the dispatcher sends Note On for
   * each note, sleeps `durationMs`, then sends Note Off for each. When
   * `strumMs` is non-zero the dispatcher staggers the Note Ons by that
   * delay each, simulating a strum or arpeggio attack. Same per-device
   * audibility caveats as `playNote`.
   */
  playChord?(
    ctx: DispatchCtx,
    notes: readonly number[],
    velocity: number,
    durationMs: number,
    strumMs: number,
    channel: number,
  ): Promise<WriteResult>;
  /** Restore the device's defaults for a single location (or range). */
  restoreDefaults?(
    ctx: DispatchCtx,
    target: LocationRef,
    options?: RestoreDefaultsOptions,
  ): Promise<RestoreDefaultsResult>;
  restoreDefaultsRange?(
    ctx: DispatchCtx,
    from: LocationRef,
    to: LocationRef,
    options?: RestoreDefaultsRangeOptions,
  ): Promise<RestoreDefaultsRangeResult>;

  /**
   * Cross-device safe-edit gate (see `docs/SAFE-EDIT-WORKFLOW.md`).
   * Called by the dispatcher BEFORE any navigation operation
   * (apply-at-slot, setlist, switch_preset) when target_location is
   * set. Implementations check `isDirty(label)` and either let the
   * caller proceed, refuse with a structured warning, or save the
   * working buffer to its active slot first.
   *
   * Devices without a dirty signal (e.g. Hydrasynth) omit this
   * method — the dispatcher treats omission as "no gate" and
   * proceeds. The `save_authorized` gate is enforced elsewhere
   * (always at the dispatcher, regardless of device capability).
   */
  guardActiveBufferOrSave?(
    ctx: DispatchCtx,
    mode: 'warn' | 'discard' | 'save_active_first',
  ): Promise<GuardResult>;
}

/**
 * Result envelope from `guardActiveBufferOrSave`. Mirrors the per-
 * device shape (`DirtyGuardResult` in `src/server/shared/safeEdit.ts`)
 * intentionally so the dispatcher can pass it through unchanged.
 */
export interface GuardResult {
  /** Whether the caller may proceed with the navigation. */
  proceed: boolean;
  /** Tool-result text when proceed=false (the warning to surface). */
  warningText?: string;
  /** Human-readable detail for the proceed=true case (after save_active_first). */
  savedDetail?: string;
  /** When proceed=true after save_active_first, the slot the buffer was saved to. */
  savedSlot?: number | string;
}

// ── Top-level descriptor ────────────────────────────────────────────

export interface DeviceDescriptor {
  // -- identity --
  id: string;                                   // 'am4', 'axe-fx-ii', 'hydrasynth'
  display_name: string;                         // 'Fractal AM4'

  // -- port matching --
  port_match: readonly { pattern: RegExp | string }[];
  /** Defaults to `id` if absent. Used by `connections.ts` as the cache key. */
  connection_label?: string;

  // -- LLM-facing surface --
  capabilities: DeviceCapabilities;
  canonical_terms: CanonicalTermMap;

  // -- schema --
  blocks: Readonly<Record<string, BlockSchema>>;
  /** Device-native block-name → canonical-name. e.g. `{ module: 'block' }` on Hydra. */
  block_aliases?: Readonly<Record<string, string>>;
  /** For `set_block(block_type=...)`. Optional — devices may not expose typed slots. */
  block_types?: Readonly<Record<string, BlockTypeMeta>>;

  // -- adapters --
  reader: DeviceReader;
  writer: DeviceWriter;

  /**
   * Long-form agent-behavior guidance surfaced via `describe_device`. v0.3
   * migrated the device-namespaced tool surface (`am4_*`, `axefx2_*`,
   * `hydra_*`) into the unified `set_param` / `apply_preset` / etc. tools.
   * The long tool descriptions that used to carry per-device behavior
   * (relative-change discipline, tempo/time semantics, channel/scene
   * model, reverb naming, save-language gating, etc.) now live here so
   * the LLM still sees them — but as device-scoped guidance rather than
   * tool-scoped duplication.
   *
   * Keyed by topic (e.g. 'relative_change', 'tempo_time', 'reverb_naming')
   * so a `describe_device` reader can selectively surface what's relevant.
   * Keys are device-defined; no enforced taxonomy.
   */
  agent_guidance?: Readonly<Record<string, string>>;

  /**
   * Cross-device concept-key map. Keyed by canonical concept-key
   * (e.g. `drive.output_level`); value is the device-local param name
   * the writer expects (e.g. `level` on AM4, `volume` on II).
   *
   * Surfaced via `describe_device.concept_keys` so the agent can read
   * the per-device spelling for any cross-device concept in one call.
   * The dispatcher's preflight step accepts EITHER the concept-key OR
   * the device-local name; the concept-key path lets an agent share
   * one vocabulary across every registered Fractal device.
   *
   * Optional — devices without any concept-key mappings omit the
   * field. The shared registry in `concept-keys.ts` is the source of
   * truth; each device descriptor populates this field from its own
   * device-specific slice of the registry at module load.
   */
  concept_keys?: Readonly<Record<string, string>>;

  /**
   * Curated top-N param list per block — the params a player adjusts daily
   * (first-page knobs on the hardware). Surfaced through `describe_device`
   * so the agent can skip the `list_params` round-trip for common cases;
   * fall back to `list_params(port, block)` for the full universe.
   *
   * Curation criteria (per BK-051 discoverability pass):
   *   1. First-page knobs on the hardware (daily-use knobs).
   *   2. Display-calibrated (predictable agent behavior).
   *   3. Cross-device-conceptually-meaningful (intuition transfers).
   *
   * Excludes: bypass, channel, internal-state, modifier wiring, master EQ,
   * advanced page parameters, GEQ bands.
   *
   * Each block lists ~5-10 entries IN THAT DEVICE'S CANONICAL SPELLING
   * (II: `drive.effect_type` / `drive.volume`; AM4: `drive.type` /
   * `drive.level`). The dispatcher validates each entry exists on the
   * registered block before surfacing the field (verify-describe-device
   * golden).
   *
   * Optional — devices without a curated summary omit the field; the
   * agent falls back to `list_params` for every block.
   */
  block_params_summary?: Readonly<Record<string, readonly string[]>>;

  /**
   * Optional pure-introspection method: return the subset of `block.type`
   * enum values that expose every listed param. Backs the
   * `find_compatible_types` MCP tool. Devices with structured
   * per-type applicability data implement this; devices without it omit
   * the method and the dispatcher falls back to returning the full type
   * list with `applicability_known: false`.
   */
  findCompatibleTypes?: (query: CompatibleTypesQuery) => CompatibleTypesResult;

  /**
   * Concrete, working `apply_preset` payload literal the agent can clone
   * verbatim. Surfaced via `describe_device.example_spec` so the LLM has
   * a starting payload (canonical block names, canonical enum values, the
   * device's slot shape, channel keys, scene structure) instead of
   * reconstructing one from prose rules.
   *
   * Every example MUST validate against `collectApplyPresetPreflight`
   * with zero errors on its own device; the `verify-describe-device.ts`
   * golden enforces this on every preflight run.
   *
   * The example covers at minimum: amp + drive + one time-based effect,
   * 2 scenes, channel-shape demonstration for devices with channels.
   * Devices without scenes/channels (Hydrasynth) omit those sections.
   */
  example_spec?: PresetSpec;
}

// ── find_compatible_types ───────────────────────────────────────────

export interface CompatibleTypesQuery {
  block: string;
  /** Param names that the chosen type must expose. AND-semantics: every param. */
  params: readonly string[];
}

export interface CompatibleTypesResult {
  block: string;
  params_queried: readonly string[];
  /**
   * Display names of types in the block's primary type enum that expose
   * every listed param. Empty array means no type satisfies all params
   * simultaneously — caller should narrow `params` or pick different knobs.
   */
  compatible_types: readonly string[];
  /**
   * Total count of types in the block's primary type enum. Useful for
   * "filtered N → K compatible" telemetry in the agent's response.
   */
  total_types: number;
  /**
   * False when the device has no structured applicability data for this
   * block (or for any of the listed params). In that case `compatible_types`
   * is the full enum list (passthrough, no filtering) — caller should
   * fall back to list_params + the free-form `applies_only_when` field.
   */
  applicability_known: boolean;
  /** Free-form explanation when filtering was partial or unknown. */
  note?: string;
}

// ── Error envelope ─────────────────────────────────────────────────

export type ErrorCode =
  | 'port_not_found'
  | 'capability_not_supported'
  | 'unknown_block'
  | 'unknown_param'
  | 'param_name_aliased'         // info-level; auto-resolved, surfaces in result
  | 'value_out_of_range'
  | 'unknown_enum_value'
  | 'ambiguous_enum_value'
  | 'bad_channel'
  | 'bad_location'
  | 'block_not_placed'           // soft-fail — write acked but block isn't in preset
  | 'no_ack'
  | 'stale_handle'
  | 'save_authorization_required' // gate refusal: apply-at-slot called without save_authorized=true
  | 'buffer_dirty';               // gate refusal: nav/save-at-slot while active buffer has unsaved edits

export interface DispatchErrorDetails {
  /** Single best near-match — printed inline ("did you mean X?"). */
  suggestion?: string;
  /** Small (≤8) valid options for inline listing. */
  valid_options?: readonly string[];
  /** Reference to a discovery tool when the valid set is too big to list. */
  valid_options_tool?: string;
  /** Recovery hint — what the LLM should try next. */
  retry_action?: string;
}

/**
 * The only error type the dispatcher throws. Centralized so every
 * device's errors share the same envelope and the LLM gets a stable
 * surface to recover from.
 */
export class DispatchError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly device: string,            // descriptor.display_name
    message: string,
    public readonly details?: DispatchErrorDetails,
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}
