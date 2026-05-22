/**
 * Hash-gated `npm run build` skipper.
 *
 * The full build runs 6 sequential `tsc` invocations + an asset-copy
 * step. On preflight that's ~10s, paid every time even when only docs
 * or tests changed. This script hashes the inputs that actually affect
 * the build (every package's `src/`, `tsconfig.json`, and `package.json`),
 * compares against a fingerprint stored at
 * `packages/server-all/dist/.build-hash`, and re-runs `npm run build`
 * only on mismatch.
 *
 * If the fingerprint file is missing (fresh checkout, deleted `dist/`,
 * etc.), the build runs unconditionally. This errs on the side of
 * always producing a working dist; a stale dist is the failure mode we
 * are actively trying to prevent.
 *
 * Run via `npm run build-if-changed` (wired into `test:server`).
 * Forcing a rebuild from a clean state: `rm packages/server-all/dist/.build-hash`
 * or just run `npm run build` directly.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');
const FINGERPRINT_PATH = path.join(
  REPO_ROOT,
  'packages',
  'server-all',
  'dist',
  '.build-hash',
);

function walkSourceFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkSourceFiles(full, out);
    else if (st.isFile()) {
      // Hash all source-affecting files. `.ts` is the obvious one; `.json`
      // catches param dictionaries, lineage corpora, and other generated
      // assets the codec ships; `.md` is excluded (docs don't affect dist).
      if (entry.endsWith('.ts') || entry.endsWith('.json')) {
        out.push(full);
      }
    }
  }
}

function computeFingerprint(): string {
  const files: string[] = [];
  if (!existsSync(PACKAGES_DIR)) {
    throw new Error(`packages/ directory not found at ${PACKAGES_DIR}`);
  }
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const pkgPath = path.join(PACKAGES_DIR, pkg);
    if (!statSync(pkgPath).isDirectory()) continue;
    walkSourceFiles(path.join(pkgPath, 'src'), files);
    // Build configuration + manifest. tsconfig drives the compile;
    // package.json's "main" / "exports" / "dependencies" affect the
    // shipped artifact even if no source changed.
    const tsconfig = path.join(pkgPath, 'tsconfig.json');
    if (existsSync(tsconfig)) files.push(tsconfig);
    const manifest = path.join(pkgPath, 'package.json');
    if (existsSync(manifest)) files.push(manifest);
  }
  // Asset-copy script. If it changes, the dist may need different
  // copied content even when source is identical.
  const assetCopier = path.join(REPO_ROOT, 'scripts', 'copy-build-assets.ts');
  if (existsSync(assetCopier)) files.push(assetCopier);

  files.sort();
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(path.relative(REPO_ROOT, f));
    hash.update('\0');
    hash.update(readFileSync(f));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readPriorFingerprint(): string | null {
  if (!existsSync(FINGERPRINT_PATH)) return null;
  return readFileSync(FINGERPRINT_PATH, 'utf8').trim();
}

function runBuild(): void {
  const result = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main(): void {
  const current = computeFingerprint();
  const prior = readPriorFingerprint();
  if (prior !== null && prior === current) {
    console.log(`build-if-changed: dist is fresh (hash ${current.slice(0, 12)}...). Skipping build.`);
    return;
  }
  if (prior === null) {
    console.log('build-if-changed: no fingerprint, running full build.');
  } else {
    console.log(
      `build-if-changed: source changed (was ${prior.slice(0, 12)}..., now ${current.slice(0, 12)}...). Running build.`,
    );
  }
  runBuild();
  // Re-compute and write AFTER build succeeds so a failed build never
  // poisons the fingerprint into a "skip me" state.
  const post = computeFingerprint();
  writeFileSync(FINGERPRINT_PATH, post, 'utf8');
  console.log(`build-if-changed: wrote new fingerprint ${post.slice(0, 12)}...`);
}

main();
