/**
 * Verify Axe-Fx III SysEx builders + parsers — byte-exact goldens
 * against the v1.4 PDF spec.
 *
 * No hardware required. The Axe-Fx III project ships without a
 * maintainer who owns the device, so this script is the project's
 * only protection against the builders drifting away from
 * `docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt`.
 *
 * Each expected hex string is computed by hand from the spec
 * envelope `F0 00 01 74 10 [fn] [payload...] [cs] F7` with checksum
 * `(XOR of every byte from F0 through last payload byte) & 0x7F`.
 *
 * Run:  npx tsx scripts/verify-axe-fx-iii-encoding.ts
 */

import {
  buildSetBypass,
  buildGetBypass,
  buildSetChannel,
  buildGetChannel,
  buildSetScene,
  buildGetScene,
  buildQueryPatchName,
  buildQuerySceneName,
  buildSetLooper,
  buildGetLooperState,
  buildTempoTap,
  buildSetTuner,
  buildSetTempo,
  buildGetTempo,
  buildStatusDump,
  buildSetParameter,
  buildGetParameter,
  buildSetParameterBypass,
  packValue16,
  unpackValue16,
  isSetGetBypassResponse,
  isSetGetChannelResponse,
  isSetGetSceneResponse,
  isQueryPatchNameResponse,
  isQuerySceneNameResponse,
  isSetGetLooperResponse,
  isSetGetTempoResponse,
  isStatusDumpResponse,
  isSetGetParameterResponse,
  isMultipurposeResponse,
  parseBypassResponse,
  parseChannelResponse,
  parseSceneResponse,
  parseQueryPatchNameResponse,
  parseQuerySceneNameResponse,
  parseLooperStateResponse,
  parseTempoResponse,
  parseStatusDumpResponse,
  parseMultipurposeResponse,
  parseSetGetParameterResponse,
  describeMultipurposeResultCode,
} from 'fractal-midi/axe-fx-iii';
import { resolveEffectId, AXE_FX_III_BLOCKS } from 'fractal-midi/axe-fx-iii';
import { fractalChecksum } from 'fractal-midi/shared';

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function asBytes(s: string): number[] {
  if (s.length % 2 !== 0) throw new Error(`asBytes: odd length ${s.length}`);
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) {
    out.push(Number.parseInt(s.slice(i, i + 2), 16));
  }
  return out;
}

let failures = 0;
function check(label: string, built: readonly number[], expected: string): void {
  const got = hex(built);
  if (got === expected) {
    console.log(`  ✓ ${label}  (${built.length}B  ${got})`);
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      built:    ${got}`);
    console.log(`      expected: ${expected}`);
    failures += 1;
  }
}

function checkEqual<T>(label: string, got: T, expected: T): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      got:      ${a}`);
    console.log(`      expected: ${b}`);
    failures += 1;
  }
}

console.log('Axe-Fx III byte-exact goldens (v1.4 PDF spec)\n');

// ── 0x0A SET/GET BYPASS ─────────────────────────────────────────────
console.log('set_bypass / get_bypass (function 0x0A):');
// Compressor 1 = effect ID 46 = 0x2E. encode14(46) = [0x2E, 0x00].
check('buildSetBypass(46, false)', buildSetBypass(46, false),
  'f000017410' + '0a' + '2e0000' + '31' + 'f7');
check('buildSetBypass(46, true)', buildSetBypass(46, true),
  'f000017410' + '0a' + '2e0001' + '30' + 'f7');
check('buildGetBypass(46)', buildGetBypass(46),
  'f000017410' + '0a' + '2e007f' + '4e' + 'f7');
// Reverb 1 = effect ID 66 = 0x42.
check('buildSetBypass(66, false)', buildSetBypass(66, false),
  'f000017410' + '0a' + '420000' + '5d' + 'f7');

// ── 0x0B SET/GET CHANNEL ────────────────────────────────────────────
console.log('\nset_channel / get_channel (function 0x0B):');
check('buildSetChannel(46, 0)', buildSetChannel(46, 0),
  'f000017410' + '0b' + '2e0000' + '30' + 'f7');
check('buildSetChannel(46, 1)', buildSetChannel(46, 1),
  'f000017410' + '0b' + '2e0001' + '31' + 'f7');
check('buildSetChannel(46, 3)', buildSetChannel(46, 3),
  'f000017410' + '0b' + '2e0003' + '33' + 'f7');
check('buildGetChannel(46)', buildGetChannel(46),
  'f000017410' + '0b' + '2e007f' + '4f' + 'f7');

// ── 0x0C SET/GET SCENE ──────────────────────────────────────────────
console.log('\nset_scene / get_scene (function 0x0C):');
check('buildSetScene(0)', buildSetScene(0),
  'f000017410' + '0c' + '00' + '19' + 'f7');
check('buildSetScene(7)', buildSetScene(7),
  'f000017410' + '0c' + '07' + '1e' + 'f7');
check('buildGetScene()', buildGetScene(),
  'f000017410' + '0c' + '7f' + '66' + 'f7');

// ── 0x0D QUERY PATCH NAME ───────────────────────────────────────────
console.log('\nquery_patch_name (function 0x0D):');
check('buildQueryPatchName(0)', buildQueryPatchName(0),
  'f000017410' + '0d' + '0000' + '18' + 'f7');
check('buildQueryPatchName(1023)', buildQueryPatchName(1023),
  'f000017410' + '0d' + '7f07' + '60' + 'f7');
// Spec says current = "dd dd = 7F 7F" (TWO sentinel bytes).
check("buildQueryPatchName('current')", buildQueryPatchName('current'),
  'f000017410' + '0d' + '7f7f' + '18' + 'f7');

// ── 0x0E QUERY SCENE NAME ───────────────────────────────────────────
console.log('\nquery_scene_name (function 0x0E):');
check('buildQuerySceneName(0)', buildQuerySceneName(0),
  'f000017410' + '0e' + '00' + '1b' + 'f7');
check('buildQuerySceneName(7)', buildQuerySceneName(7),
  'f000017410' + '0e' + '07' + '1c' + 'f7');
check("buildQuerySceneName('current')", buildQuerySceneName('current'),
  'f000017410' + '0e' + '7f' + '64' + 'f7');

// ── 0x0F SET/GET LOOPER ─────────────────────────────────────────────
console.log('\nlooper (function 0x0F):');
check("buildSetLooper('record')", buildSetLooper('record'),
  'f000017410' + '0f' + '00' + '1a' + 'f7');
check("buildSetLooper('play')", buildSetLooper('play'),
  'f000017410' + '0f' + '01' + '1b' + 'f7');
check("buildSetLooper('half_speed')", buildSetLooper('half_speed'),
  'f000017410' + '0f' + '05' + '1f' + 'f7');
check('buildGetLooperState()', buildGetLooperState(),
  'f000017410' + '0f' + '7f' + '65' + 'f7');

// ── 0x10 TEMPO TAP ──────────────────────────────────────────────────
console.log('\ntempo_tap (function 0x10):');
check('buildTempoTap()', buildTempoTap(),
  'f000017410' + '10' + '05' + 'f7');

// ── 0x11 TUNER ON/OFF ───────────────────────────────────────────────
console.log('\ntuner (function 0x11):');
check('buildSetTuner(true)', buildSetTuner(true),
  'f000017410' + '11' + '01' + '05' + 'f7');
check('buildSetTuner(false)', buildSetTuner(false),
  'f000017410' + '11' + '00' + '04' + 'f7');

// ── 0x13 STATUS DUMP ────────────────────────────────────────────────
console.log('\nstatus_dump (function 0x13):');
check('buildStatusDump()', buildStatusDump(),
  'f000017410' + '13' + '06' + 'f7');

// ── 0x14 SET/GET TEMPO ──────────────────────────────────────────────
console.log('\ntempo (function 0x14):');
// 120 BPM = 0x78. encode14(120) = [0x78, 0x00].
check('buildSetTempo(120)', buildSetTempo(120),
  'f000017410' + '14' + '7800' + '79' + 'f7');
check('buildGetTempo()', buildGetTempo(),
  'f000017410' + '14' + '7f7f' + '01' + 'f7');

// ── 0x01 PARAMETER_SETGET (🟢 SET verified, 🟡 GET hypothesis) ─────
// Wire shape byte-verified against 10 public captures spanning two
// effect blocks and two sub-action codes. See:
//   - `packages/axe-fx-iii/src/setParam.ts` FN_PARAMETER_SETGET doc-
//     comment for the evidence chain.
//   - `docs/devices/axe-fx-iii/set-parameter-captures.md` for the captured frames.
//   - `docs/devices/axe-fx-iii/fn01-decode.md` for the field-layout table.
//
// Session 97 (2026-05-18) pivot: replaced the wrong fn=0x02 II-port
// envelope with the byte-verified fn=0x01 + sub-action 09 00 (typed-
// input SET) shape. All 10 public captures and the encoder goldens
// below use checksums that re-derive against `fractalChecksum`.
console.log('\nset_parameter / get_parameter (function 0x01, 🟢 SET / 🟡 GET):');

// Reverb 1 = effect ID 66 = 0x42. paramId 0 = REVERB_TYPE per Ghidra
// catalog. fn=0x01 envelope is 23 bytes:
//   F0 00 01 74 10 01 [09 00] [eff_lo eff_hi] [pid_lo pid_hi]
//   00 00 00 [v0 v1 v2] 00 00 00 [cs] F7
//
// buildSetParameter(66, 0, 0) — min value:
//   F0 00 01 74 10 01 09 00 42 00 00 00 00 00 00 00 00 00 00 00 00 [cs] F7
//   XOR (non-zero bytes): F0^01^74^10^01^09^42 = 0xDF → cs = 0x5F
check('buildSetParameter(66, 0, 0) — Reverb 1, paramId 0, min',
  buildSetParameter(66, 0, 0),
  'f000017410' + '01' + '0900' + '4200' + '0000' + '000000' + '000000' + '000000' + '5f' + 'f7');

// buildSetParameter(66, 0, 65534) — max value (packValue16 = [7e 7f 03]):
//   XOR adds 7e^7f^03 = 0x02 → 0x5F ^ 0x02 = 0x5D
check('buildSetParameter(66, 0, 65534) — Reverb 1, paramId 0, max',
  buildSetParameter(66, 0, 65534),
  'f000017410' + '01' + '0900' + '4200' + '0000' + '000000' + '7e7f03' + '000000' + '5d' + 'f7');

// buildSetParameter(66, 11, 32767) — packValue16 = [7f 7f 01]
// XOR (non-zero): F0^01^74^10^01^09^42^0b^7f^7f^01 = 0x55
check('buildSetParameter(66, 11, 32767) — Reverb 1, paramId 11, mid',
  buildSetParameter(66, 11, 32767),
  'f000017410' + '01' + '0900' + '4200' + '0b00' + '000000' + '7f7f01' + '000000' + '55' + 'f7');

// buildGetParameter(66, 0) — same shape as SET-min (value field zeroed):
check('buildGetParameter(66, 0) — Reverb 1 query paramId 0',
  buildGetParameter(66, 0),
  'f000017410' + '01' + '0900' + '4200' + '0000' + '000000' + '000000' + '000000' + '5f' + 'f7');

// buildSetParameterBypass(66, true) = buildSetParameter(66, 255, 1)
// paramId 255 → encode14 [0x7F, 0x01]. value 1 → packValue16 [0x01, 0x00, 0x00].
// XOR (non-zero): F0^01^74^10^01^09^42^7f^01^01 = 0x20
check('buildSetParameterBypass(66, true) — Reverb 1 bypass via fn=0x01 path',
  buildSetParameterBypass(66, true),
  'f000017410' + '01' + '0900' + '4200' + '7f01' + '000000' + '010000' + '000000' + '20' + 'f7');

// ── Public-capture goldens (byte-exact, from docs/devices/axe-fx-iii/set-parameter-captures.md) ─────
// These lock isSetGetParameterResponse + parseSetGetParameterResponse
// against the real wire frames AxeEdit III emits to a real Axe-Fx III.

// FC-12 footswitch: Drive 1 boost ON (effectId=58, paramId=40, value=508)
const fc12_d1on = [
  0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x52, 0x00, 0x3a, 0x00, 0x28, 0x00,
  0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x2b, 0xf7,
];
checkEqual('isSetGetParameterResponse(FC-12 Drive 1 boost ON)',
  isSetGetParameterResponse(fc12_d1on), true);
const parsed_d1on = parseSetGetParameterResponse(fc12_d1on);
checkEqual('parse FC-12 D1on effectId', parsed_d1on.effectId, 58);
checkEqual('parse FC-12 D1on paramId',  parsed_d1on.paramId, 40);
checkEqual('parse FC-12 D1on value',    parsed_d1on.value, 508);

// gabbernutter typed-input: Delay 1 TIME = 520
const gab_typed_520 = [
  0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x09, 0x00, 0x46, 0x00, 0x02, 0x00,
  0x00, 0x00, 0x00, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x55, 0xf7,
];
checkEqual('isSetGetParameterResponse(gabbernutter Delay TIME=520)',
  isSetGetParameterResponse(gab_typed_520), true);
const parsed_gab520 = parseSetGetParameterResponse(gab_typed_520);
checkEqual('parse gabbernutter typed effectId', parsed_gab520.effectId, 70);
checkEqual('parse gabbernutter typed paramId',  parsed_gab520.paramId, 2);
checkEqual('parse gabbernutter typed value',    parsed_gab520.value, 520);

// gabbernutter mouse-drag: Delay 1 TIME = 503 (drag context at pos 12-14)
const gab_drag_503 = [
  0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x52, 0x00, 0x46, 0x00, 0x02, 0x00,
  0x49, 0x27, 0x23, 0x77, 0x03, 0x00, 0x00, 0x00, 0x00, 0x3b, 0xf7,
];
checkEqual('isSetGetParameterResponse(gabbernutter drag TIME=503)',
  isSetGetParameterResponse(gab_drag_503), true);
const parsed_drag503 = parseSetGetParameterResponse(gab_drag_503);
checkEqual('parse gabbernutter drag effectId', parsed_drag503.effectId, 70);
checkEqual('parse gabbernutter drag paramId',  parsed_drag503.paramId, 2);
checkEqual('parse gabbernutter drag value',    parsed_drag503.value, 503);

// STATE_BROADCAST (04 01) frame from passive sniff — paramId field is
// zero by convention (the broadcast doesn't carry paramId; caller
// tracks last-SET param).
const state_broadcast = [
  0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x04, 0x01, 0x3a, 0x00, 0x00, 0x00,
  0x46, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6c, 0xf7,
];
checkEqual('isSetGetParameterResponse(STATE_BROADCAST 04 01)',
  isSetGetParameterResponse(state_broadcast), true);
const parsed_bc = parseSetGetParameterResponse(state_broadcast);
checkEqual('parse STATE_BROADCAST effectId',  parsed_bc.effectId, 58);
checkEqual('parse STATE_BROADCAST paramId=0', parsed_bc.paramId, 0);
checkEqual('parse STATE_BROADCAST value',     parsed_bc.value, 198); // 0x46 + (0x01<<7) = 198

// packValue16 round-trips
checkEqual('packValue16(0)',     packValue16(0),     [0x00, 0x00, 0x00] as [number, number, number]);
checkEqual('packValue16(65534)', packValue16(65534), [0x7e, 0x7f, 0x03] as [number, number, number]);
checkEqual('packValue16(32767)', packValue16(32767), [0x7f, 0x7f, 0x01] as [number, number, number]);
checkEqual('unpackValue16(0,0,0)',     unpackValue16(0, 0, 0),       0);
checkEqual('unpackValue16(0x7e,0x7f,0x03)', unpackValue16(0x7e, 0x7f, 0x03), 65534);
checkEqual('unpackValue16(0x7f,0x7f,0x01)', unpackValue16(0x7f, 0x7f, 0x01), 32767);

// Negative case — a fn=0x0A SET_BYPASS frame is NOT a fn=0x01 frame
checkEqual('isSetGetParameterResponse(SET_BYPASS frame)',
  isSetGetParameterResponse([0xf0, 0x00, 0x01, 0x74, 0x10, 0x0a, 0x42, 0x00, 0x00, 0x5d, 0xf7]),
  false);

// ── Range-check refusals ────────────────────────────────────────────
console.log('\nrange-check refusals:');
function checkThrows(label: string, fn: () => unknown, matcher: RegExp): void {
  let threw: string | undefined;
  try { fn(); threw = '(no throw)'; } catch (err) { threw = (err as Error).message; }
  if (matcher.test(threw)) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}: ${threw}`);
    failures += 1;
  }
}
checkThrows('buildSetScene(-1) throws', () => buildSetScene(-1), /out of range/);
checkThrows('buildSetScene(8) throws',  () => buildSetScene(8),  /out of range/);
checkThrows('buildSetChannel(46, 4) throws', () => buildSetChannel(46, 4 as 0), /out of range/);
checkThrows('buildQueryPatchName(1024) throws', () => buildQueryPatchName(1024), /out of range/);

// ── resolveEffectId from blockTypes ─────────────────────────────────
console.log('\nresolveEffectId (block name → effect ID):');
checkEqual('resolveEffectId("Compressor 1")', resolveEffectId('Compressor 1'), 46);
checkEqual('resolveEffectId("CMP")',          resolveEffectId('CMP'),          46);
checkEqual('resolveEffectId("Reverb 1")',     resolveEffectId('Reverb 1'),     66);
checkEqual('resolveEffectId("Reverb 2")',     resolveEffectId('Reverb 2'),     67);
checkEqual('resolveEffectId("Drive 1")',      resolveEffectId('Drive 1'),      58);
checkEqual('resolveEffectId("Drive 4")',      resolveEffectId('Drive 4'),      61);
checkEqual('resolveEffectId("DRV", 3)',       resolveEffectId('DRV', 3),       60);
checkThrows('resolveEffectId("Amp") throws (not in v1.4)', () => resolveEffectId('Amp'), /no effect ID in the v1.4 spec/);
checkThrows('resolveEffectId("NAM") throws (post-1.13)', () => resolveEffectId('NAM'), /no effect ID in the v1.4 spec/);
checkThrows('resolveEffectId("Bogus")', () => resolveEffectId('Bogus'), /Unknown Axe-Fx III block/);

// Non-addressable v1.4 entries refuse cleanly — confirmed by community
// RE (forum thread #140602): IDs 2, 190, 199, 200 are listed in v1.4
// but not controllable via the 3rd-party MIDI surface.
checkThrows('resolveEffectId("Controllers") refuses (ID 2, non-addressable)',
  () => resolveEffectId('Controllers'), /NOT controllable via the 3rd-party MIDI/);
checkThrows('resolveEffectId("Scene MIDI") refuses (ID 190, non-addressable)',
  () => resolveEffectId('Scene MIDI'), /NOT controllable via the 3rd-party MIDI/);
checkThrows('resolveEffectId("Foot Controller") refuses (ID 199, non-addressable)',
  () => resolveEffectId('Foot Controller'), /NOT controllable via the 3rd-party MIDI/);
checkThrows('resolveEffectId("Preset FC") refuses (ID 200, non-addressable)',
  () => resolveEffectId('Preset FC'), /NOT controllable via the 3rd-party MIDI/);

// Verify the catalog is internally consistent — every 'spec-v1.4'
// entry has a firstId; nothing else does.
console.log('\nblockTypes.ts catalog consistency:');
let mismatches = 0;
for (const b of AXE_FX_III_BLOCKS) {
  const hasId = b.firstId !== null;
  const claimsSpec = b.confidence === 'spec-v1.4';
  if (hasId !== claimsSpec) {
    console.log(`  ✗ ${b.name}: firstId=${b.firstId} confidence=${b.confidence}`);
    mismatches += 1;
  }
}
if (mismatches === 0) {
  console.log(`  ✓ all ${AXE_FX_III_BLOCKS.length} entries consistent (spec-v1.4 ⇔ firstId set)`);
} else {
  failures += mismatches;
}

// ── Response predicates + parsers (round-trip on synthetic input) ───
console.log('\nresponse predicates + parsers:');

// 0x0A bypass response: effect ID 66 (Reverb 1), bypassed.
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0a, 0x42, 0x00, 0x01];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('isSetGetBypassResponse(synth)', isSetGetBypassResponse(synth), true);
  checkEqual('parseBypassResponse(synth)', parseBypassResponse(synth),
    { effectId: 66, bypassed: true });
}

// 0x0B channel response: effect ID 46 (Compressor 1), channel C (2).
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0b, 0x2e, 0x00, 0x02];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('parseChannelResponse(synth)', parseChannelResponse(synth),
    { effectId: 46, channel: 2 });
}

// 0x0C scene response: scene 3.
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0c, 0x03];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('parseSceneResponse(synth)', parseSceneResponse(synth), { scene: 3 });
}

// 0x0D QUERY PATCH NAME response: preset 257, name "Crunch Lead"
{
  const name = 'Crunch Lead';
  const padded = name + ' '.repeat(32 - name.length);
  const ascii = Array.from(padded).map((c) => c.charCodeAt(0));
  // preset 257 = 0x101 -> encode14 = [0x01, 0x02]
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0d, 0x01, 0x02, ...ascii];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('isQueryPatchNameResponse(synth)', isQueryPatchNameResponse(synth), true);
  checkEqual('parseQueryPatchNameResponse(synth)', parseQueryPatchNameResponse(synth),
    { presetNumber: 257, name: 'Crunch Lead' });
}

// 0x0E QUERY SCENE NAME response: scene 3, name "Verse"
{
  const name = 'Verse';
  const padded = name + ' '.repeat(32 - name.length);
  const ascii = Array.from(padded).map((c) => c.charCodeAt(0));
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0e, 0x03, ...ascii];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('parseQuerySceneNameResponse(synth)', parseQuerySceneNameResponse(synth),
    { scene: 3, name: 'Verse' });
}

// 0x0F LOOPER state response: recording + overdubbing -> 0b00000101 = 0x05.
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0f, 0x05];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('parseLooperStateResponse(synth)', parseLooperStateResponse(synth), {
    recording: true,
    playing: false,
    overdubbing: true,
    once: false,
    reverse: false,
    halfSpeed: false,
    raw: 0x05,
  });
}

// 0x14 tempo response: 120 BPM.
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x14, 0x78, 0x00];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('parseTempoResponse(synth)', parseTempoResponse(synth), { bpm: 120 });
}

// 0x13 STATUS_DUMP with 3 entries:
//   (effectId=66, bypass=0, channel=0, channel_count=4) → dd = 0b01000000 = 0x40
//   (effectId=46, bypass=1, channel=2, channel_count=2) → dd = 0b00100101 = 0x25
//   (effectId=70, bypass=0, channel=1, channel_count=4) → dd = 0b01000010 = 0x42
{
  const enc = (n: number): [number, number] => [n & 0x7f, (n >> 7) & 0x7f];
  const triples = [
    ...enc(66), 0x40,
    ...enc(46), 0x25,
    ...enc(70), 0x42,
  ];
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x13, ...triples];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('isStatusDumpResponse(synth)', isStatusDumpResponse(synth), true);
  const entries = parseStatusDumpResponse(synth);
  checkEqual('parseStatusDumpResponse(synth)', entries, [
    { effectId: 66, bypassed: false, channel: 0, channelCount: 4 },
    { effectId: 46, bypassed: true,  channel: 2, channelCount: 2 },
    { effectId: 70, bypassed: false, channel: 1, channelCount: 4 },
  ]);
}

// Non-responses must be rejected.
{
  checkEqual('isStatusDumpResponse(wrong fn)',
    isStatusDumpResponse(asBytes('f000017410' + '0d' + '0000' + '18' + 'f7')), false);
  checkEqual('isStatusDumpResponse(wrong model)',
    isStatusDumpResponse(asBytes('f000017415' + '13' + '06' + 'f7')), false);
  checkEqual('isStatusDumpResponse(short frame)',
    isStatusDumpResponse([0xf0, 0xf7]), false);
}

// Parser refuses malformed STATUS_DUMP payload.
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x13, 0x01, 0x02];
  const bad = [...head, fractalChecksum(head), 0xf7];
  let caught: string | undefined;
  try { parseStatusDumpResponse(bad); } catch (err) { caught = (err as Error).message; }
  checkEqual('parseStatusDumpResponse rejects non-triple payload',
    typeof caught === 'string' && /multiple of 3/.test(caught), true);
}

// 0x64 MULTIPURPOSE_RESPONSE: community-captured wire shape
//   F0 00 01 74 10 64 0E 00 7F F7
// echoed_fn=0x0E (QUERY_SCENE_NAME), result_code=0x00 (general / checksum).
// This is the exact byte sequence in docs/devices/axe-fx-iii/fn01-decode.md §0x64.
console.log('\nmultipurpose_response (function 0x64):');
{
  const captured = asBytes('f000017410' + '64' + '0e00' + '7f' + 'f7');
  // Sanity-check the published checksum matches our fractalChecksum().
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x64, 0x0e, 0x00];
  const recomputed = [...head, fractalChecksum(head), 0xf7];
  checkEqual('captured 0x64 frame matches fractalChecksum recomputation',
    hex(captured), hex(recomputed));
  checkEqual('isMultipurposeResponse(captured)',
    isMultipurposeResponse(captured), true);
  checkEqual('parseMultipurposeResponse(captured)',
    parseMultipurposeResponse(captured),
    { echoedFn: 0x0e, resultCode: 0x00 });
  checkEqual('describeMultipurposeResultCode(0x00)',
    describeMultipurposeResultCode(0x00), 'bad checksum (MIDI_ERROR_BAD_CHKSUM)');
  // 0x05 was previously labeled "NACK" from a loose community report.
  // The AxeEdit III 1.14.31 binary's MIDI_ERROR_* string table
  // (indexed by result_code) reveals it as MIDI_ERROR_INVALID_FXID.
  checkEqual('describeMultipurposeResultCode(0x05)',
    describeMultipurposeResultCode(0x05), 'invalid effect ID (MIDI_ERROR_INVALID_FXID)');
  // Spot-check entries at table boundaries + middle of the table.
  checkEqual('describeMultipurposeResultCode(0x06)',
    describeMultipurposeResultCode(0x06), 'invalid parameter ID (MIDI_ERROR_INVALID_PARAMID)');
  checkEqual('describeMultipurposeResultCode(0x0c)',
    describeMultipurposeResultCode(0x0c), 'DSP overload (MIDI_ERROR_DSP_OVERLOAD)');
  checkEqual('describeMultipurposeResultCode(0x1b)',
    describeMultipurposeResultCode(0x1b), 'flash write failed (MIDI_ERROR_FLASH_WRITE_FAILED)');
  // 0x1C is the first code past the documented table.
  checkEqual('describeMultipurposeResultCode(0x1c) — unknown',
    describeMultipurposeResultCode(0x1c), undefined);
  checkEqual('describeMultipurposeResultCode(0x42) — unknown',
    describeMultipurposeResultCode(0x42), undefined);
}

// Round-trip a synthesized 0x64 frame with a non-zero result code.
{
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x64, 0x02, 0x05];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('parseMultipurposeResponse(synth INVALID_FXID)',
    parseMultipurposeResponse(synth),
    { echoedFn: 0x02, resultCode: 0x05 });
}

// Non-0x64 frames must NOT match the 0x64 predicate.
{
  // A real 0x0D (QUERY PATCH NAME) frame must not be recognised as 0x64.
  const head = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x0d, 0x00, 0x00];
  const synth = [...head, fractalChecksum(head), 0xf7];
  checkEqual('isMultipurposeResponse(0x0D frame)',
    isMultipurposeResponse(synth), false);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
