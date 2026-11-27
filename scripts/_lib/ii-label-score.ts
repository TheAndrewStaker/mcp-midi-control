/**
 * Score the Axe-Fx II display calibration against the device's own labels.
 *
 * The II renders its display text into every fn 0x02 GET reply, so a sample
 * (param, wire, label) is a device-true reading. For every distinct sample:
 *   value  our decodeWire(wire) equals the label's number exactly (our decode
 *          applies the device's print rule), or enum / switch text equal
 *          (case- and space-insensitive).
 *   write  encodeDisplay(label number) then decodeWire prints the same label
 *          (what set_param does with a reading copied off the panel).
 *   unit   the unit we report vs the label's unit word.
 * Opaque params (no calibration: reads pass the label through, writes take raw
 * wire) are counted separately: not wrong, but not display-first either.
 * Not decode evidence, so neither counted as a match nor a miss:
 *   "(1.783 Hz)"  a tempo-synced param prints its EFFECTIVE value in
 *                 parentheses; the wire still holds the unsynced setting.
 * BARE_UNIT: params where the device prints a physical quantity with no unit
 * word (the resonator prints "882.2" for 882.2 Hz); our unit is not a mismatch.
 *
 * Used by scripts/_research/ii-label-score.ts (report) and
 * scripts/verify-ii-device-labels.ts (preflight gate).
 *
 * Any device: pass `kindFromDescriptor(descriptor)` as the lookup to score a
 * descriptor's tool-surface conversions (ParamSchema decode / encode) against
 * that device's own display text (a gen-1 GET label, a gen-3 panel read, an
 * editor read-back). The default lookup is the Axe-Fx II resolver.
 */
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';
import '@mcp-midi-control/fractal-gen2/descriptor.js';

/** What the scorer needs to know about one param. */
export interface ScoredKind {
  unit: string;
  source: string;
  decodeWire?: (wire: number) => number | string;
  encodeDisplay?: (value: number) => number;
  /** the device prints this physical quantity with no unit word */
  bareUnit?: boolean;
}
export type KindLookup = (key: string) => ScoredKind;

const II_BARE_UNIT = new Set(['resonator.freq', 'resonator.freq1', 'resonator.freq2', 'resonator.freq3', 'resonator.freq4']);

/** The Axe-Fx II calibration resolver (the default). */
export const iiKind: KindLookup = (key) => {
  const [block, ...rest] = key.split('.');
  const k = resolveParamKind('axe-fx-ii', block, rest.join('.'));
  return { unit: k.unit, source: k.source, decodeWire: k.decodeWire, encodeDisplay: k.encodeDisplay, bareUnit: II_BARE_UNIT.has(key) };
};

/**
 * A descriptor's own schemas, exactly what get_param / set_param run. A param
 * whose decode passes the wire through unchanged and whose encode refuses or
 * passes through counts as opaque, like an uncalibrated II param.
 */
export function kindFromDescriptor(d: DeviceDescriptor, bareUnit: ReadonlySet<string> = new Set()): KindLookup {
  return (key) => {
    const dot = key.indexOf('.');
    const s = d.blocks[key.slice(0, dot)]?.params[key.slice(dot + 1)];
    if (!s) return { unit: 'unknown', source: 'missing' };
    const passThrough = [0, 1, 777, 65534].every((w) => { try { return s.decode(w) === w; } catch { return false; } });
    return {
      unit: s.unit,
      source: d.id,
      decodeWire: passThrough && !s.enum_values ? undefined : (w) => s.decode(w),
      encodeDisplay: (v) => Number(s.encode(v)),
      bareUnit: bareUnit.has(key),
    };
  };
}

export interface LabelSample { key: string; wire: number; label: string }

export interface KeyScore {
  n: number; ok: number; unitOk: boolean; unit: string; labelUnit: string;
  bad: string[]; writeBad: number; source: string; opaque: number;
}

export interface LabelScore {
  samples: number; valueOk: number; valueBad: number; enumOk: number; enumBad: number;
  opaque: number; writeBad: number; params: number; paramsAllOk: number; unitMismatch: number;
  /** tempo-synced readings "(1.783 Hz)": the effective value, not the stored one */
  synced: number;
  /** word labels on a numeric param ("OFF" at a range end) */
  text: number;
  perKey: Map<string, KeyScore>;
}

const UNIT_WORDS: Record<string, string[]> = {
  hz: ['hz', 'khz'], ms: ['ms'], seconds: ['sec', 's'], db: ['db'], percent: ['%'], bipolar_percent: ['%', ''],
  degrees: ['deg'], pf: ['pf'], cents: ['ct'], knob: [''], knob_0_10: [''], ratio: [''], count: [''], semitones: [''],
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function parseLabel(label: string): { num?: number; unit: string; dec: number } {
  const m = label.trim().match(/^([-+]?\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) return { unit: '', dec: 0 };
  let num = Number(m[1]);
  const unit = m[2].trim().toLowerCase();
  const dec = m[1].split('.')[1]?.length ?? 0;
  if (unit === 'khz') num *= 1000;
  return { num, unit, dec };
}

/**
 * True when `shown` is what a display printing in increments of `step` would
 * show for `value`: rounded to nearest, or truncated toward zero (the II does
 * both, per param). Anything else, including a label half a step or more
 * ABOVE the value, is a miss. Shared by the scorer and the fitter.
 */
export function printsAs(value: number, shown: number, step: number, mode?: 'nearest' | 'truncate'): boolean {
  const x = value / step;
  const s = Math.round(shown / step);
  const eps = 1e-6;
  if (Math.abs(x - s) < eps) return true;
  const near = Math.round(x) === s;
  const trunc = Math.trunc(x + Math.sign(x) * eps) === s;
  return mode === 'nearest' ? near : mode === 'truncate' ? trunc : near || trunc;
}

/**
 * The scorer's test is EXACT: what we return must be the number the panel
 * shows (the decode already applies the param's print rule). Extra digits
 * count as a miss ("10.049" where the panel shows "10.04").
 */
function numMatch(ours: number, shown: number): boolean {
  return Math.abs(ours - shown) <= 1e-9 * Math.max(1, Math.abs(shown));
}

/** Distinct samples from JSONL text (sweep / probe rows); empty and header rows skipped. */
export function samplesFromJsonl(text: string): LabelSample[] {
  const seen = new Set<string>();
  const out: LabelSample[] = [];
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    const r = JSON.parse(ln);
    if (r.empty || r.key === undefined) continue;
    const id = `${r.key}|${r.wire}|${r.label}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key: r.key, wire: r.wire, label: r.label });
  }
  return out;
}

export function scoreLabels(samples: readonly LabelSample[], kindOf: KindLookup = iiKind): LabelScore {
  const perKey = new Map<string, KeyScore>();
  let valueOk = 0, valueBad = 0, opaque = 0, enumBad = 0, enumOk = 0, writeBad = 0, synced = 0, text = 0;
  for (const s of samples) {
    const kind = kindOf(s.key);
    const lab = parseLabel(s.label);
    const st = perKey.get(s.key) ?? { n: 0, ok: 0, unitOk: true, unit: kind.unit, labelUnit: lab.unit, bad: [], writeBad: 0, source: kind.source, opaque: 0 };
    st.n++;
    let v: 'ok' | 'value' | 'opaque' | 'enum' | 'nolabel' | 'synced';
    if (!s.label.trim()) v = 'nolabel';
    else if (/^\(.*\)$/.test(s.label.trim())) v = 'synced';
    else if (kind.decodeWire === undefined) v = 'opaque';
    else {
      const ours = kind.decodeWire(s.wire);
      if (typeof ours === 'string') {
        v = norm(ours) === norm(s.label) ? 'ok' : 'enum';
        if (v === 'enum') st.bad.push(`${s.wire}: ours "${ours}" device "${s.label}"`);
      } else if (lab.num === undefined) {
        // A word the device prints where we print a number ("INFINITE" at the
        // top of a ratio, "OFF" at wire 0) is a display miss too.
        v = 'value'; st.bad.push(`${s.wire}: ours ${ours} device "${s.label}"`);
      } else {
        v = numMatch(ours, lab.num) ? 'ok' : 'value';
        if (v === 'value') st.bad.push(`${s.wire}: ours ${+ours.toFixed(4)} device "${s.label}"`);
        if (kind.encodeDisplay) {
          try {
            const back = kind.decodeWire(kind.encodeDisplay(lab.num));
            if (typeof back !== 'number' || !numMatch(back, lab.num)) { st.writeBad++; writeBad++; }
          } catch { st.writeBad++; writeBad++; }
        }
        const words = UNIT_WORDS[kind.unit];
        if (!(lab.unit === '' && kind.bareUnit) && (words ? !words.includes(lab.unit) : lab.unit !== '')) st.unitOk = false;
      }
    }
    if (v === 'ok') { st.ok++; if (kind.unit === 'enum' || kind.unit === 'bool') enumOk++; else valueOk++; }
    else if (v === 'value') valueBad++;
    else if (v === 'enum') enumBad++;
    else if (v === 'opaque') { opaque++; st.opaque++; }
    else if (v === 'synced') synced++;
    if (v === 'synced' || v === 'nolabel') st.n--;
    st.labelUnit = lab.unit || st.labelUnit;
    perKey.set(s.key, st);
  }
  const keys = [...perKey.values()];
  return {
    samples: samples.length, valueOk, valueBad, enumOk, enumBad, opaque, writeBad, synced, text,
    params: keys.length, paramsAllOk: keys.filter((k) => k.ok === k.n).length,
    unitMismatch: keys.filter((k) => !k.unitOk).length, perKey,
  };
}
