/**
 * Test the new axefx2_atomic_apply MCP tool end-to-end.
 *
 * Demonstrates the FULL kill of BK-058 + atomic param writes in one
 * round-trip:
 *   - Amp 1: set scenes 1,3,5,7 to Y, scenes 2 bypassed, plus input_drive=0x4000
 *   - Drive 1: set scenes 2,4,6,8 to Y, scene 1 bypassed, plus a param value
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAxeFxIIPresetBinaryTools } from '@mcp-midi-control/axe-fx-ii/tools/presetBinary.js';
import { registerAxeFxIIAtomicApplyTool } from '@mcp-midi-control/axe-fx-ii/research/atomicApply.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { BLOCK_LAYOUT_MAP, paramLocation } from '@mcp-midi-control/axe-fx-ii/sceneChannelMap.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const handlers = new Map<string, (i: unknown) => Promise<{ structuredContent?: unknown }>>();
const server = {
  registerTool(n: string, _m: unknown, h: (i: unknown) => Promise<{ structuredContent?: unknown }>) {
    handlers.set(n, h);
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

async function main(): Promise<void> {
  registerAxeFxIIPresetBinaryTools(server);
  registerAxeFxIIAtomicApplyTool(server);
  console.log(`Tools: ${[...handlers.keys()].join(', ')}\n`);

  await executeSwitchPreset({ port: 'axe-fx-ii', location: 666, on_active_preset_edited: 'discard' });
  await new Promise((r) => setTimeout(r, 250));

  console.log('--- Step 1: dump baseline ---');
  const dump = handlers.get('axefx2_dump_preset')!;
  const baseline = await dump({ location: 666 });
  const baselineData = baseline.structuredContent as { bytes_base64: string; name: string };
  console.log(`  Preset: "${baselineData.name}"`);

  console.log('\n--- Step 2: invoke axefx2_atomic_apply ---');
  const atomic = handlers.get('axefx2_atomic_apply')!;
  const r = await atomic({
    location: 666,
    save_authorized: true,
    blocks: [
      {
        block: 'Amp 1',
        scenes_on_y: [1, 3, 5, 7],
        scenes_bypassed: [2],
        params: {
          // input_drive (paramId 1) = wire 0x4000 (= roughly 50% display)
          input_drive: 0x4000,
          // master_volume (paramId 5) = wire 0x2000 (= roughly 25% display)
          master_volume: 0x2000,
        },
      },
      {
        block: 'Drive 1',
        scenes_on_y: [2, 4, 6, 8],
        scenes_bypassed: [1, 8],
      },
    ],
  });
  console.log(JSON.stringify(r.structuredContent, null, 2));

  console.log('\n--- Step 3: re-dump and verify ---');
  const after = await dump({ location: 666 });
  const afterData = after.structuredContent as { bytes_base64: string };
  const afterBytes = new Uint8Array(Buffer.from(afterData.bytes_base64, 'base64'));
  const parsed = parsePresetDump(afterBytes);

  console.log('  Per-scene state check:');
  const ampLayout = BLOCK_LAYOUT_MAP.get(106)!;
  const ampUshort = decodeChunkNative(parsed.chunkPayloads[ampLayout.sceneStateChunk])[ampLayout.sceneStateUshort];
  console.log(`    Amp 1 c${ampLayout.sceneStateChunk}:u${ampLayout.sceneStateUshort} = 0x${ampUshort.toString(16).padStart(4, '0')}`);
  console.log(`      bypass bitmap (bits 0-7): 0b${(ampUshort & 0xff).toString(2).padStart(8, '0')} (scene 2 expected = bit 1 = 0x02)`);
  console.log(`      channel-Y bitmap (bits 8-15): 0b${((ampUshort >> 8) & 0xff).toString(2).padStart(8, '0')} (scenes 1,3,5,7 expected = bits 8,10,12,14)`);

  const driveLayout = BLOCK_LAYOUT_MAP.get(133)!;
  const driveUshort = decodeChunkNative(parsed.chunkPayloads[driveLayout.sceneStateChunk])[driveLayout.sceneStateUshort];
  console.log(`    Drive 1 c${driveLayout.sceneStateChunk}:u${driveLayout.sceneStateUshort} = 0x${driveUshort.toString(16).padStart(4, '0')}`);
  console.log(`      bypass bitmap: 0b${(driveUshort & 0xff).toString(2).padStart(8, '0')} (scenes 1,8 expected = bits 0,7 = 0x81)`);
  console.log(`      channel-Y bitmap: 0b${((driveUshort >> 8) & 0xff).toString(2).padStart(8, '0')} (scenes 2,4,6,8 expected = bits 9,11,13,15)`);

  console.log('  Param check:');
  const inputDriveLoc = paramLocation(106, 1)!;
  const inputDriveVal = decodeChunkNative(parsed.chunkPayloads[inputDriveLoc.chunk])[inputDriveLoc.ushort];
  console.log(`    Amp 1 input_drive (paramId 1) at c${inputDriveLoc.chunk}:u${inputDriveLoc.ushort} = 0x${inputDriveVal.toString(16).padStart(4, '0')} (expected 0x4000)`);

  const masterVolLoc = paramLocation(106, 5)!;
  const masterVolVal = decodeChunkNative(parsed.chunkPayloads[masterVolLoc.chunk])[masterVolLoc.ushort];
  console.log(`    Amp 1 master_volume (paramId 5) at c${masterVolLoc.chunk}:u${masterVolLoc.ushort} = 0x${masterVolVal.toString(16).padStart(4, '0')} (expected 0x2000)`);

  // Verdict
  const ampOK = ((ampUshort & 0xff) === 0x02) && (((ampUshort >> 8) & 0xff) === 0x55);
  const driveOK = ((driveUshort & 0xff) === 0x81) && (((driveUshort >> 8) & 0xff) === 0xaa);
  const paramOK = inputDriveVal === 0x4000 && masterVolVal === 0x2000;
  console.log('\n=== VERDICT ===');
  console.log(`  Amp scene state:  ${ampOK ? '✅' : '❌'}`);
  console.log(`  Drive scene state: ${driveOK ? '✅' : '❌'}`);
  console.log(`  Amp params:        ${paramOK ? '✅' : '❌'}`);
  if (ampOK && driveOK && paramOK) {
    console.log('\n🎯 ATOMIC APPLY WORKS — multi-block, multi-scene, multi-param in one round-trip');
  }

  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
