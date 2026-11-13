/**
 * FM9-specific help overrides over the shared gen-3 catalog. Only the
 * deltas the guide flags as FM9-specific live here. Merge via
 * `resolveHelp(GEN3_HELP, FM9_HELP_OVERRIDES)`.
 */
import type { HelpOverrides } from '../helpTypes.js';

export const FM9_HELP_OVERRIDES: HelpOverrides = {
  CABINET: {
    block: {
      detail:
        'Up to two IRs per channel (no FullRes). Legacy mode picks from IR banks; DynaCab mode dials in cab/mic position and distance visually.',
    },
  },
};
