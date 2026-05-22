/**
 * Axe-Fx II discovery tools removed v0.3, use the unified surface:
 *
 *   describe_device({ port:'axe-fx-ii' })       , capabilities + blocks
 *   list_params({ port:'axe-fx-ii', block? })    , param catalog
 *   list_params({ port:'axe-fx-ii', block, name }), enum table for that param
 *   lookup_lineage({ port:'axe-fx-ii', block_type, name?, real_gear?,
 *                    manufacturer?, model?, include_quotes? })
 *
 * The unified lookup_lineage routes through descriptor.reader.lookup
 * Lineage which wraps `runAxeFxIILineageLookup` and surfaces matchVia +
 * flags identically to the legacy axefx2_lookup_lineage tool.
 *
 * The legacy axefx2_lookup_lineage description carried multi-section
 * agent guidance about matchVia values (direct / abbrev-expand / reverb-
 * swap / prefix / unmatched) and known data-quality flags. That guidance
 * migrated into describe_device({ port:'axe-fx-ii' }).agent_guidance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerAxeFxIIDiscoveryTools(_server: McpServer): void {
    // intentionally empty, axefx2_list_params, axefx2_list_enum_values,
    // axefx2_lookup_lineage removed v0.3 (use unified list_params /
    // lookup_lineage with port='axe-fx-ii').
}
