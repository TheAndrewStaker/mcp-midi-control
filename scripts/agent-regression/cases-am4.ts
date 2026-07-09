/**
 * AM4 agent-regression cases.
 *
 * A separate human-driven end-to-end runbook is the manual counterpart;
 * these cases are the automated mirror, driven by `claude -p` against
 * the shipped MCP server. Each case is a fresh agent session: no prior
 * context, no privileged hints, the agent reads the tool description set
 * the same way Claude Desktop does.
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
    const s = slot as { block_type?: string; params?: unknown; params_by_channel?: unknown };
    if (s.block_type !== blockType) continue;
    // Channel-bearing blocks now author via params_by_channel; only
    // legacy specs use nested-in-params. Read both so the safety check
    // (muted master, muted drive) sees the value regardless of which
    // field the agent picked. Mirrors the ampChannelKeys fix in
    // cases-axe-fx-ii.ts.
    for (const candidate of [s.params_by_channel, s.params]) {
      if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
      const flat = (candidate as Record<string, unknown>)[paramName];
      if (typeof flat === 'number' || typeof flat === 'string') return flat;
      for (const v of Object.values(candidate as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object') {
          const nested = (v as Record<string, unknown>)[paramName];
          if (typeof nested === 'number' || typeof nested === 'string') return nested;
        }
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
    const s = slot as { block_type?: string; params?: unknown; params_by_channel?: unknown };
    if (s.block_type !== blockType) continue;
    // Agents author per-channel maps via params_by_channel; the legacy
    // nested-in-params shape is rejected at the MCP boundary. Read both:
    // the helper's job is to enumerate the param keys the agent declared,
    // regardless of which field carries them. Mirrors the ampChannelKeys
    // fix in cases-axe-fx-ii.ts.
    for (const candidate of [s.params_by_channel, s.params]) {
      if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
      for (const [k, v] of Object.entries(candidate as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object') {
          for (const innerKey of Object.keys(v as Record<string, unknown>)) out.add(innerKey);
        } else {
          out.add(k);
        }
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
    const s = slot as { block_type?: string; params?: unknown; params_by_channel?: unknown };
    if (s.block_type !== 'reverb') continue;
    // Channel-nested authoring goes through params_by_channel; only
    // legacy specs use nested-in-params. Look in both to stay robust
    // across the schema versions the agent may pick. Mirrors the
    // ampChannelKeys fix.
    for (const candidate of [s.params_by_channel, s.params]) {
      if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
      // Flat shape on params: {type: "...", time: 6}
      if (typeof (candidate as { type?: unknown }).type === 'string') {
        return (candidate as { type: string }).type;
      }
      // Channel-nested shape: {A: {type: "..."}}, used by params_by_channel,
      // and historically by params under the legacy schema.
      for (const v of Object.values(candidate as Record<string, unknown>)) {
        if (v !== null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') {
          return (v as { type: string }).type;
        }
      }
    }
  }
  return undefined;
}

export const AM4_CASES: AgentRegressionCase[] = [
  // ── H1: Hall-reverb fixed-decay silent-no-op check (slimmed) ────────
  //
  // SOLE OWNER of the harness's flagship silent-no-op regression check:
  // on AM4, Hall reverb variants are fixed-decay and do NOT expose
  // `reverb.time`, so writing a decay time to a Hall reverb silently
  // no-ops (device ACKs, nothing changes — the README's motivating
  // example). The agent, asked for a LONG-decay reverb, must pick a type
  // that actually exposes `time` (Plate / Spring / Echo / SFX), not Hall.
  //
  // SLIMMED 2026-06-28 (founder call): the old "recovery canary" layered a
  // bad-amp-enum trap + a chorus capability trap + a save on top, driving
  // 10–18 tool calls and chronic wall-limit flake (61% pass) — that budget
  // pressure was the flake source, NOT the Hall check. The build / recovery
  // / no-false-save aspects are redundant (deterministic-4scene-build,
  // recipe cases, unknown-param-recovery, archetype-build-lineage-readback
  // cover them). This case is reduced to JUST the unique Hall check: one
  // focused reverb-build, the no-Hall validator, a tight budget. The
  // isolated find_compatible_types variant (am4-s2-discovery-find-compatible-
  // reverb) remains retired-into-this-case.
  {
    id: 'am4-h1-sunday-morning',
    device: 'am4',

    description: 'H1 Hall-reverb silent-no-op check (slimmed): the agent, asked for a LONG-decay reverb on the AM4, must pick a type that exposes `reverb.time` (Plate/Spring/Echo/SFX), NOT a Hall variant (fixed-decay, no `time` — the flagship silent-no-op). The reverb-type validator is the regression check; the build is kept minimal to avoid the budget-pressure flake the old recovery-canary version had.',
    prompt: "On the AM4, build a clean tone in the working buffer with a long, lush reverb tail. Pick a reverb type that actually lets you dial in a long decay time. Don't save it.",
    expectations: {
      must_call: ['apply_preset'],
      max_tools: 6,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 'last',
        check: (args) => {
          const reverbType = pickReverbType(args);
          if (reverbType === undefined) return 'apply_preset did not include a reverb type';
          // The silent-no-op: Hall variants do NOT expose reverb.time on AM4.
          // For a "long-decay reverb" prompt the agent should pick from
          // Plate/Spring/Echo/SFX. If it still picks Hall, that's the regression.
          if (reverbType.startsWith('Hall')) {
            return `picked Hall variant "${reverbType}": Hall algorithms are fixed-decay on AM4 and don't expose \`time\`. Should pick from Plate/Spring/Echo/SFX instead (use find_compatible_types({block:"reverb", params:["time"]})).`;
          }
          return true;
        },
      }],
      // No false-confidence language about persisting: apply_preset is
      // audition-only. POSITIVE-CLAIM SHAPES so negation disclaimers
      // ("Not saved yet") don't false-trip.
      text_not_contains: ['I saved', 'I persisted', 'preset is saved', 'preset is persisted'],
      // Slimmed from 480 s: a single focused reverb-build is a handful of
      // calls, not the old multi-trap-recovery marathon.
      max_wall_seconds: 150,
    },
  },

  // ── H2, Hero: 4-scene rhythm/lead with progressive gain ────────
  {
    id: 'am4-h2-verse-chorus-bridge-solo',
    device: 'am4',

    disabled: true,  // Retired: am4-enter-sandman-4scene now passes and covers the same 4-scene + channel-nested apply_preset assertions. H2's ambiguous-enum recovery (Plexi 100W picking) is covered by axefx2-bk058-xy-channel-apply on the II side. Saves 233s wall.
    description: 'H2: 4-scene classic-rock preset with progressive amp gain across channels A/B/C/D and scene mapping. Tests apply_preset with scenes[] + channel-nested amp params. Catches the H2 regression: ambiguous "Plexi 100W" enum picking (now structured valid_options).',
    prompt: "Make me a classic-rock preset on Z04 with four scenes. Scene 1 clean rhythm on amp channel A. Scene 2 crunch on B. Scene 3 a higher-gain rhythm on C. Scene 4 a lead boost on D, same amp but hotter, with delay and reverb. Call it 'Verse Chorus Bridge Solo'.",
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
            const s = slot as { block_type?: string; params?: unknown; params_by_channel?: unknown };
            if (s.block_type !== 'amp') continue;
            // Read both params_by_channel and params.
            for (const candidate of [s.params_by_channel, s.params]) {
              if (candidate === null || candidate === undefined || typeof candidate !== 'object') continue;
              for (const channel of Object.values(candidate as Record<string, unknown>)) {
                if (channel === null || typeof channel !== 'object') continue;
                const t = (channel as { type?: unknown }).type;
                if (typeof t !== 'string') continue;
                if (t === 'Plexi 100W') {
                  return 'sent ambiguous "Plexi 100W" without a variant suffix (Normal/High/1970/Jumped). Should pick one verbatim on the first try when authoring from scratch.';
                }
              }
            }
          }
          return true;
        },
      }],
      max_wall_seconds: 240,
    },
  },

  // ── H3, Hero: read-then-tweak (most efficiency-sensitive) ──────
  //
  // H3 doesn't require batched set_params; it accepts either strategy.
  // The Desktop run batched (one set_params with 2 ops); headless Sonnet
  // tends to use two separate set_param calls. Both are correct; we just
  // want to see that the agent reads state, writes BOTH targets, switches
  // scene, and bypasses delay, without redundant introspection.
  {
    id: 'am4-h3-read-then-tweak',
    device: 'am4',
    mockFixture: 'populated-z04',

    // Originally H3 read-then-tweak. Extended to also exercise the
    // get_preset shape hazard: channel-bearing AM4 slots diverged in
    // shape, with amp returning flat params while delay returned
    // params_by_channel. The fix unifies on params_by_channel; this
    // case's get_preset readback is the natural place to assert it on AM4.
    description: 'H3: read current state, bump gain by 1, roll back reverb mix, scene-2 delay bypass. Tests reads + writes + scene switch + bypass in one pass. Also asserts every channel-bearing AM4 slot in get_preset uses params_by_channel.',
    prompt: "Tell me what's currently on Z04, then bump the amp gain by one, roll off the reverb mix to about 20%, and make scene 2 bypass the delay.",
    expectations: {
      must_call: ['switch_scene', 'set_bypass'],
      // Accept either set_params (batched) or 2× set_param. 12 is the realistic
      // ceiling for the full sequence including discovery + read + 2 writes +
      // scene + bypass.
      max_tools: 12,
      max_repeats: {
        get_preset: 2,
        get_param: 5,
        set_params: 2,
        set_param: 3,
        switch_scene: 3,
        set_bypass: 2,
        describe_device: 1,
        scan_locations: 1,
      },
      tool_call_validators: [
        {
          // Whichever strategy the agent picks (batched or unbatched), both
          // amp.gain AND reverb.mix must be written exactly once each.
          tool: 'set_bypass',
          call_index: 0,
          check: (_args, _result) => {
            // This validator exists purely to assert set_bypass was called.
            // The real "both knobs written" check is a sibling validator
            // declared as a free function so it can scan the full tool
            // sequence. (Tool-call validators in v1 only see one call at
            // a time, so for now this guarantees scene-2 bypass landed.)
            return true;
          },
        },
        {
          // When the agent reads via get_preset, every channel-bearing
          // slot must use params_by_channel. Optional because the prompt
          // phrasing ("tell me what's currently on Z04") usually prompts
          // get_preset but the agent occasionally satisfies it via
          // get_params individually; that path doesn't exercise the
          // shape check, so we silently skip rather than fail on the
          // alternate strategy.
          tool: 'get_preset',
          optional: true,
          check: (_args, result) => {
            if (result === undefined) return true;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(result) as Record<string, unknown>;
            } catch {
              return true;
            }
            const slots = parsed.slots as Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(slots)) return true;
            const channelBearing = new Set(['amp', 'drive', 'reverb', 'delay']);
            const offenders: string[] = [];
            for (const s of slots) {
              const bt = String(s.block_type).toLowerCase();
              if (!channelBearing.has(bt)) continue;
              const hasFlat = s.params !== undefined;
              const hasNested = s.params_by_channel !== undefined;
              if (hasFlat && !hasNested) offenders.push(bt);
            }
            if (offenders.length > 0) {
              return (
                `get_preset shape regression: channel-bearing slot(s) returned flat params ` +
                `instead of params_by_channel: ${offenders.join(', ')}. The reader's ` +
                `fallback path (failed channel read) must still use params_by_channel ` +
                `to keep response shape consistent across blocks.`
              );
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 90,
    },
  },

  // ── §2 surface coverage: no-hardware tier ──────────────────────
  //
  // These cases exercise the dispatcher's pure-introspection paths
  // (describe_device, list_params, lookup_lineage, find_compatible_types)
  // and the validator-layer error envelopes (unknown_param,
  // value_out_of_range, bad_channel, capability_not_supported,
  // unknown_block). Every failure mode below throws in resolvers.ts
  // BEFORE openCtx is called, so the cases run identically whether
  // AM4 is plugged in or not. Tag is `no-hardware` so they survive a
  // release-gate run away from the bench.

  // ── Discovery ───────────────────────────────────────────────────
  {
    id: 'am4-s2-discovery-describe',
    device: 'am4',

    disabled: true,  // Retired: meta-discovery covered by axefx2 + lineage-jcm800; was flaky in serial too.
    description: '§2 discovery: "What can this AM4 do?" should answer via describe_device. Catches the regression where an agent freelances from training data instead of asking the device.',
    prompt: 'What can this AM4 do? Tell me what blocks it has, how many scenes per preset, and how many channels per block.',
    expectations: {
      must_call: ['describe_device'],
      max_tools: 3,
      // No text_contains: agents that emit minimal text after the tool
      // call (a short summary line, or nothing) still satisfy the
      // intent; the must_call assertion covers correctness.
      // Scenes-per-preset is 4; channels are A/B/C/D. Wrong wire-format
      // talk (Axe-Fx X/Y, 8-scene) signals the agent fabricated.
      text_not_contains: ['8 scene', 'X/Y', 'X and Y channel'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-discovery-list-amp-types',
    device: 'am4',

    disabled: true,  // Retired: broken (exit -1 every run, agent never calls list_params). Re-enable when root cause diagnosed.
    description: '§2 discovery: "What amp models does this support?" should route to list_params({block:"amp", name:"type"}) so the agent reads the live enum table. Catches "agent dumps training-data list verbatim".',
    prompt: 'What amp models does this AM4 support? Just give me a count and a few examples, do not paste the entire list.',
    expectations: {
      must_call: ['list_params'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'list_params',
        check: (args) => {
          // Need a block-and-name filter to get the enum table back —
          // otherwise the agent is dumping the full param catalog
          // (much larger payload, slower) instead of asking for the
          // amp.type enum specifically. Batch-only: block and name are
          // always arrays.
          const blocks = Array.isArray(args.block) ? args.block as string[] : [];
          const names = Array.isArray(args.name) ? args.name as string[] : [];
          const includesAmp = blocks.includes('amp');
          const includesType = names.includes('type');
          if (includesAmp && includesType) return true;
          // Acceptable fallback: list_params({block:["amp"]}) plus a
          // second call with name. Catches only the maximally-wasteful
          // "list_params()" with no filter (returns every param on
          // every block).
          if (includesAmp) return true;
          return `list_params should target block:["amp"] (and ideally name:["type"]) to get the amp enum table; got block=${JSON.stringify(args.block)} name=${JSON.stringify(args.name)}.`;
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

    description: '§2 discovery: "Look up the JCM800 amp lineage" should route to lookup_lineage. Confirms the lineage corpus is wired and the agent reaches for it instead of generating from training data. A softer prompt ("Tell me about the JCM800") let Sonnet skip the tool and answer from training, so making the prompt explicit about the AM4 lineage data forces the tool call.',
    prompt: 'Look up the JCM800 amp lineage on this AM4: what real-world gear does Fractal say it models, and what does the manufacturer write about it?',
    expectations: {
      must_call: ['lookup_lineage'],
      max_tools: 4,
      tool_call_validators: [{
        tool: 'lookup_lineage',
        check: (args) => {
          if (args.block_type !== 'amp') {
            return `lookup_lineage block_type should be "amp", got ${String(args.block_type)}.`;
          }
          // Validator broadened. The agent legitimately
          // looks up the JCM800 via Fractal's name (Brit 800) or the
          // Marshall model numbers (2203, 2204) instead of the literal
          // "JCM800" string. Accept any of those as evidence the agent
          // is doing the right semantic lookup. Also handles `name`
          // as array (the migration made lookup_lineage `name`
          // array-only).
          const needles = ['jcm800', 'brit 800', '2203', '2204'];
          const collect = (v: unknown): string => {
            if (typeof v === 'string') return v.toLowerCase();
            if (Array.isArray(v)) return v.map((x) => typeof x === 'string' ? x.toLowerCase() : '').join(' ');
            return '';
          };
          const fields = [args.name, args.real_gear, args.model]
            .map(collect)
            .join(' ');
          if (!needles.some((n) => fields.includes(n))) {
            return `lookup_lineage call did not reference JCM800 or any of its Fractal-modeled names (Brit 800, 2203, 2204) in name/real_gear/model; got ${JSON.stringify({ name: args.name, real_gear: args.real_gear, model: args.model })}.`;
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

    disabled: true,  // Retired: same workflow tested end-to-end by am4-h1-sunday-morning (Hall trap recovery).
    description: '§2 discovery: "Which reverb types let me set a long decay?" should route to find_compatible_types({block:"reverb", params:["time"]}). This is the same workflow that powers the H1 regression fix, exercised in isolation here.',
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
      // variants don't expose time, pick Plate or Spring"). That's
      // the correct answer; we want to catch false POSITIVE claims
      // (claiming Hall does expose time). The find_compatible_types
      // result already excludes Hall, so assert via a phrase only a
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

    disabled: true,  // Retired: error envelope shape covered by am4-unknown-param-recovery (which adds Levenshtein recovery assertion). Duplicate.
    description: '§2 error: `set amp.warmth to 5` should reject with unknown_param. Agent must not pretend it succeeded.',
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
            return `set_param amp.warmth result did not surface the rejection; got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      // False-success language only: phrases that imply the write
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

    disabled: true,  // Retired: same no-false-success-narration pattern as channel-on-non-channel-block (which kept the critical silent-drop check).
    description: '§2 error: `set amp.gain to 12.5`: agent must surface that 12.5 is out of range (gain max = 10). Three acceptable paths: (a) call set_param and let the validator-layer reject, (b) check the descriptor first and refuse upfront, (c) refuse from training-data knowledge of AM4 gain bounds. The signal is no false-success narration, not any specific tool path.',
    prompt: 'Set the amp gain to 12.5 on the AM4.',
    expectations: {
      // min_tools:0: agent may refuse upfront with zero tool calls,
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
            return `set_param amp.gain=12.5 result did not surface a range rejection; got: ${result?.slice(0, 200)}.`;
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

    disabled: true,  // Retired: same shape as the kept channel-on-non-channel-block. That one is the silent-drop check; this one is a duplicate.
    description: '§2 error: `set amp channel E gain to 6`: agent must surface that channel E does not exist (AM4 channels are A/B/C/D). Three acceptable paths: call set_param + let the validator reject, refuse after describe_device, or refuse from training-data knowledge. Test signal is no false-success narration, not tool path.',
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
            return `set_param amp.gain channel=E result did not surface a bad-channel rejection; got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      // Drop text_contains: the agent's wording varies ("channels are
      // A/B/C/D", "AM4 supports A through D", "no channel E exists",
      // etc.), so predicting exact substrings is brittle. The signal we
      // care about is the absence of false-success language below.
      text_not_contains: ['channel E is now', 'set channel E', 'channel E gain is'],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-err-channel-on-non-channel-block',
    device: 'am4',

    description: '§2 error: user prompt mixes a channel reference into a non-channel block ("chorus channel A"). Two acceptable agent paths: (a) pass channel="A" through and surface the server\'s capability_not_supported rejection, or (b) strip the channel arg, write to chorus.rate, AND explicitly tell the user that chorus has no A/B/C/D channels. Either way, the agent must NOT narrate a successful channel-specific write (the false-success class this case originally guarded against).',
    prompt: 'Set the chorus channel A rate to 0.8 on the AM4.',
    expectations: {
      // The cleanest pass is: agent calls set_param with channel="A",
      // sees the server's refusal, surfaces it. A more careful agent
      // calls describe_device first and infers chorus has no channels;
      // in that path it strips the channel arg and explains in the
      // final response. Sonnet 4.6 increasingly takes the second path.
      // We accept both: the dangerous outcome the case originally
      // guarded against is the agent silently writing AND lying about
      // channel A in the final text. The text_not_contains list below
      // catches that.
      must_call: ['set_param'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'set_param',
        check: (args, result) => {
          if (args.block !== 'chorus' || args.name !== 'rate') {
            return `set_param should target chorus.rate, got block=${String(args.block)} name=${String(args.name)}.`;
          }
          // Path (a): channel arg passed → server must reject.
          // If the result doesn't mention channel/capability we have a
          // genuine bug (server silently accepted a channel arg on a
          // non-channel block).
          if (args.channel !== undefined) {
            if (result === undefined || !/channel|capability/i.test(result)) {
              return `set_param chorus.rate channel:${String(args.channel)} result did not mention channels/capability; server may have silently accepted a channel arg on a non-channel block. Got: ${result?.slice(0, 200)}.`;
            }
          }
          // Path (b): channel arg stripped. Server writes successfully;
          // safety relies on text_not_contains catching false-success
          // narration in the final response. No tool-level check here.
          return true;
        },
      }],
      // The real safety property: the agent must not narrate that it
      // wrote channel A specifically. "chorus.rate is set to 0.8" is
      // fine. "channel A rate is set" / "chorus channel A is now" are
      // hallucinations the user could act on.
      text_not_contains: [
        'chorus channel A is now',
        'chorus channel A rate is',
        'channel A rate is set',
        'set chorus channel A',
        'channel A is now set',
      ],
      max_wall_seconds: 60,
    },
  },
  {
    id: 'am4-s2-err-unknown-block',
    device: 'am4',

    disabled: true,  // Retired: same shape as other error-envelope cases; no-false-success-narration is covered.
    description: '§2 error: `set oscillator.gain to 5`: agent must surface that AM4 has no oscillator block. Three acceptable paths: call set_param + let the validator reject, refuse after describe_device, or refuse from training-data knowledge.',
    prompt: 'Set the oscillator gain to 5 on the AM4.',
    expectations: {
      min_tools: 0,
      max_tools: 5,
      tool_call_validators: [{
        tool: 'set_param',
        optional: true,
        check: (args, result) => {
          if (args.block !== 'oscillator') {
            return `set_param was called but block:"${String(args.block)}", odd given the prompt.`;
          }
          if (result === undefined || !/not valid|unknown.?block|Blocks?:/i.test(result)) {
            return `set_param oscillator.gain result did not surface an unknown-block rejection; got: ${result?.slice(0, 200)}.`;
          }
          return true;
        },
      }],
      text_not_contains: ['oscillator gain is now', 'set oscillator gain', 'oscillator has been set'],
      max_wall_seconds: 60,
    },
  },

  // ── Bouncing-regression cases (install-test gap) ─────────
  //
  // These cases watch the apply_preset RETRY COUNT, not just the
  // final-state correctness. The pattern the install test surfaced:
  // an agent building a multi-scene preset bounces through 3 to 5
  // apply_preset validation errors because it guessed wrong on slot
  // shape, param names, or enum values. The vocabulary fixes
  // (Levenshtein suggestions, slot auto-coerce, cross-device alias
  // table, enum tolerance, internal-ref scrub) should keep the bounce
  // count at <= 1 for typical authoring prompts. The cases below assert
  // that budget directly via `max_repeats: { apply_preset: N }`.

  // Enter Sandman 4-scene build: the canonical multi-scene authoring
  // prompt. Tests cross-device naming divergence (drive.level not
  // drive.volume, wah.type not wah.effect_type, USA MK IIC+ not
  // USA IIC+) lands on the FIRST apply_preset call because the alias
  // table + enum-key resolver fire ahead of any validator throw.
  {
    id: 'am4-enter-sandman-4scene',
    device: 'am4',

    disabled: true,  // Retired: vague song-name prompt leads to unreliable scene/amp picks. Replaced by targeted cases with explicit amp models + scene structure (am4-h1-sunday-morning).
    description: 'Enter Sandman across 4 scenes on AM4. Bouncing-regression: the vocabulary fixes (alias table, enum-key resolver) should let the agent land the build in <= 1 apply_preset retry. Asserts 4 scenes present, drive level + amp master at sensible (non-near-zero) wire targets, and the "info[]" surface fires when cross-device vocabulary substitutions happen.',
    prompt: "Build me Enter Sandman across 4 scenes on the AM4. Scene 1 clean intro, scene 2 chugging rhythm on the Mesa MK IIC+, scene 3 the loud verse, scene 4 the lead solo. Use the working buffer, don\'t save. Make every scene actually audible, don\'t mute the drive or amp.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 10,
      // The single most important assertion: at most 2 apply_preset
      // calls total (first attempt + at most one retry). Anything more
      // is bouncing. Bumped from the AM4 baseline by 0; the bouncing
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
          // Sensible drive output level: anything below 2 (out of 10)
          // is effectively a muted drive on AM4. The H1-class trap.
          const driveLevel = pickParamValue(args, 'drive', 'level')
            ?? pickParamValue(args, 'drive', 'volume');
          if (typeof driveLevel === 'number' && driveLevel < 2) {
            return `apply_preset drive.level=${driveLevel} is near-zero; drive would be effectively muted. Audible target: >= 2 on the 0..10 knob.`;
          }
          // Sensible amp master volume, same threshold.
          const ampMaster = pickParamValue(args, 'amp', 'master')
            ?? pickParamValue(args, 'amp', 'master_volume');
          if (typeof ampMaster === 'number' && ampMaster < 2) {
            return `apply_preset amp.master=${ampMaster} is near-zero; amp would be inaudible. Audible target: >= 2 on the 0..10 knob.`;
          }
          return true;
        },
      }],
      // No false-positive save-confidence narration. Patterns are
      // POSITIVE-CLAIM SHAPES (subject + verb + object) so negation
      // disclaimers ("Not saved to flash yet", "I haven't saved
      // anything") don't trip them. An earlier bare-substring 'saved to'
      // tripped on "Not saved to flash yet"
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

  // Recipe-usage test: the auto-wah recipe should drive the
  // agent\'s param picks on AM4. AM4\'s FILTER block has built-in
  // envelope-follower types (Auto-Wah / Envelope Filter / Touch-Wah);
  // the install-test failure was the agent placing a static wah block
  // and deferring modifier wiring to the user. Now the agent should
  // pick FILTER block + type=\'Auto-Wah\' with sensible env-follower
  // knobs (sensitivity, attack_time, release_time).
  {
    id: 'am4-recipe-auto-wah',
    device: 'am4',

    description: 'Auto-wah on AM4: AM4\'s FILTER block has built-in Auto-Wah type; agent should pick that, not a static wah with deferred modifier wiring. Accepts EITHER apply_preset OR the primitive set_block + set_params path (Sonnet 4.6 reliably picks primitives when the prompt reads as a step-by-step modify-sequence). End-state assertion lives in the optional apply_preset validator plus the false-deferral text_not_contains.',
    // Hermetic setup: seed slot 2 with a chorus so the
    // "replace the chorus in slot 2" prompt has a valid target. Pre-
    // setup, the case bombed whenever the working buffer didn't
    // happen to carry a chorus there.
    setup: {
      apply_preset: {
        spec: {
          slots: [
            { slot: 1, block_type: 'drive' },
            { slot: 2, block_type: 'chorus' },
            { slot: 3, block_type: 'amp' },
            { slot: 4, block_type: 'reverb' },
          ],
        },
      },
    },
    prompt: "Add an auto-wah on scene 1 of the AM4. Replace the chorus in slot 2 with a filter block. I want envelope-follower behavior, sweeping with my pick attack, not a static parked wah.",
    expectations: {
      // Accept either path. The primitive set_block + set_params
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
              return `apply_preset spec missing filter.type on AM4: the FILTER block\'s built-in Auto-Wah type is the AM4 path to envelope-follower wah. Agent picked a different shape.`;
            }
            if (!/auto.?wah|envelope.?filter|touch.?wah/i.test(filterType)) {
              return `apply_preset filter.type="${filterType}" is not an envelope-follower type. AM4 envelope-follower types: Auto-Wah / Envelope Filter / Touch-Wah.`;
            }
            // Recipe knobs the agent should land per autoWah.ts (sensitivity,
            // attack_time, release_time). Don\'t hard-assert all three; ≥ 2
            // (at least 2) is enough to prove the agent picked
            // recipe-shaped values rather than just the bare type enum.
            const keys = slotParamKeys(args, 'filter');
            const recipeKnobs = ['sensitivity', 'attack_time', 'release_time'];
            const hit = recipeKnobs.filter((k) => keys.has(k)).length;
            if (hit < 2) {
              return `apply_preset filter block set type but only ${hit}/3 envelope-follower knobs (sensitivity, attack_time, release_time). Agent should land the recipe shape, not the bare type enum.`;
            }
            return true;
          },
        },
        // Loophole closer: when the agent takes the primitive path,
        // assert set_block placed a filter block. Without this, the
        // primitive path passes for ANY set_block call.
        {
          tool: 'set_block',
          call_index: 0,
          optional: true,  // Not present on the apply_preset path.
          check: (args) => {
            const blockType = String(args.block_type ?? args.block ?? '').toLowerCase();
            if (blockType !== 'filter') {
              return `set_block placed block_type="${blockType}"; recipe requires placing a FILTER block (AM4 built-in envelope-follower). Agent picked a different shape.`;
            }
            return true;
          },
        },
        // Loophole closer: assert at least one set_params call
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
              return `set_params ops array missing or empty; agent placed a filter block but didn\'t configure any params.`;
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
      // source onto the wah\'s control"; that's the regression. On AM4,
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

  // Companion to am4-recipe-auto-wah.
  // Same recipe, but a vague prompt that omits the scene, the slot, and
  // the envelope-follower terminology. Asserts the agent doesn't
  // confidently apply without either (a) asking a clarifying question
  // or (b) explicitly naming the defaults it picked. Catches the
  // "agent silently invents a build" failure mode.
  {
    id: 'am4-recipe-auto-wah-ambiguous',
    device: 'am4',

    description: 'Auto-wah on AM4, vague prompt: tests agent ambiguity-handling. Companion to am4-recipe-auto-wah (explicit prompt). Asserts agent either asks a clarifying question OR explicitly names its defaults, and does not silently invent a build. The text_contains_any (OR-of-AND) is the sole signal: `must_call_any` was removed because it contradicted `min_tools: 0`: the case explicitly allows the "ask before writing" path, but requiring an apply call forced acting even when clarifying was correct.',
    prompt: "I want some kind of wah on the AM4.",
    expectations: {
      // No `must_call_any`, see case description. Asking a clarifying
      // question (no tool writes) and applying with named defaults are
      // BOTH legitimate paths. `text_contains_any` distinguishes them.
      max_tools: 8,
      min_tools: 0,  // Agent may legitimately ask before writing.
      // OR-of-AND clarification detector. Inner AND groups capture the
      // two legitimate paths:
      //   1. Clarifying question: final text has a question mark AND
      //      one of the question-word substrings.
      //   2. Explicit defaults narration: final text names "default"
      //      OR "I'll" and references "wah" so the narration is
      //      grounded in the actual build (not a generic disclaimer).
      // At least one path must pass. Silently inventing a build with
      // no question and no defaults-narration fails the case.
      text_contains_any: [
        ['?', 'which'],
        ['?', 'what'],
        ['?', 'should'],
        ["i'll use", 'wah'],
        ['default', 'wah'],
        ['by default', 'wah'],
      ],
      // Final text must NOT positive-claim a finished build when the
      // agent had no concrete inputs to work from.
      text_not_contains: [
        'all set',
        "you're all set",
        'preset is ready',
      ],
      max_wall_seconds: 120,
    },
  },

  // Unknown-param recovery: the agent uses a wrong param name, sees
  // a "did you mean: <canonical>?" suggestion from the dispatcher\'s
  // Levenshtein matcher (errorFormat.ts), and recovers with the
  // suggested name on the SAME tool round. Bouncing-regression for
  // the agent that fires set_param 5× with progressively-different
  // bad names instead of reading the suggestion in the error envelope.
  {
    id: 'am4-unknown-param-recovery',
    device: 'am4',

    description: 'Unknown-param recovery: when the agent fires set_param with a typo (amp.gainn), the AM4 dispatcher returns a Levenshtein "Did you mean: gain?" suggestion. Agent should recover on attempt #2 by reading that suggestion. Bouncing-regression: catches an agent that fires set_param 3 or more times cycling random param names instead of using the suggestion.',
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
              return `set_param amp.gainn result should carry a "Did you mean: gain?" suggestion; got: ${result?.slice(0, 240)}.`;
            }
            return true;
          },
        },
        // Second call (the recovery) lands with the canonical name.
        {
          tool: 'set_param',
          call_index: 1,
          optional: true, // agent could refuse rather than retry; both pass
          check: (args, result) => {
            if (args.block !== 'amp' || args.name !== 'gain') {
              return `set_param call #2 should have recovered with amp.gain (the Levenshtein-1 suggestion), got block=${String(args.block)} name=${String(args.name)}. Bouncing through more typos instead of reading the "Did you mean" hint = the regression this case catches.`;
            }
            if (args.value !== 6 && args.value !== '6') {
              return `set_param call #2 value should be 6 (from the original prompt), got ${JSON.stringify(args.value)}.`;
            }
            // Recovery must actually succeed: if the dispatcher
            // returned another error, the agent picked the wrong fix.
            if (result !== undefined && /unknown|not valid|out of range/i.test(result)) {
              return `set_param call #2 (amp.gain) returned another error; recovery picked the wrong name. Result: ${result.slice(0, 200)}.`;
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
  // Second mockFixture demo. Uses
  // `mockFixture: 'device-quirk-scene-7fff'` so the AM4 mock's scene
  // read returns 0x7fff, the observed real-device quirk where the
  // scene register lands at the signed-int16 boundary instead of a
  // legal 0..3 index.
  //
  // The expected agent behavior: the unified read (`get_preset` /
  // `describe_device`) surfaces an out-of-range scene index rather than a
  // legal 0..3 value. The agent should surface that to the user, NOT
  // confabulate a scene number ("you're on scene 1") to hide the read
  // failure.
  //
  // This case validates: (1) the mockFixture plumbing for the
  // device-quirk profile, (2) the agent doesn't paper over a read error
  // with a confident-sounding fake answer.
  {
    id: 'am4-scene-quirk-7fff',
    device: 'am4',

    mockFixture: 'device-quirk-scene-7fff',
    description: 'Scene-boundary quirk: mock returns 0x7fff for scene read (real-device boundary quirk). Agent must READ the device (get_preset returns active_scene) and surface the read failure, not confabulate a scene number, and not refuse from a stale "scenes are unreadable" prior. Validates the case-spec MOCK_FIXTURE field on a second fixture profile.',
    prompt: "Check the AM4 and tell me which scene is currently active right now.",
    expectations: {
      // Agent should attempt to read the scene state via the unified
      // surface.
      must_call_any: [['get_preset'], ['describe_device']],
      max_tools: 4,
      // Must NOT claim a definite scene number: the mock's 0x7fff
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

  // ── Overwrite-confirmation gate: exercises the safe-edit discipline
  //
  // Case-spec MOCK_FIXTURE demonstration. Uses
  // `mockFixture: 'populated-z01'` so Z01 reports "My Clean Build" with
  // is_empty: false. The case verifies the agent honors the overwrite
  // gate (per docs/SAFE-EDIT-WORKFLOW.md): scan the target location
  // before persisting, surface the existing preset name to the user,
  // and ask for confirmation BEFORE writing.
  //
  // This is the case-spec MOCK_FIXTURE field's first real usage,
  // proving the runner.ts env-var injection plumbing works end-to-end.
  {
    id: 'am4-overwrite-confirmation',
    device: 'am4',

    mockFixture: 'populated-z01',
    description: 'Overwrite gate on populated location: Z01 holds "My Clean Build" (via populated-z01 mock fixture); agent asked to save a different preset there should surface the existing name and ask the user before clobbering. Tests safe-edit discipline plus the case-spec MOCK_FIXTURE plumbing.',
    prompt: "Save my Enter Sandman build to Z01.",
    expectations: {
      // Two SAFE strategies satisfy the overwrite gate, and both must pass:
      //   (a) scan_locations first, surface "My Clean Build", ask; or
      //   (b) call save_preset and let ITS overwrite gate refuse + surface
      //       the occupying name (the gate is the real safety net, and it
      //       returns "REFUSING TO OVERWRITE: Z1 already holds ...").
      // The old spec required (a) and hard-forbade save_preset, failing the
      // equally-safe (b) path. We now accept either, but still ASSERT the
      // safety guarantee held: no unconfirmed/forced overwrite occurred.
      must_call_any: [['scan_locations'], ['save_preset']],
      max_tools: 5,
      tool_call_validators: [
        {
          // SAFETY GUARANTEE: if save_preset was called, it must NOT have
          // forced an overwrite, and the gate must have refused (no silent
          // clobber). The agent forcing overwrite:true on a populated,
          // non-active location without asking is the real regression.
          tool: 'save_preset',
          call_index: 0,
          optional: true,
          check: (args, result) => {
            if ((args as { confirm_overwrite?: unknown }).confirm_overwrite === true) {
              return `save_preset called with confirm_overwrite:true on populated Z01 WITHOUT user confirmation — overwrite gate bypassed.`;
            }
            if (result !== undefined && !/refus|already holds|overwrite/i.test(result)) {
              return `save_preset on populated Z01 did not surface the overwrite gate (expected a refusal naming the occupying preset). Result head: ${result.slice(0, 200)}`;
            }
            return true;
          },
        },
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
              return `apply_preset called with target_location='${String(target)}' BEFORE user confirmation; overwrite gate bypassed. Should have scanned, surfaced "My Clean Build", and asked the user.`;
            }
            return true;
          },
        },
        {
          // IF the agent scans (the pre-scan strategy), the scan must cover
          // Z01. Optional: the gate-reliance strategy (call save_preset and
          // let its overwrite gate refuse) is equally safe and skips the
          // scan, validated by the save_preset check above.
          tool: 'scan_locations',
          call_index: 0,
          optional: true,
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
              return `scan_locations range ${fromStr}..${toStr} doesn't cover Z01; agent should have scanned the user's target location.`;
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

  // ── Phantom-param pre-flight surfaces unplaced-block warning
  //
  // Extends the ValidationInfo[] soft-warn pattern from apply_preset to
  // set_param. When the agent writes a param for a block that isn't
  // placed in any slot of the active working buffer, the device
  // wire-acks but silently no-ops. The dispatcher pre-flight surfaces a
  // `validation_info[]` entry naming the unplaced block + a retry_action
  // pointing at set_block.
  //
  // The AM4 mock default layout is amp/chorus/reverb/delay; 'phaser' is
  // guaranteed-absent. The agent's natural follow-up is to either place
  // a phaser via set_block or surface the gap to the user. Both paths
  // count as success here; the regression is silently reporting "phaser
  // rate set to 3" when the device hadn't placed a phaser at all.
  {
    id: 'am4-phantom-param-warning',
    device: 'am4',

    description: 'Phantom-param trap: agent asked to tweak a knob on a block not placed in the active working buffer. Dispatcher pre-flight surfaces validation_info[] with the unplaced-block warning + retry_action. Agent must either place the block via set_block OR surface the gap to the user; must NOT report false success.',
    prompt: "Set the phaser rate on the AM4 to 3 Hz.",
    expectations: {
      // Agent should call set_param (the prompt is a direct instruction);
      // the dispatcher fires the phantom-param pre-flight and returns
      // validation_info[]. Acceptable follow-ups: set_block to place the
      // phaser, OR surface the gap without further wire writes.
      must_call: ['set_param'],
      max_tools: 5,
      // The agent must NOT claim success at face value. Positive-claim
      // shapes for the failure mode: "phaser rate set to 3" / "applied"
      // / "done" without surfacing that no phaser was placed. Reading
      // the validation_info[] warning naturally produces text mentioning
      // the unplaced state, so these false-claim phrases only fire when
      // the agent IGNORED the warning surface.
      text_not_contains: [
        'phaser rate is now',
        'phaser is now at',
        'phaser rate has been set',
        'all set',
        "you're all set",
      ],
      max_wall_seconds: 90,
    },
  },

  // ── Slow-response fixture: batched-write preference under latency ──
  //
  // MOCK_FIXTURE='slow-response' inflates the simulated ack latency to
  // 1500 ms per round-trip (vs real-hardware ~30 ms, vs default mock
  // 30 ms). Under that latency, an agent that fans out
  // 5 sequential set_param calls spends ~7.5 s on writes alone before
  // the user gets a response; a batched set_params lands the same edit
  // in one round-trip (~1.5 s). The case asserts the batched path.
  //
  // No must_call on the batched tool name specifically: the agent may
  // legitimately use apply_preset (which also batches under the hood)
  // for the same effect. The constraint is "don't fan out N set_param
  // calls": max_repeats: { set_param: 1 } enforces this.
  {
    id: 'am4-slow-response-batched-write',
    device: 'am4',

    mockFixture: 'slow-response',
    description: 'Slow-response fixture (~1.5 s per ack): prompt asks for 5 amp param edits. Agent should batch via set_params or apply_preset (<= 1 set_param call); fanning out 5 sequential set_param calls is the regression. Tests batched-write preference under realistic high-latency conditions.',
    prompt: "On the AM4, set the amp gain to 6, master to 5, treble to 7, mid to 4, and bass to 5.",
    expectations: {
      // No must_call on a specific batched tool: both set_params and
      // apply_preset are valid. Just enforce: at most 1 individual
      // set_param call. (Most agents will batch via set_params.)
      max_tools: 8,
      max_repeats: { set_param: 1 },
      // The 5 edits must reach the device. We don't assert tool args
      // tightly here; the constraint is on tool selection, not args.
      // This case's real assertion is BATCHING (max_repeats set_param:1).
      // The narration check is intentionally light per the comment below:
      // any reasonable acknowledgement that the amp edits landed passes.
      // (The old AND-of-5-literal-words contradicted that stated intent and
      // failed the case purely on word choice, e.g. "midrange" not "mid".)
      text_contains_any: [
        ['gain'], ['master'], ['treble'], ['mid'], ['bass'], ['amp'],
      ],
      // No positive-claim regression on this case: the agent's narrative
      // is allowed to say "all set" because the writes DID succeed.
      // The case fails on the BATCHING question, not on the narration.
      max_wall_seconds: 60,
    },
  },

  // ── Partial-ack fixture: read-after-write integrity ─────────────
  //
  // MOCK_FIXTURE='partial-ack' returns a constant display ~1.0 value
  // for any standard-knob read, regardless of what the agent just
  // wrote. Writes still ack normally on the wire. An agent that
  // narrates "set amp.gain to 6" from the write-echo alone
  // misses the discrepancy; one that verifies via get_param reads
  // back ~1.0 and surfaces the mismatch.
  //
  // The case nudges toward read-after-write by explicitly asking the
  // agent to confirm the change landed. Agents that comply hit the
  // mismatch and must surface it; agents that just write blind pass
  // the writes but fail the text_not_contains "now at 6" assertion
  // because they made a positive claim without evidence.
  {
    id: 'am4-partial-ack-read-integrity',
    device: 'am4',

    mockFixture: 'partial-ack',
    description: 'Partial-ack fixture: writes ack on the wire but reads always return display ~1.0 (the device never echoes the write). Agent must verify via get_param and surface the discrepancy ("the device acked but reads back ~1.0"). Catches agents that positive-claim a successful write off the wire-echo alone.',
    prompt: "On the AM4, set the amp.gain to 6, and then verify the change actually landed by reading it back. If the device disagrees with what we wrote, tell me.",
    expectations: {
      must_call: ['set_param', 'get_param'],
      max_tools: 6,
      // Final text must mention the discrepancy / mismatch / device-
      // not-matching narrative, i.e. the agent saw the mismatch.
      // OR-of-AND: any wording for "the device reports a different
      // value than we wrote" satisfies. "Read returned X" + "wrote 6"
      // narrative passes via the AND group.
      text_contains_any: [
        ['discrepancy'],
        ['mismatch'],
        ['differ'],
        ['does not match'],
        ["doesn't match"],
        ["did not take"],
        ['1', 'wrote', '6'],
      ],
      // Catches the "claimed success from write-echo alone" failure mode.
      // If the agent says "gain is now 6" without surfacing the read
      // mismatch, that's the regression.
      text_not_contains: [
        'gain is now 6',
        'gain is now at 6',
        'amp gain is 6',
        'set gain to 6',
      ],
      max_wall_seconds: 90,
    },
  },

  // ── MCP migration cases (AM4 equivalents) ──────────────
  //
  // Mirrors the three Axe-Fx II cases added with the migration. Kept
  // DISABLED until the II cases prove stable across three sessions —
  // the cross-device sanity holds only after the surface holds on at
  // least one device. Enable by flipping `disabled: false` per case
  // (or remove the field).

  // (A-AM4) Deterministic 4-scene build, NO recipe expected.
  //
  // Same theme as axefx2-deterministic-4scene-build: prompt is
  // intentionally non-iconic so the agent composes the spec
  // turn-by-turn without picking a recipe. Baseline wall-time
  // measurement for AM4's 4-slot linear chain.
  {
    id: 'am4-deterministic-4scene-build',
    device: 'am4',

    description: 'Deterministic 4-scene build with NO recipe match (AM4 equivalent of the II case). Agent composes a Bogner-style clean + crunchy + Marshall + lead spec by reading describe_device + lookup_lineage, then issuing apply_preset directly. Baseline against which AM4 recipe-pickup cases compare.',
    prompt: [
      'Build me a preset on the AM4 with 4 scenes.',
      'Scene A: Bogner-style clean. Scene B: same amp but crunchy (gain up).',
      'Scene C: an interesting Marshall variant (your pick).',
      'Scene D: a different high-gain lead (your pick, not Marshall).',
      'Working buffer only, do not save.',
    ].join(' '),
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 12,
      // Complex 4-scene build may need 1-2 iterations to land enum
      // and slot-id shape; each iteration is preflight-only (zero
      // wire writes on validation_errors[]). 3 attempts is the
      // empirical headroom.
      max_repeats: { apply_preset: 3 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          if (typeof args.recipe_id === 'string' && args.recipe_id.length > 0) {
            return `Deterministic build should not use recipe_id (no recipe matches the Bogner prompt). Got recipe_id='${args.recipe_id}'.`;
          }
          const spec = (args.spec ?? {}) as { scenes?: unknown; slots?: unknown };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) {
            return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          }
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

  // (B-AM4) Block-stack recipe pickup on AM4.
  //
  // Texas Blues Crunch is the AM4-applicable block_stack recipe that's
  // unambiguous from a prompt. (Edge dotted-eighth needs the delay
  // tempo set separately and the agent often picks the primitive
  // path; SRV/Bonamassa is a cleaner trigger.)
  {
    id: 'am4-recipe-block-stack-pickup',
    device: 'am4',

    description: 'MCP migration AM4 mirror: agent picks the texas_blues_crunch recipe by id from describe_device.recipes[] and applies via apply_preset({recipe_id}). Same recipe surface as the II case, AM4 4-slot linear chain.',
    prompt: "Give me a Texas blues crunch / SRV-style tone on the AM4. Working buffer only.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 6,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          if (args.recipe_id !== 'texas_blues_crunch') {
            return `Expected apply_preset({recipe_id: 'texas_blues_crunch'}); got recipe_id=${JSON.stringify(args.recipe_id)}.`;
          }
          return true;
        },
      }],
      must_not_call: ['lookup_lineage'],
      text_not_contains: ['I saved', 'I stored'],
      max_wall_seconds: 240,
    },
  },

  // (C-AM4) Single-block recipe pickup on AM4.
  //
  // Auto-wah is AM4's strongest single-block recipe family (the FILTER
  // block carries the Auto-Wah type natively). The existing
  // am4-recipe-auto-wah case already covers this surface; this case
  // is intentionally redundant when enabled, kept disabled by default
  // to avoid double-covering until we decide whether to retire the
  // older case.
  {
    id: 'am4-recipe-single-block-pickup',
    device: 'am4',

    description: 'MCP migration AM4 mirror: single-block recipe pickup. Agent picks an auto_wah recipe from describe_device.recipes[] and applies via set_block + set_params on the FILTER block (AM4 single-block recipes apply inline; recipe_id is block-stack only).',
    prompt: "Give me an envelope-follower auto-wah on the AM4, sweeping with my pick attack.",
    expectations: {
      must_call: ['describe_device'],
      // Either apply_preset (one-shot) or set_block + set_params is valid.
      must_call_any: [
        ['apply_preset'],
        ['set_block', 'set_params'],
      ],
      max_tools: 8,
      tool_call_validators: [{
        tool: 'apply_preset',
        // Optional: primitive path is the natural shape for "add one
        // block to existing preset".
        optional: true,
        check: (args) => {
          const spec = (args.spec ?? {}) as { slots?: unknown[] };
          const slots = Array.isArray(spec.slots) ? spec.slots : [];
          const hasFilter = slots.some(
            (s) => s !== null && typeof s === 'object' && (s as { block_type?: unknown }).block_type === 'filter',
          );
          if (!hasFilter) {
            return `apply_preset for auto-wah should include a filter slot on AM4.`;
          }
          return true;
        },
      }],
      text_not_contains: ['I saved', 'I stored'],
      max_wall_seconds: 240,
    },
  },

  // ── Large coverage: build + lineage + read-back (audition, no save) ────────
  {
    id: 'am4-archetype-build-lineage-readback',
    device: 'am4',
    description:
      'Preset-processor archetype, large coverage: a "build a tone, tell me its lineage, confirm it landed" request should walk the build + knowledge + read surface — apply_preset (multi-block working-buffer build), lookup_lineage (what real amp the model is based on), and get_param (read the amp gain back). The user said audition, so NO save_preset. Catches an agent that saves an audition, fabricates the amp lineage, or claims success without a read-back. Exercises the core preset-processor surface end to end against the AM4 mock.',
    // Reverb is a PLATE (exposes time, no Hall fixed-decay trap) so this broad
    // archetype case stays clear of the Hall silent-no-op — that flagship check
    // is owned in isolation by am4-h1-sunday-morning. should_avoid_dropped_param_warning
    // is intentionally NOT set here: this case tests archetype breadth, not the
    // type-gating trap (asserting it here would re-create the latent Hall flake).
    prompt:
      'On the AM4, build a Marshall-style crunch in the working buffer: a Plexi-type amp at gain 6, a tube-screamer-style drive in front of it, and a plate reverb after. ' +
      'Tell me what real amplifier the Plexi model is based on, and read the amp gain back off the device to confirm it landed. Just audition it — do not save.',
    expectations: {
      must_call: ['apply_preset', 'lookup_lineage', 'get_param'],
      must_not_call: ['save_preset'],
      max_tools: 14,
      min_tools: 3,
      tool_call_validators: [{
        tool: 'apply_preset',
        check: (args) => {
          // Working-buffer audition: must not persist to a stored location.
          if (typeof args.target_location === 'string' && args.target_location.trim() !== '') {
            return `apply_preset should build in the working buffer (no target_location) for an audition, got ${String(args.target_location)}.`;
          }
          if (args.save === true) return 'apply_preset must not save on an audition request.';
          return true;
        },
      }],
      text_not_contains: ['I saved', 'I stored', 'saved to'],
      max_wall_seconds: 320,
    },
  },

  // ── Coverage: get_params (batch read) ──────────────────────────────────────
  {
    id: 'am4-get-params-batch-read',
    device: 'am4',
    description: 'Batch read: "read the whole amp EQ at once" should route to get_params (one batched read of gain/master/bass/mid/treble), NOT a fan-out of 5 individual get_param calls. get_params had no agent-sweep coverage (get_param did). Tests the agent prefers the batch-read tool when reading several params, mirroring am4-slow-response-batched-write for the write side.',
    prompt: 'On the AM4, read the amp gain, master, bass, mid, and treble — all of them, in one batched read — and report the values.',
    expectations: {
      must_call: ['get_params'],
      // Discourage fanning out individual reads when a batch was asked for.
      max_repeats: { get_param: 1 },
      max_tools: 5,
      tool_call_validators: [{
        tool: 'get_params',
        check: (args) => {
          const queries = (args.queries ?? args.params ?? []) as Array<{ block?: string; name?: string }>;
          if (!Array.isArray(queries) || queries.length < 3) {
            return `get_params should batch several amp reads in one call (>=3 queries), got ${Array.isArray(queries) ? queries.length : 'none'}.`;
          }
          if (!queries.every((q) => String(q.block).toLowerCase() === 'amp')) {
            return `get_params queries should all target the amp block; got ${JSON.stringify(queries.map((q) => q.block))}.`;
          }
          return true;
        },
      }],
      max_wall_seconds: 60,
    },
  },
];
