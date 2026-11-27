/**
 * ii-label-fit.ts: propose Axe-Fx II display calibrations from the device's
 * own labels (corpus from ii-label-sweep.ts), and accept only what is
 * objectively better than what ships.
 *
 *   npx tsx scripts/_research/ii-label-fit.ts [corpus.jsonl] [--out proposals.json]
 *
 * Per numeric param, candidate models:
 *   current   the shipped decode (resolveParamKind)
 *   cache     every Axe-Edit editor-cache record with this paramId
 *             (effectDefinitions_07 walk: display = field x def), linear + log10
 *   fit       least squares on the corpus, linear and log10, endpoints snapped
 *             to the fewest significant digits that still fit every sample
 *   ordinal   display = wire + k (counts / small integer params)
 * A candidate is ACCEPTED only when it matches EVERY sample within the label's
 * last printed digit, the current decode misses at least one, and the evidence
 * pins both ends: >= 2 distinct wire values, or one interior value AND an
 * editor-cache record that agrees with it. Everything else is reported, not
 * changed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import '@mcp-midi-control/fractal-gen2/descriptor.js';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';
import { printsAs } from '../_lib/ii-label-score.js';
import { printDisplayValue, type DisplayPrintRule } from 'fractal-midi/shared';

const corpus = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'samples/captured/ii-label-sweep.jsonl';
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'samples/captured/ii-label-proposals.json';
const WALK = 'samples/captured/local-caches-2026-06-09/effectDefinitions_07.walk.json';

const FULL = 65534;
/** Accept a joined editor-cache record backed only by an endpoint sample. */
const ENDPOINT_OK = process.argv.includes('--endpoint-ok');
type Scale = 'linear' | 'log10' | 'ordinal';
interface Model { scale: Scale; min: number; max: number; offset?: number; factor?: number; from: string }
interface Pt { wire: number; num: number; dec: number; step: number }

function parseLabel(label: string): { num?: number; unit: string; dec: number } {
  const m = label.trim().match(/^([-+]?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { unit: '', dec: 0 };
  return { num: Number(m[1]), unit: m[2].trim().toLowerCase(), dec: m[1].split('.')[1]?.length ?? 0 };
}

function evalModel(m: Model, w: number): number {
  if (m.scale === 'ordinal') return w * (m.factor ?? 1) + (m.offset ?? 0);
  if (m.scale === 'log10') return m.min * Math.pow(m.max / m.min, w / FULL);
  return m.min + (w / FULL) * (m.max - m.min);
}
const hits = (m: Model, pts: Pt[]) => pts.filter((p) => printsAs(evalModel(m, p.wire), p.num, p.step)).length;

function snap(v: number, sig: number): number {
  if (v === 0) return 0;
  return Number(v.toPrecision(sig));
}

function lsq(pts: Pt[], log: boolean): { a: number; b: number } | undefined {
  const xs = pts.map((p) => p.wire / FULL);
  const ys = pts.map((p) => (log ? Math.log10(p.num) : p.num));
  if (ys.some((y) => !Number.isFinite(y))) return undefined;
  const n = xs.length; const mx = xs.reduce((s, x) => s + x, 0) / n; const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  if (sxx === 0) return undefined;
  const b = sxy / sxx; return { a: my - b * mx, b };
}

function fitCandidates(pts: Pt[]): Model[] {
  const out: Model[] = [];
  const ws = pts.map((p) => p.wire);
  // A slope fitted from samples bunched in a sliver of the wire range is not
  // evidence of the range: require a spread of >= 5% of full scale.
  const spread = Math.max(...ws) - Math.min(...ws) >= 0.05 * FULL;
  for (const log of spread ? [false, true] : []) {
    if (log && pts.some((p) => p.num <= 0)) continue;
    const f = lsq(pts, log);
    if (!f) continue;
    const min = log ? Math.pow(10, f.a) : f.a;
    const max = log ? Math.pow(10, f.a + f.b) : f.a + f.b;
    // Snap both ends to one grid relative to the span, so a near-zero end
    // becomes 0 instead of -0.0003.
    const span = Math.abs(max - min) || Math.abs(max) || 1;
    for (let sig = 1; sig <= 6; sig++) {
      const g = Math.pow(10, Math.floor(Math.log10(span)) - sig + 1);
      const sn = (v: number) => (log ? snap(v, sig) : Math.round(v / g) * g);
      const m: Model = { scale: log ? 'log10' : 'linear', min: +sn(min).toPrecision(8), max: +sn(max).toPrecision(8), from: `fit/${sig}sig` };
      if (m.min >= m.max || (log && m.min <= 0)) continue;
      out.push(m);
      if (hits(m, pts) === pts.length) break;
    }
  }
  if (new Set(pts.map((p) => p.wire)).size >= 2 && pts.every((p) => p.wire < 512 && Number.isInteger(p.num))) {
    // display = wire * factor + offset, integer factor (chorus voices step by 2)
    const [a, b] = [...pts].sort((x, y) => x.wire - y.wire).filter((q, i, arr) => i === 0 || q.wire !== arr[i - 1].wire);
    const factor = (b.num - a.num) / (b.wire - a.wire);
    const k = a.num - a.wire * factor;
    if (Number.isInteger(factor) && factor !== 0 && pts.every((p) => p.num === p.wire * factor + k)) {
      const lo = Math.min(...pts.map((p) => p.num)); const hi = Math.max(...pts.map((p) => p.num));
      out.push({ scale: 'ordinal', offset: k, ...(factor !== 1 ? { factor } : {}), min: lo, max: hi, from: 'ordinal' });
    }
  }
  return out;
}

// editor-cache records keyed by paramId (section unknown: every section is a candidate)
interface WalkRec { kind: string; section: number; id: number; tc: number; min: number; max: number; def: number }
const walk = JSON.parse(readFileSync(WALK, 'utf8')) as { records: WalkRec[] };
const cacheById = new Map<number, WalkRec[]>();
for (const r of walk.records) {
  if (r.kind !== 'float' || r.id >= 0xff00) continue;
  cacheById.set(r.id, [...(cacheById.get(r.id) ?? []), r]);
}
function cacheCandidates(paramId: number, section?: number): Model[] {
  const out: Model[] = [];
  for (const r of cacheById.get(paramId) ?? []) {
    if (section !== undefined && r.section !== section) continue;
    const min = snap(r.min * r.def, 5); const max = snap(r.max * r.def, 5);
    if (!(min < max)) continue;
    out.push({ scale: 'linear', min, max, from: `cache/s${r.section}` });
    if (min > 0) out.push({ scale: 'log10', min, max, from: `cache/s${r.section}` });
  }
  return out;
}

const UNIT_OF: Record<string, string> = { hz: 'hz', khz: 'hz', ms: 'ms', sec: 'seconds', s: 'seconds', db: 'db', '%': 'percent', deg: 'degrees', pf: 'pf', ct: 'cents' };

// ---- load corpus ----
const byKey = new Map<string, Map<string, { wire: number; label: string }>>();
const clampOf = new Map<string, { min?: number; max?: number }>();
for (const ln of corpus.split(',').map((f) => readFileSync(f, 'utf8')).join('\n').split('\n')) {
  if (!ln) continue;
  const r = JSON.parse(ln);
  if (r.empty || r.key === undefined) continue;
  const m = byKey.get(r.key) ?? new Map();
  m.set(`${r.wire}|${r.label}`, { wire: r.wire, label: r.label });
  byKey.set(r.key, m);
  // A probe write the device clamped (read-back wire != the wire sent) is
  // the device stating its own wire domain end.
  if (typeof r.probe === 'number' && r.probe !== r.wire) {
    const c = clampOf.get(r.key) ?? {};
    if (r.probe > r.wire) c.max = Math.min(c.max ?? Infinity, r.wire); else c.min = Math.max(c.min ?? -Infinity, r.wire);
    clampOf.set(r.key, c);
  }
}

const PARAM_BY_KEY = new Map(Object.values(KNOWN_PARAMS as Record<string, AxeFxIIParam>).map((p) => [`${p.block}.${p.name}`, p]));

interface Proposal {
  key: string; verdict: 'accept' | 'keep' | 'unresolved'; reason: string;
  model?: Model; unit?: string; decimals?: number; samples: number; distinctWires: number;
  currentHits: number; bestHits: number; misses?: string[];
}
const proposals: Proposal[] = [];
let cacheTried = 0, cacheHit = 0;

// ---- block -> editor-cache section join, by the device's own labels ----
// A section "explains" a sample when its record for that paramId (linear or
// log10) prints the label. The block's section is the one explaining the most
// samples across all its params; it must beat the runner-up clearly.
const numericPts = new Map<string, Pt[]>();
for (const [key, set] of byKey) {
  const pts = [...set.values()].map((s) => ({ s, l: parseLabel(s.label) }))
    .filter((x) => x.l.num !== undefined && x.l.unit !== 'sec' && x.l.unit !== 's' && x.l.unit !== 'khz')
    .map(({ s, l }) => ({ wire: s.wire, num: l.num!, dec: l.dec, step: Math.pow(10, -l.dec) }));
  if (pts.length) numericPts.set(key, pts);
}
const sectionOf = new Map<string, number>();
const blocks = new Set([...PARAM_BY_KEY.values()].map((p) => p.block));
for (const blk of blocks) {
  const score = new Map<number, number>();
  for (const [key, pts] of numericPts) {
    const p = PARAM_BY_KEY.get(key);
    if (!p || p.block !== blk || p.name === 'bypass') continue;
    // only informative samples: not the bare midpoint/endpoints
    const info = pts.filter((q) => q.wire !== 0 && q.wire !== FULL && q.wire !== 32767);
    if (!info.length) continue;
    const secs = new Set((cacheById.get(p.paramId) ?? []).map((r) => r.section));
    for (const sec of secs) {
      const ms = cacheCandidates(p.paramId, sec);
      if (ms.some((m) => hits(m, info) === info.length)) score.set(sec, (score.get(sec) ?? 0) + 1);
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] >= 3 && ranked[0][1] >= 2 * (ranked[1]?.[1] ?? 0)) sectionOf.set(blk, ranked[0][0]);
  console.log(`section join ${blk.padEnd(16)} ${ranked.slice(0, 3).map(([s, n]) => `s${s}:${n}`).join(' ')}${sectionOf.has(blk) ? '' : '  (no join)'}`);
}

for (const [key, set] of [...byKey.entries()].sort()) {
  const p = PARAM_BY_KEY.get(key);
  if (!p || p.controlType === 'select' || p.controlType === 'switch' || p.name === 'bypass') continue;
  const raw = [...set.values()].filter((s) => s.label.trim());
  const parsed = raw.map((s) => ({ s, l: parseLabel(s.label) })).filter((x) => x.l.num !== undefined);
  if (!parsed.length) continue;
  // Word labels at a wire ("INFINITE", "OFF", "LFO1 SYNC"): kept as labels
  // when every reading at that wire is the same word and none is a number.
  // Parenthesised readings are a tempo-synced param's EFFECTIVE value, not words.
  const wordAt = new Map<number, Set<string>>();
  for (const x of raw) {
    const t = x.label.trim();
    if (/^[-+]?\d/.test(t) || /^\(.*\)$/.test(t)) continue;
    wordAt.set(x.wire, (wordAt.get(x.wire) ?? new Set()).add(t));
  }
  const labels: Record<number, string> = {};
  for (const [w, set] of wordAt) if (set.size === 1 && !parsed.some((x) => x.s.wire === w)) labels[w] = [...set][0];
  const hasWords = Object.keys(labels).length > 0;
  // mixed ms / sec on one param: express in ms
  const units = new Set(parsed.map((x) => x.l.unit));
  const toMs = units.has('ms') && (units.has('sec') || units.has('s'));
  const pts: Pt[] = parsed.map(({ s, l }) => {
    const sec = l.unit === 'sec' || l.unit === 's';
    const k = l.unit === 'khz' ? 1000 : toMs && sec ? 1000 : 1;
    const dec = Math.max(0, l.dec - Math.round(Math.log10(k)));
    return { wire: s.wire, num: l.num! * k, dec, step: Math.pow(10, -l.dec) * k };
  });
  const unitWord = [...units].find((u) => u !== '') ?? '';
  let unit = toMs ? 'ms' : UNIT_OF[unitWord];
  if (unit === 'percent' && pts.some((q) => q.num < 0)) unit = 'bipolar_percent';
  const decimals = Math.max(...pts.map((q) => q.dec));
  const distinctWires = new Set(pts.map((q) => q.wire)).size;

  const kind = resolveParamKind('axe-fx-ii', p.block, p.name);
  const currentHits = kind.decodeWire
    ? pts.filter((q) => { const v = kind.decodeWire!(q.wire); return typeof v === 'number' && Math.abs(v - q.num) <= 1e-9 * Math.max(1, Math.abs(q.num)); }).length
    : 0;
  // Current-decode hits use the shipped 2-decimal rounding, so a 3-decimal label
  // is judged at 0.005 there; the replacement is judged at the label's own digit.

  const sec = sectionOf.get(p.block);
  const current: Model[] = [];
  if (kind.decodeWire && kind.displayMin !== undefined && kind.displayMax !== undefined && kind.source !== 'unknown') {
    const mid = kind.decodeWire(32767);
    const lin = (kind.displayMin + kind.displayMax) / 2;
    const scale: Scale = typeof mid === 'number' && Math.abs(mid - lin) > 0.02 * Math.abs(kind.displayMax - kind.displayMin) ? 'log10' : 'linear';
    current.push({ scale, min: kind.displayMin, max: kind.displayMax, from: 'current' });
  }
  const cacheC = sec !== undefined ? cacheCandidates(p.paramId, sec) : [];
  const cands = [...current, ...cacheC, ...fitCandidates(pts)];
  const full = cands.filter((m) => hits(m, pts) === pts.length);
  const rank = (m: Model) => (m.from === 'current' ? 0 : m.from.startsWith('cache') ? 1 : 2);
  // Print rules the device may use (fixed decimals / significant figures,
  // rounded / truncated); a model is worth what it prints exactly.
  const maxDec = Math.max(...pts.map((q) => q.dec));
  const RULES: DisplayPrintRule[] = [
    { decimals: maxDec }, { decimals: maxDec, rounding: 'truncate' },
    ...[3, 4, 5].flatMap((sig): DisplayPrintRule[] => [{ decimals: maxDec, sigFigs: sig }, { decimals: maxDec, sigFigs: sig, rounding: 'truncate' }]),
  ];
  // same criterion as the scorer: our PRINTED value equals the label exactly
const exactOf = (m: Model, r: DisplayPrintRule) => pts.filter((q) => Math.abs(printDisplayValue(evalModel(m, q.wire), r) - q.num) <= 1e-9 * Math.max(1, Math.abs(q.num))).length;
  const bestExact = (m: Model) => Math.max(...RULES.map((r) => exactOf(m, r)));
  // most exact prints first, then current > cache > fit
  const best = full.sort((a, b) => bestExact(b) - bestExact(a) || rank(a) - rank(b))[0];
  if (best?.scale === 'ordinal') {
    // The samples only show values presets used; the range is the param's
    // whole domain: the joined editor-cache record when the samples sit inside
    // it, else the catalog's wire domain shifted by the offset.
    const k = best.offset ?? 0;
    const lo = Math.min(...pts.map((q) => q.num)); const hi = Math.max(...pts.map((q) => q.num));
    const rec = (cacheById.get(p.paramId) ?? []).find((r) => r.section === sec);
    const cmin = rec ? Math.round(rec.min * rec.def) : undefined; const cmax = rec ? Math.round(rec.max * rec.def) : undefined;
    if (cmin !== undefined && cmax !== undefined && cmin <= lo && cmax >= hi) { best.min = cmin; best.max = cmax; best.from = `ordinal+cache/s${sec}`; }
    else if (p.displayMin !== undefined && p.displayMax !== undefined) { const f = best.factor ?? 1; best.min = p.displayMin * f + k; best.max = p.displayMax * f + k; best.from = 'ordinal+catalog-wire-domain'; }
    else {
      // the device's own clamp (probe), each end independently; else observed only (unresolved below)
      const c = clampOf.get(key);
      const f = best.factor ?? 1;
      if (c?.min !== undefined && c?.max !== undefined) { best.min = c.min * f + k; best.max = c.max * f + k; best.from = 'ordinal+device-clamp'; }
      else best.from = 'ordinal-observed-only';
    }
  }
  if (distinctWires >= 2 && cacheC.length) { cacheTried++; if (cacheC.some((m) => hits(m, pts) === pts.length)) cacheHit++; else if (process.argv.includes('--cache-misses')) console.log(`CACHE-MISS ${key} cache ${cacheC.map((m) => `${m.scale} ${m.min}..${m.max}`).join(' / ')} | ${pts.slice(0, 8).map((q) => `${q.wire}=${q.num}`).join(' ')}`); }
  const bestHits = best ? pts.length : Math.max(0, ...cands.map((m) => hits(m, pts)));
  // The midpoint is not evidence: every symmetric range prints the same there.
  const interior = pts.some((q) => q.wire > 0 && q.wire < FULL && q.wire !== 32767);
  // Pinned = no other model that prints every sample disagrees with `best`
  // anywhere in the range by a printed step or more (a second taper or range
  // that fits the same readings means the readings do not decide it).
  const step = Math.min(...pts.map((q) => q.step));
  const PROBE = [1638, 6553, 13107, 19660, 26214, 39321, 45875, 52428, 58981, 63897];
  const rival = best && best.from !== 'current'
    ? full.find((m) => m !== best && PROBE.some((w) => Math.abs(evalModel(m, w) - evalModel(best, w)) >= step))
    : undefined;
  const pinned = best?.from === 'ordinal-observed-only' ? false : best?.from === 'current'
    || (best !== undefined && rival === undefined && (distinctWires >= 2 ? interior || distinctWires >= 3 : !best.from.startsWith('fit') && (interior || ENDPOINT_OK)));
  const unitWrong = unit !== undefined && kind.unit !== unit && !(unit === 'percent' && kind.unit === 'bipolar_percent');
  // Rounding rule the device uses for this param: nearest if that prints
  // every sample, else truncation toward zero if that does.
  // The device's print rule for this param: of fixed decimals or significant
  // figures, rounded or truncated, the one that prints the most samples
  // exactly (first wins a tie). Acceptance itself needs every sample to be
  // the model rounded or truncated (`hits`); a few params miss an exact print
  // by one step because the device's own arithmetic differs from the model in
  // the 5th significant figure (39.33 vs 39.32).
  const exact = (r: DisplayPrintRule) => exactOf(best!, r);
  const printRule = best ? RULES.reduce((a, r) => (exact(r) > exact(a) ? r : a), RULES[0]) : undefined;
  const rounding = printRule?.rounding;
  const sigFigs = printRule?.sigFigs;
  const base = { key, samples: pts.length, ...(rounding ? { rounding } : {}), ...(sigFigs ? { sigFigs } : {}), printRuleFound: printRule !== undefined, distinctWires, currentHits, bestHits, unit, decimals, ...(hasWords ? { labels } : {}) };
  if (currentHits === pts.length && !unitWrong && !hasWords && kind.decodeWire) {
    proposals.push({ ...base, verdict: 'keep', reason: 'current decode matches every sample' });
  } else if (best && pinned && printRule && exact(printRule) >= currentHits) {
    proposals.push({ ...base, verdict: 'accept', reason: currentHits === pts.length ? (hasWords ? 'word labels' : 'unit/precision only') : `current ${currentHits}/${pts.length}`, model: best });
  } else {
    proposals.push({
      ...base, verdict: 'unresolved',
      reason: best && pinned ? `prints ${printRule ? exact(printRule) : 0} exactly, the shipped decode ${currentHits}` : best ? (rival ? `ambiguous: ${best.scale} ${best.min}..${best.max} and ${rival.scale} ${rival.min}..${rival.max} both print every sample` : `fits but under-determined (${distinctWires} distinct wire)`) : 'no linear/log10/ordinal model fits every sample',
      misses: pts.slice(0, 6).map((q) => `${q.wire}=${q.num}`),
    });
  }
}

// ---- enum rosters: shipped roster vs device labels; missing rosters from the joined cache section ----
interface EnumRec { kind: string; section: number; id: number; values?: string[] }
const enumRecs = (walk.records as unknown as EnumRec[]).filter((r) => r.kind === 'enum' && r.values);
const nrm = (x: string) => x.toUpperCase().replace(/\s+/g, ' ').trim();
interface EnumProposal { key: string; verdict: 'keep' | 'fill' | 'fix' | 'unresolved'; samples: number; mismatches: string[]; values?: string[]; from?: string }
const enumProposals: EnumProposal[] = [];
for (const [key, set] of [...byKey.entries()].sort()) {
  const p = PARAM_BY_KEY.get(key);
  if (!p || p.controlType !== 'select') continue;
  const pts = [...set.values()].filter((x) => x.label.trim());
  if (!pts.length) continue;
  const shipped = p.enumValues ?? {};
  const mism = pts.filter((x) => nrm(shipped[x.wire] ?? '') !== nrm(x.label)).map((x) => `${x.wire}: ours "${shipped[x.wire] ?? '(none)'}" device "${x.label}"`);
  if (!mism.length) { enumProposals.push({ key, verdict: 'keep', samples: pts.length, mismatches: [] }); continue; }
  const sec = sectionOf.get(p.block);
  const rec = enumRecs.find((r) => r.section === sec && r.id === p.paramId);
  const recOk = rec !== undefined && pts.every((x) => nrm(rec.values![x.wire] ?? '') === nrm(x.label));
  if (recOk) {
    const hasRoster = Object.keys(shipped).length > 0;
    enumProposals.push({ key, verdict: hasRoster ? 'fix' : 'fill', samples: pts.length, mismatches: mism, values: rec!.values, from: `cache/s${sec}` });
  } else {
    enumProposals.push({ key, verdict: 'unresolved', samples: pts.length, mismatches: mism, from: rec ? `cache/s${sec} disagrees` : 'no cache record' });
  }
}
// Cab rosters: the II names cabs by slot, FACTORY n at wire n-1 and USER n at
// wire 188+n. The boundary and the user count were pinned by the
// write-and-restore probe (wire 188 = FACTORY 189, 189 = USER 1, 1212 = USER
// 1024, 1213 = SCRATCHPAD1); the rule must also print every swept sample.
const FACTORY_CABS = 189, USER_CABS = 1024;
const cabName = (w: number) => (w < FACTORY_CABS ? `FACTORY ${w + 1}` : w < FACTORY_CABS + USER_CABS ? `USER ${w - FACTORY_CABS + 1}` : w === FACTORY_CABS + USER_CABS ? 'SCRATCHPAD1' : undefined);
for (const key of ['cab.cab', 'cab.cab_r']) {
  const pts = [...(byKey.get(key)?.values() ?? [])].filter((x) => x.label.trim());
  const idx = enumProposals.findIndex((e) => e.key === key);
  if (!pts.length || idx < 0) continue;
  const miss = pts.filter((x) => cabName(x.wire) !== x.label.trim());
  enumProposals[idx] = miss.length
    ? { ...enumProposals[idx], verdict: 'unresolved', from: `slot rule misses ${miss.length}` }
    : { key, verdict: 'fill', samples: pts.length, mismatches: enumProposals[idx].mismatches, values: Array.from({ length: FACTORY_CABS + USER_CABS + 1 }, (_, w) => cabName(w)!), from: 'slot rule (probe-pinned boundary)' };
}
// Pitch scale notes: chromatic from C at ordinal 0 (no editor-cache record);
// accepted only when every swept sample prints the rule's name.
const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
for (const e of enumProposals) {
  if (!/^pitch\.note[2-8]$/.test(e.key) || e.verdict !== 'unresolved') continue;
  const pts = [...(byKey.get(e.key)?.values() ?? [])].filter((x) => x.label.trim());
  if (pts.length && pts.every((x) => CHROMATIC[x.wire] === x.label.trim())) Object.assign(e, { verdict: 'fill', values: CHROMATIC, from: 'chromatic rule' });
}
const ec = (v: string) => enumProposals.filter((x) => x.verdict === v).length;
console.log(`enum params ${enumProposals.length}: keep ${ec('keep')}, fill ${ec('fill')}, fix ${ec('fix')}, unresolved ${ec('unresolved')}`);
for (const x of enumProposals.filter((q) => q.verdict !== 'keep')) console.log(`ENUM ${x.verdict.padEnd(10)} ${x.key.padEnd(30)} ${x.from ?? ''} | ${x.mismatches.slice(0, 3).join('; ')}`);

writeFileSync(OUT, JSON.stringify({ numeric: proposals, enums: enumProposals }, null, 1));
console.log(`editor-cache reliability (joined section, params with >= 2 distinct wires): ${cacheHit}/${cacheTried}`);
const c = (v: string) => proposals.filter((x) => x.verdict === v).length;
console.log(`numeric params ${proposals.length}: keep ${c('keep')}, accept ${c('accept')}, unresolved ${c('unresolved')} -> ${OUT}`);
for (const x of proposals.filter((q) => q.verdict !== 'keep')) {
  console.log(`${x.verdict.padEnd(10)} ${x.key.padEnd(34)} ${x.reason}${x.model ? ` -> ${x.model.scale} ${x.model.min}..${x.model.max}${x.model.offset !== undefined ? ` off ${x.model.offset}` : ''} [${x.model.from}] unit ${x.unit} dec ${x.decimals}` : ''}${x.misses ? ' | ' + x.misses.join(' ') : ''}`);
}
