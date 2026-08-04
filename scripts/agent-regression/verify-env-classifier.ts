/**
 * Golden: the environmental (OS spawn-refusal / Windows 0xC0000142) classifier.
 *
 * This is the linchpin of the agent-sweep cascade handling — ONE predicate
 * (`isEnvironmentalSignature`) drives env-tagging, the env-retry/abort, and the
 * pass-rate exclusion, used by BOTH the runtime path (runner.ts) and the
 * historical path (resultsLog/stats). The review flagged it as previously
 * unexercised ("0/401"), so this deterministic golden proves it without needing a
 * real OS cascade (which can't be synthesized faithfully — Node truncates child
 * exit codes to 8 bits, so a fake can't reproduce exit 3221225794).
 *
 * The single most important property: a GENUINE 0-tool refusal (agent declined,
 * exit 0) must NOT be misclassified as environmental — otherwise a real failure
 * would be silently excluded from pass-rate (the masking risk).
 *
 * Run:  npx tsx scripts/agent-regression/verify-env-classifier.ts
 */

import { isEnvironmentalSignature, isEnvironmentalRow, caseHistoryLine, type LoggedRow } from './resultsLog.js';

let failures = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) console.log(`  OK   ${name}`);
  else { console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); failures++; };
};

const CASCADE = 'claude -p exited with code 3221225794';

console.log('isEnvironmentalSignature — POSITIVE (real spawn-refusal cascade):');
check('exit 3221225794 + 0 tools + ~0s → environmental',
  isEnvironmentalSignature({ passed: false, tool_count: 0, wall_seconds: 0.01, failures: [CASCADE, 'min_tools: only 0 call(s)'] }));
check('explicit environmental flag → environmental (regardless of other fields)',
  isEnvironmentalSignature({ passed: false, environmental: true, tool_count: 5, wall_seconds: 99, failures: [] }));
check('DLL-init error text → environmental',
  isEnvironmentalSignature({ passed: false, tool_count: 0, wall_seconds: 0.2, failures: ['spawn failed: DLL init failed'] }));
check('spawn EPERM → environmental',
  isEnvironmentalSignature({ passed: false, tool_count: 0, wall_seconds: 0.0, failures: ['spawn claude EPERM'] }));

console.log('\nisEnvironmentalSignature — NEGATIVE (must NOT be swallowed):');
// THE masking-risk guard: a genuine 0-tool refusal (agent declined) is exit 0,
// no spawn code — it must score as a REAL fail, never environmental.
check('genuine 0-tool refusal (no spawn code) → NOT environmental',
  !isEnvironmentalSignature({ passed: false, tool_count: 0, wall_seconds: 12, failures: ['min_tools: only 0 call(s), expected at least 1 (did the agent refuse?)'] }),
  'a real refusal must count as a fail, not be excluded as env');
check('real assertion fail WITH tool calls → NOT environmental',
  !isEnvironmentalSignature({ passed: false, tool_count: 5, wall_seconds: 40, failures: ['tool_call_validator(apply_preset): picked Hall variant'] }));
check('a normal pass → NOT environmental',
  !isEnvironmentalSignature({ passed: true, tool_count: 3, wall_seconds: 30, failures: [] }));
check('0 tools but slow (>2s) without spawn code → NOT environmental (a genuine hang/refusal, not a spawn refusal)',
  !isEnvironmentalSignature({ passed: false, tool_count: 0, wall_seconds: 8, failures: ['some other error'] }));

console.log('\nisEnvironmentalRow agrees on logged rows (legacy signature, pre-flag rows):');
const cascadeRow: LoggedRow = { timestamp: 't', sha: 's', case_id: 'c', device: 'am4', passed: false, flaked: false, attempts: 2, tool_count: 0, wall_seconds: 0.01, failures: [CASCADE] };
const realFailRow: LoggedRow = { timestamp: 't', sha: 's', case_id: 'c', device: 'am4', passed: false, flaked: false, attempts: 2, tool_count: 4, wall_seconds: 50, failures: ['must_call: agent never called describe_device'] };
check('legacy cascade row → environmental', isEnvironmentalRow(cascadeRow));
check('real-fail row → NOT environmental', !isEnvironmentalRow(realFailRow));

console.log('\ncaseHistoryLine EXCLUDES env rows from pass-rate:');
{
  const rows: LoggedRow[] = [
    { ...cascadeRow, case_id: 'demo' },                                   // env (excluded)
    { ...cascadeRow, case_id: 'demo' },                                   // env (excluded)
    { timestamp: 't', sha: 's', case_id: 'demo', device: 'am4', passed: true, flaked: false, attempts: 1, tool_count: 3, wall_seconds: 30 }, // scored PASS
    { timestamp: 't', sha: 's', case_id: 'demo', device: 'am4', passed: true, flaked: false, attempts: 1, tool_count: 3, wall_seconds: 30 }, // scored PASS
  ];
  const line = caseHistoryLine(rows, 'demo');
  // 2 scored runs, both pass, 2 env-excluded. Rendered as the FRACTION "2/2"
  // rather than "100%": below n=3 a percentage is one run wearing the
  // authority of a rate (see MIN_RUNS_FOR_PCT in resultsLog.ts). The property
  // under test is unchanged — the env rows are not in the denominator.
  check('pass rate covers the 2 scored runs (2 env excluded), not 4',
    /2\/2 pass/.test(line) && /2 run\(s\)/.test(line) && /2 env-excluded/.test(line), line);
}

console.log('\ncaseHistoryLine does not blend across a model bump:');
{
  const base = { timestamp: 't', sha: 's', case_id: 'demo', device: 'am4', flaked: false, attempts: 1, tool_count: 3, wall_seconds: 30 };
  const rows: LoggedRow[] = [
    { ...base, passed: false, model: 'claude-sonnet-4-6' },
    { ...base, passed: false, model: 'claude-sonnet-4-6' },
    { ...base, passed: false, model: 'claude-sonnet-4-6' },
    { ...base, passed: true, model: 'claude-sonnet-5' },
    { ...base, passed: true, model: 'claude-sonnet-5' },
    { ...base, passed: true, model: 'claude-sonnet-5' },
  ];
  const scoped = caseHistoryLine(rows, 'demo', 'claude-sonnet-5');
  check('scoped to the running model, the older model\'s rows are excluded',
    /100% pass/.test(scoped) && /3 run\(s\)/.test(scoped) && /3 on other model\(s\) excluded/.test(scoped), scoped);
  const blended = caseHistoryLine(rows, 'demo');
  check('unscoped, the line SAYS it is blended rather than hiding it',
    /50% pass/.test(blended) && /BLENDED across models/.test(blended), blended);
  const noBaseline = caseHistoryLine(rows, 'demo', 'claude-opus-5');
  check('a model with no history says so instead of borrowing another model\'s rate',
    /NONE on claude-opus-5/.test(noBaseline), noBaseline);
}

console.log('\nabort-on-cascade counting (3 consecutive env → abort):');
{
  // Mirror index.ts's consecutiveEnv logic to prove the threshold trips at 3.
  const ABORT = 3;
  const simulate = (seq: boolean[]): boolean => {
    let consecutive = 0;
    for (const env of seq) {
      consecutive = env ? consecutive + 1 : 0;
      if (consecutive >= ABORT) return true;
    }
    return false;
  };
  check('3 consecutive env → abort', simulate([false, true, true, true]) === true);
  check('2 env then a pass → no abort (counter resets)', simulate([true, true, false, true, true]) === false);
  check('scattered env (never 3 in a row) → no abort', simulate([true, false, true, false, true]) === false);
}

console.log(failures === 0 ? '\nAll env-classifier goldens passed.' : `\n${failures} env-classifier golden(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
