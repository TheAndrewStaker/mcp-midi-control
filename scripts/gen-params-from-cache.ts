/**
 * Emit `src/protocol/cacheParams.ts` — bulk parameter registry
 * harvested from AM4-Edit's metadata cache.
 *
 * Session-A deliverable of P1-010 (see docs/04-BACKLOG.md). Walks each
 * CONFIRMED cache block (per `docs/CACHE-BLOCKS.md`), looks up every
 * record's `id` in `src/protocol/paramNames.ts`, and emits a
 * `KNOWN_PARAMS`-shape entry per surviving record. Records without a
 * name in `paramNames.ts` are skipped — they stay dormant until a
 * human assigns them a UI label (Session B).
 *
 * Filtering rules:
 *   - Skip `blockHeader` records (not params).
 *   - Skip blocks without a confirmed wire `pidLow` (CACHE-BLOCKS.md).
 *   - Skip scene-routing / scene-snapshot sub-blocks (S3 15/16) and
 *     controller/modifier blocks (S2 0, 1, 4, 6, and S3 13, 14) —
 *     they don't address user-facing knobs.
 *   - Skip floats with `a === b` (degenerate range — no addressable
 *     value).
 *
 * Unit inference from the cache `c` (display-scale) field:
 *   - enum          → unit='enum', enumValues from cacheEnums
 *   - c=10          → unit='knob_0_10', display 0..10
 *   - c=100         → unit='percent', display 0..100
 *   - c=1000        → unit='ms', display = a*c..b*c
 *   - c=1           → unit='db' (caller verifies via paramNames
 *                     whether this is really a dB knob vs a raw number)
 *   - other         → flagged; generator emits a warning and skips
 *
 * Run after `npx tsx scripts/parse-cache.ts`:
 *   npx tsx scripts/gen-params-from-cache.ts
 *
 * Verification (preflight):
 *   npx tsx scripts/verify-cache-params.ts
 *   — compares cacheParams against KNOWN_PARAMS for known-name entries
 *     and fails if they diverge (address, unit, or range).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAM_NAMES, type ParamNameEntry } from 'fractal-midi/am4';
import { GENERATED_PARAM_NAMES } from 'fractal-midi/am4';
import type { Unit } from 'fractal-midi/am4';

// cacheParams.ts now lives in the sibling `fractal-midi` repo (Phase B
// extraction, 2026-05-18). This is a maintainer-only regen script — it
// edits source files in `fractal-midi/`, so it can't use
// `require.resolve('fractal-midi/am4')` (that resolves to the built
// dist). Assumes the sibling-repo layout `C:/dev/{mcp-midi-tools,
// fractal-midi}` documented in `docs/research/fractal-midi-extraction-plan.md`.
const _scriptDir = dirname(fileURLToPath(import.meta.url));
const FRACTAL_MIDI_REPO = resolve(_scriptDir, '..', '..', 'fractal-midi');
const CACHE_PARAMS_OUT = join(FRACTAL_MIDI_REPO, 'src', 'am4', 'cacheParams.ts');

if (!existsSync(FRACTAL_MIDI_REPO)) {
    console.error(
        `gen-params-from-cache: sibling fractal-midi repo not found at ${FRACTAL_MIDI_REPO}.\n` +
        `Clone fractal-midi next to mcp-midi-tools to run this regen script.`,
    );
    process.exit(1);
}

/**
 * Merge hand-curated `paramNames.ts` with the resolver-derived
 * `paramNamesGenerated.ts`. Resolver entries are firmware-truth (sourced
 * from AM4-Edit.exe's per-variant dispatcher) so they win on (block,
 * cache_id) conflicts; the generator scopes itself to the diff's MISSING
 * set so today there is no actual overlap. Hand-curated names are
 * authoritative for cache_ids the resolver does not reach (out-of-band
 * registers, hand-tuned unit overrides where the cache signature is
 * ambiguous, etc.) — those carry through unchanged. Spread order makes
 * generated entries lose to a hand entry at the SAME (block, cache_id);
 * if a future regen adds an overlap that needs resolution, flip the
 * order or add a per-block override list.
 */
const MERGED_PARAM_NAMES: Readonly<Record<string, Readonly<Record<number, ParamNameEntry>>>> = (() => {
  const out: Record<string, Record<number, ParamNameEntry>> = {};
  for (const [block, entries] of Object.entries(GENERATED_PARAM_NAMES)) {
    out[block] = { ...entries };
  }
  for (const [block, entries] of Object.entries(PARAM_NAMES)) {
    out[block] = { ...(out[block] ?? {}), ...entries };
  }
  return out;
})();

/**
 * Normalize a PARAM_NAMES entry to `{ name, unit?, displayMin?,
 * displayMax? }`. String form is sugar for `{ name }` with inference
 * doing the rest.
 */
function resolveEntry(entry: ParamNameEntry): {
  name: string;
  unitOverride?: Unit;
  displayMinOverride?: number;
  displayMaxOverride?: number;
} {
  if (typeof entry === 'string') return { name: entry };
  return {
    name: entry.name,
    unitOverride: entry.unit,
    displayMinOverride: entry.displayMin,
    displayMaxOverride: entry.displayMax,
  };
}

interface CacheRec {
  offset: number;
  block: number;
  id: number;
  typecode?: number;
  kind: 'float' | 'enum' | 'blockHeader';
  a?: number; b?: number; c?: number; d?: number;
  values?: string[];
}

const DECODED_DIR = 'samples/captured/decoded';
const s2: CacheRec[] = JSON.parse(readFileSync(join(DECODED_DIR, 'cache-section2.json'), 'utf8'));
const s3: CacheRec[] = JSON.parse(readFileSync(join(DECODED_DIR, 'cache-section3.json'), 'utf8')).records;

/**
 * The block catalog below mirrors `docs/CACHE-BLOCKS.md`. Only
 * CONFIRMED blocks are included — tentative ones (controllers,
 * scene routing, etc.) are deliberately excluded. When a new block
 * is promoted to CONFIRMED, add it here + in CACHE-BLOCKS.md.
 *
 * `enumImport` names the exported `*_VALUES` map in `cacheEnums.ts`
 * for the block's Type/Mode enum record. It's referenced by the
 * generated file as an import; keeps the generator output agnostic
 * to the concrete enum list.
 */
interface BlockSpec {
  blockName: string;   // matches PARAM_NAMES key + Param.block
  pidLow: number;
  section: 'S2' | 'S3';
  cacheBlock: number;
  enumImport?: string; // e.g. 'AMP_TYPES_VALUES'
}

const BLOCKS: BlockSpec[] = [
  { blockName: 'amp',        pidLow: 0x003a, section: 'S2', cacheBlock: 5,  enumImport: 'AMP_TYPES_VALUES' },
  { blockName: 'drive',      pidLow: 0x0076, section: 'S3', cacheBlock: 9,  enumImport: 'DRIVE_TYPES_VALUES' },
  { blockName: 'reverb',     pidLow: 0x0042, section: 'S3', cacheBlock: 0,  enumImport: 'REVERB_TYPES_VALUES' },
  { blockName: 'delay',      pidLow: 0x0046, section: 'S3', cacheBlock: 1,  enumImport: 'DELAY_TYPES_VALUES' },
  { blockName: 'chorus',     pidLow: 0x004e, section: 'S3', cacheBlock: 2,  enumImport: 'CHORUS_TYPES_VALUES' },
  { blockName: 'flanger',    pidLow: 0x0052, section: 'S3', cacheBlock: 3,  enumImport: 'FLANGER_TYPES_VALUES' },
  { blockName: 'phaser',     pidLow: 0x005a, section: 'S3', cacheBlock: 5,  enumImport: 'PHASER_TYPES_VALUES' },
  { blockName: 'wah',        pidLow: 0x005e, section: 'S3', cacheBlock: 6,  enumImport: 'WAH_TYPES_VALUES' },
  { blockName: 'compressor', pidLow: 0x002e, section: 'S2', cacheBlock: 2,  enumImport: 'COMPRESSOR_TYPES_VALUES' },
  { blockName: 'geq',        pidLow: 0x0032, section: 'S2', cacheBlock: 3,  enumImport: 'GEQ_TYPES_VALUES' },
  { blockName: 'filter',     pidLow: 0x0072, section: 'S3', cacheBlock: 8,  enumImport: 'FILTER_TYPES_VALUES' },
  { blockName: 'tremolo',    pidLow: 0x006a, section: 'S3', cacheBlock: 7,  enumImport: 'TREMOLO_TYPES_VALUES' },
  { blockName: 'enhancer',   pidLow: 0x007a, section: 'S3', cacheBlock: 10, enumImport: 'ENHANCER_TYPES_VALUES' },
  { blockName: 'gate',       pidLow: 0x0092, section: 'S3', cacheBlock: 11, enumImport: 'GATE_TYPES_VALUES' },
  { blockName: 'volpan',     pidLow: 0x0066, section: 'S3', cacheBlock: 12, enumImport: 'VOLPAN_MODES_VALUES' },
  // HW-040 (Session 36, 2026-04-29): PEQ (parametric EQ) and Rotary
  // — neither has a Type enum at id=10. enumImport omitted; non-Type
  // enums are hand-authored in params.ts as usual.
  { blockName: 'peq',        pidLow: 0x0036, section: 'S2', cacheBlock: 4 },
  { blockName: 'rotary',     pidLow: 0x0056, section: 'S3', cacheBlock: 4 },
];

function recsFor(spec: BlockSpec): CacheRec[] {
  const src = spec.section === 'S2' ? s2 : s3;
  return src.filter((r) => r.block === spec.cacheBlock && r.kind !== 'blockHeader').sort((a, b) => a.id - b.id);
}

interface InferredParam {
  unit: Unit;
  displayMin: number;
  displayMax: number;
  enumImport?: string;
}

/**
 * Infer display scale from the cache's (a, b, c) triple. Returns
 * `undefined` for records whose scale doesn't fit our known unit
 * families — the generator skips those and reports them. The paramNames
 * object-form can override `unit` / `displayMin` / `displayMax` when
 * cache signature is ambiguous (most commonly c=1, which structurally
 * can be dB, Hz, seconds, semitones, or raw count).
 */
function inferUnit(rec: CacheRec, spec: BlockSpec): InferredParam | undefined {
  if (rec.kind === 'enum') {
    const count = rec.values?.length ?? 0;
    if (!count) return undefined;
    return {
      unit: 'enum',
      displayMin: 0,
      displayMax: count - 1,
      enumImport: spec.enumImport,
    };
  }
  const { a = 0, b = 0, c = 0 } = rec;
  if (a === b) return undefined;
  switch (c) {
    case 10:
      return { unit: 'knob_0_10', displayMin: 0, displayMax: 10 };
    case 100:
      return { unit: 'percent', displayMin: 0, displayMax: 100 };
    case 1000:
      // delay.time semantics: display = internal * 1000, range 0..b*1000 ms.
      // Lower bound floored at 0 — cache min for delay.time is 0.001 (1 ms)
      // but the hand-authored KNOWN_PARAMS allows 0; be permissive.
      return { unit: 'ms', displayMin: 0, displayMax: Math.round(b * 1000) };
    case 1:
      // Raw 1:1 scale — default to dB. Ambiguous (could be Hz, seconds,
      // semitones, or raw count); caller can override via the paramNames
      // object-form `{ name, unit: 'hz' }` etc.
      return { unit: 'db', displayMin: a, displayMax: b };
    default:
      return undefined;
  }
}

interface GeneratedEntry {
  key: string;
  blockName: string;
  paramName: string;
  pidLow: number;
  pidHigh: number;
  unit: Unit;
  displayMin: number;
  displayMax: number;
  scaling?: 'linear' | 'log10';
  enumImport?: string;
}

/**
 * Map cache `typecode` → scaling kind for the `decode()` rule (BK-038).
 * The AM4 stores all params as a normalized [0,1] internal float over
 * each param's display range; some params use linear normalization,
 * others use log10. The cache record's `typecode` field encodes which.
 *
 * Verified empirically from the Sultans-of-Swing iconic-tone test
 * (Session 43 cont, 2026-05-01):
 *   - typecode 0  → linear (knob_0_10)
 *   - typecode 51 → linear (reverb.time, multi-decade seconds)
 *   - typecode 64 → log10  (compressor.ratio)
 *   - typecode 68 → log10  (compressor.attack / release, multi-decade ms)
 *   - typecode 97 → linear (compressor.threshold, dB)
 *
 * Other typecodes (53, 66, 117, 144, 208, 224, etc.) seen in the cache
 * but unverified — defaulted to linear since linear is the safer bet
 * for short-range params and the read decode falls back to linear when
 * displayMin <= 0 anyway. Confirm and add to LOG10_TYPECODES as
 * empirical data lands.
 */
const LOG10_TYPECODES: ReadonlySet<number> = new Set([
  64,
  68,
  // typecode 72 added 2026-05-04 (HW-053b cont — Friedman BE-100 test).
  // amp.bright_cap (CABINET_BRIGHT, block=5 id=20, c=1000000 a=1e-5
  // b=0.01 → display range 10..10000 pF) uses this typecode. Hardware
  // confirmed log10 storage: write 220 → AM4 displays 220.0 pF ✓ but
  // a linear readback gave 4480 pF; (4480-10)/9990 = 0.4475 matches
  // log10 Q15 = log10(220/10)/log10(10000/10) = 0.4477.
  72,
  // typecode 80 added 2026-05-04 (HW-053 cont). reverb.dwell
  // (REVERB_DRIVE, block=0 id=36, c=10 a=0.01 b=1) and filter.sensitivity
  // (FILTER_SENS, block=8 id=33, c=10 a=0.1 b=40) both use this typecode
  // and the founder's HW-053 spotcheck observed compressed log curves
  // on both: dwell wrote 1→5.00, 5→8.49, 9→9.77; sensitivity wrote 7
  // and the display moved DOWN from 5.00 to 3.25 (linear encoder + log
  // firmware decode = inverse-mapped curve). Treating typecode 80 as
  // log10 corrects both. For filter.sensitivity to actually fire log10
  // at the runtime, the displayMin must be > 0 — see the paramNames.ts
  // override that sets displayMin=0.1 for filter id=33.
  80,
]);

function inferScaling(typecode: number): 'linear' | 'log10' {
  return LOG10_TYPECODES.has(typecode) ? 'log10' : 'linear';
}

function generate(): { entries: GeneratedEntry[]; usedEnums: Set<string>; warnings: string[] } {
  const entries: GeneratedEntry[] = [];
  const usedEnums = new Set<string>();
  const warnings: string[] = [];
  for (const spec of BLOCKS) {
    const names = MERGED_PARAM_NAMES[spec.blockName] ?? {};
    const recs = recsFor(spec);
    for (const rec of recs) {
      const rawEntry = names[rec.id];
      if (!rawEntry) continue;
      const { name: paramName, unitOverride, displayMinOverride, displayMaxOverride } = resolveEntry(rawEntry);
      const inferred = inferUnit(rec, spec);
      // When paramNames provides a full override (unit + both bounds),
      // skip the cache inference requirement — the caller is stating
      // authoritatively how the param should be shaped. Phaser.feedback
      // is the canonical case: cache c=111.1 doesn't fit any default
      // bucket, but we know from wire captures + Blocks Guide that the
      // knob is bipolar_percent ±90.
      const hasFullOverride =
        unitOverride !== undefined &&
        displayMinOverride !== undefined &&
        displayMaxOverride !== undefined;
      if (!inferred && !hasFullOverride) {
        warnings.push(
          `${spec.blockName}.${paramName} (id=${rec.id}): unable to infer unit ` +
          `(kind=${rec.kind}, a=${rec.a}, b=${rec.b}, c=${rec.c}) — skipped`,
        );
        continue;
      }
      const unit = unitOverride ?? inferred!.unit;
      const displayMin = displayMinOverride ?? inferred!.displayMin;
      const displayMax = displayMaxOverride ?? inferred!.displayMax;
      if (inferred?.enumImport) usedEnums.add(inferred.enumImport);
      // Infer scaling from cache typecode. Default linear for unknown
      // typecodes / non-float records; only emit `scaling` when log10
      // (linear is the default in the runtime decode, so omitting it
      // keeps the generated file compact).
      const scaling = rec.kind === 'float' && rec.typecode !== undefined
        ? inferScaling(rec.typecode)
        : 'linear';
      entries.push({
        key: `${spec.blockName}.${paramName}`,
        blockName: spec.blockName,
        paramName,
        pidLow: spec.pidLow,
        pidHigh: rec.id,
        unit,
        displayMin,
        displayMax,
        scaling: scaling === 'log10' ? 'log10' : undefined,
        enumImport: inferred?.enumImport,
      });
    }
  }
  return { entries, usedEnums, warnings };
}

function formatEntry(e: GeneratedEntry): string {
  const lines: string[] = [];
  lines.push(`  '${e.key}': {`);
  lines.push(`    block: '${e.blockName}', name: '${e.paramName}',`);
  lines.push(`    pidLow: 0x${e.pidLow.toString(16).padStart(4, '0')}, pidHigh: 0x${e.pidHigh.toString(16).padStart(4, '0')},`);
  lines.push(`    unit: '${e.unit}', displayMin: ${e.displayMin}, displayMax: ${e.displayMax},`);
  if (e.scaling) lines.push(`    scaling: '${e.scaling}',`);
  if (e.enumImport) lines.push(`    enumValues: ${e.enumImport},`);
  lines.push('  },');
  return lines.join('\n');
}

function main(): void {
  const { entries, usedEnums, warnings } = generate();

  const enumImportList = [...usedEnums].sort();
  const importBlock = enumImportList.length
    ? `import {\n${enumImportList.map((n) => `  ${n},`).join('\n')}\n} from './cacheEnums.js';\n\n`
    : '';

  const header = `/**
 * Generated by scripts/gen-params-from-cache.ts — do not hand-edit.
 *
 * Bulk parameter registry harvested from AM4-Edit's metadata cache
 * (effectDefinitions_15_2p0.cache, parsed by scripts/parse-cache.ts).
 * Names come from src/protocol/paramNames.ts; add a name there and
 * regenerate to expand coverage. Out-of-band params (channel /
 * level / other pidHighs without a cache record) stay hand-authored
 * in params.ts.
 *
 * Verification: scripts/verify-cache-params.ts confirms every entry
 * here matches the corresponding hand-authored KNOWN_PARAMS entry
 * byte-for-byte (same pidLow/pidHigh, same unit, same displayMin/
 * displayMax). Preflight runs this verification.
 */
import type { Param } from './params.js';

${importBlock}export const CACHE_PARAMS = {
${entries.map(formatEntry).join('\n')}
} as const satisfies Record<string, Param>;

export type CacheParamKey = keyof typeof CACHE_PARAMS;
`;

  writeFileSync(CACHE_PARAMS_OUT, header);
  console.log(`wrote ${CACHE_PARAMS_OUT} — ${entries.length} entries`);
  for (const e of entries) {
    console.log(`  ${e.key} — pidHigh=0x${e.pidHigh.toString(16).padStart(4, '0')} (${e.unit})`);
  }
  if (warnings.length) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
}

main();
