/**
 * Modern Fractal family descriptor factory.
 *
 * The Axe-Fx III, FM3, and FM9 share ONE gen-3 SysEx wire codec; they
 * differ only in (a) the model byte (III 0x10, FM3 0x11, FM9 0x12),
 * (b) the front-panel shape (grid dimensions, scene count, channel
 * names, preset count), and (c) the LLM-facing surface (example_spec,
 * agent_guidance, canonical terms). `createModernFractalDescriptor`
 * takes all of that as a config and returns a unified-surface
 * `DeviceDescriptor`.
 *
 * SCOPE / DISCIPLINE. The wire codec (model byte + checksum + function
 * family) is validated as shared across the family — the III's own codec
 * is byte-verified against 10 public captures, and FM3/FM9 reuse it with
 * their model byte (see memory `project_fm3_fm9_capture_evidence` and
 * `docs/_private/PLAN-device-family-expansion.md`). The PARAMETER SET/GET
 * path (fn=0x01) is reused from the III but is NOT hardware-verified on
 * any device yet; every config that wires it ships with
 * `support_tier: 'community-beta'` and a per-response safety marker. We
 * emit ONLY wire shapes verified against Fractal's published spec or the
 * III's captured layout — never guessed bytes
 * (preference_axefx3_no_untested_wire_paths).
 *
 * The catalog factory lives in `./catalog.ts`: block roster + effect IDs
 * are the III's (shared across the gen-3 family), but the param table is
 * per-device (each config passes its own `params_by_family`; FM3/FM9 ship
 * device-true tables mined from their own editor binaries). The reader /
 * writer / dirty-gate live in `./reader.ts` / `./writer.ts` / `./guard.ts`.
 * Per-device configs live in `./configs/<device>.ts`.
 */
import type {
  DeviceDescriptor,
  PresetSpec,
  CanonicalTermMap,
  SupportTier,
  CompatibleTypesQuery,
  CompatibleTypesResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { listConceptKeysForDevice } from '@mcp-midi-control/core/protocol-generic/concept-keys.js';
import {
  createModernFractalCodec,
  AXE_FX_III_BLOCKS,
  resolveEffectId,
  GEN3_READ_ROSTERS,
  ampOrdinalsExposingParams,
  III_ROUNDTRIP_DISCRETE,
} from 'fractal-midi/gen3/axe-fx-iii';
import {
  VP4_MODEL_ID,
  buildVp4SetBypass,
  buildVp4Save,
  buildVp4SetParam,
} from 'fractal-midi/gen3/vp4';
import { FM9_RANGES, FM9_ROUNDTRIP_DISCRETE } from 'fractal-midi/gen3/fm9';
import { FM3_FAMILY_JOIN_DISCRETE } from 'fractal-midi/gen3/fm3';
import { createModernCatalog, type AxeFxIIIParam } from './catalog.js';

/** FM9 SysEx model byte: its device-true editor-cache ranges (FM9_RANGES) take
 *  precedence over the AM4-overlay-inferred catalog bounds. */
const FM9_MODEL_ID = 0x12;
/** Axe-Fx III SysEx model byte (the gen-3 byte-identity anchor). */
const III_MODEL_ID = 0x10;
/** FM3 SysEx model byte. */
const FM3_MODEL_ID = 0x11;

/**
 * Discrete-ordinal overlays, keyed by SysEx model byte. The III and FM9 each
 * carry an overlay generated from THAT device's own full roundtrip hardware
 * sweep (`fractal-midi/scripts/generate-gen3-roundtrip-discrete.ts`); they are
 * device-specific (different ordinal counts), so they are NEVER cross-wired.
 * The FM3 has no roundtrip capture and no device-synced enum cache, so it
 * carries the FAMILY-JOIN overlay instead
 * (`fractal-midi/scripts/generate-fm3-family-join-discrete.ts`): the same
 * correction, classified by (family, SYMBOL) join against the FM9 cache enum
 * rows + FM9/III roundtrips — family-pattern evidence, community-beta, FM3
 * roundtrip pending. VP4 (0x14) has no oracle data and gets no overlay.
 */
const ROUNDTRIP_DISCRETE_BY_MODEL: Readonly<Record<number, Readonly<Record<string, number>>>> = {
  [III_MODEL_ID]: III_ROUNDTRIP_DISCRETE,
  [FM9_MODEL_ID]: FM9_ROUNDTRIP_DISCRETE,
  [FM3_MODEL_ID]: FM3_FAMILY_JOIN_DISCRETE,
};
import { makeReader } from './reader.js';
import { makeWriter } from './writer.js';

/** Wire response window — same budget the III device-namespaced tools use. */
const GET_RESPONSE_TIMEOUT_MS = 800;

/**
 * Per-device config passed to `createModernFractalDescriptor`. One of
 * these lives in `src/configs/<device>.ts` per device.
 */
export interface FractalModernConfig {
  /** Stable device id + connection-registry key (e.g. 'axe-fx-iii', 'fm3'). */
  id: string;
  display_name: string;
  /** SysEx model byte: III 0x10, FM3 0x11, FM9 0x12, VP4 0x14. */
  model_byte: number;
  /** Connection-registry + buffer-dirty label. Defaults to `id` when omitted. */
  connection_label?: string;
  port_match: readonly { pattern: RegExp | string }[];
  /**
   * Grid dimensions (rows × cols) for grid-shaped devices. III/FM9 = 6×14;
   * FM3 = 4×12. OMITTED for serial AM4-shape devices (VP4): those place
   * blocks in a fixed N-slot chain, not a freeform grid, so they set
   * `slot_count` instead and report `slot_model: 'linear'`.
   */
  grid?: { rows: number; cols: number };
  /**
   * Serial slot count for AM4-shape devices (VP4 = 4). Mutually exclusive
   * with `grid`: a config sets one or the other. When set, the descriptor
   * advertises `slot_model: 'linear'` + `slot_count`.
   */
  slot_count?: number;
  scene_count: number;
  channel_names: readonly string[];
  /** Number of addressable preset slots (III/FM3/FM9 use integer 0..count-1). */
  preset_count: number;
  preset_location_format: RegExp;
  support_tier: SupportTier;
  /** One-line note on what is hardware-confirmed vs spec-only. */
  verification?: string;
  /**
   * Device's OWN per-family param table. The III passes its catalog (the
   * byte-identity anchor); FM3/FM9 pass their device-true tables mined
   * from each editor's own binary. paramIds are firmware-specific, so the
   * III's must NEVER be reused for FM3/FM9 wire writes — see catalog.ts.
   */
  params_by_family: Readonly<Record<string, readonly AxeFxIIIParam[]>>;
  /**
   * When true, drop blocks the device lacks (mapped family with zero
   * params) from the describe_device surface. III: false (unchanged
   * surface). FM3/FM9: true (device-true roster).
   */
  device_true_roster?: boolean;
  /**
   * Block slugs to drop from this device's surface even when their mapped
   * family carries params in the catalog. The mined catalog is shared across
   * the gen-3 editor family, so a device-true table can list params for a
   * block the physical device does NOT expose (VP4 has no amp/cab, yet its
   * mined catalog carries DISTORT/CABINET params from the shared editor
   * binary). `device_true_roster` only drops EMPTY mapped families, so blocks
   * with non-empty-but-absent rosters need an explicit exclude. Slugs are
   * lower-case (e.g. 'amp', 'cab').
   */
  exclude_blocks?: readonly string[];
  /**
   * When true, every device-state WRITE (set_param / set_block / set_bypass /
   * apply_preset / save_preset / rename / switch_preset / switch_scene)
   * refuses with a clear "untested on hardware" message; reads stay live.
   * Used for a config whose param/block write path is inferred but not yet
   * hardware-confirmed and whose block-placement wire shape is undecoded
   * (VP4: only the fn=0x12 mode switch is wire-verified). Omit (defaults
   * false) for devices whose write path is at least spec/capture-grounded.
   */
  writes_gated?: boolean;
  /**
   * When `writes_gated` is true, ops listed here are EXEMPT — they have a
   * hardware-confirmed wire shape and ship as community-beta. e.g. VP4 allows
   * `set_bypass` + `save_preset` (decoded byte-exact from a community capture)
   * while every other write stays gated. Omit ⇒ all writes gated.
   */
  write_allowlist?: readonly string[];
  /**
   * MIDI Bank-Select encoding for switch_preset's PC+bank message. Default
   * 'standard' (Axe-Fx III per the v1.4 spec: bank = CC0<<7 | CC32).
   * Set 'msb' for devices that read the bank from CC0/MSB and ignore CC32 —
   * without it, any preset above 127 lands in bank 0. FM9: hardware-confirmed
   * 2026-06-06. FM3: fw 12.00 field-confirmed to IGNORE CC32 (2026-06-12),
   * despite the v1.4 spec naming the FM3 'standard'. See buildSwitchPresetPC.
   */
  bank_select?: import('fractal-midi/gen3/axe-fx-iii').Gen3BankSelectMode;
  /**
   * Preset-switch mechanism. Default 'pc' (MIDI Program Change + Bank Select,
   * the spec-documented path; FM9-hardware-confirmed with 'msb' bank select).
   * Set 'sysex' to switch via the gen-3 fn=0x01 sub=0x27 SysEx-native op
   * instead: full 14-bit preset number, no MIDI-channel or bank-encoding
   * dependency. FM3 uses 'sysex' — sub=0x27 is FM3-hardware-confirmed (live
   * 475→100 switch 2026-06-10; field-test restore 2026-06-12), while the PC
   * path is hardware-FALSIFIED there with 'standard' bank select (FM3 fw 12.00
   * ignores CC32: a PC switch to preset 438 landed on 54 = 438 mod 128).
   */
  switch_preset_via?: 'pc' | 'sysex';
  /**
   * Per-device enum override tables (param firmware symbol -> ordinal -> name),
   * captured + verified from THIS model's hardware. Used where the amp/effect
   * roster is device-specific so the family-shared overlay leaves it numeric
   * (e.g. FM9 amp models). Partial tables are fine. Broadcast/read ordinals,
   * which double as the discrete-SET value (set-by-name: a discrete SET carries
   * float32(ordinal) at pos 12, sub 09 00 — no separate raw-id space). Omit for
   * devices with none.
   */
  enum_overrides?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  canonical_terms: CanonicalTermMap;
  agent_guidance: Readonly<Record<string, string>>;
  example_spec: PresetSpec;
  block_params_summary: Readonly<Record<string, readonly string[]>>;
}

export function createModernFractalDescriptor(config: FractalModernConfig): DeviceDescriptor {
  let codec = createModernFractalCodec(config.model_byte, { bankSelect: config.bank_select });
  // VP4 (model 0x14) diverges from the III fn=0x01 frame: no sub-action, a `tc`
  // sub-opcode, and a swapped-septet float. Override the write builders with the
  // VP4-true ones (decoded byte-exact from community captures, fractal-midi/gen3/vp4).
  // Reads still use the shared scaffolding. set_param stays GATED (the value
  // calibration + discrete/continuous distinction are undecoded), so the param
  // builders below are wired-ready but not yet reachable.
  if (config.model_byte === VP4_MODEL_ID) {
    codec = {
      ...codec,
      buildSetBypass: (e, b) => buildVp4SetBypass(e, b),
      buildStorePreset: () => buildVp4Save(),
      buildSetParameterContinuous: (e, p, normalized) => buildVp4SetParam(e, p, normalized, { continuous: true }),
      buildSetParameter: (e, p) => {
        throw new Error(
          `vp4: discrete parameter SET (effectId ${e}, paramId ${p}) is not yet decoded; ` +
            'only continuous knob writes have a captured wire shape.',
        );
      },
    };
  }
  const deviceLabel = config.display_name;
  const connectionLabel = config.connection_label ?? config.id;

  // Per-device catalog. Block roster + effect IDs are the III's (shared
  // across the gen-3 family); the param table is THIS device's own.
  // Enum read rosters: the gen-3 grid family (III/FM3/FM9) shares the
  // read-ordinal->name tables. They are layered BELOW the family overlay and
  // this device's hardware-captured overrides (which win), so they fill params
  // the overlay leaves numeric (notably the amp roster) without disturbing the
  // overlay spellings. The merged ordinal table also drives set-by-name: a
  // discrete SET carries float32(ordinal), so the read ordinal IS the set value
  // (no separate raw-id space). Serial AM4-shape gen-3 (VP4) is held out pending
  // its own validation.
  const catalog = createModernCatalog({
    blocks: AXE_FX_III_BLOCKS,
    paramsByFamily: config.params_by_family,
    resolveEffectId,
    dropEmptyMappedBlocks: config.device_true_roster ?? false,
    deviceEnumOverrides: config.enum_overrides,
    sharedEnumRosters: config.grid !== undefined ? GEN3_READ_ROSTERS : undefined,
    excludeBlocks: config.exclude_blocks,
    // FM9: device-true display ranges from the FM9-Edit effectDefinitions cache
    // (community capture, fw 11.0) override the AM4-overlay-inferred bounds for
    // calibration, correcting the float params whose inherited range contradicts
    // the real front panel (DELAY_TIME, REVERB_PREDELAY, etc.). The III/FM3/VP4
    // have no device-true range table yet, so they keep the catalog inference.
    deviceRanges: config.model_byte === FM9_MODEL_ID ? FM9_RANGES : undefined,
    // Discrete-ordinal overlay: params the enum paths missed but oracle
    // evidence proves are ordinals (the device quantizes a continuous SET), so
    // they must route DISCRETE. III and FM9 each get their OWN roundtrip-derived
    // overlay (never cross-wired); the FM3 gets the family-join overlay
    // (sibling-evidence classification, community-beta); VP4 has no oracle data.
    roundtripDiscreteOrdinals: ROUNDTRIP_DISCRETE_BY_MODEL[config.model_byte],
  });

  // Grid devices (III/FM3/FM9) advertise a 2-D grid + multi-instance blocks;
  // serial AM4-shape devices (VP4) advertise a linear N-slot chain and are
  // single-instance. A config sets exactly one of `grid` / `slot_count`.
  const isGrid = config.grid !== undefined;

  /**
   * Per-response safety marker on a community-beta device. The machine-
   * readable signal is `capabilities.support_tier`; this is the brief
   * human marker telling the agent to confirm by ear / by panel.
   */
  const betaWarning = [
    `${config.id} ${config.support_tier}. The parameter SET/GET path reuses the`,
    `modern Fractal (Axe-Fx III) wire codec with this device's model byte`,
    `(0x${config.model_byte.toString(16).padStart(2, '0')}); it is not hardware-verified on`,
    `${deviceLabel}. Please confirm the audible/visible response on the device.`,
  ].join(' ');

  // Per-device concept-key map (built from the central registry).
  const conceptKeys: Record<string, string> = {};
  for (const entry of listConceptKeysForDevice(config.id)) {
    conceptKeys[entry.conceptKey] = entry.localName;
  }

  // find_compatible_types + apply_preset's type-knob-applicability pre-flight
  // for the AMP block: given knob names, return the amp models that expose them
  // all. Backed by the per-amp-model valid-param table (ampTypeValidParams).
  // Amp-only for now (the only block with a validity table); other blocks fall
  // through to applicability_known:false (unfiltered, as before).
  function findCompatibleTypes(query: CompatibleTypesQuery): CompatibleTypesResult {
    const ampBlock = catalog.blocks['amp'];
    const typeEnum = ampBlock?.params['type']?.enum_values;
    const base = { block: query.block, params_queried: query.params };
    if (query.block.toLowerCase() !== 'amp' || ampBlock === undefined || typeEnum === undefined) {
      return { ...base, compatible_types: [], total_types: 0, applicability_known: false,
        note: `no structured type-applicability data for "${query.block}"; full type list, no filtering.` };
    }
    const totalTypes = Object.keys(typeEnum).length;
    // Resolve each queried knob to its canonical DISTORT_* name; skip unknowns.
    const distortNames: string[] = [];
    const skipped: string[] = [];
    for (const p of query.params) {
      try {
        distortNames.push(catalog.resolveParamOrThrow('amp', p, deviceLabel).param.name);
      } catch {
        skipped.push(p);
      }
    }
    if (distortNames.length === 0) {
      return { ...base, compatible_types: Object.values(typeEnum), total_types: totalTypes,
        applicability_known: false, note: `none of [${query.params.join(', ')}] resolved to an amp param.` };
    }
    const compatible = ampOrdinalsExposingParams(distortNames)
      .map((ord) => typeEnum[ord])
      .filter((n): n is string => typeof n === 'string');
    return {
      ...base,
      compatible_types: compatible,
      total_types: totalTypes,
      applicability_known: true,
      note: skipped.length > 0 ? `Skipped (not amp params, treated as always-on): ${skipped.join(', ')}.` : undefined,
    };
  }

  return {
    id: config.id,
    display_name: config.display_name,
    preset_class: 'layout',
    connection_label: connectionLabel,
    port_match: config.port_match,
    capabilities: {
      slot_model: isGrid ? 'grid' : 'linear',
      ...(isGrid ? { grid: { rows: config.grid!.rows, cols: config.grid!.cols } } : {}),
      ...(config.slot_count !== undefined ? { slot_count: config.slot_count } : {}),
      has_scenes: true,
      scene_count: config.scene_count,
      has_channels: true,
      channel_names: config.channel_names,
      // Named tempo divisions ("1/4 DOT") have no decoded gen-3 wire value;
      // the codec refuses to fabricate one. translate_preset strips
      // division strings bound for gen-3 targets with a warning.
      named_tempo_divisions: false,
      // gen-3 grid exposes up to 4 of each block type (Amp 1..4, Reverb 1..4,
      // Delay 1..2); the `instance` arg addresses them via resolveEffectId.
      // Serial AM4-shape devices (VP4) are single-instance, like the AM4.
      has_block_instances: isGrid,
      preset_location_format: config.preset_location_format,
      // false = flash PERSISTENCE is not hardware-VERIFIED (so auto-save during
      // navigation stays gated). The explicit save_preset tool still sends the
      // store envelope (fn=0x01 sub=0x26, captured byte-exact from III/FM9-Edit),
      // marked untested — gated on writer.savePreset presence, not this flag.
      // save_note carries that distinction to the agent so supports_save=false
      // is never read as "saving is unavailable".
      supports_save: false,
      save_note:
        'save_preset and apply_preset(target_location, save_authorized: true) ARE available: ' +
        'they send the gen-3 store envelope captured byte-exact from the editor (community-beta; ' +
        'flash persistence not hardware-verified, so ask the user to confirm by switching away ' +
        'and back). supports_save=false only gates AUTOMATIC save during navigation ' +
        '(on_active_preset_edited="save_active_first"); it does NOT mean saving is unavailable.',
      supports_lineage: false,
      atomic_read: false,
      support_tier: config.support_tier,
      verification: config.verification,
    },
    canonical_terms: config.canonical_terms,
    blocks: catalog.blocks,
    reader: makeReader({
      codec, catalog, deviceLabel,
      getResponseTimeoutMs: GET_RESPONSE_TIMEOUT_MS,
      channelNames: config.channel_names,
      // Per-block channel-count derivation requires a device-true catalog
      // (the maxPid stride floor is unsound on a mined-superset catalog like
      // the III's) — see reader.ts strideOf.
      deviceTrueCatalog: config.device_true_roster ?? false,
    }),
    writer: makeWriter({
      codec,
      catalog,
      shape: {
        id: config.id,
        grid: config.grid,
        slot_count: config.slot_count,
        scene_count: config.scene_count,
        channel_names: config.channel_names,
        preset_count: config.preset_count,
        supportsSave: false, // STORE not in the published spec for III/FM3/FM9
        writesGated: config.writes_gated ?? false,
        writeAllowlist: config.write_allowlist,
        switchPresetViaSysEx: config.switch_preset_via === 'sysex',
      },
      deviceLabel,
      connectionLabel,
      betaWarning,
      getResponseTimeoutMs: GET_RESPONSE_TIMEOUT_MS,
    }),
    findCompatibleTypes,
    agent_guidance: config.agent_guidance,
    example_spec: config.example_spec,
    block_params_summary: config.block_params_summary,
    concept_keys: Object.keys(conceptKeys).length > 0 ? Object.freeze(conceptKeys) : undefined,
  };
}
