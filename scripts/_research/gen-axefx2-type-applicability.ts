/**
 * Generate `fractal-midi/src/axe-fx-ii/typeApplicability.ts` from the
 * AxeEdit II `__block_layout.xml` JUCE BinaryData resource.
 *
 * Mirrors the AM4 pipeline (`scripts/_research/{extract,gen}-type-
 * applicability.ts`) but collapsed to one pass because the II params
 * registry carries `parameterName` directly on every entry (the AM4
 * registry uses an intermediate `pidHigh → cache_id ← parameterName`
 * resolver). Direct parameterName match means the join is a single
 * Map lookup — no resolver scaffolding needed.
 *
 * Source XML schema (identical to AM4's, since both editors are JUCE
 * apps from the same Fractal codebase):
 *   <EditorControls name="<XML block>">
 *     <EffectVariants>?
 *       <EffectVariant value="N1,N2,...">
 *         <Page parameterName="<TYPE_ENUM>" value="N">?
 *           <EditorControl parameterName="<PARAM_NAME>"
 *                          controllingParamName="<TYPE_ENUM>"?
 *                          controllingParamValue="N1,N2"? />
 *
 * Effect: every parameterName under a gated Page or EffectVariant or
 * controllingParam* carries that gate as an Applicability entry. Same
 * shape as AM4's `Applicability` interface (always + gates[]), keyed
 * by `${friendlyBlock}.${friendlyName}`.
 *
 * Run:
 *   cd C:/dev/mcp-midi-tools && npx tsx scripts/_research/gen-axefx2-type-applicability.ts
 *
 * Flags:
 *   --show-annotation-gaps   Additionally emit a markdown report at
 *                            `samples/captured/decoded/axefx2-annotation-
 *                            gaps.md` that, for each XML parameterName
 *                            with no registry join, lists candidate
 *                            same-block KNOWN_PARAMS entries that look
 *                            like an annotation-only fix (the registry
 *                            entry exists but lacks the
 *                            `parameterName: "..."` annotation). Cheap
 *                            fix: add the annotation. Distinguishes
 *                            annotation-only gaps from true missing
 *                            entries so the next backfill pass sizes
 *                            correctly. Per
 *                            [[feedback_shipped_capabilities_index]].
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';

const SHOW_ANNOTATION_GAPS = process.argv.includes('--show-annotation-gaps');
const ANNOTATION_GAPS_OUT =
  'samples/captured/decoded/axefx2-annotation-gaps.md';

const XML_PATH =
  'samples/captured/decoded/binarydata/axe-edit-extracted/__block_layout.xml';
const OUT_TS =
  'C:/dev/fractal-midi/src/axe-fx-ii/typeApplicability.ts';

// ─── XML block name → params.ts block slug ──────────────────────────
// One row per <EditorControls name="X"> tag seen in the II XML.
// Entries set to `null` are XML-only constructs with no matching block
// in II params.ts (UI dialogs, blocks the II doesn't ship, etc.).
const XML_TO_FRIENDLY_BLOCK: Record<string, string | null> = {
  Amp:             'amp',
  Cab:             'cab',
  Chorus:          'chorus',
  Compressor:      'compressor',
  Controllers:     'controllers',
  Crossover:       'crossover',
  Delay:           'delay',
  Drive:           'drive',
  EffectsLoop:     'effectsloop',
  Enhancer:        'enhancer',
  FeedbackReturn:  'feedbackreturn',
  FeedbackSend:    'feedbacksend',
  Filter:          'filter',
  Flanger:         'flanger',
  Formant:         'formant',
  GateExpander:    'gateexpander',
  GraphicEQ:       'graphiceq',
  Looper:          'looper',
  MegaTap:         'megatap',
  Mixer:           'mixer',
  MultibandComp:   'multibandcomp',
  MultiDelay:      'multidelay',
  ModifierDlg:     null,        // UI dialog, not a block
  NoiseGate:       null,        // II params.ts has no 'noisegate' slug
  Output:          'output',
  PanTrem:         'pantrem',
  ParametricEQ:    'parametriceq',
  Phaser:          'phaser',
  Pitch:           'pitch',
  QuadChorus:      null,        // II params.ts has no 'quadchorus' slug
  Resonator:       'resonator',
  Reverb:          'reverb',
  RingMod:         'ringmod',
  Rotary:          'rotary',
  Synth:           'synth',
  Tone:            null,        // pre-amp tone shaper, not a discrete block
  Vocoder:         'vocoder',
  VolPan:          'volpan',
  Wah:             'wah',
};

// Per-block fallback for the type-enum parameterName when the
// <EditorControls> element doesn't carry a `parameters="..."` attribute
// and the block uses <EffectVariant> gating exclusively. Same idea as
// AM4's BLOCK_TYPE_ENUM_FALLBACK.
const BLOCK_TYPE_ENUM_FALLBACK: Record<string, string> = {
  Compressor: 'COMP_TYPE',
  GraphicEQ:  'GEQ_TYPE',
  MultiDelay: 'DELAY_MODEL',
};

interface ParsedExposure {
  /** XML parameterName, e.g. "DISTORT_DRIVE". */
  parameterName: string;
  /** True iff this exposure carries no page-level + no control-level gate. */
  always: boolean;
  pageGate?: { typeEnum: string; values: number[] };
  controlGate?: { typeEnum: string; values: number[] };
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2];
  return out;
}

function parseValueList(s: string | undefined): number[] | undefined {
  if (s === undefined) return undefined;
  if (s === '') return [];
  const parts = s.split(',').map((p) => p.trim()).filter((p) => p.length);
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  return nums.length === parts.length ? nums : undefined;
}

function deriveTypeEnum(blockName: string, parametersAttr: string | undefined): string | undefined {
  if (parametersAttr) {
    const first = parametersAttr.split(',')[0]?.trim();
    if (first) return first;
  }
  return BLOCK_TYPE_ENUM_FALLBACK[blockName];
}

/** Walk every parameterName exposure inside one <EditorControls> region. */
function extractBlockExposures(
  blockName: string,
  blockInner: string,
  variantTypeEnum: string | undefined,
): ParsedExposure[] {
  const out: ParsedExposure[] = [];

  const walkPages = (region: string, defaultGate?: { param: string; values: number[] }) => {
    const pageRe = /<Page\s+([^>]*?)>([\s\S]*?)<\/Page>/g;
    let pm;
    while ((pm = pageRe.exec(region)) !== null) {
      const pageAttrs = parseAttrs(pm[1]);
      const pageInner = pm[2];

      const pageGateParamRaw = pageAttrs.parameterName || undefined;
      const pageGateValues = parseValueList(pageAttrs.value);
      const pageHasOwnGate = pageGateValues !== undefined && pageGateValues.length > 0;
      const pageGateParam = pageHasOwnGate ? pageGateParamRaw : defaultGate?.param;
      const effectivePageGateValues = pageHasOwnGate ? pageGateValues : defaultGate?.values;

      const ctrlRe = /<EditorControl\s+([^>]*?)\/?>/g;
      let cm;
      while ((cm = ctrlRe.exec(pageInner)) !== null) {
        const a = parseAttrs(cm[1]);
        if (!a.parameterName) continue;
        const ctrlVals = parseValueList(a.controllingParamValue);
        const ctrlGate = a.controllingParamName && ctrlVals && ctrlVals.length > 0
          ? { typeEnum: a.controllingParamName, values: ctrlVals }
          : undefined;
        const pageGate = pageGateParam && effectivePageGateValues && effectivePageGateValues.length > 0
          ? { typeEnum: pageGateParam, values: effectivePageGateValues }
          : undefined;
        const always = !pageGate && !ctrlGate;
        out.push({
          parameterName: a.parameterName,
          always,
          pageGate,
          controlGate: ctrlGate,
        });
      }
    }
  };

  // First pass: <EffectVariant value="N1,N2"> regions (the Compressor /
  // GraphicEQ / MultiDelay pattern).
  const variantRe = /<EffectVariant\s+([^>]*?)>([\s\S]*?)<\/EffectVariant>/g;
  let strippedInner = blockInner;
  let vm;
  while ((vm = variantRe.exec(blockInner)) !== null) {
    const variantAttrs = parseAttrs(vm[1]);
    const variantValues = parseValueList(variantAttrs.value);
    const variantInner = vm[2];
    const defaultGate = variantValues !== undefined && variantValues.length > 0 && variantTypeEnum
      ? { param: variantTypeEnum, values: variantValues }
      : undefined;
    walkPages(variantInner, defaultGate);
    strippedInner = strippedInner.replace(vm[0], '');
  }

  // Second pass: pages outside <EffectVariant> (Drive / Filter / etc.
  // use page-level + control-level gating directly).
  walkPages(strippedInner);

  return out;
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

// ─── Build registry: parameterName → list of (block, name) targets ──
// One parameterName can resolve to multiple registry entries when the
// XML block name maps to a single params.ts block (e.g. all "Amp.*"
// XML rows feed amp.*). We only consider entries whose `parameterName`
// matches the XML's parameterName.
const REGISTRY_BY_BLOCK_AND_PARAM = new Map<string, Map<string, string>>();
for (const param of Object.values(KNOWN_PARAMS) as { block: string; name: string; parameterName?: string }[]) {
  if (!param.parameterName) continue;
  let inner = REGISTRY_BY_BLOCK_AND_PARAM.get(param.block);
  if (!inner) {
    inner = new Map<string, string>();
    REGISTRY_BY_BLOCK_AND_PARAM.set(param.block, inner);
  }
  // Last-wins is fine here — the params registry is unique on
  // (block, parameterName) for the entries that have parameterName.
  inner.set(param.parameterName, param.name);
}

// ─── Parse XML and accumulate per-friendly-key applicability ───────
const xml = readFileSync(XML_PATH, 'utf8');
const out = new Map<string, OutApplicability>();

let joined = 0;
let skippedNoFriendlyBlock = 0;
let skippedBlockHasNoRegistry = 0;
let skippedNoMatchingParam = 0;
const unmatchedSamples = new Map<string, Set<string>>();
// Full unmatched set (block → parameterName → first-seen XML block name)
// for the --show-annotation-gaps report. Separate from unmatchedSamples
// because the per-block sample cap of 6 hides the long tail we need
// here.
const unmatchedAll = new Map<string, Set<string>>();

const blockRe = /<EditorControls\s+([^>]*?)>([\s\S]*?)<\/EditorControls>/g;
let bm;
while ((bm = blockRe.exec(xml)) !== null) {
  const blockAttrs = parseAttrs(bm[1]);
  const xmlBlockName = blockAttrs.name;
  if (!xmlBlockName) continue;
  const friendlyBlock = XML_TO_FRIENDLY_BLOCK[xmlBlockName];
  if (friendlyBlock === undefined) {
    // XML block name not in the mapping table at all — log so we know
    // to add it (or set it to null explicitly).
    skippedNoFriendlyBlock++;
    continue;
  }
  if (friendlyBlock === null) continue; // intentionally unmapped
  const registry = REGISTRY_BY_BLOCK_AND_PARAM.get(friendlyBlock);
  if (!registry) {
    skippedBlockHasNoRegistry++;
    continue;
  }
  const variantTypeEnum = deriveTypeEnum(xmlBlockName, blockAttrs.parameters);

  const exposures = extractBlockExposures(xmlBlockName, bm[2], variantTypeEnum);

  // Group exposures by parameterName so we can collapse "always +
  // also-gated" duplicates into one record per friendly key.
  const byParam = new Map<string, ParsedExposure[]>();
  for (const e of exposures) {
    const list = byParam.get(e.parameterName) ?? [];
    list.push(e);
    byParam.set(e.parameterName, list);
  }

  for (const [parameterName, exps] of byParam) {
    const friendlyName = registry.get(parameterName);
    if (!friendlyName) {
      skippedNoMatchingParam++;
      const sampleSet = unmatchedSamples.get(friendlyBlock) ?? new Set<string>();
      if (sampleSet.size < 6) sampleSet.add(parameterName);
      unmatchedSamples.set(friendlyBlock, sampleSet);
      const allSet = unmatchedAll.get(friendlyBlock) ?? new Set<string>();
      allSet.add(parameterName);
      unmatchedAll.set(friendlyBlock, allSet);
      continue;
    }
    const key = `${friendlyBlock}.${friendlyName}`;

    const always = exps.some((e) => e.always);
    const gateMap = new Map<string, OutGate>();
    for (const e of exps) {
      if (e.pageGate) {
        const k = `page|${e.pageGate.typeEnum}|${e.pageGate.values.join(',')}`;
        gateMap.set(k, { typeEnum: e.pageGate.typeEnum, values: [...e.pageGate.values], source: 'page' });
      }
      if (e.controlGate) {
        const k = `control|${e.controlGate.typeEnum}|${e.controlGate.values.join(',')}`;
        gateMap.set(k, { typeEnum: e.controlGate.typeEnum, values: [...e.controlGate.values], source: 'control' });
      }
    }
    const gates = [...gateMap.values()].sort((a, b) =>
      a.typeEnum === b.typeEnum
        ? a.values.join(',').localeCompare(b.values.join(','))
        : a.typeEnum.localeCompare(b.typeEnum),
    );

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

// ─── Emit typeApplicability.ts ──────────────────────────────────────
const sortedKeys = [...out.keys()].sort();
const lines: string[] = [];
lines.push('/**');
lines.push(' * Generated by scripts/_research/gen-axefx2-type-applicability.ts');
lines.push(' * DO NOT HAND-EDIT.');
lines.push(' *');
lines.push(' * Per-(block, name) applicability records: which Axe-Fx II amp /');
lines.push(' * drive / delay / reverb / etc. types expose this knob in AxeEdit.');
lines.push(' * Decoded from AxeEdit II `__block_layout.xml` `<Page>` and');
lines.push(' * `<EditorControl>` per-type filter attributes (same JUCE schema');
lines.push(' * as AM4-Edit; see fractal-midi/src/am4/typeApplicability.ts for');
lines.push(' * the AM4 sibling).');
lines.push(' *');
lines.push(' * Keys match `KNOWN_PARAMS` (e.g. `amp.bright_cap`). For params');
lines.push(' * not in this map: assume always-on (the common case for universal');
lines.push(' * block params like `BLOCK_BYPASSMODE` / `BLOCK_MIX` / out-of-band');
lines.push(' * channel/level registers, plus any param whose XML row carries no');
lines.push(' * page-level or control-level gate).');
lines.push(' *');
lines.push(' * `always: true` means the parameter has at least one ungated UI');
lines.push(' * exposure. `gates` lists every type-enum gate the XML defines for');
lines.push(' * this parameter — useful as informational context (e.g. "this');
lines.push(' * knob is on a special Plexi page in addition to the universal');
lines.push(' * one"). When `always: false`, only types listed in `gates` expose');
lines.push(' * the knob in AxeEdit\'s UI.');
lines.push(' */');
lines.push('');
lines.push('export interface ApplicabilityGate {');
lines.push('  /** AxeEdit symbolic enum that gates this parameter — e.g. `DISTORT_TYPE`, `DELAY_TYPE`. */');
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
lines.push("export const TYPE_APPLICABILITY_FIRMWARE = 'AxeEdit II 3.7.x (Q8.x device firmware target)';");
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

writeFileSync(OUT_TS, lines.join('\n'));

console.log(`wrote ${OUT_TS} — ${out.size} entries`);
console.log(`joined: ${joined}`);
console.log(`  skipped (XML block not in mapping): ${skippedNoFriendlyBlock}`);
console.log(`  skipped (mapped block has no registry entries): ${skippedBlockHasNoRegistry}`);
console.log(`  skipped (parameterName not found in registry): ${skippedNoMatchingParam}`);

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
  console.log(`  ${block.padEnd(15)} — ${stats.total} entries (${stats.always} always-on, ${stats.gated} type-gated)`);
}

if (unmatchedSamples.size > 0) {
  console.log('\nSamples of XML parameterNames with no matching registry entry (up to 6 per block):');
  for (const [block, names] of [...unmatchedSamples.entries()].sort()) {
    console.log(`  ${block}: ${[...names].join(', ')}`);
  }
}

// ─── --show-annotation-gaps mode ────────────────────────────────────
//
// For each unmatched XML parameterName, look for same-block
// KNOWN_PARAMS entries whose `name` or `wikiName` looks like the
// suffix of the XML parameterName after the block-family prefix
// (DISTORT_, DELAY_, CHORUS_, etc.). When a candidate matches, the
// gap is an annotation-only fix: the registry entry exists; it just
// lacks the `parameterName: "..."` field. That distinction
// dramatically shrinks the "true unmatched" count and lets a
// backfill pass tackle the cheap fixes first.
//
// The block-family prefix is the leading token before the first
// underscore in the XML parameterName. This is the JUCE __block_layout
// convention (e.g. Drive block uses DISTORT_*, Delay block uses
// DELAY_*, Chorus block uses CHORUS_*). Stripping the prefix gives
// the per-knob token in upper-snake-case, which we compare against
// the registry's `name` (snake-case) and `wikiName` (UPPER WITH
// SPACES) — with whitespace normalized to underscores.
//
// Matching scoring (first hit wins):
//   exact         — suffix === name OR suffix === wikiName-normalized
//   levenshtein-1 — edit distance 1 (catches single-letter typos and
//                   pluralization quirks like LEVELL vs LEVEL_L)
//   substring     — suffix is a substring of name or vice versa
//                   (catches OUTPUT_LEVEL vs level, etc.)
//
// Higher-score matches mean stronger annotation-only hypotheses.
if (SHOW_ANNOTATION_GAPS) {
  const allParams = Object.values(KNOWN_PARAMS) as readonly {
    block: string;
    name: string;
    wikiName: string;
    parameterName?: string;
  }[];
  const paramsByBlock = new Map<string, typeof allParams>();
  for (const p of allParams) {
    const arr = (paramsByBlock.get(p.block) ?? []) as typeof allParams;
    paramsByBlock.set(p.block, [...arr, p]);
  }

  function normalizeUpper(s: string): string {
    return s.toUpperCase().replace(/\s+/g, '_');
  }

  function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const prev = new Array<number>(b.length + 1);
    const curr = new Array<number>(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
  }

  type Candidate = {
    xmlParameterName: string;
    suffix: string;
    matchKind: 'exact-name' | 'exact-wiki' | 'levenshtein-1' | 'substring';
    matchedKey: string;
    matchedName: string;
    matchedWikiName: string;
    alreadyAnnotated: boolean;
  };

  const gapsByBlock = new Map<string, Candidate[]>();
  let trueMissingCount = 0;

  for (const [block, names] of unmatchedAll) {
    const blockParams = paramsByBlock.get(block) ?? [];
    for (const xmlParameterName of names) {
      // Strip leading block-family prefix at the first underscore. If
      // no underscore present, use the whole name.
      const underscoreIx = xmlParameterName.indexOf('_');
      const suffix = underscoreIx === -1
        ? xmlParameterName
        : xmlParameterName.slice(underscoreIx + 1);
      const suffixUpper = suffix.toUpperCase();
      const suffixLower = suffix.toLowerCase();

      let best: Candidate | undefined;
      for (const p of blockParams) {
        const nameUpper = p.name.toUpperCase();
        const wikiNorm = normalizeUpper(p.wikiName);
        let kind: Candidate['matchKind'] | undefined;
        if (nameUpper === suffixUpper) kind = 'exact-name';
        else if (wikiNorm === suffixUpper) kind = 'exact-wiki';
        else if (
          levenshtein(suffixUpper, nameUpper) <= 1 ||
          levenshtein(suffixUpper, wikiNorm) <= 1
        ) {
          kind = 'levenshtein-1';
        } else if (
          nameUpper.includes(suffixUpper) ||
          suffixUpper.includes(nameUpper) ||
          wikiNorm.includes(suffixUpper) ||
          suffixUpper.includes(wikiNorm)
        ) {
          kind = 'substring';
        }
        if (kind) {
          const rank = (k: Candidate['matchKind']) =>
            k === 'exact-name' ? 0
            : k === 'exact-wiki' ? 1
            : k === 'levenshtein-1' ? 2 : 3;
          if (!best || rank(kind) < rank(best.matchKind)) {
            best = {
              xmlParameterName,
              suffix,
              matchKind: kind,
              matchedKey: `${p.block}.${p.name}`,
              matchedName: p.name,
              matchedWikiName: p.wikiName,
              alreadyAnnotated: p.parameterName !== undefined,
            };
          }
        }
      }
      if (best) {
        const arr = gapsByBlock.get(block) ?? [];
        arr.push(best);
        gapsByBlock.set(block, arr);
      } else {
        trueMissingCount++;
        // Capture true-missing in a separate bucket so the report
        // splits them out.
        const arr = gapsByBlock.get(block) ?? [];
        arr.push({
          xmlParameterName,
          suffix,
          matchKind: 'substring', // placeholder; flagged via empty matchedKey
          matchedKey: '',
          matchedName: '',
          matchedWikiName: '',
          alreadyAnnotated: false,
        });
        gapsByBlock.set(block, arr);
      }
      void suffixLower;
    }
  }

  // Emit markdown report
  const totalUnmatched = [...unmatchedAll.values()].reduce((acc, s) => acc + s.size, 0);
  const annotationOnly = totalUnmatched - trueMissingCount;
  const md: string[] = [];
  md.push('# Axe-Fx II type-applicability — annotation gap report');
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Source XML: \`${XML_PATH}\``);
  md.push('');
  md.push('## Summary');
  md.push('');
  md.push(`- **Total unmatched XML parameterNames**: ${totalUnmatched}`);
  md.push(`- **Annotation-only gaps** (registry entry exists, lacks \`parameterName\` field): **${annotationOnly}**`);
  md.push(`- **True missing entries** (no same-block registry candidate found): **${trueMissingCount}**`);
  md.push('');
  md.push('The annotation-only count is the cheap fix: add a `parameterName: "..."`');
  md.push('annotation to each matched registry entry; no new param entries, no');
  md.push('encoding research. Per [[feedback_shipped_capabilities_index]] the');
  md.push('previous "188 unmatched" report was partially false-positive in this');
  md.push('way (e.g. `amp.treble` IS shipped at `fractal-midi/src/axe-fx-ii/');
  md.push('params.ts:1875` but lacks the `parameterName: "DISTORT_TREBLE"`');
  md.push('annotation — the generator silently classifies it as missing).');
  md.push('');
  md.push('Match-kind precedence (higher rank = stronger annotation-only hypothesis):');
  md.push('');
  md.push('1. `exact-name` — XML suffix equals `name` field (case-insensitive)');
  md.push('2. `exact-wiki` — XML suffix equals normalized `wikiName` (whitespace → underscore, upper)');
  md.push('3. `levenshtein-1` — edit distance 1 against either');
  md.push('4. `substring` — substring containment either direction');
  md.push('');
  md.push('## Per-block gaps');

  const sortedBlocks = [...gapsByBlock.keys()].sort();
  for (const block of sortedBlocks) {
    const candidates = gapsByBlock.get(block)!.sort((a, b) =>
      a.xmlParameterName.localeCompare(b.xmlParameterName),
    );
    const blockAnnotationOnly = candidates.filter((c) => c.matchedKey).length;
    const blockTrueMissing = candidates.length - blockAnnotationOnly;
    md.push('');
    md.push(`### \`${block}\` — ${candidates.length} unmatched (${blockAnnotationOnly} annotation-only, ${blockTrueMissing} true-missing)`);
    md.push('');
    md.push('| XML parameterName | Suffix | Match kind | Candidate registry key | Already annotated? |');
    md.push('|---|---|---|---|---|');
    for (const c of candidates) {
      if (c.matchedKey) {
        md.push(`| \`${c.xmlParameterName}\` | \`${c.suffix}\` | ${c.matchKind} | \`${c.matchedKey}\` (\`${c.matchedWikiName}\`) | ${c.alreadyAnnotated ? 'yes — conflict, investigate' : 'no — annotation-only fix'} |`);
      } else {
        md.push(`| \`${c.xmlParameterName}\` | \`${c.suffix}\` | — | (no same-block candidate found — true missing) | n/a |`);
      }
    }
  }

  writeFileSync(ANNOTATION_GAPS_OUT, md.join('\n'));
  console.log(`\n--show-annotation-gaps: wrote ${ANNOTATION_GAPS_OUT}`);
  console.log(`  total unmatched: ${totalUnmatched}`);
  console.log(`  annotation-only: ${annotationOnly}`);
  console.log(`  true missing:    ${trueMissingCount}`);
}
