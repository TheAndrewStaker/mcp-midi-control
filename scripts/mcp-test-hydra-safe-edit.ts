/**
 * Smoke for Phase B — Hydrasynth save_authorized gate.
 *
 * Run: npm run build && npx tsx scripts/mcp-test-hydra-safe-edit.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'index.js');
function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  if (t.stderr) t.stderr.on('data', () => {});
  const c = new Client({ name: 'mcp-test-hydra-safe-edit', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await c.connect(t);
  let pass = true;
  try {
    // Scenario: apply_patch with save: true but no save_authorized → refuse.
    const r = await c.callTool({
      name: 'apply_patch',
      arguments: {
        params: [{ name: 'filter1cutoff', value: 80 }],
        save: true,
        // intentionally omitting save_authorized
      },
    });
    const text = extractText(r);
    const refused = isError(r) && /REFUSING TO SAVE/i.test(text) && /save_authorized/i.test(text);
    console.log(refused ? '✓ apply_patch refuses save:true without save_authorized' : '✗ FAIL — gate did not refuse');
    if (!refused) {
      console.log('  Response:\n' + text.split('\n').slice(0, 6).map((l) => `    ${l}`).join('\n'));
      pass = false;
    }

    // Scenario: apply_patch without save → no save-auth refusal.
    const r2 = await c.callTool({
      name: 'apply_patch',
      arguments: { params: [{ name: 'filter1cutoff', value: 80 }] },
    });
    const text2 = extractText(r2);
    const noSpurious = !/REFUSING TO SAVE/i.test(text2);
    console.log(noSpurious ? '✓ RAM-only apply_patch does NOT trip save-auth gate' : '✗ FAIL — RAM-only call refused');
    if (!noSpurious) pass = false;
  } finally {
    await c.close();
  }
  console.log(pass ? '\n🎯 Phase B smoke PASS' : '\n❌ Phase B smoke FAIL');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(99); });
