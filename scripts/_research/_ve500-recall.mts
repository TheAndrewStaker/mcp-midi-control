// One-shot: exercise the just-built VE-500 user-memory recall (register write) against hardware.
// The session's live MCP server runs a stale dist, so this spawns the fresh build.
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = path.resolve('C:/dev/mcp-midi-tools', 'packages', 'server-all', 'dist', 'server', 'index.js');
const client = new Client({ name: 've500-recall-probe', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
const text = (r: unknown): string =>
  ((r as { content?: Array<{ type?: string; text?: string }> }).content ?? [])
    .filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const loc = process.argv[2] ?? 'U95';
console.log(`--- switch_preset ${loc} ---`);
const r = await client.callTool({ name: 'switch_preset', arguments: { port: 've-500', location: loc } });
console.log(`isError=${String((r as { isError?: boolean }).isError)}`);
console.log(text(r).slice(0, 900));
await client.close();
