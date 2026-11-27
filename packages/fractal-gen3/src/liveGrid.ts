/**
 * Live gen-3 edit-buffer state reads shared by the writer's build, set_block
 * guard and verify_chain: the routing grid (fn=0x01 sub=0x2E) and the active
 * scene's per-block bypass/channel (fn=0x13 status dump).
 *
 * Grid read evidence: the bit-45 u16 decode (parseGen3GridLayout) is FM3
 * hardware-confirmed cell-exact on 7 generated grids incl. splits, merges and
 * shunt ids up to 1037 (2026-10-23), with an FM9 fw 12 field report matching
 * the same mask law. The "live read misreads ids above 127" note in other
 * implementations is about the older bit-46 u8 layout, which we no longer use.
 * Status dump: FM9 hardware placement read-back (2026-06-19), FM3 channel
 * verify (2026-09-14).
 */
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { buildRequestGridLayout, parseGen3GridLayout, type ModernFractalCodec } from 'fractal-midi/gen3/axe-fx-iii';

/** One occupied cell, 1-based coordinates. */
export interface LiveCell {
  row: number;
  col: number;
  /** Effect id, or undefined for a shunt. */
  effectId?: number;
  isShunt: boolean;
  shuntIndex?: number;
  /** Bit k = a cable from row k+1 of the previous column. */
  inputMask: number;
}

/** Send the sub=0x2E query and return the raw reply frame (undefined on timeout). */
export async function requestLiveGridFrame(ctx: DispatchCtx, modelByte: number, timeoutMs: number): Promise<number[] | undefined> {
  let frame: number[] | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });
  const unsubscribe = ctx.conn.onMessage((bytes) => {
    if (frame === undefined && bytes[1] === 0x00 && bytes[4] === modelByte && bytes[5] === 0x01 && bytes[6] === 0x2e && bytes.length > 400) {
      frame = [...bytes];
      resolveDone();
    }
  });
  const timer = setTimeout(resolveDone, timeoutMs);
  try {
    ctx.conn.send(buildRequestGridLayout(modelByte));
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  return frame;
}

/** Decode a sub=0x2E reply to 1-based cells. */
export function liveCellsFromFrame(frame: number[], modelByte: number): LiveCell[] {
  return parseGen3GridLayout(frame, modelByte).map((c) => ({
    row: c.row + 1,
    col: c.col + 1,
    ...(c.isShunt ? {} : { effectId: c.effectId }),
    isShunt: c.isShunt,
    ...(c.isShunt ? { shuntIndex: c.shuntIndex } : {}),
    inputMask: c.cableInputMask,
  }));
}

/** Read the live grid; undefined when the unit does not answer or the frame does not decode. */
export async function readLiveGrid(ctx: DispatchCtx, modelByte: number, timeoutMs: number): Promise<LiveCell[] | undefined> {
  const frame = await requestLiveGridFrame(ctx, modelByte, timeoutMs);
  if (frame === undefined) return undefined;
  try {
    return liveCellsFromFrame(frame, modelByte);
  } catch {
    return undefined;
  }
}

export interface LiveBlockState {
  effectId: number;
  bypassed: boolean;
  channel: number;
}

/** Read the active scene's status dump; undefined on timeout / parse failure. */
export async function readStatus(ctx: DispatchCtx, codec: ModernFractalCodec, timeoutMs: number): Promise<LiveBlockState[] | undefined> {
  try {
    const reply = ctx.conn.receiveSysExMatching((b) => codec.isStatusDumpResponse(b), timeoutMs);
    reply.catch(() => {});
    ctx.conn.send(codec.buildStatusDump());
    return codec.parseStatusDumpResponse(await reply).map((e) => ({ effectId: e.effectId, bypassed: e.bypassed, channel: e.channel }));
  } catch {
    return undefined;
  }
}

/** Read the active scene (1-based); undefined when the unit does not answer. */
export async function readActiveScene(ctx: DispatchCtx, codec: ModernFractalCodec, timeoutMs: number): Promise<number | undefined> {
  try {
    const reply = ctx.conn.receiveSysExMatching((b) => codec.isSetGetSceneResponse(b), timeoutMs);
    reply.catch(() => {});
    ctx.conn.send(codec.buildGetScene());
    return codec.parseSceneResponse(await reply).scene + 1;
  } catch {
    return undefined;
  }
}
