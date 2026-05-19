/**
 * Mocked-agent regression for bucket-4 changes (commit 9ca072b).
 *
 * Validates that device-namespaced tools on agent retry paths surface
 * structured DispatchError details (`valid_options` / `valid_options_tool`
 * / `retry_action`) on vocabulary failures, AND emit `structuredContent`
 * alongside the human-readable text on successful calls.
 *
 * Spawns the shipped MCP server with `MCP_MOCK_TRANSPORT=1` so no USB
 * hardware is required. The mock devices ack successful writes; the
 * vocabulary failures we test fire BEFORE any MIDI send so the mock
 * transport isn't even contacted on the negative-path cases.
 *
 * Run: `npm run build && npx tsx scripts/mcp-test-agent-retry-paths.ts`
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(
  process.cwd(),
  'packages',
  'server-all',
  'dist',
  'server',
  'index.js',
);

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '<no response>';
  const x = r as CallResult;
  const parts = (x.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n');
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}
function structured(r: unknown): Record<string, unknown> | undefined {
  return (r as CallResult)?.structuredContent;
}

interface CaseResult {
  name: string;
  pass: boolean;
  notes: string[];
}

const RESULTS: CaseResult[] = [];

function record(name: string, pass: boolean, notes: string[]): void {
  RESULTS.push({ name, pass, notes });
  const tag = pass ? '✓ PASS' : '✗ FAIL';
  console.log(`  ${tag} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

async function main(): Promise<void> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, MCP_MOCK_TRANSPORT: '1' };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env,
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      // Filter out the verbose smoke-server boot banner; keep errors visible.
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'mcp-test-agent-retry-paths', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);

    // ── Axe-Fx II: bad block name on set_block_channel ──────────────
    console.log('\nAxe-Fx II — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'axefx2_set_block_channel',
        arguments: { block: 'NonExistentBlockName', channel: 'X' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasValidOptions = /Valid options:/i.test(t);
      const hasRetryAction = /Call axefx2_list_block_types|axefx2_list_block_types for the full list/i.test(t);
      const namesBlock = /Unknown block "NonExistentBlockName"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text contains list_block_types pointer → ${hasRetryAction}`);
      notes.push(`text quotes bad input → ${namesBlock}`);
      const pass = isErr && hasValidOptions && hasRetryAction && namesBlock;
      record('axefx2_set_block_channel(bad name) → structured DispatchError', pass, notes);
    }

    // ── Axe-Fx II: SUCCESS path on a valid block ────────────────────
    {
      const r = await client.callTool({
        name: 'axefx2_set_block_channel',
        arguments: { block: 'Amp 1', channel: 'X' },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  block=${JSON.stringify(sc['block'])} channel=${JSON.stringify(sc['channel'])} effect_id=${JSON.stringify(sc['effect_id'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && sc['block'] === 'Amp 1'
        && sc['channel'] === 'X'
        && typeof sc['effect_id'] === 'number';
      record('axefx2_set_block_channel(good name) → structuredContent emitted', pass, notes);
    }

    // ── Hydrasynth: bad System CC id ────────────────────────────────
    console.log('\nHydrasynth — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'hydra_set_param',
        arguments: { id: 'system.bogus', value: 64 },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasValidOptions = /Valid options:/i.test(t);
      const hasNRPNPointer = /set_param\(\{port:"hydrasynth"/i.test(t)
        || /set_param.*port.*hydrasynth/i.test(t);
      const namesId = /Unknown parameter id "system.bogus"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text steers engine writes to unified set_param → ${hasNRPNPointer}`);
      notes.push(`text quotes bad input → ${namesId}`);
      const pass = isErr && hasValidOptions && hasNRPNPointer && namesId;
      record('hydra_set_param(bad id) → structured DispatchError', pass, notes);
    }

    // ── Hydrasynth: success on valid id ─────────────────────────────
    {
      const r = await client.callTool({
        name: 'hydra_set_param',
        arguments: { id: 'system.master_volume', value: 100 },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  id=${JSON.stringify(sc['id'])} cc=${JSON.stringify(sc['cc'])} value=${JSON.stringify(sc['value'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && sc['id'] === 'system.master_volume'
        && typeof sc['cc'] === 'number'
        && sc['value'] === 100;
      record('hydra_set_param(good id) → structuredContent emitted', pass, notes);
    }

    // ── Hydrasynth: engine id rejected with steer-to-unified hint ───
    {
      const r = await client.callTool({
        name: 'hydra_set_param',
        arguments: { id: 'osc1type', value: 0 },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      // osc1type isn't in HYDRASYNTH_PARAMS at all (NRPN-only). It should
      // hit the "Unknown parameter id" branch with valid_options.
      const hasValidOptions = /Valid options:/i.test(t);
      const pointsAtUnified = /set_param\(\{port:"hydrasynth"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains "Valid options:" → ${hasValidOptions}`);
      notes.push(`text steers to unified set_param → ${pointsAtUnified}`);
      const pass = isErr && hasValidOptions && pointsAtUnified;
      record('hydra_set_param(engine id) → steers agent to unified surface', pass, notes);
    }

    // ── Axe-Fx III: bad block name on get_bypass ────────────────────
    console.log('\nAxe-Fx III — vocabulary retry path');
    {
      const r = await client.callTool({
        name: 'axefx3_get_bypass',
        arguments: { block: 'NotARealBlockName' },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasRetryAction = /axefx3_list_blocks/i.test(t);
      const namesBlock = /Unknown Axe-Fx III block "NotARealBlockName"/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains axefx3_list_blocks pointer → ${hasRetryAction}`);
      notes.push(`text quotes bad input → ${namesBlock}`);
      const pass = isErr && hasRetryAction && namesBlock;
      record('axefx3_get_bypass(bad name) → structured DispatchError', pass, notes);
    }

    // ── Axe-Fx III: bad block on set_parameter (the raw-wire path) ──
    {
      const r = await client.callTool({
        name: 'axefx3_set_parameter',
        arguments: { block: 'Wibble 99', param_id: 1, value: 32767 },
      });
      const t = extractText(r);
      const notes: string[] = [];
      const isErr = isError(r);
      const hasRetryAction = /axefx3_list_blocks/i.test(t);
      notes.push(`isError=${isErr}`);
      notes.push(`text contains axefx3_list_blocks pointer → ${hasRetryAction}`);
      const pass = isErr && hasRetryAction;
      record('axefx3_set_parameter(bad name) → structured DispatchError', pass, notes);
    }

    // ── Axe-Fx III: success on valid block (mock transport acks) ────
    {
      const r = await client.callTool({
        name: 'axefx3_set_parameter',
        arguments: { block: 'Reverb 1', param_id: 1, value: 32767 },
      });
      const sc = structured(r);
      const notes: string[] = [];
      const isErr = isError(r);
      notes.push(`isError=${isErr}`);
      notes.push(`structuredContent present → ${sc !== undefined}`);
      if (sc) {
        notes.push(`  block=${JSON.stringify(sc['block'])} param_id=${JSON.stringify(sc['param_id'])} value=${JSON.stringify(sc['value'])}`);
      }
      const pass = !isErr
        && sc !== undefined
        && sc['block'] === 'Reverb 1'
        && sc['param_id'] === 1
        && sc['value'] === 32767;
      record('axefx3_set_parameter(good name) → structuredContent emitted', pass, notes);
    }
  } finally {
    await client.close();
  }

  // ── Summary ─────────────────────────────────────────────────────
  const passed = RESULTS.filter((r) => r.pass).length;
  const failed = RESULTS.filter((r) => !r.pass).length;
  console.log(`\n────────────────────────────────────────`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of RESULTS.filter((r) => !r.pass)) {
      console.log(`  ✗ ${r.name}`);
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(99);
});
