/**
 * Aggregator for all device cases. Importing this surface (instead of
 * per-device files) lets the runner CLI accept a case-id without
 * caring which device file declares it.
 */
import { AM4_CASES } from './cases-am4.js';
import { AXE_FX_II_CASES } from './cases-axe-fx-ii.js';
import { AXE_FX_III_CASES } from './cases-axe-fx-iii.js';
import { CROSS_DEVICE_CASES } from './cases-cross-device.js';
import { HYDRASYNTH_CASES } from './cases-hydrasynth.js';
import type { AgentRegressionCase } from './types.js';

export const ALL_CASES: readonly AgentRegressionCase[] = [
  ...AM4_CASES,
  ...AXE_FX_II_CASES,
  ...AXE_FX_III_CASES,
  ...HYDRASYNTH_CASES,
  ...CROSS_DEVICE_CASES,
];
