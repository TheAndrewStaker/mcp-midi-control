#!/usr/bin/env tsx
/**
 * Screech-fix hardware test (2026-06-07). Spawns a FRESH server from the
 * freshly-built dist (so it loads the bypass-during-build executor change)
 * and fires the exact E1 repro spec that screeched: two non-master high-gain
 * amps, 6 scenes with channel + bypass switching, delay + reverb.
 *
 * Working-buffer only (no save). Listen during the apply: with the fix, the
 * build runs through a dry/bypassed path, so it should be silent (brief
 * dropout at most), NOT screech.
 *
 * Run:  npx tsx scripts/_research/screech-fix-hwtest.ts
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_ENTRY = path.join(PROJECT_ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');

const SPEC = {
  name: 'ScreechRepro',
  slots: [
    { slot: { row: 2, col: 1 }, block_type: 'drive', params_by_channel: { X: { effect_type: 'T808 OD', gain: 6, volume: 6 } } },
    { slot: { row: 2, col: 2 }, block_type: 'amp', params_by_channel: { X: { effect_type: 'BRIT SUPER', input_drive: 8 }, Y: { effect_type: 'PLEXI 100W HIGH', input_drive: 9 } } },
    { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2, params_by_channel: { X: { effect_type: 'PLEXI 50W HI 1', input_drive: 8 }, Y: { effect_type: 'BRIT SUPER', input_drive: 9 } } },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
    { slot: { row: 2, col: 5 }, block_type: 'delay', params_by_channel: { X: { effect_type: 'DIGITAL STEREO', mix: 35, feedback: 50 } } },
    { slot: { row: 2, col: 6 }, block_type: 'reverb', params_by_channel: { X: { effect_type: 'LARGE HALL', mix: 45 } } },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'X', amp_2: 'X', reverb: 'X' }, bypassed: { drive: true, amp_2: true, delay: true } },
    { scene: 2, name: 'Crunch', channels: { amp: 'X', amp_2: 'X' }, bypassed: { drive: false, amp_2: true, delay: true } },
    { scene: 3, name: 'Rhythm', channels: { amp: 'Y', amp_2: 'X' }, bypassed: { drive: false, amp_2: false, delay: true } },
    { scene: 4, name: 'Lead', channels: { amp: 'Y', amp_2: 'Y' }, bypassed: { drive: false, amp_2: false, delay: false } },
    { scene: 5, name: 'Ambient', channels: { amp: 'X', amp_2: 'Y', reverb: 'X' }, bypassed: { drive: true, amp_2: true, delay: false } },
    { scene: 6, name: 'Solo', channels: { amp: 'Y', amp_2: 'Y' }, bypassed: { drive: false, amp_2: false, delay: false } },
  ],
  landingScene: 1,
};

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER_ENTRY], env: { ...process.env } });
  const client = new Client({ name: 'screech-fix-hwtest', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  console.log('=== fresh server (new dist) connected ===\n');

  console.log('Firing E1 repro spec via apply_preset (working buffer, no save)...');
  console.log('LISTEN NOW — with the fix this should be silent/dropout, not a screech.\n');
  const t0 = Date.now();
  const res = await client.callTool({
    name: 'apply_preset',
    arguments: { port: 'axe-fx-ii', on_active_preset_edited: 'discard', spec: SPEC },
  });
  const ms = Date.now() - t0;

  const text = (res as { content?: Array<{ type: string; text?: string }> }).content?.find((c) => c.type === 'text')?.text ?? '';
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  console.log(`apply_preset returned in ${ms}ms`);
  console.log(`  ok: ${parsed.ok}`);
  console.log(`  steps: ${parsed.steps}`);
  if (parsed.warning) console.log(`  warning: ${parsed.warning}`);
  if (parsed.validation_errors) console.log(`  validation_errors: ${JSON.stringify(parsed.validation_errors)}`);
  if (!text) console.log('  raw:', JSON.stringify(res).slice(0, 800));

  await client.close();
  console.log('\n=== done — report what you heard ===');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
