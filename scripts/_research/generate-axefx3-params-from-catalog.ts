/**
 * Emit `packages/axe-fx-iii/src/params.ts` — paramId/name catalog
 * seeded from the Ghidra-mined Axe-Edit III dispatcher table and
 * calibrated against AM4's hardware-verified display ranges where
 * the III's family matches AM4's.
 *
 * Background. Session 82 mined `FUN_140397a40`, the effect-type
 * dispatcher in Axe-Edit III v1.14.31. Each `case 0xN` of that switch
 * loads a 16-byte-strided `ParamDescriptor` table; we extracted
 * `(paramId, namePointer)` pairs from every table and wrote the result
 * to `samples/captured/decoded/ghidra-axeedit3-paramnames.json` —
 * 49 effect families, ~2.2k paramIds total. (The JSON is gitignored
 * under `samples/`; read it via the absolute path baked in below.)
 *
 * Two input sources are supported:
 *
 *   1. Ghidra JSON (primary, fresh re-mining):
 *      `samples/captured/decoded/ghidra-axeedit3-paramnames.json`.
 *      Used when present — this is the canonical source.
 *
 *   2. The committed `packages/axe-fx-iii/src/params.ts` itself
 *      (fallback). Parsed for its existing `PARAMS` array entries
 *      `(family, paramId, name)`. The committed file is, by
 *      construction, a faithful reproduction of the JSON, so this
 *      fallback re-emits the same shipping catalog without losing
 *      data. Used when the JSON is absent (e.g. running in a fresh
 *      worktree where `samples/` hasn't been populated).
 *
 * Either way, the emit step layers AM4-derived display calibration
 * over the catalog — see `./axefx3-am4-overrides.ts` for the join
 * strategy and caveats.
 *
 * What we KNOW about each entry:
 *   - the effect family (REVERB, DELAY, COMP, …)
 *   - the wire-level paramId within the family (14-bit slot in 0x02
 *     SET_PARAMETER frames; sentinels at 65520+ are firmware-internal
 *     markers like *_SET_ALL / *_VAL_ALL and are NOT addressable over
 *     the wire — they fail the encode14 range guard, but we keep them
 *     in the catalog because future Ghidra mining may give them a
 *     different role)
 *   - the symbol name Axe-Edit III uses internally (e.g. `REVERB_TYPE`,
 *     `COMP_THRESH`)
 *
 * What we INFER from AM4 (where the family maps cleanly):
 *   - display unit (dB, ms, knob 0..10, enum, …) — ported from the
 *     same-named AM4 param via AM4's hardware-verified catalog
 *   - display range (min, max)
 *   - per-param scaling (linear vs log10)
 *
 * Inferred entries are marked `// inferred from AM4` in the emitted
 * file so an audit can distinguish them from `'unverified'` entries
 * still awaiting III hardware confirmation. The inference is safe
 * because the AM4 and III share Fractal's design language — the
 * musically useful range of "reverb time" is the same on both
 * devices — but is NOT a substitute for III-side verification of
 * the wire-value scaling (16-bit linear vs log packing, sign/offset
 * conventions, etc.). When III hardware verification lands, the
 * `inferred` marker flips to `verified`.
 *
 * What we do NOT infer (deliberately):
 *   - enum value tables. AM4's `reverb.type` has 79 reverb algorithm
 *     names; the III's REVERB_TYPE has more. Copying AM4's names onto
 *     an III enum would be misleading. Inferred enum entries emit
 *     `unit: 'enum'` with no `enumValues` field — that's an honest
 *     "this is an enum, but the menu vocabulary is III-specific."
 *
 * Pipeline (idempotent — re-running emits a byte-stable file):
 *   1. Load catalog from JSON (if present) or from the committed
 *      params.ts (fallback). Either source produces the same
 *      `(family, paramId, name)` triples.
 *   2. Load AM4 calibration overrides from `cacheParams.ts`.
 *   3. Iterate families in dispatcher-case order, params in paramId
 *      ascending order.
 *   4. For each entry, look up an AM4 override by `(family, name)`.
 *      If a hit, emit calibrated fields + comment.
 *   5. Emit a TypeScript file with: Unit union, Param interface,
 *      `PARAMS` flat array, `PARAMS_BY_FAMILY` map, and
 *      `PARAM_BY_KEY` map keyed by `'FAMILY.NAME'`.
 *
 * Run with:
 *   npx tsx scripts/_research/generate-axefx3-params-from-catalog.ts
 *
 * Output is committed alongside this script — both files travel
 * together so future agents can reproduce.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findAm4Override,
  loadAm4ParamOverrides,
  loadXmlLabels,
  type Am4Override,
} from './axefx3-am4-overrides.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const CATALOG_PATH = join(
  REPO_ROOT,
  'samples',
  'captured',
  'decoded',
  'ghidra-axeedit3-paramnames.json',
);

const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages',
  'axe-fx-iii',
  'src',
  'params.ts',
);

// ── Catalog JSON shape ─────────────────────────────────────────────

interface CatalogParam {
  paramId: number;
  name: string;
}

interface CatalogCase {
  caseIdx: number;
  tableAddr: string;
  /** Absent on empty / unassigned dispatcher slots. */
  effectFamily?: string;
  paramCount: number;
  params: CatalogParam[];
}

interface Catalog {
  _source: string;
  _stride_bytes: number;
  _struct: string;
  effect_types: Record<string, CatalogCase>;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * TypeScript identifiers can't start with a digit and can't contain
 * special characters. The catalog's `name` field is the Axe-Edit III
 * internal symbol (e.g. `REVERB_TYPE`, `COMP_THRESH`) — those are
 * already valid TS identifiers, but we belt-and-suspenders the check
 * here in case a future catalog dump includes a stray character.
 */
function isValidIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Quote a string for emission as a TypeScript object key. Bare keys
 * for valid identifiers, single-quoted strings for everything else.
 */
function emitKey(s: string): string {
  return isValidIdentifier(s) ? s : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Escape a string for emission as a single-quoted TS string literal. */
function emitString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ── Catalog loaders (JSON primary, params.ts fallback) ─────────────

type FlatEntry = {
  family: string;
  paramId: number;
  name: string;
  caseIdx: number;
};

/**
 * Read the Ghidra-mined JSON catalog and produce sorted FlatEntry rows.
 * Throws if the file is malformed; caller should fall back to the
 * params.ts loader when the file is absent.
 */
function loadCatalogFromJson(): { flat: FlatEntry[]; cases: { effectFamily: string; caseIdx: number }[] } {
  const raw = readFileSync(CATALOG_PATH, 'utf8');
  const catalog: Catalog = JSON.parse(raw);
  const cases = Object.values(catalog.effect_types)
    .filter((c): c is CatalogCase & { effectFamily: string } =>
      typeof c.effectFamily === 'string' && c.params.length > 0,
    )
    .sort((a, b) => a.caseIdx - b.caseIdx);

  const flat: FlatEntry[] = [];
  for (const c of cases) {
    const sorted = [...c.params].sort((a, b) => a.paramId - b.paramId);
    for (const p of sorted) {
      flat.push({
        family: c.effectFamily,
        paramId: p.paramId,
        name: p.name,
        caseIdx: c.caseIdx,
      });
    }
  }
  return {
    flat,
    cases: cases.map((c) => ({ effectFamily: c.effectFamily, caseIdx: c.caseIdx })),
  };
}

/**
 * Fallback loader. Parses the committed `packages/axe-fx-iii/src/params.ts`
 * — specifically its `PARAMS` array entries — back into FlatEntry rows.
 * Used when the Ghidra JSON is absent (e.g. fresh worktrees without
 * `samples/`). The committed file is, by construction, an exact
 * representation of the JSON the last generator run consumed, so this
 * round-trip preserves the catalog faithfully.
 *
 * The synthetic caseIdx is a within-file appearance order — the
 * committed file groups by family in dispatcher-case order already,
 * so first-seen-family-index reproduces the original ordering for
 * byte-stable re-emit.
 */
function loadCatalogFromParamsTs(): { flat: FlatEntry[]; cases: { effectFamily: string; caseIdx: number }[] } {
  if (!existsSync(OUTPUT_PATH)) {
    throw new Error(
      `Neither the Ghidra JSON (${CATALOG_PATH}) nor the committed params.ts ` +
      `(${OUTPUT_PATH}) is readable. Cannot generate. Re-mine with ` +
      `scripts/ghidra/run-axeedit3-paramnames.cmd to produce the JSON.`,
    );
  }
  const src = readFileSync(OUTPUT_PATH, 'utf8');

  // Find the start of the PARAMS array literal and read entries until
  // the closing `];`. Each entry shape:
  //   { family: 'REVERB', paramId: 0, name: 'REVERB_TYPE', unit: 'unverified' },
  // We tolerate optional trailing fields (displayMin/displayMax/scaling)
  // and an optional trailing `// inferred from AM4` comment — those
  // come from prior calibrated runs.
  const startMarker = 'export const PARAMS: readonly Param[] = [';
  const startIdx = src.indexOf(startMarker);
  if (startIdx < 0) {
    throw new Error(
      `Fallback loader: could not locate PARAMS array in ${OUTPUT_PATH}. ` +
      `The committed file may have been hand-edited or the emit format changed.`,
    );
  }
  // Read until the matching '];' that terminates the array.
  const endIdx = src.indexOf('\n];', startIdx);
  if (endIdx < 0) {
    throw new Error(
      `Fallback loader: could not locate end of PARAMS array in ${OUTPUT_PATH}.`,
    );
  }
  const body = src.substring(startIdx + startMarker.length, endIdx);
  // Match each entry. Capture only `family`, `paramId`, `name` — the
  // rest is re-derived from AM4 overrides on this pass.
  const entryRe = /\{\s*family:\s*'([A-Z][A-Z0-9_]*)'\s*,\s*paramId:\s*(\d+)\s*,\s*name:\s*'([A-Z][A-Z0-9_]*)'/g;

  const flat: FlatEntry[] = [];
  // We assign caseIdx by first-seen-family order so the emit grouping
  // matches whatever order the existing file had — that's the original
  // dispatcher-case order.
  const familyCaseIdx = new Map<string, number>();
  let nextCaseIdx = 1;

  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    const family = m[1];
    const paramId = Number(m[2]);
    const name = m[3];
    let caseIdx = familyCaseIdx.get(family);
    if (caseIdx === undefined) {
      caseIdx = nextCaseIdx++;
      familyCaseIdx.set(family, caseIdx);
    }
    flat.push({ family, paramId, name, caseIdx });
  }

  if (flat.length === 0) {
    throw new Error(
      `Fallback loader: parsed 0 entries from ${OUTPUT_PATH} PARAMS array. ` +
      `Emit format probably changed; update the regex in loadCatalogFromParamsTs.`,
    );
  }

  // Build the cases list in first-seen order.
  const cases: { effectFamily: string; caseIdx: number }[] = [];
  for (const [family, idx] of familyCaseIdx) {
    cases.push({ effectFamily: family, caseIdx: idx });
  }
  cases.sort((a, b) => a.caseIdx - b.caseIdx);

  return { flat, cases };
}

// ── Main ───────────────────────────────────────────────────────────

function main(): void {
  // Source selection: JSON if available (canonical), otherwise the
  // committed params.ts (faithful fallback). Always emit the same
  // bytes for the same source — that's the idempotency contract.
  const useJson = existsSync(CATALOG_PATH);
  const { flat, cases } = useJson ? loadCatalogFromJson() : loadCatalogFromParamsTs();
  const catalogSource = useJson ? 'ghidra-axeedit3-paramnames.json' : 'committed params.ts (fallback)';

  // Load AM4 calibration overrides up-front. Map of 'block.name' →
  // hardware-verified unit/range. Joined per III catalog entry below.
  const am4Overrides = loadAm4ParamOverrides();

  // Load AxeEdit III JUCE-BinaryData XML labels. Map of parameterName →
  // {displayLabel, controlType}. Used in two ways inside findAm4Override:
  // (1) lossless displayLabel overlay onto whichever calibration source
  // wins, (2) 3rd-tier controlType→unit inference when AM4 + universal
  // both miss. Empty map when the JSON artifact isn't present (fresh
  // worktree without `samples/` populated) — the generator falls back
  // to AM4 + universal sources only and the III file simply ships
  // fewer display labels.
  const xmlLabels = loadXmlLabels();

  // Sanity: count per family.
  const familyCounts: Record<string, number> = {};
  for (const e of flat) {
    familyCounts[e.family] = (familyCounts[e.family] ?? 0) + 1;
  }

  // Duplicate-key detection on (family, name) — the natural composite
  // key for our keyed lookup. This SHOULD be unique because the symbol
  // names mined from Axe-Edit III are themselves unique within a
  // family. If this ever fails, the catalog has an extraction bug.
  const seenFamName = new Set<string>();
  const dupFamName: string[] = [];
  for (const e of flat) {
    const k = `${e.family}.${e.name}`;
    if (seenFamName.has(k)) dupFamName.push(k);
    seenFamName.add(k);
  }
  if (dupFamName.length > 0) {
    throw new Error(
      `generator: catalog has ${dupFamName.length} duplicate (family, name) ` +
      `entries — refusing to emit. First few: ${dupFamName.slice(0, 5).join(', ')}`,
    );
  }

  // (family, paramId) is NOT a uniqueness constraint in this catalog.
  // Some families (notably FLANGER) keep firmware-legacy overlays —
  // new symbols at paramId 0..N (e.g. `FLANGER_TYPE` at 0) alongside
  // old symbols at the same IDs (`FLANGER_OLD_TYPE` at 0) so stored
  // presets from older firmware still decode. We surface a count so
  // it's visible in generator output, but the overlay is intentional
  // and shipped as-is in the emitted catalog.
  const paramIdSeen = new Set<string>();
  let overlayCount = 0;
  for (const e of flat) {
    const k = `${e.family}.${e.paramId}`;
    if (paramIdSeen.has(k)) overlayCount += 1;
    paramIdSeen.add(k);
  }

  const totalCount = flat.length;
  const familyCount = cases.length;

  // Pre-compute the calibration override (if any) for every entry —
  // used by every emit step below. Deterministic and pure. Two sources
  // contribute: AM4-name joins (verified, copied from AM4's catalog)
  // and universal Fractal-convention fallbacks (BYPASS/PAN/GLOBALMIX/
  // SCENEIGNORE/MIX shapes that hold cross-block on every Fractal
  // device). See `axefx3-am4-overrides.ts` for the two-tier resolution
  // contract.
  const overrideByEntry: Map<string, Am4Override | undefined> = new Map();
  let calibratedCount = 0;
  let calibratedFromAm4 = 0;
  let calibratedFromConvention = 0;
  let calibratedFromXml = 0;
  let withDisplayLabel = 0;
  const calibratedByFamily: Record<string, number> = {};
  for (const e of flat) {
    const ov = findAm4Override(e.family, e.name, am4Overrides, xmlLabels);
    const key = `${e.family}.${e.name}`;
    overrideByEntry.set(key, ov);
    if (ov) {
      // "Calibrated" = unit is non-'unverified' (carries useful shape
      // info). Label-only XML synthetics (unit still 'unverified', but
      // displayLabel populated) don't count as calibrated, but DO
      // contribute to withDisplayLabel.
      if (ov.unit !== 'unverified') {
        calibratedCount += 1;
        if (ov.source === 'universal') calibratedFromConvention += 1;
        else if (ov.source === 'xml') calibratedFromXml += 1;
        else calibratedFromAm4 += 1;
        calibratedByFamily[e.family] = (calibratedByFamily[e.family] ?? 0) + 1;
      }
      if (ov.displayLabel) withDisplayLabel += 1;
    }
  }

  // ── Emit helper: one Param literal ───────────────────────────────
  //
  // Calibrated entries carry `unit`, `displayMin`, `displayMax`,
  // optional `scaling`, plus the `// inferred from AM4` trailing
  // comment. Uncalibrated entries stay `unit: 'unverified'`.
  //
  // The Unit union emitted at the top of the file enumerates the
  // calibrated units actually used + the always-present 'unverified'
  // sentinel — so an entry like `unit: 'knob_0_10'` typechecks
  // without manual maintenance of the union.
  function emitEntry(e: FlatEntry, indent: string): string {
    const head = `${indent}{ family: ${emitString(e.family)}, paramId: ${e.paramId}, name: ${emitString(e.name)},`;
    const ov = overrideByEntry.get(`${e.family}.${e.name}`);
    if (!ov) {
      return `${head} unit: 'unverified' },`;
    }

    // Source-stamped trailing comment. The three tiers each emit a
    // distinct phrase so a future audit can separate provenance lanes
    // by grep without re-running the generator.
    const trailingComment = (() => {
      switch (ov.source) {
        case 'am4': return '// inferred from AM4';
        case 'universal': return '// inferred from Fractal convention';
        case 'xml': return ov.unit === 'unverified'
          ? '// label from AxeEdit III XML'
          : '// inferred from AxeEdit III XML controlType';
      }
    })();

    // Optional displayLabel — present whenever the XML mining matched
    // this III symbol, regardless of which calibration tier supplied
    // the unit. Emitted before unit for readability (callers scan
    // human labels first when debugging).
    const labelClause = ov.displayLabel
      ? ` displayLabel: ${emitString(ov.displayLabel)},`
      : '';

    // Label-only synthetics (XML matched but controlType wasn't in
    // our inference table — e.g. label*, readoutNameLong, dynaCabControl)
    // emit `unit: 'unverified'` so they're indistinguishable from
    // un-matched entries except for the displayLabel field.
    if (ov.unit === 'unverified') {
      return `${head}${labelClause} unit: 'unverified' }, ${trailingComment}`;
    }
    // For enum entries: emit `unit: 'enum'` WITHOUT displayMin /
    // displayMax. AM4's enum cardinality is firmware-specific (AM4's
    // REVERB has 79 algorithms; the III has more), and surfacing AM4's
    // count would falsely suggest the III's vocabulary is bounded the
    // same way. The III's enum vocabulary needs III-side Ghidra mining
    // or hardware capture. XML-source enums also have no enumValues
    // because the layout XML doesn't expose the value menu.
    if (ov.enum || ov.unit === 'enum') {
      return `${head}${labelClause} unit: 'enum' }, ${trailingComment}`;
    }
    // XML-source numeric / dB entries carry unit but no range — XML
    // mining recovers controlType, not the knob's numeric bounds.
    // Omit displayMin/displayMax in that case rather than emitting
    // NaN.
    if (ov.displayMin === undefined || ov.displayMax === undefined) {
      return `${head}${labelClause} unit: ${emitString(ov.unit)} }, ${trailingComment}`;
    }
    const scalingClause = ov.scaling
      ? `, scaling: ${emitString(ov.scaling)}`
      : '';
    return `${head}${labelClause} unit: ${emitString(ov.unit)}, displayMin: ${formatNumeric(ov.displayMin)}, displayMax: ${formatNumeric(ov.displayMax)}${scalingClause} }, ${trailingComment}`;
  }

  // Collect the set of distinct calibrated units actually used, so
  // the Unit union exactly matches what's in the file. 'unverified'
  // is always part of the union (for un-ported entries).
  const usedUnits = new Set<string>(['unverified']);
  for (const ov of overrideByEntry.values()) {
    if (ov) usedUnits.add(ov.unit);
  }
  const unitUnion = [...usedUnits].sort().map((u) => `'${u}'`).join(' | ');

  // ── Emit TypeScript ──────────────────────────────────────────────

  const calibratedSummary = Object.entries(calibratedByFamily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fam, n]) => `${fam}=${n}`)
    .join(', ');

  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * Axe-Fx III parameter catalog.");
  lines.push(" *");
  lines.push(" * Auto-generated by");
  lines.push(" *   scripts/_research/generate-axefx3-params-from-catalog.ts");
  lines.push(" * from");
  lines.push(" *   samples/captured/decoded/ghidra-axeedit3-paramnames.json");
  lines.push(" * (Ghidra-mined Axe-Edit III v1.14.31 effect-type dispatcher");
  lines.push(" * FUN_140397a40 — Session 82), with AM4-derived display");
  lines.push(" * calibration layered on top (see");
  lines.push(" * `scripts/_research/axefx3-am4-overrides.ts`). DO NOT HAND-EDIT");
  lines.push(" * — re-run the generator to refresh.");
  lines.push(" *");
  lines.push(" * Coverage:");
  lines.push(` *   - ${totalCount} parameters across ${familyCount} effect families.`);
  lines.push(` *   - ${calibratedCount} entries carry inferred display calibration`);
  lines.push(" *     (non-`'unverified'` unit + optional displayMin/Max + optional scaling).");
  lines.push(` *       • ${calibratedFromAm4} via AM4 symbol-name join — trailing`);
  lines.push(" *         `// inferred from AM4`. Hardware-verified on AM4;");
  lines.push(" *         display convention shared with the III.");
  lines.push(` *       • ${calibratedFromConvention} via universal Fractal-convention`);
  lines.push(" *         fallback — trailing `// inferred from Fractal convention`.");
  lines.push(" *         Suffixes like `*_BYPASS`, `*_PAN`, `*_GLOBALMIX`,");
  lines.push(" *         `*_SCENEIGNORE`, `*_MIX` whose calibration is stable");
  lines.push(" *         across every Fractal block.");
  lines.push(` *       • ${calibratedFromXml} via AxeEdit III XML controlType — trailing`);
  lines.push(" *         `// inferred from AxeEdit III XML controlType`. Distinguishes");
  lines.push(" *         enum-vs-numeric-vs-dB widgets from the JUCE BinaryData");
  lines.push(" *         layout XML; carries no range info, so displayMin/Max omitted.");
  lines.push(` *   - ${withDisplayLabel} entries carry a \`displayLabel\` (the editor's`);
  lines.push(" *     knob caption — e.g. `'Drive'` for `DISTORT_DRIVE`). Independent of");
  lines.push(" *     calibration tier — XML labels overlay onto AM4/universal/XML units.");
  lines.push(` *   - ${totalCount - calibratedCount} entries remain \`unit: 'unverified'\``);
  lines.push(" *     (III-specific blocks like FUZZ/IRPLAYER without enum-shape labels,");
  lines.push(" *     or symbols absent from both AM4 and the XML mining catalog).");
  lines.push(" *");
  lines.push(" * Calibration sources (per-family inferred count):");
  if (calibratedSummary.length > 0) {
    lines.push(` *   ${calibratedSummary}`);
  } else {
    lines.push(" *   (none — AM4 cacheParams.ts is empty?)");
  }
  lines.push(" *");
  lines.push(" * Inferred-from-AM4 caveat:");
  lines.push(" *   - AM4 is the closest hardware-verified analog Fractal device.");
  lines.push(" *     Same vendor, same naming convention, similar musical scope.");
  lines.push(" *     The inferred display range (e.g. reverb time 0.1..100 s,");
  lines.push(" *     drive 0..10 knob) is correct as a *display* convention —");
  lines.push(" *     this is what Fractal's UI shows for the knob across both");
  lines.push(" *     devices.");
  lines.push(" *   - The III's wire encoding for the displayed value is NOT");
  lines.push(" *     yet verified. AM4 packs values into normalized [0,1] Q15;");
  lines.push(" *     the III packs into a 16-bit linear field via packValue16.");
  lines.push(" *     Display↔wire conversion still requires III-side capture.");
  lines.push(" *   - Enum entries inherit `unit: 'enum'` from AM4 but DO NOT");
  lines.push(" *     ship AM4's enumValues table. III firmware adds reverb");
  lines.push(" *     types, amp models, etc. post-AM4 — copying AM4's vocabulary");
  lines.push(" *     verbatim would mislead the agent. The III's enum vocabulary");
  lines.push(" *     needs III-side Ghidra mining or hardware capture.");
  lines.push(" *");
  lines.push(" * Wire constraints (see ./setParam.ts):");
  lines.push(" *   - paramId is sent as a 14-bit septet pair → wire range is");
  lines.push(" *     0..16383. Catalog entries with paramId >= 65520 are");
  lines.push(" *     firmware-internal sentinels (e.g. *_SET_ALL, *_VAL_ALL)");
  lines.push(" *     and are NOT addressable via 0x02 SET_PARAMETER — they");
  lines.push(" *     will fail the encode14 range guard. They are retained in");
  lines.push(" *     this catalog as documentary entries because they show up");
  lines.push(" *     in the dispatcher tables; tooling that resolves a name to");
  lines.push(" *     a paramId should filter > 16383 before attempting a wire");
  lines.push(" *     write.");
  lines.push(" *");
  lines.push(" * Firmware-legacy overlays:");
  lines.push(" *   - (family, paramId) is NOT unique. Some families (notably");
  lines.push(" *     FLANGER) keep older symbol names alongside the current");
  lines.push(" *     ones at the same paramIds (e.g. `FLANGER_TYPE` and");
  lines.push(" *     `FLANGER_OLD_TYPE` both at paramId 0). The duplicates are");
  lines.push(" *     intentional — older firmware presets store under the");
  lines.push(" *     `_OLD_` symbols, while new writes use the current names.");
  lines.push(" *     The composite key `(family, name)` IS unique; use");
  lines.push(" *     `PARAM_BY_KEY` for stable lookup.");
  lines.push(" *");
  lines.push(" * 🟢 SET wire shape byte-verified Session 97 against 10 public");
  lines.push(" * captures: `fn=0x01` + sub-action `09 00` (typed-input), 23-byte");
  lines.push(" * envelope. NOT the pre-Session-97 `fn=0x02` II-port. Capture");
  lines.push(" * corpus + field layout: `docs/devices/axe-fx-iii/set-parameter-captures.md`.");
  lines.push(" * 🟡 GET response shape still unverified — the `04 01`");
  lines.push(" * STATE_BROADCAST appears to be an AxeEdit-driven heartbeat poll,");
  lines.push(" * NOT a sync SET echo. See `docs/devices/axe-fx-iii/SYSEX-MAP.md` §0x01.");
  lines.push(" */");
  lines.push("");
  lines.push("// ── Types ──────────────────────────────────────────────────────────");
  lines.push("");
  lines.push("/**");
  lines.push(" * Display-unit tag for an Axe-Fx III parameter.");
  lines.push(" *");
  lines.push(" * `'unverified'` is the default for entries the generator could");
  lines.push(" * not infer (the AM4 has no matching parameter, or the III family");
  lines.push(" * has no AM4 analog). Other tags are AM4-derived display");
  lines.push(" * conventions — they describe the user-facing scale (dB, ms,");
  lines.push(" * knob_0_10, etc.) but NOT the III's wire encoding. Display↔wire");
  lines.push(" * conversion is still the caller's responsibility on the III");
  lines.push(" * until hardware verification lands.");
  lines.push(" */");
  lines.push(`export type Unit = ${unitUnion};`);
  lines.push("");
  lines.push("/** One entry in the Axe-Fx III parameter catalog. */");
  lines.push("export interface Param {");
  lines.push("  /**");
  lines.push("   * Effect family symbol (e.g. `'REVERB'`, `'DELAY'`, `'COMP'`).");
  lines.push("   * Sourced from the dispatcher's case → table-of-params mapping.");
  lines.push("   */");
  lines.push("  family: string;");
  lines.push("  /**");
  lines.push("   * Parameter ID within the family. Wire-encoded as a 14-bit");
  lines.push("   * septet pair in 0x02 SET_PARAMETER frames. Values >= 65520 are");
  lines.push("   * firmware-internal sentinels and NOT wire-addressable — see");
  lines.push("   * file-level header for details.");
  lines.push("   */");
  lines.push("  paramId: number;");
  lines.push("  /**");
  lines.push("   * Symbol name from Axe-Edit III's binary (e.g. `'REVERB_TYPE'`).");
  lines.push("   * Stable across firmware releases of the same generation.");
  lines.push("   */");
  lines.push("  name: string;");
  lines.push("  /**");
  lines.push("   * Human-readable display label from the AxeEdit III JUCE-BinaryData");
  lines.push("   * XML mining — the editor's knob caption (e.g. `'Drive'` for");
  lines.push("   * `DISTORT_DRIVE`, `'Reverb Time'` for `REVERB_TIME`). Populated");
  lines.push("   * for ~91% of catalog entries; absent for symbols the editor");
  lines.push("   * doesn't render (firmware-internal blocks, sentinel paramIds).");
  lines.push("   * Useful as LLM prompt context independent of unit/range.");
  lines.push("   */");
  lines.push("  displayLabel?: string;");
  lines.push("  /**");
  lines.push("   * Display unit tag. `'unverified'` until III hardware confirms");
  lines.push("   * the real shape; otherwise inferred from one of three sources");
  lines.push("   * (see file-level header for provenance — these are display");
  lines.push("   * conventions, not wire encodings).");
  lines.push("   */");
  lines.push("  unit: Unit;");
  lines.push("  /**");
  lines.push("   * Display range minimum. Populated for AM4-inferred entries");
  lines.push("   * (`// inferred from AM4` trailing comment), absent for");
  lines.push("   * `unit: 'unverified'` entries.");
  lines.push("   */");
  lines.push("  displayMin?: number;");
  lines.push("  /** Display range maximum. Same population rule as `displayMin`. */");
  lines.push("  displayMax?: number;");
  lines.push("  /**");
  lines.push("   * Optional non-linear scaling, AM4-inferred. `'log10'` for");
  lines.push("   * time / frequency knobs that span multiple decades. Absent");
  lines.push("   * for linear knobs or `'unverified'` entries.");
  lines.push("   */");
  lines.push("  scaling?: 'linear' | 'log10';");
  lines.push("}");
  lines.push("");
  lines.push("// ── Catalog data ───────────────────────────────────────────────────");
  lines.push("");
  lines.push("/**");
  lines.push(" * Flat catalog of every (family, paramId) entry mined from the");
  lines.push(" * Axe-Edit III dispatcher. Sorted by family-case-index ascending,");
  lines.push(" * then paramId ascending within each family, for byte-stable");
  lines.push(" * regeneration.");
  lines.push(" */");
  lines.push("export const PARAMS: readonly Param[] = [");
  for (const e of flat) {
    lines.push(emitEntry(e, '  '));
  }
  lines.push("];");
  lines.push("");
  lines.push("/**");
  lines.push(" * Lookup by family symbol. Each family's entry preserves the");
  lines.push(" * paramId-ascending order from `PARAMS`.");
  lines.push(" */");
  lines.push("export const PARAMS_BY_FAMILY: Readonly<Record<string, readonly Param[]>> = {");
  // Group while preserving caseIdx ordering.
  const byFamily = new Map<string, FlatEntry[]>();
  for (const e of flat) {
    let arr = byFamily.get(e.family);
    if (!arr) {
      arr = [];
      byFamily.set(e.family, arr);
    }
    arr.push(e);
  }
  for (const [family, entries] of byFamily) {
    lines.push(`  ${emitKey(family)}: [`);
    for (const e of entries) {
      lines.push(emitEntry(e, '    '));
    }
    lines.push(`  ],`);
  }
  lines.push("};");
  lines.push("");
  lines.push("/**");
  lines.push(" * Lookup by `'FAMILY.NAME'` (the catalog's natural composite key).");
  lines.push(" * Example: `PARAM_BY_KEY['REVERB.REVERB_TYPE']` → the Reverb Type");
  lines.push(" * entry. Use this when callers reference a param by its symbolic");
  lines.push(" * name; use `PARAMS_BY_FAMILY[family]` when iterating a whole");
  lines.push(" * family.");
  lines.push(" */");
  lines.push("export const PARAM_BY_KEY: Readonly<Record<string, Param>> = {");
  for (const e of flat) {
    const key = `${e.family}.${e.name}`;
    // Reuse emitEntry by stripping the trailing comma + comment so the
    // line slots into an object-literal value slot cleanly.
    const entry = emitEntry(e, '');
    // emitEntry returns one of:
    //   `{ family: 'X', ... unit: 'unverified' },`
    //   `{ family: 'X', ... }, // inferred from AM4`
    //   `{ family: 'X', ... }, // inferred from Fractal convention`
    //   `{ family: 'X', ... }, // inferred from AxeEdit III XML controlType`
    //   `{ family: 'X', ... }, // label from AxeEdit III XML`
    // We need the bare object literal followed by `,` for the key
    // map, with the source comment preserved at end-of-line. The
    // permissive `(?:inferred|label) from …` form matches all four
    // commented variants without lock-in to one phrasing.
    const commentMatch = entry.match(/(\/\/ (?:inferred|label) from [^\n]+)$/);
    const trailingComment = commentMatch ? ` ${commentMatch[1]}` : '';
    const bareObject = entry
      .replace(/, \/\/ (?:inferred|label) from [^\n]+$/, '')
      .replace(/,$/, '');
    lines.push(`  ${emitKey(key)}: ${bareObject},${trailingComment}`);
  }
  lines.push("};");
  lines.push("");
  lines.push("/** Family symbols present in the catalog, in dispatcher-case order. */");
  lines.push("export const FAMILIES: readonly string[] = [");
  for (const family of byFamily.keys()) {
    lines.push(`  ${emitString(family)},`);
  }
  lines.push("];");
  lines.push("");

  writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');

  // Generator self-report.
  const familySummary = cases
    .map((c) => `${c.effectFamily}=${familyCounts[c.effectFamily!]}`)
    .join(', ');
  console.log(
    `generate-axefx3-params-from-catalog: wrote ${OUTPUT_PATH}\n` +
    `  source: ${catalogSource}\n` +
    `  ${totalCount} params across ${familyCount} families\n` +
    `  ${calibratedCount} entries calibrated (` +
      `${calibratedFromAm4} via AM4 join, ` +
      `${calibratedFromConvention} via Fractal-convention fallback, ` +
      `${calibratedFromXml} via AxeEdit III XML controlType)\n` +
    `  ${withDisplayLabel} entries carry displayLabel from AxeEdit III XML\n` +
    `  calibrated by family: ${calibratedSummary || '(none)'}\n` +
    `  ${overlayCount} firmware-legacy paramId overlays (FLANGER_OLD_* etc.)\n` +
    `  families: ${familySummary}`,
  );
}

/**
 * Format a number for emit as a TS numeric literal. Integers emit as
 * integers; floats emit with their minimum-precision string (no
 * trailing zero padding, no exponent unless huge). Negative values
 * preserved. The goal is byte-stability and readability — round-trip
 * `parseFloat(formatNumeric(x)) === x` for the AM4 source values we
 * see (integers, halves, decimal cents like 0.1, 10000, -100).
 */
function formatNumeric(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Avoid scientific notation; AM4 ranges fit comfortably in fixed.
  // `String(0.1)` returns `'0.1'`, `String(-100.5)` returns `'-100.5'` —
  // both fine. Larger floats round-trip via JS's default formatter.
  return String(n);
}

main();
