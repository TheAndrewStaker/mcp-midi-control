/**
 * Bench: arbiter Phase A (R2 handle-health) self-heal across a replug,
 * in ONE persistent server process.
 *
 *   call 1  -> opens + CACHES the MIDI handle in the server child
 *   (founder unplugs + replugs the Circuit while this process stays alive)
 *   call 2  -> the cached handle is now STALE; the acquire-time canary in
 *              ensureConnection should self-heal it and succeed on THIS
 *              first post-replug call (pre-fix: it would fail, needing a
 *              second try or manual reconnect_midi).
 *
 * Interactive (readline-gated) per the probe design rule: the founder
 * observes/acts, we wait for Enter, never a timer.
 */
import readline from 'node:readline';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve('C:/dev/mcp-midi-tools', 'packages', 'server-all', 'dist', 'server', 'index.js');

function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  const c = new Client({ name: 'bench-circuit-selfheal', version: '1' }, { capabilities: {} });
  await c.connect(t);
  const summarize = (label: string, text: string) => {
    let p: { occupied?: number; total?: number } = {};
    try { p = JSON.parse(text); } catch { console.log(`${label}: NON-JSON: ${text.slice(0, 160)}`); return false; }
    const ok = (p.occupied ?? 0) > 0;
    console.log(`${label}: occupied=${p.occupied}/${p.total} -> ${ok ? 'OK' : 'EMPTY/FAIL'}`);
    return ok;
  };
  try {
    const start1 = Date.now();
    const r1 = ext(await c.callTool({ name: 'list_samples', arguments: { port: 'circuit' } }));
    summarize(`call 1 (handle now cached, ${Date.now() - start1}ms)`, r1);

    await ask('\n>>> Now UNPLUG the Circuit USB, wait ~3s, PLUG it back in, then press Enter <<< ');

    const start2 = Date.now();
    let r2 = '';
    try {
      r2 = ext(await c.callTool({ name: 'list_samples', arguments: { port: 'circuit' } }));
    } catch (e) {
      console.log(`call 2 THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
    const healed = summarize(`call 2 (first post-replug, ${Date.now() - start2}ms)`, r2);
    console.log(`\nSELF-HEAL ${healed ? 'CONFIRMED: first post-replug call succeeded on the stale cached handle.' : 'NOT observed: first call did not recover (report this).'}`);
  } finally {
    rl.close();
    await c.close();
  }
}

main().catch((err) => { console.error(`bench failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
