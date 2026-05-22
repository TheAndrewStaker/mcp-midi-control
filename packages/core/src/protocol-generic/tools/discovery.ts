/**
 * Discovery tools — pure-introspection MCP tools that surface device
 * capabilities, parameter catalogs, and authored block-type lineage. None
 * of these tools touch MIDI; they read the descriptor's static schema.
 *
 * Tools registered here:
 *   - `describe_device(port)` — capabilities + canonical terms + block roster
 *   - `list_params(port, block?, name?)` — param catalog + enum tables
 *   - `lookup_lineage(port, block_type, ...)` — Fractal-style real-gear lineage
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  describeDevice,
  executeLookupLineage,
  findCompatibleTypes,
  listParams,
} from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool('describe_device', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'REQUIRED first call for any device question or apply_preset call. Pure introspection, no MIDI I/O, safe to call repeatedly.',
      'Response: `capabilities` (channels/scenes/save/atomic_read), `blocks` + `block_types` roster, `canonical_terms` (AM4 channel A/B/C/D, II X/Y, Hydra "patch"), `example_spec` (clone-and-swap apply_preset literal with canonical names + slot shape — bare int on AM4, {row,col} on grid devices), `block_params_summary` (curated top-N first-page knobs per block; FIRST stop for knob names — fall back to list_params for GEQ/enum tables), `concept_keys` (cross-device aliases like `drive.output_level`), `agent_guidance`, and `recipes` — frozen knob bundles for common tone vocab (single-block: auto_wah/pitch/wah/filter/scene_leveling carry target_block + params; block-stack: e.g. edge_dotted_eighth_lead carries a slots array — paste into apply_preset.spec.slots, override individual knobs in the same call). Scan recipes[] for matching id BEFORE authoring from scratch.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
    },
  }, async ({ port }) => {
    try {
      return asText(describeDevice(port));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('list_params', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Enumerate a device\'s parameters with units and display ranges. Pure introspection, no MIDI I/O.',
      'Call before set_param when unsure of an enum spelling or knob range.',
      '- No filter: every (block, name) the device exposes. With `block`: scoped to that block. With both `block` and `name`: full enum table for enum-typed params.',
      '- Batch form: both `block` and `name` accept arrays. `block: ["amp","drive","reverb"]` surveys 3 blocks in one call.',
      '- `include_descriptions: true` attaches a Blocks-Guide / Owner\'s-Manual excerpt per param; default false.',
      '- For `amp.type` and `drive.type`, the response carries `enum_value_loudness_offsets_db` — per-model dB offsets vs the reference amp/drive (Twin Reverb at master=6 = 0 dB; T808 OD at level=7 = +6 dB). Add these on top of the conventional scene-leveling spread when balancing per-amp loudness.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe(
        'Optional block-name filter. Single string ("amp") OR array of names (["amp", "drive", "pitch"]) — the array form returns params across every listed block in one call.',
      ),
      name: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe(
        'Optional param-name filter (requires `block`). Single string OR array. For enum params, returns the full enum table for each matching name — pass an array to fetch every enum dropdown in one call instead of N sequential calls.',
      ),
      include_descriptions: z.boolean().optional().describe(
        'When true, each param entry carries a `description` field (verbatim Blocks Guide / Owner\'s Manual excerpt). Default false; turn on when you need prose to disambiguate similarly-named knobs or answer the user\'s "what does X do" question.',
      ),
    },
  }, async ({ port, block, name, include_descriptions }) => {
    try {
      return asText(listParams({ port, block, name, include_descriptions }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('find_compatible_types', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Given a block + knob names you plan to write, return the subset of block.type values that expose EVERY listed knob (AND-semantics).',
      'Call before apply_preset / set_param when "long-decay reverb" or "Vox with master" combines a tone vocabulary with a specific knob requirement. Prevents the silent-no-op trap where a fixed-decay reverb.type drops writes to `time`.',
      '- Example: find_compatible_types({port:"am4", block:"reverb", params:["time"]}) returns Plate / Echo / SFX variants (Hall / Room variants drop because they\'re fixed-decay).',
      '- Empty result: no type exposes all listed knobs. Drop a knob.',
      '- If applicability_known=false: device has no structured per-type data; result is the full type list, fall back to list_params + applies_only_when.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.string().describe('Block name (e.g. "reverb", "amp", "delay").'),
      params: z.array(z.string()).min(1).describe(
        'Knob names that the chosen type must expose. AND-semantics: every listed param must be exposed by the returned types. Examples: ["time"], ["time", "predelay"], ["master", "negative_feedback"].',
      ),
    },
  }, async ({ port, block, params }) => {
    try {
      return asText(findCompatibleTypes({ port, block, params }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('lookup_lineage', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Look up authored lineage data for a block type: what real hardware it models, manufacturer notes, developer/forum quotes. Pure data lookup, no MIDI I/O.',
      'Three call shapes (pick one):',
      '- forward: { block_type, name } exact-match the canonical model name.',
      '- reverse: { block_type, real_gear } substring search across basedOn / description / quotes. Use for "1176", "Tube Screamer", "Keith Urban tone".',
      '- structured: { block_type, manufacturer?, model? } exact-match structured fields.',
      'LOUDNESS DATA. When forward-querying an amp or drive by name, the response carries a structured `loudness` field with master_sweet_spot_display + relative_loudness_dB for amps, or default_level_display + boost_response_dB for drives. Call before apply_preset when authoring solo/lead scenes so the level compensation is computed from data, not guessed.',
      'Devices without lineage refuse via a capability error; see describe_device.capabilities.supports_lineage.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block_type: z.string().describe(
        'Block type to query. See describe_device.block_types and the device\'s lineage coverage.',
      ),
      name: z.string().optional(),
      real_gear: z.string().optional(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      include_quotes: z.boolean().optional().describe('Default true; pass false for a terser response.'),
    },
  }, async ({ port, block_type, name, real_gear, manufacturer, model, include_quotes }) => {
    try {
      const result = executeLookupLineage({ port, block_type, name, real_gear, manufacturer, model, include_quotes });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
