/**
 * Agent-regression harness — runs one case via `claude -p`.
 *
 * Spawns Claude Code in non-interactive mode with our MCP server
 * (`packages/server-all/dist/server/index.js`) as the only available
 * tool source, streams the JSON event log to stdout, parses each
 * line into a tool-call / text record, then applies the case's
 * assertions.
 *
 * Bills against the founder's Claude Max subscription (the same
 * authentication their interactive `claude` session uses). No
 * ANTHROPIC_API_KEY required.
 *
 * Authoring shortcut — drive a single case during development:
 *   npx tsx scripts/agent-regression/runner.ts <case-id>
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentRegressionCase,
  CaseResult,
  ToolCall,
} from './types.js';

const MCP_CONFIG_PATH = path.resolve('scripts/agent-regression/mcp-config.json');
const TRACES_DIR = path.resolve('scripts/agent-regression/traces');
const DEFAULT_MODEL = 'claude-sonnet-4-6';
/**
 * Claude Code's MCP tool naming convention prefixes every tool with
 * `mcp__<server_name>__<tool_name>`. Our server is registered in
 * mcp-config.json as `mcp-midi-control`, so a server-side tool like
 * `apply_preset` is exposed to the agent as
 * `mcp__mcp-midi-control__apply_preset`.
 */
const MCP_TOOL_PREFIX = 'mcp__mcp-midi-control__';

interface RunOptions {
  case: AgentRegressionCase;
  model?: string;
  /** When true, echo each stream-json event to console as it arrives. */
  verbose?: boolean;
  /**
   * Max retries on failure. Default 1 — Sonnet is non-deterministic
   * even at temperature 0, so a single spurious fail shouldn't block
   * release. Pass 0 to disable retry (CI debug mode, or when iterating
   * on a single case where you want to see every failure mode).
   *
   * Empirically validated 2026-05-21: a 23-case sweep had 2/23 cases
   * pass only on retry. Default 0 would have caused 2 false-negative
   * release-gate failures. Capture-on-fail traces (this file) make the
   * underlying flake visible without losing the gate.
   */
  max_retries?: number;
}

/**
 * Execute one regression case with retry-on-flake.
 *
 * Sonnet's non-determinism produces occasional unrepresentative tool
 * sequences (e.g. an extra exploratory list_params call) that fail
 * assertions even when the underlying agent behavior is correct. To
 * keep release-gate runs from spurious blocks, a failed attempt is
 * retried once by default. If the retry passes, the case is flagged
 * `flaked: true` so flakiness stays visible.
 */
export async function runCase(opts: RunOptions): Promise<CaseResult> {
  const maxRetries = opts.max_retries ?? 1;
  let lastResult: CaseResult | undefined;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = await runCaseOnce({ ...opts });
    if (result.passed) {
      return { ...result, attempts: attempt, flaked: attempt > 1 };
    }
    lastResult = result;
    if (attempt <= maxRetries && opts.verbose === true) {
      console.error(`[retry] ${opts.case.id} failed attempt ${attempt}/${maxRetries + 1} — retrying`);
    }
  }
  return { ...lastResult!, attempts: maxRetries + 1, flaked: false };
}

interface RunOnceOptions {
  case: AgentRegressionCase;
  model?: string;
  verbose?: boolean;
}

async function runCaseOnce(opts: RunOnceOptions): Promise<CaseResult> {
  const { case: testCase, model = DEFAULT_MODEL, verbose = false } = opts;
  const startedAt = Date.now();

  // claude -p flags chosen for full Desktop fidelity + harness control:
  //   --print / -p                       : non-interactive, prompt-and-exit
  //   --output-format stream-json        : NDJSON events on stdout
  //   --verbose                          : required to enable stream-json on stdout
  //   --strict-mcp-config + --mcp-config : use ONLY our MCP server, ignore user/project configs
  //   --model <id>                       : pin to Sonnet 4.6 by default
  //   --permission-mode bypassPermissions: auto-approve every tool call. `--allowedTools` does NOT
  //                                        support glob patterns over MCP tool names — the `*`
  //                                        syntax is for Bash arg matching only (e.g. `Bash(git *)`).
  //                                        Bypass is safe here because --strict-mcp-config already
  //                                        confines MCP to our server, and we explicitly deny the
  //                                        built-in side-effect tools below.
  //   --tools ""                         : restrict the agent to ONLY the MCP
  //                                        server's tools. `--tools` filters
  //                                        the TOOL SURFACE exposed to the
  //                                        model (per Claude Code CLI docs);
  //                                        `--allowedTools` only affects the
  //                                        permission gate, NOT what the
  //                                        agent can see. Passing `""`
  //                                        disables every Claude Code
  //                                        built-in (Bash, Edit, Read, Grep,
  //                                        Glob, Skill, Task*, ToolSearch,
  //                                        WebFetch, …); MCP servers pass
  //                                        through independently via
  //                                        --mcp-config. Verified Session 78:
  //                                        the agent's `tools[]` init list
  //                                        contains only `mcp__<server>__*`
  //                                        entries after this flag.
  //                                        Closer to a Desktop user's
  //                                        toolset AND stable against future
  //                                        Claude Code surface additions.
  //   --permission-mode bypassPermissions: with the surface already filtered
  //                                        to MCP-only, auto-approve every
  //                                        call so the harness runs unattended.
  // The prompt itself is piped to stdin (not argv) so quotes and punctuation
  // don't need shell-escaping.
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', MCP_CONFIG_PATH,
    '--model', model,
    '--permission-mode', 'bypassPermissions',
    // `--tools ""` removes every Claude Code built-in (Bash/Edit/Read/
    // Grep/Glob/Skill/Task*/ToolSearch/etc.) from the agent's tool
    // surface. MCP-server tools pass through independently via
    // --mcp-config. Verified by inspecting the `tools[]` field on
    // the system init event — empty arg = MCP-only surface.
    '--tools', '',
  ];

  // `claude.exe` is a real executable on Windows + a binary on Unix, so
  // spawn without shell:true. That avoids both the deprecation warning
  // and the argv-mangling that hits prompts with quotes / punctuation.
  //
  // `MCP_MOCK_TRANSPORT=1` propagates from this process into claude.exe
  // and on into the MCP server child it spawns via --mcp-config. The
  // server's connectXXX wrappers (am4/midi.ts etc.) short-circuit to
  // an in-memory mock when the flag is set — no USB, no hardware
  // required. Agent-regression cases all run against the mock by
  // default; opt out via `--real-hardware` for the launch-verify-style
  // wire-roundtrip test.
  const child = spawn('claude', args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, MCP_MOCK_TRANSPORT: process.env.AGENT_REGRESSION_REAL_HARDWARE === '1' ? '0' : '1' },
  });
  child.stdin.write(testCase.prompt);
  child.stdin.end();

  const tool_calls: ToolCall[] = [];
  const pending_tool_uses = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  let final_text = '';
  let raw_event_count = 0;
  let buffer = '';
  // Hold every raw stream-json line so we can dump a trace on failure.
  // Cheap (a typical case produces ~50-200 lines, ~50-300 KB) and the
  // only diagnostic we have when an agent loops or crashes.
  const raw_lines: string[] = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      raw_event_count++;
      raw_lines.push(line);
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        if (verbose) console.error(`[parse-fail] ${line}`);
        continue;
      }
      if (verbose) console.error(`[event] ${line.slice(0, 240)}`);
      processEvent(event, tool_calls, pending_tool_uses, (text) => {
        final_text += text;
      });
    }
  });

  const maxWall = (testCase.expectations.max_wall_seconds ?? 120) * 1000;
  const timeout = setTimeout(() => {
    if (!child.killed) child.kill('SIGTERM');
  }, maxWall);

  const exitCode: number = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
  });
  clearTimeout(timeout);

  const wall_seconds = (Date.now() - startedAt) / 1000;

  // Filter out Claude Code's invisible runtime tools (ToolSearch, etc.)
  // before applying assertions — they're schema-loading plumbing, not
  // agent decisions. We keep them out of `tool_calls` entirely so the
  // sequence shown in the report reflects what the AGENT did.
  const agent_tool_calls = tool_calls.filter((c) => !HARNESS_INVISIBLE_TOOLS.has(c.short_name));

  const failures = applyAssertions(testCase, agent_tool_calls, final_text, exitCode);

  // Capture-on-fail: dump the full raw stream-json so the maintainer
  // can diagnose without re-running with --verbose. Without this, a
  // release-gate failure is opaque — the parsed tool_calls[] tells
  // you WHAT the agent did but not WHY (the assistant thinking text
  // explaining the retry, the tool_result error envelopes, etc).
  if (failures.length > 0 && raw_lines.length > 0) {
    try {
      mkdirSync(TRACES_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tracePath = path.join(TRACES_DIR, `${testCase.id}-${stamp}.ndjson`);
      writeFileSync(tracePath, raw_lines.join('\n') + '\n', 'utf8');
      console.error(`    trace: ${path.relative(process.cwd(), tracePath)}`);
    } catch (err) {
      console.error(`    [trace dump failed] ${(err as Error).message}`);
    }
  }

  return {
    case: testCase,
    passed: failures.length === 0,
    failures,
    tool_calls: agent_tool_calls,
    final_text,
    wall_seconds,
    raw_event_count,
    attempts: 1,
    flaked: false,
  };
}

/**
 * Translate one stream-json event into a tool_calls[] entry or a text
 * accumulation. The Claude Code stream-json schema wraps assistant
 * turns in `assistant` envelopes with `message.content[]` arrays, and
 * tool results in `user` envelopes; we destructure both shapes.
 */
function processEvent(
  event: unknown,
  tool_calls: ToolCall[],
  pending: Map<string, { name: string; arguments: Record<string, unknown> }>,
  appendText: (text: string) => void,
): void {
  if (event === null || typeof event !== 'object') return;
  const e = event as { type?: string; message?: unknown };

  // Schema 1: { type: "assistant", message: { content: [{type:"tool_use"|"text",...}] } }
  if (e.type === 'assistant' && e.message !== null && typeof e.message === 'object') {
    const msg = e.message as { content?: unknown };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as { type?: string; id?: string; name?: string; input?: unknown; text?: string };
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          pending.set(b.id, {
            name: b.name,
            arguments: (b.input as Record<string, unknown> | undefined) ?? {},
          });
        } else if (b.type === 'text' && typeof b.text === 'string') {
          appendText(b.text);
        }
      }
    }
  }

  // Schema 2: { type: "user", message: { content: [{type:"tool_result", tool_use_id, content, is_error}] } }
  if (e.type === 'user' && e.message !== null && typeof e.message === 'object') {
    const msg = e.message as { content?: unknown };
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const pendingUse = pending.get(b.tool_use_id);
          if (pendingUse === undefined) continue;
          pending.delete(b.tool_use_id);
          tool_calls.push({
            name: pendingUse.name,
            short_name: stripPrefix(pendingUse.name),
            arguments: pendingUse.arguments,
            result: stringifyToolResult(b.content),
            is_error: b.is_error === true,
          });
        }
      }
    }
  }

  // Schema 3 (older / alternate): top-level tool_use / tool_result events.
  if (e.type === 'tool_use') {
    const t = e as { id?: string; name?: string; input?: unknown };
    if (typeof t.id === 'string' && typeof t.name === 'string') {
      pending.set(t.id, {
        name: t.name,
        arguments: (t.input as Record<string, unknown> | undefined) ?? {},
      });
    }
  }
  if (e.type === 'tool_result') {
    const t = e as { tool_use_id?: string; content?: unknown; is_error?: boolean };
    if (typeof t.tool_use_id === 'string') {
      const pendingUse = pending.get(t.tool_use_id);
      if (pendingUse !== undefined) {
        pending.delete(t.tool_use_id);
        tool_calls.push({
          name: pendingUse.name,
          short_name: stripPrefix(pendingUse.name),
          arguments: pendingUse.arguments,
          result: stringifyToolResult(t.content),
          is_error: t.is_error === true,
        });
      }
    }
  }
}

function stripPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/**
 * Claude Code's internal tools that don't represent agent "work" against
 * the MCP server. Excluded from tool-count tallies so max_tools / sequence
 * assertions reflect only the agent's actual decision-making, not the
 * runtime's lazy-schema-loading behavior.
 *
 * `ToolSearch` in particular is Claude Code's deferred-tool resolver —
 * it loads schemas for tools that are surfaced by name in system reminders
 * but not yet in the agent's context. The agent calls it implicitly to
 * "discover" our MCP tools; it would run zero times if MCP tools were
 * pre-loaded but consistently runs 1-3× per session as schemas get pulled
 * in chunks.
 */
const HARNESS_INVISIBLE_TOOLS: ReadonlySet<string> = new Set([
  'ToolSearch',
]);

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (c !== null && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text);
      return JSON.stringify(c);
    }).join('\n');
  }
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

/**
 * Apply the case's `expectations` to the captured run. Returns an
 * array of failure messages — empty array means pass.
 */
function applyAssertions(
  testCase: AgentRegressionCase,
  tool_calls: readonly ToolCall[],
  final_text: string,
  exitCode: number,
): string[] {
  const failures: string[] = [];
  const exp = testCase.expectations;

  if (exitCode !== 0) {
    failures.push(`claude -p exited with code ${exitCode}`);
  }

  const callsByName = new Map<string, ToolCall[]>();
  for (const c of tool_calls) {
    const list = callsByName.get(c.short_name) ?? [];
    list.push(c);
    callsByName.set(c.short_name, list);
  }

  // must_call (optional — omitted when the case accepts multiple paths
  // and asserts via tool_call_validators / text_contains only).
  for (const tool of exp.must_call ?? []) {
    if (!callsByName.has(tool)) {
      failures.push(`must_call: agent never called \`${tool}\``);
    }
  }

  // must_not_call
  for (const tool of exp.must_not_call ?? []) {
    if (callsByName.has(tool)) {
      failures.push(`must_not_call: agent called \`${tool}\` ${callsByName.get(tool)!.length}×`);
    }
  }

  // max_tools / min_tools
  if (tool_calls.length > exp.max_tools) {
    failures.push(`max_tools: ${tool_calls.length} > ${exp.max_tools} (sequence: ${tool_calls.map((c) => c.short_name).join(' → ')})`);
  }
  const minTools = exp.min_tools ?? 1;
  if (tool_calls.length < minTools) {
    failures.push(`min_tools: only ${tool_calls.length} call(s), expected at least ${minTools} (did the agent refuse?)`);
  }

  // max_repeats
  for (const [tool, limit] of Object.entries(exp.max_repeats ?? {})) {
    const count = callsByName.get(tool)?.length ?? 0;
    if (count > limit) {
      failures.push(`max_repeats: \`${tool}\` called ${count}× (limit ${limit}) — likely retry loop`);
    }
  }

  // text_contains / text_not_contains
  for (const needle of exp.text_contains ?? []) {
    if (!final_text.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`text_contains: final text missing "${needle}"`);
    }
  }
  for (const needle of exp.text_not_contains ?? []) {
    if (final_text.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`text_not_contains: final text contained "${needle}"`);
    }
  }

  // tool_call_validators
  for (const v of exp.tool_call_validators ?? []) {
    const matches = callsByName.get(v.tool);
    if (matches === undefined || matches.length === 0) {
      if (v.optional === true) continue; // silently skip — tool wasn't called and that's OK
      failures.push(`tool_call_validators: \`${v.tool}\` was never called`);
      continue;
    }
    const idx = v.call_index ?? 0;
    if (idx >= matches.length) {
      failures.push(`tool_call_validators: \`${v.tool}\` was called ${matches.length}× but validator wanted index ${idx}`);
      continue;
    }
    const call = matches[idx];
    const result = v.check(call.arguments, call.result);
    if (result !== true) {
      failures.push(`tool_call_validator(${v.tool}#${idx}): ${result}`);
    }
  }

  // should_avoid_dropped_param_warning — scan apply_preset results for the
  // executor's "dropped X param(s)" warning text.
  if (exp.should_avoid_dropped_param_warning === true) {
    for (const c of tool_calls) {
      if (c.short_name !== 'apply_preset') continue;
      if (c.result?.includes('Dropped ') === true || c.result?.includes("don't apply on the active block type") === true) {
        failures.push(`should_avoid_dropped_param_warning: apply_preset response carried a dropped-param warning — agent picked a type that doesn't expose every requested knob`);
      }
    }
  }

  // Hardware-unreachable detection (Session 78). Hardware-tier cases that
  // had hardware visible at sweep startup but lose it mid-sweep would
  // otherwise pass silently — args-only validators ignore tool result
  // errors. Scan every tool result for the device-not-found patterns the
  // MCP layer emits (AM4 / Axe-Fx II/III / Hydrasynth use the same
  // "not found in the MIDI device list" or "not visible" envelope) and
  // fail loudly so the operator knows to re-plug.
  if (testCase.tier === 'hardware') {
    for (const c of tool_calls) {
      if (c.result === undefined) continue;
      if (HARDWARE_UNREACHABLE_PATTERN.test(c.result)) {
        failures.push(
          `hardware unreachable mid-sweep: \`${c.short_name}\` returned a device-not-found error. Re-plug the device and re-run. ` +
          `(result snippet: ${c.result.slice(0, 120).replace(/\s+/g, ' ')})`,
        );
        break; // one diagnostic per case is enough
      }
    }
  }

  return failures;
}

/**
 * Pattern that matches the MCP layer's "device not connected" envelopes.
 * Every Fractal / Hydrasynth descriptor's MIDI connect path throws a
 * message containing one of these substrings when the named device isn't
 * visible. Keep in sync with the lead-in strings in
 * `packages/*​/src/midi.ts:notFoundLeadIn` and the list_midi_ports
 * "AM4 not visible" fallback in `packages/server-all/src/server/index.ts`.
 */
const HARDWARE_UNREACHABLE_PATTERN: RegExp =
  /not found in the MIDI device list|AM4 not visible|Axe-?Fx ?(II|III) not (found|visible)|Hydrasynth not (found|visible)|No MIDI port matching/i;

// CLI: `tsx runner.ts <case-id>` — useful during case authoring.
const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/') ?? '');
if (isMain && process.argv[2] !== undefined) {
  const caseId = process.argv[2];
  const { ALL_CASES } = await import('./cases-all.js');
  const testCase = ALL_CASES.find((c) => c.id === caseId);
  if (testCase === undefined) {
    console.error(`No case with id "${caseId}". Known ids: ${ALL_CASES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }
  const result = await runCase({ case: testCase, verbose: true });
  console.log(`\n${result.passed ? 'PASS' : 'FAIL'}: ${result.case.id} (${result.wall_seconds.toFixed(1)}s, ${result.tool_calls.length} tool calls)`);
  for (const f of result.failures) console.log(`  ✗ ${f}`);
  process.exit(result.passed ? 0 : 1);
}
