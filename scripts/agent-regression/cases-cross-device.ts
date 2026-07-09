/**
 * Cross-device agent-regression cases.
 *
 * translate_preset was restored after the schema bloat was resolved by
 * flattening presetSlotShape. Cases here exercise cross-device porting
 * prompts with RESPONSE-LEVEL assertions: checking not just which tools
 * the agent calls, but what the tools return.
 */

import type { AgentRegressionCase } from './types.js';

export const CROSS_DEVICE_CASES: AgentRegressionCase[] = [
  // Merged from cross-translate-ii-to-am4-enum-mapping +
  // cross-translate-response-shape (previously two separate cases
  // that both called translate_preset II->AM4 with overlapping checks).
  {
    id: 'cross-translate-ii-to-am4',
    device: 'axe-fx-ii',

    description: 'translate_preset II->AM4: enum mapping + response shape. Agent translates a Shiver/Brit800 preset to AM4 and the response must include port_summary with blocks_translated > 0, source/target_device fields, and ok not false.',
    prompt: 'I have a preset on the Axe-Fx II with a Shiver Clean amp and a Brit 800 amp. Translate it to the AM4 using translate_preset. Just show me the result, do not apply.',
    expectations: {
      must_call: ['translate_preset'],
      max_tools: 8,
      tool_call_validators: [
        {
          tool: 'translate_preset',
          check: (args, result) => {
            if (args.target_port !== 'am4' && args.target_port !== 'AM4') {
              return `translate_preset target_port should be am4, got ${String(args.target_port)}.`;
            }
            if (result === undefined) return true;
            if (/"ok":\s*false/.test(result.slice(0, 80))) {
              return `translate_preset returned ok:false. Response head: ${result.slice(0, 300)}.`;
            }
            if (!/"port_summary"/.test(result)) {
              return `translate_preset response missing port_summary field.`;
            }
            if (!/"blocks_translated"/.test(result)) {
              return `translate_preset response missing blocks_translated.`;
            }
            const btMatch = result.match(/"blocks_translated":\s*(\d+)/);
            if (btMatch && parseInt(btMatch[1], 10) === 0) {
              return `translate_preset blocks_translated is 0 for a preset with 2 amps.`;
            }
            if (!/"source_device"/.test(result)) {
              return `translate_preset response missing source_device.`;
            }
            if (!/"target_device"/.test(result)) {
              return `translate_preset response missing target_device.`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 120,
    },
  },

  // Adds III as a translate_preset target. III is the project's only
  // device with both a grid layout (like II) and A/B/C/D channel
  // vocabulary (like AM4), so the AM4-to-III leg exercises a channel-
  // identity remap + linear-to-grid slot expansion in the same call.
  // Response-shape assertions mirror the II→AM4 case so a regression
  // on either translator direction surfaces in the sweep.
  {
    id: 'cross-translate-am4-to-iii',
    device: 'am4',
    description: 'translate_preset AM4->III: linear-to-grid slot expansion + A/B/C/D channel identity. Agent translates a 4-channel AM4 preset to III and the response must include port_summary with blocks_translated > 0, source/target_device fields, and ok not false.',
    prompt: 'I have an AM4 preset with a Shiver Clean amp, a delay, and a reverb. Translate it to the Axe-Fx III using translate_preset. Just show me the result, do not apply.',
    expectations: {
      must_call: ['translate_preset'],
      max_tools: 8,
      tool_call_validators: [
        {
          tool: 'translate_preset',
          // Validate the FINAL translate call: the agent may make an
          // exploratory translate (e.g. to II) before the III answer; its
          // last call is the real result for "translate it to the III".
          call_index: 'last',
          check: (args, result) => {
            const tgt = String(args.target_port).toLowerCase();
            // Separator between "fx" and "iii" may be a hyphen (the real port
            // id is "axe-fx-iii"), a space, or nothing — accept all three.
            // The old `/axe-?fx ?(iii|3)/` only allowed an optional SPACE, so
            // the correct id "axe-fx-iii" failed with "should be X, got X".
            if (!/axe-?fx[- ]?(iii|3)/.test(tgt)) {
              return `translate_preset target_port should be axe-fx-iii, got ${String(args.target_port)}.`;
            }
            if (result === undefined) return true;
            if (/"ok":\s*false/.test(result.slice(0, 80))) {
              return `translate_preset returned ok:false. Response head: ${result.slice(0, 300)}.`;
            }
            if (!/"port_summary"/.test(result)) {
              return `translate_preset response missing port_summary field.`;
            }
            if (!/"blocks_translated"/.test(result)) {
              return `translate_preset response missing blocks_translated.`;
            }
            const btMatch = result.match(/"blocks_translated":\s*(\d+)/);
            if (btMatch && parseInt(btMatch[1], 10) === 0) {
              return `translate_preset blocks_translated is 0 for a preset with 3 blocks.`;
            }
            if (!/"source_device"/.test(result)) {
              return `translate_preset response missing source_device.`;
            }
            if (!/"target_device"/.test(result)) {
              return `translate_preset response missing target_device.`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 120,
    },
  },

  {
    id: 'cross-axefx2-apply-response-no-drops',
    device: 'axe-fx-ii',
    // Originally a "did the apply land without dropped-param warnings" guard.
    // Extended to also exercise the scene-pointer and channel-shape hazards:
    //   - Scene pointer: apply_preset(landingScene:1), then followup writes,
    //          then get_preset must still report active_scene:1. The pre-fix
    //          executor's final landing op was fire-and-forget; subsequent
    //          writes could leave the device pointer on scene 4 (last-authored).
    //   - Channel shape: when the caller opts into per-channel state
    //          (include_channel_state:true), every channel-bearing slot in
    //          get_preset must use params_by_channel (never flat params), or
    //          intra-response shape divergence breaks agent state-anchoring.
    //          II get_preset now defaults to active-channel FLAT params, so
    //          this check only fires in the opt-in path.
    // One agent prompt now exercises: 4-scene build + landingScene + post-
    // apply writes + readback. Costs ~1 sweep slot, covers 3 bug classes.
    description: 'Multi-scene II workflow guard. Builds a 4-scene preset with landingScene:1, tweaks the compressor, bypasses the cab, then reads back. Asserts (a) no dropped-param warnings, (b) active_scene survives the post-apply writes, (c) when include_channel_state:true is requested, channel-bearing slots in get_preset use params_by_channel.',
    prompt: "Build a preset on the Axe-Fx II with 4 scenes. Scene 1: clean Shiver Clean amp, compressor in front with threshold -20 and ratio 4, delay and reverb. Scene 2: crunch with a Brit 800 amp, reverb only. Scene 3: high-gain rhythm, same Brit 800 amp but higher gain. Scene 4: lead with Shiver Lead amp, delay and reverb. Land on scene 1. Working buffer only, do not save. After applying, set the compressor threshold to -25, bypass the cab, then call get_preset and tell me which scene is currently active.",
    expectations: {
      must_call: ['describe_device', 'apply_preset', 'get_preset'],
      max_tools: 14,
      max_repeats: { apply_preset: 3, get_preset: 2 },
      should_avoid_dropped_param_warning: true,
      tool_call_validators: [
        {
          tool: 'apply_preset',
          // Validate the agent's FINAL apply: on this heavy 4-scene build the
          // agent sometimes fuzzes an enum on the first attempt (e.g. delay
          // tempo "1/4 D" for "1/4 DOT"), gets ok:false, and self-corrects on
          // a retry. The last apply is the real build; checking #0 would
          // penalize the (healthy) self-correction.
          call_index: 'last',
          check: (args, result) => {
            // Scene-pointer setup: apply must land on scene 1 so the drift
            // check below is meaningful. The agent might forget the
            // landingScene if the prompt doesn't say it explicitly enough,
            // so flag here for a clear cause rather than a confusing
            // get_preset failure.
            const spec = (args.spec ?? {}) as { landingScene?: unknown };
            if (spec.landingScene !== 1) {
              return `apply_preset spec.landingScene should be 1 (prompt: "Land on scene 1"). Got ${JSON.stringify(spec.landingScene)}.`;
            }
            if (result === undefined) return true;
            if (/"ok":\s*false/.test(result.slice(0, 80))) {
              return `apply_preset returned ok:false. Response head: ${result.slice(0, 300)}.`;
            }
            return true;
          },
        },
        {
          tool: 'get_preset',
          check: (_args, result) => {
            if (result === undefined) {
              return 'get_preset called but result text is missing; cannot verify scene pointer or channel shape.';
            }
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(result) as Record<string, unknown>;
            } catch {
              return `get_preset result not JSON (truncated): ${result.slice(0, 200)}`;
            }
            // Scene pointer must still be on the landing scene after the
            // post-apply writes. Pre-fix this drifted to 4 (last-authored).
            if (parsed.active_scene !== 1) {
              return (
                `scene-pointer regression: get_preset.active_scene should still be 1 after ` +
                `apply(landingScene:1) + set_params + set_bypass, got ` +
                `${JSON.stringify(parsed.active_scene)}. The device's scene pointer ` +
                `drifted between the apply and the readback.`
              );
            }
            // Channel-bearing slots must use params_by_channel, never
            // flat params. II get_preset attributes the ACTIVE channel from
            // the fn 0x0E QUERY_STATES map (zero extra round-trips) and
            // returns params_by_channel:{X} + channel_status:'active' by
            // default; include_channel_state:true additionally walks the
            // inactive channel and returns {X,Y}. Either way the shape is
            // nested. Flat params on a channel-bearing slot means active-
            // channel attribution was lost, unless the channel read
            // genuinely failed (channel_status:'unknown'), which is the
            // only allowed flat case.
            const slots = parsed.slots as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(slots)) {
              const channelBearing = new Set(['amp', 'drive', 'reverb', 'delay']);
              const offenders: string[] = [];
              for (const s of slots) {
                const bt = String(s.block_type).toLowerCase();
                if (!channelBearing.has(bt)) continue;
                const hasFlat = s.params !== undefined;
                const hasNested = s.params_by_channel !== undefined;
                const channelStatus = String(s.channel_status ?? '');
                if (hasFlat && !hasNested && channelStatus !== 'unknown') offenders.push(bt);
              }
              if (offenders.length > 0) {
                return (
                  `channel-shape regression: channel-bearing slot(s) returned flat params ` +
                  `instead of params_by_channel (active-channel attribution lost): ` +
                  `${offenders.join(', ')}.`
                );
              }
            }
            return true;
          },
        },
      ],
      text_not_contains: ['I saved', 'I stored', 'preset is saved'],
      max_wall_seconds: 540,
    },
  },

  // ── Tool coverage gap closers ──────────────────────────────────────

  {
    id: 'cross-translate-axefx3-location-to-am4',
    device: 'axe-fx-iii',
    description:
      'translate_preset with source_location: porting a STORED gen-3 preset to AM4 should call ' +
      'translate_preset with source_location (the one-call read+decode+translate path), NOT ask ' +
      'the user to hand-build a source spec. The gen-3 mock answers fn=0x03 with a decodable dump.',
    prompt:
      "Port stored preset number 5 from my Axe-Fx III over to my AM4 using translate_preset. Just show me the translated result, don't apply it.",
    expectations: {
      must_call: ['translate_preset'],
      max_tools: 8,
      tool_call_validators: [{
        tool: 'translate_preset',
        check: (args, result) => {
          if (args.source_location === undefined) {
            return 'translate_preset should pass source_location to read the stored gen-3 preset, not require a hand-built source_spec.';
          }
          if (args.target_port !== 'am4' && args.target_port !== 'AM4') {
            return `translate_preset target_port should be am4, got ${String(args.target_port)}.`;
          }
          if (result === undefined) return true;
          // FIXTURE-GAP RE-SCOPE 2026-06-10: the gen-3 parityMock's
          // fn=0x03 dump is deliberately SPARSE (scene names only, empty
          // grid/block chain — parityMock.ts buildStoredPresetDump), so
          // the decode correctly yields zero blocks and translate
          // correctly reports ok:false with the explanatory
          // "no translatable blocks" note. This case's job is the AGENT
          // behavior (use source_location, target am4), so accept the
          // sparse-source outcome; tighten back to ok:true when the mock
          // fixture grows a real grid + amp block.
          if (/"ok":\s*false/.test(result.slice(0, 80)) && !/no translatable blocks/.test(result)) {
            return `translate_preset returned ok:false without the sparse-source note. Response head: ${result.slice(0, 300)}.`;
          }
          if (!/"port_summary"/.test(result)) {
            return 'translate_preset response missing port_summary.';
          }
          return true;
        },
      }],
      max_wall_seconds: 180,
    },
  },

  {
    id: 'cross-am4-get-preset-state-anchor',
    device: 'am4',

    description: 'get_preset routing: "what is on the device" prompt should call get_preset, not a series of get_param calls. Tests state-anchoring read path. Mock describe_device response is ~80KB; agent may hit context limits on recovery paths.',
    prompt: "What's currently loaded on the AM4? Give me a full snapshot of every block and its settings.",
    expectations: {
      must_call: ['get_preset'],
      max_tools: 10,
      max_wall_seconds: 180,
    },
  },

  {
    id: 'cross-axefx2-switch-preset',
    device: 'axe-fx-ii',

    description: 'switch_preset routing: "load preset N" should call switch_preset, not apply_preset.',
    prompt: 'Load preset 3 on the Axe-Fx II.',
    expectations: {
      must_call: ['switch_preset'],
      must_not_call: ['apply_preset'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'switch_preset',
        check: (args) => {
          if (args.port !== 'axe-fx-ii') {
            return `switch_preset port should be axe-fx-ii, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },

  {
    id: 'cross-am4-list-params-reverb-types',
    device: 'am4',

    description: 'list_params routing: "what reverb types are available" should call list_params (not lookup_lineage). Tests enum-discovery path.',
    prompt: 'What reverb types does the AM4 support? List them all.',
    expectations: {
      must_call: ['list_params'],
      must_not_call: ['lookup_lineage'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'list_params',
        check: (args) => {
          const block = String(args.block ?? '').toLowerCase();
          if (block !== 'reverb') {
            return `list_params should query block=reverb, got ${block}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },

  {
    id: 'cross-am4-find-compatible-types',
    device: 'am4',

    description: 'find_compatible_types routing: "which reverb types expose time" should call find_compatible_types. Tests param-gated discovery.',
    prompt: 'Which reverb types on the AM4 expose a time control?',
    expectations: {
      must_call: ['find_compatible_types'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'find_compatible_types',
        check: (args) => {
          if (args.port !== 'am4') {
            return `find_compatible_types port should be am4, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 120,
    },
  },

  {
    id: 'cross-axefx2-save-preset-explicit',
    device: 'axe-fx-ii',

    description: 'save_preset positive path: explicit save vocabulary should route to save_preset. Tests the save-authorization gate in the positive direction.',
    prompt: 'Save the current Axe-Fx II working buffer to slot 666 and name it "Test Save".',
    expectations: {
      must_call: ['save_preset'],
      max_tools: 8,
      tool_call_validators: [{
        tool: 'save_preset',
        check: (args) => {
          if (args.port !== 'axe-fx-ii') {
            return `save_preset port should be axe-fx-ii, got ${String(args.port)}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 120,
    },
  },

  {
    id: 'cross-am4-recipe-wah-cocked',
    device: 'am4',

    description: 'Wah recipe pickup: "cocked wah parked halfway" should reach for the wah_cocked_mid recipe or equivalent knob values. Tests single-block recipe discovery.',
    prompt: 'Set up a cocked wah on the AM4, parked about halfway for a mid-focused honk.',
    expectations: {
      must_call: ['describe_device'],
      must_call_any: [
        ['apply_preset'],
        ['set_block', 'set_params'],
        ['set_block', 'set_param'],
      ],
      max_tools: 10,
      max_wall_seconds: 240,
    },
  },

  // ── Coverage: describe_rig (multi-device orchestration cornerstone) ────────
  {
    id: 'cross-describe-rig-overview',
    device: 'am4', // device field is for harness availability; describe_rig is rig-wide (no port)
    description: 'Multi-device orchestration: a "what gear can you control / show me the whole rig" request should call describe_rig (the whole-rig overview, no port) FIRST, not enumerate per-device describe_device calls or guess. describe_rig is the Decision-2 orchestration cornerstone and had zero agent-sweep coverage. Pure introspection, mock-runnable. Catches an agent that fabricates the device list or reaches for list_midi_ports (lower-level) when asked about controllable gear.',
    prompt: 'What music gear can you control through this server? Give me the whole rig — which devices are set up and which are connected right now.',
    expectations: {
      must_call: ['describe_rig'],
      must_not_call: ['describe_device'], // a whole-rig question is describe_rig's job, not N per-device calls
      max_tools: 4,
      text_not_contains: ['I cannot', 'I am not able', 'no access'],
      max_wall_seconds: 90,
    },
  },
];
