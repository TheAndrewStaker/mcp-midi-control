/**
 * Generate `src/protocol/typeApplicability.ts` — per-(block, name)
 * applicability records keyed by the same `${block}.${name}` form as
 * KNOWN_PARAMS. Joins the XML decode (per-XML-block-name +
 * parameterName) to the runtime registry (friendly block + friendly
 * name) via the variant resolver (parameterName → cache_id) and the
 * KNOWN_PARAMS entries (block + pidHigh = cache_id).
 *
 * Pipeline order:
 *   1. extract-type-applicability.ts → type-applicability.json
 *   2. extract-variant-resolver.ts → variantResolverTables.ts
 *   3. gen-params-from-cache.ts → cacheParams.ts → KNOWN_PARAMS
 *   4. gen-type-applicability.ts (THIS) → typeApplicability.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { KNOWN_PARAMS } from 'fractal-midi/am4';
import { resolveAllCacheIds } from 'fractal-midi/am4';

interface JsonGate {
  typeEnum: string;
  values: number[];
}

interface JsonExposure {
  parameterName: string;
  always: boolean;
  pageGate?: JsonGate;
  controlGate?: { typeEnum: string; values?: number[]; strValue?: string };
  pages: string[];
  pageLayers: ('first' | 'expert')[];
}

interface JsonBlock {
  blockName: string;
  typeEnums: string[];
  parameters: JsonExposure[];
}

const data: JsonBlock[] = JSON.parse(
  readFileSync(process.env.AM4_APPLICABILITY_JSON ?? 'samples/captured/decoded/labels/type-applicability.json', 'utf8'),
);

/**
 * Map XML block names to KNOWN_PARAMS friendly block names. The XML
 * uses an internal naming convention; KNOWN_PARAMS uses lowercase
 * abbreviated names. Blocks listed here are the ones present in
 * KNOWN_PARAMS (so we don't waste runtime memory on out-of-scope
 * blocks like Pitch / MultiDelay / PlexDelay etc.).
 */
const XML_TO_FRIENDLY_BLOCK: Record<string, string> = {
  Amp: 'amp',
  Drive: 'drive',
  Delay: 'delay',
  Reverb: 'reverb',
  Chorus: 'chorus',
  Flanger: 'flanger',
  Phaser: 'phaser',
  Wah: 'wah',
  Compressor: 'compressor',
  GraphicEQ: 'geq',
  ParametricEQ: 'peq',
  Filter: 'filter',
  Tremolo: 'tremolo',
  Enhancer: 'enhancer',
  GateExpander: 'gate',
  VolPan: 'volpan',
  Rotary: 'rotary',
};

/**
 * Per-block parameterName-prefix preference. Mirrors the
 * `variantPreference` list in `gen-paramnames-from-resolver.ts` —
 * when one cache_id binds to multiple parameterNames across variants
 * (e.g., delay cache_id 73 binds to DELAY_OFFSET, MULTITAP_FLTTEMPO,
 * AND PLEX_THRESH), we only honour the gates from the parameterName
 * whose prefix matches the block's primary identity. Otherwise the
 * applicability annotation collapses gates from unrelated sibling
 * variants into one record and ends up reporting the wrong types.
 */
const VARIANT_PREFERENCE: Record<string, string[]> = {
  amp: ['DISTORT_', 'CABINET_', 'BLOCK_'],
  delay: ['DELAY_', 'MULTITAP_', 'PLEX_', 'BLOCK_'],
  drive: ['FUZZ_', 'BLOCK_'],
  reverb: ['REVERB_', 'BLOCK_'],
  chorus: ['CHORUS_', 'BLOCK_'],
  flanger: ['FLANGER_', 'BLOCK_'],
  phaser: ['PHASER_', 'BLOCK_'],
  wah: ['WAH_', 'BLOCK_'],
  compressor: ['COMP_', 'BLOCK_'],
  geq: ['GEQ_', 'BLOCK_'],
  peq: ['PEQ_', 'BLOCK_'],
  filter: ['FILTER_', 'BLOCK_'],
  tremolo: ['TREMOLO_', 'BLOCK_'],
  enhancer: ['ENHANCER_', 'BLOCK_'],
  gate: ['GATE_', 'BLOCK_'],
  volpan: ['VOLUME_', 'BLOCK_'],
  rotary: ['ROTARY_', 'BLOCK_'],
};

function variantRank(friendlyBlock: string, parameterName: string): number {
  const prefs = VARIANT_PREFERENCE[friendlyBlock] ?? [];
  for (let i = 0; i < prefs.length; i++) {
    if (parameterName.startsWith(prefs[i])) return i;
  }
  return 999;
}

/**
 * Per-block parameterName → cache_id resolver lookup that aggregates
 * across every variant the resolver knows. Keys are friendly block
 * names. Multiple cache_ids may resolve from a single parameterName
 * (variant ambiguity); we surface all of them so a friendly name's
 * applicability is keyed correctly even when the friendly name binds
 * to a cache_id that only one variant reaches.
 */
function resolverLookup(friendlyBlock: string, parameterName: string): readonly number[] {
  return resolveAllCacheIds(friendlyBlock, parameterName);
}

/**
 * Build a per-block index of `pidHigh -> friendly_name` from
 * KNOWN_PARAMS so we can join the XML's parameterName-keyed data to
 * the runtime registry's friendly-name-keyed entries via cache_id.
 */
const KNOWN_BY_BLOCK_AND_PIDHIGH = new Map<string, Map<number, string>>();
for (const param of Object.values(KNOWN_PARAMS)) {
  const inner = KNOWN_BY_BLOCK_AND_PIDHIGH.get(param.block) ?? new Map<number, string>();
  inner.set(param.pidHigh, param.name);
  KNOWN_BY_BLOCK_AND_PIDHIGH.set(param.block, inner);
}

interface OutGate {
  typeEnum: string;
  values: number[];
  source: 'page' | 'control';
}

interface OutApplicability {
  always: boolean;
  gates: OutGate[];
}

const out = new Map<string, OutApplicability>();

let joined = 0;
let skippedNoFriendlyBlock = 0;
let skippedNoCacheId = 0;
let skippedNoFriendlyName = 0;

for (const block of data) {
  const friendlyBlock = XML_TO_FRIENDLY_BLOCK[block.blockName];
  if (!friendlyBlock) {
    skippedNoFriendlyBlock++;
    continue;
  }
  const knownByPidHigh = KNOWN_BY_BLOCK_AND_PIDHIGH.get(friendlyBlock);
  if (!knownByPidHigh) continue;

  // Group exposures by parameterName so we can collapse "always" + gated
  // duplicates into a single record.
  const byParam = new Map<string, JsonExposure[]>();
  for (const exposure of block.parameters) {
    const list = byParam.get(exposure.parameterName) ?? [];
    list.push(exposure);
    byParam.set(exposure.parameterName, list);
  }

  // For each cache_id, pick the SINGLE parameterName whose prefix best
  // matches the block's primary variant identity. Without this filter,
  // a cache_id like delay.73 (DELAY_OFFSET ∪ MULTITAP_FLTTEMPO ∪
  // PLEX_THRESH) would merge gates from all three variants into the
  // friendly name's applicability — wrong, because the friendly name
  // came from only one of them (the highest-priority prefix).
  const bestParameterByCacheId = new Map<number, string>();
  for (const parameterName of byParam.keys()) {
    const cacheIds = resolverLookup(friendlyBlock, parameterName);
    for (const cacheId of cacheIds) {
      const existing = bestParameterByCacheId.get(cacheId);
      if (!existing || variantRank(friendlyBlock, parameterName) < variantRank(friendlyBlock, existing)) {
        bestParameterByCacheId.set(cacheId, parameterName);
      }
    }
  }

  for (const [parameterName, exposures] of byParam) {
    const cacheIds = resolverLookup(friendlyBlock, parameterName);
    if (cacheIds.length === 0) {
      skippedNoCacheId++;
      continue;
    }
    for (const cacheId of cacheIds) {
      // Only honour this parameterName's exposures for this cacheId if
      // it's the highest-priority variant for the cacheId. Otherwise we'd
      // merge gates from unrelated sibling variants.
      if (bestParameterByCacheId.get(cacheId) !== parameterName) continue;
      const friendlyName = knownByPidHigh.get(cacheId);
      if (!friendlyName) {
        skippedNoFriendlyName++;
        continue;
      }
      const key = `${friendlyBlock}.${friendlyName}`;
      // Collapse: always-on if ANY exposure is always-on.
      const always = exposures.some((e) => e.always);
      // Dedupe gates by (typeEnum, values, source).
      const gateMap = new Map<string, OutGate>();
      for (const e of exposures) {
        if (e.pageGate) {
          const k = `page|${e.pageGate.typeEnum}|${e.pageGate.values.join(',')}`;
          gateMap.set(k, { typeEnum: e.pageGate.typeEnum, values: [...e.pageGate.values], source: 'page' });
        }
        if (e.controlGate && e.controlGate.values) {
          const k = `control|${e.controlGate.typeEnum}|${e.controlGate.values.join(',')}`;
          gateMap.set(k, { typeEnum: e.controlGate.typeEnum, values: [...e.controlGate.values], source: 'control' });
        }
      }
      const gates = [...gateMap.values()].sort((a, b) =>
        a.typeEnum === b.typeEnum
          ? a.values.join(',').localeCompare(b.values.join(','))
          : a.typeEnum.localeCompare(b.typeEnum),
      );
      // Existing entry (same friendly key reachable via a different
      // cache_id binding): merge.
      const existing = out.get(key);
      if (existing) {
        existing.always = existing.always || always;
        for (const g of gates) {
          const k = `${g.source}|${g.typeEnum}|${g.values.join(',')}`;
          if (!existing.gates.some((eg) => `${eg.source}|${eg.typeEnum}|${eg.values.join(',')}` === k)) {
            existing.gates.push(g);
          }
        }
      } else {
        out.set(key, { always, gates });
      }
      joined++;
    }
  }
}

const sortedKeys = [...out.keys()].sort();

const lines: string[] = [];
lines.push('/**');
lines.push(' * Generated by scripts/gen-type-applicability.ts — do not hand-edit.');
lines.push(' *');
lines.push(' * Per-(block, name) applicability records: which AM4 amp / drive /');
lines.push(' * delay / reverb / etc. types expose this knob. Decoded from the');
lines.push(' * AM4-Edit BinaryData ZIP `__block_layout(.expert).xml` `<Page>`');
lines.push(' * and `<EditorControl>` per-type filter attributes (Session 46');
lines.push(' * cont 5, 2026-05-04 — replaces the earlier framing of "Ghidra-');
lines.push(' * into-DSP needed"; the data was always in the XML).');
lines.push(' *');
lines.push(' * Keys match `KNOWN_PARAMS` (e.g. `delay.right_post_delay`). For');
lines.push(' * params not in this map: assume always-on (the common case for');
lines.push(' * universal block params like `BLOCK_PAN` / `BLOCK_MIX` / out-of-');
lines.push(' * band channel/level registers).');
lines.push(' *');
lines.push(' * `always: true` means the parameter has at least one ungated UI');
lines.push(' * exposure. `gates` lists every type-enum gate the XML defines for');
lines.push(' * this parameter — useful as informational context (e.g. "this');
lines.push(' * knob is on a special Friedman BE page in addition to the');
lines.push(' * universal one"). When `always: false`, only types listed in');
lines.push(' * `gates` expose the knob in AM4-Edit\'s UI.');
lines.push(' */');
lines.push('');
lines.push('export interface ApplicabilityGate {');
lines.push('  /** AM4-Edit symbolic enum that gates this parameter — e.g. `DELAY_TYPE`, `FUZZ_TYPE`. */');
lines.push('  readonly typeEnum: string;');
lines.push('  /** Wire indices into the gate enum at which this parameter is exposed. */');
lines.push('  readonly values: readonly number[];');
lines.push('  /** Whether the gate is on the entire `<Page>` or an individual `<EditorControl>`. */');
lines.push("  readonly source: 'page' | 'control';");
lines.push('}');
lines.push('');
lines.push('export interface Applicability {');
lines.push('  /** True if the parameter has at least one ungated UI exposure. */');
lines.push('  readonly always: boolean;');
lines.push('  /** Type-enum gates the parameter has. May be present alongside `always: true` (special-cased pages). */');
lines.push('  readonly gates: readonly ApplicabilityGate[];');
lines.push('}');
lines.push('');
lines.push(`export const TYPE_APPLICABILITY_FIRMWARE = '${process.env.AM4_EDITOR_BUILD ?? 'AM4-Edit Mar 20 2026 build'}';`);
lines.push('');
lines.push('export const TYPE_APPLICABILITY: Readonly<Record<string, Applicability>> = {');
for (const k of sortedKeys) {
  const a = out.get(k)!;
  if (a.gates.length === 0) {
    lines.push(`  '${k}': { always: ${a.always}, gates: [] },`);
  } else {
    const gateLines = a.gates
      .map((g) => `{ typeEnum: '${g.typeEnum}', values: [${g.values.join(', ')}], source: '${g.source}' }`)
      .join(', ');
    lines.push(`  '${k}': { always: ${a.always}, gates: [${gateLines}] },`);
  }
}
lines.push('};');
lines.push('');

writeFileSync(process.env.AM4_APPLICABILITY_OUT ?? 'packages/fractal-midi/src/am4/typeApplicability.ts', lines.join('\n'));

console.log(`wrote src/protocol/typeApplicability.ts — ${out.size} entries`);
console.log(`joined: ${joined}`);
console.log(`  skipped (block not in KNOWN_PARAMS): ${skippedNoFriendlyBlock}`);
console.log(`  skipped (parameterName has no resolver cacheId): ${skippedNoCacheId}`);
console.log(`  skipped (cacheId not in KNOWN_PARAMS): ${skippedNoFriendlyName}`);

// Per-block summary
const perBlock = new Map<string, { total: number; gated: number; always: number }>();
for (const k of out.keys()) {
  const block = k.split('.')[0];
  const a = out.get(k)!;
  const cur = perBlock.get(block) ?? { total: 0, gated: 0, always: 0 };
  cur.total++;
  if (a.gates.length > 0) cur.gated++;
  if (a.always) cur.always++;
  perBlock.set(block, cur);
}
console.log('\nPer-block coverage:');
for (const [block, stats] of [...perBlock.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${block.padEnd(12)} — ${stats.total} entries (${stats.always} always-on, ${stats.gated} type-gated)`);
}
