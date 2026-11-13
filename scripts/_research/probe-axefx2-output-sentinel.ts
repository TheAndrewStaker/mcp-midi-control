#!/usr/bin/env tsx
/**
 * Empirical end-to-end test of the OUTPUT sentinel against the live
 * Axe-Fx II. Builds a minimal 3-block preset (compressor → amp →
 * reverb at cols 1-3) with explicit routing terminated by `to:
 * "OUTPUT"`. Asserts:
 *
 *   1. apply_preset returns ok:true
 *   2. nacked_steps[] is empty (every cable acked)
 *   3. chain_integrity.ok is true (col 12 receives signal)
 *
 * Pre-fix (without OUTPUT sentinel) this would either:
 *   - Fail the cable from col 3 to nothing (no auto-extension), OR
 *   - Report chain_integrity.ok:true falsely (the bug we fixed)
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_ENTRY = path.join(
  PROJECT_ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js',
);

async function main() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_ENTRY],
    env: { ...process.env },
  });

  const client = new Client({ name: 'output-sentinel-probe', version: '0.0.1' }, {
    capabilities: {},
    versionNegotiation: { mode: 'auto' },
  });

  await client.connect(transport);
  console.log('=== OUTPUT sentinel live test ===\n');

  const spec = {
    name: 'OutputSentinelTest',
    slots: [
      { slot: { row: 2, col: 1 }, block_type: 'compressor' },
      { slot: { row: 2, col: 2 }, block_type: 'amp' },
      { slot: { row: 2, col: 3 }, block_type: 'reverb' },
    ],
    routing: [
      { from: 'compressor', to: 'amp' },
      { from: 'amp', to: 'reverb' },
      { from: 'reverb', to: 'OUTPUT' }, // ← the sentinel — auto-extend through col 12
    ],
  };

  console.log('Applying spec (audition only, no save):');
  console.log(JSON.stringify(spec, null, 2));
  console.log();

  const result = await client.callTool({
    name: 'apply_preset',
    arguments: { port: 'axe-fx-ii', spec, verify_chain: true },
  });

  console.log('Response:');
  const text = (result.content as Array<{ type: string; text: string }>)?.[0]?.text ?? '';
  console.log(text.slice(0, 3000));
  console.log();

  // Parse the response payload to extract ok / nacked_steps / chain_integrity.
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    console.error('Could not parse response as JSON');
    await client.close();
    process.exit(1);
  }

  const checks: { label: string; pass: boolean; detail?: string }[] = [
    {
      label: 'apply_preset returned ok:true',
      pass: payload.ok === true,
      detail: `ok=${payload.ok}, nacked_steps=${JSON.stringify(payload.nacked_steps ?? [])}`,
    },
    {
      label: 'nacked_steps is empty (every cable acked)',
      pass: !payload.nacked_steps || payload.nacked_steps.length === 0,
      detail: `nacked_steps: ${JSON.stringify(payload.nacked_steps)}`,
    },
    {
      label: 'chain_integrity.ok is true (col 12 receives signal)',
      pass: payload.chain_integrity?.ok === true,
      detail: `chain_integrity: ${JSON.stringify(payload.chain_integrity)}`,
    },
    {
      label: 'OUTPUT-tail extension placed shunts at cols 4..12',
      pass: typeof payload.steps === 'number' && payload.steps >= 10,
      detail: `steps=${payload.steps} (3 places + 9 shunts + ~12 cables ≈ 24 expected)`,
    },
  ];

  let failed = 0;
  for (const c of checks) {
    if (c.pass) console.log(`  OK    ${c.label}`);
    else {
      failed++;
      console.error(`  FAIL  ${c.label}\n        ${c.detail ?? ''}`);
    }
  }

  await client.close();
  if (failed > 0) {
    console.error(`\n${failed} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll OUTPUT-sentinel checks pass. Signal should reach the II hardware output.');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
