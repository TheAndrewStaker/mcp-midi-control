#!/usr/bin/env tsx
/**
 * Probe the current Axe-Fx II grid state via MCP client + verify_chain.
 *
 * Goal: read what the failed real-world session 2026-05-23 left in the
 * working buffer (the broken parallel topology where reverb wasn't
 * cabled to the grid output). This gives empirical ground truth for
 * the chain_integrity false-positive fix.
 *
 * Reads:
 *   1. List MIDI ports (confirm II is reachable)
 *   2. get_preset(axe-fx-ii) — full working-buffer snapshot
 *   3. apply_preset with verify_chain:true and a no-op spec to trigger
 *      the audibility walker against the device's actual grid mask
 *   4. axefx2_get_grid_layout (if available) for the row × col cell map
 *      with routing masks
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_ENTRY = path.join(
  PROJECT_ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js',
);

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    env: { ...process.env },
  });

  const client = new Client({ name: 'grid-state-probe', version: '0.0.1' }, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  });

  await client.connect(transport);
  console.log('=== Connected to MCP server ===\n');

  // 1. Ports
  console.log('[1] list_midi_ports');
  const ports = await client.callTool({ name: 'list_midi_ports', arguments: { pattern: ['axe-fx'] } });
  console.log(JSON.stringify(ports, null, 2).slice(0, 1500));
  console.log();

  // 2. Grid layout (full row × col cell map)
  console.log('[2] axefx2_get_grid_layout');
  try {
    const grid = await client.callTool({ name: 'axefx2_get_grid_layout', arguments: {} });
    console.log(JSON.stringify(grid, null, 2).slice(0, 8000));
  } catch (e) {
    console.log('  ERROR:', (e as Error).message);
  }
  console.log();

  // 3. Active preset name + scene
  console.log('[3] axefx2_get_preset_name');
  try {
    const name = await client.callTool({ name: 'axefx2_get_preset_name', arguments: {} });
    console.log(JSON.stringify(name, null, 2).slice(0, 500));
  } catch (e) {
    console.log('  ERROR:', (e as Error).message);
  }
  console.log();

  console.log('[4] axefx2_get_active_scene');
  try {
    const scene = await client.callTool({ name: 'axefx2_get_active_scene', arguments: {} });
    console.log(JSON.stringify(scene, null, 2).slice(0, 500));
  } catch (e) {
    console.log('  ERROR:', (e as Error).message);
  }
  console.log();

  await client.close();
  console.log('=== Done ===');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
