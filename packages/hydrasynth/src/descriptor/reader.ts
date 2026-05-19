/**
 * Hydrasynth Explorer DeviceDescriptor — DeviceReader implementation.
 *
 * Scope (v1 scaffold, BK-031): MINIMAL. The Hydrasynth has no decoded
 * single-param READ primitive in our current tooling — the existing
 * `hydra_*` tool surface is write-heavy by design (the only read tool
 * is `hydra_get_active_patch`, which surfaces an inbound CC observation
 * rather than issuing a query/response round-trip).
 *
 * Reader contract requires `getParam` + `getParams`. We satisfy the
 * type system but throw `capability_not_supported` at runtime — the
 * dispatcher returns that cleanly to the agent, who can fall back to
 * audible/visible verification on the device front panel.
 *
 * `scanLocations` and `lookupLineage` are optional and omitted. The
 * Hydrasynth has no Fractal-style preset-scan envelope (each patch is
 * a full ~13KB SysEx dump, not a single-byte name read), and no
 * Fractal-authored lineage corpus.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  ReadResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

const DEVICE_LABEL = 'ASM Hydrasynth Explorer';

export const reader: DeviceReader = {
  async getParam(_ctx: DispatchCtx, block: string, name: string): Promise<ReadResult> {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `get_param is not supported on ASM Hydrasynth Explorer. The device has no decoded single-param query/response primitive. ` +
      `For the active-patch name + bank/program, call hydra_get_active_patch. To verify a written value, audition the patch ` +
      `(play_note / play_chord with port="hydrasynth") or check the front-panel display directly.`,
      { retry_action: `hydra_get_active_patch | play_note` },
    );
  },

  async getParams(_ctx: DispatchCtx, _queries): Promise<BatchReadResult> {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `get_params batch read is not supported on ASM Hydrasynth Explorer (same reason as get_param). ` +
      `Use hydra_get_active_patch for active-patch info.`,
    );
  },
};
