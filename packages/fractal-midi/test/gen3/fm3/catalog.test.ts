/**
 * FM3 device-true paramId spot goldens.
 *
 * Owns: named FM3 paramId anchors cross-asserted against the III and FM9
 * catalogs so a catalog regen that cross-contaminates devices fails loudly.
 *
 * Why: paramIds are device-specific across the gen-3 family (package
 * CLAUDE.md: reverb mix/type are 13/0 on FM3 and III but 0/10 on FM9; reusing
 * III ids would mis-address 266/1991 of the FM3's shared-with-III params).
 * The 2026-06-18 FM9 incident was the classification face of the same
 * III-anchoring failure mode; this is the id-space guard. The statistical
 * divergence check and the DELAY_TIME anchor live in
 * test/gen3/modern-family/catalog.test.ts — not duplicated here.
 */
import { FM3_PARAMS_BY_FAMILY } from '../../../src/gen3/fm3/index.js';
import { FM9_PARAMS_BY_FAMILY } from '../../../src/gen3/fm9/index.js';
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

// Device-true FM3 ids (family, name, FM3 id). The reverb trio matches the III
// (13/0/1) — the FM9 is the odd one out there — while the DISTORT (amp) family
// diverges three ways (FM3 6/7 vs III 0/1 vs FM9 10/11).
const SPOT: ReadonlyArray<readonly [string, string, number]> = [
  ['REVERB', 'REVERB_MIX', 13],
  ['REVERB', 'REVERB_TYPE', 0],
  ['REVERB', 'REVERB_TIME', 1],
  ['DISTORT', 'DISTORT_TYPE', 6],
  ['DISTORT', 'DISTORT_DRIVE', 7],
  ['DELAY', 'DELAY_MIX', 0],
];

for (const [family, name, fm3Id] of SPOT) {
  cases.push(() => assert(pid(FM3_PARAMS_BY_FAMILY, family, name) === fm3Id, `FM3 ${family}.${name} = ${pid(FM3_PARAMS_BY_FAMILY, family, name)} (want device-true ${fm3Id})`));
}

// Cross-contamination tripwires: the FM3 amp selector/knob ids must equal
// NEITHER the III's nor the FM9's (three-way divergent family).
for (const name of ['DISTORT_TYPE', 'DISTORT_DRIVE']) {
  cases.push(() =>
    assert(
      pid(FM3_PARAMS_BY_FAMILY, 'DISTORT', name) !== pid(III_PARAMS_BY_FAMILY, 'DISTORT', name),
      `FM3 DISTORT.${name} equals the III id — catalog regen cross-contaminated devices`,
    ),
  );
  cases.push(() =>
    assert(
      pid(FM3_PARAMS_BY_FAMILY, 'DISTORT', name) !== pid(FM9_PARAMS_BY_FAMILY, 'DISTORT', name),
      `FM3 DISTORT.${name} equals the FM9 id — catalog regen cross-contaminated devices`,
    ),
  );
}

export function runFm3CatalogTests(): void {
  for (const c of cases) c();
}
export const FM3_CATALOG_CASE_COUNT = cases.length;
