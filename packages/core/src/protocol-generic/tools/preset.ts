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
  server.registerTool('apply_preset', {
    description: [
      'Build a preset on a device in one call. Use this when the user is',
      'designing a fresh tone or applying a named preset concept — it replaces',
      'a sequence of set_block + set_param + switch_scene calls with one',
      'structured request.',
      'TWEAK vs FRESH: this tool REPLACES the working-buffer block layout. If',
      'the user says "tweak my current tone" or "just adjust the reverb", do',
      'NOT call apply_preset — call set_param or set_block for the targeted',
      'change. apply_preset is for fresh designs ("build me a clean tone",',
      '"design a Mesa rectifier preset").',
      'THREE MODES (pick by the user\'s save-intent language):',
      '  1. No target_location → audition at CURRENT location. Writes to the',
      '     working buffer where the user already is. Reversible by switching',
      '     presets. Use for "tweak my tone", "try this", "what about a Mesa".',
      '  2. target_location WITHOUT save_authorized=true → audition AT TARGET.',
      '     The tool checks for unsaved edits on the active preset (refusing',
      '     to navigate if dirty unless on_active_preset_edited="discard" or',
      '     "save_active_first"), then runs switch + apply at the target. NO',
      '     save. The build lives in the working buffer at the target location;',
      '     reversible by switching presets. Use for "build me a clean Fender',
      '     at Z04" or "design a Mesa preset on G02" — the user named a',
      '     location but did not use save-language. THIS IS THE DEFAULT FOR',
      '     "build at <loc>" PROMPTS.',
      '  3. target_location WITH save_authorized=true → switch + apply + SAVE.',
      '     Destructive. Persists to the target location, overwriting whatever',
      '     was there. Use ONLY when the user used explicit save-language:',
      '     "save this as A01", "store it on M03", "keep this and put it on',
      '     B02", "persist to Y04". Bare "build a preset at X" or "make me a',
      '     tone on X" is NOT save-language — use mode 2.',
      'PRESET SHAPE: slots[].params accepts TWO shapes per slot, picked by',
      'block. FLAT — `{rate: 0.8, depth: 35}` — for NON-channel blocks (AM4:',
      'filter, chorus, flanger, phaser, comp, geq, peq, tremolo, rotary, wah,',
      'enhancer, gate, volpan, ingate). CHANNEL-NESTED — `{A: {gain: 6}, D:',
      '{gain: 8}}` — for CHANNEL blocks (AM4: amp / drive / reverb / delay;',
      'Axe-Fx II/III: X/Y on every block). Mixing both shapes in one slot is',
      'rejected. Channel keys match describe_device.capabilities.channel_',
      'names. scenes[] picks per-block channel + bypass on each scene; it does',
      'not duplicate the params (channels hold the params, scenes pick which',
      'channel each block uses).',
      'FRESH-BUILD CLEARING: unlisted slots get block_type="none" and unlisted',
      'scenes are reset to defaults on every call.',
      'ENUM RECOVERY: when an enum value matches multiple variants (e.g.',
      '"Plexi 100W" matches Plexi 100W 1970 / Normal / High / Jumped on AM4),',
      'the response carries `Valid options: ...` listing the exact candidates.',
      'Re-invoke with one of them verbatim. Do NOT guess — pick from the list.',
      'TYPE-VS-KNOB COMPATIBILITY: many block `type` enum values gate which',
      'knobs are exposed. AM4 example: ALL Hall / Room / Chamber / Cloud',
      'reverb variants are FIXED-DECAY algorithms — they silently drop',
      'writes to `reverb.time`. Only Plate / Spring / Echo / SFX variants',
      'expose `time`. The wire write acks regardless, so the agent can\'t',
      'tell from the response that the decay didn\'t change — this is a',
      'silent-no-op trap, not a loud error. Same pattern on amp.type:',
      'real-circuit AC30 / non-master Marshall lineages have no `master`',
      'knob; writing it silently no-ops.',
      'If you plan to write a `type` enum AND a particular knob, do ONE of:',
      '  (a) call find_compatible_types({port, block, params: ["time"]}) and',
      '      pick a type from the returned subset — single round-trip, cleanest.',
      '  (b) call list_params({port, block, name: "time"}) and read the',
      '      `applies_only_when` field — names the types that expose this knob.',
      'NEVER pick a `type` based on the user\'s vocabulary alone when the user',
      'also names a knob. "Long hall reverb" → call find_compatible_types',
      'first, then pick Plate/Echo/SFX (NOT any Hall variant). "Vox AC30 with',
      'master at 5" → call find_compatible_types first, then pick an AC30',
      'lineage that exposes master (most don\'t — set amp.level instead).',
      'Skipping this step is the #1 cause of agents reporting "decay locked',
      'in" / "master set to 5" when the device actually ignored the write.',
      'CRITICAL — call describe_device({port}) ONCE at session start before',
      'apply_preset. Its `agent_guidance` field carries the device-specific',
      'tone-building idioms: AM4 channel/scene model (which blocks expose',
      'A/B/C/D channels, scene-as-bypass/channel-selector), Axe-Fx II X/Y',
      'channel pairs + 8-scene multi-scene authoring, Hydrasynth NRPN',
      'precondition (Param TX/RX mode), iconic-amp shortcuts table (Vox',
      'AC30, Plexi, Mesa Mark, etc. — the canonical enum strings), reverb /',
      'delay canonical-form conventions (`Room, Medium` not `Medium Room`),',
      'and the per-block applicability annotations that decide whether a',
      'param actually does anything. Skipping describe_device is the most',
      'common cause of "I built the tone but it doesn\'t sound right" —',
      'the agent used the wrong vocabulary or wrote a type-gated param on',
      'an incompatible amp model.',
      'PERFORMANCE: ~1-3 seconds wire time depending on slot/scene density.',
      'With target_location, add ~250 ms for the save.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      spec: presetShape.describe('Preset specification (slots, optional scenes, optional name).'),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target. With save_authorized=false (default), the tool navigates to the target and applies — audition mode, no save. With save_authorized=true, it also saves (destructive). Without target_location, the apply hits whatever location is currently active in the working buffer.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set to true ONLY when the user used explicit save-language: "save", "store", "keep", "put on", "persist", "commit to flash". ANTI-PATTERNS — these are AUDITION language, NOT save: "build a preset at X", "make me a tone on X", "design a preset at X", "I want X to have a copy of Y", "make X look/sound like Y", "create a [thing] based on [other thing] at X". State descriptions ("I want X to be Z") describe the desired end state, not whether to persist — interpret as audition unless the user adds save vocab. When ambiguous, audition (false) and ASK before saving — saves are destructive; auditions are reversible by switching presets. With target_location set: false = audition at target, true = save at target.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
      verify_chain: z.boolean().optional().describe(
        'When true, run a read-after-write chain integrity check after the apply ops ack. On grid devices (Axe-Fx II / III) the check reads the working-buffer grid and surfaces any cell past col 1 with `routing_mask == 0` (broken cable, signal won\'t flow). On linear devices (AM4) and synths (Hydrasynth) the check returns a trivial pass since they have no chain-routing semantics. Use when you need certainty the preset will produce sound before the user plugs in. Adds ~50-100 ms per call on grid devices.',
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
    description: [
      'Bulk-apply a setlist to the device. Each entry pairs a target location',
      'with a preset spec; the tool runs switch + apply + save per entry,',
      'with one shared inbound capture across the batch.',
      'WHEN TO USE: prefer this when the user has a fully-specified setlist',
      'plan ready up front (loaded from config, copied from prior notes).',
      'For CREATIVE batch builds where you decide blocks / scenes / tones',
      'per song from natural-language direction, prefer apply_preset with',
      'target_location in sequence (one call per preset, narrating progress',
      'between calls).',
      'PRE-FLIGHT SCAN: before bulk-applying into a range that may contain',
      'user-customised presets, call scan_locations and surface what would',
      'be overwritten. Silent overwrites are the worst failure mode for',
      'this workflow.',
      'PERFORMANCE: ~3-5 seconds per entry. A 15-entry setlist takes',
      '~1 minute wall time — frame it to the user as a "load before the',
      'show" workflow, not "load between songs".',
      'FAILURE SEMANTICS: on_error="stop" (default) halts immediately on',
      'first error; on_error="continue" logs each error and proceeds.',
      'DRY RUN: pass dry_run=true to validate every entry without sending',
      'wire bytes.',
      'VERIFY: by default each successful apply is followed by a name read-',
      'back; mismatches flip the entry to error. Pass verify=false only',
      'when the caller explicitly accepts silent-failure risk.',
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
    description: [
      'Translate a preset built for one Fractal device into an equivalent',
      'preset on another. The marquee cross-device feature: users with an',
      'existing preset library on one Fractal device get a one-call port',
      'to a sibling device.',
      'TRANSLATION COVERAGE: chain topology (AM4 4 linear slots ↔ Axe-Fx',
      'II/III grid), block availability (II/III separate cab block ↔',
      'AM4 integrated cab), parameter-name aliases (drive.volume ↔',
      'drive.level via BK-065), enum-value mapping (USA IIC+ ↔ USA MK',
      'IIC+ via BK-066 Phase 2 concept-key table — 67 high-confidence',
      'amp/drive/reverb mappings ship today), scene + channel cardinality',
      '(AM4 4 scenes × 4 channels ↔ II 8 × 2 ↔ III 8 × 4). Modifier wiring',
      '(BK-063, gated on capture work) is deferred — modifier-driven',
      'tones port as static positions; the user adds the wiring step',
      'manually.',
      'THREE MODES (mirrors apply_preset gating):',
      '  1. dry_run=true OR no target_location → translator-only.',
      '     Returns the translated spec + per-block warnings. No wire',
      '     ops on either device. Use this first to preview the port.',
      '  2. target_location WITHOUT save_authorized=true → translate +',
      '     audition at target. Translator runs, then apply_preset',
      '     navigates the target device and applies (no save).',
      '     Reversible by switching presets on the target.',
      '  3. target_location WITH save_authorized=true → translate +',
      '     apply + SAVE. Destructive. Use ONLY when the user used',
      '     explicit save-language ("save", "store", "keep", "put on").',
      'CALLER RESPONSIBILITY: this tool does NOT read the source preset',
      'from the source device — v1 takes an explicit source_spec from',
      'the caller. Construct source_spec via the existing read tools',
      '(get_block_layout, get_param, get_params) before calling, OR',
      'pass a spec the agent has in hand from a prior apply_preset.',
      'Reading-from-device source support is a v2 follow-up.',
      'OUTPUT: returns {ok, port_summary, applied_spec, warnings,',
      'apply_result?}. port_summary counts blocks_translated /',
      'blocks_dropped / params_aliased / enums_mapped / scene_collapses.',
      'warnings[] surfaces every non-fatal translation note (dropped',
      'channels, integrated-cab hints, scene overflow). applied_spec',
      'is the translated PresetSpec — agent can echo it back to the',
      'user, or feed it to apply_preset directly. apply_result is the',
      'standard apply_preset envelope when modes 2 or 3 ran.',
      'PERFORMANCE: ~5ms translator, plus ~1-3s apply time when',
      'target_location is set. Dry-run is wire-free, hardware not',
      'required.',
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
    description: [
      'Reset device preset locations to their factory state. Two shapes:',
      '  (a) single — pass only `from`: resets that one location.',
      '  (b) range — pass `from` AND `to`: resets every location from..to',
      '      inclusive (max 26 per call).',
      'DESTRUCTIVE: overwrites user-customised content with factory bytes,',
      'no recovery via the working buffer. Confirm with the user before',
      'calling on any non-empty location. For ranges, run scan_locations',
      'first and list the slots that would be wiped — get explicit "go"',
      'from the user before this call.',
      'Working buffer + active location pointer untouched; the user can',
      'keep playing through a different preset while the restore runs.',
      'PERFORMANCE: ~250 ms per location plus ~100 ms verify overhead.',
      'A 20-slot range takes ~5-7 seconds.',
      'VERIFICATION (default on): pre/post name comparison. Empty post-',
      'restore name is a hard fail; matching pre/post is a soft warning.',
      'See describe_device.capabilities.supports_factory_restore to gate',
      'this call.',
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
