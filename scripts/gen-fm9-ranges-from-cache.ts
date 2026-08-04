/**
 * Generate `packages/fractal-midi/src/gen3/fm9/ranges.generated.ts`: the
 * device-true FM9 display-range dictionary (min/max/scale/step/typecode plus
 * enum counts) per (block family, paramId), mined from an FM9-Edit
 * `effectDefinitions_12_<fw>.cache` WALK JSON produced by the strict
 * count-driven cache walker.
 *
 * Pipeline (two steps, both offline):
 *   1. npx tsx scripts/_research/parse-effectdefinitions-cache.ts \
 *        samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.cache --verify
 *   2. npx tsx scripts/gen-fm9-ranges-from-cache.ts \
 *        [samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json]
 *
 * Cache semantics (docs/_private/CACHE-FORMAT-SOLVED-2026-06-09.md):
 *   - sectionTag = the device's block-family tag (REVERB=12, DISTORT/amp=10,
 *     cab=11, delay=13, FUZZ/drive=25, shared with AM4 where blocks overlap)
 *   - the fn=0x1F channel-block WIRE STRIDE for a block counts only the
 *     section's ORDINARY records (id < 0xff00). The cache's declared section
 *     count additionally includes special table records (0xffff name tables,
 *     0xfff0..0xfff3 cab-IR tables), which the wire stride excludes: the FM9
 *     sub=0x01 block-definition response reports CABINET paramCount 106 while
 *     the cache CABINET section declares 110 records (4 cab tables). The raw
 *     declared count is kept as a separate `recordCount` field.
 *   - record id  = catalog paramId within the block
 *   - record floats = (min, max, scale, step); display value = value * scale
 *     (e.g. DISTORT_DRIVE min=0 max=1 scale=10 -> display 0..10 knob;
 *     REVERB_MIX 0..1 scale=100 -> 0..100 %). Placeholder ids carry
 *     min=max=scale=0.
 *
 * sectionTag -> catalog family mapping: five tags are evidence-anchored
 * (DISTORT=10, CABINET=11, REVERB=12, DELAY=13, FUZZ=25); the rest are derived
 * by VOTING: for every (family, section) pair, count catalog paramIds whose
 * cache record agrees in kind (enum vs float), weighting +2 extra when the
 * catalog's known displayMin/displayMax matches min*scale/max*scale, then
 * greedy-assign best section per family (same technique as
 * samples/captured/local-caches-2026-06-09/tcjoin.py on the AM4 cache).
 * Seeded anchors are ASSERTED to also win their own vote. Guards against the
 * failure modes observed on the first pass:
 *   - placeholder records (min=max=scale=0) carry no information and do NOT
 *     vote; sections made ENTIRELY of placeholders (4, 53 on fw 11.0) are
 *     excluded outright (they otherwise kind-match every float param);
 *   - byte-identical sections are INSTANCE GROUPS of one block family
 *     (INPUT = 41..44, OUTPUT = 46..48 on fw 11.0); the group votes once and
 *     the family maps to all member tags, so a leftover family can never
 *     claim "Output 2" as its own section;
 *   - tiny families below the score floor are accepted only on an EXACT
 *     cover (every family paramId present, kinds agree, family size ==
 *     section size; FDBKSEND -> 29).
 * Families with no confident section stay unmapped (honest gap), and
 * unmapped sections are listed in the output for the next decode pass.
 *
 * MIXER vs OUTPUT near-tie (issue #19, 2026-07-18): MIXER_GAIN and OUTPUT_LEVEL
 * were both cataloged as `unit: 'numeric'` with no displayMin/displayMax, so
 * neither ever earned the +2 range-match bonus and the two same-sized
 * all-float families scored within 2 points of each other on kind-agreement
 * alone — on fw 11.0 that coin flip happened to land right (OUTPUT=46..48,
 * MIXER=28); on a fw 12.0 community cache it flipped (OUTPUT=28, MIXER=46),
 * silently mislabeling every MIXER_GAIN/OUTPUT_LEVEL row. Fixed by backfilling
 * both families' displayMin/displayMax in params.ts from the already-committed,
 * cache-spot-verified fw 11.0 ranges (MIXER_GAIN 0..100%; OUTPUT_LEVEL
 * -20..20dB trim), so the range bonus now separates them by a comfortable
 * margin (fw 12.0: OUTPUT 65 vs runner-up 39; MIXER 43 vs runner-up 29)
 * instead of a near-tie, robust to whichever firmware cache is fed in.
 *
 * The `.walk.json` lives under samples/ (gitignored scratch); this script's
 * OUTPUT (the generated .ts) is committed. Gate: scripts/verify-fm9-ranges.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FM9_PARAMS_BY_FAMILY } from '../packages/fractal-midi/src/gen3/fm9/params.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const WALK = process.argv[2]
  ?? resolve(root, 'samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json');
const OUT = resolve(root, 'packages/fractal-midi/src/gen3/fm9/ranges.generated.ts');

// ---------------------------------------------------------------------------
// Walk JSON shapes (subset of scripts/_research/parse-effectdefinitions-cache.ts output)
// ---------------------------------------------------------------------------

interface WalkRecord {
  kind: 'enum' | 'float';
  section: number;
  offset: number;
  id: number;
  tc: number;
  min: number;
  max: number;
  /** The third record float is the display-scale multiplier (display = value * scale). */
  def: number;
  step: number;
  count?: number;
  values?: string[];
}
interface Walk {
  sections: { index: number; count: number; offset: number; records: number }[];
  records: WalkRecord[];
}

const walk: Walk = JSON.parse(readFileSync(WALK, 'utf8'));

// Group plain (non-table) records by section.
const bySection = new Map<number, Map<number, WalkRecord>>();
for (const r of walk.records) {
  if (r.id >= 0xff00) continue; // 0xffff name tables / 0xfff0.. cab-IR tables
  let m = bySection.get(r.section);
  if (!m) bySection.set(r.section, (m = new Map()));
  m.set(r.id, r);
}
const declaredCount = new Map<number, number>(walk.sections.map((s) => [s.index, s.count]));

/** fn=0x1F wire stride = ordinary records only (id < 0xff00). The declared
 *  cache count additionally includes special table records (0xffff name
 *  tables, 0xfff0.. cab-IR tables), which the wire stride excludes
 *  (FM9 sub=0x01 block-definition cross-validation: CABINET wire 106 vs
 *  cache 110). bySection is already filtered to ordinary records. */
const wireStride = (tag: number): number => bySection.get(tag)?.size ?? 0;

// ---------------------------------------------------------------------------
// f32 cleanup: shortest decimal that rounds back to the same float32
// ---------------------------------------------------------------------------

function f32clean(v: number): number {
  if (!Number.isFinite(v) || v === 0) return v === 0 ? 0 : v;
  for (let p = 1; p <= 9; p++) {
    const c = Number(v.toPrecision(p));
    if (Math.fround(c) === Math.fround(v)) return c;
  }
  return v;
}

/** Snap a product to the shortest decimal within 1e-6 relative tolerance, so
 *  f32 noise in (value * scale) does not leak (pi * 57.295776 emits 180, not
 *  179.99999). Tolerance is relative for values >= 1, absolute 1e-6 below. */
function snapShort(d: number): number {
  if (!Number.isFinite(d) || d === 0) return d;
  for (let p = 1; p <= 9; p++) {
    const c = Number(d.toPrecision(p));
    if (Math.abs(c - d) <= 1e-6 * Math.max(1, Math.abs(c), Math.abs(d))) return c;
  }
  return d;
}

function displayOf(raw: number, scale: number): number {
  if (scale === 0) return f32clean(raw); // placeholder rows (min=max=scale=0) and identity
  return snapShort(f32clean(raw) * f32clean(scale));
}

// ---------------------------------------------------------------------------
// sectionTag -> family: seeded anchors + kind/range agreement voting
// ---------------------------------------------------------------------------

/** Evidence-anchored tags (CACHE-FORMAT-SOLVED-2026-06-09.md, hardware anchors). */
const SEEDS: Readonly<Record<string, number>> = {
  DISTORT: 10, // amp; 331-enum on fw 11.0 / 336 on fw 12.0 at id 10, hardware ordinals 65/179/264
  CABINET: 11,
  REVERB: 12, // 79-enum at id 10, REVERB_TIME (0.1, 100) at id 11
  DELAY: 13,
  FUZZ: 25, // drive; 86-enum on fw 11.0 / 87 on fw 12.0 at id 0, hardware ordinals 15/36
};

function close(a: number, b: number, tol = 0.02): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= tol * Math.max(1e-9, Math.abs(a), Math.abs(b)) || d < 1e-6;
}

/** A placeholder row (unused wire slot) carries no identification signal. */
function isPlaceholder(r: WalkRecord): boolean {
  return r.kind === 'float' && r.min === 0 && r.max === 0 && r.def === 0;
}

function informativeSize(sec: Map<number, WalkRecord>): number {
  let n = 0;
  for (const r of sec.values()) if (!isPlaceholder(r)) n++;
  return n;
}

function score(family: string, sec: Map<number, WalkRecord>): number {
  let s = 0;
  for (const p of FM9_PARAMS_BY_FAMILY[family] ?? []) {
    const r = sec.get(p.paramId);
    if (!r || isPlaceholder(r)) continue;
    const catalogEnum = p.unit === 'enum';
    if (catalogEnum !== (r.kind === 'enum')) {
      // A kind contradiction is real negative evidence (a uniform all-float
      // section can otherwise out-vote the true section on size alone).
      s -= 1;
      continue;
    }
    s += 1;
    if (
      r.kind === 'float' &&
      p.displayMin !== undefined &&
      p.displayMax !== undefined &&
      close(displayOf(r.min, r.def), p.displayMin) &&
      close(displayOf(r.max, r.def), p.displayMax)
    ) {
      s += 2;
    }
  }
  return s;
}

const families = Object.keys(FM9_PARAMS_BY_FAMILY);

// Degenerate sections (every record a placeholder) cannot be identified and
// would otherwise kind-match every float param. Drop them from the vote.
const degenerateTags = [...bySection.keys()]
  .filter((t) => informativeSize(bySection.get(t)!) === 0)
  .sort((a, b) => a - b);

// Group byte-identical sections: instance copies of one block family (the
// device registers Input 1..4 / Output 1..3 as separate section tags with
// identical record sets). The lowest tag represents the group.
function sectionSignature(sec: Map<number, WalkRecord>): string {
  return [...sec.keys()]
    .sort((a, b) => a - b)
    .map((id) => {
      const r = sec.get(id)!;
      const base = `${id}|${r.kind}|${r.tc}|${r.min}|${r.max}|${r.def}|${r.step}`;
      return r.kind === 'enum' ? `${base}|${r.count}|${(r.values ?? []).join('')}` : base;
    })
    .join('');
}
// Large enum-free sections are config/mapping tables, not block families:
// every true block section of >= 100 records (DISTORT, CABINET, MULTITAP,
// PITCH, PLEX) carries type-selector / bypass-mode enums, while fw 11.0
// section 58 (350 records, zero enums, CC-style 0..127 ranges) is a
// footswitch/CC mapping table that kind-matches any float-heavy family on
// sheer size. Exclude such sections from family assignment.
function isEnumFreeTable(sec: Map<number, WalkRecord>): boolean {
  if (sec.size < 100) return false;
  for (const r of sec.values()) if (r.kind === 'enum') return false;
  return true;
}
const tableTags = [...bySection.keys()]
  .filter((t) => !degenerateTags.includes(t) && isEnumFreeTable(bySection.get(t)!))
  .sort((a, b) => a - b);

const groupBySignature = new Map<string, number[]>();
for (const tag of [...bySection.keys()].sort((a, b) => a - b)) {
  if (degenerateTags.includes(tag) || tableTags.includes(tag)) continue;
  const sig = sectionSignature(bySection.get(tag)!);
  const g = groupBySignature.get(sig);
  if (g) g.push(tag);
  else groupBySignature.set(sig, [tag]);
}
const groups = [...groupBySignature.values()]; // each sorted ascending by construction
const groupOf = new Map<number, number[]>();
for (const g of groups) for (const t of g) groupOf.set(t, g);
const representativeTags = groups.map((g) => g[0]);

// Score every (family, group-representative) pair.
const pairScores: { family: string; tag: number; score: number }[] = [];
for (const family of families) {
  for (const tag of representativeTags) {
    const s = score(family, bySection.get(tag)!);
    if (s > 0) pairScores.push({ family, tag, score: s });
  }
}

// Assert each seed wins its own vote (sanity: the voting agrees with evidence).
for (const [family, tag] of Object.entries(SEEDS)) {
  const best = pairScores
    .filter((p) => p.family === family)
    .sort((a, b) => b.score - a.score)[0];
  if (!best || best.tag !== tag) {
    throw new Error(
      `seed disagreement: ${family} is anchored to section ${tag} but voting picked ` +
        `${best ? `section ${best.tag} (score ${best.score})` : 'nothing'}`
    );
  }
}

// Greedy unique assignment, seeds first, then by descending score. A family
// must clear a floor of agreeing params so a tiny accidental overlap cannot
// claim a section; tiny families pass only on an exact cover.
const familyToTag = new Map<string, number>(Object.entries(SEEDS));
const tagToFamily = new Map<number, string>([...familyToTag].map(([f, t]) => [t, f]));
pairScores.sort((a, b) => b.score - a.score);
for (const { family, tag, score: s } of pairScores) {
  if (familyToTag.has(family) || tagToFamily.has(tag)) continue;
  const famSize = (FM9_PARAMS_BY_FAMILY[family] ?? []).length;
  const sec = bySection.get(tag)!;
  const floor = Math.max(5, Math.ceil(0.5 * Math.min(famSize, informativeSize(sec))));
  const exactCover = s >= famSize && famSize === sec.size;
  if (s < floor && !exactCover) continue;
  familyToTag.set(family, tag);
  tagToFamily.set(tag, family);
}

// Report the assignment with scores + runner-up so a human can audit it.
console.log(`degenerate sections (all placeholders, excluded): ${degenerateTags.map((t) => `${t}(${declaredCount.get(t)})`).join(' ') || '(none)'}`);
console.log(`enum-free table sections (config/mapping tables, excluded): ${tableTags.map((t) => `${t}(${declaredCount.get(t)})`).join(' ') || '(none)'}`);
const instanceGroups = groups.filter((g) => g.length > 1);
console.log(`identical-section instance groups: ${instanceGroups.map((g) => `[${g.join(',')}]`).join(' ') || '(none)'}`);
console.log('family -> sectionTag assignment:');
for (const [family, tag] of [...familyToTag].sort((a, b) => a[1] - b[1])) {
  const mine = pairScores.filter((p) => p.family === family);
  const own = mine.find((p) => p.tag === tag)?.score ?? 0;
  const runner = mine.filter((p) => p.tag !== tag).sort((a, b) => b.score - a.score)[0];
  const seed = family in SEEDS ? ' [anchored]' : '';
  const grp = groupOf.get(tag)!;
  const inst = grp.length > 1 ? ` instances=[${grp.join(',')}]` : '';
  console.log(
    `  ${family.padEnd(12)} -> sec ${String(tag).padStart(2)}  ` +
      `score=${own} (runner-up ${runner ? `sec ${runner.tag}=${runner.score}` : 'none'})` +
      `  records=${bySection.get(tag)!.size}/${declaredCount.get(tag)}${inst}${seed}`
  );
}
const unmappedFamilies = families.filter((f) => !familyToTag.has(f));
const unmappedTags = [...bySection.keys()]
  .filter((t) => ![...familyToTag.values()].some((rep) => groupOf.get(rep)?.includes(t)))
  .sort((a, b) => a - b);
console.log(`unmapped families: ${unmappedFamilies.join(', ') || '(none)'}`);
console.log(
  `unmapped sections: ${unmappedTags.map((t) => `${t}(${declaredCount.get(t)})`).join(' ') || '(none)'}`
);

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function num(v: number): string {
  return Object.is(v, -0) ? '0' : String(v);
}

const nameOf = new Map<string, string>();
for (const family of families) {
  for (const p of FM9_PARAMS_BY_FAMILY[family]) nameOf.set(`${family}/${p.paramId}`, p.name);
}

const familyBlocks: string[] = [];
let rows = 0;
for (const [family, tag] of [...familyToTag].sort((a, b) => a[0].localeCompare(b[0]))) {
  const sec = bySection.get(tag)!;
  const lines: string[] = [];
  for (const id of [...sec.keys()].sort((a, b) => a - b)) {
    const r = sec.get(id)!;
    const scale = f32clean(r.def);
    const fields = [
      `kind: '${r.kind}'`,
      `displayMin: ${num(displayOf(r.min, r.def))}`,
      `displayMax: ${num(displayOf(r.max, r.def))}`,
      `scale: ${num(scale)}`,
      `step: ${num(f32clean(r.step))}`,
      `typecode: 0x${r.tc.toString(16)}`,
    ];
    if (r.kind === 'enum') fields.push(`enumCount: ${r.count}`);
    const name = nameOf.get(`${family}/${id}`);
    lines.push(`    ${id}: { ${fields.join(', ')} },${name ? ` // ${name}` : ''}`);
    rows++;
  }
  const grp = groupOf.get(tag)!;
  const inst = grp.length > 1 ? `; identical instance sections ${grp.join('/')}` : '';
  const declared = declaredCount.get(tag)!;
  const stride = wireStride(tag);
  const specials = declared !== stride ? `; ${declared} cache records incl. ${declared - stride} special table record(s)` : '';
  familyBlocks.push(
    `  /** sectionTag ${tag}, wire stride ${stride} (fn=0x1F channel-block stride, ordinary records only)${specials}${inst}. */\n` +
      `  ${family}: {\n${lines.join('\n')}\n  },`
  );
}

const metaLines = [...familyToTag]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([f, t]) => {
    const grp = groupOf.get(t)!;
    const inst = grp.length > 1 ? `, instanceTags: [${grp.join(', ')}]` : '';
    return `  ${f}: { sectionTag: ${t}, stride: ${wireStride(t)}, recordCount: ${declaredCount.get(t)}${inst} },`;
  });
const unmappedLines = unmappedTags.map(
  (t) => `  { sectionTag: ${t}, recordCount: ${declaredCount.get(t)}, wireStride: ${wireStride(t)} },`
);

const banner = `// GENERATED by scripts/gen-fm9-ranges-from-cache.ts. DO NOT EDIT BY HAND.
// Source: FM9-Edit effectDefinitions cache (FM9 firmware 12.0, community capture
// 2026-07-18, issue #19), decoded by the strict count-driven walker
// (scripts/_research/parse-effectdefinitions-cache.ts; grammar:
// packages/fractal-midi/docs/research/primitives/editor-cache-section-record-grammar.md).
//
// Per (block family, paramId): the device's OWN display range.
//   displayMin/displayMax = cache (min, max) * scale, in front-panel units
//   scale                 = display-scale multiplier (display = value * scale)
//   step                  = front-panel increment, in pre-scale value units
//   typecode              = undecoded device bitfield (unit/taper candidate)
//   enumCount             = list length for enum-kind records (ordinal max = enumCount-1)
// Placeholder ids (unused wire slots) carry all-zero rows; they are kept so the
// table mirrors the device's fn=0x1F stride layout 1:1.
//
// Strides: per-family 'stride' is the fn=0x1F channel-block WIRE stride and
// counts ordinary records only (id < 0xff00); 'recordCount' is the raw cache
// section count including special table records (0xffff name tables,
// 0xfff0..0xfff3 cab-IR tables). Cross-validated by the FM9 fn=0x01 sub=0x01
// block-definition response (CABINET wire 106 vs 110 cache records).
//
// sectionTag -> family: 5 hardware/evidence anchors (DISTORT=10, CABINET=11,
// REVERB=12, DELAY=13, FUZZ=25) + kind/range agreement voting against the
// device-true FM9 catalog for the rest (placeholder rows excluded from votes;
// byte-identical sections grouped as block instances). Anchors re-asserted at
// generation time (amp 336-enum, FUZZ 87-enum, reverb 79-enum,
// REVERB_TIME 0.1..100 step 0.02; amp/FUZZ grew from 331/86 on fw 11.0 as
// firmware 12.0 appended new models — see verify-fm9-ranges.ts).
//
// Status: community-beta evidence grade, decoded from the device's own editor
// cache (real-device sync), hardware-unverified beyond the anchor points.
// NOT yet wired into live catalog resolution; gate: scripts/verify-fm9-ranges.ts.
//
// Regenerate:
//   npx tsx scripts/_research/parse-effectdefinitions-cache.ts \\
//     samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.cache --verify
//   npx tsx scripts/gen-fm9-ranges-from-cache.ts
/* eslint-disable */
`;

const body = `${banner}
export interface Fm9ParamRange {
  readonly kind: 'enum' | 'float';
  /** Device-true display minimum (= cache min * scale). */
  readonly displayMin: number;
  /** Device-true display maximum (= cache max * scale). */
  readonly displayMax: number;
  /** Display-scale multiplier: display = value * scale. 0 on placeholder rows. */
  readonly scale: number;
  /** Front-panel increment, in pre-scale value units. */
  readonly step: number;
  /** Undecoded device bitfield (unit/taper candidate). */
  readonly typecode: number;
  /** Enum list length (enum kind only); valid ordinals are 0..enumCount-1. */
  readonly enumCount?: number;
}

/** Per-family cache section tag + fn=0x1F channel-block stride. */
export interface Fm9RangeFamilyMeta {
  readonly sectionTag: number;
  /** fn=0x1F channel-block WIRE stride: ordinary records only (id < 0xff00).
   *  Excludes special table records (0xffff name tables, 0xfff0.. cab-IR
   *  tables); cross-validated by the FM9 sub=0x01 block-definition response
   *  (CABINET wire 106 vs 110 cache records). */
  readonly stride: number;
  /** Raw cache section record count as declared, INCLUDING special table
   *  records. Equals stride for sections without specials. */
  readonly recordCount: number;
  /** Present when the device registers multiple byte-identical instance
   *  sections for this family (e.g. Input 1..4, Output 1..3). */
  readonly instanceTags?: readonly number[];
}

/** Device-true FM9 display ranges, keyed by catalog family then paramId. ${rows} rows. */
export const FM9_RANGES: Readonly<Record<string, Readonly<Record<number, Fm9ParamRange>>>> = {
${familyBlocks.join('\n')}
};

/** Family -> (sectionTag, wire stride, raw recordCount). The wire stride
 *  counts ordinary records only (FM9 REVERB 73, DISTORT 147, CABINET 106 all
 *  match the wire-derived values; CABINET's raw count is 110 incl. the 4
 *  special cab-table records the wire stride excludes). */
export const FM9_RANGE_SECTIONS: Readonly<Record<string, Fm9RangeFamilyMeta>> = {
${metaLines.join('\n')}
};

/** Cache sections with no confident catalog-family match (system/telemetry
 *  blocks and families whose paramId overlap stayed under the voting floor).
 *  recordCount = raw declared count; wireStride = ordinary records only. */
export const FM9_UNMAPPED_SECTIONS: readonly { sectionTag: number; recordCount: number; wireStride: number }[] = [
${unmappedLines.join('\n')}
];
`;

writeFileSync(OUT, body);
console.log(`\nwrote ${OUT}`);
console.log(`  ${rows} range rows across ${familyToTag.size} families (all anchors validated)`);
