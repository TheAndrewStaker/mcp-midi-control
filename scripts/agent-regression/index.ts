/**
 * Agent-regression sweep — CLI entry.
 *
 * Drives `claude -p` against each enabled case, aggregates results,
 * prints a per-case pass/fail report + a summary table.
 *
 * Usage:
 *   npx tsx scripts/agent-regression/index.ts                       # all cases
 *   npx tsx scripts/agent-regression/index.ts --device=am4          # one device
 *   npx tsx scripts/agent-regression/index.ts --tier=no-hardware    # CI-safe subset
 *   npx tsx scripts/agent-regression/index.ts --case=am4-h1-...     # single case
 *   npx tsx scripts/agent-regression/index.ts --model=opus          # override model
 *   npx tsx scripts/agent-regression/index.ts --verbose             # echo events
 *
 * Hardware-tier cases run when the corresponding device is connected.
 * No-hardware cases always run. Skipping is reported in the summary,
 * not treated as a pass.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { runCase } from './runner.js';
import { ALL_CASES } from './cases-all.js';
import type { AgentRegressionCase, CaseResult, Device, Tier } from './types.js';

/**
 * Pre-flight: ask the shipped MCP server which devices are visible
 * over MIDI right now. Used to skip hardware-tier cases cleanly when
 * the corresponding device isn't connected — release-gate works
 * whether the founder is at the bench or not.
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
  tier?: Tier;
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
    else if (raw.startsWith('--tier=')) out.tier = raw.slice('--tier='.length) as Tier;
    else if (raw.startsWith('--case=')) out.caseId = raw.slice('--case='.length);
    else if (raw.startsWith('--model=')) out.model = raw.slice('--model='.length);
  }
  return out;
}

function formatToolSequence(result: CaseResult): string {
  if (result.tool_calls.length === 0) return '(no tool calls)';
  return result.tool_calls.map((c) => c.short_name).join(' → ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

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
    if (args.tier !== undefined && c.tier !== args.tier) return false;
    if (args.caseId !== undefined && c.id !== args.caseId) return false;
    if (c.disabled === true && args.caseId === undefined) return false;
    return true;
  });

  if (cases.length === 0) {
    console.error('No cases match the filter. Known cases:');
    for (const c of ALL_CASES) console.error(`  ${c.id} [${c.device}, ${c.tier}]`);
    process.exit(1);
  }

  // Detect connected hardware once; skip hardware-tier cases whose
  // device isn't visible. Keeps release-gate green when run away from
  // the bench (the founder can still test no-hardware coverage).
  const { devices: availableDevices, probeError } = await detectAvailableDevices();
  if (probeError !== undefined) {
    console.error(`\n⚠ Hardware-port probe failed: ${probeError}`);
    console.error('  All hardware-tier cases will be skipped with this reason.');
    console.error('  Diagnose: run `npm run launch-verify` to confirm the MCP server itself starts and can see ports.\n');
  }
  const runnable: AgentRegressionCase[] = [];
  const skipped: { case: AgentRegressionCase; reason: string }[] = [];
  for (const c of cases) {
    if (c.tier === 'hardware' && !availableDevices.has(c.device)) {
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
      skipped.push({ case: c, reason: `mockFixture requires mock transport — skip in --real-hardware` });
      continue;
    }
    runnable.push(c);
  }
  cases = runnable;

  const transportMode = args.realHardware ? 'real hardware (USB MIDI)' : 'mock transport (no USB)';
  const disabledCount = ALL_CASES.filter((c) => c.disabled === true).length;
  console.log(`Running ${cases.length} case(s)${args.model !== undefined ? ` with model ${args.model}` : ''}${skipped.length > 0 ? `; skipping ${skipped.length} hardware case(s)` : ''}${disabledCount > 0 ? ` (${disabledCount} disabled — run via --case=<id>)` : ''}.`);
  console.log(`Surface: MCP-only via \`--tools ""\` (Desktop-fidelity — no Bash/Grep/Skill/Task).`);
  console.log(`Transport: ${transportMode}.\n`);

  // Serial execution. Parallelism caused MCP-server cold-start races —
  // spawning 4 `claude -p` children simultaneously each requires its own
  // MCP server child, and some failed to register tools before the agent
  // started thinking (system init showed `tools:[], mcp_servers:[pending]`).
  // The agent then hallucinated tool names and burned LLM tokens. Validated
  // 2026-05-21: 4-way parallel turned 1 known-broken case into 5 broken
  // cases. The right wall-time lever is fewer high-value cases, not
  // parallelism.
  const total = cases.length;
  let completed = 0;
  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const result = await runCase({ case: testCase, model: args.model, verbose: args.verbose });
    completed += 1;
    const verdict = result.passed
      ? (result.flaked ? '⚠ PASS (retry)' : '✓ PASS')
      : '✗ FAIL';
    console.log(`[${completed}/${total}] ${verdict}  ${result.case.id}  [${result.case.device}, ${result.case.tier}]  ${result.tool_calls.length} tools / ${result.wall_seconds.toFixed(1)}s`);
    if (!result.passed) {
      for (const f of result.failures) console.log(`    ✗ ${f}`);
      console.log(`    sequence: ${formatToolSequence(result)}`);
    } else if (result.flaked) {
      console.log(`    (passed on attempt ${result.attempts} after a failed first run — investigate if recurring)`);
    }
    results.push(result);
  }

  // ── Summary ────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const flaked = results.filter((r) => r.passed && r.flaked).length;
  const failed = results.length - passed;
  console.log('━'.repeat(70));
  const skipNote = skipped.length > 0 ? `, ${skipped.length} skipped` : '';
  console.log(`Summary: ${passed}/${results.length} passed${flaked > 0 ? ` (${flaked} flaked — passed on retry)` : ''}${skipNote}.\n`);
  if (skipped.length > 0) {
    console.log('Skipped:');
    for (const s of skipped) console.log(`  ⊘ ${s.case.id} — ${s.reason}`);
    console.log('');
  }
  console.log('| Case | Device | Result | Tools | Wall |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    const tag = r.passed ? (r.flaked ? '⚠ flake' : '✓') : '✗';
    console.log(`| ${r.case.id} | ${r.case.device} | ${tag} | ${r.tool_calls.length} | ${r.wall_seconds.toFixed(1)}s |`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

await main();
