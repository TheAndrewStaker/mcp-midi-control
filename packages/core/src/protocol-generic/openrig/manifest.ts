/**
 * OpenRig Phase C: load a rig manifest (an OpenRig L1 `rig.json`) the reference
 * implementation validates and surfaces through `describe_rig`.
 *
 * Source: the `MCP_RIG_MANIFEST` env var, an absolute (or cwd-relative) path to a
 * rig.json. Env-var-driven ONLY, by design: there is no silent default-path load,
 * so `executeDescribeRig` stays a pure function of (registry, env) and every test
 * that touches it is hermetic (the golden simply clears the var). The maintainer
 * points the var at a private, gitignored `docs/_private/rig/rig.json` in the
 * server's launch config, exactly as `MCP_RIG_LINKS` / `MCP_FM3_SERIAL_PATH` are
 * set.
 *
 * Parsed once and cached (the manifest is stable for a server process; editing it
 * needs a relaunch, same as the compiled build). Call `clearRigManifestCache()`
 * in tests to re-read.
 */
import * as fs from 'node:fs';
import type { Rig } from 'openrig';

export const RIG_MANIFEST_ENV = 'MCP_RIG_MANIFEST';

export type LoadedRigManifest =
  | { status: 'loaded'; rig: Rig; source: string }
  | { status: 'error'; error: string; source: string }
  | { status: 'unconfigured' };

let cache: LoadedRigManifest | undefined;

function load(): LoadedRigManifest {
  const path = process.env[RIG_MANIFEST_ENV];
  if (path === undefined || path.trim() === '') return { status: 'unconfigured' };
  const source = path.trim();
  let raw: string;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (e) {
    return { status: 'error', source, error: `cannot read rig manifest at ${source}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { status: 'error', source, error: `rig manifest at ${source} is not valid JSON: ${(e as Error).message}` };
  }
  // Structural guard: valid JSON is not necessarily a Rig. Verify the shape the
  // consumers dereference (validateRig iterates nodes; deriveRigLinks maps them)
  // so a wrong/partial file degrades to a helpful status:'error' rather than
  // crashing describe_rig / apply_pattern with a bare TypeError.
  const obj = parsed as { nodes?: unknown; edges?: unknown };
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(obj.nodes) || !Array.isArray(obj.edges)) {
    return {
      status: 'error',
      source,
      error: `rig manifest at ${source} is not a valid OpenRig rig (expected a JSON object with "nodes" and "edges" arrays)`,
    };
  }
  return { status: 'loaded', rig: parsed as Rig, source };
}

/** The configured rig manifest, or `unconfigured` when `MCP_RIG_MANIFEST` is unset. Cached. */
export function loadRigManifest(): LoadedRigManifest {
  if (cache === undefined) cache = load();
  return cache;
}

/** Clear the parsed-manifest cache (tests). */
export function clearRigManifestCache(): void {
  cache = undefined;
}

/** The configured manifest path, or undefined when `MCP_RIG_MANIFEST` is unset. */
export function rigManifestSource(): string | undefined {
  const path = process.env[RIG_MANIFEST_ENV];
  return path === undefined || path.trim() === '' ? undefined : path.trim();
}

/**
 * Persist an edited rig back to the configured manifest file, BACKING UP the
 * existing file first (safe-edit contract: no silent overwrite of a config the
 * server did not create). Writes pretty JSON, then invalidates the parse cache
 * so the next `loadRigManifest` / `describe_rig` reflects the change. The caller
 * is responsible for having VALIDATED `rig` before calling this (a malformed rig
 * must never reach disk).
 */
export function writeRigManifest(rig: Rig): { source: string; backup?: string } {
  const source = rigManifestSource();
  if (source === undefined) {
    throw new Error(`${RIG_MANIFEST_ENV} is not set; there is no rig manifest to write.`);
  }
  let backup: string | undefined;
  if (fs.existsSync(source)) {
    backup = `${source}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(source, backup);
  }
  fs.writeFileSync(source, `${JSON.stringify(rig, null, 2)}\n`, 'utf8');
  cache = undefined;
  return { source, backup };
}
