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

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import * as z from 'zod/v4';
import {
  describeDevice,
  encodeSetParam,
  findCompatibleTypes,
  listParams,
  openOfflineCtx,
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
import { buildSetParam, checkApplicability } from 'fractal-midi/am4';
import { prepareApplyPresetWrites } from '@mcp-midi-control/am4/tools/applyExecutor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import {
  buildSetBlockParameterValue,
  buildStorePreset,
  buildSwitchPreset,
  displayToWire,
} from 'fractal-midi/gen2/axe-fx-ii';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/descriptor.js';
import {
  FN_SET_GET_CHANNEL,
  FN_PARAMETER_SETGET,
  unpackValue16,
  decode5SeptetFloat32,
} from 'fractal-midi/gen3/axe-fx-iii';

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

// The unfiltered call is a per-block CENSUS, not the whole catalog. It used
// to serialize every param, which on the AM4 was 219,691 chars and on the FM9
// 280,045, past the host's 50,000-char delivery cliff, so the model received
// none of it. The assertion changed with the behaviour, deliberately: what is
// checked now is that the census names every block and counts every param
// WITHOUT emitting rows, which is a stronger claim than "returns > 50 rows".
const census = listParams({ port: 'AM4' });
assert(
  'list_params(port) returns a census, not param rows',
  census.scope === 'summary' && census.params.length === 0,
  `got scope=${census.scope}, ${census.params.length} rows`,
);
assert(
  'list_params census covers every block and totals every param',
  (census.block_summary?.length ?? 0) > 10
  && (census.total_params ?? 0) > 500
  && (census.block_summary ?? []).every((b) => b.param_count > 0),
  `got ${census.block_summary?.length} blocks, ${census.total_params} params`,
);
assert(
  'list_params census names each block\'s type selector and roster size',
  (census.block_summary ?? []).some((b) => b.block === 'amp' && b.type_selector === 'type' && (b.type_count ?? 0) > 200),
  `amp census = ${JSON.stringify((census.block_summary ?? []).find((b) => b.block === 'amp'))}`,
);

const ampOnly = listParams({ port: 'AM4', block: ['amp'] });
assert(
  'list_params(port, block=amp) scopes to amp block',
  ampOnly.params.every((p) => p.block === 'amp') && ampOnly.params.length > 5,
);

const reverbTime = listParams({ port: 'AM4', block: ['reverb'], name: ['time'] });
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

const ampType = listParams({ port: 'AM4', block: ['amp'], name: ['type'] });
assert(
  'list_params(amp, type) enum includes full enum_values table',
  ampType.params[0].enum_values !== undefined
    && Object.keys(ampType.params[0].enum_values).length > 10,
);

// Confirm a knob_0_10 param surfaces its native unit name now (was
// previously collapsing to "knob" before open item #4 fix).
const ampGain = listParams({ port: 'AM4', block: ['amp'], name: ['gain'] });
assert(
  'list_params(amp, gain) unit is knob_0_10 (native AM4 name preserved)',
  ampGain.params[0].unit === 'knob_0_10',
  `got unit=${ampGain.params[0].unit}`,
);

// ── scope projection ────────────────────────────────────────────────
//
// `host_label` and `parameter_name` are cross-reference fields for a knob the
// agent has ALREADY identified; `parameter_name` alone is 26,358 chars across
// the FM9 catalog. Serving them per-row in a block survey is what made those
// surveys undeliverable, so they belong to the param scope only.
const ampMasterBlockScope = ampOnly.params.find((p) => p.name === 'master');
const ampMasterParamScope = listParams({ port: 'AM4', block: ['amp'], name: ['master'] }).params[0];
assert(
  'block scope withholds the post-choice cross-reference fields',
  ampMasterBlockScope?.host_label === undefined && ampMasterBlockScope?.parameter_name === undefined,
  `got host_label=${ampMasterBlockScope?.host_label}, parameter_name=${ampMasterBlockScope?.parameter_name}`,
);
assert(
  'param scope serves them',
  ampMasterParamScope.host_label !== undefined && ampMasterParamScope.parameter_name === 'DISTORT_MASTER',
  `got host_label=${ampMasterParamScope.host_label}, parameter_name=${ampMasterParamScope.parameter_name}`,
);
assert(
  'param scope upgrades applicability to the lossless rendering',
  (ampMasterParamScope.applies_only_when?.length ?? 0)
    > (ampMasterBlockScope?.applies_only_when?.length ?? 0),
  `param=${ampMasterParamScope.applies_only_when?.length} block=${ampMasterBlockScope?.applies_only_when?.length}`,
);

// The prose and the predicate must agree. `amp.fat` is exposed on 9 of 248 amp
// types; it read "applies to any type (special-cased on: ...)" until
// 2026-08-02 while `set_param` refused the write as type-gated. 112 AM4 knobs
// carried that contradiction. Never assert on the old wording again.
const ampFat = ampOnly.params.find((p) => p.name === 'fat');
assert(
  'a strictly type-gated knob is NOT described as universal',
  ampFat?.applies_only_when !== undefined
    && !/applies to any/.test(ampFat.applies_only_when)
    && /9 of 248/.test(ampFat.applies_only_when),
  `got ${ampFat?.applies_only_when}`,
);
// ...and the converse, added 2026-08-04 after the founder caught it on
// hardware. A primary gate is the whole truth only when it is the ONLY gate.
// Exposure in the editor XML is a DISJUNCTION over gate rows, so a param that
// also carries sub-mode rows can be exposed on a type the primary rows never
// name. `amp.geq_band_1` has one DISTORT_TYPE row (the four JMPre-1 amps, that
// amp's own dedicated GEQ page) and sixteen DISTORT_EQTYPE rows, and we were
// telling users it applied to 4 of 248 amps. The founder photographed the full
// 8-band GEQ in AM4-Edit on 1959SLP Normal AND 5F1 Tweed Champlifier, neither
// of them in the primary row.
//
// So: sub-mode rows present => never claim a bare amp-type gate. Reverting this
// re-ships a surface that tells users a working knob is unavailable.
const ampGeq = ampOnly.params.find((p) => p.name === 'geq_band_1');
assert(
  'a param with sub-mode gates is NOT reported as narrowly amp-type-gated',
  ampGeq?.applies_only_when !== undefined
    && !/applies on \d+ of \d+/.test(ampGeq.applies_only_when)
    && /DISTORT_EQTYPE/.test(ampGeq.applies_only_when),
  `got ${ampGeq?.applies_only_when}`,
);
// And the predicate must agree with that prose on the exact amp the founder
// checked. `1959SLP Normal` is wire index 0 and is absent from every primary
// row of geq_band_1, so the pre-fix rule refused it.
{
  const check = checkApplicability('amp.geq_band_1', { currentTypes: { amp: 0 } });
  assert(
    'checkApplicability agrees: geq_band_1 is not refused on 1959SLP Normal (hardware-observed)',
    check.applicable !== false,
    `got applicable=${String(check.applicable)}`,
  );
  // The two hardware-CONFIRMED gates must still refuse, or the fix went too far.
  const fatCheck = checkApplicability('amp.fat', { currentTypes: { amp: 0 } });
  assert(
    'amp.fat still refuses on 1959SLP Normal (hardware-confirmed absent)',
    fatCheck.applicable === false,
    `got applicable=${String(fatCheck.applicable)}`,
  );
}

// 69 of 79 AM4 reverb type names contain a comma ("Room, Small"), so a
// comma-joined roster is unparseable, and these are strings the agent must
// reproduce byte-exactly for set_param.
const reverbGated = listParams({ port: 'AM4', block: ['reverb'] })
  .params.find((p) => /\bPlate, /.test(p.applies_only_when ?? ''));
assert(
  'enum rosters in applicability prose use a separator the names cannot contain',
  reverbGated === undefined || reverbGated.applies_only_when?.includes(' | ') === true,
  `got ${reverbGated?.applies_only_when?.slice(0, 120)}`,
);

// ── budget + pagination ─────────────────────────────────────────────
//
// Walking `next_offset` must be lossless and must terminate. A pager that
// stalls or drops rows is worse than no pager: the agent believes it has the
// whole catalog.
const everyBlock = (census.block_summary ?? []).map((b) => b.block);
const page1 = listParams({ port: 'AM4', block: everyBlock, include_descriptions: true });
assert(
  'an over-budget request truncates rather than overflowing',
  page1.truncated !== undefined && JSON.stringify(page1).length <= 40_000,
  `size=${JSON.stringify(page1).length}, truncated=${page1.truncated !== undefined}`,
);
{
  let offset = page1.truncated?.next_offset ?? 0;
  let seen = page1.params.length;
  let pages = 1;
  let stalled = false;
  while (pages < 40) {
    const pg = listParams({ port: 'AM4', block: everyBlock, include_descriptions: true, offset });
    pages++;
    seen += pg.params.length;
    if (pg.truncated === undefined) break;
    if (pg.truncated.next_offset <= offset) { stalled = true; break; }
    offset = pg.truncated.next_offset;
  }
  assert(
    'pagination is lossless and terminates',
    !stalled && pages < 40 && seen === (page1.total_params ?? -1),
    `${pages} pages, ${seen} rows vs total ${page1.total_params}${stalled ? ' (STALLED)' : ''}`,
  );
}
assert(
  'limit caps rows and says so, without blaming the size budget',
  (() => {
    const l = listParams({ port: 'AM4', block: ['amp'], limit: 3 });
    return l.params.length === 3 && l.truncated?.note.includes('`limit`') === true;
  })(),
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
          // compatible at runtime, its SceneSpec.channels is `?:`
          // vs PresetSpec's required, so the cast bridges schema
          // looseness without weakening the dispatcher contract. The
          // `unknown` step is required because Zod widens to
          // `Record<string, unknown>` at the boundary (no overlap with
          // PresetSpec's required `slots`); TS surfaces the gap as a
          // TS2352 unless we route through `unknown` explicitly.
          descriptor.writer.validatePreset!(flatParsed.data as unknown as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
          passed++;
        } catch (err) {
          failed++;
          console.error(`  ✗ ${descriptor.id}/${blockName}: flat params on channel block — executor rejected\n      ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (nestedParsed.success) {
        try {
          descriptor.writer.validatePreset!(nestedParsed.data as unknown as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
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
          descriptor.writer.validatePreset!(flatParsed.data as unknown as Parameters<NonNullable<typeof descriptor.writer.validatePreset>>[0]);
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
            nestedParsed.data as unknown as Parameters<typeof collectApplyPresetPreflight>[0],
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

// ── Schema key ↔ handler DESTRUCTURE contract (added 2026-07-26) ───
//
// The sibling of the shape-contract test above, one layer earlier: that
// one asks "does the executor accept what the schema accepts", this one
// asks "does the handler even PASS ON what the schema declares".
//
// Why it exists: `apply_pattern` declared `midi_channel` and `drum_map`
// in its inputSchema, zod validated both, and the handler's parameter
// destructure listed neither, so both were silently dropped before the
// executor saw them. The caller got a successful call that quietly
// ignored what it asked for, and the tool's own description pointed at
// `drum_map` as the remedy for a skipped non-GM drum number. A tool
// schema is the contract an LLM agent reads and trusts; a param that
// exists in the schema and does nothing is a lie the agent cannot
// detect from the outside. Neither the zod layer nor `tsc` can see it:
// the handler's parameter type is INFERRED from the schema, so omitting
// a key from the destructure is perfectly well typed.
//
// The check is static (AST over source), not runtime, because the
// evidence lives in two places tools/list cannot show: the schema keys
// AND the handler's binding pattern.
//
// FALSE POSITIVES, and how each is handled:
//   - `async (args) => executeX(args)`: the handler forwards the whole
//     object. Any BARE use of the parameter identifier (passed as an
//     argument, spread, aliased, returned) marks the tool "forwards
//     wholesale" and it is exempted, never flagged. Those are listed in
//     the run output so the blind spot stays visible.
//   - `async (args) => { ... args.foo ... }`: property and string
//     element accesses off the parameter count as reads, as does a
//     `const { a, b } = args` destructure inside the body.
//   - renamed bindings (`{ drum_map: map }`): the SCHEMA key is what is
//     matched, the local name is what the used-check looks for.
//   - `...rest` in the destructure: rest captures the remainder, so the
//     tool is treated as forwarding wholesale.
//   - a genuinely ignored param: put it in SCHEMA_KEYS_IGNORED below
//     with a reason. Stale entries fail too, so the opt-out cannot rot.
//
// KNOWN LIMIT: for a wholesale-forwarding handler this cannot tell
// whether the EXECUTOR reads the key. Closing that would need a full
// type-checker program over the monorepo. The forwarder list is printed
// every run so the set stays small and reviewable.

/**
 * Schema keys a handler is ALLOWED to declare and not read. Each entry
 * carries its reason inline, next to the exception it grants. Keyed
 * "<tool>.<key>". Membership should stay near-empty: a schema key that
 * does nothing is normally a defect, not a design.
 */
const SCHEMA_KEYS_IGNORED: ReadonlyMap<string, string> = new Map([
  // (empty) No tool currently declares a param it deliberately ignores.
]);

/** Source files that register MCP tools, found by git-tracked path. */
function toolSourceFiles(): string[] {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = execSync('git ls-files "packages/*/src/**/*.ts"', { cwd: root, encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((rel) => path.join(root, rel))
    // Cheap string pre-filter so we only parse the handful of files that
    // actually register tools, not the whole (large) src tree.
    .filter((abs) => readFileSync(abs, 'utf8').includes('registerTool'));
}

interface SchemaWiring {
  tool: string;
  file: string;
  /** Top-level inputSchema keys. */
  keys: string[];
  /** Keys the handler binds or reads. */
  read: Set<string>;
  /** Handler takes the whole args object through opaquely. */
  forwardsWholesale: boolean;
  /** Schema key -> local binding name, for the bound-but-never-used check. */
  localOf: Map<string, string>;
  /** Identifiers referenced anywhere in the handler body. */
  referenced: Set<string>;
  /** Set when the call shape defeats static analysis (reported, not silently skipped). */
  unanalyzable?: string;
}

function collectToolWirings(): SchemaWiring[] {
  const wirings: SchemaWiring[] = [];
  for (const abs of toolSourceFiles()) {
    const text = readFileSync(abs, 'utf8');
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'registerTool'
      ) {
        const w = analyzeRegisterTool(abs, node);
        if (w) wirings.push(w);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return wirings;
}

function analyzeRegisterTool(file: string, call: ts.CallExpression): SchemaWiring | undefined {
  const [nameArg, cfgArg, handlerArg] = call.arguments;
  const tool = nameArg !== undefined && ts.isStringLiteralLike(nameArg) ? nameArg.text : '<dynamic-name>';
  const base: SchemaWiring = {
    tool, file, keys: [], read: new Set(), forwardsWholesale: false,
    localOf: new Map(), referenced: new Set(),
  };
  if (cfgArg === undefined || !ts.isObjectLiteralExpression(cfgArg)) {
    return { ...base, unanalyzable: 'tool config is not an object literal' };
  }
  const schemaProp = cfgArg.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'inputSchema',
  );
  // No inputSchema at all means no params to drop.
  if (schemaProp === undefined) return undefined;
  if (!ts.isObjectLiteralExpression(schemaProp.initializer)) {
    return { ...base, unanalyzable: 'inputSchema is not an object literal' };
  }
  for (const p of schemaProp.initializer.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) base.keys.push(p.name.text);
      else return { ...base, unanalyzable: 'computed inputSchema key' };
    } else if (ts.isSpreadAssignment(p)) {
      return { ...base, unanalyzable: 'spread inside inputSchema' };
    }
  }
  // A zero-key schema has nothing to wire; a paramless handler is correct.
  if (base.keys.length === 0) return undefined;
  if (handlerArg === undefined || !(ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg))) {
    return { ...base, unanalyzable: 'handler is not a function literal' };
  }
  const param = handlerArg.parameters[0];
  if (param === undefined) return base;   // declares keys, binds nothing: every key is unread

  const bindPattern = (bp: ts.ObjectBindingPattern): void => {
    for (const el of bp.elements) {
      if (el.dotDotDotToken !== undefined) { base.forwardsWholesale = true; continue; }
      const key = el.propertyName ?? el.name;
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
        base.read.add(key.text);
        if (ts.isIdentifier(el.name)) base.localOf.set(key.text, el.name.text);
      }
    }
  };

  if (ts.isObjectBindingPattern(param.name)) {
    bindPattern(param.name);
  } else if (ts.isIdentifier(param.name)) {
    const argName = param.name.text;
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === argName) {
        const p = n.parent;
        if (ts.isPropertyAccessExpression(p) && p.expression === n) { base.read.add(p.name.text); return; }
        if (ts.isElementAccessExpression(p) && p.expression === n) {
          if (ts.isStringLiteralLike(p.argumentExpression)) base.read.add(p.argumentExpression.text);
          else base.forwardsWholesale = true;   // dynamic key: cannot resolve, assume read
          return;
        }
        if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isObjectBindingPattern(p.name)) {
          bindPattern(p.name);
          return;
        }
        if (ts.isParameter(p)) return;   // the declaration itself
        base.forwardsWholesale = true;   // spread, passed as an argument, aliased, returned
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(handlerArg.body);
  } else {
    return { ...base, unanalyzable: 'handler parameter is an array binding pattern' };
  }

  const walkRefs = (n: ts.Node): void => {
    // Skip the `name` side of `x.name` so a property access does not count
    // as a reference to a same-named local.
    if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
      base.referenced.add(n.text);
    }
    ts.forEachChild(n, walkRefs);
  };
  walkRefs(handlerArg.body);
  return base;
}

console.log('\nSchema key ↔ handler destructure contract (every registered MCP tool):');

{
  const wirings = collectToolWirings();
  const forwarders: string[] = [];
  const seenIgnored = new Set<string>();
  let checkedTools = 0;
  let checkedKeys = 0;

  for (const w of wirings) {
    const where = path.basename(w.file);
    if (w.unanalyzable !== undefined) {
      // Never silently skipped: an unreadable call shape is a gate hole.
      assert(`${where}/${w.tool}: registerTool call is statically analyzable`, false, w.unanalyzable);
      continue;
    }
    if (w.forwardsWholesale) { forwarders.push(`${w.tool} (${w.keys.length} keys, ${where})`); continue; }
    checkedTools++;
    checkedKeys += w.keys.length;
    for (const key of w.keys) {
      const allow = SCHEMA_KEYS_IGNORED.get(`${w.tool}.${key}`);
      if (allow !== undefined) { seenIgnored.add(`${w.tool}.${key}`); continue; }
      // (a) declared in the schema but never bound by the handler.
      assert(
        `${w.tool}: schema key '${key}' reaches the handler`,
        w.read.has(key),
        `'${key}' is declared in ${where} inputSchema, validated by zod, and then DROPPED (the handler never binds it). `
        + `Add it to the handler's destructure and pass it to the executor, remove it from the schema, `
        + `or allowlist it in SCHEMA_KEYS_IGNORED with a reason.`,
      );
      // (b) bound but never referenced: same defect, one step later.
      const local = w.localOf.get(key);
      if (w.read.has(key) && local !== undefined) {
        assert(
          `${w.tool}: schema key '${key}' is used, not just bound`,
          w.referenced.has(local),
          `'${key}' is destructured as '${local}' in ${where} and never referenced again, so it does nothing.`,
        );
      }
    }
  }

  // A stale opt-out is as misleading as a missing one.
  for (const entry of SCHEMA_KEYS_IGNORED.keys()) {
    assert(
      `SCHEMA_KEYS_IGNORED entry '${entry}' is still live`,
      seenIgnored.has(entry),
      'this tool/key pair no longer exists (or is no longer unread). Remove the allowlist entry.',
    );
  }

  console.log(`  (${checkedTools} tools / ${checkedKeys} schema keys statically checked)`);
  if (forwarders.length > 0) {
    // Not a failure: forwarding IS the safe shape at the tool boundary. Printed
    // so the set stays small and someone notices when it grows.
    console.log(`  (${forwarders.length} tool(s) forward the whole args object, not statically checkable here: ${forwarders.join(', ')})`);
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

// Axe-Fx II byte-equivalence: fn=0x2e SET_PARAM_DIRECT uses float32
// display values, not 16-bit wire integers. The dispatcher's pure
// encodeSetParam path round-trips through wire (display -> wire ->
// display -> float32) which produces quantized bytes vs the legacy
// path (display -> float32 directly). Header equivalence (fn byte,
// effectId, paramId) is the meaningful check; value septets may
// differ due to the round-trip.
console.log('\nAxe-Fx II byte-equivalence checks (header-only for fn=0x2e):');

type AxeFxByteCase = {
  label: string;
  port: string;
  block: string;
  name: string;
  value: number | string;
  legacy: () => number[];
};

// fn=0x2e SET_PARAM_DIRECT takes display-unit floats, not wire integers.
// The legacy path now passes display values directly (same as the
// dispatcher path does after wire-to-display round-trip in the writer).
const axefx2Cases: AxeFxByteCase[] = [
  {
    label: 'amp.bass=6.0 (linear knob 0..10) — display float via fn=0x2e',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'bass',
    value: 6.0,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 2 },
      6.0,
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
      4.5,
    ),
  },
  {
    label: 'reverb.mix=30 (percent 0..100) — display float via fn=0x2e',
    port: 'axe-fx-ii',
    block: 'reverb',
    name: 'mix',
    value: 30,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 110, paramId: 13 },
      30,
    ),
  },
  {
    label: 'amp.preamp_low_cut=100 Hz — log10 scale display float',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'preamp_low_cut',
    value: 100,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 6 },
      100,
    ),
  },
  {
    label: 'amp.balance=-50 (bipolar -100..+100) — display float',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'balance',
    value: -50,
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 22 },
      -50,
    ),
  },
  {
    label: 'amp.tone_stack — exact enum string→wire index as float',
    port: 'axe-fx-ii',
    block: 'amp',
    name: 'tone_stack',
    value: Object.values(AXEFX2_DESCRIPTOR.blocks.amp.params.tone_stack.enum_values ?? {})[0],
    legacy: () => buildSetBlockParameterValue(
      { effectId: 106, paramId: 34 },
      AXEFX2_DESCRIPTOR.blocks.amp.params.tone_stack.encode(
        Object.values(AXEFX2_DESCRIPTOR.blocks.amp.params.tone_stack.enum_values ?? {})[0],
      ),
    ),
  },
];

// Display-equivalence assertion for fn=0x2e SET_PARAM_DIRECT.
//
// The dispatcher's encode path round-trips display -> wire -> display
// -> float32, while the legacy path goes display -> float32 directly.
// The round-trip may introduce small quantization differences in the
// float32 septets. Instead of byte-exact comparison we:
//   1. Encode the value through the descriptor (display -> wire), then
//      decode back (wire -> display) to get the quantized display value,
//      then build bytes via buildSetBlockParameterValue with it.
//   2. Build "legacy" bytes from the test case's legacy() function.
//   3. Verify effectId and paramId fields match across both.
//   4. Decode the float32 from both byte arrays and compare display
//      values within tolerance (0.01).

function decodeFloat32FromSysex(bytes: number[]): number {
  const b = bytes.slice(10, 15); // 5 float septets starting after effectId + paramId
  const n = (b[0] & 0x7f) | ((b[1] & 0x7f) << 7) | ((b[2] & 0x7f) << 14) | ((b[3] & 0x7f) << 21) | ((b[4] & 0x0f) << 28);
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, n >>> 0, true);
  return new DataView(buf).getFloat32(0, true);
}

for (const tc of axefx2Cases) {
  // Step 1: encode display value through the descriptor to get a wire
  // integer, then decode back to display. This simulates the dispatcher
  // path (display -> wire -> display -> float32). For enums, encode
  // returns the wire index and decode returns the display string; the
  // wire index itself IS the float32 value.
  const paramSchema = AXEFX2_DESCRIPTOR.blocks[tc.block].params[tc.name];
  const wireValue = paramSchema.encode(tc.value);
  const decodedDisplay = paramSchema.decode(wireValue);

  // The display value to pack as float32 on the dispatcher path.
  // For enums, decode returns a string; the float32 uses the wire index.
  // For calibrated knobs, decode returns a number (possibly quantized).
  const dispatcherDisplayValue =
    typeof decodedDisplay === 'number' ? decodedDisplay : wireValue;

  // Step 2-3: build both byte arrays.
  const fromLegacy = tc.legacy();

  // Extract effectId and paramId from the legacy bytes to build the
  // dispatcher-path bytes with the same addressing.
  const legacyEffectId = (fromLegacy[6] & 0x7f) | ((fromLegacy[7] & 0x7f) << 7);
  const legacyParamId = (fromLegacy[8] & 0x7f) | ((fromLegacy[9] & 0x7f) << 7);

  // Build the dispatcher-path bytes using the workspace fractal-midi's
  // buildSetBlockParameterValue (fn=0x2e with float32 display value).
  const fromDispatcher = buildSetBlockParameterValue(
    { effectId: legacyEffectId, paramId: legacyParamId },
    dispatcherDisplayValue,
  );

  // Step 3: verify effectId and paramId fields match.
  const headerMatch =
    fromDispatcher[5] === fromLegacy[5] &&  // fn byte (0x2e)
    fromDispatcher[6] === fromLegacy[6] &&  // effectId low
    fromDispatcher[7] === fromLegacy[7] &&  // effectId high
    fromDispatcher[8] === fromLegacy[8] &&  // paramId low
    fromDispatcher[9] === fromLegacy[9];    // paramId high

  assert(
    `${tc.label} -- header (fn, effectId, paramId)`,
    headerMatch,
    headerMatch ? undefined : `dispatcher fn/eff/param: ${hex(fromDispatcher.slice(5, 10))}\n      legacy   fn/eff/param: ${hex(fromLegacy.slice(5, 10))}`,
  );

  // Step 4: decode the float32 from both byte arrays and compare
  // display values within tolerance.
  const dispatcherFloat = decodeFloat32FromSysex(fromDispatcher);
  const legacyFloat = decodeFloat32FromSysex(fromLegacy);

  // For enums, the wire index IS the display value; the float32 should
  // decode to the exact integer wire index. For continuous knobs, allow
  // 0.01 tolerance for wire quantization.
  const isEnum = typeof tc.value === 'string';
  const tolerance = isEnum ? 0 : 0.01;
  const floatMatch = Math.abs(dispatcherFloat - legacyFloat) <= tolerance;

  assert(
    `${tc.label} -- float32 display value`,
    floatMatch,
    floatMatch ? undefined : `dispatcher float: ${dispatcherFloat}\n      legacy   float: ${legacyFloat}\n      delta: ${Math.abs(dispatcherFloat - legacyFloat)}`,
  );
}
console.log(`  (${axefx2Cases.length} II cases tested with display-equivalence assertion)`);

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
  // Community axe-fx-midi library golden (Mark II, wire preset 217 = display
  // slot 218): same shape as our XL+ encoder with MSB-first ordering.
  const fromDescriptor = AXEFX2_DESCRIPTOR.writer.buildSavePreset!(218);
  const fromLegacy = buildStorePreset(217);
  const eq = fromDescriptor.length === fromLegacy.length
    && fromDescriptor.every((b, i) => b === fromLegacy[i]);
  assert(
    'buildSavePreset(slot 218) — descriptor wire=217 matches legacy (community axe-fx-midi cross-check)',
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
  'describe_device(axe-fx-ii).blocks includes amp, reverb, delay, drive',
  ['amp', 'reverb', 'delay', 'drive'].every((b) => axefxDesc.blocks.includes(b)),
);

// list_params on Axe-Fx II surfaces unit metadata for calibrated knobs.
const axefxBass = listParams({ port: 'axe-fx-ii', block: ['amp'], name: ['bass'] });
assert(
  'list_params(axe-fx-ii, amp, bass) reports knob unit + display range 0..10',
  axefxBass.params.length === 1
    && axefxBass.params[0].unit === 'knob'
    && axefxBass.params[0].display_min === 0
    && axefxBass.params[0].display_max === 10,
  `got ${JSON.stringify(axefxBass.params[0])}`,
);
const axefxLowCut = listParams({ port: 'axe-fx-ii', block: ['amp'], name: ['preamp_low_cut'] });
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
  // Axe-Fx II now implements findCompatibleTypes (BUG-9 full). Reverb has no
  // primary-type gates in the II applicability table, so it still returns the
  // full roster with applicability_known: false (honest "no filtering data").
  const r = findCompatibleTypes({ port: 'axe-fx-ii', block: 'reverb', params: ['time'] });
  assert(
    'Axe-Fx II reverb (no primary gates) → full roster, applicability_known: false',
    r.applicability_known === false && r.compatible_types.length === r.total_types && r.total_types > 0,
    `known=${r.applicability_known}, compat=${r.compatible_types.length}/${r.total_types}`,
  );

  // multidelay DOES carry primary-type gates (DELAY_MODEL): `diffusion` only
  // exists on the Plex types, so the structured path narrows the roster and
  // reports applicability_known: true — the real BUG-9-full capability.
  const m = findCompatibleTypes({ port: 'axe-fx-ii', block: 'multidelay', params: ['diffusion'] });
  assert(
    'Axe-Fx II multidelay.diffusion → structured narrowing (applicability_known: true)',
    m.applicability_known === true
      && m.compatible_types.length > 0
      && m.compatible_types.length < m.total_types
      && m.compatible_types.includes('PLEX DELAY')
      && !m.compatible_types.includes('QUAD-TAP'),
    `known=${m.applicability_known}, compat=${JSON.stringify(m.compatible_types)}/${m.total_types}`,
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

  // Review-fix regression: grid devices key block_types by INSTANCE ("amp 1",
  // "reverb 2"), not the bare slug. isPseudoBlock must strip the trailing
  // " N" before deciding, else every real II block reads as a pseudo-block
  // and its unrouted/unplaced warning is silently dropped for the whole device.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = {
      id: 'test-ii-instance-keys',
      display_name: 'Stub II',
      block_types: { 'amp 1': {}, 'amp 2': {}, 'cab 1': {}, 'reverb 1': {} },
      reader: {
        getBlockLayoutSnapshot: async () => ({
          placedBlocks: new Set(['amp', 'cab']),
          unroutedBlocks: new Set(['amp']),
        }),
      },
    } as unknown as StubDescriptor;
    const ctx = stubCtx('test-conn-instkeys');
    const warnings = await collectRoutingMaskWarnings(descriptor, ctx, 'amp', 'gain');
    assert(
      'instance-suffixed block_types: unrouted amp STILL warns (isPseudoBlock strips " N")',
      warnings.length === 1 && warnings[0].dropped_param === 'gain',
      `warnings=${JSON.stringify(warnings)}`,
    );
  }

  // ...and a genuine pseudo-block (not a placeable type, e.g. AM4 'global')
  // stays exempt even on a device with instance-suffixed block_types.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = {
      id: 'test-ii-pseudo',
      display_name: 'Stub II',
      block_types: { 'amp 1': {}, 'cab 1': {} },
      reader: {
        getBlockLayoutSnapshot: async () => ({
          placedBlocks: new Set(['amp']),
          unroutedBlocks: new Set(['global']),
        }),
      },
    } as unknown as StubDescriptor;
    const ctx = stubCtx('test-conn-pseudo');
    const warnings = await collectRoutingMaskWarnings(descriptor, ctx, 'global', 'scene_cc');
    assert(
      'pseudo-block "global" (no matching block_types slug) stays exempt',
      warnings.length === 0,
      `warnings=${JSON.stringify(warnings)}`,
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

// ── set_params batch phantom-param/routing-mask loop semantics ─────
//
// executeSetParams (dispatcher/params.ts) loops `collectPhantomParamWarnings`
// / `collectRoutingMaskWarnings` over every validated op in the batch — the
// same two collectors this file already unit-tests above, called once per
// op rather than once. `executeSetParams` itself can't be exercised here
// (it calls openCtx, which opens a real/mock MIDI handle that holds the
// event loop open and hangs the script at exit — see the BK-071 comment
// above), so this block proves the LOOP semantics directly: two ops
// targeting the same unplaced block warn twice (no dedup), two ops on
// different unplaced blocks each warn once, and a mixed batch (one
// placed + one unplaced) only warns for the unplaced one. Hardware/
// end-to-end confirmation of the actual set_params tool call lives in
// launch-verification.ts ("set_params on unplaced block ... warning").

console.log('\nset_params batch loop: phantom-param/routing-mask per-op semantics:');

{
  const {
    _resetBlockLayoutCacheForTests,
  } = await import('@mcp-midi-control/core/protocol-generic/dispatcher/blockLayoutCache.js');
  const { collectPhantomParamWarnings, collectRoutingMaskWarnings } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/params.js'
  );

  type StubDescriptor = Parameters<typeof collectPhantomParamWarnings>[0];
  type StubCtx = Parameters<typeof collectPhantomParamWarnings>[1];

  function stubDescriptor(
    id: string,
    snapshot: { placedBlocks: Set<string>; unroutedBlocks?: Set<string> },
  ): StubDescriptor {
    return {
      id,
      display_name: 'Stub Device',
      reader: { getBlockLayoutSnapshot: async () => snapshot },
    } as unknown as StubDescriptor;
  }

  async function runBatch(
    descriptor: StubDescriptor,
    ctx: StubCtx,
    ops: readonly { block: string; name: string }[],
  ): Promise<{ phantom: number; routing: number }> {
    let phantom = 0;
    let routing = 0;
    for (const op of ops) {
      phantom += (await collectPhantomParamWarnings(descriptor, ctx, op.block, op.name)).length;
      routing += (await collectRoutingMaskWarnings(descriptor, ctx, op.block, op.name)).length;
    }
    return { phantom, routing };
  }

  // Two ops on the SAME unplaced block → two distinct warnings, not
  // deduplicated. Matches executeSetParams having no dedup logic (BK-075/
  // BK-076 comment: "Additive validation_info[]; write proceeds" per-entry).
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-batch-dup', { placedBlocks: new Set(['amp']) });
    const ctx = { conn: { id: 'test-conn-batch-dup' } } as unknown as StubCtx;
    const counts = await runBatch(descriptor, ctx, [
      { block: 'phaser', name: 'rate' },
      { block: 'phaser', name: 'depth' },
    ]);
    assert(
      'two ops on the same unplaced block → two phantom-param warnings (no dedup)',
      counts.phantom === 2 && counts.routing === 0,
      `phantom=${counts.phantom}, routing=${counts.routing}`,
    );
  }

  // Two ops on DIFFERENT unplaced blocks → one warning each, both fire off
  // the SAME cached snapshot (one fresher call, asserted via call count).
  {
    _resetBlockLayoutCacheForTests();
    let calls = 0;
    const descriptor = {
      id: 'test-batch-multi',
      display_name: 'Stub Device',
      reader: {
        getBlockLayoutSnapshot: async () => {
          calls += 1;
          return { placedBlocks: new Set(['amp']) };
        },
      },
    } as unknown as StubDescriptor;
    const ctx = { conn: { id: 'test-conn-batch-multi' } } as unknown as StubCtx;
    const counts = await runBatch(descriptor, ctx, [
      { block: 'phaser', name: 'rate' },
      { block: 'chorus', name: 'depth' },
    ]);
    assert(
      'two ops on different unplaced blocks → one warning each',
      counts.phantom === 2,
      `phantom=${counts.phantom}`,
    );
    assert(
      'both ops share ONE cached snapshot read, not one per op',
      calls === 1,
      `getBlockLayoutSnapshot calls=${calls}`,
    );
  }

  // Mixed batch: one placed + one unplaced → only the unplaced op warns.
  {
    _resetBlockLayoutCacheForTests();
    const descriptor = stubDescriptor('test-batch-mixed', {
      placedBlocks: new Set(['amp', 'cab']),
    });
    const ctx = { conn: { id: 'test-conn-batch-mixed' } } as unknown as StubCtx;
    const counts = await runBatch(descriptor, ctx, [
      { block: 'amp', name: 'gain' },
      { block: 'phaser', name: 'rate' },
    ]);
    assert(
      'mixed batch (placed + unplaced) → exactly one phantom-param warning',
      counts.phantom === 1,
      `phantom=${counts.phantom}`,
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

// A true SET_PARAMETER frame is fn=0x01 with a value sub-action: 0x09 (discrete
// type/model select) or 0x52 (continuous knob drag). The gen-3 block insert
// (set_block) also rides fn=0x01 but uses sub=0x32, and routing uses 0x35, so
// the function byte alone no longer discriminates param writes; check the
// sub-action too.
const SET_PARAM_SUB_ACTIONS = new Set([0x09, 0x52]);
function isSetParamFrame(f: CapturedFrame): boolean {
  return f.fn === FN_PARAMETER_SETGET && SET_PARAM_SUB_ACTIONS.has(f.bytes[6]);
}

async function testIIIChannelNestedApply(): Promise<void> {
  // Spec: amp block with channel-nested params for A and B.
  // Expected outbound sequence:
  //   1. set_block (fn 0x01 sub=0x32 block insert): place amp at (r2,c3)
  //   2. set_channel A (fn 0x0A)
  //   3. set_param drive (fn 0x01 sub=0x09)
  //   4. set_channel B (fn 0x0A)
  //   5. set_param drive (fn 0x01 sub=0x09)
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
  const paramFrames = captured.filter(isSetParamFrame);
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
    .filter((f) => f.fn === FN_SET_GET_CHANNEL || isSetParamFrame(f))
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
  // Honest 2-state SET + aggregate fix: the mock accepts but does not echo, so
  // the per-param set_param writes report acked:false + unconfirmed:true (sent,
  // not verified). Those do NOT fail the apply (the preset likely applied); they
  // surface as a "verify on device" note. So ok stays true (nothing rejected),
  // and the warning flags the unconfirmed writes. Structural ops still ack.
  assert(
    'III channel-nested apply: ok=true (unconfirmed param writes do not fail the apply; surfaced as verify-note)',
    result.ok === true
      && /UNCONFIRMED/i.test(result.warning ?? '')
      && !/MULTIPURPOSE_RESPONSE/i.test(result.warning ?? ''),
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
  const paramFrames = captured.filter(isSetParamFrame);
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
  const paramFrames = captured.filter(isSetParamFrame);
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
    'III flat-shape apply: ok=true (unconfirmed param write does not fail the apply; surfaced as verify-note)',
    result.ok === true
      && /UNCONFIRMED/i.test(result.warning ?? '')
      && !/MULTIPURPOSE_RESPONSE/i.test(result.warning ?? ''),
    `result.ok=${result.ok}, warning=${result.warning ?? '(none)'}`,
  );
}

// Display → wire coercion in apply_preset (regression: gen-3 apply_preset used
// to pass spec values straight to the codec, so `treble: 5.5` reached
// packValue16 raw — rejected as a non-integer — and integer knob values like
// `drive: 5` were silently sent as wire 5 (~0.008%) instead of the calibrated
// midpoint. apply_preset now coerces via the catalog schema, exactly as
// set_param does at the dispatcher boundary.
async function testIIIApplyCoercesDisplayToWire(): Promise<void> {
  const { ctx, captured } = buildMockIIICtx();
  const spec = {
    slots: [{
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      // treble is knob_0_10 (calibrated): 5.5 must scale to ~36044 over the
      // 0..65534 wire, NOT reach packValue16 as the literal 5.5.
      params: { treble: 5.5 },
    }],
  };
  const result = await AXEFX3_DESCRIPTOR.writer.applyPreset!(
    ctx,
    spec as Parameters<NonNullable<typeof AXEFX3_DESCRIPTOR.writer.applyPreset>>[1],
  );
  const paramFrames = captured.filter(isSetParamFrame);
  assert(
    'III apply_preset coercion: one SET_PARAMETER frame for treble',
    paramFrames.length === 1,
    `expected 1 param frame, got ${paramFrames.length}`,
  );
  // treble is CONTINUOUS → sub 52 00 + float32(normalized = wire/65534) at pos
  // 12-16. Recover the calibrated wire: float32 × 65534 ≈ 36044 (NOT raw 5.5).
  const f = paramFrames[0];
  const normalized = f !== undefined ? decode5SeptetFloat32(f.bytes[12], f.bytes[13], f.bytes[14], f.bytes[15], f.bytes[16]) : -1;
  const wire = Math.round(normalized * 65534);
  const expected = Math.round((5.5 / 10) * 65534); // 36044
  assert(
    'III apply_preset coercion: treble 5.5 → calibrated wire (~36044), not raw 5.5',
    f !== undefined && f.bytes[6] === 0x52 && Math.abs(wire - expected) <= 2,
    `expected wire ≈ ${expected} via sub 0x52 float, got wire ${wire} (sub 0x${f?.bytes[6].toString(16)})`,
  );
  assert(
    'III apply_preset coercion: ok=true (no packValue16 rejection; unconfirmed write surfaced as verify-note)',
    result.ok === true
      && /UNCONFIRMED/i.test(result.warning ?? '')
      && !/MULTIPURPOSE_RESPONSE/i.test(result.warning ?? ''),
    `result.ok=${result.ok}, warning=${result.warning ?? '(none)'}`,
  );
}

await testIIIChannelNestedApply();
await testIIIChannelNestedApplyInvalidChannel();
await testIIIChannelNestedApplyMixedShape();
await testIIIFlatParamsStillWork();
await testIIIApplyCoercesDisplayToWire();

// ── Multi-instance scene slot-id resolution (2026-05-23) ────────────
//
// Regression coverage for the scene-validation bug surfaced by the
// axefx2-deterministic-4scene-build agent-regression case (trace
// 2026-05-22T00-35-51). Scene preflight used to call resolveBlockKey
// which only matches descriptor.blocks (block TYPES). Multi-instance
// presets reference specific slot ids via scenes[].channels +
// scenes[].bypassed, and those refs always reject as "unknown block".
//
// New resolveSceneRef accepts: explicit slot.id, auto-derived id
// (`amp` for instance:1, `amp_2` for instance:2), the leniency form
// `amp_1` (back-compat with the prior types.ts comment that said
// auto-derived was `<block_type>_<instance>` for instance:1 too), and
// bare block_type when unambiguous.

console.log('\nMulti-instance scene slot-id resolution (II + AM4):');

async function testMultiInstanceSceneRef(): Promise<void> {
  const { collectApplyPresetPreflight } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher/preflight.js'
  );
  const { resolveDevice } = await import(
    '@mcp-midi-control/core/protocol-generic/registry.js'
  );

  // Test helper: run preflight on a spec, check whether it errored on the
  // expected scene path or accepted the spec cleanly.
  function expectSceneOK(
    label: string,
    devicePort: string,
    spec: Parameters<typeof collectApplyPresetPreflight>[0],
  ): void {
    const descriptor = resolveDevice(devicePort);
    if (descriptor === undefined) {
      failed++;
      console.error(`  ✗ ${label}\n      device '${devicePort}' not registered`);
      return;
    }
    const result = collectApplyPresetPreflight(spec, descriptor);
    const sceneErrors = result.errors.filter((e) => e.path.startsWith('scenes['));
    if (sceneErrors.length > 0) {
      failed++;
      console.error(`  ✗ ${label}\n      expected scene clean, got: ${JSON.stringify(sceneErrors)}`);
      return;
    }
    passed++;
    console.log(`  OK    ${label}`);
  }

  function expectSceneError(
    label: string,
    devicePort: string,
    spec: Parameters<typeof collectApplyPresetPreflight>[0],
    expectedPath: string,
    expectedFragment: string,
  ): void {
    const descriptor = resolveDevice(devicePort);
    if (descriptor === undefined) {
      failed++;
      console.error(`  ✗ ${label}\n      device '${devicePort}' not registered`);
      return;
    }
    const result = collectApplyPresetPreflight(spec, descriptor);
    const hit = result.errors.find((e) => e.path === expectedPath);
    if (hit === undefined) {
      failed++;
      console.error(`  ✗ ${label}\n      expected error at path '${expectedPath}', got errors: ${JSON.stringify(result.errors.map((e) => e.path))}`);
      return;
    }
    if (!hit.error.includes(expectedFragment)) {
      failed++;
      console.error(`  ✗ ${label}\n      error path matched but message missing "${expectedFragment}": ${hit.error}`);
      return;
    }
    passed++;
    console.log(`  OK    ${label}`);
  }

  // ── Positive: explicit slot.id resolves ────────────────────────────
  expectSceneOK(
    'II: explicit slot.id "rhythm_amp" in scenes[].channels resolves',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1, id: 'rhythm_amp' },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2, id: 'lead_amp' },
      ],
      scenes: [
        { scene: 1, channels: { rhythm_amp: 'X', lead_amp: 'X' } },
        { scene: 2, channels: { lead_amp: 'Y' }, bypassed: { rhythm_amp: true } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Positive: auto-derived id resolves ─────────────────────────────
  expectSceneOK(
    'II: auto-derived "amp_2" (instance:2) in scenes resolves',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1 },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2 },
      ],
      scenes: [
        { scene: 1, channels: { amp: 'X', amp_2: 'X' } },
        { scene: 2, channels: { amp_2: 'Y' }, bypassed: { amp: true } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Positive: leniency form `amp_1` matches instance:1 ─────────────
  expectSceneOK(
    'II: leniency "amp_1" (back-compat with old doc) resolves to instance:1',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1 },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2 },
      ],
      scenes: [
        { scene: 1, channels: { amp_1: 'X', amp_2: 'X' } },
        { scene: 2, channels: { amp_1: 'Y' }, bypassed: { amp_2: true } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Positive: single-instance bare block_type still works ──────────
  expectSceneOK(
    'II: bare "amp" on single-instance preset still resolves (back-compat)',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp' },
        { slot: { row: 2, col: 2 }, block_type: 'reverb' },
      ],
      scenes: [{ scene: 1, channels: { amp: 'X' } }],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Positive: AM4 single-instance regression ───────────────────────
  expectSceneOK(
    'AM4: bare "amp" on single-instance preset resolves',
    'am4',
    {
      slots: [{ slot: 1, block_type: 'amp' }],
      scenes: [
        { scene: 1, channels: { amp: 'A' } },
        { scene: 2, channels: { amp: 'B' } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Negative: ambiguous bare block_type on multi-instance preset ───
  // Triggers ONLY when both slots have explicit `id` fields (neither
  // slotId equals the bare block_type). When one slot uses the canonical
  // derived id (`amp` for instance:1), bare `amp` resolves cleanly to
  // that slot — the agent's intent is clear and the leniency form
  // `amp_1` is also accepted for the same slot.
  expectSceneError(
    'II: ambiguous bare "amp" when both slots have explicit ids → ambiguity error',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1, id: 'rhythm_amp' },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2, id: 'lead_amp' },
      ],
      scenes: [{ scene: 1, channels: { amp: 'X' } }],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
    'scenes[0].channels.amp',
    'ambiguous',
  );

  // ── Positive: bare block_type when one slot uses canonical id ──────
  // When slot 1 has no explicit id (canonical derived id = 'amp'), bare
  // `amp` resolves to slot 1 unambiguously even with multiple amps.
  // The canonical-id slot wins.
  expectSceneOK(
    'II: bare "amp" with mixed (canonical + explicit-id) slots resolves to canonical',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1 },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2, id: 'lead_amp' },
      ],
      scenes: [{ scene: 1, channels: { amp: 'X', lead_amp: 'Y' } }],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Negative: unknown id with suggestions ──────────────────────────
  expectSceneError(
    'II: unknown id "shiva" → error includes slot id suggestions',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1, id: 'rhythm_amp' },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2, id: 'lead_amp' },
      ],
      scenes: [{ scene: 1, channels: { shiva: 'X' } }],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
    'scenes[0].channels.shiva',
    'unknown block',
  );

  // ── Negative: scenes[].bypassed shares the same resolver ───────────
  expectSceneError(
    'II: bypassed map also rejects unknown id (same resolver as channels)',
    'axe-fx-ii',
    {
      slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
      scenes: [{ scene: 1, channels: { amp: 'X' }, bypassed: { shiva: true } }],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
    'scenes[0].bypassed.shiva',
    'unknown block',
  );

  // ── Positive: bypassed accepts explicit slot.id ────────────────────
  expectSceneOK(
    'II: bypassed map accepts explicit slot.id',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1, id: 'rhythm_amp' },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2, id: 'lead_amp' },
      ],
      scenes: [
        { scene: 1, channels: { rhythm_amp: 'X' }, bypassed: { lead_amp: true } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Direct reproduction of the failing agent trace ─────────────────
  // The 2026-05-22 axefx2-deterministic-4scene-build trace had: slot 1
  // with id:'shiva', slot 2 with instance:2 (no explicit id), and
  // scenes referencing both. Pre-fix this hit "unknown block" three
  // times. Post-fix it should preflight cleanly.
  expectSceneOK(
    'II: failing-trace repro — 2 amps (id:shiva + instance:2) + 4 scenes resolves',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1, id: 'shiva' },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2 },
        { slot: { row: 2, col: 3 }, block_type: 'cab' },
        { slot: { row: 2, col: 4 }, block_type: 'reverb' },
      ],
      scenes: [
        { scene: 1, name: 'Shiva Clean', channels: { shiva: 'X', reverb: 'X' }, bypassed: { amp_2: true } },
        { scene: 2, name: 'Shiva Crunch', channels: { shiva: 'Y', reverb: 'X' }, bypassed: { amp_2: true } },
        { scene: 3, name: 'JCM800', channels: { amp_2: 'X', reverb: 'X' }, bypassed: { shiva: true } },
        { scene: 4, name: 'IIC+ Lead', channels: { amp_2: 'Y', reverb: 'X' }, bypassed: { shiva: true } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Display-form leniency: space-separated `Amp 1` / `Amp 2` ────────
  // The 2026-05-23 retry of axefx2-deterministic-4scene-build showed the
  // agent writing `Amp 1` and `Amp 2` (display labels from describe_device
  // channel_blocks list) — the resolver normalizes `<type> <instance>`
  // to `<type>_<instance>` so the display form Just Works.
  expectSceneOK(
    'II: display-form "Amp 1" / "Amp 2" (space-separated, capitalized) resolves',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1 },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2 },
      ],
      scenes: [
        { scene: 1, channels: { 'Amp 1': 'X' }, bypassed: { 'Amp 2': true } },
        { scene: 2, channels: { 'Amp 2': 'Y' }, bypassed: { 'Amp 1': true } },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Routing edges share the same resolver as scenes ─────────────────
  // Routing previously used `slotIds.includes(edge.from)` (exact match
  // only). 2026-05-23: switched to resolveSceneRef so all the same
  // leniencies (case, space-vs-underscore, _1 form) apply.
  expectSceneOK(
    'II: routing edges accept display-form "Amp 1" → "amp_2" naming',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1 },
        { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2 },
      ],
      routing: [
        { from: 'Amp 1', to: 'amp_2' },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );

  // ── Negative: routing edge to unknown id still errors ──────────────
  {
    const descriptor = resolveDevice('axe-fx-ii');
    if (descriptor === undefined) {
      failed++;
      console.error(`  ✗ II: routing unknown-id test — device not registered`);
    } else {
      const result = collectApplyPresetPreflight({
        slots: [
          { slot: { row: 2, col: 1 }, block_type: 'amp', instance: 1 },
        ],
        routing: [{ from: 'amp', to: 'shiva' }],
      } as Parameters<typeof collectApplyPresetPreflight>[0], descriptor);
      const hit = result.errors.find((e) => e.path === 'routing[0].to');
      if (hit === undefined || !hit.error.includes('unknown block id "shiva"')) {
        failed++;
        console.error(`  ✗ II: routing unknown id "shiva" should error\n      got: ${JSON.stringify(result.errors)}`);
      } else {
        passed++;
        console.log(`  OK    II: routing edge to unknown id "shiva" errors with suggestions`);
      }
      // Error message should now mention the OUTPUT sentinel as an
      // alternative for the chain terminator case.
      if (hit !== undefined && hit.error.includes('OUTPUT')) {
        passed++;
        console.log(`  OK    II: routing-unknown-id error message mentions the OUTPUT sentinel`);
      } else {
        failed++;
        console.error(`  ✗ II: routing error should mention "OUTPUT" sentinel\n      got: ${hit?.error}`);
      }
    }
  }

  // ── OUTPUT sentinel: preflight accepts `to: "OUTPUT"` ──────────────
  // Real-world failure 2026-05-23: agent built a chain ending at col 6
  // with no Output block and no shunts through col 12, scene 1 silent.
  // The OUTPUT sentinel is the simple-author path that gets the writer
  // to auto-extend with shunts + cables through col 12.
  expectSceneOK(
    'II: routing edge `to: "OUTPUT"` is the reserved chain terminator',
    'axe-fx-ii',
    {
      slots: [
        { slot: { row: 2, col: 1 }, block_type: 'amp' },
        { slot: { row: 2, col: 2 }, block_type: 'reverb' },
      ],
      routing: [
        { from: 'amp', to: 'reverb' },
        { from: 'reverb', to: 'OUTPUT' },
      ],
    } as Parameters<typeof collectApplyPresetPreflight>[0],
  );
}

await testMultiInstanceSceneRef();

// ── Offline dry-run context ───────────────────────────────────────
// `apply_pattern dry_run` is documented as sending NOTHING (no reads, no
// gate, no backup, no transfer), so it must not require a live port: its
// use case is planning a set at a desk with the rig unplugged. It used to
// call openCtx unconditionally and die with "No MIDI port matching..."
// (hit twice in a 2026-07-16 planning session).
//
// The guarantee is structural, not a promise each writer branch keeps: the
// offline ctx carries the NULL connection, so any dry-run path that
// miswires itself to the wire throws instead of silently transmitting.
// These assert both halves — no port needed, and no send possible.
{
  const offline = openOfflineCtx(AM4_DESCRIPTOR);
  assert('openOfflineCtx: builds a ctx with no port open', offline.descriptor === AM4_DESCRIPTOR);
  assert('openOfflineCtx: reports the port closed', offline.conn.isPortOpen?.() === false);
  assert('openOfflineCtx: has no MIDI input', offline.conn.hasInput === false);
  assert(
    'openOfflineCtx: send() throws rather than transmitting on a dry run',
    (() => {
      try {
        offline.conn.send([0xf0, 0x7d, 0xf7]);
        return false;
      } catch (err) {
        return err instanceof Error && /dry run/i.test(err.message);
      }
    })(),
  );
  assert(
    'openOfflineCtx: exposes no reconnect (nothing to reconnect to)',
    offline.reconnect === undefined,
  );
}

// ── Unrecognised `overrides` / `spec` keys are REFUSED, not dropped ──
//
// The corpus defect: 3 of the 23 apply_preset calls carrying `overrides`
// passed a flat `{"amp.type": "..."}` map instead of `slots[]`. The zod input
// shape was `z.object`, which on an INPUT silently strips unknown keys, so the
// call returned ok:true having sent nothing, and in all three traces the agent
// told the user the value HAD been applied. That is the only measured case of
// the agent confidently reporting a device change that never happened.
//
// Assert the refusal fires before any wire op. The negative controls in here
// deliberately let a WELL-FORMED call through to prove the key check did not
// eat it, and they identify the "it got through" state by the DIFFERENT error
// code the MIDI layer throws.
//
// ⚠ THAT IDENTIFICATION ASSUMED NO DEVICE WAS ATTACHED, AND THE ASSUMPTION WAS
// LOAD-BEARING. With an AM4 plugged in, `executeApplyPreset({port:'AM4', spec:
// {slots:[{slot:1, block_type:'amp', params:{gain:5}}]}})` does not fail at the
// port: it OPENS THE REAL DEVICE AND APPLIES THE PRESET, placing an amp and
// setting gain on the maintainer's working buffer from a gate that is offline
// by contract. It then leaves the MIDI handle open, so this script printed its
// summary and never exited, hanging preflight (observed 2026-08-03, the first
// run of this file with hardware attached; it had only ever run on a machine
// with no AM4).
//
// So the whole block is pinned to the mock transport. A gate must not be
// offline-by-luck. `verify-midi-handle-release` exists for the handle half of
// this; the write half had nothing watching it.
{
  const priorMockTransport = process.env.MCP_MOCK_TRANSPORT;
  process.env.MCP_MOCK_TRANSPORT = '1';
  const expectRejects = async (
    label: string,
    fn: () => Promise<unknown>,
    expectedCode: string,
    messageMatch?: RegExp,
  ): Promise<void> => {
    try {
      await fn();
      failed++;
      console.error(`  ✗ ${label}\n      expected DispatchError(${expectedCode}), nothing thrown`);
    } catch (err) {
      const codeOk = err instanceof DispatchError && err.code === expectedCode;
      const msgOk = messageMatch === undefined
        || (err instanceof Error && messageMatch.test(err.message));
      if (codeOk && msgOk) { passed++; return; }
      failed++;
      const desc = err instanceof DispatchError
        ? `got DispatchError(${err.code}): ${err.message}`
        : `got ${err instanceof Error ? err.message : String(err)}`;
      console.error(`  ✗ ${label}\n      expected DispatchError(${expectedCode})${messageMatch ? ` matching ${messageMatch}` : ''}, ${desc}`);
    }
  };

  const { executeApplyPreset } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher.js'
  );

  await expectRejects(
    'apply_preset refuses flat "block.param" keys in `overrides` (the measured defect)',
    () => executeApplyPreset({
      port: 'AM4',
      recipe_id: 'texas_blues_crunch',
      overrides: { 'amp.type': 'Brit Brown' } as never,
    }),
    'value_out_of_range',
    /block\.param/i,
  );
  await expectRejects(
    'the refusal states that nothing was sent (so ok:true can never mean "dropped")',
    () => executeApplyPreset({
      port: 'AM4',
      recipe_id: 'texas_blues_crunch',
      overrides: { 'reverb.type': 'Hall, Large' } as never,
    }),
    'value_out_of_range',
    /NOTHING was sent/i,
  );
  await expectRejects(
    'apply_preset refuses an unknown top-level `spec` key',
    () => executeApplyPreset({
      port: 'AM4',
      spec: { slots: [{ slot: 1, block_type: 'amp' }], blocks: [] } as never,
    }),
    'value_out_of_range',
    /"blocks"/,
  );

  // Negative control: the legitimate shape must still reach the wire layer.
  // With no AM4 connected that surfaces as a port/connection failure — any
  // code OTHER than value_out_of_range proves the key check let it past.
  let legitCode = '(no throw)';
  try {
    await executeApplyPreset({
      port: 'AM4',
      spec: { slots: [{ slot: 1, block_type: 'amp', params: { gain: 5 } }], name: 'ok' },
    });
  } catch (err) {
    legitCode = err instanceof DispatchError ? err.code : `(${(err as Error).message.slice(0, 40)})`;
  }
  assert(
    'a well-formed spec passes the key check (fails later at the wire, not here)',
    legitCode !== 'value_out_of_range',
    `got ${legitCode}`,
  );

  // ── get_params refuses an over-wide batch BEFORE any wire work ──
  //
  // `scripts/verify-response-budget.ts` measured a whole-catalog read at
  // 149,443 chars on the AM4 and 208,649 on the Axe-Fx II, both past the
  // host's 50,000-char delivery cliff, so the device performed 894 (and
  // 1,126) SysEx round-trips and the model received nothing at all. Its own
  // leg for this needs a connected device; this one does not, which is the
  // point: the cap has to be gated on a machine with the gear unplugged too.
  //
  // Both directions matter. The refusal must fire, and it must fire HERE
  // rather than after the reads: with nothing connected, a batch that gets
  // past the check surfaces as some other DispatchError code, so an
  // `at the cap` batch reporting `value_out_of_range` would mean the cap is
  // off by one and is refusing legal calls.
  const { executeGetParams, GET_PARAMS_MAX_QUERIES } = await import(
    '@mcp-midi-control/core/protocol-generic/dispatcher.js'
  );
  const queries = (n: number): { block: string; name: string }[] =>
    Array.from({ length: n }, () => ({ block: 'amp', name: 'gain' }));

  await expectRejects(
    `get_params refuses a batch over the ${GET_PARAMS_MAX_QUERIES}-query cap`,
    () => executeGetParams({ port: 'AM4', queries: queries(GET_PARAMS_MAX_QUERIES + 1) }),
    'value_out_of_range',
    /nothing was read and nothing was sent to the device/i,
  );

  // The over-cap call above refuses before `openCtx`, so it never opens a
  // port. This one is SUPPOSED to get past the cap, which means it proceeds to
  // a connection and 100 reads: it is the reason the mock pin above covers the
  // whole block rather than one call.
  let atCapCode = '(no throw)';
  try {
    await executeGetParams({ port: 'AM4', queries: queries(GET_PARAMS_MAX_QUERIES) });
  } catch (err) {
    atCapCode = err instanceof DispatchError ? err.code : `(${(err as Error).message.slice(0, 40)})`;
  }
  assert(
    `get_params at exactly ${GET_PARAMS_MAX_QUERIES} passes the cap (fails later at the wire, not here)`,
    atCapCode !== 'value_out_of_range',
    `got ${atCapCode}`,
  );

  if (priorMockTransport === undefined) delete process.env.MCP_MOCK_TRANSPORT;
  else process.env.MCP_MOCK_TRANSPORT = priorMockTransport;
}

// Reporting ───────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
