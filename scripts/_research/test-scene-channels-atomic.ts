/**
 * BK-070 / BK-058 — exercise axefx2_set_scene_channels end-to-end.
 *
 * This is the proof that atomic apply kills the channel-Y write loss bug:
 *
 *   1. Dump preset 666 → record current scene-channel state.
 *   2. Call axefx2_set_scene_channels to set:
 *      - Amp 1: scenes 2,4,6,8 on Y
 *      - Drive 1: scenes 1,3,5,7 on Y
 *      - Delay 1: scenes 4,5,6,7 on Y
 *      (mix of even/odd scenes per block to make patterns easy to verify)
 *   3. Dump again → assert exactly those scenes are on Y for each block.
 *
 * The OLD code path (sequential SET_BLOCK_CHANNEL fn 0x11 frames) drops
 * channel-Y writes when scenes aren't all active simultaneously. The
 * new atomic-apply path patches the binary directly, so NO race exists.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAxeFxIIPresetBinaryTools,
} from '@mcp-midi-control/axe-fx-ii/tools/presetBinary.js';
import {
  registerAxeFxIISceneChannelsTool,
} from '@mcp-midi-control/axe-fx-ii/tools/sceneChannels.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import {
  SCENE_CHANNEL_MAP,
} from '@mcp-midi-control/axe-fx-ii/sceneChannelMap.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

interface ToolHandler {
  (input: unknown): Promise<{ structuredContent?: unknown }>;
}

const handlers = new Map<string, ToolHandler>();
const server = {
  registerTool(name: string, _meta: unknown, handler: ToolHandler): void {
    handlers.set(name, handler);
  },
} as unknown as McpServer;

function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    out[i] = ((payload[off] & 0x7f) | ((payload[off + 1] & 0x7f) << 7) | ((payload[off + 2] & 0x7f) << 14)) & 0xffff;
  }
  return out;
}

function readChannelBitmap(bytes: Uint8Array, blockEffectId: number): { scenesOnY: number[]; rawUshort: number } {
  const loc = SCENE_CHANNEL_MAP.get(blockEffectId);
  if (!loc) throw new Error(`No map entry for effectId ${blockEffectId}`);
  const parsed = parsePresetDump(bytes);
  const chunk = decodeChunkNative(parsed.chunkPayloads[loc.chunk]);
  const u = chunk[loc.ushort];
  const scenesOnY: number[] = [];
  for (let scene = 1; scene <= 8; scene++) {
    if (u & (1 << (7 + scene))) scenesOnY.push(scene);
  }
  return { scenesOnY, rawUshort: u };
}

async function main(): Promise<void> {
  registerAxeFxIIPresetBinaryTools(server);
  registerAxeFxIISceneChannelsTool(server);
  console.log(`Tools registered: ${[...handlers.keys()].join(', ')}\n`);

  console.log('Setup: switch to preset 666 (discard)');
  await executeSwitchPreset({
    port: 'axe-fx-ii',
    location: 666,
    on_active_preset_edited: 'discard',
  });
  await new Promise((r) => setTimeout(r, 250));

  // Step 1: dump baseline
  console.log('\n--- Step 1: dump baseline ---');
  const dump = handlers.get('axefx2_dump_preset')!;
  const baselineResult = await dump({ location: 666 });
  const baselineData = baselineResult.structuredContent as { bytes_base64: string; name: string };
  const baselineBytes = new Uint8Array(Buffer.from(baselineData.bytes_base64, 'base64'));
  console.log(`  Preset: "${baselineData.name}"`);
  for (const [effectId, loc] of SCENE_CHANNEL_MAP.entries()) {
    const { scenesOnY, rawUshort } = readChannelBitmap(baselineBytes, effectId);
    console.log(`  ${loc.blockName} (id ${effectId}): ushort=0x${rawUshort.toString(16).padStart(4, '0')}  scenes-on-Y=[${scenesOnY.join(',')}]`);
  }

  // Step 2: atomic set
  console.log('\n--- Step 2: atomic set_scene_channels ---');
  const setChannels = handlers.get('axefx2_set_scene_channels')!;
  const targets = [
    { block: 'Amp 1', scenes_on_y: [2, 4, 6, 8] },
    { block: 'Drive 1', scenes_on_y: [1, 3, 5, 7] },
    { block: 'Delay 1', scenes_on_y: [4, 5, 6, 7] },
  ];
  const setResult = await setChannels({
    location: 666,
    assignments: targets,
    save_authorized: true,
  });
  const setData = setResult.structuredContent as {
    ok: boolean;
    nacks: Array<{ acked_fn: string; result_code: string }>;
    nack_count: number;
    saved_to_location?: number;
    new_footer_hash: string;
    applied: Array<{ block: string; chunk: number; ushort: number; before: string; after: string }>;
  };
  console.log(`  ok: ${setData.ok}`);
  console.log(`  nack_count: ${setData.nack_count}`);
  console.log(`  nacks: ${JSON.stringify(setData.nacks)}`);
  console.log(`  saved_to_location: ${setData.saved_to_location}`);
  console.log(`  new_footer_hash: ${setData.new_footer_hash}`);
  for (const a of setData.applied) {
    console.log(`  ${a.block}: chunk ${a.chunk} ushort ${a.ushort}  ${a.before} → ${a.after}`);
  }

  // Step 3: re-dump and verify
  console.log('\n--- Step 3: re-dump and verify per-scene state ---');
  const afterResult = await dump({ location: 666 });
  const afterData = afterResult.structuredContent as { bytes_base64: string };
  const afterBytes = new Uint8Array(Buffer.from(afterData.bytes_base64, 'base64'));

  let allCorrect = true;
  for (const target of targets) {
    const block = [...SCENE_CHANNEL_MAP.entries()].find(([_, v]) => v.blockName === target.block);
    if (!block) continue;
    const [effectId, loc] = block;
    const { scenesOnY } = readChannelBitmap(afterBytes, effectId);
    const expected = [...target.scenes_on_y].sort();
    const actual = [...scenesOnY].sort();
    const match = expected.length === actual.length && expected.every((v, i) => v === actual[i]);
    const status = match ? '✅' : '❌';
    console.log(`  ${status} ${loc.blockName}: expected scenes-on-Y=[${expected.join(',')}] actual=[${actual.join(',')}]`);
    if (!match) allCorrect = false;
  }

  console.log('\n================================================================');
  console.log(allCorrect ? '🎯 ALL SCENE CHANNELS LANDED — BK-058 BYPASSED' : '❌ MISMATCH — atomic apply has a bug');
  console.log('================================================================');

  setTimeout(() => process.exit(allCorrect ? 0 : 1), 200);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
