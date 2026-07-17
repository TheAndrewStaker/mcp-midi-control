/**
 * Bench diagnostic: does an AM4 scene switch set the device-true edited
 * bit (the yellow "E")? Uses only shipped tools; the 'warn' navigation
 * doubles as a behavioral read of GET_PATCH byte[21] & 0x04.
 *
 * Sequence:
 *   1. switch_preset A01 mode 'warn'    -> refusal == bit currently SET
 *   2. switch_preset A01 mode 'discard' -> clean reload (bit should clear)
 *   3. switch_preset A01 mode 'warn'    -> expect proceed (bit clear)
 *   4. switch_scene 2                   -> the suspect op
 *   5. switch_preset A01 mode 'warn'    -> refusal == scene switch SET the bit
 *   6. final: switch_preset A01 'discard' to leave a clean buffer either way
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve('C:/dev/mcp-midi-tools', 'packages', 'server-all', 'dist', 'server', 'index.js');

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}

function verdict(step: string, text: string): boolean {
  const refused = /on_active_preset_edited|unsaved|dirty/i.test(text) && !/"acked": true/.test(text);
  console.log(`${step}: ${refused ? 'REFUSED (bit SET)' : 'PROCEEDED (bit clear)'}`);
  return refused;
}

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'bench-am4-edited-diag', version: '1' }, { capabilities: {} });
  await c.connect(t);
  const call = async (name: string, args: Record<string, unknown>) =>
    ext(await c.callTool({ name, arguments: args }));
  try {
    const s1 = await call('switch_preset', { port: 'am4', location: 'A01', on_active_preset_edited: 'warn' });
    verdict('1) warn-nav with current buffer', s1);

    await call('switch_preset', { port: 'am4', location: 'A01', on_active_preset_edited: 'discard' });
    console.log('2) discard-reload of A01 done');

    const s3 = await call('switch_preset', { port: 'am4', location: 'A01', on_active_preset_edited: 'warn' });
    const dirtyAfterReload = verdict('3) warn-nav right after clean reload', s3);
    if (dirtyAfterReload) {
      console.log('   UNEXPECTED: bit set right after a clean reload; stopping before scene test.');
      return;
    }

    await call('switch_scene', { port: 'am4', scene: 2 });
    console.log('4) switch_scene -> 2 done');

    const s5 = await call('switch_preset', { port: 'am4', location: 'A01', on_active_preset_edited: 'warn' });
    const sceneSetsBit = verdict('5) warn-nav after scene switch', s5);

    await call('switch_preset', { port: 'am4', location: 'A01', on_active_preset_edited: 'discard' });
    console.log('6) final discard-reload done (buffer clean, scene = stored)');

    console.log(`\nCONCLUSION: scene switch ${sceneSetsBit ? 'SETS' : 'does NOT set'} the AM4 edited bit.`);
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`diag failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
