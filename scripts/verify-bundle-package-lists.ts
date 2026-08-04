/**
 * verify-bundle-package-lists — the two shipping bundles must contain every
 * workspace package the server actually imports.
 *
 * WHY THIS EXISTS. `build-installer.ts` (Windows ZIP) and `build-mcpb.ts`
 * (macOS/Desktop Extension) each used to carry a HAND-MAINTAINED list of the
 * workspace packages to copy into the bundle. Both files warned, in their own
 * comments, that forgetting an entry ships a bundle that "boots partially with
 * ERR_MODULE_NOT_FOUND". Both drifted anyway:
 *
 *   - `build-installer.ts` was missing `arturia`, which `server-all` has
 *     imported statically since 2026-07-26 (commit 7088741). The next Windows
 *     ZIP build would have died at boot on the MicroFreak descriptor import.
 *   - `build-mcpb.ts` was missing `arturia`, `ve-500`, `boss-rc`, plus the bare
 *     packages `roland-midi` and `openrig`. `openrig` is imported as a VALUE by
 *     `core/src/protocol-generic/dispatcher/discovery.ts`, the module that
 *     registers `describe_rig` / `describe_device`.
 *
 * WHAT THIS GATE NOW CHECKS, AND WHY IT CHANGED. The first version of this
 * script compared the two hardcoded lists against ground truth. That detects
 * the drift but leaves the drift class in place: the lists still had to be
 * remembered, and the gate only ever fires AFTER someone forgets. Both builders
 * now DERIVE their lists from `packages/server-all/package.json`'s transitive
 * workspace-dependency closure (`scripts/_lib/bundle-packages.ts`), so this
 * gate's job changed to guarding the derivation itself:
 *
 *   1. DERIVATION SANITY — the closure resolves, is non-trivial, every member
 *      exists on disk with a matching package.json, and the scoped/bare split
 *      is exactly the `@mcp-midi-control/` prefix rule the builders stage on.
 *   2. INDEPENDENT ORACLE — the derivation trusts `package.json` `dependencies`.
 *      Its one blind spot is a package that is IMPORTED IN CODE but never
 *      DECLARED as a dependency: the closure would silently omit it and the
 *      bundle would ship broken, exactly as before. So we walk every bundled
 *      package's own TypeScript sources for workspace imports and require each
 *      to be inside the closure. Source imports are a genuinely different
 *      ground truth from package.json, which is what makes this an oracle
 *      rather than a restatement.
 *   3. NOTHING HARDCODED CAME BACK — both builders must import the shared
 *      derivation, must not contain a re-introduced literal list of workspace
 *      packages, and must still route bare packages through the tarball path
 *      (`openrig` and `roland-midi` are `private: true`, so `npm install`
 *      CANNOT fetch them; losing that path ships a broken bundle silently).
 *   4. LEAF DEPS RESOLVE — every non-workspace runtime dep reachable from the
 *      closure has a version at the repo root, so `npm install` inside the
 *      staging dir cannot fail mid-build on a mystery specifier.
 *
 * A comment saying "keep these in sync" was not a gate. Neither is a derivation
 * nobody checks. This is.
 *
 * Run: npx tsx scripts/verify-bundle-package-lists.ts    (also in `preflight`)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_ROOT,
  SCOPE_PREFIX,
  externalDepVersions,
  readWorkspaceIndex,
  resolveBundlePackages,
  type WorkspacePackage,
} from './_lib/bundle-packages.js';

/** The builders under guard, and the derivation they must all share. */
const BUILDERS = ['build-installer.ts', 'build-mcpb.ts'] as const;
const HELPER_IMPORT = "./_lib/bundle-packages.js";

const problems: string[] = [];
const fail = (msg: string): void => { problems.push(msg); };

// ── source-scanning helpers ───────────────────────────────────────────────

/**
 * Strip block comments and whole-line `//` comments. Deliberately does NOT
 * strip trailing `//` comments: that would need real tokenizing and would
 * mangle the URLs in build-mcpb's manifest. Doc comments are what matter here
 * (build-installer's bundle-layout diagram used to enumerate packages).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** Every module specifier a TS file imports, however it spells the import. */
function moduleSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const re of [
    /from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of source.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

/** `@scope/pkg/sub/path.js` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
function packageBase(specifier: string): string {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return '';
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

// ── 1. derivation sanity ──────────────────────────────────────────────────

const index = readWorkspaceIndex(PROJECT_ROOT);
const bundle = resolveBundlePackages(PROJECT_ROOT);
const closure: WorkspacePackage[] = [...bundle.scoped, ...bundle.bare];
const closureNames = new Set(closure.map((p) => p.name));

if (!closureNames.has('@mcp-midi-control/server-all')) {
  fail('the derived closure does not contain @mcp-midi-control/server-all — the walk root is wrong');
}
if (bundle.scoped.length < 2 || bundle.bare.length < 1) {
  fail(
    `the derived closure is implausibly small (${bundle.scoped.length} scoped, ${bundle.bare.length} bare). `
    + 'A closure that collapses to nothing would make every downstream check vacuously pass.',
  );
}
for (const pkg of closure) {
  const pj = path.join(pkg.path, 'package.json');
  if (!fs.existsSync(pj)) fail(`closure member "${pkg.dir}" has no package.json at ${pj}`);
  const scopedByName = pkg.name.startsWith(SCOPE_PREFIX);
  const inScopedList = bundle.scoped.includes(pkg);
  if (scopedByName !== inScopedList) {
    fail(`"${pkg.name}" is on the ${inScopedList ? 'scoped' : 'bare'} side but its name says otherwise`);
  }
}
// The bundles copy `dist/`; a closure member that never builds one would stage
// an empty directory and fail only at boot.
for (const pkg of closure) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkg.path, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  if (!pj.scripts?.build) fail(`closure member "${pkg.dir}" declares no build script — it would stage no dist/`);
}

// ── 2. independent oracle: the import graph ───────────────────────────────
//
// package.json says what a package DECLARES. Its sources say what it actually
// USES. When they disagree, the bundle is the thing that breaks.
const undeclared = new Map<string, Set<string>>(); // "importer -> imported" => example files
for (const pkg of closure) {
  for (const file of walkTsFiles(path.join(pkg.path, 'src'))) {
    const specifiers = moduleSpecifiers(fs.readFileSync(file, 'utf8'));
    for (const spec of specifiers) {
      const base = packageBase(spec);
      if (base === '' || base === pkg.name) continue;
      if (!index.has(base)) continue;        // not a workspace package: a registry leaf
      if (closureNames.has(base)) continue;  // already bundled
      const key = `${pkg.name} -> ${base}`;
      if (!undeclared.has(key)) undeclared.set(key, new Set());
      undeclared.get(key)!.add(path.relative(PROJECT_ROOT, file));
    }
  }
}
for (const [key, files] of [...undeclared].sort()) {
  const [importer, imported] = key.split(' -> ');
  const sample = [...files].sort().slice(0, 3).join(', ');
  fail(
    `"${importer}" imports the workspace package "${imported}" in source but does not declare it in its `
    + `dependencies, so the bundle derivation cannot see it (e.g. ${sample}). `
    + `Add "${imported}" to packages/${index.get(importer!)?.dir ?? importer}/package.json dependencies.`,
  );
}

// ── 3. nothing hardcoded came back ────────────────────────────────────────

const workspaceIdentifiers = new Set<string>();
for (const pkg of index.values()) { workspaceIdentifiers.add(pkg.dir); workspaceIdentifiers.add(pkg.name); }

for (const builder of BUILDERS) {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', builder), 'utf8');
  const source = stripComments(raw);

  if (!source.includes(HELPER_IMPORT)) {
    fail(`${builder} no longer imports the shared derivation ("${HELPER_IMPORT}") — it is back to declaring its own bundle contents`);
  }
  // The bare packages must still be packed to LOCAL TARBALLS. `openrig` and
  // `roland-midi` are `private: true` and are NOT on the npm registry, so a
  // plain version specifier in the lean package.json resolves to nothing.
  if (!source.includes('packWorkspaceTarball')) {
    fail(`${builder} no longer packs bare workspace packages to tarballs (packWorkspaceTarball). openrig/roland-midi are private:true and cannot be installed from the registry`);
  }
  if (!/\.bare\b/.test(source)) fail(`${builder} never reads the derived bare-package set`);
  if (!/\.scoped\b/.test(source)) fail(`${builder} never reads the derived scoped-package set`);

  // A literal array that enumerates workspace packages is the drift class
  // itself. Flag any array literal that is MOSTLY workspace package names
  // (>=2 of them, and at least half its string entries), which distinguishes a
  // package list from incidental prose like build-mcpb's manifest keywords.
  for (const m of source.matchAll(/\[([^[\]]*)\]/g)) {
    const strings = [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1]!);
    const hits = strings.filter((s) => workspaceIdentifiers.has(s));
    if (hits.length >= 2 && hits.length * 2 >= strings.length) {
      fail(
        `${builder} contains a hardcoded workspace-package list: [${hits.join(', ')}]. `
        + `That is the exact drift that shipped a bundle without "arturia". `
        + `Use resolveBundlePackages() from ${HELPER_IMPORT} instead.`,
      );
    }
  }
}

// ── 4. leaf deps resolve at the repo root ─────────────────────────────────

try {
  externalDepVersions(bundle.externalDeps, PROJECT_ROOT);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// ── report ────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error('FAIL: the bundle package derivation is not sound.\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nA package the bundles cannot see ships an artifact that boots partially and');
  console.error('dies with ERR_MODULE_NOT_FOUND on first launch. It resolves fine in the dev');
  console.error('tree (workspace hoisting), so ONLY a hermetic check catches it.');
  process.exit(1);
}

console.log(
  `OK: both bundles derive their contents from server-all's dependency closure — `
  + `${closure.length} workspace package(s) (${bundle.scoped.length} scoped, ${bundle.bare.length} bare) `
  + `+ ${bundle.externalDeps.length} registry leaf dep(s), no hardcoded lists, `
  + `and every workspace import in their sources is inside the closure.`,
);
