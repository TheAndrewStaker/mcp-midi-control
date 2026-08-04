/**
 * Clint Eastwood re-author device-window driver (plan §4, Pack 5 slots 27-34 IN
 * PLACE). Drives the PRODUCT MCP server (packages/server-all/dist) over
 * StdioClientTransport — the sanctioned "drive MCP tools yourself" pattern — so
 * the arrangement payloads flow from clint-staged.json without a chat-context
 * copy, and ONE process holds the Circuit port per run.
 *
 * Phases (CLI arg):
 *   gate    - the ONE live Songsterr fetch: the roster of s8562 must report
 *             revision 6899599 (drift = STOP). No device, one request.
 *   dryrun  - arg-liveness probe (33-char project_name must be refused naming
 *             the 32 limit) + 8 apply_pattern dry-runs with receipt checks
 *             (name / Lime / 85 / mixer 0 x6 / midi2 spd-sx route / condense
 *             acknowledged / layout: scenes on 31+32, chain elsewhere). No
 *             device contact.
 *   phase1  - list_midi_ports / list_packs / scan pack5 1-64 vs the premise /
 *             list_samples pack5 (expect the lone 03_PCM.wav) / ORACLE
 *             IDENTITY GATE: backup 27-34 -> clint-preauthor-2026-07-30 and
 *             byte-compare all eight against card-backup-2026-07-29/pack5
 *             (any diff = the card moved: STOP).
 *   seed    - fork Q2 default: seed the pack 5 pool with the After Dark
 *             4-sample kit, PREFIX-ALIGNED (BK-CIRCUIT-SAMPLENAME / the Smooth
 *             finding: the device registers a sample at the slot its filename's
 *             NN prefix names, not the addressed slot). 01_->wire 1, 02_->2,
 *             05_->5, 11_->11; the existing 03_PCM.wav at wire 3 is untouched.
 *             Settle, then read the pool back BEFORE any project write.
 *   write   - 8 apply_pattern ncs_upload writes, slots 27 -> 34, each with
 *             confirm_overwrite:true (pre-authorized by the plan ONLY for
 *             27-34 pack 5: identity-gated above + per-write backup_first) and
 *             backup_first left at its default true. Settle 10 s after the 8th.
 *   backup  - authored sweep 27-34 -> clint-authored-2026-07-30; neighbours
 *             9 (Amber 01), 35 (Breakdown P1), 46 (Sugar 1) ->
 *             clint-neighbour-2026-07-30.
 *   scan    - final scan_locations pack5 x2 with a settle between; 27-34 = the
 *             new names, everything else exactly as phase1 found it.
 *
 * Full receipts land in samples/_scratch/clint-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/clint-exec.ts <phase>
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
const PREAUTHOR_DIR = `${ROOT}/samples/circuit-ncs/clint-preauthor-2026-07-30`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/clint-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; pc: number; layout: 'chain' | 'scenes';
  order: string[]; sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
  expect_letters: string;
}>;

const phase = process.argv[2];
if (!phase) { console.error('usage: clint-exec.ts <gate|dryrun|phase1|seed|write|backup|scan>'); process.exit(2); }

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

/** Pack 5 occupancy premise (plan §4 step 7, corrected for the Sugar session). */
const PREMISE_OCCUPIED = [
  1, 2, 3, 4, 5, 6,                        // Stranglehold
  9, 10, 11, 12,                           // Amber (Purple)
  14, 15, 16, 17,                          // CaughtGlim
  19, 20, 21, 22, 23, 24, 25,              // IBelieve
  27, 28, 29, 30, 31, 32, 33, 34,          // ClintEastwood P1..P8 (the target)
  35, 36, 37, 38, 39,                      // Breakdown
  46, 47, 48, 49, 50, 51, 52, 53,          // Sugar (2026-07-30)
  57, 58, 59, 60, 61, 62, 63,              // The Offering
];
/** The plan's own scan window; asserted exactly. Beyond it we report, not gate. */
const PLAN_WINDOW_MAX = 40;

function applyArgs(slot: number): Record<string, unknown> {
  const st = STAGED.find((s) => s.slot === slot)!;
  return {
    port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: slot,
    ncs_template: TEMPLATE,
    project_name: st.project_name, colour: 'Lime', bpm: 85,
    // Universal stored-silent: both synths AND the condensed blend layer.
    mixer_levels: { synth1: 0, synth2: 0, drum1: 0, drum2: 0, drum3: 0, drum4: 0 },
    // Melodic lanes at written pitch in the staged rows; the Circuit transmits
    // 12 below stored, so +12 here. Drum voices are un-pitched and untouched.
    transpose: 12,
    external_targets: [{ device: 'spd-sx', track: 'midi2', note_offset: 12 }],
    drum_binding: [1, 2, 5, 11],
    condense_drums: true,
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
    const roster = await fetchSongsterrTracks('8562');
    console.log(`s8562: "${roster.title}" by ${roster.artist}, revision ${roster.revisionId}`);
    if (roster.revisionId === 6899599) ok('revision gate: 6899599 == the plan pin (every window letter is revision-specific)');
    else fail(`REVISION MOVED: ${roster.revisionId} != 6899599 — STOP, the plan is measured on 6899599`);
    writeFileSync(`${ROOT}/samples/_scratch/clint-exec-${phase}.log.json`,
      JSON.stringify({ revisionId: roster.revisionId, title: roster.title, artist: roster.artist }, null, 2));
    console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: ROOT });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'clint-exec', version: '1' }, { capabilities: {} });
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
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 27, ncs_template: TEMPLATE,
        project_name: 'ClintArgLivenessProbe0123456789AB', bpm: 85, dry_run: true,
        voices: { kick: 'x...x...x...x...' },
      });
      if (probe.err && probe.text.includes('32')) ok('arg-liveness: 33-char project_name refused naming the 32 limit (server is fresh, no silent arg-strip)');
      else fail(`arg-liveness probe: err=${probe.err} text=${probe.text.slice(0, 240)} — STALE SERVER, STOP`);

      for (const st of STAGED) {
        const r = await call(`dryrun-${st.slot}`, 'apply_pattern', { ...applyArgs(st.slot), dry_run: true }, 180_000);
        if (r.err) { fail(`slot ${st.slot} dry-run ERROR: ${r.text.slice(0, 500)}`); continue; }
        const t2 = r.text;
        const expectNote = new Set<string>();
        let hasCrash = false;
        for (const sec of st.sections) {
          for (const v of Object.keys(sec.voices)) {
            if (['synth1', 'synth2', 'midi1'].includes(v)) expectNote.add(v);
            if (v === 'crash') hasCrash = true;
          }
        }
        const trackLine = (/"?Tracks: ([^.]*)\./.exec(t2)?.[1]) ?? '';
        const advance = st.layout === 'scenes'
          ? (st.slot === 31
            ? t2.includes('4 scene steps (patterns 1-2 → patterns 1-6 → patterns 5-6 → patterns 5-8)')
            : t2.includes('4 scene steps (patterns 1-2 → patterns 1-6 → pattern 5 → pattern 7)'))
          : t2.includes(`patterns 1..${st.order.length} auto-advance via the pattern chain`);
        const checks: Array<[string, boolean]> = [
          ['dry_run status', /dry.?run/i.test(t2)],
          [`name "${st.project_name}"`, t2.includes(st.project_name)],
          ['colour Lime', /lime/i.test(t2)],
          ['bpm 85', /\b85\b/.test(t2)],
          ['synth levels 0/0 silent', /Synth 1=0 \(silent\), Synth 2=0 \(silent\)/i.test(t2)],
          ['drum levels 0 x4', /Drum 1=0 \(silent\), Drum 2=0 \(silent\), Drum 3=0 \(silent\), Drum 4=0 \(silent\)/i.test(t2)],
          ['midi2 external route', /midi2/i.test(t2)],
          ['condense acknowledged', /[Cc]ondensed the drum part onto the 4 internal drum tracks/.test(t2)],
          [`advance layout (${st.layout})`, advance],
          [`targets Project ${st.slot}`, new RegExp(`shown as .{0,2}Project ${st.slot}`).test(t2)],
          // Track roster is CONTENT-derived, not a fixed four: the Intro and
          // Chorus 1 carry no strings (they enter m24), Solo 3 carries neither
          // strings nor a crash, so midi1 / Drum4 are legitimately absent there.
          [`note tracks == staged (${[...expectNote].sort().join('+')})`,
            ['synth1', 'synth2', 'midi1'].every((tr) => (expectNote.has(tr) ? new RegExp(`\\b${tr}\\b`).test(trackLine) : !new RegExp(`\\b${tr}\\b`).test(trackLine)))
            && /\bmidi2\b/.test(trackLine)],
          [`Drum4 present iff the project has a crash (${hasCrash})`, /Drum4/.test(trackLine) === hasCrash],
          ['Drum1-3 present', /Drum1/.test(trackLine) && /Drum2/.test(trackLine) && /Drum3/.test(trackLine)],
        ];
        const bad = checks.filter(([, v]) => !v);
        if (bad.length === 0) ok(`slot ${st.slot} "${st.project_name}" dry-run receipt clean (${st.order.length} plays, ${st.sections.length} stored patterns, ${st.layout})`);
        else fail(`slot ${st.slot} dry-run receipt missing: ${bad.map(([n]) => n).join(', ')} :: ${t2.slice(0, 700)}`);
        if (st.slot === 27) console.log(`  [slot 27 receipt] ${t2.slice(0, 1400)}`);
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
        const wantIn = PREMISE_OCCUPIED.filter((s) => s <= PLAN_WINDOW_MAX);
        const gotIn = [...bySlot.keys()].filter((s) => s <= PLAN_WINDOW_MAX).sort((a, b) => a - b);
        const good = JSON.stringify(gotIn) === JSON.stringify(wantIn)
          && wantIn.every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''));
        if (good) ok('pack5 slots 1-40 EXACT per premise: Stranglehold 1-6, 7-8 EMPTY, Amber 9-12, 13 EMPTY, CaughtGlim 14-17, 18 EMPTY, IBelieve 19-25, 26 EMPTY, ClintEastwood 27-34, Breakdown 35-39, 40 EMPTY');
        else fail(`PACK 5 slots 1-40 DO NOT MATCH PREMISE (got [${gotIn.join(',')}], want [${wantIn.join(',')}]) — STOP, the card moved`);
        const beyond = [...bySlot.keys()].filter((s) => s > PLAN_WINDOW_MAX).sort((a, b) => a - b);
        const wantBeyond = PREMISE_OCCUPIED.filter((s) => s > PLAN_WINDOW_MAX);
        console.log(`  beyond the plan window (41-64), observed [${beyond.join(',')}] vs expected [${wantBeyond.join(',')}]${JSON.stringify(beyond) === JSON.stringify(wantBeyond) ? ' — matches (Sugar 46-53, Offering 57-63)' : ' — DIFFERS, report only'}`);
      }
      const smp = await call('list_samples-pack5', 'list_samples', { port: PORT, pack: PACK }, 120_000);
      if (smp.err) fail(`list_samples pack5 error: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`pack5 pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ') || '(none)'}`);
        const clash = names.filter((x) => [1, 2, 5, 11].includes(x.slot));
        if (clash.length === 0) ok('pack5 pool: seed targets wire 1/2/5/11 are all EMPTY (the lone 03_PCM.wav sits at wire 3 and is untouched)');
        else fail(`pool seed targets occupied: ${clash.map((x) => `${x.slot}:${x.name}`).join(', ')} — re-read the seed plan before Phase 1b`);
      }
      // ORACLE IDENTITY GATE (plan: mismatch = STOP).
      const first = await call('backup-preauthor-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 27, to: 34, pack: PACK,
        directory: 'samples/circuit-ncs/clint-preauthor-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, campaign standing authorization): ${first.text.slice(0, 200).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      const swp = await call('backup-preauthor', 'backup_device', {
        port: PORT, scope: 'stored', from: 27, to: 34, pack: PACK,
        directory: 'samples/circuit-ncs/clint-preauthor-2026-07-30', acknowledge_duration: true,
      }, 600_000);
      console.log(`preauthor sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) { fail(`preauthor sweep ERROR: ${swp.text.slice(0, 400)}`); return; }
      const pre = loadBackupDir(PREAUTHOR_DIR);
      let identical = 0;
      for (let slot = 27; slot <= 34; slot++) {
        const a = pre.get(slot);
        const b = readFileSync(`${ORACLE_DIR}/proj${slot}__${slot - 1}_SESSION.ncs`);
        if (a !== undefined && a.equals(b)) { identical++; continue; }
        fail(`ORACLE IDENTITY GATE: slot ${slot} ${a === undefined ? 'not captured' : 'DIFFERS from card-backup-2026-07-29'} — THE CARD MOVED, STOP`);
      }
      if (identical === 8) ok('ORACLE IDENTITY GATE: all eight slots 27-34 byte-identical to card-backup-2026-07-29 (nothing has touched Clint since the oracle)');
    } else if (phase === 'seed') {
      // Prefix-aligned seed: each file lands at the wire slot its NN prefix names.
      const FILES: Array<[string, number, string, number]> = [
        ['samples/_scratch/smooth-seed-kit/01_stoken_4_02_kick2.wav', 2, '01_stoken_4_02_kick2.wav', 1],
        ['samples/_scratch/smooth-seed-kit/02_stoken_4_03_snr.wav', 3, '02_stoken_4_03_snr.wav', 2],
        ['samples/_scratch/smooth-seed-kit/05_stoken_4_06_hatC.wav', 6, '05_stoken_4_06_hatC.wav', 5],
        ['samples/_scratch/smooth-seed-kit/11_stoken_4_12_ride.wav', 12, '11_stoken_4_12_ride.wav', 11],
      ];
      for (const [file, deviceSlot, name, wire] of FILES) {
        const t0 = Date.now();
        const r = await call(`upload-${name}`, 'upload_sample', {
          port: PORT, file, slot: deviceSlot, name, pack: PACK, confirm_overwrite: true,
        }, 300_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) { fail(`${name} -> device slot ${deviceSlot} ERROR (${secs} s): ${r.text.slice(0, 300)}`); break; }
        ok(`${name} -> addressed device slot ${deviceSlot}, expected to register at wire ${wire} (NN prefix) in ${secs} s`);
      }
      console.log('settling 12 s for the pack manifest flush...');
      await sleep(12_000);
      const smp = await call('list_samples-after', 'list_samples', { port: PORT, pack: PACK }, 120_000);
      if (smp.err) fail(`post-seed list_samples error: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { occupied?: number; slots?: Array<{ slot: number; name?: string }> };
        const names = (parsed.slots ?? []).filter((x) => x.name !== undefined);
        console.log(`post-seed pool occupied ${parsed.occupied}: ${names.map((x) => `${x.slot}:${x.name}`).join(', ')}`);
        const want: Array<[number, string]> = [
          [1, '01_stoken_4_02_kick2'], [2, '02_stoken_4_03_snr'], [5, '05_stoken_4_06_hatC'], [11, '11_stoken_4_12_ride'],
        ];
        const seeded = want.every(([s, n]) => (names.find((x) => x.slot === s)?.name ?? '').includes(n));
        const kept = (names.find((x) => x.slot === 3)?.name ?? '').includes('03_PCM');
        if (seeded && kept) ok('pool wire 1/2/5/11 = kick2 / snr / hatC / ride -> drum_binding [1,2,5,11]; the pre-existing 03_PCM.wav at wire 3 is intact');
        else fail(`post-seed pool wrong: seeded=${seeded} 03_PCM-intact=${kept}`);
      }
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
        port: PORT, scope: 'stored', from: 27, to: 34, pack: PACK,
        directory: 'samples/circuit-ncs/clint-authored-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, campaign standing authorization): ${first.text.slice(0, 200).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      const swp = await call('backup-authored', 'backup_device', {
        port: PORT, scope: 'stored', from: 27, to: 34, pack: PACK,
        directory: 'samples/circuit-ncs/clint-authored-2026-07-30', acknowledge_duration: true,
      }, 600_000);
      console.log(`authored sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) fail(`authored sweep ERROR: ${swp.text.slice(0, 400)}`);
      else ok('authored sweep 27-34 -> clint-authored-2026-07-30');
      for (const [slot, label] of [
        [9, 'Amber 01 Intro (levels-era canonical)'],
        [35, 'Breakdown P1 (the slot immediately after the build)'],
        [46, 'Sugar 1 IntroVrs (the concurrent build)'],
      ] as Array<[number, string]>) {
        const nb = await call(`backup-neighbour-${slot}`, 'backup_device', {
          port: PORT, scope: 'stored', from: slot, to: slot, pack: PACK,
          directory: 'samples/circuit-ncs/clint-neighbour-2026-07-30', acknowledge_duration: true,
        }, 180_000);
        if (nb.err) fail(`neighbour ${slot} backup ERROR: ${nb.text.slice(0, 300)}`);
        else ok(`neighbour slot ${slot} (${label}) captured`);
      }
    } else if (phase === 'scan') {
      const AFTER_NAMES = new Map(STAGED.map((s) => [s.slot, s.project_name]));
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
          && [...AFTER_NAMES.keys()].every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''));
        if (good) ok(`final scan ${i}: the eight Clint slots 27-34 present, occupancy unchanged everywhere else (${PREMISE_OCCUPIED.length} occupied)`);
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
    writeFileSync(`${ROOT}/samples/_scratch/clint-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
