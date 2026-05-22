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
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';

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
