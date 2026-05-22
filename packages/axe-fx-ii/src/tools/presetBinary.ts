/**
 * Axe-Fx II byte-exact preset binary tools, BK-083.
 *
 * Built on BK-070's atomic-apply finding (Session 115). The 12,951-byte
 * preset binary is fully decodable and modifiable:
 *
 *   - `axefx2_dump_preset`, read any stored preset (or the active
 *     working buffer) as raw bytes plus a parsed metadata snapshot
 *     (name, block-record list, footer hash). The raw bytes can be
 *     archived as a .syx for byte-exact backup.
 *
 *   - `axefx2_restore_preset`, push a 12,951-byte binary back to the
 *     device, optionally saving to a target slot. Validates the footer
 *     hash before pushing so corrupted bytes never reach the device.
 *
 * Wire mechanism: fn 0x03 (PATCH_DUMP) with explicit `[hi, lo]`
 * MSB-first payload returns the 66-message preset binary. The same 66
 * messages can be pushed back to the working buffer (0 NACKs verified
 * on hardware Session 115); STORE_PRESET commits to flash.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  parsePresetDump,
  PRESET_DUMP_LEN,
  CHUNKS_PER_PRESET,
  HEADER_LEN,
  CHUNK_LEN,
  FOOTER_LEN,
  extractPresetName,
  type ParsedPresetDump,
} from '../presetDump.js';
import {
  buildGetPresetNumber,
  isGetPresetNumberResponse,
  parseGetPresetNumberResponse,
  buildStorePreset,
  isStorePresetResponse,
  parseStorePresetResponse,
} from 'fractal-midi/axe-fx-ii';
import { AXE_FX_II_BLOCKS } from 'fractal-midi/axe-fx-ii';

import { ensureConn, GET_RESPONSE_TIMEOUT_MS } from './shared.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';

// ── wire helpers ─────────────────────────────────────────────────────

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const AXEFX2_MODEL = 0x07;
const FN_PATCH_DUMP = 0x03;
const FN_PATCH_HEADER = 0x77;
const FN_PATCH_CHUNK = 0x78;
const FN_PATCH_FOOTER = 0x79;

function fractalChecksum(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

function buildPatchDumpRequest(wirePreset: number): number[] {
  // MSB-first per fractal-midi/buildSwitchPreset convention. LSB-first
  // silently fails for any preset ≥ 128, confirmed Session 115.
  const hi = (wirePreset >> 7) & 0x7f;
  const lo = wirePreset & 0x7f;
  const head = [SYSEX_START, ...FRACTAL_MFR, AXEFX2_MODEL, FN_PATCH_DUMP, hi, lo];
  return [...head, fractalChecksum(head), SYSEX_END];
}

// ── native ushort decode (per descriptor table 0xe04440) ─────────────

function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    const v =
      ((payload[off] & 0x7f) |
        ((payload[off + 1] & 0x7f) << 7) |
        ((payload[off + 2] & 0x7f) << 14)) &
      0xffff;
    out[i] = v;
  }
  return out;
}

/** Compute the footer hash for a parsed preset dump.
 * Per FUN_00544cc0: 16-bit XOR-fold over all native ushorts across all
 * chunks. Verified 390/390 presets. */
function computeFooterHash(chunks: readonly Uint8Array[]): number {
  let xor = 0;
  for (const c of chunks) {
    const ushorts = decodeChunkNative(c);
    for (const v of ushorts) xor ^= v;
  }
  return xor & 0xffff;
}

function parseFooterValue(footer: Uint8Array): number {
  return (
    (footer[0] & 0x7f) |
    ((footer[1] & 0x7f) << 7) |
    ((footer[2] & 0x7f) << 14)
  );
}

// ── block-record list parse (chunks 0+1, 12 records × 8 ushorts) ────

const BLOCK_ID_TO_BLOCK = new Map(AXE_FX_II_BLOCKS.map((b) => [b.id, b]));

interface BlockRecordSummary {
  recordIndex: number;
  blockId: number;
  blockName: string;
  groupCode: string;
  flag: number;
}

function parseBlockRecords(parsed: ParsedPresetDump): BlockRecordSummary[] {
  const chunk0 = decodeChunkNative(parsed.chunkPayloads[0]);
  const chunk1 = decodeChunkNative(parsed.chunkPayloads[1]);
  const stream = [...Array.from(chunk0), ...Array.from(chunk1)];
  const out: BlockRecordSummary[] = [];
  for (let i = 0; i < 12; i++) {
    const idx = 36 + i * 8;
    if (idx + 2 > stream.length) break;
    const blockId = stream[idx];
    if (blockId === 0) continue; // empty slot
    const block = BLOCK_ID_TO_BLOCK.get(blockId);
    out.push({
      recordIndex: i + 1,
      blockId,
      blockName: block?.name ?? `<unknown id ${blockId}>`,
      groupCode: block?.groupCode ?? '???',
      flag: stream[idx + 1],
    });
  }
  return out;
}

// ── dump implementation ──────────────────────────────────────────────

async function dumpStoredPreset(wirePreset: number): Promise<Uint8Array> {
  const conn = ensureConn();
  // Collect frames until we see the footer (fn 0x79).
  const collected: number[][] = [];
  const isPatchFrame = (b: number[]): boolean =>
    b[0] === SYSEX_START &&
    b[1] === 0x00 &&
    b[2] === 0x01 &&
    b[3] === 0x74 &&
    b[4] === AXEFX2_MODEL &&
    (b[5] === FN_PATCH_HEADER || b[5] === FN_PATCH_CHUNK || b[5] === FN_PATCH_FOOTER);

  const allFramesPromise = new Promise<number[][]>((resolve, reject) => {
    const unsub = conn.onMessage((bytes) => {
      if (!isPatchFrame(bytes)) return;
      collected.push([...bytes]);
      if (bytes[5] === FN_PATCH_FOOTER) {
        unsub();
        resolve(collected);
      }
    });
    setTimeout(() => {
      unsub();
      reject(
        new Error(
          `Timed out waiting for PATCH_DUMP response after ${collected.length} frames ` +
            `(expected 66).`,
        ),
      );
    }, 5000);
  });

  conn.send(buildPatchDumpRequest(wirePreset));
  const frames = await allFramesPromise;
  if (frames.length !== 66) {
    throw new Error(`PATCH_DUMP returned ${frames.length} frames; expected 66`);
  }
  // Flatten to 12,951 bytes.
  const total = HEADER_LEN + CHUNK_LEN * CHUNKS_PER_PRESET + FOOTER_LEN;
  const out = new Uint8Array(total);
  let cur = 0;
  for (const m of frames) {
    out.set(m, cur);
    cur += m.length;
  }
  if (cur !== PRESET_DUMP_LEN) {
    throw new Error(`PATCH_DUMP flat byte total ${cur} ≠ expected ${PRESET_DUMP_LEN}`);
  }
  return out;
}

async function getActivePresetNumber(): Promise<number> {
  const conn = ensureConn();
  const respP = conn.receiveSysExMatching(isGetPresetNumberResponse, GET_RESPONSE_TIMEOUT_MS);
  conn.send(buildGetPresetNumber());
  const bytes = await respP;
  return parseGetPresetNumberResponse(bytes).presetNumber;
}

// ── restore implementation ───────────────────────────────────────────

async function pushPresetBinary(bytes: Uint8Array): Promise<{
  framesSent: number;
  acksReceived: number;
  nacks: Array<{ frame: number; bytes: number[] }>;
}> {
  if (bytes.length !== PRESET_DUMP_LEN) {
    throw new Error(`Preset binary must be ${PRESET_DUMP_LEN} bytes; got ${bytes.length}`);
  }
  // Split into 66 messages along F0/F7 boundaries.
  const messages: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== SYSEX_START) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== SYSEX_END) j++;
    if (j >= bytes.length) break;
    messages.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  if (messages.length !== 66) {
    throw new Error(`Preset binary parses to ${messages.length} SysEx messages; expected 66`);
  }

  const conn = ensureConn();
  const responses: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });
  for (const m of messages) {
    conn.send(m);
    await new Promise((r) => setTimeout(r, 8));
  }
  await new Promise((r) => setTimeout(r, 600));
  unsub();

  const nacks: Array<{ frame: number; bytes: number[] }> = [];
  // ACK frames are short, we look at any incoming with a non-zero result
  // byte after the function byte. Result is at offset 7..8 for the
  // ack/nack frame shape.
  for (let k = 0; k < responses.length; k++) {
    const r = responses[k];
    // Length > 7 and the byte at offset 7 (just after fn byte) is non-zero
    // = candidate NACK. Conservative heuristic, better than misclassifying.
    if (r.length > 7 && r[7] !== 0x00 && r[5] === 0x64) {
      nacks.push({ frame: k, bytes: [...r] });
    }
  }
  return { framesSent: messages.length, acksReceived: responses.length, nacks };
}

async function commitToLocation(wirePreset: number): Promise<{ ok: boolean; resultCode: number }> {
  const conn = ensureConn();
  const respP = conn.receiveSysExMatching(isStorePresetResponse, GET_RESPONSE_TIMEOUT_MS);
  conn.send(buildStorePreset(wirePreset));
  const ack = await respP;
  return parseStorePresetResponse(ack);
}

// ── tool registration ────────────────────────────────────────────────

export function registerAxeFxIIPresetBinaryTools(server: McpServer): void {
  server.registerTool('axefx2_dump_preset', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Byte-exact dump of an Axe-Fx II preset (12,951 wire bytes), plus a parsed metadata snapshot.',
      'Pass `location` as a display preset number 1..768. Pass `"active"` to dump the currently loaded working buffer.',
      'The raw bytes (base64) can be archived as a `.syx` file for backup or shared between users. `axefx2_restore_preset` accepts those exact bytes back.',
      'Returns: `{ bytes_base64, byte_length, location_display, location_wire, name, blocks[], footer_hash, footer_bytes }`.',
      'Performance: ~1.5-2 s (66-message round-trip).',
      'Non-destructive, does not change the active preset, does not write to flash.',
    ].join(' '),
    inputSchema: {
      location: z.union([z.number().int().min(1).max(768), z.literal('active')]).describe(
        'Preset to dump. Display number 1..768 reads from flash; "active" reads the live working buffer.',
      ),
    },
  }, async (input) => {
    try {
      let wirePreset: number;
      if (input.location === 'active') {
        wirePreset = await getActivePresetNumber();
      } else {
        wirePreset = input.location - 1;
      }
      const bytes = await dumpStoredPreset(wirePreset);
      const parsed = parsePresetDump(bytes);
      const name = extractPresetName(parsed);
      const blocks = parseBlockRecords(parsed);
      const computedHash = computeFooterHash(parsed.chunkPayloads);
      const parsedFooterValue = parseFooterValue(parsed.footerPayload);
      const footerHashFromFooter = parsedFooterValue & 0xffff;
      const hashIntegrity = computedHash === footerHashFromFooter ? 'verified' : 'mismatch';

      const result = {
        bytes_base64: Buffer.from(bytes).toString('base64'),
        byte_length: bytes.length,
        location_display: input.location === 'active' ? `active (wire ${wirePreset}, display ${wirePreset + 1})` : input.location,
        location_wire: wirePreset,
        name,
        blocks,
        footer_hash: '0x' + computedHash.toString(16).padStart(4, '0'),
        footer_bytes: Array.from(parsed.footerPayload).map((b: number) => '0x' + b.toString(16).padStart(2, '0')),
        hash_integrity: hashIntegrity,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...result, bytes_base64: result.bytes_base64.slice(0, 60) + '... [truncated for log]' }, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('axefx2_restore_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Push a 12,951-byte preset binary back to the Axe-Fx II. With `save_authorized: true`, commits to the target `location` via STORE_PRESET. Without it, pushes to the working buffer only (reverts on next preset switch).',
      'Validates the footer hash against the XOR-fold of decoded native ushorts BEFORE pushing, corrupted bytes are rejected client-side.',
      'WARNING: writing to a non-empty location overwrites it. Read the target via axefx2_dump_preset first if you need to confirm what is there.',
      'Returns: `{ ok, frames_sent, acks_received, nacks[], saved_to_location?, name }`.',
      'Performance: ~600 ms for push + ~250 ms for save when save_authorized=true.',
    ].join(' '),
    inputSchema: {
      bytes_base64: z.string().describe(
        '12,951-byte preset binary, base64-encoded. Get this from axefx2_dump_preset.',
      ),
      location: z.number().int().min(1).max(768).optional().describe(
        'Target preset slot 1..768. Required when save_authorized=true. Omit for working-buffer-only push.',
      ),
      save_authorized: z.boolean().default(false).describe(
        'When true, commits to `location` via STORE_PRESET. When false, pushes to the working buffer only (no flash write). The user must say "save" / "store" / "put it on N" for this to be true.',
      ),
    },
  }, async (input) => {
    try {
      const bytes = new Uint8Array(Buffer.from(input.bytes_base64, 'base64'));
      if (bytes.length !== PRESET_DUMP_LEN) {
        return asError(new Error(`bytes_base64 decodes to ${bytes.length} bytes; expected ${PRESET_DUMP_LEN}`));
      }
      // Pre-flight: hash validation.
      const parsed = parsePresetDump(bytes);
      const computedHash = computeFooterHash(parsed.chunkPayloads);
      const footerHash = parseFooterValue(parsed.footerPayload) & 0xffff;
      if (computedHash !== footerHash) {
        return asError(new Error(
          `Footer hash mismatch, computed XOR-fold=0x${computedHash.toString(16).padStart(4, '0')} ` +
            `vs footer-encoded=0x${footerHash.toString(16).padStart(4, '0')}. ` +
            `Bytes are corrupted or the hash was not recomputed after editing.`,
        ));
      }
      if (input.save_authorized && input.location === undefined) {
        return asError(new Error('save_authorized=true requires a `location` (1..768)'));
      }

      const pushResult = await pushPresetBinary(bytes);
      const name = extractPresetName(parsed);
      let savedToLocation: number | undefined;
      let storeOk = true;
      let storeResultCode: number | undefined;
      if (input.save_authorized && input.location !== undefined) {
        const wirePreset = input.location - 1;
        const r = await commitToLocation(wirePreset);
        storeOk = r.ok;
        storeResultCode = r.resultCode;
        if (r.ok) savedToLocation = input.location;
      }

      const ok = pushResult.nacks.length === 0 && storeOk;
      const result = {
        ok,
        frames_sent: pushResult.framesSent,
        acks_received: pushResult.acksReceived,
        nacks: pushResult.nacks.map((n) => ({
          frame_index: n.frame,
          fn_byte: n.bytes[5] !== undefined ? '0x' + n.bytes[5].toString(16) : '??',
          result_code: n.bytes[7] !== undefined ? '0x' + n.bytes[7].toString(16) : '??',
        })),
        saved_to_location: savedToLocation,
        store_result_code: storeResultCode !== undefined ? '0x' + storeResultCode.toString(16) : undefined,
        name,
        footer_hash: '0x' + computedHash.toString(16).padStart(4, '0'),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      return asError(err);
    }
  });
}
