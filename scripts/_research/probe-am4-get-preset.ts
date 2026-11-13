/**
 * One-shot harness: drive the unified `get_preset` tool against AM4 via
 * the MCP boundary. Validates the descriptor.reader.getPreset path that
 * landed 2026-05-22 alongside the atomic_read=true flip.
 *
 *   npx tsx scripts/_research/probe-am4-get-preset.ts
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/server-all/dist/server/index.js'],
  });
  const client = new Client({ name: 'probe', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);

  // Default mode (chunk-only, channel_state_omitted=true).
  const t0 = Date.now();
  const flat = await client.callTool({ name: 'get_preset', arguments: { port: 'am4' } });
  const flatMs = Date.now() - t0;

  // include_channel_state mode (chunk + per-block channel-selector read).
  const t1 = Date.now();
  const withChan = await client.callTool({ name: 'get_preset', arguments: { port: 'am4', include_channel_state: true } });
  const withChanMs = Date.now() - t1;

  await client.close();

  const flatText = (flat.content as any)[0].text;
  const chanText = (withChan.content as any)[0].text;

  console.log(`=== get_preset (default) — ${flatMs} ms ===`);
  console.log(flatText);
  console.log();
  console.log(`=== get_preset (include_channel_state=true) — ${withChanMs} ms ===`);
  console.log(chanText);
}

main().catch((err) => { console.error('FATAL:', err); process.exitCode = 1; });
