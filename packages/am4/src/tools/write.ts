/**
 * AM4 write tools, all device-namespaced write tools removed v0.3.
 *
 * Migrations:
 *   - am4_set_param         → set_param({port:'am4',block,name,value,channel?})
 *   - am4_set_params        → set_params({port:'am4',writes:[...]})
 *   - am4_set_block_type    → set_block({port:'am4',slot,block_type})
 *   - am4_set_block_bypass  → set_bypass({port:'am4',block,bypassed})
 *
 * The long behavioral guidance these descriptions used to carry
 * (relative-change, tempo/time, channel/scene, enum naming, reverb
 * naming, param-name aliases, ack caveat) migrated to
 * describe_device({port:'am4'}).agent_guidance in chunk 1.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerWriteTools(_server: McpServer): void {
    // intentionally empty, all AM4 device-namespaced write tools
    // removed v0.3 (use unified set_param / set_params / set_block /
    // set_bypass with port='am4').
}
