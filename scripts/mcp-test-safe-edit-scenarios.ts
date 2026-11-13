/**
 * ⚠ DEPRECATED — pre-v0.4. Drives the v0.3 device-namespaced tools
 * (am4_apply_preset_at, axefx2_apply_preset_at, …) which were removed
 * in the v0.3 → v0.4 migration. The non-destructive refusal scenarios
 * (S3a: apply-at-slot, no save_authorized → REFUSAL) also no longer
 * reflect v0.4 contract: apply_preset with target_location and
 * save_authorized=false now AUDITIONS AT TARGET (no save), it does
 * NOT refuse.
 *
 * REPLACEMENT for non-destructive scenarios: scripts/launch-verification.ts
 * (npm run launch-verify). That harness drives the v0.4 unified surface
 * (apply_preset, switch_preset, set_param) and covers the surviving
 * refusal scenarios — dirty-buffer gate on switch_preset for both
 * Fractal devices, plus AM4 routing/instance contract rejections and
 * skip-with-warning on type-gated params.
 *
 * Destructive scenarios from the original SAFE-EDIT-WORKFLOW.md
 * (clean + save-to-X happy path, dirty + setlist refusal) are not yet
 * ported to the v0.4 surface. When that port lands, this file can be
 * deleted.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

// ── CLI ────────────────────────────────────────────────────────────

interface CliOpts {
  devices: string[];
  destructive: boolean;
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = { devices: ['am4', 'axe-fx-ii'], destructive: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.destructive = true;
    else if (a === '--device') opts.devices = [argv[++i]];
  }
  return opts;
}

// ── MCP helpers ────────────────────────────────────────────────────

function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!);
  return parts.join('\n') + (r.isError ? '\n  [isError=true]' : '');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

// ── Device profiles ────────────────────────────────────────────────
//
// Encodes the cross-device variation that's NOT covered by the shared
// safe-edit schema: tool names, scratch-slot naming, minimal preset
// payload shape (each device's apply tools take a slightly different
// schema). The scenario logic is device-agnostic; only the
// invocations differ.

interface DeviceProfile {
  label: string;
  applyWorkingBufferTool: string;            // scenario 1 — no slot, no save
  applyAtSlotTool: string;                   // scenarios 2/3
  applySetlistTool: string;                  // scenarios 4/5
  switchPresetTool: string;                  // scenarios 6/7
  setParamTool: string;                      // used to dirty the buffer
  scratchSlotArg: () => Record<string, unknown>;            // slot-naming arg for apply-at-slot
  setlistScratchEntries: () => Array<{ location?: string; preset: unknown }> | Array<{ slot?: number; blocks: unknown[] }>;
  switchScratchArg: () => Record<string, unknown>;
  dirtyArgs: () => Record<string, unknown>;  // a minimal set_param to mark dirty
  minimalApplyPresetArgs: () => Record<string, unknown>;
  minimalApplyAtSlotArgs: (extra: Record<string, unknown>) => Record<string, unknown>;
  minimalApplySetlistArgs: (extra: Record<string, unknown>) => Record<string, unknown>;
}

const AM4: DeviceProfile = {
  label: 'AM4',
  applyWorkingBufferTool: 'am4_apply_preset',
  applyAtSlotTool: 'am4_apply_preset_at',
  applySetlistTool: 'am4_apply_setlist',
  switchPresetTool: 'am4_switch_preset',
  setParamTool: 'am4_set_param',
  scratchSlotArg: () => ({ location: 'Z04' }),
  setlistScratchEntries: () => [],
  switchScratchArg: () => ({ location: 'A01' }),
  dirtyArgs: () => ({ block: 'amp', name: 'gain', value: 4 }),
  minimalApplyPresetArgs: () => ({
    slots: [{ position: 1, block_type: 'amp' }],
    name: 'sf',
  }),
  minimalApplyAtSlotArgs: (extra) => ({
    location: 'Z04',
    preset: { slots: [{ position: 1, block_type: 'amp' }], name: 'sf' },
    ...extra,
  }),
  minimalApplySetlistArgs: (extra) => ({
    presets: [
      { location: 'Z04', preset: { slots: [{ position: 1, block_type: 'amp' }], name: 'a' } },
      { location: 'Z03', preset: { slots: [{ position: 1, block_type: 'amp' }], name: 'b' } },
    ],
    // No `dry_run` — we want the dirty gate to fire, which it can't if
    // the tool returns early on dry_run before reaching the guard.
    // Destructive blast radius if the gate breaks: AM4 Z03+Z04 (scratch
    // slots by convention).
    ...extra,
  }),
};

const AXEFX2: DeviceProfile = {
  label: 'Axe-Fx II',
  applyWorkingBufferTool: 'axefx2_apply_preset',
  applyAtSlotTool: 'axefx2_apply_preset_at',
  applySetlistTool: 'axefx2_apply_setlist',
  switchPresetTool: 'axefx2_switch_preset',
  setParamTool: 'axefx2_set_param',
  scratchSlotArg: () => ({ slot: 603 }),
  setlistScratchEntries: () => [],
  switchScratchArg: () => ({ slot: 1 }),
  dirtyArgs: () => ({ block: 'Amp 1', name: 'input_drive', value: 5 }),
  minimalApplyPresetArgs: () => ({
    blocks: [{ block: 'Amp 1' }],
    name: 'sf',
  }),
  minimalApplyAtSlotArgs: (extra) => ({
    slot: 603,
    blocks: [{ block: 'Amp 1' }],
    name: 'sf',
    ...extra,
  }),
  minimalApplySetlistArgs: (extra) => ({
    presets: [
      { slot: 603, blocks: [{ block: 'Amp 1' }], name: 'a' },
      { slot: 604, blocks: [{ block: 'Amp 1' }], name: 'b' },
    ],
    // No `dry_run` — see AM4 profile comment. Destructive blast radius
    // if the gate breaks: Axe-Fx II slots 603 + 604 (already exercise
    // slots from earlier sessions; safely re-buildable).
    ...extra,
  }),
};

const PROFILES: Record<string, DeviceProfile> = { am4: AM4, 'axe-fx-ii': AXEFX2 };

// ── Result tracking ────────────────────────────────────────────────

interface ScenarioResult {
  device: string;
  scenario: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
}

const results: ScenarioResult[] = [];

function record(r: ScenarioResult): void {
  results.push(r);
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '⊘';
  console.log(`  ${icon} ${r.scenario.padEnd(40)} ${r.detail}`);
}

// ── Scenarios ──────────────────────────────────────────────────────

async function runRefusalScenarios(client: Client, dev: DeviceProfile): Promise<void> {
  console.log(`\n── ${dev.label} — refusal gates (hardware-free) ──`);

  // Scenario 3a: apply-at-slot without save_authorized refuses.
  const r3a = await client.callTool({
    name: dev.applyAtSlotTool,
    arguments: dev.minimalApplyAtSlotArgs({ on_active_preset_edited: 'discard' }),
  });
  const t3a = extractText(r3a);
  if (isError(r3a) && /REFUSING TO SAVE/i.test(t3a) && new RegExp(dev.applyWorkingBufferTool, 'i').test(t3a)) {
    record({
      device: dev.label,
      scenario: 'S3a: apply-at-slot, no save_authorized',
      status: 'pass',
      detail: `refusal text present, names ${dev.applyWorkingBufferTool}`,
    });
  } else {
    record({
      device: dev.label,
      scenario: 'S3a: apply-at-slot, no save_authorized',
      status: 'fail',
      detail: isError(r3a) ? 'isError true but text mismatch' : 'expected refusal, got success',
    });
    console.log(`    Response excerpt:\n${t3a.split('\n').slice(0, 4).map((l) => `      ${l}`).join('\n')}`);
  }
}

async function runHardwareScenarios(client: Client, dev: DeviceProfile, destructive: boolean): Promise<void> {
  console.log(`\n── ${dev.label} — live hardware scenarios ${destructive ? '' : '(SKIPPED — pass --write to enable)'} ──`);

  if (!destructive) {
    record({ device: dev.label, scenario: 'S1: working-buffer apply', status: 'skip', detail: 'requires --write' });
    record({ device: dev.label, scenario: 'S2: apply-at-slot success', status: 'skip', detail: 'requires --write' });
    record({ device: dev.label, scenario: 'S3b: dirty + apply-at-slot', status: 'skip', detail: 'requires --write' });
    record({ device: dev.label, scenario: 'S5: dirty + setlist', status: 'skip', detail: 'requires --write' });
    record({ device: dev.label, scenario: 'S6: clean + switch_preset', status: 'skip', detail: 'requires --write' });
    record({ device: dev.label, scenario: 'S7: dirty + switch_preset', status: 'skip', detail: 'requires --write' });
    return;
  }

  // Reach the device by switching to a known slot with `discard` so we
  // start from a clean baseline regardless of the device's prior state.
  // This call is also our "is the device connected?" probe.
  const probe = await client.callTool({
    name: dev.switchPresetTool,
    arguments: { ...dev.switchScratchArg(), on_active_preset_edited: 'discard' },
  });
  if (isError(probe) && /not.*connected|port|no.*output|not found|reconnect/i.test(extractText(probe))) {
    record({ device: dev.label, scenario: 'all hardware scenarios', status: 'skip', detail: 'device not connected' });
    return;
  }
  // Buffer is clean from here.

  // S6: clean + switch_preset (no mode override) → succeeds.
  // Critical test: this proves the dirty guard is a NO-OP on clean
  // state. If it incorrectly refused on clean buffers, every tool
  // call would need an explicit mode override.
  {
    const r = await client.callTool({
      name: dev.switchPresetTool,
      arguments: dev.switchScratchArg(),  // no on_active_preset_edited — default 'warn'
    });
    const ok = !isError(r);
    record({
      device: dev.label,
      scenario: 'S6: clean + switch_preset',
      status: ok ? 'pass' : 'fail',
      detail: ok ? 'switch on clean buffer succeeded (default mode)' : extractText(r).split('\n')[0],
    });
  }
  // Still clean.

  // S1: working-buffer apply (no slot, no save) succeeds without save_authorized.
  {
    const r = await client.callTool({
      name: dev.applyWorkingBufferTool,
      arguments: dev.minimalApplyPresetArgs(),
    });
    const ok = !isError(r);
    record({
      device: dev.label,
      scenario: 'S1: working-buffer apply',
      status: ok ? 'pass' : 'fail',
      detail: ok ? 'tool ran without save_authorized (working buffer)' : `unexpected error: ${extractText(r).split('\n')[0]}`,
    });
  }
  // Buffer is dirty from S1's writes.

  // S7: dirty + switch_preset (no mode override) → REFUSES.
  {
    const r = await client.callTool({
      name: dev.switchPresetTool,
      arguments: dev.switchScratchArg(),
    });
    const refused = isError(r) && /REFUSING TO NAVIGATE/i.test(extractText(r));
    record({
      device: dev.label,
      scenario: 'S7: dirty + switch_preset',
      status: refused ? 'pass' : 'fail',
      detail: refused ? 'navigation refused on dirty buffer' : 'expected dirty refusal',
    });
  }
  // Still dirty.

  // S3b: apply-at-slot with save_authorized=true on dirty → REFUSES (dirty gate fires after save-auth passes).
  {
    const r = await client.callTool({
      name: dev.applyAtSlotTool,
      arguments: dev.minimalApplyAtSlotArgs({ save_authorized: true }),
    });
    const refused = isError(r) && /REFUSING TO NAVIGATE/i.test(extractText(r));
    record({
      device: dev.label,
      scenario: 'S3b: dirty + apply-at-slot',
      status: refused ? 'pass' : 'fail',
      detail: refused ? 'dirty gate fires after save-auth passes' : 'expected dirty refusal',
    });
  }
  // Still dirty.

  // S5: setlist on dirty → REFUSES.
  {
    const r = await client.callTool({
      name: dev.applySetlistTool,
      arguments: dev.minimalApplySetlistArgs({}),
    });
    const refused = isError(r) && /REFUSING TO NAVIGATE/i.test(extractText(r));
    record({
      device: dev.label,
      scenario: 'S5: dirty + setlist',
      status: refused ? 'pass' : 'fail',
      detail: refused ? 'setlist honors dirty gate' : 'expected dirty refusal',
    });
  }
  // Still dirty — discard now so S2 starts from clean.
  await client.callTool({
    name: dev.switchPresetTool,
    arguments: { ...dev.switchScratchArg(), on_active_preset_edited: 'discard' },
  });

  // S2: apply-at-slot with save_authorized=true on clean → succeeds.
  {
    const r = await client.callTool({
      name: dev.applyAtSlotTool,
      arguments: dev.minimalApplyAtSlotArgs({ save_authorized: true }),  // no override needed — buffer is clean
    });
    const ok = !isError(r);
    record({
      device: dev.label,
      scenario: 'S2: clean + apply-at-slot success',
      status: ok ? 'pass' : 'fail',
      detail: ok ? 'apply-and-save cleared all gates' : extractText(r).split('\n')[0],
    });
  }

  // Cleanup: discard back to a known slot so subsequent devices in the
  // suite start from a known state.
  await client.callTool({
    name: dev.switchPresetTool,
    arguments: { ...dev.switchScratchArg(), on_active_preset_edited: 'discard' },
  });
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('⚠  DEPRECATED — pre-v0.4 safe-edit regression suite.');
  console.log('');
  console.log('This harness drives the v0.3 device-namespaced tools');
  console.log('(am4_apply_preset_at, axefx2_apply_preset_at) which were');
  console.log('removed in the v0.3 → v0.4 migration. Non-destructive');
  console.log('refusal scenarios have moved to scripts/launch-verification.ts:');
  console.log('');
  console.log('  npm run launch-verify');
  console.log('');
  console.log('No scenarios ran.');
  if (!process.env.LEGACY_SAFE_EDIT_RUN) return;

  const opts = parseCli(process.argv);

  console.log(`Safe-edit contract regression suite`);
  console.log(`  devices: ${opts.devices.join(', ')}`);
  console.log(`  destructive: ${opts.destructive}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) transport.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));

  const client = new Client({ name: 'mcp-test-safe-edit', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });

  try {
    await client.connect(transport);
  } catch (err) {
    console.error('Failed to connect to MCP server:', err);
    process.exit(2);
  }

  try {
    for (const label of opts.devices) {
      const dev = PROFILES[label];
      if (!dev) {
        console.error(`Unknown device "${label}". Known: ${Object.keys(PROFILES).join(', ')}`);
        continue;
      }
      await runRefusalScenarios(client, dev);
      await runHardwareScenarios(client, dev, opts.destructive);
    }
  } finally {
    await client.close();
  }

  console.log('\n══════════════════════════════════════════════════════════');
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  console.log(`Summary: ${pass} pass, ${fail} fail, ${skip} skip`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  ${r.device} — ${r.scenario}: ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(99); });
