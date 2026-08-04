/**
 * bundle-packages — the ONE derivation of what a shipping bundle must contain.
 *
 * WHY THIS EXISTS. `build-installer.ts` (Windows ZIP) and `build-mcpb.ts`
 * (Claude Desktop Extension) each used to carry a HAND-MAINTAINED list of the
 * workspace packages to copy into the bundle, plus a second hand-maintained
 * list of leaf deps. Both drifted, and both drift SILENTLY: a package missing
 * from a bundle resolves fine in the dev tree (workspace hoisting) and dies
 * with ERR_MODULE_NOT_FOUND only once a user extracts the artifact standalone.
 *   - `build-installer.ts` was missing `arturia`, which `server-all` has
 *     imported statically since 2026-07-26 (commit 7088741).
 *   - `build-mcpb.ts` was missing `arturia`, `ve-500`, `boss-rc`, plus the bare
 *     packages `roland-midi` and `openrig`.
 *
 * A gate that COMPARES two hardcoded lists against ground truth only detects
 * the drift. Deriving both lists from ground truth eliminates it: adding a
 * workspace package to `packages/` and declaring it as a dependency is now the
 * whole job, and both bundles pick it up on the next build.
 *
 * GROUND TRUTH is `packages/server-all/package.json` plus the transitive
 * dependency closure over workspace packages. Non-workspace dependencies
 * (the MCP SDK, @julusian/midi, serialport, zod) are leaves: they stop the
 * walk and come back as `externalDeps`, which the bundles install from the
 * registry.
 *
 * TWO KINDS OF WORKSPACE PACKAGE, and the split is DERIVED, never declared:
 *   - SCOPED (`@mcp-midi-control/*`): copied into the bundle as real
 *     directories under `node_modules/@mcp-midi-control/`. No symlinks, so the
 *     tree is safe to ZIP and Explorer-extract.
 *   - BARE (any other name: `fractal-midi`, `roland-midi`, `openrig`): imported
 *     by plain name, so they must sit at the bundle's `node_modules` root.
 *     `openrig` and `roland-midi` are `private: true` and are therefore NOT on
 *     the npm registry — `npm install` cannot fetch them — so each is packed to
 *     a local tarball and referenced as `file:./<tarball>`, exactly as a
 *     registry dep would be. THIS IS LOAD-BEARING: dropping a bare package from
 *     the tarball path does not fail the build, it ships a broken bundle.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Namespace that marks a workspace package as "copy as a real directory". */
export const SCOPE_PREFIX = '@mcp-midi-control/';

/** The package whose dependency closure defines the bundle. */
export const BUNDLE_ROOT_PACKAGE = '@mcp-midi-control/server-all';

/** Repo root, resolved from this file's location (scripts/_lib/). */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface WorkspacePackage {
  /** Directory name under `packages/` (what the builders copy). */
  dir: string;
  /** npm package name from its package.json (what imports resolve). */
  name: string;
  /** Absolute path to the package directory. */
  path: string;
  /** Declared version. */
  version: string;
  /** `private: true` => unpublished => unreachable from the npm registry. */
  isPrivate: boolean;
}

export interface BundlePackages {
  /** `@mcp-midi-control/*` packages, copied as real dirs. Sorted by dir. */
  scoped: WorkspacePackage[];
  /** Bare-named workspace packages, packed to tarballs. Sorted by dir. */
  bare: WorkspacePackage[];
  /** Non-workspace runtime deps reachable from the closure. Sorted. */
  externalDeps: string[];
}

interface RawPkg {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): RawPkg | undefined {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as RawPkg;
}

/** npm package name -> workspace package, for every package on disk. */
export function readWorkspaceIndex(projectRoot: string = PROJECT_ROOT): Map<string, WorkspacePackage> {
  const packagesDir = path.join(projectRoot, 'packages');
  const index = new Map<string, WorkspacePackage>();
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(packagesDir, entry.name);
    const pkg = readPackageJson(dirPath);
    if (!pkg?.name) continue;
    index.set(pkg.name, {
      dir: entry.name,
      name: pkg.name,
      path: dirPath,
      version: pkg.version ?? '0.0.0',
      isPrivate: pkg.private === true,
    });
  }
  return index;
}

/**
 * Transitive closure of workspace packages reachable from server-all, split
 * into the scoped / bare halves the bundles stage differently.
 *
 * This is the function BOTH builders call instead of hardcoding a list.
 */
export function resolveBundlePackages(projectRoot: string = PROJECT_ROOT): BundlePackages {
  const index = readWorkspaceIndex(projectRoot);
  if (!index.has(BUNDLE_ROOT_PACKAGE)) {
    throw new Error(
      `bundle-packages: "${BUNDLE_ROOT_PACKAGE}" is not a workspace package under `
      + `${path.join(projectRoot, 'packages')}. The bundle derivation has no root to walk from.`,
    );
  }

  const reached: WorkspacePackage[] = [];
  const externals = new Set<string>();
  const seen = new Set<string>();
  const queue = [BUNDLE_ROOT_PACKAGE];

  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);

    const ws = index.get(name);
    if (ws === undefined) {
      externals.add(name); // not a workspace package: a registry leaf
      continue;
    }
    reached.push(ws);
    for (const dep of Object.keys(readPackageJson(ws.path)?.dependencies ?? {})) queue.push(dep);
  }

  const byDir = (a: WorkspacePackage, b: WorkspacePackage): number => a.dir.localeCompare(b.dir);
  return {
    scoped: reached.filter((p) => p.name.startsWith(SCOPE_PREFIX)).sort(byDir),
    bare: reached.filter((p) => !p.name.startsWith(SCOPE_PREFIX)).sort(byDir),
    externalDeps: [...externals].sort(),
  };
}

/**
 * Version specifiers for the non-workspace leaf deps, read from the root
 * package.json (Phase B moved them to devDependencies since each workspace
 * package now declares its own runtime deps). Throws naming the offender if a
 * reachable dep has no version at the root — that would otherwise surface as a
 * mystery `npm install` failure inside the staging dir.
 */
export function externalDepVersions(
  externalDeps: readonly string[],
  projectRoot: string = PROJECT_ROOT,
): Record<string, string> {
  const rootPkg = readPackageJson(projectRoot) ?? {};
  const versions: Record<string, string> = {};
  for (const dep of externalDeps) {
    const v = rootPkg.devDependencies?.[dep] ?? rootPkg.dependencies?.[dep];
    if (!v) {
      throw new Error(
        `Leaf dep "${dep}" is required by a bundled workspace package but has no version in the `
        + `root package.json. Add it to devDependencies (or dependencies) there.`,
      );
    }
    versions[dep] = v;
  }
  return versions;
}

/**
 * `npm pack` a bare workspace package into `destDir` and return the
 * `file:./<tarball>` specifier the lean bundle package.json needs.
 *
 * Bare packages CANNOT be installed from the registry (two of the three are
 * `private: true`), so this is the only path by which they reach a bundle.
 */
export function packWorkspaceTarball(
  pkg: WorkspacePackage,
  destDir: string,
): { filename: string; spec: string } {
  const raw = execSync('npm pack --json', { cwd: pkg.path, encoding: 'utf8' });
  const info = JSON.parse(raw) as { filename: string }[];
  const filename = info[0]?.filename;
  if (!filename) throw new Error(`npm pack for ${pkg.dir} produced no output`);
  fs.renameSync(path.join(pkg.path, filename), path.join(destDir, filename));
  return { filename, spec: `file:./${filename}` };
}
