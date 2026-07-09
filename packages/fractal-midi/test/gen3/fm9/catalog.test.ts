/**
 * FM9 device-true paramId spot goldens.
 *
 * Owns: a handful of KNOWN device-divergent paramIds pinned to the FM9's own
 * values, cross-asserted against the III and FM3 catalogs so a catalog regen
 * that cross-contaminates devices (reusing another device's ids) fails loudly.
 *
 * Why: paramIds are device-specific, never reused across the gen-3 family
 * (package CLAUDE.md: reverb mix/type are 0/10 on FM9 but 13/0 on FM3 and III;
 * reusing III ids would mis-address 13%+ of shared params). The 2026-06-18
 * incident showed what happens when FM9 classification leans on III-anchored
 * data — this suite is the id-space counterpart of that guard. The broader
 * statistical divergence check lives in test/gen3/modern-family/catalog.test.ts
 * (do not duplicate it here); these are exact, named anchors.
 */
import { FM9_PARAMS_BY_FAMILY } from '../../../src/gen3/fm9/index.js';
import { FM3_PARAMS_BY_FAMILY } from '../../../src/gen3/fm3/index.js';
import { PARAMS_BY_FAMILY as III_PARAMS_BY_FAMILY } from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function pid(
  pbf: Readonly<Record<string, readonly { name: string; paramId: number }[]>>,
  family: string,
  name: string,
): number | undefined {
  return (pbf[family] ?? []).find((p) => p.name === name)?.paramId;
}

const cases: Array<() => void> = [];

// Device-true FM9 ids (family, name, FM9 id, III id, FM3 id). III/FM3 ids are
// pinned too so the inequality assertions below stay meaningful.
const SPOT: ReadonlyArray<readonly [string, string, number, number, number]> = [
  // The CLAUDE.md-cited divergence: reverb mix/type 0/10 on FM9, 13/0 on III+FM3.
  ['REVERB', 'REVERB_MIX', 0, 13, 13],
  ['REVERB', 'REVERB_TYPE', 10, 0, 0],
  ['REVERB', 'REVERB_TIME', 11, 1, 1],
  // Amp (DISTORT family) model selector + gain knob: three-way divergent.
  ['DISTORT', 'DISTORT_TYPE', 10, 0, 6],
  ['DISTORT', 'DISTORT_DRIVE', 11, 1, 7],
  // Delay mix: FM9+FM3 both 0, III 17 — guards against an III-flavored regen.
  ['DELAY', 'DELAY_MIX', 0, 17, 0],
];

for (const [family, name, fm9Id, iiiId, fm3Id] of SPOT) {
  cases.push(() => assert(pid(FM9_PARAMS_BY_FAMILY, family, name) === fm9Id, `FM9 ${family}.${name} = ${pid(FM9_PARAMS_BY_FAMILY, family, name)} (want device-true ${fm9Id})`));
  cases.push(() => assert(pid(III_PARAMS_BY_FAMILY, family, name) === iiiId, `III ${family}.${name} = ${pid(III_PARAMS_BY_FAMILY, family, name)} (want ${iiiId})`));
  cases.push(() => assert(pid(FM3_PARAMS_BY_FAMILY, family, name) === fm3Id, `FM3 ${family}.${name} = ${pid(FM3_PARAMS_BY_FAMILY, family, name)} (want ${fm3Id})`));
}

// Cross-contamination tripwire: the FM9 reverb trio must NOT equal the III's.
for (const name of ['REVERB_MIX', 'REVERB_TYPE', 'REVERB_TIME']) {
  cases.push(() =>
    assert(
      pid(FM9_PARAMS_BY_FAMILY, 'REVERB', name) !== pid(III_PARAMS_BY_FAMILY, 'REVERB', name),
      `FM9 REVERB.${name} equals the III id — catalog regen cross-contaminated devices`,
    ),
  );
}

export function runFm9CatalogTests(): void {
  for (const c of cases) c();
}
export const FM9_CATALOG_CASE_COUNT = cases.length;
