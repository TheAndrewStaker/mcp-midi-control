/**
 * mcp-bundle-harness — extract a BUILT release artifact into a clean tmpdir,
 * boot the server inside it over MCP, and assert against the real thing.
 *
 * WHY A SHARED MODULE. Every builder in this repo carries its own smoke-boot,
 * and every one of those smoke-boots runs INSIDE the monorepo checkout, where
 * Node's ESM resolver can walk up past the staging dir into the repo's own
 * hoisted `node_modules` and silently satisfy an import the artifact does not
 * actually contain. That is how `ve-500` / `boss-rc` / `roland-midi` shipped
 * absent from the Windows ZIP for two releases (GitHub issue #15) with a green
 * build every time. The ONLY check that catches it is one that extracts the
 * finished artifact into an OS tmpdir — no monorepo ancestor to leak into —
 * and boots it there. `verify-release-zip.ts` does that for the Windows ZIP;
 * `verify-mcpb-bundle.ts` does it for the Desktop Extension. The boot logic is
 * identical, so it lives here once.
 *
 * NOTE FOR A FOLLOW-UP: `verify-release-zip.ts` still carries its own inline
 * copy of these helpers. It was outside the edit scope of the change that
 * created this module, so it has not been migrated yet. This module was
 * written as its extraction target — the function shapes (`check`, `ext`,
 * `isError`) deliberately match its locals, so the migration is mechanical.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ── pass/fail accounting ──────────────────────────────────────────────────

export interface Checker {
  /** Record one assertion. `detail` is printed only on failure. */
  check(label: string, ok: boolean, detail?: string): void;
  /** How many assertions failed so far. */
  readonly failed: number;
  /** How many assertions ran so far. */
  readonly total: number;
}

export function createChecker(): Checker {
  let failed = 0;
  let total = 0;
  return {
    check(label: string, ok: boolean, detail?: string): void {
      total++;
      if (ok) console.log(`  OK    ${label}`);
      else { failed++; console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`); }
    },
    get failed() { return failed; },
    get total() { return total; },
  };
}

// ── MCP tool-result shape helpers ─────────────────────────────────────────

/** Concatenate the text content blocks of an MCP tool result. */
export function ext(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const c = result as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? [])
    .filter((x) => x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text!)
    .join('\n');
}

export function isError(result: unknown): boolean {
  return !!(result as { isError?: boolean } | undefined)?.isError;
}

// ── artifact extraction ───────────────────────────────────────────────────

/**
 * Extract a zip-family artifact (`.zip`, `.mcpb`) into a fresh OS tmpdir and
 * return the directory. The tmpdir placement is the load-bearing part: it puts
 * the bundle outside the monorepo so a missing package cannot be satisfied by
 * the repo's hoisted node_modules.
 *
 * Uses AdmZip rather than the platform `tar`, because a `.mcpb` is a zip with
 * a non-zip extension and AdmZip reads the archive header instead of guessing
 * from the filename.
 */
export function extractArtifact(archivePath: string, tmpPrefix: string): string {
  const workDir = mkdtempSync(path.join(tmpdir(), tmpPrefix));
  new AdmZip(archivePath).extractAllTo(workDir, true);
  return workDir;
}

/**
 * Native bindings ship as per-platform prebuilds whose on-disk path varies by
 * platform, arch and package version, so a file-path check goes stale silently.
 * Actually LOADING the binding under the runtime that will run it is the only
 * durable check.
 */
export function loadsUnder(nodeExe: string, code: string, cwd: string): boolean {
  try {
    execFileSync(nodeExe, ['-e', code], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** The two native bindings every bundle must be able to load. */
export const NATIVE_LOAD_TESTS: ReadonlyArray<{ label: string; code: string }> = [
  {
    label: 'native MIDI binding (@julusian/midi) loads + enumerates',
    code: "const m=require('@julusian/midi'); new m.Output().getPortCount(); new m.Input().getPortCount();",
  },
  {
    label: 'serialport (FM3 serial transport) loads',
    code: "import('serialport').then(m => { if (!m.SerialPort) throw new Error('no SerialPort export'); }).catch(e => { console.error(e); process.exit(1); })",
  },
];

// ── booting the bundled server ────────────────────────────────────────────

/**
 * Boot a bundled server over stdio MCP with the mock wire transport (no
 * hardware, no real MIDI ports) and return a connected client. The caller
 * closes it.
 */
export async function connectBundledServer(opts: {
  /** Runtime to run the server with (bundled node.exe, or process.execPath). */
  command: string;
  /** Args, normally `[entryPointPath]`. */
  args: string[];
  /** Client name reported in the MCP handshake. */
  clientName: string;
  /** Extra env on top of the inherited environment. */
  env?: Record<string, string>;
}): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.MCP_MOCK_TRANSPORT = '1';
  for (const [k, v] of Object.entries(opts.env ?? {})) env[k] = v;

  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: opts.clientName, version: '1' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (err) {
    // A bundle missing a package dies during module load, so the MCP handshake
    // just reports "Connection closed" — which says nothing about the cause,
    // and the cause is precisely what this class of gate exists to name. The
    // transport's stderr pipe is gone by now, so re-run the entry point once,
    // directly, purely to capture the real stack.
    try { await transport.close(); } catch { /* best-effort */ }
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n${diagnoseBootFailure(opts.command, opts.args, env)}`);
  }
  return client;
}

/**
 * Boot the server once with plain stdio and turn its stderr into an
 * explanation. Called only after a failed MCP connect.
 */
function diagnoseBootFailure(command: string, args: string[], env: Record<string, string>): string {
  const r = spawnSync(command, args, { input: '', timeout: 20_000, encoding: 'utf8', env });
  const stderr = (r.stderr ?? '').trim();
  if (stderr === '') return 'The server produced no stderr when re-run directly; it may have hung or been killed.';
  const missing = /Cannot find (?:package|module) '([^']+)'/.exec(stderr);
  const headline = missing
    ? `The bundle is MISSING "${missing[1]}" — it is not in the artifact's node_modules, so the server dies during module load. `
      + 'This resolves fine in the dev tree (workspace hoisting) and only fails for a real user.'
    : 'The server failed to boot from the extracted artifact.';
  return `${headline}\n\n--- server stderr ---\n${stderr.slice(0, 4000)}`;
}

// ── expectations derived from the repo, never hardcoded ───────────────────

/**
 * The tool count the README's generated inventory region advertises (kept
 * fresh by `npm run tools:inventory-check` in preflight). Reading it beats
 * hardcoding a number that goes stale the next time a tool ships.
 */
export function readmeToolCount(projectRoot: string): number | undefined {
  const readme = readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  const m = readme.match(/\*\*(\d+) MCP tools registered\.\*\*/);
  return m ? Number(m[1]) : undefined;
}

/**
 * Every registered device port, derived from `docs/contributing/devices/*.md`.
 *
 * That directory is 1:1 with the registered descriptors BY GATE: the filename
 * IS the descriptor id, and `scripts/verify-contribution-guides.ts` (in
 * preflight) fails on a missing page or an orphan page. So deriving the sweep
 * roster from it means a newly registered device is exercised against the
 * bundle automatically — which matters, because the whole reason this file
 * exists is that `arturia` (microfreak / minifreak) was registered and then
 * silently left out of a bundle.
 */
export function registeredDevicePorts(projectRoot: string): string[] {
  const dir = path.join(projectRoot, 'docs', 'contributing', 'devices');
  if (!existsSync(dir)) throw new Error(`registeredDevicePorts: no device-page directory at ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}
