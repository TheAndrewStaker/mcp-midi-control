/**
 * FM3-specific help overrides over the shared gen-3 catalog. Only the
 * deltas the guide flags as FM3-specific live here. Merge via
 * `resolveHelp(GEN3_HELP, FM3_HELP_OVERRIDES)`.
 */
import type { HelpOverrides } from '../helpTypes.js';

export const FM3_HELP_OVERRIDES: HelpOverrides = {
  CABINET: {
    block: {
      detail:
        'Up to two IRs per channel (no FullRes). Legacy mode picks from IR banks; DynaCab mode dials in cab/mic position and distance visually.',
    },
  },
  DELAY: {
    block: {
      detail:
        'The Type page recalls a complete delay flavor in one move; the Config/EQ/Mod pages refine it. Max delay time 8 s on the FM3.',
    },
  },
};
