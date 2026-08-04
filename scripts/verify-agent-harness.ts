/**
 * Gate on the agent-regression HARNESS itself, not on the product.
 *
 * A test harness that cannot see a failure is worse than no harness: it
 * converts an outage into a green tick. Two such blind spots were measured on
 * 2026-08-02 against the archived trace corpus (707 traces, 96 cases), and
 * this file is the standing check that neither returns.
 *
 * 1. UNDELIVERED TOOL RESULTS. A tool result over a host size limit never
 *    reaches the model; the host substitutes an envelope pointing at a sidecar
 *    file that an MCP-only agent has no tool to open. 26 of 707 traces carry
 *    such a substitution and NINE of those runs were scored PASS. The harness
 *    watched the `list_params` outage 37 times over two weeks and reported
 *    green every time.
 *
 * 2. `must_call` SATISFIED BY A FAILED CALL. `is_error` was captured on every
 *    ToolCall and never read, so `must_call: ['set_param']` passed when every
 *    set_param returned an error. 13 traces carry a device-unreachable error;
 *    8 of those runs were scored PASS.
 *
 * The fixtures below are VERBATIM substrings from real traces, not invented
 * ones — a detector tested only against strings its author wrote is a detector
 * tested against its own assumptions. Provenance is cited per fixture.
 *
 * The archived corpus is gitignored, so this gate is self-contained. When a
 * `traces/` directory happens to exist locally it ALSO replays it and prints
 * what the new checks would have caught, as a non-gating sanity read.
 *
 *   npx tsx scripts/verify-agent-harness.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { applyAssertions, findUndeliveredResults } from './agent-regression/runner.js';
import type { AgentRegressionCase, Expectations, ToolCall } from './agent-regression/types.js';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) { passed++; console.log(`  OK    ${label}`); return; }
  failed++;
  console.error(`  FAIL  ${label}${detail !== undefined ? `\n          ${detail}` : ''}`);
}

function call(over: Partial<ToolCall> = {}): ToolCall {
  return {
    name: 'mcp__mcp-midi-control__list_params',
    short_name: 'list_params',
    arguments: {},
    result: '{"ok":true}',
    is_error: false,
    ...over,
  };
}

function caseWith(expectations: Expectations): AgentRegressionCase {
  return {
    id: 'synthetic',
    device: 'am4',
    description: 'harness self-test',
    prompt: 'n/a',
    expectations,
  };
}

// ── 1. Undelivered-result detection ──────────────────────────────
//
// Fixtures verbatim from the corpus:
//   (a) am4-archetype-build-lineage-readback-2026-08-02*.ndjson
//   (b) am4-deterministic-4scene-build-2026-08-0*.ndjson
console.log('\n1. Host substitutions are detected as undelivered results');

const PERSISTED_FIXTURE =
  '<persisted-output>\nOutput too large (50.1KB). Full output saved to: ' +
  'C:\\Users\\Steph\\.claude\\projects\\C--dev-mcp-midi-tools\\975c634a\\tool-results\\toolu_01Jp.txt';
const TOKEN_CAP_FIXTURE =
  'Error: result (67,731 characters) exceeds maximum allowed tokens. ' +
  'Output has been saved to C:\\Users\\Steph\\.claude\\projects\\C--dev-mcp-midi-tools\\3f2.txt';

check(
  'the 50,000-char host cap envelope is detected',
  findUndeliveredResults([call({ result: PERSISTED_FIXTURE })]).length === 1,
);
check(
  'the MAX_MCP_OUTPUT_TOKENS envelope is detected',
  findUndeliveredResults([call({ result: TOKEN_CAP_FIXTURE })]).length === 1,
);
check(
  'a normal payload is NOT flagged (the detector is not vacuous)',
  findUndeliveredResults([call({ result: '{"ok":true,"params":[{"name":"gain"}]}' })]).length === 0,
);
check(
  'the offending TOOL is named, so the fix lands on the tool not the case',
  findUndeliveredResults([call({ short_name: 'describe_device', result: PERSISTED_FIXTURE })])[0]?.tool
    === 'describe_device',
);

console.log('\n2. An undelivered result fails the case, whatever else passed');
const undeliveredFailures = applyAssertions(
  caseWith({ must_call: ['list_params'], max_tools: 5 }),
  [call({ result: PERSISTED_FIXTURE })],
  'The AM4 exposes 248 amp types.',
  0,
);
check(
  'a run whose only tool result was substituted is FAILED',
  undeliveredFailures.some((f) => /undelivered tool result/i.test(f)),
  JSON.stringify(undeliveredFailures),
);
check(
  'the failure says the agent never saw the payload',
  undeliveredFailures.some((f) => /without ever seeing it/i.test(f)),
  JSON.stringify(undeliveredFailures),
);
// This is the exact historical shape: correct tool, correct arguments, within
// the call budget, plausible-sounding answer — and 9 runs scored PASS on it.
check(
  'PRE-FIX SHAPE: must_call + max_tools alone would have scored this green',
  applyAssertions(
    caseWith({ must_call: ['list_params'], max_tools: 5 }),
    [call({ result: '{"ok":true}' })],
    'The AM4 exposes 248 amp types.',
    0,
  ).length === 0,
);

// ── 3. must_call requires a call that SUCCEEDED ──────────────────
console.log('\n3. must_call is not satisfied by a call that failed');

const allErrored = applyAssertions(
  caseWith({ must_call: ['set_param'] }),
  [call({ short_name: 'set_param', is_error: true, result: 'Error: device not responding' })],
  'Set the gain to 7.',
  0,
);
check(
  'a must_call tool that only ever errored FAILS the case',
  allErrored.some((f) => /must_call/.test(f)),
  JSON.stringify(allErrored),
);
check(
  'the failure distinguishes "only ever failed" from "never called"',
  allErrored.some((f) => /EVERY call returned is_error/.test(f)),
  JSON.stringify(allErrored),
);
check(
  'must_call: a NEVER-called tool still reads as never called',
  applyAssertions(caseWith({ must_call: ['set_param'] }), [call()], 'x', 0)
    .some((f) => /never called/.test(f)),
);

// The recovery case: error, then retry successfully. This MUST pass — several
// cases exist precisely to test that the agent reads a refusal and recovers,
// and failing them for the provoked error is the mistake `max_tools` made when
// it punished an agent for reading back its own write.
const recovered = applyAssertions(
  caseWith({ must_call: ['set_param'], max_tools: 5 }),
  [
    call({ short_name: 'set_param', is_error: true, result: 'unknown param "gainn". Did you mean: gain?' }),
    call({ short_name: 'set_param', is_error: false, result: '{"ok":true}' }),
  ],
  'Gain is now 7.',
  0,
);
check(
  'error-then-recover still PASSES (self-correction is not punished)',
  recovered.length === 0,
  JSON.stringify(recovered),
);

// must_not_call keeps counting every call: a forbidden tool is a violation
// however it ended.
check(
  'must_not_call still fires on a call that errored',
  applyAssertions(
    caseWith({ must_not_call: ['save_preset'] }),
    [call({ short_name: 'save_preset', is_error: true, result: 'refused' })],
    'x',
    0,
  ).some((f) => /must_not_call/.test(f)),
);

// must_call_any: the same success requirement across OR-groups.
check(
  'must_call_any is not satisfied by a failed call',
  applyAssertions(
    caseWith({ must_call_any: [['apply_preset'], ['set_block', 'set_params']] }),
    [call({ short_name: 'apply_preset', is_error: true, result: 'Error: no ack' })],
    'x',
    0,
  ).some((f) => /must_call_any/.test(f)),
);
check(
  'must_call_any IS satisfied by a successful call in one group',
  applyAssertions(
    caseWith({ must_call_any: [['apply_preset'], ['set_block', 'set_params']] }),
    [call({ short_name: 'apply_preset', is_error: false })],
    'x',
    0,
  ).length === 0,
);

// ── 4. Device-unreachable fires on the MOCK sweep too ────────────
//
// This scan used to run only under AGENT_REGRESSION_REAL_HARDWARE, which is
// backwards: on the mock sweep an unreachable device means the case has NO
// transport behind it and is asserting only that the agent typed the right
// argument names. Four device packages have no mock transport at all.
console.log('\n4. Device-unreachable is caught without --real-hardware');
delete process.env.AGENT_REGRESSION_REAL_HARDWARE;
check(
  'a device-not-found result fails the case on the mock sweep',
  applyAssertions(
    caseWith({}),
    [call({
      short_name: 'get_param',
      is_error: true,
      result: 'No MIDI port matching "axe-fx-gen1" found. MIDI ports the server can see (none matched)',
    })],
    'x',
    0,
  ).some((f) => /device unreachable/i.test(f)),
);

// ── 5. Non-gating corpus replay ──────────────────────────────────
const TRACES = path.resolve('scripts', 'agent-regression', 'traces');
if (existsSync(TRACES)) {
  const files = readdirSync(TRACES).filter((f) => f.endsWith('.ndjson'));
  let withSubstitution = 0;
  for (const f of files) {
    let raw: string;
    try { raw = readFileSync(path.join(TRACES, f), 'utf8'); } catch { continue; }
    if (findUndeliveredResults([call({ result: raw })]).length > 0) withSubstitution++;
  }
  console.log(
    `\n5. Corpus replay (local only, not a gate): ${withSubstitution} of ${files.length} ` +
    `archived traces carry a host substitution.`,
  );
} else {
  console.log('\n5. Corpus replay skipped (no local traces/ directory).');
}

console.log('');
if (failed > 0) {
  console.error(`✗ ${failed} harness check(s) FAILED (${passed} passed).`);
  process.exit(1);
}
console.log(`✓ agent-regression harness verified (${passed} checks).`);
