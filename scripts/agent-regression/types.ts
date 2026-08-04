/**
 * Agent-regression harness: typed test-case shape.
 *
 * Each case is a self-contained "fresh chat" against the MCP server,
 * driven by `claude -p` so the agent reads tool descriptions cold
 * (just like Claude Desktop). Assertions are envelope-shaped, not
 * exact tool-sequence match, because Sonnet is non-deterministic
 * even at temperature 0.
 *
 * Reference impl: scripts/agent-regression/runner.ts
 */

export type Device = 'am4' | 'axe-fx-ii' | 'axe-fx-iii' | 'fm3' | 'fm9' | 'vp4' | 'axe-fx-gen1' | 'hydrasynth' | 'circuit' | 'spd-sx' | 've-500' | 'microfreak' | 'minifreak';

/**
 * Mock-transport fixture profile, selected per case to exercise alternate
 * device-state shapes during agent regression.
 *
 * Implementations live in the device package mocks (currently AM4 only in
 * packages/am4/src/midi.ts). The runner injects the chosen profile as the
 * `MOCK_FIXTURE` env var on each `claude -p` spawn so the MCP server child
 * picks it up at module load.
 *
 * Keep this union in sync with `MockFixture` in packages/am4/src/midi.ts.
 *
 *   - 'clean-scratch' (default): canonical clean state. Y + Z banks empty,
 *     A..X factory, scene=0, all reads return legal mid-range. Most cases.
 *   - 'populated-z01': Z01 carries a user-named preset for overwrite-gate
 *     coverage. Use on cases that target Z01 deliberately.
 *   - 'populated-z04': Z04 carries a user-named preset so read-then-tweak
 *     cases that reference Z04 by name see a populated location.
 *   - 'device-quirk-scene-7fff': scene read returns 0x7fff (the observed
 *     real-device boundary quirk). Use on cases that need to verify
 *     dispatcher range-clamp / refusal paths.
 */
export type MockFixture =
  | 'clean-scratch'
  | 'populated-z01'
  | 'populated-z04'
  | 'device-quirk-scene-7fff'
  | 'slow-response'
  | 'partial-ack'
  | 'populated-unrouted';

export interface ToolCall {
  /** MCP-prefixed tool name as emitted by Claude Code, e.g. `mcp__mcp-midi-control__apply_preset`. */
  name: string;
  /** The MCP tool's bare name with the prefix stripped. */
  short_name: string;
  arguments: Record<string, unknown>;
  /** Tool result text (or string-stringified content). */
  result?: string;
  is_error?: boolean;
}

export interface ToolCallValidator {
  /** Bare tool name (no MCP prefix) to match against, e.g. "apply_preset". */
  tool: string;
  /**
   * Predicate over the tool call. Return true on success, or a string
   * describing the failure. Multiple calls to the same tool are tested
   * in order; the validator runs against each matching call.
   */
  check: (args: Record<string, unknown>, result: string | undefined) => true | string;
  /**
   * When provided, run the check against the Nth call to this tool
   * (0-indexed). Otherwise runs against the first call. Pass `'last'` to
   * validate the agent's FINAL call to this tool — use when the agent may
   * make exploratory calls first and only the last one is the real answer.
   */
  call_index?: number | 'last';
  /**
   * When true, the validator silently passes if the tool was never
   * called. Use for "if the agent fires this tool, verify args, but
   * not calling it at all is also acceptable" semantics. Default
   * false: a never-called tool fails the validator (legacy behavior,
   * paired with a `must_call` entry).
   */
  optional?: boolean;
}

export interface Expectations {
  /** Tools that MUST be called at least once. Bare names. Omit when the case accepts multiple valid paths and verifies via tool_call_validators / text_contains. */
  must_call?: readonly string[];
  /**
   * Must call ALL tools in ANY ONE of the inner arrays (OR-of-AND).
   * Use when the agent has multiple equivalent end-state paths, e.g.
   * `apply_preset` is one path, `set_block` + `set_params` is the
   * primitive-equivalent path. At least one inner group must be
   * satisfied (every tool in that group called at least once).
   *
   * Layered over `must_call`: both can coexist; `must_call` still
   * enforces unconditional requirements (e.g. `describe_device` once
   * per session) while `must_call_any` covers the choice of end-state
   * path. Empty / missing → no constraint from this field.
   *
   * Pairs with `tool_call_validators` carrying `optional: true` for
   * the not-always-called path. The validator silently passes when
   * the agent took the other path.
   */
  must_call_any?: readonly (readonly string[])[];
  /** Tools that MUST NOT be called. Bare names. */
  must_not_call?: readonly string[];
  /**
   * Ceiling on total tool calls. Efficiency check.
   *
   * OPTIONAL since 2026-08-02, and the default should stay "set one". A count
   * is exactly right for the majority of cases, which assert one specific
   * efficient path.
   *
   * Omit it ONLY when a case's prompt is deliberately open-ended, so the ROUTE
   * varies legitimately and only the DESTINATION is asserted. There, a count is
   * a proxy for "is the agent flailing" that fails on correct answers and has
   * to be re-tuned for every new model. `max_wall_seconds` measures the same
   * thing directly and is model-agnostic — make sure the case sets one.
   * See `am4-h1-sunday-morning` for the worked example.
   */
  max_tools?: number;
  /** Floor on total tool calls. Defaults to 1 (catches "agent refused / hedged"). */
  min_tools?: number;
  /** Per-tool retry ceiling. Catches enum-ambiguity / type-mismatch round trips. */
  max_repeats?: Readonly<Record<string, number>>;
  /** Substrings expected in the agent's final text output. */
  text_contains?: readonly string[];
  /** Substrings the final text must NOT contain (e.g. "I can't" / "not available"). */
  text_not_contains?: readonly string[];
  /**
   * OR-of-AND text assertion. Inner array is an AND group (every
   * substring must appear); outer array is OR alternatives (at least
   * one inner group must pass). Use for ambiguity-handling cases where
   * the agent can EITHER ask a clarifying question OR explicitly name
   * its defaults, both paths legitimately satisfy the case.
   *
   * Example: text_contains_any: [['?', 'which'], ['I\'ll use', 'default']]
   *  → passes if final text has "?" AND "which", OR "I'll use" AND "default".
   * Empty inner group is treated as never-matching (no false positives).
   */
  text_contains_any?: readonly (readonly string[])[];
  /** Argument-level assertions on specific tool calls. */
  tool_call_validators?: readonly ToolCallValidator[];
  /**
   * Treat a `dropped X param` warning in any apply_preset result as a
   * test failure. Catches the H1-Hall-time class of silent-no-op.
   */
  should_avoid_dropped_param_warning?: boolean;
  /** Wall-clock ceiling for the full conversation, in seconds. Default 120. */
  max_wall_seconds?: number;
}

/**
 * NOTE ON TOOL ERRORS (no per-case flag, deliberately).
 *
 * `must_call` / `must_call_any` are satisfied only by a call that did NOT
 * return `is_error` — they assert the agent got something DONE, and a failed
 * call did not. `must_not_call`, `max_repeats` and `tool_call_validators`
 * still see every call, error or not, because a forbidden call is a violation
 * however it ended and several validators inspect the error result itself.
 *
 * There is no `allow_tool_errors` opt-out because none is needed: a case that
 * provokes an error deliberately and then RECOVERS still has a successful
 * call, so it still passes. Adding a blanket "any error fails" rule would fail
 * those recovery cases for doing the right thing — the same mistake
 * `max_tools` made when it punished an agent for reading back its own write.
 */

export interface AgentRegressionCase {
  id: string;
  device: Device;
  /** Human-friendly description, surfaces in the report. */
  description: string;
  /** Literal user message sent to the agent. No agent-side hints. */
  prompt: string;
  expectations: Expectations;
  /**
   * When true, the case is excluded from default sweeps but kept in the
   * source for provenance + easy re-enablement. Disabled cases run when
   * targeted explicitly via `--case=<id>`. Use to retire low-signal or
   * duplicate cases without losing the assertion code. Sweep summary
   * reports disabled count separately.
   */
  disabled?: boolean;
  /**
   * When true, the case is SKIPPED under the mock transport (default sweep) and
   * runs ONLY under `--real-hardware`. Use for cases that need a real device
   * RESPONSE the mock can't synthesize — a SysEx readback (get_preset on a device
   * whose mock has no responder) or an ack-gated transfer. Distinct from
   * `disabled` (which removes the case from every sweep): a requiresHardware case
   * is live, just gated to the bench. Mock-friendly fire-and-forget / storage /
   * introspection cases leave this unset.
   */
  requiresHardware?: boolean;
  /**
   * Mock-transport fixture profile.
   * When set, the runner injects `MOCK_FIXTURE=<value>` into the per-case
   * `claude -p` spawn so the MCP server child picks it up at module load.
   * Source-of-truth lives on the case; the `MOCK_FIXTURE` env var still
   * works as an ad-hoc override when this field is omitted. Case-spec
   * always wins when both are present. Defaults to 'clean-scratch'.
   */
  mockFixture?: MockFixture;
  /**
   * Optional state-seeding hook. Fires BEFORE the agent
   * prompt runs: the runner connects to the same MCP server `claude -p`
   * will use, applies the spec via `apply_preset` (working buffer
   * only, no save), then hands control to the agent. Use when the
   * case's prompt assumes a starting device state, e.g.
   * "replace the chorus in slot 2" needs a chorus in slot 2.
   *
   * Without setup, the case runs against whatever happens to be in
   * the working buffer (typically whichever preset the previous case
   * left behind). Tests with state-dependent prompts become flaky.
   *
   * The setup runs only on real-hardware sweeps (not under mock
   * fixtures, the mock's clean-scratch state is already
   * deterministic). Failures abort the case with `setup_failed`.
   * Setup wire-time isn't counted toward the case's max_wall_seconds.
   */
  setup?: {
    /** PresetSpec (or recipe_id-keyed shape) applied via apply_preset. */
    apply_preset: {
      readonly spec?: unknown;
      readonly recipe_id?: string;
      readonly overrides?: unknown;
    };
  };
}

export interface CaseResult {
  case: AgentRegressionCase;
  passed: boolean;
  failures: readonly string[];
  tool_calls: readonly ToolCall[];
  final_text: string;
  wall_seconds: number;
  /** Raw stream-json lines for post-mortem. Truncated to N=200 to keep reports small. */
  raw_event_count: number;
  /**
   * Number of times this case was retried after a failed first attempt.
   * 0 = passed (or failed) on first try. 1 = passed on retry (treated as
   * a "flake-pass", flagged in the report but doesn't block release).
   * 2+ = repeated retry; shouldn't happen with default retry policy.
   */
  attempts: number;
  /** True when the case passed only after a retry, a visible signal of flakiness. */
  flaked: boolean;
  /**
   * Tool results the HOST refused to deliver to the model (size cap or token
   * cap). Persisted to results.jsonl so the corpus can be queried for the
   * outage directly instead of re-grepping traces: this is the class that ran
   * silent for two weeks while 9 runs carrying it were scored PASS.
   */
  undelivered_results?: number;
  /**
   * True when the case did not actually run on its merits because the OS refused
   * to spawn the `claude -p` child (Windows 0xC0000142 / STATUS_DLL_INIT_FAILED,
   * exit 3221225794, or a spawn EPERM/ENOENT) — a process-residue cascade, not a
   * test or product failure. Environmental results are EXCLUDED from pass/fail
   * accounting (reported as a separate `env` outcome) so one cascade doesn't wipe
   * a run's reliability numbers. See the runner's env-retry-with-backoff.
   */
  environmental?: boolean;
}
