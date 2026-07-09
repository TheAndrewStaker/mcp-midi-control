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
 *      (fetches @julusian/midi's N-API prebuilt binary — no compile needed).
 *   6. Verify staging by invoking the bundled node --version and load-testing
 *      the entry point + the @julusian/midi and serialport native bindings.
 *   7. Package build/staging/ into a versioned ZIP at build/dist/.
 *
 * Usage:
 *   npm run build:installer
 *   npm run build:installer -- --clean   # also wipe build/node-cache
 *
 * Why bundle Node + node_modules instead of using `pkg`/`nexe`/SEA:
 *   See docs/_private/DECISIONS.md packager row. The native @julusian/midi `.node`
 *   addon is friendliest with file-on-disk distribution; single-binary
 *   tools handle native addons via fragile runtime extraction.
 */

import { execSync, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import AdmZip from 'adm-zip';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

// Single source of truth: .node-version at repo root. Both CI workflows
// (preflight.yml, release.yml) read the same file via setup-node's
// `node-version-file`. Bump .node-version, not this file.
const NODE_VERSION = fs.readFileSync(
  path.join(PROJECT_ROOT, '.node-version'), 'utf8',
).trim();
const NODE_ARCH = 'win-x64';
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
  // Node-major consistency note (no longer ABI-critical). The native MIDI
  // binding is now `@julusian/midi`, which ships N-API (node-napi-v7) prebuilds.
  // N-API is ABI-stable across Node majors, so a prebuilt binary fetched during
  // `npm ci` loads under the bundled Node regardless of the build host's Node
  // major — the ERR_DLOPEN_FAILED ABI-mismatch class that burned the alpha.2
  // release (CI Node 20 vs bundled Node 24) cannot happen with the prebuild. We
  // keep a soft warning for consistency, and the real gate is the staging
  // load-test below (it actually `require()`s the binding under the bundled node).
  const runningMajor = process.version.split('.')[0];
  const bundledMajor = `v${NODE_VERSION.split('.')[0]}`;
  if (runningMajor !== bundledMajor) {
    console.warn(
      `[build] note: building on Node ${process.version} while bundling Node v${NODE_VERSION}. ` +
      `Harmless with @julusian/midi's N-API prebuild (ABI-stable); the staging load-test is authoritative.`,
    );
  }
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
  //   │   ├── @julusian/midi/             (npm install populates, N-API prebuild)
  //   │   ├── zod/                        (npm install populates)
  //   │   └── @mcp-midi-control/
  //   │       ├── core/{package.json,dist/}        (copied from packages/core)
  //   │       ├── am4/{package.json,dist/}         (copied from packages/am4)
  //   │       ├── axe-fx-ii/{package.json,dist/}
  //   │       ├── axe-fx-gen1/{package.json,dist/}
  //   │       ├── fractal-gen3/{package.json,dist/}
  //   │       ├── hydrasynth/{package.json,dist/}
  //   │       └── server-all/{package.json,dist/}
  //   ├── LICENSE, NOTICE
  //   ├── setup.cmd, uninstall.cmd, verify-midi.cmd, update.cmd, instructions.txt
  //   └── install/{merge,unmerge}-mcp-config.ps1, check-for-update.ps1
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
    'fractal-gen1',
    'fractal-gen2',
    'fractal-gen3',
    'hydrasynth',
    'circuit-tracks',
    'spd-sx',
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
  const leafDeps = ['@modelcontextprotocol/sdk', 'fractal-midi', '@julusian/midi', 'serialport', 'zod'] as const;
  const leanDeps: Record<string, string> = {};
  for (const d of leafDeps) {
    const v = devPkg.devDependencies?.[d] ?? devPkg.dependencies?.[d];
    if (!v) throw new Error(`Leaf dep ${d} missing from root package.json`);
    leanDeps[d] = v;
  }
  // fractal-midi is a workspace package. Pack it into a tarball so the
  // release bundle is self-contained (no npm registry fetch needed at
  // install time). npm pack produces a tarball in the package directory;
  // we move it into staging and rewrite the lean package.json to point
  // at the local copy.
  const fractalMidiPkgDir = path.join(PROJECT_ROOT, 'packages', 'fractal-midi');
  const fractalMidiPkg = JSON.parse(
    fs.readFileSync(path.join(fractalMidiPkgDir, 'package.json'), 'utf8'),
  ) as { name: string; version: string };
  const packResult = execSync('npm pack --json', {
    cwd: fractalMidiPkgDir,
    encoding: 'utf8',
  });
  const packInfo = JSON.parse(packResult) as { filename: string }[];
  const tarballName = packInfo[0]?.filename;
  if (!tarballName) {
    throw new Error('npm pack for fractal-midi produced no output');
  }
  const tarballSrc = path.join(fractalMidiPkgDir, tarballName);
  const tarballDst = path.join(STAGING, tarballName);
  fs.renameSync(tarballSrc, tarballDst);
  leanDeps['fractal-midi'] = `file:./${tarballName}`;
  console.log(`[build] Packed fractal-midi workspace: ${tarballName} (v${fractalMidiPkg.version})`);
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
  for (const f of ['setup.cmd', 'uninstall.cmd', 'verify-midi.cmd', 'update.cmd', 'fm9-probe.cmd', 'fm3-probe.cmd', 'axefx3-probe.cmd', 'fm9-verify.cmd', 'fm3-verify.cmd', 'axefx3-verify.cmd', 'instructions.txt']) {
    copyAsCrlf(path.join(PROJECT_ROOT, 'installer', f), path.join(STAGING, f));
  }
  // PowerShell helpers go under install/ to keep the root tidy.
  const installerHelperDir = path.join(STAGING, 'install');
  fs.mkdirSync(installerHelperDir, { recursive: true });
  for (const f of ['merge-mcp-config.ps1', 'unmerge-mcp-config.ps1', 'check-for-update.ps1']) {
    copyAsCrlf(path.join(PROJECT_ROOT, 'installer', f), path.join(installerHelperDir, f));
  }

  // 5. Production-only npm install using the BUNDLED node + npm. With
  // @julusian/midi this fetches a per-platform N-API prebuilt binary (no
  // compile), so the binding is ABI-stable across Node majors. Only the leaf
  // deps install.
  //
  // ORDER MATTERS: install FIRST, copy workspace packages AFTER. If we
  // pre-place the workspace packages, npm install treats them as
  // orphans (no declaration in the lean package.json) and prunes them.
  // N-API means the bundled Node major no longer has to match the build host's
  // (the prebuild is selected by platform, not Node version), so the old
  // ERR_DLOPEN_FAILED ABI-mismatch class is gone; the staging load-test still
  // verifies the binding actually loads under the bundled node.
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

  // @julusian/midi ships per-platform N-API prebuilds
  // (node_modules/@julusian/midi/prebuilds/midi-<plat>-<arch>/node-napi-v7.node);
  // the exact path varies by platform, so a LOAD test under the bundled node beats
  // a file-path check (same approach as serialport below). This also proves the
  // prebuild actually loads + enumerates, not just that a file exists.
  try {
    execSync(
      `"${path.join(STAGING, 'node.exe')}" -e "const m=require('@julusian/midi'); new m.Output().getPortCount(); new m.Input().getPortCount();"`,
      { cwd: STAGING, stdio: 'pipe' },
    );
  } catch (err) {
    throw new Error(
      `@julusian/midi native binding failed to load under the bundled node (MIDI would be dead in the ZIP): ` +
      `${err instanceof Error ? err.message : String(err)}\n` +
      `Try: rm -rf build/staging/node_modules && re-run this script.`,
    );
  }
  console.log('[build] @julusian/midi native binding loads + enumerates under bundled node.');

  // serialport (the FM3 USB-CDC transport) loads its native binding from
  // @serialport/bindings-cpp prebuilds — layout varies by version, so a
  // LOAD test with the bundled node beats a file-path check. Without this,
  // a broken binding ships green and surfaces only for FM3 users, with a
  // misleading "could not open port" diagnostic.
  try {
    execSync(
      `"${path.join(STAGING, 'node.exe')}" -e "import('serialport').then(m => { if (!m.SerialPort) throw new Error('no SerialPort export'); }).catch(e => { console.error(e); process.exit(1); })"`,
      { cwd: STAGING, stdio: 'pipe' },
    );
  } catch (err) {
    throw new Error(
      `serialport failed to load under the bundled node (FM3 serial transport would be dead in the ZIP): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log('[build] serialport native binding loads under bundled node.');

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
  // written `staging/node_modules` tree. Their open handles can race
  // against our `fs.renameSync` causing intermittent EPERM. The
  // retryFsOp helper wraps the rename with bounded back-off.
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
    await createZip(versionedDir, RELEASE_ZIP_PATH);
  } finally {
    await retryFsOp('rename versioned dir -> staging', () => {
      fs.renameSync(versionedDir, STAGING);
    });
  }
  if (!fs.existsSync(RELEASE_ZIP_PATH)) {
    throw new Error(`ZIP creation did not produce ${RELEASE_ZIP_PATH}`);
  }
  const zipSizeMb = Math.round(fs.statSync(RELEASE_ZIP_PATH).size / (1024 * 1024));

  console.log('');
  console.log('[build] OK release bundle ready');
  console.log(`        staging:         ${STAGING} (${stagedSize} MB)`);
  console.log(`        release ZIP:     ${RELEASE_ZIP_PATH} (${zipSizeMb} MB)`);
  console.log(`        bundled node:    ${versionOutput}`);
  console.log(`        entry point:     node_modules/@mcp-midi-control/server-all/dist/server/index.js`);
  console.log(`        native MIDI:     node_modules/@julusian/midi/prebuilds/midi-<plat>-<arch>/node-napi-v7.node`);
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

async function createZip(sourceDir: string, destZip: string): Promise<void> {
  const topDir = path.basename(sourceDir);

  if (fs.existsSync(destZip)) fs.unlinkSync(destZip);

  const output = fs.createWriteStream(destZip);
  const archive = archiver('zip', { zlib: { level: 1 } });

  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.on('warning', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') console.warn(`[build] zip warning: ${err.message}`);
      else reject(err);
    });
  });

  archive.pipe(output);
  archive.directory(sourceDir, topDir);
  await archive.finalize();
  await done;
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
  const nodeZip = new AdmZip(zipPath);
  nodeZip.extractAllTo(NODE_CACHE, true);
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
