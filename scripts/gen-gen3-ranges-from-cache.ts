/**
 * Generate a gen-3 device's `ranges.generated.ts`: the device-true display-range
 * dictionary (min/max/scale/step/typecode plus enum counts) per (block family,
 * paramId), mined from that device's own editor `effectDefinitions_*.cache`
 * WALK JSON produced by the strict count-driven cache walker.
 *
 * ONE engine, driven per device (PLAN-fm3-iii-ranges-2026-08-01: "do not write
 * a second and third copy of it"). The FM9 pipeline is the proven template;
 * this file generalizes it to a per-device config (catalog, section-tag seeds,
 * walk path, output path, emit template) and drives it for:
 *
 *   fm9   samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json
 *   fm3   samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.walk.json
 *   iii   samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.walk.json
 *
 * Usage:
 *   npx tsx scripts/gen-gen3-ranges-from-cache.ts <fm9|fm3|iii> [walk.json]
 *
 * (`scripts/gen-fm9-ranges-from-cache.ts` remains as a thin wrapper for the
 * FM9 run, so the committed FM9 banner and regenerate instructions stay true.
 * The FM9 emit template below reproduces the pre-generalization output
 * byte-identically; that identity is the refactor's own regression test.)
 *
 * Cache semantics (docs/_private/CACHE-FORMAT-SOLVED-2026-06-09.md):
 *   - sectionTag = the device's block-family tag (shared across the gen-3
 *     editor codebase: DISTORT/amp=10, cab=11, REVERB=12, DELAY=13,
 *     FUZZ/drive=25 on every cache walked so far; asserted per device)
 *   - the fn=0x1F channel-block WIRE STRIDE for a block counts only the
 *     section's ORDINARY records (id < 0xff00); the declared section count
 *     additionally includes special table records (0xffff name tables,
 *     0xfff0..0xfff3 cab-IR tables)
 *   - record id  = catalog paramId within the block (device-true: the SAME
 *     block family keys different ids per device, e.g. REVERB_TYPE/TIME are
 *     10/11 on the FM9 but 0/1 on the FM3 and III)
 *   - record floats = (min, max, scale, step); display value = value * scale
 *
 * sectionTag -> catalog family mapping: five tags are evidence-anchored per
 * device (SEEDS below); the rest are derived by VOTING (kind agreement + a +2
 * bonus when the catalog's known displayMin/displayMax matches the record),
 * with the guards developed on the FM9 pass (placeholder rows do not vote,
 * byte-identical sections group as block instances, enum-free config tables
 * are excluded, tiny families need an exact cover).
 *
 * MIXER vs OUTPUT near-tie discipline (GitHub issue #19): a mislabeled family
 * writes wrong ranges SILENTLY, so the engine additionally runs a pairwise
 * SWAP-STABILITY check over the final assignment: for every assigned pair
 * (f1 -> t1, f2 -> t2), the assigned total score must beat the swapped total
 * by a decisive margin, or generation FAILS loudly instead of shipping a coin
 * flip. Devices whose catalog lacks the disambiguating displayMin/displayMax
 * rows can seed scoring-only `voteRangeHints` (values taken from the family
 * UI constants the FM9 fix backfilled: MIXER_GAINn 0..100 %, OUTPUT_LEVELn
 * -20..20 dB trim).
 *
 * The `.walk.json` lives under samples/ (gitignored scratch); this script's
 * OUTPUT (the generated .ts) is committed. Gates: scripts/verify-fm9-ranges.ts,
 * scripts/verify-fm3-ranges.ts, scripts/verify-iii-ranges.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Param } from '../packages/fractal-midi/src/gen3/types.js';
import { FM9_PARAMS_BY_FAMILY } from '../packages/fractal-midi/src/gen3/fm9/params.js';
import { FM3_PARAMS_BY_FAMILY } from '../packages/fractal-midi/src/gen3/fm3/params.js';
import { PARAMS_BY_FAMILY as III_PARAMS_BY_FAMILY } from '../packages/fractal-midi/src/gen3/axe-fx-iii/params.js';
import { III_ROUNDTRIP_DISCRETE } from '../packages/fractal-midi/src/gen3/axe-fx-iii/roundtripDiscrete.generated.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

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

/** Everything the per-device emit template needs from the generic pass. */
export interface EmitData {
  rows: number;
  familyCount: number;
  familyBlocks: string[];
  metaLines: string[];
  unmappedLines: string[];
}

export interface Gen3RangesDeviceConfig {
  key: string;
  label: string;
  paramsByFamily: Readonly<Record<string, readonly Param[]>>;
  /** Repo-relative default walk-JSON path. */
  defaultWalk: string;
  /** Repo-relative output path of the committed generated .ts. */
  outPath: string;
  /** Evidence-anchored sectionTag seeds (family -> tag), asserted to win their vote. */
  seeds: Readonly<Record<string, number>>;
  /**
   * Scoring-ONLY displayMin/displayMax hints (family -> paramId -> [min, max])
   * for devices whose catalog lacks the disambiguating ranges (issue #19
   * MIXER/OUTPUT class). Never emitted; the emitted ranges always come from
   * the cache records themselves.
   */
  voteRangeHints?: Readonly<Record<string, Readonly<Record<number, readonly [number, number]>>>>;
  /**
   * Optional device-behavior oracle (param firmware symbol -> maxOrdinal) from
   * a hardware SET->GET roundtrip sweep. Used for CONFLICT REPORTING at
   * generation time (cache kind/count vs device behavior); the resolution
   * itself lives in fractal-gen3 catalog.ts, where the roundtrip wins.
   */
  roundtripOracle?: Readonly<Record<string, number>>;
  emit: (data: EmitData) => string;
}

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

function close(a: number, b: number, tol = 0.02): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= tol * Math.max(1e-9, Math.abs(a), Math.abs(b)) || d < 1e-6;
}

/** A placeholder row (unused wire slot) carries no identification signal. */
function isPlaceholder(r: WalkRecord): boolean {
  return r.kind === 'float' && r.min === 0 && r.max === 0 && r.def === 0;
}

// ---------------------------------------------------------------------------
// The generic pass
// ---------------------------------------------------------------------------

export function runGen3Ranges(cfg: Gen3RangesDeviceConfig, walkOverride?: string): void {
  const WALK = walkOverride !== undefined ? resolve(walkOverride) : resolve(root, cfg.defaultWalk);
  const OUT = resolve(root, cfg.outPath);
  console.log(`[${cfg.key}] walk: ${WALK}`);

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

  /** fn=0x1F wire stride = ordinary records only (id < 0xff00). */
  const wireStride = (tag: number): number => bySection.get(tag)?.size ?? 0;

  function informativeSize(sec: Map<number, WalkRecord>): number {
    let n = 0;
    for (const r of sec.values()) if (!isPlaceholder(r)) n++;
    return n;
  }

  function score(family: string, sec: Map<number, WalkRecord>): number {
    let s = 0;
    for (const p of cfg.paramsByFamily[family] ?? []) {
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
      const hint = cfg.voteRangeHints?.[family]?.[p.paramId];
      const dMin = p.displayMin ?? hint?.[0];
      const dMax = p.displayMax ?? hint?.[1];
      if (
        r.kind === 'float' &&
        dMin !== undefined &&
        dMax !== undefined &&
        close(displayOf(r.min, r.def), dMin) &&
        close(displayOf(r.max, r.def), dMax)
      ) {
        s += 2;
      }
    }
    return s;
  }

  const families = Object.keys(cfg.paramsByFamily);

  // Degenerate sections (every record a placeholder) cannot be identified and
  // would otherwise kind-match every float param. Drop them from the vote.
  const degenerateTags = [...bySection.keys()]
    .filter((t) => informativeSize(bySection.get(t)!) === 0)
    .sort((a, b) => a - b);

  // Group byte-identical sections: instance copies of one block family (the
  // device registers Input 1..N / Output 1..N as separate section tags with
  // identical record sets). The lowest tag represents the group.
  function sectionSignature(sec: Map<number, WalkRecord>): string {
    return [...sec.keys()]
      .sort((a, b) => a - b)
      .map((id) => {
        const r = sec.get(id)!;
        const base = `${id}|${r.kind}|${r.tc}|${r.min}|${r.max}|${r.def}|${r.step}`;
        return r.kind === 'enum' ? `${base}|${r.count}|${(r.values ?? []).join('')}` : base;
      })
      .join('');
  }
  // Large enum-free sections are config/mapping tables, not block families:
  // every true block section of >= 100 records carries type-selector /
  // bypass-mode enums, while the 350-record zero-enum CC-style section is a
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
  for (const [family, tag] of Object.entries(cfg.seeds)) {
    const best = pairScores
      .filter((p) => p.family === family)
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.tag !== tag) {
      throw new Error(
        `[${cfg.key}] seed disagreement: ${family} is anchored to section ${tag} but voting picked ` +
          `${best ? `section ${best.tag} (score ${best.score})` : 'nothing'}`
      );
    }
  }

  // Greedy unique assignment, seeds first, then by descending score. A family
  // must clear a floor of agreeing params so a tiny accidental overlap cannot
  // claim a section; tiny families pass only on an exact cover.
  const familyToTag = new Map<string, number>(Object.entries(cfg.seeds));
  const tagToFamily = new Map<number, string>([...familyToTag].map(([f, t]) => [t, f]));
  pairScores.sort((a, b) => b.score - a.score);
  for (const { family, tag, score: s } of pairScores) {
    if (familyToTag.has(family) || tagToFamily.has(tag)) continue;
    const famSize = (cfg.paramsByFamily[family] ?? []).length;
    const sec = bySection.get(tag)!;
    const floor = Math.max(5, Math.ceil(0.5 * Math.min(famSize, informativeSize(sec))));
    const exactCover = s >= famSize && famSize === sec.size;
    if (s < floor && !exactCover) continue;
    familyToTag.set(family, tag);
    tagToFamily.set(tag, family);
  }

  // SWAP-STABILITY margin check (issue #19 discipline): for every assigned
  // pair whose members could STRUCTURALLY take each other's section (the
  // swapped placement would itself clear the assignment rules: voting floor or
  // exact cover), the assigned total must beat the swapped total decisively. A
  // near tie means the two families are separable only by noise, which is
  // exactly the MIXER/OUTPUT silent-mislabel class; fail instead of shipping
  // it. Structurally impossible swaps (e.g. a 2-param family vs a 6-record
  // section: FDBKSEND can never claim FDBKRET's section) are not near-ties,
  // because the size/floor rules pin them regardless of score.
  const SWAP_MARGIN = 4; // two range-bonus points: a single +2 match must not decide alone
  const scoreOf = new Map<string, number>();
  for (const p of pairScores) scoreOf.set(`${p.family}/${p.tag}`, p.score);
  const sc = (f: string, t: number): number => scoreOf.get(`${f}/${t}`) ?? score(f, bySection.get(t)!);
  const acceptable = (f: string, t: number): boolean => {
    const s = sc(f, t);
    const famSize = (cfg.paramsByFamily[f] ?? []).length;
    const sec = bySection.get(t)!;
    const floor = Math.max(5, Math.ceil(0.5 * Math.min(famSize, informativeSize(sec))));
    const exactCover = s >= famSize && famSize === sec.size;
    return s >= floor || exactCover;
  };
  const assigned = [...familyToTag.entries()];
  const nearTies: string[] = [];
  for (let i = 0; i < assigned.length; i++) {
    for (let j = i + 1; j < assigned.length; j++) {
      const [f1, t1] = assigned[i];
      const [f2, t2] = assigned[j];
      if (f1 in cfg.seeds && f2 in cfg.seeds) continue; // both evidence-anchored
      if (!acceptable(f1, t2) || !acceptable(f2, t1)) continue; // structurally pinned
      const kept = sc(f1, t1) + sc(f2, t2);
      const swapped = sc(f1, t2) + sc(f2, t1);
      if (kept - swapped < SWAP_MARGIN) {
        nearTies.push(
          `${f1}<->${f2}: kept ${kept} (=${sc(f1, t1)}+${sc(f2, t2)}) vs swapped ${swapped} ` +
            `(=${sc(f1, t2)}+${sc(f2, t1)}), margin ${kept - swapped} < ${SWAP_MARGIN}`
        );
      }
    }
  }
  if (nearTies.length > 0) {
    throw new Error(
      `[${cfg.key}] family-vote near-tie(s); refusing to pick a winner by coin flip ` +
        `(issue #19 class). Backfill displayMin/displayMax evidence (voteRangeHints) for:\n  ` +
        nearTies.join('\n  ')
    );
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
    const seed = family in cfg.seeds ? ' [anchored]' : '';
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

  // -------------------------------------------------------------------------
  // Cache-vs-roundtrip conflict report (device-behavior oracle, when present)
  // -------------------------------------------------------------------------
  if (cfg.roundtripOracle !== undefined) {
    const nameOfLocal = new Map<string, string>();
    for (const family of families) {
      for (const p of cfg.paramsByFamily[family]) nameOfLocal.set(`${family}/${p.paramId}`, p.name);
    }
    const boundConflicts: string[] = [];
    const kindConflicts: string[] = [];
    for (const [family, tag] of familyToTag) {
      const sec = bySection.get(tag)!;
      for (const p of cfg.paramsByFamily[family] ?? []) {
        const oracleMax = cfg.roundtripOracle[p.name];
        if (oracleMax === undefined) continue;
        const r = sec.get(p.paramId);
        if (!r || isPlaceholder(r)) continue;
        if (r.kind === 'enum') {
          const cacheMax = (r.count ?? 1) - 1;
          if (cacheMax !== oracleMax) {
            boundConflicts.push(
              `${family}.${p.name}: cache enumCount ${r.count} (max ordinal ${cacheMax}) vs roundtrip maxOrdinal ${oracleMax}`
            );
          }
        } else {
          kindConflicts.push(
            `${family}.${p.name}: cache kind float [${displayOf(r.min, r.def)}..${displayOf(r.max, r.def)}] vs roundtrip DISCRETE maxOrdinal ${oracleMax}`
          );
        }
      }
    }
    console.log(
      `cache-vs-roundtrip KIND conflicts (roundtrip wins; routed discrete at the catalog layer): ` +
        `${kindConflicts.length === 0 ? '(none)' : ''}`
    );
    for (const c of kindConflicts) console.log(`  ${c}`);
    console.log(
      `cache-vs-roundtrip ORDINAL-BOUND conflicts (roundtrip wins at the catalog layer): ` +
        `${boundConflicts.length === 0 ? '(none)' : ''}`
    );
    for (const c of boundConflicts) console.log(`  ${c}`);
  }

  // -------------------------------------------------------------------------
  // Emit
  // -------------------------------------------------------------------------

  function num(v: number): string {
    return Object.is(v, -0) ? '0' : String(v);
  }

  const nameOf = new Map<string, string>();
  for (const family of families) {
    for (const p of cfg.paramsByFamily[family]) nameOf.set(`${family}/${p.paramId}`, p.name);
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

  const body = cfg.emit({
    rows,
    familyCount: familyToTag.size,
    familyBlocks,
    metaLines,
    unmappedLines,
  });

  writeFileSync(OUT, body);
  console.log(`\nwrote ${OUT}`);
  console.log(`  ${rows} range rows across ${familyToTag.size} families (all anchors validated)`);
}

// ---------------------------------------------------------------------------
// FM9 config. The emit template reproduces the pre-generalization
// gen-fm9-ranges-from-cache.ts output BYTE-IDENTICALLY (regression anchor).
// ---------------------------------------------------------------------------

const FM9_BANNER = `// GENERATED by scripts/gen-fm9-ranges-from-cache.ts. DO NOT EDIT BY HAND.
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

function emitFm9(d: EmitData): string {
  return `${FM9_BANNER}
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

/** Device-true FM9 display ranges, keyed by catalog family then paramId. ${d.rows} rows. */
export const FM9_RANGES: Readonly<Record<string, Readonly<Record<number, Fm9ParamRange>>>> = {
${d.familyBlocks.join('\n')}
};

/** Family -> (sectionTag, wire stride, raw recordCount). The wire stride
 *  counts ordinary records only (FM9 REVERB 73, DISTORT 147, CABINET 106 all
 *  match the wire-derived values; CABINET's raw count is 110 incl. the 4
 *  special cab-table records the wire stride excludes). */
export const FM9_RANGE_SECTIONS: Readonly<Record<string, Fm9RangeFamilyMeta>> = {
${d.metaLines.join('\n')}
};

/** Cache sections with no confident catalog-family match (system/telemetry
 *  blocks and families whose paramId overlap stayed under the voting floor).
 *  recordCount = raw declared count; wireStride = ordinary records only. */
export const FM9_UNMAPPED_SECTIONS: readonly { sectionTag: number; recordCount: number; wireStride: number }[] = [
${d.unmappedLines.join('\n')}
];
`;
}

// ---------------------------------------------------------------------------
// FM3 config
// ---------------------------------------------------------------------------

const FM3_BANNER = `// GENERATED by scripts/gen-gen3-ranges-from-cache.ts fm3. DO NOT EDIT BY HAND.
// Source: FM3-Edit effectDefinitions cache (FM3 firmware 12.0, community capture
// 2026-06-27, GitHub issues #7/#8), decoded by the strict count-driven walker
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
// 0xfff0..0xfff3 cab-IR tables).
//
// sectionTag -> family: 5 evidence anchors shared with the FM9 cache layout
// (DISTORT=10, CABINET=11, REVERB=12, DELAY=13, FUZZ=25; the record IDS inside
// each section are FM3-true paramIds, e.g. DISTORT_TYPE at id 6, REVERB_TYPE
// at id 0) + kind/range agreement voting against the device-true FM3 catalog
// for the rest, with the issue #19 swap-stability margin check. Anchors
// re-asserted at generation time (amp 331-enum at DISTORT id 6, FUZZ 86-enum
// at id 0, reverb 79-enum at id 0, REVERB_TIME 0.1..100 step 0.02 at id 1).
//
// Status: community-beta evidence grade, decoded from the device's own editor
// cache (real-device sync, walk cross-checked), hardware-unverified beyond the
// anchor points. Gate: scripts/verify-fm3-ranges.ts.
//
// Regenerate:
//   npx tsx scripts/_research/parse-effectdefinitions-cache.ts \\
//     samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.cache --verify
//   npx tsx scripts/gen-gen3-ranges-from-cache.ts fm3
/* eslint-disable */
`;

function emitFm3(d: EmitData): string {
  return `${FM3_BANNER}
export interface Fm3ParamRange {
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
export interface Fm3RangeFamilyMeta {
  readonly sectionTag: number;
  /** fn=0x1F channel-block WIRE stride: ordinary records only (id < 0xff00).
   *  Excludes special table records (0xffff name tables, 0xfff0.. cab-IR
   *  tables). */
  readonly stride: number;
  /** Raw cache section record count as declared, INCLUDING special table
   *  records. Equals stride for sections without specials. */
  readonly recordCount: number;
  /** Present when the device registers multiple byte-identical instance
   *  sections for this family (e.g. Input 1..2, Output 1..2). */
  readonly instanceTags?: readonly number[];
}

/** Device-true FM3 display ranges, keyed by catalog family then paramId. ${d.rows} rows. */
export const FM3_RANGES: Readonly<Record<string, Readonly<Record<number, Fm3ParamRange>>>> = {
${d.familyBlocks.join('\n')}
};

/** Family -> (sectionTag, wire stride, raw recordCount). */
export const FM3_RANGE_SECTIONS: Readonly<Record<string, Fm3RangeFamilyMeta>> = {
${d.metaLines.join('\n')}
};

/** Cache sections with no confident catalog-family match (system/telemetry
 *  blocks and families whose paramId overlap stayed under the voting floor).
 *  recordCount = raw declared count; wireStride = ordinary records only. */
export const FM3_UNMAPPED_SECTIONS: readonly { sectionTag: number; recordCount: number; wireStride: number }[] = [
${d.unmappedLines.join('\n')}
];
`;
}

// ---------------------------------------------------------------------------
// Axe-Fx III config
// ---------------------------------------------------------------------------

const III_BANNER = `// GENERATED by scripts/gen-gen3-ranges-from-cache.ts iii. DO NOT EDIT BY HAND.
// Source: Axe-Edit III effectDefinitions cache (community capture 2026-07-02,
// cache filename tag 10_32p6), decoded by the strict count-driven walker
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
// 0xfff0..0xfff3 cab-IR tables).
//
// sectionTag -> family: 5 evidence anchors shared with the FM9 cache layout
// (DISTORT=10, CABINET=11, REVERB=12, DELAY=13, FUZZ=25; the record IDS inside
// each section are III-true paramIds, e.g. DISTORT_TYPE at id 0, REVERB_TYPE
// at id 0) + kind/range agreement voting against the III catalog for the rest,
// with the issue #19 swap-stability margin check. Anchors re-asserted at
// generation time (amp 336-enum at DISTORT id 0, FUZZ 87-enum at id 0,
// reverb 79-enum at id 0, REVERB_TIME 0.1..100 step 0.02 at id 1).
//
// CONFLICT RULE (the III is the gen-3 byte-identity anchor): where this cache
// and the 2026-06-18 catalog-wide SET->GET roundtrip oracle disagree, the
// ROUNDTRIP (device behavior) wins at the catalog layer (fractal-gen3
// catalog.ts): a roundtrip-discrete param stays DISCRETE even when this cache
// carries a float row for it, and a roundtrip-observed ordinal bound outranks
// this cache's enumCount. Conflicts found at generation time are printed by
// the generator and asserted by the gate.
//
// Status: community-beta evidence grade, decoded from the device's own editor
// cache (real-device sync, walk cross-checked), hardware-unverified beyond the
// anchor points. Gate: scripts/verify-iii-ranges.ts.
//
// Regenerate:
//   npx tsx scripts/_research/parse-effectdefinitions-cache.ts \\
//     samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.cache --verify
//   npx tsx scripts/gen-gen3-ranges-from-cache.ts iii
/* eslint-disable */
`;

function emitIii(d: EmitData): string {
  return `${III_BANNER}
export interface AxeFxIIIParamRange {
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
export interface AxeFxIIIRangeFamilyMeta {
  readonly sectionTag: number;
  /** fn=0x1F channel-block WIRE stride: ordinary records only (id < 0xff00).
   *  Excludes special table records (0xffff name tables, 0xfff0.. cab-IR
   *  tables). */
  readonly stride: number;
  /** Raw cache section record count as declared, INCLUDING special table
   *  records. Equals stride for sections without specials. */
  readonly recordCount: number;
  /** Present when the device registers multiple byte-identical instance
   *  sections for this family (e.g. Input 1..N, Output 1..N). */
  readonly instanceTags?: readonly number[];
}

/** Device-true Axe-Fx III display ranges, keyed by catalog family then paramId. ${d.rows} rows. */
export const III_RANGES: Readonly<Record<string, Readonly<Record<number, AxeFxIIIParamRange>>>> = {
${d.familyBlocks.join('\n')}
};

/** Family -> (sectionTag, wire stride, raw recordCount). */
export const III_RANGE_SECTIONS: Readonly<Record<string, AxeFxIIIRangeFamilyMeta>> = {
${d.metaLines.join('\n')}
};

/** Cache sections with no confident catalog-family match (system/telemetry
 *  blocks and families whose paramId overlap stayed under the voting floor).
 *  recordCount = raw declared count; wireStride = ordinary records only. */
export const III_UNMAPPED_SECTIONS: readonly { sectionTag: number; recordCount: number; wireStride: number }[] = [
${d.unmappedLines.join('\n')}
];
`;
}

// ---------------------------------------------------------------------------
// Device registry + CLI
// ---------------------------------------------------------------------------

/** Shared evidence-anchored section tags (same editor codebase family-wide;
 *  the seed assertion re-proves them against each device's own catalog). */
const SHARED_SEEDS: Readonly<Record<string, number>> = {
  DISTORT: 10,
  CABINET: 11,
  REVERB: 12,
  DELAY: 13,
  FUZZ: 25,
};

/** Scoring-only MIXER/OUTPUT disambiguation (issue #19): the FM9 catalog
 *  carries these ranges in params.ts; the FM3/III catalogs do not, so the
 *  swap-stability check needs the same family UI constants as vote hints
 *  (MIXER_GAINn 0..100 % row gain, OUTPUT_LEVELn -20..20 dB trim). Values are
 *  scoring evidence only and are never emitted. */
function mixerOutputHints(
  paramsByFamily: Readonly<Record<string, readonly Param[]>>,
): Readonly<Record<string, Readonly<Record<number, readonly [number, number]>>>> {
  const hints: Record<string, Record<number, readonly [number, number]>> = {};
  for (const p of paramsByFamily['MIXER'] ?? []) {
    if (/^MIXER_GAIN\d+$/.test(p.name)) (hints['MIXER'] ??= {})[p.paramId] = [0, 100];
  }
  for (const p of paramsByFamily['OUTPUT'] ?? []) {
    if (/^OUTPUT_LEVEL\d+$/.test(p.name)) (hints['OUTPUT'] ??= {})[p.paramId] = [-20, 20];
  }
  return hints;
}

export const GEN3_RANGES_DEVICES: Readonly<Record<string, Gen3RangesDeviceConfig>> = {
  fm9: {
    key: 'fm9',
    label: 'FM9',
    paramsByFamily: FM9_PARAMS_BY_FAMILY,
    defaultWalk: 'samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json',
    outPath: 'packages/fractal-midi/src/gen3/fm9/ranges.generated.ts',
    seeds: SHARED_SEEDS,
    // No voteRangeHints: the FM9 params.ts already carries the MIXER/OUTPUT
    // disambiguation ranges (the original issue #19 fix).
    emit: emitFm9,
  },
  fm3: {
    key: 'fm3',
    label: 'FM3',
    paramsByFamily: FM3_PARAMS_BY_FAMILY,
    defaultWalk: 'samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.walk.json',
    outPath: 'packages/fractal-midi/src/gen3/fm3/ranges.generated.ts',
    seeds: SHARED_SEEDS,
    voteRangeHints: mixerOutputHints(FM3_PARAMS_BY_FAMILY),
    emit: emitFm3,
  },
  iii: {
    key: 'iii',
    label: 'Axe-Fx III',
    paramsByFamily: III_PARAMS_BY_FAMILY,
    defaultWalk: 'samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.walk.json',
    outPath: 'packages/fractal-midi/src/gen3/axe-fx-iii/ranges.generated.ts',
    seeds: SHARED_SEEDS,
    voteRangeHints: mixerOutputHints(III_PARAMS_BY_FAMILY),
    roundtripOracle: III_ROUNDTRIP_DISCRETE,
    emit: emitIii,
  },
};

const isMain = (() => {
  try {
    return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  const keyArg = (process.argv[2] ?? '').toLowerCase();
  const alias: Record<string, string> = { 'axe-fx-iii': 'iii', axefx3: 'iii', iii: 'iii', fm3: 'fm3', fm9: 'fm9' };
  const key = alias[keyArg];
  if (key === undefined) {
    console.error('usage: npx tsx scripts/gen-gen3-ranges-from-cache.ts <fm9|fm3|iii> [walk.json]');
    process.exit(2);
  }
  runGen3Ranges(GEN3_RANGES_DEVICES[key], process.argv[3]);
}
