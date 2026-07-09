/**
 * FM9 CABINET roster goldens.
 *
 * Owns: the generated factory cab/IR tables (`cabRosters.generated.ts` — the
 * CABINET section's 0xfff0..0xfff2 special table records from the FM9-Edit
 * cache, cross-validated across six firmware walks), the name→(bank, ordinal)
 * resolver (`cabResolve.ts`), and the CABINET_BANK vocabulary wired into
 * FM9_ENUM_OVERRIDES.
 *
 * Key invariants guarded here:
 *   - the USER bank never ships (device-owner content; "<EMPTY>" tripwire);
 *   - the LEGACY table's length anchors to the III hardware roundtrip's
 *     CABINET_TYPE1 quantization max (188 = 189-1) — the one device-behavior
 *     anchor the cab data has;
 *   - CABINET_TYPEn gets NO flat enum table (bank-conditioned ordinal space —
 *     a flat table would mislabel every bank but one); only CABINET_BANKn
 *     (unconditional 5-name mapping) is in FM9_ENUM_OVERRIDES.
 */
import {
  FM9_CAB_BANK_NAMES,
  FM9_CAB_FACTORY1_ROSTER,
  FM9_CAB_FACTORY2_ROSTER,
  FM9_CAB_LEGACY_ROSTER,
  FM9_CAB_ROSTERS_BY_BANK,
  resolveFm9CabName,
  FM9_ENUM_OVERRIDES,
} from '../../../src/gen3/fm9/index.js';
import { III_ROUNDTRIP_DISCRETE } from '../../../src/gen3/axe-fx-iii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const cases: Array<() => void> = [];

// ── Table shapes + spot anchors (generation-time gates, re-pinned) ─────────
cases.push(() => assert(Object.keys(FM9_CAB_FACTORY1_ROSTER).length === 1024, `FACTORY 1 count ${Object.keys(FM9_CAB_FACTORY1_ROSTER).length} != 1024`));
cases.push(() => assert(Object.keys(FM9_CAB_FACTORY2_ROSTER).length === 1024, `FACTORY 2 count ${Object.keys(FM9_CAB_FACTORY2_ROSTER).length} != 1024`));
cases.push(() => assert(Object.keys(FM9_CAB_LEGACY_ROSTER).length === 189, `LEGACY count ${Object.keys(FM9_CAB_LEGACY_ROSTER).length} != 189`));
cases.push(() => assert(FM9_CAB_FACTORY1_ROSTER[0] === '1x4 Pig 57', `FACTORY 1[0] = ${FM9_CAB_FACTORY1_ROSTER[0]}`));
cases.push(() => assert(FM9_CAB_FACTORY2_ROSTER[1023] === 'TOTALLY-FLAT', `FACTORY 2[1023] = ${FM9_CAB_FACTORY2_ROSTER[1023]}`));
cases.push(() => assert(FM9_CAB_LEGACY_ROSTER[0] === '1x6 OVAL', `LEGACY[0] = ${FM9_CAB_LEGACY_ROSTER[0]}`));
cases.push(() => assert(FM9_CAB_LEGACY_ROSTER[188] === '4x12 G12M CREAMBACK MIX (CEL)', `LEGACY[188] = ${FM9_CAB_LEGACY_ROSTER[188]}`));

// ── The III-roundtrip length anchor ─────────────────────────────────────────
cases.push(() =>
  assert(
    Object.keys(FM9_CAB_LEGACY_ROSTER).length - 1 === III_ROUNDTRIP_DISCRETE['CABINET_TYPE1'],
    `LEGACY length-1 (${Object.keys(FM9_CAB_LEGACY_ROSTER).length - 1}) != III roundtrip CABINET_TYPE1 max (${III_ROUNDTRIP_DISCRETE['CABINET_TYPE1']})`,
  ),
);

// ── User-content tripwires ──────────────────────────────────────────────────
for (const [label, roster] of [
  ['FACTORY 1', FM9_CAB_FACTORY1_ROSTER],
  ['FACTORY 2', FM9_CAB_FACTORY2_ROSTER],
  ['LEGACY', FM9_CAB_LEGACY_ROSTER],
] as const) {
  cases.push(() => assert(!Object.values(roster).includes('<EMPTY>'), `${label} contains an <EMPTY> slot — user content leaked into a factory table`));
}
// Only factory banks ship: 0 (FACTORY 1), 1 (FACTORY 2), 3 (LEGACY).
cases.push(() => {
  const got = Object.keys(FM9_CAB_ROSTERS_BY_BANK).sort().join(',');
  assert(got === '0,1,3', `FM9_CAB_ROSTERS_BY_BANK banks ${got} != 0,1,3 (USER/SCRATCHPAD must never ship)`);
});
cases.push(() => {
  const got = Object.entries(FM9_CAB_BANK_NAMES).map(([k, v]) => `${k}=${v}`).join(',');
  assert(got === '0=FACTORY 1,1=FACTORY 2,2=USER,3=LEGACY,4=SCRATCHPAD', `bank names ${got}`);
});

// ── Resolver: name → (bank, ordinal) ────────────────────────────────────────
cases.push(() => {
  const m = resolveFm9CabName('1x6 OVAL');
  assert(m.length === 1 && m[0].bank === 3 && m[0].bankName === 'LEGACY' && m[0].type === 0, `resolve('1x6 OVAL') = ${JSON.stringify(m)}`);
});
cases.push(() => {
  const m = resolveFm9CabName('  1x4 pig 57 '); // case + whitespace tolerant
  assert(m.length === 1 && m[0].bank === 0 && m[0].type === 0 && m[0].name === '1x4 Pig 57', `resolve('1x4 pig 57') = ${JSON.stringify(m)}`);
});
cases.push(() => {
  const m = resolveFm9CabName('TOTALLY-FLAT');
  assert(m.length === 1 && m[0].bank === 1 && m[0].type === 1023, `resolve('TOTALLY-FLAT') = ${JSON.stringify(m)}`);
});
cases.push(() => assert(resolveFm9CabName('Not A Real Cab Name').length === 0, 'unknown name must resolve to []'));

// ── Wiring: BANK vocabulary in, TYPE flat table OUT ─────────────────────────
cases.push(() => assert(FM9_ENUM_OVERRIDES['CABINET_BANK1'] === FM9_CAB_BANK_NAMES, 'CABINET_BANK1 must carry the bank vocabulary'));
cases.push(() => assert(FM9_ENUM_OVERRIDES['CABINET_BANK2'] === FM9_CAB_BANK_NAMES, 'CABINET_BANK2 must carry the bank vocabulary'));
// The bank-conditioned guard: a flat CABINET_TYPE enum table would mislabel
// every bank but one. If someone adds it, they must have solved bank-aware
// resolution first — fail loudly here.
cases.push(() => assert(FM9_ENUM_OVERRIDES['CABINET_TYPE1'] === undefined, 'CABINET_TYPE1 must NOT get a flat enum table (bank-conditioned ordinal space)'));
cases.push(() => assert(FM9_ENUM_OVERRIDES['CABINET_TYPE2'] === undefined, 'CABINET_TYPE2 must NOT get a flat enum table (bank-conditioned ordinal space)'));

export function runFm9CabRosterTests(): void {
  for (const c of cases) c();
}
export const FM9_CAB_ROSTER_CASE_COUNT = cases.length;
