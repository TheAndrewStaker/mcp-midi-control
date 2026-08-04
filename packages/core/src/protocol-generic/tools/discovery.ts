/**
 * Discovery tools, pure-introspection MCP tools that surface device
 * capabilities, parameter catalogs, and authored block-type lineage. None
 * of these tools touch MIDI; they read the descriptor's static schema.
 *
 * Tools registered here:
 *   - `describe_device(port)`, capabilities + canonical terms + block roster
 *   - `list_params(port, block?, name?)`, param catalog + enum tables
 *   - `lookup_lineage(port, block_type, ...)`, Fractal-style real-gear lineage
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RigEditOp, Role } from 'openrig';
import * as z from 'zod/v4';

import {
  describeDevice,
  describeDeviceGuidance,
  describeDeviceRecipe,
  executeDescribeRig,
  executeLookupLineage,
  executeRigEdit,
  findCompatibleTypes,
  listParams,
} from '../dispatcher.js';

import { PORT_DESC, asError, asText } from './shared.js';

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool('describe_rig', {
    title: 'Describe Rig',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Whole-rig overview: every device this server can drive, which are connected right now, and what each one is. Read-only, pure introspection (a non-opening port scan plus a mounted-drive check; opens no MIDI handles).',
      'Call this FIRST when configuring more than one device (e.g. setting up a rig for a song) so you can plan against what is actually present, instead of guessing ports.',
      'Per device: id and name (pass either as the `port` arg to drive it), connected plus how (a MIDI port name or a mounted drive), transport (midi/serial/storage/hybrid), preset_class (layout = preset processor, voice = synth or sampler), support_tier, pattern_target (accepts apply_pattern), and a one-line capability summary. For deep per-device detail, call describe_device(port).',
      'When a rig manifest is configured (MCP_RIG_MANIFEST), also returns `manifest`: the declared OpenRig rig (devices + typed audio/MIDI cabling + channels + cross-device bindings) plus three verification checks and presence-only declared-vs-connected drift. `validation` = is the graph well-formed. `compatibility` = per cross-device binding, do both ends agree (channel/CC/note) and is the mapping legal for the gear (will the MIDI coordination WORK). `audio` = does each instrument reach front-of-house, or is it unpatched / dead-ending. Read the manifest when configuring the rig for a song.',
      'Note: serial devices (FM3) are invisible to the MIDI scan and can read connected:false even when plugged in; confirm with describe_device or list_midi_ports.',
    ].join(' '),
    inputSchema: {},
  }, async () => {
    try {
      return asText(executeDescribeRig());
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('describe_device', {
    title: 'Describe Device',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'REQUIRED first call for any device question or apply_preset call. Pure introspection, no MIDI I/O, safe to call repeatedly.',
      '`recipes` comes FIRST in the response and is the first thing to read: frozen knob bundles for common tone vocab. Match the request to a recipe id and apply it in ONE call via apply_preset({port, recipe_id}) BEFORE authoring from scratch. Single-block recipes carry target_block + params; block-stack and Hydrasynth patch-archetype recipes carry signature_params and materialize server-side. Those entries are sized for MATCHING; for one recipe\'s full knobs + source citations, call describe_device({port, recipe:id}).',
      'Then: `capabilities` (channels/scenes/save/atomic_read; `supports_save: false` gates only auto-save during navigation, read `capabilities.save_note` before concluding a device cannot save), `blocks` + `block_types` roster, `canonical_terms` (AM4 channel A/B/C/D, II X/Y, Hydra "patch"), `example_spec` (clone-and-swap apply_preset literal, slot shape bare int on AM4 / {row,col} on grid devices), `block_params_summary` (curated first-page knobs per block; FIRST stop for knob names, fall back to list_params for GEQ/enum tables), `concept_keys` (cross-device aliases like `drive.output_level`), and `agent_guidance`.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      guidance: z.union([z.boolean(), z.array(z.string()).min(1)]).optional().describe(
        'Return ONLY this device\'s curated authoring notes, and nothing else (no capabilities/blocks/recipes). The default response carries as much guidance as fits its size budget and names anything held back in `agent_guidance_withheld.topics`. PASS THAT ARRAY here to read exactly those topics; `true` re-sends the whole corpus, which on a large device costs more than the response you are topping up.',
      ),
      recipe: z.string().optional().describe(
        'Return ONE recipe\'s full authored definition, and nothing else. Takes precedence over `guidance`. The default response\'s `recipes[]` is sized for MATCHING (description, category, tags, cultural_reference, signature_params, slot_count), which is enough to choose an id. Pass an id here for what it leaves out: `source_notes` (where the knob values come from; quote this when the user asks about a tone\'s provenance) and the full authored knobs (`full_params` plus `mod_routes`/`macro_routes` on a Hydrasynth archetype, `slots` on a Fractal block stack). `slots` also carries the per-slot REFS: read them before keying apply_preset `overrides`, where a ref matching no recipe slot is appended rather than merged. READ-ONLY detail: to apply, pass the id to apply_patch/apply_preset, which materializes these values server-side. Do NOT re-send them by hand.',
      ),
    },
  }, async ({ port, guidance, recipe }) => {
    try {
      if (recipe !== undefined) return asText(describeDeviceRecipe(port, recipe));
      if (guidance === undefined || guidance === false) return asText(describeDevice(port));
      return asText(describeDeviceGuidance(port, Array.isArray(guidance) ? guidance : undefined));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('list_params', {
    title: 'List Parameters',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Enumerate a device\'s params with units and display ranges. Pure introspection, no MIDI I/O. Call before set_param when unsure of an enum spelling or knob range. THREE SCOPES, widest to narrowest; the response names yours in `scope` and the narrowing call in `next`. No filter: a per-block census (param counts, type-selector name, roster size), NOT param rows. `block`: match-time rows for those blocks (name, unit, display range, aliases, applicability). `block` plus `name`: those rows plus the full `enum_values` table, applicability naming every applicable type, and the vendor UI / firmware labels. Responses are capped at a size the host will actually deliver, so a wide request can come back `truncated`. For `amp.type` and `drive.type` the response carries `enum_value_loudness_offsets_db`: per-model dB offsets vs the reference (Twin Reverb master=6 is 0 dB; T808 OD level=7 is +6 dB). Add these on top of conventional scene-leveling when balancing per-amp loudness.',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe(
        'Block-name filter, and the difference between a census and actual knobs. A single string (`amp`) or an array (`["amp","drive","reverb","delay"]`); a lone string is coerced to a one-element array. OMITTING IT RETURNS NO PARAM ROWS, only a per-block census, because the full catalog runs past 200,000 characters on the deepest devices and the host would deliver none of it. For a multi-block survey at the start of a tone build, pass every block you care about in one call; each extra block in a batched call saves a turn.',
      ),
      name: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe(
        'Param-name filter (requires `block`). A single string (`type`) or an array; a lone string is coerced to a one-element array. This is the scope that returns the full `enum_values` table, applicability with every applicable type named, and the vendor UI / firmware labels, all of which are withheld from the wider block scope for size. To fetch every enum dropdown across multiple blocks (e.g. amp.type + drive.type + reverb.type), batch all names in one call.',
      ),
      include_descriptions: z.boolean().optional().describe(
        'When true, each param entry carries a `description` field (verbatim Blocks Guide / Owner\'s Manual excerpt). Default false; turn on when you need prose to disambiguate similarly-named knobs or answer the user\'s "what does X do" question. It roughly doubles a row, so expect a wide request to page.',
      ),
      offset: z.number().int().min(0).optional().describe(
        'Skip this many param rows. Only useful after a response came back with `truncated`, which carries `returned` / `total` / `next_offset`: pass that `next_offset` here to read the following page, and repeat until `truncated` is absent. Narrowing `block` or `name` is usually faster than paging, and never costs you a turn you did not have to spend. Default 0.',
      ),
      limit: z.number().int().min(1).optional().describe(
        'Cap the number of param rows returned. The response size budget applies regardless, so this only ever returns fewer rows than you asked for, never more.',
      ),
    },
  }, async ({ port, block, name, include_descriptions, offset, limit }) => {
    try {
      // Coerce a lone string to a one-element array so the schema matches
      // the documented "string OR array" contract (the prior array-only
      // schema 400'd on a bare string — alpha.16 desktop test).
      const blockArr = block === undefined ? undefined : Array.isArray(block) ? block : [block];
      const nameArr = name === undefined ? undefined : Array.isArray(name) ? name : [name];
      return asText(listParams({ port, block: blockArr, name: nameArr, include_descriptions, offset, limit }));
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('find_compatible_types', {
    title: 'Find Compatible Types',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Returns the subset of block.type values that expose EVERY knob you list (AND-semantics). Call before apply_preset / set_param when a tone request pairs a vocabulary word with a knob requirement ("long-decay reverb", "Vox with master"). Prevents the silent-no-op trap where a fixed-decay reverb.type drops writes to `time`. - Example: {block:"reverb", params:["time"]} returns Plate / Echo / SFX (Hall / Room drop, fixed-decay). - Empty result: no type exposes all listed knobs; drop a knob. - applicability_known=false: no per-type data; result is the full type list, fall back to list_params + applies_only_when.',
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
    title: 'Look Up Gear Lineage',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Look up authored lineage for a block type: real hardware modeled, manufacturer notes, developer/forum quotes. Pure data, no MIDI I/O. Pick one call shape: - forward { block_type, name }: `name` is ALWAYS an array, even for one (`["USA IIC+"]`); no single-string form. Batch all names in one call (`["USA IIC+","Deluxe Verb Normal"]`) to save turns. Returns `{ entries: [...] }`; a wide batch pages via `truncated.next_offset`. - reverse { block_type, real_gear }: substring search over basedOn/description/quotes (`1176`, `Tube Screamer`, `Keith Urban tone`). Flat shape. - structured { block_type, manufacturer?, model? }: exact-match. Flat shape. Forward amp/drive entries carry a `loudness` field. Call before apply_preset on solo/lead scenes so level compensation is data-driven, not guessed. No-lineage devices refuse with a capability error; check describe_device.capabilities.supports_lineage.',
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      block_type: z.string().describe(
        'Block type to query. See describe_device.block_types and the device\'s lineage coverage.',
      ),
      name: z.array(z.string()).min(1).optional().describe(
        'Forward-lookup canonical model names. For multi-amp/multi-drive scene builds, pass every name in one call (`["USA IIC+","Deluxe Verb Normal"]`) instead of calling lookup_lineage repeatedly. Each sequential call costs you a turn.',
      ),
      real_gear: z.string().optional(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      include_quotes: z.boolean().optional().describe('Default true; pass false for a terser response.'),
      offset: z.number().int().min(0).optional().describe('Forward only: resume index into your `name` array, from `truncated.next_offset`.'),
    },
  }, async ({ port, block_type, name, real_gear, manufacturer, model, include_quotes, offset }) => {
    try {
      const result = executeLookupLineage({ port, block_type, name, real_gear, manufacturer, model, include_quotes, offset });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('edit_rig', {
    title: 'Edit Rig',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: [
      'Edit the OpenRig manifest (MCP_RIG_MANIFEST): add/remove a DEVICE, or add/remove/enable/disable a CABLE. Invalid edits are refused, the file is backed up, and the response re-runs the compatibility + audio + capacity checks. Call describe_rig first for ids.',
      'add_device: id + name + roles (+ manufacturer/family/server_device_id/ports/note). Adds the node with NO cables: where it plugs in is a separate decision, and describe_rig.capacity.free_by_kind names the genuinely free ports. remove_device: device (id or name); cables touching it go too, listed in removed_edge_ids.',
      'add_cable: from + to + kind (audio/midi/footswitch); for MIDI add midi_type, channel, cc/notes/note_map; for audio audio_channels (default L/R). Missing ports are created; enabled:false marks it [planned]. remove_cable: cable_id, or from/to (+kind). set_cable_enabled: cable_id + enabled. dry_run:true previews.',
    ].join(' '),
    inputSchema: {
      operation: z.enum(['add_cable', 'remove_cable', 'set_cable_enabled', 'add_device', 'remove_device']).describe('The edit to make.'),
      device: z.string().optional().describe('remove_device: the device to remove (id or display name).'),
      id: z.string().optional().describe('add_device: stable, opaque node id, unique in the rig.'),
      name: z.string().optional().describe('add_device: display name.'),
      roles: z.array(z.string()).optional().describe('add_device: OpenRig roles, e.g. ["sound_source"]. At least one is required; the checks key on roles.'),
      manufacturer: z.string().optional().describe('add_device: manufacturer, e.g. "Arturia".'),
      family: z.string().optional().describe('add_device: model family, e.g. "MicroFreak".'),
      server_device_id: z.string().optional().describe('add_device: registered server descriptor id, when this server supports the device. Omit for opaque gear.'),
      ports: z.array(z.object({
        id: z.string(),
        kind: z.enum(['audio_out', 'audio_in', 'midi_din_in', 'midi_din_out', 'midi_thru', 'usb_midi', 'usb_serial', 'expression', 'footswitch', 'cv', 'analog_clock']),
        label: z.string().optional(),
        audio: z.enum(['mono', 'stereo']).optional(),
        output_role: z.enum(['main', 'monitor', 'sub', 'stem', 'cue']).optional(),
      })).optional().describe('add_device: the jacks on the device.'),
      from: z.string().optional().describe('add_cable / remove_cable: source device (id or display name).'),
      to: z.string().optional().describe('add_cable / remove_cable: destination device (id or display name).'),
      kind: z.enum(['audio', 'midi', 'footswitch']).optional().describe('Cable type.'),
      midi_type: z.enum(['clock', 'transport', 'spp', 'song_select', 'pc', 'cc', 'nrpn', 'note', 'sysex', 'active_sensing']).optional().describe('add_cable MIDI message type (default cc).'),
      channel: z.number().int().min(1).max(16).optional().describe('MIDI channel 1-16.'),
      cc: z.array(z.number().int().min(0).max(127)).optional().describe('add_cable cc numbers.'),
      notes: z.array(z.number().int().min(0).max(127)).optional().describe('add_cable note numbers.'),
      note_map: z.union([z.literal('GM'), z.record(z.string(), z.string())]).optional().describe('add_cable note cable: "GM" or {note: voice}.'),
      audio_channels: z.array(z.enum(['L', 'R', 'M'])).optional().describe('add_cable audio channels (default ["L","R"], mono = ["M"]).'),
      enabled: z.boolean().optional().describe('add_cable / set_cable_enabled: false marks the cable [planned] (not active).'),
      note: z.string().optional().describe('add_cable: a human note on the cable.'),
      cable_id: z.string().optional().describe('remove_cable / set_cable_enabled: the cable id (from describe_rig).'),
      dry_run: z.boolean().optional().describe('Preview only: validate + report the effect, write nothing.'),
    },
  }, async (a) => {
    try {
      let op: RigEditOp;
      if (a.operation === 'add_cable') {
        if (a.from === undefined || a.to === undefined || a.kind === undefined) {
          throw new Error('edit_rig add_cable needs from, to, and kind.');
        }
        op = {
          op: 'add_cable', from: a.from, to: a.to, kind: a.kind, midi_type: a.midi_type,
          channel: a.channel, cc: a.cc, notes: a.notes, note_map: a.note_map,
          audio_channels: a.audio_channels, enabled: a.enabled, note: a.note,
        };
      } else if (a.operation === 'add_device') {
        if (a.id === undefined || a.name === undefined || a.roles === undefined) {
          throw new Error('edit_rig add_device needs id, name, and roles.');
        }
        // `roles` arrives as string[] from the JSON schema; applyRigEdit rejects
        // an empty list, and validateRig rejects a role outside the core enum,
        // so a bad value fails loudly at the seam rather than silently landing.
        op = {
          op: 'add_device', id: a.id, name: a.name, roles: a.roles as Role[],
          manufacturer: a.manufacturer, family: a.family,
          server_device_id: a.server_device_id, ports: a.ports, note: a.note,
        };
      } else if (a.operation === 'remove_device') {
        if (a.device === undefined) throw new Error('edit_rig remove_device needs device.');
        op = { op: 'remove_device', device: a.device };
      } else if (a.operation === 'remove_cable') {
        if (a.cable_id === undefined && a.from === undefined && a.to === undefined) {
          throw new Error('edit_rig remove_cable needs cable_id, or from/to (with optional kind).');
        }
        op = { op: 'remove_cable', cable_id: a.cable_id, from: a.from, to: a.to, kind: a.kind };
      } else {
        if (a.cable_id === undefined || a.enabled === undefined) {
          throw new Error('edit_rig set_cable_enabled needs cable_id and enabled.');
        }
        op = { op: 'set_cable_enabled', cable_id: a.cable_id, enabled: a.enabled };
      }
      return asText(executeRigEdit(op, { dry_run: a.dry_run }));
    } catch (err) {
      return asError(err);
    }
  });
}
