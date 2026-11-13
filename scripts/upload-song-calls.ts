/**
 * Upload driver for ANY song map: issues the resolved `apply_pattern` calls a song-map script
 * wrote (e.g. `.git/<song>-calls.json`) against the BUILT MCP server over stdio, in slot
 * order.
 *
 * The authoring step is pure and offline; this is the only piece that touches hardware, split so a
 * re-author never implies a re-upload.
 *
 * SAFETY, in this order (docs/SAFE-EDIT-WORKFLOW.md, the multi-preset overwrite gate):
 *   1. PRE-FLIGHT READ of every target slot, one `get_preset` each. The pack directory listing can
 *      false-empty an occupied slot, so per-slot reads are the truth. A slot is writable only if it
 *      is EMPTY, or already holds the SAME project name this map authors there (a re-author of our
 *      own earlier upload). Anything else stops the whole run before a single write, naming what is
 *      there. `--allow-overwrite 31,32` is the explicit, per-slot owner override.
 *   2. WRITE, one retry on a transient failure ("pool listing did not complete" is a retry, not a
 *      content fault).
 *   3. READ BACK every slot: the stored name must match, and pattern occupancy must not run PAST the
 *      authored chain (the dirty-template tell). A pattern INSIDE the chain that reads unoccupied is a
 *      deliberately silent pattern (an all-rest lane stores nothing), not a fault.
 *
 * Requires: `npm run build` (the server runs from dist/, not src/), the device connected, and no
 * other MCP session holding the port.
 *
 * Run: npx tsx scripts/upload-song-calls.ts --calls .git/<song>-calls.json [--check] [--only 33]
 *        [--from 31] [--dry] [--verify-only] [--allow-overwrite 31,32] [--port "Circuit Tracks"]
 *   --check        pre-flight read only: report what each target slot holds, write nothing
 *   --dry          send every call with dry_run:true (the tool validates, nothing is stored)
 *   --verify-only  read every target slot back and check it, write nothing
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const SERVER = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

interface Call { tool: string; args: Record<string, unknown> }

const argVal = (f: string): string | undefined => {
  const i = process.argv.indexOf(f);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const callsPath = argVal('--calls');
if (callsPath === undefined) {
  console.error('usage: npx tsx scripts/upload-song-calls.ts --calls .git/<song>-calls.json [--check] [--dry] [--verify-only] [--only N] [--from N] [--allow-overwrite N,M]');
  process.exit(1);
}
const PORT = argVal('--port') ?? 'Circuit Tracks';
const only = argVal('--only') !== undefined ? Number(argVal('--only')) : undefined;
const from = argVal('--from') !== undefined ? Number(argVal('--from')) : undefined;
const allowOverwrite = new Set((argVal('--allow-overwrite') ?? '').split(',').filter(Boolean).map(Number));
const check = process.argv.includes('--check');
const dry = process.argv.includes('--dry');
const verifyOnly = process.argv.includes('--verify-only');

function ext(r: unknown): string {
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c?.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
const isError = (r: unknown): boolean => !!(r as { isError?: boolean })?.isError;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SlotRead { empty: boolean; name: string; occupied: number[]; raw: string; error?: string }

async function readSlot(c: Client, pack: number, slot: number): Promise<SlotRead> {
  const rb = await c.callTool({ name: 'get_preset', arguments: { port: PORT, pack, location: slot } });
  const txt = ext(rb);
  if (isError(rb)) return { empty: false, name: '', occupied: [], raw: txt, error: txt.slice(0, 300) };
  try {
    const j = JSON.parse(txt) as { pattern_occupancy?: { occupied?: number[] }; name?: string; read_warnings?: string[] };
    const name = j.name ?? '';
    const empty = /^\(empty Project/.test(name) || (j.read_warnings ?? []).some((w) => /it is empty/.test(w));
    return { empty, name: empty ? '' : name, occupied: j.pattern_occupancy?.occupied ?? [], raw: txt };
  } catch {
    return { empty: false, name: '', occupied: [], raw: txt, error: `unparseable read: ${txt.slice(0, 200)}` };
  }
}

async function main(): Promise<void> {
  const all = JSON.parse(readFileSync(path.resolve(process.cwd(), callsPath!), 'utf8')) as Call[];
  const calls = all
    .filter((c) => c.tool === 'apply_pattern')
    .filter((c) => (only === undefined ? true : c.args.ncs_slot === only))
    .filter((c) => (from === undefined ? true : (c.args.ncs_slot as number) >= from))
    .sort((a, b) => (a.args.ncs_slot as number) - (b.args.ncs_slot as number));
  if (calls.length === 0) { console.log('no apply_pattern calls selected'); return; }
  const packs = new Set(calls.map((c) => c.args.pack as number));
  if (packs.size !== 1) throw new Error(`calls span several packs (${[...packs].join(', ')}); upload one pack at a time`);
  const pack = [...packs][0];
  const mode = check ? 'PRE-FLIGHT CHECK (no writes)' : verifyOnly ? 'VERIFY ONLY (no writes)' : dry ? 'DRY RUN' : 'WRITE';
  console.log(`${path.basename(callsPath!)} -> ${PORT} Pack ${pack}: ${calls.length} project(s), slots ${calls.map((c) => c.args.ncs_slot).join(', ')} [${mode}]\n`);

  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe' });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => { const s = b.toString(); if (/error|refus|fail/i.test(s)) process.stderr.write(`[server] ${s}`); });
  const c = new Client({ name: 'song-upload', version: '1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  await c.connect(t);

  const failures: string[] = [];
  try {
    // ── 1. pre-flight: every target slot, before any write ──
    if (!verifyOnly) {
      const blocked: string[] = [];
      for (const call of calls) {
        const slot = call.args.ncs_slot as number;
        const want = call.args.project_name as string;
        const r = await readSlot(c, pack, slot);
        const verdict = r.error !== undefined ? `UNKNOWN (${r.error})`
          : r.empty ? 'empty'
          : r.name === want ? `holds "${r.name}" (this map's own project: re-author)`
          : allowOverwrite.has(slot) ? `holds "${r.name}" (OVERWRITE allowed by --allow-overwrite)`
          : `holds "${r.name}"`;
        console.log(`  P${slot}: ${verdict}`);
        if (r.error !== undefined || (!r.empty && r.name !== want && !allowOverwrite.has(slot))) blocked.push(`P${slot} ${verdict}`);
      }
      if (blocked.length > 0) {
        console.log(`\nSTOPPED before any write: ${blocked.length} target slot(s) are not safe to write:`);
        for (const b of blocked) console.log(`  - ${b}`);
        console.log('Pick empty slots in the map, or pass --allow-overwrite with the slots the owner approved.');
        process.exitCode = 1;
        return;
      }
      console.log('\npre-flight: every target slot is writable.\n');
      if (check) return;
    }

    // ── 2. write, 3. read back ──
    let ok = 0;
    for (const call of calls) {
      const slot = call.args.ncs_slot as number;
      const name = call.args.project_name as string;
      const nPat = ((call.args.arrangement as { sections?: unknown[] } | undefined)?.sections?.length) ?? 1;
      process.stdout.write(`P${slot} "${name}" (${nPat} pat) … `);

      if (!verifyOnly) {
        const args = { ...call.args, port: PORT, ...(dry ? { dry_run: true } : {}) };
        let res = await c.callTool({ name: 'apply_pattern', arguments: args });
        if (isError(res)) {
          process.stdout.write('retry … ');
          await sleep(2000);
          res = await c.callTool({ name: 'apply_pattern', arguments: args });
        }
        if (isError(res)) {
          console.log('FAILED');
          console.log(`     ${ext(res).slice(0, 400)}`);
          failures.push(`P${slot} write: ${ext(res).slice(0, 160)}`);
          continue;
        }
        if (dry) { console.log('dry ok'); ok++; continue; }
      }

      const r = await readSlot(c, pack, slot);
      if (r.error !== undefined || r.empty) {
        console.log(`READ-BACK ${r.empty ? 'EMPTY' : 'FAILED'}`);
        failures.push(`P${slot} read-back: ${r.error ?? 'slot reads empty after the write'}`);
        continue;
      }
      if (r.name !== name) failures.push(`P${slot} name reads "${r.name}", authored "${name}"`);
      const beyond = r.occupied.filter((p) => p > nPat);
      const silent = Array.from({ length: nPat }, (_, i) => i + 1).filter((p) => !r.occupied.includes(p));
      if (beyond.length > 0) {
        console.log(`BLED  occupancy [${r.occupied.join(',')}] has pattern(s) ${beyond.join(',')} past the ${nPat} authored`);
        failures.push(`P${slot} template bleed: patterns ${beyond.join(',')} not authored`);
      } else {
        console.log(`ok  chain 1-${nPat}${silent.length > 0 ? `, silent by design: ${silent.join(',')}` : ''}`);
      }
      ok++;
    }
    console.log(`\n${ok}/${calls.length} ${verifyOnly ? 'verified' : dry ? 'dry-run ok' : 'written'}.`);
  } finally {
    await c.close().catch(() => {});
  }

  if (failures.length > 0) { console.log('ISSUES:'); for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
  else if (!check && !dry) console.log('All slots verified: stored name matches and occupancy stays inside the authored chain on every project.');
  if (!check && !dry && !verifyOnly) {
    console.log('\nNOTE: the pack manifest flushes ~6-8 s after the session closes. A directory listing taken sooner can');
    console.log('report a good write as missing; per-slot reads are the truth.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
