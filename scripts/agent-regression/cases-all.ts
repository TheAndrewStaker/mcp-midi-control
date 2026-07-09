/**
 * Aggregator for all device cases. Importing this surface (instead of
 * per-device files) lets the runner CLI accept a case-id without
 * caring which device file declares it. Keep this thin: just
 * concatenation, no logic.
 */
import { AM4_CASES } from './cases-am4.js';
import { AXE_FX_II_CASES } from './cases-axe-fx-ii.js';
import { AXE_FX_III_CASES } from './cases-axe-fx-iii.js';
import { FM3_CASES } from './cases-fm3.js';
import { FM9_CASES } from './cases-fm9.js';
import { VP4_CASES } from './cases-vp4.js';
import { AXEFX_GEN1_CASES } from './cases-axefx-gen1.js';
import { CROSS_DEVICE_CASES } from './cases-cross-device.js';
import { HYDRASYNTH_CASES } from './cases-hydrasynth.js';
import { CIRCUIT_TRACKS_CASES } from './cases-circuit-tracks.js';
import { SPD_SX_CASES } from './cases-spd-sx.js';
import { VE500_CASES } from './cases-ve-500.js';
import type { AgentRegressionCase } from './types.js';

export const ALL_CASES: readonly AgentRegressionCase[] = [
  ...AM4_CASES,
  ...AXE_FX_II_CASES,
  ...AXE_FX_III_CASES,
  ...FM3_CASES,
  ...FM9_CASES,
  ...VP4_CASES,
  ...AXEFX_GEN1_CASES,
  ...HYDRASYNTH_CASES,
  ...CIRCUIT_TRACKS_CASES,
  ...SPD_SX_CASES,
  ...VE500_CASES,
  ...CROSS_DEVICE_CASES,
];
