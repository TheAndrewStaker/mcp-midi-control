/**
 * Love Song device-window driver (plan §4 Phases 0.3/0.4/1/2/4, Pack 4
 * slots 25-29). Drives the PRODUCT MCP server (packages/server-all/dist)
 * over StdioClientTransport — the sanctioned "drive MCP tools yourself"
 * pattern — so the arrangement payloads flow from lovesong-staged.json
 * without a chat-context copy, and ONE process holds the Circuit port per
 * run. Mirror of smooth-exec.ts; no seed phase (pool works as-is, plan §0g).
 *
 * Phases (CLI arg):
 *   dryrun  - arg-liveness probe (33-char name refusal) + 5 apply_pattern
 *             dry-runs with receipt checks. No device contact.
 *   phase1  - list_midi_ports / list_packs / scan pack4 / list_samples
 *             pack4. STOPS unless pack4 == premise (strays 1-2, Smooth
 *             9-21, 22-64 empty; pool 1/2/5/11 seeded kit + 39 stray).
 *   write   - 5 apply_pattern ncs_upload writes slots 25-29 (NO
 *             confirm_overwrite: every target scanned empty; a refusal =
 *             the card moved = ABORT). Settle 10 s after the 5th.
 *   backup  - backup_device sweeps: 25-29 pack4 (duration gate acknowledged
 *             after printing the estimate), pack4 neighbours 1-2 + 21,
 *             pack2 neighbour 57 (cross-pack identity).
 *   scan    - final scan_locations pack4 x2 with a 10 s settle between.
 *
 * Full receipts land in samples/_scratch/lovesong-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/lovesong-exec.ts <phase>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const SERVER = path.resolve(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'circuit-tracks';
const PACK = 4;
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const BINDING = [1, 2, 5, 11];  // the seeded After Dark layout (plan §0g: works as-is)
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/lovesong-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; order: string[];
  sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
}>;

const phase = process.argv[2];
if (!phase) { console.error('usage: lovesong-exec.ts <dryrun|phase1|write|backup|scan>'); process.exit(2); }

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

function applyArgs(slot: number): Record<string, unknown> {
  const st = STAGED.find((s) => s.slot === slot)!;
  return {
    port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: slot,
    ncs_template: TEMPLATE,
    project_name: st.project_name, colour: 'Teal', bpm: 69,
    mixer_levels: { synth1: 0, synth2: 0 },
    condense_drums: true, drum_binding: BINDING,
    external_targets: [{ device: 'spd-sx', track: 'midi2', note_offset: 12 }],
    arrangement: { sections: st.sections, order: st.order },
  };
}

async function main(): Promise<void> {
  const t = new StdioClientTransport({
    command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: ROOT,
  });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'lovesong-exec', version: '1' }, { capabilities: {} });
  await c.connect(t);
  const call = async (step: string, name: string, args: Record<string, unknown>, timeout = 60_000): Promise<{ err: boolean; text: string }> => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout });
    const text = ext(r);
    const err = isErr(r);
    log.push({ step, ok: !err, isError: err, text });
    return { err, text };
  };

  try {
    if (phase === 'dryrun') {
      // arg-liveness (the Schism silent-strip guard), through THIS server spawn.
      const probe = await call('arg-liveness', 'apply_pattern', {
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 25, ncs_template: TEMPLATE,
        project_name: 'LoveSongArgLivenessProbe01234567X', bpm: 69, dry_run: true,
        voices: { kick: 'x...x...x...x...' },
      });
      if (probe.err && probe.text.includes('32')) ok('arg-liveness: 33-char name refused naming the 32 limit');
      else fail(`arg-liveness probe: err=${probe.err} text=${probe.text.slice(0, 200)}`);

      for (const st of STAGED) {
        const r = await call(`dryrun-${st.slot}`, 'apply_pattern', { ...applyArgs(st.slot), dry_run: true }, 120_000);
        if (r.err) { fail(`slot ${st.slot} dry-run ERROR: ${r.text.slice(0, 400)}`); continue; }
        const t2 = r.text;
        const checks: Array<[string, boolean]> = [
          ['dry_run status', /dry.?run/i.test(t2)],
          [`name "${st.project_name}"`, t2.includes(st.project_name)],
          ['colour Teal', /teal/i.test(t2)],
          ['bpm 69', t2.includes('69')],
          ['synth levels 0/0', /Synth ?1=0 \(silent\), Synth ?2=0 \(silent\)/i.test(t2)],
          ['midi2 external route', /midi2/i.test(t2)],
          ['condense', /condens/i.test(t2)],
          ['no scene table', !/scene chain|scene_plan applied/i.test(t2)],
        ];
        const bad = checks.filter(([, v]) => !v);
        if (bad.length === 0) ok(`slot ${st.slot} "${st.project_name}" dry-run receipt clean (${st.order.length} plays)`);
        else fail(`slot ${st.slot} dry-run receipt missing: ${bad.map(([n]) => n).join(', ')}`);
      }
    } else if (phase === 'phase1') {
      const ports = await call('list_midi_ports', 'list_midi_ports', { pattern: ['circuit', 'novation'] });
      if (!ports.err && /circuit/i.test(ports.text)) ok('Circuit visible in MIDI ports');
      else fail(`Circuit not visible: ${ports.text.slice(0, 300)}`);
      const packs = await call('list_packs', 'list_packs', { port: PORT });
      if (!packs.err) ok(`list_packs: ${packs.text.slice(0, 200).replace(/\n/g, ' ')}`);
      else fail(`list_packs: ${packs.text.slice(0, 300)}`);
      const s4 = await call('scan-pack4', 'scan_locations', { port: PORT, pack: 4, from: 1, to: 64 }, 120_000);
      if (s4.err) fail(`pack4 scan error: ${s4.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s4.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true);
        const occDesc = occ.map((x) => `${x.location}:${x.name ?? '?'}`).join(', ');
        console.log(`pack4 occupied: [${occDesc}]`);
        // Premise: strays 1-2 + the thirteen Smooth slots 9-21 (dir names
        // NN_SESSION.ncs, NN = slot-1), 22-64 EMPTY. Anything else = STOP.
        const bySlot = new Map(occ.map((x) => [Number(x.location), x.name ?? '']));
        const want = [1, 2, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
        const good = bySlot.size === want.length
          && want.every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''));
        if (good) ok('pack4 premise EXACT: strays 1-2 + Smooth 9-21 (dir-name lens), 22-64 empty — targets 25-29 CLEAR');
        else fail('PACK 4 DOES NOT MATCH PREMISE - STOP (do not write)');
      }
      const smp = await call('list_samples-pack4', 'list_samples', { port: PORT, pack: 4 });
      if (smp.err) fail(`list_samples pack4 error: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`pack4 pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ')}`);
        const want: Array<[number, string]> = [
          [1, '01_stoken_4_02_kick2'], [2, '02_stoken_4_03_snr'], [5, '05_stoken_4_06_hatC'], [11, '11_stoken_4_12_ride'],
        ];
        const kitOk = want.every(([s, n]) => (names.find((x) => x.slot === s)?.name ?? '').includes(n));
        const strayOk = names.some((x) => x.slot === 39 && /39_PCM/i.test(x.name ?? ''));
        const extras = names.filter((x) => ![1, 2, 5, 11, 39].includes(x.slot));
        if (kitOk && strayOk && extras.length === 0)
          ok('pool premise EXACT: seeded kit at 1/2/5/11 (prefix-aligned) + the factory 39_PCM stray — binding [1,2,5,11] works as-is');
        else fail(`POOL DOES NOT MATCH PREMISE - STOP (kit ${kitOk}, stray ${strayOk}, extras [${extras.map((x) => `${x.slot}:${x.name}`).join(', ')}])`);
      }
    } else if (phase === 'write') {
      for (const st of STAGED) {
        const t0 = Date.now();
        const r = await call(`write-${st.slot}`, 'apply_pattern', applyArgs(st.slot), 180_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) {
          fail(`slot ${st.slot} WRITE ERROR (${secs} s): ${r.text.slice(0, 400)}`);
          console.log('ABORTING remaining writes (refusal = the card moved, or a wire fault).');
          break;
        }
        ok(`slot ${st.slot} "${st.project_name}" written (${secs} s): ${r.text.slice(0, 160).replace(/\n/g, ' ')}`);
      }
      console.log('settling 10 s after the final write...');
      await sleep(10_000);
    } else if (phase === 'backup') {
      // 5-slot sweep: expect the duration gate first; print the estimate, then acknowledge.
      const first = await call('backup-authored-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 25, to: 29, pack: PACK,
        directory: 'samples/circuit-ncs/lovesong-authored-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected): ${first.text.slice(0, 300).replace(/\n/g, ' ')}`);
      else console.log('backup ran without the gate (small estimate)');
      const t0 = Date.now();
      const swp = await call('backup-authored', 'backup_device', {
        port: PORT, scope: 'stored', from: 25, to: 29, pack: PACK,
        directory: 'samples/circuit-ncs/lovesong-authored-2026-07-30', acknowledge_duration: true,
      }, 300_000);
      console.log(`authored sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) fail(`authored sweep ERROR: ${swp.text.slice(0, 400)}`);
      else ok(`authored sweep: ${swp.text.slice(0, 250).replace(/\n/g, ' ')}`);
      const nb4 = await call('backup-pack4-neighbours', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 2, pack: PACK,
        directory: 'samples/circuit-ncs/lovesong-neighbour-pack4-2026-07-30', acknowledge_duration: true,
      }, 120_000);
      if (nb4.err) fail(`pack4 strays backup ERROR: ${nb4.text.slice(0, 300)}`);
      else ok('pack4 strays 1-2 backed up');
      const nb21 = await call('backup-pack4-21', 'backup_device', {
        port: PORT, scope: 'stored', from: 21, to: 21, pack: PACK,
        directory: 'samples/circuit-ncs/lovesong-neighbour-pack4-2026-07-30', acknowledge_duration: true,
      }, 120_000);
      if (nb21.err) fail(`pack4 slot 21 backup ERROR: ${nb21.text.slice(0, 300)}`);
      else ok('pack4 neighbour slot 21 (Smooth 13 Outro3) backed up');
      const nb2 = await call('backup-pack2-57', 'backup_device', {
        port: PORT, scope: 'stored', from: 57, to: 57, pack: 2,
        directory: 'samples/circuit-ncs/lovesong-neighbour-pack2-2026-07-30', acknowledge_duration: true,
      }, 120_000);
      if (nb2.err) fail(`pack2 slot 57 backup ERROR: ${nb2.text.slice(0, 300)}`);
      else ok('pack2 neighbour slot 57 (Billie Jean) backed up (cross-pack identity)');
    } else if (phase === 'scan') {
      for (let i = 1; i <= 2; i++) {
        const s4 = await call(`scan-final-${i}`, 'scan_locations', { port: PORT, pack: 4, from: 1, to: 64 }, 120_000);
        if (s4.err) { fail(`final scan ${i} error: ${s4.text.slice(0, 300)}`); continue; }
        const parsed = JSON.parse(s4.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => [Number(x.location), x.name ?? ''] as const);
        console.log(`scan ${i}: ${occ.map(([l, n]) => `${l}:${n}`).join(', ')}`);
        const bySlot = new Map(occ);
        const want = [1, 2, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 25, 26, 27, 28, 29];
        const good = bySlot.size === want.length
          && want.every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''));
        if (good) ok(`final scan ${i}: strays 1-2 + Smooth 9-21 + the five Love Song slots 25-29 (dir-name lens), all else empty — pack 4 at 20/64`);
        else fail(`final scan ${i} does not match expectation`);
        if (i === 1) { console.log('settling 10 s...'); await sleep(10_000); }
      }
    } else {
      console.error(`unknown phase "${phase}"`);
      process.exitCode = 2;
      return;
    }
  } finally {
    writeFileSync(`${ROOT}/samples/_scratch/lovesong-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
