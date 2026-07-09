/**
 * FM9 setParam frame goldens (model byte 0x12) on device-true paramIds.
 *
 * Owns: byte-exact `buildSetParameter` / `buildSetParameterContinuous` frames
 * addressed with the FM9's OWN reverb paramIds (type=10, time=11 — NOT the
 * III's 0/1), one per wire kind:
 *   - discrete TYPE select: sub 09 00, float32(ordinal) at pos 12
 *   - continuous knob drag: sub 52 00, float32(normalized) at pos 12
 *
 * Why: the 2026-06-18 incident flipped ~351 FM9 selectors from continuous to
 * discrete at the catalog boundary; the fix explicitly did NOT touch the wire
 * builders (gen-3 byte-identity anchor). These snapshots freeze the FM9-model-
 * byte wire for both sub-actions so builder drift — which that fix and any
 * follow-up must never cause — fails here. The frames are cross-checked
 * against the parser (build → parse → equality), and the discrete layout is
 * capture-anchored elsewhere: test/gen3/axe-fx-iii/setparam.test.ts pins the
 * REAL captured FM9 frame buildSetParameter(66,10,16,0x12) from the FM9-Edit
 * fw 11.00 session (do not duplicate it here).
 */
import {
  buildSetParameter,
  buildSetParameterContinuous,
  parseSetGetParameterResponse,
} from '../../../src/gen3/axe-fx-iii/index.js';

const FM9_MODEL_ID = 0x12;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const cases: Array<() => void> = [];

// Discrete: Reverb 1 (effectId 66) TYPE, FM9 device-true paramId 10, ordinal 78
// (the max REVERB_TYPE ordinal per the FM9 editor cache, enumCount 79).
const DISCRETE = buildSetParameter(66, 10, 78, FM9_MODEL_ID);
const DISCRETE_WANT = 'f00001741201090042000a0000007014040000000037f7';
// Continuous: Reverb 1 TIME, FM9 device-true paramId 11, normalized 0.5
// (float32(0.5) = 0x3F000000 → septets 00 00 00 78 03 at pos 12).
const CONTINUOUS = buildSetParameterContinuous(66, 11, 0.5, FM9_MODEL_ID);
const CONTINUOUS_WANT = 'f00001741201520042000b0000000078030000000076f7';

cases.push(() => assert(hex(DISCRETE) === DISCRETE_WANT, `FM9 discrete frame drift\n  got:  ${hex(DISCRETE)}\n  want: ${DISCRETE_WANT}`));
cases.push(() => assert(hex(CONTINUOUS) === CONTINUOUS_WANT, `FM9 continuous frame drift\n  got:  ${hex(CONTINUOUS)}\n  want: ${CONTINUOUS_WANT}`));

// Structural: model byte, fn, sub-action per wire kind.
cases.push(() => {
  assert(DISCRETE[4] === FM9_MODEL_ID, `discrete model byte 0x${DISCRETE[4].toString(16)} (want 0x12)`);
  assert(DISCRETE[5] === 0x01 && DISCRETE[6] === 0x09 && DISCRETE[7] === 0x00, 'discrete fn=0x01 sub=09 00');
});
cases.push(() => {
  assert(CONTINUOUS[4] === FM9_MODEL_ID, `continuous model byte 0x${CONTINUOUS[4].toString(16)} (want 0x12)`);
  assert(CONTINUOUS[5] === 0x01 && CONTINUOUS[6] === 0x52 && CONTINUOUS[7] === 0x00, 'continuous fn=0x01 sub=52 00');
});

// Build → parse round-trip: the parser must decode the FM9-addressed frames
// back to the exact effectId / device-true paramId / value.
cases.push(() => {
  const p = parseSetGetParameterResponse(DISCRETE, FM9_MODEL_ID);
  assert(p.effectId === 66 && p.paramId === 10 && p.value === 78, `discrete parse drift: ${JSON.stringify(p)}`);
});
cases.push(() => {
  const p = parseSetGetParameterResponse(CONTINUOUS, FM9_MODEL_ID);
  assert(p.effectId === 66 && p.paramId === 11 && p.value === 0.5, `continuous parse drift: ${JSON.stringify(p)}`);
});

export function runFm9SetParamTests(): void {
  for (const c of cases) c();
}
export const FM9_SETPARAM_CASE_COUNT = cases.length;
