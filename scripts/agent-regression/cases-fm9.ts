/**
 * FM9 agent-regression cases.
 *
 * The FM9 is a gen-3 sibling of the Axe-Fx III: same codec, same 6x14 grid,
 * 8 scenes, A-D channels. Its value as a SEPARATE sweep case (rather than
 * relying on the III cases) is that it proves device DISPATCH and the
 * FM9-true param catalog: a `port: "fm9"` request must route to the FM9
 * descriptor (model byte 0x12, FM9 paramIds) and NOT fall through to the III
 * or the AM4 catch-all. The shared codec means FM3/VP4 don't each need a
 * case; one floor-unit sibling proves the factory dispatch pattern.
 *
 * Mock transport: the FM9 connector synthesizes the gen-3 read burst
 * (`makeGen3BroadcastMockResponder({ modelByte: 0x12 })`), and the MCP server
 * is force-connected before the agent starts (`alwaysLoad`).
 *
 * Unlike the earlier gen-3 framing, FM9 amp / drive / reverb types ARE settable
 * AND readable by their real Fractal model names (device-true rosters mined from
 * the FM9-Edit cache: amp 331, drive 86, reverb 79). The `fm9-named-tone-build`
 * case below exercises that explicitly, and doubles as the check that the tool
 * descriptions don't gate the agent into numeric-only writes.
 */

import type { AgentRegressionCase } from './types.js';

export const FM9_CASES: AgentRegressionCase[] = [
  {
    id: 'fm9-tone-build-4scene',
    device: 'fm9',
    description:
      'Four-scene guitar preset on the FM9 (clean / crunch / high-gain / lead). Proves device ' +
      'dispatch (port "fm9" routes to the FM9 descriptor, not the III/AM4 catch-all) + the ' +
      'FM9-true catalog + grid apply_preset/routing/scenes end to end.',
    prompt:
      "Build a 4-scene preset on my FM9. Scene 1: clean with reverb. Scene 2: crunchy rhythm. " +
      "Scene 3: heavy rhythm with a drive pedal. Scene 4: lead with delay. Put an amp and cab " +
      "in the chain. Use the working buffer, don't save.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 14,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const spec = (args.spec ?? {}) as { scenes?: unknown; slots?: unknown[] };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          const hasAmp = Array.isArray(spec.slots) && spec.slots.some(
            (s) => s !== null && typeof s === 'object' && (s as { block_type?: string }).block_type === 'amp',
          );
          if (!hasAmp) return 'apply_preset spec is missing an amp slot.';
          return true;
        },
      }],
      text_not_contains: [
        'I saved', 'I persisted', 'I stored',
        'preset is saved', 'now saved to', 'now persisted to', 'now stored to',
      ],
      max_wall_seconds: 360,
    },
  },
  {
    id: 'fm9-named-tone-build',
    device: 'fm9',
    description:
      'FM9 tone build that NAMES the amp, drive, and reverb models by their real Fractal names ' +
      '("Texas Star Clean", "Blues OD", "Music Hall"). Proves (a) the device-true FM9 rosters ' +
      'resolve set-by-name end to end, and (b) the tool descriptions do NOT gate the agent into ' +
      'numeric-only writes or make it claim the models cannot be named. Large primary-tool ' +
      'coverage: describe_device + a grid build with named models.',
    prompt:
      "On my FM9 working buffer, build a lead tone: use a Texas Star Clean amp into a 4x12 cab, " +
      "with a Blues OD drive in front, a delay, and a Music Hall reverb. Don't save it.",
    expectations: {
      must_call: ['describe_device'],
      // A fresh build is apply_preset's job, but accept a place-then-set path too.
      must_call_any: [['apply_preset'], ['set_block']],
      max_tools: 16,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [
        {
          // If the agent builds via apply_preset, the spec must carry the NAMED
          // models (not numbers), proving set-by-name flowed through.
          tool: 'apply_preset',
          call_index: 0,
          optional: true,
          check: (args) => {
            const spec = (args.spec ?? {}) as { slots?: unknown[] };
            const slots = Array.isArray(spec.slots) ? spec.slots : [];
            const blob = JSON.stringify(slots).toLowerCase();
            const named = ['texas star clean', 'blues od', 'music hall'].filter((n) => blob.includes(n));
            if (named.length === 0) {
              return 'apply_preset spec carries no named amp/drive/reverb model; agent fell back to numeric (description may be underselling set-by-name).';
            }
            return true;
          },
        },
        {
          // If the agent sets a type via set_param, the value should be a NAME
          // string, not a number.
          tool: 'set_param',
          optional: true,
          check: (args) => {
            const name = String((args as { name?: string }).name ?? '').toLowerCase();
            if (!name.includes('type')) return true; // only police type/model sets
            const v = (args as { value?: unknown }).value;
            if (typeof v === 'number') {
              return `set_param ${name} used a numeric value ${v} instead of a model name (description may be underselling set-by-name).`;
            }
            return true;
          },
        },
      ],
      // Underselling / gating tells: the agent must NOT claim FM9 models are numbers-only.
      text_not_contains: [
        'numeric only', 'by number', 'model number', 'amp models are numeric',
        "can't be named", 'cannot be named', 'not settable by name', "can't set by name",
        'I saved', 'now saved to', 'now persisted to', 'now stored to',
      ],
      max_wall_seconds: 360,
    },
  },
  {
    id: 'fm9-read-live-grid',
    device: 'fm9',
    description:
      'Read the active FM9 preset and report its signal-chain LAYOUT. Proves get_preset surfaces ' +
      'the live routing grid (live_grid, fn=0x01 sub=0x2E) so the agent can describe where blocks ' +
      'sit — not just a flat block list — and does NOT claim gen-3 routing is unreadable.',
    prompt:
      "What's currently on my FM9? Show me the signal chain — which blocks are in the preset and " +
      'where they sit in the grid. Just read it, don\'t change anything.',
    expectations: {
      must_call: ['get_preset'],
      must_not_call: ['apply_preset', 'set_param', 'set_block', 'save_preset'],
      max_tools: 6,
      // The mock preset places Input + Amp + Reverb + Delay; the agent should
      // describe the chain (mention at least the amp), proving it read live_grid.
      text_contains_any: [['Amp'], ['amp'], ['amplifier']],
      // Must not claim it can't see the routing/layout (the pre-grid gap).
      text_not_contains: [
        'no routing', 'routing is not', "can't read the grid", 'cannot read the grid',
        'no positioned grid', 'not able to read', 'layout is unavailable', 'I saved',
      ],
      max_wall_seconds: 240,
    },
  },
  {
    id: 'fm9-read-cpu-headroom',
    device: 'fm9',
    description:
      'Ask how much CPU/DSP headroom the active FM9 preset uses. Proves the agent reaches for ' +
      'get_preset (which now surfaces live_meters.cpu_percent from the same sub=0x2E frame as ' +
      'live_grid) to answer a CPU-load question, rather than claiming it cannot read CPU usage.',
    prompt:
      "How much CPU is my current FM9 preset using? Is there headroom to add another block? " +
      "Just read it, don't change anything.",
    expectations: {
      must_call: ['get_preset'],
      must_not_call: ['apply_preset', 'set_param', 'set_block', 'save_preset'],
      max_tools: 6,
      // The agent should report a CPU/DSP figure from live_meters.cpu_percent.
      text_contains_any: [['CPU'], ['cpu'], ['DSP'], ['%'], ['headroom'], ['load']],
      text_not_contains: [
        "can't read", 'cannot read the CPU', 'no CPU', 'CPU usage is not', 'I saved',
      ],
      max_wall_seconds: 240,
    },
  },
  {
    id: 'fm9-amp-applicability',
    device: 'fm9',
    description:
      'Ask which FM9 amp models expose a specific knob. Proves the gen-3 amp type-knob ' +
      'applicability is reachable (find_compatible_types / list_params) so the agent narrows by ' +
      'capability instead of claiming it cannot tell which amps have the control.',
    prompt:
      'On my FM9, I want an amp model that has a Depth (sag) control. Which amp models expose a ' +
      'Depth knob? Just tell me — no need to change the preset.',
    expectations: {
      // Either the dedicated tool or list_params is an acceptable path.
      must_call_any: [['find_compatible_types'], ['list_params']],
      must_not_call: ['apply_preset', 'save_preset'],
      max_tools: 6,
      tool_call_validators: [
        {
          tool: 'find_compatible_types',
          optional: true,
          check: (args) => {
            const block = String((args as { block?: string }).block ?? '').toLowerCase();
            if (block !== 'amp') return `find_compatible_types called for "${block}", expected amp.`;
            const params = (args as { params?: unknown }).params;
            const list = Array.isArray(params) ? params.map((p) => String(p).toLowerCase()) : [];
            if (!list.some((p) => p.includes('depth'))) {
              return `find_compatible_types params ${JSON.stringify(params)} should include depth.`;
            }
            return true;
          },
        },
      ],
      // Must not hedge that gen-3 applicability is unknowable.
      text_not_contains: [
        "can't tell which", 'cannot tell which', 'no way to know', 'not able to determine',
        'all amps have', 'every amp has',
      ],
      max_wall_seconds: 240,
    },
  },

  // ── Recipe pickup: a FLOOR test for discovery-surface burial ──────
  //
  // Added 2026-08-02 to test a PREDICTION rather than a known defect.
  //
  // `scripts/verify-describe-device-budget.ts` measures where each device's
  // `recipes[]` starts in its describe_device payload. The AM4's sits at ~71%
  // and its recipe pickup measurably broke (five passes at 2-3 calls, then
  // three failures at 17/9/13 with the prompt byte-identical). The FM9's sits
  // at 78% and the FM3's at 76% — DEEPER than the device where retrieval
  // broke — and no gen-3 case tested recipe pickup at all, so nobody would
  // notice. This case closes that blind spot.
  //
  // WHY THE PROMPT IS A NEAR-LITERAL NAME MATCH, deliberately. An adversarial
  // review pointed out that the II's recipe case is close to tautological:
  // prompt "classic rock Plexi" against recipe `classic_rock_plexi`. That is a
  // fair criticism of a case meant to test SEMANTIC retrieval. It is the right
  // design for a case testing BURIAL: if the agent cannot find a recipe whose
  // name is sitting in the prompt, position is the only remaining explanation.
  // A red here is unambiguous; a green does not prove subtle matching works.
  {
    id: 'fm9-recipe-platform-pickup',
    device: 'fm9',
    description:
      'FM9 block_stack recipe pickup, as a floor test for describe_device burial. The FM9 exposes '
      + 'gen3_clean_platform / gen3_crunch_platform / gen3_high_gain_platform, and its recipes[] '
      + 'starts ~78% into the payload — past the position at which AM4 recipe pickup regressed. '
      + 'Near-literal prompt match on purpose: this isolates POSITION from semantic difficulty.',
    prompt:
      "On my FM9, give me a high-gain platform tone in the working buffer. Don't save it.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const id = (args as { recipe_id?: unknown }).recipe_id;
          if (id !== 'gen3_high_gain_platform') {
            return `Expected apply_preset({recipe_id: 'gen3_high_gain_platform'}); got recipe_id=${JSON.stringify(id)}. `
              + 'The recipe is named almost verbatim in the prompt, so a miss here points at describe_device '
              + 'burial (recipes[] starts ~78% in) rather than at retrieval difficulty. Check '
              + 'scripts/verify-describe-device-budget.ts.';
          }
          return true;
        },
      }],
      // No max_tools: this asserts the DESTINATION. A count here would just
      // re-litigate the am4-h1-sunday-morning lesson (see cases-am4.ts).
      text_not_contains: ['I saved', 'I stored'],
      max_wall_seconds: 240,
    },
  },
];
