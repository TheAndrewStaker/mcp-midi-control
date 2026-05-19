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
    buildGetPresetName,
    buildReadParam,
    isReadResponse,
    parseGetPresetNameResponse,
    parseReadResponse,
} from 'fractal-midi/am4';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

export const READ_RESPONSE_TIMEOUT_MS = 300;

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
