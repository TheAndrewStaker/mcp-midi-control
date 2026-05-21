/**
 * Preset tools — full-preset apply, batch setlist apply, and factory
 * restore. These tools wrap the device's preset executor; the AM4
 * implementation lives in `src/fractal/am4/tools/applyExecutor.ts` and
 * is invoked by the descriptor's `writer.applyPreset` /
 * `writer.applySetlist` / `writer.restoreDefaults` methods.
 *
 * Tools registered here:
 *   - `apply_preset(port, spec, target_location?)`
 *   - `apply_setlist(port, entries, options?)`
 *   - `restore_defaults(port, from, to?, options?)`
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeApplyPreset,
  executeApplySetlist,
  executeGetPreset,
  executePortPreset,
  executeRestoreDefaults,
} from '../dispatcher.js';
import type { PresetSpec } from '../types.js';
import {
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
  SAVE_AUTHORIZED_SCHEMA,
  buildSaveAuthorizedDescription,
} from '../../server-shared/safeEdit.js';

import { PORT_DESC, asError, asText, presetShape } from './shared.js';

export function registerPresetTools(server: McpServer): void {
  server.registerTool('get_preset', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Snapshot the active working buffer in one tool call. Returns every placed block with its current params under a PresetSpec-shaped envelope.',
      'Use for state-anchoring before a tone-edit conversation: read what is on the device, summarize what is placed, propose changes, then call set_param or set_params for the targeted edits.',
      'PERFORMANCE. ~1-1.5 s on Axe-Fx II for a typical 11-block preset (one fn 0x1F per placed block, serial). Pass include_channel_state:true to ALSO nest params under the active channel key on channel-bearing blocks; that adds ~50 ms per channel-bearing block (≈ +450 ms on an 11-block preset with 9 channel blocks). Default OFF saves the round-trips on inspection workflows. AM4 / III / Hydra return capability_not_supported until their atomic-read primitives land; on those devices fall back to get_param + get_params.',
      'RESPONSE SCOPE. Active scene only. By default channel-bearing blocks return FLAT params with channel_status:"unknown" and _meta.channel_state_omitted:true. Set include_channel_state:true to nest under the active channel (channel_status:"active", _meta.channel_state_omitted:false) when you need round-trippable shapes. Scenes 2..N, non-active channels, and routing edges are NOT included.',
      'DO NOT FEED THE WHOLE RESPONSE INTO apply_preset. apply_preset has FRESH-BUILD CLEARING semantics: unlisted slots clear to none, unlisted scenes reset to defaults. Round-tripping the snapshot would reset scenes 2..N and drop routing. For read-mutate-write, use set_param / set_params for the specific knobs you changed.',
      'TO CLONE A SLOT INTO apply_preset. With include_channel_state:true, copy {slot, block_type, instance, params} from a snapshot entry and drop channel_status. The shape is otherwise compatible with PresetSlotSpec.',
      'POST-WRITE VALIDATION. After set_param / set_params / apply_preset, call get_preset again and diff against your intent on the slots and params you actually wrote. Catches type-gated params that silently no-op (wire ack does not mean audible change).',
      'CAPABILITY GATE. describe_device(port).capabilities.atomic_read is true when this tool is supported, false otherwise.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      include_channel_state: z.boolean().optional().describe(
        'When true, read each channel-bearing block\'s active channel via an extra SysEx round-trip per block (~50 ms each) so params nest under the active channel key. Default false (faster inspection).',
      ),
    },
  }, async ({ port, include_channel_state }) => {
    try {
      const result = await executeGetPreset({ port, include_channel_state });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('apply_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Build a fresh preset in one structured call (replaces a sequence of set_block + set_param + switch_scene). REPLACES the working-buffer layout. For "just tweak the reverb" use set_param instead.',
      'Call describe_device({port}) once per session first to load device-specific idioms (channel/scene model, iconic-amp enum strings, applicability gates).',
      'Three modes by the user\'s save-intent language:',
      '- No target_location: audition at the current location. Reversible by switching presets.',
      '- target_location, save_authorized=false (default): switch + apply at target, no save. Use for "build a Mesa at G02" (named location, no save vocab). THIS IS THE DEFAULT FOR "build at <loc>" PROMPTS.',
      '- target_location, save_authorized=true: switch + apply + SAVE. DESTRUCTIVE. Use ONLY for explicit save vocab ("save as A01", "store on M03", "keep on B02"). For save mode, run scan_locations on the target FIRST and surface what would be overwritten before invoking with save_authorized=true.',
      'PRESET SHAPE BY EXAMPLE. Clone one of these two literals and swap in the user\'s tone-shape words. For the canonical, current per-device template (matching block names, enum values, channel keys, slot shape), call describe_device(port).example_spec.',
      'Axe-Fx II (grid device, X/Y channels): {"slots":[{"slot":{"row":2,"col":1},"block_type":"drive","params":{"X":{"effect_type":"TUBE DRV 3-KNOB","gain":3,"tone":6,"volume":5}}},{"slot":{"row":2,"col":2},"block_type":"amp","params":{"X":{"effect_type":"USA CLEAN","input_drive":3,"master_volume":5},"Y":{"effect_type":"USA IIC+","input_drive":6,"master_volume":4}}},{"slot":{"row":2,"col":3},"block_type":"cab"},{"slot":{"row":2,"col":4},"block_type":"reverb","params":{"X":{"effect_type":"MEDIUM PLATE","mix":25}}}],"scenes":[{"scene":1,"name":"Clean","channels":{"amp":"X","reverb":"X"},"bypassed":{"drive":true}},{"scene":2,"name":"Lead","channels":{"amp":"Y","reverb":"X"},"bypassed":{"drive":false}}],"landingScene":1}.',
      'AM4 (linear device, A/B/C/D channels, bare-int slot 1..4): {"slots":[{"slot":1,"block_type":"drive","params":{"A":{"type":"Tube Drive 3-Knob","drive":3,"tone":6,"level":5}}},{"slot":2,"block_type":"amp","params":{"A":{"type":"USA Pre Clean","gain":3,"master":5},"B":{"type":"USA MK IIC+","gain":6,"master":4}}},{"slot":3,"block_type":"reverb","params":{"A":{"type":"Hall, Medium","mix":25}}},{"slot":4,"block_type":"delay","params":{"A":{"type":"Digital Stereo","mix":15}}}],"scenes":[{"scene":1,"name":"Clean","channels":{"amp":"A","reverb":"A"},"bypassed":{"drive":true}},{"scene":2,"name":"Lead","channels":{"amp":"B","reverb":"A"},"bypassed":{"drive":false}}],"landingScene":1}.',
      'SLOT SHORTHAND (grid devices: Axe-Fx II / III): pass `"slot": 3` instead of `"slot": {"row": 2, "col": 3}`. The bare int auto-coerces to {row: 2, col: N} (row 2 is the audio-chain row, where most blocks live) and the coercion surfaces in validation_info[] so you learn the canonical shape. Only fall back to the explicit `{row, col}` form when you specifically need row 1 (top route) or row 3 (bottom route). AM4 always takes a bare int 1..4.',
      'PRESET SHAPE RULES (what the examples encode): slots[].params takes TWO shapes per slot. FLAT `{rate: 0.8}` for non-channel blocks. CHANNEL-NESTED `{A: {gain: 6}, D: {gain: 8}}` for channel blocks (AM4: amp/drive/reverb/delay; II/III: X/Y or A/B/C/D on every block). Mixing in one slot is rejected. scenes[] picks per-block channel + bypass per scene; it does NOT duplicate params.',
      'FRESH-BUILD CLEARING: unlisted slots become block_type="none"; unlisted scenes reset to defaults.',
      'SCENE NAMING: when the user asks for a song-specific tone ("build me Comfortably Numb", "apply Sultans"), name all available scenes with section roles (Verse / Chorus / Bridge / Solo or Intro / Main / Build / Solo) even when only one tonal variant is configured. Empty-string and default-number scene names ("Scene 2") are wasted on songs — meaningful names give the user a useful section structure to footswitch through. Pure rename, no extra wire writes beyond the per-scene name set.',
      'ENUM RECOVERY: ambiguous enum values come back with "Valid options: ..." listing exact candidates. Re-invoke with one verbatim; do NOT guess.',
      'TYPE-vs-KNOB SILENT NO-OP: many block.type values gate which knobs are exposed (Hall/Room/Chamber/Cloud reverb drop writes to `time`; non-master Marshalls drop `master`). The wire acks regardless. Pick proactively: call find_compatible_types({port, block, params:["time"]}) before apply_preset, choose a type from its result ("long hall reverb" → Plate/Echo/SFX, NOT a Hall variant). On apply_preset response, ALSO scan `validation_info[]` for `{level:"warning", dropped_param, retry_action}` entries — they name any knob the picked type silently no-op\'d so you can re-issue with a type that exposes it.',
      'CONCEPT-KEYS: param names accept either the device-local spelling OR a cross-device concept-key (e.g. `drive.output_level` works on II/AM4/III equivalently — it rewrites to `volume` on II, `level` on AM4/III). See describe_device(port).concept_keys for the per-device map. Concept-keys let one agent vocabulary cover every registered device; device-local names still work unchanged.',
      'LOUDNESS DISCIPLINE: enabling a drive on a solo scene adds ~3-9 dB of perceived volume depending on the pedal (TS-808 ~+6 dB, Klon ~+4 dB, RAT ~+9 dB, Big Muff ~+10 dB; see lookup_lineage drive entries for per-drive boost_response_dB). Compensate by lowering the Output 1 level on that scene by the same amount, or accept the solo will sit above the rhythm. Amp master_volume has its own per-amp sweet spot (clean platforms ~5-7, lead/high-gain ~2-3, non-master amps locked at 10) — pull from lookup_lineage amp entries when picking master, do not assume 5 is neutral.',
      'PERFORMANCE: ~1-3 s; add ~250 ms when target_location triggers a save.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      spec: presetShape.describe('Preset specification (slots, optional scenes, optional name).'),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target. With save_authorized=false (default): navigate + apply (audition, no save). With save_authorized=true: navigate + apply + save (destructive). Omit to apply at the current working-buffer location.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set true ONLY for explicit save vocab: "save", "store", "keep", "put on", "persist". AUDITION language (NOT save): "build a preset at X", "make me a tone on X", "design a preset at X", "make X look/sound like Y". State descriptions ("I want X to be Z") are audition unless save vocab is added. When ambiguous, audition (false) and ASK before saving; saves are destructive, auditions are reversible by switching presets.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
      verify_chain: z.boolean().optional().describe(
        'When true, run a read-after-write chain integrity check after the apply ops ack. On grid devices (Axe-Fx II / III) the check reads the working-buffer grid and surfaces any cell past col 1 with `routing_mask == 0` (broken cable, signal won\'t flow). On linear devices (AM4) and synths (Hydrasynth) the check returns a trivial pass since they have no chain-routing semantics. Use when you need certainty the preset will produce sound before the user plugs in. On a returned chain_break, surface the broken cells to the user (with their row/col) BEFORE claiming the preset is ready to play. Adds ~50-100 ms per call on grid devices.',
      ),
    },
  }, async ({ port, spec, target_location, save_authorized, on_active_preset_edited, verify_chain }) => {
    try {
      const result = await executeApplyPreset({
        port,
        spec: spec as PresetSpec,
        target_location,
        save_authorized,
        on_active_preset_edited,
        verify_chain,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('apply_setlist', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'DESTRUCTIVE: bulk switch + apply + save per entry across a list. Use when the user has a fully-specified setlist plan up front. For creative per-song builds, prefer apply_preset in sequence so you can narrate progress.',
      'PRE-FLIGHT: call scan_locations across the target range first and surface what would be overwritten. Silent overwrites are the worst failure mode here.',
      '- on_error: "stop" (default) halts on first failure; "continue" logs and proceeds.',
      '- dry_run=true: validate every entry, send no wire bytes.',
      '- verify (default true): name read-back per entry; mismatch flips entry to error.',
      '- Performance: ~3-5 s per entry. 15 entries = ~1 minute. Frame as "load before the show", not between songs.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      entries: z.array(z.object({
        location: z.union([z.string(), z.number()]),
        spec: presetShape,
      })).min(1).max(26).describe(
        '1..26 setlist entries. Each entry pairs a target location with a preset spec. Locations must be unique within the batch.',
      ),
      on_error: z.enum(['stop', 'continue']).optional(),
      dry_run: z.boolean().optional(),
      verify: z.boolean().optional(),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
    },
  }, async ({ port, entries, on_error, dry_run, verify, on_active_preset_edited }) => {
    try {
      const result = await executeApplySetlist({
        port,
        entries: entries.map((e: { location: string | number; spec: unknown }) => ({
          location: e.location,
          spec: e.spec as PresetSpec,
        })),
        options: { on_error, dry_run, verify },
        on_active_preset_edited,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('port_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Translate a Fractal preset from one device to a sibling device (AM4 / Axe-Fx II / III).',
      'Translation covers chain topology, block availability (II/III cab vs AM4 integrated), param-name aliases (drive.volume ↔ drive.level), enum mappings (USA IIC+ ↔ USA MK IIC+), and scene/channel cardinality (AM4 4×4 ↔ II 8×2 ↔ III 8×4). Modifier wiring is deferred.',
      'Three modes mirror apply_preset:',
      '- dry_run=true OR no target_location: translator-only preview. No wire ops. Use first to inspect warnings.',
      '- target_location, save_authorized=false: translate + audition at target. Reversible.',
      '- target_location, save_authorized=true: translate + apply + SAVE. DESTRUCTIVE. Explicit save vocab only.',
      'Caller passes `source_spec` explicitly (v1 doesn\'t read from the source device). Construct it via get_block_layout / get_params, or reuse a prior apply_preset spec.',
      'Returns {ok, port_summary, applied_spec, warnings, apply_result?}. Performance: ~5 ms translator + ~1-3 s apply when target_location is set.',
    ].join(' '),
    inputSchema: {
      source_port: z.string().describe(`Source device port (the preset's home device). ${PORT_DESC}`),
      source_spec: presetShape.describe('Source preset specification (slots, optional scenes, optional name) in the SOURCE device\'s vocabulary. Param names + enum strings should match what the source device accepts; the translator handles the cross-device rewrite.'),
      target_port: z.string().describe(`Target device port (where the translated preset lands). Must differ from source_port. ${PORT_DESC}`),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target on the target device. Omit (or pass dry_run=true) to get just the translated spec back without firing any wire op. Set to a location for mode-2 (audition) or mode-3 (save with save_authorized=true).',
      ),
      dry_run: z.boolean().optional().describe(
        'When true, returns the translated spec + summary without applying. Default false. Always-true effective when target_location is omitted.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set to true ONLY when the user used explicit save-language. See apply_preset.save_authorized for the full rules; the same anti-patterns apply here.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
    },
  }, async ({ source_port, source_spec, target_port, target_location, dry_run, save_authorized, on_active_preset_edited }) => {
    try {
      const result = await executePortPreset({
        source_port,
        source_spec: source_spec as PresetSpec,
        target_port,
        target_location,
        dry_run,
        save_authorized,
        on_active_preset_edited,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('restore_defaults', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'DESTRUCTIVE: reset preset locations to factory state. Overwrites user content with no working-buffer recovery. Always run scan_locations first and get explicit user approval before clobbering non-empty slots.',
      'Two shapes: pass only `from` for one location; pass `from` + `to` for an inclusive range (max 26 per call).',
      '- Working buffer + active location pointer untouched; the user can keep playing while the restore runs.',
      '- Range options: on_error stop/continue, dry_run, verify (default true; empty post-restore name is a hard fail).',
      '- Performance: ~350 ms per location. 20 slots = ~5-7 s.',
      '- See describe_device.capabilities.supports_factory_restore.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      from: z.union([z.string(), z.number()]).describe(
        'Single target, or inclusive start of a range (e.g. "G01" or 24).',
      ),
      to: z.union([z.string(), z.number()]).optional().describe(
        'Inclusive end of a range. Omit for single-location restore.',
      ),
      on_error: z.enum(['stop', 'continue']).optional().describe(
        'Range only. "stop" (default) halts on first error; "continue" logs and proceeds.',
      ),
      dry_run: z.boolean().optional().describe(
        'Range only. Validate without sending any wire bytes.',
      ),
      verify: z.boolean().optional().describe(
        'Read name pre/post and compare. Default true.',
      ),
    },
  }, async ({ port, from, to, on_error, dry_run, verify }) => {
    try {
      const result = await executeRestoreDefaults({ port, from, to, on_error, dry_run, verify });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });
}
