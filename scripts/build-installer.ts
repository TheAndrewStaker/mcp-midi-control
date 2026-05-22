#!/usr/bin/env node
/**
 * scripts/build-installer.ts
 *
 * Build the MCP MIDI Control release bundle.
 *
 * Output:
 *   build/staging/                                -- bundle contents
 *   build/dist/mcp-midi-control-v<version>.zip    -- shippable ZIP (this is
 *                                                  what users download)
 *
 * Steps performed:
 *   1. Clean build/staging/.
 *   2. Compile TypeScript -> dist/.
 *   3. Download the pinned Node runtime (cached in build/node-cache/).
 *   4. Copy dist/, package.json, package-lock.json, LICENSE, NOTICE, the
 *      Node runtime, install wrappers (setup.cmd, uninstall.cmd,
 *      instructions.txt) and PowerShell helpers into build/staging/.
 *   5. Run `npm ci --omit=dev` inside build/staging/ using the BUNDLED Node
 *      (so native node-midi compiles against the same V8 ABI we ship).
 *   6. Verify staging by invoking the bundled node --version and asserting
 *      the entry point + native node-midi binary are present.
 *   7. Package build/staging/ into a versioned ZIP at build/dist/.
 *
 * Usage:
 *   npm run build:installer
 *   npm run build:installer -- --clean   # also wipe build/node-cache
 *
 * Why bundle Node + node_modules instead of using `pkg`/`nexe`/SEA:
 *   See docs/_private/DECISIONS.md packager row. The native node-midi `.node`
 *   addon is friendliest with file-on-disk distribution; single-binary
 *   tools handle native addons via fragile runtime extraction.
 */

import { execSync, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';

// Pinned Node version. Matches founder's dev env (verified 2026-05-03 = v24.13.1)
// so native modules compiled here are ABI-compatible with the runtime we ship.
// Bump only after retesting `npm run preflight` against the new Node version.
const NODE_VERSION = '24.13.1';
const NODE_ARCH = 'win-x64';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const PKG_JSON = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
) as { version: string };
const VERSION = PKG_JSON.version;

const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const STAGING = path.join(BUILD_DIR, 'staging');
const DIST_DIR = path.join(BUILD_DIR, 'dist');
const NODE_CACHE = path.join(BUILD_DIR, 'node-cache');
const NODE_DIR_NAME = `node-v${NODE_VERSION}-${NODE_ARCH}`;
const NODE_ZIP_NAME = `${NODE_DIR_NAME}.zip`;
const NODE_DOWNLOAD_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP_NAME}`;
const RELEASE_DIR_NAME = `mcp-midi-control-v${VERSION}`;
const RELEASE_ZIP_PATH = path.join(DIST_DIR, `${RELEASE_DIR_NAME}.zip`);

const cleanFlag = process.argv.includes('--clean');

async function main() {
  console.log(`[build] MCP MIDI Control installer staging -bundling Node v${NODE_VERSION}`);

  // 1. Clean staging (always); optionally clean node-cache.
  if (fs.existsSync(STAGING)) {
    fs.rmSync(STAGING, { recursive: true, force: true });
  }
  fs.mkdirSync(STAGING, { recursive: true });

  if (cleanFlag && fs.existsSync(NODE_CACHE)) {
    console.log('[build] --clean: wiping node-cache');
    fs.rmSync(NODE_CACHE, { recursive: true, force: true });
  }
  fs.mkdirSync(NODE_CACHE, { recursive: true });

  // 2. Compile TypeScript across all workspace packages.
  console.log('[build] Compiling TypeScript (all workspace packages)');
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
  const compiledEntry = path.join(
    PROJECT_ROOT,
    'packages',
    'server-all',
    'dist',
    'server',
    'index.js',
  );
  if (!fs.existsSync(compiledEntry)) {
    throw new Error(`TypeScript compile produced no ${path.relative(PROJECT_ROOT, compiledEntry)}`);
  }

  // 3. Ensure node.exe is cached locally.
  const cachedNodeDir = path.join(NODE_CACHE, NODE_DIR_NAME);
  const cachedNodeExe = path.join(cachedNodeDir, 'node.exe');
  const cachedNpmCli = path.join(cachedNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cachedNodeExe)) {
    await downloadAndExtractNode();
  } else {
    console.log(`[build] Using cached node.exe at ${cachedNodeExe}`);
  }
  if (!fs.existsSync(cachedNpmCli)) {
    throw new Error(`Bundled npm not found at ${cachedNpmCli} -Node ZIP layout may have changed`);
  }

  // 4. Stage workspace packages.
  //
  // Bundle layout (no symlinks; safe to ZIP and Explorer-extract):
  //   STAGING/
  //   ├── node.exe
  //   ├── package.json  (lean root: NO workspaces; deps = non-workspace only)
  //   ├── node_modules/
  //   │   ├── @modelcontextprotocol/sdk/  (npm install populates)
  //   │   ├── midi/                       (npm install populates, native build)
  //   │   ├── zod/                        (npm install populates)
  //   │   └── @mcp-midi-control/
  //   │       ├── core/{package.json,dist/}        (copied from packages/core)
  //   │       ├── am4/{package.json,dist/}         (copied from packages/am4)
  //   │       ├── axe-fx-ii/{package.json,dist/}
  //   │       ├── hydrasynth/{package.json,dist/}
  //   │       └── server-all/{package.json,dist/}
  //   ├── LICENSE, NOTICE
  //   ├── setup.cmd, uninstall.cmd, verify-midi.cmd, instructions.txt
  //   └── install/{merge,unmerge}-mcp-config.ps1
  //
  // Node resolves cross-package imports (e.g. server-all importing
  // `@mcp-midi-control/core/midi/transport.js`) via normal node_modules
  // walk-up -each package is a real directory under
  // node_modules/@mcp-midi-control/, no symlinks needed.
  console.log('[build] Staging artifacts');
  // Keep in sync with `workspaces` in root package.json. Adding a new
  // workspace package and forgetting it here ships a bundle that boots
  // partially -server-all imports the missing package via dynamic
  // device-registry registration and dies with ERR_MODULE_NOT_FOUND on
  // first launch.
  const WORKSPACE_PACKAGES = [
    'core',
    'am4',
    'axe-fx-ii',
    'axe-fx-iii',
    'hydrasynth',
    'server-all',
  ] as const;

  // 4a. Lean root package.json -NO workspaces, NO @mcp-midi-control/*
  //     deps. npm install only fetches the three leaf node-only deps.
  //     We pull leaf-dep versions from the project's devDependencies
  //     (Phase B moved them there since each workspace package now
  //     declares its own runtime deps).
  const devPkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  // `fractal-midi` was added in the Phase B extraction (2026-05-18) -each
  // workspace package now imports the Fractal codec from this published npm
  // package. The bundle must install it at the root so runtime walk-up
  // resolution from `node_modules/@mcp-midi-control/*/dist/*.js` finds it.
  const leafDeps = ['@modelcontextprotocol/sdk', 'fractal-midi', 'midi', 'zod'] as const;
  const leanDeps: Record<string, string> = {};
  for (const d of leafDeps) {
    const v = devPkg.devDependencies?.[d] ?? devPkg.dependencies?.[d];
    if (!v) throw new Error(`Leaf dep ${d} missing from root package.json`);
    leanDeps[d] = v;
  }
  // fractal-midi is a `file:` dep at the project root (relative to
  // C:/dev/mcp-midi-tools/). The path doesn't transpose to build/staging/
  // (relative depth is different), and copying npm cache state across
  // dirs is fragile. Resolve the source tarball ONCE here and copy it
  // into staging, then rewrite the lean package.json to point at the
  // local copy. Self-contained: no relative-path math, no broken installs.
  const fractalMidiSpec = leanDeps['fractal-midi'];
  if (typeof fractalMidiSpec === 'string' && fractalMidiSpec.startsWith('file:')) {
    const relPath = fractalMidiSpec.slice('file:'.length);
    const absPath = path.resolve(PROJECT_ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`fractal-midi tarball not found at ${absPath} (declared as ${fractalMidiSpec} in root package.json).`);
    }
    const tarballBasename = path.basename(absPath);
    const stagedTarball = path.join(STAGING, tarballBasename);
    fs.copyFileSync(absPath, stagedTarball);
    leanDeps['fractal-midi'] = `file:./${tarballBasename}`;
    console.log(`[build] Bundled fractal-midi tarball: ${tarballBasename}`);
  }
  const leanPkg = {
    name: 'mcp-midi-control-bundle',
    version: VERSION,
    private: true,
    type: 'module' as const,
    dependencies: leanDeps,
  };
  fs.writeFileSync(
    path.join(STAGING, 'package.json'),
    JSON.stringify(leanPkg, null, 2) + '\n',
  );

  // 4b. Static files at staging root.
  for (const f of ['LICENSE', 'NOTICE']) {
    fs.copyFileSync(path.join(PROJECT_ROOT, f), path.join(STAGING, f));
  }
  fs.copyFileSync(cachedNodeExe, path.join(STAGING, 'node.exe'));

  // Installer wrappers (root of the bundle so users see them after
  // extracting): setup.cmd / uninstall.cmd / verify-midi.cmd /
  // instructions.txt.
  //
  // Normalize EOLs to CRLF on the way out. cmd.exe and PowerShell
  // mis-parse multi-line scripts with bare LF (the first character of
  // line 2 gets dropped, so `setlocal` becomes `tlocal` etc.). Repo
  // working-tree state can be either LF or CRLF depending on the
  // contributor's git autocrlf setting; the shipped bundle is always
  // CRLF regardless.
  for (const f of ['setup.cmd', 'uninstall.cmd', 'verify-midi.cmd', 'instructions.txt']) {
    copyAsCrlf(path.join(PROJECT_ROOT, 'installer', f), path.join(STAGING, f));
  }
  // PowerShell helpers go under install/ to keep the root tidy.
  const installerHelperDir = path.join(STAGING, 'install');
  fs.mkdirSync(installerHelperDir, { recursive: true });
  for (const f of ['merge-mcp-config.ps1', 'unmerge-mcp-config.ps1']) {
    copyAsCrlf(path.join(PROJECT_ROOT, 'installer', f), path.join(installerHelperDir, f));
  }

  // 5. Production-only npm install using the BUNDLED node + npm. This
  // guarantees the native node-midi binary is compiled against the same
  // V8 ABI as the node.exe we ship, regardless of what's on PATH. Only
  // the three leaf deps install.
  //
  // ORDER MATTERS: install FIRST, copy workspace packages AFTER. If we
  // pre-place the workspace packages, npm install treats them as
  // orphans (no declaration in the lean package.json) and prunes them.
  console.log('[build] Installing leaf production deps with bundled node + npm');
  execSync(
    `"${cachedNodeExe}" "${cachedNpmCli}" install --omit=dev --no-package-lock`,
    { cwd: STAGING, stdio: 'inherit' }
  );

  // 6. Copy each workspace package as a real directory under
  // node_modules/@mcp-midi-control/. Done AFTER npm install so npm
  // doesn't prune them. Node's runtime resolution finds them by
  // directory presence + each package's `exports` field -no need for
  // the bundle to be a workspace, no symlinks needed (ZIP-safe).
  console.log('[build] Copying workspace packages into node_modules');
  const mcpNs = path.join(STAGING, 'node_modules', '@mcp-midi-control');
  fs.mkdirSync(mcpNs, { recursive: true });
  for (const pkg of WORKSPACE_PACKAGES) {
    const srcPkg = path.join(PROJECT_ROOT, 'packages', pkg);
    const dstPkg = path.join(mcpNs, pkg);
    fs.mkdirSync(dstPkg, { recursive: true });

    // Strip workspace-internal deps (`@mcp-midi-control/*: "*"`) from
    // each copied package.json -the shipped bundle isn't a workspace,
    // so the `"*"` specifier would confuse any future `npm` run. Real-
    // directory presence + each package's `exports` field is what runtime
    // resolution actually needs. Non-internal deps (e.g. `midi`) stay
    // listed but are already present at the bundle's root node_modules.
    const pkgJson = JSON.parse(
      fs.readFileSync(path.join(srcPkg, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; [k: string]: unknown };
    if (pkgJson.dependencies) {
      const cleaned: Record<string, string> = {};
      for (const [name, version] of Object.entries(pkgJson.dependencies)) {
        if (!name.startsWith('@mcp-midi-control/')) cleaned[name] = version;
      }
      pkgJson.dependencies = cleaned;
    }
    fs.writeFileSync(
      path.join(dstPkg, 'package.json'),
      JSON.stringify(pkgJson, null, 2) + '\n',
    );
    fs.cpSync(path.join(srcPkg, 'dist'), path.join(dstPkg, 'dist'), { recursive: true });
  }

  // 7. Verify the bundle.
  const stagedNodeExe = path.join(STAGING, 'node.exe');
  const versionOutput = execSync(`"${stagedNodeExe}" --version`).toString().trim();
  if (!versionOutput.includes(NODE_VERSION)) {
    throw new Error(`Bundled node reported ${versionOutput}; expected v${NODE_VERSION}`);
  }

  const stagedEntry = path.join(
    STAGING,
    'node_modules',
    '@mcp-midi-control',
    'server-all',
    'dist',
    'server',
    'index.js',
  );
  if (!fs.existsSync(stagedEntry)) {
    throw new Error(`Entry point missing at ${stagedEntry}`);
  }

  const stagedNativeMidi = path.join(STAGING, 'node_modules', 'midi', 'build', 'Release', 'midi.node');
  if (!fs.existsSync(stagedNativeMidi)) {
    throw new Error(
      `Native node-midi binary missing at ${stagedNativeMidi}.\n` +
      `npm install probably skipped the native build step. Try: rm -rf build/staging/node_modules ` +
      `&& re-run this script.`
    );
  }

  // Smoke-boot the bundled server with the bundled node.exe to catch
  // import-resolution regressions BEFORE producing the ZIP. The dev-tree
  // `npm run preflight` smoke-server step doesn't catch these because it
  // resolves through the workspace's hoisted node_modules -the bundle
  // has its own, narrower node_modules built from the lean root pkg +
  // copied workspace dirs, and missing deps there only surface at bundle
  // boot. Two real regressions caught here on the Phase-B release path
  // (2026-05-18):
  //   1. `fractal-midi` missing from `leafDeps` → ERR_MODULE_NOT_FOUND
  //      on the first codec import inside any workspace package.
  //   2. `axe-fx-iii` missing from `WORKSPACE_PACKAGES` → server-all
  //      can't load the III device adapter.
  // Pipe empty stdin so the JSON-RPC reader settles into wait-mode
  // instead of hanging on no-tty stdin. 5s is plenty for the device-
  // registry to finish; if it hasn't booted by then there's a fatal.
  // The MCP server reads JSON-RPC frames from stdin and prints
  // diagnostics to stderr (stdout is the JSON-RPC channel). Passing
  // empty stdin → it reads EOF and exits cleanly with status 0 within
  // milliseconds. The timeout is a safety net for two real failure
  // modes:
  //   (a) startup deadlock in some imported module
  //   (b) Windows Defender real-time scan still indexing the freshly-
  //       written node_modules/ tree -observed during the Phase-B
  //       installer fix run (2026-05-18) when smoke-boot ran moments
  //       after `npm install --omit=dev` populated staging. 15s
  //       absorbs typical AV scan latency without flapping CI.
  console.log('[build] Smoke-booting bundled server (15s timeout)');
  const smokeResult = spawnSync(stagedNodeExe, [stagedEntry], {
    input: '',
    timeout: 15_000,
    encoding: 'utf8',
  });
  console.log(
    `[build]   smoke result: status=${smokeResult.status} signal=${smokeResult.signal} ` +
    `stderrBytes=${smokeResult.stderr?.length ?? 0} stdoutBytes=${smokeResult.stdout?.length ?? 0}` +
    (smokeResult.error ? ` spawn-error=${smokeResult.error.message}` : ''),
  );
  // ERR_MODULE_NOT_FOUND is the headline regression this smoke catches.
  // Check first so the error message points at the actual cause when
  // the bundle is missing a dep or workspace package.
  if (smokeResult.stderr.includes('ERR_MODULE_NOT_FOUND')) {
    throw new Error(
      `Smoke-boot: ERR_MODULE_NOT_FOUND in the bundled server's stderr. ` +
      `A package is missing from the bundle.\n\nstderr:\n${smokeResult.stderr}`,
    );
  }
  // Startup banner proves the server reached MCP initialization. Both
  // banner and scan lines go to stderr (stdout is the JSON-RPC channel).
  if (!smokeResult.stderr.includes('MCP MIDI Control MCP server running on stdio')) {
    throw new Error(
      `Smoke-boot did not print the startup banner. The server may have ` +
      `failed to register tools before being killed.\n\nstderr:\n${smokeResult.stderr}\n\n` +
      `stdout:\n${smokeResult.stdout}`,
    );
  }
  // Each device package's port-scan log proves its module loaded -if any
  // codec or device package was missing, we'd reach the banner but skip
  // its scan. Verify all four printed. Match the per-device scan-prefix
  // substring (stable across `not visible` vs `detected` wording).
  const expectedScans = [
    'Startup port scan: AM4',
    'Hydrasynth port scan',
    'Axe-Fx II port scan',
    'Axe-Fx III port scan',
  ];
  const missingScans = expectedScans.filter((s) => !smokeResult.stderr.includes(s));
  if (missingScans.length > 0) {
    throw new Error(
      `Smoke-boot: some device packages didn't print their startup port ` +
      `scan -likely a missing transitive import. Missing scans: ` +
      `[${missingScans.join(', ')}]\n\nstderr:\n${smokeResult.stderr}`,
    );
  }

  const stagedSize = dirSizeMb(STAGING);

  // 8. Package staging into a versioned ZIP. Rename staging -> versioned
  // dir so the ZIP contains a clean top-level folder, then rename back so
  // re-builds keep working.
  //
  // Windows Defender + similar AV tools real-time-scan the freshly-
  // written `staging/node_modules` tree (97 npm-installed packages just
  // landed). Their open handles can race against our `fs.renameSync`
  // and PowerShell's `Compress-Archive` causing intermittent EPERM /
  // CompressArchive method-invocation failures. The retryFsOp helper
  // wraps both operations with bounded back-off -the AV window is
  // usually 2-5s but spikes higher on cold caches.
  console.log('[build] Packaging release ZIP');
  fs.mkdirSync(DIST_DIR, { recursive: true });
  if (fs.existsSync(RELEASE_ZIP_PATH)) {
    fs.unlinkSync(RELEASE_ZIP_PATH);
  }
  const versionedDir = path.join(BUILD_DIR, RELEASE_DIR_NAME);
  if (fs.existsSync(versionedDir)) {
    fs.rmSync(versionedDir, { recursive: true, force: true });
  }
  await retryFsOp('rename staging -> versioned dir', () => {
    fs.renameSync(STAGING, versionedDir);
  });
  try {
    await retryFsOp('Compress-Archive', () => {
      // Compress-Archive's PowerShell module throws non-zero exit on
      // any IO race; retry harness catches that and re-runs after a
      // back-off. Delete any partial output between attempts so the
      // next run doesn't trip the "already exists" check inside the
      // cmdlet.
      if (fs.existsSync(RELEASE_ZIP_PATH)) fs.unlinkSync(RELEASE_ZIP_PATH);
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${versionedDir}' -DestinationPath '${RELEASE_ZIP_PATH}' -Force"`,
        { stdio: 'inherit' },
      );
    });
  } finally {
    await retryFsOp('rename versioned dir -> staging', () => {
      fs.renameSync(versionedDir, STAGING);
    });
  }
  if (!fs.existsSync(RELEASE_ZIP_PATH)) {
    throw new Error(`Compress-Archive did not produce ${RELEASE_ZIP_PATH}`);
  }
  const zipSizeMb = Math.round(fs.statSync(RELEASE_ZIP_PATH).size / (1024 * 1024));

  console.log('');
  console.log('[build] OK release bundle ready');
  console.log(`        staging:         ${STAGING} (${stagedSize} MB)`);
  console.log(`        release ZIP:     ${RELEASE_ZIP_PATH} (${zipSizeMb} MB)`);
  console.log(`        bundled node:    ${versionOutput}`);
  console.log(`        entry point:     node_modules/@mcp-midi-control/server-all/dist/server/index.js`);
  console.log(`        native node-midi: node_modules/midi/build/Release/midi.node`);
  console.log('');
  console.log('Next: smoke-test the ZIP on a clean Win11 VM per docs/RELEASE-RUNBOOK.md');
}

/**
 * Retry a synchronous FS operation with exponential back-off. Windows
 * AV scanners hold open handles on freshly-written files for a few
 * seconds; renames + archive reads against those files fail with EPERM
 * or NULL pointer errors. A short retry loop reliably absorbs that
 * window without flapping in CI.
 */
async function retryFsOp(
  label: string,
  op: () => void,
  attempts = 5,
  initialDelayMs = 1_000,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      op();
      if (i > 0) console.log(`[build]   ${label}: succeeded on attempt ${i + 1}`);
      return;
    } catch (err) {
      lastErr = err;
      const delay = initialDelayMs * Math.pow(2, i);
      const remaining = attempts - i - 1;
      if (remaining > 0) {
        console.log(
          `[build]   ${label} attempt ${i + 1} failed (${(err as Error).message?.slice(0, 80) ?? err}); ` +
          `retrying in ${delay}ms (${remaining} attempt(s) left)`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts. Last error: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

async function downloadAndExtractNode() {
  const zipPath = path.join(NODE_CACHE, NODE_ZIP_NAME);
  console.log(`[build] Downloading ${NODE_DOWNLOAD_URL}`);
  const res = await fetch(NODE_DOWNLOAD_URL);
  if (!res.ok || !res.body) {
    throw new Error(`Node download failed: ${res.status} ${res.statusText}`);
  }
  const out = fs.createWriteStream(zipPath);
  await finished(Readable.fromWeb(res.body as any).pipe(out));

  console.log(`[build] Extracting ${NODE_ZIP_NAME}`);
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${NODE_CACHE}' -Force"`,
    { stdio: 'inherit' }
  );
  if (!fs.existsSync(path.join(NODE_CACHE, NODE_DIR_NAME, 'node.exe'))) {
    throw new Error(`After extract, expected node.exe at ${NODE_CACHE}\\${NODE_DIR_NAME}\\node.exe`);
  }
  fs.unlinkSync(zipPath);
}

function copyAsCrlf(src: string, dst: string): void {
  const buf = fs.readFileSync(src, 'utf8');
  // Replace lone LFs with CRLF without doubling existing CRs.
  const crlf = buf.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(dst, crlf, 'utf8');
}

function dirSizeMb(dir: string): number {
  let bytes = 0;
  function walk(p: string) {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(p)) walk(path.join(p, child));
    } else {
      bytes += stat.size;
    }
  }
  walk(dir);
  return Math.round(bytes / (1024 * 1024));
}

main().catch((err) => {
  console.error('\n[build] FAILED:', err.message);
  process.exit(1);
});
