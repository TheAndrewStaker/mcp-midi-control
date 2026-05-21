/**
 * Test: atomic apply writes BOTH channels' param values in ONE round-trip.
 *
 * For Amp 1, set:
 *   X.input_drive = 0x2222
 *   X.master_volume = 0x3333
 *   Y.input_drive = 0xAAAA
 *   Y.master_volume = 0xBBBB
 *   scenes 1,3,5,7 on Y
 *
 * For Drive 1:
 *   X.drive = 0x4444
 *   Y.drive = 0xCCCC
 *
 * Single atomic_apply call. Verify each value lands at the correct
 * (chunk, ushort) location.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAxeFxIIPresetBinaryTools } from '@mcp-midi-control/axe-fx-ii/tools/presetBinary.js';
import { registerAxeFxIIAtomicApplyTool } from '@mcp-midi-control/axe-fx-ii/research/atomicApply.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { BLOCK_LAYOUT_MAP, paramLocationForChannel } from '@mcp-midi-control/axe-fx-ii/sceneChannelMap.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const handlers = new Map<string, (i: unknown) => Promise<{ structuredContent?: unknown }>>();
const server = {
  registerTool(n: string, _m: unknown, h: (i: unknown) => Promise<{ structuredContent?: unknown }>) {
    handlers.set(n, h);
  },
} as unknown as McpServer;

function decodeChunk(p: Uint8Array): Uint16Array {
  const c = (p[0]&0x7f)|((p[1]&0x7f)<<7);
  const o = new Uint16Array(c);
  for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; }
  return o;
}

async function main(): Promise<void> {
  registerAxeFxIIPresetBinaryTools(server);
  registerAxeFxIIAtomicApplyTool(server);

  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise(r => setTimeout(r, 250));

  console.log('--- Step 1: dump baseline (Test Crunch) ---');
  const dump = handlers.get('axefx2_dump_preset')!;
  const baseline = await dump({ location: 666 });
  const baselineData = baseline.structuredContent as { bytes_base64: string; name: string };
  console.log(`  preset: "${baselineData.name}"`);

  console.log('\n--- Step 2: atomic_apply with X+Y param specs ---');
  const atomic = handlers.get('axefx2_atomic_apply')!;
  const r = await atomic({
    location: 666,
    save_authorized: true,
    blocks: [
      {
        block: 'Amp 1',
        scenes_on_y: [1, 3, 5, 7],
        scenes_bypassed: [],
        params_x: { input_drive: 0x2222, master_volume: 0x3333 },
        params_y: { input_drive: 0xAAAA, master_volume: 0xBBBB },
      },
      {
        block: 'Drive 1',
        params_x: { drive: 0x4444 },
        params_y: { drive: 0xCCCC },
      },
    ],
  });
  console.log(JSON.stringify(r.structuredContent, null, 2).slice(0, 1500));

  console.log('\n--- Step 3: re-dump and verify each channel\'s storage ---');
  const after = await dump({ location: 666 });
  const afterData = after.structuredContent as { bytes_base64: string };
  const afterBytes = new Uint8Array(Buffer.from(afterData.bytes_base64, 'base64'));
  const parsed = parsePresetDump(afterBytes);

  interface Check {
    block: number;
    paramId: number;
    paramName: string;
    channel: 'X' | 'Y';
    expected: number;
  }
  const checks: Check[] = [
    { block: 106, paramId: 1, paramName: 'amp.input_drive', channel: 'X', expected: 0x2222 },
    { block: 106, paramId: 1, paramName: 'amp.input_drive', channel: 'Y', expected: 0xAAAA },
    { block: 106, paramId: 5, paramName: 'amp.master_volume', channel: 'X', expected: 0x3333 },
    { block: 106, paramId: 5, paramName: 'amp.master_volume', channel: 'Y', expected: 0xBBBB },
    { block: 133, paramId: 1, paramName: 'drive.drive', channel: 'X', expected: 0x4444 },
    { block: 133, paramId: 1, paramName: 'drive.drive', channel: 'Y', expected: 0xCCCC },
  ];

  let allPass = true;
  for (const check of checks) {
    const loc = paramLocationForChannel(check.block, check.paramId, check.channel);
    if (!loc) {
      console.log(`  ❌ ${check.paramName} channel ${check.channel}: paramLocationForChannel failed`);
      allPass = false;
      continue;
    }
    const value = decodeChunk(parsed.chunkPayloads[loc.chunk])[loc.ushort];
    const ok = value === check.expected;
    console.log(`  ${ok ? '✅' : '❌'} ${check.paramName} channel ${check.channel} at c${loc.chunk}:u${loc.ushort} = 0x${value.toString(16).padStart(4,'0')} (expected 0x${check.expected.toString(16).padStart(4,'0')})`);
    if (!ok) allPass = false;
  }

  console.log('\n================================================================');
  if (allPass) {
    console.log('🎯 ATOMIC DUAL-CHANNEL APPLY WORKS — all 6 (block, channel, param) writes landed in one round-trip');
  } else {
    console.log('❌ Some writes did NOT land at the expected location');
  }
  console.log('================================================================');

  setTimeout(() => process.exit(allPass ? 0 : 1), 200);
}

main().catch((e) => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
