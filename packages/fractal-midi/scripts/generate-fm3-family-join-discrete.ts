/**
 * Generate the FM3 FAMILY-JOIN discrete-ordinal overlay
 * (`src/gen3/fm3/familyJoinDiscrete.generated.ts`).
 *
 * THE PROBLEM (same class as the FM9 2026-06-18 / III 2026-06-20 corrections).
 * A type/model/mode selector or integer-count param that the device treats as
 * an ORDINAL must be SET as a discrete float32(ordinal) (sub 09 00). Sent
 * CONTINUOUS (the catalog's default for any param the enum overlays missed),
 * the device QUANTIZES the normalized float and stores the WRONG value. The
 * FM9 was corrected from its own editor-cache enum rows + the chihotta
 * hardware roundtrip; the III from the chihotta roundtrip as oracle. The FM3
 * has NO roundtrip capture and NO device-synced enum cache, so its selectors
 * still routed continuous — the same latent wrong-value bug on the
 * best-hardware-confirmed gen-3 device.
 *
 * THE FIX (this generator): a FAMILY JOIN. The gen-3 family (III/FM3/FM9)
 * shares one effect codec, one block table, and one firmware symbol vocabulary
 * — a param's discrete-vs-continuous KIND is a property of the shared effect
 * algorithm, not of the model byte (the 2026-06-18 catalog-wide roundtrip
 * showed every shared selector quantizing identically on FM9 and III). So an
 * FM3 catalog param is classified discrete when a SIBLING source proves the
 * same (block family, param SYMBOL) is an ordinal:
 *   - the FM9 editor-cache kind:'enum' rows (FM9_RANGES), provenance
 *     'fm9-cache-family-join';
 *   - the FM9/III roundtrip-discrete sets (FM9_ROUNDTRIP_DISCRETE /
 *     III_ROUNDTRIP_DISCRETE), provenance 'sibling-roundtrip-family-join'.
 *
 * JOIN RULE — by (family, SYMBOL), NEVER by paramId: paramIds are
 * device-specific ordinals and must not cross model bytes (cookbook negative
 * `gen3-paramid-reuse-across-model-bytes`). Only FM3 catalog params whose
 * (family, name) exists on the sibling qualify; params already routed discrete
 * on the FM3 (an enum vocabulary from the XML overlay, the byte-anchored
 * effect-type lists, or the shared read rosters) are EXCLUDED so the overlay
 * covers exactly what the existing enum paths miss (mirrors the FM9 invariant
 * that the roundtrip overlay never overlaps the cache-enum class).
 *
 * maxOrdinal = the LARGEST sibling bound for the symbol (FM9 cache
 * enumCount-1, FM9 roundtrip maxOrdinal, III roundtrip maxOrdinal): the FM3's
 * true count is unknown, an under-bound would REFUSE valid FM3 ordinals, and
 * the roundtrip sweeps showed gen-3 devices clamp an over-range ordinal to
 * their own max. The bound is an encode guard only — the wire form is
 * unchanged (float32(ordinal), sub 09 00).
 *
 * EVIDENCE TIER: family-pattern (STRONG per the shipping bar — grounded in
 * the sibling devices' own cache + hardware roundtrips), community-beta,
 * FM3 roundtrip pending (Drew's queued FM3 session is the confirm).
 *
 * Usage:  npx tsx scripts/generate-fm3-family-join-discrete.ts
 * Deterministic and idempotent (keys sorted). Re-run after an FM3/FM9/III
 * catalog regen or when new sibling oracle data lands.
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FM3_PARAMS } from '../src/gen3/fm3/params.js';
import {
  FM9_PARAMS,
  FM9_RANGES,
  FM9_ROUNDTRIP_DISCRETE,
} from '../src/gen3/fm9/index.js';
import {
  PARAMS as III_PARAMS,
  III_ROUNDTRIP_DISCRETE,
  resolveEnumValues,
  resolveEffectTypeEnum,
  GEN3_READ_ROSTERS,
} from '../src/gen3/axe-fx-iii/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../src/gen3/fm3/familyJoinDiscrete.generated.ts');

type Provenance = 'fm9-cache-family-join' | 'sibling-roundtrip-family-join';

interface SiblingRow {
  maxOrdinal: number;
  fromCache: boolean;
  sources: string[];
}

// ── Build the sibling evidence table, keyed `family|SYMBOL` ────────────────
const sibling = new Map<string, SiblingRow>();

function addSibling(family: string, name: string, maxOrdinal: number, fromCache: boolean, source: string): void {
  const key = `${family}|${name}`;
  const row = sibling.get(key);
  if (row === undefined) {
    sibling.set(key, { maxOrdinal, fromCache, sources: [source] });
  } else {
    row.maxOrdinal = Math.max(row.maxOrdinal, maxOrdinal);
    row.fromCache = row.fromCache || fromCache;
    if (!row.sources.includes(source)) row.sources.push(source);
  }
}

// FM9 editor-cache kind:'enum' rows (the 2026-06-18 corrected class).
for (const p of FM9_PARAMS) {
  if (p.paramId >= 0x3fff) continue;
  const row = FM9_RANGES[p.family]?.[p.paramId];
  if (row?.kind === 'enum' && typeof row.enumCount === 'number' && row.enumCount > 1) {
    addSibling(p.family, p.name, row.enumCount - 1, true, 'fm9-cache');
  }
}
// FM9 roundtrip-discrete overlay (chihotta 2026-06-18 hardware sweep).
{
  const fm9ByName = new Map<string, string[]>();
  for (const p of FM9_PARAMS) {
    if (p.paramId >= 0x3fff) continue;
    const fams = fm9ByName.get(p.name) ?? [];
    if (!fams.includes(p.family)) fams.push(p.family);
    fm9ByName.set(p.name, fams);
  }
  for (const [name, maxOrdinal] of Object.entries(FM9_ROUNDTRIP_DISCRETE)) {
    for (const family of fm9ByName.get(name) ?? []) {
      addSibling(family, name, maxOrdinal, false, 'fm9-roundtrip');
    }
  }
}
// III roundtrip-discrete overlay (chihotta 2026-06-18 sweep, registered 06-20).
{
  const iiiByName = new Map<string, string[]>();
  for (const p of III_PARAMS) {
    if (p.paramId >= 0x3fff) continue;
    const fams = iiiByName.get(p.name) ?? [];
    if (!fams.includes(p.family)) fams.push(p.family);
    iiiByName.set(p.name, fams);
  }
  for (const [name, maxOrdinal] of Object.entries(III_ROUNDTRIP_DISCRETE)) {
    for (const family of iiiByName.get(name) ?? []) {
      addSibling(family, name, maxOrdinal, false, 'iii-roundtrip');
    }
  }
}

// ── Join to the FM3 catalog by (family, SYMBOL) ────────────────────────────
// Skip params that ALREADY route discrete on the FM3 today: an enum
// vocabulary reaches buildParamSchema via (a) the full XML overlay for
// unit:'enum' params, (b) the byte-anchored effect-type lists for everything
// else, or (c) the shared gen-3 read rosters (GEN3_READ_ROSTERS, passed as
// sharedEnumRosters for grid devices). This mirrors buildParamSchema's own
// enumValues computation (fractal-gen3/src/catalog.ts) so the overlay covers
// exactly what those paths miss.
function fm3AlreadyDiscrete(name: string, unit: string): boolean {
  const overlay = unit === 'enum' ? resolveEnumValues(name) : resolveEffectTypeEnum(name);
  if (overlay?.values !== undefined) return true;
  if (GEN3_READ_ROSTERS[name] !== undefined) return true;
  return false;
}

const joined: Record<string, { maxOrdinal: number; provenance: Provenance; sources: string[] }> = {};
const stats = { cache: 0, roundtripOnly: 0, alreadyDiscrete: 0, noSibling: 0 };
const seen = new Set<string>();

for (const p of FM3_PARAMS) {
  if (p.paramId >= 0x3fff) continue;
  if (seen.has(`${p.family}|${p.name}`)) continue;
  seen.add(`${p.family}|${p.name}`);
  const row = sibling.get(`${p.family}|${p.name}`);
  if (row === undefined) {
    stats.noSibling += 1;
    continue;
  }
  if (fm3AlreadyDiscrete(p.name, p.unit)) {
    stats.alreadyDiscrete += 1;
    continue;
  }
  const provenance: Provenance = row.fromCache
    ? 'fm9-cache-family-join'
    : 'sibling-roundtrip-family-join';
  if (row.fromCache) stats.cache += 1;
  else stats.roundtripOnly += 1;
  joined[p.name] = { maxOrdinal: row.maxOrdinal, provenance, sources: row.sources };
}

// A duplicate SYMBOL across FM3 families with different bounds would make the
// flat symbol-keyed export ambiguous; assert it cannot happen.
{
  const byName = new Map<string, number>();
  for (const [name, v] of Object.entries(joined)) {
    const prior = byName.get(name);
    if (prior !== undefined && prior !== v.maxOrdinal) {
      throw new Error(`FM3 family-join: symbol ${name} joined twice with different bounds (${prior} vs ${v.maxOrdinal})`);
    }
    byName.set(name, v.maxOrdinal);
  }
}

const keys = Object.keys(joined).sort();
const rowLines = keys.map((k) => `  ${JSON.stringify(k)}: ${joined[k].maxOrdinal}, // ${joined[k].provenance} (${joined[k].sources.join(' + ')})`);
const provLines = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(joined[k].provenance)},`);

const out = `// GENERATED by scripts/generate-fm3-family-join-discrete.ts — do not hand-edit.
// FM3 FAMILY-JOIN discrete-ordinal overlay: the enum-flow correction the FM9
// (2026-06-18, ~351 selectors, cache-gated) and the III (2026-06-20, ~92
// selectors, roundtrip-oracled) already received, applied to the FM3 via a
// (block family, param SYMBOL) join against the sibling evidence — the FM3
// has no roundtrip capture and no device-synced enum cache of its own.
//
// EVIDENCE TIER: family-pattern (STRONG — the gen-3 family shares one effect
// codec and symbol vocabulary; kind is a property of the shared algorithm,
// proven identical on FM9 + III by the 2026-06-18 catalog-wide hardware
// roundtrip). Community-beta; an FM3 SET→GET roundtrip is the pending
// hardware confirm (queued for Drew's next FM3 session).
//
// JOIN RULE: by (family, SYMBOL) — NEVER by paramId across devices (cookbook
// negative gen3-paramid-reuse-across-model-bytes). A row exists iff the FM3
// catalog has the symbol in the same family AND at least one sibling source
// classifies it discrete AND no existing FM3 enum path already routes it
// discrete. maxOrdinal = the LARGEST sibling bound (FM9 cache enumCount-1 /
// FM9 roundtrip / III roundtrip): an under-bound would refuse valid FM3
// ordinals; devices clamp over-range ordinals to their own max. Provenance
// per row: 'fm9-cache-family-join' (FM9 editor-cache kind:'enum' row exists)
// or 'sibling-roundtrip-family-join' (FM9/III hardware roundtrip only).
//
// These params are routed DISCRETE (float32(ordinal), sub 09 00) instead of
// CONTINUOUS — the wire builder is unchanged; only the catalog
// kind-classification differs, so the gen-3 byte-identity anchor stays
// intact (III and FM9 classification data is untouched by this overlay).
/* eslint-disable */

/** Per-row evidence source for the family-join overlay. */
export type Fm3FamilyJoinProvenance = 'fm9-cache-family-join' | 'sibling-roundtrip-family-join';

/** FM3 family-join discrete overlay: param firmware symbol -> maxOrdinal (encode bound). */
export const FM3_FAMILY_JOIN_DISCRETE: Readonly<Record<string, number>> = {
${rowLines.join('\n')}
};

/** Provenance per overlay row (which sibling evidence classified it discrete). */
export const FM3_FAMILY_JOIN_PROVENANCE: Readonly<Record<string, Fm3FamilyJoinProvenance>> = {
${provLines.join('\n')}
};
`;

writeFileSync(OUT, out);
console.log(`wrote ${OUT}`);
console.log(`  joined: ${keys.length} FM3 params flip continuous -> discrete`);
console.log(`    from FM9 cache (fm9-cache-family-join):        ${stats.cache}`);
console.log(`    roundtrip-only (sibling-roundtrip-family-join): ${stats.roundtripOnly}`);
console.log(`  skipped: ${stats.alreadyDiscrete} already routed discrete on FM3 (enum vocab present)`);
console.log(`  no sibling evidence (stay continuous): ${stats.noSibling}`);
