/**
 * Axe-Fx II family GET/SET_BLOCK_PARAMETER_VALUE message builders.
 *
 * Reference: Fractal Audio Wiki "MIDI_SysEx" page (cached at
 * `founder-private notes`), §"GET/SET_
 * BLOCK_PARAMETER_VALUE" + §"obtaining parameter values".
 *
 * Wire envelope (function ID `0x02`):
 *
 *   F0 00 01 74 [model] 02
 *     [effectId  bits 6-0] [effectId  bits 13-7]
 *     [paramId   bits 6-0] [paramId   bits 13-7]
 *     [value     bits 6-0] [value     bits 13-7] [value bits 14-15]
 *     [00=query, 01=set]
 *     [checksum] F7
 *
 * Value range: 0..65534 (16-bit). Packed across three 7-bit septets
 * because SysEx bytes can't have bit 7 set. The high 2 bits of the
 * 16-bit value land in the bottom 2 bits of the third septet (bits
 * 6..2 of that byte are zero).
 *
 * Status: 🟢 hardware-verified on Quantum 8.02 (2026-05-10). 
 * landed both halves of function 0x02 SET: normal paramId (Amp 1 Bass
 * 5.30 → 6.30, audibly warmer) and paramId=255 bypass (Reverb 1 tail
 * dropped, front-panel LED disengaged). Wiki spec matches Q8.02
 * firmware behavior — no drift detected.  covers the GET half
 * (function 0x02 query). Byte-exact goldens in
 * `scripts/verify-axe-fx-ii-encoding.ts` lock the encoder.
 */

import { fractalChecksum } from '../../shared/checksum.js';
import { encode14, packValue16, unpackValue16 } from '../../shared/septet16.js';
import { AXE_FX_II_LEGACY_OPCODES, AXE_FX_II_OPCODES } from './opcodes.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;

// Local FUNC_* aliases name the role this codec uses each wire byte
// for. They resolve to AxeEdit's mined SYSEX_* opcode table
// (`./opcodes.ts`) so the wire bytes here can't drift from the
// authoritative source. Two entries route through
// AXE_FX_II_LEGACY_OPCODES because AxeEdit's enum doesn't name
// them (BLOCK_CHANNEL = 0x11 sits between TEMPO and CABNAME;
// MULTIPURPOSE_RESPONSE = 0x64 is the device's response envelope
// for several write ops). See opcodes.ts for the rationale.
const FUNC_BLOCK_PARAM = AXE_FX_II_OPCODES.PARAM_SET;            // 0x02
const FUNC_BLOCK_PARAM_DIRECT = AXE_FX_II_OPCODES.SET_PARAM_DIRECT; // 0x2e
const FUNC_SET_GRID_CELL = AXE_FX_II_OPCODES.PLACE_EFFECT;       // 0x05
const FUNC_SET_CELL_ROUTING = AXE_FX_II_OPCODES.CONNECT_EFFECT;  // 0x06
const FUNC_SET_PRESET_NAME = AXE_FX_II_OPCODES.SET_NAME;         // 0x09
const FUNC_GET_PRESET_NAME = AXE_FX_II_OPCODES.QUERY_NAME;       // 0x0F
const FUNC_BLOCK_CHANNEL = AXE_FX_II_LEGACY_OPCODES.BLOCK_CHANNEL; // 0x11
const FUNC_GET_PRESET_NUMBER = AXE_FX_II_OPCODES.PATCHNUM;       // 0x14
const FUNC_PATCH_DUMP = AXE_FX_II_OPCODES.PATCH_DUMP;            // 0x03
const FUNC_GET_ALL_PARAMS = AXE_FX_II_OPCODES.GET_ALL_PARAMS;    // 0x1F
const FUNC_QUERY_STATES = AXE_FX_II_OPCODES.QUERY_STATES;        // 0x0E
const FUNC_STORE_PRESET = AXE_FX_II_OPCODES.SAVE_PATCH;          // 0x1D
const FUNC_GET_GRID_LAYOUT = AXE_FX_II_OPCODES.GET_GRID;         // 0x20
const FUNC_SCENE_NUMBER = AXE_FX_II_OPCODES.SET_SCENE;           // 0x29
const FUNC_SWITCH_PRESET = AXE_FX_II_LEGACY_OPCODES.SWITCH_PRESET; // 0x3C
const FUNC_MULTIPURPOSE_RESPONSE = AXE_FX_II_LEGACY_OPCODES.MULTIPURPOSE_RESPONSE; // 0x64
const FUNC_STATE_DUMP_HEADER = AXE_FX_II_OPCODES.EFFECT_START;   // 0x74
const FUNC_STATE_DUMP_CHUNK = AXE_FX_II_OPCODES.EFFECT_DATA;     // 0x75
const FUNC_STATE_DUMP_FOOTER = AXE_FX_II_OPCODES.EFFECT_END;     // 0x76

/**
 * Max items per 0x75 chunk observed in device captures. AxeEdit /
 * firmware splits the state value list into chunks of up to 64 items
 * each (each item = 3 wire bytes via `packValue16`). Capture corpus
 * shows full chunks of 64 followed by a final short chunk holding
 * the remainder; we mirror that shape for round-trip byte-exactness.
 */
const STATE_DUMP_CHUNK_MAX_ITEMS = 64;

const ACTION_QUERY = 0x00;
const ACTION_SET = 0x01;
/** Sentinel scene value used by SET_SCENE_NUMBER to read the current scene. */
const SCENE_QUERY = 0x7f;

/** Default model byte for the founder's hardware (Axe-Fx II XL+). */
export const AXE_FX_II_XL_PLUS_MODEL_ID = 0x07;

/** Wire model byte for each Axe-Fx II family variant. */
export const MODEL_IDS = Object.freeze({
    'axe-fx-ii': 0x03,        // Mark I / Mark II
    'axe-fx-ii-xl': 0x06,
    'axe-fx-ii-xl-plus': 0x07,
    'ax8': 0x08,
});

export interface AxeFxIIParamId {
    /** 14-bit block instance ID (e.g. 106 = Amp 1, 107 = Amp 2). */
    effectId: number;
    /** 14-bit parameter index within the block (e.g. 1 = Input Drive). */
    paramId: number;
}

/**
 * `packValue16` / `unpackValue16` are re-exported from
 * `fractal-midi/shared` (`shared/septet16.ts`) — one canonical
 * implementation shared byte-identically with the gen-3 codec.
 *
 * Value-range note (II wiki): valid input range is 0..65534. The shared
 * packer accepts up to 65535 (the full 16-bit range) so callers can pass
 * through without an extra clamp; firmware reportedly clamps
 * 65535 → 65534 internally.
 */
export { packValue16, unpackValue16 };

/**
 * Pack a float32 display value into 5 septets for fn=0x2e SET_PARAM_DIRECT.
 * Treats the float32 LE bytes as a 32-bit integer and splits into 7-bit
 * groups from LSB. This is the same scheme as `packValue16` extended to
 * 32 bits, NOT the AM4's `packFloat32LE` (which uses byte-by-byte septeting).
 * Byte-verified against AxeEdit II capture (2026-05-24).
 * Same float32→5-septet math as gen-3's `encode5SeptetFloat32`
 * (`gen3/axe-fx-iii/setParam.ts`); kept local because the gen-2 codec
 * does not otherwise depend on the gen-3 module.
 */
function packFloat32ForDirect(value: number): [number, number, number, number, number] {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    const bytes = new Uint8Array(buf);
    const n = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0);
    return [
        n & 0x7f,
        (n >>> 7) & 0x7f,
        (n >>> 14) & 0x7f,
        (n >>> 21) & 0x7f,
        (n >>> 28) & 0x0f,
    ];
}

/**
 * `displayToWire` / `wireToDisplay` / `DisplayScale` /
 * `DisplayToWireOptions` moved verbatim to `fractal-midi/shared`
 * (`shared/displayScale.ts`) and re-exported here for compatibility —
 * the resolver was calibrated and hardware-verified on this codec
 * (HW-079 goldens in `scripts/verify-axe-fx-ii-encoding.ts`) and is
 * also used by the gen-3 catalog.
 */
export { displayToWire, wireToDisplay } from '../../shared/displayScale.js';
export type { DisplayScale, DisplayToWireOptions } from '../../shared/displayScale.js';

function buildEnvelope(
    modelId: number,
    body: readonly number[],
): number[] {
    const head = [SYSEX_START, ...FRACTAL_MFR, modelId, ...body];
    return [...head, fractalChecksum(head), SYSEX_END];
}

export interface BuildOptions {
    /** Target hardware variant. Defaults to XL+ (the founder's device). */
    modelId?: number;
}

/**
 * Build a SET_PARAM_DIRECT message (function `0x2e`, action 1).
 *
 * Uses fn=0x2e (the same opcode AxeEdit uses) with a **float32
 * display value** packed into 5 septets. fn=0x2e writes to whichever
 * channel fn=0x11 BLOCK_CHANNEL last selected; fn=0x02 ignores the
 * channel state and always writes to the default channel.
 *
 * `value` is the **display-unit float** (e.g. 5.55 for input_drive on
 * a 0..10 knob, 440 for delay time in ms). The device handles the
 * display-to-internal conversion. Captured and confirmed byte-exact
 * against AxeEdit II X-to-Y channel-switch traffic (2026-05-24).
 */
export function buildSetBlockParameterValue(
    param: AxeFxIIParamId,
    value: number,
    opts: BuildOptions = {},
): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_BLOCK_PARAM_DIRECT,
        ...encode14(param.effectId),
        ...encode14(param.paramId),
        ...packFloat32ForDirect(value),
    ]);
}

/**
 * Build a SET via fn=0x02 (PARAM_SET) with an integer wire value.
 *
 * Use for enum/select params whose firmware rejects fn=0x2e float
 * writes (hardware-confirmed on compressor.effect_type, 2026-05-26:
 * fn=0x2e no-ops on all channel contexts, fn=0x02 lands correctly).
 * fn=0x02 IS channel-aware for writes (respects fn=0x11 state),
 * despite older wiki documentation claiming otherwise. Confirmed
 * 2026-05-26: compressor X=PEDAL COMP 1, Y=PEDAL COMP 2, independent.
 *
 * Continuous/knob params should still use `buildSetBlockParameterValue`
 * (fn=0x2e) for float display-value writes.
 */
export function buildSetBlockParameterValueInteger(
    param: AxeFxIIParamId,
    wireValue: number,
    opts: BuildOptions = {},
): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_BLOCK_PARAM,
        ...encode14(param.effectId),
        ...encode14(param.paramId),
        ...packValue16(wireValue),
        ACTION_SET,
    ]);
}

/**
 * Build a GET_BLOCK_PARAMETER_VALUE request (function `0x02`, action 0).
 *
 * Per wiki: "When you are getting a parameter value you still have to
 * include a parameter value with your message but this value can be 0."
 * We send three zero septets for the value field.
 */
export function buildGetBlockParameterValue(
    param: AxeFxIIParamId,
    opts: BuildOptions = {},
): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_BLOCK_PARAM,
        ...encode14(param.effectId),
        ...encode14(param.paramId),
        0x00, 0x00, 0x00,
        ACTION_QUERY,
    ]);
}

/**
 * Build a block-bypass toggle via fn=0x02 (PARAM_SET).
 *
 * Per wiki: "Bypassing/Engaging a Block is also done with this function
 * with parameter 255. Send the value 0 to Engage, 1 to Bypass."
 *
 * Uses fn=0x02 deliberately: bypass (paramId=255) is block-global
 * (reads the same on X and Y, hardware-confirmed 2026-05-26). fn=0x2e
 * (SET_PARAM_DIRECT) caused per-scene bypass to silently fail when
 * the executor's param-write phase left a non-default channel active.
 * fn=0x02 with integer wire value 0/1 reliably lands bypass state.
 * Hardware-verified on fn=0x02 (2026-05-10, Q8.02; reconfirmed
 * 2026-05-26 with channel-Y context).
 */
export function buildSetBlockBypass(
    effectId: number,
    bypassed: boolean,
    opts: BuildOptions = {},
): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_BLOCK_PARAM,
        ...encode14(effectId),
        ...encode14(255),
        ...packValue16(bypassed ? 1 : 0),
        ACTION_SET,
    ]);
}

/**
 * Predicate: does `bytes` look like the response to our GET_BLOCK_PARAMETER_VALUE
 * request for `(effectId, paramId)`? The device echoes the same
 * envelope+function+effectId+paramId, then includes the actual wire
 * value, then 5 unknown bytes, then a null-terminated label string.
 *
 * Per wiki §"GET/SET_BLOCK_PARAMETER_VALUE", response payload is:
 *   [eff7-0][eff13-7][param7-0][param13-7][val7-0][val13-7][val15-14]
 *   [unk1][unk2][unk3][unk4][unk5][label-bytes...][0x00][checksum] F7
 *
 * Distinguishing GET response from a SET echo: the GET response always
 * carries a label string (>= 1 character + null terminator), so total
 * length is well above the SET request's 14 bytes. We use the length
 * cutoff as the discriminator.
 */
export function isGetBlockParameterResponse(
    bytes: number[],
    target: AxeFxIIParamId,
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): boolean {
    if (bytes.length < 17) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[4] !== expectedModelId) return false;
    if (bytes[5] !== FUNC_BLOCK_PARAM) return false;
    const eff = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
    const param = (bytes[8] & 0x7f) | ((bytes[9] & 0x7f) << 7);
    return eff === target.effectId && param === target.paramId;
}

export interface GetBlockParameterResponse {
    /** 16-bit unsigned wire value the device reports as currently held. */
    value: number;
    /** Display label the device shows for this value (e.g. "5.00", "Plexi 50W Hi"). */
    label: string;
}

/**
 * Parse a GET_BLOCK_PARAMETER_VALUE response. Caller must have already
 * matched it via `isGetBlockParameterResponse` for the right target —
 * this just decodes the value + label string from a known-shape buffer.
 */
export function parseGetBlockParameterResponse(bytes: number[]): GetBlockParameterResponse {
    // bytes[10..12] = value 3 septets; bytes[13..17] = 5 unknown bytes;
    // bytes[18..N-2] = label string + null; bytes[N-2] = checksum; bytes[N-1] = 0xF7
    if (bytes.length < 17) {
        throw new Error(`GET_BLOCK_PARAMETER response too short: ${bytes.length} bytes`);
    }
    const value = unpackValue16(bytes[10], bytes[11], bytes[12]);
    // Find the null terminator starting at byte 18 (after 5 unknown bytes).
    let nullIdx = -1;
    for (let i = 18; i < bytes.length - 2; i++) {
        if (bytes[i] === 0x00) { nullIdx = i; break; }
    }
    const labelBytes = nullIdx > 18 ? bytes.slice(18, nullIdx) : [];
    const label = String.fromCharCode(...labelBytes);
    return { value, label };
}

/**
 * Build a GET_PRESET_NAME request (function 0x0F). Empty body —
 * envelope + function + checksum + F7.
 */
export function buildGetPresetName(opts: BuildOptions = {}): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_GET_PRESET_NAME]);
}

export function isGetPresetNameResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): boolean {
    if (bytes.length < 9) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[4] !== expectedModelId) return false;
    if (bytes[5] !== FUNC_GET_PRESET_NAME) return false;
    return true;
}

/**
 * Parse a GET_PRESET_NAME response. Body is null-terminated ASCII
 * starting at byte 6. `expectedModelId` must match the frame's model
 * byte (defaults to the XL+ for back-compat; pass the config's model
 * byte for other family members, e.g. AX8 `0x08`).
 */
export function parseGetPresetNameResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): string {
    if (!isGetPresetNameResponse(bytes, expectedModelId)) {
        throw new Error('Bytes do not match GET_PRESET_NAME response shape');
    }
    let nullIdx = -1;
    for (let i = 6; i < bytes.length - 2; i++) {
        if (bytes[i] === 0x00) { nullIdx = i; break; }
    }
    const labelBytes = nullIdx > 6 ? bytes.slice(6, nullIdx) : [];
    return String.fromCharCode(...labelBytes).trim();
}

/**
 * Build a GET_GRID_LAYOUT_AND_ROUTING request (function 0x20). Empty
 * body. Response carries 48× 4-byte grid cells (4 rows × 12 columns).
 */
export function buildGetGridLayout(opts: BuildOptions = {}): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_GET_GRID_LAYOUT]);
}

/**
 * Build a SYSEX_GET_ALL_PARAMS request (function 0x1F). 2-byte payload
 * = `[blockId_lo, blockId_hi]` (14-bit septet-packed effect ID).
 *
 * The device responds with the existing 0x74/0x75/0x76 state-broadcast
 * envelope — same shape as a knob-turn broadcast. Parse the response
 * with `parseStateBroadcast()` ( / 2026-05-11 decode) or any
 * downstream consumer of the 0x74 triple.
 *
 * Hardware-verified 2026-05-20 on Q8.02 XL+:
 * `probe-axefx2-fn1f-sweep.ts` walked the 12 placed blocks of a test
 * preset; every placed block returned a triple with 38-236 16-bit
 * values (item count per block matches the block-type's catalog param
 * count). Shunts return a zero-item triple. Unplaced block IDs were
 * not tested individually but the empty-payload form was rejected
 * (fn 0x64 result_code 06), so callers must pass a valid blockId.
 *
 * Wire: `F0 00 01 74 [model] 1F [eff_lo] [eff_hi] [cs] F7`
 *
 * Status: 🟢 hardware-verified (Q8.02).
 */
export function buildGetAllParams(
    effectId: number,
    opts: BuildOptions = {},
): number[] {
    if (!Number.isInteger(effectId) || effectId < 0 || effectId > 0x3fff) {
        throw new Error(`buildGetAllParams: effectId out of range (0..16383): ${effectId}`);
    }
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_GET_ALL_PARAMS, ...encode14(effectId)]);
}

/**
 * One record from a fn 0x0E QUERY_STATES response. The response is the
 * editor's single-round-trip whole-preset block-state inventory (AxeEdit's
 * "Read from Axe-Fx" sync issues exactly one fn 0x0E + one fn 0x20 GET_GRID).
 *
 * STRUCTURE is byte-exact proven (2 captures, byte-exact round-trip):
 * - response carries NO trailing checksum (payload is bytes[6 .. len-2]);
 * - payload tiles into fixed 5-byte records;
 * - record count equals the number of placed blocks on the active grid;
 * - response is payload-insensitive (empty request and a block-selector
 *   request return the same frame shape).
 *
 * SEMANTICS (hardware-verified on Q8.02, see primitive ii-fn0e-query-states):
 * byte0 is the per-block LIVE state in the active scene — bit 0x01 = engaged
 * (1) vs bypassed (0), bit 0x02 = channel (set = X, clear = Y). Bytes 1..4
 * (`state28`) are a per-block address monotonic in blockId; sorting records
 * by `state28` and zipping to the grid's placed effectIds (ascending) binds
 * each record to its block. Use `mapQueryStatesToBlocks` for that mapping.
 */
export interface QueryStateRecord {
    /** Leading tag byte: bit 0x01 = engaged, bit 0x02 = channel (set=X, clear=Y). */
    tag: number;
    /** Bytes 1..4 of the record, verbatim. */
    stateSeptets: [number, number, number, number];
    /** Bytes 1..4 packed LSB-septet-first into a 28-bit word: a per-block address, monotonic in blockId. */
    state28: number;
}

/** Per-block live state decoded from a fn 0x0E record + the grid's placed blocks. */
export interface AxeFxIIBlockState {
    /** 14-bit effectId / blockId (per blockTypes.ts) this record maps to. */
    effectId: number;
    /** Engaged (true) vs bypassed (false) in the active scene. */
    engaged: boolean;
    /** Active channel in the active scene. */
    channel: AxeFxIIChannel;
}

export function buildQueryStates(opts: BuildOptions = {}): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    // Empty payload; the response is payload-insensitive.
    return buildEnvelope(modelId, [FUNC_QUERY_STATES]);
}

export function isQueryStatesResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): boolean {
    if (bytes.length < 8) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[4] !== expectedModelId) return false;
    return bytes[5] === FUNC_QUERY_STATES;
}

/**
 * Parse a fn 0x0E QUERY_STATES response into opaque 5-byte records. The
 * response carries NO trailing checksum, so the payload is everything
 * between the 6-byte header and the final F7. Throws if the payload is
 * not a whole number of 5-byte records.
 */
export function parseQueryStatesResponse(bytes: number[]): QueryStateRecord[] {
    if (!isQueryStatesResponse(bytes)) {
        throw new Error('parseQueryStatesResponse: not a fn 0x0E QUERY_STATES response');
    }
    const payload = bytes.slice(6, bytes.length - 1); // drop 6-byte header + trailing F7; no checksum byte
    if (payload.length % 5 !== 0) {
        throw new Error(`parseQueryStatesResponse: payload length ${payload.length} is not a multiple of 5`);
    }
    const out: QueryStateRecord[] = [];
    for (let i = 0; i + 5 <= payload.length; i += 5) {
        const b0 = payload[i];
        const b1 = payload[i + 1];
        const b2 = payload[i + 2];
        const b3 = payload[i + 3];
        const b4 = payload[i + 4];
        const state28 = (b1 & 0x7f) | ((b2 & 0x7f) << 7) | ((b3 & 0x7f) << 14) | ((b4 & 0x7f) << 21);
        out.push({ tag: b0, stateSeptets: [b1, b2, b3, b4], state28 });
    }
    return out;
}

/**
 * Map fn 0x0E QUERY_STATES records to per-block live state, using the
 * placed effectIds from a fn 0x20 GET_GRID read.
 *
 * Records arrive in a preset-specific delivery order (not grid, not
 * blockId, not address order), but each record's `state28` (bytes 1..4)
 * is a per-block address monotonic in blockId. Sorting records by
 * `state28` and zipping to the placed effectIds sorted ascending binds
 * each record to its block. Hardware-verified 11/11 against independent
 * fn 0x02 bypass + fn 0x11 channel reads (see primitive
 * ii-fn0e-query-states). The tag byte then yields the active-scene state.
 *
 * Throws if the counts differ (the caller must pass exactly the placed,
 * non-shunt blocks the same QUERY_STATES read covers).
 */
export function mapQueryStatesToBlocks(
    records: QueryStateRecord[],
    placedEffectIds: number[],
): AxeFxIIBlockState[] {
    if (records.length !== placedEffectIds.length) {
        throw new Error(
            `mapQueryStatesToBlocks: ${records.length} records but ${placedEffectIds.length} placed blocks; cannot zip`,
        );
    }
    const recsByAddr = [...records].sort((a, b) => a.state28 - b.state28);
    const idsAsc = [...placedEffectIds].sort((a, b) => a - b);
    return recsByAddr.map((r, i) => ({
        effectId: idsAsc[i],
        engaged: (r.tag & 0x01) === 0x01,
        channel: (r.tag & 0x02) === 0x02 ? 'X' : 'Y',
    }));
}

export function isGetGridLayoutResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): boolean {
    if (bytes.length < 8 + 48 * 4) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[4] !== expectedModelId) return false;
    if (bytes[5] !== FUNC_GET_GRID_LAYOUT) return false;
    return true;
}

/**
 * One cell in the 4×12 routing grid. `blockId` is the 14-bit ID per
 * `blockTypes.ts` — block IDs 100..170, shunt IDs 200..235, or 0 for
 * an empty cell. `routingFlags` is a 4-bit mask: bit N set means
 * "connect row (N+1) of the previous column to this cell's input".
 */
export interface GridCell {
    /** Column 1..12. */
    col: number;
    /** Row 1..4. */
    row: number;
    /** 14-bit block ID (100-170 = block, 200-235 = shunt, 0 = empty). */
    blockId: number;
    /** Routing-input mask. Bit N (0..3) set ⇒ row N+1 of previous column connects to this input. */
    routingFlags: number;
}

/**
 * Parse a GET_GRID_LAYOUT_AND_ROUTING response into 48 grid cells.
 *
 * Per wiki §"GET_GRID_LAYOUT_AND_ROUTING": cell order is column-major,
 * top-to-bottom within each column. Cell 0 = (col=1, row=1); cell 1 =
 * (col=1, row=2); ...; cell 4 = (col=2, row=1); etc.
 *
 * Per cell (4 bytes):
 *   bytes[0]: blockId bits 6-0
 *   bytes[1]: blockId bits 13-7
 *   bytes[2]: routing flags
 *   bytes[3]: unused (per wiki)
 */
export function parseGetGridLayoutResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): GridCell[] {
    if (!isGetGridLayoutResponse(bytes, expectedModelId)) {
        throw new Error('Bytes do not match GET_GRID_LAYOUT response shape');
    }
    const cells: GridCell[] = [];
    let i = 6; // start after envelope + function byte
    for (let cellIdx = 0; cellIdx < 48; cellIdx++) {
        const col = Math.floor(cellIdx / 4) + 1;
        const row = (cellIdx % 4) + 1;
        const blockId = (bytes[i] & 0x7f) | ((bytes[i + 1] & 0x7f) << 7);
        const routingFlags = bytes[i + 2] & 0x0f;
        cells.push({ col, row, blockId, routingFlags });
        i += 4;
    }
    return cells;
}

/**
 * Build a SET_SCENE_NUMBER message (function 0x29). Pass scene 0..7
 * to switch; pass undefined to query the current scene (sentinel 0x7F
 * per wiki — response carries the actual scene number).
 */
export function buildSetSceneNumber(scene: number, opts: BuildOptions = {}): number[] {
    if (!Number.isInteger(scene) || scene < 0 || scene > 7) {
        throw new Error(`Scene out of range: ${scene} (valid 0..7)`);
    }
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_SCENE_NUMBER, scene]);
}

export function buildGetSceneNumber(opts: BuildOptions = {}): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_SCENE_NUMBER, SCENE_QUERY]);
}

export function isSceneNumberResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): boolean {
    if (bytes.length < 9) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[4] !== expectedModelId) return false;
    if (bytes[5] !== FUNC_SCENE_NUMBER) return false;
    return true;
}

export function parseSceneNumberResponse(
    bytes: number[],
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): number {
    if (!isSceneNumberResponse(bytes, expectedModelId)) {
        throw new Error('Bytes do not match SCENE_NUMBER response shape');
    }
    return bytes[6] & 0x7f;
}

/**
 * Block channel select (function 0x11) — Axe-Fx II has TWO channels
 * per block (X and Y), distinct from AM4's four-channel A/B/C/D model.
 *
 * Wiki documents the envelope:
 *
 *   Request (host → device):
 *     F0 00 01 74 [model] 11 [eff_lo] [eff_hi] [chan] [action] [cs] F7
 *       chan   = 0 (X) or 1 (Y)
 *       action = 0 (get current value) or 1 (set)
 *
 *   Response/broadcast (device → host):
 *     F0 00 01 74 [model] 11 [eff_lo] [eff_hi] [chan] [cs] F7
 *
 * The device emits the response form whenever the active channel for a
 * block changes (e.g. user clicks X/Y in AxeEdit or front-panel) —
 * cross-confirmed via passive capture in
 * `samples/captured/session-60-channel-toggle.syx` (2026-05-11):
 * Amp 1 toggle X→Y produced `F0 00 01 74 07 11 6A 00 01 78 F7`;
 * Y→X produced `F0 00 01 74 07 11 6A 00 00 79 F7`. Checksums verified.
 *
 * Status: 🟢 hardware-verified on Q8.02 (2026-05-11). Amp 1
 * X→Y SET round-tripped cleanly: pre-read = X, set wrote Y (12 bytes
 * out), post-read = Y, front panel + AxeEdit both confirmed Y. The
 * 0=X / 1=Y mapping holds; wire envelope is byte-exact with wiki spec
 * and the broadcast capture.
 */
export type AxeFxIIChannel = 'X' | 'Y';

export function channelToWire(c: AxeFxIIChannel | 0 | 1): number {
    if (c === 'X' || c === 0) return 0;
    if (c === 'Y' || c === 1) return 1;
    throw new Error(`channelToWire: expected 'X' / 'Y' / 0 / 1, got ${c}`);
}

export function wireToChannel(b: number): AxeFxIIChannel {
    if (b === 0) return 'X';
    if (b === 1) return 'Y';
    throw new Error(`wireToChannel: expected 0 or 1, got ${b}`);
}

export function buildSetBlockChannel(
    effectId: number,
    channel: AxeFxIIChannel | 0 | 1,
    opts: BuildOptions = {},
): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_BLOCK_CHANNEL,
        ...encode14(effectId),
        channelToWire(channel),
        0x01, // action = set
    ]);
}

export function buildGetBlockChannel(
    effectId: number,
    opts: BuildOptions = {},
): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_BLOCK_CHANNEL,
        ...encode14(effectId),
        0x00, // chan field — ignored on get
        0x00, // action = get
    ]);
}

export function isGetBlockChannelResponse(
    bytes: number[],
    expectedEffectId: number,
    expectedModelId: number = AXE_FX_II_XL_PLUS_MODEL_ID,
): boolean {
    // Response is 11 bytes: F0 00 01 74 [model] 11 [eff_lo] [eff_hi] [chan] [cs] F7
    if (bytes.length !== 11) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0] || bytes[2] !== FRACTAL_MFR[1] || bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[4] !== expectedModelId) return false;
    if (bytes[5] !== FUNC_BLOCK_CHANNEL) return false;
    const effId = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
    return effId === expectedEffectId;
}

export function parseGetBlockChannelResponse(bytes: number[]): AxeFxIIChannel {
    if (bytes.length !== 11) {
        throw new Error(`Expected 11-byte BLOCK_CHANNEL response, got ${bytes.length}`);
    }
    return wireToChannel(bytes[8]);
}

/**
 * Switch preset (function 0x3C) — load preset N into the working buffer.
 * Wiki documents the envelope as `F0 00 01 74 [model] 3C [pn_lo]
 * [pn_hi] [cs] F7` where `pn_lo`/`pn_hi` is a 14-bit septet pair
 * encoding the preset number.
 *
 * Axe-Fx II preset numbering: 0-based linear index 0..N across the
 * bank (each bank holds 128 presets typically; XL+ has bigger
 * capacity). 0x14 GET_PRESET_NUMBER returns the same number space.
 *
 * Status: 🟢 hardware-verified on Q8.02 (2026-05-11).
 * `preset_number: 0` loaded "59 Bassguy" into the working buffer
 * cleanly; front panel showed slot "1" (the MIDI 0-based index maps
 * to the device's 1-based front-panel display — preset N appears as
 * slot N+1 on the front panel).
 */
export function buildSwitchPreset(
    presetNumber: number,
    opts: BuildOptions = {},
): number[] {
    if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
        throw new Error(`buildSwitchPreset: preset number out of range (0..16383): ${presetNumber}`);
    }
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    // **MSB-first** byte ordering — matches `buildStorePreset` (0x1D) and
    // the device's own `GET_PRESET_NUMBER` (0x14) response, both of
    // which were hardware-verified on Q8.02 (session-61).
    //
    // The wiki documents this envelope as LSB-first, but
    // hardware testing on Q8.02 showed that LSB-first encoding silently
    // fails for any preset ≥ 128 — the device receives the bytes,
    // doesn't ACK or NACK, and stays on the previously-active slot
    // (founder slot-705 test 2026-05-12; agent's "RockOfAges" build
    // appeared at slot 683 instead of slot 702 because the per-entry
    // switch never landed and the writes hit whatever working buffer
    // was active). For preset < 128 both orderings produce identical
    // bytes, which is why the test on wire 0 didn't catch this.
    //
    // Closes the bug: verify buildSwitchPreset byte ordering for preset ≥ 128.
    const presetHigh = (presetNumber >> 7) & 0x7f;
    const presetLow = presetNumber & 0x7f;
    return buildEnvelope(modelId, [
        FUNC_SWITCH_PRESET,
        presetHigh,
        presetLow,
    ]);
}

/**
 * Request a PATCH_DUMP (function 0x03) of a STORED preset slot. The
 * device answers with the 66-frame 0x77/0x78/0x79 envelope chain of
 * that slot's FLASH contents.
 *
 * Status: hardware-verified on Q8.02 (2026-06-10), with two findings:
 *   - The response is the STORED preset, never the working buffer.
 *   - SIDE EFFECT: the request RELOADS the stored preset into the
 *     working buffer, discarding unsaved edits (buffer rename sent via
 *     fn 0x09 was lost the moment this request was answered). Callers
 *     that must preserve unsaved buffer state should use
 *     `buildEditBufferDumpRequest` instead.
 *
 * MSB-first 14-bit preset number, same ordering as buildSwitchPreset
 * (LSB-first silently fails for preset >= 128).
 */
export function buildPatchDumpRequest(
    presetNumber: number,
    opts: BuildOptions = {},
): number[] {
    if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
        throw new Error(`buildPatchDumpRequest: preset number out of range (0..16383): ${presetNumber}`);
    }
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_PATCH_DUMP,
        (presetNumber >> 7) & 0x7f,
        presetNumber & 0x7f,
    ]);
}

/**
 * Request an EDIT-BUFFER dump: function 0x03 with the `0x7F 0x7F`
 * sentinel payload (the same convention the AM4 uses).
 *
 * Status: hardware-confirmed on Q8.02 (2026-06-10), three-way:
 *   - TRACKING: two sentinel dumps taken across a live buffer rename
 *     differ exactly where expected, proving the dump reads the
 *     WORKING BUFFER, not a stored slot.
 *   - NO SIDE EFFECT: unlike the slot-addressed request, the sentinel
 *     does NOT reload anything into the buffer (rename survived).
 *   - ROUND-TRIP: pushing the 66-frame response back to the device
 *     restored the dumped buffer state byte-for-byte (name re-read OK).
 * Captures: samples/captured/hw132/ (sentinel-eb-{alpha,bravo}.syx).
 */
export function buildEditBufferDumpRequest(opts: BuildOptions = {}): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_PATCH_DUMP, 0x7f, 0x7f]);
}

/**
 * Set working-buffer preset name (function 0x09). Wiki documents the
 * envelope as the function byte followed by ASCII characters. Preset
 * names on Axe-Fx II are 32 chars, space-padded.
 *
 * Status: 🟢 hardware-verified on Q8.02 (2026-05-11).
 * `" Test"` written to the working buffer; immediate
 * `axefx2_get_preset_name` echoed it back; front panel showed the
 * new name. Working-buffer scope confirmed — switching presets
 * discards it (no persistent change to factory slot).
 */
export function buildSetPresetName(name: string, opts: BuildOptions = {}): number[] {
    if (name.length > 32) {
        throw new Error(`buildSetPresetName: name too long (max 32 chars): "${name}" (${name.length})`);
    }
    // Validate ASCII-printable per project convention. Allow space + printable 0x20..0x7E.
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        if (c < 0x20 || c > 0x7e) {
            throw new Error(`buildSetPresetName: non-ASCII-printable char at position ${i}: 0x${c.toString(16)}`);
        }
    }
    // Right-pad with spaces to 32 chars (Axe-Fx II convention; matches
    // GET_PRESET_NAME response shape).
    const padded = name.padEnd(32, ' ');
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_SET_PRESET_NAME,
        ...Array.from(padded, (c) => c.charCodeAt(0)),
    ]);
}

/**
 * STORE the working buffer to a user preset slot (function 0x1D).
 *
 * Wire envelope:
 *
 *   F0 00 01 74 [model] 1D [preset_high] [preset_low] [cs] F7
 *     preset_high = (n >> 7) & 0x7F
 *     preset_low  = n & 0x7F
 *
 * Note: this function uses **MSB-first** byte ordering for the 14-bit
 * preset number, unlike `buildSwitchPreset` / `buildEnvelope(..., [0x02,
 * ...effectId, ...paramId, ...])` which use LSB-first via `encode14()`.
 * The MSB-first ordering for 0x1D is taken from a community axe-fx-midi
 * library (Rust) and matches the byte order the device uses for its own
 * 0x14 GET_PRESET_NUMBER response (captured payload `05 3B`
 * for preset 699 = display preset 700).
 *
 * Status: 🟢 hardware-verified on Q8.02 XL+ (2026-05-11).
 * End-to-end round-trip from our encoder landed on the first attempt:
 * `axefx2_save_preset({ preset_number: 699, name: "..." })` produced
 * the captured save sequence, device returned `0x64 1D 00` (OK),
 * working buffer persisted to slot 700 confirmed by founder front-
 * panel inspection. Wire format derived from a community axe-fx-midi
 * library plus a passive capture (AxeEdit File, Save Preset); our
 * encoder matches AxeEdit's behavior byte-for-byte.
 *
 * Cross-checks before shipping:
 * - The community axe-fx-midi library's test case (Mark II, preset 217):
 *   `[F0 00 01 74 03 1D 01 59 43 F7]`, locked as a golden in
 *   `scripts/verify-axe-fx-ii-encoding.ts`.
 * - XL+ encoding for preset 699:
 *   `[F0 00 01 74 07 1D 05 3B 21 F7]`, also locked, paired with the
 *   captured device-side 0x64 ACK pattern.
 *
 * 0-vs-1 indexing: same as `buildSwitchPreset`, wire is 0-based, the
 * device's front panel displays 1-based. To save to what the user sees
 * as "preset 700," pass `presetNumber: 699`. The tool layer surfaces
 * this in `axefx2_save_preset`'s description so the agent translates.
 */
export function buildStorePreset(
    presetNumber: number,
    opts: BuildOptions = {},
): number[] {
    if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
        throw new Error(`buildStorePreset: preset number out of range (0..16383): ${presetNumber}`);
    }
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    const high = (presetNumber >> 7) & 0x7f;
    const low = presetNumber & 0x7f;
    return buildEnvelope(modelId, [FUNC_STORE_PRESET, high, low]);
}

/**
 * Match a MULTIPURPOSE_RESPONSE (function 0x64) acknowledging a
 * STORE_PRESET (function 0x1D) request. The device's response format
 * is `[echoed_fn, result_code]`:
 *
 *   F0 00 01 74 [model] 64 1D [result_code] [cs] F7
 *     result_code 0x00 = OK
 *     result_code 0x05 = parsed but not honored (e.g. malformed payload)
 *
 * Captured session-61, 2026-05-11 from AxeEdit's save-to-slot operation
 * on Q8.02 XL+: `F0 00 01 74 07 64 1D 00 7B F7` (result=OK).
 */
export function isStorePresetResponse(bytes: readonly number[]): boolean {
    if (bytes.length < 10) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0]) return false;
    if (bytes[2] !== FRACTAL_MFR[1]) return false;
    if (bytes[3] !== FRACTAL_MFR[2]) return false;
    // bytes[4] = model byte — accept any (we may encounter the same response
    // shape across II / XL / XL+ / AX8 if cross-revision support lands later).
    if (bytes[5] !== FUNC_MULTIPURPOSE_RESPONSE) return false;
    if (bytes[6] !== FUNC_STORE_PRESET) return false;
    return bytes[bytes.length - 1] === SYSEX_END;
}

export interface StorePresetResult {
    /** Raw device result code (0x00 = OK). */
    resultCode: number;
    /** True iff resultCode === 0x00. */
    ok: boolean;
}

export function parseStorePresetResponse(bytes: readonly number[]): StorePresetResult {
    if (!isStorePresetResponse(bytes)) {
        throw new Error(
            `parseStorePresetResponse: not a STORE_PRESET MULTIPURPOSE_RESPONSE: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
        );
    }
    const resultCode = bytes[7];
    return { resultCode, ok: resultCode === 0x00 };
}

/**
 * GET the device's currently-active preset number (function 0x14).
 *
 * Wire envelope (request):  F0 00 01 74 [model] 14 [cs] F7   (no payload)
 * Wire envelope (response): F0 00 01 74 [model] 14 [hi] [lo] [cs] F7
 *
 * **Byte ordering is MSB-first** in the response — `[bits 13-7, bits 6-0]`
 * — contrary to the wiki's "bits 6-0 first" documentation. Empirically
 * disambiguated by session-61 passive capture: payload `05 3B` decodes
 * to wire preset 699 (= front-panel display "slot 700") only under
 * MSB-first, matching the founder's reported state at capture time.
 * LSB-first decode would yield preset 7557, which is impossible (XL+
 * user range is 0..767). See `docs/SYSEX-MAP-AXE-FX-II.md` § 6b.
 *
 * Status: 🟡 wire format from session-61 passive capture; will flip to
 * 🟢 once axefx2_get_active_preset_number lands end-to-end on Q8.02.
 */
export function buildGetPresetNumber(opts: BuildOptions = {}): number[] {
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [FUNC_GET_PRESET_NUMBER]);
}

export function isGetPresetNumberResponse(bytes: readonly number[]): boolean {
    if (bytes.length < 10) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0]) return false;
    if (bytes[2] !== FRACTAL_MFR[1]) return false;
    if (bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[5] !== FUNC_GET_PRESET_NUMBER) return false;
    if (bytes[bytes.length - 1] !== SYSEX_END) return false;
    // Distinguish from a bare request echo: a response must carry the
    // two-byte preset-number payload (total length = 6 header + 2 payload
    // + 1 cs + 1 end = 10 bytes).
    return bytes.length === 10;
}

export interface GetPresetNumberResult {
    /** 0-based wire preset number (0..16383). */
    presetNumber: number;
    /** 1-based front-panel display slot (presetNumber + 1). */
    displaySlot: number;
}

export function parseGetPresetNumberResponse(bytes: readonly number[]): GetPresetNumberResult {
    if (!isGetPresetNumberResponse(bytes)) {
        throw new Error(
            `parseGetPresetNumberResponse: not a GET_PRESET_NUMBER response: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
        );
    }
    const high = bytes[6] & 0x7f;
    const low = bytes[7] & 0x7f;
    const presetNumber = (high << 7) | low;
    return { presetNumber, displaySlot: presetNumber + 1 };
}

/**
 * Set the block at a grid cell (function 0x05). Places a block at the
 * specified cell, or clears the cell (blockId = 0). If the block was
 * already on the grid elsewhere, the device MOVES it (clears its
 * previous cell as a side effect).
 *
 * Wire envelope:
 *
 *   F0 00 01 74 [model] 05
 *     [blockId_lo] [blockId_hi]
 *     [cell_idx]
 *     [reserved=0]
 *     [cs] F7
 *
 *   cell_idx = (col_idx × 4) + row_idx
 *              col_idx ∈ 0..11 (column 1..12 minus 1)
 *              row_idx ∈ 0..3  (row 1..4 minus 1)
 *              col-major, top-to-bottom — same ordering as the 0x20
 *              GET_GRID_LAYOUT_AND_ROUTING response.
 *
 *   blockId  = 14-bit, LSB-first septet pair.
 *              0 = empty cell (clears whatever was there)
 *              100..170 = named blocks (see blockTypes.ts)
 *              200..235 = shunts (pass-through cells)
 *
 *   reserved = the device accepts 0x00; non-zero behavior is unknown.
 *              May be a routing-flag mask in some firmwares; on Q8.02 XL+
 *              we observed no effect on routing when set. The device
 *              auto-assigns a routing mask to newly-placed cells (e.g.
 *              :2 for row-2 placements) regardless of this byte.
 *
 * Decoding evidence (session-62 + session-63 probes, 2026-05-11):
 *
 *   Probe (payload bytes after 0x05)         Observed effect
 *   ─────────────────────────────────────────────────────────
 *   64 00 00 00  → CPR1 at cell 0 (R1C1)     ✓ matches
 *   00 00 02 00  → empty at cell 2 (R3C1)    ✓ matches (was already empty)
 *   00 00 01 02  → empty at cell 1 (R2C1)    ✓ matches (CPR1 cleared)
 *   64 00 01 00  → CPR1 at cell 1 (R2C1)     ✓ matches (CPR1 returned)
 *
 *   Cell index 1 disambiguates col-major vs row-major: under col-major
 *   it points to (col 0, row 1) = R2C1, which IS where the change
 *   landed. Under row-major it would point to (row 0, col 1) = R1C2,
 *   which is empty and would show no change. Col-major confirmed.
 *
 *   Probes with bare (no payload) and 1-byte payload were rejected by
 *   the device with non-OK result codes (0x06 / 0x0C) — the 4-byte
 *   payload is the minimum the device accepts.
 *
 * KNOWN LIMITATION: this write does NOT propagate routing/cabling.
 * Moving a block out of a cell leaves the downstream block's input
 * mask pointing at empty space (audio dead-end). The agent / user is
 * responsible for re-wiring via a separate mechanism (TBD — likely
 * either byte[3] of this function with the right value, or a sibling
 * function byte like 0x06 which also fires during grid-move captures).
 *
 * Status: 🟢 wire format hardware-validated on Q8.02 XL+
 * (session-63 probe sequence). Routing-propagation limitation
 * documented above.
 */
export function buildSetGridCell(opts: {
    row: number;
    col: number;
    blockId: number;
    modelId?: number;
}): number[] {
    const { row, col, blockId } = opts;
    if (!Number.isInteger(row) || row < 1 || row > 4) {
        throw new Error(`buildSetGridCell: row out of range (1..4): ${row}`);
    }
    if (!Number.isInteger(col) || col < 1 || col > 12) {
        throw new Error(`buildSetGridCell: col out of range (1..12): ${col}`);
    }
    if (!Number.isInteger(blockId) || blockId < 0 || blockId > 0x3fff) {
        throw new Error(`buildSetGridCell: blockId out of range (0..16383): ${blockId}`);
    }
    const cellIdx = (col - 1) * 4 + (row - 1);
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_SET_GRID_CELL,
        blockId & 0x7f,        // blockId LSB septet
        (blockId >> 7) & 0x7f, // blockId MSB septet
        cellIdx & 0x7f,        // cell index 0..47
        0x00,                  // reserved / routing-flag-mask (unused on Q8.02)
    ]);
}

/**
 * Match a MULTIPURPOSE_RESPONSE (function 0x64) acknowledging a
 * SET_GRID_CELL (function 0x05) request.
 *
 *   F0 00 01 74 [model] 64 05 [result_code] [cs] F7
 *
 * Result codes observed on Q8.02 XL+ during decode:
 *   0x00 — OK, write applied
 *   0x06 — payload too short (e.g. bare envelope)
 *   0x0C — payload too short (e.g. 1-byte payload)
 *
 * Other values are unknown; treat any non-0x00 as a rejection.
 */
export function isSetGridCellResponse(bytes: readonly number[]): boolean {
    if (bytes.length < 10) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0]) return false;
    if (bytes[2] !== FRACTAL_MFR[1]) return false;
    if (bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[5] !== FUNC_MULTIPURPOSE_RESPONSE) return false;
    if (bytes[6] !== FUNC_SET_GRID_CELL) return false;
    return bytes[bytes.length - 1] === SYSEX_END;
}

export interface SetGridCellResult {
    resultCode: number;
    ok: boolean;
}

export function parseSetGridCellResponse(bytes: readonly number[]): SetGridCellResult {
    if (!isSetGridCellResponse(bytes)) {
        throw new Error(
            `parseSetGridCellResponse: not a SET_GRID_CELL MULTIPURPOSE_RESPONSE: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
        );
    }
    const resultCode = bytes[7];
    return { resultCode, ok: resultCode === 0x00 };
}

/**
 * Build a SET_CELL_ROUTING message (function 0x06) — add or remove a
 * cable between two adjacent-column grid cells. Companion to
 * `buildSetGridCell` (function 0x05): 0x05 places the block, 0x06 wires
 * its inputs.
 *
 * Wire envelope:
 *
 *   F0 00 01 74 [model] 06
 *     [src_cell_idx]    ← col-major linear index (col-1)*4 + (row-1)
 *     [dst_cell_idx]    ← col-major linear index; MUST be src_col + 1
 *     [connect]         ← 0x01 = add cable, 0x00 = remove cable
 *     [cs] F7
 *
 * Effect: the device updates `dst_cell.routing_mask` by setting
 * (connect=1) or clearing (connect=0) the bit at index `src_row_0indexed`.
 * The mask byte uses 4-bit input-mask encoding — bit N set means "feed
 * from row N+1 of previous column" (see `parseGetGridLayoutResponse`).
 * So a cable from row 2 → row 2 with src_col=2, dst_col=3 toggles
 * `dst_cell.routing_mask`'s bit 1 (= 0x02) on or off.
 *
 * Status: 🟢 hardware-decoded on Q8.02 XL+ (2026-05-13).
 * Captured AxeEdit's outbound fn 0x06 from a click-to-connect on
 * Amp(R2C2) → Cab(R2C3):
 *
 *   F0 00 01 74 07 06 05 09 01 09 F7
 *     src_cell = 5  = (2-1)*4 + (2-1) = R2C2
 *     dst_cell = 9  = (3-1)*4 + (2-1) = R2C3
 *     connect  = 1  = add cable
 *
 * Replayed by our own probe with byte-exact match — device acked
 * 0x00 OK and the grid-state read confirmed Cab's routing mask
 * flipped 0x00 → 0x02 ("Cab now feeds from row 2 of col 2 = from Amp").
 *
 * Validates adjacency (`dstCol === srcCol + 1`); the device rejects
 * non-adjacent cables. Cross-row cables (e.g. row 1 of col 5 → row 3
 * of col 6) ARE allowed — that's how parallel paths are wired.
 */
export function buildSetCellRouting(opts: {
    srcRow: number;
    srcCol: number;
    dstRow: number;
    dstCol: number;
    connect?: boolean;
    modelId?: number;
}): number[] {
    const { srcRow, srcCol, dstRow, dstCol, connect = true } = opts;
    if (!Number.isInteger(srcRow) || srcRow < 1 || srcRow > 4) {
        throw new Error(`buildSetCellRouting: srcRow out of range (1..4): ${srcRow}`);
    }
    if (!Number.isInteger(srcCol) || srcCol < 1 || srcCol > 11) {
        throw new Error(`buildSetCellRouting: srcCol out of range (1..11): ${srcCol}`);
    }
    if (!Number.isInteger(dstRow) || dstRow < 1 || dstRow > 4) {
        throw new Error(`buildSetCellRouting: dstRow out of range (1..4): ${dstRow}`);
    }
    if (!Number.isInteger(dstCol) || dstCol < 2 || dstCol > 12) {
        throw new Error(`buildSetCellRouting: dstCol out of range (2..12): ${dstCol}`);
    }
    if (dstCol !== srcCol + 1) {
        throw new Error(
            `buildSetCellRouting: dstCol (${dstCol}) must equal srcCol + 1 (got src=${srcCol}, dst=${dstCol}). ` +
            `Cables connect adjacent columns only — the device rejects off-column cables.`,
        );
    }
    const srcCellIdx = (srcCol - 1) * 4 + (srcRow - 1);
    const dstCellIdx = (dstCol - 1) * 4 + (dstRow - 1);
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;
    return buildEnvelope(modelId, [
        FUNC_SET_CELL_ROUTING,
        srcCellIdx & 0x7f,
        dstCellIdx & 0x7f,
        connect ? 0x01 : 0x00,
    ]);
}

/**
 * Match a MULTIPURPOSE_RESPONSE (function 0x64) acknowledging a
 * SET_CELL_ROUTING (function 0x06) request.
 *
 *   F0 00 01 74 [model] 64 06 [result_code] [cs] F7
 *
 * Result codes observed on Q8.02 XL+ during decode:
 *   0x00 — OK, routing updated
 *   0x01 — request rejected (e.g. non-adjacent columns, malformed shape)
 *   0x0C — payload length too short
 */
export function isSetCellRoutingResponse(bytes: readonly number[]): boolean {
    if (bytes.length < 10) return false;
    if (bytes[0] !== SYSEX_START) return false;
    if (bytes[1] !== FRACTAL_MFR[0]) return false;
    if (bytes[2] !== FRACTAL_MFR[1]) return false;
    if (bytes[3] !== FRACTAL_MFR[2]) return false;
    if (bytes[5] !== FUNC_MULTIPURPOSE_RESPONSE) return false;
    if (bytes[6] !== FUNC_SET_CELL_ROUTING) return false;
    return bytes[bytes.length - 1] === SYSEX_END;
}

export interface SetCellRoutingResult {
    resultCode: number;
    ok: boolean;
}

export function parseSetCellRoutingResponse(bytes: readonly number[]): SetCellRoutingResult {
    if (!isSetCellRoutingResponse(bytes)) {
        throw new Error(
            `parseSetCellRoutingResponse: not a SET_CELL_ROUTING MULTIPURPOSE_RESPONSE: ${bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
        );
    }
    const resultCode = bytes[7];
    return { resultCode, ok: resultCode === 0x00 };
}

/**
 * Axe-Fx II preset-state-dump triple builder (functions 0x74/0x75/0x76).
 *
 * Wire format decoded , 2026-05-11 from passive captures
 * (`docs/axefx2-state-broadcast-decode-research.md`). The device
 * broadcasts this triple every time AxeEdit makes a block-level
 * edit — header announces target block + total item count, then 1+
 * chunks of 16-bit values (3 septets each), then a one-byte footer.
 *
 * Layout per message:
 *
 *   HEADER (function 0x74, 13 bytes)
 *     F0 00 01 74 [model] 74
 *       [target_id 14b septet] [item_count 14b septet] [op_flag]
 *       [cs] F7
 *
 *   CHUNK  (function 0x75, variable, 8 + 3·N bytes)
 *     F0 00 01 74 [model] 75
 *       [chunk_item_count 14b septet]
 *       [N × packValue16]
 *       [cs] F7
 *
 *   FOOTER (function 0x76, 8 bytes — checksum-only terminator)
 *     F0 00 01 74 [model] 76 [cs] F7
 *
 * `target_id` matches `BLOCK_BY_ID` (e.g. 106 = Amp 1, 112 = Delay 1,
 * 127 = Volume/Pan 1). `op_flag` observed values: 0x01 for direct-
 * block edits (knob turn, grid move), 0x00 for preset-structure
 * changes (block add). Value positions correspond to `paramId 0..N`
 * of the target block's group in linear order (position-as-paramId
 * model confirmed  across AMP 1 + Delay 1 captures).
 *
 * Returns a flat byte array — caller can transmit it as a single
 * MIDI stream (the device receives the 3 messages in order). Use
 * `buildStateBroadcastTripleMessages` if you need them as separate
 * arrays.
 *
 * Status: 🟢 hardware-verified bidirectional (XL+ Q8.02, 2026-05-25).
 * All 21 block types accept writes when values match per-position
 * native encoding. NOT channel-aware (writes to monolithic block
 * state regardless of fn=0x11 channel selection). Full value array
 * required (itemCount must match block's total position count).
 * Encoding is per-position: some positions use wire16 (0..65534),
 * others use display-integer scale. See primitive entry
 * `ii-state-broadcast-triple-write` and `HW-125-FINDINGS-2026-05-25.md`.
 */
export interface BuildStateBroadcastOptions extends BuildOptions {
    /** Op flag byte 10. 0x01 = direct block edit, 0x00 = preset-structure. Default 0x01. */
    opFlag?: number;
}

export function buildStateBroadcastTripleMessages(
    targetId: number,
    values: readonly number[],
    opts: BuildStateBroadcastOptions = {},
): { header: number[]; chunks: number[][]; footer: number[] } {
    if (!Number.isInteger(targetId) || targetId < 0 || targetId > 0x3fff) {
        throw new Error(`State-broadcast targetId out of range: ${targetId}`);
    }
    const opFlag = opts.opFlag ?? 0x01;
    if (!Number.isInteger(opFlag) || opFlag < 0 || opFlag > 0x7f) {
        throw new Error(`State-broadcast opFlag out of range: ${opFlag}`);
    }
    const modelId = opts.modelId ?? AXE_FX_II_XL_PLUS_MODEL_ID;

    const header = buildEnvelope(modelId, [
        FUNC_STATE_DUMP_HEADER,
        ...encode14(targetId),
        ...encode14(values.length),
        opFlag,
    ]);

    const chunks: number[][] = [];
    for (let start = 0; start < values.length; start += STATE_DUMP_CHUNK_MAX_ITEMS) {
        const slice = values.slice(start, start + STATE_DUMP_CHUNK_MAX_ITEMS);
        const body: number[] = [FUNC_STATE_DUMP_CHUNK, ...encode14(slice.length)];
        for (const v of slice) {
            const [b0, b1, b2] = packValue16(v);
            body.push(b0, b1, b2);
        }
        chunks.push(buildEnvelope(modelId, body));
    }
    // Empty value list still emits a single zero-item chunk so the
    // header + chunk + footer triple shape stays consistent.
    if (chunks.length === 0) {
        chunks.push(buildEnvelope(modelId, [FUNC_STATE_DUMP_CHUNK, ...encode14(0)]));
    }

    const footer = buildEnvelope(modelId, [FUNC_STATE_DUMP_FOOTER]);

    return { header, chunks, footer };
}

export function buildStateBroadcastTriple(
    targetId: number,
    values: readonly number[],
    opts: BuildStateBroadcastOptions = {},
): number[] {
    const { header, chunks, footer } = buildStateBroadcastTripleMessages(targetId, values, opts);
    return [...header, ...chunks.flat(), ...footer];
}
