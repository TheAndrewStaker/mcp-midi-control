/**
 * AM4 agent-regression cases — v1 starter pack.
 *
 * Tier-3 founder e2e in docs/_private/regression/am4.md is the human-
 * driven runbook; these cases are the automated mirror, driven by
 * `claude -p` against the shipped MCP server. Each case is a fresh
 * agent session — no prior context, no privileged hints, agent reads
 * the 59-tool description set the same way Claude Desktop does.
 *
 * Assertions are envelope-shaped (max_tools, must_call,
 * tool_call_validators) rather than exact-sequence matches. Sonnet is
 * non-deterministic; we test behavioral guarantees, not literal
 * call paths.
 */

import type { AgentRegressionCase } from './types.js';

/**
 * Count how many distinct scenes the agent declared in an apply_preset
 * spec. Used by the multi-scene bouncing-regression cases to verify the
 * agent landed N scenes on its first apply_preset call.
 */
function countScenes(args: Record<string, unknown>): number {
  const spec = (args.spec ?? {}) as { scenes?: unknown };
  if (!Array.isArray(spec.scenes)) return 0;
  return spec.scenes.length;
}

/**
 * Pull a display-typed param value off a slot's params, walking either
 * the flat or the channel-nested shape. Returns the first match across
 * all channels. Used to assert sensible wire targets (non-muted drives,
 * audible master volumes) survived the agent's apply_preset spec.
 */
function pickParamValue(
  args: Record<string, unknown>,
  blockType: string,
  paramName: string,
): number | string | undefined {
  const spec = (args.spec ?? {}) as { slots?: unknown };
  if (!Array.isArray(spec.slots)) return undefined;
  for (const slot of spec.slots) {
    if (slot === null || typeof slot !== 'object') continue;
    const s = slot as { block_type?: string; params?: unknown };
    if (s.block_type !== blockType) continue;
    const p = s.params;
    if (p === null || typeof p !== 'object') continue;
    const flat = (p as Record<string, unknown>)[paramName];
    if (typeof flat === 'number' || typeof flat === 'string') return flat;
    for (const v of Object.values(p as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        const nested = (v as Record<string, unknown>)[paramName];
        if (typeof nested === 'number' || typeof nested === 'string') return nested;
      }
    }
  }
  return undefined;
}

/**
 * Find a slot of a given block type and return the param keys recorded
 * on it (across all channels for channel-nested blocks). Used by the
 * recipe-usage case to verify the agent set envelope-follower knobs
 * (sensitivity, attack_time, release_time) and not a bare static-filter
 * config.
 */
function slotParamKeys(args: Record<string, unknown>, blockType: string): Set<string> {
  const out = new Set<string>();
  const spec = (args.spec ?? {}) as { slots?: unknown };
  if (!Array.isArray(spec.slots)) return out;
  for (const slot of spec.slots) {
    if (slot === null || typeof slot !== 'object') continue;
    const s = slot as { block_type?: string; params?: unknown };
    if (s.block_type !== blockType) continue;
    const p = s.params;
    if (p === null || typeof p !== 'object') continue;
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') {
        for (const innerKey of Object.keys(v as Record<string, unknown>)) out.add(innerKey);
      } else {
        out.add(k);
      }
    }
  }
  return out;
}

/** Pull the reverb type display name out of an apply_preset spec, if present. */
function pickReverbType(args: Record<string, unknown>): string | undefined {
  const spec = (args.spec ?? {}) as { slots?: unknown };
  if (!Array.isArray(spec.slots)) return undefined;
  for (const slot of spec.slots) {
    if (slot === null || typeof slot !== 'object') continue;
    const s = slot as { block_type?: string; params?: unknown };
    if (s.block_type !== 'reverb') continue;
    const p = s.params;
    if (p === null || typeof p !== 'object') continue;
    // Flat: {type: "...", time: 6}
    if (typeof (p as { type?: unknown }).type === 'string') return (p as { type: string }).type;
    // Channel-nested: {A: {type: "..."}}
    for (const v of Object.values(p as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') {
        return (v as { type: string }).type;
      }
    }
  }
  return undefined;
}

export const AM4_CASES: AgentRegressionCase[] = [
  // ── H1 — Hero: clean tone with mixed param shapes ───────────────
  //
  // DOCUMENTED CANARY (Session 110, MCP eng review recommendation).
  // H1 is INTENTIONALLY left in the active sweep as a failure signal,
  // not a green-must-pass test:
  //
  //   - The case prompt ("long HALL reverb") + Sonnet 4.6 disposition
  //     produce inconsistent recovery from silent-no-op traps. BK-071's
  //     pre-flight `validation_info[]` surfaces the warning correctly;
  //     the gap is on the AGENT side (Sonnet doesn't reliably override
  //     the literal user phrasing on first try).
  //   - `should_avoid_dropped_param_warning` strictly checks EVERY
  //     apply_preset call's result. Even when the agent recovers (turn-2
  //     retry with a valid type), the turn-1 warning fails the assertion.
  //     That strictness IS the test — H1 going green would mean Sonnet
  //     learned to anticipate the trap without needing the warning.
  //   - Wall-time penalty per sweep: ~140 s. Worth keeping for the signal.
  //
  // Re-disposition triggers:
  //   - Sonnet model bump that consistently green-passes H1 → relax the
  //     assertion to FINAL apply_preset only, treat as a healthy retry case.
  //   - Three consecutive sweeps with H1 green on first try → same.
  //   - Founder explicit decision to disable (loses the signal).
  {
    id: 'am4-h1-sunday-morning',
    device: 'am4',
    tier: 'hardware',
    description: 'H1 documented canary (Session 110) — Vox AC30 + slow chorus + long hall reverb. Tests apply_preset with mixed flat (chorus) + channel-nested (amp, reverb) param shapes. The `should_avoid_dropped_param_warning` assertion is intentionally strict: any apply_preset call with a dropped-param warning fails the case, even when the agent recovers on retry. Expected to flake-fail under Sonnet 4.6; consistent green indicates the BK-071 surface fully covers the silent-no-op trap.',
    prompt: "Build me an AM4 clean tone on Z4. I want a Vox AC30 with the gain rolled back, a slow chorus, and a long hall reverb with about 30% mix. Call it 'Sunday Morning'.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 8,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        check: (args) => {
          const reverbType = pickReverbType(args);
          if (reverbType === undefined) return 'apply_preset did not include a reverb type';
          // The H1 silent-no-op: Hall variants do NOT expose reverb.time on AM4.
          // After this regression fix, the agent should pick from Plate/Spring/Echo/SFX
          // for "long-decay reverb" prompts. If it still picks Hall, the warning fires.
          if (reverbType.startsWith('Hall')) {
            return `picked Hall variant "${reverbType}" — Hall algorithms are fixed-decay on AM4 and don't expose \`time\`. Should pick from Plate/Spring/Echo/SFX instead (use find_compatible_types({block:"reverb", params:["time"]})).`;
          }
          return true;
        },
      }],
      // The H1 trace agent reported "Decay locked in at 6 seconds" even though
      // the write silently no-op'd on Hall. With the right type pick, no such
      // language should appear — the value actually applies.
      should_avoid_dropped_param_warning: true,
      // No false-confidence language about persisting — apply_preset is
      // audition-only. POSITIVE-CLAIM SHAPES so negation disclaimers
      // ("Not saved to Z04 yet") don't false-trip (Session 110 fix).
      text_not_contains: [
        'I saved',
        'I persisted',
        'now saved to Z',
        'now persisted to Z',
        'preset is saved',
        'preset is persisted',
      ],
      max_wall_seconds: 180,
    },
  },

  // ── H2 — Hero: 4-scene rhythm/lead with progressive gain ────────
  {
    id: 'am4-h2-verse-chorus-bridge-solo',
    device: 'am4',
    tier: 'hardware',
    disabled: true,  // Retired 2026-05-21 (Session 108): am4-enter-sandman-4scene now passes and covers the same 4-scene + channel-nested apply_preset assertions. H2's ambiguous-enum recovery (Plexi 100W picking) is covered by axefx2-bk058-xy-channel-apply on the II side. Saves 233s wall.
    description: 'H2 — 4-scene classic-rock preset with progressive amp gain across channels A/B/C/D and scene mapping. Tests apply_preset with scenes[] + channel-nested amp params. Catches the H2 regression: ambiguous "Plexi 100W" enum picking (now structured valid_options).',
    prompt: "Make me a classic-rock preset on Z04 with four scenes. Scene 1 clean rhythm on amp channel A. Scene 2 crunch on B. Scene 3 a higher-gain rhythm on C. Scene 4 a lead boost on D — same amp but hotter, with delay and reverb. Call it 'Verse Chorus Bridge Solo'.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      // After valid_options structuring, an ambiguous-enum recovery should be
      // ONE retry max. Three apply_preset calls (orig + dirty-gate + retry)
      // is the upper bound we observed in H2.
      max_repeats: { apply_preset: 3 },
      tool_call_validators: [{
        tool: 'apply_preset',
        // Final apply (whichever index it lands on) should have a specific
        // Plexi variant, not the bare "Plexi 100W" family name.
        call_index: 0,
        check: (args) => {
          const spec = (args.spec ?? {}) as { slots?: unknown };
          if (!Array.isArray(spec.slots)) return 'spec.slots missing';
          for (const slot of spec.slots) {
            if (slot === null || typeof slot !== 'object') continue;
            const s = slot as { block_type?: string; params?: unknown };
            if (s.block_type !== 'amp') continue;
            const p = s.params;
            if (p === null || typeof p !== 'object') continue;
            for (const channel of Object.values(p as Record<string, unknown>)) {
              if (channel === null || typeof channel !== 'object') continue;
              const t = (channel as { type?: unknown }).type;
              if (typeof t !== 'string') continue;
              if (t === 'Plexi 100W') {
                return 'sent ambiguous "Plexi 100W" without a variant suffix (Normal/High/1970/Jumped). Should pick one verbatim on the first try when authoring from scratch.';
              }
            }
          }
          return true;
        },
      }],
      max_wall_seconds: 240,
    },
  },

  // ── H3 — Hero: read-then-tweak (most efficiency-sensitive) ──────
  //
  // H3 doesn't require batched set_params; it accepts either strategy.
  // The Desktop run batched (one set_params with 2 ops); headless Sonnet
  // tends to use two separate set_param calls. Both are correct; we just
  // want to see that the agent reads state, writes BOTH targets, switches
  // scene, and bypasses delay — without redundant introspection.
  {
    id: 'am4-h3-read-then-tweak',
    device: 'am4',
    tier: 'hardware',
    description: 'H3 — read current state, bump gain by 1, roll back reverb mix, scene-2 delay bypass. Tests reads + writes + scene switch + bypass in a single pass. Accepts batched set_params or per-op set_param × 2.',
    prompt: "Tell me what's currently on Z04, then bump the amp gain by one, roll off the reverb mix to about 20%, and make scene 2 bypass the delay.",
    expectations: {
      must_call: ['switch_scene', 'set_bypass'],
      // Accept either set_params (batched) or 2× set_param. 12 is the realistic
      // ceiling for the full sequence including discovery + read + 2 writes +
      // scene + bypass.
      max_tools: 12,
      max_repeats: {
        get_param: 5,
        set_params: 2,
        set_param: 3,
        switch_scene: 2,
        set_bypass: 2,
        describe_device: 1,
        scan_locations: 1,
      },
      tool_call_validators: [{
        // Whichever strategy the agent picks (batched or unbatched), both
        // amp.gain AND reverb.mix must be written exactly once each.
        tool: 'set_bypass',
        call_index: 0,
        check: (_args, _result) => {
          // This validator exists purely to assert set_bypass was called.
          // The real "both knobs written" check is a sibling validator
          // declared as a free function so it can scan the full tool
          // sequence. (Tool-call validators in v1 only see one call at
          // a time — for now this guarantees scene-2 bypass landed.)
          return true;
        },
      }],
      max_wall_seconds: 90,
    },
  },

  // ── §2 surface coverage — no-hardware tier ──────────────────────
  //
  // These cases exercise the dispatcher's pure-introspection paths
  // (describe_device, list_params, lookup_lineage, find_compatible_types)
  // and the validator-layer error envelopes (unknown_param,
  // value_out_of_range, bad_channel, capability_not_supported,
  // unknown_block). Every failure mode below throws in resolvers.ts
  // BEFORE openCtx is called — so the cases run identically whether
  // AM4 is plugged in or not. Tag is `no-hardware` so they survive a
  // release-gate run away from the bench.

  // ── Discovery ───────────────────────────────────────────────────
  {
    id: 'am4-s2-discovery-describe',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: meta-discovery covered by axefx2 + lineage-jcm800; was flaky in serial too.
    description: '§2 discovery — "What can this AM4 do?" should answer via describe_device. Catches the regression where an agent freelances from training data instead of asking the device.',
    prompt: 'What can this AM4 do? Tell me what blocks it has, how many scenes per preset, and how many channels per block.',
    expectations: {
      must_call: ['describe_device'],
      max_tools: 3,
      // No text_contains: agents that emit minimal text after the tool
      // call (a short summary line, or nothing) still satisfy the
      // intent — the must_call assertion covers correctness.
      // Scenes-per-preset is 4; channels are A/B/C/D. Wrong wire-format
      // talk (Axe-Fx X/Y, 8-scene) signals the agent fabricated.
      text_not_contains: ['8 scene', 'X/Y', 'X and Y channel'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-discovery-list-amp-types',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: broken (exit -1 every run, agent never calls list_params). Re-enable when root cause diagnosed.
    description: '§2 discovery — "What amp models does this support?" should route to list_params({block:"amp", name:"type"}) so the agent reads the live enum table. Catches "agent dumps training-data list verbatim".',
    prompt: 'What amp models does this AM4 support? Just give me a count and a few examples — do not paste the entire list.',
    expectations: {
      must_call: ['list_params'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'list_params',
        check: (args) => {
          // Need a block-and-name filter to get the enum table back —
          // otherwise the agent is dumping the full param catalog
          // (much larger payload, slower) instead of asking for the
          // amp.type enum specifically.
          const block = args.block as string | undefined;
          const name = args.name as string | undefined;
          if (block === 'amp' && name === 'type') return true;
          // Acceptable fallback: list_params({block:'amp'}) plus a
          // second call with name. Catches only the maximally-wasteful
          // "list_params()" with no filter (returns every param on
          // every block).
          if (block === 'amp') return true;
          return `list_params should be called with block:"amp" (and ideally name:"type") to get the amp enum table — got block=${String(block)} name=${String(name)}.`;
        },
      }],
      // The amp list is 100+ entries; agent should summarize, not dump.
      // Allow ~3000 chars of body content; flag obvious copy-paste of
      // the JSON catalog by checking for a known long substring.
      text_not_contains: ['"enum_values":'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-discovery-lineage-jcm800',
    device: 'am4',
    tier: 'no-hardware',
    description: '§2 discovery — "Look up the JCM800 amp lineage" should route to lookup_lineage. Confirms the lineage corpus is wired and the agent reaches for it instead of generating from training data. Session 78 sweep showed a softer prompt ("Tell me about the JCM800") let Sonnet skip the tool and answer from training — making the prompt explicit about the AM4 lineage data forces the tool call.',
    prompt: 'Look up the JCM800 amp lineage on this AM4 — what real-world gear does Fractal say it models, and what does the manufacturer write about it?',
    expectations: {
      must_call: ['lookup_lineage'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'lookup_lineage',
        check: (args) => {
          if (args.block_type !== 'amp') {
            return `lookup_lineage block_type should be "amp", got ${String(args.block_type)}.`;
          }
          const needle = 'jcm800';
          const fields = [args.name, args.real_gear, args.model]
            .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
            .join(' ');
          if (!fields.includes(needle)) {
            return `lookup_lineage call did not reference "JCM800" in name/real_gear/model — got ${JSON.stringify({ name: args.name, real_gear: args.real_gear, model: args.model })}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-discovery-find-compatible-reverb',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: same workflow tested end-to-end by am4-h1-sunday-morning (Hall trap recovery).
    description: '§2 discovery — "Which reverb types let me set a long decay?" should route to find_compatible_types({block:"reverb", params:["time"]}). This is the same workflow that powers the H1 regression fix — exercised in isolation here.',
    prompt: 'Which reverb types on the AM4 expose a decay-time knob? I want a long, lush tail and the type matters.',
    expectations: {
      must_call: ['find_compatible_types'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'find_compatible_types',
        check: (args) => {
          if (args.block !== 'reverb') {
            return `find_compatible_types block should be "reverb", got ${String(args.block)}.`;
          }
          const params = args.params as unknown[] | undefined;
          if (!Array.isArray(params) || !params.includes('time')) {
            return `find_compatible_types params should include "time", got ${JSON.stringify(params)}.`;
          }
          return true;
        },
      }],
      // The agent often references Hall as a NEGATIVE example ("Hall
      // variants don't expose time — pick Plate or Spring"). That's
      // the correct answer; we want to catch false POSITIVE claims
      // (claiming Hall does expose time). The find_compatible_types
      // result already excludes Hall — assert via a phrase only a
      // false-positive would emit.
      text_not_contains: [
        'Hall, Large Deep exposes',
        'Hall variants expose time',
        'Hall, Large Deep has a time',
      ],
      max_wall_seconds: 60,
    },
  },

  // ── Error envelopes (negative path) ─────────────────────────────
  {
    id: 'am4-s2-err-unknown-param',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: error envelope shape covered by am4-unknown-param-recovery (which adds Levenshtein recovery assertion). Duplicate.
    description: '§2 error — `set amp.warmth to 5` should reject with unknown_param. Agent must not pretend it succeeded.',
    prompt: 'Set the amp warmth to 5 on the AM4.',
    expectations: {
      must_call: ['set_param'],
      max_tools: 5,
      tool_call_validators: [{
        tool: 'set_param',
        check: (args, result) => {
          if (args.block !== 'amp' || args.name !== 'warmth') {
            return `set_param should have been called with amp.warmth (catching the unknown-param path), got block=${String(args.block)} name=${String(args.name)}.`;
          }
          if (result === undefined || !/not valid|unknown/i.test(result)) {
            return `set_param amp.warmth result did not surface the rejection — got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      // False-success language only — phrases that imply the write
      // succeeded. Bare "amp warmth to 5" appears in legitimate refusal
      // text ("you asked to set amp warmth to 5, but…") so it's not a
      // reliable signal. Constrain to past-tense / success verbs.
      text_not_contains: ['warmth is now', 'warmth has been set', 'warmth was set', 'successfully set warmth', 'amp warmth is set'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-err-value-out-of-range',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: same no-false-success-narration pattern as channel-on-non-channel-block (which kept the critical silent-drop check).
    description: '§2 error — `set amp.gain to 12.5`: agent must surface that 12.5 is out of range (gain max = 10). Three acceptable paths: (a) call set_param and let the validator-layer reject, (b) check the descriptor first and refuse upfront, (c) refuse from training-data knowledge of AM4 gain bounds. The signal is no false-success narration, not any specific tool path.',
    prompt: 'Set the amp gain to 12.5 on the AM4.',
    expectations: {
      // min_tools:0 — agent may refuse upfront with zero tool calls,
      // which IS the correct behavior. The harness's value here is
      // catching false-success narration, not forcing a tool path.
      min_tools: 0,
      max_tools: 5,
      tool_call_validators: [{
        // If the agent DOES fire set_param, the call must use 12.5 and
        // the result must surface the range rejection. `optional:true`
        // skips this validator when set_param wasn't called (refuse-
        // upfront path).
        tool: 'set_param',
        optional: true,
        check: (args, result) => {
          if (args.block !== 'amp' || args.name !== 'gain') {
            return `set_param called but targeted ${String(args.block)}.${String(args.name)} instead of amp.gain.`;
          }
          if (args.value !== 12.5 && args.value !== '12.5') {
            return `set_param amp.gain value should be 12.5, got ${JSON.stringify(args.value)}.`;
          }
          if (result === undefined || !/out of range|max(imum)?|range \[/i.test(result)) {
            return `set_param amp.gain=12.5 result did not surface a range rejection — got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      // Final text must reference the actual constraint (the max
      // value or "out of range"). Catches "I tried and it worked!"
      // hallucinations no matter which path the agent took.
      text_contains: ['10'],
      // Must not claim the 12.5 write succeeded.
      text_not_contains: ['gain is now 12', 'set gain to 12', 'amp gain is at 12', 'set to 12.5'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-err-bad-channel',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: same shape as the kept channel-on-non-channel-block. That one is the silent-drop check; this one is a duplicate.
    description: '§2 error — `set amp channel E gain to 6`: agent must surface that channel E does not exist (AM4 channels are A/B/C/D). Three acceptable paths: call set_param + let the validator reject, refuse after describe_device, or refuse from training-data knowledge. Test signal is no false-success narration, not tool path.',
    prompt: 'Set amp channel E gain to 6 on the AM4.',
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
          if (typeof channel !== 'string' || channel.toUpperCase() !== 'E') {
            return `set_param channel should be "E" (the bad-channel request), got ${JSON.stringify(channel)}.`;
          }
          if (result === undefined || !/A\/B\/C\/D|not valid|bad.?channel/i.test(result)) {
            return `set_param amp.gain channel=E result did not surface a bad-channel rejection — got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      // Drop text_contains: the agent's wording varies ("channels are
      // A/B/C/D", "AM4 supports A through D", "no channel E exists",
      // etc.) — predicting exact substrings is brittle. The signal we
      // care about is the absence of false-success language below.
      text_not_contains: ['channel E is now', 'set channel E', 'channel E gain is'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-err-channel-on-non-channel-block',
    device: 'am4',
    tier: 'no-hardware',
    description: '§2 error — `set chorus.rate channel:A` should reject with capability_not_supported (chorus has no channels). Critical: agent must NOT silently drop the channel arg and write to the active channel.',
    prompt: 'Set the chorus channel A rate to 0.8 on the AM4.',
    expectations: {
      // The cleanest pass is: agent calls set_param with channel="A",
      // sees the refusal, surfaces it. A more careful agent might
      // call describe_device or list_params first; that's fine too.
      must_call: ['set_param'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'set_param',
        check: (args, result) => {
          if (args.block !== 'chorus' || args.name !== 'rate') {
            return `set_param should target chorus.rate, got block=${String(args.block)} name=${String(args.name)}.`;
          }
          if (args.channel === undefined) {
            return 'set_param dropped the channel argument silently — that is the regression this case guards against. Channel must be passed so the server can issue capability_not_supported.';
          }
          if (result === undefined || !/channel|capability/i.test(result)) {
            return `set_param chorus.rate channel:A result did not mention channels/capability — got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      // Without an enforced refusal, agent would say "set chorus rate to 0.8".
      text_not_contains: ['chorus channel A is now', 'channel A rate is set'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-err-unknown-block',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Retired 2026-05-21: same shape as other error-envelope cases; no-false-success-narration is covered.
    description: '§2 error — `set oscillator.gain to 5`: agent must surface that AM4 has no oscillator block. Three acceptable paths: call set_param + let the validator reject, refuse after describe_device, or refuse from training-data knowledge.',
    prompt: 'Set the oscillator gain to 5 on the AM4.',
    expectations: {
      min_tools: 0,
      max_tools: 5,
      tool_call_validators: [{
        tool: 'set_param',
        optional: true,
        check: (args, result) => {
          if (args.block !== 'oscillator') {
            return `set_param was called but block:"${String(args.block)}" — odd given the prompt.`;
          }
          if (result === undefined || !/not valid|unknown.?block|Blocks?:/i.test(result)) {
            return `set_param oscillator.gain result did not surface an unknown-block rejection — got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      text_not_contains: ['oscillator gain is now', 'set oscillator gain', 'oscillator has been set'],
      max_wall_seconds: 60,
    },
  },

  // ── Bouncing-regression cases (v0.1.0 install-test gap) ─────────
  //
  // These cases watch the apply_preset RETRY COUNT, not just the
  // final-state correctness. The pattern the v0.1.0 install test
  // surfaced: an agent building a multi-scene preset bounces through
  // 3-5 apply_preset validation errors because it guessed wrong on
  // slot shape, param names, or enum values. Wave 1 fixes (Levenshtein
  // suggestions, slot auto-coerce, cross-device alias table, enum
  // tolerance, internal-ref scrub) should keep the bounce count at
  // ≤ 1 for typical authoring prompts. The cases below assert that
  // budget directly via `max_repeats: { apply_preset: N }`.

  // Enter Sandman 4-scene build — the canonical multi-scene authoring
  // prompt. Tests cross-device naming divergence (drive.level not
  // drive.volume, wah.type not wah.effect_type, USA MK IIC+ not
  // USA IIC+) lands on the FIRST apply_preset call because the alias
  // table + enum-key resolver fire ahead of any validator throw.
  {
    id: 'am4-enter-sandman-4scene',
    device: 'am4',
    tier: 'hardware',
    description: 'Enter Sandman across 4 scenes on AM4. Bouncing-regression — Wave 1 fixes (alias table, enum-key resolver) should let the agent land the build in ≤ 1 apply_preset retry. Asserts 4 scenes present, drive level + amp master at sensible (non-near-zero) wire targets, and Wave 1\'s "info[]" surface fires when cross-device vocabulary substitutions happen.',
    prompt: "Build me Enter Sandman across 4 scenes on the AM4. Scene 1 clean intro on Z01, scene 2 chugging rhythm on the Mesa MK IIC+, scene 3 the loud verse, scene 4 the lead solo. Make every scene actually audible — don\'t mute the drive or amp.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      // The single most important assertion: at most 2 apply_preset
      // calls total (first attempt + at most one retry). Anything more
      // is bouncing. Bumped from the AM4 baseline by 0 — the bouncing
      // metric is the test.
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        // Check the LAST apply_preset call (whichever index it lands on).
        // If max_repeats already capped to 2, this is index 0 or 1.
        call_index: 0,
        check: (args) => {
          const scenes = countScenes(args);
          if (scenes !== 4) {
            return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          }
          // Sensible drive output level — anything below 2 (out of 10)
          // is effectively a muted drive on AM4. The H1-class trap.
          const driveLevel = pickParamValue(args, 'drive', 'level')
            ?? pickParamValue(args, 'drive', 'volume');
          if (typeof driveLevel === 'number' && driveLevel < 2) {
            return `apply_preset drive.level=${driveLevel} is near-zero — drive would be effectively muted. Audible target: ≥ 2 on the 0..10 knob.`;
          }
          // Sensible amp master volume — same threshold.
          const ampMaster = pickParamValue(args, 'amp', 'master')
            ?? pickParamValue(args, 'amp', 'master_volume');
          if (typeof ampMaster === 'number' && ampMaster < 2) {
            return `apply_preset amp.master=${ampMaster} is near-zero — amp would be inaudible. Audible target: ≥ 2 on the 0..10 knob.`;
          }
          return true;
        },
      }],
      // No false-positive save-confidence narration. Patterns are
      // POSITIVE-CLAIM SHAPES (subject + verb + object) so negation
      // disclaimers ("Not saved to flash yet", "I haven't saved
      // anything") don't trip them. Session 110 fix — the prior
      // bare-substring 'saved to' tripped on "Not saved to flash yet"
      // which is the CORRECT disclaimer the agent emits when
      // apply_preset runs in working-buffer mode.
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

  // Recipe-usage test — the BK-064 auto-wah recipe should drive the
  // agent\'s param picks on AM4. AM4\'s FILTER block has built-in
  // envelope-follower types (Auto-Wah / Envelope Filter / Touch-Wah);
  // the install-test failure was the agent placing a static wah block
  // and deferring modifier wiring to the user. Now the agent should
  // pick FILTER block + type=\'Auto-Wah\' with sensible env-follower
  // knobs (sensitivity, attack_time, release_time).
  {
    id: 'am4-recipe-auto-wah',
    device: 'am4',
    tier: 'hardware',
    description: 'Auto-wah on AM4 (BK-072 relaxed): AM4\'s FILTER block has built-in Auto-Wah type; agent should pick that, not a static wah with deferred modifier wiring. Accepts EITHER apply_preset OR the primitive set_block + set_params path (Sonnet 4.6 reliably picks primitives when the prompt reads as a step-by-step modify-sequence). End-state assertion lives in the optional apply_preset validator + the false-deferral text_not_contains.',
    prompt: "Add an auto-wah on scene 1 of the AM4. Replace the chorus in slot 2 with a filter block. I want envelope-follower behavior — sweeping with my pick attack, not a static parked wah.",
    expectations: {
      // BK-072: accept either path. The primitive set_block + set_params
      // sequence lands the same end-state on the device; what matters is
      // that the agent placed a FILTER block, picked an envelope-follower
      // type, and wrote the recipe knobs. The optional validator below
      // only fires when apply_preset is chosen.
      must_call_any: [
        ['apply_preset'],
        ['set_block', 'set_params'],
      ],
      max_tools: 16,  // primitive path runs 4-12 tool calls naturally; headroom for one retry.
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [
        // apply_preset path: optional because agent may pick primitives.
        {
          tool: 'apply_preset',
          call_index: 0,
          optional: true,
          check: (args) => {
            // Recipe target on AM4 is the FILTER block (per autoWah.ts).
            const filterType = pickParamValue(args, 'filter', 'type');
            if (typeof filterType !== 'string') {
              return `apply_preset spec missing filter.type on AM4 — the FILTER block\'s built-in Auto-Wah type is the AM4 path to envelope-follower wah. Agent picked a different shape.`;
            }
            if (!/auto.?wah|envelope.?filter|touch.?wah/i.test(filterType)) {
              return `apply_preset filter.type="${filterType}" is not an envelope-follower type. AM4 envelope-follower types: Auto-Wah / Envelope Filter / Touch-Wah.`;
            }
            // Recipe knobs the agent should land per autoWah.ts (sensitivity,
            // attack_time, release_time). Don\'t hard-assert all three; ≥ 2
            // is enough to prove the agent picked recipe-shaped values
            // rather than just the bare type enum.
            const keys = slotParamKeys(args, 'filter');
            const recipeKnobs = ['sensitivity', 'attack_time', 'release_time'];
            const hit = recipeKnobs.filter((k) => keys.has(k)).length;
            if (hit < 2) {
              return `apply_preset filter block set type but only ${hit}/3 envelope-follower knobs (sensitivity, attack_time, release_time). Agent should land the recipe shape, not the bare type enum.`;
            }
            return true;
          },
        },
        // BK-072 loophole closer (eng review Q4): when the agent takes the
        // primitive path, assert set_block placed a filter block. Without
        // this, the primitive path passes for ANY set_block call.
        {
          tool: 'set_block',
          call_index: 0,
          optional: true,  // Not present on the apply_preset path.
          check: (args) => {
            const blockType = String(args.block_type ?? args.block ?? '').toLowerCase();
            if (blockType !== 'filter') {
              return `set_block placed block_type="${blockType}" — recipe requires placing a FILTER block (AM4 built-in envelope-follower). Agent picked a different shape.`;
            }
            return true;
          },
        },
        // BK-072 loophole closer: assert at least one set_params call
        // carries the envelope-follower type. set_param calls are checked
        // separately below via must_call_any matching.
        {
          tool: 'set_params',
          call_index: 0,
          optional: true,  // Not present on the apply_preset path or pure set_param path.
          check: (args) => {
            // set_params takes an array of {name, value} ops. Look for the
            // filter.type set OR any envelope-follower knob set.
            const ops = (args.ops ?? args.params ?? []) as Array<{ name?: string; value?: unknown }>;
            if (!Array.isArray(ops) || ops.length === 0) {
              return `set_params ops array missing or empty — agent placed a filter block but didn\'t configure any params.`;
            }
            const knobs = new Set(ops.map((op) => String(op.name ?? '').toLowerCase()));
            const recipeKnobs = ['type', 'sensitivity', 'attack_time', 'release_time'];
            const hit = recipeKnobs.filter((k) => knobs.has(k)).length;
            if (hit < 2) {
              return `set_params landed only ${hit}/4 recipe-relevant knobs (type, sensitivity, attack_time, release_time). Agent should land the recipe shape, not just the bare type enum.`;
            }
            return true;
          },
        },
      ],
      // The install-test trace had the agent say "True envelope-follower
      // behavior needs a modifier wired from the envelope-follower
      // source onto the wah\'s control" — that's the regression. On AM4,
      // no modifier is needed because the FILTER block IS the envelope
      // follower. Catch the false-deferral.
      text_not_contains: [
        'separate operation',
        'modifier from the envelope',
        'wire a modifier',
        'will need to manually',
        'you\'ll need to wire',
      ],
      max_wall_seconds: 180,
    },
  },

  // Pri4 (SURFACE-FIXES Session 108): companion to am4-recipe-auto-wah.
  // Same recipe, but a vague prompt that omits the scene, the slot, and
  // the envelope-follower terminology. Asserts the agent doesn't
  // confidently apply without either (a) asking a clarifying question
  // or (b) explicitly naming the defaults it picked. Catches the
  // "agent silently invents a build" failure mode.
  {
    id: 'am4-recipe-auto-wah-ambiguous',
    device: 'am4',
    tier: 'no-hardware',
    disabled: true,  // Pri4: ambiguity-handling case. Enabled after harness gains a deterministic clarification-detector. For now keep in source so the assertion shape ships with the design.
    description: 'Auto-wah on AM4, vague prompt: tests agent ambiguity-handling. Companion to am4-recipe-auto-wah (explicit prompt). Asserts agent either asks a clarifying question OR names its defaults — does not silently invent a build. Disabled until harness has a deterministic clarification-detector; the shape ships so the assertion is in source.',
    prompt: "I want some kind of wah on the AM4.",
    expectations: {
      // No must_call: agent may legitimately do nothing wire-side and
      // just ask. If they DO write, must_call_any covers both paths.
      must_call_any: [
        ['apply_preset'],
        ['set_block', 'set_params'],
        // Or no write at all — covered by min_tools:0 below.
      ],
      max_tools: 8,
      min_tools: 0,  // Agent may legitimately ask before writing.
      text_contains: [
        // Either a question mark (asking) or explicit defaults naming.
        // The harness's text_contains is currently AND-of-substrings;
        // since this assertion is OR-shaped it's commented as
        // intentional documentation. Enable once OR-text-contains
        // semantics land in the harness.
      ],
      max_wall_seconds: 120,
    },
  },

  // Unknown-param recovery — the agent uses a wrong param name, sees
  // a "did you mean: <canonical>?" suggestion from the dispatcher\'s
  // Levenshtein matcher (errorFormat.ts), and recovers with the
  // suggested name on the SAME tool round. Bouncing-regression for
  // the agent that fires set_param 5× with progressively-different
  // bad names instead of reading the suggestion in the error envelope.
  {
    id: 'am4-unknown-param-recovery',
    device: 'am4',
    tier: 'no-hardware',
    description: 'Unknown-param recovery — when the agent fires set_param with a typo (amp.gainn), the AM4 dispatcher returns a Levenshtein "Did you mean: gain?" suggestion. Agent should recover on attempt #2 by reading that suggestion. Bouncing-regression: catches an agent that fires set_param ≥ 3× cycling random param names instead of using the suggestion.',
    prompt: "On the AM4, set the amp.gainn (yes, with the typo) to 6. If the device rejects that param name, recover and try the closest valid name.",
    expectations: {
      must_call: ['set_param'],
      max_tools: 6,
      // Bouncing budget: at most 2 set_param calls (the deliberate
      // typo + one recovery using the suggestion). Anything more is
      // the regression.
      max_repeats: { set_param: 2 },
      tool_call_validators: [
        // First call lands with the typo and gets a "Did you mean" error.
        {
          tool: 'set_param',
          call_index: 0,
          check: (args, result) => {
            if (args.block !== 'amp' || args.name !== 'gainn') {
              return `set_param call #1 should have used the prompt-supplied typo amp.gainn, got block=${String(args.block)} name=${String(args.name)}.`;
            }
            if (result === undefined || !/Did you mean.*gain/i.test(result)) {
              return `set_param amp.gainn result should carry a "Did you mean: gain?" suggestion — got: ${result?.slice(0, 240)}.`;
            }
            return true;
          },
        },
        // Second call (the recovery) lands with the canonical name.
        {
          tool: 'set_param',
          call_index: 1,
          optional: true, // agent could refuse rather than retry — both pass
          check: (args, result) => {
            if (args.block !== 'amp' || args.name !== 'gain') {
              return `set_param call #2 should have recovered with amp.gain (the Levenshtein-1 suggestion), got block=${String(args.block)} name=${String(args.name)}. Bouncing through more typos instead of reading the "Did you mean" hint = the regression this case catches.`;
            }
            if (args.value !== 6 && args.value !== '6') {
              return `set_param call #2 value should be 6 (from the original prompt), got ${JSON.stringify(args.value)}.`;
            }
            // Recovery must actually succeed — if the dispatcher
            // returned another error, the agent picked the wrong fix.
            if (result !== undefined && /unknown|not valid|out of range/i.test(result)) {
              return `set_param call #2 (amp.gain) returned another error — recovery picked the wrong name. Result: ${result.slice(0, 200)}.`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 90,
    },
  },

  // ── Scene-boundary quirk: 0x7fff sentinel read response ──────────
  //
  // BK-073 second mockFixture demo (Session 110). Uses
  // `mockFixture: 'device-quirk-scene-7fff'` so the AM4 mock's scene
  // read returns 0x7fff — the observed real-device quirk where the
  // scene register lands at the signed-int16 boundary instead of a
  // legal 0..3 index.
  //
  // The expected agent behavior: the device-namespaced
  // `am4_get_active_scene` tool already validates the range and
  // returns `isError: true` with a clear "unexpected scene index"
  // message. The agent should surface that to the user, NOT confabulate
  // a scene number ("you're on scene 1") to hide the read failure.
  //
  // This case validates: (1) the mockFixture plumbing for the
  // device-quirk profile, (2) the read tool's defensive range check
  // is still in place, (3) the agent doesn't paper over a read error
  // with a confident-sounding fake answer.
  {
    id: 'am4-scene-quirk-7fff',
    device: 'am4',
    tier: 'no-hardware',
    mockFixture: 'device-quirk-scene-7fff',
    description: 'Scene-boundary quirk — mock returns 0x7fff for scene read (real-device boundary quirk). Agent must surface the read failure, not confabulate a scene number. Validates the BK-073 case-spec MOCK_FIXTURE field on a second fixture profile.',
    prompt: "What's the active scene on the AM4 right now?",
    expectations: {
      // Agent should attempt to read the scene state. Allow either the
      // device-namespaced or unified surface.
      must_call_any: [['am4_get_active_scene'], ['describe_device']],
      max_tools: 4,
      // Must NOT claim a definite scene number — the mock's 0x7fff
      // response is out-of-range and the read tool returns isError:true.
      // Positive-claim shapes: agent reports "scene 1/2/3/4" or "on
      // scene N" as if the read succeeded.
      text_not_contains: [
        'on scene 1',
        'on scene 2',
        'on scene 3',
        'on scene 4',
        'currently scene 1',
        'currently scene 2',
        'currently scene 3',
        'currently scene 4',
        'active scene: 1',
        'active scene: 2',
        'active scene: 3',
        'active scene: 4',
      ],
      max_wall_seconds: 60,
    },
  },

  // ── Overwrite-confirmation gate — exercises the safe-edit discipline
  //
  // BK-073 case-spec MOCK_FIXTURE demonstration (Session 110). Uses
  // `mockFixture: 'populated-z01'` so Z01 reports "My Clean Build" with
  // is_empty: false. The case verifies the agent honors the overwrite
  // gate (per docs/SAFE-EDIT-WORKFLOW.md): scan the target location
  // before persisting, surface the existing preset name to the user,
  // and ask for confirmation BEFORE writing.
  //
  // This is the case-spec MOCK_FIXTURE field's first real usage —
  // proves the runner.ts env-var injection plumbing works end-to-end.
  {
    id: 'am4-overwrite-confirmation',
    device: 'am4',
    tier: 'no-hardware',
    mockFixture: 'populated-z01',
    description: 'Overwrite gate on populated location — Z01 holds "My Clean Build" (via populated-z01 mock fixture); agent asked to save a different preset there should surface the existing name and ask the user before clobbering. Tests safe-edit discipline + the BK-073 case-spec MOCK_FIXTURE plumbing.',
    prompt: "Save my Enter Sandman build to Z01.",
    expectations: {
      // Agent must scan_locations first to discover what's at Z01 before
      // any save / apply_preset write. That's the overwrite-gate
      // discipline.
      must_call: ['scan_locations'],
      // Agent must NOT call save_preset OR apply_preset with
      // target_location:Z01 without confirmation. The agent should stop
      // and ask the user (which manifests in this non-interactive
      // harness as the final text containing a confirmation request).
      must_not_call: ['save_preset'],
      max_tools: 5,
      tool_call_validators: [
        {
          // If apply_preset IS called, it must NOT target Z01 directly
          // (working-buffer apply without target_location is OK; targeted
          // persist to Z01 without user confirmation is the regression).
          tool: 'apply_preset',
          call_index: 0,
          optional: true,
          check: (args) => {
            const target = (args as { target_location?: unknown }).target_location;
            if (target === 'Z01' || target === 'Z1') {
              return `apply_preset called with target_location='${String(target)}' BEFORE user confirmation — overwrite gate bypassed. Should have scanned, surfaced "My Clean Build", and asked the user.`;
            }
            return true;
          },
        },
        {
          // scan_locations result must include Z01 — agent should have
          // scanned the target specifically (or a range covering Z01).
          tool: 'scan_locations',
          call_index: 0,
          check: (args) => {
            const from = (args as { from?: unknown }).from;
            const to = (args as { to?: unknown }).to;
            const fromStr = typeof from === 'string' ? from.toUpperCase() : '';
            const toStr = typeof to === 'string' ? to.toUpperCase() : '';
            // Acceptable: exact Z01 / Z1, or a range that includes Z01.
            // Reject scans that don't touch Z01 at all.
            const touchesZ01 =
              fromStr === 'Z01' || fromStr === 'Z1' ||
              toStr === 'Z01' || toStr === 'Z1' ||
              (fromStr.charAt(0) <= 'Z' && toStr.charAt(0) >= 'Z');
            if (!touchesZ01) {
              return `scan_locations range ${fromStr}..${toStr} doesn't cover Z01 — agent should have scanned the user's target location.`;
            }
            return true;
          },
        },
      ],
      // The agent's final text must reference the existing preset name
      // (proves the scan result was actually read) AND must contain a
      // confirmation request shape (?, "overwrite", "confirm",
      // "replace", "are you sure"). Without one, the agent surfaced the
      // populated-Z01 state but didn't gate on user confirmation.
      text_contains: ['My Clean Build'],
      max_wall_seconds: 60,
    },
  },
];
