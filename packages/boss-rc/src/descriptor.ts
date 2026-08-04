/**
 * Boss RC looper family HYBRID descriptor — two USB surfaces on one device.
 *
 * The RC-505mk2 (and its RC-600 sibling) exposes two surfaces selected by its
 * USB MODE:
 *
 *   - Normal USB-MIDI → the LIVE surface. A class-compliant USB-MIDI device that
 *     receives control on its RX CTL channel: memory recall via Program Change
 *     (switch_preset; memory M -> PC M-1, device-confirmed), and looper/track
 *     functions via Control Change routed through the memory's user-configured
 *     ASSIGN table (there is NO fixed factory CC map — an incoming CC does
 *     whatever the loaded memory's Assigns map it to; drive those with send_cc on
 *     the RX CTL channel). It is also a MIDI clock master/slave (drive tempo with
 *     the send_clock_* primitives). No parameter READ over MIDI — the device
 *     never echoes state, so live control is send-and-confirm-by-ear.
 *
 *   - STORAGE: CONNECT -> the STORAGE surface. The unit mounts as a USB drive
 *     whose memories are `ROLAND/DATA/MEMORY###A.RC0` / `###B.RC0` files (a
 *     redundant A/B pair per memory; the higher `<count>` is live). This is where
 *     a memory's NAME and ASSIGN control-routing table are read and authored:
 *     scan_locations lists memory names, get_preset(location) decodes one memory's
 *     Assign table, export_preset(location) backs up the live `.RC0`. The `.RC0`
 *     codec + the RC-505mk2 Assign dictionary are byte-exact and hardware-confirmed
 *     (see the maintainer's RC-505mk2 schema notes).
 *
 * `transport: { kind: 'hybrid' }` lets `openCtx` resolve the live surface per
 * call: drive mounted -> storage (ctx.storage.root); else a MIDI port -> midi
 * (ctx.conn). Each method guards its surface (`requireStorage` / `requireMidi`)
 * so a verb invoked in the wrong USB mode returns capability_not_supported naming
 * the mode to switch to.
 *
 * The family generalizes like Fractal gen-3: one codec (`codec/rc0`) bound to
 * per-model CONFIGS, each carrying its own ASSIGN field dictionary via
 * `BossRcConfig.assign` (a `BossRcAssignBinding`; see that interface). The
 * mk2 config (`codec/mk2`) shipped first with a hardware-confirmed ordinal
 * codec (full read + author). The RC-600 config (`codec/rc600`) shares the
 * A/B storage shape and the same ASSIGN block letter positions (byte-confirmed
 * against real RC-600 files) but ships READ-ONLY ordinals (no confirmed
 * source/target label map yet (see `codec/rc600.ts`); its `assign` binding
 * refuses to author a populated slot, while rename-only authoring (spec.name)
 * still works. The RC-500 / mk1 (single-file, no `<count>`) remain later
 * configs with their own dictionaries.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  SupportTier,
  ApplyPresetOptions,
  ApplyResult,
  BlockSchema,
  DeviceCapabilities,
  DeviceDescriptor,
  DispatchCtx,
  GetPresetOptions,
  LocationRef,
  ParamSchema,
  PresetSnapshot,
  PresetSpec,
  PresetBinaryDump,
  ScannedLocation,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  readName,
  authorName,
  readAllAssigns as mk2ReadAllAssigns,
  memoryIdIn,
  authorAssignRaw,
  clearAssign as mk2ClearAssign,
  sourceOrdinalFromDisplay,
  targetOrdinalFromDisplay,
  modeOrdinalFromDisplay,
  SOURCE_ENUM_VALUES,
  TARGET_ENUM_VALUES,
  MODE_ENUM_VALUES,
  type DecodedAssign,
} from './codec/mk2.js';
import {
  readAllAssigns as rc600ReadAllAssigns,
  clearAssign as rc600ClearAssign,
  refuseAssignAuthoring as rc600RefuseAssignAuthoring,
  TRACK_COUNT as RC600_TRACK_COUNT,
} from './codec/rc600.js';
import type { Rc0Doc } from './codec/rc0.js';
import { resolveRc505Root, RC505_ROOT_ENV } from './storage/discovery.js';
import { readActiveMemory, writeMemory, memoryFilename, MEMORY_MIN, MEMORY_MAX } from './storage/memoryStore.js';

/**
 * One decoded Assign slot in the shape `get_preset` emits. `mk2.ts`'s own
 * `DecodedAssign` already matches this structurally (see the import above);
 * `codec/rc600.ts`'s `DecodedAssignRc600` matches it too (raw `SOURCE#n` /
 * `TARGET#n` tokens instead of decoded labels).
 */
export type DecodedAssignLike = DecodedAssign;

/**
 * Per-model binding of the `assign` block schema to its read/author
 * primitives, the RC-family analogue of Fractal gen-3's per-device catalog
 * binding. The mk2 binding wires the hardware-confirmed ordinal codec
 * (`codec/mk2.ts`); the RC-600 binding wires structure-only reads (raw
 * `SOURCE#n`/`TARGET#n` tokens) and refuses to author a populated slot (see
 * `codec/rc600.ts`'s module docstring for why).
 */
export interface BossRcAssignBinding {
  /** The `assign` BlockSchema for this model (params: source/target/mode/act_lo/act_hi/target_min/target_max). */
  block: BlockSchema;
  /** Decode all 16 Assign slots of a memory doc to the `get_preset` params shape. */
  readAllAssigns(doc: Rc0Doc, memId: string | number): readonly DecodedAssignLike[];
  /** Blank one Assign slot to the model's confirmed factory-default byte pattern (FRESH-BUILD semantics). */
  clearSlot(doc: Rc0Doc, memId: string | number, slot: number): void;
  /**
   * Author every ENABLED slot from a validated `apply_preset` spec (already
   * past the generic param-encode preflight). For a binding whose block
   * schema's `source`/`target` `encode` always throws (RC-600), the generic
   * preflight rejects any non-empty slot before this is ever reached with
   * real content; it's still given a defensive throw for direct-API misuse.
   */
  authorSlots(doc: Rc0Doc, memId: string | number, enabledSlots: readonly PresetSpec['slots'][number][]): void;
}

/** Per-model binding for the shared hybrid descriptor. */
export interface BossRcConfig {
  id: string;
  display_name: string;
  connection_label: string;
  port_match: readonly { pattern: RegExp | string }[];
  /**
   * Default RX CTL channel (1..16) for memory-recall Program Change. The device
   * default is 1; the actual channel is user-set per unit (stored in SYSTEM1.RC0,
   * not readable over MIDI), so it is overridable at runtime via `ctl_channel_env`.
   */
  default_ctl_channel: number;
  /** Env var name for the RX CTL channel override (per-model, so an mk2 + an RC-600 don't fight over one variable). */
  ctl_channel_env: string;
  /** Track count: mk2 = 5, RC-600 = 6. Surfaced in agent guidance / docs. */
  track_count: number;
  /** ASSIGN block schema + read/author bindings (see `BossRcAssignBinding`). */
  assign: BossRcAssignBinding;
  /** Whether `apply_preset` can author a POPULATED assign slot (mk2: yes, hardware-confirmed; RC-600: no, ordinal map undecoded, rename-only). */
  assign_authoring_supported: boolean;
  /** Extra agent-guidance prose appended after the shared `live_control` text (e.g. the RC-600's richer SOURCE/TARGET vocabulary). */
  live_surface_note?: string;
  /** Override for `describe_device.example_spec` (defaults to the mk2's scene-ping-pong example when omitted). Devices whose assign authoring is gated should supply a rename-only example instead. */
  example_spec?: PresetSpec;
  /** Human `verification` string for capabilities. */
  verification: string;
  /**
   * Support tier for THIS device, not for the family.
   *
   * It lives on the config rather than the factory because the two Boss loopers
   * genuinely differ in evidence: the RC-505mk2's file surface is
   * hardware-confirmed through this server on the maintainer's own unit, while
   * the RC-600 carries no hardware confirmation at all. A tier hardcoded on the
   * shared factory could not express that, so both sat at the weaker label and
   * the mk2 was understated. Same shape as `fractal-gen2` / `fractal-gen3` /
   * `arturia`, which all put the tier on the per-device config.
   */
  support_tier: SupportTier;
}

/** Resolve the RX CTL channel: env override (1..16) wins, else the config default. */
function resolveCtlChannel(config: BossRcConfig): number {
  const raw = process.env[config.ctl_channel_env];
  if (raw && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  }
  return config.default_ctl_channel;
}

const MOUNT_STEPS =
  'Put the unit in storage mode (MENU -> STORAGE -> CONNECT) and connect USB so it mounts as a drive with a ' +
  `ROLAND/DATA/ folder of MEMORY###.RC0 files. Override discovery with the ${RC505_ROOT_ENV} env var if the ` +
  'drive is not auto-found. Return to normal USB-MIDI mode for live memory recall + looper control.';

/** Memory number (1..99) from a location ref. */
function parseMemoryNumber(config: BossRcConfig, location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
  if (!Number.isInteger(n) || n < MEMORY_MIN || n > MEMORY_MAX) {
    throw new DispatchError('bad_location', config.display_name, `${config.display_name} memory must be ${MEMORY_MIN}..${MEMORY_MAX}, got '${location}'.`);
  }
  return n;
}

/** Resolve the mounted storage root, or refuse with the mode-switch hint. */
function requireStorage(config: BossRcConfig, ctx: DispatchCtx): string {
  if (!ctx.storage) {
    throw new DispatchError(
      'capability_not_supported',
      config.display_name,
      `This reads/authors memory files, which needs the ${config.display_name} mounted as a drive. It is on its ` +
        `live USB-MIDI surface right now (memory recall + looper CC only). ${MOUNT_STEPS}`,
    );
  }
  return ctx.storage.root;
}

/** Refuse a live-MIDI op when the unit is on the storage surface instead. */
function requireMidi(config: BossRcConfig, ctx: DispatchCtx): void {
  if (ctx.storage) {
    throw new DispatchError(
      'capability_not_supported',
      config.display_name,
      `Live memory recall / looper control needs the ${config.display_name} on its USB-MIDI surface. It is mounted ` +
        'as a drive (STORAGE mode) right now. Return to normal USB-MIDI mode and retry.',
    );
  }
}

// ── blocks.assign schema ─────────────────────────────────────────────────────
// One "block" = one ASSIGN control-routing slot. apply_preset validates + encodes
// each slot's params through this schema (display -> ordinal), the exact inverse
// of what get_preset decodes, so a read round-trips through an author. Enum encode
// functions throw a plain Error on an illegal value; the dispatcher's preflight
// captures it as a structured validation_errors[] entry.

function enumParam(display_name: string, values: Readonly<Record<number, string>>, encode: (d: number | string) => number): ParamSchema {
  return { display_name, unit: 'enum', enum_values: values, encode, decode: (w: number): number | string => values[w] ?? w };
}
function intParam(display_name: string, min: number, max: number): ParamSchema {
  return {
    display_name,
    unit: 'int',
    display_min: min,
    display_max: max,
    encode: (d: number | string): number => {
      const n = Number(d);
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${display_name} must be an integer ${min}..${max}, got ${JSON.stringify(d)}`);
      return n;
    },
    decode: (w: number): number => w,
  };
}

const MK2_ASSIGN_BLOCK: BlockSchema = {
  display_name: 'Assign (control-routing slot)',
  params: {
    source: enumParam('Source', SOURCE_ENUM_VALUES, sourceOrdinalFromDisplay),
    target: enumParam('Target', TARGET_ENUM_VALUES, targetOrdinalFromDisplay),
    mode: enumParam('Source mode', MODE_ENUM_VALUES, modeOrdinalFromDisplay),
    act_lo: intParam('Source ACT.LO', 0, 127),
    act_hi: intParam('Source ACT.HI', 0, 127),
    target_min: intParam('Target min', 0, 200),
    target_max: intParam('Target max', 0, 200),
  },
};

/** RC-505mk2 ASSIGN binding: the hardware-confirmed (2026-07-07) ordinal codec in `codec/mk2.ts`. */
const MK2_ASSIGN_BINDING: BossRcAssignBinding = {
  block: MK2_ASSIGN_BLOCK,
  readAllAssigns: mk2ReadAllAssigns,
  clearSlot: mk2ClearAssign,
  authorSlots(doc, memId, enabledSlots): void {
    for (const slot of enabledSlots) {
      const sIdx = slot.slot as number;
      const p = (slot.params ?? {}) as Record<string, string | number>;
      authorAssignRaw(doc, memId, sIdx, {
        sw: 1,
        mode: p.mode !== undefined ? modeOrdinalFromDisplay(p.mode) : 0,
        sourceOrd: sourceOrdinalFromDisplay(p.source),
        actLo: p.act_lo !== undefined ? Number(p.act_lo) : 0,
        actHi: p.act_hi !== undefined ? Number(p.act_hi) : 127,
        targetOrd: targetOrdinalFromDisplay(p.target),
        targetMin: p.target_min !== undefined ? Number(p.target_min) : 0,
        targetMax: p.target_max !== undefined ? Number(p.target_max) : 1,
      });
    }
  },
};

// A "refusing" enum param: `decode` always renders a raw ordinal token (never a
// guessed label), `encode` always throws (so the dispatcher's generic BK-059
// preflight rejects any attempt to author a real value with a structured
// validation_errors[] entry, before any wire/file op fires). Used by the
// RC-600 binding below, whose source/target ordinal-to-label map is undecoded
// (see codec/rc600.ts's module docstring for the evidence).
function refusingEnumParam(display_name: string, tokenPrefix: string): ParamSchema {
  return {
    display_name,
    unit: 'enum',
    enum_values: {},
    encode: (): number => rc600RefuseAssignAuthoring(display_name),
    decode: (w: number): string => (w === 0 ? '(none)' : `${tokenPrefix}#${w}`),
  };
}

const RC600_ASSIGN_BLOCK: BlockSchema = {
  display_name: 'Assign (control-routing slot); RC-600: raw ordinals only, authoring gated (see codec/rc600.ts)',
  params: {
    source: refusingEnumParam('Source', 'SOURCE'),
    target: refusingEnumParam('Target', 'TARGET'),
    mode: enumParam('Source mode', MODE_ENUM_VALUES, modeOrdinalFromDisplay),
    act_lo: intParam('Source ACT.LO', 0, 127),
    act_hi: intParam('Source ACT.HI', 0, 127),
    target_min: intParam('Target min', 0, 200),
    target_max: intParam('Target max', 0, 200),
  },
};

/**
 * RC-600 ASSIGN binding: structure-only (real-file-confirmed letter positions
 * + blank-default pattern), source/target ordinals reported raw and authoring
 * refused: see `codec/rc600.ts`'s module docstring for the evidence and why.
 */
const RC600_ASSIGN_BINDING: BossRcAssignBinding = {
  block: RC600_ASSIGN_BLOCK,
  readAllAssigns: rc600ReadAllAssigns,
  clearSlot: rc600ClearAssign,
  authorSlots(_doc, _memId, enabledSlots): void {
    // The block schema's source/target `encode` already throws during the
    // generic preflight, so a real dispatcher call never reaches this with
    // non-empty content. Defensive guard for direct-API callers only.
    if (enabledSlots.length > 0) rc600RefuseAssignAuthoring('Source/Target');
  },
};

/**
 * Derive the OpenRig `control_sources` capability from this model's ASSIGN
 * source/target enum tables: the CC numbers legal as a control source (the
 * `CC#N` source labels) + the decoded target labels. Returns undefined when the
 * source map is undecoded (RC-600, whose source enum is empty by design), so a
 * device with no confirmed legal set advertises none rather than a guess. This
 * is what lets `describe_rig`'s compat check reject a binding to an illegal
 * source CC on the mk2 while staying honestly silent on the RC-600.
 */
function deriveControlSources(config: BossRcConfig): DeviceCapabilities['control_sources'] {
  const assignable_cc: number[] = [];
  for (const label of Object.values(config.assign.block.params.source?.enum_values ?? {})) {
    const m = /^CC#(\d+)$/.exec(label);
    if (m) assignable_cc.push(Number(m[1]));
  }
  if (assignable_cc.length === 0) return undefined;
  const targets = Object.values(config.assign.block.params.target?.enum_values ?? {});
  return { assignable_cc, ...(targets.length > 0 ? { targets } : {}) };
}

function bossRcBlocks(config: BossRcConfig): Readonly<Record<string, BlockSchema>> {
  return {
    assign: config.assign.block,
    // Empty slot marker so a get_preset snapshot (which emits block_type 'none' for
    // disabled assigns) round-trips through apply_preset without an "unknown block".
    none: { display_name: '(empty assign slot)', params: {} },
  };
}

function bossRcAgentGuidance(config: BossRcConfig): Readonly<Record<string, string>> {
  const ch = config.default_ctl_channel;
  return Object.freeze({
    capability_summary:
      `The ${config.display_name} has TWO surfaces, one at a time, selected by USB MODE. Normal USB-MIDI = the LIVE ` +
      `surface: recall a memory (switch_preset, memory 1..99 -> Program Change memory-1 on the RX CTL channel) and ` +
      'drive looper/track functions by sending CC on that channel (send_cc), plus MIDI clock master/slave for tempo. ' +
      'STORAGE mode (the unit mounts as a drive) = the FILE surface: read + author a memory\'s name and ASSIGN ' +
      'control-routing table as .RC0 files. The two modes are mutually exclusive; a verb invoked in the wrong mode ' +
      'returns capability_not_supported naming the mode to switch to.',
    the_assign_indirection:
      'The RC has NO fixed factory CC-to-function chart. Every external control is INDIRECT: an incoming CC does ' +
      'whatever the currently-loaded memory\'s ASSIGN table maps it to, and the same CC can mean different things ' +
      'in different memories (or nothing). So "send_cc N" only triggers a looper function if that memory has an ' +
      'Assign with SOURCE = MIDI CC#N pointed at the target you want. The Assign table is what get_preset reads and ' +
      'what the file-surface author path writes; live CC control is only as reliable as the loaded memory\'s Assigns.',
    live_control:
      `Memory recall: switch_preset(location = memory 1..99) sends Program Change memory-1 on the RX CTL channel ` +
      `(default ch${ch}; set ${config.ctl_channel_env} to the unit's actual RX CTL channel). Looper/track functions: ` +
      'send_cc(channel = RX CTL channel, cc = the number a memory Assign listens on) with a momentary pulse for ' +
      'transport targets (REC/PLY, STOP, ALL START/STOP) or a 0..127 value for a level target. The device NEVER ' +
      'echoes state over MIDI, so nothing can be read back or confirmed on the wire; confirm by ear / front panel.' +
      (config.live_surface_note ? ` ${config.live_surface_note}` : ''),
    tempo:
      'The RC is a MIDI clock master or slave. As a slave (its SYNC CLOCK = AUTO/MIDI/USB), drive its tempo with ' +
      'send_clock_start / send_clock_continue / send_clock_stop plus a clock stream; a MIDI Start launches tracks ' +
      'and/or rhythm only if its SYNC START is ALL or RHYTHM. As a master it transmits clock (SYNC OUT = ON) and a ' +
      'Program Change on memory change (PC OUT = ON).',
    file_surface: config.assign_authoring_supported
      ? 'In STORAGE mode: scan_locations(from, to as memory numbers) lists memory names; get_preset(location = memory) ' +
        'decodes that memory\'s ASSIGN table (each slot: source -> target, e.g. "CC#81 -> TRK2 PLY/STP"); ' +
        'among per-track TARGET labels only REC/PLY, PLY/STP, and STOP are device-confirmed, so a decoded label outside ' +
        'those three is inferred from the parameter-guide order and may be off by a position until hardware-confirmed. ' +
        'export_preset(location = memory) backs up the live .RC0 file. There is no active working buffer over storage, ' +
        'so get_preset always needs a memory number. A memory is stored as a redundant A/B pair; the higher <count> ' +
        'is the live copy, which the read path picks automatically.'
      : 'In STORAGE mode: scan_locations(from, to as memory numbers) lists memory names; get_preset(location = memory) ' +
        'decodes that memory\'s ASSIGN table STRUCTURALLY (which of the 16 slots are ON/OFF), reporting a raw ' +
        '"SOURCE#n -> TARGET#n" token per enabled slot rather than a friendly label; no ordinal-to-label map is decoded ' +
        `for the ${config.display_name} yet (see docs/_private/RC600-RESEARCH-2026-07-09.md). export_preset(location = memory) ` +
        'backs up the live .RC0 file. There is no active working buffer over storage, so get_preset always needs a ' +
        'memory number. A memory is stored as a redundant A/B pair; the higher <count> is the live copy, which the read ' +
        'path picks automatically.',
    authoring_memories: config.assign_authoring_supported
      ? 'AUTHOR a memory\'s Assign table with apply_preset(target_location = memory 1..99), the inverse of get_preset: ' +
        'each slot is { slot: 1..16, block_type: "assign", params: { source, target, mode?, act_lo?, act_hi?, ' +
        'target_min?, target_max? } }; source is "CTL1"/"CTL2" or "CC#64".."CC#95"; target is "TRKn <FN>" (FN = REC/PLY, ' +
        'PLY/STP, STOP, CLEAR, REVERSE, UN/RED, M.BACK, R.BACK, M.SET, M.CLEAR, LEVEL); spec.name sets the memory name. ' +
        'LABEL CAVEAT: only REC/PLY, PLY/STP, and STOP are device-confirmed; the other 8 FN labels are inferred from the ' +
        'parameter-guide order and unconfirmed on hardware, so verify a memory\'s assigns by ear / front panel after authoring. ' +
        'It is a FRESH-BUILD: the WHOLE 16-slot table is rewritten and any slot you do not list is CLEARED, so read the ' +
        'memory with get_preset first and re-list the assigns you want to keep. Default (save_authorized off) is a PREVIEW ' +
        '(validates + reports, writes nothing); pass save_authorized to write the .RC0 (it targets the inactive A/B slot ' +
        'and bumps its <count> so the edit goes live, backing up the overwritten copy first). save_preset(location, name) ' +
        'renames a memory without touching its assigns. The signature coordination, an external CC (e.g. an AM4 scene ' +
        'change) starting/stopping a looper track, is exactly this: author "CC#N -> TRKk <FN>" into the memory, then send ' +
        'that CC live. All storage writes need STORAGE mode; the live CC needs USB-MIDI mode.'
      : `AUTHORING an Assign slot's source/target is REFUSED on the ${config.display_name}: no confirmed ordinal-to-label ` +
        'map exists yet (see docs/_private/RC600-RESEARCH-2026-07-09.md; two independent from-the-manual guesses of the ' +
        'ordinal order disagree with each other, which is why this server won\'t guess a third). apply_preset(target_location ' +
        '= memory 1..99) still works for a RENAME (spec.name) or to blank the whole 16-slot table (FRESH-BUILD always ' +
        'clears every slot first; the confirmed blank byte pattern is safe to write), but any slot with block_type ' +
        '"assign" and real source/target params is rejected by preflight with a structured validation error. ' +
        'save_preset(location, name) also renames a memory without touching its assigns. Once a real owner backup with a ' +
        'POPULATED Assign table (or a two-saves-one-field-changed diff) is available, the ordinal map can be decoded and ' +
        'this gate lifted; the read/write plumbing is already built.',
    coordination:
      'The signature use: make one stomp on another device (e.g. an AM4 scene change that transmits a CC) also ' +
      'start/stop a looper track. That works when the target memory has an Assign mapping that CC to the track ' +
      'function; the RC receives the CC on its RX CTL channel and acts. This server sends the CC (live surface) and ' +
      'reads/authors the Assign that makes it land (file surface); it cannot confirm the result over MIDI.' +
      (config.assign_authoring_supported
        ? ''
        : ` On the ${config.display_name} today, the "authors the Assign" half of that sentence is rename-only; see ` +
          'authoring_memories.'),
  });
}

/** Build a hybrid RC-looper descriptor from a per-model config. */
export function createBossRcDescriptor(config: BossRcConfig): DeviceDescriptor {
  const label = config.display_name;
  const controlSources = deriveControlSources(config);
  return {
    id: config.id,
    display_name: label,
    preset_class: 'layout',
    connection_label: config.connection_label,
    transport: {
      kind: 'hybrid',
      resolveRoot: resolveRc505Root,
      notMountedHint: `${label} is not mounted as a drive. ${MOUNT_STEPS}`,
    },
    port_match: config.port_match,
    capabilities: {
      // A "slot" here is one ASSIGN control-routing slot (1..16); a "location" is
      // a memory (1..99, via preset_location_format).
      slot_model: 'linear',
      slot_count: 16,
      support_tier: config.support_tier,
      verification: config.verification,
      has_scenes: false,
      has_channels: false,
      supports_save: true,
      save_note: config.assign_authoring_supported
        ? 'Save is a STORAGE-mode file write, not a MIDI store: apply_preset(target_location=memory, save_authorized) ' +
          'authors a memory\'s name + ASSIGN table into its .RC0 (A/B <count> arbitration, backup-before-write), and ' +
          'save_preset(location, name) renames a memory. There is no editable working buffer over MIDI, so both need the ' +
          'drive mounted.'
        : 'Save is a STORAGE-mode file write, not a MIDI store: apply_preset(target_location=memory, save_authorized) ' +
          'authors a memory\'s NAME (and blanks its ASSIGN table if slots are omitted) into its .RC0 (A/B <count> ' +
          'arbitration, backup-before-write); authoring a POPULATED assign slot is refused pending a decoded ordinal map ' +
          '(see agent_guidance.authoring_memories). save_preset(location, name) renames a memory. There is no editable ' +
          'working buffer over MIDI, so both need the drive mounted.',
      supports_lineage: false,
      preset_location_format: /^([1-9]|[1-9][0-9])$/, // memory 1..99
      // Legal assignable control sources/targets (mk2: CC#64-95 + TRK targets;
      // RC-600: omitted, source map undecoded). Backs the OpenRig compat check.
      ...(controlSources !== undefined ? { control_sources: controlSources } : {}),
    },
    canonical_terms: {
      block: 'assign (control-routing slot)',
      slot: 'assign slot (1-16)',
      preset: 'memory',
      scene: `n/a (the RC has no scenes; its ${config.track_count} tracks are the performance layers)`,
      channel: 'RX CTL channel (the memory-recall + control channel)',
      location: 'memory (1-99)',
    },
    blocks: bossRcBlocks(config), // one "block" = one ASSIGN control-routing slot (see bossRcBlocks)
    reader: {
      async getParam() {
        throw new DispatchError('capability_not_supported', label, `${label} exposes no readable parameters over MIDI (it never echoes state).`);
      },
      async getParams() {
        throw new DispatchError('capability_not_supported', label, `${label} exposes no readable parameters over MIDI (it never echoes state).`);
      },
      async scanLocations(ctx, from, to): Promise<{ scanned: readonly ScannedLocation[]; failed_at?: string; failed_reason?: string }> {
        const root = requireStorage(config, ctx);
        const lo = parseMemoryNumber(config, from);
        const hi = parseMemoryNumber(config, to);
        const scanned: ScannedLocation[] = [];
        for (let m = Math.min(lo, hi); m <= Math.max(lo, hi); m++) {
          try {
            const active = readActiveMemory(root, m);
            const id = memoryIdIn(active.doc) ?? '0';
            scanned.push({ location: String(m), name: readName(active.doc, id), is_empty: false });
          } catch {
            // A memory whose file pair is absent reads as empty (not an error).
            scanned.push({ location: String(m), name: '', is_empty: true });
          }
        }
        return { scanned };
      },
      async getPreset(ctx, options?: GetPresetOptions): Promise<PresetSnapshot> {
        const root = requireStorage(config, ctx);
        if (options?.location === undefined) {
          throw new DispatchError('capability_not_supported', label, `${label} has no active working buffer over storage; pass a memory location (1..99) to read that memory.`);
        }
        const m = parseMemoryNumber(config, options.location);
        let active;
        try {
          active = readActiveMemory(root, m);
        } catch {
          throw new DispatchError('bad_location', label, `Memory ${m} is not present on the device.`);
        }
        const id = memoryIdIn(active.doc) ?? '0';
        const assigns = config.assign.readAllAssigns(active.doc, id);
        return {
          name: readName(active.doc, id),
          slots: assigns.map((a) => {
            const enabled = a.sw && a.source !== '(none)';
            const params: Record<string, string | number> = enabled
              ? {
                  source: a.source,
                  target: a.target,
                  mode: a.mode,
                  act_lo: a.actLo,
                  act_hi: a.actHi,
                  target_min: a.targetMin,
                  target_max: a.targetMax,
                }
              : {};
            return { slot: a.slot, block_type: enabled ? 'assign' : 'none', params };
          }),
          read_warnings: [
            config.assign_authoring_supported
              ? 'This reads the memory\'s ASSIGN control-routing table (which external control drives which looper ' +
                'function), not audio/track content. An enabled assign reads as "source -> target" (e.g. ' +
                '"CC#81 -> TRK2 PLY/STP"). Targets outside the decoded per-track set (CUR.TRK / global / FX / mixer) ' +
                'show as a raw TARGET#n rather than a guessed label. The live copy of the A/B pair was read.'
              : `This reads the memory's ASSIGN control-routing table structurally (which slots are ON/OFF), not audio/track ` +
                `content. No source/target ordinal-to-label map is decoded for the ${label} yet (see ` +
                'docs/_private/RC600-RESEARCH-2026-07-09.md), so an enabled assign reads as a raw "SOURCE#n -> TARGET#n" ' +
                'token rather than a guessed label. The live copy of the A/B pair was read.',
          ],
          _meta: {
            device: label,
            read_at_ms: Date.now(),
            active_scene_only: false,
            routing_omitted: true,
          },
        };
      },
      async dumpStoredPresetBinary(location, ctx): Promise<PresetBinaryDump> {
        const root = requireStorage(config, ctx);
        const m = parseMemoryNumber(config, location);
        let active;
        try {
          active = readActiveMemory(root, m);
        } catch {
          return {
            bytes: new Uint8Array(0),
            byte_length: 0,
            frame_count: 0,
            format: 'boss-rc-memory',
            file_extension: 'RC0',
            empty: true,
            source: `${label} memory ${m} is empty (no MEMORY${String(m).padStart(3, '0')} file on the device).`,
          };
        }
        const id = memoryIdIn(active.doc) ?? '0';
        const file = join(root, 'DATA', memoryFilename(m, active.slot));
        const bytes = new Uint8Array(readFileSync(file));
        return {
          bytes,
          byte_length: bytes.length,
          frame_count: 1,
          format: 'boss-rc-memory',
          file_extension: 'RC0',
          name: readName(active.doc, id),
          source: `${label} memory ${m} (${memoryFilename(m, active.slot)}, the live A/B copy)`,
        };
      },
    },
    writer: {
      buildSetParam() {
        throw new DispatchError('capability_not_supported', label, `${label} has no MIDI-addressable parameters; only memory recall (switch_preset) and CC-driven Assigns (send_cc).`);
      },
      buildSwitchPreset(location): number[] {
        const ch = resolveCtlChannel(config);
        return [0xc0 | ((ch - 1) & 0x0f), (parseMemoryNumber(config, location) - 1) & 0x7f];
      },
      async switchPreset(ctx, location: LocationRef): Promise<WriteResult> {
        requireMidi(config, ctx);
        const m = parseMemoryNumber(config, location);
        const ch = resolveCtlChannel(config);
        ctx.conn.send([0xc0 | ((ch - 1) & 0x0f), (m - 1) & 0x7f]);
        return {
          op: 'switch_preset',
          target: `memory ${m}`,
          acked: true,
          unconfirmed: true,
          info:
            `Recalled memory ${m} via Program Change ${m - 1} on ch${ch} (the RX CTL channel). ` +
            `Requires PC IN = ON and the unit's RX CTL channel to match (set ${config.ctl_channel_env} if it is not ` +
            `${config.default_ctl_channel}). No readback; confirm on the device.`,
        };
      },
      // Pre-MIDI validation (runs before the drive is opened): apply_preset must
      // target a memory, and each 'assign' slot needs a source + target.
      validatePreset(spec: PresetSpec, target?: LocationRef): void {
        if (target === undefined) {
          throw new Error(`${label}: apply_preset authors a stored MEMORY; pass target_location (memory 1..99). There is no working buffer to build into.`);
        }
        parseMemoryNumber(config, target);
        const seen = new Set<number>();
        for (const slot of spec.slots) {
          if (slot.block_type === 'none' || slot.block_type === '') continue;
          if (typeof slot.slot !== 'number' || slot.slot < 1 || slot.slot > 16) {
            throw new Error(`${label}: assign slot must be an integer 1..16, got ${JSON.stringify(slot.slot)}.`);
          }
          if (seen.has(slot.slot)) {
            throw new Error(`${label}: assign slot ${slot.slot} is listed more than once; each of the 16 ASSIGN slots may appear at most once per apply_preset.`);
          }
          seen.add(slot.slot);
          const p = (slot.params ?? {}) as Record<string, unknown>;
          if (p.source === undefined || p.target === undefined) {
            throw new Error(`${label}: assign slot ${slot.slot} needs both a source and a target.`);
          }
        }
      },
      // Author a memory's name + ASSIGN table over storage. FRESH-BUILD: the whole
      // 16-slot table is rewritten and unlisted slots are cleared (apply_preset
      // contract). save_authorized (options.save) gates the actual write; without
      // it this is a validated preview that touches nothing.
      async applyPreset(ctx: DispatchCtx, spec: PresetSpec, target?: LocationRef, options?: ApplyPresetOptions): Promise<ApplyResult> {
        const started = Date.now();
        const root = requireStorage(config, ctx);
        if (target === undefined) {
          throw new DispatchError('bad_request', label, `${label}: apply_preset authors a stored MEMORY; pass target_location (memory 1..99). There is no working buffer.`);
        }
        const m = parseMemoryNumber(config, target);
        const enabled = spec.slots.filter((s) => s.block_type !== 'none' && s.block_type !== '');
        const mutate = (doc: Rc0Doc): void => {
          const id = memoryIdIn(doc) ?? 0;
          if (spec.name !== undefined) authorName(doc, id, spec.name);
          for (let s = 1; s <= 16; s++) config.assign.clearSlot(doc, id, s); // FRESH-BUILD
          config.assign.authorSlots(doc, id, enabled);
        };
        const save = options?.save === true;
        const wr = writeMemory(root, m, mutate, { dryRun: !save });
        const nameNote = spec.name !== undefined ? ` + name "${spec.name}"` : '';
        return {
          ok: true,
          steps: enabled.length + (spec.name !== undefined ? 1 : 0),
          duration_ms: Date.now() - started,
          saved: save,
          ...(save
            ? {}
            : {
                warning:
                  `PREVIEW only (save_authorized not set): validated ${enabled.length} assign(s)${nameNote} for memory ${m}; ` +
                  'NOTHING was written. Re-call with save_authorized to write the .RC0 (backs up the current copy first).',
              }),
          info: save
            ? `Authored memory ${m} on ${label}: FRESH-BUILT ${enabled.length} enabled assign(s)${nameNote}, wrote slot ` +
              `${wr.writeSlot} (count ${wr.count})${wr.backedUp ? ', backed up the prior copy' : ''}. The 16-slot ASSIGN table ` +
              'was rewritten (any unlisted slot cleared). Reconnect in USB-MIDI mode; the change shows on storage disconnect (no power cycle).'
            : `Dry run for memory ${m}: would FRESH-BUILD ${enabled.length} assign(s)${nameNote}, write slot ${wr.writeSlot} (count ${wr.count}). Not written.`,
          applied_spec: spec,
        } as ApplyResult;
      },
      // Required by the apply_preset(target_location) gate, and a standalone rename:
      // save_preset(location, name) sets memory `location`'s name (assigns untouched).
      async savePreset(ctx: DispatchCtx, location: LocationRef, name?: string): Promise<WriteResult> {
        const root = requireStorage(config, ctx);
        const m = parseMemoryNumber(config, location);
        if (name === undefined || name.trim() === '') {
          throw new DispatchError('bad_request', label, `${label}: save_preset renames a stored memory; pass a name. To author a memory's ASSIGN table, use apply_preset(target_location, save_authorized).`);
        }
        const wr = writeMemory(root, m, (doc) => authorName(doc, memoryIdIn(doc) ?? 0, name));
        return {
          op: 'save_preset',
          target: `memory ${m}`,
          acked: true,
          info: `Renamed memory ${m} to "${name}" on ${label} (wrote slot ${wr.writeSlot}, count ${wr.count}${wr.backedUp ? ', prior copy backed up' : ''}). Shows on storage disconnect.`,
        };
      },
    },
    agent_guidance: bossRcAgentGuidance(config),
    example_spec: config.example_spec ?? {
      name: 'ScenePP',
      slots: [
        { slot: 1, block_type: 'assign', params: { source: 'CC#81', target: 'TRK2 PLY/STP' } },
        { slot: 2, block_type: 'assign', params: { source: 'CC#81', target: 'TRK3 STOP' } },
        { slot: 3, block_type: 'assign', params: { source: 'CC#82', target: 'TRK3 PLY/STP' } },
        { slot: 4, block_type: 'assign', params: { source: 'CC#82', target: 'TRK2 STOP' } },
      ],
    },
  };
}

/** RC-505mk2 config — the first Boss RC looper to ship. */
export const RC505MK2_CONFIG: BossRcConfig = {
  id: 'rc-505mk2',
  display_name: 'Boss RC-505mk2',
  connection_label: 'rc-505mk2',
  port_match: [{ pattern: /rc-?505/i }, { pattern: /rc505/i }],
  default_ctl_channel: 1,
  ctl_channel_env: 'MCP_RC505_CTL_CHANNEL',
  track_count: 5,
  assign: MK2_ASSIGN_BINDING,
  assign_authoring_supported: true,
  // HYBRID device. Set from the PRIMARY authoring surface, which is the FILE
  // surface: hardware-confirmed through this server's own packaged path on the
  // maintainer's own unit. The live MIDI surface stays documented-only, and the
  // verification string below leads with that split.
  support_tier: 'verified',
  verification:
    'Live surface: documented (Parameter Guide) memory recall via Program Change (memory M -> PC M-1, ' +
    'device-confirmed) + looper/track control via CC routed through the memory\'s user-configured ASSIGN table; ' +
    'no parameter read over MIDI (the unit never echoes state). File surface, HARDWARE-CONFIRMED through this ' +
    'server\'s own packaged path on the maintainer\'s unit (2026-07-08): scan_locations + get_preset decoded the ' +
    'real memories\' ASSIGN tables off the mounted drive; apply_preset authored a memory (name + assigns) into ' +
    'the inactive A/B slot with the count+1 double-buffer flip, read back byte-exact, and reversed cleanly; ' +
    'export_preset dumped the live copy. The .RC0 codec + ASSIGN dictionary are byte-exact against real device ' +
    'files. The live coordination itself (an authored CC firing a looper track by ear/front panel) was confirmed ' +
    '2026-07-07 via a direct send_cc on the RX CTL channel; driving that CC trigger through this server end-to-end ' +
    'is generic-MIDI send_cc and awaits its own by-ear pass.',
};

/** The RC-505mk2 device descriptor. */
export const RC_505_MK2_DESCRIPTOR: DeviceDescriptor = createBossRcDescriptor(RC505MK2_CONFIG);

/**
 * RC-600 config: same `.RC0` generation + hybrid transport as the mk2, added
 * this session (2026-07-09). LIVE surface (PC-based memory recall + CC-driven
 * Assign indirection + clock) is community-beta from Roland's published
 * RC-600 Parameter Guide + the mk2's own hardware-confirmed sibling behavior.
 * STORAGE surface reads (scan_locations / get_preset / export_preset) are
 * community-beta from real RC-600 device files (paulelong/RCEditor's MIT
 * corpus); ASSIGN source/target values read as raw ordinal tokens and
 * AUTHORING a populated assign slot is refused (no confirmed ordinal map;
 * see `codec/rc600.ts` + docs/_private/RC600-RESEARCH-2026-07-09.md).
 * Renaming a memory (apply_preset spec.name / save_preset) is fully
 * supported: NAME encoding is byte-confirmed against the same real files.
 */
export const RC600_CONFIG: BossRcConfig = {
  id: 'rc-600',
  display_name: 'Boss RC-600',
  connection_label: 'rc-600',
  port_match: [{ pattern: /rc-?600/i }],
  default_ctl_channel: 1,
  ctl_channel_env: 'MCP_RC600_CTL_CHANNEL',
  track_count: RC600_TRACK_COUNT,
  assign: RC600_ASSIGN_BINDING,
  assign_authoring_supported: false,
  live_surface_note:
    'The RC-600\'s published ASSIGN SOURCE vocabulary is richer than the mk2\'s: TRK1-6 REC/DB, TRK1-6 PLY/STP, ' +
    'SYNC ST/STP, PEDAL1-9 x MODE1-3, CTL1-4, EXP1-2, and MIDI CC#01-31 + CC#64-95 (RC-600 Parameter Guide, ' +
    '"ASSIGN" section). TARGET reuses the SAME 11 per-track function names as the mk2 (REC/PLY, PLY/STP, STOP, ' +
    'CLEAR, REVERSE, UN/RED, M.BACK, R.BACK, M.SET, M.CLEAR, LEVEL) across 6 tracks, plus a large non-per-track set ' +
    '(CUR.TRK equivalents, ALL ST/STP, TAP TEMPO, INPUT/TRACK FX, RHYTHM, mixer/EQ/output levels, PEDAL MODE); none ' +
    'of that vocabulary is wired for send_cc auto-lookup; drive CC numbers directly and confirm by ear / front panel, ' +
    'same as the mk2. The memory-recall PC mapping (memory M -> PC M-1) is carried from the mk2\'s own hardware-' +
    'confirmed convention (same generation, same PC OUT / RX CTL CH menu shape) and Roland/Boss\'s universal 0-indexed ' +
    'PC convention, but is NOT independently hardware-tested on an RC-600 unit; confirm with one switch_preset call.',
  example_spec: { name: 'MyLoop', slots: [] },
  // NOT owned by the maintainer and carries no hardware confirmation of any
  // kind. This is the case the per-config tier exists to express: it must stay
  // weaker than its mk2 sibling rather than inherit the sibling's evidence.
  support_tier: 'generic-only',
  verification:
    'Live surface: documented (RC-600 Parameter Guide) memory recall via Program Change + looper/track control via ' +
    'CC routed through the memory\'s user-configured ASSIGN table + MIDI clock; the exact PC-to-memory offset ' +
    '(memory M -> PC M-1) is carried from the mk2\'s hardware-confirmed sibling behavior and standard Boss/Roland ' +
    'practice, NOT independently confirmed on an RC-600 unit. No parameter read over MIDI (the unit never echoes ' +
    'state). File surface: the `.RC0` envelope, 12-char NAME encoding, 16-slot/10-leaf ASSIGN block shape, and 6-track ' +
    'layout are BYTE-CONFIRMED against two real RC-600 device files (paulelong/RCEditor\'s MIT-licensed ' +
    '`SupportDoc/RolExample` corpus); scan_locations / get_preset / export_preset ship as community-beta reads. ' +
    'ASSIGN source/target ordinal-to-label mapping is NOT decoded (both corpus files hold only blank factory assigns, ' +
    'and two independent from-the-manual guesses at the ordinal order contradict each other), so get_preset reports ' +
    'raw "SOURCE#n"/"TARGET#n" tokens and apply_preset REFUSES to author a populated assign slot; renaming a memory ' +
    '(apply_preset spec.name / save_preset) is fully supported. See docs/_private/RC600-RESEARCH-2026-07-09.md.',
};

/** The RC-600 device descriptor. */
export const RC_600_DESCRIPTOR: DeviceDescriptor = createBossRcDescriptor(RC600_CONFIG);
