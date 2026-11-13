/**
 * MCP-driven slot-666 routing probe.
 *
 * Same logic as `scripts/probe-axefx2-routing-slot666.ts`, but instead of
 * calling the underlying TypeScript functions directly, this script SPAWNS
 * THE MCP SERVER as a child process (the same `dist/server/index.js` Claude
 * Desktop runs) and invokes its tools via the MCP SDK's stdio client.
 *
 * Why this exists: lets us exercise the full MCP stack — schemas, handler
 * wrappers, the unified-surface dispatcher, midi.ts connection management,
 * everything Claude Desktop would touch — without needing the founder to
 * open Claude Desktop and prompt themselves. The script IS a synthetic
 * Claude Desktop conversation, just deterministic.
 *
 * SETUP:
 *   1. `npm run build` (so dist/server/index.js is current).
 *   2. Quit Claude Desktop AND AxeEdit (single-writer MIDI port).
 *   3. `npx tsx scripts/mcp-probe-axefx2-routing-slot666.ts`
 *
 * The spawned MCP server opens the MIDI port itself. When the script ends
 * it closes the client cleanly and the child exits.
 *
 * Probe coverage: same shapes as the direct-function variant. Each shape
 * is sent through `axefx2_probe_sysex` (which sends bytes + captures the
 * inbound ACK), and after each probe we read `axefx2_get_grid_layout`
 * to detect mask mutation on COMP1. Slot 666 reload via
 * `axefx2_switch_preset` between probes that mutate.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// ── Constants ────────────────────────────────────────────────────────────

const SLOT_666_DISPLAY = 666;
const COMP1_BLOCK_ID = 100;
const AMP1_BLOCK_ID = 106;
const TARGET_NEW_MASK = 0x03;

const SERVER_ENTRY = path.resolve(process.cwd(), 'dist', 'server', 'index.js');

// ── Helpers ──────────────────────────────────────────────────────────────

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function fractalCs(envelope: number[], csPos: number): number {
  let cs = 0;
  for (let i = 1; i < csPos; i++) cs ^= envelope[i];
  return cs & 0x7f;
}

function buildProbeFrame(payload: number[]): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, 0x07, 0x06, ...payload];
  const cs = fractalCs(head, head.length);
  return [...head, cs, 0xf7];
}

interface ProbeShape {
  label: string;
  payload: number[];
}

function buildShapes(): ProbeShape[] {
  const bid = COMP1_BLOCK_ID;
  const m = TARGET_NEW_MASK;
  return [
    { label: '2A  [blockId_lo, mask]',                                        payload: [bid & 0x7f, m] },
    { label: '3A  [blockId_lo, blockId_hi, mask]',                            payload: [bid & 0x7f, (bid >> 7) & 0x7f, m] },
    { label: '3B  [col0, row0, mask]',                                        payload: [0, 1, m] },
    { label: '4A  [blockId_lo, blockId_hi, mask, 0]',                         payload: [bid & 0x7f, (bid >> 7) & 0x7f, m, 0] },
    { label: '4B  [blockId_lo, blockId_hi, 0, mask]',                         payload: [bid & 0x7f, (bid >> 7) & 0x7f, 0, m] },
    { label: '4C  [blockId_lo, blockId_hi, 4, mask]  (revisit 0x0C hit)',     payload: [bid & 0x7f, (bid >> 7) & 0x7f, 4, m] },
    { label: '4D  [col0, row0, mask, 0]',                                     payload: [0, 1, m, 0] },
    { label: '4E  [cellIdx_colmajor, 0, mask, 0]',                            payload: [1, 0, m, 0] },
    { label: '5A  [blockId_lo, blockId_hi, col0, row0, mask]',                payload: [bid & 0x7f, (bid >> 7) & 0x7f, 0, 1, m] },
    { label: '5B  [blockId_lo, blockId_hi, row0, col0, mask]',                payload: [bid & 0x7f, (bid >> 7) & 0x7f, 1, 0, m] },
    { label: '5C  [srcCol, srcRow, dstCol, dstRow, mask]  (R2C1→R2C2)',       payload: [0, 1, 1, 1, m] },
    { label: '5D  [srcBlockId_lo, srcBlockId_hi, dstBlockId_lo, dstBlockId_hi, mask]', payload: [bid & 0x7f, (bid >> 7) & 0x7f, AMP1_BLOCK_ID & 0x7f, (AMP1_BLOCK_ID >> 7) & 0x7f, m] },
  ];
}

// MCP tool responses come back as { content: [{ type: 'text', text: '…' }, …], isError? }
function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n') + (r.isError ? '  [tool returned isError=true]' : '');
}

/** Find the mask byte for COMP1 in an axefx2_get_grid_layout text response.
 *  The response is human-readable text — parse it loosely rather than
 *  hard-coding a fragile regex. Looks for a line mentioning the block name
 *  containing a mask/routing hex value. Falls back to -1 if not found. */
function parseCompMaskFromGridText(text: string): number {
  // Try several common output shapes — the actual format may vary by tool
  // implementation. Look for lines containing "Comp" or blockId 100 and a
  // 0x?? value nearby.
  const lines = text.split('\n');
  for (const line of lines) {
    if (!/comp/i.test(line) && !/100/.test(line)) continue;
    const hexMatches = [...line.matchAll(/0x([0-9a-f]{1,2})/gi)];
    if (hexMatches.length === 0) continue;
    // The last hex on a Comp-line is typically the mask
    const last = hexMatches[hexMatches.length - 1];
    return parseInt(last[1], 16);
  }
  return -1;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Spawning MCP server: node ${SERVER_ENTRY}`);
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'mcp-probe-axefx2-routing', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  // Print server stderr (useful if the server fails to open MIDI)
  if (transport.stderr) {
    transport.stderr.on('data', (buf: Buffer) => {
      process.stderr.write(`[server] ${buf.toString()}`);
    });
  }

  try {
    await client.connect(transport);
    console.log('✓ Connected to MCP server.\n');

    // Sanity check — list tools (just the count is enough)
    const tools = await client.listTools();
    const axeTools = tools.tools.filter((t) => t.name.startsWith('axefx2_'));
    console.log(`Server exposes ${tools.tools.length} tools (${axeTools.length} axefx2_*).\n`);

    // ── 1. Reload slot 666 for clean baseline ──
    console.log(`Step 1: Switching to slot ${SLOT_666_DISPLAY} (Glassy Clean)...`);
    const switchResp = await client.callTool({
      name: 'axefx2_switch_preset',
      arguments: { slot: SLOT_666_DISPLAY },
    });
    const switchText = extractText(switchResp);
    console.log(`   ${switchText.split('\n')[0]}`);
    if ((switchResp as { isError?: boolean }).isError) {
      console.error('❌ switch_preset failed. Aborting.');
      console.error(switchText);
      await client.close();
      process.exit(1);
    }

    // ── 2. Read baseline grid ──
    console.log(`Step 2: Reading baseline grid...`);
    const gridResp = await client.callTool({
      name: 'axefx2_get_grid_layout',
      arguments: {},
    });
    const gridText = extractText(gridResp);
    const baselineMask = parseCompMaskFromGridText(gridText);
    console.log(`   COMP1 baseline mask: ${baselineMask >= 0 ? `0x${baselineMask.toString(16).padStart(2,'0')}` : '(could not parse)'}`);
    if (baselineMask < 0) {
      console.log(`   (Grid response excerpt for debugging):`);
      console.log(gridText.split('\n').slice(0, 12).map((l) => `     ${l}`).join('\n'));
    }
    console.log('');

    // ── 3. Probe each shape via axefx2_probe_sysex ──
    const shapes = buildShapes();
    console.log(`Step 3: Probing ${shapes.length} shapes via axefx2_probe_sysex...\n`);

    interface ProbeOutcome {
      shape: ProbeShape;
      probeText: string;
      maskAfter: number;
      flipped: boolean;
    }
    const results: ProbeOutcome[] = [];

    for (const shape of shapes) {
      console.log(`── ${shape.label}`);
      const frame = buildProbeFrame(shape.payload);
      console.log(`   frame: ${toHex(frame)}`);

      const probeResp = await client.callTool({
        name: 'axefx2_probe_sysex',
        arguments: { bytes: toHex(frame), capture_ms: 250 },
      });
      const probeText = extractText(probeResp);
      // Print a single-line summary of the probe response (full text is long)
      const firstSummaryLine = probeText.split('\n').slice(0, 3).join(' | ');
      console.log(`   probe: ${firstSummaryLine}`);

      const gridAfterResp = await client.callTool({
        name: 'axefx2_get_grid_layout',
        arguments: {},
      });
      const maskAfter = parseCompMaskFromGridText(extractText(gridAfterResp));
      const flipped = baselineMask >= 0 && maskAfter !== baselineMask && maskAfter >= 0;
      console.log(`   COMP1 mask after: ${maskAfter >= 0 ? `0x${maskAfter.toString(16).padStart(2,'0')}` : '?'}${flipped ? ' ★ FLIPPED' : ''}`);

      results.push({ shape, probeText, maskAfter, flipped });

      if (flipped) {
        console.log(`   ★ Reloading slot 666 before next probe...`);
        await client.callTool({ name: 'axefx2_switch_preset', arguments: { slot: SLOT_666_DISPLAY } });
      }
      console.log('');
    }

    // ── 4. Final reload to leave clean state ──
    console.log(`Step 4: Reloading slot 666 to ensure clean exit state...`);
    await client.callTool({ name: 'axefx2_switch_preset', arguments: { slot: SLOT_666_DISPLAY } });

    // ── Summary ──
    console.log('\n========================================');
    console.log('SUMMARY');
    console.log('========================================');
    const hits = results.filter((r) => r.flipped);
    if (hits.length > 0) {
      console.log(`🎯 HITS (${hits.length}):`);
      for (const h of hits) {
        console.log(`   ${h.shape.label}`);
        console.log(`     payload: ${toHex(h.shape.payload)}`);
        console.log(`     mask after: 0x${h.maskAfter.toString(16).padStart(2,'0')}`);
      }
    } else {
      console.log('No shape mutated COMP1 mask via the MCP surface.');
      console.log('Inspect individual probe outputs above for ack codes (0x00/0x01/0x0C).');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
