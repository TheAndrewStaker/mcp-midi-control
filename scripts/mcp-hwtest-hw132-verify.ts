/**
 * HW-132 live verification — drives the SHIPPED MCP server (real USB
 * transport) the same way the agent does, validating today's fixes
 * end-to-end on the Axe-Fx II:
 *
 *   1. export_preset now dumps the TRUE edit buffer (fn 0x03 7F 7F
 *      sentinel): build an unsaved tone, export, assert the file's
 *      `name` matches the unsaved buffer and `source` says working
 *      buffer.
 *   2. import_preset round-trips the exported file.
 *   3. get_preset reports the ACTIVE channel on a Y-scene
 *      (params_by_channel keyed Y with the Y-channel amp model).
 *   4. volpan.volume reads back in display units (0..10), not raw wire.
 *
 * Working-buffer only: save_authorized stays false throughout; ends by
 * switching to the current preset (discard) to restore the stored state.
 *
 * Run: npm run build && npx tsx scripts/mcp-hwtest-hw132-verify.ts
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'hw132-verify', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await c.connect(t);
  try {
    // 1. Build an UNSAVED Y-scene tone in the working buffer.
    console.log('1. apply_preset (unsaved): amp X/Y + volpan, scene 2 on Y …');
    const apply = await c.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        save_authorized: false,
        on_active_preset_edited: 'discard',
        spec: {
          name: 'HW132 VERIFY',
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'amp', params_by_channel: {
              X: { effect_type: 'SHIVER CLEAN', input_drive: 3.5 },
              Y: { effect_type: 'SHIVER LEAD', input_drive: 6 },
            } },
            { slot: { row: 2, col: 2 }, block_type: 'cab' },
            { slot: { row: 2, col: 3 }, block_type: 'volpan', params: { volume: 10 } },
          ],
          scenes: [
            { scene: 1, channels: { amp: 'X' } },
            { scene: 2, channels: { amp: 'Y' } },
          ],
          landingScene: 1,
        },
      },
    });
    const applyText = ext(apply);
    check('apply ok', !isError(apply) && applyText.includes('"ok": true'), applyText.slice(0, 300));

    // 2. Export the UNSAVED buffer.
    console.log('2. export_preset (unsaved buffer) …');
    const exp = await c.callTool({ name: 'export_preset', arguments: { port: 'axe-fx-ii' } });
    const expText = ext(exp);
    let expParsed: { ok?: boolean; name?: string; source?: string; file_path?: string; byte_length?: number } = {};
    try { expParsed = JSON.parse(expText); } catch { /* checked below */ }
    check('export ok', !isError(exp) && expParsed.ok === true, expText.slice(0, 300));
    check(`export name is the UNSAVED buffer name, got "${expParsed.name}"`, expParsed.name === 'HW132 VERIFY');
    check(`export source says working buffer, got "${expParsed.source}"`, /active working buffer/i.test(expParsed.source ?? ''));
    check(`export byte_length 12951, got ${expParsed.byte_length}`, expParsed.byte_length === 12951);

    // 3. Import the file back (round-trip through the real tool path).
    if (expParsed.file_path) {
      console.log('3. import_preset round-trip …');
      const imp = await c.callTool({ name: 'import_preset', arguments: { port: 'axe-fx-ii', file_path: expParsed.file_path } });
      const impText = ext(imp);
      check('import ok, 66 frames, 0 nacks', !isError(imp) && impText.includes('"frames_sent": 66') && impText.includes('"nacks": []'), impText.slice(0, 200));
    }

    // 4. Y-scene channel honesty: switch to scene 2 (amp on Y), snapshot.
    console.log('4. switch_scene 2 + get_preset (active-channel honesty) …');
    await c.callTool({ name: 'switch_scene', arguments: { port: 'axe-fx-ii', scene: 2 } });
    const snap = await c.callTool({ name: 'get_preset', arguments: { port: 'axe-fx-ii' } });
    const snapText = ext(snap);
    let snapParsed: { slots?: Array<{ block_type?: string; params_by_channel?: Record<string, Record<string, unknown>>; channel_status?: string }> } = {};
    try { snapParsed = JSON.parse(snapText); } catch { /* checked below */ }
    const amp = (snapParsed.slots ?? []).find((s) => s.block_type === 'amp');
    const ampKeys = Object.keys(amp?.params_by_channel ?? {});
    check(`amp snapshot keyed by ACTIVE channel Y, got [${ampKeys.join(',')}] status=${amp?.channel_status}`,
      ampKeys.length === 1 && ampKeys[0] === 'Y' && amp?.channel_status === 'active');
    const yModel = amp?.params_by_channel?.Y?.effect_type;
    check(`amp Y params carry the Y model (SHIVER LEAD), got "${String(yModel)}"`, yModel === 'SHIVER LEAD');

    // 5. volpan.volume display readback.
    console.log('5. get_param volpan.volume (display calibration) …');
    const vol = await c.callTool({ name: 'get_param', arguments: { port: 'axe-fx-ii', block: 'volpan', name: 'volume' } });
    const volText = ext(vol);
    let volParsed: { display_value?: unknown; wire_value?: number } = {};
    try { volParsed = JSON.parse(volText); } catch { /* checked below */ }
    check(`volpan.volume display 10 (wire ${volParsed.wire_value}), got ${String(volParsed.display_value)}`,
      typeof volParsed.display_value === 'number' && Math.abs((volParsed.display_value as number) - 10) < 0.05);

    // 6. Restore: discard the test buffer (reload stored preset).
    console.log('6. restore: switch_preset (discard) back to the stored preset …');
    const num = await c.callTool({ name: 'get_param', arguments: { port: 'axe-fx-ii', block: 'amp', name: 'effect_type' } });
    void num; // buffer state is junk; the switch below reloads stored.
    const sw = await c.callTool({ name: 'switch_preset', arguments: { port: 'axe-fx-ii', location: 8, on_active_preset_edited: 'discard' } });
    check('restore switch ok', !isError(sw), ext(sw).slice(0, 200));
  } finally {
    await c.close();
  }
  console.log(failed === 0 ? '\nALL CHECKS PASS' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`hwtest failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
