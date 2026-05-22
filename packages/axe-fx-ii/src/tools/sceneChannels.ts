/**
 * axefx2_set_scene_channels, atomic per-scene channel setter.
 *
 * Kills BK-058 (channel-Y write loss) at the protocol level. Instead of
 * sending individual SET_BLOCK_CHANNEL (fn 0x11) frames per scene (the
 * race-prone path), this tool dumps the preset binary, modifies the
 * per-scene channel-Y bitmap for each requested block, recomputes the
 * footer hash, and pushes the entire preset back atomically.
 *
 * Verified Session 115: no NACKs on push, byte-exact round-trip.
 *
 * Limits: only blocks present in SCENE_CHANNEL_MAP are mappable. Adding
 * a new block requires running `bk070-channel-experiment-v2.ts` to
 * discover the (chunk, ushort) location.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  parsePresetDump,
  serializePresetDump,
  PRESET_DUMP_LEN,
  extractPresetName,
} from '../presetDump.js';
import {
  buildGetPresetNumber,
  isGetPresetNumberResponse,
  parseGetPresetNumberResponse,
  buildStorePreset,
  isStorePresetResponse,
  parseStorePresetResponse,
} from 'fractal-midi/axe-fx-ii';
import { resolveBlock } from 'fractal-midi/axe-fx-ii';

import { ensureConn, GET_RESPONSE_TIMEOUT_MS } from './shared.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';
import {
  SCENE_CHANNEL_MAP,
  buildSceneChannelUshort,
} from '../sceneChannelMap.js';

// ── shared wire helpers ──────────────────────────────────────────────

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
  const hi = (wirePreset >> 7) & 0x7f;
  const lo = wirePreset & 0x7f;
  const head = [SYSEX_START, ...FRACTAL_MFR, AXEFX2_MODEL, FN_PATCH_DUMP, hi, lo];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function decodeChunkNative(payload: Uint8Array): Uint16Array {
  const count = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    out[i] = ((payload[off] & 0x7f) |
      ((payload[off + 1] & 0x7f) << 7) |
      ((payload[off + 2] & 0x7f) << 14)) & 0xffff;
  }
  return out;
}

function computeFooterHash(chunks: readonly Uint8Array[]): number {
  let xor = 0;
  for (const c of chunks) {
    for (const v of decodeChunkNative(c)) xor ^= v;
  }
  return xor & 0xffff;
}

function readUshortAt(payload: Uint8Array, ushortIdx: number): number {
  const off = 2 + ushortIdx * 3;
  return ((payload[off] & 0x7f) |
    ((payload[off + 1] & 0x7f) << 7) |
    ((payload[off + 2] & 0x7f) << 14)) & 0xffff;
}

/**
 * Write a 16-bit value at the ushort slot, PRESERVING bits 16-20 in the
 * high septet of wire byte 2. Each chunk-stream ushort wire-encodes as
 * a 21-bit septet value but the decoder takes only the low 16 bits.
 * The high 5 bits (= bits 16-20) sometimes encode device-private state
 * (similar to the footer's byte-2 high bits). Overwriting them with
 * zeros caused fn 0x79 NACK 0x13 in multi-chunk modifications during
 * Session 115 testing, we now preserve them.
 */
function writeUshortAt(payload: Uint8Array, ushortIdx: number, value: number): void {
  const off = 2 + ushortIdx * 3;
  payload[off] = value & 0x7f;
  payload[off + 1] = (value >> 7) & 0x7f;
  // Preserve high 5 bits of byte 2; only update low 2 bits (= ushort bits 14-15).
  payload[off + 2] = (payload[off + 2] & 0x7c) | ((value >> 14) & 0x03);
}

async function dumpStoredPreset(wirePreset: number): Promise<Uint8Array> {
  const conn = ensureConn();
  const collected: number[][] = [];
  const HEADER_LEN = 12, CHUNK_LEN = 202, FOOTER_LEN = 11;
  const isPatchFrame = (b: number[]): boolean =>
    b[0] === SYSEX_START && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x74 &&
    b[4] === AXEFX2_MODEL &&
    (b[5] === FN_PATCH_HEADER || b[5] === FN_PATCH_CHUNK || b[5] === FN_PATCH_FOOTER);
  const promise = new Promise<number[][]>((resolve, reject) => {
    const unsub = conn.onMessage((bytes) => {
      if (!isPatchFrame(bytes)) return;
      collected.push([...bytes]);
      if (bytes[5] === FN_PATCH_FOOTER) { unsub(); resolve(collected); }
    });
    setTimeout(() => { unsub(); reject(new Error(`PATCH_DUMP timeout after ${collected.length} frames`)); }, 5000);
  });
  conn.send(buildPatchDumpRequest(wirePreset));
  const frames = await promise;
  if (frames.length !== 66) throw new Error(`PATCH_DUMP got ${frames.length} frames, expected 66`);
  const out = new Uint8Array(HEADER_LEN + CHUNK_LEN * 64 + FOOTER_LEN);
  let cur = 0;
  for (const m of frames) { out.set(m, cur); cur += m.length; }
  return out;
}

async function pushPresetBinary(bytes: Uint8Array): Promise<{ ok: boolean; nacks: Array<{ ackedFn: number; resultCode: number }> }> {
  const messages: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== SYSEX_START) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== SYSEX_END) j++;
    messages.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  const conn = ensureConn();
  const responses: number[][] = [];
  const unsub = conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });
  for (const m of messages) {
    conn.send(m);
    // 12 ms inter-message gap: tighter timings (8 ms) caused intermittent
    // NACKs in multi-modification tests; 12 ms keeps the device's frame
    // buffer happy even with 66 back-to-back messages.
    await new Promise((r) => setTimeout(r, 12));
  }
  await new Promise((r) => setTimeout(r, 800));
  unsub();
  const nacks: Array<{ ackedFn: number; resultCode: number }> = [];
  for (const r of responses) {
    if (r.length > 7 && r[5] === 0x64 && r[7] !== 0x00) {
      nacks.push({ ackedFn: r[6], resultCode: r[7] });
    }
  }
  return { ok: nacks.length === 0, nacks };
}

async function commitToLocation(wirePreset: number): Promise<{ ok: boolean; resultCode: number }> {
  const conn = ensureConn();
  const respP = conn.receiveSysExMatching(isStorePresetResponse, GET_RESPONSE_TIMEOUT_MS);
  conn.send(buildStorePreset(wirePreset));
  const ack = await respP;
  return parseStorePresetResponse(ack);
}

async function getActivePresetNumber(): Promise<number> {
  const conn = ensureConn();
  const respP = conn.receiveSysExMatching(isGetPresetNumberResponse, GET_RESPONSE_TIMEOUT_MS);
  conn.send(buildGetPresetNumber());
  const bytes = await respP;
  return parseGetPresetNumberResponse(bytes).presetNumber;
}

// ── tool ────────────────────────────────────────────────────────────

export function registerAxeFxIISceneChannelsTool(server: McpServer): void {
  server.registerTool('axefx2_set_scene_channels', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Set per-scene channel routing (X or Y) for one or more blocks ATOMICALLY by patching the preset binary directly instead of sending individual per-scene channel frames.',
      'Each `assignments[]` entry names a block (display name or effectId) and lists which scenes should be on channel Y. Scenes not listed stay on X.',
      'When `save_authorized: true`, commits to `location` via STORE_PRESET. When false, push to working buffer only (reverts on next preset switch).',
      'Pre-flight refuses if any named block is not in the per-scene channel map (currently: Amp 1, Drive 1, Reverb 1, Delay 1, Cab 1, Compressor 1). For other blocks, fall back to set_block_channel.',
      'Performance: ~1.5 s dump + ~600 ms push + ~250 ms save (when save_authorized=true).',
      'Returns: `{ ok, applied[], frames_sent, nacks, name, saved_to_location? }`.',
    ].join(' '),
    inputSchema: {
      location: z.union([z.number().int().min(1).max(768), z.literal('active')]).default('active').describe(
        'Preset to modify. "active" reads/writes the working buffer; a number reads from flash and (optionally) saves back.',
      ),
      assignments: z.array(z.object({
        block: z.union([z.string(), z.number()]).describe('Block name like "Amp 1" or effectId 106'),
        scenes_on_y: z.array(z.number().int().min(1).max(8)).describe(
          'List of scene numbers (1..8) that should be on channel Y after the update. Scenes not listed go to channel X.',
        ),
      })).min(1).describe('One entry per block whose scene routing should change.'),
      save_authorized: z.boolean().default(false).describe(
        'When true, STORE_PRESET commits the patched preset to `location` after pushing. The user must explicitly say "save"/"keep"/"store" for this to be true.',
      ),
    },
  }, async (input) => {
    try {
      // Resolve each block + look up its scene-channel location.
      const resolutions = input.assignments.map((a, idx) => {
        const block = resolveBlock(a.block);
        if (!block) {
          throw new Error(`assignments[${idx}].block: unknown block "${a.block}". Pass a display name like "Amp 1" or an effectId.`);
        }
        const loc = SCENE_CHANNEL_MAP.get(block.id);
        if (!loc) {
          throw new Error(
            `assignments[${idx}].block: "${block.name}" (id ${block.id}) is not in the per-scene channel map yet. ` +
            `Mapped blocks: ${[...SCENE_CHANNEL_MAP.values()].map((v) => v.blockName).join(', ')}. ` +
            `Use set_block_channel for unmapped blocks.`,
          );
        }
        return { block, loc, scenesOnY: a.scenes_on_y };
      });

      // Resolve location.
      let wirePreset: number;
      if (input.location === 'active') {
        wirePreset = await getActivePresetNumber();
      } else {
        wirePreset = input.location - 1;
      }
      if (input.save_authorized && input.location === 'active') {
        // Use the current location for the save target.
      }

      // Dump baseline.
      const baselineBytes = await dumpStoredPreset(wirePreset);
      if (baselineBytes.length !== PRESET_DUMP_LEN) {
        throw new Error(`Dumped ${baselineBytes.length} bytes; expected ${PRESET_DUMP_LEN}`);
      }
      const parsed = parsePresetDump(baselineBytes);
      const name = extractPresetName(parsed);

      // Apply each assignment: read the target ushort, build new value, write back.
      const applied: Array<{ block: string; chunk: number; ushort: number; before: string; after: string }> = [];
      const newChunks: Uint8Array[] = parsed.chunkPayloads.map((c) => new Uint8Array(c));
      for (const { block, loc, scenesOnY } of resolutions) {
        const chunk = newChunks[loc.chunk];
        const before = readUshortAt(chunk, loc.ushort);
        const after = buildSceneChannelUshort(before, scenesOnY);
        writeUshortAt(chunk, loc.ushort, after);
        applied.push({
          block: block.name,
          chunk: loc.chunk,
          ushort: loc.ushort,
          before: '0x' + before.toString(16).padStart(4, '0'),
          after: '0x' + after.toString(16).padStart(4, '0'),
        });
      }

      // Recompute hash + footer.
      const newHash = computeFooterHash(newChunks);
      const newFooter = new Uint8Array([
        newHash & 0x7f,
        (newHash >> 7) & 0x7f,
        (parsed.footerPayload[2] & 0x7c) | ((newHash >> 14) & 0x03),
      ]);
      const modified = serializePresetDump({
        raw: parsed.raw,
        headerPayload: parsed.headerPayload,
        chunkPayloads: newChunks,
        footerPayload: newFooter,
      });

      // Push.
      const pushResult = await pushPresetBinary(modified);
      let savedToLocation: number | undefined;
      if (input.save_authorized) {
        const r = await commitToLocation(wirePreset);
        if (r.ok) savedToLocation = wirePreset + 1;
      }

      const result = {
        ok: pushResult.ok,
        applied,
        name,
        new_footer_hash: '0x' + newHash.toString(16).padStart(4, '0'),
        nacks: pushResult.nacks.map((n) => ({
          acked_fn: '0x' + n.ackedFn.toString(16),
          result_code: '0x' + n.resultCode.toString(16),
        })),
        nack_count: pushResult.nacks.length,
        saved_to_location: savedToLocation,
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
