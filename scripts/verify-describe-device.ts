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
  collectApplyPresetPreflight,
} from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  clearRegistry,
  registerDevice,
} from '@mcp-midi-control/core/protocol-generic/registry.js';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/descriptor.js';
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
  { port: 'hydrasynth', descriptor: HYDRASYNTH_DESCRIPTOR, expectScenes: false },
];

for (const c of cases) {
  console.log(`\nDevice: ${c.port}`);

  const response = describeDevice(c.port);
  check(
    `describe_device(${c.port}) returns a response object`,
    response !== undefined && response !== null,
  );

  check(
    `describe_device(${c.port}).example_spec is present`,
    response.example_spec !== undefined,
    `response keys: ${Object.keys(response).join(', ')}`,
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

console.log('');
if (failed > 0) {
  console.error(`x ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log('All describe_device example_spec checks pass.');
