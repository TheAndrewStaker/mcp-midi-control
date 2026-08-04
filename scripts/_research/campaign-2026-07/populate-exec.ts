/**
 * POPULATE pass, 2026-07-30: give Amber / Stranglehold / Sugar 2-7 the CONDENSED
 * four-voice copy of their own MIDI 2 drum part on the Circuit's internal drum
 * tracks — populated, bound [1,2,5,11], stored SILENT (all six levels 0).
 *
 * The maintainer's standing instruction: "the whole point of the drums is to be
 * a copy of what is on MIDI two, but it's only four voices, so it must be
 * compressed or condensed using our functionality." Never invent drums where the
 * source has none — hence Sugar 1 (46) and Sugar 8 (53) are NOT in this run;
 * their source is drumless and they stay untouched (they double as neighbour
 * witnesses instead).
 *
 * METHOD: re-author each project exactly as its own plan specifies, UNCHANGED in
 * every other respect (same source + revision pin, same part set, names, colours,
 * tempos, scene/chain shapes, the same external_targets MIDI 2 leg), adding
 * `condense_drums: true` + `drum_binding: [1,2,5,11]`. The two arguments COMPOSE
 * as of b391cba (verified against THIS tree before staging, see the run log), so
 * the binding is restated in the same call and the 2026-07-30 binding pass is
 * carried forward rather than re-patched afterwards.
 *
 * Payload provenance:
 *   Stranglehold  samples/_scratch/stranglehold-staged.json  (2026-07-30 build)
 *   Sugar         samples/_scratch/sugar-staged.json         (2026-07-30 build)
 *   Amber         samples/_scratch/amber-staged.json         (rebuilt + PROVED
 *                 byte-exact against the canonical card by amber-stage.ts; the
 *                 2026-07-29 Amber build predates the staged-JSON convention)
 *
 * Phases (CLI arg):
 *   dryrun  - arg-liveness probe (33-char project_name must be refused naming
 *             the 32 limit) + 16 apply_pattern dry-runs with receipt checks:
 *             the condensed layer NAMED, drum levels 0/0/0/0, mixer six-silent,
 *             Drum1..4 in the written tracks, name / colour / bpm / external
 *             route, and the SAME chain / scene shape the canonical holds.
 *   phase1  - list_midi_ports / list_packs / list_samples pack5 (the binding's
 *             pool precondition: wire 1/2/5/11 must be kick2/snr/hatC/ride) /
 *             scan pack 5 vs the premise / ORACLE IDENTITY GATE: download the
 *             16 targets + 6 witnesses and byte-compare all 22 against the
 *             newest canonical (bindings-2026-07-30/verify). Any diff = STOP.
 *   write   - 16 apply_pattern ncs_upload writes, confirm_overwrite:true
 *             (pre-authorized: identity-gated above) + backup_first default
 *             true. Settle 10 s at the end.
 *   backup  - authored sweep of the 16 -> populate-authored-2026-07-30/, plus
 *             the 6 untouched witnesses -> populate-neighbour-2026-07-30/.
 *   scan    - final scan_locations pack5 x2 with a settle between.
 *
 * Receipts land in samples/_scratch/populate-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/populate-exec.ts <phase>
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
const CANON_DIR = `${ROOT}/samples/circuit-ncs/bindings-2026-07-30/verify`;
const PREAUTHOR_DIR = `${ROOT}/samples/circuit-ncs/populate-preauthor-2026-07-30`;

/** The canonical binding every project on this card carries (2026-07-30 pass). */
export const BINDING = [1, 2, 5, 11];

interface StagedSection { name: string; steps?: number; voices: Record<string, string> }
interface StagedProject { slot: number; project_name: string; order: string[]; sections: StagedSection[] }
const load = (f: string): StagedProject[] => JSON.parse(readFileSync(`${ROOT}/samples/_scratch/${f}`, 'utf8')) as StagedProject[];

interface SongSpec {
  song: string; colour: string; bpm: number; slots: number[]; staged: StagedProject[];
}
const SONGS: SongSpec[] = [
  { song: 'Amber', colour: 'Purple', bpm: 83, slots: [9, 10, 11, 12], staged: load('amber-staged.json') },
  { song: 'Stranglehold', colour: 'Peach', bpm: 72, slots: [1, 2, 3, 4, 5, 6], staged: load('stranglehold-staged.json') },
  // Sugar 1 (46) and Sugar 8 (53) are DRUMLESS IN SOURCE and are deliberately
  // excluded: populating them would invent content the record does not have.
  { song: 'Sugar', colour: 'Khaki', bpm: 122, slots: [47, 48, 49, 50, 51, 52], staged: load('sugar-staged.json') },
];

/** Every target, in write order (song by song, slot ascending). */
const TARGETS = SONGS.flatMap((s) => s.slots.map((slot) => ({ ...s, slot, st: s.staged.find((x) => x.slot === slot)! })));
for (const t of TARGETS) if (t.st === undefined) throw new Error(`no staged payload for ${t.song} slot ${t.slot}`);

/**
 * Untouched witnesses, one per neighbouring song block plus Sugar's own two
 * drumless siblings (the strongest witnesses: same song, same write session,
 * deliberately not in the target set).
 */
const WITNESSES = [46, 53, 14, 27, 35, 57];

/** Contiguous download bands covering every target + witness (backup_device takes from/to). */
const BANDS: Array<[number, number]> = [[1, 17], [27, 27], [35, 35], [46, 53], [57, 57]];

const phase = process.argv[2];
if (!phase) { console.error('usage: populate-exec.ts <dryrun|phase1|write|backup|scan>'); process.exit(2); }

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
 * Pack 5 occupancy premise, as the 2026-07-30 binding pass left it (its own
 * scan is the canonical: 1-6 Stranglehold, 9-12 Amber, 14-17 CaughtGlim, 19-25
 * IBelieve, 27-34 Clint, 35-39 Breakdown, 46-53 Sugar, 57-63 Offering).
 */
const PREMISE_OCCUPIED = [
  1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 14, 15, 16, 17,
  19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 36, 37, 38, 39, 46, 47, 48, 49, 50, 51, 52, 53,
  57, 58, 59, 60, 61, 62, 63,
];

function applyArgs(t: (typeof TARGETS)[number]): Record<string, unknown> {
  return {
    port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: t.slot,
    ncs_template: TEMPLATE,
    project_name: t.st.project_name, colour: t.colour, bpm: t.bpm,
    // UNIVERSAL STORED-SILENT, all six tracks. The drum keys are passed
    // explicitly as well as being condense_drums' own default, so a section
    // that turns out to carry no drums still stores 0 rather than the
    // template's 100 (the defect the 2026-07-30 levels pass had to repair).
    mixer_levels: { synth1: 0, synth2: 0, drum1: 0, drum2: 0, drum3: 0, drum4: 0 },
    // UNCHANGED: the real kit still plays the SPD-SX on MIDI 2 at the oracle's
    // own +12 register. The condensed copy is additional and silent.
    external_targets: [{ device: 'spd-sx', track: 'midi2', note_offset: 12 }],
    arrangement: { sections: t.st.sections, order: t.st.order },
    // THE POPULATE ITSELF, plus the binding restated in the same call.
    condense_drums: true,
    drum_binding: BINDING,
    confirm_overwrite: true,
  };
}

const loadBackupDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /pack5-project(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(path.join(dir, f)));
  }
  return m;
};

async function main(): Promise<void> {
  const t = new StdioClientTransport({ command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: ROOT });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'populate-exec', version: '1' }, { capabilities: {} });
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
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 9, ncs_template: TEMPLATE,
        project_name: 'PopulateArgLivenessProbe0123456789', bpm: 83, dry_run: true,
        voices: { kick: 'x...x...' },
      });
      if (probe.err && probe.text.includes('32')) ok('arg-liveness: an over-long project_name was refused naming the 32 limit (server fresh, no silent arg-strip)');
      else fail(`arg-liveness probe: err=${probe.err} text=${probe.text.slice(0, 240)} — STALE SERVER, STOP`);

      for (const tg of TARGETS) {
        const r = await call(`dryrun-${tg.slot}`, 'apply_pattern', { ...applyArgs(tg), dry_run: true }, 300_000);
        if (r.err) { fail(`${tg.song} slot ${tg.slot} dry-run ERROR: ${r.text.slice(0, 600)}`); continue; }
        const x = r.text;
        const trackLine = (/Tracks(?: written)?: ([^.]*)\./.exec(x)?.[1]) ?? '';
        const plays = tg.st.order.length;
        const checks: Array<[string, boolean]> = [
          ['dry_run status', /dry.?run/i.test(x)],
          [`name "${tg.st.project_name}"`, x.includes(tg.st.project_name)],
          [`colour ${tg.colour}`, new RegExp(`Pad colour stored as ${tg.colour}`, 'i').test(x)],
          [`bpm ${tg.bpm}`, new RegExp(`Tempo stored at ${tg.bpm} BPM`).test(x)],
          // THE POPULATE: the receipt must NAME the condensed layer.
          ['condensed layer named', /Condensed the drum part onto the 4 internal drum tracks \(kick \/ snare \/ closed_hat \/ ride\)/.test(x)],
          ['condensed in every section that has drums', /in (\d+) of (\d+) section\(s\)/.test(x)],
          ['drum levels stored 0/0/0/0', /Drum-track levels stored at 0\/0\/0\/0/.test(x)],
          ['mixer six-silent', /Synth 1=0 \(silent\), Synth 2=0 \(silent\), Drum 1=0 \(silent\), Drum 2=0 \(silent\), Drum 3=0 \(silent\), Drum 4=0 \(silent\)/.test(x)],
          // At least one internal drum track must be written. NOT all four: a
          // song whose kit is only kick+snare condenses onto Drum1+Drum2 and
          // leaves 3/4 empty, which is the honest answer, not a gap. Which
          // tracks each project lands on is RECORDED here and CHECKED for real
          // in Phase 4, where the stored steps are compared against a fresh
          // condensation of that project's own midi2 content.
          ['at least one internal drum track written', /\bDrum[1-4]\b/.test(trackLine)],
          ['midi2 external route to spd-sx', /midi2/.test(trackLine) && /SPD-SX via the host's midi2 track \(external only\)/.test(x)],
          [`targets Project ${tg.slot}`, new RegExp(`shown as .{0,2}Project ${tg.slot}`).test(x)],
          ['no also_internal doubling', !/also_internal/.test(x)],
        ];
        // Layout: the canonical's own shape, restated so a re-author can never
        // silently re-chop the song.
        const wantChain = plays <= 8;
        checks.push([
          wantChain ? `plain chain 1..${plays}` : 'scene layout',
          wantChain ? x.includes(`patterns 1..${plays} auto-advance via the pattern chain`) : /scene steps \(/.test(x),
        ]);
        // midi1 must survive wherever the staged payload has it (Stranglehold's
        // hand-authored drone; Amber's hand-authored chord pad; Sugar's harp).
        const hasM1 = tg.st.sections.some((s) => s.voices.midi1 !== undefined);
        if (hasM1) checks.push(['midi1 written (hand layer survives)', /\bmidi1\b/.test(trackLine)]);
        const hasSynth = tg.st.sections.some((s) => s.voices.synth1 !== undefined || s.voices.synth2 !== undefined);
        if (hasSynth) checks.push(['synth track(s) written', /synth[12]/.test(trackLine)]);

        const bad = checks.filter(([, v]) => !v);
        const condensedIn = /in (\d+) of (\d+) section\(s\)/.exec(x);
        if (bad.length === 0) {
          ok(`${tg.song} slot ${tg.slot} "${tg.st.project_name}" dry-run clean (${plays} plays, ${tg.st.sections.length} sections, condensed ${condensedIn?.[1]}/${condensedIn?.[2]}, tracks: ${trackLine})`);
        } else {
          fail(`${tg.song} slot ${tg.slot} dry-run missing: ${bad.map(([n]) => n).join(', ')}\n   receipt: ${x.slice(0, 1200)}`);
        }
      }
    } else if (phase === 'phase1') {
      const ports = await call('list_midi_ports', 'list_midi_ports', { pattern: ['circuit', 'novation'] });
      if (!ports.err && /circuit/i.test(ports.text)) ok('Circuit visible in MIDI ports');
      else fail(`Circuit not visible: ${ports.text.slice(0, 300)}`);
      const packs = await call('list_packs', 'list_packs', { port: PORT });
      if (!packs.err) ok('list_packs answered');
      else fail(`list_packs: ${packs.text.slice(0, 400)}`);

      // POOL PRECONDITION: the binding [1,2,5,11] is only meaningful if pack 5
      // actually holds kick2 / snr / hatC / ride at those wire slots, and the
      // condensed layer is only audible-on-demand if they are the right pieces.
      const smp = await call('list_samples-pack5', 'list_samples', { port: PORT, pack: PACK }, 120_000);
      if (smp.err) fail(`list_samples pack5 ERROR: ${smp.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(smp.text) as { slots?: Array<{ slot: number; name?: string }> };
        const bySlot = new Map((parsed.slots ?? []).filter((s) => s.name !== undefined).map((s) => [s.slot, s.name!]));
        console.log(`pack5 pool: ${[...bySlot].map(([s, n]) => `${s}:${n}`).join(', ')}`);
        const want: Array<[number, RegExp]> = [[1, /kick/i], [2, /snr|snare/i], [5, /hat/i], [11, /ride/i]];
        const bad = want.filter(([s, re]) => !re.test(bySlot.get(s) ?? ''));
        if (bad.length === 0) ok('pool precondition: wire 1/2/5/11 = kick2 / snr / hatC / ride, so binding [1,2,5,11] resolves to the four roles');
        else fail(`POOL PRECONDITION FAILED at wire slot(s) ${bad.map(([s]) => s).join(',')} — the condensed kit would play the wrong pieces, STOP`);
      }

      const s5 = await call('scan-pack5', 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 180_000);
      if (s5.err) fail(`pack5 scan error: ${s5.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => Number(x.location)).sort((a, b) => a - b);
        console.log(`pack5 occupied (${occ.length}): [${occ.join(',')}]`);
        if (JSON.stringify(occ) === JSON.stringify(PREMISE_OCCUPIED)) ok('pack5 occupancy EXACT per the binding-pass premise');
        else fail(`PACK 5 OCCUPANCY MOVED (got [${occ.join(',')}]) — STOP, re-backup and re-plan`);
      }

      // ORACLE IDENTITY GATE: every target AND every witness must still be
      // byte-identical to the newest canonical before a single byte is written.
      const all = [...TARGETS.map((x) => x.slot), ...WITNESSES].sort((a, b) => a - b);
      // backup_device sweeps a CONTIGUOUS range, so the 16 targets + 6 witnesses
      // are covered by five bands and only the 22 are compared.
      const first = await call('backup-preauthor-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 17, pack: PACK,
        directory: 'samples/circuit-ncs/populate-preauthor-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, campaign standing authorization): ${first.text.slice(0, 200).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      for (const [from, to] of BANDS) {
        const swp = await call(`backup-preauthor-${from}-${to}`, 'backup_device', {
          port: PORT, scope: 'stored', from, to, pack: PACK,
          directory: 'samples/circuit-ncs/populate-preauthor-2026-07-30', acknowledge_duration: true,
        }, 600_000);
        if (swp.err) { fail(`preauthor sweep ${from}-${to} ERROR: ${swp.text.slice(0, 400)}`); return; }
      }
      console.log(`preauthor sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const pre = loadBackupDir(PREAUTHOR_DIR);
      const canon = loadBackupDir(CANON_DIR);
      let identical = 0;
      for (const slot of all) {
        const a = pre.get(slot); const b = canon.get(slot);
        if (b === undefined) { fail(`no canonical capture for slot ${slot} in bindings-2026-07-30/verify`); continue; }
        if (a !== undefined && a.equals(b)) { identical++; continue; }
        fail(`ORACLE IDENTITY GATE: slot ${slot} ${a === undefined ? 'not captured' : 'DIFFERS from the 2026-07-30 binding-pass canonical'} — THE CARD MOVED, STOP`);
      }
      if (identical === all.length) ok(`ORACLE IDENTITY GATE: all ${identical} slots (16 targets + 6 witnesses) byte-identical to bindings-2026-07-30/verify`);
    } else if (phase === 'write') {
      for (const tg of TARGETS) {
        const t0 = Date.now();
        const r = await call(`write-${tg.slot}`, 'apply_pattern', applyArgs(tg), 300_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) {
          fail(`${tg.song} slot ${tg.slot} WRITE ERROR (${secs} s): ${r.text.slice(0, 600)}`);
          console.log('ABORTING remaining writes.');
          break;
        }
        const acked = /all frames acked/i.test(r.text) && /uploaded/i.test(r.text);
        const condensed = /Condensed the drum part/.test(r.text);
        const backed = /back(ed)? up/i.test(r.text);
        if (acked && condensed) ok(`${tg.song} slot ${tg.slot} "${tg.st.project_name}" written with the condensed layer (${secs} s)${backed ? ', pre-write backup taken' : ''}`);
        else fail(`${tg.song} slot ${tg.slot} receipt lacks ${acked ? 'the condensed-layer line' : 'the acked-upload marker'}: ${r.text.slice(0, 400)}`);
      }
      console.log('settling 10 s after the final write...');
      await sleep(10_000);
    } else if (phase === 'backup') {
      const gate = await call('backup-authored-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 1, to: 17, pack: PACK,
        directory: 'samples/circuit-ncs/populate-authored-2026-07-30',
      }, 60_000);
      if (gate.err) console.log(`duration gate (expected, campaign standing authorization): ${gate.text.slice(0, 200).replace(/\n/g, ' ')}`);
      for (const [from, to] of BANDS) {
        const swp = await call(`backup-authored-${from}-${to}`, 'backup_device', {
          port: PORT, scope: 'stored', from, to, pack: PACK,
          directory: 'samples/circuit-ncs/populate-authored-2026-07-30', acknowledge_duration: true,
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
        console.log(`scan ${i} occupied (${occ.length})`);
        const slots = occ.map(([l]) => l).sort((a, b) => a - b);
        if (JSON.stringify(slots) === JSON.stringify(PREMISE_OCCUPIED)) ok(`final scan ${i}: occupancy unchanged (${slots.length} occupied, zero deletes, zero new slots)`);
        else fail(`final scan ${i} occupancy CHANGED: [${slots.join(',')}]`);
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
    writeFileSync(`${ROOT}/samples/_scratch/populate-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
