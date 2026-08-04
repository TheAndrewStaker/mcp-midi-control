/**
 * binding-upload.ts — DEVICE WRITE. Upload the staged drum-binding corrections.
 *
 * Drives the MCP server over stdio (one connection, strictly sequential calls, so
 * the Circuit's file-transfer session is never interleaved). Each upload runs with
 * confirm_overwrite: true and backup_first: true, so every clobbered project is
 * saved to ~/mcp-midi-backups first and is individually restorable.
 *
 * Reads samples/circuit-ncs/bindings-2026-07-30/manifest.json (written by
 * binding-stage.ts) and uploads the matching staged file to its (pack, slot).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const SERVER = path.resolve(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const BASE = path.resolve(ROOT, 'samples/circuit-ncs/bindings-2026-07-30');

interface Entry { key: string; pack: number; slot: number; name: string; staged: string; before: number[] }

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter(x => x.type === 'text' && typeof x.text === 'string').map(x => x.text!).join('\n');
}

async function main(): Promise<void> {
  const manifest: Entry[] = JSON.parse(readFileSync(path.join(BASE, 'manifest.json'), 'utf8'));
  console.log(`Uploading ${manifest.length} staged projects.\n`);

  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'binding-upload', version: '1' }, { capabilities: {} });
  await c.connect(t);

  let ok = 0;
  const failures: string[] = [];
  try {
    for (const e of manifest) {
      const file = path.join(BASE, 'staged', e.staged);
      const started = Date.now();
      let text = '';
      try {
        const r = await c.callTool({
          name: 'upload_project',
          arguments: {
            port: 'circuit',
            file,
            pack: e.pack,
            slot: e.slot,
            confirm_overwrite: true,
            backup_first: true,
          },
        }, undefined, { timeout: 120000 });
        text = ext(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${e.key} "${e.name}": THREW ${msg}`);
        console.log(`  ${e.key} "${e.name}"  FAILED (threw): ${msg}`);
        continue;
      }
      const elapsed = Date.now() - started;
      let parsed: { ok?: boolean; backup?: unknown; error?: string } = {};
      try { parsed = JSON.parse(text); } catch { /* non-JSON receipt */ }
      if (parsed.ok === false || parsed.error) {
        failures.push(`${e.key} "${e.name}": ${text.slice(0, 300)}`);
        console.log(`  ${e.key} "${e.name}"  FAILED: ${text.slice(0, 200)}`);
      } else {
        ok++;
        console.log(`  ${e.key} "${e.name}"  ok  [${e.before.join(',')}] -> [1,2,5,11]  ${elapsed}ms`);
      }
    }
  } finally {
    await c.close();
  }

  console.log(`\n=== ${ok}/${manifest.length} uploaded ok, ${failures.length} failed ===`);
  for (const f of failures) console.log('  FAIL ' + f);
  if (failures.length > 0) process.exit(1);
}

main().catch(err => { console.error(`upload driver failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
