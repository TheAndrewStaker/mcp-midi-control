/**
 * RE-workflow ledger gate (Gates 1 + 3 + the Gate-4 drift check).
 * Warnings day-to-day; failures only under --strict (the release gate).
 * Design principle: the machine remembers and nags; the human judges.
 *
 * 1. UNMINED ledger + age check. Both captured-artifacts manifests
 *    (public: packages/fractal-midi/docs/research/captured-artifacts.md;
 *    founder-private: docs/_private/captured-artifacts.md, gitignored —
 *    parsed only when present) may carry structured lines:
 *
 *      UNMINED[YYYY-MM-DD]: <artifact path or pointer> — <what would close it>
 *
 *    optionally suffixed `(deferred: YYYY-MM-DD <reason>)`. Items older
 *    than 30 days WARN (naming the item + its closer). Under --strict,
 *    items older than 60 days FAIL unless they carry the deferred tag.
 *    Legacy prose markers (/un-?mined/i outside structured lines) WARN
 *    with a convert-to-UNMINED[date] nudge — a format nudge, never a fail.
 *    A prose marker followed (within 8 lines, i.e. its own wrapped
 *    paragraph) by a structured UNMINED[ line is treated as that item's
 *    narrative and not re-flagged.
 *
 * 2. Samples-vs-manifest sweep (local-only, never fails — even --strict).
 *    Top-level entries under samples/captured/ (repo root AND
 *    packages/fractal-midi/) older than 7 days whose basename appears in
 *    NEITHER manifest WARN: on disk but invisible to future sessions.
 *    Skips cleanly in CI and when the directories are absent. Capped at 20.
 *
 * 3. Transfer-candidates drift check (FAILS, mirroring catalog:check):
 *    regenerates docs/research/transfer-candidates.generated.md in memory
 *    via scripts/gen-transfer-candidates.ts and fails on mismatch with the
 *    committed file, so primitives coverage changes force a regen commit.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReport, REPORT_PATH } from './gen-transfer-candidates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const FRACTAL_MIDI_ROOT = path.join(MCP_ROOT, 'packages', 'fractal-midi');
const STRICT = process.argv.includes('--strict');
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
const NOW_MS = Date.now();
const DAY_MS = 86_400_000;
const WARN_AGE_DAYS = 30;
const STRICT_FAIL_AGE_DAYS = 60;
const SAMPLES_AGE_DAYS = 7;
const SAMPLES_WARN_CAP = 20;

const MANIFESTS = [
  {
    label: 'public manifest',
    file: path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'captured-artifacts.md'),
    required: true,
  },
  {
    label: 'private manifest',
    file: path.join(MCP_ROOT, 'docs', '_private', 'captured-artifacts.md'),
    required: false, // gitignored, founder-local; clean skip when absent
  },
];

const UNMINED_RE = /^\s*(?:[-*>]\s*)*UNMINED\[(\d{4}-\d{2}-\d{2})\]:\s*(.+?)\s+—\s+(.+)$/;
const DEFERRED_RE = /\(deferred:\s*\d{4}-\d{2}-\d{2}\s+[^)]+\)/;
const LEGACY_RE = /\bun-?mined\b/i;
// Instructional prose about the un-mined concept itself, not an item flag.
const LEGACY_INSTRUCTIONAL_RE = /un-?mined (material|entries)|what'?s un-?mined/i;

const warns: string[] = [];
const fails: string[] = [];

function checkManifest(label: string, file: string): number {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let structured = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(UNMINED_RE);
    if (m) {
      structured += 1;
      const [, dateStr, artifact, closer] = m;
      const dateMs = Date.parse(`${dateStr}T00:00:00Z`);
      if (Number.isNaN(dateMs)) {
        fails.push(`${label} L${i + 1}: UNMINED date '${dateStr}' does not parse.`);
        continue;
      }
      const ageDays = Math.floor((NOW_MS - dateMs) / DAY_MS);
      const deferred = DEFERRED_RE.test(line);
      if (STRICT && ageDays > STRICT_FAIL_AGE_DAYS && !deferred) {
        fails.push(
          `${label} L${i + 1}: UNMINED item is ${ageDays} days old (> ${STRICT_FAIL_AGE_DAYS}, strict): ` +
          `${artifact} — closer: ${closer}. Re-mine it, or mark '(deferred: YYYY-MM-DD <reason>)'.`,
        );
      } else if (ageDays > WARN_AGE_DAYS) {
        warns.push(
          `${label} L${i + 1}: UNMINED item aged ${ageDays} days: ${artifact} — closer: ${closer}` +
          (deferred ? ' [deferred]' : ''),
        );
      }
      continue;
    }
    // Legacy prose marker detection (format nudge only).
    if (!LEGACY_RE.test(line)) continue;
    if (LEGACY_INSTRUCTIONAL_RE.test(line)) continue; // how-to prose
    if (/nothing|~~/i.test(line)) continue; // "Un-mined: nothing" / struck-through
    const supplemented = lines
      .slice(i + 1, i + 9)
      .some((l) => UNMINED_RE.test(l));
    if (supplemented) continue;
    warns.push(
      `${label} L${i + 1}: legacy un-mined prose marker — convert to a structured ` +
      `'UNMINED[YYYY-MM-DD]: <artifact> — <closer>' line (or close it out): ${line.trim().slice(0, 120)}`,
    );
  }
  return structured;
}

function sweepSamples(manifestTexts: string[]): void {
  if (IS_CI) {
    console.log('verify-re-ledger: samples sweep skipped in CI (samples/ is founder-local).');
    return;
  }
  const haystack = manifestTexts.join('\n').toLowerCase();
  const roots = [
    path.join(MCP_ROOT, 'samples', 'captured'),
    path.join(FRACTAL_MIDI_ROOT, 'samples', 'captured'),
  ].filter((r) => existsSync(r));
  if (roots.length === 0) {
    console.log('verify-re-ledger: no samples/captured directory present — sweep skipped.');
    return;
  }
  const unindexed: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      if (name === '.gitkeep') continue;
      const st = statSync(path.join(root, name));
      const ageDays = (NOW_MS - st.mtimeMs) / DAY_MS;
      if (ageDays < SAMPLES_AGE_DAYS) continue;
      if (haystack.includes(name.toLowerCase())) continue;
      unindexed.push(`${path.relative(MCP_ROOT, path.join(root, name))} (mtime ${new Date(st.mtimeMs).toISOString().slice(0, 10)})`);
    }
  }
  if (unindexed.length === 0) return;
  // Never a failure, even under --strict: manifest coverage of local scratch
  // is a hygiene nudge, not a gate.
  warns.push(
    `samples sweep: ${unindexed.length} on-disk entries under samples/captured/ are > ${SAMPLES_AGE_DAYS} days old ` +
    `and not mentioned by basename in any manifest — invisible to future sessions. Register them or fold them ` +
    `into an existing entry.`,
  );
  for (const u of unindexed.slice(0, SAMPLES_WARN_CAP)) {
    warns.push(`  unindexed: ${u}`);
  }
  if (unindexed.length > SAMPLES_WARN_CAP) {
    warns.push(`  ... and ${unindexed.length - SAMPLES_WARN_CAP} more (showing first ${SAMPLES_WARN_CAP}).`);
  }
}

function checkTransferCandidatesDrift(): void {
  let fresh: string;
  try {
    fresh = generateReport();
  } catch (e) {
    fails.push(`transfer-candidates: generator threw: ${(e as Error).message}`);
    return;
  }
  if (!existsSync(REPORT_PATH)) {
    fails.push(
      `transfer-candidates: committed report missing at ${REPORT_PATH}. ` +
      `Run 'npx tsx scripts/gen-transfer-candidates.ts' and commit the output.`,
    );
    return;
  }
  const committed = readFileSync(REPORT_PATH, 'utf8');
  if (committed !== fresh) {
    fails.push(
      `transfer-candidates: committed report is stale (primitives coverage changed). ` +
      `Run 'npx tsx scripts/gen-transfer-candidates.ts' and commit ${path.relative(MCP_ROOT, REPORT_PATH)}.`,
    );
  }
}

function main(): void {
  const manifestTexts: string[] = [];
  let structuredTotal = 0;
  for (const { label, file, required } of MANIFESTS) {
    if (!existsSync(file)) {
      if (required) {
        fails.push(`${label} missing on disk: ${file}`);
      } else {
        console.log(`verify-re-ledger: ${label} not present (gitignored, founder-local) — skipped cleanly.`);
      }
      continue;
    }
    manifestTexts.push(readFileSync(file, 'utf8'));
    structuredTotal += checkManifest(label, file);
  }
  sweepSamples(manifestTexts);
  checkTransferCandidatesDrift();

  if (warns.length > 0) {
    console.log(`WARNINGS (${warns.length}):`);
    for (const w of warns) console.log(`  [warn] ${w}`);
    console.log('');
  }
  if (fails.length > 0) {
    console.log(`FAILURES (${fails.length})${STRICT ? ' [--strict]' : ''}:`);
    for (const f of fails) console.log(`  [fail] ${f}`);
    process.exit(1);
  }
  console.log(
    `OK: verify-re-ledger — ${structuredTotal} UNMINED ledger lines tracked, ` +
    `${warns.length} non-blocking warnings${STRICT ? ' (strict mode)' : ''}.`,
  );
}

main();
