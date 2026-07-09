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
/**
 * How hardware-verified a device's tool surface is. Surfaced once per
 * device via `describe_device.capabilities.support_tier` so the agent
 * can self-govern (read it once, calibrate caution) instead of every
 * tool response carrying a beta-prefix string.
 *
 *   - 'verified'       Wire shapes hardware-confirmed end-to-end by the
 *                      maintainer (AM4, Axe-Fx II XL+).
 *   - 'community-beta' Codec reused from a verified family with the
 *                      correct model byte + spec-documented envelopes,
 *                      but not yet confirmed on this exact device's
 *                      hardware (Axe-Fx III, FM3, FM9). Authoring works;
 *                      every write is a hypothesis pending owner
 *                      confirmation by ear / front panel.
 *   - 'generic-only'   Only generic-MIDI primitives are safe (PC / CC /
 *                      NRPN / tempo); no verified preset-authoring codec.
 *
 * Optional for back-compat: a missing tier reads as 'verified' (the
 * pre-existing implicit contract for AM4 / II / Hydrasynth).
 */
export type SupportTier = 'verified' | 'community-beta' | 'generic-only';

export interface DeviceCapabilities {
  slot_model: 'linear' | 'grid';
  /**
   * Hardware-verification tier for this device's tool surface. Read once
   * per device; calibrates how much the agent should ask the user to
   * confirm writes. Omit on fully-verified maintainer-owned devices
   * (reads as 'verified'); set 'community-beta' on family-codec-reuse
   * devices (III / FM3 / FM9). See `SupportTier`.
   */
  support_tier?: SupportTier;
  /**
   * One-line human note on what is hardware-confirmed vs spec-only for
   * this device. Surfaced alongside `support_tier`. Optional.
   */
  verification?: string;
  slot_count?: number;                          // linear: 4 for AM4
  grid?: { rows: number; cols: number };        // grid: 4×8 for Axe-Fx II
  has_scenes: boolean;
  scene_count?: number;
  has_channels: boolean;
  channel_names?: readonly string[];            // ['A','B','C','D'] or ['X','Y']
  channel_blocks?: readonly string[];           // which blocks expose channels
  /**
   * Whether named tempo divisions ("1/4", "1/2 DOT") are addressable over
   * the wire as display strings on tempo-sync params. Omitted = supported
   * (AM4 / Axe-Fx II). Set `false` on devices whose codec refuses to
   * fabricate a division wire value (the gen-3 family today): translate
   * strips division strings bound for such targets with a warning instead
   * of emitting a spec that fails or no-ops at apply.
   */
  named_tempo_divisions?: boolean;
  /**
   * Whether this device exposes MULTIPLE instances of the same block type
   * (e.g. Amp 1 + Amp 2, Reverb 1..4) addressable via the `instance` arg on
   * set_param / get_param / set_block / set_bypass (and per-slot `instance`
   * in apply_preset). Grid Fractal devices (Axe-Fx II / III / FM3 / FM9)
   * set this true; single-instance devices (AM4, Hydrasynth) omit it.
   *
   * The dispatcher GATES on this: when absent/false, any `instance > 1`
   * request is refused with `capability_not_supported` rather than silently
   * writing to instance 1. `instance` of 1 / undefined is always accepted,
   * so single-instance devices keep their pre-existing contract unchanged.
   */
  has_block_instances?: boolean;
  preset_location_format?: RegExp;
  /**
   * Whether flash persistence is hardware-VERIFIED, which gates AUTOMATIC
   * save during navigation (`save_active_first`). `false` does NOT mean the
   * explicit `save_preset` tool is unavailable; that is governed by
   * `writer.savePreset` presence (a device with an evidence-backed store
   * envelope saves, marked untested). When the two diverge, `save_note`
   * spells it out.
   */
  supports_save: boolean;
  /**
   * Clarifies what `supports_save: false` means for this device when the
   * explicit save_preset tool IS still wired. Agents should read this
   * before concluding a device "cannot save".
   */
  save_note?: string;
  supports_lineage: boolean;
  has_macros?: boolean;
  /**
   * Whether the device exposes an atomic-read primitive that lets
   * `get_preset` snapshot the active working buffer in a small,
   * bounded number of round-trips (rather than N×get_param).
   *
   * True on Axe-Fx II (fn 0x1F SYSEX_GET_ALL_PARAMS, Session 103 decode).
   * False / omitted on devices that fall back to per-param reads —
   * `get_preset` on those returns capability_not_supported.
   *
   * Agents should prefer `get_preset` for state-anchoring when this
   * flag is true; on false-flagged devices, the fallback is
   * `get_params` with a curated subset (block_params_summary).
   */
  atomic_read?: boolean;
  /**
   * Optional: device exposes a modulation matrix authorable by name via
   * set_mod_route. `mod_matrix_slots` is the route count (default 32).
   */
  has_mod_matrix?: boolean;
  mod_matrix_slots?: number;
  /**
   * Optional: device's performance macros have authorable destinations
   * (set_macro_route). `macro_count` is the number of macros (default 8),
   * `macro_dest_slots` the destinations per macro (default 8).
   */
  has_macro_routing?: boolean;
  macro_count?: number;
  macro_dest_slots?: number;
  /**
   * Sequencer-orchestrator axis (ORTHOGONAL to preset_class). When present
   * and non-empty, this device is a valid TARGET for `apply_pattern`: the
   * device-neutral pattern module (see `protocol-generic/patterns/`) can
   * realize a step grid onto it. The array lists the realization modes the
   * device supports, in PREFERENCE order (first = the default when the
   * caller doesn't pass `mode`):
   *   - 'live_stream'    Host streams clock-aligned notes in real time; the
   *                      device is a sound module. Works on any note-capable
   *                      device, zero device code. Ephemeral / audition-tier
   *                      (JS-timer jitter — not a performance tool).
   *   - 'record_capture' Host streams notes while the device's own sequencer
   *                      records them into a pattern that then loops on-device
   *                      (e.g. Circuit Tracks "record from external controller").
   *                      Two-phase: the user arms Record on the hardware first.
   *   - 'ncs_upload'     Author a named project offline and push it (Circuit
   *                      Tracks .ncs over SysEx). Phase C — not yet shippable;
   *                      no device lists it until the codec lands.
   * Absent/empty ⇒ not a pattern target; `apply_pattern` refuses with
   * capability_not_supported. Mirrors the optional-capability idiom
   * (`has_scenes`, `has_mod_matrix`).
   */
  pattern_realizers?: readonly RealizerMode[];
  /**
   * Abstract-voice → concrete trigger resolution for THIS device as a
   * pattern target. Keys are abstract voice names the neutral pattern uses
   * (`kick`/`snare`/`hat`/`bass`/`lead`/…); values are the `{channel, note}`
   * this device fires them on (Circuit drums: ch10 notes 60/62/64/65;
   * SPD-SX pads: ch10 from C4=60; a synth's `bass`: its melodic channel).
   *
   * This is what keeps device vocabulary OUT of the neutral pattern data:
   * the pattern says "kick", the target descriptor owns where "kick" goes.
   * Required to be a pattern target; absent ⇒ only patterns that carry
   * their own `voice_hints` can realize, and unmapped voices error rather
   * than silently drop.
   */
  voice_map?: Readonly<Record<string, VoiceTarget>>;
  /**
   * Devices that SEQUENCE EXTERNAL gear over MIDI declare their outward
   * note-track channels here: track name → the MIDI channel that track transmits
   * on. The Circuit Tracks has two such tracks (`{ midi1: 3, midi2: 4 }`). This
   * is what `apply_pattern`'s `external_targets` uses to route a groove resolved
   * against ANOTHER device's `voice_map` (e.g. an SPD-SX) onto one of these
   * tracks — so the Circuit's MIDI 2 track drives the SPD-SX's pads. The external
   * device must be set to receive on the same channel. Absent on devices with no
   * outward MIDI sequencer tracks.
   */
  external_tracks?: Readonly<Record<string, number>>;
}

// ── Pattern / sequencer-orchestrator surface ───────────────────────
//
// The device-neutral pattern module (`protocol-generic/patterns/`) owns
// the grammar (grid, mini-notation, Euclid) and the named library. These
// types are the THIN contract between that module and a device: the
// capability flag (`pattern_realizers`), the voice→trigger map
// (`voice_map`), and the fully-compiled, device-agnostic plan a realizer
// consumes. Defined here (not in patterns/) so `DeviceWriter` can
// reference them without a core→patterns import cycle.

/** Realization mode for `apply_pattern`. See `DeviceCapabilities.pattern_realizers`. */
export type RealizerMode = 'live_stream' | 'record_capture' | 'ncs_upload';

/** Where an abstract voice fires on a specific target device. */
export interface VoiceTarget {
  /** MIDI channel 1..16 (musician convention; converted to 0..15 at the wire). */
  channel: number;
  /** MIDI note number 0..127 that triggers this voice on the target. */
  note: number;
}

/**
 * One fully-resolved note in a realize plan. The dispatcher compiles a
 * NeutralPattern through the target's `voice_map` into these BEFORE a
 * realizer runs, so realizers handle MIDI, never the pattern grammar.
 * Same field shape as the existing `send_sequence` event, plus an
 * explicit per-event `channel` (a pattern can drive several channels at
 * once — Circuit drums on ch10 + a synth voice on ch1).
 */
export interface RealizeNoteEvent {
  channel: number;       // 1..16
  note: number;          // 0..127
  velocity: number;      // 1..127
  time_ms: number;       // offset from cycle start
  duration_ms: number;
  /**
   * Micro-step roll: 1..6 sub-hits within this step (drum hits only; absent/1
   * = a single plain hit). The NCS author writes it as the Circuit's 6-bit
   * micro-hit mask; live realizers expand it into that many rapid retriggers.
   * Carried through from `Step.roll`.
   */
  micro_hits?: number;
  /**
   * Micro-tick PLACEMENT: this onset's position within its step, 1..5 (absent
   * = on-grid, tick 0). `time_ms` already includes the offset (step + micro/6),
   * so live realizers play true micro-timing with no extra handling; the .ncs
   * author writes this field directly as the note slot's delay byte. One event
   * per onset — a step with `Step.micro = [0, 3]` compiles to two events.
   * Carried through from `Step.micro`. B0-hardware-confirmed on the wire
   * (2026-07-02): the Circuit MIDI-OUT transmits the delay as real timing.
   */
  micro?: number;
}

/** One named section of a song arrangement: a compiled plan + its name. */
export interface ArrangementSectionPlan {
  name: string;
  plan: RealizePlan;
}

/**
 * Device-agnostic, fully-compiled input to a realizer. Produced by the
 * pattern module's `compileToPlan`; consumed by the realizers in
 * `patterns/realizers/` and by the optional `DeviceWriter.realizePattern`
 * override hook.
 */
export interface RealizePlan {
  pattern_name: string;
  bpm: number;
  steps: number;
  bars: number;
  repeat: number;
  mode: RealizerMode;
  /** Compiled, voice_map-resolved events for ONE cycle (the `bars`-long loop). */
  events: readonly RealizeNoteEvent[];
  /** Length of one cycle in ms (the loop period; total play = cycle_ms × repeat). */
  cycle_ms: number;
  /**
   * record_capture two-phase signal: false/undefined on the first call
   * (the realizer returns an "arm Record on the device" instruction and
   * sends nothing); true once the user has armed the hardware (the
   * realizer streams the events for the device to capture).
   */
  armed?: boolean;
  /**
   * ncs_upload only: the bespoke inputs for authoring a project file and
   * pushing it to a stored slot. `template_path` is an existing project to
   * modify (template-modify, since we don't author a project from scratch);
   * `slot` is the 0-based project slot to write. `scale` optionally names the
   * musical scale the target device should constrain the pattern to (device-
   * specific; the Circuit defaults to Chromatic so authored pitches are
   * literal). Ignored by other realizers.
   *
   * `drum_flips` authors per-step SAMPLE FLIPS (Circuit Tracks): a map of drum
   * track name ("drum1".."drum4") to { 1-based step number → absolute sample
   * slot 0..63 }. The flipped step plays that sample instead of the track's
   * default, so several drum pieces (kick + snare + …) can live on one track.
   *
   * `drum_binding` sets which pool slot each drum track plays (Circuit Tracks):
   * a 4-element array of 0-based sample slots for Drum 1..4. Authoring writes it
   * into the project so the groove loads TURNKEY (no on-device hand-assignment).
   * Defaults to the canonical stoken role layout [0,1,2,3] = kick / snare /
   * closed_hat / ride when drum tracks are authored. See
   * docs/design/groove-instrument-mapping.md.
   */
  upload?: {
    template_path?: string;
    slot: number;
    scale?: string;
    drum_flips?: Record<string, Record<string, number>>;
    drum_binding?: number[];
    /**
     * Safe-edit overwrite gate (cf. `docs/SAFE-EDIT-WORKFLOW.md`): authored
     * `ncs_upload` writes a stored project slot, so it honors the same gate as
     * `upload_project` — it refuses to clobber an occupied slot unless the user
     * authorized the overwrite. An empty target slot is written without it.
     */
    confirm_overwrite?: boolean;
    /**
     * Pre-flight only: author + fit-check + report, but send NOTHING to the
     * device (no reads, no gate, no transfer). The realizer returns status
     * 'dry_run' with the full receipt so the agent can surface piece
     * compression / layout before committing.
     */
    dry_run?: boolean;
  };
}

/**
 * Realizer outcome. `source` carries the project's read-honesty: most
 * sequencer targets give NO readback, so a realize is reported as what we
 * actually know — `played` (we streamed it), `streamed_unverified` (we
 * streamed for the device to capture, can't confirm it landed) — never a
 * fabricated success.
 */
export interface RealizeResult {
  ok: boolean;
  mode: RealizerMode;
  /** 'played' | 'awaiting_arm' | 'streamed_unverified' | 'uploaded'. */
  status: string;
  notes_sent?: number;
  source?: 'played' | 'streamed_unverified' | 'device_confirmed';
  warning?: string;
  info?: string;
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
   * The `enum_values` table is PARTIAL (not exhaustive): it labels the wire
   * ordinals captured so far, but other valid ordinals exist that simply
   * aren't named yet. When true, a NUMERIC value outside `enum_values` is NOT
   * rejected as "out of range" — it passes through as a raw wire ordinal
   * (decode falls back to the number). Used by per-device read-leg overrides
   * (e.g. the FM9 amp roster, where only a few of ~150 models are captured).
   * Absent/false ⇒ the table is treated as complete and an unknown numeric
   * ordinal is a validation error.
   */
  enum_partial?: boolean;
  /**
   * gen-3 (modern Fractal) only: which SET wire form the param uses. The value
   * always rides as a 5-septet float32 at payload pos 12, but the sub-action
   * and value semantics differ:
   *   - `'discrete'` (type/model selectors): sub `09 00`, value = `float32(ordinal)`
   *     where `encode` returns the read-roster ordinal. Set-by-name resolves
   *     straight off the read vocabulary (the ordinal IS the set value).
   *   - `'continuous'` (knobs): sub `52 00`, value = `float32(normalized 0..1)`
   *     where the writer normalizes `encode`'s 0..65534 wire by /65534.
   * Absent on AM4 / Axe-Fx II / Hydra (they have their own SET wire).
   */
  wire_kind?: 'discrete' | 'continuous';
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
  /**
   * Live MIDI handle, scoped to this device's connection label. For
   * storage-transport devices (no MIDI pipe) this is a null-object
   * `MidiConnection` that throws on any I/O — those devices' reader/writer
   * methods use `storage` instead and never touch `conn`. Kept required so
   * the ~156 existing `ctx.conn` call sites in MIDI devices are unchanged.
   */
  conn: MidiConnection;
  /**
   * Mounted-volume root for storage-transport devices (e.g. the SPD-SX
   * `Roland/SPD-SX` folder in WAVE MGR mode). Present only when the
   * descriptor's `transport.kind` resolved to storage at `openCtx` time
   * (`'storage'`, or `'hybrid'` with a drive mounted). Absent on MIDI/serial
   * transports. See `DeviceTransport` and `docs/ARCHITECTURE.md` §"Transport
   * abstraction".
   */
  storage?: { root: string };
  /** The descriptor the dispatcher resolved. */
  descriptor: DeviceDescriptor;
  /**
   * Force-reconnect this device's handle and return the FRESH one. Lets a
   * multi-frame transfer (Circuit `.ncs` / sample upload, download) recover
   * from a stale/poisoned handle by reconnecting + retrying ONCE, instead of
   * refusing and making the user run reconnect_midi by hand. Set by `openCtx`.
   */
  reconnect?: () => MidiConnection;
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

/**
 * Save receipt. After a save_preset persists, the writer reads back the
 * persisted working buffer with TARGETED deterministic reads (block-slot
 * reads + amp/drive type-param reads + preset-name read) and returns this
 * so the agent — and the user — can confirm WHAT landed, not just THAT a
 * save acked. The fn-0x1F bulk dump is non-deterministic and its
 * chunk-to-paramId map is undecoded, so it is deliberately NOT used here.
 *
 * Every field except `block_chain` is best-effort: a failed targeted read
 * omits its field (and the writer notes the omission in `info`) rather
 * than failing the save, which already landed. AM4 populates this first;
 * Axe-Fx II / Hydrasynth adopt later (cross-device-ready, not
 * cross-device-yet).
 */
export interface SavedSnapshot {
  /** The 4 signal-chain slot block types, slot 1 to 4. 'none' for empty slots. */
  block_chain: readonly string[];
  /** Amp model display name (e.g. "Brit 800"). Omitted if no amp placed / the read failed. */
  amp_model?: string;
  /** Drive model display name (e.g. "T808 OD"). Omitted if no drive placed / the read failed. */
  drive_model?: string;
  /** Persisted preset name at the target location. Omitted if the read failed or the location is empty. */
  preset_name?: string;
}

/**
 * Non-destructive overwrite pre-check for save_preset, returned by
 * `DeviceReader.checkOverwriteTarget`. The dispatcher uses this to run the
 * confirmable overwrite gate uniformly across every device that can read a
 * stored location's name + the active location.
 */
export interface OverwriteTargetInfo {
  /** Canonical display form of the target location (e.g. "A1"), for messages. */
  target_display: string;
  /** The occupying preset's display name when the target is non-empty;
   *  undefined when the target slot is empty. */
  occupant_name?: string;
  /** True when the target IS the currently-active/edited location — saving
   *  there is a refresh, not a clobber, so the gate stays silent. */
  is_active_location: boolean;
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
  /**
   * Set when `acked` is false ONLY because the write was sent and not
   * rejected, but the device returned no confirming echo within the ack
   * window (a "sent, unconfirmed" outcome — distinct from a real 0x64
   * rejection or an error). Currently produced by the gen-3 (Axe-Fx III /
   * FM3 / FM9 / VP4) per-param SET path, whose typed-SET echo is hardware-
   * confirmed only for enum/type params. Aggregators (apply_preset) MUST NOT
   * count an `unconfirmed` write as a failure: the preset may have applied
   * fine; we just could not verify it. Surface it as "verify on the device",
   * not "failed".
   */
  unconfirmed?: boolean;
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
  /**
   * BK-075: structured pre-flight warnings (e.g. phantom-param trap
   * where the block isn't placed in the active working buffer). Same
   * shape as `ApplyResult.validation_info[]` so the agent reads
   * `level: 'warning'` + `dropped_param` + `reason` + `retry_action`
   * identically across set_param and apply_preset.
   *
   * Absent on the happy path so the response stays unchanged when no
   * warnings fired.
   */
  validation_info?: readonly ValidationInfo[];
  /**
   * save_preset receipt — what the device holds at the target after the
   * save persisted. Populated by AM4 save_preset only; absent on every
   * other op and device. See SavedSnapshot.
   */
  saved_snapshot?: SavedSnapshot;
}

export interface BatchWriteResult {
  writes: readonly WriteResult[];
  acked_count: number;
  unacked_count: number;
  /**
   * Batch-level structured pre-flight warnings — same shape as
   * `WriteResult.validation_info[]`. Populated when a cross-param trap
   * spans multiple writes in the batch (e.g. the tempo-lock co-write:
   * setting a tempo division AND an absolute time/rate for the same
   * block in one call, where the device silently ignores the absolute
   * write). Absent on the happy path.
   */
  validation_info?: readonly ValidationInfo[];
}

export interface BlockChange {
  block_type?: string;          // canonical block name, e.g. "amp", or "none" to clear
  bypassed?: boolean;
  channel?: string | number;    // 'A'..'D' / 'X'..'Y' / 0..3
  /**
   * 1-indexed block instance for grid devices that expose multiple blocks
   * of the same type (e.g. instance=2 places/clears "Amp 2"). Defaults to 1.
   * Devices without `capabilities.has_block_instances` reject anything > 1
   * at the dispatcher gate; single-instance placements stay byte-identical.
   */
  instance?: number;
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
  /**
   * Block params.
   *
   * SCHEMA boundary (apply_preset tool input): callers pass either
   *   - `params: { rate: 0.8 }` — flat record, for non-channel blocks
   *     or active-channel-only writes on channel blocks
   *   - `params_by_channel: { A: { gain: 6 } }` — nested per-channel,
   *     for multi-channel authoring on channel blocks
   * The schema (presetSlotShape) rejects nested values inside `params`
   * and rejects setting both fields on the same slot (T-5, 2026-05-21).
   *
   * INTERNAL shape (after preflight normalization): the preflight
   * merges `params_by_channel` into `params`, so downstream dispatcher
   * walkers see a single polymorphic `params` field accepting either
   * shape. This is why the internal type stays permissive — only the
   * schema layer enforces the split. Downstream consumers continue to
   * branch on shape via the existing `classifyParamsShape` helper.
   */
  params?:
    | Readonly<Record<string, number | string>>
    | Readonly<Record<string, Readonly<Record<string, number | string>>>>;
  /**
   * SCHEMA-ONLY field: when authoring an apply_preset call, pass per-
   * channel param maps here instead of nesting them in `params`. The
   * preflight folds this into the internal `params` shape before any
   * walker sees the spec; downstream descriptor writers continue to
   * receive the nested shape via `params`.
   */
  params_by_channel?: Readonly<Record<string, Readonly<Record<string, number | string>>>>;
  bypassed?: boolean;
  /**
   * v0.4: stable identifier for this block within the preset. Used by
   * `routing` edges and `scenes[].channels` / `scenes[].bypassed` to
   * reference this specific block when multiple instances of the same
   * type exist (e.g. `id: "rhythm_amp"` vs `id: "lead_amp"`).
   *
   * When omitted, the descriptor auto-derives the canonical id as:
   *   - `<block_type>` when `instance` is 1 or omitted (the default —
   *     most presets have exactly one of each block, so the bare type
   *     reads naturally).
   *   - `<block_type>_<instance>` when `instance >= 2` (`amp_2`,
   *     `drive_3`).
   *
   * For back-compat with agents authoring multi-amp presets the scene/
   * routing resolver also accepts the `<block_type>_1` form for the
   * first instance — i.e. `amp_1` matches the same slot as bare `amp`.
   * Explicit ids on multi-instance slots are still recommended (clearer
   * in routing edges and scene maps).
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
  /**
   * 2026-05-23: aggregate of every mid-sequence wire NACK during the
   * apply (cable failures, grid-cell rejections, save failures).
   * Pre-fix the writer only retained the LAST NACK in failed_step,
   * silently overwriting earlier rejections — leading to the
   * chain_integrity false-positive vector where the agent saw a
   * single failed cable in failed_step but didn't realize multiple
   * cables NACKed mid-sequence. Empty when all ops acked OK.
   *
   * `ok` is false when this array is non-empty (mid-sequence cable
   * NACK), even for working-buffer-only applies. The agent should
   * surface ALL nacked_steps to the user, not just the first.
   */
  nacked_steps?: readonly {
    index: number;
    description: string;
    error: string;
    kind: string;
  }[];
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
  /**
   * 2026-05-22 MCP migration: the fully materialized + alias-resolved
   * PresetSpec the writer consumed (or would have consumed on a
   * validation_errors[] path). Always populated when the dispatcher
   * reached the writer; lets the agent confirm what landed without
   * a follow-up get_preset round-trip. Most useful when the call
   * used `recipe_id` + `overrides` — the agent sees the merged
   * result directly in the response.
   */
  applied_spec?: PresetSpec;
  /**
   * 2026-05-22 MCP migration: echoed when the apply was driven by
   * `recipe_id`. Lets downstream consumers (telemetry, audit logs)
   * attribute behavior to the recipe id without re-parsing the
   * applied_spec.
   */
  recipe_id?: string;
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
  /**
   * Informational notes that don't fail the audibility check but
   * carry context the agent should mention to the user. Today this
   * surfaces FX Loop blocks engaged on the active path (audibility
   * depends on external send/return cabling we can't see from MIDI).
   * Omitted when empty.
   */
  notes?: ReadonlyArray<{ slot_ref: SlotRef; note: string }>;
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
  /**
   * BK-071: severity hint for the agent. Defaults to 'info' when omitted
   * (alias/case-tolerance resolutions). 'warning' means the dispatcher
   * accepted the write but the agent should reconsider — e.g. a knob
   * the picked type doesn't expose, which silently no-ops on the wire.
   */
  level?: 'info' | 'warning';
  /**
   * BK-071: name of the param that the picked type doesn't expose. The
   * write proceeded but the device will silently no-op this knob.
   * Pairs with `reason` + `retry_action` so the agent can self-correct
   * on the next turn instead of reporting false success.
   */
  dropped_param?: string;
  /**
   * BK-071: one-line explanation of why the param dropped (e.g.
   * "Hall variants are fixed-decay on AM4; reverb.time is not
   * exposed for this type"). Distinct from `info` which is the
   * full agent-facing message.
   */
  reason?: string;
  /**
   * BK-071: concrete next-call the agent should issue to recover —
   * e.g. `find_compatible_types({block:"reverb", params:["time"]})`.
   * The agent reads this verbatim and re-issues.
   */
  retry_action?: string;
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

/**
 * Read-side counterpart to `PresetSpec`. Carries the same structural
 * shape (slots, scenes, name) plus snapshot metadata that doesn't
 * belong on the write-side input.
 *
 * Distinct type so callers can statically tell "this is a snapshot,
 * not a build spec" and not accidentally feed the whole thing into
 * `apply_preset` (which would clear unlisted scenes / routing per its
 * FRESH-BUILD semantics).
 *
 * Field parallels with `PresetSpec`:
 *   - `slots[]`, `scenes?[]`, `name?`: same shape, same semantics.
 *   - `slots[i].channel_status`: NEW. Per-slot marker indicating which
 *     channel the snapshot reflects. `'active'` = the device's active
 *     channel, params nested under that channel key. `'all_channels'`
 *     = all channels decomposed (v2 scope). `'unknown'` = channel read
 *     failed, params returned flat as fallback.
 *   - `active_scene?`: NEW. 1-indexed scene the device is currently
 *     showing, when the device has scenes. Undefined on devices
 *     without scenes (Hydrasynth).
 *   - `_meta`: NEW. Snapshot envelope (device label, snapshot time,
 *     partial-info flags). Distinct from the spec shape so a copy
 *     of `slots`/`scenes`/`name` is feedable into `apply_preset` after
 *     dropping `_meta`/`active_scene`/`channel_status`.
 */
export interface PresetSnapshot {
  name?: string;
  slots: readonly PresetSnapshotSlot[];
  scenes?: readonly SceneSpec[];
  active_scene?: number;
  routing?: readonly RoutingEdge[];
  /**
   * Audibility / chain-integrity check over the snapshot's grid +
   * bypass state. Same shape as `ApplyResult.chain_integrity` so
   * agents handle both surfaces uniformly. Present on grid devices
   * (Axe-Fx II) that read the routing grid as part of get_preset;
   * absent on devices without grid semantics. The reader does not
   * pay extra round-trips for this — bypass state + bypass_mode
   * come from the same per-block param dump already used to fill
   * `slots[].params`.
   */
  chain_integrity?: ChainIntegrityResult;
  /**
   * Per-slot diagnostic strings collected while reading. Used to surface
   * partial-read failures that the snapshot couldn't fully reflect, e.g.
   * a channel-state register read that returned an unparseable wire
   * value (which leaves `channel_status: 'unknown'` with no indication
   * of WHY). Absent when every slot read cleanly.
   */
  read_warnings?: readonly string[];
  /**
   * gen-3 only: the full decoded patch when `get_preset` read a whole dump
   * (stored-by-location, or the active buffer when its dump validated). Carries
   * the routing grid, per-channel block types, scene names + per-scene bypass/
   * channel, amp model + knobs, modifiers, and scene controllers — everything
   * the II/AM4 `slots` envelope can't represent. Absent on II/AM4/Hydra and on
   * gen-3 active-buffer reads that fell back to the fn=0x1F poll inventory.
   */
  whole_preset?: Gen3WholePresetView;
  /**
   * gen-3 only: the LIVE routing grid of the ACTIVE preset, read in one
   * round-trip via `fn=0x01 sub=0x2E` (empty-target query). Each cell carries
   * its position (row/col), the placed block's effect id + display name, the
   * raw input-cable bitmask (`route_flag`), and `is_shunt`. This is the live
   * counterpart to `whole_preset.grid` (which only comes from a stored/dumped
   * preset) — it tells an agent the actual signal-chain layout of the buffer
   * being edited, which the fn=0x1F poll inventory (`slots`) cannot.
   *
   * Block POSITIONS + IDENTITIES are cross-validated against our FM9 capture
   * (every effect id resolves; Input→…→Output coherent). The cable bitmask is
   * surfaced raw; edge-direction decode is community-beta and NOT asserted as
   * `from_rows` here. Present only when the live grid read succeeded; absent on
   * II/AM4/Hydra, on stored-by-location gen-3 reads (use `whole_preset.grid`),
   * and when the grid read returned nothing (then `slots` is the poll inventory).
   */
  live_grid?: readonly Gen3GridCellView[];
  /**
   * gen-3 only: live DSP/CPU + stereo-output meters, decoded from the SAME
   * `fn=0x01 sub=0x2E` frame the `live_grid` is read from (zero extra wire
   * round-trips). `cpu_percent` is the steady DSP cost of the active preset
   * (the most useful field for a one-shot read — it answers "how much headroom
   * does this patch leave"); the output meters are momentary peaks at read time.
   * FM9-cross-validated, community beta. Present only on a gen-3 active-buffer
   * read where the sub=0x2E frame arrived; absent on II/AM4/Hydra and on
   * stored-by-location reads. The device's INPUT meter is intentionally not
   * surfaced — its offset is FM3-frame-specific and not portable across the
   * gen-3 family (see fractal-midi `liveMeters.ts`).
   */
  live_meters?: Gen3LiveMeters;
  _meta: PresetSnapshotMeta;
}

/** gen-3 live telemetry (CPU + stereo output meters) from a sub=0x2E read. */
export interface Gen3LiveMeters {
  /** DSP/CPU utilization, percent (32.0..95.5). Steady for a given preset. */
  cpu_percent: number;
  /** Output meter, LEFT channel, normalized 0..1 (momentary). */
  output_left: number;
  /** Output meter, RIGHT channel, normalized 0..1 (momentary). */
  output_right: number;
}

export interface PresetSnapshotSlot extends PresetSlotSpec {
  /**
   * Which channel the params dict reflects on a channel-bearing block.
   * `'active'`: params nested under the device's active channel key
   * (default — round-trippable through apply_preset on that channel).
   * `'all_channels'`: every channel decomposed under its key (v2
   * scope; not yet emitted by any device).
   * `'unknown'`: channel read failed; params returned flat. Agent
   * should not feed this slot back into apply_preset without
   * resolving the channel first (call set_param with explicit
   * channel and re-call get_preset).
   * Omitted on non-channel blocks where the distinction doesn't
   * apply (flat params are always correct).
   */
  channel_status?: 'active' | 'all_channels' | 'unknown';
}

export interface PresetSnapshotMeta {
  /** Device the snapshot was read from (matches descriptor.display_name). */
  device: string;
  /** Server-side timestamp of the read, milliseconds since epoch. */
  read_at_ms: number;
  /** True when the snapshot reflects only the active scene (v1 scope). */
  active_scene_only: boolean;
  /** True when routing edges were not included in the snapshot. */
  routing_omitted: boolean;
  /**
   * True when channel-bearing-block channel-id reads were skipped to
   * save wire round-trips (T-3 Phase A default). When true, every
   * channel-bearing slot in `slots[]` returns flat params with
   * `channel_status: 'unknown'`; callers wanting round-trippable
   * snapshots must pass `include_channel_state: true` to `get_preset`.
   */
  channel_state_omitted?: boolean;
  /** When true, both X and Y channel params were read for channel-bearing blocks. */
  both_channels_read?: boolean;
  /**
   * Server-measured wall-clock of the SysEx read loop, in milliseconds.
   * Client-independent (the agent's own JSON-handling time does NOT count),
   * so it is the trustworthy figure for "how slow is this read" — unlike a
   * client-side timer, which is swamped by model token-generation latency on
   * large payloads (alpha.17 finding). Populated by readers that time the
   * loop; absent on readers that don't.
   */
  read_duration_ms?: number;
  /**
   * Present ONLY when channel state was omitted on a channel-bearing device
   * (the fast default). A short, actionable nudge telling the caller how to
   * get the full per-channel snapshot, surfaced in the response itself so the
   * agent doesn't have to already know the `include_channel_state` option
   * exists (alpha.17: an agent proposed adding a flag that already shipped).
   */
  channel_state_hint?: string;
  /**
   * Present ONLY when one or more placed blocks failed to read (timeout /
   * parse error) and were OMITTED from `slots[]`. One entry per failed
   * block ("<block> @ row R col C: <error>"). Without this, a partial
   * snapshot is indistinguishable from a complete one and an agent will
   * state-anchor on a preset that has more blocks than it can see
   * (0.3.0 final-signoff finding).
   */
  blocks_failed?: string[];
  /**
   * The stored preset LOCATION the working buffer's pointer is at
   * (e.g. "A01".."Z04"), when the device exposes an active-location
   * register. Lets an agent plan navigation and dirty-buffer gating
   * without a separate read. Absent when the read failed or the device
   * doesn't model an active-location pointer. NOTE: the buffer may have
   * diverged from what is STORED at this location — see `is_dirty`
   * (GAP-1, 2026-07-04 AM4 session).
   */
  current_location?: string;
  /**
   * True when the working buffer has unsaved edits relative to the last
   * loaded/saved state, per the server's dirty tracker. False when known
   * clean; absent when the device provides no dirty signal. On the AM4
   * this reflects the in-memory edit tracker (the device emits no dirty
   * push), so it is authoritative for edits made THROUGH this server but
   * cannot see front-panel edits.
   */
  is_dirty?: boolean;
}

/**
 * Per-call options for `reader.getPreset`. Drives latency / completeness
 * trade-offs without changing the response envelope.
 */
export interface GetPresetOptions {
  /**
   * When true, run the per-block channel-id read (fn 0x11 on Axe-Fx II)
   * so each channel-bearing slot's params nest under the active channel
   * key. Costs one extra SysEx round-trip per channel-bearing block (≈
   * 50 ms each; an 11-block preset with 9 channel-bearing blocks adds
   * ≈ 450 ms to the snapshot wall time). Default false (omit) for the
   * common case where the caller is inspecting state, not authoring a
   * round-trip mutate-and-reapply flow.
   */
  include_channel_state?: boolean;
  /**
   * gen-3 only (Axe-Fx III / FM3 / FM9): read a STORED preset by integer
   * preset number instead of the active working buffer. The device dumps
   * that stored slot (fn=0x03, the same path `export_preset(location)`
   * uses), and the reader decodes the whole patch body — routing grid,
   * per-channel (A/B/C/D) block types, scene names + per-scene bypass/
   * channel state, amp model + knobs, modifier routing, scene controllers
   * — into `PresetSnapshot.whole_preset`. Omit to read the active buffer.
   */
  location?: string | number;
}

// ── gen-3 whole-preset detail (PresetSnapshot.whole_preset) ───────────
// Structured decode of a gen-3 preset's decompressed patch body. Carried
// verbatim on PresetSnapshot.whole_preset for Axe-Fx III / FM3 / FM9 when a
// full dump was decoded (stored-by-location, or the active buffer when its
// dump validated). Far richer than the II/AM4 `slots` envelope, so it lives
// in its own field rather than being squeezed into PresetSlotSpec.

/** One placed cell in the routing grid (column-major). */
export interface Gen3GridCellView {
  effect_id: number;
  row: number;
  col: number;
  route_flag: number;
  name: string;
  /** Grid rows this cell's input arrives from (route_flag bitmask). */
  from_rows?: readonly number[];
  /** True for routing shunt/merge nodes (no effect). */
  is_shunt?: boolean;
}

/** Per-channel (A/B/C/D) state of a placed block: effect type + (amp) knobs. */
export interface Gen3BlockChannelView {
  type_id?: number;
  type?: string;
  [knob: string]: number | string | undefined;
}

/** One placed block in the signal chain with its per-channel + scene state. */
export interface Gen3BlockView {
  block: string;
  cols: number;
  rows: number;
  /** Per-scene (8) active channel letter. */
  scene_channels?: readonly string[];
  /** Per-scene (8) bypass state. */
  scene_bypass?: readonly boolean[];
  type_id?: number;
  type?: string;
  bank1?: string;
  cab1?: number;
  bank2?: string;
  cab2?: number;
  channels?: Readonly<Record<string, Gen3BlockChannelView>>;
}

export interface Gen3ModifierView {
  source: string;
  target: string;
  param: number;
  origin: 'pre-chain' | 'chain';
}

export interface Gen3SceneControllerView {
  controller: string;
  /** Per-scene (8) value, 0..100 %. */
  values: readonly number[];
  raw: readonly number[];
}

/** The full decoded gen-3 preset, carried on PresetSnapshot.whole_preset. */
export interface Gen3WholePresetView {
  /** Where the dump came from: a stored slot, or the live edit buffer. */
  source: 'stored-dump' | 'edit-buffer';
  model: string;
  model_id: number;
  /** Preset name from the raw-patch header. */
  preset_name: string;
  /** True when the patch CRC validated (the device's own validity gate). */
  crc_valid: boolean;
  scene_names?: readonly string[];
  grid?: readonly Gen3GridCellView[];
  blocks?: readonly Gen3BlockView[];
  /** Convenience: the first Amp block's per-channel map. */
  amp?: Readonly<Record<string, Gen3BlockChannelView>>;
  modifiers?: readonly Gen3ModifierView[];
  scene_controllers?: readonly Gen3SceneControllerView[];
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

export interface ParamQuery {
  block: string;
  name: string;
  channel?: string | number;
  /** 1-indexed block instance for grid devices with multiple blocks of
   *  the same type (e.g. instance 2 targets Amp 2). Default 1. */
  instance?: number;
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

/**
 * BK-075 cross-device block-placement snapshot. Lightweight read-side
 * envelope describing which block types occupy the active working
 * buffer. The dispatcher's phantom-param pre-flight calls
 * `placedBlocks.has(block)` directly — no method on the interface,
 * keeps each device's reader free to populate `placedBlocks` from
 * whatever its native layout primitive returns (AM4 4-slot register
 * read, II grid query, etc.) and decorate the envelope with device-
 * specific extras.
 *
 * Devices without a placement model (Hydrasynth — single-patch, no
 * block-slot concept) omit `getBlockLayoutSnapshot` on their reader;
 * the dispatcher skips the pre-flight check gracefully.
 */
export interface BlockLayoutSnapshot {
  /**
   * Unique canonical block-type names placed somewhere in the active
   * working buffer. Empty slots / cells / 'none' values are excluded.
   * The phantom-param pre-flight tests membership with `.has(block)`.
   */
  placedBlocks: ReadonlySet<string>;
  /**
   * BK-076: block-type names whose every placed cell has routing_mask=0
   * past col 1 (no input cable feeding the cell). The block IS placed
   * — it appears in `placedBlocks` — but no signal flows through it,
   * so a `set_param` write acks on the wire while the audible state
   * stays put. Mutually exclusive with phantom-param: a block here is
   * always present in `placedBlocks`.
   *
   * Optional. Devices without a routing model (AM4 linear chain;
   * Hydra no grid) leave this undefined and the dispatcher skips the
   * routing-mask pre-flight gracefully.
   */
  unroutedBlocks?: ReadonlySet<string>;
}

/**
 * Raw, byte-exact dump of a device's ACTIVE working-buffer preset in its
 * native SysEx wire form (concatenated F0..F7 frames). This is a
 * backup / transport primitive, NOT a decoded snapshot: the bytes are not
 * interpreted, they are exactly what the device emitted and what it will
 * accept back. Suitable for writing verbatim to a `.syx` file the user can
 * keep, share, or reload with the manufacturer's editor.
 *
 * Distinct from `PresetSnapshot` (which `getPreset` returns): a snapshot is
 * a structured, display-shaped view for the agent to reason about; a
 * `PresetBinaryDump` is opaque bytes for storage. Neither substitutes for
 * the other.
 */
export interface PresetBinaryDump {
  /** The device's native dump frames concatenated (each is a full F0..F7 SysEx message). */
  bytes: Uint8Array;
  /** Byte length of `bytes` (== bytes.length; echoed for response convenience). */
  byte_length: number;
  /** Number of SysEx frames concatenated in `bytes` (e.g. 66 on Axe-Fx II, 6 on AM4). */
  frame_count: number;
  /**
   * Wire-shape identifier so a future restore path can validate the bytes
   * before pushing. e.g. `'axe-fx-ii-patch-dump'`, `'am4-preset-dump'`.
   */
  format: string;
  /** Preset name read from the device when cheaply available; best-effort, may be absent. */
  name?: string;
  /** Human-readable note on what was dumped (e.g. 'active working buffer'). */
  source?: string;
  /**
   * File extension (no dot) the backup should be written with, e.g. `'syx'`
   * for Fractal dumps, `'ncs'` for a Circuit Tracks project. Absent ⇒ the
   * tool layer defaults to `'syx'` (the Fractal convention). Lets a device
   * whose native file is not a `.syx` declare its own container without the
   * export tool special-casing per device.
   */
  file_extension?: string;
  /**
   * True when the requested stored location holds NOTHING (an empty slot),
   * so `bytes` is empty and there is nothing to back up. A clean, expected
   * answer for a read-before-write probe — NOT an error. The export tool
   * reports it without writing a file; backup-before-overwrite skips it.
   * Only devices whose stored slots can be empty (Circuit Tracks projects)
   * ever set it; Fractal stored-location dumps never do.
   */
  empty?: boolean;
  /**
   * Surfaced caveat the caller MUST relay to the user (e.g. the Axe-Fx II
   * has no edit-buffer dump request, so its "active" export is the stored
   * flash copy of the active slot). Absent when the dump is unambiguous.
   */
  warning?: string;
}

/**
 * Result of pushing a byte-exact preset dump back to a device (the restore
 * counterpart of `PresetBinaryDump`). Backs the `import_preset` tool.
 */
export interface RestorePresetResult {
  /** True when every frame acked and (if requested) the save committed. */
  ok: boolean;
  /** Number of SysEx frames sent to the device. */
  frames_sent: number;
  /** Number of ack/response frames received. */
  acks_received: number;
  /** Per-frame NACKs (device rejected the frame). Empty on success. */
  nacks: readonly { frame_index: number; detail?: string }[];
  /** Preset name decoded from the pushed bytes, when available. */
  name?: string;
  /** Set when the bytes were persisted to a stored location (save path). Absent for working-buffer-only push. */
  saved_to_location?: string | number;
  /** Wire-shape identifier (matches `PresetBinaryDump.format`). */
  format: string;
}

/** One entry in a device's named sample/sound directory. */
export interface SampleDirectoryEntry {
  /** 0-based wire slot. */
  slot: number;
  /** 1-based slot number as the device/editor displays it. */
  device_slot: number;
  /** Stored name, or undefined when the slot is empty. */
  name?: string;
}

/**
 * A read of a device's named sample pool (Circuit Tracks: the pack's shared
 * 64-slot drum-sample directory). Backs the read-only `read_sample_directory`
 * tool. Reading slot names lets a caller map sounds semantically.
 */
export interface SampleDirectoryDump {
  /** Number of named (occupied) slots. */
  occupied: number;
  /** Total slot count probed. */
  total: number;
  slots: SampleDirectoryEntry[];
  /**
   * True when the pool is append-only with no fixed slot ceiling (SPD-SX:
   * storage-bounded, not slot-bounded). When set, `total` equals `occupied`
   * (the count of waves present), and `occupied/total` must NOT be read as a
   * "% full" — there is room to append. Unset/false (Circuit) = a real ceiling.
   */
  unbounded?: boolean;
  /** Optional human note about capacity (e.g. "append-only, room to add more"). */
  capacity_note?: string;
}

export interface DeviceReader {
  getParam(ctx: DispatchCtx, block: string, name: string, channel?: string | number, instance?: number): Promise<ReadResult>;
  /**
   * Byte-exact dump of the ACTIVE working-buffer preset as raw device
   * SysEx (concatenated frames). Backs the unified `export_preset` tool:
   * the returned bytes write verbatim to a `.syx` backup file and can be
   * re-sent to the device unchanged. A backup primitive, not a decode, so
   * the non-deterministic-encoder caveat on some devices (AM4) does not
   * block it: a blob round-trips regardless of whether we can interpret it.
   *
   * Optional. Implemented on the devices whose dump wire-shape is decoded
   * and hardware-confirmed (Fractal AM4, Axe-Fx II). Devices without a
   * decoded dump path (modern Fractal community-beta, Hydrasynth) omit it
   * and the dispatcher errors with capability_not_supported.
   */
  dumpActivePresetBinary?(ctx: DispatchCtx): Promise<PresetBinaryDump>;
  /**
   * Optional. Byte-exact backup of a stored preset (by integer location index)
   * via the gen-3 fn=0x03 REQUEST_PRESET_DUMP / 0x77/0x78/0x79 chain.
   * Wire-confirmed on FM9 fw 11.00 (capture 2026-06-04). III/FM3/VP4 share
   * the gen-3 codec (community beta). Devices without this path omit it and
   * the dispatcher errors with capability_not_supported.
   */
  dumpStoredPresetBinary?(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump>;
  /**
   * Optional. Read the device's named sample/sound directory (Circuit Tracks:
   * the pack's shared 64-slot drum-sample pool). Read-only, bidirectional.
   * Devices without a named sample pool omit it and the dispatcher errors with
   * capability_not_supported.
   */
  readSampleDirectory?(ctx: DispatchCtx): Promise<SampleDirectoryDump>;
  getParams(ctx: DispatchCtx, queries: readonly ParamQuery[]): Promise<BatchReadResult>;
  /**
   * BK-075 phantom-param pre-flight read. Returns a snapshot of which
   * block-type names are currently placed in the active working buffer.
   * Optional — devices without a placement model (Hydrasynth) omit this
   * and the dispatcher skips the phantom-param check.
   *
   * The dispatcher caches the result per-device with a 5-second TTL +
   * connection-identity check (see `blockLayoutCache.ts`); writers
   * (`set_block`, `apply_preset`, `save_preset`, `switch_preset`)
   * invalidate the cache so the next `set_param` re-reads.
   */
  getBlockLayoutSnapshot?(ctx: DispatchCtx): Promise<BlockLayoutSnapshot>;
  /**
   * Atomic read of the active working buffer. Returns one
   * `PresetSnapshot` describing every placed block + its current param
   * state. Single tool-call alternative to N×get_param round-trips for
   * state-anchoring before a tone-edit conversation.
   *
   * Optional. Currently implemented only on Axe-Fx II via fn 0x1F
   * SYSEX_GET_ALL_PARAMS per-block (Session 103 decode). Devices without
   * an atomic-read primitive omit this method and the dispatcher errors
   * with capability_not_supported. Callers fall back to grid +
   * per-block get_param reads.
   *
   * Scope v1: active-channel state only (X or Y on II, A/B/C/D on AM4
   * once AM4 is wired). Routing edges, per-scene snapshots, and
   * per-channel decomposition are deferred to v2 and will land via
   * additional fields on `PresetSnapshot` rather than a tool-shape
   * change.
   */
  getPreset?(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot>;
  /** Bulk-scan stored preset locations for their names. */
  scanLocations?(ctx: DispatchCtx, from: string | number, to: string | number): Promise<{
    scanned: readonly ScannedLocation[];
    failed_at?: string;
    failed_reason?: string;
  }>;
  /**
   * Non-destructive overwrite pre-check for save_preset. Reads the target
   * location's occupant name + whether it is the currently-active location,
   * so the dispatcher can run the confirmable overwrite gate uniformly.
   * Returns undefined when occupancy cannot be determined (a read failed) —
   * the dispatcher then degrades (proceeds, but flags the unverified
   * overwrite). Devices that omit this capability get no overwrite gate.
   */
  checkOverwriteTarget?(ctx: DispatchCtx, location: LocationRef): Promise<OverwriteTargetInfo | undefined>;
  /**
   * Read-after-save receipt: a targeted, deterministic read-back of what
   * persisted at `location`, surfaced as save_preset's `saved_snapshot`.
   * Best-effort (the dispatcher swallows failures). `missing` names the
   * fields whose read failed so the dispatcher can surface an honest
   * "could not confirm X" note. Devices that omit this get no receipt.
   */
  readSaveSnapshot?(ctx: DispatchCtx, location: LocationRef): Promise<{
    snapshot: SavedSnapshot;
    missing: readonly string[];
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
 * Result of uploading one WAV to a device sample slot (Circuit Tracks family).
 * `slot` is wire-indexed 0..63; the dispatcher surfaces the device-facing
 * 1..64 in `info`.
 */
export interface SampleUploadOutcome {
  ok: boolean;
  slot: number;
  /** Number of WRITE_DATA blocks sent. */
  blocks: number;
  /** True when the source WAV was resampled/folded/requantized to device format. */
  converted: boolean;
  /** Name written to the slot (what the device/Components shows). */
  filename: string;
  /** Human receipt (device-slot numbering, overwrite advisory, format note). */
  info: string;
  warning?: string;
}

/**
 * Options for a destructive slot transfer (sample / kit / project upload).
 *
 * `confirmOverwrite` is the safe-edit overwrite gate (cf.
 * `docs/SAFE-EDIT-WORKFLOW.md`): the destructive transfer tools refuse to
 * overwrite an occupied — or, for samples, an unverifiable — slot unless the
 * caller passes it true (the user used save/overwrite/replace language). A slot
 * the writer can READ and finds EMPTY is written without it (no gate on empty
 * slots — the whole point is to confirm before clobbering something real).
 */
export interface SlotWriteOptions {
  confirmOverwrite?: boolean;
}

/** One item in a kit upload: the already-read WAV bytes + its destination + name. */
export interface KitUploadItem {
  wav: Uint8Array;
  slot: number;
  filename: string;
}

/** Result of uploading a folder of WAVs to consecutive sample slots. */
export interface KitUploadOutcome {
  ok: boolean;
  uploaded: { slot: number; filename: string; converted: boolean }[];
  /** The item that aborted the batch, if any (upload stops on first failure). */
  failed?: { slot: number; filename: string; error: string };
  info: string;
  warning?: string;
}

/**
 * Result of uploading a prepared whole-project file (e.g. a Circuit Tracks
 * .ncs) to a device project slot. `slot` is the project slot 0..63; the device
 * shows it as "Project slot+1".
 */
export interface ProjectUploadOutcome {
  ok: boolean;
  slot: number;
  /** Number of WRITE_DATA blocks sent. */
  blocks: number;
  /** Human receipt (slot numbering, overwrite advisory). */
  info: string;
  warning?: string;
}

// ── Sampler kit authoring (author_kit) ──────────────────────────────
//
// The sampler-archetype whole-preset write. A kit IS the preset, addressed by
// location; there is no audition buffer, so authoring writes the stored file
// directly. First device: Roland SPD-SX (storage transport). Generalizes to
// future drum samplers as the sampler write verb. See
// `docs/design/device-archetypes-and-transport.md`.

/**
 * One pad assignment. The simple form is a wave index (number), a wave name
 * (string), or -1 / 'empty'. The object form additionally sets per-pad MIDI /
 * voice properties (sampler archetype; SPD-SX): the MIDI note that triggers the
 * pad, POLY vs MONO voicing (POLY = overlapping trails — wanted for hat rolls),
 * mute group (open/closed-hat choke), and velocity dynamics. Passing ANY object
 * form switches the kit to the device's full format; the all-simple form stays
 * on the byte-confirmed minimal format.
 */
export type KitPadAssignment = number | string | KitPadSpec;

export interface KitPadSpec {
  /** Wave index (number), wave name (string), or -1 / 'empty'. */
  wave: number | string;
  /** MIDI note that triggers this pad (0..127). Default: ascending from 60 by pad order. */
  note?: number;
  /** POLY = a new hit layers over the previous sound (hat rolls ring out); MONO = it chokes. Default 'poly' (one-shot) / 'mono' (loop). */
  voice?: 'poly' | 'mono';
  /** LOOP the wave (a groove/bed you play along to) instead of a one-shot hit; plays at its native tempo. Default false. */
  loop?: boolean;
  /** Mute group 0..9 (0 = off; pads in the same group cut each other off, e.g. open vs closed hat). Default 0. */
  mute_group?: number;
  /** Per-pad LEVEL / volume 0..127 (device WvLevel). Default 100. Lower it to sit a loud pad (e.g. a hi-hat) below the shells without re-baking the wave. */
  level?: number;
  /** Velocity scales volume (DYNAMICS). Default true. */
  dynamics?: boolean;
  /** Optional second (sub) wave layered on the pad: index, name, or -1 / 'empty'. */
  sub_wave?: number | string;
}

export interface KitAuthorOptions {
  /** Allow overwriting an occupied kit (backs the prior kit up first). */
  confirmOverwrite?: boolean;
  /** Build + validate the kit but do not write. */
  dryRun?: boolean;
}

export interface KitAuthorResult {
  ok: boolean;
  /** Kit location written (device-facing numbering, e.g. 1..100 on SPD-SX). */
  location: number;
  name: string;
  /** Pads that ended up with a wave assigned. */
  assigned: number;
  /** Serialized kit size in bytes. */
  bytes: number;
  /** True when this was a dry run (nothing written). */
  dry_run: boolean;
  /** Prior kit backed up before an overwrite (absolute path), when applicable. */
  backed_up?: string;
  info: string;
  warning?: string;
}

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
  setParam?(ctx: DispatchCtx, block: string, name: string, wireValue: number, channel?: string | number, instance?: number): Promise<WriteResult>;
  setParams?(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult>;
  setBlock?(ctx: DispatchCtx, slot: SlotRef, change: BlockChange): Promise<WriteResult>;
  setBypass?(ctx: DispatchCtx, block: string, bypassed: boolean, instance?: number): Promise<WriteResult>;
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
  /**
   * Persist the working buffer to `location` (optionally renaming first).
   * Just the persist — the confirmable overwrite gate and the read-back
   * receipt are handled device-agnostically in the dispatcher
   * (`executeSavePreset`) via the reader's `checkOverwriteTarget` +
   * `readSaveSnapshot` capabilities.
   */
  savePreset?(ctx: DispatchCtx, location: LocationRef, name?: string, instance?: number): Promise<WriteResult>;
  switchScene?(ctx: DispatchCtx, scene: number): Promise<WriteResult>;
  rename?(ctx: DispatchCtx, target: RenameTarget, name: string): Promise<WriteResult>;

  /**
   * OPTIONAL per-device override for `apply_pattern`. Most devices need
   * NONE of this: for `live_stream` / `record_capture` the dispatcher runs
   * the shared, device-agnostic realizers in `patterns/realizers/` directly
   * against `ctx.conn` using the descriptor's `voice_map` — zero device
   * code. A device implements this hook only when it has a bespoke
   * realization path the shared realizers can't express — chiefly
   * `ncs_upload` (Circuit Tracks .ncs authoring + SysEx transfer, phase C).
   * When present, the dispatcher prefers it; when absent it falls back to
   * the shared realizer for the selected `plan.mode`.
   */
  realizePattern?(ctx: DispatchCtx, plan: RealizePlan): Promise<RealizeResult>;

  /**
   * OPTIONAL. Realize a multi-section song ARRANGEMENT (apply_pattern
   * `arrangement`): each section is one compiled RealizePlan; `order` lists
   * section indices in play order (repeats allowed). The device writer owns
   * the layout strategy (pattern slots + chain vs. scene-chain) and its own
   * capacity limits, and errors honestly when the song doesn't fit. Only
   * devices with multi-pattern project authoring implement this (Circuit
   * Tracks .ncs); absent → the dispatcher errors capability_not_supported.
   */
  realizeArrangement?(
    ctx: DispatchCtx,
    sections: readonly ArrangementSectionPlan[],
    order: readonly number[],
    upload: NonNullable<RealizePlan['upload']>,
  ): Promise<RealizeResult>;

  /**
   * OPTIONAL. Add one WAV to a device's sample pool. `wav` is the raw file
   * bytes; any device-format normalize (rate/channels/bits) happens inside.
   *
   * `slot` semantics are device-dependent:
   *   - Slot-addressed pools (Circuit Tracks, 0..63): `slot` is REQUIRED and
   *     names the destination (OVERWRITES it). The writer rejects `undefined`.
   *   - Append-only pools (SPD-SX wave pool): `slot` is IGNORED — the wave is
   *     appended at the next free index, which the result reports. Callers omit
   *     it (the dispatcher passes `undefined`).
   *
   * Devices without sample memory omit this; the dispatcher then errors with
   * capability_not_supported.
   */
  uploadSample?(ctx: DispatchCtx, wav: Uint8Array, slot: number | undefined, filename: string, opts?: SlotWriteOptions): Promise<SampleUploadOutcome>;

  /**
   * OPTIONAL. Author a sampler KIT (a pad→wave map) and persist it at a stored
   * location (sampler archetype; Roland SPD-SX). The kit IS the preset, addressed
   * by location — there is no audition buffer, so this writes the device file
   * directly. `pads[i]` assigns pad i (0-based order) a wave by index (number) or
   * name (string), or -1 / 'empty' for an empty pad; the writer resolves names
   * against the device's wave pool. Refuses to overwrite an occupied kit unless
   * `opts.confirmOverwrite` (which backs the prior kit up first). Devices without
   * a kit format omit this; the dispatcher then errors capability_not_supported.
   */
  authorKit?(ctx: DispatchCtx, location: LocationRef, name: string, pads: readonly KitPadAssignment[], opts?: KitAuthorOptions): Promise<KitAuthorResult>;

  /**
   * OPTIONAL. Non-destructively set per-pad MIDI trigger notes on an EXISTING
   * kit WITHOUT rebuilding it: only the note fields change, so waves, levels, and
   * FX are preserved exactly (unlike authorKit, which rebuilds and resets levels/
   * FX to defaults — the loudness-drop trap). `notes` maps the device-facing pad
   * number (1-based) to a MIDI note 0..127. Sampler-family; full kits only — an
   * implementation refuses a kit that stores no per-pad notes (e.g. an SPD-SX
   * minimal kit), since adding one would force the level-changing full format.
   * Reuses KitAuthorResult (assigned = pads patched). Devices without a kit
   * format omit this; the dispatcher then errors capability_not_supported.
   */
  editPadNotes?(ctx: DispatchCtx, location: LocationRef, notes: Readonly<Record<number, number>>, opts?: KitAuthorOptions): Promise<KitAuthorResult>;

  /**
   * OPTIONAL. Upload a batch of WAVs to consecutive sample slots in one
   * session-managed run (each item is its own ACK-gated transfer). Stops on the
   * first failure rather than firing more frames into a possibly-dead handle.
   */
  uploadKit?(ctx: DispatchCtx, items: readonly KitUploadItem[], opts?: SlotWriteOptions): Promise<KitUploadOutcome>;

  /**
   * OPTIONAL. Upload a prepared whole-project file (e.g. a Circuit Tracks .ncs)
   * to a device project slot over the file-transfer transport. The bytes are
   * sent VERBATIM (no authoring) — this is the "play a pre-made project" path,
   * distinct from realizePattern which authors a pattern into a template first.
   * The writer validates the file shape (size/format). Devices without project
   * memory omit this; the dispatcher then errors with capability_not_supported.
   */
  uploadProject?(ctx: DispatchCtx, project: Uint8Array, slot: number, opts?: SlotWriteOptions): Promise<ProjectUploadOutcome>;

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

  /**
   * Push a byte-exact preset dump (produced by `export_preset` /
   * `reader.dumpActivePresetBinary`) back onto the device. The bytes are the
   * device's own native dump frames, so this is the SAME-DEVICE-MODEL restore
   * path: an Axe-Fx II dump only re-applies to an Axe-Fx II, an AM4 dump to an
   * AM4. (Cross-device porting is the structured `spec` + `translate_preset`
   * path, not this one.) Backs the `import_preset` tool.
   *
   * Default (no `target_location`): push to the WORKING BUFFER only, reversible
   * by switching presets. With `target_location` AND `save_authorized: true`
   * (the dispatcher enforces the gate), also persist to that stored location.
   *
   * Optional. Implemented on devices with a verified push path (AM4, Axe-Fx
   * II). Devices without it omit the method and the dispatcher returns
   * capability_not_supported for import_preset.
   */
  restorePresetBinary?(
    ctx: DispatchCtx,
    bytes: Uint8Array,
    options?: { target_location?: LocationRef; save_authorized?: boolean },
  ): Promise<RestorePresetResult>;
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

/**
 * Preset-shape class. Devices fall into one of three classes; each
 * class has one canonical "apply the whole preset" tool. See
 * `docs/ARCHITECTURE.md` § "Preset-class architecture" for the full
 * trichotomy.
 *
 *   - `'layout'`: signal-chain with slots + routing. Tool: `apply_preset`.
 *     Devices: Fractal AM4, Axe-Fx II, Axe-Fx III, future Helix/FM9.
 *   - `'voice'`: sparse override on a fixed-topology synth voice. Tool:
 *     `apply_patch`. Devices: Hydrasynth, future Roland synths.
 *   - `'effect'`: flat name/value map, no slots. Tool: `apply_settings`.
 *     Devices: Strymon pedals, Eventide H9 (planned).
 *
 * Default is `'layout'` for back-compat with existing Fractal descriptors.
 */
export type PresetClass = 'layout' | 'voice' | 'effect';

/**
 * Which kind of endpoint a device talks over. The dispatcher's `openCtx`
 * branches on this to build the right `DispatchCtx`.
 *
 *   - `'midi'`    USB MIDI port (the default; resolved via `ensureConnection`).
 *   - `'serial'`  USB-CDC serial carrying raw MIDI bytes (FM3). Still a
 *                 `MidiConnection`; the difference is handled inside the
 *                 connection factory, so the dispatch path is identical to midi.
 *   - `'storage'` A mounted USB mass-storage volume (SPD-SX WAVE MGR mode).
 *                 NOT a MIDI byte stream — `openCtx` resolves a filesystem root
 *                 instead of a wire handle and puts it on `DispatchCtx.storage`.
 *   - `'hybrid'`  The device exposes BOTH a MIDI surface and a storage surface,
 *                 mutually exclusive by hardware mode (SPD-SX). `openCtx`
 *                 resolves the live one per call: drive mounted → storage, else
 *                 a MIDI port → midi.
 *
 * Omit the field entirely for plain USB-MIDI devices — it defaults to `'midi'`,
 * leaving every existing descriptor untouched.
 */
export type TransportKind = 'midi' | 'serial' | 'storage' | 'hybrid';

export interface DeviceTransport {
  kind: TransportKind;
  /**
   * Storage / hybrid only: resolve the device's mounted-volume root, or
   * `undefined` when it is not currently mounted. For `'storage'` an absent
   * root makes `openCtx` throw `device_not_mounted`; for `'hybrid'` an absent
   * root means "fall through to the MIDI surface".
   */
  resolveRoot?: () => string | undefined;
  /**
   * Storage / hybrid only: device-specific steps to mount the drive, folded
   * into the `device_not_mounted` error so the agent can relay exactly how to
   * get the storage surface (USB mode, driver, port). Optional; a generic
   * message is used when absent.
   */
  notMountedHint?: string;
}

export interface DeviceDescriptor {
  // -- identity --
  id: string;                                   // 'am4', 'axe-fx-ii', 'hydrasynth'
  display_name: string;                         // 'Fractal AM4'
  /**
   * Endpoint kind for this device. Defaults to `'midi'` when omitted. Storage
   * and hybrid devices (SPD-SX) set it to declare their mass-storage surface;
   * see `DeviceTransport` and `docs/design/device-archetypes-and-transport.md`.
   */
  transport?: DeviceTransport;
  /**
   * Preset-shape class (layout / voice / effect). Determines which
   * "apply the whole preset" tool is registered for this device.
   * Defaults to `'layout'` when omitted.
   */
  preset_class?: PresetClass;

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
   * Tempo-lock map: absolute time/rate param path → the tempo-sync enum
   * param path that silently overrides it when synced. On AM4 / Axe-Fx II
   * a delay/modulation block locks its timing param to (song tempo ×
   * division) whenever its `tempo` enum is anything other than NONE, and
   * SILENTLY IGNORES absolute writes to the timing param.
   *
   * The dispatcher reads this to surface a non-blocking `validation_info`
   * warning when a SINGLE call (set_params batch / apply_preset slot)
   * sets both the tempo to a non-NONE division AND the absolute time/rate
   * for the same block — the "value not audible" trap the AM4/II guidance
   * calls out. Purely advisory: the write still proceeds.
   *
   * Keys and values are canonical `block.param` paths
   * (e.g. `'delay.time': 'delay.tempo'`). Optional — devices without a
   * tempo-lock model (Hydrasynth uses an explicit `delaybpmsync` flag the
   * agent sets directly; III is raw-wire uncalibrated) omit it.
   */
  tempo_locked_params?: Readonly<Record<string, string>>;

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
   * with zero errors AND parse against the `apply_preset` inputSchema
   * (the cross-device discriminated union) on devices that target the
   * unified apply_preset surface. The `verify-describe-device.ts`
   * golden enforces both.
   *
   * Devices WITHOUT a writer.applyPreset (Hydrasynth uses
   * `apply_patch` separately) MUST omit this field. Surfacing
   * an example_spec for a device that can't apply_preset misleads
   * agents into authoring calls that the schema then rejects (real
   * failure mode 2026-05-23).
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
  | 'bad_request'                  // malformed/contradictory tool arguments (e.g. two mutually-exclusive modes)
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
  | 'device_not_mounted'          // storage-transport device is not mounted as a drive (e.g. SPD-SX not in WAVE MGR mode)
  | 'save_authorization_required' // gate refusal: apply-at-slot called without save_authorized=true
  | 'buffer_dirty'                // gate refusal: nav/save-at-slot while active buffer has unsaved edits
  | 'overwrite_confirmation_required'; // gate refusal: destructive slot transfer to an occupied/unverifiable slot without confirm_overwrite=true

export interface DispatchErrorDetails {
  /** Single best near-match — printed inline ("did you mean X?"). */
  suggestion?: string;
  /** Small (≤8) valid options for inline listing. */
  valid_options?: readonly string[];
  /** Reference to a discovery tool when the valid set is too big to list. */
  valid_options_tool?: string;
  /** Recovery hint — what the LLM should try next. */
  retry_action?: string;
  /**
   * Structured per-param error list. Used by tools that batch validation
   * (e.g. apply_patch resolves every name + value before throwing) so the
   * agent sees every problem in one response instead of one-per-round-trip.
   * `asError` formats each entry inline beneath the main message.
   */
  validation_errors?: readonly {
    path: string;
    error: string;
    valid_options?: readonly string[];
    retry_action?: string;
  }[];
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
