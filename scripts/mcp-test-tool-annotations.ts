/**
 * Smoke test for bucket 6 (commit 784c5d8): verifies every registered
 * tool actually emits ToolAnnotations via tools/list per the MCP
 * 2025-11-25 spec.
 *
 * The spec defaults `destructiveHint=true` when annotations are absent,
 * so this test catches the regression where a new tool ships without
 * its annotation block and quietly inherits "potentially destructive."
 *
 * Spawns the dist server with MCP_MOCK_TRANSPORT=1 (no hardware
 * required), calls listTools(), and asserts:
 *
 *   1. EVERY tool carries an annotations object.
 *   2. Read tools (whitelist by name pattern) declare readOnlyHint: true.
 *   3. Destructive tools (whitelist) declare destructiveHint: true.
 *   4. Working-buffer writes do NOT carry destructiveHint: true
 *      (they're additive / reversible).
 *
 * Run: `npm run build && npx tsx scripts/mcp-test-tool-annotations.ts`
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(
  process.cwd(),
  'packages',
  'server-all',
  'dist',
  'server',
  'index.js',
);

interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolDef {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  outputSchema?: unknown;
}

// Names that MUST be readOnlyHint: true.
const READ_TOOLS = new Set([
  'describe_device',
  'list_params',
  'list_midi_ports',
  'find_compatible_types',
  'lookup_lineage',
  'scan_locations',
  'get_param',
  'get_params',
  'am4_get_block_layout',
  'am4_get_active_scene',
  'am4_get_active_location',
  'am4_get_block_bypass',
  'am4_request_active_buffer_dump',
  'axefx2_get_preset_name',
  'axefx2_get_active_preset_number',
  'axefx2_get_block_channel',
  'axefx2_get_grid_layout',
  'axefx3_get_bypass',
  'axefx3_get_channel',
  'axefx3_get_parameter',
  'axefx3_get_active_scene',
  'axefx3_get_preset_name',
  'axefx3_get_scene_name',
  'axefx3_get_tempo',
  'axefx3_get_looper_state',
  'axefx3_status_dump',
  'axefx3_list_blocks',
  'hydra_get_active_patch',
]);

// Names that MUST be destructiveHint: true.
const DESTRUCTIVE_TOOLS = new Set([
  'save_preset',
  'restore_defaults',
  'apply_setlist',
  'apply_preset',
  'port_preset',
  'hydra_apply_patch',
  'send_sysex',
  'axefx2_probe_sysex',
  'axefx3_probe_sysex',
]);

// Names that MUST NOT be destructiveHint: true (working-buffer writes).
const ADDITIVE_TOOLS = new Set([
  'set_param',
  'set_params',
  'set_block',
  'set_bypass',
  'switch_preset',
  'switch_scene',
  'rename',
  'reconnect_midi',
  'play_note',
  'play_chord',
  'axefx2_set_block_channel',
  'axefx2_set_block_at_cell',
  'axefx2_set_cell_routing',
  'axefx2_reconnect_midi',
  'axefx3_set_channel',
  'axefx3_set_parameter',
  'axefx3_set_tempo',
  'axefx3_set_tuner',
  'axefx3_reconnect_midi',
  'hydra_set_param',
  'hydra_set_macro',
  'hydra_navigate_to',
  'hydra_apply_init',
  'hydra_apply_init_to',
  'hydra_reconnect_midi',
]);

// Tools that MUST declare an outputSchema (bucket 6 set).
const OUTPUT_SCHEMA_TOOLS = new Set([
  'axefx2_set_block_channel',
  'axefx2_get_block_channel',
  'hydra_set_param',
  'hydra_set_macro',
  'hydra_navigate_to',
  'axefx3_get_bypass',
  'axefx3_set_channel',
  'axefx3_get_channel',
  'axefx3_set_parameter',
  'axefx3_get_parameter',
  'am4_get_block_bypass',
]);

interface Issue {
  tool: string;
  problem: string;
}
const ISSUES: Issue[] = [];

async function main(): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MCP_MOCK_TRANSPORT: '1',
    // Annotation check covers the entire registered surface, not just
    // the default `core` profile. Force `full` so every tool is visible.
    MCP_TOOLS_PROFILE: 'full',
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'mcp-test-tool-annotations', version: '1.0.0' },
    { capabilities: {} },
  );

  let pass = true;
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools as ToolDef[];

    console.log(`Got ${tools.length} tools from server.\n`);

    let withAnnotations = 0;
    let withReadOnly = 0;
    let withDestructive = 0;
    let withIdempotent = 0;
    let withOutputSchema = 0;

    for (const t of tools) {
      // (1) Every tool must carry annotations.
      if (!t.annotations || Object.keys(t.annotations).length === 0) {
        ISSUES.push({ tool: t.name, problem: 'missing annotations object' });
        continue;
      }
      withAnnotations++;
      if (t.annotations.readOnlyHint === true) withReadOnly++;
      if (t.annotations.destructiveHint === true) withDestructive++;
      if (t.annotations.idempotentHint === true) withIdempotent++;
      if (t.outputSchema) withOutputSchema++;

      // (2) Read tools must declare readOnlyHint: true.
      if (READ_TOOLS.has(t.name) && t.annotations.readOnlyHint !== true) {
        ISSUES.push({
          tool: t.name,
          problem: `expected readOnlyHint:true on read tool, got ${JSON.stringify(t.annotations)}`,
        });
      }
      // (3) Destructive tools must declare destructiveHint: true.
      if (DESTRUCTIVE_TOOLS.has(t.name) && t.annotations.destructiveHint !== true) {
        ISSUES.push({
          tool: t.name,
          problem: `expected destructiveHint:true on destructive tool, got ${JSON.stringify(t.annotations)}`,
        });
      }
      // (4) Working-buffer writes must NOT be destructiveHint: true.
      if (ADDITIVE_TOOLS.has(t.name) && t.annotations.destructiveHint === true) {
        ISSUES.push({
          tool: t.name,
          problem: `expected destructiveHint:false (working-buffer write), got destructiveHint:true`,
        });
      }
      // (5) Bucket 6 outputSchema set must declare outputSchema.
      if (OUTPUT_SCHEMA_TOOLS.has(t.name) && !t.outputSchema) {
        ISSUES.push({
          tool: t.name,
          problem: 'expected outputSchema declared (bucket 6 set), got none',
        });
      }
    }

    console.log(`Annotation coverage:`);
    console.log(`  ${withAnnotations}/${tools.length} tools carry annotations.`);
    console.log(`  ${withReadOnly} declare readOnlyHint: true`);
    console.log(`  ${withDestructive} declare destructiveHint: true`);
    console.log(`  ${withIdempotent} declare idempotentHint: true`);
    console.log(`  ${withOutputSchema} declare outputSchema`);
    console.log('');

    if (ISSUES.length === 0) {
      console.log(`✓ PASS — all ${tools.length} tools annotated correctly.`);
    } else {
      pass = false;
      console.log(`✗ FAIL — ${ISSUES.length} issue${ISSUES.length === 1 ? '' : 's'}:\n`);
      for (const issue of ISSUES) {
        console.log(`  ${issue.tool}: ${issue.problem}`);
      }
    }
  } finally {
    await client.close();
  }

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
