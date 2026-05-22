/**
 * Axe-Fx II param tools removed v0.3, use the unified surface:
 *
 *   set_param({ port:'axe-fx-ii', block, name, value, channel? })
 *   get_param({ port:'axe-fx-ii', block, name, channel? })
 *
 * Both unified tools route through descriptor.writer.setParam /
 * descriptor.reader.getParam which carry the same display/wire
 * resolution logic the legacy axefx2_set_param / axefx2_get_param used.
 *
 * Behavioral guidance previously carried by these descriptions
 * (volume language, display-first contract, X/Y channel model,
 * NO-ACK protocol caveat) migrated into describe_device({
 * port:'axe-fx-ii' }).agent_guidance.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerAxeFxIIParamTools(_server: McpServer): void {
    // intentionally empty, axefx2_set_param / axefx2_get_param removed
    // v0.3 (use unified set_param / get_param with port='axe-fx-ii').
}
