/**
 * Arturia device package: brand-level SysEx codec + the Freak-family factory.
 *
 * One package per CODEC, not per device. The Arturia envelope is shared across
 * the line and differs by a device-code byte, so new models join as configs.
 */
export * from './codec/sysex.js';
export * from './devices/types.js';
export * from './downstream.js';
export {
  MICROFREAK,
  MICROFREAK_CCS,
  MICROFREAK_GLOBALS,
  MIDI_THRU_DIN_ALIVE,
  OUTPUT_DEST_DIN_ALIVE,
  OUTPUT_DEST_USB_ALIVE,
} from './devices/microfreak.js';
export { MINIFREAK, MINIFREAK_CCS } from './devices/minifreak.js';
export { createFreakDescriptor } from './factory.js';
export { MICROFREAK_DESCRIPTOR, MINIFREAK_DESCRIPTOR } from './descriptor.js';
