/**
 * Decode per-type knob applicability from AM4-Edit's __block_layout XMLs.
 *
 * Discovery (Session 46 cont 5, 2026-05-03): the XML schema gates entire
 * `<Page>` elements per-type via `parameterName="<TYPE_ENUM>" value="<N>"`.
 * Individual `<EditorControl>` lines can also be gated via
 * `controllingParamName` + `controllingParamValue` / `controllingParamStrValue`.
 * Together these tell us EXACTLY which knobs each type exposes — the
 * answer to "which types have which params" the founder asked for.
 *
 * 200 Page-level filters + 311 EditorControl-level filters across the
 * two XMLs (BASIC + Expert). Heaviest filtering: DELAY_TYPE (8 distinct
 * pages), FILTER_TYPE (7), TREMOLO_TYPE (3), GATE_TYPE (3),
 * REVERB_BASETYPE (3).
 *
 * This is the decode the founder asked us to "challenge" — turns out
 * Ghidra-into-DSP isn't needed. The capability map was always in the
 * data we extracted in Session 46 cont 3; the prior parser
 * (`parse-am4edit-labels.ts`) just stripped these attributes when
 * building EDITOR_CONTROLS.
 *
 * Output: `src/protocol/typeApplicability.ts` — for each block, lists
 * the parameterNames exposed under each (typeEnum, typeValue) gate,
 * plus a "universal" set that's exposed regardless of type.
 *
 * Run:
 *   npx tsx scripts/extract-type-applicability.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const XML_DIR = 'samples/captured/decoded/binarydata/extracted';

interface ControlGate {
  parameterName: string;
  controllingParamName?: string;
  controllingParamValue?: number[];
  controllingParamStrValue?: string;
  page?: string;
  pageGateParam?: string;
  pageGateValues?: number[];
  pageLayer: 'first' | 'expert';
}

/**
 * Tokenize the XML enough to find <EditorControls name="X">...</EditorControls>
 * regions and within them, <Page ...>...</Page> regions. We don't need a
 * full parser — the XML is well-formed and the attributes we care about
 * appear on opening tags.
 */
function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2];
  return out;
}

function parseValueList(s: string | undefined): number[] | undefined {
  if (s === undefined) return undefined;
  // Empty string `value=""` means "fallback / always" (per the XML
  // schema's substring-match rule for controllingParamStrValue: an empty
  // string is a substring of every type name → matches every type). We
  // signal this with `[]` to the caller, which downgrades it to "always".
  if (s === '') return [];
  const parts = s.split(',').map((p) => p.trim()).filter((p) => p.length);
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  return nums.length === parts.length ? nums : undefined;
}

interface Block {
  blockName: string;
  pageGroups: { pageGateParam?: string; pageGateValues?: number[]; pageName: string; controls: ControlGate[] }[];
}

// Per-block fallback for the type-enum parameterName when the
// <EditorControls> element doesn't carry a `parameters="..."` attribute.
// Discovered HW-055 (Session 47, 2026-05-04): Compressor uses
// `<EffectVariant value="6,14" name="Analog">` to gate type-groups but
// has no `parameters=` attribute on its EditorControls. Without this
// fallback, the extractor saw all compressor controls as ungated —
// an iconic-tone test then wrote ratio/threshold to dead
// registers on Dynami-Comp Classic (a pedal-style comp that doesn't
// expose them). GraphicEQ has the same schema shape (gates by GEQ_TYPE).
const BLOCK_TYPE_ENUM_FALLBACK: Record<string, string> = {
  Compressor: 'COMP_TYPE',
  GraphicEQ:  'GEQ_TYPE',
  MultiDelay: 'DELAY_MODEL',
};

function deriveTypeEnumFor(blockName: string, parametersAttr: string | undefined): string | undefined {
  // Prefer the first parameter listed in the EditorControls' parameters=
  // attribute when present (Reverb → REVERB_TYPE, Delay → DELAY_TYPE,
  // ParametricEQ → PEQ_TYPE1, etc.). Fall back to the per-block hardcode
  // for blocks that don't carry that attribute.
  if (parametersAttr) {
    const first = parametersAttr.split(',')[0]?.trim();
    if (first) return first;
  }
  return BLOCK_TYPE_ENUM_FALLBACK[blockName];
}

function extract(xmlPath: string, pageLayer: 'first' | 'expert'): Block[] {
  const xml = readFileSync(xmlPath, 'utf8');
  const blocks: Block[] = [];

  // Walk top-level <EditorControls name="..."> blocks (one per UI block:
  // Amp / Drive / Delay / etc.). Use a non-greedy regex with manual
  // bracket counting to be safe against nesting.
  const blockRe = /<EditorControls\s+([^>]*?)>([\s\S]*?)<\/EditorControls>/g;
  let bm;
  while ((bm = blockRe.exec(xml)) !== null) {
    const blockAttrs = parseAttrs(bm[1]);
    const blockName = blockAttrs.name;
    if (!blockName) continue;
    const inner = bm[2];
    const variantTypeEnum = deriveTypeEnumFor(blockName, blockAttrs.parameters);

    const block: Block = { blockName, pageGroups: [] };

    // Helper: walk all <Page>s inside a region, applying a default
    // gate when the Page itself doesn't carry one. Used twice — once
    // per <EffectVariant value="..."> region (with that variant's
    // value gate as the default), and once for the residual Pages
    // not inside any value-gated EffectVariant.
    const walkPages = (region: string, defaultGate?: { param: string; values: number[] }) => {
      const pageRe = /<Page\s+([^>]*?)>([\s\S]*?)<\/Page>/g;
      let pm;
      while ((pm = pageRe.exec(region)) !== null) {
        const pageAttrs = parseAttrs(pm[1]);
        const pageInner = pm[2];

        const pageGateParamRaw = pageAttrs.parameterName || undefined;
        const pageGateValues = parseValueList(pageAttrs.value);
        // Treat `value=""` (empty list) as "no gate" — that's the XML's
        // fallback page for "any type that didn't match an earlier page".
        const pageHasOwnGate = pageGateValues !== undefined && pageGateValues.length > 0;
        const pageGateParam = pageHasOwnGate
          ? pageGateParamRaw
          : (defaultGate?.param);
        const effectivePageGateValues = pageHasOwnGate
          ? pageGateValues
          : (defaultGate?.values);
        const pageName = pageAttrs.name ?? 'unnamed';

        const controls: ControlGate[] = [];
        const ctrlRe = /<EditorControl\s+([^>]*?)\/?>/g;
        let cm;
        while ((cm = ctrlRe.exec(pageInner)) !== null) {
          const a = parseAttrs(cm[1]);
          if (!a.parameterName) continue;
          controls.push({
            parameterName: a.parameterName,
            controllingParamName: a.controllingParamName || undefined,
            controllingParamValue: parseValueList(a.controllingParamValue),
            controllingParamStrValue: a.controllingParamStrValue || undefined,
            page: pageName,
            pageGateParam,
            pageGateValues: effectivePageGateValues,
            pageLayer,
          });
        }
        block.pageGroups.push({ pageGateParam, pageGateValues: effectivePageGateValues, pageName, controls });
      }
    };

    // First pass: walk <EffectVariant value="N1,N2"> regions. Each
    // EffectVariant gates its inner Pages by `(typeEnum=value)` —
    // discovered HW-055: Compressor uses this exclusively rather than
    // page-level gating.
    const variantRe = /<EffectVariant\s+([^>]*?)>([\s\S]*?)<\/EffectVariant>/g;
    let strippedInner = inner;
    let vm;
    while ((vm = variantRe.exec(inner)) !== null) {
      const variantAttrs = parseAttrs(vm[1]);
      const variantValues = parseValueList(variantAttrs.value);
      const variantInner = vm[2];

      const hasVariantGate = variantValues !== undefined && variantValues.length > 0 && variantTypeEnum !== undefined;
      const defaultGate = hasVariantGate
        ? { param: variantTypeEnum!, values: variantValues! }
        : undefined;
      walkPages(variantInner, defaultGate);

      // Strip from `strippedInner` so the second pass doesn't double-walk
      // these Pages without the variant gate.
      strippedInner = strippedInner.replace(vm[0], '');
    }

    // Second pass: walk Pages not inside any <EffectVariant>. Blocks
    // that don't use the variant pattern (Drive, Filter, etc.) hit this
    // pass exclusively — their gates are page-level or control-level.
    walkPages(strippedInner);

    blocks.push(block);
  }
  return blocks;
}

const basicBlocks = extract(join(XML_DIR, '__block_layout.xml'), 'first');
const expertBlocks = extract(join(XML_DIR, '__block_layout_expert.xml'), 'expert');

interface ExposureRecord {
  parameterName: string;
  always: boolean;          // true if ungated within the block
  pageGate?: { typeEnum: string; values: number[] };
  controlGate?: { typeEnum: string; values?: number[]; strValue?: string };
  pages: string[];           // page names where it appears
  pageLayers: ('first' | 'expert')[];
}

interface BlockApplicability {
  blockName: string;
  typeEnums: string[];        // every distinct controlling-param enum seen
  parameters: ExposureRecord[];
}

function collapse(blocks: Block[]): Map<string, ExposureRecord[]> {
  const out = new Map<string, ExposureRecord[]>();
  for (const block of blocks) {
    const recs: ExposureRecord[] = [];
    const byParam = new Map<string, ExposureRecord>();
    for (const pg of block.pageGroups) {
      for (const c of pg.controls) {
        const key = `${c.parameterName}|${pg.pageGateParam ?? ''}|${(pg.pageGateValues ?? []).join(',')}|${c.controllingParamName ?? ''}|${(c.controllingParamValue ?? []).join(',')}|${c.controllingParamStrValue ?? ''}`;
        let r = byParam.get(key);
        if (!r) {
          r = {
            parameterName: c.parameterName,
            always: !pg.pageGateParam && !c.controllingParamName,
            pageGate: pg.pageGateParam ? { typeEnum: pg.pageGateParam, values: pg.pageGateValues ?? [] } : undefined,
            controlGate: c.controllingParamName
              ? { typeEnum: c.controllingParamName, values: c.controllingParamValue, strValue: c.controllingParamStrValue }
              : undefined,
            pages: [],
            pageLayers: [],
          };
          byParam.set(key, r);
          recs.push(r);
        }
        if (!r.pages.includes(pg.pageName)) r.pages.push(pg.pageName);
        if (!r.pageLayers.includes(c.pageLayer)) r.pageLayers.push(c.pageLayer);
      }
    }
    const existing = out.get(block.blockName) ?? [];
    out.set(block.blockName, [...existing, ...recs]);
  }
  return out;
}

const merged = new Map<string, ExposureRecord[]>();
for (const [k, v] of collapse(basicBlocks)) merged.set(k, v);
for (const [k, v] of collapse(expertBlocks)) {
  const existing = merged.get(k) ?? [];
  merged.set(k, [...existing, ...v]);
}

const result: BlockApplicability[] = [];
for (const [blockName, recs] of merged) {
  const typeEnums = [...new Set(
    recs
      .flatMap((r) => [r.pageGate?.typeEnum, r.controlGate?.typeEnum])
      .filter((s): s is string => Boolean(s)),
  )];
  result.push({ blockName, typeEnums, parameters: recs });
}

writeFileSync(
  'samples/captured/decoded/labels/type-applicability.json',
  JSON.stringify(result, null, 2),
);

console.log(`Decoded ${result.length} blocks.\n`);
for (const b of result.sort((a, c) => c.parameters.length - a.parameters.length)) {
  const gated = b.parameters.filter((p) => !p.always);
  const universal = b.parameters.filter((p) => p.always);
  console.log(
    `  ${b.blockName.padEnd(15)} — ${b.parameters.length} param entries `
    + `(${universal.length} always-on, ${gated.length} type-gated)`
    + (b.typeEnums.length ? `  typeEnums: ${b.typeEnums.join(', ')}` : ''),
  );
}

console.log('\nSpot-check: where does DELAY_OFFSET ("Right Post Delay") apply?');
const delay = result.find((b) => b.blockName === 'Delay');
if (delay) {
  const offset = delay.parameters.filter((p) => p.parameterName === 'DELAY_OFFSET');
  for (const e of offset) {
    const gate = e.pageGate ?? e.controlGate;
    console.log('  ', JSON.stringify({
      parameterName: e.parameterName,
      always: e.always,
      gate,
      pages: e.pages,
      layers: e.pageLayers,
    }));
  }
}
