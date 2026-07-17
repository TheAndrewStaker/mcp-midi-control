/**
 * Bench test 1: Axe-Fx II atomic get_preset (BK-081) against real hardware.
 * Read-only: no apply, no save, no buffer mutation.
 * Run: npx tsx bench1-ii-atomic-read.ts   (cwd = repo root)
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

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'bench1-ii-atomic-read', version: '1' }, { capabilities: {} });
  await c.connect(t);
  try {
    const started = Date.now();
    const r = await c.callTool({ name: 'get_preset', arguments: { port: 'Fractal Axe-Fx II XL+', include_channel_state: true } });
    const elapsed = Date.now() - started;
    const text = ext(r);
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(text); } catch { console.log('RAW (non-JSON):\n' + text.slice(0, 2000)); return; }

    const meta = (p._meta ?? {}) as Record<string, unknown>;
    console.log('=== BENCH 1 RESULT ===');
    console.log('top-level keys:', Object.keys(p).join(', '));
    console.log('active_scene:', p.active_scene, '| chain_integrity:', JSON.stringify(p.chain_integrity));
    const slots = (p.slots ?? []) as Array<Record<string, unknown>>;
    console.log('placed blocks (' + slots.length + '):');
    for (const b of slots) {
      const slot = (b.slot ?? {}) as Record<string, unknown>;
      const pbc = (b.params_by_channel ?? {}) as Record<string, Record<string, unknown>>;
      const chans = Object.keys(pbc);
      console.log(`  (${slot.row},${slot.col}) ${b.block_type}${b.instance && b.instance !== 1 ? ' #' + b.instance : ''}${b.bypassed ? ' [bypassed]' : ''} channels=${chans.join('/')}`);
      for (const ch of chans) {
        const params = pbc[ch];
        const interesting = Object.entries(params).filter(([k]) =>
          /^(gain|drive|master|level|mix|time|type|effect_type|bass|mid|treble)$/.test(k)).slice(0, 6);
        if (interesting.length) console.log(`      ${ch}: ` + interesting.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  '));
      }
    }
    console.log('elapsed_ms:', elapsed);
    console.log('read_path:', meta.read_path);
    console.log('fallback_reason:', meta.image_read_fallback_reason ?? '(none)');
    console.log('preset name:', p.name, '| location:', p.location ?? p.preset_number ?? '(active)');

    const blocks = (p.blocks ?? []) as Array<Record<string, unknown>>;
    console.log('blocks (' + blocks.length + '):');
    for (const b of blocks) {
      const params = (b.params ?? {}) as Record<string, unknown>;
      const keys = Object.keys(params);
      console.log(`  - ${b.block ?? b.type ?? '?'}${b.engaged === false ? ' [bypassed]' : ''} (${keys.length} params)`);
    }
    // Spot-check candidates for the front panel: print amp + delay + reverb key knobs if present.
    for (const b of blocks) {
      const name = String(b.block ?? b.type ?? '');
      const params = (b.params ?? {}) as Record<string, unknown>;
      if (/amp|drive|delay|reverb|cab/i.test(name)) {
        const interesting = Object.entries(params).filter(([k]) =>
          /gain|drive|master|level|mix|time|bass|mid|treble|type/i.test(k)).slice(0, 8);
        if (interesting.length) {
          console.log(`  spot-check ${name}: ` + interesting.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  '));
        }
      }
    }
    const warnings = p.read_warnings ?? p.warnings;
    if (warnings) console.log('warnings:', JSON.stringify(warnings));
  } finally {
    await c.close();
  }
}

main().catch((err) => { console.error(`bench1 failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
