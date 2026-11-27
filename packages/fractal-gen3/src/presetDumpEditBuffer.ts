/**
 * Gen-3 (Axe-Fx III / FM3 / FM9) EDIT-BUFFER preset dump: the pure codec half
 * of loading a whole preset into the unit's working buffer.
 *
 * A 0x77/0x78/0x79 dump (presetDump.ts) carries its TARGET in the 0x77 header
 * payload bytes 0-1, a 14-bit big-endian septet pair. A dump read from stored
 * preset N still names N; sending it verbatim addresses that stored preset.
 * Retargeting bytes 0-1 to `7F 7F` (0x3FFF, the edit-buffer sentinel) makes
 * the unit load it into the edit buffer and write no stored preset. Only the
 * header frame changes (and its frame checksum); the chunk frames and the
 * footer XOR do not cover the header, so they stay byte-identical, as does the
 * raw-patch CRC (raw bytes 4-5, which covers the raw patch only).
 *
 * The unit answers EACH frame of the transfer with a 0x64 MULTIPURPOSE_RESPONSE
 * echoing that frame's function: `64 [fn] 00` is the per-frame success
 * acknowledgement, any other result code is a refusal.
 *
 * EVIDENCE (two independent open-source implementations; untested by us, no
 * gen-3 hardware here):
 *  - fractone (GreyManSoftware, MIT), FM9 fw 12 hardware-verified whole-preset
 *    loads: Fm9PresetDump.ForEditBufferImport (header bytes 0-1 -> 7F 7F,
 *    frames rebuilt), Fm9EditBufferRestoreSender.RestoreAcknowledgedAsync
 *    (each frame must draw `64 [fn] 00`, <= 3 whole-transfer attempts, 300 ms
 *    settle), FractalSysExCodec.IsSuccessfulAcknowledgement (fn 0x64, echoed
 *    fn, result 0).
 *  - forgefx-midi (sKuhLight, Apache-2.0) presetDump.ts
 *    retargetPresetDumpToEditBuffer (same 7F 7F rewrite + header checksum),
 *    live-validated on an FM3 by the ForgeFX server's audition flow.
 * Both agree byte for byte on the retarget. Edit-buffer-addressed dumps also
 * exist as device-written files: fractone's empty templates carry `7F 7F`.
 *
 * OPEN CONFLICT on result code 0x00: our 0x64 code table labels index 0
 * MIDI_ERROR_BAD_CHKSUM (from Axe-Edit III's string table plus one capture of
 * a bad-checksum query answered `64 0E 00`), while the Axe-Fx II answers a
 * successful routing write `64 06 00` and fractone treats `64 [fn] 00` as the
 * dump-frame success on FM9 hardware. For THIS transfer we follow the
 * hardware-verified implementation: code 0 = acknowledged. See SYSEX-MAP
 * (axe-fx-iii) "edit-buffer preset dump write".
 */
import {
  buildRequestPresetDump,
  describeMultipurposeResultCode,
  isMultipurposeResponse,
  parseMultipurposeResponse,
} from 'fractal-midi/gen3/axe-fx-iii';
import { HEADER_PAYLOAD_LEN, serializePresetDump } from './presetDump.js';
import type { ParsedPresetDump } from './presetDump.js';

/** The 14-bit preset number that addresses the edit buffer (`7F 7F`). */
export const EDIT_BUFFER_PRESET_NUMBER = 0x3fff;

/** Function bytes of the three dump frame kinds. */
export const FN_DUMP_HEADER = 0x77;
export const FN_DUMP_CHUNK = 0x78;
export const FN_DUMP_FOOTER = 0x79;

/** True when the dump's header already addresses the edit buffer. */
export function dumpTargetsEditBuffer(dump: ParsedPresetDump): boolean {
  return dump.headerPayload[0] === 0x7f && dump.headerPayload[1] === 0x7f;
}

/**
 * The same dump, addressed to the edit buffer: header payload bytes 0-1 set to
 * `7F 7F`, header checksum recomputed, every other byte unchanged. Header
 * payload bytes 2-4 (device-specific: III `00 00 01`, FM3/FM9 `00 40 00`) are
 * kept as read. Never mutates its input.
 */
export function retargetPresetDumpToEditBuffer(dump: ParsedPresetDump): ParsedPresetDump {
  if (dump.headerPayload.length !== HEADER_PAYLOAD_LEN) {
    throw new Error(
      `retargetPresetDumpToEditBuffer: header payload must be ${HEADER_PAYLOAD_LEN} bytes, got ${dump.headerPayload.length}`,
    );
  }
  const headerPayload = Uint8Array.from(dump.headerPayload);
  headerPayload[0] = 0x7f;
  headerPayload[1] = 0x7f;
  const shaped: ParsedPresetDump = { ...dump, headerPayload, raw: new Uint8Array(0), byteLength: 0 };
  const raw = serializePresetDump(shaped);
  return { ...shaped, raw, byteLength: raw.length };
}

/** Split a serialized dump into its individual F0..F7 frames, in order. */
export function splitDumpFrames(bytes: Uint8Array): number[][] {
  const frames: number[][] = [];
  let start = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0xf0) start = i;
    else if (bytes[i] === 0xf7 && start >= 0) {
      frames.push(Array.from(bytes.subarray(start, i + 1)));
      start = -1;
    }
  }
  return frames;
}

/**
 * The frames to send for an edit-buffer load: the dump retargeted to `7F 7F`,
 * one 0x77 header, the 0x78 chunks, one 0x79 footer. Nothing else: in
 * particular no fn=0x01 sub=0x27 preset switch goes ahead of the dump (fractone
 * observed the FM9 showing preset #0 when one did).
 */
export function buildEditBufferLoadFrames(dump: ParsedPresetDump): number[][] {
  return splitDumpFrames(retargetPresetDumpToEditBuffer(dump).raw);
}

/**
 * fn=0x03 request for the EDIT BUFFER as a 0x77/0x78/0x79 dump (preset number
 * 0x3FFF, `03 7F 7F 00`). Read-only. fractone reads the FM9 edit buffer this
 * way after every load (Fm9StoredPresetReader.ReadAsync(0x3FFF)); the reply's
 * header payload reads `7F 00 ...` on the FM9 (fractone's read-back fixture),
 * so a read-back is recognised by its content, not by its header.
 */
export function buildRequestEditBufferPresetDump(modelByte: number): number[] {
  return buildRequestPresetDump(EDIT_BUFFER_PRESET_NUMBER, modelByte);
}

export type DumpFrameAck =
  | { kind: 'ack' }
  | { kind: 'refused'; resultCode: number; description?: string };

/**
 * Classify an inbound frame as the answer to a dump frame of function
 * `sentFn` (0x77 / 0x78 / 0x79): `ack` for `64 [sentFn] 00`, `refused` for
 * `64 [sentFn] <code != 0>`, undefined for anything else (another function's
 * 0x64, the 0x64 tuner/tempo status stream, any other frame). Reuses the
 * shared 0x64 predicate with echoed-function matching.
 */
export function classifyDumpFrameResponse(
  frame: readonly number[],
  modelByte: number,
  sentFn: number,
): DumpFrameAck | undefined {
  if (!isMultipurposeResponse(frame, modelByte, sentFn)) return undefined;
  const { resultCode } = parseMultipurposeResponse(frame, modelByte);
  if (resultCode === 0) return { kind: 'ack' };
  return { kind: 'refused', resultCode, description: describeMultipurposeResultCode(resultCode) };
}
