/**
 * Agent-sweep analytics reader (P3). Reads the gitignored results.jsonl corpus
 * and prints per-case behavior so flakiness, slow cases, and drift across
 * commits are visible at a glance.
 *
 *   npx tsx scripts/agent-regression/stats.ts                    # per-case table
 *   npx tsx scripts/agent-regression/stats.ts --case=ID          # one case's history
 *   npx tsx scripts/agent-regression/stats.ts --recent=N         # last N runs, newest first
 *   npx tsx scripts/agent-regression/stats.ts --model=sonnet-5   # one model only
 *   npx tsx scripts/agent-regression/stats.ts --since=2026-08-01 # from a date
 *   npx tsx scripts/agent-regression/stats.ts --device=am4       # one device
 *   npx tsx scripts/agent-regression/stats.ts --by-model         # split every rate by model
 *
 * The corpus is append-only and dirty-tree-aware: each row carries HEAD `sha`,
 * a `dirty` flag, and (when dirty) a `tree_sha`, so a result is attributable to
 * the actual code under test, not just the last commit. Rows with `dirty:true`
 * are flagged so you don't read a clean-commit trend into dirty-tree runs.
 *
 * ── TWO RULES THIS FILE ENFORCES, both learned the hard way ──────────────
 *
 * 1. A PASS RATE IS MEANINGLESS WITHOUT ITS MODEL. The corpus spans several
 *    models (124 rows predate the `model` column entirely, then sonnet-4-6,
 *    sonnet-5, opus-4-8), and a model bump RESETS the baseline. Blending them
 *    produces a number that describes no configuration that ever existed. The
 *    header always states the model mix; `--by-model` splits every rate.
 *
 * 2. NO PERCENTAGE BELOW n=3. `1/1 = 100%` and `0/1 = 0%` are noise printed
 *    with the authority of a statistic, and a run-count column nobody reads is
 *    not a defence. Below the floor this prints the raw fraction instead, so
 *    the reader cannot mistake one run for a rate.
 *
 * And a caveat about ERA COMPARISONS generally: a "before vs after" split is
 * only as good as its stated boundary. A 2026-08-02 plan quoted a case going
 * 5/5 -> 0/5 -> 7/7 without saying where it drew the eras; redrawn at the two
 * real commits, the same 17 rows read 8/13 -> 3/3 -> 1/1. State the boundary
 * (`--since`, a sha) or do not quote the split.
 */
import path from 'node:path';

import { RESULTS_LOG, loadRows, isEnvironmentalRow, type LoggedRow } from './resultsLog.js';

type Row = LoggedRow;

/**
 * Below this many scored runs, print the fraction rather than a percentage.
 * Shared with `caseHistoryLine` (resultsLog.ts) so the inline sweep footer and
 * this table cannot disagree about when a number is quotable.
 */
export const MIN_RUNS_FOR_PCT = 3;

function pct(n: number, d: number): string {
  if (d === 0) return '  -  ';
  if (d < MIN_RUNS_FOR_PCT) return `${n}/${d}  `.padStart(5);
  return `${Math.round((n / d) * 100).toString().padStart(3)}%`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Short display form for a model id: `claude-sonnet-4-6` -> `sonnet-4-6`. */
function shortModel(model: string | undefined): string {
  if (model === undefined || model === '') return 'pre-column';
  return model.replace(/^claude-/, '');
}

interface Args {
  caseId?: string;
  recent?: number;
  model?: string;
  since?: string;
  device?: string;
  byModel: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { byModel: false };
  for (const a of argv) {
    if (a.startsWith('--case=')) out.caseId = a.slice('--case='.length);
    else if (a.startsWith('--recent=')) out.recent = Number(a.slice('--recent='.length));
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
    else if (a.startsWith('--device=')) out.device = a.slice('--device='.length);
    else if (a === '--by-model') out.byModel = true;
  }
  return out;
}

/**
 * Apply the segmentation filters. `--model` matches on the SHORT form too, so
 * `--model=sonnet-5` finds `claude-sonnet-5`; `--model=none` selects the rows
 * written before the column existed.
 */
function applyFilters(rows: readonly Row[], args: Args): Row[] {
  let out = [...rows];
  if (args.model !== undefined) {
    const want = args.model.toLowerCase();
    out = want === 'none'
      ? out.filter((r) => r.model === undefined || r.model === '')
      : out.filter((r) => (r.model ?? '').toLowerCase().includes(want));
  }
  if (args.since !== undefined) out = out.filter((r) => r.timestamp.slice(0, 10) >= args.since!);
  if (args.device !== undefined) {
    const want = args.device.toLowerCase();
    out = out.filter((r) => r.device.toLowerCase() === want);
  }
  return out;
}

/** One-line statement of what is being counted, printed before any number. */
function describeScope(all: readonly Row[], shown: readonly Row[], args: Args): string {
  const filters: string[] = [];
  if (args.model !== undefined) filters.push(`model~"${args.model}"`);
  if (args.since !== undefined) filters.push(`since ${args.since}`);
  if (args.device !== undefined) filters.push(`device=${args.device}`);
  const scope = filters.length > 0
    ? `${shown.length} of ${all.length} rows (${filters.join(', ')})`
    : `all ${all.length} rows`;
  const models = new Map<string, number>();
  for (const r of shown) {
    const k = shortModel(r.model);
    models.set(k, (models.get(k) ?? 0) + 1);
  }
  const mix = [...models].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  return `Scope: ${scope}. Models: ${mix || 'none'}.`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const allRows = loadRows();
  if (allRows.length === 0) {
    console.error(`No results corpus at ${path.relative(process.cwd(), RESULTS_LOG)}. Run a sweep or a single case first.`);
    process.exit(1);
  }
  const rows = applyFilters(allRows, args);
  if (rows.length === 0) {
    console.error(`No rows match the filters. ${describeScope(allRows, rows, args)}`);
    process.exit(1);
  }

  if (args.recent !== undefined) {
    const recent = rows.slice(-args.recent).reverse();
    console.log(`${describeScope(allRows, rows, args)}`);
    console.log(`Last ${recent.length} run(s), newest first:\n`);
    for (const r of recent) {
      const v = r.passed ? (r.flaked ? '⚠' : '✓') : '✗';
      const dirty = r.dirty ? ` +dirty${r.tree_sha ? `:${r.tree_sha}` : ''}` : '';
      const undelivered = (r.undelivered_results ?? 0) > 0 ? `  ⊗${r.undelivered_results}` : '';
      console.log(
        `${v} ${r.timestamp.slice(0, 16).replace('T', ' ')}  ${r.sha}${dirty}  ` +
        `${r.case_id.padEnd(34)} ${r.wall_seconds.toFixed(0).padStart(4)}s  ${String(r.tool_count).padStart(2)}t  ` +
        `${shortModel(r.model).padEnd(11)} ${r.via ?? '?'}${undelivered}`,
      );
    }
    console.log('\n⊗N = N tool result(s) the host never delivered to the model.');
    return;
  }

  if (args.caseId !== undefined) {
    const hist = rows.filter((r) => r.case_id === args.caseId);
    if (hist.length === 0) { console.error(`No rows for case "${args.caseId}" within the filters.`); process.exit(1); }
    console.log(`${describeScope(allRows, rows, args)}`);
    console.log(`\nHistory for ${args.caseId} (${hist.length} runs):\n`);
    for (const r of [...hist].reverse()) {
      const v = r.passed ? (r.flaked ? '⚠ flake' : '✓ pass') : '✗ fail';
      const dirty = r.dirty ? ` +dirty${r.tree_sha ? `:${r.tree_sha}` : ''}` : '';
      console.log(
        `  ${r.timestamp.slice(0, 16).replace('T', ' ')}  ${r.sha}${dirty}  ${v}  ` +
        `${r.wall_seconds.toFixed(0)}s  ${r.tool_count}t  ${shortModel(r.model)}  ${r.via ?? '?'}`,
      );
      if (!r.passed && r.failures) for (const f of r.failures) console.log(`        ✗ ${f}`);
    }
    // Per-model split for this case: the whole point of the column.
    const byModel = new Map<string, Row[]>();
    for (const r of hist.filter((x) => !isEnvironmentalRow(x))) {
      const k = shortModel(r.model);
      byModel.set(k, [...(byModel.get(k) ?? []), r]);
    }
    if (byModel.size > 1) {
      console.log('\n  Per model (a model bump resets the baseline — do not compare across these):');
      for (const [m, list] of byModel) {
        const p = list.filter((r) => r.passed).length;
        console.log(`    ${m.padEnd(12)} ${pct(p, list.length)}  (${p}/${list.length})`);
      }
    }
    return;
  }

  // Per-case aggregate table.
  const byCase = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byCase.get(r.case_id) ?? [];
    list.push(r);
    byCase.set(r.case_id, list);
  }
  const dirtyRuns = rows.filter((r) => r.dirty).length;
  const shas = new Set(rows.map((r) => r.sha));
  console.log(describeScope(allRows, rows, args));
  console.log(
    `Agent-sweep corpus: ${rows.length} runs across ${byCase.size} case(s), ${shas.size} commit(s), ` +
    `${rows[0]?.timestamp.slice(0, 10)}..${rows[rows.length - 1]?.timestamp.slice(0, 10)}. ` +
    `${dirtyRuns} run(s) against a dirty tree.\n`,
  );
  const totalEnv = rows.filter(isEnvironmentalRow).length;
  const totalUndelivered = rows.reduce((a, r) => a + (r.undelivered_results ?? 0), 0);

  const modelCols = args.byModel
    ? [...new Set(rows.map((r) => shortModel(r.model)))].sort()
    : [];
  const header = args.byModel
    ? `case                                 runs   pass  flake    env   ${modelCols.map((m) => m.padStart(11)).join(' ')}`
    : 'case                                 runs   pass  flake    env   wall p50/p95   last';
  console.log(header);
  console.log('─'.repeat(Math.max(94, header.length)));
  const names = [...byCase.keys()].sort();
  for (const name of names) {
    const all = byCase.get(name)!;
    // Pass/flake rates exclude environmental (OS spawn-refusal) rows — they
    // measure the machine, not the case. They get their own count column.
    const env = all.filter(isEnvironmentalRow).length;
    const list = all.filter((r) => !isEnvironmentalRow(r));
    const passes = list.filter((r) => r.passed).length;
    const flakes = list.filter((r) => r.passed && r.flaked).length;
    const lead =
      `${name.padEnd(36)} ${String(list.length).padStart(4)}  ${pct(passes, list.length)}  ` +
      `${pct(flakes, list.length)}  ${String(env).padStart(4)}   `;
    if (args.byModel) {
      const cells = modelCols.map((m) => {
        const sub = list.filter((r) => shortModel(r.model) === m);
        return (sub.length === 0 ? '   -   ' : pct(sub.filter((r) => r.passed).length, sub.length)).padStart(11);
      });
      console.log(lead + cells.join(' '));
      continue;
    }
    const walls = list.map((r) => r.wall_seconds).sort((a, b) => a - b);
    const p50 = percentile(walls, 50);
    const p95 = percentile(walls, 95);
    const last = list[list.length - 1] ?? all[all.length - 1];
    const lastV = last.passed ? (last.flaked ? '⚠' : '✓') : (isEnvironmentalRow(last) ? '⊘' : '✗');
    console.log(
      lead + `${p50.toFixed(0).padStart(4)}s/${p95.toFixed(0).padStart(4)}s   ` +
      `${lastV} ${last.sha}${last.dirty ? '*' : ''}`,
    );
  }
  console.log(`\nenv = environmental (OS spawn-refusal, 0xC0000142) non-runs, excluded from pass/flake (${totalEnv} total in scope).`);
  console.log('* last run was against a dirty (uncommitted) tree — sha is the baseline, not the exact code.');
  console.log(`A cell shows a FRACTION, not a percentage, below n=${MIN_RUNS_FOR_PCT}: one run is not a rate.`);
  if (totalUndelivered > 0) {
    console.log(`⚠ ${totalUndelivered} tool result(s) in scope were never delivered to the model — those runs measured a stub.`);
  }
  if (!args.byModel) {
    console.log('Rates above are BLENDED across models. Split them with --by-model, or scope with --model=/--since=.');
  }
  console.log('Drill in: --case=<id> for history, --recent=N for the latest runs.');
}

main();
