/**
 * Agent-sweep analytics reader (P3). Reads the gitignored results.jsonl corpus
 * and prints per-case behavior so flakiness, slow cases, and drift across
 * commits are visible at a glance.
 *
 *   npx tsx scripts/agent-regression/stats.ts            # per-case table
 *   npx tsx scripts/agent-regression/stats.ts --case=ID  # one case's history
 *   npx tsx scripts/agent-regression/stats.ts --recent=N # last N runs, newest first
 *
 * The corpus is append-only and dirty-tree-aware: each row carries HEAD `sha`,
 * a `dirty` flag, and (when dirty) a `tree_sha`, so a result is attributable to
 * the actual code under test, not just the last commit. Rows with `dirty:true`
 * are flagged so you don't read a clean-commit trend into dirty-tree runs.
 */
import path from 'node:path';

import { RESULTS_LOG, loadRows, isEnvironmentalRow, type LoggedRow } from './resultsLog.js';

type Row = LoggedRow;

function pct(n: number, d: number): string {
  return d === 0 ? '  -  ' : `${Math.round((n / d) * 100).toString().padStart(3)}%`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function parseArgs(argv: readonly string[]): { caseId?: string; recent?: number } {
  const out: { caseId?: string; recent?: number } = {};
  for (const a of argv) {
    if (a.startsWith('--case=')) out.caseId = a.slice('--case='.length);
    else if (a.startsWith('--recent=')) out.recent = Number(a.slice('--recent='.length));
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadRows();
  if (rows.length === 0) {
    console.error(`No results corpus at ${path.relative(process.cwd(), RESULTS_LOG)}. Run a sweep or a single case first.`);
    process.exit(1);
  }

  if (args.recent !== undefined) {
    const recent = rows.slice(-args.recent).reverse();
    console.log(`Last ${recent.length} run(s), newest first:\n`);
    for (const r of recent) {
      const v = r.passed ? (r.flaked ? '⚠' : '✓') : '✗';
      const dirty = r.dirty ? ` +dirty${r.tree_sha ? `:${r.tree_sha}` : ''}` : '';
      console.log(
        `${v} ${r.timestamp.slice(0, 16).replace('T', ' ')}  ${r.sha}${dirty}  ` +
        `${r.case_id.padEnd(34)} ${r.wall_seconds.toFixed(0).padStart(4)}s  ${String(r.tool_count).padStart(2)}t  ${r.via ?? '?'}`,
      );
    }
    return;
  }

  if (args.caseId !== undefined) {
    const hist = rows.filter((r) => r.case_id === args.caseId);
    if (hist.length === 0) { console.error(`No rows for case "${args.caseId}".`); process.exit(1); }
    console.log(`History for ${args.caseId} (${hist.length} runs):\n`);
    for (const r of hist.reverse()) {
      const v = r.passed ? (r.flaked ? '⚠ flake' : '✓ pass') : '✗ fail';
      const dirty = r.dirty ? ` +dirty${r.tree_sha ? `:${r.tree_sha}` : ''}` : '';
      console.log(`  ${r.timestamp.slice(0, 16).replace('T', ' ')}  ${r.sha}${dirty}  ${v}  ${r.wall_seconds.toFixed(0)}s  ${r.tool_count}t  ${r.via ?? '?'}`);
      if (!r.passed && r.failures) for (const f of r.failures) console.log(`        ✗ ${f}`);
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
  console.log(
    `Agent-sweep corpus: ${rows.length} runs across ${byCase.size} case(s), ${shas.size} commit(s), ` +
    `${rows[0]?.timestamp.slice(0, 10)}..${rows[rows.length - 1]?.timestamp.slice(0, 10)}. ` +
    `${dirtyRuns} run(s) against a dirty tree.\n`,
  );
  const totalEnv = rows.filter(isEnvironmentalRow).length;
  console.log('case                                 runs   pass  flake    env   wall p50/p95   last');
  console.log('─'.repeat(94));
  const names = [...byCase.keys()].sort();
  for (const name of names) {
    const all = byCase.get(name)!;
    // Pass/flake rates exclude environmental (OS spawn-refusal) rows — they
    // measure the machine, not the case. They get their own count column.
    const env = all.filter(isEnvironmentalRow).length;
    const list = all.filter((r) => !isEnvironmentalRow(r));
    const passes = list.filter((r) => r.passed).length;
    const flakes = list.filter((r) => r.passed && r.flaked).length;
    const walls = list.map((r) => r.wall_seconds).sort((a, b) => a - b);
    const p50 = percentile(walls, 50);
    const p95 = percentile(walls, 95);
    const last = list[list.length - 1] ?? all[all.length - 1];
    const lastV = last.passed ? (last.flaked ? '⚠' : '✓') : (isEnvironmentalRow(last) ? '⊘' : '✗');
    console.log(
      `${name.padEnd(36)} ${String(list.length).padStart(4)}  ${pct(passes, list.length)}  ` +
      `${pct(flakes, list.length)}  ${String(env).padStart(4)}   ${p50.toFixed(0).padStart(4)}s/${p95.toFixed(0).padStart(4)}s   ` +
      `${lastV} ${last.sha}${last.dirty ? '*' : ''}`,
    );
  }
  console.log(`\nenv = environmental (OS spawn-refusal, 0xC0000142) non-runs, excluded from pass/flake (${totalEnv} total in corpus).`);
  console.log('* last run was against a dirty (uncommitted) tree — sha is the baseline, not the exact code.');
  console.log('Drill in: --case=<id> for history, --recent=N for the latest runs.');
}

main();
