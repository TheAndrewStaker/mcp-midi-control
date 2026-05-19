#!/usr/bin/env tsx
/**
 * Goldens for `INIT_PATCH_BUFFER` — the baked factory INIT patch from
 * ASM Hydrasynth Manager's `Single INIT Bank.hydra`.
 *
 * Scope: structural-integrity checks only. We assert the bytes the
 * device's spec declares as required (size, ETCD magic, name region,
 * 2390..2399 sentinel, save-marker), plus a few sanity properties
 * (non-empty volumes, non-zero filter cutoff) that show the buffer
 * isn't all-zeros.
 *
 * Deliberately NOT tested here: display values for bipolar params.
 * Our patchEncoder's interpretation of bipolar wire-center is suspect
 * (see task #10 — patch-buffer values appear to be NRPN_wire / 8 with
 * center=512, not center=4096). Until HW-040 test 1 verifies the
 * buffer plays audibly, asserting display interpretations risks locking
 * in the wrong interpretation.
 */
import { INIT_PATCH_BUFFER } from '@mcp-midi-control/hydrasynth/initPatchBuffer.js';
import {
  PATCH_BUFFER_SIZE,
  PATCH_META,
  PATCH_MAGIC_BYTES,
  PATCH_NAME,
  readPatchName,
  decodePatch,
  defaultPatchBuffer,
} from '@mcp-midi-control/hydrasynth/patchEncoder.js';

let pass = 0;
const fail: string[] = [];

function check(name: string, fn: () => true | string): void {
  try {
    const r = fn();
    if (r === true) {
      pass++;
    } else {
      fail.push(`${name} — ${r}`);
    }
  } catch (e) {
    fail.push(`${name} — threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Size & wire-format envelope (the 4-byte routing prefix synthesized by
// the bake script — `[0x06, 0x00, 0x00, 0x00]` = "Save to RAM, Bank A,
// Patch 1").
// ---------------------------------------------------------------------------

check('size = PATCH_BUFFER_SIZE', () => {
  return INIT_PATCH_BUFFER.length === PATCH_BUFFER_SIZE
    ? true
    : `got ${INIT_PATCH_BUFFER.length}, want ${PATCH_BUFFER_SIZE}`;
});

check('byte 0 = 0x06 (Save-to-RAM marker)', () => {
  return INIT_PATCH_BUFFER[PATCH_META.saveMarker] === 0x06 ? true : 'mismatch';
});

check('byte 1 = 0x00', () => {
  return INIT_PATCH_BUFFER[PATCH_META.reserved1] === 0x00 ? true : 'mismatch';
});

check('byte 2 = 0x00 (Bank A in synthesized routing header)', () => {
  return INIT_PATCH_BUFFER[PATCH_META.bank] === 0x00 ? true : 'mismatch';
});

check('byte 3 = 0x00 (Patch 1 in synthesized routing header)', () => {
  return INIT_PATCH_BUFFER[PATCH_META.patchNumber] === 0x00 ? true : 'mismatch';
});

// ---------------------------------------------------------------------------
// Spec-required magic bytes (ETCD at 1766..1769, alternating -100/-1 at
// 2390..2399 — without these the device rejects most subsequent writes).
// ---------------------------------------------------------------------------

check('bytes 1766..1769 = "ETCD" magic', () => {
  for (let i = 0; i < PATCH_MAGIC_BYTES.offsets.length; i++) {
    const offset = PATCH_MAGIC_BYTES.offsets[i];
    const expected = PATCH_MAGIC_BYTES.defaults[i];
    if (INIT_PATCH_BUFFER[offset] !== expected) {
      return `byte ${offset}: expected ${expected}, got ${INIT_PATCH_BUFFER[offset]}`;
    }
  }
  return true;
});

check('bytes 2390..2399 = -100,-1 sentinel pattern', () => {
  for (let i = 0; i < 10; i++) {
    const expected = i % 2 === 0 ? 0x9c : 0xff; // -100 / -1
    if (INIT_PATCH_BUFFER[2390 + i] !== expected) {
      return `byte ${2390 + i}: expected 0x${expected.toString(16)}, got 0x${INIT_PATCH_BUFFER[2390 + i].toString(16)}`;
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// Patch name decodes correctly — proves `readPatchName` and the file→wire
// 4-byte shift line up at the spec-documented offsets (9..24 in wire).
// ---------------------------------------------------------------------------

check('readPatchName decodes "Init"', () => {
  const name = readPatchName(INIT_PATCH_BUFFER);
  return name === 'Init' ? true : `got ${JSON.stringify(name)}`;
});

check('byte 9 (name start) = "I" (0x49)', () => {
  return INIT_PATCH_BUFFER[PATCH_NAME.startByte] === 0x49 ? true : 'mismatch';
});

// ---------------------------------------------------------------------------
// Sanity — buffer isn't an all-zeros placeholder. We check a handful of
// curated params for non-zero values that the factory INIT must set
// (cutoff, osc1 vol, env1 sustain, amp level — silencing any of these
// produces no sound regardless of envelope routing).
// ---------------------------------------------------------------------------

check('curated param decode contains non-zero key params', () => {
  const decoded = decodePatch(INIT_PATCH_BUFFER);
  const requiredNonZero: Array<[string, number]> = [
    ['filter1cutoff', decoded.get('filter1cutoff') ?? 0],
    ['mixerosc1vol', decoded.get('mixerosc1vol') ?? 0],
    ['env1sustain', decoded.get('env1sustain') ?? 0],
    ['amplevel', decoded.get('amplevel') ?? 0],
  ];
  for (const [name, value] of requiredNonZero) {
    if (value === 0) {
      return `${name} = 0 (factory INIT must set it non-zero or the device is silent)`;
    }
  }
  return true;
});

check('decodePatch returns full curated set (282 entries — Session 49 +env3-5 ×19 each + lfo2-5 ×16 each per HW-061 followup; prior counts: Session 47 +mutators1-4 ×6 fields, +delaytimesyncon collapsed slot, Session 48 +env2 ×14 +5 collapsed sync-on aliases, +lfo1 ×12 +2 collapsed sync-on aliases)', () => {
  const decoded = decodePatch(INIT_PATCH_BUFFER);
  return decoded.size === 282 ? true : `got ${decoded.size}, want 282`;
});

// ---------------------------------------------------------------------------
// Cloning — `defaultPatchBuffer()` must return a fresh Uint8Array, not
// a reference to the constant (otherwise mutations leak back).
// ---------------------------------------------------------------------------

check('defaultPatchBuffer returns a fresh clone (not a reference)', () => {
  const a = defaultPatchBuffer();
  const b = defaultPatchBuffer();
  if (a === b) return 'same reference (Uint8Array.from clones expected)';
  if (a === INIT_PATCH_BUFFER) return 'aliased to INIT_PATCH_BUFFER';
  // Mutate one, ensure the other doesn't change.
  a[0] = 0xff;
  return b[0] === 0x06 ? true : 'mutation leaked';
});

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------

if (fail.length > 0) {
  console.error(`${pass}/${pass + fail.length} pass; ${fail.length} fail:\n`);
  for (const line of fail) console.error(`  ✗ ${line}`);
  process.exit(1);
} else {
  console.log(`✓ ${pass}/${pass} INIT_PATCH_BUFFER cases pass.`);
}
