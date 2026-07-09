// Boss VE-500 device constants (from the editor's product_setting.js).

import type { RolandTarget } from '../shared/sysex.js';

/** VE-500 Roland model ID. */
export const VE500_MODEL_ID = [0x00, 0x00, 0x00, 0x55] as const;

/** Default unit device ID (configurable on the device; 0x10 is the factory default). */
export const VE500_DEVICE_ID = 0x10;

/** Default SysEx target for the VE-500. */
export const VE500_TARGET: RolandTarget = {
  modelId: VE500_MODEL_ID,
  deviceId: VE500_DEVICE_ID,
};

/** Build a target with a non-default device ID. */
export function ve500Target(deviceId: number): RolandTarget {
  return { modelId: VE500_MODEL_ID, deviceId };
}

// --- patch memory map (product_setting.js) ---

/** Active (temporary) patch base address — `set_param`/`get_param` target this. */
export const TEMP_PATCH_ADDR = 0x04000000;
/** First user patch (U01) base address. */
export const USER_PATCH_ADDR = 0x04040000;
/** Address stride between consecutive user patches. */
export const USER_PATCH_STRIDE = 0x00040000;

export const NUM_USER_PATCHES = 99; // U01..U99
export const NUM_PRESET_PATCHES = 50; // P01..P50

// Program Change mapping (product_setting.js minPatchOfUser..maxPatchOfPreset):
//   PC 0..98   -> user U01..U99
//   PC 99..148 -> preset P01..P50
export const PC_MIN_USER = 0;
export const PC_MAX_USER = 98;
export const PC_MIN_PRESET = 99;
export const PC_MAX_PRESET = 148;

/** Internal base address of user patch n (1-based: n=1 -> U01). */
export function userPatchAddr(n: number): number {
  return USER_PATCH_ADDR + USER_PATCH_STRIDE * (n - 1);
}
