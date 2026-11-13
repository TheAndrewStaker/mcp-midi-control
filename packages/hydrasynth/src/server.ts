#!/usr/bin/env node
/**
 * Hydrasynth MCP tool registration index.
 *
 * `registerHydrasynthTools(server)` composes the per-family
 * registrations. Each family file under `src/tools/` owns one
 * coherent slice:
 *
 *   - `shared.ts`     MIDI lazy-init, byte helpers, slot/note/bank
 *                     parsers, bank-PC dance, inbound-message decoder,
 *                     SysEx pacing constants, runEngineParamBatch
 *                     NRPN-batch executor
 *   - `params.ts`     set_system_param, set_macro
 *   - `patch.ts`      hydra_apply_init, apply_patch
 *   - `navigation.ts` hydra_navigate_to
 *   - `meta.ts`       describeHydrasynthPortStatus (port-scan helper,
 *                     no tool registrations)
 *   - `discovery.ts`  hydra_list_enum_values, hydra_param_catalog
 *
 * MIDI is opened lazily on the first tool call so the server can
 * register with Claude Desktop even if the Hydrasynth is unplugged.
 *
 * Run standalone for a sanity check (the import.meta.url guard at the
 * bottom spawns its own MCP stdio server with just these tools):
 *   npx tsx packages/hydrasynth/src/server.ts
 *
 * Important: CCs 0/1/7/11/32/64/123 (the "system" category in
 * params.ts) work whether the device's Param TX/RX is set to CC,
 * NRPN, or Off. The other 110 CCs require Param TX/RX = CC on the
 * device's MIDI page 10; otherwise the device receives the bytes
 * but doesn't act on them.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { registerHydrasynthDiscoveryTools } from './tools/discovery.js';
import { registerHydrasynthNavigationTools } from './tools/navigation.js';
import { registerHydrasynthParamTools } from './tools/params.js';
import { registerHydrasynthPatchTools } from './tools/patch.js';

export { describeHydrasynthPortStatus } from './tools/meta.js';

export function registerHydrasynthTools(server: McpServer): void {
  registerHydrasynthParamTools(server);
  // hydra_navigate_to removed from surface: diagnostic-only, redundant
  // with switch_preset for actual navigation. Code stays in navigation.ts.
  registerHydrasynthPatchTools(server);
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
  // v2 lifecycle: serveStdio owns the transport and pins one instance from
  // the factory per connection. The factory MUST mint a fresh McpServer per
  // call (v2 clients spawn a short-lived probe process, and a shared
  // instance leaks across successive connections).
  serveStdio(() => {
    const standaloneServer = new McpServer({
      name: 'hydrasynth-standalone',
      version: '0.1.0',
    });
    registerHydrasynthTools(standaloneServer);
    return standaloneServer;
  }, {
    onerror: (err) => {
      console.error('Hydrasynth server error:', err);
    },
  });
  console.error('Hydrasynth Explorer MCP server (standalone) running on stdio.');
  console.error(`Startup port scan: ${describeHydrasynthPortStatus()}.`);
}
