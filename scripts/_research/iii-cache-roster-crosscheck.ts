/**
 * iii-cache-roster-crosscheck.ts (gen-3 cache roster cross-check)
 *
 * Compare the enum NAME rosters in a gen-3 editor cache walk against the names
 * the shipped descriptor offers (`enum_values` on each param schema). Answers
 * "what does a device-synced cache tell us that the catalog does not yet say?"
 * (issue #13 for the III; works for the FM3 and FM9 too).
 *
 * Join: descriptor param -> parameter_name -> codec params (family, paramId)
 * -> <DEVICE>_RANGE_SECTIONS[family].sectionTag -> cache record (tag, id).
 * Never a positional join. Group prefixes ("Room: Small Room") and case are
 * reported separately from real ordinal disagreements.
 *
 * Usage:
 *   npx tsx scripts/_research/iii-cache-roster-crosscheck.ts [iii|fm3|fm9] [walk.json] [-v]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';
import { PARAMS } from '../../packages/fractal-midi/src/gen3/axe-fx-iii/params.js';
import { III_RANGE_SECTIONS } from '../../packages/fractal-midi/src/gen3/axe-fx-iii/ranges.generated.js';
import { FM3_PARAMS } from '../../packages/fractal-midi/src/gen3/fm3/params.js';
import { FM3_RANGE_SECTIONS } from '../../packages/fractal-midi/src/gen3/fm3/ranges.generated.js';
import { FM9_PARAMS } from '../../packages/fractal-midi/src/gen3/fm9/params.js';
import { FM9_RANGE_SECTIONS } from '../../packages/fractal-midi/src/gen3/fm9/ranges.generated.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
type ParamLike = { family: string; paramId: number; name: string };
const DEVICES: Record<string, { desc: DeviceDescriptor; params: readonly ParamLike[]; sections: Readonly<Record<string, { sectionTag: number }>>; walk: string }> = {
  iii: { desc: AXEFX3_DESCRIPTOR, params: Object.values(PARAMS) as ParamLike[], sections: III_RANGE_SECTIONS, walk: 'samples/captured/axefx3-community-2026-07-02/effectDefinitions_10_32p6.walk.json' },
  fm3: { desc: FM3_DESCRIPTOR, params: FM3_PARAMS as readonly ParamLike[], sections: FM3_RANGE_SECTIONS, walk: 'samples/captured/fm3-community-2026-06-27/effectDefinitions_11_12p0.walk.json' },
  fm9: { desc: FM9_DESCRIPTOR, params: FM9_PARAMS as readonly ParamLike[], sections: FM9_RANGE_SECTIONS, walk: 'samples/captured/fm9-community-2026-07-18/effectDefinitions_12_12p0.walk.json' },
};

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const pos = args.filter((a) => !a.startsWith('-'));
const devKey = pos[0] && DEVICES[pos[0]] ? pos.shift()! : 'iii';
const dev = DEVICES[devKey];
const walkPath = resolve(root, pos[0] ?? dev.walk);

interface WalkRecord { kind: 'enum' | 'float'; section: number; id: number; values?: string[] }
const walk = JSON.parse(readFileSync(walkPath, 'utf8')) as { records: WalkRecord[] };
const cache = new Map<string, WalkRecord>();
for (const r of walk.records) cache.set(`${r.section}:${r.id}`, r);
const bySymbol = new Map<string, ParamLike>();
for (const p of dev.params) bySymbol.set(p.name, p);

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
const stripGroup = (s: string): string => s.replace(/^[^:]{1,24}:\s+/, '');

let compared = 0, identical = 0, cosmetic = 0, differing = 0, shippedNone = 0;
const rows: string[] = [];
const seen = new Set<string>();
for (const [blockSlug, block] of Object.entries(dev.desc.blocks)) {
  for (const [key, schema] of Object.entries(block.params)) {
    const sym = (schema as { parameter_name?: string }).parameter_name;
    if (sym === undefined || seen.has(sym)) continue;
    seen.add(sym);
    const loc = bySymbol.get(sym);
    if (!loc) continue;
    const tag = dev.sections[loc.family]?.sectionTag;
    if (tag === undefined) continue;
    const rec = cache.get(`${tag}:${loc.paramId}`);
    if (!rec || rec.kind !== 'enum' || !rec.values) continue;
    const names = rec.values;
    const shipped = (schema as { enum_values?: Record<number, string> }).enum_values;
    if (shipped === undefined || Object.keys(shipped).length === 0) {
      shippedNone++;
      if (verbose) rows.push(`NO-NAMES  ${blockSlug}.${key} (${sym}) cache has ${names.length}: ${JSON.stringify(names.slice(0, 4))}`);
      continue;
    }
    compared++;
    let exact = 0, cos = 0, diff = 0, missing = 0;
    const diffs: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const s = shipped[i];
      if (s === undefined) { missing++; continue; }
      if (s === names[i]) exact++;
      else if (norm(s) === norm(names[i]) || norm(s) === norm(stripGroup(names[i]))) cos++;
      else { diff++; if (diffs.length < 4) diffs.push(`[${i}] ship "${s}" cache "${names[i]}"`); }
    }
    const extra = Object.keys(shipped).map(Number).filter((n) => n >= names.length).length;
    if (diff === 0 && missing === 0 && extra === 0) { if (cos === 0) identical++; else cosmetic++; continue; }
    differing++;
    rows.push(`DIFF      ${blockSlug}.${key} (${sym}) n=${names.length} exact=${exact} cosmetic=${cos} diff=${diff} missing=${missing} extra=${extra} ${diffs.join('; ')}`);
  }
}
console.log(`[${devKey}] walk: ${walkPath}`);
console.log(`enum params with a cache roster: compared=${compared} identical=${identical} cosmeticOnly=${cosmetic} differing=${differing} shippedWithoutNames=${shippedNone}`);
for (const r of rows) console.log('  ' + r);
