/**
 * Hydrasynth agent-regression cases.
 *
 * Hydrasynth surfaces two parameter paths:
 *   - `hydra_set_param`: System CCs only (master vol, sustain, etc.)
 *   - unified `set_param({port:'hydrasynth', block, name, value})`: engine
 *     parameters via NRPN (Param TX/RX = NRPN precondition; see the
 *     descriptor's agent_guidance).
 *
 * The lead case exercises `hydra_set_param` against a System CC
 * (master_volume). System CCs are always-on regardless of Param TX/RX,
 * so this is the most predictable smoke test of the Hydra surface.
 * The second case targets the unified NRPN path for engine knobs.
 */

import type { AgentRegressionCase } from './types.js';

export const HYDRASYNTH_CASES: AgentRegressionCase[] = [
  // System CC write: set_system_param against master_volume ─────────
  // STALE-CASE REWRITE 2026-06-10: the legacy hydra_set_param tool no
  // longer exists (surface migrated to unified tools); the case
  // demanded a nonexistent tool and failed every post-migration run.
  {
    id: 'hydrasynth-system-cc-master-volume',
    device: 'hydrasynth',

    description: 'System CC: agent should call set_system_param for master volume. System CCs are always-on regardless of Param TX/RX mode, so this is the most predictable Hydrasynth smoke. Catches the regression where the agent reaches for an engine-param NRPN write for a System CC (wrong path, requires a CC-mode precondition the System CC does not need).',
    prompt: "Set the master volume on the Hydrasynth to 100.",
    expectations: {
      must_call: ['set_system_param'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'set_system_param',
        check: (args) => {
          if (args.id !== 'system.master_volume') {
            return `set_system_param id should be "system.master_volume", got ${JSON.stringify(args.id)}.`;
          }
          if (args.value !== 100) {
            return `set_system_param value should be 100, got ${JSON.stringify(args.value)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },

  // §2 discovery: describe_device routes correctly for Hydrasynth ───
  {
    id: 'hydrasynth-discovery-describe',
    device: 'hydrasynth',
    disabled: true,  // Retired: cross-device duplicate of meta-discovery pattern.
    description: 'Discovery: "What can the Hydrasynth do?" should call describe_device({port:"hydrasynth"}). Catches the regression where the agent fabricates Hydrasynth specs from training data instead of consulting the descriptors agent_guidance (which carries the Param TX/RX precondition, smushed-lowercase NRPN naming, etc.).',
    prompt: 'What can the Hydrasynth do? Tell me how I would change a filter cutoff and whether there is any precondition I should set first.',
    expectations: {
      must_call: ['describe_device'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'describe_device',
        check: (args) => {
          const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
          if (!port.includes('hydra')) {
            return `describe_device port should target hydrasynth, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      // Hydrasynth has no MIDI-exposed dirty signal: catches an agent
      // that imports the AM4 buffer-fingerprint workflow vocabulary.
      text_not_contains: ['buffer fingerprint', 'fingerprint check'],
      max_wall_seconds: 60,
    },
  },

  // Macro write: set_macro for patch-defined controls ───────────────
  // STALE-CASE REWRITE 2026-06-10: hydra_set_macro no longer exists
  // (unified set_macro replaced it); the case demanded a nonexistent
  // tool and failed every post-migration run.
  {
    id: 'hydrasynth-macro-set',
    device: 'hydrasynth',

    description: 'Macros: agent should call set_macro when the user names a macro by number (Macro 1..8 are CCs 16..23, patch-defined). Catches the regression where the agent fires raw CC bytes via a different tool.',
    prompt: "Set Macro 1 to 64 on the Hydrasynth.",
    expectations: {
      must_call: ['set_macro'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'set_macro',
        check: (args) => {
          if (args.macro !== 1) {
            return `set_macro macro should be 1, got ${JSON.stringify(args.macro)}.`;
          }
          if (args.value !== 64) {
            return `set_macro value should be 64, got ${JSON.stringify(args.value)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },

  // Recipe apply: apply_patch({recipe_id}) for a named patch archetype ─
  {
    id: 'hydrasynth-recipe-apply',
    device: 'hydrasynth',

    description: 'Patch recipes: when the user names a recipe (or asks for a category tone the recipes cover), the agent should apply it via apply_patch({recipe_id}), NOT author 15 params by hand. Catches the regression where the recipe_id surface is ignored. Every registered recipe is listed in describe_device and apply_patch resolves any valid recipe_id by name.',
    prompt: "Load the warm_analog_pad recipe onto the Hydrasynth (just audition it, don't save).",
    expectations: {
      must_call: ['apply_patch'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'apply_patch',
        check: (args) => {
          if (args.recipe_id !== 'warm_analog_pad') {
            return `apply_patch recipe_id should be "warm_analog_pad", got ${JSON.stringify(args.recipe_id)}.`;
          }
          if (args.save === true) {
            return `apply_patch must not save on an audition request (save was true).`;
          }
          return true;
        },
      }],
      max_wall_seconds: 90,
    },
  },

  // ── Large coverage: patch recipe + macro + system param ───────────────────
  {
    id: 'hydrasynth-archetype-patch-macro-system',
    device: 'hydrasynth',
    description:
      'Synth archetype, large coverage: a multi-step "set up a pad, wire a macro, set the master volume" request should walk the synth surface — apply_patch (load the warm_analog_pad recipe, auditioned not saved), set_macro (a performance macro), and set_system_param (master volume, a global CC). All three are mock-supported (per the per-tool hydra cases) and clearly induced by the explicit prompt. Catches an agent that hand-authors 15 params instead of using the recipe, or saves an audition.',
    // "set macro 1 to 64" (concrete value) not a bare "set macro 1": the vague
    // form is under-specified (set it to WHAT?), so the agent skipped set_macro
    // on attempt 1 and only added it on retry (the 100%-flake the review caught).
    prompt:
      'Set up my Hydrasynth for a warm pad: load the warm_analog_pad patch (just audition it, do not save), set macro 1 to 64, and turn the master volume up to 100. Summarize what you did.',
    expectations: {
      must_call: ['apply_patch', 'set_macro', 'set_system_param'],
      max_tools: 9,
      min_tools: 3,
      tool_call_validators: [{
        tool: 'apply_patch',
        check: (args) => {
          if (args.recipe_id !== 'warm_analog_pad') return `apply_patch recipe_id should be "warm_analog_pad", got ${JSON.stringify(args.recipe_id)}.`;
          if (args.save === true) return 'apply_patch must not save on an audition request.';
          return true;
        },
      }],
      max_wall_seconds: 180,
    },
  },

  // ── Coverage: init_patch (start from a blank init buffer) ──────────────────
  {
    id: 'hydrasynth-init-patch',
    device: 'hydrasynth',
    description: 'init_patch coverage: "reset to a clean init patch / start from scratch" should route to init_patch (loads the Hydrasynth init buffer), NOT apply_patch with a recipe or a hand-authored spec. init_patch had no agent-sweep coverage. Catches an agent that conflates "start from init" with loading a named patch.',
    prompt: 'Reset my Hydrasynth to a clean init patch so I can start building a sound from scratch. Just load the init patch, do not save.',
    expectations: {
      must_call: ['init_patch'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'init_patch',
        check: (args) => {
          // Lenient: the agent may omit `port` (single Hydrasynth → implicit
          // routing); only a port that's explicitly the WRONG device is a fail.
          // must_call: ['init_patch'] is the actual coverage assertion.
          if (typeof args.port === 'string' && args.port.trim() !== '' && !/hydra/i.test(args.port)) {
            return `init_patch port, when given, should target the Hydrasynth, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      // No false-confidence about persisting an init.
      text_not_contains: ['I saved', 'saved the init', 'init patch is saved'],
      max_wall_seconds: 90,
    },
  },
];
