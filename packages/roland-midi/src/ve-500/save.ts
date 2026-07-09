// VE-500 store / command builders.
//
// The editor drives a separate COMMAND address space at 0x7F00xxxx (literal
// wire addresses, NOT 7-bit-spread). Decoded from the VE-500 Editor's
// `MIDIController.command.*` (midi.js): the active edit buffer is already live
// on the device (set_param writes there), so the STORE frame itself is just a
// command that names the destination user memory — no whole-patch DT1 dump
// precedes it (confirmed: `WriteDialogView.write()` in dialog-view.js sends
// nothing else before `MIDIController.command.write(patchNum)`).
//
// HARDWARE-REFUTED (2026-07-08): a BARE store command does not persist a
// MIDI-set value (loaded U99, set enhancer.enhance=77, saved to U99, switched
// away + back to force a flash reload, get_param read back 25 — the ORIGINAL
// value). Root cause, from the editor's own connect sequence
// (`js/product/midi.js` `MIDIController.manager.connect`): the editor ALWAYS
// sends `editorCommunicationModeOn()` (`dt1raw('7F000001','01')`) right after
// the identity handshake, before its UI allows ANY interaction — every
// `command.write()` the real editor ever issues therefore happens with this
// mode already on. The 0x7F0000xx "command" register space (where STORE
// lives) appears gated behind it, while ordinary patch-address DT1 writes
// (set_param/get_param, which round-tripped fine in the hardware test above)
// are not, that split matches the symptom exactly. FIX (HARDWARE-CONFIRMED
// 2026-07-08 on the maintainer's unit, a set + save + reload round-trip
// persisted): send Editor Communication Mode ON immediately before every
// STORE, in `writer.savePreset`.

import {
  buildDT1,
  buildDT1Raw,
  bytesToAddr,
  encodeWire,
  matchesDT1Addr,
  sevenBitize,
  type RolandTarget,
} from '../shared/index.js';
import { TEMP_PATCH_ADDR, VE500_TARGET } from './model.js';

// Command addresses — literal wire bytes (each <= 0x7F), sent verbatim.
const CMD_WRITE = [0x7f, 0x00, 0x01, 0x04]; // store edit buffer -> user memory
const CMD_COMM_MODE = [0x7f, 0x00, 0x00, 0x01]; // editor communication mode on/off

/** Packed-internal address matching the literal wire bytes `CMD_WRITE`, for reply matching. */
const CMD_WRITE_ADDR = bytesToAddr(CMD_WRITE);

/** PatchCommon name: 16 ASCII bytes at the start of the patch. */
const PATCH_NAME_REL_ADDR = 0x00000000;
const PATCH_NAME_LEN = 16;

/**
 * Build the STORE command: persist the active edit buffer to user memory
 * `userIndex` (0-based: U01 = 0 … U99 = 98). Decoded from the editor's
 * `command.write` → `dt1raw('7F000104', _7bitize(n) as 2 bytes)`. Must be
 * preceded by `buildCommMode(true)` — see the file header.
 */
export function buildSavePreset(
  userIndex: number,
  target: RolandTarget = VE500_TARGET,
): number[] {
  const w = sevenBitize(userIndex); // == userIndex for 0..98
  const data = [(w >>> 8) & 0xff, w & 0xff];
  return buildDT1Raw(target, CMD_WRITE, data);
}

/**
 * Predicate for `receiveSysExMatching`: does `msg` carry the device's echo of
 * a STORE command? Decoded from the editor's receive dispatch
 * (`js/product/midi.js`): `if (addr == '7F000104') { ...; MIDIController.
 * receive.writeCommand(data); }` — the VE-500 echoes a DT1 to this SAME
 * command address once it has processed a store (the editor uses this as its
 * own confirm-and-refresh signal). This is NOT the same guarantee as ordinary
 * patch-address DT1 writes (set_param), which are not echoed this way — only
 * the 0x7F0000xx command register space round-trips like this.
 */
export function saveAckMatcher(
  target: RolandTarget = VE500_TARGET,
): (msg: readonly number[]) => boolean {
  return (msg) => matchesDT1Addr(target, CMD_WRITE_ADDR, msg);
}

/** Build the editor communication-mode on/off command (`dt1raw('7F000001', 00/01)`). */
export function buildCommMode(
  on: boolean,
  target: RolandTarget = VE500_TARGET,
): number[] {
  return buildDT1Raw(target, CMD_COMM_MODE, [on ? 0x01 : 0x00]);
}

/** Build a DT1 that writes a 16-char patch name into the active edit buffer. */
export function buildSetPatchName(
  name: string,
  target: RolandTarget = VE500_TARGET,
): number[] {
  const data = encodeWire(PATCH_NAME_LEN, name, 0); // ASCII, space-padded to 16
  return buildDT1(target, TEMP_PATCH_ADDR + PATCH_NAME_REL_ADDR, data);
}
