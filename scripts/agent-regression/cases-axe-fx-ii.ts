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
      // POSITIVE-CLAIM SHAPES so negation disclaimers ("Not saved to
      // flash yet") don't false-trip (Session 110 fix).
      text_not_contains: [
        'I saved',
        'I persisted',
        'I stored',
        'preset is saved',
        'preset is persisted',
        'now saved to',
        'now persisted to',
        'now stored to',
      ],
      max_wall_seconds: 180,
    },
  },

  // §2 discovery — content correctness, not tool-call audit
  {
    id: 'axefx2-discovery-describe',
    device: 'axe-fx-ii',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: II-side discovery exercised end-to-end by axefx2-bk058 + axefx2-enter-sandman cases.
    description: 'Discovery — "What can the Axe-Fx II do?" must NOT hallucinate AM4 semantics (A/B/C/D channels, 4 scenes) for an Axe-Fx II prompt. The agent may answer from training priors or via describe_device; both are acceptable as long as the content is right. Catches the regression where the agent applies the wrong device\'s channel/scene model to II.',
    prompt: 'What can the Axe-Fx II do? Tell me how many channels per block and how many scenes per preset it has.',
    expectations: {
      // No must_call. The senior MCP review (2026-05-20) flagged the
      // prior must_call=[describe_device] as model-behavior-test, not
      // tool-correctness-test: Sonnet correctly answers from priors
      // about II's X/Y + 8-scene model without needing the tool. The
      // hallucination regression we actually care about is in the
      // content, which text_not_contains catches.
      max_tools: 3,
      tool_call_validators: [{
        // If the agent does call describe_device, it should target the
        // right port. Optional: not calling at all is also acceptable.
        tool: 'describe_device',
        optional: true,
        check: (args) => {
          if (args.port !== 'axe-fx-ii' && args.port !== 'axe-fx ii' && args.port !== 'axefx2') {
            return `describe_device port should target axe-fx-ii, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      // Catches "described it like an AM4" hallucination. Axe-Fx II is
      // X/Y channels (not A/B/C/D) and 8 scenes (not 4). Phrases
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
    disabled: true,  // Retired 2026-05-21: cross-device duplicate of channel-on-non-channel-block (AM4 side); both test the same error-envelope shape.
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

  // ── Bouncing-regression cases (v0.1.0 install-test gap) ─────────
  //
  // Same theme as the AM4 bouncing cases (see cases-am4.ts): watch
  // the apply_preset RETRY COUNT, not just the final-state correct.
  // The pattern the v0.1.0 install test surfaced: agents building
  // multi-scene presets bounce 3-5 apply_preset calls through
  // validation errors. The Wave 1 fixes (Levenshtein hints, slot
  // auto-coerce, internal-ref scrub) close that. These cases assert
  // the budget directly.

  // Enter Sandman 4-scene build on II — tests the X/Y channel surface,
  // grid slot shape, and the BK-058 fix at the same time (X AND Y nested
  // params survive the agent\'s spec). Asserts ≤ 1 apply_preset retry.
  {
    id: 'axefx2-enter-sandman-4scene',
    device: 'axe-fx-ii',
    tier: 'hardware',
    description: 'Enter Sandman across 4 scenes on Axe-Fx II. Bouncing-regression — Wave 1 fixes + BK-058 channel-Y survival should let the agent land in ≤ 1 apply_preset retry. Verifies 4 scenes, X+Y channel amp params, no silently-muted master_volume.',
    prompt: "Build me Enter Sandman across 4 scenes on the Axe-Fx II. Scene 1 clean intro on the X channel, scene 2 chugging rhythm on the Y channel with a high-gain amp, scene 3 verse loud, scene 4 lead solo. Use the working buffer, don\'t save. Make every scene actually audible.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const spec = (args.spec ?? {}) as { scenes?: unknown };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) {
            return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          }
          // BK-058 regression-piggyback: both X and Y must reach apply_preset.
          const channelKeys = ampChannelKeys(args);
          if (!channelKeys.has('X') || !channelKeys.has('Y')) {
            return `apply_preset amp params should include BOTH X and Y channels, got: ${[...channelKeys].sort().join(',') || '(none)'}.`;
          }
          // Sensible master_volume on II — anything below display ~2 is
          // a near-mute on the 0..10 knob. The H1-class trap, ported.
          let muted = false;
          if (Array.isArray((args.spec as { slots?: unknown[] }).slots)) {
            for (const slot of (args.spec as { slots: unknown[] }).slots) {
              if (slot === null || typeof slot !== 'object') continue;
              const s = slot as { block_type?: string; params?: unknown };
              if (s.block_type !== 'amp') continue;
              const p = s.params;
              if (p === null || typeof p !== 'object') continue;
              for (const v of Object.values(p as Record<string, unknown>)) {
                if (v === null || typeof v !== 'object') continue;
                const mv = (v as Record<string, unknown>).master_volume ?? (v as Record<string, unknown>).master;
                if (typeof mv === 'number' && mv < 2) muted = true;
              }
            }
          }
          if (muted) {
            return `apply_preset spec sets amp master_volume < 2 on at least one channel — silently-muted amp regression. Audible target: ≥ 2 on the 0..10 knob.`;
          }
          return true;
        },
      }],
      // POSITIVE-CLAIM SHAPES — negation disclaimers ("Not saved to
      // flash yet") pass through (Session 110 fix).
      text_not_contains: [
        'I saved',
        'I persisted',
        'I stored',
        'preset is saved',
        'preset is persisted',
        'now saved to',
        'now persisted to',
        'now stored to',
      ],
      max_wall_seconds: 240,
    },
  },

  // Slot-shape recovery — Wave 1 added an auto-coerce path in the
  // preflight walker (preflight.ts:374): a bare-int slot=3 on a grid
  // device gets coerced to {row:2, col:3} with an `info[]` advisory.
  // The agent should NOT need to retry. The case fires apply_preset
  // with slot:3 and verifies (a) the call succeeded on the first try
  // (b) the result envelope carries the "coerced shorthand" info line.
  {
    id: 'axefx2-slot-shape-recovery',
    device: 'axe-fx-ii',
    tier: 'no-hardware',
    // BK-072 re-enabled 2026-05-21: Sonnet 4.6 still picks the per-tool
    // path (set_block_at_cell + set_params) over apply_preset, but the
    // relaxed must_call_any now accepts that path. The bare-int
    // auto-coerce assertion still runs whenever apply_preset IS chosen
    // (optional validator below).
    description: 'Slot auto-coerce on Axe-Fx II — Wave 1 fix lets bare-int slot:3 on grid devices auto-coerce to {row:2, col:3} with an info[] advisory. BK-072: accepts either apply_preset (asserting the coerce) OR the primitive set_block_at_cell + set_params path.',
    prompt: "On the Axe-Fx II, place an amp in slot 3 using the working buffer. Use a clean amp at moderate gain. Don\'t save.",
    expectations: {
      must_call_any: [
        ['apply_preset'],
        ['set_block_at_cell', 'set_params'],
        ['set_block_at_cell', 'set_param'],
        // Sonnet often reaches for the device-namespaced surface
        // (axefx2_*) on II — accept both unified and namespaced.
        ['axefx2_set_block_at_cell', 'set_params'],
        ['axefx2_set_block_at_cell', 'axefx2_set_param'],
        ['axefx2_set_block_at_cell', 'set_param'],
      ],
      max_tools: 8,
      max_repeats: { apply_preset: 1 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        optional: true,  // BK-072: primitive path is acceptable too.
        check: (args, result) => {
          // Session 110 relax: the agent has two valid apply_preset paths.
          // Both land an amp at row=2, col=3 — only the bare-int path
          // exercises the auto-coerce surface.
          //
          //   1. Bare-int shorthand `slot: 3` — the auto-coerce path being
          //      tested. Dispatcher coerces to {row:2,col:3} and emits an
          //      `info[]` advisory with "coerced shorthand" wording.
          //      Assertion: spec carries 3 + result carries advisory text.
          //   2. Proper object shape `slot: {row:2, col:3}` — Sonnet 4.6
          //      naturally picks this when describe_device shows the grid
          //      example. No coerce path triggered, no advisory expected.
          //      Assertion: spec carries {row:2,col:3}.
          //
          // Both are healthy end-states. The validator previously demanded
          // advisory text in ALL apply_preset paths, which false-failed the
          // {row,col} branch.
          const spec = (args.spec ?? {}) as { slots?: unknown };
          if (!Array.isArray(spec.slots) || spec.slots.length === 0) {
            return `apply_preset spec.slots empty — no amp placed.`;
          }
          const first = spec.slots[0] as { slot?: unknown; block_type?: string };

          // Bare-int 3 path: must trigger auto-coerce advisory.
          if (first.slot === 3) {
            if (result === undefined || !/coerced shorthand|row.*2.*col.*3|validation_info/i.test(result)) {
              return `apply_preset bare-int slot:3 should trigger auto-coerce advisory ("coerced shorthand slot=3 -> {row: 2, col: 3}"). Got: ${result?.slice(0, 280)}.`;
            }
            return true;
          }

          // {row,col} object path: must target row=2, col=3. No advisory expected.
          if (typeof first.slot === 'object' && first.slot !== null) {
            const o = first.slot as { row?: unknown; col?: unknown };
            if (o.row !== 2 || o.col !== 3) {
              return `apply_preset slot should target row=2, col=3 (the amp position the prompt requested) — got ${JSON.stringify(first.slot)}.`;
            }
            return true;
          }

          return `apply_preset slot should be bare-int 3 (testing auto-coerce) or {row:2, col:3} (the proper grid shape) — got ${JSON.stringify(first.slot)}.`;
        },
      }],
      // Session 110: bumped 60 → 120 because Sonnet's natural disposition
      // is to verify after a write (describe → grid_layout → apply_preset
      // → grid_layout). The mock-transport doesn't persist grid placements
      // across calls, so the verification call shows an empty grid and the
      // agent enters a brief recovery-reasoning loop before the case ends.
      // Bumping the budget covers that without hiding any real regression
      // (the assertion still catches a runaway retry via max_repeats: 1).
      max_wall_seconds: 120,
    },
  },

  // ── BK-077 channel-Y inactive pre-flight ────────────────────────
  //
  // Session 113: extends the BK-071/BK-075 ValidationInfo[] soft-warn
  // pattern. When the agent authors an apply_preset spec with channel-
  // nested amp params (X + Y) but every scene in spec.scenes[]
  // references channel X for the amp, the Y data writes to the working
  // buffer yet stays inaudible. The dispatcher fires the channel-Y
  // inactive warning and the agent should self-correct on the next
  // turn (either by adding a scene that routes to Y, or by moving the
  // Y params under X).
  //
  // The prompt explicitly authors a "scene 1 uses the clean amp"
  // configuration with Y data — a realistic agent trap. Acceptable
  // recoveries: a follow-up apply_preset that either drops the Y
  // block or assigns a scene to Y; OR a chat-only acknowledgement
  // that the Y data is currently inactive.
  {
    id: 'axefx2-channel-y-inactive-warning',
    device: 'axe-fx-ii',
    tier: 'no-hardware',
    description: 'Channel-Y inactive trap — agent authors Y-channel amp params plus a one-scene spec that routes amp→X. Dispatcher pre-flight surfaces validation_info[] warning naming the inactive channel. Agent must NOT report the Y settings as audible; acceptable paths are a follow-up apply_preset with a scene routing to Y, or a chat-only acknowledgement of the inactive Y data.',
    prompt: "On the Axe-Fx II, build a working-buffer preset with the amp's X channel set to a clean tone at gain 3, and the amp's Y channel set to a lead tone at gain 8. Define one scene that uses the clean amp. Use the working buffer, don't save.",
    expectations: {
      must_call: ['apply_preset'],
      max_tools: 8,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const keys = ampChannelKeys(args);
          if (!keys.has('X') || !keys.has('Y')) {
            return `apply_preset amp params should include BOTH X and Y to exercise the channel-Y trap, got: ${[...keys].sort().join(',') || '(none)'}.`;
          }
          const spec = (args.spec ?? {}) as { scenes?: unknown };
          if (!Array.isArray(spec.scenes) || spec.scenes.length === 0) {
            return `apply_preset spec should declare scenes[] to exercise the BK-077 pre-flight (the warning only fires when at least one scene constrains the block's channel).`;
          }
          return true;
        },
      }],
      // Agent must NOT positive-claim Y settings are active. Reading the
      // validation_info[] warning naturally produces text mentioning the
      // inactive Y channel; the false-claim regressions only fire when
      // the agent IGNORED the warning surface.
      text_not_contains: [
        'Y channel is now',
        'Y channel is set',
        'lead tone is now',
        'lead amp is now',
        'lead amp is audible',
        'lead is audible',
        'all set',
        "you're all set",
      ],
      max_wall_seconds: 120,
    },
  },

  // ── BK-076 routing-mask=0 pre-flight, end-to-end ───────────────
  //
  // Session 113 cont follow-up: uses MOCK_FIXTURE='populated-unrouted'
  // so the II mock grid carries Amp 1 at (row 2, col 3) with
  // routingFlags=0. When the agent calls set_param on amp.gain, the
  // dispatcher's BK-076 pre-flight reads the grid via
  // getBlockLayoutSnapshot, finds amp in unroutedBlocks, and attaches
  // a validation_info[] warning with level='warning', dropped_param,
  // reason, retry_action.
  //
  // Acceptable agent recoveries: a follow-up `axefx2_set_cell_routing`
  // call to connect a previous-column cell into amp, OR a chat-only
  // acknowledgement of the broken-cable state. Both paths pass.
  {
    id: 'axefx2-routing-mask-warning',
    device: 'axe-fx-ii',
    tier: 'no-hardware',
    mockFixture: 'populated-unrouted',
    description: 'Routing-mask=0 trap — agent set_param on amp.gain when amp is placed at (row 2, col 3) with routing_mask=0 (no input cable). Dispatcher pre-flight surfaces validation_info[] warning naming the broken-cable state + retry_action pointing at axefx2_set_cell_routing. Agent must NOT positive-claim audible success; acceptable paths are a follow-up cable write OR a chat-only acknowledgement.',
    prompt: "On the Axe-Fx II, set the amp gain to 6.",
    expectations: {
      must_call: ['set_param'],
      max_tools: 6,
      // Agent must NOT positive-claim audible success. Reading the
      // validation_info[] warning naturally produces text mentioning
      // the broken-cable state; false-claim regressions fire when the
      // agent IGNORED the warning surface.
      text_not_contains: [
        'gain is now 6',
        'gain is now at 6',
        'amp gain is 6',
        'audibly',
        'all set',
        "you're all set",
      ],
      max_wall_seconds: 120,
    },
  },
];
