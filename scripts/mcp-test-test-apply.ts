/**
 * Hardware smoke test for the unified `apply_preset({port:'axe-fx-ii',
 * verify_chain:true})` call. One-call build-and-verify against the
 * working buffer. Spawns the MCP server via StdioClientTransport just
 * like Claude Desktop would, calls the tool, parses the response,
 * prints the chain-integrity verdict.
 *
 * Originally written against `axefx2_test_apply` (removed T-2,
 * 2026-05-21); the call shape ports to the unified surface 1:1 via
 * verify_chain.
 *
 * Run: npm run build && npx tsx scripts/mcp-test-test-apply.ts
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'dist', 'server', 'index.js');

function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n') + (r.isError ? '\n  [tool returned isError=true]' : '');
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (buf: Buffer) => process.stderr.write(`[server] ${buf.toString()}`));
  }
  const client = new Client(
    { name: 'mcp-test-test-apply', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    // T-2 (2026-05-21): ported from removed `axefx2_test_apply` to the
    // unified `apply_preset({port:'axe-fx-ii', spec, verify_chain:true})`.
    // Same wire path, same chain-integrity verdict, but the call shape
    // matches the unified surface every device uses.
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'apply_preset');
    if (!tool) {
      console.error('❌ apply_preset not registered. Rebuild dist?');
      process.exit(1);
    }
    console.log(`✓ apply_preset registered. Description length: ${(tool.description ?? '').length} chars.\n`);

    // Call it with a 4-block chain. Working-buffer only (no target_location, no save).
    console.log('Calling apply_preset({port:"axe-fx-ii", verify_chain:true}) with Comp + Amp + Cab + Reverb (working buffer)…\n');
    const resp = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        verify_chain: true,
        on_active_preset_edited: 'discard',
        spec: {
          name: 'Verify Build',
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'compressor' },
            { slot: { row: 2, col: 2 }, block_type: 'amp', params_by_channel: { X: { input_drive: 4, master_volume: 5 } } },
            { slot: { row: 2, col: 3 }, block_type: 'cab' },
            { slot: { row: 2, col: 4 }, block_type: 'reverb', params_by_channel: { X: { mix: 25 } } },
          ],
        },
      },
    });

    const text = extractText(resp);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error('❌ Tool returned non-JSON text:');
      console.error(text);
      process.exit(2);
    }

    console.log('Tool response (parsed):');
    console.log(JSON.stringify(parsed, null, 2));
    console.log('');

    // ApplyResult shape: { ok, chain_integrity?: { ok, breaks, summary } }.
    // Map to the legacy verdict / chainBreaks language for log continuity.
    const r = parsed as { ok?: boolean; chain_integrity?: { ok?: boolean; breaks?: unknown[]; summary?: string } };
    const chainOk = r.chain_integrity?.ok !== false;
    const breaks = r.chain_integrity?.breaks ?? [];
    if (r.ok === true && chainOk) {
      console.log('🎯 PASS — apply_preset returned ok=true with chain_integrity.ok=true.');
      if (r.chain_integrity?.summary) console.log(`   Chain summary: ${r.chain_integrity.summary}`);
    } else {
      console.log('❌ FAIL — apply_preset rejected or chain broken.');
      console.log(`   ok=${r.ok} chain_integrity.ok=${chainOk}`);
      console.log(`   breaks: ${JSON.stringify(breaks)}`);
      process.exit(3);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
