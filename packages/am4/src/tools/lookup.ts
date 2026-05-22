/**
 * AM4 lookup tools removed v0.3, use the unified surface:
 *
 *   list_params({ port:'am4', block?, name? }) , full catalog or scoped to block/name
 *   describe_device({ port:'am4' })            , capabilities + agent_guidance
 *
 * The MCP `initialize` handshake confirms the server is alive; the
 * earlier `live_confirmation` synthetic string on list_params was
 * dropped v0.4 because it duplicated info already in the handshake
 * and drifted on tool rename.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerLookupTools(_server: McpServer): void {
    // intentionally empty, am4_list_params, am4_list_block_types,
    // am4_list_enum_values removed v0.3 (use unified list_params with
    // port='am4').
}
