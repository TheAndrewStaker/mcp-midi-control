/**
 * Generate a gen-3 device's `enumNames.generated.ts`: the device-true enum
 * NAME table (param symbol -> ordinal -> label) for every enum parameter in
 * that device's own editor `effectDefinitions_*.cache`, read from the strict
 * cache walk JSON (scripts/_research/parse-effectdefinitions-cache.ts).
 *
 * Why: the III and FM9 catalogs took their enum names from family-shared
 * overlays (several AM4-inferred), so a number of selectors named the wrong
 * ordinal (every gen-3 LFO type from ordinal 6: "Log" sent EXP; delay.model
 * from 22: "Pan Delay" sent Zephyr; PITCH_TEMPO off by one; inputselect
 * reordered) and ~350-390 selectors had no names at all. The FM3 already ships
 * the same kind of table from its own cache. Issue #13 (III cache).
 *
 * Join: catalog param (family, paramId) -> <DEVICE>_RANGE_SECTIONS[family]
 * .sectionTag -> cache record (tag, id). The same join the shipped
 * ranges.generated.ts uses (validated by verify-<device>-ranges); never
 * positional. Name tables (ids >= 0xff00) are skipped: they have no param.
 *
 * Spelling: the cache's group prefix ("Room: Small Room") and trailing pad
 * spaces are dropped. Where the currently shipped label for the same ordinal
 * names the same model (case / word-order / a subset of its words, e.g.
 * shipped "Asylum Hall" vs cache "Asylum"), the shipped spelling is KEPT so
 * existing set-by-name strings keep working. Re-running is idempotent.
 *
 * Usage:
 *   npx tsx scripts/gen-gen3-enum-names-from-cache.ts <iii|fm3|fm9> [walk.json]
 * Run it against the descriptor WITHOUT this file wired in (the "shipped"
 * spellings it keeps must be the pre-existing ones; with it wired the run is
 * idempotent anyway). Then `npm run build` and `npm run catalog:export`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { FM3_PARAMS } from '../packages/fractal-midi/src/gen3/fm3/params.js';
import { FM3_RANGE_SECTIONS } from '../packages/fractal-midi/src/gen3/fm3/ranges.generated.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';
import { PARAMS } from '../packages/fractal-midi/src/gen3/axe-fx-iii/params.js';
import { III_RANGE_SECTIONS } from '../packages/fractal-midi/src/gen3/axe-fx-iii/ranges.generated.js';
import { FM9_PARAMS } from '../packages/fractal-midi/src/gen3/fm9/params.js';
import { FM9_RANGE_SECTIONS } from '../packages/fractal-midi/src/gen3/fm9/ranges.generated.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
type ParamLike = { family: string; paramId: number; name: string };
interface DeviceCfg {
  desc: DeviceDescriptor;
  params: readonly ParamLike[];
  sections: Readonly<Record<string, { sectionTag: number }>>;
  walk: string;
  out: string;
  constName: string;
  label: string;
}
const DEVICES: Record<string, DeviceCfg> = {
  iii: {
    desc: AXEFX3_DESCRIPTOR,
    params: Object.values(PARAMS) as ParamLike[],
    sections: III_RANGE_SECTIONS,
    walk: 'samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.walk.json',
    out: 'packages/fractal-midi/src/gen3/axe-fx-iii/enumNames.generated.ts',
    constName: 'III_CACHE_ENUM_NAMES',
    label: 'Axe-Fx III (Axe-Edit III cache, fw 32.06, community donation issue #13)',
  },
  fm3: {
    desc: FM3_DESCRIPTOR,
    params: FM3_PARAMS as readonly ParamLike[],
    sections: FM3_RANGE_SECTIONS,
    walk: 'samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.walk.json',
    out: 'packages/fractal-midi/src/gen3/fm3/enumNames.generated.ts',
    constName: 'FM3_CACHE_ENUM_NAMES',
    label: 'FM3 (FM3-Edit cache, fw 12.0, community donation issue #8)',
  },
  fm9: {
    desc: FM9_DESCRIPTOR,
    params: FM9_PARAMS as readonly ParamLike[],
    sections: FM9_RANGE_SECTIONS,
    walk: 'samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json',
    out: 'packages/fractal-midi/src/gen3/fm9/enumNames.generated.ts',
    constName: 'FM9_CACHE_ENUM_NAMES',
    label: 'FM9 (FM9-Edit cache, fw 12.0, community donation)',
  },
};

const [devKey, walkArg] = process.argv.slice(2);
const dev = devKey !== undefined ? DEVICES[devKey] : undefined;
if (dev === undefined) {
  console.error('usage: gen-gen3-enum-names-from-cache.ts <iii|fm9> [walk.json]');
  process.exit(2);
}
const walkPath = resolve(root, walkArg ?? dev.walk);

interface WalkRecord { kind: 'enum' | 'float'; section: number; id: number; values?: string[] }
const walk = JSON.parse(readFileSync(walkPath, 'utf8')) as { records: WalkRecord[] };
const cache = new Map<string, WalkRecord>();
for (const r of walk.records) cache.set(`${r.section}:${r.id}`, r);

// Shipped labels by symbol (the spelling to keep where it names the same model).
const shippedBySymbol = new Map<string, Readonly<Record<number, string>>>();
for (const block of Object.values(dev.desc.blocks)) {
  for (const schema of Object.values(block.params)) {
    const s = schema as { parameter_name?: string; enum_values?: Record<number, string> };
    if (s.parameter_name !== undefined && s.enum_values !== undefined && !shippedBySymbol.has(s.parameter_name)) {
      shippedBySymbol.set(s.parameter_name, s.enum_values);
    }
  }
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9+#./-]+/).filter((w) => w !== '');
const sameModel = (shipped: string, cacheName: string): boolean => {
  const a = words(shipped), b = words(cacheName);
  if (b.length === 0) return false;
  if (a.join(' ') === b.join(' ')) return true;
  const as = new Set(a);
  if (b.every((w) => as.has(w))) return true; // cache words are a subset of the shipped spelling
  return a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');
};
const GROUP = /^[^:]{1,24}:\s+/;

const out: Record<string, Record<number, string>> = {};
let params = 0, kept = 0, fromCache = 0, changedOrdinals = 0, newlyNamed = 0;
const seen = new Set<string>();
for (const p of dev.params) {
  if (seen.has(p.name)) continue;
  seen.add(p.name);
  const tag = dev.sections[p.family]?.sectionTag;
  if (tag === undefined || p.paramId >= 0xff00) continue;
  const rec = cache.get(`${tag}:${p.paramId}`);
  if (rec === undefined || rec.kind !== 'enum' || rec.values === undefined || rec.values.length === 0) continue;
  const raw = rec.values.map((v) => v.replace(/\s+$/u, ''));
  if (raw.every((v) => v === '')) continue;
  const grouped = raw.filter((v) => GROUP.test(v)).length * 2 >= raw.length;
  const shipped = shippedBySymbol.get(p.name);
  // A list that already ships mixed-case names ("Sine", "Triangle") takes its
  // new cache labels title-cased too ("TRAPEZOID" -> "Trapezoid"), so one list
  // never mixes styles. A list with no shipped names keeps the device's casing.
  const mixedCase = shipped !== undefined && Object.values(shipped).some((s) => /[a-z]/.test(s));
  // Only a label that is ENTIRELY upper case is recased; a label that already
  // has lower case ("PVH 6160 Block Clean", "Brit JVM") keeps its acronyms.
  const titleCase = (s: string): string =>
    /[a-z]/.test(s) ? s : s.replace(/\b([A-Z])([A-Z]{2,})\b/g, (_m, a: string, b: string) => a + b.toLowerCase());
  const table: Record<number, string> = {};
  raw.forEach((v, i) => {
    const stripped = grouped ? v.replace(GROUP, '') : v;
    const cacheName = mixedCase ? titleCase(stripped) : stripped;
    const s = shipped?.[i];
    // The subset rule must not keep a shipped label that is exactly ANOTHER
    // entry of this list: shipped "1/64 Trip" at the ordinal the device calls
    // "1/64" is a shifted list, not a respelling (PITCH_TEMPO).
    const isOtherEntry = s !== undefined && raw.some((o, j) => j !== i && words(grouped ? o.replace(GROUP, '') : o).join(' ') === words(s).join(' '));
    if (s !== undefined && !isOtherEntry && sameModel(s, cacheName)) { table[i] = s; kept++; return; }
    table[i] = cacheName;
    fromCache++;
    if (s !== undefined) changedOrdinals++;
  });
  if (shipped === undefined) newlyNamed++;
  out[p.name] = table;
  params++;
}

const body =
  `// GENERATED by scripts/gen-gen3-enum-names-from-cache.ts. DO NOT EDIT BY HAND.\n` +
  `// Source: ${dev.label}.\n` +
  `// Device-true enum names: param symbol -> ordinal -> label (the ordinal IS the\n` +
  `// discrete-SET value). Joined by (family, paramId) through the device's own\n` +
  `// range sections. ${params} params, ${newlyNamed} newly named, ${changedOrdinals} ordinals corrected.\n` +
  `/* eslint-disable */\n\n` +
  `export const ${dev.constName}: Readonly<Record<string, Readonly<Record<number, string>>>> = ${JSON.stringify(out, null, 2)};\n`;
writeFileSync(resolve(root, dev.out), body);
console.log(`[${devKey}] walk ${walkPath}`);
console.log(`[${devKey}] ${params} enum params; ${newlyNamed} had no names; labels kept=${kept} fromCache=${fromCache} (corrected ordinals=${changedOrdinals}) -> ${dev.out}`);
