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
    description: [
      'Return a registered device\'s capabilities and canonical vocabulary.',
      'Call once per session for any device you\'re about to control via the',
      'unified set_param / get_param / apply_preset / etc. tools — the',
      'response tells you what blocks the device has, what its scenes /',
      'channels / preset locations look like, and which words the device',
      'uses for each concept (e.g. AM4: "channel A/B/C/D"; Axe-Fx II:',
      '"channel X/Y"; Hydrasynth: "patch" instead of "preset").',
      'Pure introspection — no MIDI I/O. Safe to call repeatedly.',
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
    description: [
      'Enumerate a device\'s named parameters. With no `block` filter,',
      'returns every (block, name) pair the device exposes plus its unit',
      'and display range. With `block` supplied, scopes to just that block.',
      'With both `block` AND `name`, the response also includes the full',
      'enum table for enum-typed params (e.g. amp.type with 50+ amp model',
      'names; reverb.type with all the "Room, Small" / "Plate, Medium"',
      'entries). Use this before calling set_param when you\'re unsure of',
      'the exact spelling of an enum value.',
      'BATCH FORM (preferred for tone-building): both `block` and `name`',
      'accept arrays. Pass `block: ["amp", "drive", "pitch", "reverb"]`',
      'to survey four blocks in one call, or `block: "pitch", name:',
      '["effect_type", "key", "scale", "voice_1_harmony"]` to pull every',
      'enum table you need for the pitch block in one call. Beats the',
      'one-call-per-enum loop that costs ~50 ms per round-trip.',
      'OPTIONAL PROSE: pass `include_descriptions: true` to attach a',
      '`description` field (verbatim Blocks Guide / Owner\'s Manual',
      'excerpt) to each param entry where one is on file. Default false',
      'to keep the response low-bandwidth; turn on when the user asks',
      '"what does X do" or you need to pick between similarly-named',
      'knobs. Params without a prose entry omit the field entirely.',
      'Pure introspection — no MIDI I/O.',
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
    description: [
      'Given a block + a list of knob names you plan to write, return the',
      'subset of `block.type` enum values that expose EVERY listed knob.',
      'Use BEFORE apply_preset / set_param when you care about specific knobs',
      '— e.g. "long-decay reverb" needs a reverb.type that exposes `time`.',
      'Saves a "dropped X param" warning round-trip.',
      'Example: find_compatible_types({port:"am4", block:"reverb", params:',
      '["time"]}) → compatible_types = ["Hall, Large Deep", "Plate Long", …].',
      'Pick from compatible_types[] for the apply_preset call.',
      'Empty `compatible_types` means no single type exposes all listed knobs',
      'simultaneously — drop a knob or pick different ones.',
      'If `applicability_known` is false, the device descriptor has no',
      'structured per-type data — `compatible_types` is the full type list',
      '(no filtering). Fall back to list_params + `applies_only_when`.',
      'AND-semantics across `params`: a type makes the list only if it',
      'exposes EVERY listed param. Pure introspection — no MIDI I/O.',
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
    description: [
      'Look up the registered device\'s authored lineage data for one of',
      'its block types — what real hardware it\'s modeled after, the',
      'device manufacturer\'s description, and developer/forum quotes.',
      'Three call shapes (provide one):',
      '  (a) forward — { block_type, name }: exact-match the canonical',
      '      device model name (case-insensitive).',
      '  (b) reverse — { block_type, real_gear }: substring search across',
      '      basedOn / description / quotes. Use for fuzzy queries like',
      '      "1176", "Tube Screamer", "Keith Urban tone".',
      '  (c) structured — { block_type, manufacturer?, model? }: exact-',
      '      match against structured fields. Most precise.',
      'Devices without a registered lineage corpus reject with a capability',
      'error — see describe_device.capabilities.supports_lineage.',
      'Pure data lookup — no MIDI I/O.',
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
