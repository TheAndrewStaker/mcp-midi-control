/**
 * Axe-Fx III agent-regression cases.
 *
 * III has two parameter surfaces today: the unified `set_param` /
 * `get_param` (block + name) and the lower-level `axefx3_set_parameter`
 * / `axefx3_get_parameter` (raw paramId integers). Cases below target
 * the lower-level surface for SET_PARAMETER envelope coverage — the
 * fn=0x01 wire shape locked in Session 97 against 10 public captures.
 *
 * `axefx3_set_parameter` is the wire-level tool; the agent reaches for
 * it when the user names a raw paramId or when the unified set_param
 * fails to resolve a name. Both flows funnel through the same fn=0x01
 * builder, so a regression in the builder would surface here first.
 */

import type { AgentRegressionCase } from './types.js';

export const AXE_FX_III_CASES: AgentRegressionCase[] = [
  // SET_PARAMETER fn=0x01 envelope coverage (Session 97) ──────────────
  {
    id: 'axefx3-set-parameter-fn01-envelope',
    device: 'axe-fx-iii',
    tier: 'hardware',
    description: 'fn=0x01 SET_PARAMETER envelope — agent should reach for axefx3_set_parameter when the user gives a paramId integer. Asserts the call lands with the requested (block, param_id, value) tuple. The fn=0x01 sub-action 09 00 wire shape was locked Session 97 against 10 public captures; if the builder regresses, this case is the canary.',
    prompt: "On the Axe-Fx III, set parameter ID 0 on the AMP1 block to wire value 16384.",
    expectations: {
      must_call: ['axefx3_set_parameter'],
      max_tools: 5,
      tool_call_validators: [{
        tool: 'axefx3_set_parameter',
        check: (args) => {
          const block = typeof args.block === 'string' ? args.block.toUpperCase() : '';
          if (!block.includes('AMP1') && block !== 'AMP') {
            return `axefx3_set_parameter block should target AMP1, got ${String(args.block)}.`;
          }
          if (args.param_id !== 0) {
            return `axefx3_set_parameter param_id should be 0, got ${JSON.stringify(args.param_id)}.`;
          }
          if (args.value !== 16384) {
            return `axefx3_set_parameter value should be 16384 (wire 0..65534), got ${JSON.stringify(args.value)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 90,
    },
  },

  // GET_PARAMETER fn=0x01 envelope coverage ───────────────────────────
  {
    id: 'axefx3-get-parameter-fn01-envelope',
    device: 'axe-fx-iii',
    tier: 'hardware',
    description: 'fn=0x01 GET_PARAMETER envelope — agent should reach for axefx3_get_parameter for a raw paramId read. The GET response shape is still 🟡 unverified (per the SET_PARAMETER memory), so this case catches the agent calling the right tool with the right args; the runner records whatever wire response comes back without asserting on it.',
    prompt: "On the Axe-Fx III, read parameter ID 0 on the AMP1 block. Tell me the raw wire value.",
    expectations: {
      must_call: ['axefx3_get_parameter'],
      max_tools: 5,
      tool_call_validators: [{
        tool: 'axefx3_get_parameter',
        check: (args) => {
          const block = typeof args.block === 'string' ? args.block.toUpperCase() : '';
          if (!block.includes('AMP1') && block !== 'AMP') {
            return `axefx3_get_parameter block should target AMP1, got ${String(args.block)}.`;
          }
          if (args.param_id !== 0) {
            return `axefx3_get_parameter param_id should be 0, got ${JSON.stringify(args.param_id)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 90,
    },
  },

  // ── Bouncing-regression case (v0.1.0 install-test gap) ─────────
  //
  // Enter Sandman 4-scene on III — tests the III\'s unified apply_preset
  // surface + scene-overflow handling. III supports 8 scenes; we use 4
  // for parity with the AM4/II Enter Sandman cases. Asserts ≤ 1
  // apply_preset retry — Wave 1\'s slot auto-coerce, cross-device
  // aliasing, and enum-key resolver are exercised end-to-end.
  {
    id: 'axefx3-enter-sandman-4scene',
    device: 'axe-fx-iii',
    tier: 'hardware',
    description: 'Enter Sandman across 4 scenes on Axe-Fx III. Bouncing-regression — exercises the III\'s grid auto-coerce + 4-channel surface. Wave 1 fixes should land the build in ≤ 1 apply_preset retry. Verifies 4 scenes, a placed amp + drive, sensible audio levels.',
    prompt: "Build me Enter Sandman across 4 scenes on the Axe-Fx III. Scene 1 clean intro, scene 2 chugging rhythm on a high-gain amp, scene 3 verse loud, scene 4 lead solo. Use the working buffer, don\'t save. Make every scene audible.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const spec = (args.spec ?? {}) as { scenes?: unknown; slots?: unknown[] };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) {
            return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          }
          // Sanity: an amp must be placed. Empty-slots multi-scene
          // builds are a silent-no-op regression.
          const hasAmp = Array.isArray(spec.slots) && spec.slots.some((s) => {
            return s !== null && typeof s === 'object' && (s as { block_type?: string }).block_type === 'amp';
          });
          if (!hasAmp) {
            return `apply_preset spec is missing an amp slot — 4-scene Enter Sandman without an amp is a silent-no-op regression.`;
          }
          return true;
        },
      }],
      text_not_contains: ['saved to', 'persisted to', 'stored to'],
      max_wall_seconds: 240,
    },
  },

  // §2 discovery — describe_device routes correctly for III
  {
    id: 'axefx3-discovery-describe',
    device: 'axe-fx-iii',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: cross-device duplicate of meta-discovery pattern; III lacks any hardware-tier case to exercise the surface anyway.
    description: 'Discovery — "What can the Axe-Fx III do?" should call describe_device({port:"axe-fx-iii"}). Catches the regression where the agent fabricates III specs from training data without consulting the descriptor.',
    prompt: 'What can the Axe-Fx III do? Tell me which blocks it has and how many scenes per preset.',
    expectations: {
      must_call: ['describe_device'],
      max_tools: 3,
      tool_call_validators: [{
        tool: 'describe_device',
        check: (args) => {
          const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
          if (!port.includes('iii') && !port.includes('axefx3') && !port.includes('axe-fx-iii')) {
            return `describe_device port should target axe-fx-iii, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },
];
