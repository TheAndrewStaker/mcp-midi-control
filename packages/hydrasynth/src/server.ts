#!/usr/bin/env node
/**
 * Hydrasynth Explorer — MCP tool registration index.
 *
 * Side-branch exploratory work — see CLAUDE.md and
 * `memory/feedback_am4_depth_gates_wave_expansion.md`. This module
 * registers the hydra_* tool family on the shared mcp-midi-control
 * server alongside the AM4 + Axe-Fx II surfaces.
 *
 * `registerHydrasynthTools(server)` composes the per-family
 * registrations. Each family file under
 * `src/asm/hydrasynth-explorer/tools/` owns one coherent slice:
 *
 *   - `shared.ts`     — MIDI lazy-init, byte helpers, slot/note/bank
 *                       parsers, bank-PC dance, inbound-message decoder,
 *                       SysEx pacing constants, the long preamble +
 *                       cheat-sheet strings, and the runEngineParamBatch
 *                       NRPN-batch executor
 *   - `params.ts`     — hydra_set_param, hydra_set_macro,
 *                       hydra_set_engine_param, hydra_set_engine_params
 *   - `patch.ts`      — hydra_apply_init, hydra_apply_init_to,
 *                       hydra_apply_patch (the 3 SysEx whole-patch dumps)
 *   - `navigation.ts` — hydra_navigate_to
 *   - `meta.ts`       — hydra_reconnect_midi, hydra_get_active_patch,
 *                       describeHydrasynthPortStatus
 *   - `discovery.ts`  — hydra_list_enum_values, hydra_param_catalog
 *
 * 14 tools total. MIDI is opened lazily on the first tool call so the
 * server can register with Claude Desktop even if the Hydrasynth is
 * unplugged.
 *
 * Run standalone for a sanity check (the import.meta.url guard at the
 * bottom spawns its own MCP stdio server with just these tools):
 *   npx tsx packages/hydrasynth/src/server.ts
 *
 * Important: CCs 0/1/7/11/32/64/123 (the "system" category in
 * params.ts) work whether the device's Param TX/RX is set to CC,
 * NRPN, or Off. The other 110 CCs require Param TX/RX = CC on the
 * device's MIDI page 10 — otherwise the device receives the bytes
 * but doesn't act on them.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerHydrasynthDiscoveryTools } from './tools/discovery.js';
import { registerHydrasynthMetaTools } from './tools/meta.js';
import { registerHydrasynthNavigationTools } from './tools/navigation.js';
import { registerHydrasynthParamTools } from './tools/params.js';
import { registerHydrasynthPatchTools } from './tools/patch.js';

export { describeHydrasynthPortStatus } from './tools/meta.js';

export function registerHydrasynthTools(server: McpServer): void {
  registerHydrasynthParamTools(server);
  registerHydrasynthNavigationTools(server);
  registerHydrasynthPatchTools(server);
  registerHydrasynthMetaTools(server);
  registerHydrasynthDiscoveryTools(server);
}

// -- Standalone debugging entrypoint --------------------------------------
//
// `npx tsx packages/hydrasynth/src/server.ts` still works for
// one-off testing of the Hydrasynth tools in isolation, without
// running the full mcp-midi-control server. Production launch path is
// the main server registering both AM4 and Hydrasynth tools.
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { describeHydrasynthPortStatus } from './tools/meta.js';

const isDirectInvocation =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  const standaloneServer = new McpServer({
    name: 'hydrasynth-standalone',
    version: '0.1.0',
  });
  registerHydrasynthTools(standaloneServer);
  const transport = new StdioServerTransport();
  standaloneServer.connect(transport).then(() => {
    console.error('Hydrasynth Explorer MCP server (standalone) running on stdio.');
    console.error(`Startup port scan: ${describeHydrasynthPortStatus()}.`);
  }).catch((err) => {
    console.error('Fatal Hydrasynth server error:', err);
    process.exit(1);
  });
}
