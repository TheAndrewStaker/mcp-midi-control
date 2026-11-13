// verify-gen3-scene-channels.ts
//
// Golden for two gen-3 writer defects found in a 2026-09-14 FM3 session:
//   1. set_param dropped its `channel` argument, so `set_param(channel: "B")`
//      wrote whichever channel the active scene was on.
//   2. apply_preset never sent scenes[] or landingScene: the scene map passed
//      preflight and was silently discarded, so every scene kept the channel /
//      bypass state the last param write left behind.
//
// The fix selects the channel with fn=0x0B SET_CHANNEL before the param write,
// and walks each authored scene as SET_SCENE (0x0C) -> SET_CHANNEL (0x0B) per
// block -> SET_BYPASS (0x0A) per block, then lands on landingScene (default 1).
// On a real FM3 (fw 12) that sequence persisted through a store and decoded
// back per scene from the stored preset.
//
// Offline: the writer runs against a recording fake connection. No MIDI I/O.
//
// Run: npx tsx scripts/verify-gen3-scene-channels.ts

import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { createModernFractalDescriptor } from '../packages/fractal-gen3/src/factory.js';
import { FM3_CONFIG } from '../packages/fractal-gen3/src/configs/fm3.js';
import { GEN3_MODEL_FM3, recomputeGen3Checksum } from '../packages/fractal-gen3/src/simResponders.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const FN_SET_BYPASS = 0x0a;
const FN_SET_CHANNEL = 0x0b;
const FN_SET_SCENE = 0x0c;
const EFFECT_AMP_1 = 58;
const EFFECT_AMP_2 = 59;
const EFFECT_DRIVE_1 = 118;
const EFFECT_REVERB_1 = 66;

interface Recorder {
  ctx: DispatchCtx;
  sent: number[][];
}

/**
 * A connection that records every frame and never answers, which the gen-3
 * writer reads as "not rejected". `rejectFn` makes it answer a frame of that
 * function with a 0x64 rejection instead.
 */
function recorder(opts: { rejectFn?: number; rejectChannel?: number } = {}): Recorder {
  const sent: number[][] = [];
  let lastSent: number[] | undefined;
  let ampChannel = 0;
  const listeners = new Set<(bytes: number[]) => void>();
  const shouldReject = (bytes: number[]): boolean =>
    opts.rejectFn === bytes[5] &&
    (opts.rejectChannel === undefined || bytes[8] === opts.rejectChannel);
  const rejectFrame = (fn: number): number[] => recomputeGen3Checksum([
    0xf0, 0x00, 0x01, 0x74, GEN3_MODEL_FM3, 0x64, fn, 0x05, 0x00, 0xf7,
  ]);
  const conn = {
    send: (bytes: number[]) => {
      sent.push(bytes);
      lastSent = bytes;
      if (
        bytes[5] === FN_SET_CHANNEL &&
        effectIdOf(bytes) === EFFECT_AMP_1 &&
        !shouldReject(bytes)
      ) {
        ampChannel = bytes[8] ?? ampChannel;
      }
      if (shouldReject(bytes)) {
        const rejection = rejectFrame(bytes[5]);
        setTimeout(() => listeners.forEach((listener) => listener(rejection)), 0);
      }
    },
    receiveSysEx: () => Promise.reject(new Error('timeout')),
    receiveSysExMatching: (predicate: (bytes: number[]) => boolean) =>
      new Promise<number[]>((resolve, reject) => {
        // The writer registers the watch before sending, so answer on the next tick.
        setTimeout(() => {
          if (lastSent?.[5] === 0x13) {
            const state = (4 << 4) | (ampChannel << 1);
            const status = recomputeGen3Checksum([
              0xf0, 0x00, 0x01, 0x74, GEN3_MODEL_FM3, 0x13,
              EFFECT_AMP_1 & 0x7f, (EFFECT_AMP_1 >> 7) & 0x7f, state,
              0x00, 0xf7,
            ]);
            if (predicate(status)) {
              resolve(status);
              return;
            }
          }
          if (lastSent !== undefined && shouldReject(lastSent)) {
            const reject64 = rejectFrame(lastSent[5]);
            if (predicate(reject64)) {
              resolve(reject64);
              return;
            }
          }
          reject(new Error('timeout'));
        }, 0);
      }),
    onMessage: (listener: (bytes: number[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as MidiConnection;
  return { ctx: { conn } as DispatchCtx, sent };
}

const effectIdOf = (f: number[]): number => f[6] | (f[7] << 7);
const ofFn = (frames: number[][], fn: number): number[][] => frames.filter((f) => f[5] === fn);

const writer = createModernFractalDescriptor(FM3_CONFIG).writer;

// ── Case 1: set_param with a channel selects it before writing ──
console.log('Case 1: set_param(channel B) sends SET_CHANNEL before the param write');
{
  const { ctx, sent } = recorder();
  const result = await writer.setParam!(ctx, 'amp', 'drive', 32767, 1, undefined);
  const functions = sent.map((frame) => frame[5]);
  check('captures channel before mutation', functions[0] === 0x13, functions.join(','));
  check('SET_CHANNEL addresses Amp 1 (effect 58)', effectIdOf(sent[1]) === EFFECT_AMP_1);
  check('SET_CHANNEL carries channel B (wire 1)', sent[1]?.[8] === 1);
  check('verifies target before the param write', functions[2] === 0x13 && functions[3] === 0x01, functions.join(','));
  check('restores channel A and verifies it', functions[4] === FN_SET_CHANNEL && sent[4]?.[8] === 0 && functions[5] === 0x13, functions.join(','));
  check('result reports the channel it wrote', result.channel === 'B', String(result.channel));
}

// ── Case 2: no channel means no channel select (unchanged behavior) ──
console.log('Case 2: set_param without a channel writes the current channel only');
{
  const { ctx, sent } = recorder();
  const result = await writer.setParam!(ctx, 'amp', 'drive', 32767, undefined, undefined);
  check('no SET_CHANNEL frame', ofFn(sent, FN_SET_CHANNEL).length === 0);
  check('exactly one param write', sent.length === 1 && sent[0][5] === 0x01);
  check('result carries no channel', result.channel === undefined);
}

// ── Case 3: a rejected channel select aborts the write ──
console.log('Case 3: a 0x64 rejection of the channel select writes nothing');
{
  const { ctx, sent } = recorder({ rejectFn: FN_SET_CHANNEL });
  const result = await writer.setParam!(ctx, 'amp', 'drive', 32767, 2, undefined);
  check('not acked', result.acked === false);
  check('param write never sent', ofFn(sent, 0x01).length === 0, `${sent.length} frame(s)`);
  check('rejected select leaves channel unchanged', sent.map((frame) => frame[5]).join(',') === '19,11');
  check('warning names the channel select', /channel C select/.test(result.warning ?? ''), result.warning);
}

// ── Case 3b: a rejected parameter write still restores the original channel ──
console.log('Case 3b: a rejected parameter write restores channel A');
{
  const { ctx, sent } = recorder({ rejectFn: 0x01 });
  const result = await writer.setParam!(ctx, 'amp', 'drive', 32767, 1, undefined);
  const functions = sent.map((frame) => frame[5]);
  check('parameter rejection is reported', result.acked === false && /rejected set_param/.test(result.warning ?? ''));
  check('restore follows the rejected parameter write', functions.join(',') === '19,11,19,1,11,19', functions.join(','));
  check('restore selects channel A', sent[4]?.[8] === 0);
}

// ── Case 3c: a rejected restoration is an actionable recovery failure ──
console.log('Case 3c: rejected channel restoration cannot report success');
{
  const { ctx, sent } = recorder({ rejectFn: FN_SET_CHANNEL, rejectChannel: 0 });
  let message = '';
  try {
    await writer.setParam!(ctx, 'amp', 'drive', 32767, 1, undefined);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  check('throws recovery-required error', /restoring channel A was rejected.*Recovery is required/.test(message), message);
  check('parameter write was sent before failed restoration', ofFn(sent, 0x01).length === 1);
}

// ── Case 4: an out-of-range channel index is refused before any I/O ──
console.log('Case 4: channel index outside A..D is refused before sending');
{
  const { ctx, sent } = recorder();
  let threw = false;
  try {
    await writer.setParam!(ctx, 'amp', 'drive', 32767, 7, undefined);
  } catch {
    threw = true;
  }
  check('throws', threw);
  check('nothing sent', sent.length === 0);
}

// ── Case 5: apply_preset walks scenes[] and lands on landingScene ──
console.log('Case 5: apply_preset sends each scene as SET_SCENE -> SET_CHANNEL -> SET_BYPASS');
{
  const { ctx, sent } = recorder();
  const result = await writer.applyPreset!(ctx, {
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'drive', id: 'lead_drive' },
      { slot: { row: 2, col: 2 }, block_type: 'amp' },
      { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2 },
      { slot: { row: 2, col: 4 }, block_type: 'reverb' },
    ],
    scenes: [
      { scene: 1, name: 'Clean', channels: { amp: 'A', reverb: 'C' }, bypassed: { lead_drive: true } },
      { scene: 4, channels: { amp_2: 'D', lead_drive: 1 }, bypassed: { lead_drive: false, reverb: true } },
    ],
    landingScene: 4,
  });

  const sceneOps = sent.filter((f) => [FN_SET_SCENE, FN_SET_CHANNEL, FN_SET_BYPASS].includes(f[5]));
  const shape = sceneOps.map((f) =>
    f[5] === FN_SET_SCENE ? `S${f[6] + 1}` : `${f[5] === FN_SET_CHANNEL ? 'ch' : 'byp'}:${effectIdOf(f)}=${f[8]}`,
  );
  const expected = [
    'S1', `ch:${EFFECT_AMP_1}=0`, `ch:${EFFECT_REVERB_1}=2`, `byp:${EFFECT_DRIVE_1}=1`,
    'S4', `ch:${EFFECT_AMP_2}=3`, `ch:${EFFECT_DRIVE_1}=1`, `byp:${EFFECT_DRIVE_1}=0`, `byp:${EFFECT_REVERB_1}=1`,
    'S4',
  ];
  check('scene op sequence', shape.join(' ') === expected.join(' '), `got ${shape.join(' ')}`);
  check('scene ops come after block placement and params', sent.indexOf(sceneOps[0]) > 0);
  check('apply reports ok', result.ok === true, result.failed_step?.error);
  const sceneNameFrames = sent.filter((f) => f[5] === 0x01 && f[6] === 0x2b);
  check('scene 1 name goes out as one SET_SCENE_NAME (sub 0x2b)', sceneNameFrames.length === 1);
  check('no not-written note', !/NOT written/.test(result.warning ?? ''), result.warning);
}

// ── Case 6: an unknown channel letter fails the apply without sending it ──
console.log('Case 6: apply_preset refuses an unknown channel letter');
{
  const { ctx, sent } = recorder();
  const result = await writer.applyPreset!(ctx, {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
    scenes: [{ scene: 2, channels: { amp: 'X' } }],
  });
  check('apply not ok', result.ok === false);
  check('no SET_CHANNEL sent for the bad letter', ofFn(sent, FN_SET_CHANNEL).length === 0);
  check('still lands on scene 1', sent.at(-1)?.[5] === FN_SET_SCENE && sent.at(-1)?.[6] === 0);
}

// ── Case 7: no scenes and no landingScene means no scene traffic ──
console.log('Case 7: apply_preset without scenes sends no scene ops');
{
  const { ctx, sent } = recorder();
  await writer.applyPreset!(ctx, { slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }] });
  check('no SET_SCENE / SET_BYPASS frames', ofFn(sent, FN_SET_SCENE).length === 0 && ofFn(sent, FN_SET_BYPASS).length === 0);
}

if (failures > 0) {
  console.error(`\nverify-gen3-scene-channels: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nverify-gen3-scene-channels: all checks passed');
