/**
 * Verify all three CPR calibration entries against live hardware.
 *
 * Writes display values at min/mid/max for comp, filter, and look_ahead,
 * reads back via get_param, and checks the device's ASCII label matches.
 *
 * Non-destructive: works in the active working buffer only.
 * Requires a compressor block placed in the active preset.
 *
 * Run: npx tsx scripts/_research/probe-cpr-calibration-verify.ts
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(
  process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js',
);
const PORT = 'axe-fx-ii';

function extractJson(callResult: unknown): Record<string, unknown> {
  const r = callResult as { content?: Array<{ type?: string; text?: string }> };
  const text = (r.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text!)
    .join('\n');
  return JSON.parse(text);
}

function decodeAsciiFromRaw(raw: number[]): string {
  const asciiStart = 18;
  const bytes = raw.slice(asciiStart);
  const nullIdx = bytes.indexOf(0);
  const textBytes = nullIdx >= 0 ? bytes.slice(0, nullIdx) : bytes;
  return String.fromCharCode(...textBytes).trim();
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` -- ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function main() {
  console.log('Connecting to MCP server...');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
  });
  const client = new Client({ name: 'cpr-verify', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  console.log('Connected.\n');

  try {
    // Place PEDAL COMP 1
    console.log('Setup: placing PEDAL COMP 1...');
    await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: PORT,
        spec: {
          name: 'CPR Verify',
          slots: [
            {
              slot: { row: 2, col: 1 },
              block_type: 'compressor',
              params: { effect_type: 'PEDAL COMP 1' },
            },
          ],
        },
      },
    });
    console.log('Preset placed.\n');

    // Test matrix: display value, expected device label pattern
    const tests: Array<{
      name: string;
      display: number;
      expectPattern: RegExp;
      description: string;
    }> = [
      // compressor.comp: 0..10 linear
      { name: 'comp', display: 0, expectPattern: /^0\.00/, description: 'comp min (0..10 linear)' },
      { name: 'comp', display: 5, expectPattern: /^5\.00/, description: 'comp mid' },
      { name: 'comp', display: 10, expectPattern: /^10\.0/, description: 'comp max' },
      { name: 'comp', display: 2.5, expectPattern: /^2\.50/, description: 'comp quarter' },
      { name: 'comp', display: 7.5, expectPattern: /^7\.50/, description: 'comp three-quarter' },

      // compressor.filter: 10..1000 Hz log10
      { name: 'filter', display: 10, expectPattern: /^10\.0.*Hz/, description: 'filter min (10..1000 Hz log10)' },
      { name: 'filter', display: 100, expectPattern: /^100\.?0?.*Hz/, description: 'filter geometric mid' },
      { name: 'filter', display: 1000, expectPattern: /^1000.*Hz/, description: 'filter max' },
      { name: 'filter', display: 31.62, expectPattern: /^31\.\d.*Hz/, description: 'filter quarter (sqrt(10*100))' },
      { name: 'filter', display: 316.2, expectPattern: /^316\.\d.*Hz/, description: 'filter three-quarter (sqrt(100*1000))' },

      // compressor.look_ahead: 0..2 ms linear
      { name: 'look_ahead', display: 0, expectPattern: /^0\.000.*ms/, description: 'look_ahead min (0..2 ms linear)' },
      { name: 'look_ahead', display: 1, expectPattern: /^1\.000.*ms/, description: 'look_ahead mid' },
      { name: 'look_ahead', display: 2, expectPattern: /^2\.000.*ms/, description: 'look_ahead max' },
      { name: 'look_ahead', display: 0.5, expectPattern: /^0\.500.*ms/, description: 'look_ahead quarter' },
      { name: 'look_ahead', display: 1.5, expectPattern: /^1\.500.*ms/, description: 'look_ahead three-quarter' },
    ];

    console.log('=== Calibration verification ===\n');
    for (const t of tests) {
      try {
        const setResult = await client.callTool({
          name: 'set_param',
          arguments: { port: PORT, block: 'compressor', name: t.name, value: t.display },
        });
        const setJson = extractJson(setResult);
        if (setJson['acked'] !== true) {
          check(t.description, false, `set_param not acked: ${JSON.stringify(setJson)}`);
          continue;
        }

        const getResult = await client.callTool({
          name: 'get_param',
          arguments: { port: PORT, block: 'compressor', name: t.name },
        });
        const getJson = extractJson(getResult);
        const rawResp = getJson['raw_response'] as number[] | undefined;
        const asciiLabel = rawResp ? decodeAsciiFromRaw(rawResp) : '(no raw)';
        const matches = t.expectPattern.test(asciiLabel);
        check(
          t.description,
          matches,
          `display=${t.display} -> device="${asciiLabel}" ${matches ? 'OK' : `EXPECTED ${t.expectPattern}`}`,
        );
      } catch (err) {
        check(t.description, false, `ERROR: ${err}`);
      }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
