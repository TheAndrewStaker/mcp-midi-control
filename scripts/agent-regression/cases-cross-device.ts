/**
 * Cross-device agent-regression cases.
 *
 * Cases that exercise the `port_preset` tool — the marquee cross-device
 * feature that translates a preset built on one Fractal device into an
 * equivalent build on another. Lives in its own file (rather than under
 * either source-device or target-device per-file) because the case is
 * about the bridge tool itself, not either endpoint.
 *
 * Bouncing-regression motive: the v0.1.0 install test surfaced agents
 * that re-issued port_preset 2-3 times because the cross-device alias
 * table or enum-key resolver missed a substitution. Wave 1 fixes (BK-066
 * concept-key resolution + the param-alias table) should keep the port
 * call count to exactly ONE. This case asserts that budget.
 */

import type { AgentRegressionCase } from './types.js';

export const CROSS_DEVICE_CASES: AgentRegressionCase[] = [
  // port_preset — AM4 source → Axe-Fx II target, dry-run mode.
  //
  // Dry-run keeps the case hardware-free (no wire ops on either device,
  // pure translator). The agent gets a small AM4 spec to port, calls
  // port_preset once, and the result should carry a non-empty
  // applied_spec + zero `validation_errors`. The bouncing metric:
  // exactly ONE port_preset call. A retry signals the agent didn\'t
  // trust the translator\'s output and tried again with different
  // source-spec vocabulary — that\'s the regression.
  {
    id: 'cross-port-am4-to-axefx2',
    device: 'am4',
    tier: 'no-hardware',
    description: 'port_preset (AM4 → Axe-Fx II, dry-run) — Wave 1 cross-device alias + concept-key resolver should let the agent port a preset on the FIRST tool call. Bouncing-regression: catches an agent that retries port_preset 2-3 times because it second-guessed the alias/enum substitutions.',
    prompt: "I have a clean tone built on the AM4: amp type \"USA MK IIC+\" at gain 5 master 7, a drive at level 6, and a reverb (Plate, large) at mix 30. Port that exact build to the Axe-Fx II. Give me the translated spec back without firing any writes on the target.",
    expectations: {
      must_call: ['port_preset'],
      max_tools: 6,
      // The single most important assertion: exactly ONE port_preset
      // call. Retries = bouncing.
      max_repeats: { port_preset: 1 },
      tool_call_validators: [{
        tool: 'port_preset',
        call_index: 0,
        check: (args, result) => {
          // Source / target ports must be the two named devices.
          const src = String(args.source_port ?? '').toLowerCase();
          const tgt = String(args.target_port ?? '').toLowerCase();
          if (!src.includes('am4')) {
            return `port_preset source_port should be "am4", got ${String(args.source_port)}.`;
          }
          if (!tgt.includes('axe-fx-ii') && !tgt.includes('axefx2') && !tgt.includes('axe-fx ii')) {
            return `port_preset target_port should be "axe-fx-ii", got ${String(args.target_port)}.`;
          }
          // Dry-run is the cheap path — agent should request it.
          // Accept either explicit dry_run:true or omitted target_location
          // (also returns translator-only per the tool description).
          const dryRun = args.dry_run;
          const targetLoc = args.target_location;
          if (dryRun !== true && targetLoc !== undefined) {
            return `port_preset should run in dry-run mode (the prompt says "without firing any writes") — got dry_run=${JSON.stringify(dryRun)} target_location=${JSON.stringify(targetLoc)}.`;
          }
          // Result envelope must surface the translated spec, not just
          // bounce with validation errors.
          if (result === undefined) {
            return `port_preset returned no result body.`;
          }
          if (/"ok"\s*:\s*false/i.test(result) && !/applied_spec/i.test(result)) {
            return `port_preset returned ok:false with no applied_spec — translator failed instead of cross-aliasing. Result snippet: ${result.slice(0, 280)}.`;
          }
          return true;
        },
      }],
      text_not_contains: [
        // Catch agents that narrate a port failure when the translator
        // actually succeeded (false-failure language).
        'could not be ported',
        'failed to translate',
        'no equivalent',
      ],
      max_wall_seconds: 90,
    },
  },
];
