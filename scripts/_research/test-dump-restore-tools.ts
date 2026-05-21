/**
 * BK-083 — exercise axefx2_dump_preset + axefx2_restore_preset directly.
 *
 * Calls the tool registration functions to register them on an in-memory
 * server, then invokes the tool handlers exactly the way the MCP runtime
 * would.
 *
 * Test flow:
 *   1. dump_preset(666) → save bytes_base64
 *   2. Modify a single byte client-side, recompute hash (do this manually
 *      to verify dump→edit→restore round-trip end to end).
 *   3. restore_preset(modified_bytes, location=666, save_authorized=true).
 *   4. dump_preset(666) again → confirm modification stuck.
 *
 * No new wire mechanism — exercises the same logic as
 * bk070-modified-push-with-hash.ts but through the new tool surface.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAxeFxIIPresetBinaryTools,
} from '@mcp-midi-control/axe-fx-ii/tools/presetBinary.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';

registerDevice(AXEFX2_DESCRIPTOR);

interface ToolHandler {
  (input: unknown): Promise<{ structuredContent?: unknown }>;
}

const handlers = new Map<string, ToolHandler>();

// Build a stub server that captures tool handlers.
const server = {
  registerTool(name: string, _meta: unknown, handler: ToolHandler): void {
    handlers.set(name, handler);
  },
} as unknown as McpServer;

async function main(): Promise<void> {
  registerAxeFxIIPresetBinaryTools(server);
  console.log(`Registered tools: ${[...handlers.keys()].join(', ')}\n`);

  console.log('Setup: switch to preset 666 (discard any edits)');
  await executeSwitchPreset({
    port: 'axe-fx-ii',
    location: 666,
    on_active_preset_edited: 'discard',
  });
  await new Promise((r) => setTimeout(r, 250));

  console.log('\n--- Test 1: axefx2_dump_preset({ location: 666 }) ---');
  const dump1 = handlers.get('axefx2_dump_preset');
  if (!dump1) throw new Error('axefx2_dump_preset not registered');
  const dump1Result = await dump1({ location: 666 });
  const dump1Data = dump1Result.structuredContent as {
    name: string;
    location_display: number;
    location_wire: number;
    blocks: Array<{ recordIndex: number; blockName: string; blockId: number }>;
    footer_hash: string;
    bytes_base64: string;
    byte_length: number;
    hash_integrity: string;
  };
  console.log(`  Name: "${dump1Data.name}"`);
  console.log(`  Location wire: ${dump1Data.location_wire}, display: ${dump1Data.location_display}`);
  console.log(`  Byte length: ${dump1Data.byte_length}`);
  console.log(`  Footer hash: ${dump1Data.footer_hash}`);
  console.log(`  Hash integrity: ${dump1Data.hash_integrity}`);
  console.log(`  Blocks (${dump1Data.blocks.length}):`);
  for (const b of dump1Data.blocks) {
    console.log(`    rec ${b.recordIndex}: ${b.blockName} (id ${b.blockId})`);
  }

  console.log('\n--- Test 2: restore the dump back unchanged ---');
  // Take the bytes_base64, restore them. Should land with 0 NACKs and
  // re-dump byte-identical.
  const restore = handlers.get('axefx2_restore_preset');
  if (!restore) throw new Error('axefx2_restore_preset not registered');
  const restore1Result = await restore({
    bytes_base64: dump1Data.bytes_base64,
    location: 666,
    save_authorized: true,
  });
  const restore1Data = restore1Result.structuredContent as {
    ok: boolean;
    frames_sent: number;
    acks_received: number;
    nacks: unknown[];
    saved_to_location?: number;
    name: string;
  };
  console.log(`  ok: ${restore1Data.ok}`);
  console.log(`  frames_sent: ${restore1Data.frames_sent}`);
  console.log(`  acks_received: ${restore1Data.acks_received}`);
  console.log(`  nacks: ${restore1Data.nacks.length}`);
  console.log(`  saved_to_location: ${restore1Data.saved_to_location}`);

  console.log('\n--- Test 3: dump again, confirm bytes are byte-identical ---');
  const dump2Result = await dump1({ location: 666 });
  const dump2Data = dump2Result.structuredContent as {
    bytes_base64: string;
    footer_hash: string;
    name: string;
  };
  if (dump2Data.bytes_base64 === dump1Data.bytes_base64) {
    console.log(`  ✅ Re-dump bytes are IDENTICAL to original dump`);
  } else {
    console.log(`  ❌ Re-dump bytes DIFFER`);
    // Find the difference.
    const a = Buffer.from(dump1Data.bytes_base64, 'base64');
    const b = Buffer.from(dump2Data.bytes_base64, 'base64');
    let firstDiff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { firstDiff = i; break; }
    }
    console.log(`  first byte diff at offset ${firstDiff}`);
  }

  console.log('\n--- Test 4: modify a byte + recompute hash + restore ---');
  // Take dump bytes, modify chunkPayload[3][179] (a known data byte in
  // Test Crunch's amp.input_drive region), recompute footer, restore.
  const baselineBytes = Buffer.from(dump1Data.bytes_base64, 'base64');
  const modified = new Uint8Array(baselineBytes);
  // Find the chunk-3 message: header (12) + 3 chunks (3*202) = 12+606 = 618.
  // chunk 4 payload starts at byte 618 + 6 = 624 (skip envelope F0 00 01 74 07 78).
  // chunkPayload[3][179] = byte 618 + 6 + 179 = byte 803.
  const HEADER_LEN = 12;
  const CHUNK_LEN = 202;
  const ENV_PREFIX = 6;
  const target_byte = HEADER_LEN + 3 * CHUNK_LEN + ENV_PREFIX + 179;
  console.log(`  flipping byte at offset ${target_byte} (CHUNK03:179): 0x${modified[target_byte].toString(16)} → 0x55`);
  modified[target_byte] = 0x55;

  // Recompute the chunk-3 checksum (last byte before F7) since we changed
  // a payload byte. The serializer in presetDump.ts handles this when
  // re-parsing+re-serializing, but the simpler approach: recompute
  // checksum of the chunk envelope.
  // chunk-3 message: bytes [HEADER_LEN + 3*CHUNK_LEN .. HEADER_LEN + 4*CHUNK_LEN - 1]
  const msgStart = HEADER_LEN + 3 * CHUNK_LEN;
  const msgEnd = msgStart + CHUNK_LEN;
  let cs = 0;
  for (let i = msgStart; i < msgEnd - 2; i++) cs ^= modified[i];
  modified[msgEnd - 2] = cs & 0x7f;
  console.log(`  recomputed chunk-3 envelope checksum: 0x${(cs & 0x7f).toString(16)}`);

  // Recompute the footer hash too. Use the same XOR-fold logic.
  // For brevity, just call the restore with the modified bytes — the
  // tool itself will validate the hash and reject if invalid. We need
  // to recompute it before calling.
  function decodeChunkNative(payload: Uint8Array): Uint16Array {
    const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      const off = 2 + i * 3;
      out[i] = ((payload[off] & 0x7f) | ((payload[off+1] & 0x7f) << 7) | ((payload[off+2] & 0x7f) << 14)) & 0xffff;
    }
    return out;
  }
  let newHash = 0;
  for (let c = 0; c < 64; c++) {
    const chunkOffset = HEADER_LEN + c * CHUNK_LEN + ENV_PREFIX;
    const payload = modified.slice(chunkOffset, chunkOffset + 194);
    for (const u of decodeChunkNative(payload)) newHash ^= u;
  }
  newHash &= 0xffff;
  console.log(`  new footer hash: 0x${newHash.toString(16).padStart(4, '0')}`);

  // Footer message starts at HEADER_LEN + 64 * CHUNK_LEN. Payload is at
  // +6, +7, +8. Checksum at +9. F7 at +10.
  const footerStart = HEADER_LEN + 64 * CHUNK_LEN;
  const origByte2 = modified[footerStart + 8];
  modified[footerStart + 6] = newHash & 0x7f;
  modified[footerStart + 7] = (newHash >> 7) & 0x7f;
  modified[footerStart + 8] = (origByte2 & 0x7c) | ((newHash >> 14) & 0x03);
  // Recompute footer envelope checksum.
  let fcs = 0;
  for (let i = footerStart; i < footerStart + 9; i++) fcs ^= modified[i];
  modified[footerStart + 9] = fcs & 0x7f;
  console.log(`  recomputed footer envelope checksum: 0x${(fcs & 0x7f).toString(16)}`);

  console.log('\nRestoring modified preset with save_authorized=true');
  const modifiedB64 = Buffer.from(modified).toString('base64');
  const restore2Result = await restore({
    bytes_base64: modifiedB64,
    location: 666,
    save_authorized: true,
  });
  const restore2Data = restore2Result.structuredContent as {
    ok: boolean;
    frames_sent: number;
    nacks: unknown[];
    saved_to_location?: number;
  };
  console.log(`  ok: ${restore2Data.ok}`);
  console.log(`  nacks: ${restore2Data.nacks.length}`);
  console.log(`  saved_to_location: ${restore2Data.saved_to_location}`);

  console.log('\n--- Test 5: re-dump, confirm modification stuck ---');
  const dump3Result = await dump1({ location: 666 });
  const dump3Data = dump3Result.structuredContent as { bytes_base64: string; footer_hash: string };
  const dump3Bytes = Buffer.from(dump3Data.bytes_base64, 'base64');
  if (dump3Bytes[target_byte] === 0x55) {
    console.log(`  ✅ Byte at offset ${target_byte} = 0x55 — modification persisted`);
  } else {
    console.log(`  ❌ Byte at offset ${target_byte} = 0x${dump3Bytes[target_byte].toString(16)} (expected 0x55)`);
  }
  console.log(`  Re-dumped footer hash: ${dump3Data.footer_hash}`);

  console.log('\n=== ALL TESTS COMPLETE ===');
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
