/**
 * AM4 working-buffer STATE reads shared by the reader and the writer's
 * receipts: the per-scene channel + bypass table (from one working-buffer
 * dump) and a single block's bypass flag.
 *
 * The working-buffer dump (fn 0x03, bank 0x7F) answers the same 6-frame
 * container as a stored dump and reflects UNSAVED edits: on hardware
 * (2026-11-12) a set_bypass moved the scene record's bypass word, a channel
 * switch moved its channel word, and a switch_scene moved the active-scene
 * word, each in the very next dump. One round-trip, about 80 ms.
 */

import {
  BLOCK_TYPE_VALUES,
  buildReadParam,
  buildRequestActiveBufferDump,
  decodeAm4PresetBody,
  decodeAm4RawPatch,
  isReadResponseLong,
  parseLongReadBypassFlag,
  READ_TYPE_LONG,
  type Am4PresetBody,
  type BlockTypeName,
} from 'fractal-midi/am4';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import { receivePresetDumpStream } from '../presetDump.js';
import { READ_RESPONSE_TIMEOUT_MS } from './readOps.js';

const BYPASS_STATE_PID_HIGH = 0x0003;

/** Wait for the working-buffer dump no longer than this; the frames arrive within ~100 ms. */
const BUFFER_DUMP_TIMEOUT_MS = 800;

/**
 * Dump + decode the working buffer's body. Best-effort: returns `undefined`
 * when the dump does not arrive, fails its CRC, or does not walk as the known
 * block-record chain. Never throws.
 */
/**
 * Dump + decode the working buffer once, returning its body and the preset
 * name the buffer itself carries (raw_patch offset 0x08). The name is the
 * working buffer's, so it reflects an unsaved build or rename, unlike the
 * READ_PRESET_NAME of the loaded location. `body` is `undefined` when the
 * dump validates but does not walk as the known block chain; the whole result
 * is `undefined` when the dump does not arrive or fails its CRC. Never throws.
 */
export async function readActiveBufferSnapshot(
  conn: MidiConnection,
): Promise<{ body: Am4PresetBody | undefined; name: string } | undefined> {
  const decoded = await readActiveBufferDecoded(conn);
  if (decoded === undefined) return undefined;
  let body: Am4PresetBody | undefined;
  try {
    body = decodeAm4PresetBody(decoded.decompressedBody, decoded.decompSize);
  } catch {
    body = undefined;
  }
  return { body, name: decoded.name };
}

export async function readActiveBufferBody(conn: MidiConnection): Promise<Am4PresetBody | undefined> {
  const decoded = await readActiveBufferDecoded(conn);
  if (decoded === undefined) return undefined;
  try {
    return decodeAm4PresetBody(decoded.decompressedBody, decoded.decompSize);
  } catch {
    return undefined;
  }
}

/**
 * The working buffer's decompressed preset body (CRC + Huffman validated), or
 * `undefined` when the dump does not arrive or does not validate. Never throws.
 * import_preset compares this against the pushed file's own body to tell a
 * restore that landed from one that did not (contract review L2).
 */
export async function readActiveBufferDecoded(
  conn: MidiConnection,
): Promise<{ decompressedBody: Uint8Array; decompSize: number; name: string } | undefined> {
  try {
    const streamPromise = receivePresetDumpStream(conn, { timeoutMs: BUFFER_DUMP_TIMEOUT_MS });
    conn.send(buildRequestActiveBufferDump());
    const stream = await streamPromise;
    const flat: number[] = [...stream.headerBytes];
    for (const chunk of stream.chunkBytes) for (const b of chunk) flat.push(b);
    for (const b of stream.footerBytes) flat.push(b);
    const decoded = decodeAm4RawPatch(Uint8Array.from(flat));
    if (!decoded.crcValid || !decoded.huffmanComplete) return undefined;
    return { decompressedBody: decoded.decompressedBody, decompSize: decoded.decompSize, name: decoded.name };
  } catch {
    return undefined;
  }
}

/** Decode a dump file's own body the same way, or `undefined` when it does not validate. */
export function decodeDumpBody(bytes: Uint8Array): { decompressedBody: Uint8Array; decompSize: number } | undefined {
  try {
    const decoded = decodeAm4RawPatch(bytes);
    if (!decoded.crcValid || !decoded.huffmanComplete) return undefined;
    return { decompressedBody: decoded.decompressedBody, decompSize: decoded.decompSize };
  } catch {
    return undefined;
  }
}

/** One block's state on one scene. */
export interface SceneBlockState {
  slot: number;
  block: string;
  /** Channel the scene selects for this block (A/B/C/D). */
  channel: string;
  /** Whether the scene bypasses this block (the amp included). */
  bypassed: boolean;
}

/** Per-block channel + bypass for one scene (1-based) of a decoded body. */
export function sceneBlockStates(body: Am4PresetBody, scene: number): SceneBlockState[] {
  return body.blocks.map((b) => ({
    slot: b.slot,
    block: b.block ?? `effect_${b.effectId}`,
    channel: b.sceneChannels[scene - 1],
    bypassed: b.sceneBypass[scene - 1],
  }));
}

/** "drive (slot 1): channel A, bypassed; amp (slot 2): channel B" */
export function formatSceneBlockStates(states: readonly SceneBlockState[]): string {
  return states
    .map((s) => `${s.block} (slot ${s.slot}): channel ${s.channel}` +
      (s.bypassed === undefined ? '' : s.bypassed ? ', bypassed' : ', active'))
    .join('; ');
}

/** Read one block's bypass flag on the active scene. `undefined` when the read fails. */
export async function readBypassState(
  conn: MidiConnection,
  blockType: string,
  /** 1 for a second instance of the block (effect id = base + 1). */
  instanceOffset = 0,
): Promise<boolean | undefined> {
  const base = BLOCK_TYPE_VALUES[blockType as BlockTypeName];
  if (base === undefined || base === BLOCK_TYPE_VALUES.none) return undefined;
  const pidLow = base + instanceOffset;
  try {
    const readBytes = buildReadParam({ pidLow, pidHigh: BYPASS_STATE_PID_HIGH }, READ_TYPE_LONG);
    const respPromise = conn.receiveSysExMatching(
      (resp) => isReadResponseLong(readBytes, resp),
      READ_RESPONSE_TIMEOUT_MS,
    );
    conn.send(readBytes);
    return parseLongReadBypassFlag(await respPromise);
  } catch {
    return undefined;
  }
}
