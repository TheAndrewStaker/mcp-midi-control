/**
 * BK-051 unified MCP tool surface — index module.
 *
 * `registerUnifiedTools(server)` registers the full port-dispatched,
 * device-agnostic tool family on an `McpServer`. Tools are split across
 * per-family files under `src/protocol/generic/tools/` so each file
 * stays focused on one concern (discovery, params, layout, navigation,
 * preset). This index just composes them.
 *
 * Family layout (every file exports a `register{Family}Tools(server)` fn):
 *   - `discovery.ts` — describe_device, list_params, lookup_lineage
 *   - `params.ts`    — get_param, set_param, get_params, set_params
 *   - `layout.ts`    — set_block, set_bypass
 *   - `navigation.ts` — switch_preset, save_preset, switch_scene, rename,
 *                       scan_locations
 *   - `preset.ts`    — apply_preset, translate_preset
 *   - `audio.ts`     -- measure_loudness (OS-audio loudness sensing, no MIDI)
 *   - `shared.ts`    — PORT_DESC + asText/asError + presetShape zod schemas
 *
 * The long AM4-specific behavioral guidance (RELATIVE-CHANGE DISCIPLINE,
 * TEMPO/TIME, CHANNEL/SCENE, REVERB.TYPE NAMING, COMPRESSOR groups, etc.)
 * stays on the legacy device-namespaced tool descriptions through v0.1.0.
 * When Wave 2 retires the device-namespaced surface, the guidance migrates
 * into per-device `behavioral_guidance` fields on `describe_device`. v0.3
 * problem; not Session B's job.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Side-effect import: keep the descriptor registry in this module's
// import graph so any future bundler / tree-shaker preserves it
// alongside the unified tool registrations. The dispatcher functions
// each per-family file uses (requireDevice, resolveDevice, etc.) already
// import registry.js transitively, but pinning it here makes the intent
// explicit and stops a "this import looks unused, drop it" cleanup pass
// from inadvertently breaking the unified surface. Replaces an earlier
// `void requireDevice;` no-op statement (T-14, 2026-05-21).
import './registry.js';

import { registerAudioTools } from './tools/audio.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerLayoutTools } from './tools/layout.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerParamTools } from './tools/params.js';
import { registerPatternTools } from './tools/patterns.js';
import { registerPresetTools } from './tools/preset.js';
import { registerUploadTools } from './tools/uploads.js';

export function registerUnifiedTools(server: McpServer): void {
  registerDiscoveryTools(server);
  registerParamTools(server);
  registerLayoutTools(server);
  registerNavigationTools(server);
  registerPresetTools(server);
  registerPatternTools(server);
  registerUploadTools(server);
  registerAudioTools(server);
}
