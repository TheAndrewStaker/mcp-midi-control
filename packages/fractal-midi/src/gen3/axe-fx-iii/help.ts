/**
 * Axe-Fx III–specific help overrides over the shared gen-3 catalog.
 * Only the deltas the guide flags as III-specific live here; everything
 * else resolves to `GEN3_HELP`. Merge via `resolveHelp(GEN3_HELP,
 * AXE_FX_III_HELP_OVERRIDES)`.
 */
import type { HelpOverrides } from '../helpTypes.js';

export const AXE_FX_III_HELP_OVERRIDES: HelpOverrides = {
  CABINET: {
    block: {
      detail:
        'Up to four IRs per channel. Slots 3–4 support FullRes IRs for up to ~1.37 s of room response. Legacy mode picks from IR banks; DynaCab mode dials in cab/mic position and distance visually.',
    },
  },
};
