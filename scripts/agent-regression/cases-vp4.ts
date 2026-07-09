/**
 * Fractal VP4 agent-regression cases.
 *
 * The VP4 (model byte 0x14) is the gen-3 family's GATED member: reads work,
 * but only `set_param`/`set_params` (CONTINUOUS knobs, raw 0..65534 wire
 * value), `set_bypass`, and `save_preset` are on the `write_allowlist`.
 * Every other write (`set_block` / `apply_preset` / `switch_scene` /
 * `switch_preset` / `rename`) refuses with `capability_not_supported`
 * (`writes_gated: true` in packages/fractal-gen3/src/configs/vp4.ts).
 *
 * Its value as a sweep device is exactly that asymmetry: the cases below
 * prove the agent (a) dispatches port "vp4" to the VP4 descriptor, (b) uses
 * the allowlisted continuous write path, and (c) SURFACES a gate refusal to
 * the user instead of hallucinating success or working around it with raw
 * MIDI primitives.
 *
 * Mock transport: the VP4 connector short-circuits to a no-inbound mock
 * (`noInboundResponder` in packages/fractal-gen3/src/midi.ts), so writes are
 * accepted fire-and-forget and come back `sent-but-unconfirmed` — which is
 * also the honest real-hardware envelope for this community-beta device.
 * Gated ops refuse at the dispatcher before any wire I/O, so every case here
 * runs cleanly with NO hardware attached.
 */

import type { AgentRegressionCase } from './types.js';

export const VP4_CASES: AgentRegressionCase[] = [
  // §1 Introspection sanity — describe_device + list_params dispatch ────────
  {
    id: 'vp4-describe-and-list-params',
    device: 'vp4',
    description:
      'Introspection sanity: "what is on my VP4\'s reverb block" should route port "vp4" to ' +
      'the VP4 descriptor (AM4-shape serial 4-slot pedal, no amp/cab) and answer from ' +
      'describe_device / list_params without attempting any write. Catches mis-dispatch to ' +
      'the III/AM4 catch-all and catches an agent that starts editing when only asked to look.',
    prompt:
      'What is my VP4 and which parameters can you control on its reverb block? ' +
      "Just tell me — don't change anything.",
    expectations: {
      must_call: ['list_params'],
      must_not_call: ['set_param', 'set_params', 'apply_preset', 'set_block', 'save_preset', 'switch_scene'],
      max_tools: 6,
      tool_call_validators: [
        {
          tool: 'list_params',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('vp4') && !port.includes('vp-4') && !port.includes('vp 4')) {
              return `list_params port should target the VP4, got ${String(args.port)}`;
            }
            return true;
          },
        },
      ],
      // The VP4 has no amp/cab — the agent must not describe it as an amp modeler.
      text_not_contains: ['amp model', 'cab block', 'I set', 'I changed'],
      max_wall_seconds: 120,
    },
  },

  // §2 Allowlisted continuous set_param — honest unconfirmed reporting ──────
  {
    id: 'vp4-continuous-set-param-unconfirmed',
    device: 'vp4',
    description:
      'Allowlisted write path: a continuous-knob set_param on the VP4 goes through (raw wire ' +
      'value, community-beta). The mock (like real gated-era hardware) returns ' +
      'sent-but-unconfirmed, so the agent must report the write as sent/unverified and point ' +
      'at the front panel — NOT claim the value is confirmed on the device, and NOT save.',
    prompt:
      'On my VP4, raise the reverb mix — set it to raw wire value 20000. ' +
      "Don't save anything.",
    expectations: {
      must_call: ['set_param'],
      must_not_call: ['save_preset', 'switch_preset', 'set_block', 'apply_preset'],
      max_tools: 7,
      max_repeats: { set_param: 2 },
      tool_call_validators: [
        {
          tool: 'set_param',
          call_index: 'last',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('vp4') && !port.includes('vp-4') && !port.includes('vp 4')) {
              return `set_param port should target the VP4, got ${String(args.port)}`;
            }
            if (args.block !== 'reverb') {
              return `set_param block should be "reverb", got ${JSON.stringify(args.block)}`;
            }
            if (typeof args.value !== 'number') {
              return `set_param value should be a numeric raw wire value, got ${JSON.stringify(args.value)}`;
            }
            return true;
          },
        },
      ],
      // The write is sent-but-unconfirmed: the agent should surface that honestly.
      text_contains_any: [['unconfirmed'], ['not confirmed'], ['unverified'], ['front panel'], ['confirm']],
      text_not_contains: [
        'confirmed on the device', 'verified on the device',
        'I saved', 'now saved', 'persisted',
      ],
      max_wall_seconds: 150,
    },
  },

  // §3 Gated op — switch_scene must surface the refusal, not fake success ───
  {
    id: 'vp4-gated-switch-scene-refusal',
    device: 'vp4',
    description:
      'Gate honesty: switch_scene is GATED on the VP4 (value↔scene mapping undecoded) and ' +
      'refuses with capability_not_supported. The agent must surface that refusal to the user ' +
      '— not claim the scene changed, and not work around the gate with raw MIDI primitives ' +
      '(send_cc / send_program_change / send_sysex). Reading describe_device and reporting the ' +
      'gate without firing switch_scene is an equally honest path.',
    prompt: 'Switch my VP4 to scene 2.',
    expectations: {
      // Either the agent tries switch_scene and relays the refusal, or it reads
      // describe_device, sees the gate, and reports it without a doomed call.
      must_call_any: [['switch_scene'], ['describe_device']],
      must_not_call: ['send_cc', 'send_program_change', 'send_sysex', 'set_param', 'apply_preset', 'save_preset'],
      max_tools: 5,
      max_repeats: { switch_scene: 1 },
      // The refusal must reach the user in some form.
      text_contains_any: [
        ['gated'], ['not supported'], ['unsupported'], ['refus'],
        ["can't switch"], ['cannot switch'], ['not able to switch'],
        ['undecoded'], ['not yet'],
      ],
      // The agent must NOT hallucinate success.
      text_not_contains: [
        'switched to scene 2', 'now on scene 2', 'scene 2 is active',
        'scene 2 is now', 'I switched',
      ],
      max_wall_seconds: 120,
    },
  },
];
