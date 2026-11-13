/**
 * Hardware regression: verify AM4's new safe-edit gates via MCP.
 *
 * Spawns the shipped MCP server and exercises:
 *   1. am4_apply_preset_at WITHOUT save_authorized → refuses (isError=true,
 *      message names am4_apply_preset as the audition tool).
 *   2. am4_apply_preset_at with save_authorized=true on a clean buffer
 *      → succeeds against the AM4 (if connected; otherwise harmlessly
 *      errors at the MIDI layer — that's fine, we're testing the gate).
 *
 * Doesn't actually mutate hardware in scenario 1 (refusal happens before
 * any wire write). Scenario 2 would write — gated behind an explicit
 * `--write` CLI flag so casual runs only validate the refusal path.
 *
 * Run: `npm run build && npx tsx scripts/mcp-test-am4-safe-edit.ts`
 *      `npx tsx scripts/mcp-test-am4-safe-edit.ts --write` (writes to AM4 Z04)
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'dist', 'server', 'index.js');
const writeMode = process.argv.includes('--write');

function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!);
  return parts.join('\n') + (r.isError ? '\n  [isError=true]' : '');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

const minimalPreset = {
  slots: [{ position: 1, block_type: 'amp' }],
  name: 'safe-edit-test',
};

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) transport.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const client = new Client({ name: 'mcp-test-am4-safe-edit', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });

  let pass = true;
  try {
    await client.connect(transport);

    console.log('Scenario 1: am4_apply_preset_at WITHOUT save_authorized → expect refusal\n');
    const r1 = await client.callTool({
      name: 'am4_apply_preset_at',
      arguments: { location: 'Z04', preset: minimalPreset },
    });
    const t1 = extractText(r1);
    const refused = isError(r1) && /REFUSING TO SAVE/i.test(t1) && /am4_apply_preset/i.test(t1);
    console.log(refused ? '  ✓ PASS — refusal text present, names am4_apply_preset as audition tool' : '  ✗ FAIL — refusal not detected');
    if (!refused) {
      console.log('  Response:');
      console.log(t1.split('\n').slice(0, 8).map((l) => `    ${l}`).join('\n'));
      pass = false;
    }

    if (!writeMode) {
      console.log('\nScenario 2: skipping (pass --write to exercise the live-save path on AM4 Z04).');
    } else {
      console.log('\nScenario 2: am4_apply_preset_at WITH save_authorized=true → expect success (writes to Z04)\n');
      const r2 = await client.callTool({
        name: 'am4_apply_preset_at',
        arguments: {
          location: 'Z04',
          preset: minimalPreset,
          save_authorized: true,
          on_active_preset_edited: 'discard',
        },
      });
      const t2 = extractText(r2);
      // If AM4 isn't connected we'll see a port error — that's still proof
      // the gate cleared. If AM4 IS connected, ok=true in the JSON result.
      const passedGate = !/REFUSING TO SAVE/.test(t2);
      console.log(passedGate ? '  ✓ PASS — gate cleared (request reached the wire layer)' : '  ✗ FAIL — gate still refused with save_authorized=true');
      console.log('  Response digest:');
      console.log(t2.split('\n').slice(0, 5).map((l) => `    ${l}`).join('\n'));
      if (!passedGate) pass = false;
    }
  } finally {
    await client.close();
  }

  console.log(pass ? '\n🎯 PASS' : '\n❌ FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(99); });
