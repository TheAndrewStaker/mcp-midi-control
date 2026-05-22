/**
 * One-shot em-dash sweep across agent-visible source files.
 *
 * Substitution rules (in this order):
 *   1. " — " (space em-dash space) becomes ", " (most natural inline)
 *   2. " —" (trailing space) or "— " (leading space) becomes ", "
 *   3. Bare "—" with no surrounding spaces becomes ","
 *
 * Conservative: produces grammatical text in nearly every case. Run with
 * `--dry-run` to preview the diff per file before committing.
 *
 * One-shot tool: T-9 sprint sweep (2026-05-22). Once the lint at
 * `scripts/list-tools.ts` is enforcing the rule on tool descriptions
 * via tools:inventory-check, this script's purpose is finished.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

function globMatch(pattern: string): string[] {
  // Tiny glob: handles "<dir>/*.ts" only. Sufficient for the fixed
  // pattern set this sweep uses.
  const m = /^(.+)\/\*\.ts$/.exec(pattern);
  if (!m) return [];
  const root = m[1];
  const results: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    if (entry.endsWith('.ts')) results.push(full.replace(/\\/g, '/'));
  }
  return results;
}

const TARGETS = [
  'packages/am4/src/tools/*.ts',
  'packages/axe-fx-ii/src/tools/*.ts',
  'packages/hydrasynth/src/tools/*.ts',
  'packages/core/src/protocol-generic/tools/*.ts',
];

const dryRun = process.argv.includes('--dry-run');

let totalReplaced = 0;
let filesTouched = 0;

for (const pattern of TARGETS) {
  for (const file of globMatch(pattern)) {
    const original = readFileSync(file, 'utf8');
    if (!original.includes('—')) continue;
    const swept = original
      .replace(/ — /g, ', ')
      .replace(/— /g, ', ')
      .replace(/ —/g, ',')
      .replace(/—/g, ',');
    const count = (original.match(/—/g) || []).length;
    totalReplaced += count;
    filesTouched++;
    if (dryRun) {
      console.log(`[dry-run] ${file}: ${count} em-dash(es)`);
    } else {
      writeFileSync(file, swept, 'utf8');
      console.log(`${file}: ${count} em-dash(es) replaced`);
    }
  }
}

console.log(`\n${dryRun ? 'Would touch' : 'Touched'} ${filesTouched} file(s); ${totalReplaced} em-dash(es) replaced.`);
