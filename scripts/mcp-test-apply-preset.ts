/**
 * MCP-driven hardware test harness for the unified `apply_preset` on the
 * Axe-Fx II.
 *
 * Spawns the SHIPPED MCP server (`dist/server/index.js` — the same
 * binary Claude Desktop loads) as a child process and drives it via
 * JSON-RPC over stdio, exactly as the in-Desktop agent does. This is
 * the canonical regression harness for hardware-touching changes per
 * the founder's directive (feedback_drive_mcp_tools memory) and the
 * MCP community workflow (custom Client + StdioClientTransport for
 * scripted tests; Inspector for interactive; Desktop only for final
 * sign-off).
 *
 * SETUP:
 *   1. `npm run build` so dist/server/index.js is current.
 *   2. Close Claude Desktop AND AxeEdit (single-writer MIDI port).
 *   3. `npm run mcp-test-apply [-- --slot N --preset NAME]`
 *
 * Defaults: slot 604, "glassy-clean" preset spec.
 *
 * What it does:
 *   - Spawns the MCP server and connects.
 *   - Calls `tools/list` and prints the registered tool descriptions
 *     for `apply_preset` + `get_preset` so the test path matches exactly
 *     what an agent would see and interpret.
 *   - Calls `apply_preset(port='axe-fx-ii', spec, target_location)` with
 *     the requested spec (converted from the legacy block list).
 *   - Calls `get_preset(port='axe-fx-ii')` and checks chain_integrity.
 *   - Reports pass/fail. Exits non-zero on failure.
 *
 * Pass criteria:
 *   - apply_preset_at returns no isError
 *   - get_grid_layout response does NOT contain "CHAIN BREAK"
 *
 * Does NOT verify audio. The founder confirms audio out-of-band; this
 * is the wire-level regression that catches silent-preset bugs before
 * they ever reach the agent's conversation.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

// ── CLI ────────────────────────────────────────────────────────────────

interface CliOpts {
  slot: number;
  presetName: keyof typeof PRESETS;
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = { slot: 604, presetName: 'glassy-clean' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot') opts.slot = parseInt(argv[++i], 10);
    else if (a === '--preset') opts.presetName = argv[++i] as keyof typeof PRESETS;
  }
  if (!Number.isInteger(opts.slot) || opts.slot < 1 || opts.slot > 16384) {
    throw new Error(`--slot must be 1..16384, got ${opts.slot}`);
  }
  if (!(opts.presetName in PRESETS)) {
    throw new Error(`--preset must be one of: ${Object.keys(PRESETS).join(', ')}; got "${opts.presetName}"`);
  }
  return opts;
}

// ── Preset specs ───────────────────────────────────────────────────────

// Each spec is authored in the legacy `blocks` shape (block display name +
// optional `params` map of display-unit values) for readability, then
// converted to the unified apply_preset `spec` by toUnifiedSpec() below.
// The unified tool's encode layer translates display → wire under the hood.

const PRESETS = {
  // Minimal — single block. Edge case: only col 1 occupied, the rest
  // of row 2 is shunts only. Exercises the "11-cable chain to OUTPUT
  // via 11 shunts" path.
  'amp-only': {
    name: 'Amp Only',
    blocks: [
      { block: 'Amp 1', params: { input_drive: 5, master_volume: 5 } },
    ],
  },
  // Two-block edge case — Amp + Cab, the classic minimal tone.
  'amp-cab': {
    name: 'Amp Cab',
    blocks: [
      { block: 'Amp 1', params: { input_drive: 5, master_volume: 5 } },
      { block: 'Cab 1' },
    ],
  },
  // The canonical 4-block Glassy Clean chain (Session 71 oracle).
  'glassy-clean': {
    name: 'Glassy Clean',
    blocks: [
      { block: 'Compressor 1' },
      {
        block: 'Amp 1',
        params: { input_drive: 3.5, bass: 4.5, middle: 5.0, treble: 6.5, presence: 6.0, master_volume: 5.0 },
      },
      { block: 'Cab 1' },
      { block: 'Reverb 1', params: { mix: 25 } },
    ],
  },
  // 6-block chain — Comp + Drive + Amp + Cab + Delay + Reverb.
  'high-gain': {
    name: 'High Gain',
    blocks: [
      { block: 'Compressor 1' },
      { block: 'Drive 1' },
      {
        block: 'Amp 1',
        params: { input_drive: 7.5, bass: 5, middle: 4, treble: 6, presence: 6, master_volume: 5 },
      },
      { block: 'Cab 1' },
      { block: 'Delay 1', params: { mix: 15 } },
      { block: 'Reverb 1', params: { mix: 20 } },
    ],
  },
  // Same 6-block shape, different param emphasis (more modulation).
  'ambient-lead': {
    name: 'Ambient Lead',
    blocks: [
      { block: 'Compressor 1' },
      { block: 'Drive 1' },
      {
        block: 'Amp 1',
        params: { input_drive: 5.5, bass: 4, middle: 5, treble: 6, presence: 6, master_volume: 5 },
      },
      { block: 'Cab 1' },
      { block: 'Delay 1', params: { mix: 35 } },
      { block: 'Reverb 1', params: { mix: 40 } },
    ],
  },
  // Saturated stack: Wah + Compressor + Drive + Drive + Amp + Cab +
  // Chorus + Delay + Reverb. 9 blocks → only 3 shunt cells. Stresses
  // the "long chain, fewer shunts" path.
  'saturated-stack': {
    name: 'Saturated Stack',
    blocks: [
      { block: 'Wah 1' },
      { block: 'Compressor 1' },
      { block: 'Drive 1' },
      { block: 'Drive 2' },
      {
        block: 'Amp 1',
        params: { input_drive: 6.5, bass: 5, middle: 4.5, treble: 6, presence: 6, master_volume: 5 },
      },
      { block: 'Cab 1' },
      { block: 'Chorus 1' },
      { block: 'Delay 1', params: { mix: 20 } },
      { block: 'Reverb 1', params: { mix: 25 } },
    ],
  },
  // Max chain length — 12 content blocks fill all of row 2, zero
  // shunts. Stresses the "no shunt extension needed" path. The
  // applyExecutor's shunt loop should be a no-op here.
  'max-12-blocks': {
    name: 'Max 12 Blocks',
    blocks: [
      { block: 'Wah 1' },
      { block: 'Compressor 1' },
      { block: 'Drive 1' },
      { block: 'Drive 2' },
      { block: 'Amp 1', params: { input_drive: 5, master_volume: 5 } },
      { block: 'Cab 1' },
      { block: 'Chorus 1' },
      { block: 'Flanger 1' },
      { block: 'Phaser 1' },
      { block: 'Delay 1', params: { mix: 18 } },
      { block: 'Multi Delay 1' },
      { block: 'Reverb 1', params: { mix: 25 } },
    ],
  },
} as const;

// Convert a preset (legacy `blocks` shape) to the unified apply_preset
// `spec`: sequential slots, block_type slug (trailing instance number
// stripped, spaces removed, e.g. "Multi Delay 1" → "multidelay"), and
// params wrapped under the active channel (X).
function toUnifiedSpec(preset: { name: string; blocks: readonly unknown[] }): {
  name: string;
  slots: Array<Record<string, unknown>>;
} {
  return {
    name: preset.name,
    slots: preset.blocks.map((raw, i) => {
      const b = raw as { block: string; params?: Record<string, number> };
      const block_type = b.block.replace(/\s*\d+\s*$/, '').toLowerCase().replace(/\s+/g, '');
      return b.params
        ? { slot: i + 1, block_type, params_by_channel: { X: b.params } }
        : { slot: i + 1, block_type };
    }),
  };
}

// ── MCP response helpers ───────────────────────────────────────────────

function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n') + (r.isError ? '\n  [tool returned isError=true]' : '');
}

function isError(callResult: unknown): boolean {
  return !!(callResult as { isError?: boolean })?.isError;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  const preset = PRESETS[opts.presetName];

  console.log(`MCP-driven apply test`);
  console.log(`  slot:   ${opts.slot}`);
  console.log(`  preset: ${opts.presetName} ("${preset.name}", ${preset.blocks.length} blocks)`);
  console.log('');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (buf: Buffer) => {
      process.stderr.write(`[server] ${buf.toString()}`);
    });
  }

  const client = new Client(
    { name: 'mcp-test-apply-preset', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  try {
    await client.connect(transport);
    console.log('✓ Connected to MCP server.\n');

    // ── 1. List tools, print descriptions for the tools we'll call. ──
    const { tools } = await client.listTools();
    const applyTool = tools.find((t) => t.name === 'apply_preset');
    const readTool = tools.find((t) => t.name === 'get_preset');
    if (!applyTool || !readTool) {
      console.error('❌ Required unified tools not registered: apply_preset and/or get_preset');
      process.exit(1);
    }

    console.log('── Tool descriptions (what the agent sees) ───────────────────');
    console.log(`\n[apply_preset]\n${(applyTool.description ?? '').slice(0, 600)}${(applyTool.description ?? '').length > 600 ? '\n…' : ''}`);
    console.log(`\n[get_preset]\n${(readTool.description ?? '').slice(0, 400)}${(readTool.description ?? '').length > 400 ? '\n…' : ''}`);
    console.log('\n──────────────────────────────────────────────────────────────\n');

    // ── 2. Apply the preset to the target slot via the unified surface. ──
    const spec = toUnifiedSpec(preset);
    console.log(`Calling apply_preset(port='axe-fx-ii', target_location=${opts.slot}, name="${preset.name}", ${spec.slots.length} blocks)…`);
    const applyResp = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        target_location: opts.slot,
        spec,
        save_authorized: true,
        on_active_preset_edited: 'discard',
      },
    });
    const applyText = extractText(applyResp);
    if (isError(applyResp)) {
      console.error('❌ apply_preset returned isError:');
      console.error(applyText);
      process.exit(2);
    }
    // Print a digest — the tool's response is usually a multi-line summary.
    const applyLines = applyText.split('\n');
    console.log(`✓ apply_preset ok. Response digest:`);
    for (const l of applyLines.slice(0, 3)) console.log(`    ${l}`);
    if (applyLines.length > 3) console.log(`    … (${applyLines.length - 3} more lines)`);
    console.log('');

    // ── 3. Read the preset back, check chain integrity. ──
    console.log(`Calling get_preset(port='axe-fx-ii')…`);
    const readResp = await client.callTool({
      name: 'get_preset',
      arguments: { port: 'axe-fx-ii' },
    });
    const readText = extractText(readResp);
    if (isError(readResp)) {
      console.error('❌ get_preset returned isError:');
      console.error(readText);
      process.exit(3);
    }
    console.log(readText);
    console.log('');

    // ── 4. Verdict. chain_integrity.ok === false means a break. ──
    const ci = (readResp as { structuredContent?: { chain_integrity?: { ok?: boolean } } })
      .structuredContent?.chain_integrity;
    const hasBreak = ci ? ci.ok === false : /chain.{0,20}break/i.test(readText);
    if (hasBreak) {
      console.log('═══════════════════════════════════════════════════════════');
      console.log('❌ FAIL — get_preset chain_integrity reports a break.');
      console.log('   Signal will not flow end-to-end. Inspect the snapshot above.');
      process.exit(4);
    } else {
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`🎯 PASS — slot ${opts.slot} ("${preset.name}") chain reads clean.`);
      console.log(`   Founder can audition slot ${opts.slot} for audio confirmation.`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
