/**
 * AM4 fn 0x1F: full position map for the amp block.
 *
 * Builds on `probe-am4-fn1f-find-amp.ts` which established effectId 58
 * holds amp and amp.gain is at position 11. This script iterates every
 * amp first-page knob, writes a unique sentinel, diffs the effectId=58
 * chunk, and records position(s) per param.
 *
 * Restores all originals at the end via a single neutral-5.0 write per
 * param (acceptable because the working buffer is non-persistent).
 *
 * Run with AM4 powered + USB connected + AM4-Edit closed:
 *   npx tsx scripts/_research/probe-am4-fn1f-amp-positions.ts
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  KNOWN_PARAMS,
  buildSetFloatParam,
  buildGetAllParams,
  encode,
  type ParamKey,
} from 'fractal-midi/am4';

const AM4_MODEL = 0x15;
const SYSEX_START = 0xf0;
const AMP_EFFECT_ID = 58;

const TARGETS: { key: ParamKey; sentinelDisplay: number }[] = [
  { key: 'amp.gain',     sentinelDisplay: 3.0 },
  { key: 'amp.bass',     sentinelDisplay: 7.0 },
  { key: 'amp.mid',      sentinelDisplay: 3.0 },
  { key: 'amp.treble',   sentinelDisplay: 7.0 },
  { key: 'amp.master',   sentinelDisplay: 3.0 },
  { key: 'amp.depth',    sentinelDisplay: 7.0 },
  { key: 'amp.presence', sentinelDisplay: 3.0 },
];

function decode14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
function isAm4Fn(bytes: number[], fn: number): boolean {
  return bytes.length >= 7 && bytes[0] === SYSEX_START && bytes[1] === 0x00 && bytes[2] === 0x01
    && bytes[3] === 0x74 && bytes[4] === AM4_MODEL && bytes[5] === fn;
}
function decodeChunkPayload(bytes: number[]): number[] {
  const itemCount = decode14(bytes[6], bytes[7]);
  const out: number[] = [];
  const start = 8;
  const end = bytes.length - 2;
  for (let i = 0; i < itemCount; i++) {
    const off = start + i * 3;
    if (off + 2 >= end) break;
    out.push(decode16Packed(bytes[off], bytes[off + 1], bytes[off + 2]));
  }
  return out;
}
function pickPort(instance: midi.Input | midi.Output, label: string): number {
  const n = instance.getPortCount();
  for (let i = 0; i < n; i++) if (/AM4|Fractal.*AM4/i.test(instance.getPortName(i))) return i;
  throw new Error(`No AM4 ${label} port`);
}

async function main(): Promise<void> {
  const input = new midi.Input();
  const output = new midi.Output();
  input.ignoreTypes(false, true, true);
  input.openPort(pickPort(input, 'input'));
  output.openPort(pickPort(output, 'output'));
  console.log('AM4 ports opened.');

  const frames: number[][] = [];
  let active = false;
  input.on('message', (_dt, msg) => { if (active) frames.push([...msg]); });
  const capture = async <T>(work: () => Promise<T>, waitMs = 500): Promise<number[][]> => {
    active = true;
    frames.length = 0;
    await work();
    await sleep(waitMs);
    active = false;
    const t = [...frames];
    frames.length = 0;
    return t;
  };

  const readChunk = async (): Promise<number[]> => {
    const f = await capture(async () => { output.sendMessage(buildGetAllParams(AMP_EFFECT_ID)); });
    const chunk = f.find((m) => isAm4Fn(m, 0x75));
    if (!chunk) throw new Error('no chunk');
    return decodeChunkPayload(chunk);
  };

  const writeParam = async (key: ParamKey, display: number): Promise<void> => {
    const p = KNOWN_PARAMS[key];
    await capture(async () => {
      output.sendMessage(buildSetFloatParam(p, encode(p, display)));
    }, 250);
  };

  // Initial neutral baseline: set every target to 5.0 first.
  console.log('\nResetting every target to 5.0 baseline…');
  for (const { key } of TARGETS) await writeParam(key, 5.0);

  // Now baseline the chunk.
  console.log('Baselining amp chunk (eid=58)…');
  const baseline = await readChunk();
  console.log(`  ${baseline.length} ushorts`);

  // For each target: write the sentinel, capture diff, restore to 5.0.
  const results: {
    param: ParamKey;
    pidLow: number;
    pidHigh: number;
    sentinel: number;
    expectedWire: number;
    changedPositions: number[];
    diffs: { position: number; before: number; after: number }[];
  }[] = [];

  for (const { key, sentinelDisplay } of TARGETS) {
    const p = KNOWN_PARAMS[key];
    const internalFloat = encode(p, sentinelDisplay);
    const expectedWire = Math.round(internalFloat * 65534);
    console.log(`\n[${key}] writing display=${sentinelDisplay} (expected wire u32 ≈ ${expectedWire})…`);
    await writeParam(key, sentinelDisplay);
    const after = await readChunk();
    const changed: number[] = [];
    const diffs: { position: number; before: number; after: number }[] = [];
    const len = Math.min(baseline.length, after.length);
    for (let i = 0; i < len; i++) {
      if (baseline[i] !== after[i]) {
        changed.push(i);
        diffs.push({ position: i, before: baseline[i], after: after[i] });
      }
    }
    if (changed.length === 0) {
      console.log(`  (no positions changed)`);
    } else {
      for (const d of diffs) {
        const matchesExpected = d.after === expectedWire ? '  ✓ matches expected wire' : '';
        console.log(`  pos ${d.position}: ${d.before} → ${d.after}${matchesExpected}`);
      }
    }
    results.push({
      param: key,
      pidLow: p.pidLow,
      pidHigh: p.pidHigh,
      sentinel: sentinelDisplay,
      expectedWire,
      changedPositions: changed,
      diffs,
    });
    // Restore via 5.0 so the next param's diff is against a clean baseline
    await writeParam(key, 5.0);
  }

  input.closePort();
  output.closePort();

  // Emit summary
  mkdirSync('samples/captured/decoded', { recursive: true });
  const outPath = 'samples/captured/decoded/am4-fn1f-amp-position-map.json';
  writeFileSync(outPath, JSON.stringify({
    run: new Date().toISOString(),
    effectId: AMP_EFFECT_ID,
    baselineLength: baseline.length,
    results,
  }, null, 2));

  console.log('\n=== Position map (amp block, effectId 58) ===');
  console.log('param                 pidHigh  →  chunk position(s)');
  for (const r of results) {
    const posStr = r.changedPositions.length === 0
      ? '(no diff)'
      : r.changedPositions.join(', ');
    console.log(`  ${r.param.padEnd(20)}  0x${r.pidHigh.toString(16).padStart(4, '0')}    [${posStr}]`);
  }
  console.log(`\nJSON: ${outPath}`);
}

main().catch((err) => { console.error('FATAL:', err); process.exitCode = 1; });
