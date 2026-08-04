/**
 * Arturia Freak-family descriptors, each built from its config by the shared
 * factory. Adding a Freak means adding a config in `devices/`, not a descriptor.
 */
import { createFreakDescriptor } from './factory.js';
import { MICROFREAK } from './devices/microfreak.js';
import { MINIFREAK } from './devices/minifreak.js';

/** Hardware-confirmed on the maintainer's unit (fw 5.0.0), 2026-07-25. */
export const MICROFREAK_DESCRIPTOR = createFreakDescriptor(MICROFREAK);

/**
 * EXPERIMENTAL. No hardware access, CC table second-hand, and no SysEx at all
 * (device-code byte unknown), so every parameter is write-only and get_param
 * refuses. Registered so the family is reachable; see its `verification`.
 */
export const MINIFREAK_DESCRIPTOR = createFreakDescriptor(MINIFREAK);
