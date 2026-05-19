/**
 * Concept-key golden.
 *
 * Asserts:
 *   1. `resolveConceptKey(port, key)` maps registered concept-keys to
 *      each device's local param name; unknown keys + unsupported
 *      devices both return undefined.
 *   2. `resolveConceptKeyForBlock(port, block, name)` handles the
 *      bare-concept-with-implicit-block form used by the preflight
 *      walker.
 *   3. `listConceptKeysForDevice(port)` exposes the per-device subset
 *      surfaced through `describe_device.concept_keys`.
 *   4. End-to-end through the dispatcher's `resolveParamName` for each
 *      device: concept-keys + device-local names both resolve, and
 *      unknown names surface the Levenshtein "did you mean" error.
 *   5. The preflight walker's normalizedSpec rewrites concept-keys to
 *      the local canonical name for apply_preset, on AM4 + II + III.
 *   6. `describe_device(port).concept_keys` carries the per-device map.
 *   7. The BK-065 alias table still resolves (regression check).
 *
 * Run:  npx tsx scripts/verify-concept-keys.ts
 */

import {
  resolveConceptKey,
  resolveConceptKeyForBlock,
  listConceptKeysForDevice,
} from '@mcp-midi-control/core/protocol-generic/concept-keys.js';
import { resolveParamAlias } from '@mcp-midi-control/core/protocol-generic/cross-device-aliases.js';
import { resolveParamName } from '@mcp-midi-control/core/protocol-generic/dispatcher/resolvers.js';
import { describeDevice } from '@mcp-midi-control/core/protocol-generic/dispatcher/discovery.js';
import { collectApplyPresetPreflight } from '@mcp-midi-control/core/protocol-generic/dispatcher/preflight.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import type {
  DeviceDescriptor,
  PresetSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/descriptor.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';

// Register every device so the dispatcher's `requireDevice` finds them
// during describe_device / preflight tests below.
registerDevice(AM4_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);

let passed = 0;
let failed = 0;

function check(desc: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`OK ${desc}`);
  } else {
    failed += 1;
    console.log(`FAIL ${desc}${detail !== undefined ? `\n      ${detail}` : ''}`);
  }
}

// ── 1. resolveConceptKey: fully-qualified concept-key on each device ──
console.log('-- resolveConceptKey: per-device mapping --');

check(
  'drive.output_level -> II volume',
  resolveConceptKey('axe-fx-ii', 'drive.output_level')?.localName === 'volume',
);
check(
  'drive.output_level -> AM4 level',
  resolveConceptKey('am4', 'drive.output_level')?.localName === 'level',
);
check(
  'drive.output_level -> III level',
  resolveConceptKey('axe-fx-iii', 'drive.output_level')?.localName === 'level',
);
check(
  'amp.preamp_gain -> II input_drive',
  resolveConceptKey('axe-fx-ii', 'amp.preamp_gain')?.localName === 'input_drive',
);
check(
  'amp.preamp_gain -> AM4 gain',
  resolveConceptKey('am4', 'amp.preamp_gain')?.localName === 'gain',
);
check(
  'amp.power_amp_master -> II master_volume',
  resolveConceptKey('axe-fx-ii', 'amp.power_amp_master')?.localName === 'master_volume',
);
check(
  'amp.power_amp_master -> AM4 master',
  resolveConceptKey('am4', 'amp.power_amp_master')?.localName === 'master',
);
check(
  'amp.type -> II effect_type',
  resolveConceptKey('axe-fx-ii', 'amp.type')?.localName === 'effect_type',
);
check(
  'amp.type -> AM4 type',
  resolveConceptKey('am4', 'amp.type')?.localName === 'type',
);
check(
  'filter.cutoff -> Hydrasynth cutoff',
  resolveConceptKey('hydrasynth', 'filter.cutoff')?.localName === 'cutoff',
);
check(
  'env.attack -> Hydrasynth attack (synth-only concept)',
  resolveConceptKey('hydrasynth', 'env.attack')?.localName === 'attack',
);
check(
  'unknown concept-key returns undefined',
  resolveConceptKey('am4', 'amp.no_such_concept') === undefined,
);
check(
  'concept-key without dot returns undefined',
  resolveConceptKey('am4', 'just_a_word') === undefined,
);
check(
  'concept-key on device that does not expose the concept returns undefined',
  resolveConceptKey('am4', 'env.attack') === undefined,
);
check(
  'unknown device returns undefined',
  resolveConceptKey('not-a-device', 'drive.output_level') === undefined,
);

// ── 2. resolveConceptKeyForBlock: bare-concept-with-block form ────────
console.log('\n-- resolveConceptKeyForBlock: bare concept + block context --');

check(
  'output_level + drive on II -> volume',
  resolveConceptKeyForBlock('axe-fx-ii', 'drive', 'output_level')?.localName === 'volume',
);
check(
  'output_level + drive on AM4 -> level',
  resolveConceptKeyForBlock('am4', 'drive', 'output_level')?.localName === 'level',
);
check(
  'preamp_gain + amp on AM4 -> gain',
  resolveConceptKeyForBlock('am4', 'amp', 'preamp_gain')?.localName === 'gain',
);
check(
  'fully-qualified passed via block form still works',
  resolveConceptKeyForBlock('am4', 'amp', 'drive.output_level')?.localName === 'level',
);
check(
  'bare local name (not a concept) returns undefined',
  resolveConceptKeyForBlock('am4', 'drive', 'level') === undefined,
);

// ── 3. listConceptKeysForDevice: per-device subset ────────────────────
console.log('\n-- listConceptKeysForDevice: surface map --');

const am4Map = listConceptKeysForDevice('am4');
const iiMap = listConceptKeysForDevice('axe-fx-ii');
const iiiMap = listConceptKeysForDevice('axe-fx-iii');
const hydraMap = listConceptKeysForDevice('hydrasynth');

check(
  'AM4 map carries drive.output_level',
  am4Map.some((e) => e.conceptKey === 'drive.output_level' && e.localName === 'level'),
);
check(
  'II map carries drive.output_level -> volume',
  iiMap.some((e) => e.conceptKey === 'drive.output_level' && e.localName === 'volume'),
);
check(
  'III map carries amp.power_amp_master -> master',
  iiiMap.some((e) => e.conceptKey === 'amp.power_amp_master' && e.localName === 'master'),
);
check(
  'Hydrasynth map carries env.attack',
  hydraMap.some((e) => e.conceptKey === 'env.attack' && e.localName === 'attack'),
);
check(
  'Hydrasynth map does NOT carry amp.type (Fractal-only concept)',
  !hydraMap.some((e) => e.conceptKey === 'amp.type'),
);

// ── 4. End-to-end through dispatcher's resolveParamName ──────────────
console.log('\n-- resolveParamName: concept-keys + device-local names + unknown --');

function resolveParamSafely(
  desc: DeviceDescriptor,
  block: string,
  name: string,
): { name: string; aliased_from?: string } | { error: string } {
  try {
    return resolveParamName(desc, block, name);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// Device-local names still work unchanged (no regression).
{
  const r = resolveParamSafely(AM4_DESCRIPTOR, 'drive', 'level');
  check(
    'AM4 drive.level (device-local) resolves to level',
    'name' in r && r.name === 'level' && r.aliased_from === undefined,
    JSON.stringify(r),
  );
}
{
  const r = resolveParamSafely(AXEFX2_DESCRIPTOR, 'drive', 'volume');
  check(
    'II drive.volume (device-local) resolves to volume',
    'name' in r && r.name === 'volume' && r.aliased_from === undefined,
    JSON.stringify(r),
  );
}

// Concept-keys resolve to the device-local name.
{
  const r = resolveParamSafely(AM4_DESCRIPTOR, 'drive', 'output_level');
  check(
    'AM4 drive.output_level (concept-key) resolves to level',
    'name' in r && r.name === 'level' && r.aliased_from === 'output_level',
    JSON.stringify(r),
  );
}
{
  const r = resolveParamSafely(AXEFX2_DESCRIPTOR, 'drive', 'output_level');
  check(
    'II drive.output_level (concept-key) resolves to volume',
    'name' in r && r.name === 'volume' && r.aliased_from === 'output_level',
    JSON.stringify(r),
  );
}
{
  const r = resolveParamSafely(AM4_DESCRIPTOR, 'amp', 'power_amp_master');
  check(
    'AM4 amp.power_amp_master (concept-key) resolves to master',
    'name' in r && r.name === 'master' && r.aliased_from === 'power_amp_master',
    JSON.stringify(r),
  );
}
{
  const r = resolveParamSafely(AXEFX2_DESCRIPTOR, 'amp', 'preamp_gain');
  check(
    'II amp.preamp_gain (concept-key) resolves to input_drive',
    'name' in r && r.name === 'input_drive' && r.aliased_from === 'preamp_gain',
    JSON.stringify(r),
  );
}

// BK-065 per-pair alias still works (regression check).
{
  const r = resolveParamSafely(AM4_DESCRIPTOR, 'drive', 'volume');
  check(
    'AM4 drive.volume (BK-065 alias) still resolves to level',
    'name' in r && r.name === 'level' && r.aliased_from === 'volume',
    JSON.stringify(r),
  );
}
{
  const r = resolveParamSafely(AXEFX2_DESCRIPTOR, 'drive', 'level');
  check(
    'II drive.level (BK-065 alias) still resolves to volume',
    'name' in r && r.name === 'volume' && r.aliased_from === 'level',
    JSON.stringify(r),
  );
}
{
  // Confirm the alias table data path is independent of concept-keys.
  const r = resolveParamAlias('am4', 'drive', 'volume');
  check(
    'BK-065 alias data: am4 drive.volume -> level (unchanged)',
    r.canonical === 'level' && r.aliasUsed === 'volume',
    JSON.stringify(r),
  );
}

// Unknown concept-key produces a "did you mean..." style error.
{
  const r = resolveParamSafely(AM4_DESCRIPTOR, 'drive', 'mysterious_knob');
  check(
    'unknown name surfaces did-you-mean suggestion path',
    'error' in r && /did you mean|known params|Did you mean/i.test(r.error),
    JSON.stringify(r),
  );
}

// ── 5. End-to-end through preflight (apply_preset path) ──────────────
console.log('\n-- collectApplyPresetPreflight: concept-keys in apply_preset --');

function preflightConceptKey(
  desc: DeviceDescriptor,
  spec: PresetSpec,
): { ok: boolean; normalized: PresetSpec; infoCount: number; errorCount: number } {
  const r = collectApplyPresetPreflight(spec, desc);
  return {
    ok: r.errors.length === 0,
    normalized: r.normalized_spec,
    infoCount: r.info.length,
    errorCount: r.errors.length,
  };
}

// AM4: drive.output_level (concept-key) should normalize to drive.level.
{
  const spec: PresetSpec = {
    slots: [
      { slot: 1, block_type: 'drive', params: { A: { output_level: 5, gain: 3, color_tone: 6 } } },
    ],
  };
  const r = preflightConceptKey(AM4_DESCRIPTOR, spec);
  const params = (r.normalized.slots[0].params as Record<string, Record<string, unknown>>).A;
  check(
    'AM4 apply_preset: drive.output_level normalized to drive.level',
    r.ok && params.level === 5 && params.drive === 3 && params.tone === 6,
    `errors=${r.errorCount} info=${r.infoCount} normalized.params=${JSON.stringify(params)}`,
  );
}

// II: drive.output_level (concept-key) should normalize to drive.volume.
{
  const spec: PresetSpec = {
    slots: [
      {
        slot: { row: 2, col: 1 },
        block_type: 'drive',
        params: { X: { output_level: 5, gain: 3, color_tone: 6 } },
      },
    ],
  };
  const r = preflightConceptKey(AXEFX2_DESCRIPTOR, spec);
  const params = (r.normalized.slots[0].params as Record<string, Record<string, unknown>>).X;
  check(
    'II apply_preset: drive.output_level normalized to drive.volume',
    r.ok && params.volume === 5 && params.gain === 3 && params.tone === 6,
    `errors=${r.errorCount} info=${r.infoCount} normalized.params=${JSON.stringify(params)}`,
  );
}

// III: amp.power_amp_master normalizes to amp.master.
// III's amp block has no parameter catalog mined (post-v1.13 firmware
// addition), so we use drive.output_level for the III check instead.
{
  const spec: PresetSpec = {
    slots: [
      {
        slot: { row: 2, col: 1 },
        block_type: 'drive',
        params: { A: { output_level: 32767 } },
      },
    ],
  };
  const r = preflightConceptKey(AXEFX3_DESCRIPTOR, spec);
  const params = (r.normalized.slots[0].params as Record<string, Record<string, unknown>>).A;
  check(
    'III apply_preset: drive.output_level normalized to drive.level',
    r.ok && params.level === 32767,
    `errors=${r.errorCount} info=${r.infoCount} normalized.params=${JSON.stringify(params)}`,
  );
}

// Device-local names in apply_preset still work (no regression).
{
  const spec: PresetSpec = {
    slots: [{ slot: 1, block_type: 'drive', params: { A: { level: 5 } } }],
  };
  const r = preflightConceptKey(AM4_DESCRIPTOR, spec);
  const params = (r.normalized.slots[0].params as Record<string, Record<string, unknown>>).A;
  check(
    'AM4 apply_preset: device-local drive.level still works',
    r.ok && params.level === 5,
    `errors=${r.errorCount} normalized=${JSON.stringify(params)}`,
  );
}

// BK-065 per-pair alias in apply_preset still works (regression).
{
  const spec: PresetSpec = {
    slots: [{ slot: 1, block_type: 'drive', params: { A: { volume: 5 } } }],
  };
  const r = preflightConceptKey(AM4_DESCRIPTOR, spec);
  const params = (r.normalized.slots[0].params as Record<string, Record<string, unknown>>).A;
  check(
    'AM4 apply_preset: BK-065 alias drive.volume -> drive.level still works',
    r.ok && params.level === 5,
    `errors=${r.errorCount} normalized=${JSON.stringify(params)}`,
  );
}

// Unknown concept-key surfaces a validation error naming the unknown param.
{
  const spec: PresetSpec = {
    slots: [{ slot: 1, block_type: 'drive', params: { A: { not_a_concept_key: 5 } } }],
  };
  const r = collectApplyPresetPreflight(spec, AM4_DESCRIPTOR);
  check(
    'AM4 apply_preset: unknown name produces validation_error',
    r.errors.length === 1
      && /unknown param/i.test(r.errors[0].error)
      && r.errors[0].path.includes('not_a_concept_key'),
    `errors=${JSON.stringify(r.errors)}`,
  );
}

// ── 6. describe_device exposes concept_keys ──────────────────────────
console.log('\n-- describe_device.concept_keys --');

{
  const am4 = describeDevice('am4');
  const ii = describeDevice('axe-fx-ii');
  const iii = describeDevice('axe-fx-iii');
  const hydra = describeDevice('hydrasynth');
  check(
    'describe_device(am4).concept_keys carries drive.output_level=level',
    am4.concept_keys?.['drive.output_level'] === 'level',
  );
  check(
    'describe_device(axe-fx-ii).concept_keys carries drive.output_level=volume',
    ii.concept_keys?.['drive.output_level'] === 'volume',
  );
  check(
    'describe_device(axe-fx-iii).concept_keys carries amp.power_amp_master=master',
    iii.concept_keys?.['amp.power_amp_master'] === 'master',
  );
  check(
    'describe_device(hydrasynth).concept_keys carries env.attack=attack',
    hydra.concept_keys?.['env.attack'] === 'attack',
  );
  check(
    'describe_device(hydrasynth).concept_keys does NOT carry amp.type',
    hydra.concept_keys?.['amp.type'] === undefined,
  );
}

// ── Done ─────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${passed}/${total} cases pass.`);
if (failed > 0) process.exit(1);
