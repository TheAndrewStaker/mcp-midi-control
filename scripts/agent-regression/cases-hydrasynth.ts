/**
 * Hydrasynth agent-regression cases.
 *
 * Hydrasynth surfaces two parameter paths:
 *   - `hydra_set_param`  — System CCs only (master vol, sustain, etc.)
 *   - unified `set_param({port:'hydrasynth', block, name, value})` — engine
 *     parameters via NRPN (Param TX/RX = NRPN precondition; see the
 *     descriptor's agent_guidance).
 *
 * The lead case exercises `hydra_set_param` against a System CC
 * (master_volume) — System CCs are always-on regardless of Param TX/RX,
 * so this is the most predictable smoke test of the Hydra surface.
 * The second case targets the unified NRPN path for engine knobs.
 */

import type { AgentRegressionCase } from './types.js';

export const HYDRASYNTH_CASES: AgentRegressionCase[] = [
  // System CC write — hydra_set_param against master_volume ──────────
  {
    id: 'hydrasynth-system-cc-master-volume',
    device: 'hydrasynth',
    tier: 'hardware',
    description: 'System CC — agent should call hydra_set_param for master volume. System CCs are always-on regardless of Param TX/RX mode, so this is the most predictable Hydrasynth smoke. Catches the regression where the agent reaches for hydra_set_engine_param / NRPN for a System CC (wrong tool, slower path, requires a CC-mode precondition the System CC doesnt need).',
    prompt: "Set the master volume on the Hydrasynth to 100.",
    expectations: {
      must_call: ['hydra_set_param'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'hydra_set_param',
        check: (args) => {
          if (args.id !== 'system.master_volume') {
            return `hydra_set_param id should be "system.master_volume", got ${JSON.stringify(args.id)}.`;
          }
          if (args.value !== 100) {
            return `hydra_set_param value should be 100, got ${JSON.stringify(args.value)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },

  // §2 discovery — describe_device routes correctly for Hydrasynth ───
  {
    id: 'hydrasynth-discovery-describe',
    device: 'hydrasynth',
    tier: 'no-hardware',
    description: 'Discovery — "What can the Hydrasynth do?" should call describe_device({port:"hydrasynth"}). Catches the regression where the agent fabricates Hydrasynth specs from training data instead of consulting the descriptors agent_guidance (which carries the Param TX/RX precondition, smushed-lowercase NRPN naming, etc.).',
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
      // Hydrasynth has no MIDI-exposed dirty signal — catches an agent
      // that imports the AM4 buffer-fingerprint workflow vocabulary.
      text_not_contains: ['buffer fingerprint', 'fingerprint check'],
      max_wall_seconds: 60,
    },
  },

  // Macro write — hydra_set_macro for patch-defined controls ─────────
  {
    id: 'hydrasynth-macro-set',
    device: 'hydrasynth',
    tier: 'hardware',
    description: 'Macros — agent should call hydra_set_macro when the user names a macro by number (Macro 1..8 are CCs 16..23, patch-defined). Catches the regression where the agent fires raw CC bytes via a different tool.',
    prompt: "Set Macro 1 to 64 on the Hydrasynth.",
    expectations: {
      must_call: ['hydra_set_macro'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'hydra_set_macro',
        check: (args) => {
          if (args.macro !== 1) {
            return `hydra_set_macro macro should be 1, got ${JSON.stringify(args.macro)}.`;
          }
          if (args.value !== 64) {
            return `hydra_set_macro value should be 64, got ${JSON.stringify(args.value)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },
];
