/**
 * Probe uncalibrated compressor knob params to discover display ranges.
 *
 * Reads comp, filter, and look_ahead via get_param (fn=0x02 GET) at
 * their current values, then writes extreme wire values (0, 32767,
 * 65534) via raw fn=0x02 SET and reads back the device-emitted label
 * to determine the display range and scale.
 *
 * Also verifies compressor.comp calibration (0..10 from AM4 sibling).
 *
 * Non-destructive to stored presets: writes only to the working buffer.
 * Requires a compressor block placed in the active preset.
 *
 * Run: npx tsx scripts/_research/probe-cpr-uncalibrated.ts
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

function extractText(callResult: unknown): string {
  const r = callResult as { content?: Array<{ type?: string; text?: string }> };
  return (r.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text!)
    .join('\n');
}

async function main() {
  console.log('Connecting to MCP server...');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
  });
  const client = new Client({ name: 'cpr-probe', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  console.log('Connected.\n');

  try {
    // Place a preset with PEDAL COMP 1 (the type the user reported issues with)
    console.log('=== Setup: place compressor as PEDAL COMP 1 ===');
    const applyResult = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: PORT,
        spec: {
          name: 'CPR Probe',
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
    console.log('apply_preset:', JSON.stringify(extractJson(applyResult), null, 2));

    // Target params to probe. These are the three CPR knobs without calibration.
    const targetParams = [
      { name: 'comp', paramId: 13, note: 'COMP_SUSTAIN / Pedal Comp specific' },
      { name: 'filter', paramId: 8, note: 'COMP_CONTOUR / sidechain filter' },
      { name: 'look_ahead', paramId: 15, note: 'COMP_DELAYTIME / look-ahead time' },
    ];

    // Also probe calibrated params as control group
    const controlParams = [
      { name: 'treshold', paramId: 0, note: 'calibrated: -80..0' },
      { name: 'ratio', paramId: 1, note: 'calibrated: 1..20 log10' },
    ];

    console.log('\n=== Phase 1: Read current values via get_param ===');
    for (const p of [...targetParams, ...controlParams]) {
      try {
        const result = await client.callTool({
          name: 'get_param',
          arguments: { port: PORT, block: 'compressor', name: p.name },
        });
        console.log(`  ${p.name} (${p.note}):`);
        console.log(`    ${extractText(result)}`);
      } catch (err) {
        console.log(`  ${p.name}: ERROR — ${err}`);
      }
    }

    // Phase 2: Write extreme wire values via set_param and read back.
    // For calibrated params, write display values at min/mid/max.
    // For uncalibrated params, write raw wire integers and read back
    // to see what display label the device returns.
    console.log('\n=== Phase 2: Write extreme values + readback ===');
    console.log('Writing raw wire values to uncalibrated params...\n');

    // Wire extremes: 0 (minimum), 32767 (midpoint), 65534 (maximum)
    const wireExtremes = [0, 16384, 32767, 49152, 65534];

    for (const p of targetParams) {
      console.log(`--- ${p.name} (${p.note}) ---`);
      for (const wire of wireExtremes) {
        try {
          // Write raw wire value
          const setResult = await client.callTool({
            name: 'set_param',
            arguments: { port: PORT, block: 'compressor', name: p.name, value: wire },
          });
          // Read back via get_param to see device's display label
          const getResult = await client.callTool({
            name: 'get_param',
            arguments: { port: PORT, block: 'compressor', name: p.name },
          });
          const getJson = extractJson(getResult);
          console.log(`  wire=${wire.toString().padStart(5)}: display=${JSON.stringify(getJson['value'])} raw_response=${JSON.stringify(getJson['raw_response'] ?? '(none)')}`);
        } catch (err) {
          console.log(`  wire=${wire.toString().padStart(5)}: ERROR — ${err}`);
        }
      }
      console.log();
    }

    // Phase 3: Verify compressor.comp calibration fix.
    // Write display values (0, 2.5, 5, 7.5, 10) and read back.
    console.log('=== Phase 3: Verify compressor.comp calibration (0..10) ===');
    const compDisplayValues = [0, 2.5, 5, 7.5, 10];
    for (const dv of compDisplayValues) {
      try {
        const setResult = await client.callTool({
          name: 'set_param',
          arguments: { port: PORT, block: 'compressor', name: 'comp', value: dv },
        });
        const setJson = extractJson(setResult);
        const getResult = await client.callTool({
          name: 'get_param',
          arguments: { port: PORT, block: 'compressor', name: 'comp' },
        });
        const getJson = extractJson(getResult);
        console.log(`  display=${dv.toString().padStart(4)}: acked=${setJson['acked']} readback=${JSON.stringify(getJson['value'])} raw=${JSON.stringify(getJson['raw_response'] ?? '(none)')}`);
      } catch (err) {
        console.log(`  display=${dv.toString().padStart(4)}: ERROR — ${err}`);
      }
    }

    // Phase 4: Try different compressor types and check if comp/filter/look_ahead
    // behavior changes with type.
    console.log('\n=== Phase 4: Type-dependent behavior check ===');
    const typesToTest = ['STUDIO COMP', 'OPTICAL 1', 'PEDAL COMP 2'];
    for (const compType of typesToTest) {
      console.log(`\n--- Switching to ${compType} ---`);
      try {
        await client.callTool({
          name: 'set_param',
          arguments: { port: PORT, block: 'compressor', name: 'effect_type', value: compType },
        });
        // Read comp, filter, look_ahead to see if available/different
        for (const p of targetParams) {
          const getResult = await client.callTool({
            name: 'get_param',
            arguments: { port: PORT, block: 'compressor', name: p.name },
          });
          const getJson = extractJson(getResult);
          console.log(`  ${p.name}: value=${JSON.stringify(getJson['value'])} raw=${JSON.stringify(getJson['raw_response'] ?? '(none)')}`);
        }
      } catch (err) {
        console.log(`  ERROR: ${err}`);
      }
    }

    console.log('\n=== Done ===');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
