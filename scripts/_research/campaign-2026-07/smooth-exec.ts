/**
 * Smooth + Havana device-window driver (plan §4 Phases 0.4/1/2/4, Pack 4
 * slots 9-21). Drives the PRODUCT MCP server (packages/server-all/dist) over
 * StdioClientTransport — the sanctioned "drive MCP tools yourself" pattern —
 * so the 84 KB of arrangement payloads flow from smooth-staged.json without
 * a chat-context copy, and ONE process holds the Circuit port per run.
 *
 * Phases (CLI arg):
 *   dryrun  - arg-liveness probe (33-char name refusal) + 13 apply_pattern
 *             dry-runs with receipt checks. No device contact.
 *   phase1  - list_midi_ports / list_packs / scan pack4 / scan pack2 /
 *             list_samples pack4. STOPS unless pack4 == premise
 *             (slots 1-2 = "Sugar 2/10", 3-64 empty; pool slots 1-4 empty).
 *   seed    - upload_kit (4-sample After Dark kit) to pack 4 slots 1-4,
 *             settle 12 s, list_samples re-read.
 *   write   - 13 apply_pattern ncs_upload writes (NO confirm_overwrite:
 *             every target scanned empty; a refusal = the card moved = ABORT).
 *   backup  - backup_device sweeps: 9-21 pack4 (duration gate acknowledged
 *             after printing the estimate), pack4 strays 1-2, pack2
 *             neighbours 57 (Billie Jean) + 25 (Redbone).
 *   scan    - final scan_locations pack4 x2 with a 10 s settle between.
 *
 * Full receipts land in samples/_scratch/smooth-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/smooth-exec.ts <phase>
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
/**
 * Pool binding = the After Dark layout LITERALLY. The first seed attempt
 * (upload_kit to slots 1-4 with Pack-2-named files) surfaced a decode finding:
 * the device registers a sample's DIRECTORY entry at the slot named by the
 * filename's NN prefix, not the transfer's addressed slot, and a later data
 * write to a slot wipes that slot's (misplaced) entry. So the re-seed uploads
 * each file to the wire slot its name says: 01_->1, 02_->2, 05_->5, 11_->11.
 */
const BINDING = [1, 2, 5, 11];
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/smooth-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; order: string[];
  sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
}>;

const phase = process.argv[2];
if (!phase) { console.error('usage: smooth-exec.ts <dryrun|phase1|seed|write|backup|scan>'); process.exit(2); }

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
    project_name: st.project_name, colour: 'Sand', bpm: 116,
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
  const c = new Client({ name: 'smooth-exec', version: '1' }, { capabilities: {} });
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
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 9, ncs_template: TEMPLATE,
        project_name: 'SmoothArgLivenessProbe0123456789X', bpm: 116, dry_run: true,
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
          ['colour Sand', /sand/i.test(t2)],
          ['bpm 116', t2.includes('116')],
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
        // scan_locations reports pack-DIRECTORY names (NN_SESSION.ncs); the strays'
        // embedded names ("Sugar 2/10") are in the 07-29 card backup manifest and
        // byte-identity vs those images is asserted in the backup phase.
        const good = occ.length === 2
          && occ.every((x) => Number(x.location) <= 2 && /SESSION/i.test(x.name ?? ''));
        if (good) ok('pack4 premise EXACT: slots 1-2 occupied (the Sugar 2/10 strays, dir names NN_SESSION.ncs), 3-64 empty');
        else fail('PACK 4 DOES NOT MATCH PREMISE - STOP (do not run seed/write)');
      }
      const s2 = await call('scan-pack2', 'scan_locations', { port: PORT, pack: 2, from: 1, to: 64 }, 120_000);
      if (s2.err) fail(`pack2 scan error: ${s2.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s2.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = new Map((parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => [Number(x.location), x.name ?? '']));
        const expectRanges: Array<[number, number, string]> = [
          [1, 5, 'AfterDark'], [9, 24, 'Schism'], [25, 32, 'Redbone'], [33, 38, 'BrainStew'],
          [41, 49, 'WhatIGot'], [57, 64, 'BillieJean'],
        ];
        let mism = 0;
        for (const [f, to, tag] of expectRanges) {
          for (let s = f; s <= to; s++) {
            const nm = occ.get(s);
            if (nm === undefined) { mism++; console.log(`  pack2 slot ${s}: EMPTY, expected ${tag}`); }
          }
        }
        for (const s of [6, 7, 8, 39, 40, 50, 51, 52, 53, 54, 55, 56]) {
          if (occ.has(s)) { mism++; console.log(`  pack2 slot ${s}: OCCUPIED "${occ.get(s)}", expected empty`); }
        }
        if (mism === 0) ok('pack2 cross-check == premise (AfterDark 1-5, Schism 9-24, Redbone 25-32, BrainStew 33-38, WhatIGot 41-49, BillieJean 57-64, separators empty)');
        else fail(`pack2 premise deviations: ${mism} (cross-check only; not a write blocker unless catastrophic)`);
      }
      const smp = await call('list_samples-pack4', 'list_samples', { port: PORT, pack: 4 });
      if (smp.err) fail(`list_samples pack4 error: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`pack4 pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ')}`);
        const low = names.filter((x) => x.slot <= 4);
        if (low.length === 0) ok('pack4 pool slots 1-4 EMPTY (seed target clear)');
        else fail(`pack4 pool slots 1-4 occupied: ${low.map((x) => `${x.slot}:${x.name}`).join(', ')} - STOP`);
      }
    } else if (phase === 'seed2') {
      // Prefix-aligned re-seed: each file to the wire slot its NN prefix names.
      const FILES: Array<[string, number, string]> = [
        ['samples/_scratch/smooth-seed-kit/01_stoken_4_02_kick2.wav', 2, '01_stoken_4_02_kick2.wav'],
        ['samples/_scratch/smooth-seed-kit/02_stoken_4_03_snr.wav', 3, '02_stoken_4_03_snr.wav'],
        ['samples/_scratch/smooth-seed-kit/05_stoken_4_06_hatC.wav', 6, '05_stoken_4_06_hatC.wav'],
        ['samples/_scratch/smooth-seed-kit/11_stoken_4_12_ride.wav', 12, '11_stoken_4_12_ride.wav'],
      ];
      for (const [file, deviceSlot, name] of FILES) {
        const t0 = Date.now();
        const r = await call(`upload-${name}`, 'upload_sample', {
          port: PORT, file, slot: deviceSlot, name, pack: PACK, confirm_overwrite: true,
        }, 240_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) { fail(`${name} -> device slot ${deviceSlot} ERROR (${secs} s): ${r.text.slice(0, 300)}`); break; }
        ok(`${name} -> device slot ${deviceSlot} (wire ${deviceSlot - 1}) in ${secs} s`);
      }
      console.log('settling 12 s for the pack manifest flush...');
      await sleep(12_000);
      const smp = await call('list_samples-after', 'list_samples', { port: PORT, pack: 4 });
      if (smp.err) fail(`post-seed list_samples error: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`post-seed pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ')}`);
        const want: Array<[number, string]> = [
          [1, '01_stoken_4_02_kick2'], [2, '02_stoken_4_03_snr'], [5, '05_stoken_4_06_hatC'], [11, '11_stoken_4_12_ride'],
        ];
        if (want.every(([s, n]) => (names.find((x) => x.slot === s)?.name ?? '').includes(n)))
          ok('pool wire slots 1/2/5/11 = kick2/snr/hatC/ride -> drum_binding [1,2,5,11] (the After Dark layout, literally)');
        else fail('post-seed pool does not show the kit at wire 1/2/5/11');
      }
    } else if (phase === 'seed') {
      console.log('seeding pack 4 pool slots 1-4 with the After Dark 4-sample kit (kick2/snr/hatC/ride)...');
      const t0 = Date.now();
      const up = await call('upload_kit', 'upload_kit', {
        port: PORT, folder: 'samples/_scratch/smooth-seed-kit', start_slot: 1, pack: 4, confirm_overwrite: true,
      }, 420_000);
      console.log(`upload_kit took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (up.err) fail(`upload_kit ERROR: ${up.text.slice(0, 500)}`);
      else ok(`upload_kit: ${up.text.slice(0, 300).replace(/\n/g, ' ')}`);
      console.log('settling 12 s for the pack manifest flush...');
      await sleep(12_000);
      const smp = await call('list_samples-after', 'list_samples', { port: PORT, pack: 4 });
      if (smp.err) fail(`post-seed list_samples error: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`post-seed pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ')}`);
        const want = ['01_stoken_4_02_kick2', '02_stoken_4_03_snr', '05_stoken_4_06_hatC', '11_stoken_4_12_ride'];
        const got = [1, 2, 3, 4].map((s) => names.find((x) => x.slot === s)?.name ?? '');
        if (want.every((w, i) => got[i].includes(w.replace('.wav', '')))) {
          ok(`pool slots 1-4 = the 4-sample kit in order -> drum_binding [0,1,2,3] confirmed`);
        } else fail(`pool slots 1-4 read [${got.join(', ')}] != expected kit order`);
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
      // 13-slot sweep: expect the duration gate first; print the estimate, then acknowledge.
      const first = await call('backup-authored-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 9, to: 21, pack: PACK,
        directory: 'samples/circuit-ncs/smooth-authored-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected): ${first.text.slice(0, 300).replace(/\n/g, ' ')}`);
      else console.log('backup ran without the gate (small estimate)');
      const t0 = Date.now();
      const swp = await call('backup-authored', 'backup_device', {
        port: PORT, scope: 'stored', from: 9, to: 21, pack: PACK,
        directory: 'samples/circuit-ncs/smooth-authored-2026-07-30', acknowledge_duration: true,
      }, 300_000);
      console.log(`authored sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) fail(`authored sweep ERROR: ${swp.text.slice(0, 400)}`);
      else ok(`authored sweep: ${swp.text.slice(0, 250).replace(/\n/g, ' ')}`);
      const strays = await call('backup-strays', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 2, pack: PACK,
        directory: 'samples/circuit-ncs/smooth-pack4-strays-2026-07-30', acknowledge_duration: true,
      }, 120_000);
      if (strays.err) fail(`pack4 strays backup ERROR: ${strays.text.slice(0, 300)}`);
      else ok(`pack4 strays 1-2 backed up`);
      for (const slot of [57, 25]) {
        const nb = await call(`backup-pack2-${slot}`, 'backup_device', {
          port: PORT, scope: 'stored', from: slot, to: slot, pack: 2,
          directory: 'samples/circuit-ncs/smooth-pack2-neighbour-2026-07-30', acknowledge_duration: true,
        }, 120_000);
        if (nb.err) fail(`pack2 slot ${slot} backup ERROR: ${nb.text.slice(0, 300)}`);
        else ok(`pack2 neighbour slot ${slot} backed up`);
      }
    } else if (phase === 'scan') {
      for (let i = 1; i <= 2; i++) {
        const s4 = await call(`scan-final-${i}`, 'scan_locations', { port: PORT, pack: 4, from: 1, to: 64 }, 120_000);
        if (s4.err) { fail(`final scan ${i} error: ${s4.text.slice(0, 300)}`); continue; }
        const parsed = JSON.parse(s4.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => [Number(x.location), x.name ?? ''] as const);
        console.log(`scan ${i}: ${occ.map(([l, n]) => `${l}:${n}`).join(', ')}`);
        // scan_locations reports pack-DIRECTORY names (NN_SESSION.ncs, NN = wire
        // slot); the embedded names @0x10 are decode-verified from the backup
        // captures by smooth-verify.ts. Here: occupancy set + dir-name shape.
        const bySlot = new Map(occ);
        let good = bySlot.size === 15
          && [1, 2, ...STAGED.map((s) => s.slot)].every((s) => {
            const nm = bySlot.get(s) ?? '';
            return new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(nm);
          });
        if (good) ok(`final scan ${i}: strays 1-2 + the thirteen Smooth projects on 9-21 (dir-name lens), all else empty`);
        else fail(`final scan ${i} does not match expectation`);
        if (i === 1) { console.log('settling 10 s...'); await sleep(10_000); }
      }
    } else {
      console.error(`unknown phase "${phase}"`);
      process.exitCode = 2;
      return;
    }
  } finally {
    writeFileSync(`${ROOT}/samples/_scratch/smooth-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
