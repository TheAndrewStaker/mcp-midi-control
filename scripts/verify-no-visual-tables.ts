/**
 * Preflight lint — fails the build if a screen-reader-hostile VISUAL TABLE
 * leaks into an agent-visible string under packages/*\/src/.
 *
 * RATIONALE
 * ---------
 * The conversational surface IS this project's accessibility win: many
 * users drive it entirely by voice / screen reader (VoiceOver, NVDA).
 * That only holds if tools return STRUCTURED display-unit data the model
 * narrates as prose — never a pre-rendered grid the model echoes verbatim.
 * A box-drawing diagram or block-element bar read aloud is noise: "vertical
 * line space space dash dash dash" instead of "drive into amp into reverb".
 *
 * This guard is the objective half of the runtime-accessibility-polish
 * plan (see docs/design/runtime-accessibility-polish.md, item 5). It scans
 * every `.ts` file under `packages/*\/src/` for Unicode BOX-DRAWING
 * (U+2500..U+257F) and BLOCK-ELEMENT (U+2580..U+259F) characters in
 * agent-visible string territory (NOT inside JSDoc / line comments — a box
 * diagram in a dev comment never reaches the model). It exits non-zero with
 * a list of offenders so a contributor fixes the rendered table instead of
 * shipping a grid that fights a screen reader.
 *
 * SCOPE NOTE: this guard deliberately does NOT flag multi-space column
 * alignment. Aligned plain-text tables appear legitimately inside
 * agent_guidance (model INPUT the model reformats before speaking, e.g. the
 * AM4 loudness knob table), and flagging them would drown the signal in
 * false positives. Box-drawing / block-element glyphs are the unambiguous
 * marker of a glyph-rendered visual. Arrow glyphs (↔ →, the Arrows block
 * U+2190..U+21FF) are intentionally OUT of range — a lone arrow reads fine
 * aloud ("to" / "versus") and is used in cross-device naming guidance.
 *
 * Wired into `npm run preflight`. If a genuine need for one of these glyphs
 * ever arises in agent-visible text (unlikely), add a narrow allowlist
 * entry here with a reason rather than widening the ranges.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Box-drawing (U+2500..U+257F) + block-element (U+2580..U+259F). Any of
// these in an agent-visible string means a rendered visual table/grid/bar.
const VISUAL_GLYPH_RE = /[─-╿▀-▟]/u;

// File-discovery: tracked TS sources under packages/*/src/.
function listFiles(): string[] {
  const out = execSync(
    'git ls-files "packages/*/src/**/*.ts"',
    { cwd: ROOT, encoding: 'utf8' },
  );
  // `git ls-files` reports tracked paths from the index, which can include
  // files deleted in the working tree but not yet staged. Skip any path
  // that no longer exists on disk rather than crashing on ENOENT.
  return parseGitLsFiles(out).filter((rel) => existsSync(rel));
}

function parseGitLsFiles(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((rel) => path.join(ROOT, rel));
}

interface Offence {
  file: string;
  line: number;
  excerpt: string;
}

/**
 * Walk a file line-by-line, stripping JSDoc / line-comment regions so a
 * box diagram in developer-territory comments doesn't false-positive.
 * Mirrors the comment-stripping in verify-no-internal-refs.ts.
 */
function scanFile(absPath: string): Offence[] {
  const raw = readFileSync(absPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const offences: Offence[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmedLeft = line.replace(/^\s+/, '');
    let working = line;

    if (inBlockComment) {
      const closeIdx = working.indexOf('*/');
      if (closeIdx === -1) continue; // entire line still comment
      working = working.slice(closeIdx + 2);
      inBlockComment = false;
    }

    // Strip remaining /* ... */ block-openings on this line.
    for (;;) {
      const openIdx = working.indexOf('/*');
      if (openIdx === -1) break;
      const closeIdx = working.indexOf('*/', openIdx + 2);
      if (closeIdx === -1) {
        working = working.slice(0, openIdx);
        inBlockComment = true;
        break;
      }
      working = working.slice(0, openIdx) + working.slice(closeIdx + 2);
    }

    // Skip pure JSDoc continuation lines (` * ...`).
    if (trimmedLeft.startsWith('*') && !trimmedLeft.startsWith('*/')) continue;

    // Strip trailing // line comments.
    const commentIdx = working.indexOf('//');
    if (commentIdx !== -1) working = working.slice(0, commentIdx);

    if (working.trim().length === 0) continue;

    if (VISUAL_GLYPH_RE.test(working)) {
      offences.push({
        file: absPath,
        line: i + 1,
        excerpt: working.trim().slice(0, 140),
      });
    }
  }
  return offences;
}

function main(): void {
  const tsFiles = listFiles();
  const allOffences: Offence[] = [];
  for (const file of tsFiles) {
    allOffences.push(...scanFile(file));
  }

  if (allOffences.length === 0) {
    console.log(
      `verify-no-visual-tables: ok — scanned ${tsFiles.length} TS files ` +
        `under packages/*/src/. No box-drawing / block-element glyphs in ` +
        `agent-visible strings.`,
    );
    return;
  }

  console.error(
    `verify-no-visual-tables: FAIL — ${allOffences.length} offence(s) found.\n` +
      `Box-drawing / block-element characters render a visual table that ` +
      `reads as noise through a screen reader. Return structured data and ` +
      `let the model narrate it as prose instead.\n` +
      `(Allowed inside JSDoc / line comments — dev territory.)\n`,
  );
  for (const o of allOffences) {
    const rel = path.relative(ROOT, o.file).replace(/\\/g, '/');
    console.error(`  ${rel}:${o.line}  ${o.excerpt}`);
  }
  process.exit(1);
}

main();
