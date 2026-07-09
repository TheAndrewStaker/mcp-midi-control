#!/usr/bin/env node
/**
 * scripts/build-mcpb.ts
 *
 * Build a Claude Desktop Extension (`.mcpb`) for one-click install — the
 * accessibility front door for blind users (no Terminal, no Node install,
 * no Xcode, no config editing; Claude Desktop unpacks the bundle internally
 * so there is no Gatekeeper "unidentified developer" wall, and no $99 Apple
 * Developer fee). See docs/MCPB-EXTENSION.md and
 * docs/design/accessibility-blind-support.md.
 *
 * Output:
 *   build/mcpb-staging/                                         bundle contents
 *   build/dist/mcp-midi-control-v<version>-<platform>-<arch>.mcpb
 *
 * It reuses the same dependency-staging shape as build-installer.ts (lean
 * root package.json -> `npm install --omit=dev` leaf deps -> copy each
 * workspace package as a real dir under node_modules/@mcp-midi-control/),
 * but it does NOT bundle a Node runtime (Claude Desktop ships its own) and
 * it emits a `manifest.json` + a `.mcpb` (zip) instead of the Windows ZIP.
 *
 * PER-PLATFORM ARTIFACT: `npm install` fetches the prebuilt native bindings
 * for the BUILD HOST's platform/arch. @julusian/midi ships N-API prebuilds
 * and serialport's @serialport/bindings-cpp fetches per-platform, so the
 * produced `.mcpb` is correct for the host platform and is named accordingly
 * (…-darwin-arm64.mcpb). Build the blind-user target (darwin-arm64) on a
 * macos-14 runner. A universal multi-platform `.mcpb` would require bundling
 * every platform's prebuilds; that is a documented follow-up.
 *
 * Usage: `npm run build:mcpb`
 */
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(PROJECT_ROOT, 'build');
const STAGING = path.join(BUILD_DIR, 'mcpb-staging');
const DIST_DIR = path.join(BUILD_DIR, 'dist');

// Keep in sync with build-installer.ts WORKSPACE_PACKAGES / leafDeps — both
// describe the same bundle shape. (If you add a workspace package, add it in
// both places or the bundle boots partially with ERR_MODULE_NOT_FOUND.)
const WORKSPACE_PACKAGES = [
  'core', 'am4', 'fractal-gen1', 'fractal-gen2', 'fractal-gen3',
  'hydrasynth', 'circuit-tracks', 'spd-sx', 'server-all',
] as const;
const LEAF_DEPS = ['@modelcontextprotocol/sdk', 'fractal-midi', '@julusian/midi', 'serialport', 'zod'] as const;

const SERVER_ENTRY_REL = 'node_modules/@mcp-midi-control/server-all/dist/server/index.js';

interface RootPkg {
  version: string;
  description: string;
  author: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parseAuthor(author: string): { name: string; email?: string; url?: string } {
  // "Name <email> (url)" — email/url optional.
  const m = /^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?$/.exec(author.trim());
  if (!m) return { name: author.trim() };
  return { name: m[1]!.trim(), ...(m[2] ? { email: m[2] } : {}), ...(m[3] ? { url: m[3] } : {}) };
}

/** Build manifest.json from package.json — version + metadata never drift. */
function buildManifest(pkg: RootPkg): object {
  return {
    // mcpb manifest schema version (anthropics/mcpb). Bump if the schema does.
    manifest_version: '0.2',
    name: 'mcp-midi-control',
    display_name: 'MCP MIDI Control',
    version: pkg.version,
    description: pkg.description,
    long_description:
      'Control MIDI gear (Fractal AM4 / Axe-Fx II / III / FM3 / FM9 / VP4, ASM ' +
      'Hydrasynth, Novation Circuit Tracks, and any USB MIDI device) by ' +
      'conversation. Display-first, safe-by-default writes, the same guarantees ' +
      'across every device. The conversational, text-first surface is built to ' +
      'be driven by voice and screen readers.',
    author: parseAuthor(pkg.author),
    license: 'Apache-2.0',
    homepage: 'https://github.com/TheAndrewStaker/mcp-midi-control',
    documentation: 'https://github.com/TheAndrewStaker/mcp-midi-control/blob/main/README.md',
    repository: { type: 'git', url: 'https://github.com/TheAndrewStaker/mcp-midi-control' },
    keywords: ['midi', 'music', 'guitar', 'synth', 'fractal', 'axe-fx', 'hydrasynth', 'accessibility'],
    server: {
      type: 'node',
      entry_point: SERVER_ENTRY_REL,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${SERVER_ENTRY_REL}`],
        // FM3-only USB-serial override. Blank -> the transport auto-detects
        // (serialTransport treats "" as unset: `if (!path) autodetect`).
        env: { MCP_FM3_SERIAL_PATH: '${user_config.fm3_serial_path}' },
      },
    },
    // The server registers its full tool surface at runtime; Claude Desktop
    // discovers it on connect. No need to enumerate (and risk drift) here.
    tools_generated: true,
    user_config: {
      fm3_serial_path: {
        type: 'string',
        title: 'FM3 serial port (optional)',
        description:
          'Only for the Fractal FM3, which talks over USB-serial rather than ' +
          'MIDI. Leave blank to auto-detect. Examples: macOS /dev/cu.usbmodemXXXX, ' +
          'Linux /dev/ttyACM0, Windows COM3. No other device needs this.',
        required: false,
        sensitive: false,
      },
    },
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: '>=20.0.0' },
    },
  };
}

function loadTest(label: string, code: string): void {
  try {
    execSync(`node -e "${code}"`, { cwd: STAGING, stdio: 'pipe' });
    console.log(`[mcpb] ${label} loads under node ✓`);
  } catch (err) {
    throw new Error(`[mcpb] ${label} failed to load in the staged bundle: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function createMcpb(sourceDir: string, dest: string): Promise<void> {
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  const output = fs.createWriteStream(dest);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);
  // .mcpb contents live at the ARCHIVE ROOT (manifest.json at top level),
  // unlike the installer ZIP which nests under a versioned folder.
  archive.directory(sourceDir, false);
  await archive.finalize();
  await done;
}

async function main(): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as RootPkg;
  const platTag = `${process.platform}-${process.arch}`;
  console.log(`[mcpb] Building mcp-midi-control v${pkg.version} for ${platTag}`);

  // 1. Clean staging.
  if (fs.existsSync(STAGING)) fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });

  // 2. Compile all workspace packages.
  console.log('[mcpb] Building TypeScript (all workspace packages)');
  execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // 3. Lean root package.json: leaf deps only. fractal-midi is a workspace
  //    package — pack it to a tarball so the bundle is self-contained.
  const leanDeps: Record<string, string> = {};
  for (const d of LEAF_DEPS) {
    if (d === 'fractal-midi') continue; // handled via tarball below
    const v = pkg.devDependencies?.[d] ?? pkg.dependencies?.[d];
    if (!v) throw new Error(`Leaf dep ${d} missing from root package.json`);
    leanDeps[d] = v;
  }
  const fmDir = path.join(PROJECT_ROOT, 'packages', 'fractal-midi');
  const packInfo = JSON.parse(execSync('npm pack --json', { cwd: fmDir, encoding: 'utf8' })) as { filename: string }[];
  const tarball = packInfo[0]?.filename;
  if (!tarball) throw new Error('npm pack for fractal-midi produced no output');
  fs.renameSync(path.join(fmDir, tarball), path.join(STAGING, tarball));
  leanDeps['fractal-midi'] = `file:./${tarball}`;

  fs.writeFileSync(path.join(STAGING, 'package.json'),
    JSON.stringify({ name: 'mcp-midi-control-mcpb', version: pkg.version, private: true, type: 'module', dependencies: leanDeps }, null, 2) + '\n');

  // 4. Install leaf deps (fetches the host platform's N-API prebuilds). Use
  //    npm from PATH — no bundled Node; Claude Desktop provides the runtime.
  console.log('[mcpb] Installing leaf production deps (fetches native prebuilds for this platform)');
  execSync('npm install --omit=dev --no-package-lock', { cwd: STAGING, stdio: 'inherit' });

  // 5. Copy workspace packages as real dirs under node_modules (AFTER install
  //    so npm doesn't prune them); strip @mcp-midi-control/* internal deps.
  const mcpNs = path.join(STAGING, 'node_modules', '@mcp-midi-control');
  fs.mkdirSync(mcpNs, { recursive: true });
  for (const p of WORKSPACE_PACKAGES) {
    const src = path.join(PROJECT_ROOT, 'packages', p);
    const dst = path.join(mcpNs, p);
    fs.mkdirSync(dst, { recursive: true });
    const pj = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; [k: string]: unknown };
    if (pj.dependencies) pj.dependencies = Object.fromEntries(Object.entries(pj.dependencies).filter(([n]) => !n.startsWith('@mcp-midi-control/')));
    fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify(pj, null, 2) + '\n');
    fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true });
  }

  // 6. Write manifest.json at the bundle root.
  fs.writeFileSync(path.join(STAGING, 'manifest.json'), JSON.stringify(buildManifest(pkg), null, 2) + '\n');

  // 7. Verify: entry exists, native bindings load, server smoke-boots.
  const entry = path.join(STAGING, SERVER_ENTRY_REL);
  if (!fs.existsSync(entry)) throw new Error(`Entry point missing at ${entry}`);
  loadTest('@julusian/midi', "const m=require('@julusian/midi'); new m.Input().getPortCount(); new m.Output().getPortCount();");
  loadTest('serialport', "import('serialport').then(m=>{if(!m.SerialPort)process.exit(1)}).catch(()=>process.exit(1))");

  console.log('[mcpb] Smoke-booting staged server (15s timeout)');
  const smoke = spawnSync('node', [entry], { input: '', timeout: 15_000, encoding: 'utf8' });
  if (smoke.stderr?.includes('ERR_MODULE_NOT_FOUND')) {
    throw new Error(`Smoke-boot ERR_MODULE_NOT_FOUND — a package is missing from the bundle.\n${smoke.stderr}`);
  }
  if (!smoke.stderr?.includes('MCP MIDI Control MCP server running on stdio')) {
    throw new Error(`Smoke-boot did not print the startup banner.\nstderr:\n${smoke.stderr}`);
  }
  console.log('[mcpb] Server smoke-boots ✓');

  // 8. Pack the .mcpb.
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const mcpbPath = path.join(DIST_DIR, `mcp-midi-control-v${pkg.version}-${platTag}.mcpb`);
  await createMcpb(STAGING, mcpbPath);
  const sizeMb = Math.round(fs.statSync(mcpbPath).size / (1024 * 1024));

  console.log('');
  console.log('[mcpb] OK Desktop Extension ready');
  console.log(`       manifest:  ${path.join(STAGING, 'manifest.json')}`);
  console.log(`       artifact:  ${mcpbPath} (${sizeMb} MB, ${platTag})`);
  console.log('');
  console.log('Validate (optional): npx @anthropic-ai/mcpb validate ' + path.join(STAGING, 'manifest.json'));
  console.log('Install: open the .mcpb in Claude Desktop (Settings -> Extensions), or drag it in.');
  console.log('NOTE: this artifact carries the prebuilds for THIS platform (' + platTag + '). ' +
    'Build the blind-user target on a macos-14 (darwin-arm64) runner.');
}

main().catch((err) => {
  console.error('\n[mcpb] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
