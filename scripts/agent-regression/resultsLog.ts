/**
 * Shared results-log for agent-regression runs.
 *
 * Both the full sweep (`index.ts`) and single-case dev runs (`runner.ts`) append
 * here, so the corpus reflects iteration, not just gate runs. Append-only
 * JSON-lines; gitignored (local-only analytics, read by `stats.ts`).
 *
 * Code-state honesty: a row records HEAD `sha` AND a `dirty` flag AND, when the
 * tree is dirty, a `tree_sha` (a real git tree-object hash of the tracked
 * working-tree state via `git stash create`). The plain HEAD sha is misleading
 * on its own because sweeps almost always run against uncommitted changes — a
 * row tagged with HEAD would attribute new behavior to the prior commit.
 * `dirty` + `tree_sha` make "which code produced this result" answerable.
 */
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { CaseResult } from './types.js';

export const RESULTS_LOG = path.resolve('scripts', 'agent-regression', 'results.jsonl');

/** Identifies the code that produced a result, dirty-tree-aware. */
export interface CodeState {
  /** HEAD commit (12-char). The committed baseline. */
  sha: string;
  /** True when the working tree (tracked OR untracked) differs from HEAD. */
  dirty: boolean;
  /**
   * Tree-object hash of the tracked working-tree state (`git stash create`),
   * present only when dirty and there are tracked changes. A stable id for the
   * exact tracked code under test even though it was never committed. Untracked-
   * only dirtiness sets `dirty:true` with no `tree_sha` (stash create captures
   * tracked changes only).
   */
  tree_sha?: string;
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Capture HEAD + working-tree dirtiness once at process start. Best-effort:
 * outside a git checkout it degrades to `{sha:'unknown', dirty:false}` rather
 * than throwing (the sweep must still run in a tarball/CI export).
 */
export function captureCodeState(): CodeState {
  try {
    const sha = git('rev-parse HEAD').slice(0, 12);
    const dirty = git('status --porcelain') !== '';
    let tree_sha: string | undefined;
    if (dirty) {
      // `git stash create` builds a commit object of the tracked working-tree +
      // index WITHOUT touching the tree, index, or stash list, and prints its
      // hash (empty when there are no tracked changes). Read-only in effect.
      const created = git('stash create').slice(0, 12);
      if (created !== '') tree_sha = created;
    }
    return { sha, dirty, tree_sha };
  } catch {
    return { sha: 'unknown', dirty: false };
  }
}

/** One persisted row. `via` distinguishes full-sweep from single-case runs. */
export function appendResultRow(
  codeState: CodeState,
  result: CaseResult,
  opts: { mockFixture?: string; via: 'sweep' | 'single'; model?: string },
): void {
  const row = {
    timestamp: new Date().toISOString(),
    sha: codeState.sha,
    dirty: codeState.dirty,
    tree_sha: codeState.tree_sha,
    via: opts.via,
    model: opts.model,
    case_id: result.case.id,
    device: result.case.device,
    passed: result.passed,
    flaked: result.flaked,
    attempts: result.attempts,
    tool_count: result.tool_calls.length,
    wall_seconds: Number(result.wall_seconds.toFixed(3)),
    mock_fixture: opts.mockFixture,
    // Tool results the host never delivered to the model. Recorded so the
    // corpus answers "was this run reading real payloads?" without re-grepping
    // traces. Omitted when zero so existing rows and clean rows read the same.
    undelivered_results: result.undelivered_results,
    // Environmental (OS spawn-refusal) non-runs are tagged so pass-rate math can
    // exclude them — they measure the machine, not the case.
    environmental: result.environmental === true ? true : undefined,
    failures: result.passed ? undefined : result.failures,
  };
  try {
    mkdirSync(path.dirname(RESULTS_LOG), { recursive: true });
    appendFileSync(RESULTS_LOG, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    // Best-effort; never fail a run on a log-write error (disk full, read-only
    // fs). Surface to stderr so it's visible.
    console.error(`    [results.jsonl append failed] ${(err as Error).message}`);
  }
}

// ── Read side: shared so the sweep + single runner can surface history inline
//    (automatic, no separate command) and stats.ts can query ad-hoc. ─────────

/** One persisted result row, as read back from the corpus. */
export interface LoggedRow {
  timestamp: string;
  sha: string;
  dirty?: boolean;
  tree_sha?: string;
  via?: 'sweep' | 'single';
  model?: string;
  case_id: string;
  device: string;
  passed: boolean;
  flaked: boolean;
  attempts: number;
  tool_count: number;
  wall_seconds: number;
  mock_fixture?: string;
  /** OS spawn-refusal non-run (excluded from pass/fail accounting). */
  environmental?: boolean;
  /** Tool results the host refused to deliver to the model. Absent = zero. */
  undelivered_results?: number;
  failures?: string[];
}

/** Read the whole corpus (newest last). Returns [] when none exists yet. */
export function loadRows(): LoggedRow[] {
  let raw: string;
  try {
    raw = readFileSync(RESULTS_LOG, 'utf8');
  } catch {
    return [];
  }
  const rows: LoggedRow[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try { rows.push(JSON.parse(t) as LoggedRow); } catch { /* skip malformed */ }
  }
  return rows;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

/**
 * One-line history for a case across the whole corpus (current run included,
 * since it's appended first). Printed inline after a run so behavior/trend is
 * visible without a separate command. Empty string when the case has no history.
 */
/**
 * THE single environmental-signature predicate, shared by the runtime path
 * (runner.ts — drives env-retry/backoff/abort + the environmental flag) and the
 * historical path (isEnvironmentalRow / caseHistoryLine / stats.ts). One detector
 * so live and historical verdicts always agree (no detector split).
 *
 * Environmental = an OS spawn-refusal NON-run that measures the machine, not the
 * case: the explicit flag (new rows) OR the legacy signature (not passed, zero
 * tool calls, near-instant, and a spawn-failure exit code / DLL-init / spawn errno
 * in failures[]). The Windows 0xC0000142 (STATUS_DLL_INIT_FAILED) cascade.
 */
export function isEnvironmentalSignature(x: {
  passed: boolean;
  environmental?: boolean;
  tool_count: number;
  wall_seconds: number;
  failures?: readonly string[];
}): boolean {
  if (x.environmental === true) return true;
  return !x.passed && x.tool_count === 0 && x.wall_seconds <= 2 &&
    (x.failures ?? []).some((f) => f.includes('3221225794') || /DLL[- ]init|\bEPERM\b|\bENOENT\b|\bEAGAIN\b/i.test(f));
}

/** Historical-row form of {@link isEnvironmentalSignature}. */
export function isEnvironmentalRow(r: LoggedRow): boolean {
  return isEnvironmentalSignature(r);
}

/**
 * Below this many scored runs the line prints a FRACTION, not a percentage.
 * `1/1 = 100%` is noise wearing the authority of a statistic. Mirrored as
 * `MIN_RUNS_FOR_PCT` in stats.ts so the inline footer and the table cannot
 * disagree about when a number is quotable.
 */
const MIN_RUNS_FOR_PCT = 3;

function rate(n: number, d: number): string {
  return d < MIN_RUNS_FOR_PCT ? `${n}/${d}` : `${Math.round((n / d) * 100)}%`;
}

/**
 * @param model When given, the rate is computed over THIS model's rows only,
 *   and rows from other models are reported as a separate excluded count. A
 *   model bump resets the baseline: every rate measured before 2026-08-01 was
 *   against Sonnet 4-6, and blending it into a Sonnet 5 run's footer produces a
 *   number describing no configuration that ever existed. Omit to blend, which
 *   the line then says out loud.
 */
export function caseHistoryLine(
  rows: readonly LoggedRow[],
  caseId: string,
  model?: string,
): string {
  const all = rows.filter((r) => r.case_id === caseId);
  if (all.length === 0) return '';
  const envCount = all.filter(isEnvironmentalRow).length;
  const scored = all.filter((r) => !isEnvironmentalRow(r));
  if (scored.length === 0) return `history: ${all.length} run(s), all environmental (OS spawn refusal) — no scored runs`;

  const hist = model !== undefined ? scored.filter((r) => r.model === model) : scored;
  const otherModels = scored.length - hist.length;
  if (hist.length === 0) {
    return `history: ${scored.length} scored run(s) but NONE on ${model} — no comparable baseline (a model bump resets it)`;
  }
  const passes = hist.filter((r) => r.passed).length;
  const flakes = hist.filter((r) => r.passed && r.flaked).length;
  const walls = hist.map((r) => r.wall_seconds).sort((a, b) => a - b);
  const p50 = percentile(walls, 50).toFixed(0);
  const recent = hist.slice(-8).map((r) => (r.passed ? (r.flaked ? '⚠' : '✓') : '✗')).join('');
  const flakeNote = flakes > 0 ? `, ${rate(flakes, hist.length)} flake` : '';
  const envNote = envCount > 0 ? `, ${envCount} env-excluded` : '';
  const modelNote = model !== undefined
    ? (otherModels > 0 ? `, ${otherModels} on other model(s) excluded` : '')
    : (new Set(scored.map((r) => r.model)).size > 1 ? ', BLENDED across models' : '');
  const undelivered = hist.reduce((a, r) => a + (r.undelivered_results ?? 0), 0);
  const undeliveredNote = undelivered > 0 ? `, ⚠ ${undelivered} undelivered result(s)` : '';
  return `history: ${hist.length} run(s), ${rate(passes, hist.length)} pass${flakeNote}${envNote}${modelNote}${undeliveredNote}, p50 ${p50}s — recent ${recent}`;
}
