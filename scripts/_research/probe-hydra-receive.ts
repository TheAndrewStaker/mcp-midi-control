/**
 * One-off receive-path probe for the Hydrasynth @julusian/midi fix.
 *
 * Spawns the freshly-built dist server over stdio (real @julusian
 * transport, with the ignoreTypes-after-openPort reorder) and calls
 * init_patch on a connected Hydrasynth. init_patch surfaces an explicit
 * inbound-MIDI diagnostic block (Header Response 19 00 / Chunk Acks
 * 17 00 NN 16 / Footer 1B 00). Those acks are exactly the inbound SysEx
 * the ignoreTypes flag governs:
 *   - fix WORKS  -> acks observed (Header ✓, Chunk Acks 22/22, Footer ✓)
 *   - bug PRESENT -> "device is fully silent on the MIDI input" (0 acks)
 *
 * RAM-only (no flash burn); loads INIT into scratch slot H128.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

function textOf(r: unknown): string {
  const content = (r as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

async function main(): Promise<void> {
  console.log(`server: ${SERVER_ENTRY}\n`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  }
  const client = new Client({ name: 'hydra-receive-probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const ports = await client.callTool({ name: 'list_midi_ports', arguments: { pattern: 'hydra' } });
  const portsText = textOf(ports);
  console.log('── list_midi_ports ──\n' + portsText + '\n');
  if (!/hydra/i.test(portsText)) {
    console.log('Hydrasynth not visible — aborting (connect it and retry).');
    await client.close();
    return;
  }

  const desc = await client.callTool({ name: 'describe_device', arguments: { port: 'hydrasynth' } });
  console.log('── describe_device(hydrasynth) ──\n  isError=' + (desc as { isError?: boolean }).isError + '\n');

  console.log('── init_patch(hydrasynth) — watch the inbound diagnostic block ──');
  const init = await client.callTool({ name: 'init_patch', arguments: {} });
  console.log(textOf(init));

  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
