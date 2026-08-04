/**
 * OFFERING scene-chain RE-APPLICATION — DEVICE EXECUTION.
 *
 * Uploads the three offline-staged projects (offering-scene-stage.ts) that carry
 * the re-applied 4-scene chain on BOTH the midi2 note leg and the internal drum
 * leg, with the stale plain-chain ranges cleared on every track that got a scene
 * table.
 *
 * Phases (CLI arg):
 *   gate    - ports / packs / pack-5 occupancy / ORACLE IDENTITY GATE: download
 *             Projects 57-63 and byte-compare all seven against the newest
 *             canonical (offering-authored-2026-07-31). Any diff = STOP.
 *   write   - 3 upload_project writes of the staged .ncs, confirm_overwrite:true
 *             (identity-gated above), backup_first left at its default true.
 *             10 s settle after the last write.
 *   backup  - post-write sweep of 57-63 (3 targets + 4 untouched witnesses).
 *   scan    - final scan_locations pack 5 x2 with a settle between.
 *
 * Receipts land in samples/_scratch/offering-scene-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/offering-scene-exec.ts <phase>
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const SERVER = path.resolve(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'circuit-tracks';
const PACK = 5;
export const TARGETS = [57, 60, 61];
/** Untouched witnesses, INTERLEAVED with the targets: the other four Offering projects. */
export const WITNESSES = [58, 59, 62, 63];
const BAND: [number, number] = [57, 63];
const CANON = `${ROOT}/samples/circuit-ncs/offering-authored-2026-07-31`;
const STAGED_DIR = `${ROOT}/samples/_scratch/offering-scene-staged`;
const PRE_DIR = 'samples/circuit-ncs/offering-scenefix-preauthor-2026-07-31';
const POST_DIR = 'samples/circuit-ncs/offering-scenefix-authored-2026-07-31';

/** Pack 5 occupancy premise, as the 2026-07-30/31 campaign left it. */
const PREMISE_OCCUPIED = [
  1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 14, 15, 16, 17,
  19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 36, 37, 38, 39, 46, 47, 48, 49, 50, 51, 52, 53,
  57, 58, 59, 60, 61, 62, 63,
];

const phase = process.argv[2];
if (!phase) { console.error('usage: offering-scene-exec.ts <gate|write|backup|scan>'); process.exit(2); }

interface LogEntry { step: string; ok: boolean; isError: boolean; text: string }
const log: LogEntry[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ext = (r: unknown): string => {
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c?.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
};
const isErr = (r: unknown): boolean => (r as { isError?: boolean })?.isError === true;

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);

const loadDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return m; }
  for (const f of files.filter((x) => x.endsWith('.ncs'))) {
    const mm = /pack5-project0*(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(path.join(dir, f)));
  }
  return m;
};

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: ROOT });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'offering-scene-exec', version: '1' }, { capabilities: {} });
  await c.connect(t);
  const call = async (step: string, name: string, args: Record<string, unknown>, timeout = 60_000): Promise<{ err: boolean; text: string }> => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout });
    const text = ext(r);
    const err = isErr(r);
    log.push({ step, ok: !err, isError: err, text });
    return { err, text };
  };

  try {
    if (phase === 'gate') {
      const ports = await call('list_midi_ports', 'list_midi_ports', { pattern: ['circuit', 'novation'] });
      if (!ports.err && /circuit/i.test(ports.text)) ok('Circuit visible in MIDI ports');
      else fail(`Circuit not visible: ${ports.text.slice(0, 300)}`);
      const packs = await call('list_packs', 'list_packs', { port: PORT });
      if (!packs.err) ok('list_packs answered');
      else fail(`list_packs: ${packs.text.slice(0, 400)}`);

      const s5 = await call('scan-pack5', 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 180_000);
      if (s5.err) fail(`pack5 scan error: ${s5.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => Number(x.location)).sort((a, b) => a - b);
        if (JSON.stringify(occ) === JSON.stringify(PREMISE_OCCUPIED)) ok(`pack5 occupancy EXACT per the campaign premise (${occ.length} occupied)`);
        else fail(`PACK 5 OCCUPANCY MOVED (got [${occ.join(',')}]) — STOP`);
      }

      const gate = await call('backup-pre-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: BAND[0], to: BAND[1], pack: PACK, directory: PRE_DIR,
      }, 60_000);
      if (gate.err) console.log(`duration gate (expected, campaign standing authorization): ${gate.text.slice(0, 180).replace(/\n/g, ' ')}`);
      const swp = await call('backup-pre-sweep', 'backup_device', {
        port: PORT, scope: 'stored', from: BAND[0], to: BAND[1], pack: PACK,
        directory: PRE_DIR, acknowledge_duration: true,
      }, 600_000);
      if (swp.err) { fail(`pre sweep ERROR: ${swp.text.slice(0, 400)}`); return; }

      const pre = loadDir(`${ROOT}/${PRE_DIR}`);
      const canon = loadDir(CANON);
      let identical = 0;
      const all = [...TARGETS, ...WITNESSES].sort((a, b) => a - b);
      for (const slot of all) {
        const a = pre.get(slot); const b = canon.get(slot);
        if (b === undefined) { fail(`no canonical capture for slot ${slot}`); continue; }
        if (a !== undefined && a.equals(b)) { identical++; continue; }
        fail(`ORACLE IDENTITY GATE: slot ${slot} ${a === undefined ? 'not captured' : 'DIFFERS from the newest canonical'} — THE CARD MOVED, STOP`);
      }
      if (identical === all.length) ok(`ORACLE IDENTITY GATE: all ${identical} slots (3 targets + 4 witnesses) byte-identical to offering-authored-2026-07-31`);
    } else if (phase === 'write') {
      // Only upload files that the staging pass actually produced, and re-assert
      // their size here (the transport sends verbatim).
      for (const slot of TARGETS) {
        const file = path.join(STAGED_DIR, `pack5-project${slot}.ncs`);
        const bytes = readFileSync(file);
        if (bytes.length !== 160_780) { fail(`staged slot ${slot} is ${bytes.length} bytes — STOP`); break; }
        const t0 = Date.now();
        const r = await call(`write-${slot}`, 'upload_project', {
          port: PORT, file: path.relative(ROOT, file).replace(/\\/g, '/'),
          slot, pack: PACK, confirm_overwrite: true,
        }, 300_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) { fail(`slot ${slot} WRITE ERROR (${secs} s): ${r.text.slice(0, 700)}`); console.log('ABORTING remaining writes.'); break; }
        const acked = /acked|uploaded|complete/i.test(r.text);
        const backed = /backup/i.test(r.text);
        if (acked) ok(`slot ${slot} uploaded (${secs} s)${backed ? ', pre-write backup taken' : ''}`);
        else fail(`slot ${slot} receipt unclear: ${r.text.slice(0, 500)}`);
      }
      console.log('settling 10 s after the final write...');
      await sleep(10_000);
    } else if (phase === 'backup') {
      const gate = await call('backup-post-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: BAND[0], to: BAND[1], pack: PACK, directory: POST_DIR,
      }, 60_000);
      if (gate.err) console.log(`duration gate (expected): ${gate.text.slice(0, 180).replace(/\n/g, ' ')}`);
      const swp = await call('backup-post-sweep', 'backup_device', {
        port: PORT, scope: 'stored', from: BAND[0], to: BAND[1], pack: PACK,
        directory: POST_DIR, acknowledge_duration: true,
      }, 600_000);
      if (swp.err) fail(`post sweep ERROR: ${swp.text.slice(0, 400)}`);
      else ok(`post-write sweep ${BAND[0]}-${BAND[1]} captured`);
    } else if (phase === 'scan') {
      let firstSig = '';
      for (let i = 1; i <= 2; i++) {
        const s5 = await call(`scan-final-${i}`, 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 180_000);
        if (s5.err) { fail(`final scan ${i} error: ${s5.text.slice(0, 300)}`); continue; }
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => [Number(x.location), x.name ?? ''] as const);
        const sig = JSON.stringify(occ);
        const slots = occ.map(([l]) => l).sort((a, b) => a - b);
        if (JSON.stringify(slots) === JSON.stringify(PREMISE_OCCUPIED)) ok(`final scan ${i}: occupancy unchanged (${slots.length} occupied)`);
        else fail(`final scan ${i} occupancy CHANGED: [${slots.join(',')}]`);
        console.log(`  offering names: ${occ.filter(([l]) => l >= 57 && l <= 63).map(([l, n]) => `${l}:${n}`).join(', ')}`);
        if (i === 1) { firstSig = sig; console.log('settling 10 s...'); await sleep(10_000); }
        else if (sig === firstSig) ok('the two final scans AGREE exactly');
        else fail('the two final scans DISAGREE — re-read after a settle');
      }
    } else {
      console.error(`unknown phase "${phase}"`);
      process.exitCode = 2;
      return;
    }
  } finally {
    writeFileSync(`${ROOT}/samples/_scratch/offering-scene-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
