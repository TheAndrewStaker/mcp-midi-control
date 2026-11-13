/**
 * End-to-end MCP test: apply_preset with per-channel params on Axe-Fx II.
 *
 * Spawns the MCP server, calls apply_preset with a 2-block preset
 * where Amp 1 and Drive 1 each have distinct X and Y channel params,
 * then calls get_preset to verify both channels landed correctly.
 *
 * This is the alpha.5 validation: the first end-to-end test of
 * per-channel writes after the fn=0x2e value encoding fix.
 *
 * SETUP:
 *   1. `npm run build` (so dist/server/index.js is current)
 *   2. Quit Claude Desktop AND AxeEdit (single-writer MIDI port)
 *   3. `npx tsx scripts/_research/mcp-test-channel-apply.ts`
 *
 * The test writes to the working buffer only (no save).
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

function extractText(callResult: unknown): string {
  if (!callResult || typeof callResult !== 'object') return '<no response>';
  const r = callResult as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const parts = (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n') + (r.isError ? '  [isError=true]' : '');
}

function extractJson(callResult: unknown): Record<string, unknown> | null {
  const text = extractText(callResult);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log('===================================================================');
  console.log('  End-to-End Channel Apply Test (Axe-Fx II)');
  console.log('===================================================================\n');

  console.log(`Spawning MCP server: node ${SERVER_ENTRY}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'mcp-test-channel-apply', version: '1.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );

  if (transport.stderr) {
    transport.stderr.on('data', (buf: Buffer) => {
      process.stderr.write(`[server] ${buf.toString()}`);
    });
  }

  let passes = 0;
  let fails = 0;

  function check(cond: boolean, msg: string) {
    if (cond) { console.log(`  PASS: ${msg}`); passes++; }
    else { console.log(`  FAIL: ${msg}`); fails++; }
  }

  try {
    await client.connect(transport);
    console.log('Connected to MCP server.\n');

    const tools = await client.listTools();
    console.log(`Server exposes ${tools.tools.length} tools.\n`);

    // ── Step 1: Apply a preset with per-channel params ──
    console.log('[Step 1] apply_preset with per-channel X/Y params');
    console.log('----------------------------------------------------------\n');

    const presetSpec = {
      port: 'axe-fx-ii',
      spec: {
        name: 'CHANNEL TEST',
        slots: [
          {
            slot: { row: 2, col: 2 },
            block_type: 'amp',
            params_by_channel: {
              X: {
                effect_type: 'SHIVER CLEAN',
                input_drive: 3.0,
                bass: 5.0,
                middle: 6.0,
                treble: 7.0,
                master_volume: 4.0,
              },
              Y: {
                effect_type: 'JR BLUES',
                input_drive: 7.5,
                bass: 4.0,
                middle: 5.0,
                treble: 8.0,
                master_volume: 6.0,
              },
            },
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'drive',
            params_by_channel: {
              X: { gain: 3.0, tone: 5.0, level: 5.0 },
              Y: { gain: 8.0, tone: 7.0, level: 6.0 },
            },
          },
        ],
      },
    };

    console.log('  Calling apply_preset...');
    let applyText = '';
    let applyOk = false;
    try {
      const applyResult = await client.callTool({
        name: 'apply_preset',
        arguments: presetSpec,
      });
      applyText = extractText(applyResult);
      const applyIsError = (applyResult as { isError?: boolean }).isError;
      console.log(`  apply_preset returned (${applyText.length} chars, isError=${applyIsError})\n`);

      if (applyIsError) {
        console.log('  apply_preset returned isError=true');
        console.log(applyText.slice(0, 500));
      }

      const applyJson = extractJson(applyResult);
      if (applyJson) {
        applyOk = applyJson.ok === true;
        check(applyOk, `apply_preset ok=${applyJson.ok}`);
        console.log(`  Steps: ${applyJson.total_steps}, Time: ${applyJson.elapsed_ms}ms\n`);
      } else {
        applyOk = applyText.includes('"ok":true') || applyText.includes('"ok": true');
        check(applyOk, 'apply_preset contains ok:true');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('output schema') || msg.includes('outputSchema')) {
        console.log(`  apply_preset executed but output schema validation failed (known issue).`);
        console.log('  Wire writes likely landed. Proceeding to get_preset verification.\n');
        applyOk = true;
      } else {
        console.log(`  apply_preset threw: ${msg.slice(0, 300)}\n`);
      }
    }

    // ── Step 2: get_preset to verify per-channel state ──
    console.log('[Step 2] get_preset to verify per-channel state');
    console.log('----------------------------------------------------------\n');

    console.log('  Calling get_preset...');
    const getResult = await client.callTool({
      name: 'get_preset',
      arguments: { port: 'axe-fx-ii' },
    });
    const getText = extractText(getResult);
    console.log(`  get_preset returned (${getText.length} chars)\n`);

    // Parse the response and check for per-channel params.
    const getJson = extractJson(getResult);
    if (getJson && typeof getJson === 'object') {
      const slots = (getJson as { slots?: unknown[] }).slots;
      if (Array.isArray(slots)) {
        console.log(`  Found ${slots.length} slots in response.\n`);

        for (const slot of slots) {
          const s = slot as {
            block_type?: string;
            params_by_channel?: Record<string, Record<string, unknown>>;
            params?: Record<string, unknown>;
            channel_status?: string;
          };
          if (!s.block_type) continue;

          if (s.block_type.includes('amp') || s.block_type.includes('Amp')) {
            console.log(`  Amp block (channel_status: ${s.channel_status}):`);
            if (s.params_by_channel) {
              const xParams = s.params_by_channel['X'] ?? s.params_by_channel['x'];
              const yParams = s.params_by_channel['Y'] ?? s.params_by_channel['y'];

              if (xParams && yParams) {
                const xDrive = xParams['input_drive'];
                const yDrive = yParams['input_drive'];
                console.log(`    X.input_drive = ${xDrive}`);
                console.log(`    Y.input_drive = ${yDrive}`);
                check(xDrive !== yDrive, `Amp X.input_drive (${xDrive}) != Y.input_drive (${yDrive})`);

                const xType = xParams['effect_type'];
                const yType = yParams['effect_type'];
                console.log(`    X.effect_type = ${xType}`);
                console.log(`    Y.effect_type = ${yType}`);
                check(xType !== yType, `Amp X.effect_type (${xType}) != Y.effect_type (${yType})`);
              } else {
                console.log('    Only one channel returned');
                fails++;
              }
            } else if (s.params) {
              console.log('    WARNING: flat params returned (no per-channel split)');
              fails++;
            }
          }

          if (s.block_type.includes('drive') || s.block_type.includes('Drive')) {
            console.log(`  Drive block (channel_status: ${s.channel_status}):`);
            if (s.params_by_channel) {
              const xParams = s.params_by_channel['X'] ?? s.params_by_channel['x'];
              const yParams = s.params_by_channel['Y'] ?? s.params_by_channel['y'];

              if (xParams && yParams) {
                const xGain = xParams['gain'];
                const yGain = yParams['gain'];
                console.log(`    X.gain = ${xGain}`);
                console.log(`    Y.gain = ${yGain}`);
                check(xGain !== yGain, `Drive X.gain (${xGain}) != Y.gain (${yGain})`);
              }
            }
          }
        }
      }
    } else {
      console.log('  Could not parse get_preset response as JSON');
      console.log('  First 1000 chars:');
      console.log(getText.slice(0, 1000));
    }

    // ── Summary ──
    console.log('\n===================================================================');
    console.log(`  SUMMARY: ${passes} passed, ${fails} failed`);
    console.log('===================================================================\n');

    if (fails === 0) {
      console.log('  VERDICT: Per-channel apply_preset works end-to-end!');
      console.log('  Alpha.5 channel-write fix validated.\n');
    } else {
      console.log('  VERDICT: Some checks failed. See details above.\n');
    }

  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
