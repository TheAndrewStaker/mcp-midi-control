/**
 * Boss VE-500 Vocal Performer agent-regression cases.
 *
 * The VE-500 is the tree's first Roland address-based SysEx device
 * (packages/ve-500, codec in roland-midi). Its shipped surface:
 * set_param / set_params / get_param / set_bypass / apply_preset over
 * DT1/RQ1, switch_preset for user memories U01–U99 via a BARE Program
 * Change (hardware-confirmed 2026-06-28 — a prepended Bank Select makes
 * the unit IGNORE the recall, so none is sent), and save_preset (store
 * the edit buffer to a user memory, decoded from the editor's own
 * command.write). Preset-bank P01–P50 recall (2026-07-09) sends a DT1
 * write to the "Current Patch Number" register instead of a Program
 * Change; decoded from the editor's own patch-switch handler, not yet
 * hardware-confirmed (community-beta).
 *
 * These cases prove device DISPATCH (port "ve-500" routes to the Roland
 * descriptor, not any Fractal pattern) and that the agent uses the
 * unified verbs (switch_preset / apply_preset) rather than raw MIDI
 * primitives (send_program_change / send_sysex).
 *
 * Mock transport: the VE-500 has no device-specific mock factory, so under
 * MCP_MOCK_TRANSPORT=1 its generic connect() falls back to the shared
 * fire-and-forget mock (packages/core/src/midi/transport.ts). Every write
 * path exercised here is fire-and-forget on real hardware too (the VE-500
 * does not echo DT1 or PC), so the mock envelope matches the real one and
 * the cases run cleanly with NO hardware attached.
 *
 * WHY THERE IS NO CASE FOR THE PC-IN REFUSAL, and why that is not an
 * oversight. User-memory recall now pre-flight reads the unit's MIDI
 * Program Change IN switch and refuses when it is off, because the unit
 * ignores a Program Change in that state and never says so (see
 * packages/ve-500/src/descriptor/writer.ts). The obvious case to add is
 * "the agent must not work around the refusal by turning PC IN on itself".
 * It cannot be written here: the shared mock answers no reads, so the
 * pre-flight resolves to "unreadable", the recall is sent with an
 * unverified warning, and the refusal never fires. A case that asserts
 * behaviour on a branch the harness cannot reach tests nothing while
 * looking like coverage. The refusal is covered deterministically in
 * scripts/verify-ve500.ts section 12, including a guard that the recall
 * guidance tells an agent not to flip the setting. Revisit this if the
 * VE-500 ever gets a responding mock factory. The `must_not_call` list on
 * the recall case below already includes `set_param`, so the workaround
 * would fail the case if the branch ever became reachable.
 */

import type { AgentRegressionCase } from './types.js';

export const VE500_CASES: AgentRegressionCase[] = [
  // §1 switch_preset — user-memory recall via the device verb ───────────────
  {
    id: 've500-switch-preset-user-memory',
    device: 've-500',
    description:
      'User-memory recall flow: "recall memory 12" should call switch_preset({port:"ve-500", ' +
      'location}) — the descriptor sends the hardware-confirmed BARE Program Change. Catches ' +
      'an agent that reaches for send_program_change (bypassing the U/P gating and the ' +
      'no-Bank-Select rule) or tries to save/edit when only asked to recall.',
    prompt: 'Recall user memory 12 on my VE-500.',
    expectations: {
      must_call: ['switch_preset'],
      must_not_call: ['send_program_change', 'send_cc', 'send_sysex', 'save_preset', 'apply_preset', 'set_param'],
      max_tools: 5,
      max_repeats: { switch_preset: 1 },
      tool_call_validators: [
        {
          tool: 'switch_preset',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('ve-500') && !port.includes('ve500') && !port.includes('ve 500')) {
              return `switch_preset port should target the VE-500, got ${String(args.port)}`;
            }
            // Accept U12, "12", or 12 — the writer normalizes all three.
            const loc = String(args.location ?? '').toUpperCase().replace(/^U0*/, '').replace(/^0+/, '');
            if (loc !== '12') {
              return `switch_preset location should resolve to user memory 12, got ${JSON.stringify(args.location)}`;
            }
            return true;
          },
        },
      ],
      // Must not hallucinate a factory-preset (P-bank) recall or a save.
      text_not_contains: ['P12', 'I saved', 'now saved', 'stored to memory'],
      max_wall_seconds: 90,
    },
  },

  // §2 apply_preset — build a vocal chain into the active buffer ────────────
  {
    id: 've500-apply-vocal-chain',
    device: 've-500',
    description:
      'Whole-patch build: a "set up a lead vocal chain" request should use apply_preset (or ' +
      'the set_params primitive path) against the VE-500\'s fixed effect sections — and must ' +
      'NOT call save_preset (the user said don\'t store it) or claim the result is stored. ' +
      'Proves the layout archetype dispatch + the working-buffer honesty posture on a device ' +
      'whose WRITE button is the persistence step.',
    prompt:
      'Set up a lead vocal sound on my VE-500: gentle pitch correction, a harmony a third up, ' +
      "and a hall reverb. Don't store it to a memory — I'll audition it first.",
    expectations: {
      // apply_preset is the natural path; accept the primitive-equivalent too.
      must_call_any: [['apply_preset'], ['set_params'], ['set_param']],
      must_not_call: ['save_preset', 'switch_preset', 'send_sysex'],
      max_tools: 10,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [
        {
          tool: 'apply_preset',
          call_index: 'last',
          optional: true,
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('ve-500') && !port.includes('ve500') && !port.includes('ve 500')) {
              return `apply_preset port should target the VE-500, got ${String(args.port)}`;
            }
            const spec = (args.spec ?? {}) as { slots?: unknown[] };
            const blob = JSON.stringify(spec.slots ?? []).toLowerCase();
            const touched = ['pitch', 'harmony', 'reverb'].filter((s) => blob.includes(s));
            if (touched.length < 2) {
              return `apply_preset spec should carry at least pitch-correct/harmony/reverb sections, got ${blob.slice(0, 200)}`;
            }
            return true;
          },
        },
      ],
      // Working-buffer honesty: no save claim; pressing WRITE (or save_preset
      // with explicit intent) is the persistence step.
      text_not_contains: [
        'I saved', 'now saved', 'stored to memory', 'persisted to',
        'saved to U', 'written to memory',
      ],
      max_wall_seconds: 240,
    },
  },
];
