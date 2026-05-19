/**
 * AM4 0x77/0x78/0x79 PRESET_DUMP message parsing and serialization.
 *
 * A single AM4 preset is exported / uploaded as a 6-message stream totaling
 * 12,352 bytes:
 *
 *   Msg 1   13B    func 0x77   PRESET_DUMP_HEADER  (5-byte payload)
 *   Msg 2  3082B   func 0x78   PRESET_DUMP_CHUNK 1 (3074-byte payload)
 *   Msg 3  3082B   func 0x78   PRESET_DUMP_CHUNK 2
 *   Msg 4  3082B   func 0x78   PRESET_DUMP_CHUNK 3
 *   Msg 5  3082B   func 0x78   PRESET_DUMP_CHUNK 4
 *   Msg 6   11B    func 0x79   PRESET_DUMP_FOOTER  (3-byte payload)
 *
 * Per the Fractal Presets Update Guide, the same byte stream that AM4-Edit
 * exports to a `.syx` file can be sent back to the device to upload it. The
 * factory bank file `AM4-Factory-Presets-1p01.syx` is exactly 104 ×
 * 12,352 bytes — a clean concatenation of all 104 factory preset dumps.
 *
 * This module deliberately treats the chunk payloads as opaque blobs. The
 * inner structure is XOR-masked or otherwise scrambled (see SYSEX-MAP.md
 * §11) and decoding it isn't needed for backup / restore — we just need a
 * byte-identical round-trip and checksum validation on every message.
 *
 * Target-location encoding inside the 0x77 header payload is not yet
 * fully decoded (SYSEX-MAP.md §10b). Verifying which header byte(s) vary
 * across the 104 factory dumps is the job of `scripts/verify-preset-dump.ts`.
 * Until that decode is confirmed, restoring a dump to a *different*
 * location than the one it was originally captured from is not safe — a
 * verbatim re-emit goes back to the source location only.
 */

import { fractalChecksum } from 'fractal-midi/shared';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL_ID = 0x15;

const FUNC_PRESET_HEADER = 0x77;
const FUNC_PRESET_CHUNK = 0x78;
const FUNC_PRESET_FOOTER = 0x79;

export const HEADER_LEN = 13;
export const CHUNK_LEN = 3082;
export const FOOTER_LEN = 11;
export const CHUNKS_PER_PRESET = 4;

/** Bytes wrapping a payload: F0 + 3 mfr + model + func + cs + F7 = 8. */
const ENVELOPE_OVERHEAD = 8;

export const HEADER_PAYLOAD_LEN = HEADER_LEN - ENVELOPE_OVERHEAD; // 5
export const CHUNK_PAYLOAD_LEN = CHUNK_LEN - ENVELOPE_OVERHEAD;   // 3074
export const FOOTER_PAYLOAD_LEN = FOOTER_LEN - ENVELOPE_OVERHEAD; // 3

/** Total bytes in one preset dump on disk / on the wire. */
export const PRESET_DUMP_LEN =
  HEADER_LEN + CHUNK_LEN * CHUNKS_PER_PRESET + FOOTER_LEN; // 12,352

/** A parsed preset dump. Payload buffers are slices of the source bytes. */
export interface ParsedPresetDump {
  /** The original 12,352 bytes this dump was parsed from. */
  readonly raw: Uint8Array;
  /** 5 bytes between 0x77 and its checksum. Encodes the target location. */
  readonly headerPayload: Uint8Array;
  /** 4 × 3074-byte chunk payloads. Inner structure is opaque (XOR-masked). */
  readonly chunkPayloads: readonly Uint8Array[];
  /** 3 bytes between 0x79 and its checksum. Believed to be a content hash. */
  readonly footerPayload: Uint8Array;
}

function hex(b: number): string {
  return '0x' + b.toString(16).padStart(2, '0');
}

function checkEnvelope(
  bytes: Uint8Array,
  offset: number,
  length: number,
  expectedFunc: number,
  what: string,
): void {
  if (bytes[offset] !== SYSEX_START) {
    throw new Error(`${what}: expected F0 at offset ${offset}, got ${hex(bytes[offset])}`);
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[offset + 1 + i] !== FRACTAL_MFR[i]) {
      throw new Error(
        `${what}: expected Fractal manufacturer ID 00 01 74 at offset ${offset + 1}, ` +
          `got ${hex(bytes[offset + 1])} ${hex(bytes[offset + 2])} ${hex(bytes[offset + 3])}`,
      );
    }
  }
  if (bytes[offset + 4] !== AM4_MODEL_ID) {
    throw new Error(
      `${what}: expected AM4 model ID 0x15 at offset ${offset + 4}, got ${hex(bytes[offset + 4])}`,
    );
  }
  if (bytes[offset + 5] !== expectedFunc) {
    throw new Error(
      `${what}: expected function ${hex(expectedFunc)} at offset ${offset + 5}, ` +
        `got ${hex(bytes[offset + 5])}`,
    );
  }
  if (bytes[offset + length - 1] !== SYSEX_END) {
    throw new Error(
      `${what}: expected F7 at offset ${offset + length - 1}, got ${hex(bytes[offset + length - 1])}`,
    );
  }

  // Checksum is XOR of every byte from F0 (offset) through the last payload
  // byte (offset + length - 3), AND'd with 0x7F. The cs byte itself sits at
  // offset + length - 2, F7 at offset + length - 1.
  let acc = 0;
  const csInputEnd = offset + length - 2;
  for (let i = offset; i < csInputEnd; i++) acc ^= bytes[i];
  const expected = acc & 0x7f;
  const got = bytes[offset + length - 2];
  if (got !== expected) {
    throw new Error(
      `${what}: checksum mismatch at offset ${offset + length - 2}: ` +
        `expected ${hex(expected)}, got ${hex(got)}`,
    );
  }
}

/**
 * Parse one preset dump (12,352 bytes) from a buffer.
 *
 * Validates every message envelope and checksum. Throws on any malformed
 * byte. The returned payload arrays are slices of the source buffer.
 */
export function parsePresetDump(bytes: Uint8Array, offset = 0): ParsedPresetDump {
  if (offset + PRESET_DUMP_LEN > bytes.length) {
    throw new Error(
      `parsePresetDump: insufficient bytes — need ${PRESET_DUMP_LEN} starting at offset ${offset}, ` +
        `got ${bytes.length - offset} remaining`,
    );
  }

  const headerStart = offset;
  checkEnvelope(bytes, headerStart, HEADER_LEN, FUNC_PRESET_HEADER, 'PRESET_DUMP_HEADER (0x77)');
  const headerPayload = bytes.slice(
    headerStart + 6,
    headerStart + HEADER_LEN - 2,
  );

  const chunkPayloads: Uint8Array[] = [];
  let cursor = headerStart + HEADER_LEN;
  for (let i = 0; i < CHUNKS_PER_PRESET; i++) {
    checkEnvelope(
      bytes,
      cursor,
      CHUNK_LEN,
      FUNC_PRESET_CHUNK,
      `PRESET_DUMP_CHUNK ${i + 1}/${CHUNKS_PER_PRESET} (0x78)`,
    );
    chunkPayloads.push(bytes.slice(cursor + 6, cursor + CHUNK_LEN - 2));
    cursor += CHUNK_LEN;
  }

  checkEnvelope(bytes, cursor, FOOTER_LEN, FUNC_PRESET_FOOTER, 'PRESET_DUMP_FOOTER (0x79)');
  const footerPayload = bytes.slice(cursor + 6, cursor + FOOTER_LEN - 2);

  return {
    raw: bytes.slice(offset, offset + PRESET_DUMP_LEN),
    headerPayload,
    chunkPayloads,
    footerPayload,
  };
}

/**
 * Parse a buffer holding N back-to-back preset dumps. The factory bank
 * file `AM4-Factory-Presets-1p01.syx` is the canonical example: 104
 * concatenated dumps, no separator.
 */
export function parsePresetBank(bytes: Uint8Array): ParsedPresetDump[] {
  if (bytes.length === 0 || bytes.length % PRESET_DUMP_LEN !== 0) {
    throw new Error(
      `parsePresetBank: expected length to be a non-zero multiple of ${PRESET_DUMP_LEN} ` +
        `(one preset dump), got ${bytes.length}`,
    );
  }
  const count = bytes.length / PRESET_DUMP_LEN;
  const out: ParsedPresetDump[] = [];
  for (let i = 0; i < count; i++) {
    out.push(parsePresetDump(bytes, i * PRESET_DUMP_LEN));
  }
  return out;
}

function buildMessage(
  func: number,
  payload: Uint8Array,
  totalLen: number,
): Uint8Array {
  const out = new Uint8Array(totalLen);
  out[0] = SYSEX_START;
  out[1] = FRACTAL_MFR[0];
  out[2] = FRACTAL_MFR[1];
  out[3] = FRACTAL_MFR[2];
  out[4] = AM4_MODEL_ID;
  out[5] = func;
  out.set(payload, 6);
  const csIndex = 6 + payload.length;
  let acc = 0;
  for (let i = 0; i < csIndex; i++) acc ^= out[i];
  out[csIndex] = acc & 0x7f;
  out[csIndex + 1] = SYSEX_END;
  return out;
}

/**
 * Serialize a parsed dump back to its 12,352-byte wire form. For any input
 * that came from `parsePresetDump`, the output is byte-identical to the
 * input. Useful for backup-and-replay; also the round-trip property the
 * preflight golden checks against the factory bank.
 */
export function serializePresetDump(parsed: ParsedPresetDump): Uint8Array {
  if (parsed.headerPayload.length !== HEADER_PAYLOAD_LEN) {
    throw new Error(
      `serializePresetDump: header payload must be ${HEADER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.headerPayload.length}`,
    );
  }
  if (parsed.chunkPayloads.length !== CHUNKS_PER_PRESET) {
    throw new Error(
      `serializePresetDump: expected ${CHUNKS_PER_PRESET} chunk payloads, ` +
        `got ${parsed.chunkPayloads.length}`,
    );
  }
  for (let i = 0; i < parsed.chunkPayloads.length; i++) {
    if (parsed.chunkPayloads[i].length !== CHUNK_PAYLOAD_LEN) {
      throw new Error(
        `serializePresetDump: chunk ${i + 1} payload must be ${CHUNK_PAYLOAD_LEN} bytes, ` +
          `got ${parsed.chunkPayloads[i].length}`,
      );
    }
  }
  if (parsed.footerPayload.length !== FOOTER_PAYLOAD_LEN) {
    throw new Error(
      `serializePresetDump: footer payload must be ${FOOTER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.footerPayload.length}`,
    );
  }

  const out = new Uint8Array(PRESET_DUMP_LEN);
  let cursor = 0;
  out.set(buildMessage(FUNC_PRESET_HEADER, parsed.headerPayload, HEADER_LEN), cursor);
  cursor += HEADER_LEN;
  for (const chunk of parsed.chunkPayloads) {
    out.set(buildMessage(FUNC_PRESET_CHUNK, chunk, CHUNK_LEN), cursor);
    cursor += CHUNK_LEN;
  }
  out.set(buildMessage(FUNC_PRESET_FOOTER, parsed.footerPayload, FOOTER_LEN), cursor);
  return out;
}

/**
 * Re-export of the checksum helper, in case callers want to validate
 * stray bytes ahead of `parsePresetDump`.
 */
export { fractalChecksum };

/**
 * Result of a successful 6-message preset-dump capture from the device.
 *
 * `bank` and `sub` are the addressing bytes from the 0x77 header payload
 * (positions 0..1). For an active-buffer dump (the only variant
 * `am4_request_active_buffer_dump` ships today) `bank === 0x7F` and
 * `sub === 0x00`. A future stored-preset dump tool will see the actual
 * location bytes here.
 *
 * `headerBytes` / `chunkBytes` / `footerBytes` are the raw SysEx messages
 * including the F0/F7 envelope and checksum, so they can be re-emitted
 * byte-identically (e.g. saved to a `.syx` file or replayed back to the
 * device for restore).
 */
export interface PresetDumpStream {
  readonly bank: number;
  readonly sub: number;
  readonly totalBytes: number;
  readonly messageCount: number;
  readonly headerBytes: number[];
  readonly chunkBytes: number[][];
  readonly footerBytes: number[];
}

export interface ReceivePresetDumpStreamOptions {
  /**
   * Maximum wall time to wait for the full 6-message stream to arrive,
   * measured from when this function is called. Default 2000 ms — generous
   * for a 12 KB stream over USB-MIDI; on hardware the 6 messages typically
   * arrive within ~250 ms (Session 51 capture: ~2 ms wall time between
   * first 0x77 and final 0x79 frames).
   */
  readonly timeoutMs?: number;
}

/**
 * Validate that `bytes` is a single well-formed preset-dump message of the
 * expected length and function byte. Throws with a clear message on any
 * mismatch (envelope, manufacturer ID, model byte, function, F7, checksum).
 *
 * Used by `receivePresetDumpStream` to validate each of the 6 messages as
 * they arrive; goldens-friendly because it's a pure function.
 */
function assertDumpMessageShape(
  bytes: number[],
  expectedFunc: number,
  expectedLen: number,
  what: string,
): void {
  if (bytes.length !== expectedLen) {
    throw new Error(`${what}: expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== SYSEX_START) {
    throw new Error(`${what}: expected F0 at offset 0, got ${hex(bytes[0])}`);
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[1 + i] !== FRACTAL_MFR[i]) {
      throw new Error(
        `${what}: expected Fractal manufacturer ID 00 01 74 at offset 1, ` +
          `got ${hex(bytes[1])} ${hex(bytes[2])} ${hex(bytes[3])}`,
      );
    }
  }
  if (bytes[4] !== AM4_MODEL_ID) {
    throw new Error(`${what}: expected AM4 model ID 0x15 at offset 4, got ${hex(bytes[4])}`);
  }
  if (bytes[5] !== expectedFunc) {
    throw new Error(
      `${what}: expected function ${hex(expectedFunc)} at offset 5, got ${hex(bytes[5])}`,
    );
  }
  if (bytes[bytes.length - 1] !== SYSEX_END) {
    throw new Error(
      `${what}: expected F7 at offset ${bytes.length - 1}, got ${hex(bytes[bytes.length - 1])}`,
    );
  }
  const csIdx = bytes.length - 2;
  let acc = 0;
  for (let i = 0; i < csIdx; i++) acc ^= bytes[i];
  const expected = acc & 0x7f;
  if (bytes[csIdx] !== expected) {
    throw new Error(
      `${what}: checksum mismatch at offset ${csIdx}: ` +
        `expected ${hex(expected)}, got ${hex(bytes[csIdx])}`,
    );
  }
}

/**
 * Listen on `conn` for a 6-message preset-dump stream and assemble the
 * result. Caller must register this BEFORE sending the request so the
 * response can't race ahead of the listener (same convention as
 * `receiveSysExMatching`).
 *
 * Resolves once the 0x79 footer arrives after a valid header + 4 chunks.
 * Rejects on:
 *   - Timeout (no full stream within `timeoutMs` of the call site).
 *   - Out-of-order messages (e.g. a 0x78 chunk before the 0x77 header).
 *   - Malformed envelope, wrong length, or checksum failure on any frame.
 *
 * Returns the structured stream including the addressing bytes
 * (bank/sub) decoded from the 0x77 header payload. For an
 * active-buffer dump these are `0x7F` and `0x00`; the response shape
 * is documented in `docs/devices/am4/preset-dump-request-research.md`.
 */
export function receivePresetDumpStream(
  conn: MidiConnection,
  options: ReceivePresetDumpStreamOptions = {},
): Promise<PresetDumpStream> {
  const timeoutMs = options.timeoutMs ?? 2000;
  return new Promise<PresetDumpStream>((resolve, reject) => {
    let headerBytes: number[] | undefined;
    const chunkBytes: number[][] = [];
    let footerBytes: number[] | undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      const got = (headerBytes ? 1 : 0) + chunkBytes.length + (footerBytes ? 1 : 0);
      reject(
        new Error(
          `Timeout waiting for preset-dump stream after ${timeoutMs}ms ` +
            `(received ${got}/6 messages: header=${headerBytes ? 'yes' : 'no'}, ` +
            `chunks=${chunkBytes.length}/${CHUNKS_PER_PRESET}, ` +
            `footer=${footerBytes ? 'yes' : 'no'}).`,
        ),
      );
    }, timeoutMs);
    const fail = (err: Error): void => {
      clearTimeout(timer);
      unsubscribe();
      reject(err);
    };
    const unsubscribe = conn.onMessage((msg) => {
      if (msg.length === 0 || msg[0] !== SYSEX_START) return;
      // Only consider AM4-prefixed SysEx; anything else (USB receipt-echo
      // of unrelated traffic, foreign devices on the same MIDI bus) gets
      // dropped silently so the dump assembly stays robust.
      if (
        msg[1] !== FRACTAL_MFR[0] ||
        msg[2] !== FRACTAL_MFR[1] ||
        msg[3] !== FRACTAL_MFR[2] ||
        msg[4] !== AM4_MODEL_ID
      ) {
        return;
      }
      const fn = msg[5];
      if (fn !== FUNC_PRESET_HEADER && fn !== FUNC_PRESET_CHUNK && fn !== FUNC_PRESET_FOOTER) {
        return;
      }
      const bytes = [...msg];
      try {
        if (fn === FUNC_PRESET_HEADER) {
          if (headerBytes !== undefined) {
            throw new Error(
              'PRESET_DUMP_HEADER (0x77): unexpected second header before footer arrived',
            );
          }
          assertDumpMessageShape(bytes, FUNC_PRESET_HEADER, HEADER_LEN, 'PRESET_DUMP_HEADER (0x77)');
          headerBytes = bytes;
          return;
        }
        if (fn === FUNC_PRESET_CHUNK) {
          if (headerBytes === undefined) {
            throw new Error(
              'PRESET_DUMP_CHUNK (0x78): chunk arrived before 0x77 header',
            );
          }
          if (chunkBytes.length >= CHUNKS_PER_PRESET) {
            throw new Error(
              `PRESET_DUMP_CHUNK (0x78): too many chunks (already received ${CHUNKS_PER_PRESET})`,
            );
          }
          assertDumpMessageShape(
            bytes,
            FUNC_PRESET_CHUNK,
            CHUNK_LEN,
            `PRESET_DUMP_CHUNK ${chunkBytes.length + 1}/${CHUNKS_PER_PRESET} (0x78)`,
          );
          chunkBytes.push(bytes);
          return;
        }
        // 0x79 footer.
        if (headerBytes === undefined) {
          throw new Error(
            'PRESET_DUMP_FOOTER (0x79): footer arrived before 0x77 header',
          );
        }
        if (chunkBytes.length !== CHUNKS_PER_PRESET) {
          throw new Error(
            `PRESET_DUMP_FOOTER (0x79): footer arrived after ${chunkBytes.length} chunks ` +
              `(expected ${CHUNKS_PER_PRESET})`,
          );
        }
        assertDumpMessageShape(bytes, FUNC_PRESET_FOOTER, FOOTER_LEN, 'PRESET_DUMP_FOOTER (0x79)');
        footerBytes = bytes;
        // bank / sub from header payload (offsets 6..7 within the message).
        const bank = headerBytes[6];
        const sub = headerBytes[7];
        const totalBytes =
          headerBytes.length +
          chunkBytes.reduce((n, c) => n + c.length, 0) +
          footerBytes.length;
        clearTimeout(timer);
        unsubscribe();
        resolve({
          bank,
          sub,
          totalBytes,
          messageCount: 1 + chunkBytes.length + 1,
          headerBytes,
          chunkBytes,
          footerBytes,
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
