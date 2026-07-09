/**
 * Circuit Tracks SysEx framing (handoff §11). Header is constant:
 *   F0 00 20 29 01 64 <cmd> ...
 * Novation manufacturer ID 00 20 29; product 01 (Synth) 64 (Circuit Tracks).
 *
 * Pace consecutive SysEx ≥ 20 ms apart; replies always come back on USB.
 */

export const MANUFACTURER = [0x00, 0x20, 0x29] as const;
export const PRODUCT = [0x01, 0x64] as const;

export const CMD_REPLACE_CURRENT = 0x00; // write to a synth part's RAM (revertable)
export const CMD_REPLACE_FLASH = 0x01;   // write to a Flash slot 0..63 (destructive)
export const CMD_DUMP_REQUEST = 0x40;    // request the current patch dump

export const PATCH_BODY_LEN = 340;

/** Synth location byte: 0 = Synth 1, 1 = Synth 2. */
export type SynthLocation = 0 | 1;

const HEADER = [0xf0, ...MANUFACTURER, ...PRODUCT] as const;

/** `F0 00 20 29 01 64 40 <loc> F7`, Current Patch Dump Request (9 bytes). */
export function buildDumpRequest(loc: SynthLocation): number[] {
  return [...HEADER, CMD_DUMP_REQUEST, loc, 0xf7];
}

/**
 * `F0 00 20 29 01 64 00 <loc> 00 <340 body> F7`, Replace Current Patch
 * (RAM of a synth part; non-destructive, revertable). Total 350 bytes.
 */
export function buildReplaceCurrentPatch(body: readonly number[], loc: SynthLocation): number[] {
  assertBody(body);
  return [...HEADER, CMD_REPLACE_CURRENT, loc, 0x00, ...body, 0xf7];
}

/**
 * `F0 00 20 29 01 64 01 00 <slotHi> <slotLo> 00 <340 body> F7`, Replace Patch
 * (writes a Flash slot 0..63; DESTRUCTIVE, gated behind save authorization).
 *
 * The prefix is 5 bytes (`01 00 <slotHi> <slotLo> 00`), NOT the 3-byte
 * `01 <slot> 00` shape Replace-Current uses — CORRECTED 2026-07-03 from a real
 * Novation Components capture (`samples/captured/components-patch-save.pcapng`
 * + `components-patch-change.pcapng`), where four Replace-Patch messages to
 * slots 0/1/2/3 all carry the slot at body-offset 3 with a septet-split slot:
 * `01 00 00 0X 00 …`. The earlier 3-byte shape (slot at offset 1, total 350
 * bytes) was mis-derived from the OCR-garbled v3 guide and the device silently
 * dropped it — the total is 352 bytes, and the save now matches Components.
 */
export function buildReplaceFlashPatch(body: readonly number[], patchNum: number): number[] {
  assertBody(body);
  if (!Number.isInteger(patchNum) || patchNum < 0 || patchNum > 63) {
    throw new RangeError(`Flash patch number must be 0..63, got ${patchNum}.`);
  }
  return [...HEADER, CMD_REPLACE_FLASH, 0x00, (patchNum >> 7) & 0x7f, patchNum & 0x7f, 0x00, ...body, 0xf7];
}

function assertBody(body: readonly number[]): void {
  if (body.length !== PATCH_BODY_LEN) {
    throw new RangeError(`Patch body must be ${PATCH_BODY_LEN} bytes, got ${body.length}.`);
  }
}
