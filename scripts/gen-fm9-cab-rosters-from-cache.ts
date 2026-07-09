/**
 * Generate `packages/fractal-midi/src/gen3/fm9/cabRosters.generated.ts` — the
 * device-true FM9 CABINET (cab IR / legacy-cab) name tables, mined from the
 * FM9-Edit `effectDefinitions` cache walks and cross-validated across every
 * firmware cache on disk before emission.
 *
 * WHY THIS EXISTS. The 2026-06-27 "cab: no base roster to validate against"
 * verdict was stale (2026-07-02 synthesis pass §1c): the synced FM9 cache's
 * CABINET section carries FOUR special table records (ids 0xfff0..0xfff3 —
 * the "cab-IR tables" the range-walker skips), each a full name list:
 *   0xfff0  1024 names  "1x4 Pig 57" …                → FACTORY 1 bank
 *   0xfff1  1024 names  … "TOTALLY-FLAT"              → FACTORY 2 bank
 *   0xfff2   189 names  "1x6 OVAL" … (II-era caps)    → LEGACY bank
 *   0xfff3  1024 names  owner IRs + "<EMPTY>" slots   → USER bank (EXCLUDED)
 *
 * TABLE→BANK JOIN (content-signature, the one soft step — documented, not
 * id-arithmetic): the CABINET_BANK selector's own cache enum is
 * ["FACTORY 1","FACTORY 2","USER","LEGACY","SCRATCHPAD"] (ordinals 0..4).
 * 0xfff2 cannot be the USER bank (fixed 189 curated II-era cab names, no
 * "<EMPTY>", byte-identical across all six firmware caches) and 0xfff3 cannot
 * be factory content ("<EMPTY>" slots + owner-specific names), so
 * 0xfff2=LEGACY (bank ordinal 3) and 0xfff3=USER (bank ordinal 2). Anchor:
 * the legacy table's length-1 (188) equals the Axe-Fx III hardware
 * roundtrip's CABINET_TYPE1 quantization max (III_ROUNDTRIP_DISCRETE,
 * chihotta 2026-06-18) — the device's own ordinal space for a legacy-bank
 * cab slot ends exactly where this table ends.
 *
 * VALIDATION GATES (generator refuses to emit on any failure):
 *   - all six firmware walks on disk (8p1/9p0/9p1/9p2/75p0/11p0) agree
 *     byte-for-byte per ordinal on 0xfff0/0xfff1/0xfff2 (a conflict = STOP
 *     for that ordinal — none found at generation time; 10p0's walk lacks
 *     the CABINET specials and is skipped with a note);
 *   - counts pinned (1024/1024/189) + the III-roundtrip length anchor;
 *   - no "<EMPTY>" entry in any emitted table;
 *   - the bank enum matches the documented 5-name list.
 *
 * WHAT THIS DOES **NOT** DO — read before wiring these into enum_values:
 * unlike amp/drive/reverb TYPE (one unconditional ordinal→name space),
 * CABINET_TYPEn's ordinal space is BANK-CONDITIONED: the same ordinal names
 * a different IR depending on the paired CABINET_BANKn value (cache:
 * TYPE1/2 are float 0..1023, BANK1/2 enum/5). Registering ONE flat table on
 * CABINET_TYPE would mislabel reads and mis-set writes for every other bank,
 * so these tables ship as bank-keyed DATA + a name→(bank, ordinal) resolver
 * (`cabResolve.ts`); only the BANK selector's 5-name vocabulary is wired
 * into FM9_ENUM_OVERRIDES (that mapping is unconditional).
 *
 * INDEX-0 CAVEAT (community-beta): no hardware capture yet pins name[0] ↔
 * within-bank ordinal 0 (the amp/drive/reverb rosters had captured ordinal
 * anchors; cab has only the length anchor above). Verify on hardware: select
 * the first Factory 1 cab on the panel and read CABINET_TYPE1 — ordinal 0
 * should pair with "1x4 Pig 57".
 *
 * The walk JSONs are gitignored (samples/); this script's OUTPUT is committed.
 *   npx tsx scripts/gen-fm9-cab-rosters-from-cache.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { III_ROUNDTRIP_DISCRETE } from '../packages/fractal-midi/src/gen3/axe-fx-iii/roundtripDiscrete.generated.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const DIR = resolve(root, 'samples/captured/fm9-community-2026-06-09');
const OUT = resolve(root, 'packages/fractal-midi/src/gen3/fm9/cabRosters.generated.ts');

const PRIMARY_FW = '11p0';
const CROSS_FWS = ['8p1', '9p0', '9p1', '9p2', '75p0', '10p0'];

const CABINET_SECTION = 11; // sectionTag 11 = CABINET (anchored in ranges.generated.ts)

interface WalkRecord {
  kind: string;
  section: number;
  id: number;
  count?: number;
  values?: string[];
}

function loadSpecials(fw: string): Map<number, string[]> | undefined {
  const path = resolve(DIR, `effectDefinitions_12_${fw}.walk.json`);
  if (!existsSync(path)) return undefined;
  const walk = JSON.parse(readFileSync(path, 'utf8')) as { records: WalkRecord[] };
  const out = new Map<number, string[]>();
  for (const r of walk.records) {
    if (r.section === CABINET_SECTION && r.id >= 0xfff0 && r.id <= 0xfff3 && Array.isArray(r.values)) {
      out.set(r.id, r.values);
    }
  }
  return out.size > 0 ? out : undefined;
}

const primary = loadSpecials(PRIMARY_FW);
if (primary === undefined) throw new Error(`primary walk (${PRIMARY_FW}) has no CABINET specials`);
for (const id of [0xfff0, 0xfff1, 0xfff2, 0xfff3]) {
  if (!primary.has(id)) throw new Error(`primary walk missing CABINET special 0x${id.toString(16)}`);
}

// ── Cross-firmware agreement gate (conflicts = STOP) ────────────────────────
const crossChecked: string[] = [];
const skipped: string[] = [];
for (const fw of CROSS_FWS) {
  const other = loadSpecials(fw);
  if (other === undefined) {
    skipped.push(fw);
    continue;
  }
  for (const id of [0xfff0, 0xfff1, 0xfff2]) {
    const a = primary.get(id)!;
    const b = other.get(id);
    if (b === undefined) throw new Error(`fw ${fw}: CABINET special 0x${id.toString(16)} missing`);
    if (b.length !== a.length) {
      throw new Error(`fw ${fw}: CABINET 0x${id.toString(16)} length ${b.length} != ${a.length} — cross-firmware conflict, STOP`);
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        throw new Error(
          `fw ${fw}: CABINET 0x${id.toString(16)}[${i}] "${b[i]}" != "${a[i]}" — cross-firmware conflict, STOP for this ordinal (none may ship)`,
        );
      }
    }
  }
  crossChecked.push(fw);
}
if (crossChecked.length === 0) throw new Error('no cross-validation firmware walk found — refuse to emit single-source');

const factory1 = primary.get(0xfff0)!;
const factory2 = primary.get(0xfff1)!;
const legacy = primary.get(0xfff2)!;
const user = primary.get(0xfff3)!;

// ── Shape + anchor gates ────────────────────────────────────────────────────
if (factory1.length !== 1024) throw new Error(`FACTORY 1 count ${factory1.length} != 1024`);
if (factory2.length !== 1024) throw new Error(`FACTORY 2 count ${factory2.length} != 1024`);
if (legacy.length !== 189) throw new Error(`LEGACY count ${legacy.length} != 189`);
const iiiCabMax = III_ROUNDTRIP_DISCRETE['CABINET_TYPE1'];
if (legacy.length - 1 !== iiiCabMax) {
  throw new Error(`LEGACY length-1 (${legacy.length - 1}) != III roundtrip CABINET_TYPE1 max (${iiiCabMax}) — length anchor broken`);
}
// Content-signature sanity for the table→bank join.
if (!user.includes('<EMPTY>')) throw new Error('0xfff3 has no <EMPTY> slots — user-bank signature broken, re-verify the table→bank join');
for (const [label, table] of [['FACTORY 1', factory1], ['FACTORY 2', factory2], ['LEGACY', legacy]] as const) {
  if (table.includes('<EMPTY>')) throw new Error(`${label} contains <EMPTY> — factory-table signature broken`);
}

// Bank enum from the CABINET_BANK1 record (id 0) — pin the documented order.
{
  const walk = JSON.parse(readFileSync(resolve(DIR, `effectDefinitions_12_${PRIMARY_FW}.walk.json`), 'utf8')) as { records: WalkRecord[] };
  const bank = walk.records.find((r) => r.section === CABINET_SECTION && r.id === 0);
  const want = ['FACTORY 1', 'FACTORY 2', 'USER', 'LEGACY', 'SCRATCHPAD'];
  if (JSON.stringify(bank?.values) !== JSON.stringify(want)) {
    throw new Error(`CABINET_BANK1 enum ${JSON.stringify(bank?.values)} != ${JSON.stringify(want)}`);
  }
}

function toMap(names: string[]): string {
  return '{\n' + names.map((n, i) => `  ${i}: ${JSON.stringify(n)},`).join('\n') + '\n}';
}

const banner = `// GENERATED by scripts/gen-fm9-cab-rosters-from-cache.ts — DO NOT EDIT BY HAND.
// Source: FM9-Edit effectDefinitions cache walks (community capture 2026-06-09,
// D. MacVicar), CABINET section special table records 0xfff0..0xfff2.
// Cross-validated byte-for-byte across firmware caches ${crossChecked.join('/')}${skipped.length > 0 ? ` (${skipped.join('/')} lack the CABINET specials and were skipped)` : ''};
// zero conflicts. The USER bank table (0xfff3: owner IRs + <EMPTY> slots) is
// deliberately NOT emitted — it is device-owner content, not a factory roster.
//
// BANK-CONDITIONED — do NOT register these flat on CABINET_TYPEn enum_values:
// the same TYPE ordinal names a different IR per CABINET_BANKn value
// (banks: 0=FACTORY 1, 1=FACTORY 2, 2=USER, 3=LEGACY, 4=SCRATCHPAD). Use
// resolveFm9CabName (cabResolve.ts) for name -> (bank, ordinal), then set
// BOTH the bank and type params. Table->bank join is content-signature
// (see the generator header); the LEGACY table's length-1 = 188 matches the
// III hardware roundtrip's CABINET_TYPE1 quantization max (length anchor).
//
// Community-beta, index-0 caveat: no hardware anchor yet pins name[0] <->
// within-bank ordinal 0 (verify: first Factory 1 cab on the panel should read
// CABINET_TYPE1 ordinal 0 = "1x4 Pig 57"). Re-run the script to regenerate.
/* eslint-disable */
`;

const body = `${banner}
/** CABINET bank selector ordinals (CABINET_BANK1/2 cache enum, in order). */
export const FM9_CAB_BANK_NAMES: Readonly<Record<number, string>> = {
  0: "FACTORY 1",
  1: "FACTORY 2",
  2: "USER",
  3: "LEGACY",
  4: "SCRATCHPAD",
};

/** FM9 FACTORY 1 cab bank (bank ordinal 0). ${factory1.length} IRs. */
export const FM9_CAB_FACTORY1_ROSTER: Readonly<Record<number, string>> = ${toMap(factory1)};

/** FM9 FACTORY 2 cab bank (bank ordinal 1). ${factory2.length} IRs. */
export const FM9_CAB_FACTORY2_ROSTER: Readonly<Record<number, string>> = ${toMap(factory2)};

/** FM9 LEGACY cab bank (bank ordinal 3) — the II-era cab models. ${legacy.length} cabs. */
export const FM9_CAB_LEGACY_ROSTER: Readonly<Record<number, string>> = ${toMap(legacy)};

/**
 * Factory cab rosters keyed by CABINET_BANK ordinal. USER (2) and
 * SCRATCHPAD (4) are absent by design (device-owner content).
 */
export const FM9_CAB_ROSTERS_BY_BANK: Readonly<Record<number, Readonly<Record<number, string>>>> = {
  0: FM9_CAB_FACTORY1_ROSTER,
  1: FM9_CAB_FACTORY2_ROSTER,
  3: FM9_CAB_LEGACY_ROSTER,
};
`;

writeFileSync(OUT, body);
console.log(`wrote ${OUT}`);
console.log(`  factory1=${factory1.length}  factory2=${factory2.length}  legacy=${legacy.length}  (user bank excluded)`);
console.log(`  cross-validated vs fw: ${crossChecked.join(', ')}${skipped.length > 0 ? `; skipped (no CABINET specials): ${skipped.join(', ')}` : ''}`);
console.log(`  anchors: legacy length-1 = ${legacy.length - 1} = III roundtrip CABINET_TYPE1 max`);
