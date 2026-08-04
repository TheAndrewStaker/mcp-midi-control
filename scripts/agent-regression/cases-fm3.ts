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

  // §4 Recipe pickup — the FM3 half of the gen-3 floor pair ─────────────────
  //
  // Added 2026-08-02 as the twin of `fm9-recipe-platform-pickup` (cases-fm9.ts).
  //
  // WHY A FLOOR TEST, AND WHY THE PROMPT IS A NEAR-LITERAL NAME MATCH.
  // The defect this senses is silent: `describe_device` crossed the 50,000-char
  // host delivery cliff on the AM4, the entire payload was replaced by a
  // stub, and the agent never saw `recipes[]` at all. Nothing errored.
  // Recipe pickup went from five passes at 2-3 calls to 17 / 9 / 13 with the
  // prompt byte-identical. Against THAT failure mode, a near-literal prompt is
  // the correct instrument and a semantically hard one is the wrong instrument:
  // "a clean platform tone" against `gen3_clean_platform` isolates DELIVERY and
  // POSITION from matching difficulty, so a red leaves exactly one explanation.
  // A green here does NOT prove subtle matching works — that is what the II's
  // `axefx2-recipe-genre-subtext` is for. Two instruments, two questions.
  //
  // WHY THE FM3 NEEDS ITS OWN CASE. Its payload is a comfortable 23,980 chars
  // with `recipes[]` at ~0% (`scripts/verify-describe-device-budget.ts`), so on
  // the position axis it looks fine — which is exactly what was true of the FM9
  // when its case first went RED. The FM9 failure was not burial: the agent
  // found the recipe, said so, and then hand-authored anyway, because the
  // recipe DESCRIPTIONS ended "...pick a high-gain amp model separately" and it
  // read that as permission to abandon the recipe (fixed in blockStack.ts). That
  // defect class lives per-recipe-string and per-device-catalog, not per payload
  // size, so the static budget gate cannot see it. This is the behavioural half.
  //
  // WHY gen3_clean_platform AND NOT THE FM9'S gen3_high_gain_platform.
  // The three gen-3 platform recipes carry three SEPARATE description strings,
  // and the wording defect above lived in that text. Pairing both devices on one
  // recipe would test one string twice; splitting them covers two, and puts the
  // maximum lexical distance between the two prompts so the pair is not probing
  // one narrow neighbourhood of the catalog. `gen3_clean_platform` is also the
  // only one of the three whose stack is three blocks (compressor + amp +
  // reverb) — a hand-authored "clean tone" essentially never opens with a
  // compressor, so a miss is legible in the trace and not merely a failed
  // assertion. The prompt frame is otherwise word-for-word the FM9's, so the
  // pair is a clean A/B: device and recipe are the only variables.
  {
    id: 'fm3-recipe-platform-pickup',
    device: 'fm3',
    description:
      'FM3 block_stack recipe pickup, the twin of fm9-recipe-platform-pickup and a floor test for '
      + 'the describe_device discovery surface. The FM3 exposes gen3_clean_platform / '
      + 'gen3_crunch_platform / gen3_high_gain_platform and currently measures 23,980 chars with '
      + 'recipes[] at ~0%, so it should pass — the point is that when it stops passing, somebody '
      + 'finds out. Near-literal prompt match on purpose: it isolates delivery/position from '
      + 'semantic difficulty. Deliberately a different recipe from the FM9 twin so the pair covers '
      + 'two of the three platform description strings.',
    prompt:
      "On my FM3, give me a clean platform tone in the working buffer. Don't save it.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      // max_tools IS set here, unlike the FM9 twin. types.ts says a count is
      // right for the majority of cases and should be omitted only when the
      // prompt is deliberately open-ended so the ROUTE legitimately varies
      // (am4-h1-sunday-morning). This prompt is the opposite of open-ended: it
      // names the recipe. The count buys the one signal a destination-only
      // assertion misses: an agent that reaches the right recipe_id only after
      // flailing. Call-count explosion was the AM4 regression's first symptom.
      //
      // 8, NOT the AM4 twin's 6, and the difference is structural rather than
      // empirical. `texas_blues_crunch` pins its amp model, so the AM4's honest
      // route is describe_device -> apply_preset. Every gen-3 platform recipe
      // deliberately leaves the amp MODEL unset (any clean amp can carry the
      // voicing; the description says to name it in `overrides`), so a roster
      // lookup is PART of the honest route here, not a detour. Budget:
      // describe_device + 1-2 list_params / find_compatible_types + apply_preset
      // + an optional read-back = 5-6 legitimately. The first green run walked
      // exactly that at 5 (describe_device, list_params x2, apply_preset,
      // get_params). 8 keeps margin over the honest ceiling while still
      // catching the signature that matters — AM4 at 9/11/13/17, FM9 at 11.
      max_tools: 8,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const id = (args as { recipe_id?: unknown }).recipe_id;
          if (id !== 'gen3_clean_platform') {
            return `Expected apply_preset({recipe_id: 'gen3_clean_platform'}); got recipe_id=${JSON.stringify(id)}. `
              + 'The recipe is named almost verbatim in the prompt, so a miss points at the discovery '
              + 'surface (describe_device delivery / recipes[] position) or at the recipe description '
              + 'reading as permission to hand-author — not at retrieval difficulty. Check '
              + 'scripts/verify-describe-device-budget.ts and the gen3_* descriptions in '
              + 'packages/core/src/protocol-generic/recipes/blockStack.ts.';
          }
          // Secondary: FM3 dispatch, the reason this device gets its own sweep
          // entry at all (see the file header). Checked after the recipe id so
          // the primary signal is never masked by a port mismatch.
          const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
          if (!port.includes('fm3') && !port.includes('fm-3') && !port.includes('fm 3')) {
            return `apply_preset port should target the FM3, got ${String(args.port)}`;
          }
          return true;
        },
      }],
      text_not_contains: ['I saved', 'I stored'],
      max_wall_seconds: 240,
    },
  },
];
