/**
 * Generate an Axe-Fx II params.ts addendum from the Session 94 Ghidra
 * direct-pattern-scan catalog.
 *
 * The Ghidra catalog (`samples/captured/decoded/ghidra-axeedit2-
 * paramtables.json`, produced by `scripts/ghidra/SeekParamTablesII.java`)
 * holds 1,113 family-pure (paramId, symbolicName) pairs recovered
 * from Axe-Edit.exe. 643 of these already ship in the codec's
 * `fractal-midi/src/axe-fx-ii/params.ts` (Session 98 extraction moved
 * the param registry into the sibling `fractal-midi` repo; before
 * that it lived at `packages/axe-fx-ii/src/params.ts`). The remaining
 * 470 entries are NEW — the editor binary knows the params, the wiki
 * never indexed them.
 *
 * This script identifies the 470 NEW entries, joins each against
 * `samples/captured/decoded/labels/axe-edit-catalog.json` for display
 * label + control type, and emits two outputs:
 *
 *   1. samples/captured/decoded/axefx2-ghidra-addendum.json
 *      Machine-readable list. Per entry:
 *        { registryKey, groupCode, block, paramId, wikiName, name,
 *          controlType, parameterName, xmlLabel?, sourceFamily }
 *
 *   2. samples/captured/decoded/axefx2-ghidra-addendum.ts.txt
 *      Paste-ready TypeScript snippet for direct insertion into the
 *      codec's `fractal-midi/src/axe-fx-ii/params.ts` as an addendum
 *      block. The merge happens in the fractal-midi repo, then
 *      pack+install back here.
 *
 * **Why an addendum, not a generator-merge.** The parallel agent
 * (2026-05-17) is actively editing `scripts/extract-axe-fx-ii-params.ts`
 * to fix the "preserve verified header on regen" issue. Writing a
 * second generator that touches `params.ts` at the same time would
 * conflict. Emitting an addendum to a gitignored artifact lets the
 * user (or a follow-up session) merge it cleanly once the parallel
 * work lands — and the merged form sidesteps the
 * generator-regen-clobber issue entirely by being append-only.
 *
 * Skipped families (per generator design):
 *   MOD       — per-param modifier configuration (CTRLID/MIN/MAX/
 *               SLOPE/etc.), not a placeable block. Belongs in the
 *               modifier-config layer, not the params registry.
 *   EFFECT    — layout/page strings, not params.
 *   ID        — block-ID enums, not params.
 *   FDBKSEND  — Ghidra found no family-pure entries (the
 *               feedbacksend block has no separate param table; it
 *               shares with FDBKRET).
 *
 * Run:
 *   npx tsx scripts/_research/generate-axefx2-ghidra-addendum.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';

const GHIDRA_JSON =
  'samples/captured/decoded/ghidra-axeedit2-paramtables.json';
const XML_CATALOG_JSON =
  'samples/captured/decoded/labels/axe-edit-catalog.json';
// Session 98 (fractal-midi extraction): params.ts moved out of this
// repo into the sibling codec repo. The research script runs locally
// on a checkout where both repos are side-by-side at C:/dev/. If you
// have fractal-midi elsewhere, set FRACTAL_MIDI_REPO env var.
const FRACTAL_MIDI_REPO = process.env.FRACTAL_MIDI_REPO ?? '../fractal-midi';
const PARAMS_TS = `${FRACTAL_MIDI_REPO}/src/axe-fx-ii/params.ts`;
const OUT_JSON =
  'samples/captured/decoded/axefx2-ghidra-addendum.json';
const OUT_SNIPPET =
  'samples/captured/decoded/axefx2-ghidra-addendum.ts.txt';

// Fractal family prefix → II (groupCode, block-slug) used in
// `packages/axe-fx-ii/src/params.ts`. Derived by inspecting the
// shipping entries — every parameterName "FAMILY_*" that ships in
// params.ts goes under exactly one groupCode (with one wiring
// duplicate: OUTPUT_LEVEL*/OUTPUT_PAN* appears under both FXL and
// OUTPUT; for new OUTPUT_* additions we put them under OUTPUT only).
const FAMILY_TO_BLOCK: Record<string, { groupCode: string; block: string }> = {
  CABINET:     { groupCode: 'CAB',         block: 'cab' },
  CHORUS:      { groupCode: 'CHO',         block: 'chorus' },
  COMP:        { groupCode: 'CPR',         block: 'compressor' },
  CONTROLLERS: { groupCode: 'CONTROLLERS', block: 'controllers' },
  CROSSOVER:   { groupCode: 'XVR',         block: 'crossover' },
  DELAY:       { groupCode: 'DLY',         block: 'delay' },
  DISTORT:     { groupCode: 'AMP',         block: 'amp' },
  ENHANCER:    { groupCode: 'ENH',         block: 'enhancer' },
  FDBKRET:     { groupCode: 'RTN',         block: 'feedbackreturn' },
  FILTER:      { groupCode: 'FIL',         block: 'filter' },
  FLANGER:     { groupCode: 'FLG',         block: 'flanger' },
  FORMANT:     { groupCode: 'FRM',         block: 'formant' },
  FUZZ:        { groupCode: 'DRV',         block: 'drive' },
  GATE:        { groupCode: 'GTE',         block: 'gateexpander' },
  GEQ:         { groupCode: 'GEQ',         block: 'graphiceq' },
  LOOPER:      { groupCode: 'LPR',         block: 'looper' },
  MEGATAP:     { groupCode: 'MGT',         block: 'megatap' },
  MIXER:       { groupCode: 'MIX',         block: 'mixer' },
  MULTICOMP:   { groupCode: 'MBC',         block: 'multibandcomp' },
  MULTITAP:    { groupCode: 'MTD',         block: 'multidelay' },
  OUTPUT:      { groupCode: 'OUTPUT',      block: 'output' },
  PEQ:         { groupCode: 'PEQ',         block: 'parametriceq' },
  PHASER:      { groupCode: 'PHA',         block: 'phaser' },
  PITCH:       { groupCode: 'PIT',         block: 'pitch' },
  REVERB:      { groupCode: 'REV',         block: 'reverb' },
  RESONATOR:   { groupCode: 'RES',         block: 'resonator' },
  RINGMOD:     { groupCode: 'RNG',         block: 'ringmod' },
  ROTARY:      { groupCode: 'ROT',         block: 'rotary' },
  SYNTH:       { groupCode: 'SYN',         block: 'synth' },
  TREMOLO:     { groupCode: 'TRM',         block: 'pantrem' },
  VOCODER:     { groupCode: 'VOC',         block: 'vocoder' },
  VOLUME:      { groupCode: 'VOL',         block: 'volpan' },
  WAH:         { groupCode: 'WAH',         block: 'wah' },
};

// AxeFxII control-type vocab. Anything outside this set maps to
// 'unknown' per the existing schema (see AxeFxIIControlType).
const KNOWN_CONTROL_TYPES = new Set(['knob', 'select', 'switch']);

interface GhidraTable {
  startAddr: string;
  stride: number;
  effectFamily: string | null;
  paramCount: number;
  params: { paramId: number; name: string }[];
}
interface GhidraDump {
  tables: GhidraTable[];
  summary: {
    tables: number;
    totalParamEntries: number;
    uniqueSymbolsInTables: number;
    symbolsIndexed: number;
  };
}

interface CatalogEntry {
  parameterName?: string;
  label?: string;
  controlType?: string;
  block?: string;
  variant?: string;
}
interface XmlCatalog {
  entries: CatalogEntry[];
}

interface ShippedEntry {
  registryKey: string;
  groupCode: string;
  paramId: number;
  parameterName?: string;
}

function loadShipped(): {
  byParamName: Set<string>;
  byGroupParamId: Set<string>;
  byRegistryKey: Set<string>;
} {
  const t = readFileSync(PARAMS_TS, 'utf-8');
  const re =
    /"([a-z_0-9]+\.[a-z_0-9]+)":\s*\{[^}]*groupCode:\s*"([A-Z_]+)"[^}]*paramId:\s*(\d+)[^}]*?(?:parameterName:\s*"([A-Z][A-Z0-9_]*)")?/g;
  const byParamName = new Set<string>();
  const byGroupParamId = new Set<string>();
  const byRegistryKey = new Set<string>();
  for (const m of t.matchAll(re)) {
    const [, registryKey, groupCode, paramIdStr, parameterName] = m;
    byRegistryKey.add(registryKey);
    byGroupParamId.add(`${groupCode}/${paramIdStr}`);
    if (parameterName) byParamName.add(parameterName);
  }
  return { byParamName, byGroupParamId, byRegistryKey };
}

function loadCatalogLabels(): Map<
  string,
  { label?: string; controlType?: string }
> {
  const cat: XmlCatalog = JSON.parse(readFileSync(XML_CATALOG_JSON, 'utf-8'));
  const out = new Map<string, { label?: string; controlType?: string }>();
  for (const e of cat.entries) {
    if (!e.parameterName) continue;
    if (out.has(e.parameterName)) continue; // first wins
    out.set(e.parameterName, { label: e.label, controlType: e.controlType });
  }
  return out;
}

// SYMBOL → name slug. Strategy: lowercase the post-prefix suffix,
// preserve any trailing digits, do not insert underscores. Matches the
// existing shipping convention where "DISTORT_MASTER" → "master_volume"
// (the existing entries are hand-curated; for new ones we use a
// predictable lowercase-suffix slug so the registry key is
// deterministic and reviewable).
function symbolToNameSlug(symbol: string, family: string): string {
  const prefix = family + '_';
  if (!symbol.startsWith(prefix)) return symbol.toLowerCase();
  return symbol.slice(prefix.length).toLowerCase();
}

function symbolToWikiName(symbol: string, family: string): string {
  const prefix = family + '_';
  if (!symbol.startsWith(prefix)) return symbol;
  return symbol.slice(prefix.length);
}

function tsifyControlType(ct?: string): "knob" | "select" | "switch" | "unknown" {
  if (!ct) return 'unknown';
  if (KNOWN_CONTROL_TYPES.has(ct)) return ct as any;
  // Map XML control-type vocab to schema vocab.
  if (/^dropdown/i.test(ct) || /^combo/i.test(ct)) return 'select';
  if (/^toggle/i.test(ct) || /^button/i.test(ct)) return 'switch';
  if (/^knob/i.test(ct) || /^slider/i.test(ct)) return 'knob';
  return 'unknown';
}

function escapeStr(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

const ghidra: GhidraDump = JSON.parse(readFileSync(GHIDRA_JSON, 'utf-8'));
const shipped = loadShipped();
const catalogLabels = loadCatalogLabels();

// Pick the canonical (largest) table per family.
const canonical: Record<string, GhidraTable> = {};
for (const t of ghidra.tables) {
  const fam = t.effectFamily ?? 'UNKNOWN';
  if (!canonical[fam] || t.paramCount > canonical[fam].paramCount) {
    canonical[fam] = t;
  }
}

interface Addendum {
  registryKey: string;
  groupCode: string;
  block: string;
  paramId: number;
  wikiName: string;
  name: string;
  controlType: 'knob' | 'select' | 'switch' | 'unknown';
  parameterName: string;
  xmlLabel?: string;
  sourceFamily: string;
}

const addendum: Addendum[] = [];
const skippedReasons = new Map<string, number>();
function bumpSkip(reason: string) {
  skippedReasons.set(reason, (skippedReasons.get(reason) ?? 0) + 1);
}

const familiesWithEntries = new Set<string>();

for (const [family, table] of Object.entries(canonical)) {
  const mapping = FAMILY_TO_BLOCK[family];
  if (!mapping) {
    for (const p of table.params) {
      if (p.name.startsWith(family + '_')) bumpSkip(`family-unmapped:${family}`);
    }
    continue;
  }
  for (const p of table.params) {
    if (!p.name.startsWith(family + '_')) continue; // cross-family ghost entry
    if (shipped.byParamName.has(p.name)) {
      bumpSkip('parameterName-already-shipping');
      continue;
    }
    const gpKey = `${mapping.groupCode}/${p.paramId}`;
    if (shipped.byGroupParamId.has(gpKey)) {
      bumpSkip('groupCode-paramId-pair-already-shipping');
      continue;
    }
    const name = symbolToNameSlug(p.name, family);
    if (!name) {
      bumpSkip('empty-name-slug');
      continue;
    }
    const registryKey = `${mapping.block}.${name}`;
    if (shipped.byRegistryKey.has(registryKey)) {
      bumpSkip('registryKey-already-shipping');
      continue;
    }
    const lab = catalogLabels.get(p.name);
    addendum.push({
      registryKey,
      groupCode: mapping.groupCode,
      block: mapping.block,
      paramId: p.paramId,
      wikiName: symbolToWikiName(p.name, family),
      name,
      controlType: tsifyControlType(lab?.controlType),
      parameterName: p.name,
      xmlLabel: lab?.label,
      sourceFamily: family,
    });
    familiesWithEntries.add(family);
  }
}

// Sort: by groupCode then paramId, so the addendum reads in a stable
// block-by-block order.
addendum.sort((a, b) => {
  if (a.groupCode !== b.groupCode) return a.groupCode.localeCompare(b.groupCode);
  return a.paramId - b.paramId;
});

// Emit JSON.
const jsonOut = {
  _generator: 'scripts/_research/generate-axefx2-ghidra-addendum.ts',
  _source: GHIDRA_JSON,
  _labelSource: XML_CATALOG_JSON,
  _shippedSource: PARAMS_TS,
  ghidraTablesTotal: ghidra.tables.length,
  ghidraEntriesIndexed: ghidra.summary.totalParamEntries,
  shippedParamNames: shipped.byParamName.size,
  addendumCount: addendum.length,
  skipped: Object.fromEntries(skippedReasons),
  familiesWithNewEntries: [...familiesWithEntries].sort(),
  entries: addendum,
};
writeFileSync(OUT_JSON, JSON.stringify(jsonOut, null, 2), 'utf-8');

// Emit TS snippet. Two views: per-block-grouped sections + a flat
// dump. The grouped view is paste-friendly for params.ts.
const lines: string[] = [];
lines.push(
  '// ============================================================',
  '// Session 94 Ghidra-direct-scan addendum (2026-05-17).',
  '//',
  '// Generated by scripts/_research/generate-axefx2-ghidra-addendum.ts',
  '// Source: ghidra-axeedit2-paramtables.json (' +
    ghidra.summary.totalParamEntries +
    ' entries from binary)',
  '// Skipped: ' +
    [...skippedReasons.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(', '),
  '//',
  '// Each entry below is a params.ts row recovered from Axe-Edit.exe',
  '// that the wiki+XML pipeline never indexed. paramId verified',
  '// against AM4/III ParamDescriptor convention. displayMin/displayMax',
  '// not populated — needs hardware calibration sweep per block.',
  '// ============================================================',
  '',
);
let prevBlock: string | null = null;
for (const a of addendum) {
  if (a.block !== prevBlock) {
    if (prevBlock !== null) lines.push('');
    lines.push(`    // --- ${a.block} (${a.groupCode}) ---`);
    prevBlock = a.block;
  }
  const xmlPart = a.xmlLabel
    ? `, xmlLabel: "${escapeStr(a.xmlLabel)}"`
    : '';
  lines.push(
    `    "${a.registryKey}": { groupCode: "${a.groupCode}", block: "${a.block}", paramId: ${a.paramId}, wikiName: "${a.wikiName}", name: "${a.name}", controlType: "${a.controlType}", parameterName: "${a.parameterName}"${xmlPart} },`,
  );
}
writeFileSync(OUT_SNIPPET, lines.join('\n') + '\n', 'utf-8');

// Console summary.
console.log('');
console.log('=== Axe-Fx II Ghidra addendum generator ===');
console.log('');
console.log(`Ghidra entries (total):        ${ghidra.summary.totalParamEntries}`);
console.log(`Shipping parameterNames:       ${shipped.byParamName.size}`);
console.log(`Shipping (groupCode,paramId):  ${shipped.byGroupParamId.size}`);
console.log('');
console.log(`Addendum entries generated:    ${addendum.length}`);
console.log(`Skipped (per reason):`);
for (const [r, n] of [...skippedReasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${r.padEnd(40)} ${n.toString().padStart(5)}`);
}
console.log('');
console.log(`Families with new entries (${familiesWithEntries.size}):`);
const perFamily = new Map<string, number>();
for (const a of addendum) {
  perFamily.set(a.sourceFamily, (perFamily.get(a.sourceFamily) ?? 0) + 1);
}
for (const [f, n] of [...perFamily.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${f.padEnd(16)} ${n.toString().padStart(4)}`);
}
console.log('');
console.log(`Wrote ${OUT_JSON} (${addendum.length} entries)`);
console.log(`Wrote ${OUT_SNIPPET} (${lines.length} lines)`);
