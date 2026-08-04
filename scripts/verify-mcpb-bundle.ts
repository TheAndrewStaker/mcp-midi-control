/**
 * verify-mcpb-bundle — the Desktop Extension counterpart to
 * `verify-release-zip.ts`. Extracts the built `.mcpb` into a clean tmpdir and
 * drives the server inside it over MCP. No hardware, no dev tree.
 *
 * WHY THIS EXISTS. Until now `build:mcpb` appeared exactly ONCE in the whole
 * repo — as a script definition. It was in no gate and no workflow, so the
 * `.mcpb` (the accessibility front door: one-click install, no Terminal, no
 * Node, no config editing) was the least-verified artifact we ship, while
 * being the one whose users are least able to diagnose a broken install.
 * `build-mcpb.ts` does smoke-boot its own staging dir, but that boot runs
 * INSIDE the monorepo checkout, where Node's resolver can walk up into the
 * repo's hoisted `node_modules` and satisfy an import the artifact does not
 * contain. That is exactly how packages have shipped absent from the Windows
 * ZIP with a green build (GitHub issue #15). Only an extract-and-boot check
 * outside the repo can see it, which is what this is.
 *
 * Checks:
 *   1. Archive shape: `manifest.json` at the ARCHIVE ROOT (a .mcpb is not
 *      nested under a versioned folder the way the installer ZIP is), the
 *      manifest's entry_point resolves, version/metadata agree with
 *      package.json, and mcp_config points at the same entry.
 *   2. Bundle contents vs the DERIVED closure: every scoped workspace package
 *      from `resolveBundlePackages()` is present as a real directory with a
 *      `dist/`, and every bare package is installed at the node_modules root.
 *      This is the hermetic proof of what `verify-bundle-package-lists.ts`
 *      asserts statically.
 *   3. Native bindings load under the runtime that will run the server.
 *   4. MCP handshake: serverInfo name/version, and `tools/list` against the
 *      README's generated inventory count.
 *   5. `describe_device` for EVERY registered device port. This is the loop
 *      that actually executes each device package's code out of the bundle's
 *      own node_modules — the check that would have caught `arturia` /
 *      `ve-500` / `boss-rc` / `openrig` shipping absent from this bundle.
 *
 * RUNTIME CAVEAT: Claude Desktop supplies its own Node to run an installed
 * extension; the .mcpb deliberately bundles no runtime. This script therefore
 * boots the bundle with the Node running the script (`process.execPath`),
 * which is the closest available stand-in. The manifest declares
 * `runtimes.node: >=20`, so any host Node in that range is expected to behave
 * the same; the artifact-completeness failures this gate exists to catch are
 * runtime-independent.
 *
 * Run: npx tsx scripts/verify-mcpb-bundle.ts [path-to-mcpb]
 * Default: build/dist/mcp-midi-control-v<version>-<platform>-<arch>.mcpb
 * Wired into `release-gate` (NOT preflight: it needs a built artifact).
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveBundlePackages } from './_lib/bundle-packages.js';
import {
  NATIVE_LOAD_TESTS,
  connectBundledServer,
  createChecker,
  ext,
  isError,
  extractArtifact,
  loadsUnder,
  readmeToolCount,
  registeredDevicePorts,
} from './_lib/mcp-bundle-harness.js';

const ROOT = process.cwd();
const version = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const platTag = `${process.platform}-${process.arch}`;
const defaultPath = path.join(ROOT, 'build', 'dist', `mcp-midi-control-v${version}-${platTag}.mcpb`);
const mcpbPath = process.argv[2] ?? defaultPath;

interface Manifest {
  manifest_version?: string;
  name?: string;
  version?: string;
  tools_generated?: boolean;
  server?: {
    type?: string;
    entry_point?: string;
    mcp_config?: { command?: string; args?: string[] };
  };
  compatibility?: { platforms?: string[]; runtimes?: Record<string, string> };
}

async function main(): Promise<void> {
  console.log(`verify-mcpb-bundle: ${mcpbPath}\n`);
  if (!existsSync(mcpbPath)) {
    console.error(`.mcpb not found: ${mcpbPath}`);
    console.error('Build it first: npm run build:mcpb');
    process.exit(1);
  }

  const checker = createChecker();
  const { check } = checker;

  // ── 1. Extract + archive shape ──────────────────────────────────────
  const workDir = extractArtifact(mcpbPath, 'mcp-midi-mcpb-verify-');
  console.log(`extracted to ${workDir}\n`);

  // A .mcpb puts manifest.json at the archive ROOT. If a build ever nests it
  // under a versioned folder (the installer-ZIP shape), Claude Desktop rejects
  // the extension with an unhelpful error, so assert the shape explicitly.
  const manifestPath = path.join(workDir, 'manifest.json');
  check('manifest.json at archive root (not nested)', existsSync(manifestPath), workDir);
  if (!existsSync(manifestPath)) {
    console.error(`\ntop-level entries: ${readdirSync(workDir).join(', ')}`);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  check(`manifest version ${manifest.version} === ${version}`, manifest.version === version);
  check('manifest name is mcp-midi-control', manifest.name === 'mcp-midi-control');
  check(`manifest_version declared (${manifest.manifest_version})`, typeof manifest.manifest_version === 'string');
  check('server.type === node', manifest.server?.type === 'node');
  check('tools_generated true (surface registered at runtime)', manifest.tools_generated === true);
  check('compatibility.runtimes.node declared', typeof manifest.compatibility?.runtimes?.node === 'string');

  const entryRel = manifest.server?.entry_point ?? '';
  const entry = path.join(workDir, entryRel);
  check(`manifest entry_point resolves (${entryRel})`, entryRel !== '' && existsSync(entry), entry);
  // The host launches `mcp_config.args`, not `entry_point`; a mismatch between
  // the two boots nothing while every other check still passes.
  const cfgArgs = manifest.server?.mcp_config?.args ?? [];
  check(
    'mcp_config args point at the same entry_point',
    cfgArgs.some((a) => a.includes(entryRel)),
    JSON.stringify(cfgArgs),
  );

  const bundlePkgPath = path.join(workDir, 'package.json');
  const bundlePkg = existsSync(bundlePkgPath)
    ? (JSON.parse(readFileSync(bundlePkgPath, 'utf8')) as { version?: string })
    : {};
  check(`bundled package version ${bundlePkg.version} === ${version}`, bundlePkg.version === version);

  // ── 2. Contents vs the DERIVED closure ──────────────────────────────
  // `verify-bundle-package-lists.ts` asserts this statically; here it is
  // proven against the finished artifact.
  const derived = resolveBundlePackages(ROOT);
  const nodeModules = path.join(workDir, 'node_modules');
  for (const pkg of derived.scoped) {
    const dir = path.join(nodeModules, '@mcp-midi-control', pkg.dir);
    check(
      `scoped package staged: @mcp-midi-control/${pkg.dir} (+dist)`,
      existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'dist')),
      dir,
    );
  }
  for (const pkg of derived.bare) {
    // Bare packages are installed from local tarballs — `openrig` and
    // `roland-midi` are private:true and unreachable from the registry, so
    // absence here means the extension dies on first launch.
    check(
      `bare package installed at node_modules root: ${pkg.name}`,
      existsSync(path.join(nodeModules, pkg.name, 'package.json')),
      path.join(nodeModules, pkg.name),
    );
  }
  for (const dep of derived.externalDeps) {
    check(`registry leaf dep installed: ${dep}`, existsSync(path.join(nodeModules, ...dep.split('/'))));
  }

  // ── 3. Native bindings load under the host runtime ──────────────────
  for (const t of NATIVE_LOAD_TESTS) {
    check(`${t.label} (host node ${process.version})`, loadsUnder(process.execPath, t.code, workDir));
  }

  // ── 4-5. Boot over MCP and sweep every registered device ────────────
  console.log('\nbooting the bundled server (mock transport) …');
  let client;
  try {
    client = await connectBundledServer({
      command: process.execPath,
      args: [entry],
      clientName: 'mcpb-verify',
    });
  } catch (err) {
    // A boot failure is a FAILED CHECK, not a crashed script: report it in the
    // same ledger as everything else so the summary is honest about how many
    // checks ran, and clean up the extraction.
    check('bundled server boots over MCP', false, err instanceof Error ? err.message : String(err));
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    console.error(`\n${checker.failed} of ${checker.total} CHECK(S) FAILED.`);
    process.exit(1);
  }
  check('bundled server boots over MCP', true);
  try {
    const sv = client.getServerVersion();
    check(
      `serverInfo ${sv?.name} ${sv?.version}`,
      sv?.name === 'mcp-midi-control' && sv?.version === version,
    );

    const tools = await client.listTools();
    const expected = readmeToolCount(ROOT);
    check(
      `tools/list returns ${expected ?? '?'} tools (per README inventory), got ${tools.tools.length}`,
      expected !== undefined && tools.tools.length === expected,
    );

    // Every registered device page == a registered descriptor id (gated by
    // verify-contribution-guides.ts), so this sweep grows with the roster.
    // It is the loop that executes each device package OUT OF THE BUNDLE.
    const ports = registeredDevicePorts(ROOT);
    console.log(`\ndescribe_device sweep over ${ports.length} registered port(s) …`);
    for (const port of ports) {
      const r = await client.callTool({ name: 'describe_device', arguments: { port } });
      const text = ext(r);
      check(`describe_device(${port})`, !isError(r) && text.length > 1000, text.slice(0, 160));
    }
  } finally {
    await client.close();
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(
    checker.failed === 0
      ? `\nMCPB BUNDLE VERIFIED — ${checker.total} checks pass (${platTag}).`
      : `\n${checker.failed} of ${checker.total} CHECK(S) FAILED.`,
  );
  process.exit(checker.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-mcpb-bundle failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
