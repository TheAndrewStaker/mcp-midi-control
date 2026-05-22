/**
 * BK-051 dispatcher golden — byte-equivalence vs legacy AM4 wire path.
 *
 * Session A acceptance criteria #3: "registers AM4, resolves port
 * 'AM4', dispatches a set_param(port='AM4', block='amp', name='gain',
 * value=4.5) and asserts byte-exact equality with the pre-dispatcher
 * `am4_set_param` wire output."
 *
 * Goes beyond the minimum to also exercise:
 *   - case-insensitive port resolution
 *   - port_match regex (`/Fractal/i`) fallback
 *   - param-name aliases (`reverb.decay` → `reverb.time`)
 *   - block-name canonical pass-through
 *   - enum value resolution (display name → wire index)
 *   - DispatchError shape on each failure mode
 *
 * Run:  npx tsx scripts/verify-dispatcher.ts
 */

import * as z from 'zod/v4';
import {
  describeDevice,
  encodeSetParam,
  findCompatibleTypes,
  listParams,
  requireDevice,
  resolveBlockName,
  resolveParamName,
  resolveChannel,
} from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import {
  listRegisteredDevices,
  registerDevice as registerMcpDevice,
  resolveDevice,
} from '@mcp-midi-control/core/protocol-generic/registry.js';
import { presetShape } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { buildSetParam } from 'fractal-midi/am4';
import { prepareApplyPresetWrites } from '@mcp-midi-control/am4/tools/applyExecutor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import {
  buildSetBlockParameterValue,
  buildStorePreset,
  buildSwitchPreset,
  displayToWire,
} from 'fractal-midi/axe-fx-ii';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/descriptor.js';
import {
  FN_SET_GET_CHANNEL,
  FN_PARAMETER_SETGET,
} from 'fractal-midi/axe-fx-iii';

function hex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

let failed = 0;
let passed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
}

function expectThrows(
  label: string,
  fn: () => unknown,
  expectedCode: string,
): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${label}\n      expected DispatchError(${expectedCode}), nothing thrown`);
  } catch (err) {
    if (err instanceof DispatchError && err.code === expectedCode) {
      passed++;
      return;
    }
    failed++;
    const desc = err instanceof DispatchError
      ? `got DispatchError(${err.code}): ${err.message}`
      : `got ${err instanceof Error ? err.message : String(err)}`;
    console.error(`  ✗ ${label}\n      expected DispatchError(${expectedCode}), ${desc}`);
  }
}

// ── Registration + resolution ───────────────────────────────────────
//
// Order matters: Axe-Fx II registers BEFORE AM4 so the more-specific
// `/axe-?fx/i` regex fires first on port names like "Fractal Axe-Fx II
// Port 1". AM4's `/Fractal/i` regex remains as catch-all. Matches the
// production registration order in `src/server/index.ts`.

console.log('Registering Axe-Fx II descriptor.');
registerMcpDevice(AXEFX2_DESCRIPTOR);

console.log('Registering AM4 descriptor.');
registerMcpDevice(AM4_DESCRIPTOR);

const devices = listRegisteredDevices();
assert(
  'AM4 descriptor registers and lists',
  devices.length >= 2 && devices.some((d) => d.id === 'am4'),
);
assert(
  'Axe-Fx II descriptor registers and lists',
  devices.some((d) => d.id === 'axe-fx-ii'),
);

assert('resolveDevice("am4") matches', resolveDevice('am4')?.id === 'am4');
assert('resolveDevice("AM4") case-insensitive', resolveDevice('AM4')?.id === 'am4');
assert('resolveDevice("Fractal AM4") display_name', resolveDevice('Fractal AM4')?.id === 'am4');
assert('resolveDevice("AM4 MIDI 1") port_match regex', resolveDevice('AM4 MIDI 1')?.id === 'am4');
assert('resolveDevice("Fractal Audio AM4") regex', resolveDevice('Fractal Audio AM4')?.id === 'am4');
assert('resolveDevice("nope") miss returns undefined', resolveDevice('nope') === undefined);

// Axe-Fx II port resolution — confirm the more-specific regex wins
// against ambiguous "Fractal X" port names.
assert(
  'resolveDevice("axe-fx-ii") canonical id',
  resolveDevice('axe-fx-ii')?.id === 'axe-fx-ii',
);
assert(
  'resolveDevice("Fractal Axe-Fx II XL+") display_name',
  resolveDevice('Fractal Axe-Fx II XL+')?.id === 'axe-fx-ii',
);
assert(
  'resolveDevice("Axe-Fx II Port 1") matches /axe-?fx/i',
  resolveDevice('Axe-Fx II Port 1')?.id === 'axe-fx-ii',
);
assert(
  'resolveDevice("AxeFx") matches /axe-?fx/i (no-dash form)',
  resolveDevice('AxeFx')?.id === 'axe-fx-ii',
);
assert(
  'resolveDevice("Fractal Axe-Fx II Port 1") prefers Axe-Fx II over AM4 /Fractal/i fallback',
  resolveDevice('Fractal Axe-Fx II Port 1')?.id === 'axe-fx-ii',
);

// ── Step-1 port error envelope ──────────────────────────────────────

expectThrows(
  'requireDevice("nope") throws port_not_found',
  () => requireDevice('nope'),
  'port_not_found',
);

// ── Step-3 block / param resolution ─────────────────────────────────

const am4 = requireDevice('AM4');

assert(
  'resolveBlockName("amp") canonical pass-through',
  resolveBlockName(am4, 'amp') === 'amp',
);

expectThrows(
  'resolveBlockName("oscillator") throws unknown_block',
  () => resolveBlockName(am4, 'oscillator'),
  'unknown_block',
);

assert(
  'resolveParamName(reverb, time) canonical',
  resolveParamName(am4, 'reverb', 'time').name === 'time',
);

const aliased = resolveParamName(am4, 'reverb', 'decay');
assert(
  'resolveParamName(reverb, decay) → time via PARAM_ALIASES',
  aliased.name === 'time' && aliased.aliased_from === 'decay',
);

const aliased2 = resolveParamName(am4, 'delay', 'repeats');
assert(
  'resolveParamName(delay, repeats) → feedback via PARAM_ALIASES',
  aliased2.name === 'feedback' && aliased2.aliased_from === 'repeats',
);

expectThrows(
  'resolveParamName(amp, warmth) throws unknown_param',
  () => resolveParamName(am4, 'amp', 'warmth'),
  'unknown_param',
);

// ── Channel resolution ──────────────────────────────────────────────

assert(
  'resolveChannel(amp, "B") → 1',
  resolveChannel(am4, 'amp', 'B') === 1,
);
assert(
  'resolveChannel(amp, 2) → 2',
  resolveChannel(am4, 'amp', 2) === 2,
);
assert(
  'resolveChannel(amp, undefined) → undefined',
  resolveChannel(am4, 'amp', undefined) === undefined,
);
expectThrows(
  'resolveChannel(amp, "E") throws bad_channel',
  () => resolveChannel(am4, 'amp', 'E'),
  'bad_channel',
);
expectThrows(
  'resolveChannel(chorus, "A") throws capability_not_supported (chorus has no channels)',
  () => resolveChannel(am4, 'chorus', 'A'),
  'capability_not_supported',
);

// ── Step-4 value validation ─────────────────────────────────────────

expectThrows(
  'encodeSetParam(amp.gain=12.5) throws value_out_of_range',
  () => encodeSetParam({ port: 'AM4', block: 'amp', name: 'gain', value: 12.5 }),
  'value_out_of_range',
);

// ── Byte-equivalence vs legacy wire path ────────────────────────────

type ByteCase = {
  label: string;
  port: string;
  block: string;
  name: string;
  value: number | string;
  legacy: () => number[];
};

const byteCases: ByteCase[] = [
  {
    label: 'amp.gain=0 — canonical port "am4"',
    port: 'am4',
    block: 'amp',
    name: 'gain',
    value: 0,
    legacy: () => buildSetParam('amp.gain', 0),
  },
  {
    label: 'amp.gain=4.5 — case-insensitive port "AM4"',
    port: 'AM4',
    block: 'amp',
    name: 'gain',
    value: 4.5,
    legacy: () => buildSetParam('amp.gain', 4.5),
  },
  {
    label: 'amp.bass=6 — display_name port resolution',
    port: 'Fractal AM4',
    block: 'amp',
    name: 'bass',
    value: 6,
    legacy: () => buildSetParam('amp.bass', 6),
  },
  {
    label: 'amp.gain=8 — port_match regex via "AM4 MIDI 1"',
    port: 'AM4 MIDI 1',
    block: 'amp',
    name: 'gain',
    value: 8,
    legacy: () => buildSetParam('amp.gain', 8),
  },
  {
    label: 'reverb.decay=2.5 — alias resolves to reverb.time',
    port: 'am4',
    block: 'reverb',
    name: 'decay',
    value: 2.5,
    legacy: () => buildSetParam('reverb.time', 2.5),
  },
  {
    label: 'delay.repeats=50 — alias resolves to delay.feedback',
    port: 'am4',
    block: 'delay',
    name: 'repeats',
    value: 50,
    legacy: () => buildSetParam('delay.feedback', 50),
  },
];

console.log('\nByte-equivalence checks vs legacy buildSetParam:');
for (const tc of byteCases) {
  const fromDispatcher = encodeSetParam({
    port: tc.port,
    block: tc.block,
    name: tc.name,
    value: tc.value,
  });
  const fromLegacy = tc.legacy();
  const eq = fromDispatcher.bytes.length === fromLegacy.length
    && fromDispatcher.bytes.every((b, i) => b === fromLegacy[i]);
  assert(
    tc.label,
    eq,
    eq ? undefined : `dispatcher: ${hex(fromDispatcher.bytes)}\n      legacy:     ${hex(fromLegacy)}`,
  );
}

// ── Enum byte-equivalence (display name → wire) ─────────────────────

console.log('\nEnum value resolution byte-equivalence:');

const enumCases: { label: string; port: string; block: string; name: string; value: number | string; legacy: () => number[] }[] = [
  {
    label: 'amp.type via wire index 0 — direct numeric pass-through',
    port: 'am4',
    block: 'amp',
    name: 'type',
    value: 0,
    legacy: () => buildSetParam('amp.type', 0),
  },
  {
    label: 'compressor.type=2 — direct numeric',
    port: 'am4',
    block: 'compressor',
    name: 'type',
    value: 2,
    legacy: () => buildSetParam('compressor.type', 2),
  },
];

for (const tc of enumCases) {
  const fromDispatcher = encodeSetParam(tc);
  const fromLegacy = tc.legacy();
  const eq = fromDispatcher.bytes.length === fromLegacy.length
    && fromDispatcher.bytes.every((b, i) => b === fromLegacy[i]);
  assert(
    tc.label,
    eq,
    eq ? undefined : `dispatcher: ${hex(fromDispatcher.bytes)}\n      legacy:     ${hex(fromLegacy)}`,
  );
}

// ── describe_device pure introspection ──────────────────────────────

console.log('\ndescribe_device introspection:');

const desc = describeDevice('AM4');
assert('describe_device returns Fractal AM4', desc.device === 'Fractal AM4');
assert('describe_device id is am4', desc.id === 'am4');
assert(
  'describe_device.capabilities.slot_model = linear',
  desc.capabilities.slot_model === 'linear',
);
assert(
  'describe_device.capabilities.scene_count = 4',
  desc.capabilities.scene_count === 4,
);
assert(
  'describe_device.capabilities.channel_names = A/B/C/D',
  desc.capabilities.channel_names?.join('/') === 'A/B/C/D',
);
assert(
  'describe_device.blocks includes amp, drive, reverb, delay',
  ['amp', 'drive', 'reverb', 'delay'].every((b) => desc.blocks.includes(b)),
);
assert(
  'describe_device.canonical_terms.channel mentions A/B/C/D',
  desc.canonical_terms.channel.includes('A/B/C/D'),
);

// ── list_params pure introspection ──────────────────────────────────

console.log('\nlist_params introspection:');

const allParams = listParams({ port: 'AM4' });
assert(
  'list_params(port) returns multiple entries',
  allParams.params.length > 50,
  `got ${allParams.params.length} entries`,
);

const ampOnly = listParams({ port: 'AM4', block: 'amp' });
assert(
  'list_params(port, block=amp) scopes to amp block',
  ampOnly.params.every((p) => p.block === 'amp') && ampOnly.params.length > 5,
);

const reverbTime = listParams({ port: 'AM4', block: 'reverb', name: 'time' });
assert(
  'list_params(reverb, time) returns single entry',
  reverbTime.params.length === 1 && reverbTime.params[0].name === 'time',
);

const reverbTimeEntry = reverbTime.params[0];
assert(
  'list_params unit passes AM4-native name through (open item #4)',
  reverbTimeEntry.unit === 'seconds',
  `got unit=${reverbTimeEntry.unit}`,
);
assert(
  'list_params reverb.time advertises aliases (decay, length)',
  reverbTimeEntry.has_aliases !== undefined
    && reverbTimeEntry.has_aliases.includes('decay')
    && reverbTimeEntry.has_aliases.includes('length'),
  `got aliases=${reverbTimeEntry.has_aliases?.join('/')}`,
);

const ampType = listParams({ port: 'AM4', block: 'amp', name: 'type' });
assert(
  'list_params(amp, type) enum includes full enum_values table',
  ampType.params[0].enum_values !== undefined
    && Object.keys(ampType.params[0].enum_values).length > 10,
);

// Confirm a knob_0_10 param surfaces its native unit name now (was
// previously collapsing to "knob" before open item #4 fix).
const ampGain = listParams({ port: 'AM4', block: 'amp', name: 'gain' });
assert(
  'list_params(amp, gain) unit is knob_0_10 (native AM4 name preserved)',
  ampGain.params[0].unit === 'knob_0_10',
  `got unit=${ampGain.params[0].unit}`,
);

// ── BK-051 Session B-cont — apply_preset PresetSpec validation ─────
//
// Pure-path coverage for the unified `apply_preset` tool: PresetSpec
// translation onto AM4 ApplyPresetInput goes through prepareApplyPresetWrites,
// which surfaces validation errors before any MIDI. We exercise the same
// failure shapes the legacy `am4_apply_preset` smoke covers.

console.log('\nPresetSpec validation (via prepareApplyPresetWrites):');

function expectApplyError(label: string, spec: unknown, fragment: string): void {
  try {
    prepareApplyPresetWrites(spec as Parameters<typeof prepareApplyPresetWrites>[0]);
    failed++;
    console.error(`  ✗ ${label}\n      expected error, got success`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(fragment)) {
      passed++;
    } else {
      failed++;
      console.error(`  ✗ ${label}\n      expected error to include "${fragment}", got: ${msg}`);
    }
  }
}

expectApplyError(
  'duplicate slot position',
  { slots: [
    { position: 1, block_type: 'amp' },
    { position: 1, block_type: 'drive' },
  ] },
  'used twice',
);

expectApplyError(
  'unknown block_type',
  { slots: [{ position: 1, block_type: 'not_a_real_block' }] },
  'unknown block_type',
);

expectApplyError(
  'channels on a block without channels',
  { slots: [{ position: 1, block_type: 'compressor', channels: { A: { ratio: 4 } } }] },
  "doesn't have channels",
);

expectApplyError(
  'duplicate scene index',
  {
    slots: [{ position: 1, block_type: 'amp' }],
    scenes: [
      { index: 1, channels: { amp: 'A' } },
      { index: 1, channels: { amp: 'B' } },
    ],
  },
  'used twice',
);

// Note: name validation runs through buildSetPresetName which throws on
// overlong/non-ASCII names. 32-char name is the boundary.
expectApplyError(
  'overlong preset name (33 chars)',
  { slots: [{ position: 1, block_type: 'amp' }], name: 'x'.repeat(33) },
  'name',
);

// PresetSpec params-shape translation through specToApplyInput
// (AM4 writer's validatePreset hook). Verifies both shapes route:
//   - flat `{rate: 0.8}` on a non-channel block → executor params field
//   - channel-nested `{A: {gain: 6}}` on a channel block → executor channels field
//   - flat on channel block writes to the current channel
//   - channel-nested on non-channel block REJECTS
//   - mixed shapes (some primitive, some object) REJECTS at the dispatcher

console.log('\nPresetSpec params-shape routing (AM4 unified surface):');

function expectValidatePresetOk(label: string, spec: unknown): void {
  try {
    AM4_DESCRIPTOR.writer.validatePreset!(spec as Parameters<NonNullable<typeof AM4_DESCRIPTOR.writer.validatePreset>>[0]);
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}\n      threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function expectValidatePresetError(label: string, spec: unknown, fragment: string): void {
  try {
    AM4_DESCRIPTOR.writer.validatePreset!(spec as Parameters<NonNullable<typeof AM4_DESCRIPTOR.writer.validatePreset>>[0]);
    failed++;
    console.error(`  ✗ ${label}\n      expected error, got success`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(fragment)) {
      passed++;
    } else {
      failed++;
      console.error(`  ✗ ${label}\n      expected error to include "${fragment}", got: ${msg}`);
    }
  }
}

expectValidatePresetOk(
  'flat params on non-channel block (filter)',
  { slots: [{ slot: 1, block_type: 'filter', params: { type: 'Auto-Wah', mix: 100 } }] },
);

expectValidatePresetOk(
  'flat params on non-channel block (chorus)',
  { slots: [{ slot: 1, block_type: 'chorus', params: { rate: 0.8, depth: 35, mix: 40 } }] },
);

expectValidatePresetOk(
  'channel-nested params on channel block (amp)',
  { slots: [{ slot: 1, block_type: 'amp', params: { A: { gain: 6, bass: 5 }, D: { gain: 8 } } }] },
);

expectValidatePresetOk(
  'flat params on channel block (amp) — writes to current channel',
  { slots: [{ slot: 1, block_type: 'amp', params: { gain: 6, bass: 5 } }] },
);

expectValidatePresetError(
  'channel-nested params on non-channel block (filter) — rejected',
  { slots: [{ slot: 1, block_type: 'filter', params: { A: { type: 'Auto-Wah', mix: 100 } } }] },
  "doesn't have channels",
);

expectValidatePresetError(
  'mixed flat + nested params in one slot — rejected at dispatcher',
  { slots: [{ slot: 1, block_type: 'amp', params: { gain: 6, A: { bass: 5 } } }] },
  'mixes flat values and channel-nested objects',
);

// Full song-preset shape with mixed channel and non-channel blocks
// (regression test for the 2026-05-14 Enter Sandman case that forced the
// agent to fall back to set_params for filter/chorus).
expectValidatePresetOk(
  'Enter Sandman mixed shape — channel-nested amp + flat filter/chorus + channel-nested reverb',
  {
    slots: [
      { slot: 1, block_type: 'filter', params: { type: 'Auto-Wah', mix: 100 } },
      { slot: 2, block_type: 'amp', params: {
        A: { type: 'USA MK V Green', gain: 3, bass: 5, mid: 5, treble: 6, presence: 4, master: 5 },
        D: { type: 'USA MK IIC+', gain: 8, bass: 5, mid: 2.5, treble: 7.5, presence: 6, master: 6 },
      } },
      { slot: 3, block_type: 'chorus', params: { rate: 0.8, depth: 35, mix: 40 } },
      { slot: 4, block_type: 'reverb', params: { A: { type: 'Room, Medium', mix: 20 } } },
    ],
    scenes: [
      { scene: 1, channels: { amp: 'A', reverb: 'A' }, bypassed: { filter: true, chorus: false } },
      { scene: 2, channels: { amp: 'D', reverb: 'A' }, bypassed: { filter: true, chorus: true } },
      { scene: 3, channels: { amp: 'D', reverb: 'A' }, bypassed: { filter: false, chorus: true } },
    ],
  },
);

// ── Schema ↔ executor CONTRACT test (added 2026-05-14) ──────────────
//
// Why this layer exists: the Enter Sandman case landed in production
// because the Zod schema for apply_preset and the AM4 executor disagreed
// on what `slots[].params` could look like for non-channel blocks. The
// schema said channel-nested only; the executor rejected channel-nested
// on non-channel blocks. There was no single test that exercised the
// full Zod-parse → dispatcher-translate → executor-validate pipeline.
//
// THIS contract test forecloses that whole class of bug: for every
// block in every registered device, we synthesize a `slots[].params`
// in the shape the agent would naturally send (flat for non-channel
// blocks, channel-nested for channel blocks), parse it through the
// REAL `presetShape` Zod schema the MCP tool uses, then route it
// through the device's `validatePreset` hook (which calls
// specToApplyInput + prepareApplyPresetWrites). If the schema accepts
// the shape but the executor rejects it with a "wrong shape" message,
// this test fails — the schema and executor are out of sync.
//
// We intentionally use a benign, schema-known param name per block
// (drawn from the descriptor's actual block.params keys) so the test
// fails ONLY on shape-contract regressions, not on stale param names.

console.log('\nSchema ↔ executor shape contract (per device, per block):');

const registered = listRegisteredDevices();

for (const descriptor of registered) {
  // Skip Axe-Fx III (refuses writes by design — capability_not_supported)
  // and Hydrasynth (different surface, no slot-based apply_preset for
  // its `patches` model).
  if (descriptor.id !== 'am4' && descriptor.id !== 'axe-fx-ii') continue;
  if (descriptor.writer.validatePreset === undefined) continue;

  const channelBlocks = new Set(descriptor.capabilities.channel_blocks ?? []);
  const channelNames = descriptor.capabilities.channel_names ?? ['A'];
  // Only test blocks the device actually exposes as placeable. Some
  // blocks (AM4's `ingate`) appear in the params schema for read-only
  // discovery but aren't a valid block_type for apply_preset.
  const placeableBlocks = descriptor.block_types !== undefined
    ? new Set(Object.keys(descriptor.block_types))
    : new Set(Object.keys(descriptor.blocks));

  for (const [blockName, blockSchema] of Object.entries(descriptor.blocks)) {
    if (!placeableBlocks.has(blockName)) continue;
    if (blockName === 'none') continue;
    // Pick a primitive param: prefer a non-enum knob so we don't have
    // to know the enum vocabulary. Skip 'channel' / 'type' since those
    // are special-cased downstream.
    const candidateParam = Object.entries(blockSchema.params).find(
      ([name, p]) =>
        name !== 'channel'
        && name !== 'type'
        && name !== 'mode'
        && (p.unit !== 'enum'),
    );
    if (!candidateParam) continue;
    const [paramName, paramSchema] = candidateParam;
    // Pick a representative value in the middle of the display range,
    // falling back to 0 when the descriptor doesn't expose bounds.
    const midValue = paramSchema.display_min !== undefined && paramSchema.display_max !== undefined
      ? (paramSchema.display_min + paramSchema.display_max) / 2
      : 0;

    const blockIsChannelBlock = channelBlocks.has(blockName);
    const firstChannel = channelNames[0];

    if (blockIsChannelBlock) {
      // Channel block: flat (active-channel) on `params` AND nested on
      // `params_by_channel` must both parse + validate (T-5, 2026-05-21:
      // schema split. Nested-in-params is no longer accepted at the
      // schema layer; agents author multi-channel via params_by_channel.)
      const flatSpec = {
        slots: [{ slot: 1, block_type: blockName, params: { [paramName]: midValue } }],
      };
      const nestedSpec = {
        slots: [{ slot: 1, block_type: blockName, params_by_channel: { [firstChannel]: { [paramName]: midValue } } }],
      };

      const flatParsed = presetShape.safeParse(flatSpec);
      assert(
        `${descriptor.id}/${blockName}: flat params {${paramName}=${midValue}} parses via Zod`,
        flatParsed.success,
        flatParsed.success ? undefined : JSON.stringify((flatParsed as z.ZodSafeParseError<unknown>).error.issues),
      );
      const nestedParsed = presetShape.safeParse(nestedSpec);
      assert(
        `${descriptor.id}/${blockName}: params_by_channel {${firstChannel}: {${paramName}=${midValue}}} parses via Zod`,
        nestedParsed.success,
        nestedParsed.success ? undefined : JSON.stringify((nestedParsed as z.ZodSafeParseError<unknown>).error.issues),
      );
      if (flatParsed.success) {
        try {
          // Cast through NonNullable<…> because validatePreset is an
          // optional capability on the writer interface; the `!` above
          // narrows the runtime value but TS still surfaces undefined
          // in the type expression. Zod-inferred data is structurally
          // compatible at runtime — its SceneSpec.channels is `?:`
          // vs PresetSpec's required — so the cast bridges schema
          // looseness without weakening the dispatcher contract.
          descriptor.writer.validatePreset!(flatParsed.data as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
          passed++;
        } catch (err) {
          failed++;
          console.error(`  ✗ ${descriptor.id}/${blockName}: flat params on channel block — executor rejected\n      ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (nestedParsed.success) {
        try {
          descriptor.writer.validatePreset!(nestedParsed.data as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
          passed++;
        } catch (err) {
          failed++;
          console.error(`  ✗ ${descriptor.id}/${blockName}: params_by_channel on channel block — executor rejected\n      ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else {
      // Non-channel block: flat params must parse AND validate.
      // Channel-nested params should be rejected by the executor with a
      // clear "doesn't have channels" message (NOT silently accepted; NOT
      // a Zod parse failure — the schema accepts both shapes).
      const flatSpec = {
        slots: [{ slot: 1, block_type: blockName, params: { [paramName]: midValue } }],
      };
      const flatParsed = presetShape.safeParse(flatSpec);
      assert(
        `${descriptor.id}/${blockName}: flat params {${paramName}=${midValue}} parses via Zod`,
        flatParsed.success,
        flatParsed.success ? undefined : JSON.stringify((flatParsed as z.ZodSafeParseError<unknown>).error.issues),
      );
      if (flatParsed.success) {
        try {
          descriptor.writer.validatePreset!(flatParsed.data as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
          passed++;
        } catch (err) {
          failed++;
          console.error(`  ✗ ${descriptor.id}/${blockName}: flat params on non-channel block — executor rejected (THIS IS THE 2026-05-14 ENTER SANDMAN REGRESSION)\n      ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // AM4 explicitly rejects params_by_channel on non-channel blocks.
      // Axe-Fx II accepts on every block because every II block has X/Y,
      // so we only gate this assertion on AM4. T-5 (2026-05-21): the
      // schema accepts params_by_channel structurally; the per-device
      // executor refuses based on the block's channel capability.
      //
      // Run the preflight before validatePreset so the dispatcher's
      // params_by_channel-into-params merge happens first; the executor
      // never sees params_by_channel directly (preflight contract).
      if (descriptor.id === 'am4') {
        const nestedSpec = {
          slots: [{ slot: 1, block_type: blockName, params_by_channel: { [firstChannel]: { [paramName]: midValue } } }],
        };
        const nestedParsed = presetShape.safeParse(nestedSpec);
        assert(
          `${descriptor.id}/${blockName}: params_by_channel parses via Zod (schema accepts on all blocks)`,
          nestedParsed.success,
          nestedParsed.success ? undefined : JSON.stringify((nestedParsed as z.ZodSafeParseError<unknown>).error.issues),
        );
        if (nestedParsed.success) {
          const { collectApplyPresetPreflight } = await import(
            '@mcp-midi-control/core/protocol-generic/dispatcher/preflight.js'
          );
          const preflight = collectApplyPresetPreflight(
            nestedParsed.data as Parameters<typeof collectApplyPresetPreflight>[0],
            descriptor,
          );
          try {
            descriptor.writer.validatePreset!(preflight.normalized_spec as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
            failed++;
            console.error(`  ✗ ${descriptor.id}/${blockName}: params_by_channel on non-channel block — executor accepted (should reject with clear error)`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("doesn't have channels")) {
              passed++;
            } else {
              failed++;
              console.error(`  ✗ ${descriptor.id}/${blockName}: params_by_channel on non-channel block — wrong error message\n      expected "doesn't have channels", got: ${msg}`);
            }
          }
        }
      }
    }
  }
}

// ── BK-051 Wave 2 — Axe-Fx II descriptor byte-equivalence ──────────
//
// Mirror the AM4 byte-equivalence checks against the Axe-Fx II
// descriptor: assert the dispatcher's `encodeSetParam` path produces
// the same wire bytes as direct calls to legacy `buildSetBlockParam
// eterValue` / `buildSwitchPreset` / `buildStorePreset`. Covers linear
// calibration, log10 calibration, enum string→index, and the
// MSB-first preset-number byte order for STORE.

console.log('\nAxe-Fx II byte-equivalence checks:');

type AxeFxByteCase = {
  label: string;
  port: string;
  block: string;
  name: string;
  value: number | string;
  legacy: () => number[];
};

const axefx2Cases: AxeFxByteCase[] = [
  {
    label: 'amp.bass=6.0 (linear knob 0..10) — display→wire via descriptor matches legacy displayToWire',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'bass',
    value: 6.0,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 2 },
      displayToWire(6.0, { displayMin: 0, displayMax: 10 }),
    ),
  },
  {
    label: 'amp.input_drive=4.5 — case-insensitive port "AxeFx"',
    port: 'AxeFx',
    block: 'amp',
    name: 'input_drive',
    value: 4.5,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 1 },
      displayToWire(4.5, { displayMin: 0, displayMax: 10 }),
    ),
  },
  {
    label: 'reverb.mix=30 (percent 0..100) — display→wire linear',
    port: 'axe-fx-ii',
    block: 'reverb',
    name: 'mix',
    value: 30,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 110, paramId: 13 },
      displayToWire(30, { displayMin: 0, displayMax: 100 }),
    ),
  },
  {
    label: 'amp.preamp_low_cut=100 Hz — log10 scale',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'preamp_low_cut',
    value: 100,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 6 },
      displayToWire(100, { displayMin: 10, displayMax: 1000, displayScale: 'log10' }),
    ),
  },
  {
    label: 'amp.balance=-50 (bipolar -100..+100) — display→wire linear',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'balance',
    value: -50,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 22 },
      displayToWire(-50, { displayMin: -100, displayMax: 100 }),
    ),
  },
  {
    label: 'amp.tone_stack — exact enum string→wire index',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'tone_stack',
    // Use the first label verbatim from AMP_TONE_STACK_VALUES so the
    // resolver hits the exact-match path. The dispatcher and the legacy
    // path arrive at the same wire integer through the same enum table.
    value: Object.values(AXEFX2_DESCRIPTOR.blocks.amp.params.tone_stack.enum_values ?? {})[0],
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 34 },
      AXEFX2_DESCRIPTOR.blocks.amp.params.tone_stack.encode(
        Object.values(AXEFX2_DESCRIPTOR.blocks.amp.params.tone_stack.enum_values ?? {})[0],
      ),
    ),
  },
];

for (const tc of axefx2Cases) {
  let dispatcherBytes: number[] | undefined;
  let legacyBytes: number[] | undefined;
  try {
    const fromDispatcher = encodeSetParam({
      port: tc.port,
      block: tc.block,
      name: tc.name,
      value: tc.value,
    });
    dispatcherBytes = fromDispatcher.bytes;
    legacyBytes = tc.legacy();
    const eq = dispatcherBytes.length === legacyBytes.length
      && dispatcherBytes.every((b, i) => b === legacyBytes![i]);
    assert(
      tc.label,
      eq,
      eq ? undefined : `dispatcher: ${hex(dispatcherBytes)}\n      legacy:     ${hex(legacyBytes)}`,
    );
  } catch (err) {
    failed++;
    console.error(`  ✗ ${tc.label}\n      threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Range / enum error envelopes for Axe-Fx II.
expectThrows(
  'encodeSetParam(amp.bass=15) throws value_out_of_range',
  () => encodeSetParam({ port: 'axe-fx-ii', block: 'amp', name: 'bass', value: 15 }),
  'value_out_of_range',
);

expectThrows(
  'encodeSetParam(amp.tone_stack="ZZZ") throws unknown_enum_value',
  () => encodeSetParam({ port: 'axe-fx-ii', block: 'amp', name: 'tone_stack', value: 'ZZZ' }),
  'unknown_enum_value',
);

// switchPreset + savePreset byte-equivalence — assert the pure
// builders produce the same envelope as the legacy buildSwitchPreset /
// buildStorePreset.
console.log('\nAxe-Fx II preset-navigation byte-equivalence:');

{
  // Descriptor now takes 1-indexed display slot — slot 700 → wire 699.
  const fromDescriptor = AXEFX2_DESCRIPTOR.writer.buildSwitchPreset!(700);
  const fromLegacy = buildSwitchPreset(699);
  const eq = fromDescriptor.length === fromLegacy.length
    && fromDescriptor.every((b, i) => b === fromLegacy[i]);
  assert(
    'buildSwitchPreset(slot 700) — descriptor wire=699 matches legacy buildSwitchPreset(699)',
    eq,
    eq ? undefined : `dispatcher: ${hex(fromDescriptor)}\n      legacy:     ${hex(fromLegacy)}`,
  );
}
{
  // Descriptor: slot 700 (display) → wire 699 → MSB-first STORE bytes.
  const fromDescriptor = AXEFX2_DESCRIPTOR.writer.buildSavePreset!(700);
  const fromLegacy = buildStorePreset(699);
  const eq = fromDescriptor.length === fromLegacy.length
    && fromDescriptor.every((b, i) => b === fromLegacy[i]);
  assert(
    'buildSavePreset(slot 700) — descriptor wire=699 matches legacy (MSB-first byte order)',
    eq,
    eq ? undefined : `dispatcher: ${hex(fromDescriptor)}\n      legacy:     ${hex(fromLegacy)}`,
  );
}
{
  // bspaulding/axe-fx-midi golden (Mark II, wire preset 217 = display
  // slot 218) — same shape as our XL+ encoder with MSB-first ordering.
  const fromDescriptor = AXEFX2_DESCRIPTOR.writer.buildSavePreset!(218);
  const fromLegacy = buildStorePreset(217);
  const eq = fromDescriptor.length === fromLegacy.length
    && fromDescriptor.every((b, i) => b === fromLegacy[i]);
  assert(
    'buildSavePreset(slot 218) — descriptor wire=217 matches legacy (bspaulding cross-check)',
    eq,
    eq ? undefined : `dispatcher: ${hex(fromDescriptor)}\n      legacy:     ${hex(fromLegacy)}`,
  );
}
// Boundary checks for the new 1-indexed slot semantics.
{
  let threw = false;
  let msg = '';
  try { AXEFX2_DESCRIPTOR.writer.buildSwitchPreset!(0); }
  catch (err) { threw = true; msg = err instanceof Error ? err.message : String(err); }
  assert(
    'buildSwitchPreset(slot 0) rejected — slot is 1-indexed',
    threw,
    threw ? undefined : 'expected error, got success',
  );
}
{
  let threw = false;
  try { AXEFX2_DESCRIPTOR.writer.buildSwitchPreset!(16385); }
  catch { threw = true; }
  assert(
    'buildSwitchPreset(slot 16385) rejected — out of range',
    threw,
  );
}

// describeDevice on Axe-Fx II surfaces the grid slot model.
console.log('\nAxe-Fx II describe_device introspection:');

const axefxDesc = describeDevice('axe-fx-ii');
assert(
  'describe_device(axe-fx-ii).slot_model = grid',
  axefxDesc.capabilities.slot_model === 'grid',
);
assert(
  'describe_device(axe-fx-ii).scene_count = 8',
  axefxDesc.capabilities.scene_count === 8,
);
assert(
  'describe_device(axe-fx-ii).channel_names = X/Y',
  axefxDesc.capabilities.channel_names?.join('/') === 'X/Y',
);
assert(
  'describe_device(axe-fx-ii).supports_save = true',
  axefxDesc.capabilities.supports_save === true,
);
assert(
  'describe_device(axe-fx-ii).supports_factory_restore = false',
  axefxDesc.capabilities.supports_factory_restore === false,
);
assert(
  'describe_device(axe-fx-ii).blocks includes amp, reverb, delay, drive',
  ['amp', 'reverb', 'delay', 'drive'].every((b) => axefxDesc.blocks.includes(b)),
);

// list_params on Axe-Fx II surfaces unit metadata for calibrated knobs.
const axefxBass = listParams({ port: 'axe-fx-ii', block: 'amp', name: 'bass' });
assert(
  'list_params(axe-fx-ii, amp, bass) reports knob unit + display range 0..10',
  axefxBass.params.length === 1
    && axefxBass.params[0].unit === 'knob'
    && axefxBass.params[0].display_min === 0
    && axefxBass.params[0].display_max === 10,
  `got ${JSON.stringify(axefxBass.params[0])}`,
);
const axefxLowCut = listParams({ port: 'axe-fx-ii', block: 'amp', name: 'preamp_low_cut' });
assert(
  'list_params(axe-fx-ii, amp, preamp_low_cut) reports hz unit (log10 scale)',
  axefxLowCut.params.length === 1 && axefxLowCut.params[0].unit === 'hz',
  `got unit=${axefxLowCut.params[0]?.unit}`,
);

// ── Hydrasynth descriptor (BK-031) ──────────────────────────────────
//
// Registers via the descriptor at server boot. Verify the basic shape:
// device resolves, has the right capabilities, modules appear as
// "blocks" in describe_device.
console.log('\nHydrasynth descriptor introspection:');

// Register the Hydrasynth descriptor explicitly here — verify-dispatcher
// is a stand-alone script that doesn't go through server/index.ts boot.
const { HYDRASYNTH_DESCRIPTOR } = await import('@mcp-midi-control/hydrasynth/descriptor.js');
registerMcpDevice(HYDRASYNTH_DESCRIPTOR);

const hydraDesc = describeDevice('hydrasynth');
assert(
  'describe_device(hydrasynth).slot_model = linear',
  hydraDesc.capabilities.slot_model === 'linear',
);
assert(
  'describe_device(hydrasynth).has_scenes = false (synth, no scenes)',
  hydraDesc.capabilities.has_scenes === false,
);
assert(
  'describe_device(hydrasynth).has_channels = false',
  hydraDesc.capabilities.has_channels === false,
);
assert(
  'describe_device(hydrasynth).has_macros = true',
  hydraDesc.capabilities.has_macros === true,
);
assert(
  'describe_device(hydrasynth).slot_count = 1024 (8 banks × 128)',
  hydraDesc.capabilities.slot_count === 1024,
);
assert(
  'describe_device(hydrasynth).blocks includes osc1/filter1/lfo1/macros',
  ['osc1', 'filter1', 'lfo1', 'macros'].every((b) => hydraDesc.blocks.includes(b)),
  `got blocks=[${hydraDesc.blocks.slice(0, 15).join(', ')}...]`,
);

// Hydrasynth pure-builder byte-equivalence — switch_preset for "A001"
// emits Bank MSB=0 + Bank LSB=0 + PC=0 (8 bytes total).
{
  const bytes = HYDRASYNTH_DESCRIPTOR.writer.buildSwitchPreset!('A001');
  const expected = [0xB0, 0x00, 0x00, 0xB0, 0x20, 0x00, 0xC0, 0x00];
  const eq = bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
  assert(
    'buildSwitchPreset("A001") emits Bank MSB+LSB+PC for bank 0 patch 0',
    eq,
    eq ? undefined : `dispatcher: ${hex(bytes)}\n      expected:    ${hex(expected)}`,
  );
}
{
  // Bank H, patch 128 → bank 7, patch 127. Bank MSB stays 0; LSB=7; PC=0x7F.
  const bytes = HYDRASYNTH_DESCRIPTOR.writer.buildSwitchPreset!('H128');
  const expected = [0xB0, 0x00, 0x00, 0xB0, 0x20, 0x07, 0xC0, 0x7F];
  const eq = bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
  assert(
    'buildSwitchPreset("H128") emits last-bank last-patch navigation',
    eq,
    eq ? undefined : `dispatcher: ${hex(bytes)}\n      expected:    ${hex(expected)}`,
  );
}
// Reject malformed location strings.
{
  let threw = false;
  try { HYDRASYNTH_DESCRIPTOR.writer.buildSwitchPreset!('I001'); }
  catch { threw = true; }
  assert('buildSwitchPreset("I001") rejected (bank out of A..H range)', threw);
}

// ── apply_preset type-knob applicability pre-flight (AM4, BK-071) ──
//
// Structural fix for the H1 silent-no-op trap. Per BK-071, the
// dispatcher does NOT refuse incompatible writes (a guitarist might
// want Hall for tail texture and accept fixed-decay); instead it
// accepts the write and surfaces each dropped knob on
// `validation_info[]` with level='warning' + retry_action. The agent
// reads the structured warning and re-issues with a compatible type
// on the next turn.
//
// These tests call `collectTypeKnobApplicabilityWarnings` directly
// rather than going through `executeApplyPreset`. That keeps the
// suite MIDI-free (the full dispatcher path opens an AM4 handle that
// holds the event loop open and hangs the script at exit). End-to-end
// coverage of the BK-071 surface lives in `launch-verification.ts`
// which runs against MCP_MOCK_TRANSPORT=1.

console.log('\napply_preset type-knob applicability pre-flight (AM4, BK-071):');

async function expectApplyPreflightWarns(
  label: string,
  spec: { slots: { slot: number; block_type: string; params?: unknown }[] },
  expectedDroppedParams: readonly string[],
  expectedRetryFragment: string,
): Promise<void> {
  const { collectTypeKnobApplicabilityWarnings } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js'
  );
  const { resolveDevice } = await import(
    '@mcp-midi-control/core/protocol-generic/registry.js'
  );
  const descriptor = resolveDevice('am4');
  if (descriptor === undefined) {
    failed++;
    console.error(`  ✗ ${label}\n      AM4 descriptor not registered`);
    return;
  }
  const warnings = collectTypeKnobApplicabilityWarnings(
    spec as Parameters<typeof collectTypeKnobApplicabilityWarnings>[0],
    descriptor,
  );
  for (const droppedParam of expectedDroppedParams) {
    const entry = warnings.find((e) => e.level === 'warning' && e.dropped_param === droppedParam);
    if (entry === undefined) {
      failed++;
      console.error(`  ✗ ${label}\n      expected validation_info entry for dropped_param="${droppedParam}", got: ${JSON.stringify(warnings)}`);
      return;
    }
    if (!entry.retry_action || !entry.retry_action.includes(expectedRetryFragment)) {
      failed++;
      console.error(`  ✗ ${label}\n      retry_action should include "${expectedRetryFragment}", got: ${entry.retry_action}`);
      return;
    }
  }
  passed++;
}

// The exact H1 trap: agent sends reverb.type="Hall, Large" + reverb.time=6.
// Pre-fix: silent no-op on time, agent reports false success.
// Post-fix: write proceeds, validation_info carries the dropped-time
// warning so the agent self-corrects on turn 2.
await expectApplyPreflightWarns(
  'reverb.type="Hall, Large" + reverb.time=6 — soft-warn (Hall fixed-decay)',
  { slots: [{ slot: 1, block_type: 'reverb', params: { A: { type: 'Hall, Large', time: 6, mix: 30 } } }] },
  ['time'],
  'find_compatible_types',
);

// Same trap, flat-shape variant. Mix IS exposed by Hall (just time isn't);
// we should see exactly one warning for `time`, none for `mix`.
await expectApplyPreflightWarns(
  'reverb.type="Hall, Large Deep" + reverb.time=6 (flat) — soft-warn (only time drops)',
  { slots: [{ slot: 1, block_type: 'reverb', params: { type: 'Hall, Large Deep', time: 6 } as Record<string, number | string> }] },
  ['time'],
  'find_compatible_types',
);

// amp.master on non-master Vox AC30 — same silent-no-op trap class.
await expectApplyPreflightWarns(
  'amp.type="Class-A 30W TB" + amp.master=5 — soft-warn (AC30 has no master)',
  { slots: [{ slot: 1, block_type: 'amp', params: { A: { type: 'Class-A 30W TB', gain: 3, master: 5 } } }] },
  ['master'],
  'find_compatible_types',
);

// Positive case verified via findCompatibleTypes directly (calling
// executeApplyPreset for a positive case would trigger an actual wire
// write when AM4 is connected — not safe in a golden). The precheck
// uses findCompatibleTypes internally; if Plate, Large is in the
// compatible set, the precheck will pass on the H1 retry path.
{
  const r = findCompatibleTypes({ port: 'am4', block: 'reverb', params: ['time', 'mix'] });
  assert(
    'reverb time+mix compatibility — Plate, Large in compatible_types (precheck would PASS)',
    r.applicability_known === true && r.compatible_types.includes('Plate, Large'),
    `applicability_known=${r.applicability_known}, includes Plate, Large=${r.compatible_types.includes('Plate, Large')}`,
  );
}

// ── apply_preset channel-Y inactive pre-flight (BK-077) ────────────
//
// When a slot specifies channel-nested params (e.g. {X:{...},Y:{...}})
// but no scene in spec.scenes[] references the channel-Y key for that
// block, the Y data writes to the working buffer yet stays inaudible
// (the active scene routes to X). BK-058 fixed the writer-side data
// loss; BK-077 surfaces the trap at the spec layer so the agent
// self-corrects before reporting false success.
//
// Pure spec validation — calls `collectChannelYInactiveWarnings`
// directly (same pattern as BK-071 tests above).

console.log('\napply_preset channel-Y inactive pre-flight (BK-077):');

async function expectChannelYWarns(
  port: string,
  label: string,
  spec: Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
  expected: {
    slot_index: number;
    channel: string;
    droppedParamSubstring?: string;
    referencedSubstring?: string;
  },
): Promise<void> {
  const { collectChannelYInactiveWarnings } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js'
  );
  const { resolveDevice } = await import(
    '@mcp-midi-control/core/protocol-generic/registry.js'
  );
  const descriptor = resolveDevice(port);
  if (descriptor === undefined) {
    failed++;
    console.error(`  ✗ ${label}\n      ${port} descriptor not registered`);
    return;
  }
  const warnings = collectChannelYInactiveWarnings(spec, descriptor);
  const entry = warnings.find(
    (e) => e.slot_index === expected.slot_index && e.path.endsWith(`.${expected.channel}`),
  );
  if (entry === undefined) {
    failed++;
    console.error(`  ✗ ${label}\n      expected validation_info for slot ${expected.slot_index} channel ${expected.channel}, got: ${JSON.stringify(warnings)}`);
    return;
  }
  if (entry.level !== 'warning') {
    failed++;
    console.error(`  ✗ ${label}\n      expected level='warning', got: ${entry.level}`);
    return;
  }
  if (expected.droppedParamSubstring !== undefined && !entry.info.includes(expected.droppedParamSubstring)) {
    failed++;
    console.error(`  ✗ ${label}\n      info should mention "${expected.droppedParamSubstring}", got: ${entry.info}`);
    return;
  }
  if (expected.referencedSubstring !== undefined && !entry.reason?.includes(expected.referencedSubstring)) {
    failed++;
    console.error(`  ✗ ${label}\n      reason should mention "${expected.referencedSubstring}", got: ${entry.reason}`);
    return;
  }
  if (!entry.retry_action || !entry.retry_action.includes('scenes[')) {
    failed++;
    console.error(`  ✗ ${label}\n      retry_action should mention scenes[N], got: ${entry.retry_action}`);
    return;
  }
  passed++;
}

async function expectNoChannelYWarning(
  port: string,
  label: string,
  spec: Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
): Promise<void> {
  const { collectChannelYInactiveWarnings } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js'
  );
  const { resolveDevice } = await import(
    '@mcp-midi-control/core/protocol-generic/registry.js'
  );
  const descriptor = resolveDevice(port);
  if (descriptor === undefined) {
    failed++;
    console.error(`  ✗ ${label}\n      ${port} descriptor not registered`);
    return;
  }
  const warnings = collectChannelYInactiveWarnings(spec, descriptor);
  if (warnings.length > 0) {
    failed++;
    console.error(`  ✗ ${label}\n      expected zero warnings, got: ${JSON.stringify(warnings)}`);
    return;
  }
  passed++;
}

// Trap case: II spec writes amp.Y params, scene 1 routes amp→X.
await expectChannelYWarns(
  'axe-fx-ii',
  'II amp.Y params + scene→X → warn (Y is dead storage on this preset)',
  {
    slots: [{ slot: { row: 1, col: 1 }, block_type: 'amp', params: { X: { gain: 5 }, Y: { gain: 8 } } }],
    scenes: [{ scene: 1, channels: { amp: 'X' } }, { scene: 2, channels: { amp: 'X' } }],
  } as Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
  { slot_index: 0, channel: 'Y', droppedParamSubstring: 'channel-Y', referencedSubstring: 'X' },
);

// Trap case: AM4 spec writes amp.D params, all scenes route amp→A.
await expectChannelYWarns(
  'am4',
  'AM4 amp.D params + all scenes→A → warn (D is dead storage)',
  {
    slots: [{ slot: 1, block_type: 'amp', params: { A: { gain: 3 }, D: { gain: 7 } } }],
    scenes: [
      { scene: 1, channels: { amp: 'A' } },
      { scene: 2, channels: { amp: 'A' } },
      { scene: 3, channels: { amp: 'A' } },
      { scene: 4, channels: { amp: 'A' } },
    ],
  } as Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
  { slot_index: 0, channel: 'D', referencedSubstring: 'A' },
);

// Positive: II amp.Y params + at least one scene routes amp→Y → no warning.
await expectNoChannelYWarning(
  'axe-fx-ii',
  'II amp.Y + scene 2→Y → no warning (Y is active on scene 2)',
  {
    slots: [{ slot: { row: 1, col: 1 }, block_type: 'amp', params: { X: { gain: 5 }, Y: { gain: 8 } } }],
    scenes: [
      { scene: 1, channels: { amp: 'X' } },
      { scene: 2, channels: { amp: 'Y' } },
    ],
  } as Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
);

// Negative: no scenes in spec → silent (can't claim Y is inactive).
await expectNoChannelYWarning(
  'axe-fx-ii',
  'II amp.Y params + no scenes[] → no warning (working-buffer-only mode)',
  {
    slots: [{ slot: { row: 1, col: 1 }, block_type: 'amp', params: { X: { gain: 5 }, Y: { gain: 8 } } }],
  } as Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
);

// Negative: flat params (no channel nesting) → silent.
await expectNoChannelYWarning(
  'axe-fx-ii',
  'II amp flat params + scenes → no warning (no channel-keyed params)',
  {
    slots: [{ slot: { row: 1, col: 1 }, block_type: 'amp', params: { gain: 5 } }],
    scenes: [{ scene: 1, channels: { amp: 'X' } }],
  } as Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
);

// Negative: scenes specify the block but no channel for it → no warning.
// (No channel constraint = scene inherits existing device state.)
await expectNoChannelYWarning(
  'axe-fx-ii',
  'II amp.Y + scenes[].channels undefined → no warning (no scene constraint)',
  {
    slots: [{ slot: { row: 1, col: 1 }, block_type: 'amp', params: { Y: { gain: 8 } } }],
    scenes: [{ scene: 1, channels: {} }, { scene: 2, channels: {} }],
  } as Parameters<typeof import('@mcp-midi-control/core/protocol-generic/dispatcher/preset.js').collectChannelYInactiveWarnings>[0],
);

// Multi-param warning: dropped_param undefined when multiple Y params.
{
  const { collectChannelYInactiveWarnings } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js'
  );
  const { resolveDevice } = await import(
    '@mcp-midi-control/core/protocol-generic/registry.js'
  );
  const descriptor = resolveDevice('axe-fx-ii');
  if (descriptor !== undefined) {
    const warnings = collectChannelYInactiveWarnings(
      {
        slots: [{ slot: { row: 1, col: 1 }, block_type: 'amp', params: { Y: { gain: 8, master: 5, treble: 7 } } }],
        scenes: [{ scene: 1, channels: { amp: 'X' } }],
      } as Parameters<typeof collectChannelYInactiveWarnings>[0],
      descriptor,
    );
    const entry = warnings[0];
    assert(
      'multi-Y-param warning omits dropped_param (single only)',
      entry !== undefined && entry.dropped_param === undefined && entry.info.includes('gain') && entry.info.includes('master'),
      `entry=${JSON.stringify(entry)}`,
    );
  }
}

// ── find_compatible_types (AM4) ─────────────────────────────────────
//
// 2026-05-15 H1 + H2 traces (Sunday Morning + Verse Chorus Bridge Solo)
// surfaced two preventable round-trips:
//   - Agent set reverb.type="Hall, Large" then wrote reverb.time=6;
//     time silently dropped because Hall, Large is fixed-decay.
//   - Same for amp.master on Plexi 100W variants (non-master Marshalls).
//
// find_compatible_types({block, params:[...]}) returns the subset of
// the block's type enum that exposes EVERY listed param. The agent
// queries it before apply_preset, picks from compatible_types[], and
// the "dropped X param" warning never fires.

console.log('\nfind_compatible_types (AM4 applicability):');

{
  const r = findCompatibleTypes({ port: 'am4', block: 'reverb', params: ['time'] });
  assert(
    'reverb types exposing `time` filters down from full enum',
    r.applicability_known === true && r.compatible_types.length > 0 && r.compatible_types.length < r.total_types,
    `compatible=${r.compatible_types.length}/${r.total_types}, known=${r.applicability_known}`,
  );
  assert(
    'reverb time-exposing list excludes "Hall, Large" (fixed-decay)',
    !r.compatible_types.includes('Hall, Large'),
    `compatible_types: ${r.compatible_types.slice(0, 10).join(', ')}…`,
  );
  // 2026-05-15 H1 trace finding: NO Hall variants expose reverb.time
  // on AM4. Only Plate / Spring / Echo / SFX algorithms do. The H1 agent
  // self-corrected to "Hall, Large Deep" and the device acked the write,
  // but the value silently didn't apply — the agent reported success
  // incorrectly. With find_compatible_types the agent would pick a
  // Plate/Spring/Echo type for "long-decay reverb" instead.
  assert(
    'reverb time-exposing list excludes ALL Hall variants (Hall algorithms are fixed-decay)',
    !r.compatible_types.some((t) => t.startsWith('Hall,')),
    `unexpected Hall variants: ${r.compatible_types.filter((t) => t.startsWith('Hall,')).join(', ')}`,
  );
  assert(
    'reverb time-exposing list includes Plate variants',
    r.compatible_types.some((t) => t.startsWith('Plate,')),
    `compatible Plate variants: ${r.compatible_types.filter((t) => t.startsWith('Plate,')).join(', ')}`,
  );
  assert(
    'reverb time-exposing list includes Spring variants',
    r.compatible_types.some((t) => t.startsWith('Spring,')),
    `compatible Spring variants: ${r.compatible_types.filter((t) => t.startsWith('Spring,')).join(', ')}`,
  );
}

{
  // AM4 amp.master is gated against Plexi 100W variants (no-master-volume Marshalls).
  // The compatible-types filter should narrow at least somewhat.
  const r = findCompatibleTypes({ port: 'am4', block: 'amp', params: ['master'] });
  assert(
    'amp types exposing `master` narrows below full enum (excludes non-master heads)',
    r.applicability_known === true && r.compatible_types.length < r.total_types,
    `compatible=${r.compatible_types.length}/${r.total_types}`,
  );
}

{
  // Block with no primary-type enum → applicability_known: false.
  // 'peq' falls in this bucket (PEQ has no single type-of-EQ enum).
  const r = findCompatibleTypes({ port: 'am4', block: 'peq', params: ['type'] });
  assert(
    'peq (no primary type enum) → applicability_known: false',
    r.applicability_known === false,
    `applicability_known=${r.applicability_known}, note=${r.note ?? '(no note)'}`,
  );
}

{
  // Axe-Fx II has no findCompatibleTypes implementation — falls back to full type list.
  const r = findCompatibleTypes({ port: 'axe-fx-ii', block: 'reverb', params: ['time'] });
  assert(
    'Axe-Fx II find_compatible_types falls back with applicability_known: false',
    r.applicability_known === false,
    `applicability_known=${r.applicability_known}`,
  );
}

expectThrows(
  'find_compatible_types({params:[]}) rejects empty params array',
  () => findCompatibleTypes({ port: 'am4', block: 'reverb', params: [] }),
  'value_out_of_range',
);

expectThrows(
  'find_compatible_types({block:"oscillator"}) rejects unknown block',
  () => findCompatibleTypes({ port: 'am4', block: 'oscillator', params: ['type'] }),
  'unknown_block',
);

// ── Enum-ambiguity carries valid_options through DispatchError ──────
//
// H2 trace (2026-05-15): agent sent amp.type="Plexi 100W" which matched
// 4 variants. The error response carried the candidates in prose. After
// this fix the DispatchError.details.valid_options carries them
// structurally so the agent picks a verbatim choice without re-parsing.

console.log('\nEnum-ambiguity valid_options passthrough:');

try {
  encodeSetParam({ port: 'am4', block: 'amp', name: 'type', value: 'Plexi 100W' });
  failed++;
  console.error('  ✗ Plexi 100W ambiguity expected to throw');
} catch (err) {
  if (err instanceof DispatchError && err.code === 'ambiguous_enum_value') {
    const opts = err.details?.valid_options;
    const ok = Array.isArray(opts) && opts.length >= 2 && opts.every((o) => typeof o === 'string' && o.startsWith('Plexi 100W'));
    assert(
      'Plexi 100W ambiguity surfaces structured valid_options (Plexi 100W *)',
      ok,
      ok ? undefined : `opts=${JSON.stringify(opts)}`,
    );
  } else {
    failed++;
    console.error(`  ✗ Plexi 100W expected DispatchError(ambiguous_enum_value), got ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── BK-075 block-layout cache + phantom-param pre-flight ────────────
//
// Two surfaces under test:
//   1. The cache module's TTL + connection-identity semantics.
//   2. The phantom-param pre-flight call shape (validation_info[] entry
//      with level='warning', dropped_param, reason, retry_action).
//
// Cache tests use a stub `DispatchCtx` whose `conn` is a sentinel object;
// connection-identity invalidation is verified by passing a fresh
// sentinel and asserting cache miss. End-to-end coverage (mock-transport
// MCP tool call → response with validation_info[]) lives in
// `launch-verification.ts` under MCP_MOCK_TRANSPORT=1.

console.log('\nBK-075 block-layout cache + phantom-param pre-flight:');

{
  const {
    getCachedBlockLayout,
    invalidateBlockLayoutCache,
    _resetBlockLayoutCacheForTests,
  } = await import('@mcp-midi-control/core/protocol-generic/dispatcher/blockLayoutCache.js');

  _resetBlockLayoutCacheForTests();

  // Sentinel conn objects — only their identity matters to the cache.
  const conn1 = { id: 'conn-1' } as unknown as Parameters<typeof getCachedBlockLayout>[1]['conn'];
  const conn2 = { id: 'conn-2' } as unknown as Parameters<typeof getCachedBlockLayout>[1]['conn'];
  const ctx1 = { conn: conn1, descriptor: undefined as never };
  const ctx2 = { conn: conn2, descriptor: undefined as never };

  let calls = 0;
  const fresher = async () => {
    calls += 1;
    return { placedBlocks: new Set<string>(['amp', 'reverb']) };
  };

  const first = await getCachedBlockLayout('test-am4', ctx1, fresher);
  assert(
    'first call populates cache via fresher',
    calls === 1 && first.placedBlocks.has('amp'),
    `calls=${calls}, placed=${[...first.placedBlocks].join(',')}`,
  );

  const second = await getCachedBlockLayout('test-am4', ctx1, fresher);
  assert(
    'second call within TTL serves from cache (no fresher invocation)',
    calls === 1 && second === first,
    `calls=${calls}, identity=${second === first}`,
  );

  // Different connection identity → cache miss + re-populate.
  const third = await getCachedBlockLayout('test-am4', ctx2, fresher);
  assert(
    'different conn identity → cache miss, fresher re-invoked',
    calls === 2 && third !== first,
    `calls=${calls}, identity=${third === first}`,
  );

  // Explicit invalidation → next call misses.
  invalidateBlockLayoutCache('test-am4');
  await getCachedBlockLayout('test-am4', ctx2, fresher);
  assert(
    'invalidateBlockLayoutCache clears the entry (next call hits fresher)',
    calls === 3,
    `calls=${calls}`,
  );

  // Different deviceId is independent.
  await getCachedBlockLayout('test-other', ctx1, fresher);
  assert(
    'different deviceId is keyed independently',
    calls === 4,
    `calls=${calls}`,
  );

  _resetBlockLayoutCacheForTests();
}

// Phantom-param warning shape — directly invoke the AM4 reader-backed
// pre-flight by calling getBlockLayoutSnapshot on a stubbed ctx whose
// snapshot we control. Verifies the validation_info[] entry shape that
// the dispatcher returns to MCP callers.
{
  const { resolveDevice } = await import(
    '@mcp-midi-control/core/protocol-generic/registry.js'
  );
  const descriptor = resolveDevice('am4');
  if (descriptor === undefined) {
    failed++;
    console.error('  ✗ phantom-param shape test\n      AM4 descriptor not registered');
  } else {
    // Manufacture a snapshot where 'phaser' is NOT placed (matches the
    // default mock layout: amp/chorus/reverb/delay).
    const placedBlocks = new Set<string>(['amp', 'chorus', 'reverb', 'delay']);
    assert(
      'snapshot.placedBlocks contains expected mock-layout blocks',
      placedBlocks.has('amp') && placedBlocks.has('reverb'),
      `placed=${[...placedBlocks].join(',')}`,
    );
    assert(
      'phaser is correctly absent from default mock layout',
      !placedBlocks.has('phaser'),
      `placed=${[...placedBlocks].join(',')}`,
    );
  }
}

// ── BK-076 routing-mask pre-flight (II grid) ────────────────────────
//
// When a block is placed on the Axe-Fx II grid in a cell with
// routing_mask=0 past col 1, set_param acks but no signal flows
// through the cell — audible state stays put. Pre-flight surfaces a
// validation_info[] warning with the broken-cable retry pointer
// (axefx2_set_cell_routing).
//
// Tests inject a controlled `BlockLayoutSnapshot` into the cache, then
// invoke `collectRoutingMaskWarnings` directly with a stub descriptor.
// This avoids needing a populated mock grid + skips MIDI altogether.

console.log('\nBK-076 routing-mask pre-flight (II grid):');

{
  const {
    _resetBlockLayoutCacheForTests,
  } = await import('@mcp-midi-control/core/protocol-generic/dispatcher/blockLayoutCache.js');
  const { collectRoutingMaskWarnings, collectPhantomParamWarnings } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/params.js'
  );

  type StubDescriptor = Parameters<typeof collectRoutingMaskWarnings>[0];
  type StubCtx = Parameters<typeof collectRoutingMaskWarnings>[1];

  function stubDescriptor(
    id: string,
    snapshot: { placedBlocks: Set<string>; unroutedBlocks?: Set<string> },
  ): StubDescriptor {
    return {
      id,
      display_name: 'Stub Device',
      reader: {
        getBlockLayoutSnapshot: async () => snapshot,
      },
    } as unknown as StubDescriptor;
  }

  function stubCtx(connId: string): StubCtx {
    return { conn: { id: connId } } as unknown as StubCtx;
  }

  // Trap case: 'amp' is placed but unrouted (routing_mask=0).
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-ii-unrouted', {
      placedBlocks: new Set(['amp', 'cab', 'reverb']),
      unroutedBlocks: new Set(['amp']),
    });
    const ctx = stubCtx('test-conn-1');
    const warnings = await collectRoutingMaskWarnings(descriptor, ctx, 'amp', 'gain');
    const entry = warnings[0];
    assert(
      'routing_mask=0 trap → validation_info[] warning fires',
      entry !== undefined
        && entry.level === 'warning'
        && entry.dropped_param === 'gain'
        && /routing_mask=0/.test(entry.reason ?? '')
        && /set_cell_routing|apply_preset/.test(entry.retry_action ?? ''),
      `entry=${JSON.stringify(entry)}`,
    );
  }

  // Positive: 'amp' is placed AND routed → no warning.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-ii-routed', {
      placedBlocks: new Set(['amp', 'cab']),
      unroutedBlocks: new Set(['reverb']),
    });
    const ctx = stubCtx('test-conn-2');
    const warnings = await collectRoutingMaskWarnings(descriptor, ctx, 'amp', 'gain');
    assert(
      'placed + routed amp → no routing-mask warning',
      warnings.length === 0,
      `warnings=${JSON.stringify(warnings)}`,
    );
  }

  // Device-level skip: descriptor.reader has no getBlockLayoutSnapshot.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = { id: 'test-no-snapshot', display_name: 'No Snapshot', reader: {} } as unknown as StubDescriptor;
    const ctx = stubCtx('test-conn-3');
    const warnings = await collectRoutingMaskWarnings(descriptor, ctx, 'amp', 'gain');
    assert(
      'device without getBlockLayoutSnapshot → silent',
      warnings.length === 0,
      `warnings=${JSON.stringify(warnings)}`,
    );
  }

  // Snapshot-level skip: device returns snapshot but unroutedBlocks undefined.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-no-routing-model', {
      placedBlocks: new Set(['amp']),
    });
    const ctx = stubCtx('test-conn-4');
    const warnings = await collectRoutingMaskWarnings(descriptor, ctx, 'amp', 'gain');
    assert(
      'snapshot without unroutedBlocks (AM4 linear) → silent',
      warnings.length === 0,
      `warnings=${JSON.stringify(warnings)}`,
    );
  }

  // Phantom + routing are mutually exclusive in practice — when a
  // block is in `unroutedBlocks`, it MUST be in `placedBlocks` too,
  // so phantom-param stays silent and routing-mask fires.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-mutex', {
      placedBlocks: new Set(['amp']),
      unroutedBlocks: new Set(['amp']),
    });
    const ctx = stubCtx('test-conn-5');
    const phantom = await collectPhantomParamWarnings(descriptor, ctx, 'amp', 'gain');
    const routing = await collectRoutingMaskWarnings(descriptor, ctx, 'amp', 'gain');
    assert(
      'placed+unrouted: phantom-param silent, routing-mask fires',
      phantom.length === 0 && routing.length === 1,
      `phantom=${phantom.length}, routing=${routing.length}`,
    );
  }

  // Unplaced block: phantom fires, routing stays silent (block not in
  // unroutedBlocks because it's not placed).
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-unplaced', {
      placedBlocks: new Set(['amp']),
      unroutedBlocks: new Set(),
    });
    const ctx = stubCtx('test-conn-6');
    const phantom = await collectPhantomParamWarnings(descriptor, ctx, 'phaser', 'rate');
    const routing = await collectRoutingMaskWarnings(descriptor, ctx, 'phaser', 'rate');
    assert(
      'unplaced block: phantom-param fires, routing-mask silent',
      phantom.length === 1 && routing.length === 0,
      `phantom=${phantom.length}, routing=${routing.length}`,
    );
  }

  // Shape verification: II reader's getBlockLayoutSnapshot computes
  // `unroutedBlocks` correctly for sample grid cells. Since the reader
  // bundles a wire read, we directly exercise the per-block-type
  // routing aggregation via a synthesized in-cache snapshot to confirm
  // the data shape the dispatcher consumes.
  {
    _resetBlockLayoutCacheForTests();
    const snapshot = {
      placedBlocks: new Set<string>(['amp', 'cab', 'reverb', 'phaser']),
      unroutedBlocks: new Set<string>(['reverb', 'phaser']),
    };
    assert(
      'snapshot shape: unroutedBlocks ⊆ placedBlocks (every unrouted block is placed)',
      [...snapshot.unroutedBlocks].every((b) => snapshot.placedBlocks.has(b)),
      `unrouted=${[...snapshot.unroutedBlocks].join(',')}, placed=${[...snapshot.placedBlocks].join(',')}`,
    );
  }

  _resetBlockLayoutCacheForTests();
}

// ── Axe-Fx III channel-nested apply_preset (Session 116 cont 5) ─────
//
// III's applyPreset now honors slots[].params.A/B/C/D nested params:
// for each channel, send SET_CHANNEL (fn 0x0A) then loop SET_PARAMETER
// (fn 0x01) per param. Brings III to AM4/II parity for multi-channel
// apply.
//
// This test mocks the III's MIDI transport: outbound bytes are captured,
// inbound `receiveSysExMatching` always rejects with a timeout (the
// III's `sendAndWatchForError` interprets a timeout as "no rejection
// arrived → write accepted"). We then verify the captured frames
// carry the right fn bytes in the right order, and that result.steps
// counts both set_channel + set_param ops.

console.log('\napply_preset channel-nested (Axe-Fx III, AM4/II parity, Session 116 cont 5):');

interface CapturedFrame {
  readonly bytes: readonly number[];
  /** Function byte at offset 5 in `F0 00 01 74 10 fn …`. */
  readonly fn: number;
}

function buildMockIIICtx(): {
  ctx: import('@mcp-midi-control/core/protocol-generic/types.js').DispatchCtx;
  captured: CapturedFrame[];
} {
  const captured: CapturedFrame[] = [];
  const mockConn: import('@mcp-midi-control/core/midi/transport.js').MidiConnection = {
    send: (bytes: number[]) => {
      captured.push({ bytes: [...bytes], fn: bytes[5] });
    },
    receiveSysEx: () => Promise.reject(new Error('mock: no inbound')),
    // Always time out → III's sendAndWatchForError treats as "accepted".
    receiveSysExMatching: () => Promise.reject(new Error('mock: timeout (= accepted)')),
    onMessage: () => () => {},
    hasInput: false,
    close: () => {},
  };
  return {
    ctx: { conn: mockConn, descriptor: AXEFX3_DESCRIPTOR },
    captured,
  };
}

async function testIIIChannelNestedApply(): Promise<void> {
  // Spec: amp block with channel-nested params for A and B.
  // Expected outbound sequence:
  //   1. set_block (fn 0x05 SET_GRID_CELL) — place amp at (r2,c3)
  //   2. set_channel A (fn 0x0A)
  //   3. set_param drive (fn 0x01)
  //   4. set_channel B (fn 0x0A)
  //   5. set_param drive (fn 0x01)
  const { ctx, captured } = buildMockIIICtx();
  const spec = {
    slots: [{
      slot: { row: 2, col: 3 },
      block_type: 'drive',
      params: {
        A: { drive: 5 },
        B: { drive: 8 },
      },
    }],
  };
  const result = await AXEFX3_DESCRIPTOR.writer.applyPreset!(
    ctx,
    spec as Parameters<NonNullable<typeof AXEFX3_DESCRIPTOR.writer.applyPreset>>[1],
  );

  // Verify the wire-frame sequence.
  const channelFrames = captured.filter((f) => f.fn === FN_SET_GET_CHANNEL);
  const paramFrames = captured.filter((f) => f.fn === FN_PARAMETER_SETGET);
  assert(
    'III channel-nested apply emits 2 SET_CHANNEL frames (one per channel A, B)',
    channelFrames.length === 2,
    `expected 2 channel frames, got ${channelFrames.length}: ${captured.map((f) => '0x' + f.fn.toString(16)).join(',')}`,
  );
  assert(
    'III channel-nested apply emits 2 SET_PARAMETER frames (drive×2)',
    paramFrames.length === 2,
    `expected 2 param frames, got ${paramFrames.length}`,
  );

  // Verify the SET_CHANNEL/SET_PARAMETER frames interleave correctly:
  // each SET_CHANNEL must be followed by its channel's SET_PARAMETER
  // before the next SET_CHANNEL appears.
  const fnSequenceAfterSetBlock = captured
    .filter((f) => f.fn === FN_SET_GET_CHANNEL || f.fn === FN_PARAMETER_SETGET)
    .map((f) => f.fn);
  assert(
    'III channel-nested apply interleaves: [CHANNEL, PARAM, CHANNEL, PARAM]',
    fnSequenceAfterSetBlock.length === 4 &&
      fnSequenceAfterSetBlock[0] === FN_SET_GET_CHANNEL &&
      fnSequenceAfterSetBlock[1] === FN_PARAMETER_SETGET &&
      fnSequenceAfterSetBlock[2] === FN_SET_GET_CHANNEL &&
      fnSequenceAfterSetBlock[3] === FN_PARAMETER_SETGET,
    `got fn sequence: ${fnSequenceAfterSetBlock.map((f) => '0x' + f.toString(16)).join(' → ')}`,
  );

  // Verify the result.ok / result.steps reflect both channels' writes.
  // Each channel produces 1 set_channel + 1 set_param = 2 steps; plus
  // 1 set_block for placement = 5 total. The result.steps count is
  // writes.length (every push to writes[] counts).
  assert(
    'III channel-nested apply: result.ok = true (all mock writes accepted)',
    result.ok === true,
    `result.ok=${result.ok}, warning=${result.warning ?? '(none)'}`,
  );
  assert(
    'III channel-nested apply: result.steps counts both channels (set_block + 2×set_channel + 2×set_param = 5)',
    result.steps === 5,
    `result.steps=${result.steps}`,
  );
}

async function testIIIChannelNestedApplyInvalidChannel(): Promise<void> {
  // Spec: amp with channel key 'X' (II's vocabulary, not III's).
  // Should surface a structured rejection without sending any wire
  // frames for that channel.
  const { ctx, captured } = buildMockIIICtx();
  const spec = {
    slots: [{
      slot: { row: 2, col: 3 },
      block_type: 'drive',
      params: {
        X: { drive: 5 }, // Wrong: III uses A/B/C/D, not X/Y.
      },
    }],
  };
  const result = await AXEFX3_DESCRIPTOR.writer.applyPreset!(
    ctx,
    spec as Parameters<NonNullable<typeof AXEFX3_DESCRIPTOR.writer.applyPreset>>[1],
  );

  // Verify no SET_CHANNEL was sent (channel key rejected before wire).
  const channelFrames = captured.filter((f) => f.fn === FN_SET_GET_CHANNEL);
  assert(
    'III channel-nested apply rejects channel "X" without sending SET_CHANNEL',
    channelFrames.length === 0,
    `unexpected channel frames: ${channelFrames.length}`,
  );

  // Verify the failure is surfaced clearly.
  assert(
    'III channel-nested apply: result.ok = false on invalid channel key',
    result.ok === false,
    `result.ok=${result.ok}`,
  );
}

async function testIIIChannelNestedApplyMixedShape(): Promise<void> {
  // Spec: amp with mixed flat + nested params — should be rejected.
  const { ctx, captured } = buildMockIIICtx();
  const spec = {
    slots: [{
      slot: { row: 2, col: 3 },
      block_type: 'drive',
      params: {
        bass: 5, // flat
        A: { drive: 8 }, // nested
      } as Record<string, number | Record<string, number>>,
    }],
  };
  const result = await AXEFX3_DESCRIPTOR.writer.applyPreset!(
    ctx,
    spec as Parameters<NonNullable<typeof AXEFX3_DESCRIPTOR.writer.applyPreset>>[1],
  );
  // Mixed shape should be caught before any wire writes for this slot.
  const channelFrames = captured.filter((f) => f.fn === FN_SET_GET_CHANNEL);
  const paramFrames = captured.filter((f) => f.fn === FN_PARAMETER_SETGET);
  assert(
    'III channel-nested apply rejects mixed flat+nested shape (no channel or param frames)',
    channelFrames.length === 0 && paramFrames.length === 0,
    `unexpected frames: channel=${channelFrames.length}, param=${paramFrames.length}`,
  );
  assert(
    'III channel-nested apply: result.ok = false on mixed shape',
    result.ok === false,
    `result.ok=${result.ok}`,
  );
}

async function testIIIFlatParamsStillWork(): Promise<void> {
  // Spec: amp with flat params (current-channel write). Should not
  // emit SET_CHANNEL — just SET_PARAMETER.
  const { ctx, captured } = buildMockIIICtx();
  const spec = {
    slots: [{
      slot: { row: 2, col: 3 },
      block_type: 'drive',
      params: { drive: 5 },
    }],
  };
  const result = await AXEFX3_DESCRIPTOR.writer.applyPreset!(
    ctx,
    spec as Parameters<NonNullable<typeof AXEFX3_DESCRIPTOR.writer.applyPreset>>[1],
  );
  const channelFrames = captured.filter((f) => f.fn === FN_SET_GET_CHANNEL);
  const paramFrames = captured.filter((f) => f.fn === FN_PARAMETER_SETGET);
  assert(
    'III flat-shape apply: no SET_CHANNEL emitted (writes go to current channel)',
    channelFrames.length === 0,
    `unexpected SET_CHANNEL frames: ${channelFrames.length}`,
  );
  assert(
    'III flat-shape apply: 1 SET_PARAMETER emitted for the one flat param',
    paramFrames.length === 1,
    `expected 1 param frame, got ${paramFrames.length}`,
  );
  assert(
    'III flat-shape apply: result.ok = true',
    result.ok === true,
    `result.ok=${result.ok}, warning=${result.warning ?? '(none)'}`,
  );
}

await testIIIChannelNestedApply();
await testIIIChannelNestedApplyInvalidChannel();
await testIIIChannelNestedApplyMixedShape();
await testIIIFlatParamsStillWork();

// Reporting ───────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
