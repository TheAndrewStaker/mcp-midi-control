/**
 * I BELIEVE IN A THING CALLED LOVE — populate DEVICE EXECUTION, 2026-07-31.
 *
 * Give I Believe (Pack 5, Projects 19-25) the condensed four-voice copy of its
 * own MIDI 2 drum part on the Circuit's internal drum tracks: bound [1,2,5,11],
 * stored SILENT (all six levels 0). This is the LAST unpopulated song in the
 * campaign.
 *
 * METHOD (see ibelieve-stage.ts for the full rationale): each project is
 * re-authored with ITS OWN newest canonical export as the `ncs_template`, and
 * the ONLY authored content is the condensed drum layer. No `external_targets`
 * are passed, so every source drum voice resolves to an empty destination list,
 * `union_notes` is EMPTY, and the writer never touches a note track, a note
 * chain, a scene table or the project scale. midi1 (a real melodic leg on all
 * seven) and midi2 are preserved BY CONSTRUCTION rather than reconstructed.
 *
 * WHY THIS UNBLOCKS A SONG PREVIOUSLY SCOPED AS BLOCKED: I Believe's per-project
 * BAR SPANS are unrecorded, which blocks a from-source re-author but is simply
 * not needed here — the payload comes from the card's own stored midi2 content.
 *
 * Phases (CLI arg):
 *   dryrun  - arg-liveness probe + 7 apply_pattern dry-runs, receipt-checked:
 *             condensed layer NAMED, drum levels 0/0/0/0, six-silent mixer,
 *             tracks written are DRUM ONLY (the assertion that proves no note
 *             track is touched), plain chain 1..N matching the canonical's own
 *             midi2 chain, name / colour / bpm unchanged.
 *   gate    - ports / packs / pack-5 pool precondition / occupancy / ORACLE
 *             IDENTITY GATE: download the 7 targets + 2 witnesses and byte-
 *             compare all 9 against the newest canonical. Any diff = STOP.
 *   write   - 7 apply_pattern ncs_upload writes, confirm_overwrite:true
 *             (identity-gated above) + backup_first default true. 10 s settle.
 *   backup  - authored sweep of the 7 + the 2 untouched witnesses.
 *   scan    - final scan_locations pack 5 x2 with a settle between.
 *
 * Receipts land in samples/_scratch/ibelieve-exec-<phase>.log.json.
 * Run: npx tsx scripts/_research/campaign-2026-07/ibelieve-exec.ts <phase>
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { newestCanonical } from './ibelieve-facts-probe.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const SERVER = path.resolve(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'circuit-tracks';
const PACK = 5;
export const BINDING = [1, 2, 5, 11];
export const TARGET_SLOTS = [19, 20, 21, 22, 23, 24, 25];
/** Untouched neighbours, immediately either side of the block. */
export const WITNESSES = [17, 27];
/** Contiguous OCCUPIED bands covering targets + witnesses (18 and 26 are empty). */
const BANDS: Array<[number, number]> = [[17, 17], [19, 25], [27, 27]];
const PREAUTHOR_DIR = `${ROOT}/samples/circuit-ncs/ibelieve-preauthor-2026-07-31`;

interface StagedSection { name: string; steps: number; voices: Record<string, string> }
export interface StagedProject {
  slot: number; project_name: string; colour: string; bpm: number;
  template: string; chain: [number, number]; plays: number;
  sections: StagedSection[]; order: string[]; note: string;
}
const STAGED: StagedProject[] = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/ibelieve-staged.json`, 'utf8')) as StagedProject[];
if (STAGED.length !== 7) throw new Error(`expected 7 staged projects, got ${STAGED.length}`);

/** Pack 5 occupancy premise, as the 2026-07-30/31 campaign left it. */
const PREMISE_OCCUPIED = [
  1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 14, 15, 16, 17,
  19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 36, 37, 38, 39, 46, 47, 48, 49, 50, 51, 52, 53,
  57, 58, 59, 60, 61, 62, 63,
];

const phase = process.argv[2];
if (!phase) { console.error('usage: ibelieve-exec.ts <dryrun|gate|write|backup|scan>'); process.exit(2); }

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

/**
 * The apply_pattern arguments for one project. NOTE what is absent:
 * `external_targets` (so no note track is authored) and `scene_plan` (the card
 * holds no scene chain). Name / colour / bpm are restated at the values the
 * template already holds, so they are byte no-ops that double as an assertion
 * the right template was loaded.
 */
export function applyArgs(t: StagedProject): Record<string, unknown> {
  return {
    port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: t.slot,
    ncs_template: path.relative(ROOT, t.template).replace(/\\/g, '/'),
    project_name: t.project_name, colour: t.colour, bpm: t.bpm,
    mixer_levels: { synth1: 0, synth2: 0, drum1: 0, drum2: 0, drum3: 0, drum4: 0 },
    arrangement: { sections: t.sections, order: t.order },
    condense_drums: true,
    drum_binding: BINDING,
    confirm_overwrite: true,
  };
}

const loadBackupDir = (dir: string): Map<number, Buffer> => {
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
  const c = new Client({ name: 'ibelieve-exec', version: '1' }, { capabilities: {} });
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
      const probe = await call('arg-liveness', 'apply_pattern', {
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 19,
        ncs_template: 'samples/circuit-tracks/blank_slot20.ncs',
        project_name: 'IBelieveArgLivenessProbe0123456789', bpm: 128, dry_run: true,
        voices: { kick: 'x...x...' },
      });
      if (probe.err && probe.text.includes('32')) ok('arg-liveness: an over-long project_name was refused naming the 32 limit (server fresh)');
      else fail(`arg-liveness probe: err=${probe.err} text=${probe.text.slice(0, 240)} — STALE SERVER, STOP`);

      for (const tg of STAGED) {
        const r = await call(`dryrun-${tg.slot}`, 'apply_pattern', { ...applyArgs(tg), dry_run: true }, 300_000);
        if (r.err) { fail(`slot ${tg.slot} dry-run ERROR: ${r.text.slice(0, 700)}`); continue; }
        let x: string;
        try { x = String((JSON.parse(r.text) as { info?: string }).info ?? r.text); } catch { x = r.text; }
        const full = r.text;
        const trackLine = (/Tracks(?: written)?: ([^.]*)\./.exec(x)?.[1]) ?? '';
        const checks: Array<[string, boolean]> = [
          ['dry_run status', /dry.?run/i.test(x)],
          [`name "${tg.project_name}" unchanged`, x.includes(`Project name stored as "${tg.project_name}" (the template already held it)`)],
          [`colour ${tg.colour} unchanged`, new RegExp(`Pad colour stored as ${tg.colour} \\(the template already held it\\)`).test(x)],
          [`bpm ${tg.bpm} unchanged`, new RegExp(`Tempo stored at ${tg.bpm} BPM;`).test(x)],
          ['condensed layer named', /Condensed the drum part onto the 4 internal drum tracks \(kick \/ snare \/ closed_hat \/ ride\)/.test(x)],
          ['condensed in every section', new RegExp(`in ${tg.sections.length} of ${tg.sections.length} section\\(s\\)`).test(x)],
          ['drum levels stored 0/0/0/0', /Drum-track levels stored at 0\/0\/0\/0/.test(x)],
          ['mixer six-silent', /Synth 1=0 \(silent\), Synth 2=0 \(silent\), Drum 1=0 \(silent\), Drum 2=0 \(silent\), Drum 3=0 \(silent\), Drum 4=0 \(silent\)/.test(x)],
          // THE PRESERVATION ASSERTION: drum tracks and NOTHING else. A note
          // track in this list would mean midi1 or midi2 is being re-authored.
          ['at least one drum track written', /\bDrum[1-4]\b/.test(trackLine)],
          ['NO note track written (midi1 + midi2 preserved)', !/\b(midi1|midi2|synth1|synth2)\b/.test(trackLine)],
          ['no scale change (drums are scale-immune)', !/Project scale set to/.test(full)],
          ['no external routing in this call', !/via the host's midi2 track/.test(full)],
          ['no also_internal doubling', !/also_internal/.test(full)],
          [`plain chain 1..${tg.plays}`, x.includes(`patterns 1..${tg.plays} auto-advance via the pattern chain`)],
          ['no scene layout', !/scene steps \(/.test(full)],
          [`targets Project ${tg.slot}`, new RegExp(`shown as .{0,2}Project ${tg.slot}`).test(x)],
        ];
        const bad = checks.filter(([, v]) => !v);
        if (bad.length === 0) ok(`slot ${tg.slot} "${tg.project_name}" dry-run clean (${tg.plays} plays, tracks: ${trackLine})`);
        else fail(`slot ${tg.slot} dry-run missing: ${bad.map(([n]) => n).join(', ')}\n   receipt: ${x.slice(0, 1400)}`);
      }
    } else if (phase === 'gate') {
      const ports = await call('list_midi_ports', 'list_midi_ports', { pattern: ['circuit', 'novation'] });
      if (!ports.err && /circuit/i.test(ports.text)) ok('Circuit visible in MIDI ports');
      else fail(`Circuit not visible: ${ports.text.slice(0, 300)}`);
      const packs = await call('list_packs', 'list_packs', { port: PORT });
      if (!packs.err) ok('list_packs answered');
      else fail(`list_packs: ${packs.text.slice(0, 400)}`);

      const smp = await call('list_samples-pack5', 'list_samples', { port: PORT, pack: PACK }, 120_000);
      if (smp.err) fail(`list_samples pack5 ERROR: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { slots?: Array<{ slot: number; name?: string }> };
        const bySlot = new Map((parsed.slots ?? []).filter((s) => s.name !== undefined).map((s) => [s.slot, s.name!]));
        console.log(`pack5 pool: ${[...bySlot].map(([s, n]) => `${s}:${n}`).join(', ')}`);
        const want: Array<[number, RegExp]> = [[1, /kick/i], [2, /snr|snare/i], [5, /hat/i], [11, /ride/i]];
        const bad = want.filter(([s, re]) => !re.test(bySlot.get(s) ?? ''));
        if (bad.length === 0) ok('pool precondition: wire 1/2/5/11 = kick2 / snr / hatC / ride, so binding [1,2,5,11] resolves');
        else fail(`POOL PRECONDITION FAILED at wire slot(s) ${bad.map(([s]) => s).join(',')} — STOP`);
      }

      const s5 = await call('scan-pack5', 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 180_000);
      if (s5.err) fail(`pack5 scan error: ${s5.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => Number(x.location)).sort((a, b) => a - b);
        console.log(`pack5 occupied (${occ.length}): [${occ.join(',')}]`);
        if (JSON.stringify(occ) === JSON.stringify(PREMISE_OCCUPIED)) ok('pack5 occupancy EXACT per the campaign premise');
        else fail(`PACK 5 OCCUPANCY MOVED (got [${occ.join(',')}]) — STOP, re-backup and re-plan`);
      }

      const gate = await call('backup-preauthor-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 19, to: 25, pack: PACK,
        directory: 'samples/circuit-ncs/ibelieve-preauthor-2026-07-31',
      }, 60_000);
      if (gate.err) console.log(`duration gate (expected, campaign standing authorization): ${gate.text.slice(0, 180).replace(/\n/g, ' ')}`);
      for (const [from, to] of BANDS) {
        const swp = await call(`backup-preauthor-${from}-${to}`, 'backup_device', {
          port: PORT, scope: 'stored', from, to, pack: PACK,
          directory: 'samples/circuit-ncs/ibelieve-preauthor-2026-07-31', acknowledge_duration: true,
        }, 600_000);
        if (swp.err) { fail(`preauthor sweep ${from}-${to} ERROR: ${swp.text.slice(0, 400)}`); return; }
      }
      const pre = loadBackupDir(PREAUTHOR_DIR);
      let identical = 0;
      const all = [...TARGET_SLOTS, ...WITNESSES].sort((a, b) => a - b);
      for (const slot of all) {
        const a = pre.get(slot);
        const b = readFileSync(newestCanonical(slot).file);
        if (a !== undefined && a.equals(b)) { identical++; continue; }
        fail(`ORACLE IDENTITY GATE: slot ${slot} ${a === undefined ? 'not captured' : 'DIFFERS from the newest canonical'} — THE CARD MOVED, STOP`);
      }
      if (identical === all.length) ok(`ORACLE IDENTITY GATE: all ${identical} slots (7 targets + 2 witnesses) byte-identical to the newest canonical`);
    } else if (phase === 'write') {
      for (const tg of STAGED) {
        const t0 = Date.now();
        const r = await call(`write-${tg.slot}`, 'apply_pattern', applyArgs(tg), 300_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) { fail(`slot ${tg.slot} WRITE ERROR (${secs} s): ${r.text.slice(0, 700)}`); console.log('ABORTING remaining writes.'); break; }
        const acked = /all frames acked/i.test(r.text) && /uploaded/i.test(r.text);
        const condensed = /Condensed the drum part/.test(r.text);
        const trackLine = (/Tracks written: ([^.]*)\./.exec(r.text)?.[1]) ?? '';
        const notesTouched = /\b(midi1|midi2|synth1|synth2)\b/.test(trackLine);
        if (acked && condensed && !notesTouched) ok(`slot ${tg.slot} "${tg.project_name}" written with the condensed layer (${secs} s, tracks: ${trackLine})`);
        else fail(`slot ${tg.slot} receipt problem (acked=${acked} condensed=${condensed} noteTracksTouched=${notesTouched}): ${r.text.slice(0, 500)}`);
      }
      console.log('settling 10 s after the final write...');
      await sleep(10_000);
    } else if (phase === 'backup') {
      const gate = await call('backup-authored-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 19, to: 25, pack: PACK,
        directory: 'samples/circuit-ncs/ibelieve-authored-2026-07-31',
      }, 60_000);
      if (gate.err) console.log(`duration gate (expected): ${gate.text.slice(0, 180).replace(/\n/g, ' ')}`);
      for (const [from, to] of BANDS) {
        const swp = await call(`backup-authored-${from}-${to}`, 'backup_device', {
          port: PORT, scope: 'stored', from, to, pack: PACK,
          directory: 'samples/circuit-ncs/ibelieve-authored-2026-07-31', acknowledge_duration: true,
        }, 600_000);
        if (swp.err) fail(`authored sweep ${from}-${to} ERROR: ${swp.text.slice(0, 400)}`);
        else ok(`authored sweep ${from}-${to} captured`);
      }
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
        const names = occ.filter(([l]) => TARGET_SLOTS.includes(l)).map(([l, n]) => `${l}:${n}`);
        console.log(`  I Believe names: ${names.join(', ')}`);
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
    writeFileSync(`${ROOT}/samples/_scratch/ibelieve-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
