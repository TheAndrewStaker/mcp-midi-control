/**
 * Fractal Axe-Fx II XL+ device — STUB IMPLEMENTATION.
 *
 * v0.1.0 ships AM4 only. This file exists to (a) prove the
 * `FractalDevice` interface has the right shape for a second device
 * and (b) make adding Axe-Fx II a fill-in-the-blanks exercise rather
 * than a green-field design.
 *
 * What's already confirmed (Session 53, hardware-free, from factory
 * bank file `samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx`):
 *
 *   - Wire model byte for **Axe-Fx II XL+** = `0x07`. (Earlier guess
 *     `0x03` was wrong — that's the Axe-Edit-internal device tag,
 *     not the wire byte. The XML's `<Device model="3" .../>` /
 *     `<model="6"/>` / `<model="7"/>` declarations are Axe-Edit's
 *     internal numbering for Axe-Fx II Mark I/II / XL / XL+; on the
 *     wire each variant uses a distinct model byte. XL+ = `0x07`
 *     verified across all three factory bank files.)
 *   - Manufacturer ID `00 01 74` (same as AM4 — confirmed in Owner's
 *     Manual as "SysEx ID: 00 01 74 (cannot be changed)").
 *   - Checksum scheme = XOR & 0x7F across `F0..lastPayload` (same
 *     as AM4 — verified against 8448 SysEx messages in each bank
 *     file, 100% match).
 *   - Function bytes for preset-dump format:
 *       `0x77` = preset header (4-byte payload `[bank, preset, 0, 0x20]`)
 *       `0x78` = preset data chunk (194-byte payload, 64 chunks/preset)
 *       `0x79` = preset footer (3-byte payload)
 *   - Per-preset wire shape: 1× header + 64× data chunks + 1× footer
 *     = 66 messages = ~13 KB per preset.
 *   - Bank size: 128 presets per bank, 3 factory banks (A/B/C),
 *     384 presets total in factory bundle. Per Owner's Manual XL+
 *     supports 768 user preset locations (vs 384 on Mark I/II).
 *
 * Public protocol map: `docs/devices/axe-fx-ii/SYSEX-MAP.md`.
 *
 * What still needs hardware:
 *
 *   1. Capture AxeEdit ↔ device live SysEx via USBPcap to decode the
 *      live read/write commands (the bank file shows persistence-
 *      format only — not the parameter set/get commands the editor
 *      sends during normal editing).
 *   2. Decode the per-parameter wire-ID mapping (parameterName from
 *      Axe-Edit XML → pidLow/pidHigh) — equivalent to AM4's
 *      `variantResolverTables.ts` derivation. Axe-Edit's BinaryData
 *      ZIP does NOT contain a cache resolver (only XMLs and
 *      graphics) so this path differs from AM4: capture-based RE
 *      is the working route, statistical inference from bank file
 *      bodies is a backup.
 *   3. Fill in remaining `FractalDevice` interface methods (wire
 *      builders for set_param, read_param, set_block_type,
 *      switch_scene, etc.).
 *   4. Hardware smoke + iconic-tone test on founder's Axe-Fx II XL+.
 *
 * Until then, this stub throws on every protocol call. Server startup
 * will only instantiate this device if the connected hardware
 * identifies as model 0x07 — which won't happen for an AM4 user, so
 * v0.1.0 is unaffected.
 */
import {
  FractalDevice,
  DeviceCapabilities,
  ReadResponse,
  BaseParam,
} from 'fractal-midi/shared';

const NOT_YET = (): never => {
  throw new Error(
    'Axe-Fx II support is not yet implemented in v0.1.0. ' +
    'Targeting v0.1.1 — see docs/MULTI-DEVICE-ROADMAP.md for the path.',
  );
};

const CAPABILITIES: DeviceCapabilities = {
  // 8 scenes confirmed via Fractal's Axe-Fx-II-Scenes-Mini-Manual-1.02.pdf.
  sceneCount: 8,
  // Axe-Fx II XL+ supports a 12-slot signal chain (vs AM4's 4).
  // Confirm at HW-test time.
  slotCount: 12,
  channelsPerBlock: 'A-D',
  routing: 'linear',
  // Axe-Fx II = 384 user presets (128 banks × 3? — confirm at HW-test
  // time; this is the published number per the manual).
  presetLocationCount: 384,
};

const EMPTY_PARAM_REGISTRY: Readonly<Record<string, BaseParam>> = Object.freeze({});
const EMPTY_BLOCK_TYPES: Readonly<Record<string, number>> = Object.freeze({});

export const AXE_FX_II_DEVICE: FractalDevice = {
  // Axe-Fx II XL+ uses model byte 0x07 in the Fractal manufacturer's
  // SysEx envelope (F0 00 01 74 07 ... F7). Verified Session 53 against
  // 8448/8448 messages in Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx — see
  // `docs/devices/axe-fx-ii/SYSEX-MAP.md` §1. Other family variants:
  // 0x03 = Mark I/II, 0x06 = XL, 0x08 = AX8.
  modelByte: 0x07,
  displayName: 'Fractal Axe-Fx II XL+',
  slug: 'axe-fx-ii',
  capabilities: CAPABILITIES,
  midiPortPattern: /Axe-Fx II|AxeFx/i,

  knownParams: EMPTY_PARAM_REGISTRY,
  blockTypes: EMPTY_BLOCK_TYPES,
  paramAliases: {},

  formatLocationCode: NOT_YET,
  formatLocationDisplay: NOT_YET,
  parseLocationCode: NOT_YET,
  resolveBlockType: NOT_YET,
  blockNameForValue: NOT_YET,

  buildSetParam: NOT_YET,
  buildReadParam: NOT_YET,
  buildSetBlockType: NOT_YET,
  buildSetBlockBypass: NOT_YET,
  buildSwitchScene: NOT_YET,
  buildSwitchPreset: NOT_YET,
  buildSetPresetName: NOT_YET,
  buildSetSceneName: NOT_YET,
  buildSaveToLocation: NOT_YET,

  isWriteEcho: () => false,
  isCommandAck: () => false,
  isReadResponse: () => false,
  parseReadResponse: NOT_YET,
};

// NOT registered with FRACTAL_DEVICE_REGISTRY in v0.1.0. The stub
// exists so the path is concretely visible — uncomment the import
// in src/fractal/index.ts and call registerDevice() when v0.1.1
// implementation lands.
//
// import { registerDevice } from 'fractal-midi/shared';
// registerDevice(AXE_FX_II_DEVICE);
