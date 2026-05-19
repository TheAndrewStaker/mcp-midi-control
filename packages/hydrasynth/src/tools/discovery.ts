/**
 * Hydrasynth discovery tools removed v0.3 — use the unified surface:
 *
 *   describe_device({ port:'hydrasynth' })       — capabilities + blocks + agent_guidance
 *   list_params({ port:'hydrasynth', block? })    — param catalog
 *   list_params({ port:'hydrasynth', block, name })— enum table for that param
 *
 * The CC-style ↔ canonical-NRPN alias resolution that hydra_param_catalog
 * exposed is built into the unified set_param dispatcher — pass either
 * form ("filter1.cutoff" or "filter1cutoff") and the descriptor's
 * findHydraNrpn resolves both.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerHydrasynthDiscoveryTools(_server: McpServer): void {
    // intentionally empty — hydra_list_enum_values and hydra_param_catalog
    // removed v0.3 (use unified list_params with port='hydrasynth').
}
