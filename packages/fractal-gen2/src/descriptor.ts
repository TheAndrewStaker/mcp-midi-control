/**
 * Axe-Fx II DeviceDescriptor — top-level assembler for the BK-051 unified
 * tool surface (Wave 2).
 *
 * Wraps the existing Axe-Fx II protocol code (params.ts, blockTypes.ts,
 * setParam.ts, lineageLookup.ts, tools/applyExecutor.ts) into the
 * `DeviceDescriptor` contract from `src/protocol/generic/types.ts`. The
 * wire layer is byte-frozen — no code under `src/fractal/axe-fx-ii/`
 * outside this descriptor directory (and the applyExecutor.ts widening
 * tweaks) is modified. This file is the translation layer between the
 * legacy direct-call shape and the dispatcher-routed shape.
 *
 * Split into a per-role directory (Session 67, mirroring the AM4
 * descriptor split in Session 65 cont):
 *
 *   - `descriptor/schema.ts`  — makeEncode / makeDecode (per-param
 *                                encode/decode closures), buildBlocks,
 *                                buildBlockTypes, parseAxeFxIILocation,
 *                                findBlockBySlug
 *   - `descriptor/writer.ts`  — DeviceWriter (14 methods)
 *   - `descriptor/reader.ts`  — DeviceReader (4 methods)
 *
 * Consumers continue to import `AXEFX2_DESCRIPTOR` from
 * `@/fractal/axe-fx-ii/descriptor.js`; the directory split is internal.
 *
 * Registration order in `src/server/index.ts` is INTENTIONAL: Axe-Fx II
 * registers BEFORE AM4 so the more-specific `/axe-?fx/i` regex fires
 * first on port names like "Fractal Axe-Fx II Port 1". AM4's
 * `/Fractal/i` regex stays as a catch-all (Q4 answered Session 66 wrap;
 * see `docs/_private/axefx2-descriptor-plan.md` § 9).
 */

import type {
  DeviceDescriptor,
  PresetSpec,
  CompatibleTypesQuery,
  CompatibleTypesResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { registerParamKindResolver } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import { AXE_FX_II_BLOCKS, KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';
import { findCompatibleTypes as axefx2FindCompatibleTypes } from 'fractal-midi/gen2/axe-fx-ii';

import { listConceptKeysForDevice } from '@mcp-midi-control/core/protocol-generic/concept-keys.js';

import { AXEFX2_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';
import { resolveAxeFxIIParamKind } from './calibration.js';
import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';

/**
 * Per-device concept-key map. Built from the central registry in
 * `concept-keys.ts`. Surfaced via `describe_device.concept_keys` so the
 * agent can read the canonical concept-key -> local-name map in one call.
 */
const AXEFX2_CONCEPT_KEYS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const entry of listConceptKeysForDevice('axe-fx-ii')) {
    out[entry.conceptKey] = entry.localName;
  }
  return Object.freeze(out);
})();

// Plug the Axe-Fx II resolver into the cross-device param-kind registry
// BEFORE buildBlocks() runs (schema.ts uses resolveParamKind to derive
// each param's encode/decode closures + display range + unit).
registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind);

// X/Y channel-bearing block set for the Axe-Fx II XL+ (model byte 0x07,
// the hardware this descriptor targets).
//
// Source of truth: Fractal Audio wiki "Channels" page → "Which effect
// blocks support X/Y" table, the "Axe-Fx II XL and XL+" row:
//   Amp, Cab, Chorus, Compressor, Delay, Drive, Flanger, GEQ, Gate,
//   Mixer, PEQ, Phaser, Pitch, Rotary, Reverb, Tremolo, Wah.
// Keyed by the stable 3-letter group code (blockTypes.ts) so the membership
// can't drift on a display-name rename.
//
// This REPLACES the old `canBypass` proxy, which had three defects: it
// over-included non-X/Y blocks (filter, enhancer, synth, formant, …),
// emitted DISPLAY-form keys ("gate expander", "graphic eq", "volume/pan")
// that don't match the canonical block keys used everywhere else, and never
// deduped multi-instance blocks. An agent keying its params_by_channel
// decision off that list got a failed first apply (the display-form key
// didn't resolve against descriptor.blocks). The list now emits the
// canonical block keys (== AxeFxIIParam.block), deduped and sorted.
const XY_CHANNEL_GROUP_CODES: ReadonlySet<string> = new Set([
  'AMP', 'CAB', 'CHO', 'CPR', 'DLY', 'DRV', 'FLG', 'GEQ', 'GTE',
  'MIX', 'PEQ', 'PHA', 'PIT', 'ROT', 'REV', 'TRM', 'WAH',
]);
// The executor's per-channel write path requires a bypassable block, so the
// advertised list must match what apply actually accepts. Mixer (MIX) is the
// one wiki-listed X/Y group that is non-bypassable on the II — the hardware
// supports X/Y on it, but our apply path can't author it, so intersecting
// with the bypassable set drops it (advertise only what apply accepts).
const BYPASSABLE_GROUP_CODES: ReadonlySet<string> = new Set(
  AXE_FX_II_BLOCKS.filter((b) => b.canBypass).map((b) => b.groupCode.toUpperCase()),
);
const CHANNEL_BLOCKS: readonly string[] = Object.freeze(
  Array.from(
    new Set(
      (Object.values(KNOWN_PARAMS) as readonly AxeFxIIParam[])
        .filter((p) => {
          const g = p.groupCode.toUpperCase();
          return XY_CHANNEL_GROUP_CODES.has(g) && BYPASSABLE_GROUP_CODES.has(g);
        })
        .map((p) => p.block),
    ),
  ).sort(),
);

/**
 * Working `apply_preset` payload literal for the unified surface. Axe-Fx II
 * uses {row, col} grid slot refs and X/Y channels on channel-bearing blocks.
 * Every value is in the device's display vocabulary (knob 0..10, canonical
 * upper-case enum spelling per AxeEdit). The spec passes
 * `collectApplyPresetPreflight` with zero errors (verified by
 * `scripts/verify-describe-device.ts`).
 */
/**
 * Two amp slots in this example demonstrate scene-channel referencing
 * with the canonical auto-derived ids: `amp` (instance 1, the default,
 * suffix dropped) and `amp_2` (instance 2). Scene `channels` / routing
 * `from` / routing `to` always key by these underscore-form ids — NOT
 * display forms like "Amp 1" / "Amp 2", NOT the literal block_type
 * when multiple instances exist. The preflight resolver also accepts
 * the leniency form `amp_1`, the display form `Amp 1`, and bare
 * `amp` when unambiguous, but the canonical form shown here is the
 * one to copy.
 */
const AXEFX2_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params_by_channel: {
        X: { effect_type: 'TUBE DRV 3-KNOB', gain: 3, tone: 6, volume: 5 },
      },
    },
    {
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      // instance: 1 implicit; auto-derived id = "amp" (no _1 suffix).
      params_by_channel: {
        X: { effect_type: 'USA CLEAN', input_drive: 3, master_volume: 5 },
        Y: { effect_type: 'USA IIC+', input_drive: 6, master_volume: 4 },
      },
    },
    {
      slot: { row: 2, col: 3 },
      block_type: 'amp',
      instance: 2,
      // instance: 2 → auto-derived id = "amp_2". Reference under this id
      // in scenes[].channels and routing edges below.
      params_by_channel: {
        X: { effect_type: 'BRIT JM45', input_drive: 5, master_volume: 5 },
      },
    },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 5 },
      block_type: 'reverb',
      params_by_channel: {
        X: { effect_type: 'MEDIUM PLATE', mix: 25 },
      },
    },
  ],
  scenes: [
    // channels[] keys are slot ids: "amp" (instance 1), "amp_2"
    // (instance 2). Verbatim form to copy when authoring scenes.
    { scene: 1, name: 'Clean', channels: { amp: 'X', amp_2: 'X', reverb: 'X' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'Y', amp_2: 'X', reverb: 'X' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

/**
 * Curated top-N first-page knob list per Axe-Fx II block.
 *
 * Source: AxeEdit page-1 controls per block. Each list is in the II's
 * canonical spelling (note: II uses `effect_type` not `type`,
 * `master_volume` not `master`, `volume` not `level` for drive).
 * Excludes bypass, balance, bypass_mode, globalmix (advanced page),
 * and per-tap multidelay parameters.
 */
const AXEFX2_BLOCK_PARAMS_SUMMARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amp: ['effect_type', 'input_drive', 'bass', 'middle', 'treble', 'presence', 'master_volume', 'level'],
  drive: ['effect_type', 'gain', 'tone', 'volume', 'mix', 'bass', 'middle', 'treble'],
  reverb: ['effect_type', 'mix', 'time', 'predelay', 'size', 'high_cut', 'level'],
  delay: ['effect_type', 'time', 'feedback', 'mix', 'low_cut', 'high_cut', 'level'],
  chorus: ['effect_type', 'rate', 'depth', 'mix', 'level'],
  flanger: ['effect_type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  phaser: ['effect_type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  wah: ['effect_type', 'freq_min', 'freq_max', 'resonance', 'control', 'level'],
  compressor: ['effect_type', 'threshold', 'ratio', 'attack', 'release', 'level', 'mix'],
  pitch: ['effect_type', 'mode', 'voice_1_harmony', 'voice_2_harmony', 'key', 'scale', 'mix', 'level'],
  cab: ['cab', 'mic', 'low_cut', 'high_cut', 'level', 'proximity'],
  pantrem: ['effect_type', 'rate', 'depth', 'duty', 'mix', 'level'],
  filter: ['effect_type', 'frequency', 'q', 'gain', 'level'],
  enhancer: ['effect_type', 'width', 'depth', 'level'],
  gateexpander: ['threshold', 'attack', 'hold', 'release', 'ratio', 'level'],
  rotary: ['rate', 'low_depth', 'hi_depth', 'drive', 'mix', 'level'],
  volpan: ['volume', 'pan_left', 'pan_right', 'level'],
  ringmod: ['mix', 'level'],
  formant: ['mix', 'level'],
  synth: ['mix', 'level'],
  multidelay: ['time_1', 'feedback_1', 'level_1', 'time_2', 'feedback_2', 'level_2'],
});

/**
 * find_compatible_types wrapper — delegates to the codec and adds the
 * dispatcher-shape fields. Wiring this makes the dispatcher's STRUCTURED
 * path fire (real per-type narrowing for the blocks whose applicability
 * table has primary-type gates: compressor + multidelay) instead of the
 * unfiltered fallback. See `fractal-midi/gen2/axe-fx-ii` applicability.
 */
function findCompatibleTypes(query: CompatibleTypesQuery): CompatibleTypesResult {
  const r = axefx2FindCompatibleTypes(query.block, query.params);
  return {
    block: query.block,
    params_queried: query.params,
    compatible_types: r.compatible_types,
    total_types: r.total_types,
    applicability_known: r.applicability_known,
    note: r.note,
  };
}

export const AXEFX2_DESCRIPTOR: DeviceDescriptor = {
  id: 'axe-fx-ii',
  display_name: 'Fractal Axe-Fx II XL+',
  preset_class: 'layout',
  connection_label: 'axe-fx-ii',
  port_match: [
    { pattern: /axe-?fx/i },
  ],
  capabilities: {
    slot_model: 'grid',
    grid: { rows: 4, cols: 12 },
    has_scenes: true,
    scene_count: 8,
    has_channels: true,
    channel_names: ['X', 'Y'],
    channel_blocks: CHANNEL_BLOCKS,
    // Multiple instances per block type (Amp 1/2, Reverb 1..4, etc.) are
    // addressable via the `instance` arg; writer/reader resolve them with
    // resolveBlockWithInstance.
    has_block_instances: true,
    // 1-indexed display slot (1..16384). Coarse digit gate (no leading zero,
    // not 0); parseAxeFxIILocation enforces the exact 1..16384 upper bound.
    preset_location_format: /^[1-9]\d{0,4}$/,
    supports_save: true,
    supports_lineage: true,
    atomic_read: true,
  },
  canonical_terms: {
    block: 'block',
    slot: 'grid location (row 1..4, col 1..12)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel X/Y',
    location: '1-indexed display slot 1..16384 (matches the front panel; wire is 0-indexed internally)',
  },
  blocks: buildBlocks(),
  block_types: buildBlockTypes(),
  findCompatibleTypes,
  reader,
  writer,
  agent_guidance: AXEFX2_AGENT_GUIDANCE,
  example_spec: AXEFX2_EXAMPLE_SPEC,
  block_params_summary: AXEFX2_BLOCK_PARAMS_SUMMARY,
  concept_keys: AXEFX2_CONCEPT_KEYS,
  // Tempo-lock map: a non-NONE `tempo` enum locks the block's timing
  // param and silently ignores absolute writes to it. Drives the
  // co-write advisory in the dispatcher (see tempoLock.ts).
  tempo_locked_params: {
    'delay.time': 'delay.tempo',
    'chorus.rate': 'chorus.tempo',
    'flanger.rate': 'flanger.tempo',
    'phaser.rate': 'phaser.tempo',
    'pantrem.rate': 'pantrem.tempo',
  },
};
