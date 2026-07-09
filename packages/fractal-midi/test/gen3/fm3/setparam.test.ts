/**
 * FM3 setParam frame goldens (model byte 0x11) on device-true paramIds.
 *
 * Owns: byte-exact `buildSetParameter` / `buildSetParameterContinuous` frames
 * addressed with the FM3's OWN reverb paramIds (type=0, time=1), one per wire
 * kind (discrete sub 09 00 / continuous sub 52 00). Discrete-by-name is NOT
 * refused for the FM3 in this codec: it is FM3-hardware-confirmed (2026-06-10
 * BoodieTraps session, frames byte-identical to this builder), so we golden
 * the frames rather than a refusal.
 *
 * Why: the 2026-06-18 FM9 kind-classification fix (and the III's 2026-06-20
 * follow-up) changed ONLY catalog classification, never the wire builders —
 * the gen-3 byte-identity anchor. The FM3 is the family member with no
 * roundtrip oracle, so its wire must stay byte-identical to the III-anchored
 * codec; these snapshots freeze the 0x11-model-byte wire so builder drift
 * fails here. The REAL captured FM3 oracle frames (amp ordinal 31, reverb
 * ordinal 38, gain drags) are pinned in test/gen3/axe-fx-iii/setparam.test.ts
 * — deliberately not duplicated; these cases pin different values so both
 * suites fail independently.
 */
import {
  buildSetParameter,
  buildSetParameterContinuous,
  parseSetGetParameterResponse,
} from '../../../src/gen3/axe-fx-iii/index.js';

const FM3_MODEL_ID = 0x11;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cases: Array<() => void> = [];

// Discrete: Reverb 1 (effectId 66) TYPE, FM3 device-true paramId 0, ordinal 16
// (float32(16) → septets 00 00 00 0c 04 at pos 12 — the same value-encoding the
// captured FM9 typed-SET golden proves, here under the FM3 model byte).
const DISCRETE = buildSetParameter(66, 0, 16, FM3_MODEL_ID);
const DISCRETE_WANT = 'f000017411010900420000000000000c040000000056f7';
// Continuous: Reverb 1 TIME, FM3 device-true paramId 1, normalized 0.5
// (float32(0.5) = 0x3F000000 → septets 00 00 00 78 03 at pos 12).
const CONTINUOUS = buildSetParameterContinuous(66, 1, 0.5, FM3_MODEL_ID);
const CONTINUOUS_WANT = 'f000017411015200420001000000007803000000007ff7';

cases.push(() => assert(hex(DISCRETE) === DISCRETE_WANT, `FM3 discrete frame drift\n  got:  ${hex(DISCRETE)}\n  want: ${DISCRETE_WANT}`));
cases.push(() => assert(hex(CONTINUOUS) === CONTINUOUS_WANT, `FM3 continuous frame drift\n  got:  ${hex(CONTINUOUS)}\n  want: ${CONTINUOUS_WANT}`));

// Structural: model byte, fn, sub-action per wire kind.
cases.push(() => {
  assert(DISCRETE[4] === FM3_MODEL_ID, `discrete model byte 0x${DISCRETE[4].toString(16)} (want 0x11)`);
  assert(DISCRETE[5] === 0x01 && DISCRETE[6] === 0x09 && DISCRETE[7] === 0x00, 'discrete fn=0x01 sub=09 00');
});
cases.push(() => {
  assert(CONTINUOUS[4] === FM3_MODEL_ID, `continuous model byte 0x${CONTINUOUS[4].toString(16)} (want 0x11)`);
  assert(CONTINUOUS[5] === 0x01 && CONTINUOUS[6] === 0x52 && CONTINUOUS[7] === 0x00, 'continuous fn=0x01 sub=52 00');
});

// Build → parse round-trip on the FM3-addressed frames.
cases.push(() => {
  const p = parseSetGetParameterResponse(DISCRETE, FM3_MODEL_ID);
  assert(p.effectId === 66 && p.paramId === 0 && p.value === 16, `discrete parse drift: ${JSON.stringify(p)}`);
});
cases.push(() => {
  const p = parseSetGetParameterResponse(CONTINUOUS, FM3_MODEL_ID);
  assert(p.effectId === 66 && p.paramId === 1 && p.value === 0.5, `continuous parse drift: ${JSON.stringify(p)}`);
});

export function runFm3SetParamTests(): void {
  for (const c of cases) c();
}
export const FM3_SETPARAM_CASE_COUNT = cases.length;
