/**
 * BK-084 mode-collapse end-to-end confirmation, through the REAL MCP
 * protocol boundary (not the dispatcher functions directly, unlike every
 * other BK-084 hardware probe this session). Spawns the actual compiled
 * server (`packages/server-all/dist/server/index.js`, the same binary
 * Claude Desktop launches) and drives it via `@modelcontextprotocol/sdk`'s
 * `Client`/`StdioClientTransport`, exactly as an agent conversation would:
 * real `inputSchema` validation on the way in, real tool descriptions
 * (not internal knowledge of the dispatcher's shape), real JSON response
 * serialization on the way out.
 *
 * This closes a gap every earlier BK-084 probe left open: they all called
 * `executeApplyPreset`/`executeSetParams` directly, which never exercises
 * the MCP tool registration layer at all (schema validation, tool
 * descriptions, response serialization). A prior incident in this project
 * (a response field missing from a declared Zod outputSchema silently
 * dropped an ENTIRE tool call in Claude Desktop) is exactly the class of
 * bug that only shows up at this boundary.
 *
 * Covers, through real tool calls:
 *   1. `switch_preset` to location 666 (founder-authorized disposable) —
 *      establishes a known starting point.
 *   2. `apply_preset` WITHOUT a `mode` argument (the whole point of the
 *      collapse — there is no longer anything to pass) builds a 5-block
 *      preset.
 *   3. `set_param` hand-tunes a param the spec never listed.
 *   4. `apply_preset` again: 3 blocks unchanged (not re-opinioned on the
 *      hand-tuned param), 1 replaced, 1 removed — the diff-based
 *      placement claim, through the real tool boundary this time.
 *   5. `get_param` confirms the hand-tuned value survived.
 *   6. `set_params` with a batch >= SET_PARAMS_ATOMIC_THRESHOLD (4),
 *      confirming the real MCP response actually carries `apply_path`/
 *      `receipt`/`push_attempts` end-to-end (no outputSchema is declared
 *      on set_params, so nothing strips them, but this proves it, not
 *      just reads the code).
 *   7. `switch_preset` back to 666 (reload from flash) as cleanup —
 *      nothing was ever saved, so this discards every working-buffer
 *      edit this script made and restores the pre-run state.
 *
 * Preconditions: Axe-Fx II connected. Claude Desktop closed (exclusive
 * MIDI port). Location 666 founder-authorized disposable.
 *
 * Run:  npm run build && npx tsx scripts/_research/probe-mcp-e2e-bk084.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'axe-fx-ii';
const TARGET_LOCATION = 666;

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function structured(r: unknown): Record<string, unknown> | undefined {
  return (r as { structuredContent?: Record<string, unknown> }).structuredContent;
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

async function main(): Promise<void> {
  console.log(`── BK-084 mode-collapse: end-to-end confirmation through the real MCP server (Axe-Fx II XL+, location ${TARGET_LOCATION}) ──\n`);
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'bk084-e2e', version: '1' }, { capabilities: {} });
  await c.connect(t);

  try {
    console.log(`1. switch_preset -> location ${TARGET_LOCATION} (known starting point)...`);
    const nav = await c.callTool({ name: 'switch_preset', arguments: { port: PORT, location: TARGET_LOCATION, on_active_preset_edited: 'discard' } });
    check('1: switch_preset ok', !isError(nav), ext(nav).slice(0, 200));

    console.log('\n2. apply_preset (no `mode` argument -- the collapse itself): build a 5-block preset...');
    const build = await c.callTool({
      name: 'apply_preset',
      arguments: {
        port: PORT,
        save_authorized: false,
        on_active_preset_edited: 'discard',
        spec: {
          name: 'BK084 E2E',
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'drive', params: { drive: 4 } },
            { slot: { row: 2, col: 2 }, block_type: 'amp', params: { bass: 7, treble: 3 } },
            { slot: { row: 2, col: 3 }, block_type: 'cab' },
            { slot: { row: 2, col: 4 }, block_type: 'delay', params: { mix: 25 } },
            { slot: { row: 2, col: 5 }, block_type: 'reverb', params: { mix: 20 } },
          ],
        },
      },
    });
    check('2: apply_preset (build) ok', !isError(build), ext(build).slice(0, 300));

    console.log('\n3. set_param: hand-tune amp.middle, NOT listed in either apply_preset spec...');
    const HAND_TUNED = 8.5;
    const tune = await c.callTool({ name: 'set_param', arguments: { port: PORT, block: 'amp', name: 'middle', value: HAND_TUNED } });
    check('3: set_param ok', !isError(tune), ext(tune).slice(0, 200));

    console.log('\n4. apply_preset AGAIN: drive/amp/cab unchanged (middle not re-listed), delay->chorus REPLACE, reverb REMOVED...');
    const reapply = await c.callTool({
      name: 'apply_preset',
      arguments: {
        port: PORT,
        save_authorized: false,
        on_active_preset_edited: 'discard',
        spec: {
          name: 'BK084 E2E v2',
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'drive', params: { drive: 4 } },
            { slot: { row: 2, col: 2 }, block_type: 'amp', params: { bass: 7, treble: 3 } },
            { slot: { row: 2, col: 3 }, block_type: 'cab' },
            { slot: { row: 2, col: 4 }, block_type: 'chorus', params: { mix: 40 } },
          ],
        },
      },
    });
    check('4: apply_preset (diff) ok', !isError(reapply), ext(reapply).slice(0, 400));
    const reapplySc = structured(reapply);
    const autoApplied = reapplySc?.auto_applied as { note?: string } | undefined;
    const claimsCab = (autoApplied?.note ?? '').toLowerCase().includes('cab');
    check('4: auto_applied does not stale-claim cab-polish for the unchanged cab', !claimsCab, JSON.stringify(autoApplied));

    console.log('\n5. get_param: amp.middle must STILL read the hand-tuned value (unchanged block kept its unlisted param)...');
    const readBack = await c.callTool({ name: 'get_param', arguments: { port: PORT, block: 'amp', name: 'middle' } });
    const readBackSc = structured(readBack);
    const gotMiddle = Number((readBackSc as { display_value?: unknown } | undefined)?.display_value);
    check(`5: amp.middle reads back ${HAND_TUNED} through the real tool boundary`, Math.abs(gotMiddle - HAND_TUNED) < 0.05, `got ${gotMiddle}`);

    console.log('\n6. set_params: batch of 5 continuous ops (>= atomic threshold), confirming apply_path/receipt/push_attempts survive the real MCP response...');
    const batch = await c.callTool({
      name: 'set_params',
      arguments: {
        port: PORT,
        ops: [
          { block: 'drive', name: 'drive', value: 6 },
          { block: 'amp', name: 'bass', value: 6.5 },
          { block: 'amp', name: 'treble', value: 4.5 },
          { block: 'amp', name: 'master_volume', value: 6 },
          { block: 'cab', name: 'level', value: -2 },
        ],
      },
    });
    check('6: set_params ok', !isError(batch), ext(batch).slice(0, 300));
    const batchSc = structured(batch) as { acked_count?: number; unacked_count?: number; apply_path?: string; receipt?: string; push_attempts?: number } | undefined;
    check('6: acked_count === 5', batchSc?.acked_count === 5, `acked=${batchSc?.acked_count}`);
    check("6: apply_path='preset-image' survives the real MCP response (structuredContent)", batchSc?.apply_path === 'preset-image', `apply_path=${batchSc?.apply_path}`);
    check("6: receipt='word-exact' survives the real MCP response", batchSc?.receipt === 'word-exact', `receipt=${batchSc?.receipt}`);
    check('6: push_attempts present and === 1', batchSc?.push_attempts === 1, `push_attempts=${batchSc?.push_attempts}`);

    console.log(`\n7. switch_preset -> location ${TARGET_LOCATION} again (reload from flash, discards all unsaved edits this script made)...`);
    const restore = await c.callTool({ name: 'switch_preset', arguments: { port: PORT, location: TARGET_LOCATION, on_active_preset_edited: 'discard' } });
    check('7: restore switch_preset ok', !isError(restore));
    const finalCheck = await c.callTool({ name: 'get_preset', arguments: { port: PORT } });
    const finalName = (structured(finalCheck) as { name?: string } | undefined)?.name;
    console.log(`  location ${TARGET_LOCATION} now named "${finalName}" (nothing was ever saved this run)`);
  } finally {
    await c.close();
  }

  console.log(`\n${pass} PASS, ${fail} FAIL.`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(99); });
