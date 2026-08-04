/**
 * AM4 DeviceDescriptor — top-level assembler for the BK-051 unified tool
 * surface.
 *
 * Wraps the existing AM4 protocol code (params.ts, blockTypes.ts,
 * setParam.ts, locations.ts) into the `DeviceDescriptor` contract from
 * `src/protocol/generic/types.ts`. The wire layer is byte-frozen — no
 * code under `src/fractal/am4/` outside this descriptor directory is
 * modified. This file is the translation layer between the legacy
 * direct-call shape and the dispatcher-routed shape.
 *
 * Coexists with `src/fractal/am4/device.ts` (the Fractal-protocol-layer
 * `FractalDevice` instance used by the cross-Fractal device registry).
 * Both registries hold an AM4 entry; they serve different layers.
 *
 * Split into a per-role directory (Session 65) so the writer object
 * (~720 LOC of execute methods + pure builders) doesn't sit alongside
 * the reader, schema helpers, and the top-level descriptor literal:
 *
 *   - `descriptor/schema.ts`  — makeEncode / makeDecode / buildBlocks /
 *                                buildBlockTypes / parseAm4Location
 *   - `descriptor/writer.ts`  — DeviceWriter (14 methods)
 *   - `descriptor/reader.ts`  — DeviceReader (4 methods)
 *
 * Consumers continue to import `AM4_DESCRIPTOR` from
 * `@/fractal/am4/descriptor.js`; the directory split is internal.
 */

import type {
  CompatibleTypesQuery,
  CompatibleTypesResult,
  DeviceDescriptor,
  PresetSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { findCompatibleTypes as am4FindCompatibleTypes } from 'fractal-midi/am4';
import { TOTAL_LOCATIONS } from 'fractal-midi/am4';

import { listConceptKeysForDevice } from '@mcp-midi-control/core/protocol-generic/concept-keys.js';

import { AM4_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';
import { buildBlocks, buildBlockTypes } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';

/**
 * Per-device concept-key map. Built from the central registry in
 * `concept-keys.ts`. Surfaced via `describe_device.concept_keys` so the
 * agent can read the canonical concept-key -> local-name map in one call.
 */
const AM4_CONCEPT_KEYS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const entry of listConceptKeysForDevice('am4')) {
    out[entry.conceptKey] = entry.localName;
  }
  return Object.freeze(out);
})();

function findCompatibleTypes(query: CompatibleTypesQuery): CompatibleTypesResult {
  const r = am4FindCompatibleTypes(query.block, query.params);
  return {
    block: query.block,
    params_queried: query.params,
    compatible_types: r.compatible_types,
    total_types: r.total_types,
    applicability_known: r.applicability_known,
    note: r.note,
  };
}

/**
 * Working `apply_preset` payload literal the agent can clone. AM4 uses
 * linear bare-int slots 1..4 and A/B/C/D channels on amp/drive/reverb/delay.
 * Every value here is in the device's display vocabulary (knob 0..10,
 * canonical enum spelling); the spec passes `collectApplyPresetPreflight`
 * with zero errors (verified by `scripts/verify-describe-device.ts`).
 */
const AM4_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      slot: 1,
      block_type: 'drive',
      params_by_channel: {
        A: { type: 'Tube Drive 3-Knob', drive: 3, tone: 6, level: 5 },
      },
    },
    {
      slot: 2,
      block_type: 'amp',
      params_by_channel: {
        A: { type: 'USA Pre Clean', gain: 3, master: 5 },
        B: { type: 'USA MK IIC+', gain: 6, master: 4 },
      },
    },
    {
      slot: 3,
      block_type: 'reverb',
      params_by_channel: {
        A: { type: 'Hall, Medium', mix: 25 },
      },
    },
    {
      slot: 4,
      block_type: 'delay',
      params_by_channel: {
        A: { type: 'Digital Stereo', mix: 15 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'A', reverb: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'B', reverb: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

/**
 * Curated top-N first-page knob list per AM4 block.
 *
 * Source: AM4-Edit front-panel page-1 controls + `docs/BLOCK-PARAMS.md`
 * + the loudness corpus. Each list is the daily-use subset a player
 * adjusts when tone-building, in AM4's canonical spelling. Advanced-page
 * knobs (GEQ bands, sidechain detail, modifier wiring) live in
 * `list_params` — not here.
 *
 * Cross-device convention: keep amp/drive/reverb/delay/chorus structure
 * parallel across AM4 / II / III so the agent's intuition transfers.
 */
const AM4_BLOCK_PARAMS_SUMMARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amp: ['type', 'gain', 'bass', 'mid', 'treble', 'presence', 'master', 'level'],
  drive: ['type', 'drive', 'tone', 'level', 'mix', 'bass', 'mid', 'treble'],
  reverb: ['type', 'mix', 'time', 'pre_delay', 'size', 'high_decay'],
  delay: ['type', 'time', 'feedback', 'mix', 'low_cut', 'high_cut'],
  chorus: ['type', 'rate', 'depth', 'mix', 'level'],
  flanger: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  phaser: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  wah: ['type', 'min_frequency', 'max_frequency', 'q_resonance', 'wah_control', 'mix'],
  compressor: ['type', 'threshold', 'ratio', 'attack', 'release', 'mix'],
  filter: ['type', 'freq', 'q', 'gain', 'mix'],
  tremolo: ['type', 'rate', 'depth', 'duty', 'shape'],
  enhancer: ['type', 'width', 'depth', 'level'],
  gate: ['threshold', 'attack', 'hold', 'release', 'ratio', 'level'],
  volpan: ['mode', 'volume', 'pan_left', 'pan_right', 'level'],
  rotary: ['rate', 'low_depth', 'high_depth', 'drive', 'level', 'mic_distance'],
  ingate: ['threshold', 'attack', 'release', 'ratio', 'level'],
  geq: ['type', 'level', 'mix'],
  peq: ['mix'],
});

export const AM4_DESCRIPTOR: DeviceDescriptor = {
  id: 'am4',
  display_name: 'Fractal AM4',
  preset_class: 'layout',
  connection_label: 'am4',                      // matches AM4_LABEL in connections.ts
  port_match: [
    { pattern: /AM4/i },
    { pattern: /Fractal/i },
  ],
  capabilities: {
    slot_model: 'linear',
    slot_count: 4,
    // Declared explicitly rather than inheriting the dispatcher's `?? 'verified'`
    // default: the default lands on the right answer here by luck, and a future
    // change to it would move this device's advertised status silently. The
    // contribution-guide gate requires an explicit declaration on every
    // registered descriptor.
    support_tier: 'verified',
    has_scenes: true,
    scene_count: 4,
    has_channels: true,
    channel_names: ['A', 'B', 'C', 'D'],
    channel_blocks: ['amp', 'drive', 'reverb', 'delay'],
    preset_location_format: /^[A-Z]0?[1-4]$/,
    supports_save: true,
    supports_lineage: true,
    // atomic_read=true: the fn 0x1F wire primitive
    // (`readAllParams` in shared/readOps.ts) returns a per-block u16
    // chunk where position == pidHigh — hardware-validated 53/53 across
    // 17 audio blocks (Session 122 amp probe + 2026-05-22 all-blocks
    // probe, samples/captured/decoded/am4-fn1f-all-blocks-position-map.json).
    // `reader.getPreset` reads the layout, then one chunk per pidLow per
    // placed slot, then decodes `chunk[pidHigh]` via the same `am4Decode`
    // path `get_param` uses. ~250 ms for a full 4-slot preset snapshot
    // covering every documented param across every placed block (cold-
    // start: 263 ms; warm with include_channel_state: 129 ms). Output
    // round-trips through `get_param` byte-exactly (cross-check probe
    // `scripts/_research/probe-am4-get-preset-roundtrip.ts`).
    // The 4 `*.channel` selectors (amp/drive/reverb/delay, pidHigh=0x7d2)
    // live outside the chunk; emitted via per-paramId GET only when
    // `include_channel_state: true`, mirroring II's pattern.
    atomic_read: true,
    // NOTE: this descriptor should also declare `capabilities.backup`
    // ({ unit_label: 'preset', first_location: 0, last_location:
    // TOTAL_LOCATIONS - 1, seconds_per_unit: 0.6, restore_tool:
    // 'import_preset' }), which is what lets `backup_device` sweep the whole
    // device without the caller knowing the AM4 holds 104 presets. It is
    // withheld only because this package typechecks against the core
    // package's BUILT `dist/*.d.ts`, and the field cannot be referenced until
    // core is rebuilt. Until then `resolveBackupPolicy` derives a correct but
    // bounds-less policy, so a sweep works and simply asks for from/to.
  },
  canonical_terms: {
    block: 'block',
    slot: 'slot 1..4',
    preset: 'preset',
    scene: 'scene 1..4',
    channel: 'channel A/B/C/D',
    location: `location A1..Z4 (${TOTAL_LOCATIONS} total: banks A..Z × 4 per bank; device front-panel shows the unpadded form, e.g. "A1", "M3", "Z4")`,
  },
  blocks: buildBlocks(),
  block_types: buildBlockTypes(),
  reader,
  writer,
  agent_guidance: AM4_AGENT_GUIDANCE,
  block_params_summary: AM4_BLOCK_PARAMS_SUMMARY,
  concept_keys: AM4_CONCEPT_KEYS,
  // Tempo-lock map: a non-NONE `tempo` enum locks the block's timing
  // param and silently ignores absolute writes to it. Drives the
  // co-write advisory in the dispatcher (see tempoLock.ts).
  tempo_locked_params: {
    'delay.time': 'delay.tempo',
    'chorus.rate': 'chorus.tempo',
    'flanger.rate': 'flanger.tempo',
    'phaser.rate': 'phaser.tempo',
    'tremolo.rate': 'tremolo.tempo',
  },
  findCompatibleTypes,
  example_spec: AM4_EXAMPLE_SPEC,
};
