/**
 * 340-byte synth-patch body codec (handoff §13).
 *
 * SCOPE (v1): a faithful CONTAINER + the patch NAME (bytes 0-15, ASCII,
 * space-padded). The body round-trips byte-exact, and the name decodes /
 * re-encodes without trimming. The full per-offset structured decode (osc /
 * filter / envelope / LFO / mod-matrix / macro regions) is documented in
 * the v3 guide §13 and is a follow-on leg, patch AUTHORING today goes
 * through the live CC/NRPN path (`apply_patch` → `codec/live.ts`), which
 * maps 1:1 to these params, so the structured blob writer isn't needed to
 * build a sound. The container is what backs dump round-trips, name
 * read/write, and .syx import/export.
 */

import { PATCH_BODY_LEN } from './sysex.js';

export const NAME_OFFSET = 0;
export const NAME_LEN = 16;
export const DEFAULT_PATCH_NAME = 'Initial Patch';

export interface DecodedPatch {
  name: string;
  /** The verbatim 340 body bytes (so a decode→encode round-trip is byte-exact). */
  raw: Uint8Array;
}

/** Decode the patch name from bytes 0-15 (space-padded; trailing spaces preserved on raw). */
export function decodePatchName(body: Uint8Array | readonly number[]): string {
  let s = '';
  for (let i = 0; i < NAME_LEN; i++) s += String.fromCharCode(body[NAME_OFFSET + i] & 0x7f);
  return s.replace(/\s+$/u, ''); // display form trims trailing pad; raw bytes are untouched
}

/** Write a name into bytes 0-15 of a body (space-padded, truncated to 16). */
export function encodePatchName(body: Uint8Array, name: string): void {
  for (let i = 0; i < NAME_LEN; i++) {
    const ch = i < name.length ? name.charCodeAt(i) & 0x7f : 0x20; // space pad
    body[NAME_OFFSET + i] = ch;
  }
}

export function decodePatch(body: Uint8Array | readonly number[]): DecodedPatch {
  const raw = Uint8Array.from(body);
  if (raw.length !== PATCH_BODY_LEN) {
    throw new RangeError(`Patch body must be ${PATCH_BODY_LEN} bytes, got ${raw.length}.`);
  }
  return { name: decodePatchName(raw), raw };
}

/** Re-encode a patch body, optionally overwriting the name. Byte-exact for raw round-trips. */
export function encodePatch(patch: DecodedPatch, name?: string): number[] {
  const out = Uint8Array.from(patch.raw);
  if (out.length !== PATCH_BODY_LEN) {
    throw new RangeError(`Patch body must be ${PATCH_BODY_LEN} bytes, got ${out.length}.`);
  }
  if (name !== undefined) encodePatchName(out, name);
  return Array.from(out);
}

/**
 * Synthetic INIT body: 340 zero bytes with the name "Initial Patch   ".
 * NOTE: this is a framing/name scaffold, NOT a byte-accurate copy of the
 * device's true factory init patch (whose non-name bytes carry real
 * defaults). It is sufficient for framing + name goldens and as a base for
 * `.syx` construction; a captured init dump replaces it when available.
 */
export function initPatchBody(): number[] {
  const body = new Uint8Array(PATCH_BODY_LEN); // all zero
  encodePatchName(body, DEFAULT_PATCH_NAME);
  return Array.from(body);
}
