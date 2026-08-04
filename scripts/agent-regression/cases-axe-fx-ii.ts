/**
 * Axe-Fx II agent-regression cases.
 *
 * Targets the unified MCP surface (`apply_preset`, `set_param`,
 * `get_param`, `describe_device`) with `port: 'axe-fx-ii'`. Same
 * harness pattern as cases-am4.ts: fresh `claude -p` session per
 * case, MCP-only tool surface, mock-transport by default so the
 * sweep runs without USB hardware.
 *
 * Lead case: X/Y channel-nested apply_preset, guarding the channel-Y
 * write-loss bug. Asserts BOTH X and Y nested params reach
 * apply_preset's spec. The executor downstream is responsible for
 * translating those into wire writes against each channel, but the
 * harness can only see the tool's incoming args. That's still the
 * right granularity: if the agent drops Y from the spec, the fix did
 * not survive the prompt layer.
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
    const s = slot as { block_type?: string; params?: unknown; params_by_channel?: unknown };
    if (s.block_type !== 'amp') continue;
    // Agents now author per-channel maps via params_by_channel
    // ({X: {...}, Y: {...}}). The legacy nested-in-params shape is
    // rejected at the MCP boundary; accept both here for tests that
    // ran against the older surface (the validator job is to count
    // distinct channels regardless of which field the agent used).
    for (const candidate of [s.params_by_channel, s.params]) {
      if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
      for (const [k, v] of Object.entries(candidate as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object' && (k === 'X' || k === 'Y')) {
          keys.add(k);
        }
      }
    }
  }
  return keys;
}

export const AXE_FX_II_CASES: AgentRegressionCase[] = [
  // X/Y channel-nested apply_preset (regression-guard) ──────
  {
    id: 'axefx2-bk058-xy-channel-apply',
    device: 'axe-fx-ii',

    description: 'apply_preset on Axe-Fx II with channel-nested {X, Y} amp params. The historical bug dropped Y-channel writes silently; this case guards against regression by asserting BOTH X and Y land in the spec the agent sends to apply_preset.',
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
      // flash yet") don't false-trip.
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

  // §2 discovery: content correctness, not tool-call audit
  {
    id: 'axefx2-discovery-describe',
    device: 'axe-fx-ii',

    disabled: true,  // Retired: II-side discovery exercised end-to-end by axefx2-bk058 + axefx2-enter-sandman cases.
    description: 'Discovery: "What can the Axe-Fx II do?" must NOT hallucinate AM4 semantics (A/B/C/D channels, 4 scenes) for an Axe-Fx II prompt. The agent may answer from training priors or via describe_device; both are acceptable as long as the content is right. Catches the regression where the agent applies the wrong device\'s channel/scene model to II.',
    prompt: 'What can the Axe-Fx II do? Tell me how many channels per block and how many scenes per preset it has.',
    expectations: {
      // No must_call. A senior MCP review flagged the
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

  // §2 error envelope: invalid channel rejection
  {
    id: 'axefx2-err-bad-channel',
    device: 'axe-fx-ii',

    disabled: true,  // Retired: cross-device duplicate of channel-on-non-channel-block (AM4 side); both test the same error-envelope shape.
    description: 'Error envelope: `set amp channel Z gain to 6 on Axe-Fx II`: Axe-Fx II channels are X/Y only, so channel Z must reject. Acceptable paths: call set_param + let the validator reject, or refuse upfront from describe_device knowledge.',
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
            return `set_param amp.gain channel=Z result did not surface a bad-channel rejection; got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      text_not_contains: ['channel Z is now', 'set channel Z', 'channel Z gain is'],
      max_wall_seconds: 60,
    },
  },

  // ── Bouncing-regression cases (install-test gap) ─────────
  //
  // Same theme as the AM4 bouncing cases (see cases-am4.ts): watch
  // the apply_preset RETRY COUNT, not just the final-state correct.
  // The pattern the install test surfaced: agents building multi-scene
  // presets bounce 3 to 5 apply_preset calls through validation errors.
  // The vocabulary fixes (Levenshtein hints, slot auto-coerce,
  // internal-ref scrub) close that. These cases assert the budget
  // directly.

  // Enter Sandman 4-scene build on II: tests the X/Y channel surface,
  // grid slot shape, and the channel-Y survival fix at the same time
  // (X AND Y nested params survive the agent\'s spec). Asserts <= 1
  // apply_preset retry.
  {
    id: 'axefx2-enter-sandman-4scene',
    device: 'axe-fx-ii',

    disabled: true,  // Retired: vague song-name prompt leads to unreliable scene structure + amp picks. Replaced by axefx2-alpha1-4scene-verbatim which names specific amp models + scene descriptions.
    description: 'Enter Sandman across 4 scenes on Axe-Fx II. Bouncing-regression: the vocabulary fixes plus channel-Y survival should let the agent land in <= 1 apply_preset retry. Verifies 4 scenes, X+Y channel amp params, no silently-muted master_volume.',
    prompt: "Build me a preset for the song Enter Sandman by Metallica on the Axe-Fx II including 4 scenes.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        // Dropped call_index:0 because Sonnet sometimes sends an
        // exploratory sceneless apply before the full build. Checking
        // only call_index:0 rejected the valid full-build call at
        // index 1 (alpha.1-test sweep false-fail).
        check: (args) => {
          const spec = (args.spec ?? {}) as { scenes?: unknown };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) {
            return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          }
          // Regression-piggyback: both X and Y must reach apply_preset.
          const channelKeys = ampChannelKeys(args);
          if (!channelKeys.has('X') || !channelKeys.has('Y')) {
            return `apply_preset amp params should include BOTH X and Y channels, got: ${[...channelKeys].sort().join(',') || '(none)'}.`;
          }
          // Sensible master_volume on II: anything below display ~2 is
          // a near-mute on the 0..10 knob. The H1-class trap, ported.
          let muted = false;
          if (Array.isArray((args.spec as { slots?: unknown[] }).slots)) {
            for (const slot of (args.spec as { slots: unknown[] }).slots) {
              if (slot === null || typeof slot !== 'object') continue;
              const s = slot as { block_type?: string; params?: unknown; params_by_channel?: unknown };
              if (s.block_type !== 'amp') continue;
              // Agents author per-channel amp params via
              // params_by_channel. Reading only params would mean a
              // muted master under params_by_channel.X slips past the
              // silent-mute safety check. Mirrors the ampChannelKeys fix.
              for (const candidate of [s.params_by_channel, s.params]) {
                if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
                for (const v of Object.values(candidate as Record<string, unknown>)) {
                  if (v === null || typeof v !== 'object') continue;
                  const mv = (v as Record<string, unknown>).master_volume ?? (v as Record<string, unknown>).master;
                  if (typeof mv === 'number' && mv < 2) muted = true;
                }
              }
            }
          }
          if (muted) {
            return `apply_preset spec sets amp master_volume < 2 on at least one channel: silently-muted amp regression. Audible target: >= 2 on the 0..10 knob.`;
          }
          return true;
        },
      }],
      // POSITIVE-CLAIM SHAPES: negation disclaimers ("Not saved to
      // flash yet") pass through.
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
      // Wall-clock budget bumped from 240 to 300. Sonnet under the
      // runner system prompt does more loudness-compensation research
      // (lookup_lineage twice on hot/clean amp pairs + reasoning) before
      // emitting the 4-scene spec. Real cost: ~5s describe + 20s lineage
      // pair + 10s list + 60 to 100s apply_preset on slow II hardware +
      // Sonnet reasoning gaps, about 270 to 300s. 240s clipped
      // mid-apply_preset generation.
      max_wall_seconds: 480,
    },
  },

  // Slot-shape recovery: the preflight walker added an auto-coerce
  // path where a bare-int slot=3 on a grid
  // device gets coerced to {row:2, col:3} with an `info[]` advisory.
  // The agent should NOT need to retry. The case fires apply_preset
  // with slot:3 and verifies (a) the call succeeded on the first try
  // (b) the result envelope carries the "coerced shorthand" info line.
  {
    id: 'axefx2-slot-shape-recovery',
    device: 'axe-fx-ii',

    // Re-enabled: Sonnet 4.6 still picks the per-tool path
    // (set_block_at_cell + set_params) over apply_preset, but the
    // relaxed must_call_any now accepts that path. The bare-int
    // auto-coerce assertion still runs whenever apply_preset IS chosen
    // (optional validator below).
    description: 'Slot auto-coerce on Axe-Fx II: bare-int slot:3 on grid devices auto-coerces to {row:2, col:3} with an info[] advisory. Accepts either apply_preset (asserting the coerce) OR a primitive set_block / set_block_at_cell path.',
    prompt: "On the Axe-Fx II, place an amp in slot 3 using the working buffer. Use a clean amp at moderate gain. Don\'t save.",
    expectations: {
      must_call_any: [
        ['apply_preset'],
        // Unified-surface primitives (the canonical names).
        // Added because Sonnet picked `set_block` alone on slot-shape-
        // recovery (no follow-up set_param when the default-gain amp was
        // acceptable for "moderate gain"). That's a healthy single-write
        // path that the previous must_call_any list rejected, false-
        // failing the case on alpha.1 sweep.
        ['set_block'],
        ['set_block', 'set_param'],
        ['set_block', 'set_params'],
      ],
      max_tools: 8,
      max_repeats: { apply_preset: 1 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        optional: true,  // primitive path is acceptable too.
        check: (args, result) => {
          // The agent has two valid apply_preset paths. Both land an amp
          // at row=2, col=3; only the bare-int path exercises the
          // auto-coerce surface.
          //
          //   1. Bare-int shorthand `slot: 3`: the auto-coerce path being
          //      tested. Dispatcher coerces to {row:2,col:3} and emits an
          //      `info[]` advisory with "coerced shorthand" wording.
          //      Assertion: spec carries 3 + result carries advisory text.
          //   2. Proper object shape `slot: {row:2, col:3}`: Sonnet 4.6
          //      naturally picks this when describe_device shows the grid
          //      example. No coerce path triggered, no advisory expected.
          //      Assertion: spec carries {row:2,col:3}.
          //
          // Both are healthy end-states. The validator previously demanded
          // advisory text in ALL apply_preset paths, which false-failed the
          // {row,col} branch.
          const spec = (args.spec ?? {}) as { slots?: unknown };
          if (!Array.isArray(spec.slots) || spec.slots.length === 0) {
            return `apply_preset spec.slots empty: no amp placed.`;
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
              return `apply_preset slot should target row=2, col=3 (the amp position the prompt requested); got ${JSON.stringify(first.slot)}.`;
            }
            return true;
          }

          return `apply_preset slot should be bare-int 3 (testing auto-coerce) or {row:2, col:3} (the proper grid shape); got ${JSON.stringify(first.slot)}.`;
        },
      }],
      // Wall-clock budget bumped from 60 to 120 because Sonnet's natural
      // disposition is to verify after a write (describe, grid_layout,
      // apply_preset, grid_layout). The mock-transport doesn't persist grid placements
      // across calls, so the verification call shows an empty grid and the
      // agent enters a brief recovery-reasoning loop before the case ends.
      // Bumping the budget covers that without hiding any real regression
      // (the assertion still catches a runaway retry via max_repeats: 1).
      max_wall_seconds: 120,
    },
  },

  // ── channel-Y inactive pre-flight ────────────────────────
  //
  // Extends the ValidationInfo[] soft-warn pattern. When the agent
  // authors an apply_preset spec with channel-nested amp params (X + Y)
  // but every scene in spec.scenes[] references channel X for the amp,
  // the Y data writes to the working buffer yet stays inaudible. The
  // dispatcher fires the channel-Y inactive warning and the agent
  // should self-correct on the next turn (either by adding a scene that
  // routes to Y, or by moving the Y params under X).
  //
  // The prompt explicitly authors a "scene 1 uses the clean amp"
  // configuration with Y data, a realistic agent trap. Acceptable
  // recoveries: a follow-up apply_preset that either drops the Y
  // block or assigns a scene to Y; OR a chat-only acknowledgement
  // that the Y data is currently inactive.
  {
    id: 'axefx2-channel-y-inactive-warning',
    device: 'axe-fx-ii',

    description: 'Channel-Y inactive trap: agent authors Y-channel amp params plus a one-scene spec that routes amp to X. Dispatcher pre-flight surfaces validation_info[] warning naming the inactive channel. Agent must NOT report the Y settings as audible; acceptable paths are a follow-up apply_preset with a scene routing to Y, or a chat-only acknowledgement of the inactive Y data.',
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
            return `apply_preset spec should declare scenes[] to exercise the channel-Y pre-flight (the warning only fires when at least one scene constrains the block's channel).`;
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

  // ── routing-mask=0 pre-flight, end-to-end ───────────────
  //
  // Uses MOCK_FIXTURE='populated-unrouted' so the II mock grid carries
  // Amp 1 at (row 2, col 3) with routingFlags=0. When the agent calls
  // set_param on amp.gain, the dispatcher's routing pre-flight reads
  // the grid via getBlockLayoutSnapshot, finds amp in unroutedBlocks,
  // and attaches
  // a validation_info[] warning with level='warning', dropped_param,
  // reason, retry_action.
  //
  // Acceptable agent recoveries: a follow-up apply_preset with a
  // routing[] array to cable a previous-column cell into amp, OR a
  // chat-only acknowledgement of the broken-cable state. Both paths pass.
  {
    id: 'axefx2-routing-mask-warning',
    device: 'axe-fx-ii',

    mockFixture: 'populated-unrouted',
    description: 'Routing-mask=0 trap: agent set_param on amp.gain when amp is placed at (row 2, col 3) with routing_mask=0 (no input cable). Dispatcher pre-flight surfaces validation_info[] warning naming the broken-cable state + retry_action pointing at apply_preset with a routing[] array. Agent must NOT positive-claim audible success; acceptable paths are a follow-up cable write OR a chat-only acknowledgement.',
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

  // ── MCP migration cases ────────────────
  //
  // Three cases prove the new apply_preset({recipe_id, overrides,
  // dry_run}) surface. They run alongside axefx2-enter-sandman-4scene
  // until they prove stable across three consecutive sessions; then
  // enter-sandman retires.
  //
  // The deterministic-build case captures the "no recipe matches my
  // prompt" path: agent composes the 4-scene spec from scratch. The
  // two pickup cases validate the recipe surface: the agent should
  // call apply_preset({recipe_id}) not paste full slots.

  // (A) Deterministic 4-scene build, NO recipe expected.
  //
  // Prompt is intentionally non-iconic: "Shiva Bogner clean + crunchy
  // version + Marshall variant + lead". No recipe matches; the agent
  // composes the spec turn-by-turn. Baseline for wall-time + tool-call
  // budget against which the recipe-using cases (B, C) are compared.
  {
    id: 'axefx2-deterministic-4scene-build',
    device: 'axe-fx-ii',

    disabled: true,  // Merged into axefx2-alpha1-4scene-verbatim (superset: multi-amp + loudness + no-recipe_id). Re-enable only if alpha1 is retired.
    description: 'Deterministic 4-scene build with NO recipe match. Agent composes a Shiva Bogner-style clean + crunchy variant + Marshall variant + high-gain lead by reading describe_device + lookup_lineage, then issuing apply_preset directly. Baseline against which the recipe-pickup cases compare.',
    prompt: [
      'Build me a preset on the Axe-Fx II with 4 scenes.',
      'Scene 1: Shiva Bogner clean. Scene 2: same amp but crunchy (gain up).',
      'Scene 3: an interesting Marshall variant (your pick).',
      'Scene 4: a different high-gain lead (your pick, not Marshall).',
      'Working buffer only, do not save.',
    ].join(' '),
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 12,
      should_avoid_dropped_param_warning: true,
      // Complex multi-amp + 4-scene build occasionally needs 1-2
      // iterations to land enum + slot-id shape. Each iteration is
      // a preflight-only commit attempt (zero wire writes on
      // validation_errors[] paths); 3 attempts ≈ ~30s of agent
      // compose time, well inside the wall budget.
      max_repeats: { apply_preset: 3 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          // Agent must NOT use recipe_id here: no recipe matches Bogner.
          if (typeof args.recipe_id === 'string' && args.recipe_id.length > 0) {
            return `Deterministic build should not use recipe_id (no recipe matches the Bogner prompt). Got recipe_id='${args.recipe_id}'.`;
          }
          const spec = (args.spec ?? {}) as { scenes?: unknown; slots?: unknown };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) {
            return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          }
          // At least 2 amps placed (clean + crunchy share one; lead is another).
          // The spec must have a non-empty slots[].
          const slots = Array.isArray(spec.slots) ? spec.slots : [];
          let ampSlots = 0;
          for (const s of slots) {
            if (s !== null && typeof s === 'object' && (s as { block_type?: unknown }).block_type === 'amp') {
              ampSlots++;
            }
          }
          if (ampSlots < 1) {
            return `apply_preset should place at least one amp slot. Got ${ampSlots}.`;
          }
          return true;
        },
      }],
      text_not_contains: ['I saved', 'I stored', 'preset is saved', 'now saved to'],
      max_wall_seconds: 480,
    },
  },

  // (B) Block-stack recipe pickup: exact name.
  //
  // "Classic rock Plexi" maps directly to classic_rock_plexi recipe.
  // Agent should call apply_preset({recipe_id: 'classic_rock_plexi'})
  // instead of authoring from scratch. max_tools: 4 for early bail.
  {
    id: 'axefx2-recipe-block-stack-pickup',
    device: 'axe-fx-ii',

    description: 'Block-stack recipe pickup (exact name). Agent picks classic_rock_plexi from describe_device.recipes[] and applies via recipe_id. Validates the recipe hint in apply_preset description is strong enough.',
    prompt: "Give me a classic rock Plexi tone on the Axe-Fx II. Working buffer only.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 6,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          if (args.recipe_id !== 'classic_rock_plexi') {
            return `Expected apply_preset({recipe_id: 'classic_rock_plexi'}); got recipe_id=${JSON.stringify(args.recipe_id)}. The agent should have matched the prompt to describe_device.recipes[].`;
          }
          return true;
        },
      }],
      must_not_call: ['lookup_lineage'],
      text_not_contains: ['I saved', 'I stored'],
      max_wall_seconds: 240,
    },
  },

  // (B2) Block-stack recipe pickup: genre subtext (no exact name).
  //
  // "Modern metal / djent with an overdrive in front" should trigger
  // modern_metal_recto or djent_gated_5150 (II-only, 5 slots). Tests
  // whether the agent infers recipe applicability from genre vocabulary
  // rather than needing the exact recipe name in the prompt.
  {
    id: 'axefx2-recipe-genre-subtext',
    device: 'axe-fx-ii',

    description: 'Block-stack recipe pickup (genre subtext). Prompt uses genre vocab, not recipe name. Agent should find a matching recipe in describe_device.recipes[] and use recipe_id. Accepts any of the metal/high-gain recipes.',
    prompt: "Build me a modern metal tone on the Axe-Fx II. Tight, gated, high-gain with a drive pedal in front. Think Periphery or Meshuggah. Working buffer only.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      // `max_tools: 6` REMOVED 2026-08-02 on real-hardware evidence. This case
      // failed at 7 tools while doing everything it exists to test, and the
      // failure was the gate, not the agent. The run:
      //
      //   describe_device -> describe_device({recipe:"djent_gated_5150"})
      //   -> apply_preset({recipe_id:"djent_gated_5150"}) -> get_preset
      //   -> list_params(gateexpander) x2 -> set_params
      //
      // It made the semantic jump the case is FOR ("Think Periphery or
      // Meshuggah" to `djent_gated_5150`, zero lexical overlap), read the
      // recipe detail path, applied by id in ONE call, and passed the recipe
      // validator. The two calls over budget were `get_preset` (reading back
      // its own write) and a second `list_params` to refine the gate: it was
      // punished for verifying and self-correcting, which is exactly the
      // failure mode commit d3440d8 identified when it made `max_tools`
      // optional and `max_wall_seconds` the runaway guard. That migration
      // simply missed this case.
      //
      // Still guarded: `max_wall_seconds: 240` below (actual 80.5s) catches
      // runaway, and `max_repeats` catches retry loops, which is the thing a
      // call count was ever a proxy for.
      max_repeats: { apply_preset: 3 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const validRecipes = ['modern_metal_recto', 'djent_gated_5150', 'thrash_metal_iic_plus'];
          if (typeof args.recipe_id !== 'string' || !validRecipes.includes(args.recipe_id)) {
            return `Expected a metal recipe_id (${validRecipes.join(' | ')}); got recipe_id=${JSON.stringify(args.recipe_id)}. The agent should match genre vocabulary to recipes[].`;
          }
          return true;
        },
      }],
      text_not_contains: ['I saved', 'I stored'],
      max_wall_seconds: 240,
    },
  },

  // (C) axefx2-recipe-single-block-pickup: REMOVED.
  // Hits context overflow from the large II describe_device response
  // (same class as am4-phantom-param-warning). AM4 equivalent covers
  // single-block recipe pickup without the context-window issue.

  // ── Multi-amp instance regression ────────────────────────────────
  //
  // Real-world failure: a user asked an agent to build a 4-scene
  // Axe-Fx II preset where Clean + Lead used one amp model (Bogner
  // Shiva) and Crunch + Rhythm used another (Plexi / Brit 800 Mod).
  // The natural authoring shape is TWO amp blocks (Amp 1 + Amp 2) so
  // each amp gets its own pair of X/Y voicings.
  //
  // Pre-fix the translator silently mapped both slots to "Amp 1"
  // (effectId 106): placing the same effectId at row 2 col 2 AND
  // col 3 triggered the device's "move on duplicate" eviction, the
  // cable col 1 to col 2 then NACKed with 0x0e and apply_preset
  // returned ok:false with no actionable error. The agent thrashed
  // through about 7 isolation builds before giving up on the 2-amp shape.
  //
  // This case asserts the spec the agent emits carries two distinct
  // instance values (or distinct ids), AND that apply_preset returns
  // ok:true on the first try without a duplicate-id rejection.
  {
    id: 'axefx2-multi-amp-distinct-instance',
    device: 'axe-fx-ii',

    description: 'Multi-amp regression: agent builds a preset with two amp blocks (Amp 1 + Amp 2) using different amp models per block. Pre-fix translateSpec resolved both to "Amp 1" (effectId 106) and the cable chain NACKed. Verifies the agent emits distinct instance values on the two amp slots AND apply_preset acks ok:true.',
    prompt: "Build me an Axe-Fx II preset that uses TWO different amp blocks placed in series on the working buffer: the first amp block should be a Bogner Shiva clean voicing, the second amp block should be a Marshall Plexi 50W crunch voicing. Put them side by side in row 2 with a cab after them. Don't save anywhere, working buffer only.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args, result) => {
          const spec = (args.spec ?? {}) as { slots?: unknown };
          const slots = Array.isArray(spec.slots) ? spec.slots : [];
          const ampSlots = slots.filter(
            (s) => s !== null && typeof s === 'object' && (s as { block_type?: unknown }).block_type === 'amp',
          ) as Array<{ instance?: number; id?: string }>;
          if (ampSlots.length < 2) {
            return `apply_preset spec should declare TWO amp slots (Amp 1 + Amp 2). Got ${ampSlots.length}.`;
          }
          // Two amp slots must be disambiguated by instance OR id.
          // Pre-fix the translator collapsed identical instance=1
          // entries onto the same effectId; this assertion catches a
          // regression to that shape.
          const instances = new Set<number>();
          const ids = new Set<string>();
          for (const s of ampSlots) {
            if (typeof s.instance === 'number') instances.add(s.instance);
            if (typeof s.id === 'string') ids.add(s.id);
          }
          const instanceOk = instances.size >= 2;
          const idOk = ids.size >= 2;
          if (!instanceOk && !idOk) {
            return `apply_preset spec has two amp slots but they share the same instance/id. The translator would silently resolve both to "Amp 1" (effectId 106) and the cable chain would NACK. Set instance:2 (or a distinct id) on the second amp slot.`;
          }
          // Server response must indicate success. Pre-fix it returned
          // ok:false with failed_step "CABLE row 2 col 1 → row 2 col 2".
          // Anchor to the response HEAD (first 80 chars) so a nested
          // `chain_integrity.ok:false` doesn't false-match.
          if (result === undefined) return true;
          if (/"ok":\s*false/.test(result.slice(0, 80))) {
            return `apply_preset returned ok:false on a 2-amp spec. Pre-fix failure mode: check that translateSpec resolves instance:2 to "Amp 2" (effectId 107) instead of silently collapsing to "Amp 1" (106). Response head: ${result.slice(0, 300)}.`;
          }
          return true;
        },
      }],
      // Audition only: no save vocab in the prompt.
      text_not_contains: [
        'I saved',
        'I persisted',
        'I stored',
        'preset is saved',
        'preset is persisted',
      ],
      max_wall_seconds: 300,
    },
  },

  // axefx2-alpha1-4scene-verbatim: REMOVED.
  // Redundant with axefx2-multi-amp-distinct-instance (same multi-amp
  // instance-collapse regression guard). The 4-scene verbatim prompt
  // was a 600s flake magnet due to Sonnet non-determinism on complex
  // scene structures. Scene count and loudness checks weren't catching
  // regressions that other tests don't already cover.

  // axefx2-channel-y-write-verify: REMOVED.
  // The "verified" string assertion checked for channel-verify markers
  // in the apply_preset tool response, but the executor's summaries
  // array (where "verified" lives) is never surfaced in the JSON
  // response. The X/Y channel spec shape is already validated by
  // axefx2-bk058-xy-channel-apply (ampChannelKeys + ok:true).

  // export_preset of an UNSAVED working buffer (0.3.0 edit-buffer dump) ──
  {
    id: 'axefx2-export-unsaved-buffer',
    device: 'axe-fx-ii',

    description: "0.3.0 regression guard: export_preset on the II dumps the TRUE edit buffer (fn 0x03 with the 0x7F 0x7F sentinel, hardware-confirmed 2026-06-10), so backing up an UNSAVED tone works in one call with NO save. The agent must apply (unsaved), export, and must NOT save anywhere (the user said don't save) — the old failure mode was a unilateral save_preset to 'enable' the backup.",
    prompt: "On the Axe-Fx II, build me a quick crunch tone in the working buffer — one amp, gain 6 — but don't save it anywhere. Then back up that tone to a .syx file on disk.",
    expectations: {
      must_call: ['apply_preset', 'export_preset'],
      // The user said don't save: the edit-buffer export needs no save,
      // and a unilateral save_preset was the old failure mode.
      must_not_call: ['save_preset'],
      max_tools: 10,
      max_repeats: { export_preset: 2 },
      tool_call_validators: [
        {
          tool: 'apply_preset',
          check: (args) => {
            if ((args as { save_authorized?: boolean }).save_authorized === true) {
              return "apply_preset called with save_authorized:true, but the user said don't save. The edit-buffer export needs no save.";
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 240,
    },
  },

  // ── save_preset overwrite gate on the II (2026-08-03) ─────────────
  //
  // The gate: the II can read which preset is ACTIVE but has no decoded read
  // for what is stored at an arbitrary location, so saving to a NON-ACTIVE
  // target refuses until the caller passes confirm_overwrite. Before this the
  // store landed acked:true with a caution on the RECEIPT, which is a warning
  // after a flash write, not a gate, on a `verified`-tier device.
  //
  // WHAT THIS CASE IS ACTUALLY FOR, and why it is not "assert a refusal":
  // the dispatcher-level refusal is already gated offline in
  // verify-axefx2-dirty-gate.ts (three branches, no billed run needed). What
  // only a real agent can tell us is whether the refusal is RECOVERABLE-BUT-
  // NOT-AUTO-DEFEATABLE. The failure mode worth money is an agent that reads
  // "call again with confirm_overwrite: true", does exactly that on its own,
  // and overwrites a preset the user never agreed to lose. That would make the
  // gate theatre. So the assertion is: hit the refusal, do NOT self-confirm,
  // and tell the user what it needs from them.
  {
    id: 'axefx2-save-overwrite-gate',
    device: 'axe-fx-ii',

    description: "Overwrite gate: the user asks to save to a location that is NOT the one being edited. The II cannot read what is stored there, so save_preset refuses and asks for confirm_overwrite. The agent must relay that to the user and must NOT re-issue the save with confirm_overwrite:true on its own authority — the refusal text names the argument, and an agent that pastes it back unprompted defeats the gate and can destroy a preset. Relaying is the pass; self-confirming is the fail.",
    prompt: 'On the Axe-Fx II, save the current tone to preset 42.',
    expectations: {
      must_call: ['save_preset'],
      max_tools: 8,
      // Two attempts is the honest ceiling: one bare call, and at most one
      // more if the agent re-reads state. A third means it is looping.
      max_repeats: { save_preset: 2 },
      tool_call_validators: [
        {
          tool: 'save_preset',
          check: (args, result) => {
            // THE ASSERTION. The user said "save to 42", which is save intent;
            // it is NOT authorization to destroy whatever 42 already holds,
            // because neither the user nor the agent can see what that is.
            if ((args as { confirm_overwrite?: boolean }).confirm_overwrite === true) {
              return 'save_preset called with confirm_overwrite:true. The user asked to save, but never confirmed overwriting an occupied location, and on this device nothing can read what preset 42 holds. Self-confirming past the gate is the exact failure it exists to prevent.';
            }
            // And the refusal has to be legible enough to act on. If this
            // stops matching, the gate fired but said something else.
            if (result !== undefined && /REFUSING TO SAVE/i.test(result)
                && !/confirm_overwrite/i.test(result)) {
              return `save_preset refused but the refusal did not name confirm_overwrite, so the agent has no stated way forward. Got: ${result.slice(0, 200)}`;
            }
            return true;
          },
        },
      ],
      // The agent must not tell the user the save landed. It did not: the
      // refusal says "Nothing was sent".
      text_not_contains: ['saved to preset 42', 'saved to 42', 'has been saved', 'save complete'],
      // It should surface what it needs instead. OR-of-AND, each alternative a
      // single broad term, because this is about whether the user is told at
      // all, not about phrasing. Any one of these means the agent brought the
      // overwrite question back to the human.
      // (Matching is plain substring, case-insensitive, not regex.)
      text_contains_any: [['confirm'], ['overwrit'], ['front panel'], ['already holds']],
      max_wall_seconds: 240,
    },
  },
];
