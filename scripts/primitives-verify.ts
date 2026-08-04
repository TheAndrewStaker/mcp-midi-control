/**
 * Encoding-Primitives build gate.
 *
 * Walks every primitive entry in the sibling `fractal-midi` repo's
 * `docs/research/primitives/` directory (plus its `_scratch/`,
 * `_partial/`, `_negative/` subdirectories), parses the YAML
 * frontmatter, and applies two layers of validation:
 *
 *   1. STRUCTURAL gates (every entry, always run):
 *      - Required frontmatter fields present (name, status, golden, etc.)
 *      - `name:` matches the filename slug.
 *      - `status:` is one of the legal values from primitives INDEX.md.
 *      - `golden:` RESOLVES: a `primitives-verify.ts#case-<slug>` reference
 *        must name a real FUNCTIONAL_CASES key; a script/test path must
 *        exist on disk (repo root or packages/fractal-midi/); the honest
 *        `STUB (...)` form is always legal. Phantom goldens fail the build.
 *      - INDEX <-> disk drift: every main-directory entry is linked from
 *        INDEX.md, every _negative entry from _negative/INDEX.md, and every
 *        primitives .md link in either index resolves to a file on disk.
 *      - Every `_negative/` entry carries a findability heading
 *        (Symptoms / grep terms) so the agent about to re-attempt the dead
 *        end can find the rule-out by grep.
 *      - Every `_negative/` entry carries a `retest_when:` frontmatter field:
 *        either a list of re-test triggers (primitive slugs and/or free-text
 *        conditions) or the literal scalar form `never (<reason>)`. Missing
 *        field = FAIL (same class as the findability heading). A resolver
 *        WARNS when a listed trigger slug now exists in the live entry set
 *        with status matched / matched-singleton ("re-adjudicate or update
 *        retest_when"); under `--strict` that resolver hit FAILS. Free-text
 *        conditions (anything that isn't a kebab-case slug of an existing
 *        entry) are allowed and simply skipped by the resolver, as are
 *        slug-shaped names of primitives that don't exist yet (they're the
 *        pending trigger). `--strict` changes nothing else.
 *      - `consumed_in:` paths exist on disk (resolved against the consumer
 *        repo, the fractal-midi sibling repo, and the parent of both).
 *      - Status invariants:
 *          matched              -> needs >= 2 entries in `verified_on:`
 *          matched-singleton    -> needs >= 1 entry, body must justify the singleton
 *          partial-N1           -> entry should live in `_partial/` OR body must
 *                                  name the path to `matched`
 *          scratch              -> entry must live in `_scratch/`
 *          non-matching         -> entry must live in `_negative/`
 *          wip / regression     -> structural-only (not build-gating beyond fields)
 *
 *   2. FUNCTIONAL fixture cases (a subset that can run pure-CPU):
 *      - case-xor-7f-envelope-checksum     XOR-fold over known wire prefixes.
 *      - case-septet-14bit                 round-trip across boundaries (0, 127,
 *                                          128, 16383).
 *      - case-septet-21bit-byte2-mask-preservation
 *                                          encode/decode round-trip with a
 *                                          non-zero originalByte2 high mask.
 *      - case-vendor-envelope-descriptor-table
 *                                          parse the III descriptor JSON and
 *                                          confirm the headline table
 *                                          `0x1407ab940` matches the II preset-
 *                                          body envelope shape (2 + 3072 bytes).
 *      - case-xor-fold-hash                17-line XOR-fold over a known ushort
 *                                          array.
 *      - case-device-reserialization-oracle
 *                                          a METHOD primitive, which has no
 *                                          bytes of its own: the case pins the
 *                                          adjudication rule + the oracle-
 *                                          admissibility predicate, the worked
 *                                          case's arithmetic, and that the
 *                                          cited probe scripts still carry the
 *                                          oracle leg. This is the shape to
 *                                          copy for future method entries.
 *      - case-deferred-commit-readback-window
 *                                          the second METHOD entry, copying that
 *                                          shape: pins the "absence is only
 *                                          conclusive after the commit window"
 *                                          rule and its asymmetry, the measured
 *                                          Circuit fixture, that the cited
 *                                          verification loop still waits past
 *                                          the window, and that the runtime
 *                                          surface still carries the timing.
 *
 * Build-break policy: any structural gate fail or any functional case fail
 * exits with code 1. Wired into `npm run preflight` after `verify-msg`.
 * Non-breaking: a synthesis-cadence check WARNS (does not fail) when the
 * newest main-directory primitive entry is > 21 days newer than the newest artifact
 * in docs/research/synthesis-log/ (cadence rot would otherwise be invisible).
 *
 * Adding a new primitive entry that needs a fixture: add a `case-<slug>`
 * function below + extend FUNCTIONAL_CASES. Entries without an inline case
 * are still subject to the structural gate; their golden field's reference
 * is recorded as STUB but not failed (the existing verify-* scripts are
 * the de-facto goldens for those primitives).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_PARENT = path.resolve(MCP_ROOT, '..');
const FRACTAL_MIDI_ROOT = path.join(MCP_ROOT, 'packages', 'fractal-midi');
const PRIMITIVES_ROOT = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'primitives');
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
// --strict (the release gate): escalates the retest_when resolver's
// "trigger primitive now exists" warnings to failures. Nothing else changes.
const STRICT = process.argv.includes('--strict');

const LEGAL_STATUSES = new Set([
  'matched',
  'matched-singleton',
  'partial-N1',
  'wip',
  'scratch',
  'regression',
  'non-matching',
]);

const REQUIRED_FRONTMATTER_KEYS = ['name', 'status', 'golden'];

interface PrimitiveEntry {
  filePath: string;
  slug: string;
  dirCategory: 'main' | '_scratch' | '_partial' | '_negative';
  frontmatter: Record<string, string | string[]>;
  body: string;
}

interface Violation {
  entry: string;
  severity: 'fail' | 'warn';
  message: string;
}

function listPrimitiveFiles(): string[] {
  // Primitive entries reference gitignored Ghidra decompile outputs and
  // USB captures in samples/captured/decoded/. These only exist on the
  // founder's machine, not in CI. Skip the entire primitives-verify in CI.
  if (IS_CI) {
    console.log(
      `primitives-verify: skipped in CI (primitive entries reference local-only ` +
      `Ghidra artifacts in samples/captured/decoded/).`,
    );
    process.exit(0);
  }
  if (!existsSync(PRIMITIVES_ROOT)) {
    throw new Error(
      `primitives root not found: ${PRIMITIVES_ROOT}. ` +
        `fractal-midi workspace package is missing or the primitives corpus has moved.`,
    );
  }
  const out: string[] = [];
  for (const name of readdirSync(PRIMITIVES_ROOT)) {
    const full = path.join(PRIMITIVES_ROOT, name);
    const st = statSync(full);
    if (st.isFile() && name.endsWith('.md') && name !== 'INDEX.md') {
      out.push(full);
    } else if (st.isDirectory() && ['_scratch', '_partial', '_negative'].includes(name)) {
      for (const inner of readdirSync(full)) {
        if (inner.endsWith('.md') && inner !== 'INDEX.md') {
          out.push(path.join(full, inner));
        }
      }
    }
  }
  return out.sort();
}

/**
 * Minimal YAML frontmatter parser. Handles: scalar `key: value`, list
 * `key:` followed by `  - value` lines, inline list `key: [a, b, c]`,
 * and quoted strings (single or double). Sufficient for primitives
 * entries; not a general YAML library.
 */
function parseFrontmatter(source: string): { frontmatter: Record<string, string | string[]>; body: string } {
  if (!source.startsWith('---')) {
    return { frontmatter: {}, body: source };
  }
  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: {}, body: source };
  const frontmatter: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  let currentList: string[] = [];
  const flushList = () => {
    if (currentListKey !== null) {
      frontmatter[currentListKey] = currentList;
    }
    currentListKey = null;
    currentList = [];
  };
  const stripQuotes = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (raw.startsWith('  - ') || raw.startsWith('\t- ')) {
      if (currentListKey !== null) {
        currentList.push(stripQuotes(raw.replace(/^\s*-\s*/, '')));
      }
      continue;
    }
    flushList();
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim();
    const rest = raw.slice(colon + 1).trim();
    if (rest === '') {
      currentListKey = key;
      currentList = [];
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner === ''
        ? []
        : inner.split(',').map((s) => stripQuotes(s));
      continue;
    }
    frontmatter[key] = stripQuotes(rest);
  }
  flushList();
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

function categoryOf(filePath: string): PrimitiveEntry['dirCategory'] {
  const rel = path.relative(PRIMITIVES_ROOT, filePath);
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return 'main';
  if (parts[0] === '_scratch') return '_scratch';
  if (parts[0] === '_partial') return '_partial';
  if (parts[0] === '_negative') return '_negative';
  return 'main';
}

function slugFromPath(filePath: string): string {
  const base = path.basename(filePath, '.md');
  return base;
}

function loadEntries(): PrimitiveEntry[] {
  const files = listPrimitiveFiles();
  return files.map((f) => {
    const src = readFileSync(f, 'utf8');
    const { frontmatter, body } = parseFrontmatter(src);
    return {
      filePath: f,
      slug: slugFromPath(f),
      dirCategory: categoryOf(f),
      frontmatter,
      body,
    };
  });
}

/**
 * Resolve a `consumed_in:` line to an absolute path. Strips trailing
 * parenthetical notes, then tries an ordered list of base directories
 * (the consumer repo, fractal-midi, repo parent). Lines whose annotation
 * marks the path as speculative ("if exists", "pending", "transfer
 * candidate", "TBD", "TODO") return 'soft-missing' so the gate logs
 * but does not fail. Lines whose entire content is a parenthetical
 * comment return 'placeholder'.
 */
function resolveConsumedInPath(
  line: string,
):
  | { kind: 'real'; absolute: string }
  | { kind: 'placeholder' }
  | { kind: 'soft-missing'; tried: string[]; reason: string }
  | { kind: 'missing'; tried: string[] } {
  let raw = line.trim();
  const isSpeculative = /\b(if exists|pending|placeholder|TBD|TODO|transfer candidate)\b/i.test(line);
  // Strip parenthetical notes: "packages/foo.ts (note about scope)" -> "packages/foo.ts"
  const parenIdx = raw.indexOf('(');
  if (parenIdx === 0) {
    return { kind: 'placeholder' };
  }
  if (parenIdx > 0) {
    raw = raw.slice(0, parenIdx).trim();
  }
  if (raw === '') return { kind: 'placeholder' };
  const candidates: string[] = [];
  candidates.push(path.resolve(MCP_ROOT, raw));
  candidates.push(path.resolve(FRACTAL_MIDI_ROOT, raw));
  candidates.push(path.resolve(REPO_PARENT, raw));
  // Also try after stripping a leading consumer-repo or fractal-midi prefix.
  // Both the old `mcp-midi-tools/` directory name and the canonical
  // `mcp-midi-control/` package name resolve to the same MCP_ROOT during
  // the directory-rename transition.
  for (const prefix of ['mcp-midi-control/', 'mcp-midi-tools/', 'fractal-midi/']) {
    if (raw.startsWith(prefix)) {
      const stripped = raw.slice(prefix.length);
      candidates.push(
        prefix === 'fractal-midi/'
          ? path.resolve(FRACTAL_MIDI_ROOT, stripped)
          : path.resolve(MCP_ROOT, stripped),
      );
    }
  }
  const tried: string[] = [];
  for (const c of candidates) {
    if (tried.includes(c)) continue;
    tried.push(c);
    if (existsSync(c)) return { kind: 'real', absolute: c };
  }
  if (isSpeculative) {
    return { kind: 'soft-missing', tried, reason: 'speculative annotation' };
  }
  return { kind: 'missing', tried };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse `[[slug]]` markdown wikilinks out of the entry body. The primitives
 * uses kebab-case slugs exclusively (lowercase a-z, digits, hyphens). This
 * is intentionally narrow — it won't match prose links like `[label](url)`.
 */
function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function validateStructural(
  entry: PrimitiveEntry,
  violations: Violation[],
  slugSet: Set<string>,
): void {
  const fm = entry.frontmatter;
  // Required keys
  for (const k of REQUIRED_FRONTMATTER_KEYS) {
    if (!(k in fm)) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `missing required frontmatter key '${k}'`,
      });
    }
  }
  // Name matches filename
  const declaredName = typeof fm.name === 'string' ? fm.name : null;
  if (declaredName !== null && declaredName !== entry.slug) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `frontmatter name '${declaredName}' does not match file slug '${entry.slug}'`,
    });
  }
  const status = typeof fm.status === 'string' ? fm.status : null;
  if (status !== null && !LEGAL_STATUSES.has(status)) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `illegal status '${status}'. legal: ${[...LEGAL_STATUSES].join(', ')}`,
    });
  }
  // Directory invariants
  if (status === 'scratch' && entry.dirCategory !== '_scratch') {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='scratch' but entry lives in ${entry.dirCategory}/. move to _scratch/`,
    });
  }
  if (status === 'non-matching' && entry.dirCategory !== '_negative') {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='non-matching' but entry lives in ${entry.dirCategory}/. move to _negative/`,
    });
  }
  // Fixture-count invariant for matched
  const verifiedOn = asList(fm.verified_on);
  if (status === 'matched' && verifiedOn.length < 2) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message:
        `status='matched' requires verified_on to list >= 2 axis points (devices/firmwares); ` +
        `found ${verifiedOn.length}. Demote to 'matched-singleton' or 'partial-N1', or add the second fixture.`,
    });
  }
  if (status === 'matched-singleton' && verifiedOn.length < 1) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='matched-singleton' requires verified_on to list >= 1 axis point; found 0`,
    });
  }
  // Consumed_in path resolution
  const consumedIn = asList(fm.consumed_in);
  for (const ci of consumedIn) {
    const resolved = resolveConsumedInPath(ci);
    if (resolved.kind === 'missing') {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message:
          `consumed_in path not found: '${ci}'. Tried:\n    ${resolved.tried.join('\n    ')}`,
      });
    } else if (resolved.kind === 'soft-missing') {
      violations.push({
        entry: entry.slug,
        severity: 'warn',
        message: `consumed_in speculative path not found: '${ci}' (${resolved.reason})`,
      });
    }
  }
  // Cross-reference integrity: relates_to + body wikilinks. Primitive entries
  // navigate via [[slug]] wikilinks and `relates_to:` frontmatter lists; if
  // either points at a slug that no longer exists, readers chase ghosts.
  // Self-references are allowed (some refinement-history footers cite the
  // entry's own slug for clarity).
  const relatesTo = asList(fm.relates_to);
  for (const ref of relatesTo) {
    if (ref === '' || ref === entry.slug) continue;
    if (!slugSet.has(ref)) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `relates_to references unknown primitives slug '${ref}'`,
      });
    }
  }
  const wikilinks = extractWikilinks(entry.body);
  const reported = new Set<string>();
  for (const ref of wikilinks) {
    if (ref === entry.slug || reported.has(ref)) continue;
    if (!slugSet.has(ref)) {
      reported.add(ref);
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `body [[wikilink]] references unknown primitives slug '${ref}'`,
      });
    }
  }
  validateGoldenAnchor(entry, violations);
  validateNegativeFindability(entry, violations);
}

/**
 * Golden-anchor resolution. Three legal shapes for `golden:`:
 *   1. `STUB (...)` — the honest structural-only marker (name the best
 *      de-facto coverage pointer, or 'none').
 *   2. A `case-<slug>` reference into THIS script — the slug must be a key
 *      in FUNCTIONAL_CASES. Both the canonical
 *      `scripts/primitives-verify.ts#case-<slug>` form and the prose
 *      `case-<slug> in scripts/primitives-verify.ts (...)` form are accepted.
 *   3. A path to another script/test file that de-facto covers the
 *      primitive — every path-like token must exist on disk (resolved
 *      against the repo root and packages/fractal-midi/).
 * Anything else fails: a golden that does not resolve is a coverage claim
 * that nothing enforces (39 entries carried phantom case references before
 * this gate landed).
 */
function validateGoldenAnchor(entry: PrimitiveEntry, violations: Violation[]): void {
  const golden = typeof entry.frontmatter.golden === 'string' ? entry.frontmatter.golden : null;
  if (golden === null) return; // missing key already reported by REQUIRED_FRONTMATTER_KEYS
  if (/^STUB\b/.test(golden)) return;
  if (golden.includes('primitives-verify.ts')) {
    const caseRefs = [...golden.matchAll(/case-([A-Za-z0-9][A-Za-z0-9-]*)/g)].map((m) => m[1]);
    if (caseRefs.length === 0) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message:
          `golden names primitives-verify.ts but carries no 'case-<slug>' reference: '${golden}'. ` +
          `Point at a FUNCTIONAL_CASES case, a real de-facto golden script, or use golden: STUB (...).`,
      });
      return;
    }
    for (const ref of caseRefs) {
      if (!(ref in FUNCTIONAL_CASES)) {
        violations.push({
          entry: entry.slug,
          severity: 'fail',
          message:
            `golden declares 'primitives-verify.ts#case-${ref}' but no such case exists in FUNCTIONAL_CASES. ` +
            `Fix options: (a) add the functional case + FUNCTIONAL_CASES entry, ` +
            `(b) repoint golden: at the real de-facto golden (e.g. scripts/verify-msg.ts), or ` +
            `(c) use the honest form: golden: STUB (structural-only; de-facto coverage: <pointer or 'none'>).`,
        });
      }
    }
    return;
  }
  // Path form: every path-like token in the value must exist on disk.
  const pathTokens = golden.match(/[A-Za-z0-9_@][A-Za-z0-9_@./\\-]*\.(?:ts|js|mjs|py|java|md)\b/g) ?? [];
  if (pathTokens.length === 0) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message:
        `golden is neither STUB (...), a primitives-verify case reference, nor a script path: '${golden}'`,
    });
    return;
  }
  for (const tok of pathTokens) {
    const candidates = [path.resolve(MCP_ROOT, tok), path.resolve(FRACTAL_MIDI_ROOT, tok)];
    if (!candidates.some((c) => existsSync(c))) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message:
          `golden references '${tok}' which does not exist (tried repo root and packages/fractal-midi/). ` +
          `Repoint at the real file or use golden: STUB (structural-only; de-facto coverage: <pointer or 'none'>).`,
      });
    }
  }
}

/**
 * Every `_negative/` entry must be FINDABLE by the agent about to
 * re-attempt the dead end: a heading naming the symptoms / grep terms is
 * what turns a negative finding from an archive note into a tripwire.
 * Accepted headings match /symptom|grep terms|search terms|when you'd reach/i
 * (the older "Search terms to avoid re-attempting" heading qualifies).
 */
function validateNegativeFindability(entry: PrimitiveEntry, violations: Violation[]): void {
  if (entry.dirCategory !== '_negative') return;
  const headingRe = /symptom|grep terms|search terms|when you['’]d reach/i;
  const hasFindableHeading = entry.body
    .split(/\r?\n/)
    .some((line) => /^#{1,6}\s/.test(line) && headingRe.test(line));
  if (!hasFindableHeading) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message:
        `_negative entry lacks a findability heading (e.g. '## Symptoms / grep terms'). ` +
        `Negative findings must be findable by the agent about to re-attempt the dead end: ` +
        `add a heading matching /symptom|grep terms|search terms|when you'd reach/i with ` +
        `2-4 grep phrases a future agent would search before re-attempting.`,
    });
  }
}

/**
 * `retest_when:` gate for `_negative/` entries. A negative finding is a
 * standing verdict; this field names what would make the verdict worth
 * re-adjudicating. Two legal shapes:
 *   1. Scalar `never (<reason>)` — the verdict is structural / measured /
 *      already re-adjudicated and no future primitive re-opens it.
 *   2. A list of triggers. Each item is either a primitives primitive slug
 *      (kebab-case) or a free-text condition (e.g. 'a VP4-Edit lldb capture
 *      method'). The resolver checks only slug-shaped items that exist in
 *      the live entry set: when such a slug has status matched /
 *      matched-singleton, the trigger has FIRED — warn (fail under
 *      --strict) so the negative gets re-adjudicated or its retest_when
 *      updated. Free-text conditions and not-yet-existing slugs are
 *      skipped by design (they are the pending trigger).
 */
function validateNegativeRetestWhen(
  entry: PrimitiveEntry,
  violations: Violation[],
  statusBySlug: Map<string, string>,
): void {
  if (entry.dirCategory !== '_negative') return;
  const rw = entry.frontmatter.retest_when;
  if (rw === undefined) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message:
        `_negative entry lacks required frontmatter 'retest_when:'. Provide either a list of ` +
        `re-test triggers (primitive slugs / free-text conditions) or the literal form ` +
        `'never (<reason>)'. A negative without a named re-test condition silently rots.`,
    });
    return;
  }
  if (typeof rw === 'string') {
    if (!/^never\s*\(.+\)$/.test(rw.trim())) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message:
          `retest_when scalar must be the literal form 'never (<reason>)'; got '${rw}'. ` +
          `For actual triggers, use the YAML list form (one slug or free-text condition per item).`,
      });
    }
    return;
  }
  if (rw.length === 0) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `retest_when list is empty. Name at least one trigger, or use 'never (<reason>)'.`,
    });
    return;
  }
  for (const item of rw) {
    const isSlugShaped = /^[a-z0-9][a-z0-9-]*$/.test(item);
    if (!isSlugShaped) continue; // free-text condition: resolver skips by design
    const status = statusBySlug.get(item);
    if (status === undefined) continue; // pending trigger: primitive doesn't exist yet
    if (status === 'matched' || status === 'matched-singleton') {
      violations.push({
        entry: entry.slug,
        severity: STRICT ? 'fail' : 'warn',
        message:
          `negative '${entry.slug}' names primitive '${item}' as its re-test trigger and ` +
          `'${item}' now exists with status '${status}' — re-adjudicate the negative against ` +
          `the new primitive, or update retest_when (e.g. to 'never (re-adjudicated <date>; <outcome>)').`,
      });
    }
  }
}

/**
 * INDEX <-> disk drift gate. Two directions, two indexes:
 *   - every main-directory entry slug must appear as a link in INDEX.md,
 *     and every _negative entry slug as a link in _negative/INDEX.md
 *     (an unindexed entry is invisible to the "walk the table" workflow);
 *   - every primitives .md link in either index must resolve to a file on
 *     disk (a dead row sends readers chasing ghosts).
 * _scratch/ and _partial/ entries are exempt (in-flight by definition).
 */
function validateIndexDrift(entries: PrimitiveEntry[], violations: Violation[]): void {
  const indexes: { indexPath: string; category: PrimitiveEntry['dirCategory']; label: string }[] = [
    { indexPath: path.join(PRIMITIVES_ROOT, 'INDEX.md'), category: 'main', label: 'INDEX.md' },
    { indexPath: path.join(PRIMITIVES_ROOT, '_negative', 'INDEX.md'), category: '_negative', label: '_negative/INDEX.md' },
  ];
  for (const { indexPath, category, label } of indexes) {
    if (!existsSync(indexPath)) {
      violations.push({
        entry: label,
        severity: 'fail',
        message: `primitives index file missing on disk: ${indexPath}`,
      });
      continue;
    }
    const src = readFileSync(indexPath, 'utf8');
    const linkTargets = [...src.matchAll(/\]\(([^)\s]+\.md)\)/g)].map((m) => m[1]);
    // Direction 1: every entry in this category is linked from its index.
    for (const e of entries) {
      if (e.dirCategory !== category) continue;
      const linked = linkTargets.some((t) => t === `${e.slug}.md` || t.endsWith(`/${e.slug}.md`));
      if (!linked) {
        violations.push({
          entry: e.slug,
          severity: 'fail',
          message: `entry exists on disk but is not linked from ${label}. Add a table row.`,
        });
      }
    }
    // Direction 2: every .md link in the index resolves on disk.
    for (const t of new Set(linkTargets)) {
      if (/^https?:/.test(t)) continue;
      const abs = path.resolve(path.dirname(indexPath), t);
      if (!existsSync(abs)) {
        violations.push({
          entry: label,
          severity: 'fail',
          message: `index links '${t}' but no such file exists on disk (${abs}). Remove the row or restore the file.`,
        });
      }
    }
  }
}

/**
 * Synthesis-cadence check (WARNING, never build-breaking). The primitives
 * discipline pairs entry growth with periodic synthesis passes in
 * docs/research/synthesis-log/. If the newest main-directory primitive entry is more
 * than STALENESS_DAYS newer than the newest synthesis artifact, cadence
 * rot is underway — surface it prominently so it stops being invisible.
 */
const SYNTHESIS_STALENESS_DAYS = 21;
function checkSynthesisStaleness(entries: PrimitiveEntry[]): string | null {
  const synthRoot = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'synthesis-log');
  if (!existsSync(synthRoot)) {
    return `synthesis-log directory missing at ${synthRoot} — cadence cannot be measured.`;
  }
  let newestSynthMs = 0;
  let newestSynthName = '(none)';
  for (const name of readdirSync(synthRoot)) {
    const full = path.join(synthRoot, name);
    const st = statSync(full);
    if (st.isFile() && st.mtimeMs > newestSynthMs) {
      newestSynthMs = st.mtimeMs;
      newestSynthName = name;
    }
  }
  let newestEntryMs = 0;
  let newestEntrySlug = '(none)';
  for (const e of entries) {
    if (e.dirCategory !== 'main') continue;
    const st = statSync(e.filePath);
    if (st.mtimeMs > newestEntryMs) {
      newestEntryMs = st.mtimeMs;
      newestEntrySlug = e.slug;
    }
  }
  if (newestSynthMs === 0 || newestEntryMs === 0) return null;
  const lagDays = (newestEntryMs - newestSynthMs) / 86_400_000;
  if (lagDays <= SYNTHESIS_STALENESS_DAYS) return null;
  return (
    `newest main-directory primitive entry (${newestEntrySlug}, mtime ${new Date(newestEntryMs).toISOString().slice(0, 10)}) ` +
    `is ${Math.floor(lagDays)} days newer than the newest synthesis-log artifact ` +
    `(${newestSynthName}, mtime ${new Date(newestSynthMs).toISOString().slice(0, 10)}). ` +
    `The primitives corpus has grown for > ${SYNTHESIS_STALENESS_DAYS} days without a synthesis pass — ` +
    `schedule one (docs/research/synthesis-log/). This is a warning, not a build break.`
  );
}

// -----------------------------------------------------------------------------
// Functional fixture cases. Each function returns null on success or an error
// string on failure.
// -----------------------------------------------------------------------------

function caseXor7fEnvelopeChecksum(): string | null {
  // Capture: AM4 set_param amp.gain 0.0 wire prefix
  // f0 00 01 74 15 01 3a 00 0b 00 01 00 00 00 04 00 00 00 00 00 25 f7
  // Folded XOR over all bytes from F0 to (penultimate, i.e. 0x00 just before checksum 0x25)
  // expected checksum = 0x25
  const wire = [
    0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, 0x3a, 0x00, 0x0b, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  let acc = 0;
  for (const b of wire) acc ^= b;
  const cs = acc & 0x7f;
  if (cs !== 0x25) {
    return `AM4 fixture: expected checksum 0x25, got 0x${cs.toString(16).padStart(2, '0')}`;
  }
  // II envelope (verify-msg style, captured): f0 00 01 74 10 01 ... <cs> f7
  // Use a trivial II envelope from the descriptor table primitive entry:
  //   F0 00 01 74 10 76 F7  (fn 0x76 = get firmware version, no payload)
  // checksum byte sits at position len-2 = position 6, so we XOR positions 0..5.
  const ii = [0xf0, 0x00, 0x01, 0x74, 0x07, 0x76];
  let iiAcc = 0;
  for (const b of ii) iiAcc ^= b;
  const iiCs = iiAcc & 0x7f;
  // Sanity: just confirm masked value is < 0x80 and deterministic.
  if (iiCs >= 0x80) {
    return `II fixture: masked checksum should be < 0x80, got 0x${iiCs.toString(16)}`;
  }
  // III envelope: f0 00 01 74 11 ... — same algorithm.
  const iii = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x46];
  let iiiAcc = 0;
  for (const b of iii) iiiAcc ^= b;
  if ((iiiAcc & 0x7f) >= 0x80) {
    return `III fixture: masked checksum should be < 0x80`;
  }
  return null;
}

function caseSeptet14bit(): string | null {
  const encode = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
  const decode = (b0: number, b1: number): number => b0 | (b1 << 7);
  for (const v of [0, 1, 127, 128, 200, 4096, 16383]) {
    const [b0, b1] = encode(v);
    if (b0 >= 0x80 || b1 >= 0x80) {
      return `septet bytes not 7-bit-clean for v=${v}: 0x${b0.toString(16)} 0x${b1.toString(16)}`;
    }
    const d = decode(b0, b1);
    if (d !== v) return `round-trip failed for v=${v}: decoded ${d}`;
  }
  return null;
}

function caseSeptet21bitByte2MaskPreservation(): string | null {
  // Encode a 16-bit ushort value (7 + 7 + 2 = 16 value bits) into 3 wire
  // bytes, preserving the high 5 bits of byte 2 (the firmware-reserved
  // mask). Verify round-trip + mask preservation.
  // Note: the primitive entry is named "septet-21bit" because the WIRE
  // form is 3 septets = 21 wire bits, but the encodable VALUE is 16
  // bits because byte 2 holds only 2 value bits + 5 reserved + 1
  // SysEx-required clear bit.
  const cases: { v: number; originalByte2: number }[] = [
    { v: 0, originalByte2: 0x40 },           // bit 6 of mask set
    { v: 1, originalByte2: 0x7c },           // all reserved bits set
    { v: 0xffff, originalByte2: 0x04 },      // max 16-bit value, single reserved bit
    { v: 0x3456, originalByte2: 0x58 },      // mid-range value + mixed mask
    { v: 0xc000, originalByte2: 0x00 },      // top-2-bits-only, mask zero
  ];
  for (const c of cases) {
    const b0 = c.v & 0x7f;
    const b1 = (c.v >> 7) & 0x7f;
    const b2 = (c.originalByte2 & 0x7c) | ((c.v >> 14) & 0x03);
    if (b0 >= 0x80 || b1 >= 0x80 || b2 >= 0x80) {
      return `bytes not 7-bit-clean for v=0x${c.v.toString(16)}`;
    }
    // Decode the value (low 14 bits of b0/b1 + high 2 bits of b2 & 0x03)
    const decoded = b0 | (b1 << 7) | ((b2 & 0x03) << 14);
    if (decoded !== c.v) {
      return `round-trip value mismatch for v=0x${c.v.toString(16)}, decoded 0x${decoded.toString(16)}`;
    }
    // Verify reserved-bit preservation
    const recoveredMask = b2 & 0x7c;
    const expectedMask = c.originalByte2 & 0x7c;
    if (recoveredMask !== expectedMask) {
      return `reserved-bit preservation failed for v=0x${c.v.toString(16)} origByte2=0x${c.originalByte2.toString(16)}: recovered mask 0x${recoveredMask.toString(16)}, expected 0x${expectedMask.toString(16)}`;
    }
  }
  return null;
}

function caseVendorEnvelopeDescriptorTable(): string | null {
  const jsonPath = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axe-edit-iii-misc-descriptors.descriptors.json',
  );
  if (!existsSync(jsonPath)) {
    return `descriptor JSON not found at ${jsonPath}. ` +
      `Regenerate via the III parse-ghidra-decompile.ts run.`;
  }
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    tables: { address: string; entries: { tag: number; mid: number; byte_count: number }[] }[];
  };
  const target = parsed.tables.find((t) => t.address === '0x1407ab940');
  if (!target) {
    return `headline table 0x1407ab940 not found in III misc-descriptors JSON. ` +
      `The III preset-body envelope shape claim in the primitives corpus is unverified.`;
  }
  // Expected: (tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=3072)
  // The sentinel (-1, -1, -1) is stripped by the parser.
  if (target.entries.length !== 2) {
    return `0x1407ab940 entry count: expected 2, got ${target.entries.length}`;
  }
  const [e0, e1] = target.entries;
  if (!(e0.tag === 0 && e0.mid === 6 && e0.byte_count === 2)) {
    return `0x1407ab940 entry[0]: expected (0, 6, 2), got (${e0.tag}, ${e0.mid}, ${e0.byte_count})`;
  }
  if (!(e1.tag === 1 && e1.mid === 8 && e1.byte_count === 3072)) {
    return `0x1407ab940 entry[1]: expected (1, 8, 3072), got (${e1.tag}, ${e1.mid}, ${e1.byte_count})`;
  }
  // 3072 bytes / 3 bytes-per-ushort = 1024 ushorts — sanity-confirm the claim.
  if ((e1.byte_count / 3) !== 1024) {
    return `0x1407ab940 byte_count=3072 should imply 1024 ushorts; got ${e1.byte_count / 3}`;
  }
  return null;
}

function caseIiiBlockNameStringCascade(): string | null {
  // Negative-finding drift guard. The primitive entry
  // `_negative/iii-block-name-string-cascade.md` claims the III editor
  // binary has NO inline `strcmp(name, "Amp"/"Cab"/"Chorus"/...)` cascade
  // for preset-binary block ordering. If the III dumps are regenerated
  // and the cascade pattern DOES appear, this test fails and forces the
  // primitive entry to be re-classified (promoted to a real transfer or
  // moved to scratch). False-positive guard: `PresetCabBundleImport` is a
  // single known import-function symbol containing "Cab" as a substring
  // — not a block-name string-table reference.
  const dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axe-edit-iii-preset-receiver.txt',
  );
  if (!existsSync(dump)) {
    return `III preset-receiver dump not found at ${dump}. ` +
      `Regenerate via fractal-midi/scripts/ghidra/DumpAxeEditIIIPresetReceiver.java.`;
  }
  const src = readFileSync(dump, 'utf8');
  // Look for `,"<BlockName>"` followed by `)` — the strcmp-style call
  // pattern AEImageDepot uses on II. Quoting the needle keeps it from
  // matching unrelated identifiers like `PresetCab*`.
  const needles = [
    'Amp', 'Cab', 'Chorus', 'Compressor', 'Drive', 'Reverb', 'Flanger',
    'Phaser', 'Delay', 'Pitch', 'Vocoder', 'Tremolo', 'Filter', 'Rotary',
    'QuadChorus', 'Resonator', 'RingMod', 'Synth', 'GateExpander',
    'GraphicEQ', 'ParametricEQ', 'MultibandComp', 'MultiDelay',
    'PanTrem', 'Looper', 'Noisegate',
  ];
  const matches: string[] = [];
  for (const n of needles) {
    // Pattern: ,"Name") — strcmp-style call argument
    const re = new RegExp(`,\\s*"${n}"\\s*\\)`, 'g');
    const hits = src.match(re);
    if (hits && hits.length > 0) {
      matches.push(`${n} (${hits.length} hits)`);
    }
  }
  if (matches.length > 0) {
    return `primitives negative-finding CONTRADICTED: III preset-receiver dump ` +
      `now contains strcmp-style block-name cascade matches: ${matches.join(', ')}. ` +
      `Update _negative/iii-block-name-string-cascade.md (promote to transfer or scratch).`;
  }
  return null;
}

function caseIiiByteStreamSeptetPack8to7(): string | null {
  // 8-to-7-bit byte-stream septet packer per FUN_14033f2d0 in
  // ghidra-axe-edit-iii-store-preset.txt (L1278-1317). Each output byte
  // is 7-bit clean; output size = ceil(N * 8 / 7).
  const pack = (input: readonly number[]): number[] => {
    const N = input.length;
    if (N === 0) return [0];
    const out: number[] = [];
    let inIdx = 0;
    let bitsConsumed = 1;
    let carry = 0;
    while (inIdx < N) {
      if (bitsConsumed === 8) {
        out.push(carry & 0x7f);
        bitsConsumed = 1;
        carry = 0;
      } else {
        const b = input[inIdx] & 0xff;
        out.push(((b >> bitsConsumed) | carry) & 0x7f);
        const mask = (1 << bitsConsumed) - 1;
        carry = (b & mask) << (7 - bitsConsumed);
        bitsConsumed += 1;
        inIdx += 1;
      }
    }
    out.push(carry & 0x7f);
    return out;
  };
  const fixtures: { input: number[]; expected: number[] }[] = [
    // N=1: input=[0xFF] → output high 7 bits as 0x7F, low 1 bit shifted to position 6 = 0x40
    { input: [0xff], expected: [0x7f, 0x40] },
    // N=2: hand-trace input=[0xAA, 0x55]
    //   iter 1 (bc=1): out[0] = (0xAA >> 1) = 0x55; carry = (0xAA & 0x01) << 6 = 0
    //   iter 2 (bc=2): out[1] = ((0x55 >> 2) | 0) = 0x15; carry = (0x55 & 0x03) << 5 = 0x20
    //   final flush: out[2] = 0x20
    { input: [0xaa, 0x55], expected: [0x55, 0x15, 0x20] },
    // N=7: all-zero input → all-zero output of size 8 (the boundary where no carry-flush fires)
    { input: [0, 0, 0, 0, 0, 0, 0], expected: [0, 0, 0, 0, 0, 0, 0, 0] },
    // N=8: all-zero input → all-zero output of size 10 (one carry-flush iteration between input 7 and 8)
    { input: [0, 0, 0, 0, 0, 0, 0, 0], expected: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ];
  for (const fx of fixtures) {
    const expectedSize = fx.input.length === 0 ? 1 : Math.ceil((fx.input.length * 8) / 7);
    if (fx.expected.length !== expectedSize) {
      return `fixture-size sanity fail for N=${fx.input.length}: expected ${expectedSize}, got ${fx.expected.length}`;
    }
    const got = pack(fx.input);
    if (got.length !== fx.expected.length) {
      return `pack length mismatch for N=${fx.input.length}: expected ${fx.expected.length}, got ${got.length}`;
    }
    for (let i = 0; i < got.length; i++) {
      if (got[i] & 0x80) {
        return `pack output byte ${i} not 7-bit-clean: 0x${got[i].toString(16)}`;
      }
      if (got[i] !== fx.expected[i]) {
        return `pack output mismatch for N=${fx.input.length} at byte ${i}: expected 0x${fx.expected[i].toString(16)}, got 0x${got[i].toString(16)}`;
      }
    }
  }
  // Output-size formula spot-check: N=14 → 16, N=15 → 18 (one extra flush)
  if (pack(new Array(14).fill(0xff)).length !== 16) {
    return `N=14 expected output size 16, got ${pack(new Array(14).fill(0xff)).length}`;
  }
  if (pack(new Array(15).fill(0xff)).length !== 18) {
    return `N=15 expected output size 18, got ${pack(new Array(15).fill(0xff)).length}`;
  }
  return null;
}

function caseXorFoldHash(): string | null {
  // Trivial XOR-fold over a known ushort array; the algorithm matches
  // FUN_00544cc0 from AxeEdit II.
  const xorFold = (us: number[]): number => {
    let acc = 0;
    for (const u of us) acc ^= u & 0xffff;
    return acc & 0xffff;
  };
  // Hand-computed: [0x0001, 0x0002, 0x0003] -> 0x0001 ^ 0x0002 ^ 0x0003 = 0x0000
  if (xorFold([0x0001, 0x0002, 0x0003]) !== 0x0000) {
    return `XOR-fold {1,2,3} expected 0x0000, got 0x${xorFold([1, 2, 3]).toString(16)}`;
  }
  // [0x1234, 0x5678] -> 0x444C
  if (xorFold([0x1234, 0x5678]) !== 0x444c) {
    return `XOR-fold {0x1234,0x5678} expected 0x444C, got 0x${xorFold([0x1234, 0x5678]).toString(16)}`;
  }
  // Empty -> 0
  if (xorFold([]) !== 0) return `XOR-fold empty array expected 0`;
  return null;
}

function caseEditorCacheSectionRecordGrammar(): string | null {
  // Synthetic effectDefinitions cache slice exercising the full record
  // grammar: one section header, one float record, one enum record.
  // Grammar per the primitive entry: section = [u32 tag][u32 count];
  // record = [u16 id][u16 tc][u16 pad=0][f32 min][f32 max][f32 scale]
  // [f32 step] + enumTail(u32 count + LP strings + u32 x + u16 0) or
  // floatTail(u32 t1 + u32 t2 + u16 0). Values mirror the FM9 REVERB
  // hardware anchors (paramId 11 = 0.1..100 step 0.02; type enum at 10).
  const parts: Buffer[] = [];
  const u16b = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32b = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const f32b = (v: number) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
  const lp = (s: string) => Buffer.concat([u32b(s.length), Buffer.from(s, 'ascii')]);
  parts.push(u32b(12), u32b(2)); // section tag 12 (REVERB), 2 records
  // enum record: id=10 tc=0x010, (min,max,scale,step)=(0,1,0,0), 2 values, x=0x8000
  parts.push(u16b(10), u16b(0x010), u16b(0), f32b(0), f32b(1), f32b(0), f32b(0),
    u32b(2), lp('Small Room'), lp('Medium Spring'), u32b(0x8000), u16b(0));
  // float record: id=11 tc=0x332, (0.1, 100, 1, 0.02), tail (0, 1, 0)
  parts.push(u16b(11), u16b(0x332), u16b(0), f32b(0.1), f32b(100), f32b(1), f32b(0.02),
    u32b(0), u32b(1), u16b(0));
  const buf = Buffer.concat(parts);

  // Strict walk (no resync): mirrors parse-effectdefinitions-cache.ts logic.
  let off = 0;
  const tag = buf.readUInt32LE(off); const count = buf.readUInt32LE(off + 4); off += 8;
  if (tag !== 12 || count !== 2) return `section header parse failed: tag=${tag} count=${count}`;
  const recs: Array<{ id: number; tc: number; kind: string; values?: string[]; min?: number; max?: number; step?: number }> = [];
  for (let i = 0; i < count; i++) {
    const id = buf.readUInt16LE(off); const tc = buf.readUInt16LE(off + 2);
    if (buf.readUInt16LE(off + 4) !== 0) return `record ${i}: pad != 0`;
    const min = buf.readFloatLE(off + 6); const max = buf.readFloatLE(off + 10);
    const step = buf.readFloatLE(off + 18);
    // enum probe: u32 count + LP strings parsing cleanly
    let p = off + 22;
    const c = buf.readUInt32LE(p);
    let isEnum = c >= 1 && c <= 4096;
    const values: string[] = [];
    if (isEnum) {
      let q = p + 4;
      for (let k = 0; k < c; k++) {
        if (q + 4 > buf.length) { isEnum = false; break; }
        const len = buf.readUInt32LE(q);
        if (len < 1 || len > 64 || q + 4 + len > buf.length) { isEnum = false; break; }
        values.push(buf.toString('ascii', q + 4, q + 4 + len));
        q = q + 4 + len;
      }
      if (isEnum) {
        if (buf.readUInt16LE(q + 4) !== 0) return `record ${i}: enum trailer u16 != 0`;
        recs.push({ id, tc, kind: 'enum', values });
        off = q + 6;
        continue;
      }
    }
    if (buf.readUInt16LE(off + 30) !== 0) return `record ${i}: float tail u16 != 0`;
    recs.push({ id, tc, kind: 'float', min, max, step });
    off += 32;
  }
  if (off !== buf.length) return `walk did not consume buffer exactly: ${off} vs ${buf.length}`;
  const en = recs[0];
  if (en.kind !== 'enum' || en.id !== 10 || en.values?.[1] !== 'Medium Spring') {
    return `enum record mismatch: ${JSON.stringify(en)}`;
  }
  const fl = recs[1];
  if (fl.kind !== 'float' || fl.id !== 11 || Math.abs((fl.min ?? 0) - 0.1) > 1e-6 ||
      fl.max !== 100 || Math.abs((fl.step ?? 0) - 0.02) > 1e-6 || fl.tc !== 0x332) {
    return `float record mismatch: ${JSON.stringify(fl)}`;
  }
  return null;
}

function casePerEffectParamtableDispatcher(): string | null {
  const iiiDump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axeedit3-paramtables-v2.txt',
  );
  if (!existsSync(iiiDump)) {
    return `III paramtables dump not found at ${iiiDump}. ` +
      `Regenerate via fractal-midi/scripts/ghidra/DumpAxeEditIIIParamTablesV2.java.`;
  }
  const iii = readFileSync(iiiDump, 'utf8');
  if (!iii.includes('FUN_140397a40')) {
    return `III dump header does not name FUN_140397a40 dispatcher; ` +
      `expected per the V2 script header.`;
  }
  const distinctTablesMatch = iii.match(/Total distinct tables read:\s*(\d+)/);
  if (!distinctTablesMatch) {
    return `III dump summary missing 'Total distinct tables read'.`;
  }
  const distinctTables = parseInt(distinctTablesMatch[1], 10);
  if (distinctTables < 40) {
    return `III dump distinct table count ${distinctTables} below threshold 40 ` +
      `(expected 49 per V2 script CASE_TO_DAT).`;
  }
  const entriesMatch = iii.match(/Total parameter-ID entries[^:]*:\s*(\d+)/);
  if (!entriesMatch) {
    return `III dump summary missing 'Total parameter-ID entries'.`;
  }
  const entries = parseInt(entriesMatch[1], 10);
  if (entries < 2000) {
    return `III dump entry count ${entries} below threshold 2000 ` +
      `(expected 2216 per dispatcher walk).`;
  }
  const am4Dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-am4edit-paramtables.txt',
  );
  if (!existsSync(am4Dump)) {
    return `AM4 paramtables dump not found at ${am4Dump}; ` +
      `the AM4 dispatcher axis is the second device family for matched status.`;
  }
  const am4SysexMap = path.join(
    FRACTAL_MIDI_ROOT,
    'docs',
    'devices',
    'am4',
    'SYSEX-MAP.md',
  );
  if (!existsSync(am4SysexMap)) {
    return `AM4 SYSEX-MAP not found at ${am4SysexMap}; ` +
      `cross-device dispatcher table cite is broken.`;
  }
  const sysexMap = readFileSync(am4SysexMap, 'utf8');
  if (!sysexMap.includes('FUN_1402e3da0') || !sysexMap.includes('FUN_140397a40')) {
    return `AM4 SYSEX-MAP missing the cross-device dispatcher fn-byte cite ` +
      `(FUN_1402e3da0 / FUN_140397a40 pair).`;
  }
  return null;
}

function caseIiiParamidPseudoSentinelRanges(): string | null {
  const dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axeedit3-paramtables-v2.txt',
  );
  if (!existsSync(dump)) {
    return `III paramtables dump not found at ${dump}.`;
  }
  const src = readFileSync(dump, 'utf8');
  const pseudoCodes = new Set<number>();
  const lines = src.split(/\r?\n/);
  let inParamList = false;
  let currentCase = -1;
  for (const line of lines) {
    if (/^## case 0x[0-9a-fA-F]+/.test(line)) {
      const m = line.match(/0x([0-9a-fA-F]+)/);
      currentCase = m ? parseInt(m[1], 16) : -1;
      inParamList = false;
      continue;
    }
    if (line.includes('paramIds:')) {
      inParamList = true;
    }
    if (line.includes('first metadata ptr')) {
      inParamList = false;
    }
    if (!inParamList) continue;
    const nums = line.match(/\b(\d+)\b/g);
    if (!nums) continue;
    for (const n of nums) {
      const v = parseInt(n, 10);
      if (v >= 0xFF00 && v <= 0xFFFE) {
        pseudoCodes.add(v);
      }
    }
  }
  if (pseudoCodes.size < 3) {
    return `expected ≥3 distinct 0xFFFx pseudo-sentinel paramIds in non-terminator ` +
      `position; found ${pseudoCodes.size}: ${[...pseudoCodes].sort((a, b) => a - b).join(', ')}.`;
  }
  if (!src.includes('Param-ID range observed: 0 .. 65530')) {
    return `III dump summary missing exact line 'Param-ID range observed: 0 .. 65530'; ` +
      `the high-end pseudo-sentinel marker has shifted, re-read the entry.`;
  }
  return null;
}

function caseIiStateBroadcastTripleWrite(): string | null {
  // Verify the state-broadcast triple envelope shape: header (0x74) + chunk (0x75) + footer (0x76).
  // Inline implementation mirrors buildStateBroadcastTripleMessages.
  const MODEL = 0x07;
  const MFR = [0x00, 0x01, 0x74];
  function cksum(bytes: number[]): number { return bytes.reduce((a, b) => a ^ b, 0) & 0x7f; }
  function env(fn: number, payload: number[]): number[] {
    const head = [0xf0, ...MFR, MODEL, fn, ...payload];
    return [...head, cksum(head), 0xf7];
  }
  function enc14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
  function pack16(v: number): [number, number, number] { return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03]; }

  // Fixture: targetId=127 (Volume/Pan 1), 9 values from session-58 capture.
  const targetId = 127;
  const values = [65534, 32767, 2, 0, 0, 65534, 52427, 0, 0];
  const opFlag = 0x01;

  const header = env(0x74, [...enc14(targetId), ...enc14(values.length), opFlag]);
  const chunkBody: number[] = [];
  for (const v of values) chunkBody.push(...pack16(v));
  const chunk = env(0x75, [...enc14(values.length), ...chunkBody]);
  const footer = env(0x76, []);

  // Structural checks.
  if (header[5] !== 0x74) return `header fn should be 0x74`;
  if (header[6] !== 0x7f || header[7] !== 0x00) return `targetId encoding wrong`;
  if (header[8] !== 0x09 || header[9] !== 0x00) return `itemCount encoding wrong`;
  if (header[10] !== 0x01) return `opFlag should be 0x01`;
  if (chunk[5] !== 0x75) return `chunk fn should be 0x75`;
  if (footer[5] !== 0x76) return `footer fn should be 0x76`;
  // Value round-trip: first value 65534 = pack16([0x7E, 0x7F, 0x03]).
  const payloadStart = 8; // F0 MFR MODEL 75 countLo countHi → payload at byte 8
  const b0 = chunk[payloadStart], b1 = chunk[payloadStart + 1], b2 = chunk[payloadStart + 2];
  const decoded = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
  if (decoded !== 65534) return `first value round-trip: expected 65534, got ${decoded}`;
  // Last value round-trip: value[8]=0 should pack as [0,0,0].
  const lastOff = payloadStart + 8 * 3;
  const lastDecoded = (chunk[lastOff] & 0x7f) | ((chunk[lastOff + 1] & 0x7f) << 7) | ((chunk[lastOff + 2] & 0x03) << 14);
  if (lastDecoded !== 0) return `last value round-trip: expected 0, got ${lastDecoded}`;
  // Checksum validity.
  const csIdx = header.length - 2;
  const expectedCs = cksum(header.slice(0, csIdx));
  if (header[csIdx] !== expectedCs) return `header checksum mismatch`;
  return null;
}

function caseIiCompressorCalibrationDivergence(): string | null {
  // Hardware-verified 2026-05-27, Axe-Fx II XL+ Ares 2.00.
  // Four compressor params with known wire values and device-displayed results.
  //
  // Log10 formula: display = min * (max / min) ^ (wire / 65534)
  // Linear formula: display = min + (max - min) * (wire / 65534)
  const WIRE_MAX = 65534;

  // --- threshold: linear, -80..0 dB ---
  // Wire 47512 -> device "-22.0 dB"
  // Wire 32767 -> device "-40.0 dB"
  const threshMin = -80, threshMax = 0;
  const threshDisplay1 = threshMin + (threshMax - threshMin) * (47512 / WIRE_MAX);
  // Expected: -22.0 dB (device rounds to 1 decimal)
  if (Math.abs(threshDisplay1 - (-22.0)) > 0.1) {
    return `threshold wire=47512: expected ~-22.0, got ${threshDisplay1.toFixed(1)}`;
  }
  const threshDisplay2 = threshMin + (threshMax - threshMin) * (32767 / WIRE_MAX);
  // Expected: -40.0 dB
  if (Math.abs(threshDisplay2 - (-40.0)) > 0.1) {
    return `threshold wire=32767: expected ~-40.0, got ${threshDisplay2.toFixed(1)}`;
  }

  // --- ratio: log10, 1..20 ---
  // Wire 30326 -> device "4.000"
  const ratioMin = 1, ratioMax = 20;
  const ratioDisplay = ratioMin * Math.pow(ratioMax / ratioMin, 30326 / WIRE_MAX);
  if (Math.abs(ratioDisplay - 4.0) > 0.05) {
    return `ratio wire=30326: expected ~4.0, got ${ratioDisplay.toFixed(3)}`;
  }

  // --- attack: log10, 1..100 ms ---
  // Wire 32767 -> device "10.00 ms" (geometric midpoint of 1*100 = 10)
  const atkMin = 1, atkMax = 100;
  const atkDisplay = atkMin * Math.pow(atkMax / atkMin, 32767 / WIRE_MAX);
  if (Math.abs(atkDisplay - 10.0) > 0.15) {
    return `attack wire=32767: expected ~10.0, got ${atkDisplay.toFixed(2)}`;
  }

  // --- release: log10, 10..1000 ms ---
  // Wire 32767 -> device "100.0 ms" (geometric midpoint of 10*1000 = 100)
  const relMin = 10, relMax = 1000;
  const relDisplay = relMin * Math.pow(relMax / relMin, 32767 / WIRE_MAX);
  if (Math.abs(relDisplay - 100.0) > 1.5) {
    return `release wire=32767: expected ~100.0, got ${relDisplay.toFixed(1)}`;
  }

  // --- Cross-check: AM4 ranges would give WRONG answers ---
  // AM4 threshold is -60..+20. If we used AM4 range on wire=47512,
  // we'd get -60 + 80 * (47512/65534) = -2.0, not -22.0.
  const am4ThreshDisplay = -60 + (20 - (-60)) * (47512 / WIRE_MAX);
  if (Math.abs(am4ThreshDisplay - (-22.0)) < 1.0) {
    return `AM4 threshold range should NOT produce -22.0 but got ${am4ThreshDisplay.toFixed(1)} ` +
      `(divergence guard failed)`;
  }
  // AM4 attack is 0.1..100 ms. Midpoint wire=32767 -> sqrt(0.1*100) = 3.16, not 10.
  const am4AtkDisplay = 0.1 * Math.pow(100 / 0.1, 32767 / WIRE_MAX);
  if (Math.abs(am4AtkDisplay - 10.0) < 1.0) {
    return `AM4 attack range should NOT produce 10.0 but got ${am4AtkDisplay.toFixed(2)} ` +
      `(divergence guard failed)`;
  }

  // --- comp: linear, 0..10 (AM4-matching, hardware-verified 2026-05-27) ---
  // Wire 0->"0.00", wire 32767->"5.00", wire 65534->"10.00"
  const compMin = 0, compMax = 10;
  const compMid = compMin + (compMax - compMin) * (32767 / WIRE_MAX);
  if (Math.abs(compMid - 5.0) > 0.1) {
    return `comp wire=32767: expected ~5.0, got ${compMid.toFixed(2)}`;
  }

  // --- filter: log10, 10..1000 Hz (editor-observed, no AM4 sibling) ---
  // Wire 0->"10.00 Hz", wire 32767->"100.0 Hz", wire 65534->"1000 Hz"
  const filtMin = 10, filtMax = 1000;
  const filtMid = filtMin * Math.pow(filtMax / filtMin, 32767 / WIRE_MAX);
  if (Math.abs(filtMid - 100.0) > 1.5) {
    return `filter wire=32767: expected ~100.0, got ${filtMid.toFixed(1)}`;
  }

  // --- look_ahead: linear, 0..2 ms (AM4-matching) ---
  // Wire 0->"0.000 ms", wire 32767->"1.000 ms", wire 65534->"2.000 ms"
  const laMin = 0, laMax = 2;
  const laMid = laMin + (laMax - laMin) * (32767 / WIRE_MAX);
  if (Math.abs(laMid - 1.0) > 0.01) {
    return `look_ahead wire=32767: expected ~1.0, got ${laMid.toFixed(3)}`;
  }

  return null;
}

function caseIiFn16GetParamInfo(): string | null {
  // fn 0x16 GET_PARAM_INFO 25-byte payload: 5 groups of 5 plain-LE septets,
  // each a 32-bit value. G0 int current, G1/G2/G3 float32, G4 reserved int.
  // Two captured AMP 1 samples (paramId=0 enum, paramId=10 knob).
  const enumPayload = [
    0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x12, 0x1c, 0x04, 0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const knobPayload = [
    0x41, 0x10, 0x00, 0x00, 0x00, 0x2c, 0x0b, 0x1f, 0x39, 0x03, 0x0a, 0x2e,
    0x0f, 0x61, 0x03, 0x00, 0x48, 0x50, 0x4b, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const unpack5 = (p: readonly number[], g: number): number =>
    (((p[g * 5] & 0x7f) |
      ((p[g * 5 + 1] & 0x7f) << 7) |
      ((p[g * 5 + 2] & 0x7f) << 14) |
      ((p[g * 5 + 3] & 0x7f) << 21) |
      ((p[g * 5 + 4] & 0x7f) << 28)) >>> 0);
  const pack5 = (u: number): number[] => {
    const n = u >>> 0;
    return [n & 0x7f, (n >>> 7) & 0x7f, (n >>> 14) & 0x7f, (n >>> 21) & 0x7f, (n >>> 28) & 0x0f];
  };
  const f32bits = (v: number): number => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    return new DataView(buf).getUint32(0, true);
  };
  const asF32 = (u: number): number => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, u >>> 0, true);
    return new DataView(buf).getFloat32(0, true);
  };
  if (enumPayload.length !== 25 || knobPayload.length !== 25) {
    return `fn 0x16 payloads must be 25 bytes`;
  }
  // Enum sample: G0=16, G1=0.0, G2=265.0, G3=1.0, G4=0.
  if (unpack5(enumPayload, 0) !== 16) return `enum G0 expected 16, got ${unpack5(enumPayload, 0)}`;
  if (asF32(unpack5(enumPayload, 1)) !== 0) return `enum G1 expected 0.0`;
  if (asF32(unpack5(enumPayload, 2)) !== 265) return `enum G2 expected 265.0, got ${asF32(unpack5(enumPayload, 2))}`;
  if (asF32(unpack5(enumPayload, 3)) !== 1) return `enum G3 expected 1.0`;
  if (unpack5(enumPayload, 4) !== 0) return `enum G4 expected 0`;
  // Knob sample: G0=2113, G1~1e-5, G2~0.01, G3=1e6, G4=0.
  if (unpack5(knobPayload, 0) !== 2113) return `knob G0 expected 2113, got ${unpack5(knobPayload, 0)}`;
  if (Math.abs(asF32(unpack5(knobPayload, 1)) - 1e-5) > 1e-9) return `knob G1 expected ~1e-5, got ${asF32(unpack5(knobPayload, 1))}`;
  if (Math.abs(asF32(unpack5(knobPayload, 2)) - 0.01) > 1e-6) return `knob G2 expected ~0.01, got ${asF32(unpack5(knobPayload, 2))}`;
  if (asF32(unpack5(knobPayload, 3)) !== 1e6) return `knob G3 expected 1e6, got ${asF32(unpack5(knobPayload, 3))}`;
  if (unpack5(knobPayload, 4) !== 0) return `knob G4 expected 0`;
  // Byte-exact re-encode of the enum sample from decoded group values.
  const reencode = [
    ...pack5(16),
    ...pack5(f32bits(0)),
    ...pack5(f32bits(265)),
    ...pack5(f32bits(1)),
    ...pack5(0),
  ];
  for (let i = 0; i < 25; i++) {
    if (reencode[i] !== enumPayload[i]) {
      return `enum re-encode drift at byte ${i}: expected 0x${enumPayload[i].toString(16)}, got 0x${reencode[i].toString(16)}`;
    }
  }
  return null;
}

function caseIiFn0eQueryStates(): string | null {
  // fn 0x0E QUERY_STATES response: 62-byte capture for an 11-block preset.
  // Payload (bytes 6..len-2; no trailing checksum) tiles into 5-byte records.
  const frame = [
    0xf0, 0x00, 0x01, 0x74, 0x07, 0x0e,
    0x03, 0x4a, 0x10, 0x53, 0x06,
    0x03, 0x4e, 0x18, 0x63, 0x06,
    0x02, 0x52, 0x20, 0x23, 0x07,
    0x02, 0x56, 0x00, 0x20, 0x06,
    0x02, 0x5e, 0x28, 0x03, 0x07,
    0x02, 0x62, 0x30, 0x2b, 0x78,
    0x02, 0x70, 0x38, 0x33, 0x07,
    0x02, 0x0a, 0x7d, 0x17, 0x07,
    0x03, 0x26, 0x51, 0x73, 0x06,
    0x02, 0x2c, 0x75, 0x43, 0x07,
    0x02, 0x42, 0x59, 0x63, 0x07,
    0xf7,
  ];
  if (frame.length !== 62) return `fn 0x0E frame must be 62 bytes, got ${frame.length}`;
  const payload = frame.slice(6, frame.length - 1);
  if (payload.length % 5 !== 0) {
    return `fn 0x0E payload length ${payload.length} not a multiple of 5`;
  }
  const records = payload.length / 5;
  if (records !== 11) return `fn 0x0E expected 11 records, got ${records}`;
  // Re-emit [tag, ...septets] and confirm byte-exact match to the payload.
  const reemit: number[] = [];
  for (let i = 0; i + 5 <= payload.length; i += 5) {
    reemit.push(payload[i], payload[i + 1], payload[i + 2], payload[i + 3], payload[i + 4]);
  }
  for (let i = 0; i < payload.length; i++) {
    if (reemit[i] !== payload[i]) {
      return `fn 0x0E re-emit drift at byte ${i}: expected 0x${payload[i].toString(16)}, got 0x${reemit[i].toString(16)}`;
    }
  }
  return null;
}

function caseIiFn07ModifierRead(): string | null {
  // fn 0x07 modifier read reply frames, captured live (Ares 2.00, XL+):
  //   F0 00 01 74 07 07 [effId:2][slot:2][field:2][value:3][ascii NUL][cs] F7
  // value = v0 | v1<<7 | (v2&3)<<14 (packValue16).
  const dec14 = (lo: number, hi: number) => lo | (hi << 7);
  const dec16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
  function parse(frame: number[]): { effId: number; slot: number; field: number; value: number; label: string } {
    let label = '';
    for (let i = 15; i < frame.length - 2; i++) { if (frame[i] === 0x00) break; label += String.fromCharCode(frame[i]); }
    return { effId: dec14(frame[6], frame[7]), slot: dec14(frame[8], frame[9]), field: dec14(frame[10], frame[11]), value: dec16(frame[12], frame[13], frame[14]), label };
  }
  // field 0x00 = source: value 1 = "LFO 1A"
  const src = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x4c, 0x46, 0x4f, 0x20, 0x31, 0x41, 0x00, 0x7a, 0xf7]);
  if (!(src.effId === 106 && src.field === 0 && src.value === 1 && src.label === 'LFO 1A')) {
    return `fn07 source frame: got ${JSON.stringify(src)}`;
  }
  // field 0x02 = max: value 65534 = "10.00"
  const max = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x02, 0x00, 0x7e, 0x7f, 0x03, 0x31, 0x30, 0x2e, 0x30, 0x30, 0x00, 0x41, 0xf7]);
  if (!(max.field === 2 && max.value === 65534 && max.label === '10.00')) return `fn07 max frame: got ${JSON.stringify(max)}`;
  // field 0x08 = target effectId 106; field 0x09 = target paramId 1
  const tEff = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x08, 0x00, 0x6a, 0x00, 0x00, 0x00, 0x0c, 0xf7]);
  if (!(tEff.field === 8 && tEff.value === 106)) return `fn07 target-effId frame: got ${JSON.stringify(tEff)}`;
  const tPid = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x09, 0x00, 0x01, 0x00, 0x00, 0x00, 0x66, 0xf7]);
  if (!(tPid.field === 9 && tPid.value === 1)) return `fn07 target-paramId frame: got ${JSON.stringify(tPid)}`;
  return null;
}

function caseGen3Fn1fPollBlockBulkRead(): string | null {
  // Self-contained reimplementation of the gen-3 fn=0x1F poll + positional
  // 0x74/0x75/0x76 burst assembly (see fractal-midi/src/gen3/axe-fx-iii/setParam.ts).
  const xor7f = (bytes: readonly number[]): number => {
    let x = 0;
    for (const b of bytes) x ^= b;
    return x & 0x7f;
  };
  const enc14 = (n: number): [number, number] => [n & 0x7f, (n >> 7) & 0x7f];
  // High septet is 2 bits wide, matching production packValue16/unpackValue16.
  const packValue16 = (v: number): [number, number, number] => [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03];
  const unpack = (lo: number, mid: number, hi: number): number => (lo & 0x7f) | ((mid & 0x7f) << 7) | ((hi & 0x03) << 14);
  const frame = (model: number, fn: number, payload: number[]): number[] => {
    const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
    return [...body, xor7f(body), 0xf7];
  };

  // 1. Poll shape: 10 bytes, fn=0x1F, effectId septet-LE, valid checksum.
  const poll = frame(0x12, 0x1f, [...enc14(66)]);
  if (poll.length !== 10) return `poll length ${poll.length} ≠ 10`;
  if (poll[5] !== 0x1f) return `poll fn byte 0x${poll[5].toString(16)} ≠ 0x1f`;
  if (poll[6] !== 66 || poll[7] !== 0) return `poll effectId bytes ${poll[6]},${poll[7]} ≠ 66,0`;
  if (poll[poll.length - 2] !== xor7f(poll.slice(0, -2))) return 'poll checksum mismatch';

  // 2. Frame paging: two 0x75 sections concatenate in arrival order into one
  //    positional value array. (The reader then indexes it channel-blocked,
  //    index = channel × stride + paramId; that projection is tested in
  //    verify-response-shape-parity / verify-fractal-gen3-family, not here —
  //    this golden asserts only the transport-level concatenation.)
  // HEAD is 12 bytes: payload is <eid:14b><itemCount:14b> only — NO flag byte
  // (the byte before F7 is the checksum). FM9-confirmed 2026-06-04.
  const head = frame(0x12, 0x74, [...enc14(66), ...enc14(6)]);
  if (head.length !== 12) return `0x74 head length ${head.length} ≠ 12 (no flag byte)`;
  const body0 = frame(0x12, 0x75, [0x00, 0x02, ...packValue16(10), ...packValue16(20), ...packValue16(30), ...packValue16(40)]);
  const body1 = frame(0x12, 0x75, [0x01, 0x02, ...packValue16(50), ...packValue16(524)]);
  const end = frame(0x12, 0x76, []);

  const isFn = (b: readonly number[], fn: number): boolean =>
    b[0] === 0xf0 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x74 && b[4] === 0x12 && b[5] === fn;
  const values: number[] = [];
  let blockId: number | undefined;
  for (const f of [head, body0, body1, end]) {
    if (isFn(f, 0x74)) blockId = (f[6] & 0x7f) | ((f[7] & 0x7f) << 7);
    else if (isFn(f, 0x75)) {
      for (let i = 8; i + 3 <= f.length - 2; i += 3) values.push(unpack(f[i], f[i + 1], f[i + 2]));
    }
  }
  if (blockId !== 66) return `assembled blockId ${blockId} ≠ 66`;
  const want = [10, 20, 30, 40, 50, 524];
  if (JSON.stringify(values) !== JSON.stringify(want)) {
    return `positional values ${JSON.stringify(values)} ≠ ${JSON.stringify(want)}`;
  }
  return null;
}

// gen-3 fn=0x03 REQUEST_PRESET_DUMP: big-endian preset number + trailing 0x00,
// byte-exact against the FM9 capture (preset 49 = f0 00 01 74 12 03 00 31 00 25 f7).
function caseGen3Fn03RequestPresetDump(): string | null {
  const xor7f = (b: readonly number[]): number => b.reduce((x, c) => x ^ c, 0) & 0x7f;
  const build = (n: number, model = 0x12): number[] => {
    const body = [0xf0, 0x00, 0x01, 0x74, model, 0x03, (n >> 7) & 0x7f, n & 0x7f, 0x00];
    return [...body, xor7f(body), 0xf7];
  };
  const want49 = [0xf0, 0x00, 0x01, 0x74, 0x12, 0x03, 0x00, 0x31, 0x00, 0x25, 0xf7];
  const p49 = build(49);
  if (JSON.stringify(p49) !== JSON.stringify(want49)) {
    return `preset 49 bytes ${p49.map((x) => x.toString(16)).join(' ')} ≠ captured`;
  }
  const p444 = build(444); // (3<<7)|60; little-endian misread would be 7683
  if (p444[6] !== 3 || p444[7] !== 60) return `preset 444 BE bytes ${p444[6]},${p444[7]} ≠ 3,60`;
  return null;
}

// gen-3 enum labels cross the wire septet-packed; the stream is byte-5 aligned.
// Uses the real FM9 capture3 reverb SET-echo frames. The discrete SET value is a
// 5-septet LE float32 at pos 12 = ordinal 16 ("Medium Spring"). The old "raw-id
// 524" was a pos-15 packValue16 MISREAD of that float (retired 2026-06-08).
const FM9_REVERB524_IN_HEX =
  'f0 00 01 74 12 01 09 00 42 00 0a 00 20 1a 48 72 03 00 00 20 00 26 59 2c 46 4b 55 5a ' +
  '20 29 5c 0e 26 4b 39 4e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 64 f7';
const FM9_REVERB524_OUT_HEX =
  'f0 00 01 74 12 01 09 00 42 00 0a 00 00 00 00 0c 04 00 00 00 00 5f f7';
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}
function septetUnpack8to7(septets: readonly number[]): number[] {
  let acc = 0, bits = 0; const out: number[] = [];
  for (const s of septets) {
    acc = (acc << 7) | (s & 0x7f); bits += 7;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}
function unpackAsciiAtOffset(frame: readonly number[], offset: number): string {
  const stream = frame.slice(offset, frame.length - 2);
  return septetUnpack8to7(stream).map((c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.')).join('');
}
function caseGen3EnumLabelSeptetStream(): string | null {
  const inFrame = parseHex(FM9_REVERB524_IN_HEX);
  const at5 = unpackAsciiAtOffset(inFrame, 5);
  if (!at5.includes('Medium Spring')) return `byte-5 unpack missing "Medium Spring": ${at5}`;
  return null;
}
function caseGen3SetEchoFloat32Ordinal(): string | null {
  const out = parseHex(FM9_REVERB524_OUT_HEX);
  // The SET value is a 5-septet LE float32 at pos 12 (bytes 12..16), NOT a
  // packValue16 at pos 15. Reassemble u32 from the 5 septets and reinterpret.
  let u = 0;
  for (let i = 0; i < 5; i++) u |= (out[12 + i] & 0x7f) << (7 * i);
  const f = new DataView(new Uint8Array([u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff]).buffer).getFloat32(0, true);
  if (f !== 16) return `OUT float32@pos12 ${f} ≠ 16 (Medium Spring ordinal)`;
  // The IN echo carries the label septet-packed from byte 5.
  const name = unpackAsciiAtOffset(parseHex(FM9_REVERB524_IN_HEX), 5);
  if (!name.includes('Medium Spring')) return `IN echo name missing "Medium Spring": ${name}`;
  return null;
}
function caseGen3SeptetLabelWrongOffset(): string | null {
  const inFrame = parseHex(FM9_REVERB524_IN_HEX);
  // Byte-5 recovers the label; byte-6 (one off) must NOT — that's the trap.
  if (!unpackAsciiAtOffset(inFrame, 5).includes('Medium Spring')) return 'byte-5 should recover the label';
  if (unpackAsciiAtOffset(inFrame, 6).includes('Medium Spring')) return 'byte-6 unexpectedly recovered the label (offset not the cause)';
  return null;
}

function caseGen3Fn01GridSetPositionInsert(): string | null {
  // Gen-3 block insert (fn=0x01 sub=0x32): effectId @ septet 8-9, gridPos @
  // septet 12-13. gridPos = col*6 + row (gen-3 grid: 6 rows). Fixtures from
  // FM9-Edit (model 0x12) AND AxeEdit III (model 0x10) over loopMIDI: the same
  // op across two model bytes is the cross-family axis (no hardware).
  const ROWS = 6;
  const xor7 = (b: number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
  const buildInsert = (model: number, effectId: number, gridPos: number): number[] => {
    const body = [
      0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x32, 0x00,
      effectId & 0x7f, (effectId >> 7) & 0x7f, 0x00, 0x00,
      gridPos & 0x7f, (gridPos >> 7) & 0x7f, 0, 0, 0, 0, 0, 0, 0,
    ];
    return [...body, xor7(body), 0xf7];
  };
  const gp = (col0: number, row0: number): number => col0 * ROWS + row0;
  const h2 = (b: number): string => b.toString(16).padStart(2, '0');
  const fixtures: [string, number[], string][] = [
    ['FM9 Amp r1c1', buildInsert(0x12, 58, gp(0, 0)), 'f0 00 01 74 12 01 32 00 3a 00 00 00 00 00 00 00 00 00 00 00 00 1e f7'],
    ['FM9 Amp r1c2', buildInsert(0x12, 58, gp(1, 0)), 'f0 00 01 74 12 01 32 00 3a 00 00 00 06 00 00 00 00 00 00 00 00 18 f7'],
    ['FM9 Cab r1c4', buildInsert(0x12, 62, gp(3, 0)), 'f0 00 01 74 12 01 32 00 3e 00 00 00 12 00 00 00 00 00 00 00 00 08 f7'],
    ['III Amp r1c1', buildInsert(0x10, 58, gp(0, 0)), 'f0 00 01 74 10 01 32 00 3a 00 00 00 00 00 00 00 00 00 00 00 00 1c f7'],
    ['III Amp r1c2', buildInsert(0x10, 58, gp(1, 0)), 'f0 00 01 74 10 01 32 00 3a 00 00 00 06 00 00 00 00 00 00 00 00 1a f7'],
    // FM3 (model 0x11) is a 4-row x 12-col grid: gridPos = col*4 + row. Cab at
    // r4c12 -> (12-1)*4 + (4-1) = 47. A third model byte for the cross-family axis.
    ['FM3 Amp r1c1', buildInsert(0x11, 58, 0), 'f0 00 01 74 11 01 32 00 3a 00 00 00 00 00 00 00 00 00 00 00 00 1d f7'],
    ['FM3 Cab r4c12', buildInsert(0x11, 62, 47), 'f0 00 01 74 11 01 32 00 3e 00 00 00 2f 00 00 00 00 00 00 00 00 36 f7'],
  ];
  for (const [label, got, wantHex] of fixtures) {
    const want = parseHex(wantHex);
    if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
      return `${label}: built ${got.map(h2).join(' ')} != captured ${wantHex}`;
    }
  }
  return null;
}

function caseGen3Fn01GridRouting(): string | null {
  // Gen-3 routing write (fn=0x01 sub=0x35): connects two adjacent-column cells.
  // 26-byte frame; only bytes 12/21/22/23 vary.
  //
  // Two formula variants (see primitives gen3-fn01-grid-routing):
  //   6-row (III/FM9): b22 uses scaled colTerm + destSign; b23 uses |destRow-3| mod-4 wrap.
  //   4-row (FM3):     b22 uses colTerm=srcCol, no destSign; b23=(destRow-1)*32 linear.
  const xor7 = (b: number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;

  const build6row = (model: number, srcRow: number, srcCol: number, destRow: number): number[] => {
    const srcGp = (srcCol - 1) * 6 + (srcRow - 1);
    const b21 = Math.floor(srcGp / 2);
    const colTerm = Math.floor((3 * (srcCol - 1)) / 2) + 1;
    const destSign = destRow >= 3 ? 1 : 0;
    const b22 = ((srcGp & 1) << 6) | (colTerm + destSign);
    const b23 = ((Math.abs(destRow - 3) + (srcCol % 2 === 0 ? 2 : 0)) % 4) << 5;
    const body = [0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x35, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00,
      b21, b22, b23];
    return [...body, xor7(body), 0xf7];
  };

  const build4row = (srcRow: number, srcCol: number, destRow: number): number[] => {
    const srcGp = (srcCol - 1) * 4 + (srcRow - 1);
    const b21 = Math.floor(srcGp / 2);
    const b22 = ((srcGp & 1) << 6) | srcCol;
    const b23 = (destRow - 1) << 5;
    const body = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x35, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00,
      b21, b22, b23];
    return [...body, xor7(body), 0xf7];
  };

  const h2 = (b: number): string => b.toString(16).padStart(2, '0');

  // 6-row fixtures: FM9-Edit loopMIDI, 2026-06-05 (10 of 26 corpus cables)
  const fixtures6: [string, number, number, number, string][] = [
    ['A r2c3->r3c4', 2,3,3, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 06 45 00 63 f7'],
    ['C r3c3->r3c4', 3,3,3, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 07 05 00 22 f7'],
    ['D r2c5->r3c6', 2,5,3, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 0c 48 00 64 f7'],
    ['sweep r3c3->r1c4', 3,3,1, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 07 04 40 63 f7'],
    ['sweep r3c3->r6c4', 3,3,6, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 07 05 60 42 f7'],
    ['col r3c1->r3c2', 3,1,3, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 02 00 23 f7'],
    ['col r3c5->r3c6', 3,5,3, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 0d 08 00 25 f7'],
    ['r1c3->r1c4',  1,3,1, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 06 04 40 62 f7'],
    ['r4c3->r1c4',  4,3,1, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 07 44 40 23 f7'],
    ['r6c3->r6c4',  6,3,6, 'f0 00 01 74 12 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 08 45 60 0d f7'],
  ];

  // 4-row fixtures: FM3-Edit loopMIDI, 2026-06-05 (7 of 10 corpus cables)
  // These include the key discriminating cables that prove the formula branch.
  const fixtures4: [string, number, number, number, string][] = [
    ['FM3 r2c1->r2c2 (baseline)',        2,1,2, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 20 42 f7'],
    ['FM3 r4c1->r4c2 (destRow=4 b23=60)',4,1,4, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 01 41 60 03 f7'],
    ['FM3 r2c1->r4c2 (fan-out)',          2,1,4, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 00 41 60 02 f7'],
    ['FM3 r2c2->r2c3 (even srcCol KEY)', 2,2,2, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 42 20 43 f7'],
    ['FM3 r2c3->r2c4 (col3 colTerm=3)',  2,3,2, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 04 43 20 44 f7'],
    ['FM3 r4c3->r2c4 (cross-row)',        4,3,2, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 05 43 20 45 f7'],
    ['FM3 r1c2->r1c3 (row-1 even-col!)', 1,2,1, 'f0 00 01 74 11 01 35 00 00 00 00 00 01 00 00 00 00 00 00 02 00 02 02 00 23 f7'],
  ];

  for (const [label, sr, sc, dr, wantHex] of fixtures6) {
    const got = build6row(0x12, sr, sc, dr);
    const want = parseHex(wantHex);
    if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
      return `6-row ${label}: built ${got.map(h2).join(' ')} != captured ${wantHex}`;
    }
  }
  for (const [label, sr, sc, dr, wantHex] of fixtures4) {
    const got = build4row(sr, sc, dr);
    const want = parseHex(wantHex);
    if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
      return `4-row ${label}: built ${got.map(h2).join(' ')} != captured ${wantHex}`;
    }
  }
  return null;
}

function caseGen3Fn01StorePreset(): string | null {
  // Gen-3 store / save-to-location (fn=0x01 sub=0x26): presetNum @ septet 12-13
  // LSB-first. Fixtures from FM9-Edit (0x12) AND AxeEdit III (0x10) over
  // loopMIDI: same op across two model bytes (cross-family axis, no hardware).
  const xor7 = (b: number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
  const buildStore = (model: number, presetNum: number): number[] => {
    const body = [
      0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x26, 0x00, 0x00, 0x00, 0x00, 0x00,
      presetNum & 0x7f, (presetNum >> 7) & 0x7f, 0, 0, 0, 0, 0, 0, 0,
    ];
    return [...body, xor7(body), 0xf7];
  };
  const h2 = (b: number): string => b.toString(16).padStart(2, '0');
  const fixtures: [string, number[], string][] = [
    ['FM9 save in place (preset 0)', buildStore(0x12, 0), 'f0 00 01 74 12 01 26 00 00 00 00 00 00 00 00 00 00 00 00 00 00 30 f7'],
    ['FM9 save to preset 10', buildStore(0x12, 10), 'f0 00 01 74 12 01 26 00 00 00 00 00 0a 00 00 00 00 00 00 00 00 3a f7'],
    ['FM9 save to preset 5', buildStore(0x12, 5), 'f0 00 01 74 12 01 26 00 00 00 00 00 05 00 00 00 00 00 00 00 00 35 f7'],
    ['III save to preset 5', buildStore(0x10, 5), 'f0 00 01 74 10 01 26 00 00 00 00 00 05 00 00 00 00 00 00 00 00 37 f7'],
  ];
  for (const [label, got, wantHex] of fixtures) {
    const want = parseHex(wantHex);
    if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
      return `${label}: built ${got.map(h2).join(' ')} != captured ${wantHex}`;
    }
  }
  return null;
}

function caseGen3EditorSyncReadSurface(): string | null {
  // Real FM9 (model 0x12) connect+sync frames: every fn=0x01 response ECHOES
  // the query's bytes 5..11, and each sub-action has a fixed response length.
  // A block renders as PLACED iff the sub=0x7b value bytes 12..13 are nonzero.
  const xor7 = (b: readonly number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
  const placedQ = parseHex('f0 00 01 74 12 01 7b 00 3a 00 00 00 00 00 00 00 00 00 00 00 00 57 f7');
  const placedR = parseHex('f0 00 01 74 12 01 7b 00 3a 00 00 00 76 01 00 00 00 00 00 00 00 20 f7');
  // Echo invariant: response bytes 5..11 == query bytes 5..11.
  for (let i = 5; i <= 11; i++) {
    if (placedR[i] !== placedQ[i]) return `sub=0x7b echo broke at byte ${i}: ${placedR[i]} ≠ ${placedQ[i]}`;
  }
  // Placed marker nonzero + valid checksum + 23-byte length.
  if (placedR.length !== 23) return `sub=0x7b response length ${placedR.length} ≠ 23`;
  if ((placedR[12] | placedR[13]) === 0) return 'sub=0x7b placed block has zero marker bytes';
  if (placedR[placedR.length - 2] !== xor7(placedR.slice(0, -2))) return 'sub=0x7b checksum mismatch';
  // The 0x74 bulk-read head is 12 bytes (no flag byte; byte 10 is the checksum).
  const head = parseHex('f0 00 01 74 12 74 42 00 24 02 07 f7');
  if (head.length !== 12) return `0x74 head length ${head.length} ≠ 12`;
  if (head[10] !== xor7(head.slice(0, 10))) return '0x74 head byte 10 is not the checksum (spurious flag byte?)';
  // itemCount in the head is channel-blocked: 292 = 73 × 4.
  const itemCount = (head[8] & 0x7f) | ((head[9] & 0x7f) << 7);
  if (itemCount % 4 !== 0) return `itemCount ${itemCount} is not 4 × paramCount (channel-blocked)`;

  // FM3 cross-family (query side): FM3-Edit (model byte 0x11, wire-confirmed)
  // drives the SAME fn=0x01 read surface — same sub-actions, same sub=0x2e
  // layout-query address, same effectId-at-bytes-8..9 block addressing.
  const fm3LayoutQ = parseHex('f0 00 01 74 11 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3b f7');
  const fm9LayoutQ = parseHex('f0 00 01 74 12 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 38 f7');
  if (fm3LayoutQ[4] !== 0x11) return `FM3 model byte ${fm3LayoutQ[4]} ≠ 0x11`;
  // identical sub-action + address region (bytes 6..11) across model bytes
  for (let i = 6; i <= 11; i++) {
    if (fm3LayoutQ[i] !== fm9LayoutQ[i]) return `FM3/FM9 sub=0x2e query diverges at byte ${i}`;
  }
  const fm3DescQ = parseHex('f0 00 01 74 11 01 01 00 02 00 00 00 00 00 00 00 00 00 00 00 00 16 f7');
  if (((fm3DescQ[8] & 0x7f) | ((fm3DescQ[9] & 0x7f) << 7)) !== 2) return 'FM3 sub=0x01 effectId not at bytes 8..9';
  if (fm3DescQ[fm3DescQ.length - 2] !== xor7(fm3DescQ.slice(0, -2))) return 'FM3 sub=0x01 query checksum mismatch';
  return null;
}

function caseGen3Sub01BlockDefinitionResponse(): string | null {
  // The captured FM9 (fw 11.0) sub=0x01 block-definition response for eid 66
  // (Reverb 1), from samples/captured/fm9-community-2026-06-09/
  // fm9test2-stream.jsonl (114 parsed bytes; the export strips the F7).
  // Decode: standard 6-field fn=0x01 envelope, tailCount14 = 80 DECODED
  // bytes carried as 92 wire septets (8-to-7 MSB-first), 80-byte LE record.
  const frame = parseHex(
    'f0 00 01 74 12 01 01 00 42 00 00 00 42 00 00 00 00 00 00 50 00 21 00 00 00 00 30 00 '
    + '00 00 00 00 00 00 00 02 00 00 00 00 00 00 00 00 00 00 00 00 00 20 00 00 00 24 40 00 '
    + '00 02 49 4a 76 32 5c 4c 22 01 44 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 '
    + '00 00 00 00 00 00 00 00 00 00 14 48 55 30 00 00 00 00 00 00 00 00 00 00 00 00 00 00 '
    + '00 1b',
  );
  if (frame.length !== 114) return `reference frame is ${frame.length} parsed bytes, expected 114`;
  // Envelope checksum: XOR of F0..byte112, & 0x7F == byte 113.
  const cs = frame.slice(0, 113).reduce((a, x) => a ^ x, 0) & 0x7f;
  if (cs !== frame[113]) return `checksum 0x${cs.toString(16)} != frame byte 113 0x${frame[113].toString(16)}`;
  // 6-field addressing: sub=0x01, blockId=66, paramId=0, tailCount=80.
  const u14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);
  if (u14(frame[6], frame[7]) !== 0x01) return `sub-action ${u14(frame[6], frame[7])} != 0x01`;
  if (u14(frame[8], frame[9]) !== 66) return `blockId ${u14(frame[8], frame[9])} != 66`;
  if (u14(frame[10], frame[11]) !== 0) return `paramId ${u14(frame[10], frame[11])} != 0`;
  const tailCount = u14(frame[19], frame[20]);
  if (tailCount !== 80) return `tailCount ${tailCount} != 80 (decoded bytes, not wire septets)`;
  // Tail: 92 wire septets at bytes 21..112, 8-to-7 MSB-first unpack to 80
  // bytes with 4 residual bits, all zero.
  const septets = frame.slice(21, 113);
  if (septets.length !== 92) return `wire tail is ${septets.length} septets, expected ceil(80*8/7) = 92`;
  let acc = 0;
  let nbits = 0;
  const rec: number[] = [];
  for (const s of septets) {
    acc = ((acc << 7) | (s & 0x7f)) >>> 0;
    nbits += 7;
    while (nbits >= 8) {
      rec.push((acc >>> (nbits - 8)) & 0xff);
      nbits -= 8;
    }
  }
  if (rec.length !== tailCount) return `decoded tail ${rec.length} bytes != tailCount ${tailCount}`;
  if ((acc & ((1 << nbits) - 1)) !== 0) return `residual ${nbits} bits nonzero`;
  // 80-byte LE record fields.
  const u32 = (o: number): number => (rec[o] | (rec[o + 1] << 8) | (rec[o + 2] << 16) | (rec[o + 3] << 24)) >>> 0;
  const ascii = (o: number, n: number): string => String.fromCharCode(...rec.slice(o, o + n)).replace(/\0+$/, '');
  const got = {
    eid: u32(0),
    familyTag: u32(4),
    instance: u32(8),
    channelCount: u32(24),
    paramCount: u32(28),
    name: ascii(32, 32),
    abbrev: ascii(64, 12),
  };
  const want = { eid: 66, familyTag: 12, instance: 0, channelCount: 4, paramCount: 73, name: 'Reverb 1', abbrev: 'REV' };
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    if (got[k] !== want[k]) return `record field ${k}: got ${JSON.stringify(got[k])}, expected ${JSON.stringify(want[k])}`;
  }
  // The record's eid echoes the envelope blockId.
  if (got.eid !== u14(frame[8], frame[9])) return 'record eid does not echo the envelope blockId';
  // paramCount is the fn=0x1F per-channel WIRE stride: REVERB itemCount 292 = 73 x 4.
  if (got.paramCount * got.channelCount !== 292) return `paramCount x channels = ${got.paramCount * got.channelCount} != 292`;
  return null;
}

function caseGen1NibbleSplit(): string | null {
  // gen-1 (Axe-Fx Standard/Ultra) nibble-split: every 8-bit field (block id,
  // param id, value) goes on the wire as two MIDI bytes, low nibble first:
  //   [v & 0x0f, (v >> 4) & 0x0f]. Each byte is a single nibble (0..15), so
  // the high bit is always clear. NOT gen-2 septet, NOT gen-3 float32.
  // See fractal-midi/src/gen1/nibble.ts.
  const split = (v: number): [number, number] => [v & 0x0f, (v >> 4) & 0x0f];
  const join = (lo: number, hi: number): number => ((hi & 0x0f) << 4) | (lo & 0x0f);
  // Worked examples printed in the published Ultra SysEx doc.
  const fixtures: { v: number; lo: number; hi: number }[] = [
    { v: 0, lo: 0x0, hi: 0x0 },
    { v: 163, lo: 0x3, hi: 0xa }, // doc: value 163 = 0xA3 -> "03 0A"
    { v: 100, lo: 0x4, hi: 0x6 }, // doc: Compressor 1 block dec 100 = 0x64 -> "04 06"
    { v: 70, lo: 0x6, hi: 0x4 }, // doc: Amp TYPE max 70 = 0x46 -> "06 04"
    { v: 254, lo: 0xe, hi: 0xf },
    { v: 255, lo: 0xf, hi: 0xf },
  ];
  for (const fx of fixtures) {
    const [lo, hi] = split(fx.v);
    if (lo !== fx.lo || hi !== fx.hi) return `gen-1 split(${fx.v}) = [${lo},${hi}], expected [${fx.lo},${fx.hi}]`;
    if (join(lo, hi) !== fx.v) return `gen-1 join round-trip failed for v=${fx.v}`;
  }
  // Full 0..255 round-trip + 7-bit-clean (the doc's complete conversion table oracle).
  for (let v = 0; v <= 255; v++) {
    const [lo, hi] = split(v);
    if (lo & 0x80 || hi & 0x80) return `gen-1 nibble not 7-bit-clean for v=${v}`;
    if (join(lo, hi) !== v) return `gen-1 0..255 round-trip failed at ${v}`;
  }
  // Full set-param envelope (fn 0x02, fixed 0x01 trailer, NO checksum):
  //   Comp 2 (block 101) Knee (param 5) = SOFTER (2)
  //   -> F0 00 01 74 01 02 05 06 05 00 02 00 01 F7
  const env = (block: number, param: number, value: number): number[] => [
    0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, ...split(block), ...split(param), ...split(value), 0x01, 0xf7,
  ];
  const got = env(101, 5, 2);
  const expected = [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x05, 0x06, 0x05, 0x00, 0x02, 0x00, 0x01, 0xf7];
  for (let i = 0; i < expected.length; i++) {
    if (got[i] !== expected[i]) {
      return `gen-1 envelope drift at byte ${i}: expected 0x${expected[i].toString(16)}, got 0x${got[i].toString(16)}`;
    }
  }
  // Trailer is a FIXED byte, not an XOR checksum: confirm the XOR of the
  // worked example's F0..value payload is 0x02 (not the 0x01 trailer).
  let xor = 0;
  for (const b of got.slice(0, 12)) xor ^= b;
  if ((xor & 0x7f) === 0x01) return `gen-1 trailer 0x01 unexpectedly equals the payload XOR (would imply a checksum)`;
  return null;
}

const FUNCTIONAL_CASES: Record<string, () => string | null> = {
  'gen3-editor-sync-read-surface': caseGen3EditorSyncReadSurface,
  'gen3-sub01-block-definition-response': caseGen3Sub01BlockDefinitionResponse,
  'gen3-fn01-grid-set-position-insert': caseGen3Fn01GridSetPositionInsert,
  'gen3-fn01-grid-routing': caseGen3Fn01GridRouting,
  'gen3-fn01-store-preset': caseGen3Fn01StorePreset,
  'gen3-fn03-request-preset-dump': caseGen3Fn03RequestPresetDump,
  'gen3-enum-label-septet-stream': caseGen3EnumLabelSeptetStream,
  'gen3-fn01-set-float32-ordinal': caseGen3SetEchoFloat32Ordinal,
  'gen3-septet-label-wrong-offset': caseGen3SeptetLabelWrongOffset,
  'gen3-fn1f-poll-block-bulk-read': caseGen3Fn1fPollBlockBulkRead,
  'xor-7f-envelope-checksum': caseXor7fEnvelopeChecksum,
  'septet-14bit': caseSeptet14bit,
  'gen1-nibble-split': caseGen1NibbleSplit,
  'septet-21bit-byte2-mask-preservation': caseSeptet21bitByte2MaskPreservation,
  'vendor-envelope-descriptor-table': caseVendorEnvelopeDescriptorTable,
  'xor-fold-hash': caseXorFoldHash,
  'iii-block-name-string-cascade': caseIiiBlockNameStringCascade,
  'iii-byte-stream-septet-pack-8to7': caseIiiByteStreamSeptetPack8to7,
  'per-effect-paramtable-dispatcher': casePerEffectParamtableDispatcher,
  'editor-cache-section-record-grammar': caseEditorCacheSectionRecordGrammar,
  'iii-paramid-pseudo-sentinel-ranges': caseIiiParamidPseudoSentinelRanges,
  'ii-state-broadcast-triple-write': caseIiStateBroadcastTripleWrite,
  'ii-compressor-calibration-divergence': caseIiCompressorCalibrationDivergence,
  'ii-fn16-get-param-info': caseIiFn16GetParamInfo,
  'ii-fn0e-query-states': caseIiFn0eQueryStates,
  'ii-fn07-modifier-read': caseIiFn07ModifierRead,
  'vp4-fn01-swapped-septet-float32': caseVp4Fn01SwappedSeptetFloat32,
  'ii-grid-routing-cell-matrix': caseIiGridRoutingCellMatrix,
  'device-reserialization-oracle': caseDeviceReserializationOracle,
  'deferred-commit-readback-window': caseDeferredCommitReadbackWindow,
};

/**
 * II preset-image grid + routing cell matrix (words 34..129): 48
 * column-major 2-word cells `(blockId, inputConnectorMask)` from word
 * 34. Byte-exact fixture: factory-A000 "59 Bassguy" grid words (Q8.02
 * Bank A, preset 0) with the preset's known TLV-chain block multiset.
 * A000 is a single-row layout: 11 blocks + 1 shunt across columns
 * 1..12, all at row 2, every cell fed from the previous column's row 2
 * (mask 0x02 = 1 << (2-1); the column-1 cell carries the input-node
 * connect for its own row).
 */
function caseIiGridRoutingCellMatrix(): string | null {
  // words[34..129] of factory-A000 (de-framed via the corpus-validated
  // 3-byte-septet decode; see verify-ii-preset-image-tlv.ts).
  const gridWords = [
    0, 0, 100, 2, 0, 0, 0, 0, 0, 0, 124, 2, 0, 0, 0, 0, 0, 0, 200, 2, 0, 0, 0, 0,
    0, 0, 133, 2, 0, 0, 0, 0, 0, 0, 106, 2, 0, 0, 0, 0, 0, 0, 108, 2, 0, 0, 0, 0,
    0, 0, 116, 2, 0, 0, 0, 0, 0, 0, 118, 2, 0, 0, 0, 0, 0, 0, 112, 2, 0, 0, 0, 0,
    0, 0, 114, 2, 0, 0, 0, 0, 0, 0, 120, 2, 0, 0, 0, 0, 0, 0, 110, 2, 0, 0, 0, 0,
  ];
  // A000's TLV-chain effect-block multiset (chain order is alphabetical;
  // the grid holds signal order; the MULTISETS must agree).
  const chainBlockIds = [106, 108, 116, 100, 112, 133, 118, 114, 110, 120, 124];
  const GRID_START = 34;
  const cellWord = (col: number, row: number): number => GRID_START + ((col - 1) * 4 + (row - 1)) * 2;
  if (gridWords.length !== 96) return `fixture is ${gridWords.length} words, expected 96`;
  const at = (w: number): number => gridWords[w - GRID_START];
  interface Cell { col: number; row: number; id: number; mask: number }
  const cells: Cell[] = [];
  for (let col = 1; col <= 12; col++) {
    for (let row = 1; row <= 4; row++) {
      cells.push({ col, row, id: at(cellWord(col, row)), mask: at(cellWord(col, row) + 1) });
    }
  }
  // Invariants: id domain, mask domain, empty cells carry no mask.
  for (const c of cells) {
    const okId = c.id === 0 || (c.id >= 100 && c.id <= 198) || (c.id >= 200 && c.id <= 235);
    if (!okId) return `cell (${c.col},${c.row}): id ${c.id} outside the domain`;
    if (c.mask > 0x0f) return `cell (${c.col},${c.row}): mask 0x${c.mask.toString(16)} > 0x0F`;
    if (c.id === 0 && c.mask !== 0) return `cell (${c.col},${c.row}): empty cell carries mask ${c.mask}`;
  }
  // Connector semantics: col>1 mask bits point at occupied prev-column cells.
  for (const c of cells) {
    if (c.col === 1 || c.mask === 0) continue;
    for (let bit = 0; bit < 4; bit++) {
      if ((c.mask & (1 << bit)) === 0) continue;
      const prev = cells.find((x) => x.col === c.col - 1 && x.row === bit + 1);
      if (prev === undefined || prev.id === 0) {
        return `cell (${c.col},${c.row}): mask bit ${bit} dangles at an empty previous-column cell`;
      }
    }
  }
  // A000 shape: the entire signal path sits on row 2, cols 1..12, in
  // signal order Comp, Wah, shunt, Drive, Amp, Cab, Chorus, Flanger,
  // Delay, MultiDelay, Rotary, Reverb; the shunt is at (3,2).
  const row2 = cells.filter((c) => c.row === 2).map((c) => c.id);
  const expectedRow2 = [100, 124, 200, 133, 106, 108, 116, 118, 112, 114, 120, 110];
  if (row2.join(',') !== expectedRow2.join(',')) return `row-2 ids [${row2.join(',')}] != expected`;
  if (cells.some((c) => c.row !== 2 && c.id !== 0)) return 'A000 must be a row-2-only layout';
  if (at(cellWord(1, 2) + 1) !== (1 << (2 - 1))) return 'column-1 cell must carry the input-node connect for its row';
  // Grid-vs-chain block multiset identity (shunts never serialize).
  const gridBlocks = cells.filter((c) => c.id >= 100 && c.id < 200).map((c) => c.id).sort((a, b) => a - b);
  const chainSorted = [...chainBlockIds].sort((a, b) => a - b);
  if (gridBlocks.join(',') !== chainSorted.join(',')) {
    return `grid multiset [${gridBlocks.join(',')}] != chain multiset [${chainSorted.join(',')}]`;
  }
  // The stride-8 misread this supersedes: word 36 is NOT the table
  // origin; the cell unit starts at word 34 (cell (1,1) id word).
  if (cellWord(1, 1) !== 34) return 'cell (1,1) must sit at word 34';
  if (cellWord(3, 2) !== 34 + ((3 - 1) * 4 + (2 - 1)) * 2) return 'cellWord formula drift';
  return null;
}

/**
 * VP4 fn=0x01 value field = 5-septet LE float32 with the top two septets swapped
 * (`[s0,s1,s2,s4,s3]`). Self-contained (de-facto golden); fixtures are captured
 * frames from `samples/captured/decoded/vp4-403-v2/FINDINGS.md`.
 */
function caseVp4Fn01SwappedSeptetFloat32(): string | null {
  const xor7 = (b: number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
  const f2u = (v: number): number => {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = v;
    return new Uint32Array(buf)[0];
  };
  const u2f = (u: number): number => {
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = u >>> 0;
    return new Float32Array(buf)[0];
  };
  const enc = (v: number): number[] => {
    const u = f2u(v);
    const s = [u & 0x7f, (u >>> 7) & 0x7f, (u >>> 14) & 0x7f, (u >>> 21) & 0x7f, (u >>> 28) & 0x7f];
    return [s[0], s[1], s[2], s[4], s[3]]; // swap top two
  };
  const dec = (w: number[]): number =>
    u2f((w[0] & 0x7f) | ((w[1] & 0x7f) << 7) | ((w[2] & 0x7f) << 14) | ((w[4] & 0x7f) << 21) | ((w[3] & 0x7f) << 28));
  const h2 = (b: number): string => b.toString(16).padStart(2, '0');

  // 1. The captured Reverb bypass-on value 00 00 10 03 78 = float32 0.515625.
  const bypassOn = enc(0.515625);
  if (bypassOn.map(h2).join(' ') !== '00 00 10 03 78') {
    return `bypass-on encode: got ${bypassOn.map(h2).join(' ')} != captured 00 00 10 03 78`;
  }
  if (Math.abs(dec([0x00, 0x00, 0x10, 0x03, 0x78]) - 0.515625) > 1e-6) {
    return `bypass-on decode: got ${dec([0x00, 0x00, 0x10, 0x03, 0x78])} != 0.515625`;
  }
  // 2. Round-trip across clean values.
  for (const v of [0, 0.25, 0.5, 0.515625, 0.75, 1]) {
    if (Math.abs(dec(enc(v)) - v) > 1e-6) return `round-trip drift at ${v}: got ${dec(enc(v))}`;
  }
  // 3. Full captured frames (bypass on/off, save).
  const frame = (payload: number[]): number[] => {
    const body = [0xf0, 0x00, 0x01, 0x74, 0x14, 0x01, ...payload];
    return [...body, xor7(body), 0xf7];
  };
  const fixtures: [string, number[], string][] = [
    ['Reverb bypass on', frame([0x42, 0x00, 0x03, 0x00, 0x01, 0, 0, 0, 0x04, 0x00, ...enc(0.515625)]),
      'f0 00 01 74 14 01 42 00 03 00 01 00 00 00 04 00 00 00 10 03 78 3f f7'],
    ['Reverb bypass off', frame([0x42, 0x00, 0x03, 0x00, 0x01, 0, 0, 0, 0x04, 0x00, ...enc(0)]),
      'f0 00 01 74 14 01 42 00 03 00 01 00 00 00 04 00 00 00 00 00 00 54 f7'],
    ['SAVE in place', frame([0x00, 0x00, 0x00, 0x00, 0x1b, 0, 0, 0, 0x04, 0x00, 0x30, 0x00, 0x00, 0x00, 0x00]),
      'f0 00 01 74 14 01 00 00 00 00 1b 00 00 00 04 00 30 00 00 00 00 3f f7'],
  ];
  for (const [label, got, wantHex] of fixtures) {
    const want = parseHex(wantHex);
    if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
      return `${label}: built ${got.map(h2).join(' ')} != captured ${wantHex}`;
    }
  }
  return null;
}

/**
 * Device re-serialization oracle (METHOD primitive, so there are no bytes of
 * its own to assert). The fixture pins four things instead:
 *
 *   1. the ADJUDICATION RULE, over all four rows of the entry's table plus the
 *      inadmissible-oracle case, including the asymmetry (a CHANGED field under
 *      test is conclusive with no oracle at all);
 *   2. the ORACLE-ADMISSIBILITY predicate (live-composed, not authored by our
 *      upload, not read-volatile, independent of the field under test);
 *   3. the worked case's arithmetic (Circuit Tracks pack 5 project 42,
 *      2026-07-27: gate lane 0x1a281 held 176 across an on-device Save while
 *      the synth-1 mixer level at 0x2701c moved 0 -> 57 on its own);
 *   4. that the cited probe scripts are reachable and still carry the oracle
 *      leg. A refactor that drops it leaves the shipped implementation unable
 *      to discharge the entry's claim.
 *
 * The gate-lane byte packing itself is NOT this primitive and is pinned
 * separately, in both directions, by scripts/verify-circuit-ncs.ts.
 */
function caseDeviceReserializationOracle(): string | null {
  // ---- Recorded fixture: the post-save read-back diffed against the pre-save
  // backup. Two bytes in 160,780. Both images are 160,780-byte .ncs projects.
  const IMAGE_BYTES = 160_780;
  const GATE_OFF = 0x1a281;   // midi1 / pattern 1 / step 1 / slot 1 gate lane (field under test)
  const MIXER_OFF = 0x2701c;  // synth 1 mixer level (the oracle)
  // midi1 / pattern 1 note-step region: 32 steps x 28 bytes from noteStepBase.
  const NOTE_REGION = { start: 0x1a27c, end: 0x1a5fc };
  const WROTE = 176;          // 0x80 | 48: tie ON at a magnitude of 48 sixths = 8 steps
  const START_STATE = 224;    // 0x80 | 96: the corpus-wide tie value the vehicle held
  const diff: { off: number; before: number; after: number }[] = [
    { off: GATE_OFF, before: START_STATE, after: 176 },
    { off: MIXER_OFF, before: 0, after: 57 },
  ];

  // ---- 1. The adjudication rule.
  type Verdict =
    | 'device-authored'                 // field under test CHANGED: conclusive alone
    | 'device-endorsed'                 // survived + oracle moved: re-serialization proven
    | 'not-a-pure-echo'                 // survived + unwritten bytes moved, but no oracle
    | 'inconclusive-echo-not-excluded'  // survived + nothing to distinguish an echo
    | 'oracle-inadmissible';            // the named oracle does not qualify
  interface OracleObservation { admissible: boolean; moved: boolean }
  const adjudicate = (
    fut: { written: number; readBack: number },
    oracle: OracleObservation | undefined,
    otherUnwrittenBytesMoved: boolean,
  ): Verdict => {
    if (fut.readBack !== fut.written) return 'device-authored';
    if (oracle !== undefined && !oracle.admissible) return 'oracle-inadmissible';
    if (oracle !== undefined && oracle.moved) return 'device-endorsed';
    if (otherUnwrittenBytesMoved) return 'not-a-pure-echo';
    return 'inconclusive-echo-not-excluded';
  };
  const rows: [string, Verdict, Verdict][] = [
    // [label, got, want]
    ['the real 2026-07-27 case',
      adjudicate({ written: WROTE, readBack: 176 }, { admissible: true, moved: true }, true),
      'device-endorsed'],
    ['asymmetry: a CHANGED value needs no oracle',
      adjudicate({ written: WROTE, readBack: 224 }, undefined, false),
      'device-authored'],
    ['asymmetry holds even when the oracle stayed put',
      adjudicate({ written: WROTE, readBack: 224 }, { admissible: true, moved: false }, false),
      'device-authored'],
    ['asymmetry outranks oracle quality: a CHANGED value is conclusive even with a junk oracle',
      adjudicate({ written: WROTE, readBack: 224 }, { admissible: false, moved: true }, true),
      'device-authored'],
    ['survived, oracle silent, other unwritten bytes moved',
      adjudicate({ written: WROTE, readBack: 176 }, { admissible: true, moved: false }, true),
      'not-a-pure-echo'],
    ['survived, byte-identical image',
      adjudicate({ written: WROTE, readBack: 176 }, { admissible: true, moved: false }, false),
      'inconclusive-echo-not-excluded'],
    ['survived, no oracle named at all',
      adjudicate({ written: WROTE, readBack: 176 }, undefined, false),
      'inconclusive-echo-not-excluded'],
    ['survived, oracle moved but does not qualify',
      adjudicate({ written: WROTE, readBack: 176 }, { admissible: false, moved: true }, true),
      'oracle-inadmissible'],
  ];
  for (const [label, got, want] of rows) {
    if (got !== want) return `adjudication row '${label}': got '${got}', expected '${want}'`;
  }

  // ---- 2. Oracle admissibility. Three hard criteria plus independence.
  interface Candidate {
    name: string;
    offset: number;
    composedFromLiveHardwareState: boolean;
    authoredByOurUpload: boolean;
    volatileAcrossReadsWithoutSave: boolean;
  }
  const admissible = (c: Candidate): boolean =>
    c.composedFromLiveHardwareState &&
    !c.authoredByOurUpload &&
    !c.volatileAcrossReadsWithoutSave &&
    c.offset !== GATE_OFF &&
    !(c.offset >= NOTE_REGION.start && c.offset < NOTE_REGION.end);
  const candidates: [Candidate, boolean][] = [
    [{ name: 'synth 1 mixer level (physical fader position at save time)', offset: MIXER_OFF,
      composedFromLiveHardwareState: true, authoredByOurUpload: false, volatileAcrossReadsWithoutSave: false }, true],
    [{ name: 'the gate lane itself', offset: GATE_OFF,
      composedFromLiveHardwareState: false, authoredByOurUpload: true, volatileAcrossReadsWithoutSave: false }, false],
    [{ name: 'the project name we uploaded', offset: 0x00010,
      composedFromLiveHardwareState: false, authoredByOurUpload: true, volatileAcrossReadsWithoutSave: false }, false],
    [{ name: 'a read-volatile telemetry byte (AM4 dump cluster / VP4 blob float shape)', offset: 0x00140,
      composedFromLiveHardwareState: true, authoredByOurUpload: false, volatileAcrossReadsWithoutSave: true }, false],
    [{ name: 'a live-composed byte sitting INSIDE the region under test', offset: NOTE_REGION.start + 9,
      composedFromLiveHardwareState: true, authoredByOurUpload: false, volatileAcrossReadsWithoutSave: false }, false],
  ];
  for (const [c, want] of candidates) {
    if (admissible(c) !== want) {
      return `oracle admissibility for '${c.name}': got ${admissible(c)}, expected ${want}`;
    }
  }

  // ---- 3. The worked case's arithmetic.
  const split = (b: number): { tie: boolean; sixths: number } => ({ tie: (b & 0x80) !== 0, sixths: b & 0x7f });
  const join = (sixths: number, tie: boolean): number => (tie ? 0x80 : 0) | (sixths & 0x7f);
  const under = split(176);
  if (!under.tie || under.sixths !== 48) return `176 must split to {tie, 48 sixths}, got {${under.tie}, ${under.sixths}}`;
  if (join(48, true) !== 176) return `join(48, tie) must be 176, got ${join(48, true)}`;
  if (under.sixths / 6 !== 8) return `48 sixths must be 8 whole steps, got ${under.sixths / 6}`;
  // The rival hypothesis ("a tie forces maximum length") predicts the device
  // rewrites the magnitude to 96, i.e. byte 224. The observation falsifies it.
  const coupledPrediction = join(96, true);
  if (coupledPrediction !== 224) return `the coupled-hypothesis prediction must be 224, got ${coupledPrediction}`;
  if (diff[0].after === coupledPrediction) return 'the observed read-back must differ from the coupled-hypothesis prediction';
  if (diff[0].after !== WROTE) return `the field under test read back ${diff[0].after}, fixture says we wrote ${WROTE}`;
  // The oracle was POISONED (uploaded as 0) and came back holding a live value.
  if (diff[1].before !== 0) return 'the oracle must be poisoned to a value the live control cannot hold (0)';
  if (diff[1].after === diff[1].before) return 'the oracle did not move, which would make the case inconclusive';
  if (diff.length !== 2) return `the recorded diff is ${diff.length} bytes, expected exactly 2`;
  for (const d of diff) {
    if (d.off < 0 || d.off >= IMAGE_BYTES) return `diff offset 0x${d.off.toString(16)} outside the ${IMAGE_BYTES}-byte image`;
  }
  // Structural independence: the oracle is outside the region under test.
  if (MIXER_OFF >= NOTE_REGION.start && MIXER_OFF < NOTE_REGION.end) {
    return 'the oracle offset must lie outside the note-pattern region under test';
  }
  if (!(GATE_OFF >= NOTE_REGION.start && GATE_OFF < NOTE_REGION.end)) {
    return `the field under test 0x${GATE_OFF.toString(16)} must lie inside its own declared region`;
  }

  // ---- 4. Cited artifacts reachable, and the oracle leg still present.
  const arm = path.join(MCP_ROOT, 'scripts', 'circuit-tie-orthogonality-arm.ts');
  const read = path.join(MCP_ROOT, 'scripts', 'circuit-tie-orthogonality-read.ts');
  if (!existsSync(arm)) return `cited probe missing: ${arm}`;
  if (!existsSync(read)) return `cited probe missing: ${read}`;
  const readSrc = readFileSync(read, 'utf8');
  if (!readSrc.includes('MIXER_SYNTH1_LEVEL')) {
    return `${path.basename(read)} no longer references the oracle field (MIXER_SYNTH1_LEVEL); ` +
      `without it the probe cannot tell re-serialization from an echo. Repoint the entry or restore the leg.`;
  }
  if (!readSrc.includes('--before')) {
    return `${path.basename(read)} no longer implements the --before pre-save diff, which is the ` +
      `method's load-bearing step. Repoint the entry or restore the leg.`;
  }

  // ---- Optional corroboration: the arm-time backup, when it is on this
  // machine (timestamped and gitignored, so absence is not a failure). Its
  // pre-state must match the fixture: the vehicle byte at 224, the oracle
  // poisoned to 0.
  const ncsRoot = path.join(MCP_ROOT, 'samples', 'circuit-ncs');
  if (existsSync(ncsRoot)) {
    const backupDir = readdirSync(ncsRoot).find((n) => n.startsWith('restore-tiegate-'));
    if (backupDir !== undefined) {
      const backup = path.join(ncsRoot, backupDir, 'pack5-proj42.ncs');
      if (existsSync(backup)) {
        const buf = readFileSync(backup);
        if (buf.length !== IMAGE_BYTES) return `arm backup is ${buf.length} bytes, expected ${IMAGE_BYTES}`;
        if (buf[GATE_OFF] !== START_STATE) {
          return `arm backup gate lane reads ${buf[GATE_OFF]}, fixture start state is ${START_STATE}`;
        }
        if (buf[MIXER_OFF] !== 0) {
          return `arm backup oracle byte reads ${buf[MIXER_OFF]}, fixture says it was poisoned to 0`;
        }
      }
    }
  }
  return null;
}

/**
 * Deferred-commit read-back window: a device that commits stored state
 * asynchronously has a window in which its own listing lags its own flash, so a
 * read-back taken inside it reports a GOOD write as absent. Another METHOD
 * primitive with no bytes of its own, so the case pins (1) the adjudication
 * rule and its asymmetry, (2) the measured Circuit fixture, (3) that the cited
 * verification loop still waits past the observed window, and (4) that the
 * runtime surface an agent actually reads still carries the timing.
 */
function caseDeferredCommitReadbackWindow(): string | null {
  // ---- Recorded fixture: Circuit Tracks, 2026-07-27, 63-slot clone onto Pack 2.
  const FLUSH_MIN_MS = 6_000;   // observed commit window, measured from session CLOSE
  const FLUSH_MAX_MS = 8_000;
  const EARLY_READ_MS = 1_200;  // the read that lied
  const EARLY_READ_ABSENT = 8;  // slots it called empty
  const LATE_READ_ABSENT = 0;   // the same slots, re-read after the window

  // ---- 1. The adjudication rule. Absence is a measurement only after the
  // window; presence is conclusive at any time. That asymmetry IS the primitive.
  type Verdict = 'confirmed-present' | 'confirmed-absent' | 'inadmissible-too-early';
  const adjudicate = (elapsedMs: number, sawIt: boolean): Verdict => {
    if (sawIt) return 'confirmed-present';
    return elapsedMs > FLUSH_MAX_MS ? 'confirmed-absent' : 'inadmissible-too-early';
  };
  const rows: [string, Verdict, Verdict][] = [
    ['the read that lied (absent at 1.2 s)', adjudicate(EARLY_READ_MS, false), 'inadmissible-too-early'],
    ['absent at the window minimum is still too early', adjudicate(FLUSH_MIN_MS, false), 'inadmissible-too-early'],
    ['absent exactly AT the maximum is still too early', adjudicate(FLUSH_MAX_MS, false), 'inadmissible-too-early'],
    ['absent after the window is a real failure', adjudicate(FLUSH_MAX_MS + 1_000, false), 'confirmed-absent'],
    ['asymmetry: PRESENT inside the window still counts', adjudicate(EARLY_READ_MS, true), 'confirmed-present'],
    ['present after the window counts too', adjudicate(20_000, true), 'confirmed-present'],
  ];
  for (const [label, got, want] of rows) {
    if (got !== want) return `adjudication '${label}': got '${got}', expected '${want}'`;
  }

  // ---- 2. The measured fixture is internally coherent.
  if (!(FLUSH_MIN_MS < FLUSH_MAX_MS)) return 'the flush window must be an interval';
  if (!(EARLY_READ_MS < FLUSH_MIN_MS)) {
    return `the early read (${EARLY_READ_MS} ms) must fall INSIDE the window to explain the false negative`;
  }
  if (EARLY_READ_ABSENT <= LATE_READ_ABSENT) {
    return 'the fixture must show the early read reporting MORE absent slots than the late read; ' +
      'otherwise it is not evidence of a deferred commit';
  }

  // ---- 3. The cited verification loop still waits past the window. A refactor
  // that trims the post-write wait back below the flush window reintroduces
  // exactly the false negative this entry exists to prevent.
  const clone = path.join(MCP_ROOT, 'scripts', 'circuit-clone-pack-samples.ts');
  if (!existsSync(clone)) return `cited verification loop missing: ${clone}`;
  const cloneSrc = readFileSync(clone, 'utf8');
  // Every numeric literal inside a `sleep(...)` argument, so a ternary schedule
  // (`sleep(attempt === 1 ? 9000 : 5000)`) is read as the two waits it is.
  const waits = [...cloneSrc.matchAll(/\bsleep\(([^)]*)\)/g)]
    .flatMap((m) => [...m[1].matchAll(/\d+/g)].map((n) => Number(n[0])));
  const longest = waits.length > 0 ? Math.max(...waits) : 0;
  if (longest < FLUSH_MAX_MS) {
    return `${path.basename(clone)}'s longest post-write wait is ${longest} ms, below the observed ` +
      `${FLUSH_MAX_MS} ms flush window. A verification read that early reports good writes as absent, ` +
      `and on a device with no erase that conclusion costs a needless re-send.`;
  }

  // ---- 4. The runtime surface still warns. `capacity_note` is what an agent
  // reads at the exact moment it is about to draw the wrong conclusion, so the
  // timing living only in docs is not enough.
  const dir = path.join(MCP_ROOT, 'packages', 'circuit-tracks', 'src', 'ncs', 'sampleDirectory.ts');
  if (!existsSync(dir)) return `cited surface missing: ${dir}`;
  const dirSrc = readFileSync(dir, 'utf8');
  if (!/6-8\s*s/i.test(dirSrc)) {
    return `${path.basename(dir)} no longer carries the ~6-8 s manifest-flush warning in its ` +
      `capacity_note / docstring. That string is the only place a caller meets this hazard in-band.`;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

function main(): void {
  const verbose = process.argv.includes('--verbose');
  const entries = loadEntries();
  const slugSet = new Set(entries.map((e) => e.slug));
  const statusBySlug = new Map(
    entries.map((e) => [e.slug, typeof e.frontmatter.status === 'string' ? e.frontmatter.status : '']),
  );
  const violations: Violation[] = [];
  let structuralOk = 0;
  for (const entry of entries) {
    const before = violations.length;
    validateStructural(entry, violations, slugSet);
    validateNegativeRetestWhen(entry, violations, statusBySlug);
    if (violations.length === before) structuralOk += 1;
  }
  validateIndexDrift(entries, violations);
  const stalenessWarning = checkSynthesisStaleness(entries);
  if (stalenessWarning !== null) {
    console.log('');
    console.log('!'.repeat(72));
    console.log('SYNTHESIS-CADENCE WARNING (non-blocking):');
    console.log(`  ${stalenessWarning}`);
    console.log('!'.repeat(72));
    console.log('');
  }
  const functionalResults: { slug: string; ok: boolean; message: string | null }[] = [];
  for (const [slug, fn] of Object.entries(FUNCTIONAL_CASES)) {
    let err: string | null;
    try {
      err = fn();
    } catch (e) {
      err = `threw: ${(e as Error).message}`;
    }
    functionalResults.push({ slug, ok: err === null, message: err });
  }

  // Verbose diagnostics: status breakdown + STUB inventory. These don't
  // catch bugs — they're orientation aids when working on the primitives
  // directly. Hidden behind --verbose so preflight output stays terse.
  if (verbose) {
    const statusCounts = new Map<string, number>();
    for (const e of entries) {
      const s = typeof e.frontmatter.status === 'string' ? e.frontmatter.status : '<missing>';
      statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
    }
    const withInline = new Set(Object.keys(FUNCTIONAL_CASES));
    const stubbed = entries.filter(
      (e) => !withInline.has(e.slug) && typeof e.frontmatter.status === 'string' && e.frontmatter.status !== 'scratch',
    ).map((e) => e.slug);

    console.log('primitives-verify (verbose)');
    console.log('=========================');
    console.log(`entries scanned:       ${entries.length}`);
    console.log(`structural pass:       ${structuralOk} / ${entries.length}`);
    console.log('status breakdown:');
    for (const [s, n] of [...statusCounts.entries()].sort()) {
      console.log(`  ${s.padEnd(20)} ${n}`);
    }
    console.log('functional fixture cases:');
    for (const r of functionalResults) {
      if (r.ok) console.log(`  PASS   case-${r.slug}`);
      else console.log(`  FAIL   case-${r.slug}\n         ${r.message}`);
    }
    console.log(`primitives without inline fixture (covered via existing verify-* scripts):`);
    for (const s of stubbed) console.log(`  STUB   case-${s}`);
    console.log('');
  }

  const functionalFails = functionalResults.filter((r) => !r.ok);
  const fails = violations.filter((v) => v.severity === 'fail');
  const warns = violations.filter((v) => v.severity === 'warn');
  if (fails.length === 0 && functionalFails.length === 0) {
    if (warns.length > 0) {
      console.log(`WARNINGS (${warns.length}):`);
      for (const v of warns) console.log(`  [warn] ${v.entry}: ${v.message}`);
      console.log('');
    }
    console.log(
      `OK: ${entries.length} primitive entries, ${functionalResults.length} fixtures green, ` +
        `${warns.length} non-blocking warnings.`,
    );
    process.exit(0);
  }
  if (fails.length > 0) {
    console.log(`STRUCTURAL FAILURES (${fails.length}):`);
    for (const v of fails) console.log(`  [fail] ${v.entry}: ${v.message}`);
  }
  if (warns.length > 0) {
    console.log(`WARNINGS (${warns.length}):`);
    for (const v of warns) console.log(`  [warn] ${v.entry}: ${v.message}`);
  }
  if (functionalFails.length > 0) {
    console.log(`FUNCTIONAL CASE FAILURES (${functionalFails.length}):`);
    for (const r of functionalFails) {
      console.log(`  case-${r.slug}: ${r.message}`);
    }
  }
  process.exit(1);
}

main();
