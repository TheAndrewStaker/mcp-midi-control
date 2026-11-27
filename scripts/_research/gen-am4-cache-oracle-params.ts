/**
 * gen-am4-cache-oracle-params.ts
 *
 * Emits `packages/fractal-midi/src/am4/cacheOracleParams.generated.ts`:
 * draft KNOWN_PARAMS-shape registrations sourced from the SOLVED
 * effectDefinitions cache walk (the AM4-native range/label oracle that
 * HW-129 said did not exist).
 *
 * Inputs:
 *   - samples/captured/local-caches-2026-06-09/effectDefinitions_15_2p0.walk.json
 *     (strict.py zero-resync walk of the real-device-synced AM4 cache;
 *     record fields: min, max, def(=display scale; display = field*scale), step)
 *   - samples/captured/decoded/ghidra-am4-paramnames.json (firmware symbol
 *     names per family; DISTORT = amp section 10, GLOBAL = section 1)
 *   - KNOWN_PARAMS from packages/fractal-midi/src/am4/params.ts (shipped truth)
 *
 * Outputs (NOT wired into KNOWN_PARAMS; review + spread is the integration):
 *   - AMP_GHOST_PARAMS: unshipped amp (pidLow 0x3a / cache section 10) records
 *     with a firmware name. HW-129 GHOSTs.
 *   - SYSTEM_PARAM_UPDATES: corrected/refined entries for shipped global
 *     (pidLow 0x01 / cache section 1) params where the cache record disagrees
 *     with or refines the shipped placeholder.
 *
 * Run: npx tsx scripts/_research/gen-am4-cache-oracle-params.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { KNOWN_PARAMS } from '../../packages/fractal-midi/src/am4/params.js';

const WALK = 'samples/captured/local-caches-2026-06-09/effectDefinitions_15_2p0.walk.json';
const GHIDRA = 'samples/captured/decoded/ghidra-am4-paramnames.json';
const OUT = 'packages/fractal-midi/src/am4/cacheOracleParams.generated.ts';

interface WalkRec {
  kind: 'float' | 'enum';
  section: number;
  offset: number;
  id: number;
  tc: number;
  min: number;
  max: number;
  /** Display scale: display = field * def. (Named `def` in the walk JSON.) */
  def: number;
  step: number;
  count?: number;
  values?: string[];
}

const walk = JSON.parse(readFileSync(WALK, 'utf8')) as { records: WalkRec[] };
const bySection = new Map<number, Map<number, WalkRec>>();
for (const r of walk.records) {
  if (r.id >= 0xff00) continue;
  if (!bySection.has(r.section)) bySection.set(r.section, new Map());
  bySection.get(r.section)!.set(r.id, r);
}
const sec10 = bySection.get(10)!; // DISTORT (amp @ pidLow 0x3a)
const sec1 = bySection.get(1)!;   // GLOBAL  (system @ pidLow 0x01)

const ghidra = JSON.parse(readFileSync(GHIDRA, 'utf8')) as {
  effect_types: Record<string, { effectFamily?: string; params?: Array<{ paramId: number; name: string }> }>;
};
const familyNames = (family: string): Map<number, string> => {
  for (const v of Object.values(ghidra.effect_types)) {
    if (v.effectFamily === family && v.params) return new Map(v.params.map((p) => [p.paramId, p.name]));
  }
  throw new Error(`family ${family} not found`);
};
const DISTORT = familyNames('DISTORT');

// Shipped registrations keyed by pidHigh, per (block, pidLow) bank.
const shippedAmp3a = new Map<number, { key: string; p: (typeof KNOWN_PARAMS)[keyof typeof KNOWN_PARAMS] }>();
const shippedGlobal = new Map<number, { key: string; p: (typeof KNOWN_PARAMS)[keyof typeof KNOWN_PARAMS] }>();
for (const [key, p] of Object.entries(KNOWN_PARAMS)) {
  if (p.block === 'amp' && p.pidLow === 0x3a) shippedAmp3a.set(p.pidHigh, { key, p });
  if (p.block === 'global' && p.pidLow === 0x01) shippedGlobal.set(p.pidHigh, { key, p });
}

// ---------------------------------------------------------------------------
// Curated decisions (each names its evidence / reason)
// ---------------------------------------------------------------------------

/** HW-129 Tier-2: amp-model-internal classification codes. The cache now
 * supplies AM4-native label sets (the label oracle HW-129 lacked), but
 * writing these desyncs the amp model (III __amp_layout.xml uses them as
 * controllingParam gates). Recommend READ-ONLY exposure. */
const TIER2_TYPE_CODES = new Set([28, 37, 41, 44, 98, 118]);

/** HW-129 Tier-3 (do not register): monitors / version stamps. */
const AMP_TIER3_EXCLUDE = new Set([89]); // DISTORT_VERSION (degenerate cache range 0..0)

/** Global pids deliberately NOT updated, with reasons (kept in the findings doc):
 * 15 delayspill: cache label diff is cosmetic ('DLY & REV' vs shipped
 *    hardware-probed 'Delay & Rev'); shipped enum is front-panel-verified.
 * 104 tuneraccidentals: HARD ORDER CONFLICT, cache [MIXED, ALL FLATS, ALL
 *    SHARPS] vs 2026-06-05 front-panel probe [Flats, Both, Sharps]. Front
 *    panel is ground truth; cache version withheld pending a re-probe. */
const GLOBAL_SKIP = new Set([15, 104]);

/** Friendly name for new amp entries, from the firmware symbol. */
const AMP_NAME: Record<number, string> = {
  19: 'xfleakage',   // DISTORT_XFLEAKAGE
  27: 'offset1',     // DISTORT_OFFSET1
  28: 'cliptype2',   // DISTORT_CLIPTYPE2
  37: 'drivetype',   // DISTORT_DRIVETYPE
  39: 'wshpf',       // DISTORT_WSHPF
  41: 'tonetype',    // DISTORT_TONETYPE
  44: 'fbtype',      // DISTORT_FBTYPE
  45: 'pi_ratio',    // DISTORT_PI_RATIO
  98: 'biastype',    // DISTORT_BIASTYPE
  118: 'precomptype', // DISTORT_PRECOMPTYPE
};

/** Typecodes hardware-confirmed log10 (gen-params-from-cache.ts history).
 * 0x42 confirmed 2026-11-26 (fw 2.02): amp High Cut Frequency wire 0.958
 * reads 32999 Hz in AM4-Edit (log10; linear would be 38345) and Depth Freq
 * wire 0.699 reads 250 Hz (linear 364). 0x43/0x45 stay taper-OPEN: the
 * 0x40-bit-and-not-0x20-bit rule predicts log10 but is not confirmed, so
 * they stay linear here with a comment. */
const LOG10_CONFIRMED = new Set([0x40, 0x42, 0x44, 0x48, 0x50]);

// ---------------------------------------------------------------------------
// Unit inference: typecode low nibble = unit family (1=dB 2=Hz 3=s 4=ms
// 5=percent 6=deg 7=cents[inferred] 8=pF 0=unitless), disambiguated by the
// record's display scale so the emitted Unit's DISPLAY_TO_INTERNAL factor
// matches the cache scale (encode correctness).
// ---------------------------------------------------------------------------
interface Inferred { unit: string; displayUnit?: string; note?: string }

function inferFloatUnit(r: WalkRec): Inferred {
  const nib = r.tc & 0x0f;
  const sc = r.def;
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 0.001 * Math.max(1, Math.abs(b));
  if (close(sc, 10)) return { unit: 'knob_0_10' };
  if (close(sc, 20)) return { unit: 'knob_0_20' };
  if (close(sc, 100)) return { unit: r.min < 0 ? 'bipolar_percent' : 'percent' };
  if (close(sc, 1000)) return { unit: 'ms' };
  if (close(sc, 1000000)) return { unit: 'pf' };
  if (close(sc, 57.29577951308232)) return { unit: 'degrees' };
  if (close(sc, 31.83098793029785)) return { unit: 'rotary_mic_spacing' };
  if (close(sc, 12)) return { unit: 'amp_geq_band' };
  if (close(sc, 1)) {
    switch (nib) {
      case 1: return { unit: 'db' };
      case 2: return { unit: 'hz' };
      case 3: return { unit: 'seconds' };
      case 5: return { unit: 'count', displayUnit: '%', note: 'tc says percent-family but cache scale=1 (wire = display 1:1); percent Unit would mis-encode by 100x, so count + cosmetic % suffix' };
      case 7: return { unit: 'count', displayUnit: 'cents', note: 'tc unit-family 7 unmapped; cents inferred from range/step and tuner context, UNCONFIRMED' };
      default: return { unit: 'count' };
    }
  }
  return { unit: 'count', note: `UNRESOLVED cache scale ${sc}; verify before wiring` };
}

function inferScaling(r: WalkRec, displayMin: number): { scaling?: 'log10'; note?: string } {
  if (LOG10_CONFIRMED.has(r.tc) && displayMin > 0) return { scaling: 'log10' };
  if ((r.tc & 0x40) !== 0 && (r.tc & 0x20) === 0 && r.kind === 'float') {
    return { note: `taper OPEN: tc=0x${r.tc.toString(16)} predicts log10 under the 0x40-and-not-0x20 rule (unconfirmed); linear until verified` };
  }
  return {};
}

const round6 = (n: number): number => Number(n.toFixed(6));

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function fmtEnumValues(values: string[], base: number): string {
  // Compact CC-list form: emitted via the ccLabels() helper after verifying
  // the cache list matches the CC #1..CC #127 [+NONE [+PEDAL 1, PEDAL 2]] pattern.
  const isCc = values.length >= 127 && values.slice(0, 127).every((v, i) => v === `CC #${i + 1}`);
  if (isCc && base === 1) {
    const tail = values.slice(127);
    const expectTails: Record<number, string[]> = { 0: [], 1: ['NONE'], 3: ['NONE', 'PEDAL 1', 'PEDAL 2'] };
    const exp = expectTails[tail.length];
    if (exp && tail.every((v, i) => v === exp[i])) return `ccLabels(${values.length})`;
  }
  const items = values.map((v, i) => `${i + base}: '${esc(v)}'`);
  // wrap at ~100 cols
  const lines: string[] = [];
  let cur = '      ';
  for (const it of items) {
    if (cur.length + it.length + 2 > 100) { lines.push(cur); cur = '      '; }
    cur += `${it}, `;
  }
  lines.push(cur);
  return `{\n${lines.join('\n').replace(/, $/, ',')}\n    }`;
}

interface EmitEntry {
  key: string;
  comment: string[];
  fields: string[];
}

function fmtEntry(e: EmitEntry): string {
  const lines: string[] = [];
  for (const c of e.comment) lines.push(`  // ${c}`);
  lines.push(`  '${e.key}': {`);
  for (const f of e.fields) lines.push(`    ${f},`);
  lines.push('  },');
  return lines.join('\n');
}

const recCite = (sec: number, r: WalkRec): string =>
  r.kind === 'enum'
    ? `cache: section ${sec} id ${r.id}, tc=0x${r.tc.toString(16).padStart(2, '0')}, enum n=${r.count}`
    : `cache: section ${sec} id ${r.id}, tc=0x${r.tc.toString(16).padStart(2, '0')}, ` +
      `display [${round6(r.min * r.def)}..${round6(r.max * r.def)}] step ${round6(r.step * r.def)} (scale ${round6(r.def)})`;

// ---------------------------------------------------------------------------
// AMP_GHOST_PARAMS
// ---------------------------------------------------------------------------
const ampEntries: EmitEntry[] = [];
const ampFieldOnly: WalkRec[] = [];
for (const [id, r] of [...sec10.entries()].sort((a, b) => a[0] - b[0])) {
  if (shippedAmp3a.has(id)) continue;
  const sym = DISTORT.get(id);
  if (!sym) { ampFieldOnly.push(r); continue; }
  if (AMP_TIER3_EXCLUDE.has(id)) continue;
  const name = AMP_NAME[id];
  if (!name) throw new Error(`no curated name for DISTORT id ${id} (${sym})`);
  const comment: string[] = [`${sym} -- ${recCite(10, r)}`];
  const fields: string[] = [
    `block: 'amp', name: '${name}'`,
    `pidLow: 0x003a, pidHigh: 0x${id.toString(16).padStart(4, '0')}`,
  ];
  if (r.kind === 'enum') {
    if (TIER2_TYPE_CODES.has(id)) {
      comment.push('HW-129 Tier-2: amp-model-internal type code. Labels are AM4-native (cache oracle),');
      comment.push('but arbitrary writes desync the amp model; recommend READ-ONLY exposure.');
    }
    fields.push(`unit: 'enum', displayMin: 0, displayMax: ${r.count! - 1}`);
    fields.push(`enumValues: ${fmtEnumValues(r.values!, 0)}`);
  } else {
    const lo = round6(r.min * r.def);
    const hi = round6(r.max * r.def);
    const inf = inferFloatUnit(r);
    const unit = id === 45 ? 'ratio' : inf.unit; // PI_RATIO: unitless scale-1; 'ratio' matches the symbol semantics
    if (inf.note) comment.push(inf.note);
    comment.push('HW-129 Tier-1: continuous no-UI advanced register (device ACKs; no front-panel display).');
    fields.push(`unit: '${unit}', displayMin: ${lo}, displayMax: ${hi}`);
    const sc = inferScaling(r, lo);
    if (sc.scaling) fields.push(`scaling: '${sc.scaling}'`);
    if (sc.note) comment.push(sc.note);
    if (inf.displayUnit) fields.push(`displayUnit: '${esc(inf.displayUnit)}'`);
  }
  ampEntries.push({ key: `amp.${name}`, comment, fields });
}

// ---------------------------------------------------------------------------
// SYSTEM_PARAM_UPDATES
// ---------------------------------------------------------------------------
const close2 = (a: number, b: number): boolean => {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= 0.02 * Math.max(1e-9, Math.abs(a), Math.abs(b)) || d < 1e-6;
};

const sysEntries: EmitEntry[] = [];
const sysSkipped: string[] = [];
for (const [pid, rec] of [...sec1.entries()].sort((a, b) => a[0] - b[0])) {
  const shipped = shippedGlobal.get(pid);
  if (!shipped) continue; // unshipped global cache records go to the findings doc, not here
  if (GLOBAL_SKIP.has(pid)) { sysSkipped.push(shipped.key); continue; }
  const { key, p } = shipped;
  const comment: string[] = [`${recCite(1, rec)}`];
  const fields: string[] = [
    `block: 'global', name: '${p.name}'`,
    `pidLow: 0x0001, pidHigh: 0x${pid.toString(16).padStart(4, '0')}`,
  ];
  if (rec.kind === 'enum') {
    const vals = rec.values!;
    const base = rec.min === 1 ? 1 : 0; // CC-style lists are 1-based (min=1, max=count); true enums 0-based
    if (p.unit === 'enum') {
      const shippedVals = (p as { enumValues?: Record<number, string> }).enumValues ?? {};
      const sameCount = Object.keys(shippedVals).length === vals.length;
      const sameLabels = sameCount && vals.every((v, i) => (shippedVals[i + base] ?? '').trim().toUpperCase() === v.trim().toUpperCase());
      if (sameLabels) continue; // shipped already cache-exact (case-insensitive)
      comment.push(`shipped enum has ${Object.keys(shippedVals).length} values; cache supplies the full device list (${vals.length})`);
    } else {
      comment.push(`shipped placeholder was ${p.unit} [${p.displayMin}..${p.displayMax}]; cache says this is an enum`);
    }
    if (base === 1) comment.push('CC pick list: 1-BASED per the cache min=1/max=count signature (wire value = CC number); unconfirmed on hardware');
    fields.push(`unit: 'enum', displayMin: ${base}, displayMax: ${vals.length - 1 + base}`);
    fields.push(`enumValues: ${fmtEnumValues(vals, base)}`);
  } else {
    if (rec.def === 0) continue; // degenerate record (no range info)
    const lo = round6(rec.min * rec.def);
    const hi = round6(rec.max * rec.def);
    if (p.unit !== 'enum' && close2(lo, p.displayMin) && close2(hi, p.displayMax)) continue; // already device-true
    const inf = inferFloatUnit(rec);
    if (inf.note) comment.push(inf.note);
    comment.push(`shipped was ${p.unit} [${p.displayMin}..${p.displayMax}]`);
    fields.push(`unit: '${inf.unit}', displayMin: ${lo}, displayMax: ${hi}`);
    const sc = inferScaling(rec, lo);
    if (sc.scaling) fields.push(`scaling: '${sc.scaling}'`);
    if (sc.note) comment.push(sc.note);
    if (inf.displayUnit) fields.push(`displayUnit: '${esc(inf.displayUnit)}'`);
  }
  const label = (p as { displayLabel?: string }).displayLabel;
  if (label) fields.push(`displayLabel: '${esc(label)}'`);
  sysEntries.push({ key, comment, fields });
}

// ---------------------------------------------------------------------------
// Field-only data (no name source; never invent names)
// ---------------------------------------------------------------------------
const fieldOnlyRows = ampFieldOnly
  .map((r) => {
    const range = r.kind === 'enum'
      ? `values: [${r.values!.map((v) => `'${esc(v)}'`).join(', ')}]`
      : `displayMin: ${round6(r.min * r.def)}, displayMax: ${round6(r.max * r.def)}, scale: ${round6(r.def)}, step: ${round6(r.step * r.def)}`;
    return `  { section: 10, id: ${r.id}, kind: '${r.kind}', tc: 0x${r.tc.toString(16).padStart(2, '0')}, ${range} },`;
  })
  .join('\n');

const globalFieldOnly = [...sec1.entries()]
  .filter(([id]) => !shippedGlobal.has(id))
  .map(([, r]) => `  { section: 1, id: ${r.id}, kind: '${r.kind}', tc: 0x${r.tc.toString(16).padStart(2, '0')}, displayMin: ${round6(r.min * r.def)}, displayMax: ${round6(r.max * r.def)}, scale: ${round6(r.def)}, step: ${round6(r.step * r.def)} },`)
  .join('\n');

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------
const header = `/**
 * Generated by scripts/_research/gen-am4-cache-oracle-params.ts -- do not hand-edit.
 * NOT WIRED into KNOWN_PARAMS. Integration is one spread + review:
 *   export const KNOWN_PARAMS = { ...CACHE_PARAMS, ...AMP_GHOST_PARAMS, ...SYSTEM_PARAM_UPDATES, ... }
 *
 * EVIDENCE GRADE: cache-oracle, STRONG format basis.
 *   Source: effectDefinitions_15_2p0.cache, AM4-Edit's metadata cache synced
 *   from a REAL AM4 (fw 2.0) on this machine, walked with the solved cache
 *   grammar (zero-resync, exact section record counts; hardware anchors pass;
 *   the II cache cross-validates 259/259 amp ordinals against the shipped
 *   hardware-verified II catalog). See docs/_private/CACHE-FORMAT-SOLVED-2026-06-09.md.
 *   Record semantics: f32 fields are (min, max, scale, step); display = field x scale.
 *
 * Per the shipping bar this is DONE-pending-confirmation, not "not done":
 * ranges/labels are device-true cache data, hardware-UNCONFIRMED end-to-end.
 * Honesty labels carried per entry:
 *   - Tier-2 type-code enums (HW-129): labels are AM4-native, but the params
 *     are amp-model-internal; recommend read-only exposure.
 *   - CC pick lists: 1-based mapping inferred from the cache min=1/max=count
 *     signature; index base unconfirmed on hardware.
 *   - tc unit-family 7 (tuner offsets): "cents" display suffix is an
 *     inference, the unit family byte is unmapped.
 *   - Taper: scaling 'log10' only for hardware-confirmed typecodes
 *     {0x40,0x42,0x44,0x48,0x50}; 0x43/0x45 are taper-OPEN (predicted log10
 *     by the 0x40-and-not-0x20 rule, kept linear until confirmed).
 *
 * Cross-checks against the shipped catalog (contradictions are NOT resolved
 * here; shipped values unchanged) are documented in
 * docs/_private/AM4-CACHE-ORACLE-EXPANSION-2026-06-09.md.
 */
import type { Param } from './params.js';

/** CC pick lists: 'CC #1'..'CC #127' [+ 'NONE' [+ 'PEDAL 1','PEDAL 2']], 1-based.
 * Pattern byte-verified against every CC-style cache record by the generator. */
function ccLabels(n: 127 | 128 | 130): Record<number, string> {
  const out: Record<number, string> = {};
  for (let i = 1; i <= Math.min(n, 127); i++) out[i] = \`CC #\${i}\`;
  if (n >= 128) out[128] = 'NONE';
  if (n >= 130) { out[129] = 'PEDAL 1'; out[130] = 'PEDAL 2'; }
  return out;
}
`;

const body = `${header}
/**
 * HW-129 amp GHOSTs (DISTORT family @ pidLow 0x3a) that are device-real
 * (hardware ACK, 2026-05-31 probe) and still unregistered. Ranges/labels from
 * the cache oracle. Excluded: DISTORT_VERSION (id 89, Tier-3 version stamp,
 * degenerate cache range).
 */
export const AMP_GHOST_PARAMS = {
${ampEntries.map(fmtEntry).join('\n')}
} as const satisfies Record<string, Param>;

/**
 * Cache-oracle corrections/refinements for shipped GLOBAL (system) params
 * (pidLow 0x01, cache section 1). Keys match the shipped KNOWN_PARAMS keys, so
 * spreading AFTER the shipped entries replaces them. Entries already
 * cache-exact are omitted. Withheld despite cache data (see findings doc):
 * ${sysSkipped.join(', ')}.
 */
export const SYSTEM_PARAM_UPDATES = {
${sysEntries.map(fmtEntry).join('\n')}
} as const satisfies Record<string, Param>;

/**
 * Cache records with NO name source (no Ghidra symbol, no XML control).
 * Data only -- names are NOT invented. Amp section-10 low ids match the
 * common per-block row shape (level/mix/balance/bypass...) every section
 * shares; identification needs a probe or a capture, not a guess.
 */
export const UNNAMED_CACHE_RECORDS = [
${fieldOnlyRows}
${globalFieldOnly}
] as const;
`;

writeFileSync(OUT, body);
console.log(`wrote ${OUT}`);
console.log(`AMP_GHOST_PARAMS: ${ampEntries.length} entries`);
console.log(`SYSTEM_PARAM_UPDATES: ${sysEntries.length} entries (skipped, kept-shipped: ${sysSkipped.join(', ')})`);
console.log(`UNNAMED_CACHE_RECORDS: ${ampFieldOnly.length} amp + ${globalFieldOnly.split('\n').filter(Boolean).length} global`);
