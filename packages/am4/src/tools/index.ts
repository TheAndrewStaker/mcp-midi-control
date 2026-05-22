/**
 * AM4 MCP tool aggregator, `registerAM4Tools(server)`.
 *
 * The AM4 tool surface is split across multiple files (one per tool
 * family) because the family-specific internals are too big to share a
 * file. `apply.ts` alone is 1633 LOC. This aggregator gives the rest of
 * the server a single entry point so `src/server/index.ts` calls one
 * `registerAM4Tools(server)` instead of eight separate `registerXTools`
 * lines.
 *
 * Pattern parity with other devices:
 *   src/fractal/am4/tools/index.ts  → registerAM4Tools(server)
 *   src/fractal/axe-fx-ii/tools.ts  → registerAxeFxIITools(server)
 *   src/asm/hydrasynth-explorer/server.ts → registerHydrasynthTools(server)
 *
 * Adding a new device follows the same shape: put the device's tools
 * under `src/<vendor>/<device>/tools.ts` (single-file) or
 * `src/<vendor>/<device>/tools/index.ts` (multi-file aggregator), then
 * register it in `src/server/index.ts`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerApplyTools } from './apply.js';
import { registerDiagnosticsTools } from './diagnostics.js';
import { registerLookupTools } from './lookup.js';
import { registerNavigationTools } from './navigation.js';
import { registerReadTools } from './read.js';
import { registerWriteTools } from './write.js';

export function registerAM4Tools(server: McpServer): void {
    registerWriteTools(server);
    registerReadTools(server);
    registerApplyTools(server);
    registerNavigationTools(server);
    registerLookupTools(server);
    registerDiagnosticsTools(server);
}
