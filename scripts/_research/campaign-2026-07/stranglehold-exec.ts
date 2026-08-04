/**
 * Stranglehold re-author device-window driver (plan §4, Pack 5 slots 1-6 IN
 * PLACE, Peach, PC 64-69). Drives the PRODUCT MCP server
 * (packages/server-all/dist) over StdioClientTransport — the sanctioned "drive
 * MCP tools yourself" pattern — so the arrangement payloads flow from
 * stranglehold-staged.json without a chat-context copy, and ONE process holds
 * the Circuit port per run.
 *
 * Maintainer decisions binding this run (2026-07-30):
 *   Q1 NO FOLD  -> six projects, two AM4 presets, ZERO deletes.
 *   Q2 KEEP     -> the hand-authored MIDI 1 drone is carried byte-faithfully
 *                  (staged from the oracle by stranglehold-stage.ts) and is
 *                  ASSERTED PER SLOT in Phase 4. This is a REQUIREMENT.
 *   Q3 default  -> Solo3 keeps C G C H C I C J.
 *
 * Phases (CLI arg):
 *   gate    - the ONE live Songsterr fetch: s403 must report revision 8042866
 *             (drift = STOP). No device, one request.
 *   dryrun  - arg-liveness probe (33-char project_name must be refused naming
 *             the 32 limit) + 6 apply_pattern dry-runs with receipt checks
 *             (name / Peach / 72 / mixer 0 x6 / midi2 spd-sx route / NO
 *             condense / NO binding / plain chain / midi1+midi2 only).
 *   phase1  - list_midi_ports / list_packs / scan pack5 1-64 vs the premise /
 *             list_samples pack5 (reported, NOT relied on: this song uses no
 *             condense and no binding) / ORACLE IDENTITY GATE: backup 1-6 ->
 *             stranglehold-preauthor-2026-07-30 and byte-compare all six
 *             against card-backup-2026-07-29/pack5 (any diff = STOP).
 *   write   - 6 apply_pattern ncs_upload writes, slots 1 -> 6, each with
 *             confirm_overwrite:true (pre-authorized by the plan ONLY for
 *             slots 1-6 pack 5: identity-gated above + per-write backup_first
 *             left at its default true). Settle 10 s after the 6th.
 *   backup  - authored sweep 1-6 -> stranglehold-authored-2026-07-30;
 *             neighbours 9 (Amber), 27 (Clint), 46 (Sugar), 35 (Breakdown,
 *             reported only — it is under concurrent surgical work).
 *   scan    - final scan_locations pack5 x2 with a settle between.
 *
 * Full receipts land in samples/_scratch/stranglehold-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/stranglehold-exec.ts <phase>
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const SERVER = path.resolve(ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'circuit-tracks';
const PACK = 5;
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const ORACLE_DIR = `${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack5`;
const PREAUTHOR_DIR = `${ROOT}/samples/circuit-ncs/stranglehold-preauthor-2026-07-30`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/stranglehold-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; pc: number; chain: [number, number];
  order: string[]; sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
  note: string;
}>;

const phase = process.argv[2];
if (!phase) { console.error('usage: stranglehold-exec.ts <gate|dryrun|phase1|write|backup|scan>'); process.exit(2); }

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
 * Pack 5 occupancy premise (plan §4 step 6), as Clint's run verified it earlier
 * TODAY (2026-07-30 18:19): Stranglehold 1-6, Amber 9-12, CaughtGlim 14-17,
 * IBelieve 19-25, Clint 27-34, Breakdown 35-39, Sugar 46-53, Offering 57-63.
 */
const PREMISE_OCCUPIED = [
  1, 2, 3, 4, 5, 6,
  9, 10, 11, 12,
  14, 15, 16, 17,
  19, 20, 21, 22, 23, 24, 25,
  27, 28, 29, 30, 31, 32, 33, 34,
  35, 36, 37, 38, 39,
  46, 47, 48, 49, 50, 51, 52, 53,
  57, 58, 59, 60, 61, 62, 63,
];

function applyArgs(slot: number): Record<string, unknown> {
  const st = STAGED.find((s) => s.slot === slot)!;
  return {
    port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: slot,
    ncs_template: TEMPLATE,
    project_name: st.project_name, colour: 'Peach', bpm: 72,
    // UNIVERSAL STORED-SILENT: both synths, plus the internal drum tracks
    // (standing convention; this song has no internal drum content at all).
    mixer_levels: { synth1: 0, synth2: 0, drum1: 0, drum2: 0, drum3: 0, drum4: 0 },
    // The kit is EXTERNAL-ONLY to the SPD-SX (kit 40) at the oracle's own +12
    // register. NO condense_drums, NO drum_binding, NO transpose, NO scene_plan.
    external_targets: [{ device: 'spd-sx', track: 'midi2', note_offset: 12 }],
    arrangement: { sections: st.sections, order: st.order },
    confirm_overwrite: true,
  };
}

const loadBackupDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /project(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(path.join(dir, f)));
  }
  return m;
};

async function main(): Promise<void> {
  if (phase === 'gate') {
    const { fetchSongsterrTracks } = await import('../../packages/core/src/protocol-generic/patterns/songsterrFetch.js');
    const roster = await fetchSongsterrTracks('403');
    console.log(`s403: "${roster.title}" by ${roster.artist}, revision ${roster.revisionId}`);
    if (roster.revisionId === 8042866) ok('revision gate: 8042866 == the plan pin (every window letter is revision-specific)');
    else fail(`REVISION MOVED: ${roster.revisionId} != 8042866 — STOP, the plan is measured on 8042866`);
    // The roster shift is the reason the pin is load-bearing: confirm the kit is
    // part 8 at this revision, NOT the stale doc's part 7.
    const parts = (roster as unknown as { tracks?: Array<{ partId?: number; title?: string; instrument?: string }> }).tracks ?? [];
    for (const t of parts) console.log(`  part ${t.partId}: ${t.title ?? ''} ${t.instrument ?? ''}`);
    writeFileSync(`${ROOT}/samples/_scratch/stranglehold-exec-${phase}.log.json`,
      JSON.stringify({ revisionId: roster.revisionId, title: roster.title, artist: roster.artist, tracks: parts }, null, 2));
    console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: ROOT });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'stranglehold-exec', version: '1' }, { capabilities: {} });
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
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 1, ncs_template: TEMPLATE,
        // EXACTLY 33 chars — one past the 32 limit, so a live server must refuse.
        project_name: 'StrangleArgLivenessProbe012345678', bpm: 72, dry_run: true,
        voices: { kick: 'x...x...x...x...' },
      });
      if (probe.err && probe.text.includes('32')) ok('arg-liveness: 33-char project_name refused naming the 32 limit (server is fresh, no silent arg-strip)');
      else fail(`arg-liveness probe: err=${probe.err} text=${probe.text.slice(0, 240)} — STALE SERVER, STOP`);

      for (const st of STAGED) {
        const r = await call(`dryrun-${st.slot}`, 'apply_pattern', { ...applyArgs(st.slot), dry_run: true }, 180_000);
        if (r.err) { fail(`slot ${st.slot} dry-run ERROR: ${r.text.slice(0, 500)}`); continue; }
        const t2 = r.text;
        const trackLine = (/"?Tracks: ([^.]*)\./.exec(t2)?.[1]) ?? '';
        const checks: Array<[string, boolean]> = [
          ['dry_run status', /dry.?run/i.test(t2)],
          [`name "${st.project_name}"`, t2.includes(st.project_name)],
          ['colour Peach', /peach/i.test(t2)],
          ['bpm 72', /\b72\b/.test(t2)],
          ['synth levels 0/0 silent', /Synth 1=0 \(silent\), Synth 2=0 \(silent\)/i.test(t2)],
          ['drum levels 0 x4', /Drum 1=0 \(silent\), Drum 2=0 \(silent\), Drum 3=0 \(silent\), Drum 4=0 \(silent\)/i.test(t2)],
          ['midi2 external route', /midi2/i.test(t2)],
          ['NO condense (external-only)', !/condensed the drum part/i.test(t2)],
          [`plain chain 1..${st.order.length}`, t2.includes(`patterns 1..${st.order.length} auto-advance via the pattern chain`)],
          ['NO scene table', !/scene step/i.test(t2)],
          [`targets Project ${st.slot}`, new RegExp(`shown as .{0,2}Project ${st.slot}`).test(t2)],
          // The ONLY tracks are midi2 (the kit) and midi1 (THE DRONE, fork Q2
          // KEEP). No synths, no internal drums.
          ['tracks == midi1 + midi2 exactly',
            /\bmidi1\b/.test(trackLine) && /\bmidi2\b/.test(trackLine)
            && !/\bsynth1\b/.test(trackLine) && !/\bsynth2\b/.test(trackLine) && !/Drum\d/.test(trackLine)],
        ];
        const bad = checks.filter(([, v]) => !v);
        if (bad.length === 0) ok(`slot ${st.slot} "${st.project_name}" dry-run receipt clean (${st.order.length} plays, ${st.sections.length} stored patterns, chain [${st.chain}])`);
        else fail(`slot ${st.slot} dry-run receipt missing: ${bad.map(([n]) => n).join(', ')} :: ${t2.slice(0, 800)}`);
        if (st.slot === 1) console.log(`  [slot 1 receipt] ${t2.slice(0, 1500)}`);
      }
    } else if (phase === 'phase1') {
      const ports = await call('list_midi_ports', 'list_midi_ports', { pattern: ['circuit', 'novation'] });
      if (!ports.err && /circuit/i.test(ports.text)) ok('Circuit visible in MIDI ports');
      else fail(`Circuit not visible: ${ports.text.slice(0, 300)}`);
      const packs = await call('list_packs', 'list_packs', { port: PORT });
      if (!packs.err && /03_PACK/i.test(packs.text)) ok('list_packs answered and Pack 5 "03_PACK" is present');
      else fail(`list_packs: ${packs.text.slice(0, 400)}`);
      const s5 = await call('scan-pack5', 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 180_000);
      if (s5.err) fail(`pack5 scan error: ${s5.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true);
        const bySlot = new Map(occ.map((x) => [Number(x.location), x.name ?? '']));
        console.log(`pack5 occupied (${occ.length}): [${[...bySlot.entries()].map(([l, n]) => `${l}:${n}`).join(', ')}]`);
        const got = [...bySlot.keys()].sort((a, b) => a - b);
        if (JSON.stringify(got) === JSON.stringify(PREMISE_OCCUPIED))
          ok('pack5 occupancy EXACT per premise: Stranglehold 1-6, 7-8 EMPTY, Amber 9-12, 13 EMPTY, CaughtGlim 14-17, 18 EMPTY, IBelieve 19-25, 26 EMPTY, Clint 27-34, Breakdown 35-39, 40-45 EMPTY, Sugar 46-53, 54-56 EMPTY, Offering 57-63, 64 EMPTY');
        else fail(`PACK 5 OCCUPANCY DOES NOT MATCH PREMISE (got [${got.join(',')}], want [${PREMISE_OCCUPIED.join(',')}]) — STOP, the card moved`);
        for (let s = 1; s <= 6; s++) {
          const n = bySlot.get(s) ?? '';
          if (!new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(n)) fail(`slot ${s} name "${n}" is not the expected session-file shape`);
        }
      }
      const smp = await call('list_samples-pack5', 'list_samples', { port: PORT, pack: PACK }, 120_000);
      if (smp.err) console.log(`list_samples pack5 (reported only): ${smp.text.slice(0, 200)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`pack5 pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ') || '(none)'}`);
        ok('pool state recorded — NOT relied on: this song is external-only (no condense_drums, no drum_binding), so no pool slot is load-bearing');
      }
      // ORACLE IDENTITY GATE (plan §4 step 7: mismatch = STOP).
      const first = await call('backup-preauthor-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 6, pack: PACK,
        directory: 'samples/circuit-ncs/stranglehold-preauthor-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, campaign standing authorization): ${first.text.slice(0, 200).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      const swp = await call('backup-preauthor', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 6, pack: PACK,
        directory: 'samples/circuit-ncs/stranglehold-preauthor-2026-07-30', acknowledge_duration: true,
      }, 600_000);
      console.log(`preauthor sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) { fail(`preauthor sweep ERROR: ${swp.text.slice(0, 400)}`); return; }
      const pre = loadBackupDir(PREAUTHOR_DIR);
      let identical = 0;
      for (let slot = 1; slot <= 6; slot++) {
        const a = pre.get(slot);
        const b = readFileSync(`${ORACLE_DIR}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`);
        if (a !== undefined && a.equals(b)) { identical++; continue; }
        fail(`ORACLE IDENTITY GATE: slot ${slot} ${a === undefined ? 'not captured' : 'DIFFERS from card-backup-2026-07-29'} — THE CARD MOVED, STOP`);
      }
      if (identical === 6) ok('ORACLE IDENTITY GATE: all six slots 1-6 byte-identical to card-backup-2026-07-29 (nothing has touched Stranglehold since the oracle; the §3 carry-over inventory stands, THE DRONE included)');
    } else if (phase === 'write') {
      for (const st of STAGED) {
        const t0 = Date.now();
        const r = await call(`write-${st.slot}`, 'apply_pattern', applyArgs(st.slot), 300_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) {
          fail(`slot ${st.slot} WRITE ERROR (${secs} s): ${r.text.slice(0, 500)}`);
          console.log('ABORTING remaining writes (a refusal here means the card moved or a wire fault).');
          break;
        }
        const acked = /all frames acked/i.test(r.text) && /uploaded/i.test(r.text);
        const backed = /back(ed)? up/i.test(r.text);
        if (acked) ok(`slot ${st.slot} "${st.project_name}" written (${secs} s)${backed ? ', pre-write backup taken' : ''}`);
        else fail(`slot ${st.slot} receipt lacks the acked-upload marker: ${r.text.slice(0, 250)}`);
      }
      console.log('settling 10 s after the final write...');
      await sleep(10_000);
    } else if (phase === 'backup') {
      const first = await call('backup-authored-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 6, pack: PACK,
        directory: 'samples/circuit-ncs/stranglehold-authored-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, campaign standing authorization): ${first.text.slice(0, 200).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      const swp = await call('backup-authored', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 6, pack: PACK,
        directory: 'samples/circuit-ncs/stranglehold-authored-2026-07-30', acknowledge_duration: true,
      }, 600_000);
      console.log(`authored sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) fail(`authored sweep ERROR: ${swp.text.slice(0, 400)}`);
      else ok('authored sweep 1-6 -> stranglehold-authored-2026-07-30');
      for (const [slot, label] of [
        [9, 'Amber 01 Intro (canonical: amber-authored-2026-07-29)'],
        [27, 'Clint 01 Intro (canonical: clint-authored-2026-07-30)'],
        [46, 'Sugar 1 IntroVrs (canonical: sugar-authored-2026-07-30)'],
        [35, 'Breakdown P1 (reported only — concurrent surgical work)'],
      ] as Array<[number, string]>) {
        const nb = await call(`backup-neighbour-${slot}`, 'backup_device', {
          port: PORT, scope: 'stored', from: slot, to: slot, pack: PACK,
          directory: 'samples/circuit-ncs/stranglehold-neighbour-2026-07-30', acknowledge_duration: true,
        }, 180_000);
        if (nb.err) fail(`neighbour ${slot} backup ERROR: ${nb.text.slice(0, 300)}`);
        else ok(`neighbour slot ${slot} (${label}) captured`);
      }
    } else if (phase === 'scan') {
      const AFTER = new Map(STAGED.map((s) => [s.slot, s.project_name]));
      let firstOcc = '';
      for (let i = 1; i <= 2; i++) {
        const s5 = await call(`scan-final-${i}`, 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 180_000);
        if (s5.err) { fail(`final scan ${i} error: ${s5.text.slice(0, 300)}`); continue; }
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => [Number(x.location), x.name ?? ''] as const);
        const sig = JSON.stringify(occ);
        console.log(`scan ${i} occupied (${occ.length}): ${occ.map(([l, n]) => `${l}:${n}`).join(', ')}`);
        const bySlot = new Map(occ);
        const good = JSON.stringify([...bySlot.keys()].sort((a, b) => a - b)) === JSON.stringify(PREMISE_OCCUPIED)
          && [...AFTER.keys()].every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''));
        if (good) ok(`final scan ${i}: the six Stranglehold slots 1-6 present, occupancy unchanged everywhere else (${PREMISE_OCCUPIED.length} occupied, ZERO deletes)`);
        else fail(`final scan ${i} does not match the after-state expectation`);
        if (i === 1) { firstOcc = sig; console.log('settling 10 s...'); await sleep(10_000); }
        else if (sig === firstOcc) ok('the two final scans AGREE exactly');
        else fail('the two final scans DISAGREE — re-read after a settle before concluding anything');
      }
    } else {
      console.error(`unknown phase "${phase}"`);
      process.exitCode = 2;
      return;
    }
  } finally {
    writeFileSync(`${ROOT}/samples/_scratch/stranglehold-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
