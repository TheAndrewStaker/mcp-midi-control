/**
 * verify-fractal-calibration-snapshot.ts: every Fractal param must convert
 * exactly as it did when the snapshot was frozen.
 *
 * For every param of every registered Fractal descriptor (AM4, Axe-Fx II XL+,
 * AX8, Axe-Fx III, FM3, FM9, VP4, gen-1) it records what the tool surface
 * actually sees: unit, display range, wire kind, the enum roster, decode() at a
 * fixed set of wire values AND at fractional values (the AM4 schema decodes a
 * normalized 0..1 internal value), encode() of each decoded value, and encode
 * at the display endpoints, mid-point, just outside each end, half a printed
 * digit past each end, and string inputs. Errors are recorded with their FULL
 * text (refusal wording is part of the display-first contract), and -0 is kept
 * distinct from 0.
 *
 * The AM4 write path does not go through schema.encode (that returns the
 * display value; the conversion happens in fractal-midi's encode() inside
 * buildSetParam), so for every AM4 catalog param the gate also hashes
 * encode() and the full buildSetParam frame at the same display points, and
 * the fn 0x1F chunk decode get_preset uses (decodeChunkValue).
 *
 * The fixture holds one short hash per param, so the check is exact while the
 * committed file stays small. A refactor that is meant to be behaviour-neutral
 * (moving calibration into a shared module) must pass with ZERO diffs. A change
 * that is meant to alter conversions regenerates the snapshot in the same
 * commit, and the diff list (`--diff`) is the review record of what moved.
 *
 *   npx tsx scripts/verify-fractal-calibration-snapshot.ts            # check
 *   npx tsx scripts/verify-fractal-calibration-snapshot.ts --write    # freeze
 *   npx tsx scripts/verify-fractal-calibration-snapshot.ts --dump f   # full detail to f (for a diff review)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import type { DeviceDescriptor, ParamSchema } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR, AX8_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFX3_DESCRIPTOR, FM3_DESCRIPTOR, FM9_DESCRIPTOR, VP4_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/device.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { decodeChunkValue } from '@mcp-midi-control/am4/descriptor/reader.js';
import { KNOWN_PARAMS as AM4_PARAMS, encode as am4Encode, decode as am4Decode, roundDisplayValue, buildSetParam, type Param as Am4Param } from 'fractal-midi/am4';

const FIXTURE = 'scripts/fixtures/fractal-calibration-snapshot.json';
const DEVICES: Array<[string, DeviceDescriptor]> = [
  ['am4', AM4_DESCRIPTOR], ['axe-fx-ii', AXEFX2_DESCRIPTOR], ['ax8', AX8_DESCRIPTOR],
  ['axe-fx-iii', AXEFX3_DESCRIPTOR], ['fm3', FM3_DESCRIPTOR], ['fm9', FM9_DESCRIPTOR],
  ['vp4', VP4_DESCRIPTOR], ['axe-fx-gen1', AXEFXGEN1_DESCRIPTOR],
];
const WIRES = [0, 1, 2, 3, 7, 12, 24, 48, 127, 254, 655, 6553, 13107, 16383, 21845, 32767, 43690, 49151, 58981, 65533, 65534];
const FRACTIONS = [0.0001, 0.01, 0.1, 0.2, 0.25, 0.3333, 0.5, 0.6667, 0.75, 0.9, 0.99, 0.9999];
const STRINGS = ['5', ' 2.5 ', 'abc', '', 'off'];

const num = (v: number) => (Object.is(v, -0) ? '-0' : `${+v.toPrecision(12)}`);
const out = (f: () => unknown): string => {
  try { const v = f(); return typeof v === 'number' ? num(v) : JSON.stringify(v); } catch (e) { return `ERR:${String((e as Error).message)}`; }
};
/** display points around the range: ends, mid, 1% outside, half a step past each end at 1-3 decimals */
function edgePoints(min?: number, max?: number): number[] {
  if (min === undefined || max === undefined) return [];
  const span = Math.abs(max - min) || 1;
  return [min, max, (min + max) / 2, min - span * 0.01, max + span * 0.01,
    ...[0.5, 0.05, 0.005].flatMap((h) => [min - h, max + h, min + h, max - h])];
}

function describe(s: ParamSchema): unknown {
  const rows = WIRES.map((w) => {
    const d = (() => { try { return s.decode(w); } catch { return undefined; } })();
    return [w, out(() => s.decode(w)), d === undefined ? '-' : out(() => s.encode(d))];
  });
  const frac = FRACTIONS.map((f) => [f, out(() => s.decode(f))]);
  const ends = edgePoints(s.display_min, s.display_max).map((v) => out(() => s.encode(v)));
  const strs = STRINGS.map((v) => out(() => s.encode(v)));
  return {
    unit: s.unit, min: s.display_min, max: s.display_max, wk: s.wire_kind, partial: s.enum_partial,
    enum: s.enum_values ? Object.entries(s.enum_values).map(([k, v]) => `${k}=${v}`).join('|') : undefined,
    rows, frac, ends, strs,
  };
}

/** AM4 write + chunk-read math, which the descriptor schema does not run. */
function describeAm4(p: Am4Param): unknown {
  const reads = [...WIRES.map((w) => [w, out(() => decodeChunkValue(p, w))]),
    ...[0, ...FRACTIONS, 1].map((f) => [f, out(() => roundDisplayValue(p, am4Decode(p, f)))])];
  const points = [...edgePoints(p.displayMin, p.displayMax),
    ...[0, ...FRACTIONS, 1].map((f) => { try { return am4Decode(p, f); } catch { return NaN; } })].filter((v) => Number.isFinite(v));
  const writes = points.map((v) => [num(v), out(() => am4Encode(p, v)), out(() => buildSetParam(`${p.block}.${p.name}` as never, v).join(' '))]);
  return { reads, writes };
}

const current: Record<string, Record<string, string>> = {};
const detail: Record<string, unknown> = {};
for (const [id, d] of DEVICES) {
  const per: Record<string, string> = {};
  for (const [slug, block] of Object.entries(d.blocks)) {
    for (const [name, s] of Object.entries(block.params)) {
      const desc = describe(s);
      const json = JSON.stringify(desc);
      per[`${slug}.${name}`] = createHash('sha1').update(json).digest('base64url').slice(0, 12);
      detail[`${id}/${slug}.${name}`] = desc;
    }
  }
  current[id] = per;
}
{
  const per: Record<string, string> = {};
  for (const [key, p] of Object.entries(AM4_PARAMS as Record<string, Am4Param>)) {
    const desc = describeAm4(p);
    per[key] = createHash('sha1').update(JSON.stringify(desc)).digest('base64url').slice(0, 12);
    detail[`am4-wire/${key}`] = desc;
  }
  current['am4-wire'] = per;
}

const dumpAt = process.argv.indexOf('--dump');
if (dumpAt > 0) { writeFileSync(process.argv[dumpAt + 1], JSON.stringify(detail, null, 1)); console.log(`detail -> ${process.argv[dumpAt + 1]}`); }

if (process.argv.includes('--write')) {
  writeFileSync(FIXTURE, JSON.stringify(current, null, 0).replace(/\},"/g, '},\n"') + '\n');
  console.log(`froze ${Object.values(current).reduce((n, p) => n + Object.keys(p).length, 0)} params over ${DEVICES.length} devices -> ${FIXTURE}`);
  process.exit(0);
}

const frozen = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, Record<string, string>>;
let diffs = 0;
const lines: string[] = [];
for (const id of [...DEVICES.map(([d]) => d), 'am4-wire']) {
  const a = frozen[id] ?? {}; const b = current[id];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue;
    diffs++;
    lines.push(`  ${id}/${k}: ${a[k] === undefined ? 'ADDED' : b[k] === undefined ? 'REMOVED' : 'CHANGED'}`);
  }
}
const total = Object.values(current).reduce((n, p) => n + Object.keys(p).length, 0);
if (diffs) {
  console.error(lines.slice(0, process.argv.includes('--diff') ? undefined : 40).join('\n'));
  console.error(`x verify-fractal-calibration-snapshot: ${diffs} of ${total} params convert differently from the frozen snapshot.`);
  console.error('  Behaviour-neutral change: fix it. Intended change: --dump before/after, review, then --write in the same commit.');
  process.exit(1);
}
console.log(`OK verify-fractal-calibration-snapshot: ${total} params over ${DEVICES.length} Fractal devices convert identically.`);
