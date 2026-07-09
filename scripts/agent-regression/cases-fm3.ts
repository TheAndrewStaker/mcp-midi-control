/**
 * FM3 agent-regression cases.
 *
 * The FM3 is the gen-3 family's most hardware-verified floor unit (2026-06-12
 * field test: serial transport, reads, continuous writes, bypass, scene, and
 * the sub=0x27 preset switch, end-to-end through this server; 2026-06-10
 * community session: discrete set-by-name via byte-identical frames). Its
 * value as a SEPARATE sweep device (beyond the FM9 sibling) is:
 *   - device DISPATCH: port "fm3" must route to the FM3 descriptor (model
 *     byte 0x11, FM3-true paramIds, the smaller 4×12 grid) and not fall
 *     through to the III/FM9/AM4;
 *   - preset switching: the FM3's CC32 bank-select path is hardware-FALSIFIED
 *     (fw 12.00 ignores CC32), so switch_preset routes over SysEx sub=0x27 —
 *     the agent-level assertion is that it uses the switch_preset VERB and
 *     never reaches for raw send_program_change / send_cc;
 *   - set-by-name: FM3 discrete set-by-name is hardware-confirmed, so the
 *     tool descriptions must not gate the agent into numeric-only writes.
 *
 * Mock transport: the FM3 connector synthesizes the gen-3 read burst
 * (`makeGen3BroadcastMockResponder({ modelByte: 0x11 })`), so read flows
 * complete without hardware. The USB-CDC serial fallback is a transport
 * detail below the tool surface; under mock the connector short-circuits
 * before any port (MIDI or serial) is touched, so these cases run cleanly
 * with NO hardware attached.
 */

import type { AgentRegressionCase } from './types.js';

export const FM3_CASES: AgentRegressionCase[] = [
  // §1 Tone build — dispatch + FM3-true catalog + named models ──────────────
  {
    id: 'fm3-named-tone-build',
    device: 'fm3',
    description:
      'FM3 tone build naming the amp/drive models by their real Fractal names. Proves port ' +
      '"fm3" dispatches to the FM3 descriptor (not the III/FM9/AM4 catch-all) and that ' +
      'set-by-name flows through — FM3 discrete set-by-name is hardware-confirmed, so the ' +
      'agent must not fall back to numeric-only writes or claim models cannot be named.',
    prompt:
      "On my FM3 working buffer, build a blues lead tone: a Texas Star Clean amp into a 4x12 " +
      "cab, with a Blues OD drive in front and a little reverb. Don't save it.",
    expectations: {
      must_call: ['describe_device'],
      // A fresh build is apply_preset's job, but accept a place-then-set path too.
      must_call_any: [['apply_preset'], ['set_block']],
      max_tools: 16,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [
        {
          tool: 'apply_preset',
          call_index: 0,
          optional: true,
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('fm3') && !port.includes('fm-3') && !port.includes('fm 3')) {
              return `apply_preset port should target the FM3, got ${String(args.port)}`;
            }
            const spec = (args.spec ?? {}) as { slots?: unknown[] };
            const slots = Array.isArray(spec.slots) ? spec.slots : [];
            const blob = JSON.stringify(slots).toLowerCase();
            const named = ['texas star clean', 'blues od'].filter((n) => blob.includes(n));
            if (named.length === 0) {
              return 'apply_preset spec carries no named amp/drive model; agent fell back to numeric (description may be underselling set-by-name).';
            }
            return true;
          },
        },
      ],
      // Underselling tells + save honesty.
      text_not_contains: [
        'numeric only', 'by number', "can't be named", 'cannot be named',
        'not settable by name', "can't set by name",
        'I saved', 'now saved to', 'now persisted to', 'now stored to',
      ],
      max_wall_seconds: 360,
    },
  },

  // §2 Read path — get_param over the mock broadcast responder ──────────────
  {
    id: 'fm3-read-amp-gain',
    device: 'fm3',
    description:
      'Read path: "what is the amp gain on my FM3" should call get_param({port:"fm3", ...}) ' +
      'and report the device value — the FM3 read leg is hardware-confirmed and the mock ' +
      'synthesizes the gen-3 broadcast burst, so the read completes. Catches an agent that ' +
      'deflects to the front panel, fabricates a number, or starts writing on a read request.',
    prompt: "What's the current amp gain on my FM3? Just read it, don't change anything.",
    expectations: {
      must_call: ['get_param'],
      must_not_call: ['set_param', 'set_params', 'apply_preset', 'set_block', 'save_preset'],
      max_tools: 6,
      tool_call_validators: [
        {
          tool: 'get_param',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('fm3') && !port.includes('fm-3') && !port.includes('fm 3')) {
              return `get_param port should target the FM3, got ${String(args.port)}`;
            }
            if (args.block !== 'amp') {
              return `get_param block should be "amp", got ${JSON.stringify(args.block)}`;
            }
            return true;
          },
        },
      ],
      text_not_contains: ["can't read", 'cannot read', 'no read-back', 'I saved'],
      max_wall_seconds: 150,
    },
  },

  // §3 Preset switch — the verb, not raw PC/CC (CC32 path is falsified) ─────
  {
    id: 'fm3-switch-preset-verb',
    device: 'fm3',
    description:
      'Preset switch: "load preset 100" must go through switch_preset (which routes over the ' +
      'FM3-hardware-confirmed SysEx sub=0x27 switch). The FM3 IGNORES CC32 bank select ' +
      '(hardware-falsified, fw 12.00), so an agent that hand-rolls send_program_change / ' +
      'send_cc lands on the wrong preset for any location ≥ 128. Catches raw-primitive ' +
      'workarounds and save-on-navigate.',
    prompt: 'Load preset 100 on my FM3.',
    expectations: {
      must_call: ['switch_preset'],
      must_not_call: ['send_program_change', 'send_cc', 'send_sysex', 'save_preset', 'apply_preset'],
      max_tools: 5,
      max_repeats: { switch_preset: 2 },
      tool_call_validators: [
        {
          tool: 'switch_preset',
          call_index: 'last',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('fm3') && !port.includes('fm-3') && !port.includes('fm 3')) {
              return `switch_preset port should target the FM3, got ${String(args.port)}`;
            }
            const loc = typeof args.location === 'string' ? Number(args.location) : args.location;
            if (loc !== 100) {
              return `switch_preset location should be 100, got ${JSON.stringify(args.location)}`;
            }
            return true;
          },
        },
      ],
      text_not_contains: ['I saved', 'now saved', 'persisted'],
      max_wall_seconds: 120,
    },
  },
];
