/**
 * Agent-regression harness: runs one case via `claude -p`.
 *
 * Spawns Claude Code in non-interactive mode with our MCP server
 * (`packages/server-all/dist/server/index.js`) as the only available
 * tool source, streams the JSON event log to stdout, parses each
 * line into a tool-call / text record, then applies the case's
 * assertions.
 *
 * Bills against the operator's Claude Max subscription (the same
 * authentication their interactive `claude` session uses). No
 * ANTHROPIC_API_KEY required.
 *
 * Authoring shortcut, drive a single case during development:
 *   npx tsx scripts/agent-regression/runner.ts <case-id>
 */

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { buildKit } from '@mcp-midi-control/spd-sx/codec/kitXml.js';
import { encodeWavePrm, nameToNm } from '@mcp-midi-control/spd-sx/codec/wavePrm.js';
import { isEnvironmentalSignature } from './resultsLog.js';

import type {
  AgentRegressionCase,
  CaseResult,
  ToolCall,
} from './types.js';

/**
 * Build (once) a deterministic SPD-SX storage fixture for sampler-archetype
 * cases and return its root, to be injected as `MCP_SPDSX_ROOT`. The SPD-SX is a
 * storage-transport device (no MIDI mock): its reader needs a mounted `Roland/
 * SPD-SX` tree with a KIT dir. The reader uses only the PRM (wave names/paths)
 * and KIT (pad→wave) XML — not the WAV DATA — so a PRM + KIT fixture is enough
 * (mirrors the verify-spdsx hybrid-descriptor golden). Three waves + one kit.
 */
let spdsxFixtureRoot: string | undefined;
function getSpdsxFixtureRoot(): string {
  if (spdsxFixtureRoot !== undefined) return spdsxFixtureRoot;
  const root = path.join(tmpdir(), 'agent-regression-spdsx', 'Roland', 'SPD-SX');
  const prm = path.join(root, 'WAVE', 'PRM', '00');
  const kit = path.join(root, 'KIT');
  mkdirSync(prm, { recursive: true });
  mkdirSync(kit, { recursive: true });
  const waves = ['kick', 'snare', 'hat'];
  waves.forEach((name, i) => {
    writeFileSync(path.join(prm, `0${i}.spd`), encodeWavePrm(nameToNm(name), `00/${name}.wav`, 0));
  });
  // Kit 1 (file kit000.spd): pads 1-3 → waves 0,1,2; the rest empty. Written
  // UNCONDITIONALLY (like the PRMs above) so a persisted temp dir from a prior
  // run can't leave a stale kit if the codec ever changes.
  writeFileSync(path.join(kit, 'kit000.spd'), buildKit('Demo Kit', [0, 1, 2]));
  spdsxFixtureRoot = root;
  return root;
}

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
   * Max retries on failure. Default 1: Sonnet is non-deterministic
   * even at temperature 0, so a single spurious fail shouldn't block
   * release. Pass 0 to disable retry (CI debug mode, or when iterating
   * on a single case where you want to see every failure mode).
   *
   * Empirically validated: a 23-case sweep had 2/23 cases pass only on
   * retry. Default 0 would have caused 2 false-negative release-gate
   * failures. Capture-on-fail traces (this file) make the underlying
   * flake visible without losing the gate.
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
/**
 * Classify a result as an environmental (OS spawn-refusal) non-run vs a real
 * outcome, via the SHARED signature predicate (so the runtime path and the
 * historical stats path use one detector — no split). The Windows 0xC0000142
 * (STATUS_DLL_INIT_FAILED) cascade: instant exit, zero tool calls.
 */
function isEnvironmentalResult(result: CaseResult): boolean {
  return isEnvironmentalSignature({
    passed: result.passed,
    environmental: result.environmental,
    tool_count: result.tool_calls.length,
    wall_seconds: result.wall_seconds,
    failures: result.failures,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runCase(opts: RunOptions): Promise<CaseResult> {
  const maxRetries = opts.max_retries ?? 1;
  // Environmental (OS spawn-refusal) failures get their OWN retry budget with
  // backoff (NO reap — an in-process reap would kill the sweep's own launcher
  // chain), separate from the instant LLM-flake retry: an immediate re-spawn
  // fails identically, but a few seconds of backoff lets the OS release the
  // handles that triggered the cascade. After the budget, the case is returned
  // tagged environmental (NOT counted as a real pass/fail).
  const maxEnvRetries = 2;
  let envAttempts = 0;
  let lastResult: CaseResult | undefined;
  let attempt = 1;
  const flakeCap = maxRetries + 1;
  while (attempt <= flakeCap) {
    const result = await runCaseOnce({ ...opts });
    if (result.passed) {
      return { ...result, attempts: attempt, flaked: attempt > 1 };
    }
    if (isEnvironmentalResult(result)) {
      if (envAttempts < maxEnvRetries) {
        envAttempts++;
        const backoffMs = 4000 * envAttempts;
        if (opts.verbose === true) {
          console.error(`[env-retry] ${opts.case.id}: OS spawn refusal (0xC0000142). backoff ${backoffMs}ms (${envAttempts}/${maxEnvRetries})`);
        }
        // Backoff only — NO in-process reap: a reap from inside the sweep would
        // kill this runner's own launcher chain. The wait gives the OS time to
        // release the per-spawn handles that triggered the refusal.
        await sleep(backoffMs);
        continue; // re-spawn WITHOUT consuming a flake attempt
      }
      // Exhausted env retries: hand back tagged, not a real failure.
      return { ...result, attempts: attempt, flaked: false, environmental: true };
    }
    lastResult = result;
    if (attempt < flakeCap && opts.verbose === true) {
      console.error(`[retry] ${opts.case.id} failed attempt ${attempt}/${flakeCap}, retrying`);
    }
    attempt++;
  }
  return { ...lastResult!, attempts: flakeCap, flaked: false };
}

interface RunOnceOptions {
  case: AgentRegressionCase;
  model?: string;
  verbose?: boolean;
}

/**
 * Apply a case's `setup` spec before the agent prompt fires. Mirrors
 * E2E test fixtures: each test gets a known starting device state
 * instead of inheriting whatever the previous case left in the
 * working buffer. Connects to the SAME MCP server `claude -p` is
 * about to spawn (StdioClientTransport against
 * packages/server-all/dist/server/index.js), invokes apply_preset
 * with the seed spec, closes.
 *
 * Skipped under mock-transport sweeps: the mock's clean-scratch
 * state is already deterministic; setup only matters when wire
 * state can drift across cases (real hardware).
 *
 * Returns the apply_preset response so the runner can surface
 * setup failures with the spec it tried to apply. Throws on
 * MCP connect failure (caller wraps).
 */
async function applyCaseSetup(testCase: AgentRegressionCase, childEnv: NodeJS.ProcessEnv): Promise<void> {
  if (testCase.setup === undefined) return;
  // Mock transport: skip setup. The mock fixtures are deterministic
  // per-case; layering a setup wire-write on top would just be
  // redundant. Real-hardware sweeps benefit from the seeding.
  if (childEnv.MCP_MOCK_TRANSPORT === '1') return;
  const SERVER_ENTRY = path.resolve('packages', 'server-all', 'dist', 'server', 'index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
    env: childEnv as Record<string, string>,
  });
  const client = new Client({ name: 'agent-regression-setup', version: '0.1.0' });
  try {
    await client.connect(transport);
    const args = {
      port: testCase.device,
      ...testCase.setup.apply_preset,
    };
    const result = await client.callTool({ name: 'apply_preset', arguments: args });
    // Surface apply_preset's structured `ok:false` errors to the
    // caller so test runs don't silently start from a half-applied
    // state. The MCP SDK returns isError when DispatchError fires;
    // for ok:false (validation_errors), peek into the structured
    // content.
    if ((result as { isError?: boolean }).isError === true) {
      const content = (result as { content?: Array<{ text?: string }> }).content;
      const text = content?.[0]?.text ?? '(no error text)';
      throw new Error(`setup apply_preset returned isError: ${text}`);
    }
    const structured = (result as { structuredContent?: { ok?: boolean; validation_errors?: unknown[] } }).structuredContent;
    if (structured !== undefined && structured.ok === false) {
      const errs = JSON.stringify(structured.validation_errors ?? []);
      throw new Error(`setup apply_preset returned ok:false with validation_errors: ${errs}`);
    }
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }
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
  //                                        support glob patterns over MCP tool names: the `*`
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
  //                                        --mcp-config. Verified against
  //                                        the agent's `tools[]` init list:
  //                                        it
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
    // Suppress the "read STATE.md first" reflex inherited from the
    // project CLAUDE.md. CLAUDE.md is written for engineer-driven
    // sessions; agent-regression spawns claude -p with no Read/Bash
    // tool, so an agent that tries to follow CLAUDE.md emits raw
    // `<function_calls>` XML as text instead of using MCP tool_use
    // blocks, and the case times out with 0 tool calls.
    //
    // A later strengthening: the v1 phrasing ("you have only MCP
    // tools; use them directly") reduced the reflex but didn't close
    // it. The am4-recipe-auto-wah case flake-failed on attempt 1
    // emitting Read XML. Per Anthropic prompting best practices
    // (https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices):
    // negation-as-emphasis is folklore, not doctrine. The endorsed
    // pattern is positive-scope-first, then explicit negation with
    // rationale, framed as a session boundary. We add (a) specific
    // tool names the model commonly hallucinates and (b) explicit
    // fallback behavior for prompts referencing project files. No
    // describe_device prescription: that would bias single-tool cases.
    '--append-system-prompt',
    'You are a tone-build assistant operating a real guitar amplifier exclusively through MCP tools. The MCP tools in your tool surface are your only tools: there is no file system, shell, or web access in this session, and no Read, Bash, Grep, Write, or WebFetch tools. If a prompt references project files or source code, acknowledge they are out of scope.',
    // `--tools ""` removes every Claude Code built-in (Bash/Edit/Read/
    // Grep/Glob/Skill/Task*/ToolSearch/etc.) from the agent's tool
    // surface. MCP-server tools pass through independently via
    // --mcp-config. Verified by inspecting the `tools[]` field on
    // the system init event: empty arg = MCP-only surface.
    '--tools', '',
  ];

  // `claude.exe` is a real executable on Windows + a binary on Unix, so
  // spawn without shell:true. That avoids both the deprecation warning
  // and the argv-mangling that hits prompts with quotes or punctuation.
  //
  // `MCP_MOCK_TRANSPORT=1` propagates from this process into claude.exe
  // and on into the MCP server child it spawns via --mcp-config. The
  // server's connectXXX wrappers (am4/midi.ts etc.) short-circuit to
  // an in-memory mock when the flag is set: no USB, no hardware
  // required. Agent-regression cases all run against the mock by
  // default; opt out via `--real-hardware` for the launch-verify-style
  // wire-roundtrip test.
  //
  // `MOCK_FIXTURE` is picked per case: when `case.mockFixture` is set,
  // inject the chosen profile so the
  // AM4 mock (and future II / III mocks) read it at module load. Case-spec
  // wins over the inherited process env so ad-hoc `MOCK_FIXTURE=...` runs
  // still work when a case doesn't pin a profile.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MCP_MOCK_TRANSPORT: process.env.AGENT_REGRESSION_REAL_HARDWARE === '1' ? '0' : '1',
  };
  if (testCase.mockFixture !== undefined) {
    childEnv.MOCK_FIXTURE = testCase.mockFixture;
  }
  // Sampler archetype (SPD-SX, storage transport): point the server at a
  // deterministic on-disk fixture instead of a real mounted drive.
  if (testCase.device === 'spd-sx' && process.env.AGENT_REGRESSION_REAL_HARDWARE !== '1') {
    childEnv.MCP_SPDSX_ROOT = getSpdsxFixtureRoot();
  }

  // Apply the case's setup (if any) BEFORE the agent prompt fires.
  // Hermetic-test pattern: every case gets a known starting state
  // instead of inheriting the previous case's working buffer.
  // Failures abort the case with a `setup_failed` failure entry.
  if (testCase.setup !== undefined) {
    try {
      await applyCaseSetup(testCase, childEnv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        case: testCase,
        passed: false,
        failures: [`setup_failed: ${msg}`],
        tool_calls: [],
        final_text: '',
        wall_seconds: (Date.now() - startedAt) / 1000,
        raw_event_count: 0,
        attempts: 1,
        flaked: false,
      };
    }
  }

  // `CLAUDE_BIN` env override lets the harness pin a specific CLI
  // binary when the one on PATH has a regression that breaks the
  // sweep. One claude CLI release stopped awaiting MCP-server
  // connection before emitting the init event: the model sees
  // `mcp_servers[].status: "pending"` and `tools: []`, then
  // hallucinates `<function_calls>` XML in prose instead of calling
  // real tools. Setting CLAUDE_BIN to a known-good prior binary
  // (e.g. a renamed copy of the previous install) restores the
  // wait-for-MCP behavior. Remove the override once the regression
  // is fixed upstream.
  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
  const child = spawn(claudeBin, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: childEnv,
  });
  child.stdin.write(testCase.prompt);
  child.stdin.end();

  const tool_calls: ToolCall[] = [];
  const pending_tool_uses = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  let final_text = '';
  let raw_event_count = 0;
  let buffer = '';
  // Hold every raw stream-json line so we can dump a trace on failure.
  // Cheap (a typical case produces 50 to 200 lines, 50 to 300 KB) and
  // the only diagnostic we have when an agent loops or crashes.
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

  // Wall-limit kill. On Windows, `child.kill('SIGTERM')` does NOT reliably
  // terminate the `claude` process tree (claude spawns its own MCP-server
  // child, and SIGTERM is emulated): the runner's `await child.on('exit')`
  // then never resolves and the whole sweep hangs forever. Force-kill the
  // entire tree (taskkill /T /F on Windows; SIGKILL elsewhere), and arm a
  // grace timer that resolves the await even if the OS never delivers `exit`,
  // so a runaway case always terminates the case instead of the sweep.
  let timedOut = false;
  const maxWall = (testCase.expectations.max_wall_seconds ?? 120) * 1000;
  const exitCode: number = await new Promise((resolve) => {
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    child.on('exit', (code) => settle(code ?? -1));
    const timeout = setTimeout(() => {
      timedOut = true;
      forceKillTree(child.pid);
      // If the kill still doesn't yield an `exit` event within a short grace
      // window, resolve anyway so the harness reports a timeout instead of
      // hanging. The orphaned tree, if any, is reaped by the OS.
      setTimeout(() => settle(-1), 5000);
    }, maxWall);
    // Clear the wall timer once the child exits on its own.
    child.on('exit', () => clearTimeout(timeout));
  });

  const wall_seconds = (Date.now() - startedAt) / 1000;

  // Filter out Claude Code's invisible runtime tools (ToolSearch, etc.)
  // before applying assertions: they're schema-loading plumbing, not
  // agent decisions. We keep them out of `tool_calls` entirely so the
  // sequence shown in the report reflects what the AGENT did.
  const agent_tool_calls = tool_calls.filter((c) => !HARNESS_INVISIBLE_TOOLS.has(c.short_name));

  // A wall-limit kill reports as a clean timeout, not a confusing "exited with
  // code -1": pass exitCode 0 to applyAssertions so its exit-code check stays
  // quiet, and prepend the timeout failure explicitly.
  const failures = timedOut
    ? [
        `timed out after ${(maxWall / 1000).toFixed(0)}s wall limit (force-killed); ` +
          `agent made ${agent_tool_calls.length} tool call(s) before the cutoff`,
        ...applyAssertions(testCase, agent_tool_calls, final_text, 0),
      ]
    : applyAssertions(testCase, agent_tool_calls, final_text, exitCode);

  // Default flipped to ALWAYS trace (for cross-session
  // analytics on tool usage, wall times, agent decision patterns). Set
  // TRACE_ONLY_ON_FAIL=1 to opt back into capture-on-fail behavior
  // (saves disk on CI / batch sweeps where pass-traces aren't useful).
  // Legacy TRACE_ALWAYS=1 still honored: it's now a no-op next to the
  // default but kept for back-compat with existing doc / scripts.
  const traceOnFailOnly = process.env.TRACE_ONLY_ON_FAIL === '1';
  const shouldDumpTrace = failures.length > 0 || !traceOnFailOnly;
  if (shouldDumpTrace && raw_lines.length > 0) {
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
 * Force-kill a spawned process AND its descendants. `claude` spawns its own
 * MCP-server child, and on Windows a plain `child.kill('SIGTERM')` neither
 * reaches that grandchild nor reliably terminates `claude` itself, so the
 * runner hangs on `child.on('exit')`. `taskkill /T /F` walks the tree by PID;
 * on POSIX, SIGKILL the group. Best-effort: a race where the tree already
 * exited just throws, which we swallow.
 */
function forceKillTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already exited */
  }
}

/**
 * Claude Code's internal tools that don't represent agent "work" against
 * the MCP server. Excluded from tool-count tallies so max_tools / sequence
 * assertions reflect only the agent's actual decision-making, not the
 * runtime's lazy-schema-loading behavior.
 *
 * `ToolSearch` in particular is Claude Code's deferred-tool resolver:
 * it loads schemas for tools that are surfaced by name in system reminders
 * but not yet in the agent's context. The agent calls it implicitly to
 * "discover" our MCP tools; it would run zero times if MCP tools were
 * pre-loaded but consistently runs 1 to 3 times per session as schemas
 * get pulled in chunks.
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
 * array of failure messages; an empty array means pass.
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

  // must_call (optional, omitted when the case accepts multiple paths
  // and asserts via tool_call_validators / text_contains only).
  for (const tool of exp.must_call ?? []) {
    if (!callsByName.has(tool)) {
      failures.push(`must_call: agent never called \`${tool}\``);
    }
  }

  // must_call_any (OR-of-AND). The agent must satisfy at least
  // one of the inner groups; every tool in that group must have been
  // called. Used when multiple end-state paths are acceptable
  // (e.g. apply_preset vs primitive set_block + set_params).
  if (exp.must_call_any !== undefined && exp.must_call_any.length > 0) {
    const satisfied = exp.must_call_any.some((group) =>
      group.length > 0 && group.every((tool) => callsByName.has(tool)),
    );
    if (!satisfied) {
      const groupDescs = exp.must_call_any
        .map((g) => `[${g.join(' + ')}]`)
        .join(' OR ');
      failures.push(
        `must_call_any: agent satisfied none of the accepted paths (${groupDescs}); called: [${[...callsByName.keys()].join(', ')}]`,
      );
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
      failures.push(`max_repeats: \`${tool}\` called ${count}× (limit ${limit}), likely retry loop`);
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
  // text_contains_any (OR-of-AND). Pass when at least one inner AND
  // group is fully satisfied. Empty inner groups never match.
  if (exp.text_contains_any !== undefined && exp.text_contains_any.length > 0) {
    const lower = final_text.toLowerCase();
    const groupSatisfied = (group: readonly string[]): boolean => {
      if (group.length === 0) return false;
      return group.every((needle) => lower.includes(needle.toLowerCase()));
    };
    if (!exp.text_contains_any.some(groupSatisfied)) {
      const summary = exp.text_contains_any
        .map((g) => `[${g.map((s) => `"${s}"`).join(' + ')}]`)
        .join(' OR ');
      failures.push(`text_contains_any: none of the OR-alternatives matched; expected one of ${summary}`);
    }
  }

  // tool_call_validators
  for (const v of exp.tool_call_validators ?? []) {
    const matches = callsByName.get(v.tool);
    if (matches === undefined || matches.length === 0) {
      if (v.optional === true) continue; // silently skip: tool wasn't called and that's OK
      failures.push(`tool_call_validators: \`${v.tool}\` was never called`);
      continue;
    }
    const idx = v.call_index === 'last' ? matches.length - 1 : (v.call_index ?? 0);
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

  // should_avoid_dropped_param_warning: scan apply_preset results for
  // any dropped-param signal. Two flavors land here:
  //   - Post-write executor warning: "Dropped …" / "don't apply on the
  //     active block type" (AM4 writer surface after the wire ack).
  //   - Pre-flight warning: `validation_info[]` entry with
  //     `level: 'warning'` + `dropped_param` (dispatcher pre-flight,
  //     before the wire). Same root cause; same agent-side mistake.
  if (exp.should_avoid_dropped_param_warning === true) {
    for (const c of tool_calls) {
      if (c.short_name !== 'apply_preset') continue;
      const r = c.result ?? '';
      const postWriteHit = r.includes('Dropped ') || r.includes("don't apply on the active block type");
      const preFlightHit = /"dropped_param"\s*:/.test(r) && /"level"\s*:\s*"warning"/.test(r);
      if (postWriteHit || preFlightHit) {
        failures.push(`should_avoid_dropped_param_warning: apply_preset response carried a dropped-param warning; agent picked a type that doesn't expose every requested knob`);
      }
    }
  }

  // Hardware-unreachable detection. Hardware-tier cases that had
  // hardware visible at sweep startup but lose it mid-sweep would
  // otherwise pass silently: args-only validators ignore tool result
  // errors. Scan every tool result for the device-not-found patterns the
  // MCP layer emits (AM4 / Axe-Fx II/III / Hydrasynth use the same
  // "not found in the MIDI device list" or "not visible" envelope) and
  // fail loudly so the operator knows to re-plug.
  if (process.env.AGENT_REGRESSION_REAL_HARDWARE === '1') {
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

// CLI: `tsx runner.ts <case-id>`, useful during case authoring.
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
  // Single-case dev runs append to the same corpus as the full sweep (tagged
  // via:'single'), so iteration history isn't lost — only full sweeps logged
  // before. Code-state is dirty-aware (see resultsLog.ts).
  const { captureCodeState, appendResultRow, loadRows, caseHistoryLine } = await import('./resultsLog.js');
  appendResultRow(captureCodeState(), result, {
    mockFixture: testCase.mockFixture,
    via: 'single',
    model: 'claude-sonnet-4-6',
  });
  console.log(`\n${result.passed ? 'PASS' : 'FAIL'}: ${result.case.id} (${result.wall_seconds.toFixed(1)}s, ${result.tool_calls.length} tool calls)`);
  for (const f of result.failures) console.log(`  ✗ ${f}`);
  // Inline trend (automatic — no separate command needed).
  const hist = caseHistoryLine(loadRows(), result.case.id);
  if (hist !== '') console.log(`  ${hist}`);
  process.exit(result.passed ? 0 : 1);
}
