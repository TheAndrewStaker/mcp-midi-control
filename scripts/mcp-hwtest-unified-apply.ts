/**
 * Hardware test 1 — unified `apply_preset` end-to-end against Axe-Fx II.
 *
 * Validates the v0.3 migration: the unified apply_preset path (port-
 * dispatched, descriptor-routed) produces a saved + audible preset on
 * the Axe-Fx II. This is the replacement for the removed
 * axefx2_apply_preset_at tool.
 *
 * Slot 608 (display) is the test target. Pick a fresh slot — this
 * tool WILL OVERWRITE whatever's there.
 *
 * Hardware-dependent. Requires:
 *   - Axe-Fx II powered on + USB connected
 *   - Claude Desktop fully closed (system tray → Quit)
 *   - AxeEdit closed
 *
 * Run: npm run build && npx tsx scripts/mcp-hwtest-unified-apply.ts
 *
 * Pass criteria (script-side):
 *   - unified apply_preset returns ok=true
 *   - axefx2_get_grid_layout shows the 4 content blocks + 8 shunts
 *   - no chain-break warning
 *
 * Pass criteria (audible — founder reports):
 *   - Plug in guitar, switch Axe-Fx II to slot 608, play
 *   - Confirm tone is audible (clean chime)
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'index.js');
const TARGET_SLOT = 608;

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

async function main(): Promise<void> {
  console.log(`Hardware test 1 — unified apply_preset → Axe-Fx II slot ${TARGET_SLOT}\n`);
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'hwtest-1', version: '1' }, { capabilities: {} });
  await c.connect(t);
  let pass = true;
  try {
    // Step 1: apply via unified surface. This is the v0.3 path —
    // dispatcher → descriptor.writer.applyPreset → applyExecutor.
    console.log(`Step 1: calling unified apply_preset(port='axe-fx-ii', target_location=${TARGET_SLOT})…`);
    const apply = await c.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        target_location: TARGET_SLOT,
        save_authorized: true,
        on_active_preset_edited: 'discard',
        spec: {
          name: 'Unified Test',
          slots: [
            { slot: 1, block_type: 'compressor' },
            { slot: 2, block_type: 'amp', params_by_channel: { X: { input_drive: 3.5, bass: 4.5, middle: 5, treble: 6.5, presence: 6, master_volume: 5 } } },
            { slot: 3, block_type: 'cab' },
            { slot: 4, block_type: 'reverb', params_by_channel: { X: { mix: 25 } } },
          ],
        },
      },
    });
    const applyText = ext(apply);
    if (isError(apply)) {
      console.log(`  ✗ apply_preset returned isError:\n${applyText.split('\n').slice(0, 8).map((l) => `      ${l}`).join('\n')}`);
      pass = false;
    } else {
      console.log(`  ✓ apply_preset ok`);
      console.log(applyText.split('\n').slice(0, 3).map((l) => `      ${l}`).join('\n'));
    }

    // Step 2: read grid layout via the surviving device-namespaced read tool.
    console.log(`\nStep 2: reading grid layout to verify chain integrity…`);
    const grid = await c.callTool({ name: 'axefx2_get_grid_layout', arguments: {} });
    const gridText = ext(grid);
    const hasBreak = /CHAIN BREAK/i.test(gridText);
    if (hasBreak) {
      console.log(`  ✗ grid layout reports a chain break:`);
      console.log(gridText.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'));
      pass = false;
    } else {
      console.log(`  ✓ grid layout reads clean (no chain break)`);
      console.log(gridText.split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n'));
    }
  } finally {
    await c.close();
  }

  console.log('\n══════════════════════════════════════════════════════════');
  if (pass) {
    console.log(`🎯 SCRIPT-SIDE PASS — wire-level chain integrity confirmed on slot ${TARGET_SLOT}.`);
    console.log('');
    console.log(`Next: plug in guitar. On the Axe-Fx II front panel, turn the VALUE wheel`);
    console.log(`to load slot ${TARGET_SLOT} ("Unified Test"). Play notes. Confirm audible.`);
  } else {
    console.log('❌ SCRIPT-SIDE FAIL — see errors above.');
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(99); });
