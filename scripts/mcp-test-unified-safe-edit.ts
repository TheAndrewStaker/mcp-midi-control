/**
 * Smoke test for Phase C — the unified `apply_preset` tool's safe-edit
 * gates. Verifies that the dispatcher refuses target_location writes
 * without save_authorized=true, with a structured DispatchError that
 * the asError shape renders into isError=true content.
 *
 * Hardware-free — refusal fires inside the dispatcher before any wire
 * I/O. Doesn't actually need a connected device.
 *
 * Run: npm run build && npx tsx scripts/mcp-test-unified-safe-edit.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'dist', 'server', 'index.js');

function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '<no response>';
  const c = r as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n') + (c.isError ? '\n[isError=true]' : '');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

const PRESET = { slots: [{ slot: 1, block_type: 'amp' }], name: 'sf' };

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  if (transport.stderr) transport.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const client = new Client({ name: 'unified-safe-edit', version: '1.0.0' }, { capabilities: {} });
  let pass = true;
  try {
    await client.connect(transport);

    // S3a equivalent on the unified surface: apply_preset with target_location, no save_authorized → refuse.
    const r1 = await client.callTool({
      name: 'apply_preset',
      arguments: { port: 'am4', spec: PRESET, target_location: 'Z04' },
    });
    const t1 = extractText(r1);
    const refused = isError(r1) && /save_authorized/i.test(t1) && /apply_preset.*without target_location|audition/i.test(t1);
    console.log(refused ? '  ✓ unified apply_preset refuses target_location without save_authorized' : '  ✗ unified apply_preset gate did not refuse');
    if (!refused) {
      console.log('  Response excerpt:\n' + t1.split('\n').slice(0, 5).map((l) => `    ${l}`).join('\n'));
      pass = false;
    }

    // Same check for Axe-Fx II.
    const r2 = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        spec: { slots: [{ slot: 1, block_type: 'amp', params_by_channel: { X: { input_drive: 5 } } }] },
        target_location: 603,
      },
    });
    const t2 = extractText(r2);
    const refused2 = isError(r2) && /save_authorized/i.test(t2);
    console.log(refused2 ? '  ✓ unified apply_preset (axe-fx-ii) refuses target_location without save_authorized' : '  ✗ axe-fx-ii gate did not refuse');
    if (!refused2) {
      console.log('  Response excerpt:\n' + t2.split('\n').slice(0, 5).map((l) => `    ${l}`).join('\n'));
      pass = false;
    }

    // Without target_location, should NOT refuse on save-auth grounds.
    // (May still fail at the wire layer if device not connected; that's fine.)
    const r3 = await client.callTool({
      name: 'apply_preset',
      arguments: { port: 'am4', spec: PRESET },
    });
    const t3 = extractText(r3);
    const noSaveAuthRefusal = !/save_authorization_required|save_authorized.*=.*true/i.test(t3);
    console.log(noSaveAuthRefusal ? '  ✓ working-buffer apply_preset does NOT trip save-auth gate' : '  ✗ working-buffer apply incorrectly tripped save-auth gate');
    if (!noSaveAuthRefusal) pass = false;
  } finally {
    await client.close();
  }
  console.log(pass ? '\n🎯 Phase C smoke PASS' : '\n❌ Phase C smoke FAIL');
  process.exit(pass ? 0 : 1);
}
main().catch((err) => { console.error('Fatal:', err); process.exit(99); });
