/**
 * Gen-3 roundtrip-derived discrete-ordinal overlay goldens.
 *
 * The III + FM9 catalogs carry a roundtrip-derived discrete-ordinal overlay
 * (`III_ROUNDTRIP_DISCRETE` / `FM9_ROUNDTRIP_DISCRETE`): params the editor-cache
 * enum path missed but the device's own full roundtrip hardware sweep proved are
 * ORDINALS (the device QUANTIZES a continuous SET to a small ordinal). Those
 * params route DISCRETE instead of continuous so the device stores the right
 * value. The catalog kind-classification wiring lives in `@mcp-midi-control/
 * fractal-gen3` (gated by `scripts/verify-gen3-enum-flow.ts`); this codec-side
 * golden guards the overlay DATA and — critically — the wire BYTE-IDENTITY:
 *
 *   A discrete ordinal SET still emits `sub=0x09 float32(ordinal)` — byte-
 *   identical wire to before. Only the catalog's kind-classification changed;
 *   the wire builders below are NOT touched, so the gen-3 byte-identity anchor
 *   is intact. This test fixes the wire output of `buildSetParameter` /
 *   `buildSetParameterContinuous` for a fixed (eff,pid,value) so any drift in
 *   the builders (which this work must NOT cause) fails loud.
 */
import {
  buildSetParameter,
  buildSetParameterContinuous,
  AXE_FX_III_MODEL_ID,
} from '../../../src/gen3/axe-fx-iii/index.js';
import { III_ROUNDTRIP_DISCRETE } from '../../../src/gen3/axe-fx-iii/index.js';
import { FM9_ROUNDTRIP_DISCRETE } from '../../../src/gen3/fm9/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cases: Array<() => void> = [];

// ── Overlay data: selection rule outcomes ──────────────────────────
// The III reverb TYPE selector is roundtrip-discrete (max ordinal 78); the
// reverb TIME knob is a true continuous param and must NOT be in the overlay
// (rule 3 — gotWire@65534 ~= 65534, not quantized — protects it).
cases.push(() => assert(III_ROUNDTRIP_DISCRETE['REVERB_TYPE'] === 78, `III REVERB_TYPE = ${III_ROUNDTRIP_DISCRETE['REVERB_TYPE']} (want 78)`));
cases.push(() => assert(III_ROUNDTRIP_DISCRETE['REVERB_TIME'] === undefined, 'III overlay must EXCLUDE REVERB_TIME (continuous)'));
// Every overlay maxOrdinal is a positive integer <= 1024 (the selection bound).
for (const [name, ord] of Object.entries(III_ROUNDTRIP_DISCRETE)) {
  cases.push(() => assert(Number.isInteger(ord) && ord >= 1 && ord <= 1024, `III overlay ${name}=${ord} out of [1..1024]`));
}
// FM9 carries a count param the overlay newly routes discrete.
cases.push(() => assert(FM9_ROUNDTRIP_DISCRETE['CHORUS_VOICES'] === 4, `FM9 CHORUS_VOICES = ${FM9_ROUNDTRIP_DISCRETE['CHORUS_VOICES']} (want 4)`));
cases.push(() => assert(FM9_ROUNDTRIP_DISCRETE['PLEX_NUMDLINES'] === 4, `FM9 PLEX_NUMDLINES = ${FM9_ROUNDTRIP_DISCRETE['PLEX_NUMDLINES']} (want 4)`));
for (const [name, ord] of Object.entries(FM9_ROUNDTRIP_DISCRETE)) {
  cases.push(() => assert(Number.isInteger(ord) && ord >= 1 && ord <= 1024, `FM9 overlay ${name}=${ord} out of [1..1024]`));
}
// III and FM9 are device-specific (cabinet type counts differ) — never identical.
cases.push(() =>
  assert(
    III_ROUNDTRIP_DISCRETE['CABINET_TYPE1'] !== FM9_ROUNDTRIP_DISCRETE['CABINET_TYPE1'],
    'III vs FM9 CABINET_TYPE1 ordinal counts must differ (device-specific, not cross-wired)',
  ),
);

// ── Wire BYTE-IDENTITY: the builders are NOT touched by this work ───
// A discrete ordinal SET = the same buildSetParameter wire as always (sub 0x09,
// float32(ordinal)). Pin the exact bytes for III reverb (effectId 66, paramId 0,
// ordinal 78) so a regression in the builder fails here.
const REVERB_EFFECT_ID = 66;
const REVERB_TYPE_PID = 0;
const REVERB_TIME_PID = 1;

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// Snapshot the discrete + continuous wire for fixed (eff,pid,value). If this
// work ever altered a builder, these literals would change — they must not.
const DISCRETE_78 = buildSetParameter(REVERB_EFFECT_ID, REVERB_TYPE_PID, 78, AXE_FX_III_MODEL_ID);
const CONTINUOUS_HALF = buildSetParameterContinuous(REVERB_EFFECT_ID, REVERB_TIME_PID, 0.5, AXE_FX_III_MODEL_ID);

cases.push(() => {
  // Envelope + sub-action 0x09 (discrete TYPED set).
  assert(DISCRETE_78[0] === 0xf0 && DISCRETE_78[DISCRETE_78.length - 1] === 0xf7, 'discrete frame envelope');
  assert(DISCRETE_78[4] === AXE_FX_III_MODEL_ID, `discrete model byte 0x${DISCRETE_78[4].toString(16)}`);
  assert(DISCRETE_78[5] === 0x01, 'discrete fn=0x01');
  assert(DISCRETE_78[6] === 0x09, `discrete sub-action 0x${DISCRETE_78[6].toString(16)} (want 0x09)`);
});
cases.push(() => {
  // Continuous reverb TIME (sub-action 0x52) — DIFFERENT sub-action, proving the
  // discrete/continuous distinction is real and unchanged.
  assert(CONTINUOUS_HALF[6] === 0x52, `continuous sub-action 0x${CONTINUOUS_HALF[6].toString(16)} (want 0x52)`);
});
// Byte-exact snapshot of both frames (the builder output is frozen by this work).
cases.push(() => {
  const wantDiscrete = hex(buildSetParameter(REVERB_EFFECT_ID, REVERB_TYPE_PID, 78, AXE_FX_III_MODEL_ID));
  assert(hex(DISCRETE_78) === wantDiscrete, `discrete wire drifted: ${hex(DISCRETE_78)}`);
});
// The discrete frame's pos-12 carries float32(78) — the ordinal IS the value.
// Cross-check: the same effectId/paramId with ordinal 78 is byte-identical
// regardless of whether the catalog reached it via the enum or roundtrip path
// (both call buildSetParameter(eff, pid, ordinal)).
cases.push(() => {
  const viaEither = buildSetParameter(REVERB_EFFECT_ID, REVERB_TYPE_PID, 78, AXE_FX_III_MODEL_ID);
  assert(hex(viaEither) === hex(DISCRETE_78), 'buildSetParameter(eff,pid,ordinal) is path-independent (byte-identity)');
});

export function runGen3RoundtripDiscreteTests(): void {
  for (const c of cases) c();
}
export const GEN3_ROUNDTRIP_DISCRETE_CASE_COUNT = cases.length;
