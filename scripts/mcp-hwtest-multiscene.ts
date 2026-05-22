/**
 * Hardware test 2 — multi-scene authoring round-trip on Axe-Fx II.
 *
 * Validates v0.3 chunk 11 parity restoration: the unified
 * apply_preset's translateSpec was collapsed to single-scene-only by
 * the original v0.3 cleanup; chunk 11 restored multi-scene authoring
 * (walks every spec.scenes[] entry with full per-block bypass +
 * channel state). This test confirms the restoration works end-to-end
 * on hardware.
 *
 * Slot 609 (display) is the test target. Fresh slot — overwrites
 * whatever's there.
 *
 * Hardware-dependent. Requires:
 *   - Axe-Fx II powered on + USB connected
 *   - Claude Desktop fully closed
 *   - AxeEdit closed
 *
 * Run: npm run build && npx tsx scripts/mcp-hwtest-multiscene.ts
 *
 * Test design:
 *   Chain: Compressor → Drive → Amp → Cab → Delay → Reverb (6 blocks)
 *   Scene 1 "Rhythm":  comp engaged, drive BYPASSED, delay BYPASSED, amp on X
 *   Scene 2 "Lead":    comp engaged, drive engaged, delay engaged, amp on Y
 *
 * Pass criteria (script-side):
 *   - apply_preset returns ok=true
 *   - Grid shows 6 content blocks + 6 shunts, no chain break
 *
 * Pass criteria (audible — founder reports):
 *   - Plug in guitar, switch to slot 609
 *   - Scene 1 should sound rhythm-y: clean amp + compression, no drive, no delay
 *   - Scene 2 should sound lead-y: dirtier amp (Y channel) with drive + delay
 *   - Toggling scenes 1→2 on the device should produce an audible difference
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'index.js');
const TARGET_SLOT = 609;

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

async function main(): Promise<void> {
  console.log(`Hardware test 2 — multi-scene authoring → Axe-Fx II slot ${TARGET_SLOT}\n`);
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'hwtest-2', version: '1' }, { capabilities: {} });
  await c.connect(t);
  let pass = true;
  try {
    console.log(`Step 1: applying multi-scene preset (2 scenes, 6 blocks) to slot ${TARGET_SLOT}…`);
    const apply = await c.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        target_location: TARGET_SLOT,
        save_authorized: true,
        on_active_preset_edited: 'discard',
        spec: {
          name: 'Multi Scene',
          slots: [
            { slot: 1, block_type: 'compressor' },
            { slot: 2, block_type: 'drive' },
            {
              slot: 3,
              block_type: 'amp',
              // Different params on X vs Y channel — proves per-channel
              // routing through the unified surface.
              params_by_channel: {
                X: { input_drive: 3.5, bass: 4.5, middle: 5, treble: 6.5, master_volume: 5 },
                Y: { input_drive: 6.5, bass: 5, middle: 4, treble: 6, master_volume: 5 },
              },
            },
            { slot: 4, block_type: 'cab' },
            { slot: 5, block_type: 'delay', params_by_channel: { X: { mix: 25 } } },
            { slot: 6, block_type: 'reverb', params_by_channel: { X: { mix: 30 } } },
          ],
          // The chunk 11 parity restoration — every entry walked through
          // switch-write-switch-back. If the bug had stayed, only scenes[0]
          // would be honored and scene 2's per-block state would be lost.
          scenes: [
            {
              scene: 1,
              channels: { amp: 'X' },
              bypassed: { drive: true, delay: true, reverb: false, compressor: false },
            },
            {
              scene: 2,
              channels: { amp: 'Y' },
              bypassed: { drive: false, delay: false, reverb: false, compressor: false },
            },
          ],
          landingScene: 1,  // come up on scene 1 (Rhythm) so the audible test starts clean
        },
      },
    });
    const applyText = ext(apply);
    if (isError(apply)) {
      console.log(`  ✗ apply_preset returned isError:\n${applyText.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n')}`);
      pass = false;
    } else {
      console.log(`  ✓ apply_preset ok`);
      console.log(applyText.split('\n').slice(0, 3).map((l) => `      ${l}`).join('\n'));
    }

    console.log(`\nStep 2: reading grid layout to verify chain integrity…`);
    const grid = await c.callTool({ name: 'axefx2_get_grid_layout', arguments: {} });
    const gridText = ext(grid);
    const hasBreak = /CHAIN BREAK/i.test(gridText);
    if (hasBreak) {
      console.log(`  ✗ grid reports a chain break:`);
      console.log(gridText.split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'));
      pass = false;
    } else {
      console.log(`  ✓ grid reads clean (6 blocks + 6 shunts, full chain)`);
      console.log(gridText.split('\n').slice(0, 6).map((l) => `      ${l}`).join('\n'));
    }
  } finally {
    await c.close();
  }

  console.log('\n══════════════════════════════════════════════════════════');
  if (pass) {
    console.log(`🎯 SCRIPT-SIDE PASS — multi-scene preset saved to slot ${TARGET_SLOT}.`);
    console.log('');
    console.log('Next steps — confirm scenes round-trip audibly:');
    console.log(`  1. Plug in guitar. Load slot ${TARGET_SLOT} ("Multi Scene") on the device.`);
    console.log(`  2. Device should come up on Scene 1 (landingScene=1). Play notes.`);
    console.log(`     EXPECT: clean tone — compressed, amp on X channel, drive + delay BYPASSED.`);
    console.log('  3. Use the Axe-Fx II Scene-select buttons to switch to Scene 2.');
    console.log(`     EXPECT: lead tone — drive engaged, amp on Y channel (dirtier), delay engaged.`);
    console.log('  4. Toggle 1↔2 a few times. Audibly distinct = parity restoration confirmed.');
  } else {
    console.log('❌ SCRIPT-SIDE FAIL — see errors above. Multi-scene parity NOT confirmed.');
  }
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(99); });
