/**
 * Modern Fractal family — device-simulator response builders (published,
 * golden-testable).
 *
 * These are the PURE wire-frame builders the codec-backed device simulator
 * uses to answer a gen-3 editor's reads so the editor renders the block grid
 * over loopMIDI with no hardware. They live in the published package (not the
 * research script) so `npm test` covers their byte shapes against captured
 * device frames. The stateful machine that drives them lives in
 * `scripts/_research/sim/` (research-scoped) and calls into here.
 *
 * Wire facts these builders honor (all FM9-confirmed against the
 * 2026-06-03 connect+enum-sweep capture; byte-identical across model bytes
 * 0x10/0x11/0x12 per the shared gen-3 codec):
 *
 *  - Every fn=0x01 response ECHOES the query's bytes 5..11 verbatim (the fn
 *    byte, the sub-action, and the 4-byte address region), then fills a
 *    fixed-length tail, then the XOR-7 envelope checksum, then 0xF7. The
 *    echo-of-bytes-5..11 invariant held across every captured query/response
 *    pair, so it is centralized in `gen3EchoFrame`.
 *  - The fn=0x1F block bulk-read answer is a 0x74 head + N×0x75 body + 0x76
 *    end burst. The head is 12 bytes: `F0 00 01 74 <model> 74 [blockId:14b]
 *    [itemCount:14b] [cks] F7` — there is NO flag byte (the byte preceding
 *    F7 IS the checksum; this corrects `parityMock.ts`'s 13-byte head, whose
 *    extra flag byte the real editor would not expect). The body pages every
 *    256 values; itemCount = 4 × (block param count) because the body is
 *    channel-blocked (4 contiguous copies, channels A–D).
 *
 * Untested-wire discipline: these builders only assert shapes proven against
 * the capture. They are research-scoped consumers (the simulator answers a
 * local loopMIDI editor, not a shipping device tool), but the shapes are
 * golden-tested here so a regression surfaces in `npm test`.
 */
import { fractalChecksum } from 'fractal-midi/shared';
import { packValue16 } from 'fractal-midi/gen3/axe-fx-iii';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const MFR_PREFIX: readonly number[] = [0x00, 0x01, 0x74];

/** Gen-3 model bytes. */
export const GEN3_MODEL_AXE_FX_III = 0x10;
export const GEN3_MODEL_FM3 = 0x11;
export const GEN3_MODEL_FM9 = 0x12;

/** fn bytes (envelope position 5). */
export const FN_PARAMETER_SETGET = 0x01;
export const FN_BLOCK_BULK_READ = 0x1f;
export const FN_BROADCAST_HEAD = 0x74;
export const FN_BROADCAST_BODY = 0x75;
export const FN_BROADCAST_END = 0x76;
export const FN_MULTIPURPOSE_RESPONSE = 0x64;

/** fn=0x01 sub-actions (envelope position 6) the editor sends. */
export const SUB_BLOCK_DESCRIPTOR = 0x01;
export const SUB_LAYOUT_MAP = 0x2e;
export const SUB_PLACED_FLAG = 0x7b;
export const SUB_STREAM = 0x37;
export const SUB_PARAM_INFO = 0x1a;
export const SUB_PARAM_FLAGS = 0x1b;
export const SUB_TYPED_GET = 0x09;
export const SUB_GLOBAL_TABLE = 0x4b;
export const SUB_PRESET_DIRECTORY = 0x2a;
export const SUB_ENUM_LABEL_SWEEP = 0x1c;
export const SUB_ENUM_LIST = 0x56;
/** Write sub-actions (editor → device): block insert / cell-select / store / routing. */
export const SUB_GRID_INSERT = 0x32;
export const SUB_CELL_SELECT = 0x30;
export const SUB_STORE_PRESET = 0x26;
export const SUB_ROUTING = 0x35;

/**
 * Expected response byte-length per fn=0x01 sub-action, from the FM9 capture.
 * The simulator's M0 golden gates each served frame's length against this so a
 * shape error is caught offline, not as a confusing non-render. Subs the editor
 * only WRITES (insert/select/store/routing) are absent — they get no length gate.
 */
export const GEN3_RESPONSE_LENGTHS: Readonly<Record<number, number>> = Object.freeze({
  [SUB_LAYOUT_MAP]: 755,
  [SUB_BLOCK_DESCRIPTOR]: 115,
  [SUB_PARAM_INFO]: 60,
  [SUB_TYPED_GET]: 60,
  [SUB_PRESET_DIRECTORY]: 60,
  [SUB_GLOBAL_TABLE]: 60,
  [SUB_ENUM_LIST]: 60,
  [0x00]: 60,
  [SUB_PLACED_FLAG]: 23,
  [SUB_PARAM_FLAGS]: 23,
  [SUB_STREAM]: 23,
  [0x39]: 23,
  [0x19]: 23,
  [0x25]: 23,
  [0x27]: 23,
  [SUB_ENUM_LABEL_SWEEP]: 65,
});

/** Bodies page every 256 values (FM9-confirmed: a 588-value burst paged 256+256+76). */
export const BROADCAST_BODY_PAGE = 256;

// ── Low-level envelope helpers ─────────────────────────────────────

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

/** True if `bytes` is a Fractal SysEx envelope for `modelByte`. */
export function isGen3Envelope(bytes: readonly number[], modelByte: number): boolean {
  return (
    bytes.length >= 7
    && bytes[0] === SYSEX_START
    && bytes[1] === MFR_PREFIX[0]
    && bytes[2] === MFR_PREFIX[1]
    && bytes[3] === MFR_PREFIX[2]
    && bytes[4] === modelByte
  );
}

/**
 * Recompute the XOR-7 envelope checksum of a complete frame in place and
 * return a fresh array. Use this to serve a captured device frame VERBATIM:
 * the body bytes are reproduced exactly and only the checksum byte (the
 * second-to-last) is recomputed (it is identical when the body is unchanged).
 */
export function recomputeGen3Checksum(frame: readonly number[]): number[] {
  const out = frame.slice();
  const n = out.length;
  if (n < 3 || out[0] !== SYSEX_START || out[n - 1] !== SYSEX_END) {
    throw new Error('recomputeGen3Checksum: not a complete F0..F7 frame');
  }
  out[n - 2] = fractalChecksum(out.slice(0, n - 2));
  return out;
}

/**
 * Build a fn=0x01 response that echoes the query's bytes 5..11, appends the
 * `tail`, and closes with the XOR-7 checksum + 0xF7. `echo` is the query's
 * bytes 5..11 inclusive (7 bytes: fn=0x01, sub-action, and the 4-byte address
 * region). The total length is `12 + tail.length + 2`.
 */
export function gen3EchoFrame(
  modelByte: number,
  echo: readonly number[],
  tail: readonly number[],
): number[] {
  if (echo.length !== 7) {
    throw new Error(`gen3EchoFrame: echo must be query bytes 5..11 (7 bytes), got ${echo.length}`);
  }
  const body = [SYSEX_START, ...MFR_PREFIX, modelByte, ...echo, ...tail];
  return [...body, fractalChecksum(body), SYSEX_END];
}

/** Extract the echo region (bytes 5..11) from an inbound query. */
export function gen3EchoOf(query: readonly number[]): number[] {
  return query.slice(5, 12);
}

/**
 * Build the 23-byte placed-flag response (sub=0x7b). A block is rendered as
 * PLACED iff value bytes 12..13 are nonzero; an absent block answers all-zero.
 * `valueBytes` are the two bytes the device reports for a placed block (its
 * captured value, e.g. the amp's selected-model marker); pass `undefined` for
 * an absent block. The remaining 7 tail bytes are zero.
 */
export function buildPlacedFlagResponse(
  modelByte: number,
  query: readonly number[],
  valueBytes?: readonly [number, number],
): number[] {
  const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (valueBytes !== undefined) {
    tail[0] = valueBytes[0] & 0x7f;
    tail[1] = valueBytes[1] & 0x7f;
  }
  return gen3EchoFrame(modelByte, gen3EchoOf(query), tail);
}

/**
 * Build the 23-byte stream response (sub=0x37). The same query returns a
 * changing value in the real capture (a free-running meter/counter), so the
 * caller passes a per-session counter. Bytes 12..13 carry the low 14 bits of
 * the counter; bytes 14..16 reproduce the captured trailing context constants.
 * The exact counter law is undecoded (low-risk: a wrong cadence at most makes
 * the editor distrust the meter stream, not disconnect).
 */
export function buildStreamResponse(
  modelByte: number,
  query: readonly number[],
  counter: number,
): number[] {
  const [lo, hi] = encode14(counter & 0x3fff);
  // bytes 12..20 (9-byte tail): counter at 12..13, then the captured trailing
  // context bytes 14..16 = 0x28 0x12 0x04 (stable across captured frames).
  const tail = [lo, hi, 0x28, 0x12, 0x04, 0, 0, 0, 0];
  return gen3EchoFrame(modelByte, gen3EchoOf(query), tail);
}

// ── fn=0x1F block bulk-read burst (0x74 head + N×0x75 body + 0x76 end) ──

function envelope(modelByte: number, fn: number, payload: readonly number[]): number[] {
  const body = [SYSEX_START, ...MFR_PREFIX, modelByte, fn, ...payload];
  return [...body, fractalChecksum(body), SYSEX_END];
}

export interface BroadcastBurstSpec {
  /** Effect/block id echoed in the 0x74 head. */
  blockId: number;
  /**
   * Item count the head advertises. MUST equal `values.length` (the reader's
   * truncation guard rejects a burst with fewer values than advertised). For a
   * channel-blocked block this is 4 × the block's param count.
   */
  itemCount: number;
  /** Positional 16-bit wire values (channel-blocked: index = channel×stride + paramId). */
  values: readonly number[];
}

/**
 * Build the fn=0x1F answer: a 0x74 head + N×0x75 body + 0x76 end burst, the
 * device's real state-broadcast shape (channel-blocked positional body). The
 * head is 12 bytes with NO flag byte (byte 10 is the XOR-7 checksum). Bodies
 * page every `BROADCAST_BODY_PAGE` (256) values; each body is
 * `[sectionId=0] [flag=0] [N × packValue16]`. The 0x76 end carries no payload.
 *
 * This is the gen-3 analog of `parityMock.ts`'s `buildBroadcastBurst`, with the
 * head-shape bug fixed (no spurious flag byte) and the page size + itemCount
 * driven from real state rather than a 256-constant.
 */
export function buildBroadcastBurst(
  modelByte: number,
  spec: BroadcastBurstSpec,
): number[][] {
  const { blockId, itemCount, values } = spec;
  if (values.length !== itemCount) {
    throw new Error(
      `buildBroadcastBurst: itemCount ${itemCount} must equal values.length ${values.length}`,
    );
  }
  const head = envelope(modelByte, FN_BROADCAST_HEAD, [
    ...encode14(blockId),
    ...encode14(itemCount),
  ]);
  const frames: number[][] = [head];
  for (let off = 0; off < values.length; off += BROADCAST_BODY_PAGE) {
    const page = values.slice(off, off + BROADCAST_BODY_PAGE);
    const bodyValues: number[] = [];
    for (const v of page) bodyValues.push(...packValue16(v));
    frames.push(envelope(modelByte, FN_BROADCAST_BODY, [0x00, 0x00, ...bodyValues]));
  }
  frames.push(envelope(modelByte, FN_BROADCAST_END, []));
  return frames;
}

/** Build the fn=0x64 NACK the device returns for a poll of an unplaced block. */
export function buildNotInUseNack(modelByte: number): number[] {
  return envelope(modelByte, FN_MULTIPURPOSE_RESPONSE, [FN_BLOCK_BULK_READ, 0x07]);
}

/** Parse a 0x74 head → { blockId, itemCount }. Mirrors the codec's parser. */
export function parseBurstHead(bytes: readonly number[]): { blockId: number; itemCount: number } {
  return { blockId: decode14(bytes[6], bytes[7]), itemCount: decode14(bytes[8], bytes[9]) };
}

export { encode14 as gen3Encode14, decode14 as gen3Decode14 };

/**
 * Build a live grid reply (fn=0x01 sub=0x2E) carrying `cells` (0-based row /
 * col, effect id or 1024 + shunt index, input mask) - the inverse of
 * fractal-midi's parseGen3GridLayout: a 361-byte header then the
 * tail-anchored bit region (u16 id + u16 mask per cell, LSB byte first,
 * MSB-first bits, 7 bits per byte). FM9 / III frames come out 755 bytes,
 * the captured length.
 */
export function buildGen3GridLayoutFrame(
  modelByte: number,
  cells: ReadonlyArray<{ row: number; col: number; id: number; mask: number }>,
): number[] {
  const rows = modelByte === GEN3_MODEL_FM3 ? 4 : 6;
  const cols = modelByte === GEN3_MODEL_FM3 ? 12 : 14;
  const BASE_BIT = 46;
  const CELL_BIT = 45;
  const ROW_STRIDE = 32;
  const regionBytes = Math.ceil((BASE_BIT + cols * rows * ROW_STRIDE) / 7);
  const region = new Array<number>(regionBytes).fill(0);
  const put = (bit: number, n: number, v: number): void => {
    for (let i = 0; i < n; i++) {
      const b = bit + i;
      if ((v >> (n - 1 - i)) & 1) region[Math.floor(b / 7)] |= 1 << (6 - (b % 7));
    }
  };
  for (const c of cells) {
    const base = CELL_BIT + c.col * rows * ROW_STRIDE + c.row * ROW_STRIDE;
    put(base, 8, c.id & 0xff); put(base + 8, 8, (c.id >> 8) & 0xff);
    put(base + 16, 8, c.mask & 0xff); put(base + 24, 8, (c.mask >> 8) & 0xff);
  }
  const header = new Array<number>(361).fill(0);
  header.splice(0, 6, 0x00, 0x01, 0x74, modelByte, FN_PARAMETER_SETGET, SUB_LAYOUT_MAP);
  return recomputeGen3Checksum([0xf0, ...header.slice(0, 361), ...region, 0x00, 0xf7]);
}

/** Build a fn=0x13 status dump reply: `id lo, id hi, dd` per block (dd: bit0 bypass, bits 1-3 channel, bits 4-6 channel count). */
export function buildGen3StatusDumpFrame(
  modelByte: number,
  entries: ReadonlyArray<{ effectId: number; bypassed: boolean; channel: number; channelCount?: number }>,
): number[] {
  const body = entries.flatMap((e) => [e.effectId & 0x7f, (e.effectId >> 7) & 0x7f, ((e.channelCount ?? 4) << 4) | (e.channel << 1) | (e.bypassed ? 1 : 0)]);
  return recomputeGen3Checksum([0xf0, 0x00, 0x01, 0x74, modelByte, 0x13, ...body, 0x00, 0xf7]);
}
