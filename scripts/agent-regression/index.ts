/**
 * Agent-regression sweep: CLI entry.
 *
 * Drives `claude -p` against each enabled case, aggregates results,
 * prints a per-case pass/fail report + a summary table.
 *
 * Usage:
 *   npx tsx scripts/agent-regression/index.ts                       # all cases (mock)
 *   npx tsx scripts/agent-regression/index.ts --device=am4          # one device
 *   npx tsx scripts/agent-regression/index.ts --case=am4-h1-...     # single case
 *   npx tsx scripts/agent-regression/index.ts --model=opus          # override model
 *   npx tsx scripts/agent-regression/index.ts --verbose             # echo events
 *   npx tsx scripts/agent-regression/index.ts --real-hardware       # USB transport
 *
 * All cases run on mock transport by default (no hardware needed).
 * Pass --real-hardware to use USB; cases whose device isn't connected
 * are skipped.
 */

import path from 'node:path';
import { execSync, spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { runCase } from './runner.js';
import { ALL_CASES } from './cases-all.js';
import { captureCodeState, appendResultRow, loadRows, caseHistoryLine } from './resultsLog.js';
import type { AgentRegressionCase, CaseResult, Device } from './types.js';

// Per-case results are appended to a shared, gitignored JSON-lines corpus
// (see resultsLog.ts) so cross-session analytics ("did recipe-pickup wall-time
// drop after the migration?", "which cases flake recurrently?") have a
// machine-readable history. Read by `stats.ts` (npm run agent-sweep:stats).

/**
 * Pre-flight: ask the shipped MCP server which devices are visible
 * over MIDI right now. Used to skip hardware-tier cases cleanly when
 * the corresponding device isn't connected: the release gate works
 * whether the operator is at the bench or not.
 */
async function detectAvailableDevices(): Promise<{ devices: Set<Device>; probeError?: string }> {
  const SERVER_ENTRY = path.resolve('packages', 'server-all', 'dist', 'server', 'index.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agent-regression-port-probe', version: '0.1.0' });
  const available = new Set<Device>();
  let probeError: string | undefined;
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'list_midi_ports', arguments: {} });
    const text = JSON.stringify(result);
    if (/am4/i.test(text)) available.add('am4');
    if (/axe[- ]?fx ?ii(?!i)/i.test(text)) available.add('axe-fx-ii');
    if (/axe[- ]?fx ?iii|axefx ?3/i.test(text)) available.add('axe-fx-iii');
    if (/\bfm ?3\b|fm-3/i.test(text)) available.add('fm3');
    if (/\bfm ?9\b|fm-9/i.test(text)) available.add('fm9');
    if (/\bvp[- ]?4\b/i.test(text)) available.add('vp4');
    if (/ve-?500/i.test(text)) available.add('ve-500');
    if (/hydrasynth|hydra/i.test(text)) available.add('hydrasynth');
  } catch (err) {
    // Probe failure: capture the error so the sweep header can flag it.
    // Without surfacing this, a server crash / list_midi_ports throw /
    // MCP-client-connect timeout makes every hardware case skip silently
    // with the misleading "not visible via list_midi_ports" message.
    probeError = err instanceof Error ? `${err.message}` : String(err);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
  return { devices: available, probeError };
}

interface CliArgs {
  device?: Device;
  caseId?: string;
  model?: string;
  verbose: boolean;
  realHardware: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { verbose: false, realHardware: false };
  for (const raw of argv) {
    if (raw === '--verbose') out.verbose = true;
    else if (raw === '--real-hardware') out.realHardware = true;
    else if (raw.startsWith('--device=')) out.device = raw.slice('--device='.length) as Device;
    else if (raw.startsWith('--case=')) out.caseId = raw.slice('--case='.length);
    else if (raw.startsWith('--model=')) out.model = raw.slice('--model='.length);
  }
  return out;
}

function formatToolSequence(result: CaseResult): string {
  if (result.tool_calls.length === 0) return '(no tool calls)';
  return result.tool_calls.map((c) => c.short_name).join(' → ');
}

/**
 * Pre-flight: spawn the claude CLI with our MCP config and check whether
 * the init event reports MCP `connected` with a populated tools list, or
 * `pending` with empty tools.
 *
 * Catches the claude-code regression where the CLI stopped awaiting MCP
 * server connection before emitting the init event. Every case under that
 * CLI fails with "0 tool calls": the agent sees an empty tool surface and
 * hallucinates `<function_calls>` XML in prose.
 *
 * Returns the verdict so the sweep can abort fast with actionable guidance
 * instead of burning ~30 minutes of agent tokens on guaranteed failures.
 */
async function preflightClaudeMcpHandshake(claudeBin: string): Promise<{ ok: boolean; status: string; toolCount: number; cliVersion: string }> {
  const MCP_CONFIG_PATH = path.resolve('scripts/agent-regression/mcp-config.json');
  let cliVersion = 'unknown';
  try {
    cliVersion = execSync(`"${claudeBin}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* ignore: main spawn will surface the real error */ }
  return await new Promise((resolve) => {
    const child = spawn(claudeBin, [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config', MCP_CONFIG_PATH,
      '--model', 'claude-sonnet-4-6',
      '--permission-mode', 'bypassPermissions',
      '--tools', '',
    ], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MCP_MOCK_TRANSPORT: '1' },
    });
    // Swallow child stderr: we don't want claude's banner cluttering preflight output.
    child.stderr.on('data', () => {});
    // Prompt via stdin matches the runner. argv-prompt collides with the
    // variadic `--tools` greedy parsing on 2.1.x.
    child.stdin.write('noop');
    child.stdin.end();
    let buf = '';
    let settled = false;
    const settle = (verdict: { ok: boolean; status: string; toolCount: number; cliVersion: string }): void => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(verdict);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; subtype?: string; tools?: unknown[]; mcp_servers?: Array<{ status?: string }> };
          if (ev.type === 'system' && ev.subtype === 'init') {
            const status = ev.mcp_servers?.[0]?.status ?? 'missing';
            const toolCount = Array.isArray(ev.tools) ? ev.tools.length : 0;
            settle({ ok: status === 'connected' && toolCount > 0, status, toolCount, cliVersion });
            return;
          }
        } catch { /* skip */ }
      }
    });
    setTimeout(() => settle({ ok: false, status: 'timeout', toolCount: 0, cliVersion }), 15_000);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Catch the known CLI handshake regression before burning tokens on
  // every case. Allow opt-out via SKIP_AGENT_SWEEP_PREFLIGHT=1 for debugging.
  if (process.env.SKIP_AGENT_SWEEP_PREFLIGHT !== '1') {
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude';
    process.stdout.write(`Pre-flight: probing ${claudeBin} MCP handshake … `);
    const verdict = await preflightClaudeMcpHandshake(claudeBin);
    if (verdict.ok) {
      console.log(`✓ ${verdict.cliVersion}, MCP ${verdict.status}, ${verdict.toolCount} tools.`);
    } else {
      console.log(`✗ ${verdict.cliVersion}, MCP ${verdict.status}, ${verdict.toolCount} tools.`);
      console.error('');
      console.error('Agent sweep would fail every case: the claude CLI is not waiting for');
      console.error('the MCP server to connect before emitting the init event. The agent');
      console.error('sees an empty tool surface and hallucinates <function_calls> XML in prose.');
      console.error('');
      console.error('This is a known regression in some claude-code releases; older');
      console.error('releases wait for the MCP server before emitting init.');
      console.error('');
      console.error('Workaround: set CLAUDE_BIN to a known-good binary, e.g.');
      console.error('  CLAUDE_BIN=/path/to/claude npm run agent-sweep');
      console.error('or pin a known-good claude-code release globally with npm i -g.');
      console.error('');
      console.error('Opt out with SKIP_AGENT_SWEEP_PREFLIGHT=1 to force the sweep anyway.');
      process.exit(2);
    }
  }

  // `--real-hardware` flips runner.ts off the default mock-transport
  // path. The runner reads `AGENT_REGRESSION_REAL_HARDWARE` from the
  // env (cross-platform); we set it here so the npm script wrappers
  // can stay shell-agnostic (Git Bash / PowerShell / cmd all run the
  // same `tsx ... --real-hardware` line).
  if (args.realHardware) {
    process.env.AGENT_REGRESSION_REAL_HARDWARE = '1';
  }

  // Disabled cases are excluded from default sweeps but stay registered
  // so `--case=<id>` can still target them (e.g. for one-off retires).
  let cases: readonly AgentRegressionCase[] = ALL_CASES.filter((c) => {
    if (args.device !== undefined && c.device !== args.device) return false;
    if (args.caseId !== undefined && c.id !== args.caseId) return false;
    if (c.disabled === true && args.caseId === undefined) return false;
    return true;
  });

  if (cases.length === 0) {
    console.error('No cases match the filter. Known cases:');
    for (const c of ALL_CASES) console.error(`  ${c.id} [${c.device}]`);
    process.exit(1);
  }

  // Under --real-hardware, detect connected devices and skip cases
  // whose device isn't visible. Under mock (default), all cases run.
  let availableDevices = new Set<string>();
  let probeError: string | undefined;
  if (args.realHardware) {
    const probeResult = await detectAvailableDevices();
    availableDevices = probeResult.devices;
    probeError = probeResult.probeError;
    if (probeError !== undefined) {
      console.error(`\n⚠ Hardware-port probe failed: ${probeError}`);
      console.error('  Cases for missing devices will be skipped.\n');
    }
  }
  const runnable: AgentRegressionCase[] = [];
  const skipped: { case: AgentRegressionCase; reason: string }[] = [];
  for (const c of cases) {
    if (args.realHardware && !availableDevices.has(c.device)) {
      const reason = probeError !== undefined
        ? `port probe failed (${probeError.slice(0, 80)})`
        : `${c.device} not visible via list_midi_ports`;
      skipped.push({ case: c, reason });
      continue;
    }
    // mockFixture declarations are a hard dependency on MCP_MOCK_TRANSPORT=1.
    // Under --real-hardware the runner sets MCP_MOCK_TRANSPORT=0 so the mock
    // module never activates, the fixture has no effect, and the case's
    // pre-conditions ("Z01 carries 'My Clean Build'", "scene read returns
    // 0x7fff") cannot hold. Skip cleanly rather than false-fail.
    if (args.realHardware && c.mockFixture !== undefined) {
      skipped.push({ case: c, reason: `mockFixture requires mock transport; skip in --real-hardware` });
      continue;
    }
    // requiresHardware cases need a real device response (SysEx readback / ack-gated
    // transfer) the mock can't synthesize; run them only on the bench.
    if (!args.realHardware && c.requiresHardware === true) {
      skipped.push({ case: c, reason: `requiresHardware: needs a real device response; run via --real-hardware` });
      continue;
    }
    runnable.push(c);
  }
  cases = runnable;

  const transportMode = args.realHardware ? 'real hardware (USB MIDI)' : 'mock transport (no USB)';
  const disabledCount = ALL_CASES.filter((c) => c.disabled === true).length;
  console.log(`Running ${cases.length} case(s)${args.model !== undefined ? ` with model ${args.model}` : ''}${skipped.length > 0 ? `; skipping ${skipped.length} hardware case(s)` : ''}${disabledCount > 0 ? ` (${disabledCount} disabled, run via --case=<id>)` : ''}.`);
  console.log(`Surface: MCP-only via \`--tools ""\` (Desktop-fidelity, no Bash/Grep/Skill/Task).`);
  console.log(`Transport: ${transportMode}.\n`);

  // Serial execution. Parallelism caused MCP-server cold-start races:
  // spawning 4 `claude -p` children simultaneously each requires its own
  // MCP server child, and some failed to register tools before the agent
  // started thinking (system init showed `tools:[], mcp_servers:[pending]`).
  // The agent then hallucinated tool names and burned LLM tokens. Validated
  // empirically: 4-way parallel turned 1 known-broken case into 5 broken
  // cases. The right wall-time lever is fewer high-value cases, not
  // parallelism.
  const total = cases.length;
  let completed = 0;
  const results: CaseResult[] = [];
  const codeState = captureCodeState();
  if (codeState.dirty) {
    console.log(`Code state: ${codeState.sha} + uncommitted changes${codeState.tree_sha ? ` (tree ${codeState.tree_sha})` : ''} — results tagged dirty.\n`);
  }

  // NOTE on residue hygiene: the Windows 0xC0000142 spawn cascade is driven by
  // leftover processes from a PRIOR killed sweep. We do NOT auto-reap here — a
  // reap from inside the running sweep would match this process's own launcher
  // chain (bash → npx → tsx → node index.ts all carry 'agent-regression/index')
  // and kill the tree (exit 255). Run `npm run agent-sweep:kill` BEFORE a big
  // unscoped sweep instead (safe standalone). The defenses that work from inside
  // the run are below: inter-case spacing, env-retry-with-backoff, env-tagging,
  // and the abort-on-cascade guard.
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const INTER_CASE_MS = 1200; // let the OS release per-spawn handles between claude -p children
  const CASCADE_ABORT = 3;    // consecutive OS spawn-refusals → stop (the machine needs a break)
  let consecutiveEnv = 0;

  for (const testCase of cases) {
    if (completed > 0) await sleep(INTER_CASE_MS);
    const result = await runCase({ case: testCase, model: args.model, verbose: args.verbose });
    completed += 1;
    const verdict = result.environmental
      ? '⊘ ENV (OS spawn refusal — not run)'
      : result.passed
        ? (result.flaked ? '⚠ PASS (retry)' : '✓ PASS')
        : '✗ FAIL';
    console.log(`[${completed}/${total}] ${verdict}  ${result.case.id}  [${result.case.device}]  ${result.tool_calls.length} tools / ${result.wall_seconds.toFixed(1)}s`);
    if (result.environmental) {
      // Don't print the env failure as a test failure; it's an OS condition.
    } else if (!result.passed) {
      for (const f of result.failures) console.log(`    ✗ ${f}`);
      console.log(`    sequence: ${formatToolSequence(result)}`);
    } else if (result.flaked) {
      console.log(`    (passed on attempt ${result.attempts} after a failed first run, investigate if recurring)`);
    }
    results.push(result);
    appendResultRow(codeState, result, {
      mockFixture: testCase.mockFixture,
      via: 'sweep',
      model: args.model ?? 'claude-sonnet-4-6',
    });

    // Abort-on-cascade: once the OS starts refusing spawns it does not recover
    // mid-run, so stop with an actionable message instead of marking the rest
    // ENV. The env-retry-with-backoff in runCase already tried to recover.
    consecutiveEnv = result.environmental ? consecutiveEnv + 1 : 0;
    if (consecutiveEnv >= CASCADE_ABORT) {
      console.error(
        `\n⚠ Aborting: ${consecutiveEnv} consecutive OS spawn refusals (Windows 0xC0000142) — the cascade does not ` +
        `recover mid-run. The remaining ${total - completed} case(s) were NOT run.\n` +
        `  Recover: \`npm run agent-sweep:kill\`, wait ~30s, then re-run (smaller --device scopes are immune).`,
      );
      break;
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  // Environmental non-runs are excluded from pass/fail accounting (they measure
  // the OS, not the case) and reported on their own line.
  const envCount = results.filter((r) => r.environmental).length;
  const scored = results.filter((r) => !r.environmental);
  const passed = scored.filter((r) => r.passed).length;
  const flaked = scored.filter((r) => r.passed && r.flaked).length;
  const failed = scored.length - passed;
  const notRun = total - results.length;
  console.log('━'.repeat(70));
  const skipNote = skipped.length > 0 ? `, ${skipped.length} skipped` : '';
  const envNote = envCount > 0 ? `, ${envCount} env (OS spawn refusal, not scored)` : '';
  const abortNote = notRun > 0 ? `, ${notRun} not run (cascade abort)` : '';
  console.log(`Summary: ${passed}/${scored.length} passed${flaked > 0 ? ` (${flaked} flaked, passed on retry)` : ''}${envNote}${abortNote}${skipNote}.\n`);
  if (skipped.length > 0) {
    console.log('Skipped:');
    for (const s of skipped) console.log(`  ⊘ ${s.case.id}: ${s.reason}`);
    console.log('');
  }
  console.log('| Case | Device | Result | Tools | Wall |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    const tag = r.environmental ? '⊘ env' : r.passed ? (r.flaked ? '⚠ flake' : '✓') : '✗';
    console.log(`| ${r.case.id} | ${r.case.device} | ${tag} | ${r.tool_calls.length} | ${r.wall_seconds.toFixed(1)}s |`);
  }

  // Inline trend across the corpus (automatic — no separate command needed).
  // Surfaces flake/wall history for the cases just run so recurring flakiness
  // is visible without remembering `agent-sweep:stats`. The corpus already
  // includes this run's rows (appended above).
  const corpus = loadRows();
  console.log('\nHistory (this case across all logged runs):');
  for (const r of results) {
    const line = caseHistoryLine(corpus, r.case.id);
    if (line !== '') console.log(`  ${r.case.id.padEnd(34)} ${line}`);
  }
  console.log('  (full corpus query: npm run agent-sweep:stats)');

  process.exit(failed > 0 ? 1 : 0);
}

await main();
