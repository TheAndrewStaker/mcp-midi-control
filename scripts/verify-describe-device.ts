/**
 * Golden: describe_device exposes a working `example_spec` for every
 * registered device, and each example_spec validates against the
 * unified apply_preset preflight with zero errors.
 *
 * Rationale: agents reconstructing apply_preset payloads from prose
 * rules drop scenes, mix up channel keys, and guess at enum spellings.
 * The fix is a starting payload per device that the agent can clone
 * verbatim. This golden is the mechanical guard that those payloads
 * stay valid as the descriptors evolve. If a block rename, enum
 * spelling change, or param-catalog edit breaks the example, this
 * golden fails and the descriptor author updates the example_spec in
 * the same commit.
 *
 * Run via:  npx tsx scripts/verify-describe-device.ts
 */

import {
  describeDevice,
  describeDeviceGuidance,
  collectApplyPresetPreflight,
} from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  clearRegistry,
  registerDevice,
} from '@mcp-midi-control/core/protocol-generic/registry.js';
import { buildPresetShape } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/descriptor.js';
import { FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

// Register all four descriptors against the runtime registry so
// describeDevice(port) resolves cleanly. Order matches src/server/index.ts:
// Axe-Fx III then II then AM4 then Hydra.
clearRegistry();
registerDevice(AXEFX3_DESCRIPTOR);
registerDevice(FM3_DESCRIPTOR);
registerDevice(FM9_DESCRIPTOR);
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AM4_DESCRIPTOR);
registerDevice(HYDRASYNTH_DESCRIPTOR);

interface DeviceCase {
  port: string;
  descriptor: typeof AM4_DESCRIPTOR;
  expectScenes: boolean;
}

const cases: DeviceCase[] = [
  { port: 'am4', descriptor: AM4_DESCRIPTOR, expectScenes: true },
  { port: 'axe-fx-ii', descriptor: AXEFX2_DESCRIPTOR, expectScenes: true },
  { port: 'axe-fx-iii', descriptor: AXEFX3_DESCRIPTOR, expectScenes: true },
  // The whole modern family, not just the III stand-in: FM3/FM9 must
  // carry the same tempo-first + example_spec parity.
  { port: 'fm3', descriptor: FM3_DESCRIPTOR, expectScenes: true },
  { port: 'fm9', descriptor: FM9_DESCRIPTOR, expectScenes: true },
  { port: 'hydrasynth', descriptor: HYDRASYNTH_DESCRIPTOR, expectScenes: false },
];

for (const c of cases) {
  console.log(`\nDevice: ${c.port}`);

  const response = describeDevice(c.port);
  check(
    `describe_device(${c.port}) returns a response object`,
    response !== undefined && response !== null,
  );

  // Contract: example_spec is REQUIRED on devices that target the
  // unified apply_preset tool, FORBIDDEN on devices that don't.
  // Hydrasynth uses apply_patch separately and intentionally
  // omits example_spec — surfacing one would mislead agents into
  // authoring apply_preset calls the schema rejects.
  const targetsApplyPreset = c.descriptor.writer.applyPreset !== undefined;
  if (targetsApplyPreset) {
    check(
      `describe_device(${c.port}).example_spec is present (device targets apply_preset)`,
      response.example_spec !== undefined,
      `response keys: ${Object.keys(response).join(', ')}`,
    );
  } else {
    check(
      `describe_device(${c.port}).example_spec is absent (device uses a separate apply path)`,
      response.example_spec === undefined,
      `unexpected example_spec on ${c.port} — agents will be misled to apply_preset which doesn't support this device's blocks`,
    );
  }

  // Tempo-first guidance parity: every device carries a
  // `tempo_time_discipline` topic in agent_guidance, and it must be REACHABLE
  // from the tool surface — either inline in describe_device, or named in
  // `agent_guidance_withheld` and served by describe_device({port,
  // guidance:true}). Checked before the example_spec `continue` so Hydrasynth
  // is covered.
  //
  // The two-path form is not a loosening. `describeDevice` now holds guidance
  // topics back when a response would otherwise cross the host's tool-result
  // delivery cliff (50,000 chars, above which the model receives a
  // stub and NOTHING else). Asserting only the inline path would have this
  // check pass on a device whose whole payload is being thrown away and fail
  // on one that is being delivered correctly, which is backwards. So: assert
  // the topic is reachable, and assert the pointer is honest when it is not
  // inline.
  const inlineTopic = response.agent_guidance?.tempo_time_discipline;
  const withheldTopics = response.agent_guidance_withheld?.topics ?? [];
  const fetched = describeDeviceGuidance(c.port).agent_guidance?.tempo_time_discipline;
  check(
    `${c.port} agent_guidance carries tempo_time_discipline`,
    typeof fetched === 'string' && fetched.length > 0,
    `describe_device({port:"${c.port}", guidance:true}) keys: ${Object.keys(describeDeviceGuidance(c.port).agent_guidance ?? {}).join(', ')}`,
  );
  check(
    `${c.port} tempo_time_discipline is inline, or named in agent_guidance_withheld`,
    (typeof inlineTopic === 'string' && inlineTopic.length > 0)
      || withheldTopics.includes('tempo_time_discipline'),
    `not inline and not listed as withheld. withheld: [${withheldTopics.join(', ')}]`,
  );

  if (response.example_spec === undefined) continue;
  const spec: PresetSpec = response.example_spec;

  check(
    `${c.port} example_spec carries at least one slot`,
    Array.isArray(spec.slots) && spec.slots.length >= 1,
    `slots: ${spec.slots?.length}`,
  );

  if (c.expectScenes) {
    check(
      `${c.port} example_spec covers at least 2 scenes (per descriptor contract)`,
      Array.isArray(spec.scenes) && spec.scenes.length >= 2,
      `scenes: ${spec.scenes?.length ?? 0}`,
    );
  }

  // Feed the example back into the dispatcher preflight against the
  // same device. Zero errors means the example is a usable apply_preset
  // payload right now, with no synthetic rewrites needed.
  const preflight = collectApplyPresetPreflight(spec, c.descriptor);
  check(
    `${c.port} example_spec passes preflight with zero errors`,
    preflight.errors.length === 0,
    preflight.errors.map((e) => `${e.path}: ${e.error}`).join(' | '),
  );

  // Feed the example through the apply_preset INPUT SCHEMA (zod parse)
  // for devices that target the unified apply_preset tool. Hydrasynth
  // uses a separate apply_patch tool (no writer.applyPreset, empty
  // block_types) so its example_spec is preflight-shaped but intentionally
  // not parseable against apply_preset's cross-device discriminated union.
  // This check catches a different class of regression than preflight: a
  // spec that passes preflight but fails zod parse means agents copying
  // the example verbatim get rejected by the protocol before the
  // dispatcher ever runs. Caught the III wire-int-vs-enum-string
  // regression when SEP-1330 enum schemas first shipped (2026-05-23).
  if (targetsApplyPreset) {
    const presetShape = buildPresetShape();
    const parseResult = presetShape.safeParse(spec);
    check(
      `${c.port} example_spec parses against apply_preset inputSchema`,
      parseResult.success,
      parseResult.success
        ? undefined
        : parseResult.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message.slice(0, 80)}`)
          .join(' | '),
    );
  }

  // Sanity: every block_type in the spec actually exists in the
  // descriptor's blocks map. Catches a future rename that the
  // preflight might tolerate via alias resolution but that would
  // confuse an agent reading the example.
  for (const slot of spec.slots) {
    const blockType = slot.block_type;
    if (blockType === 'none' || blockType === 'empty' || blockType === '') continue;
    check(
      `${c.port} example slot block_type "${blockType}" exists in descriptor.blocks`,
      c.descriptor.blocks[blockType] !== undefined,
      `descriptor.blocks keys (first 10): ${Object.keys(c.descriptor.blocks).slice(0, 10).join(', ')}`,
    );
  }
}

// ── channel_blocks contract ─────────────────────────────────────────
// Every entry in capabilities.channel_blocks must be a canonical block
// key that exists in descriptor.blocks (NOT a display-form name like
// "graphic eq" or "volume/pan"), and the list must be duplicate-free.
// Agents key the params-vs-params_by_channel apply decision off this
// list; a display-form or duplicated entry causes a failed first apply.
console.log('\nchannel_blocks contract (canonical keys, deduped):');
for (const c of cases) {
  const list = c.descriptor.capabilities.channel_blocks;
  if (list === undefined) continue;
  check(
    `${c.port} channel_blocks has no duplicates`,
    new Set(list).size === list.length,
    `list: ${JSON.stringify(list)}`,
  );
  for (const key of list) {
    check(
      `${c.port} channel_blocks entry "${key}" is a canonical key in descriptor.blocks`,
      c.descriptor.blocks[key] !== undefined,
      `descriptor.blocks keys (first 12): ${Object.keys(c.descriptor.blocks).slice(0, 12).join(', ')}`,
    );
  }
}

// Pin the Axe-Fx II XL+ curated X/Y set (Fractal wiki "Channels" page,
// XL/XL+ row, intersected with bypassable blocks the executor accepts).
// If this drifts, the descriptor author re-confirms against the wiki and
// updates both the set and this golden in the same commit.
const EXPECTED_AXEFX2_CHANNEL_BLOCKS = [
  'amp', 'cab', 'chorus', 'compressor', 'delay', 'drive', 'flanger',
  'gateexpander', 'graphiceq', 'pantrem', 'parametriceq', 'phaser',
  'pitch', 'reverb', 'rotary', 'wah',
];
check(
  'axe-fx-ii channel_blocks matches the curated XL+ X/Y set',
  JSON.stringify(AXEFX2_DESCRIPTOR.capabilities.channel_blocks) ===
    JSON.stringify(EXPECTED_AXEFX2_CHANNEL_BLOCKS),
  `got: ${JSON.stringify(AXEFX2_DESCRIPTOR.capabilities.channel_blocks)}`,
);

console.log('');
if (failed > 0) {
  console.error(`x ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('All describe_device example_spec checks pass.');
