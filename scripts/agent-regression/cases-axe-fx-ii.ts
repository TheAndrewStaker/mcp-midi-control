/**
 * Axe-Fx II agent-regression cases.
 *
 * Targets the unified MCP surface (`apply_preset`, `set_param`,
 * `get_param`, `describe_device`) with `port: 'axe-fx-ii'`. Same
 * harness pattern as cases-am4.ts — fresh `claude -p` session per
 * case, MCP-only tool surface, mock-transport by default so the
 * sweep runs without USB hardware.
 *
 * Lead case: BK-058 X/Y channel-nested apply_preset (the channel-Y
 * write-loss bug closed Session 99). Asserts BOTH X and Y nested
 * params reach apply_preset's spec — the executor downstream is
 * responsible for translating those into wire writes against each
 * channel, but the harness can only see the tool's incoming args.
 * That's still the right granularity: if the agent drops Y from
 * the spec, the BK-058 fix did not survive the prompt layer.
 */

import type { AgentRegressionCase } from './types.js';

/**
 * Walk an apply_preset spec's slots[] looking for an amp block with
 * channel-nested params, return the set of channel keys present
 * (e.g. `{X, Y}`). Used to assert both X and Y params survive the
 * agent's spec construction.
 */
function ampChannelKeys(args: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const spec = (args.spec ?? {}) as { slots?: unknown };
  if (!Array.isArray(spec.slots)) return keys;
  for (const slot of spec.slots) {
    if (slot === null || typeof slot !== 'object') continue;
    const s = slot as { block_type?: string; params?: unknown };
    if (s.block_type !== 'amp') continue;
    const p = s.params;
    if (p === null || typeof p !== 'object') continue;
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      // Channel-nested shape: {X: {...}, Y: {...}}. Flat shape:
      // {gain: 6} — single-letter keys catch the channel-nested
      // case without false-positives on flat param names.
      if (v !== null && typeof v === 'object' && (k === 'X' || k === 'Y')) {
        keys.add(k);
      }
    }
  }
  return keys;
}

export const AXE_FX_II_CASES: AgentRegressionCase[] = [
  // BK-058 — X/Y channel-nested apply_preset (regression-guard) ──────
  {
    id: 'axefx2-bk058-xy-channel-apply',
    device: 'axe-fx-ii',
    tier: 'hardware',
    description: 'BK-058 — apply_preset on Axe-Fx II with channel-nested {X, Y} amp params. The bug closed Session 99 dropped Y-channel writes silently; this case guards against regression by asserting BOTH X and Y land in the spec the agent sends to apply_preset.',
    prompt: "Build me an Axe-Fx II preset where the amp has two channels with different gain. X channel should be a clean amp at gain 3. Y channel should be a high-gain lead amp at gain 8. Use the working buffer, don't save anywhere.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 8,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        check: (args) => {
          const keys = ampChannelKeys(args);
          if (!keys.has('X') || !keys.has('Y')) {
            return `apply_preset amp params should include BOTH X and Y channel-nested entries, got: ${[...keys].sort().join(',') || '(none)'}.`;
          }
          return true;
        },
      }],
      // No save-confidence narration on a working-buffer apply.
      text_not_contains: ['saved to', 'persisted to', 'stored to'],
      max_wall_seconds: 180,
    },
  },

  // §2 discovery — describe_device routes to the agent_guidance text
  {
    id: 'axefx2-discovery-describe',
    device: 'axe-fx-ii',
    tier: 'no-hardware',
    description: 'Discovery — "What can the Axe-Fx II do?" should call describe_device({port:"axe-fx-ii"}) so the agent gets channel/scene semantics right. Catches the regression where the agent describes AM4 conventions (A/B/C/D, 4 scenes) for an Axe-Fx II prompt.',
    prompt: 'What can the Axe-Fx II do? Tell me how many channels per block and how many scenes per preset it has.',
    expectations: {
      must_call: ['describe_device'],
      max_tools: 3,
      tool_call_validators: [{
        tool: 'describe_device',
        check: (args) => {
          if (args.port !== 'axe-fx-ii' && args.port !== 'axe-fx ii' && args.port !== 'axefx2') {
            return `describe_device port should target axe-fx-ii, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      // Catches "described it like an AM4" hallucination — Axe-Fx II
      // is X/Y channels (not A/B/C/D) and 8 scenes (not 4). Phrases
      // below are tight enough to avoid false-positives on comparative
      // explanations ("AM4 has A/B/C/D, II has X/Y" is legitimate).
      text_not_contains: [
        'II has A/B/C/D',
        'II supports A/B/C/D',
        'Axe-Fx II has 4 channel',
        'Axe-Fx II has four channel',
        'Axe-Fx II has 4 scene',
        'Axe-Fx II has four scene',
      ],
      max_wall_seconds: 60,
    },
  },

  // §2 error envelope — invalid channel rejection
  {
    id: 'axefx2-err-bad-channel',
    device: 'axe-fx-ii',
    tier: 'no-hardware',
    description: 'Error envelope — `set amp channel Z gain to 6 on Axe-Fx II`: Axe-Fx II channels are X/Y only, so channel Z must reject. Acceptable paths: call set_param + let the validator reject, or refuse upfront from describe_device knowledge.',
    prompt: 'Set the amp channel Z gain to 6 on the Axe-Fx II.',
    expectations: {
      min_tools: 0,
      max_tools: 5,
      tool_call_validators: [{
        tool: 'set_param',
        optional: true,
        check: (args, result) => {
          if (args.block !== 'amp' || args.name !== 'gain') {
            return `set_param called but targeted ${String(args.block)}.${String(args.name)} instead of amp.gain.`;
          }
          const channel = args.channel;
          if (typeof channel !== 'string' || channel.toUpperCase() !== 'Z') {
            return `set_param channel should be "Z" (the bad-channel request), got ${JSON.stringify(channel)}.`;
          }
          if (result === undefined || !/X\/Y|X.{0,3}Y|not valid|bad.?channel/i.test(result)) {
            return `set_param amp.gain channel=Z result did not surface a bad-channel rejection — got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      text_not_contains: ['channel Z is now', 'set channel Z', 'channel Z gain is'],
      max_wall_seconds: 60,
    },
  },
];
