/**
 * Axe-Fx II XL+ config for `createAxeFxIIDescriptor` (`../descriptor.ts`).
 *
 * The founder's own hardware; the hardware-verified anchor for the whole
 * gen-2 codec (see `packages/fractal-midi/src/gen2/axe-fx-ii/setParam.ts`
 * and `docs/devices/axe-fx-ii/SYSEX-MAP.md`). Every other Axe-Fx II family
 * config (AX8, and any future Mark I/II / XL config) reuses this same codec,
 * differing only by model byte + block roster + LLM-facing surface.
 */
import type { AxeFxIIConfig } from '../descriptor/config.js';
import { AXE_FX_II_XL_PLUS_MODEL_ID } from 'fractal-midi/gen2/axe-fx-ii';

export const AXE_FX_II_XL_PLUS_CONFIG: AxeFxIIConfig = {
  id: 'axe-fx-ii',
  displayName: 'Fractal Axe-Fx II XL+',
  modelByte: AXE_FX_II_XL_PLUS_MODEL_ID,
  connectionLabel: 'axe-fx-ii',
  portMatch: [{ pattern: /axe-?fx/i }],
  supportTier: 'verified',
  verification:
    'Model byte 0x07 hardware-verified on the founder\'s Quantum 8.02 XL+ unit. ' +
    'Every op in this descriptor (set_param, set_block, set_bypass, switch_preset, ' +
    'switch_scene, save_preset, apply_preset, get_preset, export_preset/import_preset) ' +
    'is hardware-confirmed; see docs/devices/axe-fx-ii/SYSEX-MAP.md for capture-cited decodes.',
  // No isBlockAvailable filter: every block in AXE_FX_II_BLOCKS is present
  // on the XL+ (the fullest member of the family).
  // writesGated omitted (false): every write ships un-gated, as before.
  // BK-084 mode-collapse: set_params' internal atomic image path — XL+
  // only. HARDWARE-CONFIRMED 2026-07-17 (founder bench, Q8.02, when this
  // was still reached via apply_preset mode:'retune'; the underlying
  // mechanism is unchanged by the mode-collapse): identity push + patched
  // atomic apply both "seamless like a preset switch" under continuous
  // playing (P0/P1); front-panel value landing incl. CPR + scene_3_main
  // (P2); state preservation (P3); STORE leg persisted at the contract
  // location, panel mapping pinned 1-based (P4 retest); 9-knob A/B vs the
  // streamed path both seamless (P5). The streamed fallback + NACK
  // recovery stay fake-conn-golden-covered (not drillable on demand);
  // enum-leg-inside-batch and the set_params entry point itself are not
  // yet exercised on hardware post-collapse.
  supportsAtomicParamImage: true,
};
