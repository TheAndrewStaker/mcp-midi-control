/**
 * Emit `src/protocol/cacheEnums.ts` — the top-level effect-type
 * dictionaries pulled from the parsed cache. These are the dropdown
 * lists AM4-Edit shows for each block's Type selector, in the exact
 * order the firmware enumerates them.
 *
 * Wire index == array index. Pass the index (as float32) to SET_PARAM
 * at the block's Type `pidHigh` — most blocks use id=10 (pidHigh=0x000A),
 * except Compressor (id=19) and GEQ (id=20).
 *
 * Also emit `docs/CACHE-DUMP.md` — human-readable listing of every
 * param record for each mapped block, so the catalog is visible
 * without loading JSON.
 *
 * Run after `npx tsx scripts/parse-cache.ts`:
 *   npx tsx scripts/gen-cache-enums.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CacheRec {
  offset: number;
  block: number;
  id: number;
  typecode: number;
  kind: 'float' | 'enum' | 'blockHeader';
  a?: number; b?: number; c?: number; d?: number;
  values?: string[];
}

// AM4_CACHE_OUT_DIR: read parse-cache.ts output from another folder (one per
// firmware); AM4_ENUMS_OUT: write the .ts somewhere other than the codec.
const DECODED_DIR = process.env.AM4_CACHE_OUT_DIR ?? 'samples/captured/decoded';
const CACHE_FILE_NAME = process.env.AM4_CACHE_FILE ?? 'effectDefinitions_15_2p0.cache';
const s2: CacheRec[] = JSON.parse(readFileSync(join(DECODED_DIR, 'cache-section2.json'), 'utf8'));
const s3: CacheRec[] = JSON.parse(readFileSync(join(DECODED_DIR, 'cache-section3.json'), 'utf8')).records;

interface BlockLoc {
  label: string;
  constName: string;
  section: 'S2' | 'S3';
  block: number;
  recs: CacheRec[];
  pidLow: number;
  /** Type-dropdown record id. Defaults to 10 but Comp/GEQ use 19/20. */
  typeId: number;
}

const BLOCKS: BlockLoc[] = [
  { label: 'Amp',          constName: 'AMP_TYPES',        section: 'S2', block: 5,  recs: s2, pidLow: 0x3a, typeId: 10 },
  { label: 'Drive',        constName: 'DRIVE_TYPES',      section: 'S3', block: 9,  recs: s3, pidLow: 0x76, typeId: 10 },
  { label: 'Reverb',       constName: 'REVERB_TYPES',     section: 'S3', block: 0,  recs: s3, pidLow: 0x42, typeId: 10 },
  { label: 'Delay',        constName: 'DELAY_TYPES',      section: 'S3', block: 1,  recs: s3, pidLow: 0x46, typeId: 10 },
  { label: 'Chorus',       constName: 'CHORUS_TYPES',     section: 'S3', block: 2,  recs: s3, pidLow: 0x4e, typeId: 10 },
  { label: 'Flanger',      constName: 'FLANGER_TYPES',    section: 'S3', block: 3,  recs: s3, pidLow: 0x52, typeId: 10 },
  { label: 'Phaser',       constName: 'PHASER_TYPES',     section: 'S3', block: 5,  recs: s3, pidLow: 0x5a, typeId: 10 },
  { label: 'Wah',          constName: 'WAH_TYPES',        section: 'S3', block: 6,  recs: s3, pidLow: 0x5e, typeId: 10 },
  { label: 'Compressor',   constName: 'COMPRESSOR_TYPES', section: 'S2', block: 2,  recs: s2, pidLow: 0x2e, typeId: 19 },
  { label: 'GEQ',          constName: 'GEQ_TYPES',        section: 'S2', block: 3,  recs: s2, pidLow: 0x32, typeId: 20 },
  { label: 'Filter',       constName: 'FILTER_TYPES',     section: 'S3', block: 8,  recs: s3, pidLow: 0x72, typeId: 10 },
  { label: 'Tremolo',      constName: 'TREMOLO_TYPES',    section: 'S3', block: 7,  recs: s3, pidLow: 0x6a, typeId: 10 },
  { label: 'Enhancer',     constName: 'ENHANCER_TYPES',   section: 'S3', block: 10, recs: s3, pidLow: 0x7a, typeId: 14 },
  { label: 'Gate/Expander',constName: 'GATE_TYPES',       section: 'S3', block: 11, recs: s3, pidLow: 0x92, typeId: 19 },
  { label: 'Volume/Pan',   constName: 'VOLPAN_MODES',     section: 'S3', block: 12, recs: s3, pidLow: 0x66, typeId: 15 },
];

function paramsOf(loc: BlockLoc): CacheRec[] {
  return loc.recs.filter((r) => r.block === loc.block && r.kind !== 'blockHeader').sort((a, b) => a.id - b.id);
}

function typeEnum(loc: BlockLoc): string[] {
  const rec = paramsOf(loc).find((r) => r.id === loc.typeId && r.kind === 'enum');
  if (!rec) throw new Error(`${loc.label}: no enum at id=${loc.typeId}`);
  return rec.values!;
}

/**
 * Tempo division dictionary (79 entries: NONE / 1/64 TRIP / 1/64 / ... /
 * 63/64). Identical across every block that exposes a Tempo Sync knob —
 * captured 14 times in the cache (delay × 6, chorus × 2, reverb / flanger
 * / rotary / phaser / tremolo / filter × 1 each). Source-of-truth here
 * is delay sub-block 1 id=19 (the wire-captured `delay.tempo` register
 * from session-30-delay-basic-digital-mono); cross-checked byte-identical
 * against the chorus + flanger + phaser + tremolo first-tempo records.
 */
function tempoDivisionsEnum(): string[] {
  const rec = s3.find((r) => r.block === 1 && r.id === 19 && r.kind === 'enum');
  if (!rec || !rec.values || rec.values.length !== 79 || rec.values[0] !== 'NONE ') {
    throw new Error('tempoDivisionsEnum: cache no longer has 79-entry tempo enum at delay/id=19');
  }
  return rec.values;
}

/**
 * LFO waveform dictionary (10 entries: SINE / TRIANGLE / ... / ASTABLE).
 * Identical across every modulation block that exposes a Waveform/LFO Type
 * knob — captured 4 times in the cache (chorus id=18, flanger id=18, phaser
 * id=13, tremolo id=11). Source-of-truth here is chorus sub-block 2 id=18;
 * cross-checked byte-identical against the other three.
 */
function lfoWaveformsEnum(): string[] {
  const rec = s3.find((r) => r.block === 2 && r.id === 18 && r.kind === 'enum');
  if (!rec || !rec.values || rec.values.length !== 10 || rec.values[0] !== 'SINE') {
    throw new Error('lfoWaveformsEnum: cache no longer has 10-entry waveform enum at chorus/id=18');
  }
  return rec.values;
}

// -- cacheEnums.ts --

function formatTsArray(name: string, values: string[]): string {
  const escaped = values.map((v) => JSON.stringify(v));
  return `export const ${name}: readonly string[] = [\n  ${escaped.join(',\n  ')},\n] as const;`;
}

function toEnumValuesObject(varName: string, values: string[]): string {
  // Emit `Object.fromEntries(values.map((s, i) => [i, s]))` style so
  // params.ts can import one array and use it as `enumValues`.
  return `export const ${varName}: Record<number, string> = Object.fromEntries(${varName.replace(/_VALUES$/, '')}.map((s, i) => [i, s] as const));`;
}

const header = `/**
 * Generated by scripts/gen-cache-enums.ts — do not hand-edit.
 *
 * Source: AM4-Edit metadata cache (${CACHE_FILE_NAME}),
 * parsed by scripts/parse-cache.ts, verified against wire captures
 * by scripts/map-cache-params.ts.
 *
 * Each array lists the firmware's effect-type dictionary in wire
 * order. The wire value sent in SET_PARAM (at pidHigh=0x000A of the
 * block's pidLow) is the integer index encoded as a float32.
 */
`;

const arrays = BLOCKS.map((b) => formatTsArray(b.constName, typeEnum(b))).join('\n\n');
const mapsSection = BLOCKS.map((b) => toEnumValuesObject(`${b.constName}_VALUES`, typeEnum(b))).join('\n');

// Shared non-Type enums — extracted from the cache, used by per-block
// non-Type registrations (tempo, etc.) where a block's `enumImport` would
// otherwise mis-target the block's TYPES_VALUES.
const tempoDivisions = tempoDivisionsEnum();
const lfoWaveforms = lfoWaveformsEnum();
const sharedArrays = [
  formatTsArray('TEMPO_DIVISIONS', tempoDivisions),
  formatTsArray('LFO_WAVEFORMS', lfoWaveforms),
].join('\n\n');
const sharedMaps = [
  toEnumValuesObject('TEMPO_DIVISIONS_VALUES', tempoDivisions),
  toEnumValuesObject('LFO_WAVEFORMS_VALUES', lfoWaveforms),
].join('\n');

const ts = `${header}\n${arrays}\n\n${sharedArrays}\n\n${mapsSection}\n${sharedMaps}\n`;
const outPath = process.env.AM4_ENUMS_OUT ?? 'packages/fractal-midi/src/am4/cacheEnums.ts';
writeFileSync(outPath, ts);
console.log(`wrote ${outPath}`);
for (const b of BLOCKS) {
  console.log(`  ${b.constName}: ${typeEnum(b).length} entries`);
}
console.log(`  TEMPO_DIVISIONS: ${tempoDivisions.length} entries`);
console.log(`  LFO_WAVEFORMS: ${lfoWaveforms.length} entries`);

// -- docs/CACHE-DUMP.md --

function describeRec(r: CacheRec): string {
  if (r.kind === 'enum') {
    const preview = r.values!.length <= 6
      ? r.values!.map((v) => `\`${v}\``).join(', ')
      : `\`${r.values![0]}\`, \`${r.values![1]}\`, …, \`${r.values![r.values!.length - 1]}\` *(${r.values!.length} total)*`;
    return `enum × ${r.values!.length} — ${preview}`;
  }
  return `float — min=${r.a}, max=${r.b}, display-scale=${r.c}, step=${r.d}`;
}

const md: string[] = [];
md.push('# Cache Dump — mapped blocks');
md.push('');
md.push('Human-readable view of every parameter record in the 4 main effect');
md.push('blocks, extracted from AM4-Edit\'s metadata cache. Generated by');
md.push('`scripts/gen-cache-enums.ts` — do not hand-edit. Regenerate after');
md.push('any change to the cache by running:');
md.push('');
md.push('```');
md.push('npx tsx scripts/parse-cache.ts');
md.push('npx tsx scripts/gen-cache-enums.ts');
md.push('```');
md.push('');
md.push('**Wire protocol:** cache record `id` == wire `pidHigh`. The block\'s');
md.push('`pidLow` is in the section header below. Send SET_PARAM with');
md.push('`(pidLow, pidHigh=id)` and the value encoded per the unit convention');
md.push('in `src/protocol/params.ts`. Type-dropdown id is 10 for most blocks');
md.push('except Compressor (id=19) and GEQ (id=20).');
md.push('');
md.push('Parameter *names* are not in the cache — only IDs. Entries whose');
md.push('name is known via wire capture are tagged in `params.ts`. Everything');
md.push('else here is "cache-derived, unnamed" and needs either an AM4-Edit');
md.push('capture or a manual review to label.');
md.push('');

for (const b of BLOCKS) {
  const recs = paramsOf(b);
  const enums = recs.filter((r) => r.kind === 'enum').length;
  const floats = recs.filter((r) => r.kind === 'float').length;
  md.push(`## ${b.label} — pidLow = 0x${b.pidLow.toString(16).padStart(2, '0')}`);
  md.push('');
  md.push(`Cache location: ${b.section} block ${b.block}. ${recs.length} records (${enums} enums, ${floats} floats).`);
  md.push('');
  md.push('| pidHigh | kind | details |');
  md.push('|--------:|------|---------|');
  for (const r of recs) {
    md.push(`| \`0x${r.id.toString(16).padStart(4, '0')}\` | ${r.kind} | ${describeRec(r)} |`);
  }
  md.push('');
}

// The dump is a research listing (it no longer lives in docs/); write it next
// to the parsed JSON it lists.
const mdPath = join(DECODED_DIR, 'CACHE-DUMP.md');
writeFileSync(mdPath, md.join('\n'));
console.log(`wrote ${mdPath}`);
