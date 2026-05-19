/**
 * Preflight lint — fails the build if dev-internal references leak into
 * agent-visible strings under packages/*\/src/.
 *
 * RATIONALE
 * ---------
 * Tool descriptions and agent_guidance values get shipped to the LLM on
 * every tool call. Anything in there with the smell of internal process
 * (`Session 99`, `BK-060`, `HW-107`, `Phase 2`, `Ghidra-mined`,
 * `decode status`) leaks our workflow onto the agent's planning context,
 * tempts the agent to cite fictional canonical sources to the user, and
 * inflates input-context size for no user benefit.
 *
 * This lint scans every `.ts` file under `packages/*\/src/` for the
 * forbidden patterns, ignoring JSDoc / line comments (developers'
 * territory — Session/BK/HW IDs are correct there). It exits non-zero
 * with a list of offenders so the founder fixes the agent-visible
 * string instead of finding it weeks later in a user-reported leak.
 *
 * Wired into `npm run preflight` after the goldens. Add new forbidden
 * patterns to FORBIDDEN_PATTERNS as the lexicon evolves.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Forbidden patterns. Each pattern fires if it appears in an agent-
// visible string literal (i.e. NOT inside a JSDoc block or a // line
// comment). Keep the list narrow — adding "wire opcode bytes" or
// similar would catch substance that the agent actually needs.
const FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'Session-NN', re: /\b[Ss]ession \d+\b/ },
  { name: 'SESSION-NN', re: /\bSESSION \d+\b/ },
  { name: 'BK-NNN', re: /\bBK-\d{3}\b/ },
  { name: 'HW-NNN', re: /\bHW-\d{3}\b/ },
  { name: 'Phase-1/2 shorthand', re: /\bPhase [12]\b/ },
  { name: 'Ghidra mention', re: /\bGhidra\b/ },
  { name: 'decode-status callout', re: /\bdecode status\b/i },
  { name: 'WIRED-MISLABEL classification', re: /\bWIRED-MISLABEL\b/ },
  { name: 'UI-MISSING classification', re: /\bUI-MISSING\b/ },
  { name: 'GHOST classification', re: /\bGHOST candidates?\b/i },
  { name: 'docs/_private path', re: /docs\/_private\b/ },
];

// File-discovery — use git ls-files so we only check tracked sources,
// not generated dist/ output (which copies descriptions as-is and
// would produce duplicate offences).
function listFiles(): string[] {
  const out = execSync(
    'git ls-files "packages/*/src/**/*.ts"',
    { cwd: ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((rel) => path.join(ROOT, rel));
}

interface Offence {
  file: string;
  line: number;
  pattern: string;
  excerpt: string;
}

/**
 * Walk a file line-by-line, stripping JSDoc / line-comment regions.
 *
 * The strip is intentionally simple: a line is "comment territory" if
 * - its trimmed-left form starts with `*` (JSDoc body),
 * - its trimmed-left form starts with `//` (line comment),
 * - the line begins or sits inside a `/* ... *\/` block.
 *
 * Inline trailing comments on a code line still scan the code half —
 * but the dev-internal patterns we forbid are unlikely to appear in
 * trailing comments on code lines (they live in description strings).
 */
function scanFile(absPath: string): Offence[] {
  const raw = readFileSync(absPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const offences: Offence[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmedLeft = line.replace(/^\s+/, '');

    // Block-comment state machine. We process the line for comment
    // ranges, then check the non-comment remainder against forbidden
    // patterns.
    let working = line;

    if (inBlockComment) {
      const closeIdx = working.indexOf('*/');
      if (closeIdx === -1) {
        // Entire line is still comment.
        continue;
      }
      // Drop everything up to and including */ — exempt comment region.
      working = working.slice(closeIdx + 2);
      inBlockComment = false;
    }

    // Strip remaining /* ... */ block-openings on this line.
    for (;;) {
      const openIdx = working.indexOf('/*');
      if (openIdx === -1) break;
      const closeIdx = working.indexOf('*/', openIdx + 2);
      if (closeIdx === -1) {
        // Block comment opens but doesn't close on this line.
        working = working.slice(0, openIdx);
        inBlockComment = true;
        break;
      }
      // Strip the block-comment region in place.
      working = working.slice(0, openIdx) + working.slice(closeIdx + 2);
    }

    // Skip pure JSDoc continuation lines (` * ...`).
    if (trimmedLeft.startsWith('*') && !trimmedLeft.startsWith('*/')) {
      continue;
    }

    // Strip trailing // line comments — anything after the first //
    // outside a string is comment territory. The naive split is fine
    // here because we're matching forbidden words; a stray // inside
    // a string literal won't false-positive on the words we forbid.
    const commentIdx = working.indexOf('//');
    if (commentIdx !== -1) {
      working = working.slice(0, commentIdx);
    }

    if (working.trim().length === 0) continue;

    for (const { name, re } of FORBIDDEN_PATTERNS) {
      if (re.test(working)) {
        offences.push({
          file: absPath,
          line: i + 1,
          pattern: name,
          excerpt: working.trim().slice(0, 140),
        });
      }
    }
  }
  return offences;
}

function main(): void {
  const files = listFiles();
  const allOffences: Offence[] = [];
  for (const file of files) {
    allOffences.push(...scanFile(file));
  }

  if (allOffences.length === 0) {
    console.log(
      `verify-no-internal-refs: ok — scanned ${files.length} files under packages/*/src/, ` +
        `no internal references leaked into agent-visible strings.`,
    );
    return;
  }

  console.error(
    `verify-no-internal-refs: FAIL — ${allOffences.length} offence(s) found ` +
      `across ${files.length} files. Dev-internal references must not appear ` +
      `in description / agent_guidance string literals.\n`,
  );
  console.error(
    `Allowed in JSDoc comments (/** ... */) and // line comments, NOT in ` +
      `agent-facing string literals.\n`,
  );
  for (const o of allOffences) {
    const rel = path.relative(ROOT, o.file).replace(/\\/g, '/');
    console.error(`  ${rel}:${o.line}  [${o.pattern}]  ${o.excerpt}`);
  }
  process.exit(1);
}

main();
