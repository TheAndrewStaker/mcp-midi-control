/**
 * Working-buffer read helpers shared by every read tool, plus the
 * post-write verification path used by `am4_apply_setlist` and the
 * `am4_restore_factory*` family.
 *
 * Wire shapes decoded HW-044 (general param read, 2026-05-01) and HW-070
 * (READ_PRESET_NAME, Session 50, 2026-05-07). See SYSEX-MAP.md §6a +
 * §6m and `docs/devices/am4/preset-read-research.md`.
 */

import {
    buildGetAllParams,
    buildGetPresetName,
    buildReadParam,
    isReadResponse,
    parseGetPresetNameResponse,
    parseReadResponse,
} from 'fractal-midi/am4';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

export const READ_RESPONSE_TIMEOUT_MS = 300;
export const FN1F_TRIPLE_TIMEOUT_MS = 500;

export async function sendReadAndParse(
    conn: MidiConnection,
    pidLow: number,
    pidHigh: number,
): Promise<ReturnType<typeof parseReadResponse>> {
    const bytes = buildReadParam({ pidLow, pidHigh });
    const respPromise = conn.receiveSysExMatching(
        (resp) => isReadResponse(bytes, resp),
        READ_RESPONSE_TIMEOUT_MS,
    );
    conn.send(bytes);
    const resp = await respPromise;
    return parseReadResponse(resp);
}

// HW-070 (Session 50, 2026-05-07): READ_PRESET_NAME — non-destructive
// stored-preset name reads. Wire shape decoded byte-exact from the
// AM4-Edit launch capture; see SYSEX-MAP §6m and `docs/devices/am4/preset-read-research.md`.
const READ_PRESET_NAME_RESPONSE_TOTAL_BYTES = 55;
const READ_PRESET_NAME_RESPONSE_HDR4_LO = 0x20;
const READ_PRESET_NAME_RESPONSE_HDR4_HI = 0x00;

/**
 * Predicate for `receiveSysExMatching` that accepts the AM4's response to
 * a READ_PRESET_NAME (action 0x0012) request. Length and addressing fields
 * echo the outgoing request; hdr4 = 0x0020 (32 raw payload bytes).
 */
export function isPresetNameReadResponse(req: number[], resp: number[]): boolean {
    if (resp.length !== READ_PRESET_NAME_RESPONSE_TOTAL_BYTES) return false;
    if (resp[0] !== 0xf0 || resp[resp.length - 1] !== 0xf7) return false;
    // Envelope + function byte (bytes 0..5) must match the outgoing request.
    for (let i = 0; i < 6; i++) if (resp[i] !== req[i]) return false;
    // pidLow (6..7), pidHigh (8..9), action (10..11) echo the request.
    for (let i = 6; i < 12; i++) if (resp[i] !== req[i]) return false;
    // hdr3 zero, hdr4 = 0x0020 (32-byte payload).
    if (resp[12] !== 0x00 || resp[13] !== 0x00) return false;
    if (resp[14] !== READ_PRESET_NAME_RESPONSE_HDR4_LO) return false;
    if (resp[15] !== READ_PRESET_NAME_RESPONSE_HDR4_HI) return false;
    return true;
}

/**
 * Send a READ_PRESET_NAME request for one location and parse the response.
 * Used by both `am4_get_preset_name` and `am4_scan_locations`. Throws on
 * timeout, validation failure, or any wire-level mismatch.
 */
export async function readPresetName(
    conn: MidiConnection,
    locationIndex: number,
): Promise<ReturnType<typeof parseGetPresetNameResponse>> {
    const bytes = buildGetPresetName(locationIndex);
    const respPromise = conn.receiveSysExMatching(
        (resp) => isPresetNameReadResponse(bytes, resp),
        READ_RESPONSE_TIMEOUT_MS,
    );
    conn.send(bytes);
    const resp = await respPromise;
    return parseGetPresetNameResponse(resp, locationIndex);
}

// ── HW-AM4-FN1F: per-block atomic read via fn 0x1F ──────────────────
//
// `readAllParams` issues a single GET_ALL_PARAMS request and reassembles
// the device's 0x74 / 0x75 / 0x76 state-broadcast triple into an
// `AtomicReadResult` carrying the announced effectId, itemCount, and the
// decoded 16-bit ushort sequence.
//
// Wire shape (HW-AM4-FN1F probe, 2026-05-22 — same envelope as Axe-Fx II
// fn 0x1F but with model byte 0x15 and a 2-byte septet effectId payload
// instead of II's no-payload request). See cookbook
// `am4-fn1f-atomic-read` and `docs/devices/am4/SYSEX-MAP.md` §6oa.
//
//   Header (fn 0x74):
//     F0 00 01 74 15 74 [eid_lo eid_hi] [size_lo size_hi] [cs] F7
//     - targetId  = decode14(eid_lo, eid_hi)   → outgoing effectId
//                                                  echoed
//     - itemCount = decode14(size_lo, size_hi) → 16-bit ushorts in
//                                                  the chunk
//   Chunk (fn 0x75):
//     F0 00 01 74 15 75 [n_lo n_hi] [N × 3 packed septets] [cs] F7
//     - each value = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14)
//   Footer (fn 0x76):
//     F0 00 01 74 15 76 [cs] F7 — empty; marks end of triple.
//
// NACK contract: effectId 0 (and empty / wide-zero payloads) return a
// `fn 0x64` multipurpose-response with result_code 0x06. The helper
// surfaces these as a thrown Error naming the result_code so callers
// can distinguish "wire transport ok, just not a placed block" from
// timeout.
//
// **Chunk-position-to-paramId mapping is NOT YET DECODED.** Callers
// should treat the returned `values` array as opaque until the mapping
// ships. This helper exposes the wire primitive only.

function decode14(lo: number, hi: number): number {
    return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function decode16Packed(b0: number, b1: number, b2: number): number {
    return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

function isAm4Fn(bytes: number[], fn: number): boolean {
    return (
        bytes.length >= 7
        && bytes[0] === 0xf0
        && bytes[1] === 0x00
        && bytes[2] === 0x01
        && bytes[3] === 0x74
        && bytes[4] === 0x15
        && bytes[5] === fn
    );
}

function decodeChunkPayload(bytes: number[]): number[] {
    // bytes[6..7] = septet itemCount; bytes[8..] = N × 3 packed septets.
    const itemCount = decode14(bytes[6], bytes[7]);
    const out: number[] = [];
    const start = 8;
    const end = bytes.length - 2; // exclude checksum + F7
    for (let i = 0; i < itemCount; i++) {
        const off = start + i * 3;
        if (off + 2 >= end) break;
        out.push(decode16Packed(bytes[off], bytes[off + 1], bytes[off + 2]));
    }
    return out;
}

export interface AtomicReadResult {
    /** effectId echoed in the 0x74 header. Matches the request's effectId. */
    targetId: number;
    /** itemCount announced in the 0x74 header (number of 16-bit ushorts). */
    itemCount: number;
    /** Decoded 16-bit ushort sequence from the 0x75 chunk(s). */
    values: number[];
}

/**
 * Send a GET_ALL_PARAMS request for one effectId and assemble the
 * state-broadcast triple. Subscribes BEFORE sending so the device's
 * burst (header + chunk + footer typically lands in a single USB
 * callback frame) can't outrace the listener.
 *
 * Throws on:
 *   - 0x64 NACK with the result_code embedded in the error message
 *     (effectId 0 always NACKs)
 *   - timeout (no header arrived within FN1F_TRIPLE_TIMEOUT_MS)
 */
export async function readAllParams(
    conn: MidiConnection,
    effectId: number,
): Promise<AtomicReadResult> {
    const request = buildGetAllParams(effectId);
    let header: { targetId: number; itemCount: number } | undefined;
    const values: number[] = [];
    let nackResultCode: number | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const donePromise = new Promise<void>((res, rej) => {
        resolveDone = res;
        rejectDone = rej;
    });
    const unsubscribe = conn.onMessage((bytes) => {
        if (isAm4Fn(bytes, 0x64) && bytes.length >= 8 && bytes[6] === 0x1f) {
            // Multipurpose NACK echoing fn 0x1F — invalid effectId.
            nackResultCode = bytes[7];
            resolveDone();
            return;
        }
        if (isAm4Fn(bytes, 0x74)) {
            const tId = decode14(bytes[6], bytes[7]);
            if (tId !== effectId) return; // unrelated broadcast
            if (header !== undefined) return; // duplicate — ignore
            header = {
                targetId: tId,
                itemCount: decode14(bytes[8], bytes[9]),
            };
        } else if (isAm4Fn(bytes, 0x75)) {
            if (header === undefined) return; // chunk before header — drop
            for (const v of decodeChunkPayload(bytes)) values.push(v);
        } else if (isAm4Fn(bytes, 0x76)) {
            if (header === undefined) return; // footer before header — drop
            resolveDone();
        }
    });
    const timer = setTimeout(() => {
        if (header !== undefined) resolveDone();
        else rejectDone(new Error(
            `readAllParams(effectId=${effectId}): no fn 0x74 header arrived within ${FN1F_TRIPLE_TIMEOUT_MS}ms`,
        ));
    }, FN1F_TRIPLE_TIMEOUT_MS);
    try {
        conn.send(request);
        await donePromise;
    } finally {
        clearTimeout(timer);
        unsubscribe();
    }
    if (nackResultCode !== undefined) {
        throw new Error(
            `readAllParams(effectId=${effectId}): device responded with multipurpose NACK ` +
            `(fn=0x64) echoing fn 0x1F with result_code 0x${nackResultCode.toString(16).padStart(2, '0')}. ` +
            `effectId 0 is always invalid; other low effectIds may not correspond to placed blocks on this preset.`,
        );
    }
    if (header === undefined) {
        throw new Error(`readAllParams(effectId=${effectId}): no header (timed out)`);
    }
    return {
        targetId: header.targetId,
        itemCount: header.itemCount,
        values,
    };
}
