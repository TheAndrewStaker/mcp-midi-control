/**
 * Modern Fractal family parity-test mock responder.
 *
 * Synthesizes the gen-3 device's reply to an fn=0x1F block bulk-read poll so
 * the reader's `getPreset` / `getParam` can be driven end to end against the
 * in-memory mock transport, with NO hardware. This is the gen-3 analog of the
 * AM4 mock's fn=0x1F triple responder: it lets the response-shape parity gate
 * (`scripts/verify-response-shape-parity.ts`) hold the gen-3 `PresetSnapshot`
 * and `ReadResult` envelopes to the same contract as the AM4 / Axe-Fx II
 * siblings.
 *
 * The synthesized frames are the device-emitted side of the read: a
 * `0x74` head + `0x75` body + `0x76` end state-broadcast burst (the real wire
 * shape, FM9-confirmed and documented in
 * `fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md`). They are built with the
 * real codec envelope + checksum + `packValue16` value encoding, not
 * hand-rolled bytes. A poll for a block that is NOT in the synthetic "placed"
 * set answers with a fn=0x64 multipurpose NACK (result code = effect not in
 * use), exactly as the real device rejects a poll for an empty block, so the
 * reader's poll loop short-circuits the empty blocks fast instead of paying a
 * timeout for each.
 *
 * This responder is for the parity gate / offline test harness only. The
 * production connectors keep `noInboundResponder` as their default (a real
 * device answers on the wire), so wiring this in never changes shipped
 * behaviour.
 */
import type { MockResponder } from '@mcp-midi-control/core/midi/transport.js';
import { fractalChecksum } from 'fractal-midi/shared';
import {
  packValue16,
  FN_BLOCK_BULK_READ,
  FN_MULTIPURPOSE_RESPONSE,
  AXE_FX_III_MODEL_ID,
} from 'fractal-midi/gen3/axe-fx-iii';
import { encode16to3, huffmanCompress, computeRawPatchCrc } from './presetHuffman.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const MFR_PREFIX: readonly number[] = [0x00, 0x01, 0x74];

const FN_BROADCAST_HEAD = 0x74;
const FN_BROADCAST_BODY = 0x75;
const FN_BROADCAST_END = 0x76;

/** Effect not in use in this preset (the NACK the device returns for an empty block). */
const MIDI_ERROR_FX_NOT_IN_USE = 0x07;

/**
 * Mid-scale wire value the body reports for every parameter. 32767 is the
 * midpoint of the gen-3 16-bit value space (0..65534), so it decodes to a
 * plausible "knob at 50%" reading through every uncalibrated passthrough
 * param without per-param tailoring.
 */
const MOCK_PARAM_VALUE = 32767;

/**
 * Item count the head advertises and the body delivers. Generous enough to
 * cover any single block's catalogued paramIds (the densest gen-3 family,
 * DISTORT, tops out at paramId 141), so `getParam` for any placed block's
 * param projects a value rather than tripping the past-end-of-dump guard. The
 * head's count equals the body's value count so the reader's truncation check
 * (`values.length < itemCount`) passes.
 */
const MOCK_ITEM_COUNT = 256;

function encode14Lo(v: number): number {
  return v & 0x7f;
}
function encode14Hi(v: number): number {
  return (v >> 7) & 0x7f;
}

function envelope(modelByte: number, fn: number, payload: readonly number[]): number[] {
  const body = [SYSEX_START, ...MFR_PREFIX, modelByte, fn, ...payload];
  return [...body, fractalChecksum(body), SYSEX_END];
}

/** MSB-first bit writer into a 7-bit-packed stream (inverse of the grid reader). */
function writeGridBits(region: number[], bit: number, value: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    region[Math.floor(b / 7)] = (region[Math.floor(b / 7)] ?? 0) | (((value >> (n - 1 - i)) & 1) << (6 - (b % 7)));
  }
}

/**
 * Build the device's reply to an empty-target `fn=0x01 sub=0x2E` grid query: a
 * 755-byte frame (the canonical 6-row length) whose TAIL carries the
 * 7-bit-packed grid, ending [checksum, F7] like the real device — the parser
 * anchors the region from the tail, so the checksum byte is load-bearing for
 * frame shape (its value is not verified). Lays the placed effect IDs across
 * row 0 (Input at col 0), so the reader decodes a coherent live grid (used by
 * get_preset's active path). Geometry matches gridLayout.ts:
 * cell_start_bit = 46 + col*192 + row*32.
 */
function buildGridLayoutResponse(modelByte: number, placedEffectIds: readonly number[]): number[] {
  const region = new Array(391).fill(0);
  // Input (effect id 37) at col 0, then each placed block in its own column, row 0.
  const chain = [37, ...placedEffectIds];
  chain.forEach((eid, col) => {
    const base = 46 + col * 192;
    writeGridBits(region, base, eid << 1, 8); // bits 0-7: effectId<<1
    writeGridBits(region, base + 8, 0x00, 8); // bits 8-15: 0x00 = real block
  });
  const header = [SYSEX_START, ...MFR_PREFIX, modelByte, 0x01, 0x2e];
  const frame = [...header];
  while (frame.length < 362) frame.push(0x00); // pad to mido offset 361 (frame idx 362)
  frame.push(...region);
  frame.push(frame.reduce((a, b) => a ^ b, 0) & 0x7f, SYSEX_END); // [checksum, F7] tail
  return frame;
}

/**
 * Build the 0x74/0x75/0x76 burst the device emits in answer to an fn=0x1F poll
 * for `effectId`. One 0x75 body section carries `MOCK_ITEM_COUNT` mid-scale
 * values, one `packValue16` triple each, in positional paramId order.
 */
function buildBroadcastBurst(
  modelByte: number,
  effectId: number,
  valueAt?: (effectId: number, index: number) => number,
): number[][] {
  const head = envelope(modelByte, FN_BROADCAST_HEAD, [
    encode14Lo(effectId), encode14Hi(effectId),
    encode14Lo(MOCK_ITEM_COUNT), encode14Hi(MOCK_ITEM_COUNT),
    0x00, // flag
  ]);

  const bodyValues: number[] = [];
  for (let i = 0; i < MOCK_ITEM_COUNT; i++) {
    bodyValues.push(...packValue16(valueAt ? valueAt(effectId, i) : MOCK_PARAM_VALUE));
  }
  const body = envelope(modelByte, FN_BROADCAST_BODY, [
    0x00, // sectionId
    0x00, // reserved / flag
    ...bodyValues,
  ]);

  const end = envelope(modelByte, FN_BROADCAST_END, []);
  return [head, body, end];
}

/** Build the fn=0x64 multipurpose NACK the device returns for a poll of an unplaced block. */
function buildNotInUseNack(modelByte: number): number[] {
  return envelope(modelByte, FN_MULTIPURPOSE_RESPONSE, [
    FN_BLOCK_BULK_READ,        // echoed function byte
    MIDI_ERROR_FX_NOT_IN_USE,  // result code
  ]);
}

const FN_REQUEST_EDIT_BUFFER_DUMP = 0x43;
const FN_EDIT_BUFFER_DUMP_HEAD = 0x51;
const FN_EDIT_BUFFER_DUMP_BODY = 0x52;

/** Number of synthetic 0x52 body frames the edit-buffer mock emits. */
const MOCK_EDIT_BUFFER_BODY_FRAMES = 3;

/**
 * Build the device's reply to an fn=0x43 REQUEST_EDIT_BUFFER_DUMP: a 0x51 head
 * (payload `00 00 04`, the wire-observed format tag) + a homogeneous run of
 * 0x52 body frames (lead word `00 08`, like the real dump) with NO tail frame.
 * Bodies are small synthetic blobs (the collector treats them as opaque), just
 * enough to exercise the reader's read-until-quiet termination.
 */
function buildEditBufferDump(modelByte: number): number[][] {
  const head = envelope(modelByte, FN_EDIT_BUFFER_DUMP_HEAD, [0x00, 0x00, 0x04]);
  const bodies: number[][] = [];
  for (let i = 0; i < MOCK_EDIT_BUFFER_BODY_FRAMES; i++) {
    bodies.push(envelope(modelByte, FN_EDIT_BUFFER_DUMP_BODY, [0x00, 0x08, i & 0x7f, 0x00]));
  }
  return [head, ...bodies];
}

/** fn=0x03 REQUEST_PRESET_DUMP → 0x77 head / 0x78 chunks / 0x79 footer. */
const FN_REQUEST_PRESET_DUMP = 0x03;
const FN_PRESET_DUMP_HEAD = 0x77;
const FN_PRESET_DUMP_CHUNK = 0x78;
const FN_PRESET_DUMP_FOOTER = 0x79;

/**
 * Build the device's reply to an fn=0x03 stored-preset dump request: a CRC-valid
 * single-chunk 0x77/0x78/0x79 dump carrying a preset name + 8 scene names, so
 * `get_preset(location)` and `translate_preset(source_location)` decode end to
 * end (CRC validates, `decodeGen3PresetDump` yields a `whole_preset`). The grid
 * + block chain are left empty (zero); the decode is exercised, the preset is
 * just sparse. Built with the real codec (encode16to3 + huffmanCompress + CRC),
 * so it round-trips through the production reader exactly like a device dump.
 */
function buildStoredPresetDump(modelByte: number, presetName = 'Mock Preset'): number[][] {
  // Decompressed body: scene names live at body[4 + i*32].
  const body = new Uint8Array(0x300);
  const sceneNames = ['Clean', 'Crunch', 'Rhythm', 'Lead', 'Ambient', 'Dry', 'Solo', 'Verb'];
  for (let i = 0; i < 8; i++) {
    const s = sceneNames[i];
    for (let j = 0; j < s.length && j < 31; j++) body[4 + i * 32 + j] = s.charCodeAt(j);
  }
  const comp = huffmanCompress(body);
  // raw_patch: 1 chunk = 1024 words = 2048 bytes. CRC@0x04, name@0x08,
  // decompSize@0x48, compSize@0x4A, Huffman body@0x4C.
  const rawPatch = new Uint8Array(2048);
  for (let j = 0; j < presetName.length && j < 31; j++) rawPatch[0x08 + j] = presetName.charCodeAt(j);
  rawPatch[0x48] = body.length & 0xff; rawPatch[0x49] = (body.length >> 8) & 0xff;
  rawPatch[0x4a] = comp.length & 0xff; rawPatch[0x4b] = (comp.length >> 8) & 0xff;
  rawPatch.set(comp, 0x4c);
  const crc = computeRawPatchCrc(rawPatch);
  rawPatch[0x04] = crc & 0xff; rawPatch[0x05] = (crc >> 8) & 0xff;
  const packed = encode16to3(rawPatch); // 1024 words → 3072 packed bytes
  const chunkPayload = [0x00, 0x00, ...Array.from(packed)]; // 2-byte discriminator + 3072
  return [
    envelope(modelByte, FN_PRESET_DUMP_HEAD, [0x00, 0x01, 0x00, 0x40, 0x00]),
    envelope(modelByte, FN_PRESET_DUMP_CHUNK, chunkPayload),
    envelope(modelByte, FN_PRESET_DUMP_FOOTER, [0x00, 0x00, 0x00]),
  ];
}

export interface Gen3ParityMockOptions {
  /** SysEx model byte (III 0x10, FM3 0x11, FM9 0x12). Defaults to the III. */
  modelByte?: number;
  /**
   * Effect IDs the synthetic preset has "placed". A poll for one of these
   * answers with a broadcast burst; any other effect ID answers with a
   * not-in-use NACK. Defaults to Amp 1 (58), Reverb 1 (66), Delay 1 (70) so
   * the snapshot has a few slots and the canonical `amp` probe resolves.
   */
  placedEffectIds?: readonly number[];
  /**
   * Optional per-index value override for the 0x75 body. `(effectId, index) =>
   * wire16`. The body is channel-blocked (index = channel × stride + paramId,
   * stride = itemCount/4), so a test can make one paramId differ across channels
   * by returning distinct values at `paramId`, `stride+paramId`, … . Defaults to
   * a constant mid-scale value (every channel equal).
   */
  valueAt?: (effectId: number, index: number) => number;
}

/**
 * Build a gen-3 mock responder for the parity gate. Recognizes the fn=0x1F
 * bulk-read poll and answers with the device's burst (placed block) or NACK
 * (unplaced block); returns no inbound frames for anything else.
 */
export function makeGen3BroadcastMockResponder(opts: Gen3ParityMockOptions = {}): MockResponder {
  const modelByte = opts.modelByte ?? AXE_FX_III_MODEL_ID;
  const placed = new Set(opts.placedEffectIds ?? [58, 66, 70]);

  return (outgoing: number[]): number[][] => {
    // Envelope gate (fn=0x43 is an 8-byte no-arg request, so check it before
    // the bulk-read length gate below).
    if (outgoing[0] !== SYSEX_START) return [];
    if (outgoing[1] !== MFR_PREFIX[0] || outgoing[2] !== MFR_PREFIX[1] || outgoing[3] !== MFR_PREFIX[2]) {
      return [];
    }
    if (outgoing[4] !== modelByte) return [];
    // Edit-buffer dump request (export_preset): reply with head + body run.
    if (outgoing[5] === FN_REQUEST_EDIT_BUFFER_DUMP) return buildEditBufferDump(modelByte);
    // Stored-preset dump request (get_preset(location) / translate source_location,
    // export_preset(location)): reply with a CRC-valid 0x77/0x78/0x79 dump.
    if (outgoing[5] === FN_REQUEST_PRESET_DUMP) return buildStoredPresetDump(modelByte);
    // Live grid query (get_preset active buffer): fn=0x01 sub=0x2E empty-target.
    if (outgoing[5] === 0x01 && outgoing[6] === 0x2e) {
      return [buildGridLayoutResponse(modelByte, [...placed])];
    }
    if (outgoing.length < 10) return [];
    if (outgoing[5] !== FN_BLOCK_BULK_READ) return [];
    const effectId = (outgoing[6] & 0x7f) | ((outgoing[7] & 0x7f) << 7);
    if (placed.has(effectId)) return buildBroadcastBurst(modelByte, effectId, opts.valueAt);
    return [buildNotInUseNack(modelByte)];
  };
}
