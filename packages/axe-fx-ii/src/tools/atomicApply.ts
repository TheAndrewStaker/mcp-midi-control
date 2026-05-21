/**
 * Axe-Fx II atomic apply — BK-070 ship vehicle.
 *
 * `axefx2_atomic_apply` writes a multi-block, multi-scene, multi-param
 * preset modification in ONE round-trip via dump → patch → push → save.
 *
 * Why this exists: the existing per-frame apply_preset path uses
 * SET_BLOCK_CHANNEL (fn 0x11) for per-scene channel state. That op has
 * the BK-058 race condition that drops channel-Y writes on scenes that
 * aren't currently active. This tool ZERO uses that op — it patches the
 * preset binary directly and pushes it back atomically. The device
 * never sees a partial state, so the race is impossible.
 *
 * Scope: only blocks present in BLOCK_LAYOUT_MAP can have per-scene
 * state or params modified through this tool. Currently Amp 1, Drive 1,
 * Cab 1, Reverb 1, Delay 1, Compressor 1 have per-scene state; Amp 1
 * and Drive 1 additionally have params mappable. Other blocks need
 * their (chunk, ushort) discovered via the bk070-* research scripts.
 *
 * For unmapped blocks, fall back to the existing per-frame apply_preset.
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
import { resolveBlock, KNOWN_PARAMS, findParamFuzzy } from 'fractal-midi/axe-fx-ii';

import { ensureConn, GET_RESPONSE_TIMEOUT_MS } from './shared.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';
import {
  BLOCK_LAYOUT_MAP,
  buildSceneStateUshort,
  paramLocation,
  paramLocationForChannel,
  sceneChannelYBit,
  sceneBypassBit,
} from '../sceneChannelMap.js';

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

function writeUshortAt(payload: Uint8Array, ushortIdx: number, value: number): void {
  const off = 2 + ushortIdx * 3;
  payload[off] = value & 0x7f;
  payload[off + 1] = (value >> 7) & 0x7f;
  // Preserve byte-2 high 5 bits (= bits 16-20 of the 21-bit septet wire
  // value); they carry device-private state that the decoder doesn't
  // surface. Overwriting them triggers fn 0x79 NACK 0x13.
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

async function pushPresetBinary(bytes: Uint8Array): Promise<{
  ok: boolean;
  framesSent: number;
  acks: number;
  nacks: Array<{ ackedFn: number; resultCode: number; frameIndex: number }>;
}> {
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
    // 12ms inter-frame gap (Session 115: 8ms caused intermittent NACKs).
    await new Promise((r) => setTimeout(r, 12));
  }
  await new Promise((r) => setTimeout(r, 800));
  unsub();
  const acks = responses.filter((r) => r.length > 7 && r[5] === 0x64).length;
  const nacks: Array<{ ackedFn: number; resultCode: number; frameIndex: number }> = [];
  let frameIdx = 0;
  for (const r of responses) {
    if (r.length > 7 && r[5] === 0x64) {
      if (r[7] !== 0x00) {
        nacks.push({ ackedFn: r[6], resultCode: r[7], frameIndex: frameIdx });
      }
      frameIdx++;
    }
  }
  return { ok: nacks.length === 0, framesSent: messages.length, acks, nacks };
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

// ── tool registration ────────────────────────────────────────────────

export function registerAxeFxIIAtomicApplyTool(server: McpServer): void {
  server.registerTool('axefx2_atomic_apply', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Atomic preset modification via dump, patch, push, save. ZERO use of per-frame channel/param frames; the device sees one coherent preset binary instead of 50+ race-prone wire frames.',
      'Each blocks[] entry names a block (display name or effectId) and may carry: `params` (param-name to display-or-wire value), `scenes_bypassed` (1-indexed scene numbers to bypass), `scenes_on_y` (1-indexed scene numbers to route to channel Y; remaining scenes go to channel X).',
      'When `save_authorized: true`, STORE_PRESET commits to `location` after pushing. When false, push goes to working buffer only.',
      'LAYOUT LIMIT: paramBase entries are calibrated for the Test Crunch 6-block composition (compressor / drive / amp / cab / delay / reverb at row 2, nothing else placed). Apply against a preset with a different block composition writes to the WRONG ushorts. Verify the target preset matches this composition before relying on param writes. sceneState entries may also be layout-dependent; not yet verified.',
      'COVERAGE LIMITS: per-scene state mapped for Amp 1, Drive 1, Cab 1, Reverb 1, Delay 1, Compressor 1. Params atomic-writable for the same six blocks (X + Y). Other blocks: fall back to apply_preset.',
      'Returns: `{ ok, applied[], block_layout_lookups[], frames_sent, nacks, name, saved_to_location? }`.',
      'Performance: ~1.5 s dump + ~800 ms push + ~250 ms save when save_authorized=true.',
    ].join(' '),
    inputSchema: {
      location: z.union([z.number().int().min(1).max(768), z.literal('active')]).default('active').describe(
        'Preset to modify. "active" reads/writes the working buffer; a number reads from flash and (optionally) saves back.',
      ),
      blocks: z.array(z.object({
        block: z.union([z.string(), z.number()]).describe('Block name like "Amp 1" or effectId 106'),
        params: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(
          'param-name → wire-value (0..65534) mapping for the CURRENT channel (whichever the block was last set to). Use params_x / params_y for explicit channel targeting.',
        ),
        params_x: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(
          'param-name → wire-value mapping for channel X. Writes directly to X storage in the binary, regardless of which scene is active. Requires the block to be in Tier 1a (X/Y paramBase both mapped).',
        ),
        params_y: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe(
          'param-name → wire-value mapping for channel Y. Writes directly to Y storage in the binary. Requires the block to be in Tier 1a.',
        ),
        scenes_bypassed: z.array(z.number().int().min(1).max(8)).optional(),
        scenes_on_y: z.array(z.number().int().min(1).max(8)).optional(),
      })).min(1).describe('Per-block modifications.'),
      save_authorized: z.boolean().default(false),
    },
  }, async (input) => {
    try {
      // Resolve each block + look up its layout.
      const resolutions = input.blocks.map((b, idx) => {
        const block = resolveBlock(b.block);
        if (!block) {
          throw new Error(`blocks[${idx}].block: unknown block "${b.block}". Pass a display name like "Amp 1" or an effectId.`);
        }
        const layout = BLOCK_LAYOUT_MAP.get(block.id);
        if (!layout) {
          throw new Error(
            `blocks[${idx}].block: "${block.name}" (id ${block.id}) is not in BLOCK_LAYOUT_MAP yet. ` +
            `Mapped: ${[...BLOCK_LAYOUT_MAP.values()].map((v) => v.blockName).join(', ')}. ` +
            `For unmapped blocks use apply_preset (non-atomic).`,
          );
        }
        return { block, layout, input: b };
      });

      // For each block that has params requested, check that paramBase is known.
      for (const r of resolutions) {
        if (r.input.params && Object.keys(r.input.params).length > 0) {
          if (r.layout.paramBaseChunk === undefined) {
            throw new Error(
              `Block "${r.layout.blockName}" has no paramBase in BLOCK_LAYOUT_MAP — params can't be atomic-written for this block yet. ` +
              `Run scripts/_research/bk070-amp-param-mapper.ts with EFFECT_ID=${r.block.id} to discover its paramBase, then add to sceneChannelMap.ts.`,
            );
          }
        }
        if (r.input.params_x && Object.keys(r.input.params_x).length > 0) {
          if (r.layout.paramBaseChunkX === undefined) {
            throw new Error(
              `Block "${r.layout.blockName}" has no channel-X paramBase mapped — params_x not writable. ` +
              `Currently Tier 1a (X+Y mapped): Amp 1, Cab 1, Reverb 1, Drive 1. Run scripts/_research/bk070-map-xy-parambase.ts to extend.`,
            );
          }
        }
        if (r.input.params_y && Object.keys(r.input.params_y).length > 0) {
          if (r.layout.paramBaseChunkY === undefined) {
            throw new Error(
              `Block "${r.layout.blockName}" has no channel-Y paramBase mapped — params_y not writable. ` +
              `Currently Tier 1a (X+Y mapped): Amp 1, Cab 1, Reverb 1, Drive 1.`,
            );
          }
        }
      }

      // Resolve location.
      let wirePreset: number;
      if (input.location === 'active') {
        wirePreset = await getActivePresetNumber();
      } else {
        wirePreset = input.location - 1;
      }

      // Dump baseline.
      const baselineBytes = await dumpStoredPreset(wirePreset);
      if (baselineBytes.length !== PRESET_DUMP_LEN) {
        throw new Error(`Dumped ${baselineBytes.length} bytes; expected ${PRESET_DUMP_LEN}`);
      }
      const parsed = parsePresetDump(baselineBytes);
      const name = extractPresetName(parsed);

      // Track patches applied so we can report back.
      const applied: Array<{
        block: string;
        operation: string;
        chunk: number;
        ushort: number;
        before: string;
        after: string;
      }> = [];
      const newChunks: Uint8Array[] = parsed.chunkPayloads.map((c) => new Uint8Array(c));

      // Apply scene state changes.
      for (const r of resolutions) {
        if (r.input.scenes_bypassed !== undefined || r.input.scenes_on_y !== undefined) {
          const chunk = newChunks[r.layout.sceneStateChunk];
          const before = readUshortAt(chunk, r.layout.sceneStateUshort);
          // Build new value. For unspecified halves, preserve original.
          let bypassMap = before & 0x00ff;
          let yMap = before & 0xff00;
          if (r.input.scenes_bypassed !== undefined) {
            bypassMap = 0;
            for (const scene of r.input.scenes_bypassed) bypassMap |= 1 << sceneBypassBit(scene);
            bypassMap &= 0x00ff;
          }
          if (r.input.scenes_on_y !== undefined) {
            yMap = 0;
            for (const scene of r.input.scenes_on_y) yMap |= 1 << sceneChannelYBit(scene);
            yMap &= 0xff00;
          }
          const after = bypassMap | yMap;
          writeUshortAt(chunk, r.layout.sceneStateUshort, after);
          applied.push({
            block: r.layout.blockName,
            operation: 'scene_state',
            chunk: r.layout.sceneStateChunk,
            ushort: r.layout.sceneStateUshort,
            before: '0x' + before.toString(16).padStart(4, '0'),
            after: '0x' + after.toString(16).padStart(4, '0'),
          });
        }
      }

      // Apply param changes. Helper that resolves and writes one param.
      const applyParamWrite = (
        r: typeof resolutions[number],
        paramName: string,
        paramValue: number | string,
        channelTag: 'current' | 'X' | 'Y',
      ): void => {
        const paramDef = findParamFuzzy(r.block, paramName);
        if (!paramDef) {
          throw new Error(
            `Block "${r.layout.blockName}" has no param matching "${paramName}". ` +
            `Look up valid names via list_params({port:"axe-fx-ii", block:"${r.layout.blockName}"}).`,
          );
        }
        const loc =
          channelTag === 'current'
            ? paramLocation(r.block.id, paramDef.paramId)
            : paramLocationForChannel(r.block.id, paramDef.paramId, channelTag);
        if (!loc) {
          throw new Error(
            `Location lookup failed for ${r.layout.blockName} paramId ${paramDef.paramId} channel=${channelTag}.`,
          );
        }
        let wireValue: number;
        if (typeof paramValue === 'number') {
          wireValue = paramValue & 0xffff;
        } else {
          throw new Error(
            `Param "${paramName}" got a string value "${paramValue}"; atomic_apply v0.1 needs wire numbers (0..65534). ` +
            `Resolve via set_param's display→wire mapping then pass the wire value here.`,
          );
        }
        const chunkPayload = newChunks[loc.chunk];
        const before = readUshortAt(chunkPayload, loc.ushort);
        writeUshortAt(chunkPayload, loc.ushort, wireValue);
        applied.push({
          block: r.layout.blockName,
          operation: `param ${paramName} (paramId ${paramDef.paramId}, channel ${channelTag})`,
          chunk: loc.chunk,
          ushort: loc.ushort,
          before: '0x' + before.toString(16).padStart(4, '0'),
          after: '0x' + wireValue.toString(16).padStart(4, '0'),
        });
      };

      for (const r of resolutions) {
        if (r.input.params) {
          for (const [paramName, paramValue] of Object.entries(r.input.params)) {
            applyParamWrite(r, paramName, paramValue, 'current');
          }
        }
        if (r.input.params_x) {
          for (const [paramName, paramValue] of Object.entries(r.input.params_x)) {
            applyParamWrite(r, paramName, paramValue, 'X');
          }
        }
        if (r.input.params_y) {
          for (const [paramName, paramValue] of Object.entries(r.input.params_y)) {
            applyParamWrite(r, paramName, paramValue, 'Y');
          }
        }
      }

      if (applied.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, applied: [], message: 'No modifications specified' }, null, 2) }],
          structuredContent: { ok: true, applied: [], message: 'No modifications specified' },
        };
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
      if (input.save_authorized && pushResult.ok) {
        const r = await commitToLocation(wirePreset);
        if (r.ok) savedToLocation = wirePreset + 1;
      }

      const result = {
        ok: pushResult.ok,
        applied,
        name,
        new_footer_hash: '0x' + newHash.toString(16).padStart(4, '0'),
        frames_sent: pushResult.framesSent,
        acks_received: pushResult.acks,
        nacks: pushResult.nacks.map((n) => ({
          frame_index: n.frameIndex,
          acked_fn: '0x' + n.ackedFn.toString(16),
          result_code: '0x' + n.resultCode.toString(16),
        })),
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
