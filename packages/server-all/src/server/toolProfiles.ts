/**
 * MCP_TOOLS_PROFILE — server-boot tool-surface gating.
 *
 * The project ships three profiles to balance Sonnet context budget
 * against capability breadth. Selected at server boot via the
 * MCP_TOOLS_PROFILE env var. Default = 'full' so existing
 * claude_desktop_config.json users see no behavior change.
 *
 *   core          ~25 tools — unified surface essentials + conversational
 *                  generic-MIDI primitives. Smallest agent context;
 *                  recommended for production conversations once the
 *                  unified surface covers everything you actually use.
 *
 *   experimental  ~80 tools — core + all device-namespaced tools +
 *                  generic-MIDI raw send_* + diagnostic / probe tools.
 *                  Used during dev when poking hardware-specific
 *                  capabilities the unified surface does not yet cover.
 *
 *   full          all registered tools (current default). Equivalent to
 *                  no env var. Preserved as the v0.1 baseline so
 *                  existing users do not lose tools on upgrade.
 *
 * Cut tools (T-2, T-6) get archived in docs/TOOL-ARCHIVE.md so the
 * capability knowledge is preserved when a tool drops out of every
 * profile (not the same as profile exclusion — archive is for full
 * removal, profiles are for visibility tuning).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ToolProfile = 'core' | 'experimental' | 'full';

const VALID_PROFILES = new Set<ToolProfile>(['core', 'experimental', 'full']);

/**
 * Read MCP_TOOLS_PROFILE from the environment. Empty / unset returns
 * 'core' (the subtraction-sprint default, flipped from 'full' on
 * 2026-05-21 before the v0.1.0 announce). Unknown values log to
 * stderr and fall back to 'core' rather than fail-fast: a typo in
 * claude_desktop_config.json should not brick the server.
 *
 * To expose the full registered surface (every device-namespaced
 * tool + diagnostic + debug tools), set MCP_TOOLS_PROFILE=full in
 * the config's env block.
 */
export function readToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = (env.MCP_TOOLS_PROFILE ?? '').trim().toLowerCase();
  if (raw === '') return 'core';
  if (VALID_PROFILES.has(raw as ToolProfile)) return raw as ToolProfile;
  console.error(
    `[MCP_TOOLS_PROFILE] "${raw}" is not a recognized profile, ` +
    `falling back to "core". Valid values: core, experimental, full.`,
  );
  return 'core';
}

/**
 * Core profile membership. The ~25 tools that cover conversational
 * tone-building, preset audition / save / switch / rename, scene
 * control, structured discovery (describe_device, find_compatible_types,
 * lookup_lineage, list_params, scan_locations), and the conversational
 * generic-MIDI primitives (play notes, list ports, reconnect).
 *
 * Inclusion criteria for a tool to land in core:
 *   1. Available on every registered device (port-dispatched) OR a
 *      generic-MIDI primitive that any device benefits from.
 *   2. Likely to be called by a non-technical musician during a typical
 *      tone-building or setlist-prep conversation.
 *   3. Stable wire layer (no [BETA] / community-beta tools land in core).
 *
 * Tools NOT in core but available in experimental + full:
 *   - All device-namespaced tools (am4_*, axefx2_*, axefx3_*, hydra_*)
 *   - Generic-MIDI raw send_* primitives (send_cc, send_sysex, etc.)
 *   - Diagnostic / probe tools
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  // Unified surface — essentials
  'apply_preset',
  'apply_setlist',
  'describe_device',
  'find_compatible_types',
  'get_param',
  'get_params',
  'get_preset',
  'list_params',
  'lookup_lineage',
  'nudge_param',
  'translate_preset', // renamed from port_preset (T-10, 2026-05-22) to match what it does
  'rename',
  'restore_defaults',
  'save_preset',
  'scan_locations',
  'set_block',
  'set_bypass',
  'set_param',
  'set_params',
  'switch_preset',
  'switch_scene',
  'toggle_bypass',
  // Generic-MIDI — conversational primitives only
  'list_midi_ports',
  'play_chord',
  'play_note',
  'reconnect_midi',
]);

/**
 * Tools EXCLUDED from the experimental profile. Reserved for tools that
 * exist only for short-lived debugging or one-off captures and should
 * never appear in either core or experimental. The membership is
 * intentionally small: experimental is the "dev surface" and should
 * still expose anything a device owner might want for diagnostics,
 * just not raw byte-banging.
 *
 * Each entry carries a one-line reason for the exclusion so a future
 * agent can decide whether to promote it back.
 */
export const EXPERIMENTAL_EXCLUDED: ReadonlySet<string> = new Set<string>([
  // Raw SysEx probes used for protocol RE only. Not a tool a device
  // owner calls in normal play. Hidden by default; flip
  // MCP_TOOLS_PROFILE=full to expose.
  'axefx2_probe_sysex',
  'axefx3_probe_sysex',
]);

export function isToolInProfile(name: string, profile: ToolProfile): boolean {
  if (profile === 'full') return true;
  if (profile === 'core') return CORE_TOOLS.has(name);
  return !EXPERIMENTAL_EXCLUDED.has(name);
}

/**
 * Wrap an McpServer with a Proxy that intercepts registerTool calls and
 * silently drops registrations whose tool name is not in the active
 * profile. All other server methods pass through unchanged.
 *
 * The wrapped server records skipped tool names on a side-channel field
 * (__skippedTools) so the startup banner can summarize what was hidden.
 *
 * 'full' profile short-circuits — returns the original server with no
 * Proxy overhead, preserving identity for downstream code paths that
 * might rely on it.
 */
export function wrapServerWithProfileFilter(
  server: McpServer,
  profile: ToolProfile,
): McpServer & { __skippedTools: readonly string[] } {
  const skipped: string[] = [];
  if (profile === 'full') {
    (server as McpServer & { __skippedTools: readonly string[] }).__skippedTools = skipped;
    return server as McpServer & { __skippedTools: readonly string[] };
  }
  const proxy = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === '__skippedTools') return skipped;
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) => {
          if (isToolInProfile(name, profile)) {
            const fn = Reflect.get(target, prop, receiver) as unknown as (
              n: string,
              ...r: unknown[]
            ) => unknown;
            return fn.call(target, name, ...rest);
          }
          skipped.push(name);
          // Return a no-op stub matching the RegisteredTool shape minimally;
          // no callers in this codebase use the return value.
          return undefined;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  }) as McpServer & { __skippedTools: readonly string[] };
  return proxy;
}
