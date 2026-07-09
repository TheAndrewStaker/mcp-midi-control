// verify-am4-fresh-build-channel.ts
//
// Regression test for BUG-4 (apply_preset fresh-build channel semantics).
//
// Root cause: a channel-block slot (amp/drive/reverb/delay) with flat
// `params` and no explicit `channel` emitted its param writes with NO
// channel-select op at all, so they landed on whatever channel the
// device happened to have active when the call ran. Unlisted scenes
// already defaulted their channel pointer to A, but listed scenes and
// the flat-param writes themselves did not, so a fresh build could be
// silently stranded on a channel no scene pointed at (2026-07-03 hardware
// report: scene 2 active [channel B], recipe applied, landing scene 1
// pointed at channel A, which still held the OLD preset's values).
//
// Fix (Steph's chosen option, 2026-07-04): flat channel-block params
// with no explicit channel always target channel A, and every scene
// (listed or unlisted) that doesn't explicitly map that block's channel
// also defaults to A. Together this guarantees a fresh build is audible
// on the default landing scene regardless of what channel was active
// before the call.
//
// Offline op-emission check: build the prepared write list and assert
// on op order/shape, no MIDI I/O.
//
// Run: npx tsx scripts/verify-am4-fresh-build-channel.ts

import {
  prepareApplyPresetWrites,
  type ApplyPresetPreparedWrite,
} from '@mcp-midi-control/am4/tools/applyExecutor.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

type ChannelWrite = Extract<ApplyPresetPreparedWrite, { kind: 'channel' }>;
type SceneChannelWrite = Extract<ApplyPresetPreparedWrite, { kind: 'scene_channel' }>;
type SwitchSceneWrite = Extract<ApplyPresetPreparedWrite, { kind: 'am4_switch_scene' }>;

// ── Case 1: original repro shape — flat params, no channel, no scenes ──
{
  const { prepared } = prepareApplyPresetWrites({
    slots: [
      { position: 1, block_type: 'compressor', params: { type: 'JFET Studio Compressor' } },
      { position: 2, block_type: 'amp', params: { type: 'Brit Silver', gain: 4 } },
    ],
  });

  const ampChannelIdx = prepared.findIndex(
    (p): p is ChannelWrite => p.kind === 'channel' && p.block === 'amp',
  );
  const ampParamIdx = prepared.findIndex((p) => p.kind === 'param' && p.block === 'amp');

  check(
    'flat amp params (no explicit channel) emit an implicit channel-A select',
    ampChannelIdx !== -1 && (prepared[ampChannelIdx] as ChannelWrite).index === 0,
    `ampChannelIdx=${ampChannelIdx}`,
  );
  check(
    'the implicit channel-A select fires BEFORE the amp param writes',
    ampChannelIdx !== -1 && ampParamIdx !== -1 && ampChannelIdx < ampParamIdx,
    `ampChannelIdx=${ampChannelIdx}, ampParamIdx=${ampParamIdx}`,
  );

  const sceneChannelWrites = prepared.filter(
    (p): p is SceneChannelWrite => p.kind === 'scene_channel' && p.block === 'amp',
  );
  check(
    'every one of the 4 unlisted scenes points amp at channel A (index 0)',
    sceneChannelWrites.length === 4 && sceneChannelWrites.every((w) => w.index === 0),
    `sceneChannelWrites=${JSON.stringify(sceneChannelWrites.map((w) => ({ scene: w.sceneIndex, index: w.index })))}`,
  );

  const switchWrites = prepared.filter((p): p is SwitchSceneWrite => p.kind === 'am4_switch_scene');
  const landingSwitch = switchWrites[switchWrites.length - 1];
  check(
    'default landingScene (1) is the final scene switch',
    landingSwitch !== undefined && landingSwitch.sceneIndex === 0,
    `landingSwitch=${JSON.stringify(landingSwitch)}`,
  );
}

// ── Case 2: explicit `channel` overrides the default ────────────────────
{
  const { prepared } = prepareApplyPresetWrites({
    slots: [{ position: 2, block_type: 'amp', channel: 'B', params: { type: 'Brit Silver', gain: 4 } }],
  });
  const ampChannelWrites = prepared.filter(
    (p): p is ChannelWrite => p.kind === 'channel' && p.block === 'amp',
  );
  check(
    'explicit channel:"B" emits exactly ONE channel select, to B (index 1), no default-A duplicate',
    ampChannelWrites.length === 1 && ampChannelWrites[0].index === 1,
    `ampChannelWrites=${JSON.stringify(ampChannelWrites)}`,
  );
}

// ── Case 3: `channels` (multi-channel map) is untouched by the default ──
{
  const { prepared } = prepareApplyPresetWrites({
    slots: [
      {
        position: 2,
        block_type: 'amp',
        channels: { A: { type: 'Shiver Clean', gain: 3 }, B: { type: 'Friedman BE', gain: 6 } },
      },
    ],
  });
  const ampChannelWrites = prepared.filter(
    (p): p is ChannelWrite => p.kind === 'channel' && p.block === 'amp',
  );
  check(
    'multi-channel `channels` map still emits exactly its own 2 channel selects (A, B), no extra default',
    ampChannelWrites.length === 2
      && ampChannelWrites.some((w) => w.index === 0)
      && ampChannelWrites.some((w) => w.index === 1),
    `ampChannelWrites=${JSON.stringify(ampChannelWrites)}`,
  );
}

// ── Case 4: an EXPLICITLY listed scene that omits this block's channel
// still defaults it to A (the "incomplete scenes input" edge case beyond
// the original repro — a scene that names some fields but not channels
// must not leave a placed channel-block's pointer stale). ─────────────
{
  const { prepared } = prepareApplyPresetWrites({
    slots: [{ position: 2, block_type: 'amp', params: { type: 'Brit Silver', gain: 4 } }],
    scenes: [{ index: 1, bypass: { amp: false } }],
    landingScene: 1,
  });
  const scene1ChannelWrite = prepared.find(
    (p): p is SceneChannelWrite => p.kind === 'scene_channel' && p.block === 'amp' && p.sceneIndex === 0,
  );
  check(
    'scene 1, explicitly listed but with no `channels` field, still defaults amp to channel A',
    scene1ChannelWrite !== undefined && scene1ChannelWrite.index === 0,
    `scene1ChannelWrite=${JSON.stringify(scene1ChannelWrite)}`,
  );
}

// ── Case 5: a scene that explicitly maps this block to a DIFFERENT
// channel is respected (no default stomps an explicit choice). ─────────
{
  const { prepared } = prepareApplyPresetWrites({
    slots: [{ position: 2, block_type: 'amp', channel: 'C', params: { type: 'Brit Silver', gain: 4 } }],
    scenes: [{ index: 1, channels: { amp: 'C' } }],
    landingScene: 1,
  });
  const scene1ChannelWrites = prepared.filter(
    (p): p is SceneChannelWrite => p.kind === 'scene_channel' && p.block === 'amp' && p.sceneIndex === 0,
  );
  check(
    'scene 1 explicitly mapped to channel C is respected (exactly one write, index 2), not overridden to A',
    scene1ChannelWrites.length === 1 && scene1ChannelWrites[0].index === 2,
    `scene1ChannelWrites=${JSON.stringify(scene1ChannelWrites)}`,
  );
}

if (failures === 0) {
  console.log('\nverify-am4-fresh-build-channel: all assertions passed.');
  process.exit(0);
}
console.error(`\nverify-am4-fresh-build-channel: ${failures} failure(s).`);
process.exit(1);
