/**
 * Agent-regression harness — typed test-case shape.
 *
 * Each case is a self-contained "fresh chat" against the MCP server,
 * driven by `claude -p` so the agent reads tool descriptions cold
 * (just like Claude Desktop). Assertions are envelope-shaped — not
 * exact tool-sequence match — because Sonnet is non-deterministic
 * even at temperature 0.
 *
 * Reference impl: scripts/agent-regression/runner.ts
 */

export type Tier = 'no-hardware' | 'hardware';
export type Device = 'am4' | 'axe-fx-ii' | 'axe-fx-iii' | 'hydrasynth';

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
  /** Bare tool name (no MCP prefix) to match against — e.g. "apply_preset". */
  tool: string;
  /**
   * Predicate over the tool call. Return true on success, or a string
   * describing the failure. Multiple calls to the same tool are tested
   * in order; the validator runs against each matching call.
   */
  check: (args: Record<string, unknown>, result: string | undefined) => true | string;
  /**
   * When provided, run the check against the Nth call to this tool
   * (0-indexed). Otherwise runs against the first call.
   */
  call_index?: number;
  /**
   * When true, the validator silently passes if the tool was never
   * called. Use for "if the agent fires this tool, verify args — but
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
   * BK-072: must call ALL tools in ANY ONE of the inner arrays (OR-of-AND).
   * Use when the agent has multiple equivalent end-state paths — e.g.
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
  /** Ceiling on total tool calls. Efficiency check. */
  max_tools: number;
  /** Floor on total tool calls. Defaults to 1 (catches "agent refused / hedged"). */
  min_tools?: number;
  /** Per-tool retry ceiling. Catches enum-ambiguity / type-mismatch round trips. */
  max_repeats?: Readonly<Record<string, number>>;
  /** Substrings expected in the agent's final text output. */
  text_contains?: readonly string[];
  /** Substrings the final text must NOT contain (e.g. "I can't" / "not available"). */
  text_not_contains?: readonly string[];
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

export interface AgentRegressionCase {
  id: string;
  device: Device;
  tier: Tier;
  /** Human-friendly description — surfaces in the report. */
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
   * a "flake-pass" — flagged in the report but doesn't block release).
   * 2+ = repeated retry; shouldn't happen with default retry policy.
   */
  attempts: number;
  /** True when the case passed only after a retry — visible signal of flakiness. */
  flaked: boolean;
}
