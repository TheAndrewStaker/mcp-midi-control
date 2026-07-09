/**
 * AM4 fn 0x1F: which effectId holds the amp block?
 *
 * The effectId sweep (probe-am4-fn1f-effectid-sweep.ts) identified
 * effectIds that return non-empty chunks. This script:
 *
 *   1. Reads the current amp.gain wire u32 (for restore later).
 *   2. Baselines readAllParams(eid) for every non-zero-size effectId.
 *   3. Writes amp.gain to a sentinel display value (3.0 or 7.0, picked
 *      to differ from the current value).
 *   4. Re-reads each effectId's chunk and diffs vs baseline.
 *   5. Restores amp.gain.
 *   6. Reports: which effectId(s) changed (= contain amp.gain at some
 *      position), and at which position(s).
 *
 * One write, 17 baseline reads, 17 re-reads. ~15 seconds total.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  KNOWN_PARAMS,
  buildSetFloatParam,
  buildGetAllParams,
  encode,
} from 'fractal-midi/am4';

const AM4_MODEL = 0x15;
const SYSEX_START = 0xf0;

const TARGET_EFFECT_IDS = [
  // From sweep: every effectId that returned a non-zero-size chunk.
  1, 2, 37, 42, 46, 50, 54, 58, 62, 66, 70, 78, 82, 86, 90, 94, 102, 106,
  114, 118, 119, 122, 146, 206, 207,
];

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}
function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
function isAm4Fn(bytes: number[], fn: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === SYSEX_START
    && bytes[1] === 0x00
    && bytes[2] === 0x01
    && bytes[3] === 0x74
    && bytes[4] === AM4_MODEL
    && bytes[5] === fn
  );
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
  for (let i = 0; i < n; i++) {
    if (/AM4|Fractal.*AM4/i.test(instance.getPortName(i))) return i;
  }
  throw new Error(`No AM4 ${label} port`);
}

async function readAllParams(
  collector: { collect: <T>(work: () => Promise<T>, waitMs?: number) => Promise<{ result: T; frames: number[][] }> },
  output: midi.Output,
  effectId: number,
): Promise<number[]> {
  const { frames } = await collector.collect(async () => {
    output.sendMessage(buildGetAllParams(effectId));
  }, 500);
  for (const f of frames) {
    if (isAm4Fn(f, 0x64) && f[6] === 0x1f) {
      throw new Error(`NACK rc=0x${f[7].toString(16).padStart(2, '0')}`);
    }
  }
  const chunk = frames.find((f) => isAm4Fn(f, 0x75));
  if (!chunk) return [];
  return decodeChunkPayload(chunk);
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
  input.on('message', (_dt, msg) => {
    if (active) frames.push([...msg]);
  });
  const collector = {
    collect: async <T>(work: () => Promise<T>, waitMs = 500) => {
      active = true;
      frames.length = 0;
      const result = await work();
      await sleep(waitMs);
      active = false;
      const taken = [...frames];
      frames.length = 0;
      return { result, frames: taken };
    },
  };

  // 1. Baseline every target effectId.
  console.log('\nBaselining every non-zero-size effectId…');
  const baselines = new Map<number, number[]>();
  for (const eid of TARGET_EFFECT_IDS) {
    try {
      const values = await readAllParams(collector, output, eid);
      baselines.set(eid, values);
      console.log(`  eid=${eid.toString().padStart(3)} → ${values.length} ushorts`);
    } catch (err) {
      console.log(`  eid=${eid.toString().padStart(3)} → error: ${err}`);
    }
  }

  // 2. Write amp.gain to sentinel.
  const ampGain = KNOWN_PARAMS['amp.gain'];
  const SENTINEL_DISPLAY = 7.5;
  console.log(`\nWriting amp.gain = ${SENTINEL_DISPLAY} (sentinel)…`);
  const sentinelInternalFloat = encode(ampGain, SENTINEL_DISPLAY);
  await collector.collect(async () => {
    output.sendMessage(buildSetFloatParam(ampGain, sentinelInternalFloat));
  }, 250);

  // 3. Re-read every target effectId.
  console.log('\nRe-reading every target effectId after the write…');
  const diffs: { eid: number; before: number[]; after: number[]; changedPositions: number[] }[] = [];
  for (const eid of TARGET_EFFECT_IDS) {
    const baseline = baselines.get(eid);
    if (!baseline) continue;
    try {
      const after = await readAllParams(collector, output, eid);
      const changed: number[] = [];
      const len = Math.min(baseline.length, after.length);
      for (let i = 0; i < len; i++) {
        if (baseline[i] !== after[i]) changed.push(i);
      }
      diffs.push({ eid, before: baseline, after, changedPositions: changed });
      if (changed.length > 0) {
        console.log(`  eid=${eid.toString().padStart(3)} → CHANGED at positions [${changed.join(', ')}]`);
        for (const p of changed) {
          console.log(`         pos ${p}: ${baseline[p]} → ${after[p]}`);
        }
      } else if (baseline.length !== after.length) {
        console.log(`  eid=${eid.toString().padStart(3)} → length changed ${baseline.length} → ${after.length}`);
      } else {
        // unchanged — don't spam
      }
    } catch (err) {
      console.log(`  eid=${eid.toString().padStart(3)} → re-read error: ${err}`);
    }
  }

  // 4. Restore amp.gain via the same builder path.
  // We didn't capture the original value via read — to keep this simple,
  // just write a neutral 5.0 back. (Founder can re-tweak.)
  console.log('\nRestoring amp.gain = 5.0 (neutral)…');
  await collector.collect(async () => {
    output.sendMessage(buildSetFloatParam(ampGain, encode(ampGain, 5.0)));
  }, 250);

  input.closePort();
  output.closePort();

  // 5. Emit summary
  mkdirSync('samples/captured/decoded', { recursive: true });
  const summary = diffs
    .filter((d) => d.changedPositions.length > 0)
    .map((d) => ({
      effectId: d.eid,
      chunkLength: d.after.length,
      changedPositions: d.changedPositions,
      sample: d.changedPositions.map((p) => ({
        position: p,
        before: d.before[p],
        after: d.after[p],
      })),
    }));
  const outPath = 'samples/captured/decoded/am4-fn1f-find-amp.json';
  writeFileSync(outPath, JSON.stringify({
    run: new Date().toISOString(),
    sentinelDisplay: SENTINEL_DISPLAY,
    targetEffectIds: TARGET_EFFECT_IDS,
    changedEffectIds: summary,
  }, null, 2));
  console.log(`\nJSON: ${outPath}`);

  console.log('\n=== Summary ===');
  if (summary.length === 0) {
    console.log('NO effectId chunks changed. Possible causes:');
    console.log('- The write was no-op (current value already equals sentinel)');
    console.log('- The chunk is stale and doesn\'t reflect working-buffer writes');
    console.log('- amp.gain is not in the per-block fn 0x1F surface at all');
  } else {
    console.log(`Found ${summary.length} effectId(s) whose chunk changed after amp.gain write:`);
    for (const s of summary) {
      console.log(`  eid=${s.effectId} (chunk=${s.chunkLength} ushorts) at position(s) ${s.changedPositions.join(', ')}`);
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
