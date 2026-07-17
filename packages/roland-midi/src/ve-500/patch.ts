// VE-500 current-patch recall (user memories AND factory presets).
//
// Decoded from the VE-500 Editor's own patch-switch handlers, NOT from any
// Program Change / Bank Select scheme:
//
//   docs/_private/devices/ve-500/editor-extract/js/product/preset_patch.js:126
//     Parameter.setValue("Setup%SetupCommon%0", INTEGER2x4, 0, nextPatch); // Change current patch
//
//   (the SAME call recalls a USER memory from the '#user-preset-button'
//   handler in the same file, lines 106-142 -- `nextPatch` there is
//   `lastUserPatch` (0..98) or `lastPresetPatch` (99..148), the identical
//   0-based index product_setting.js documents for Program Change.)
//
// `Parameter.setValue` (js/common/parameter.js:59-73) resolves the pid string
// to a block + a DT1 write: `b = this.getblock('Setup%SetupCommon')` (block
// base = Setup root 0x00000000 + SetupCommon offset 0x00000000 = 0), then
// `MIDIController.dt1(b.addr + addr, ...)` with addr=0 (the trailing '0' in
// the pid string) -- i.e. a DT1 to ABSOLUTE internal address 0x00000000.
//
// The register itself is catalogued at address_map.js:488-490:
//   var SetupCommon = [
//     {"addr":"0x00000000","name":"Current Patch Number","size":INTEGER2x4,"ofs":0,"min":0,"max":148,"init":0}
//   ];
//   var Setup = [ { addr: 0x00000000, size: 3, child: SetupCommon, name: "SetupCommon" } ];
//   this.root = [ { addr: 0x00000000, size: 0, child: Setup, name: "Setup" }, ... ]  (address_map.js:570-576)
//
// So recalling ANY patch -- user (U01-U99, index 0..98) or factory preset
// (P01-P50, index 99..148, product_setting.js:30-34) -- is ONE DT1 write to
// this single "Current Patch Number" register, INTEGER2x4-packed (2 wire
// bytes, 4-bit nibbles, see roland-midi/shared/packValue.ts). This is the
// editor's OWN recall mechanism for BOTH banks; it is the only decoded path
// for factory presets (their Bank-Select scheme was never found because the
// editor doesn't use Bank Select/Program Change for recall at all).
//
// Community-beta / hardware-unverified: this specific SysEx write has not yet
// been pressed on the maintainer's unit (the user-memory Program Change path
// already in `writer.ts` IS hardware-confirmed and is left untouched; this
// builder is additive, used only for the previously-gated preset recall).

import { buildDT1, encodeWire, Size, type RolandTarget } from '../shared/index.js';
import { VE500_TARGET } from './model.js';

/** Absolute internal address of the "Current Patch Number" register (Setup > SetupCommon). */
export const CURRENT_PATCH_ADDR = 0x00000000;

/**
 * Build a DT1 that recalls patch `n` (0-based, the SAME index Program Change
 * uses: 0..98 = U01..U99, 99..148 = P01..P50). Decoded from the editor's
 * `Parameter.setValue("Setup%SetupCommon%0", INTEGER2x4, 0, n)` -- see the
 * file header for the full citation trail.
 */
export function buildSwitchPatch(
  n: number,
  target: RolandTarget = VE500_TARGET,
): number[] {
  const data = encodeWire(Size.INTEGER2x4, n, 0);
  return buildDT1(target, CURRENT_PATCH_ADDR, data);
}
