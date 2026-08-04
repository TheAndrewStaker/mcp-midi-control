/**
 * Sugar re-author device-window driver (plan §4 Phases 0.1/0.3/0.4/1/2/3/4,
 * Pack 5 slots 46-53 in place + delete 54-55). Drives the PRODUCT MCP server
 * (packages/server-all/dist) over StdioClientTransport — the sanctioned
 * "drive MCP tools yourself" pattern — so the arrangement payloads flow from
 * sugar-staged.json without a chat-context copy, and ONE process holds the
 * Circuit port per run. Mirror of lovesong-exec.ts.
 *
 * Phases (CLI arg):
 *   gate    - the ONE live Songsterr fetch: roster of s560358 must report
 *             revision 3001145 (a different id = STOP). No device, 1 request.
 *   dryrun  - arg-liveness probe (33-char name refusal naming the 32 limit)
 *             + 8 apply_pattern dry-runs with receipt checks (names / Khaki /
 *             122 / mixer 0-silent x6 / midi2 route / NO condense / layout:
 *             scenes on 46+53, chain 1..8 on the rest). No device contact.
 *   phase1  - list_midi_ports / list_packs / scan pack5 1-64 vs the §0g
 *             premise (dir-name lens NN_SESSION) / ORACLE IDENTITY GATE:
 *             backup 46-55 -> sugar-preauthor-2026-07-30 and byte-compare all
 *             ten against card-backup-2026-07-29/pack5 (any diff = STOP).
 *   write   - 8 apply_pattern ncs_upload writes slots 46-53 WITH
 *             confirm_overwrite:true (pre-authorized by the plan ONLY for
 *             46-53: identity-gated + backup_first default-true). Settle 10 s.
 *   delete  - refusal-first delete of 54-55: call WITHOUT confirm_delete,
 *             assert the refusal names Project 54 ("53_SESSION") + Project 55
 *             ("54_SESSION") — the pack's DIRECTORY names; the STORED names
 *             ("Sugar 9/10" / "Sugar 10/10") are proven by the identity gate's
 *             bytes (0x10) and re-checked here from the preauthor capture —
 *             then re-call with confirm_delete:true. Expect per-slot ok /
 *             gone_by_query / gone_by_directory / matches_free_control.
 *   backup  - authored sweep 46-53 -> sugar-authored-2026-07-30; neighbours
 *             9 & 12 (Amber) / 14 (CaughtGlim) / 39 (Breakdown) / 57
 *             (Offering) -> sugar-neighbour-2026-07-30.
 *   scan    - final scan_locations pack5 x2 with a 10 s settle between:
 *             46-53 occupied, 54-55 EMPTY, everything else per premise.
 *
 * Full receipts land in samples/_scratch/sugar-exec-<phase>.log.json.
 * Run: npx tsx samples/_scratch/sugar-exec.ts <phase>
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
const PREAUTHOR_DIR = `${ROOT}/samples/circuit-ncs/sugar-preauthor-2026-07-30`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/sugar-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; layout: string; order: string[];
  sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
}>;

const phase = process.argv[2];
if (!phase) { console.error('usage: sugar-exec.ts <gate|dryrun|phase1|write|delete|backup|scan>'); process.exit(2); }

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

// Pack 5 occupancy premise (§0g / plan §4 step 6), directory-name lens:
// every occupied slot's directory entry is `${slot-1}_SESSION`.
const PREMISE_OCCUPIED = [
  1, 2, 3, 4, 5, 6,                     // Stranglehold
  9, 10, 11, 12,                        // Amber
  14, 15, 16, 17,                       // CaughtGlim
  19, 20, 21, 22, 23, 24, 25,           // IBelieve
  27, 28, 29, 30, 31, 32, 33, 34,       // ClintEastwood (old build; Clint plan NOT executed)
  35, 36, 37, 38, 39,                   // Breakdown
  46, 47, 48, 49, 50, 51, 52, 53, 54, 55, // Sugar 1/10..10/10
  57, 58, 59, 60, 61, 62, 63,           // Offering
];
const AFTER_OCCUPIED = PREMISE_OCCUPIED.filter((s) => s !== 54 && s !== 55);

const KIT_VOICES = ['kick', 'snare', 'hat', 'openhat', 'crash', 'ride', 'tom'];
const hasKit = (st: (typeof STAGED)[number]): boolean =>
  st.sections.some((s) => Object.keys(s.voices).some((v) => KIT_VOICES.includes(v)));

function applyArgs(slot: number): Record<string, unknown> {
  const st = STAGED.find((s) => s.slot === slot)!;
  return {
    port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: slot,
    ncs_template: TEMPLATE,
    project_name: st.project_name, colour: 'Khaki', bpm: 122,
    // §1: stored-silent synths (this song's own 2026-07-27 rule, predating the
    // universal default) + internal drum levels 0 x4 (standing convention,
    // §3 row 15 / §4 step 12 — passed explicitly; no condense, so the
    // template's 100s would otherwise survive).
    mixer_levels: { synth1: 0, synth2: 0, drum1: 0, drum2: 0, drum3: 0, drum4: 0 },
    // P1 (46) and P8 (53) carry NO kit voices (drums are silent m1-24 and
    // m129-148 in the source; oracle midi2 empty there too, §3 row 13). The
    // dispatcher refuses external_targets with zero mappable voices, so the
    // route is passed only where drums exist — same wire result.
    ...(hasKit(st) ? { external_targets: [{ device: 'spd-sx', track: 'midi2', note_offset: 12 }] } : {}),
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
const embeddedName = (buf: Buffer): string => buf.subarray(0x10, 0x30).toString('latin1').replace(/[\s\0]+$/g, '');

async function main(): Promise<void> {
  if (phase === 'gate') {
    // The ONE live fetch (plan §4 step 1). fetchSongsterrTracks is the same
    // roster request import_songsterr opens with — a single HTTP call, no
    // part downloads, no device.
    const { fetchSongsterrTracks } = await import('../../packages/core/src/protocol-generic/patterns/songsterrFetch.js');
    const roster = await fetchSongsterrTracks('560358');
    console.log(`s560358: "${roster.title}" by ${roster.artist}, revision ${roster.revisionId}`);
    if (roster.revisionId === 3001145) ok('revision gate: 3001145 == the pin (sugar.md + this plan\'s fresh fetch)');
    else fail(`REVISION MOVED: ${roster.revisionId} != 3001145 — STOP, a re-pin voids the plan`);
    writeFileSync(`${ROOT}/samples/_scratch/sugar-exec-${phase}.log.json`,
      JSON.stringify({ revisionId: roster.revisionId, title: roster.title, artist: roster.artist }, null, 2));
    console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
    process.exitCode = failures === 0 ? 0 : 1;
    return;
  }

  const t = new StdioClientTransport({
    command: process.execPath, args: [SERVER], stderr: 'pipe', cwd: ROOT,
  });
  if (t.stderr) t.stderr.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  const c = new Client({ name: 'sugar-exec', version: '1' }, { capabilities: {} });
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
      // Arg-liveness (the Schism silent-strip guard), through THIS server spawn.
      const probe = await call('arg-liveness', 'apply_pattern', {
        port: PORT, mode: 'ncs_upload', pack: PACK, ncs_slot: 46, ncs_template: TEMPLATE,
        project_name: 'SugarArgLivenessProbe0123456789AB', bpm: 122, dry_run: true,
        voices: { kick: 'x...x...x...x...' },
      });
      if (probe.err && probe.text.includes('32')) ok('arg-liveness: 33-char name refused naming the 32 limit (server is fresh)');
      else fail(`arg-liveness probe: err=${probe.err} text=${probe.text.slice(0, 200)} — STALE SERVER, STOP`);

      for (const st of STAGED) {
        const r = await call(`dryrun-${st.slot}`, 'apply_pattern', { ...applyArgs(st.slot), dry_run: true }, 120_000);
        if (r.err) { fail(`slot ${st.slot} dry-run ERROR: ${r.text.slice(0, 400)}`); continue; }
        const t2 = r.text;
        // The writer's greedy run-compression groups P1/P8 as TWO scene steps
        // ([1-4] then [1-8]/[1-6]): the second Stmt/OV pass and the close are
        // one ascending run. The DECODED PLAY SEQUENCE is identical to §1
        // (4+4+4 / 4+4+2 plays in order) — the plan's "-equivalent ranges"
        // clause; STOP is only >4 steps or a play-sequence mismatch.
        const advance = st.slot === 46
          ? t2.includes('2 scene steps (patterns 1-4 → patterns 1-8)')
          : st.slot === 53
            ? t2.includes('2 scene steps (patterns 1-4 → patterns 1-6)')
            : t2.includes(`patterns 1..${st.order.length} auto-advance via the pattern chain`);
        const checks: Array<[string, boolean]> = [
          ['dry_run status', /dry.?run/i.test(t2)],
          [`name "${st.project_name}"`, t2.includes(st.project_name)],
          ['colour Khaki', /khaki/i.test(t2)],
          ['bpm 122', t2.includes('122')],
          ['synth levels 0/0 silent', /Synth 1=0 \(silent\), Synth 2=0 \(silent\)/i.test(t2)],
          ['drum levels 0 x4', /Drum 1=0 \(silent\), Drum 2=0 \(silent\), Drum 3=0 \(silent\), Drum 4=0 \(silent\)/i.test(t2)],
          ['midi2 routed iff kit', hasKit(st) === /midi2/i.test(t2)],
          ['NO condense', !/condens/i.test(t2)],
          [`advance layout (${st.layout})`, advance],
          [`targets Project ${st.slot}`, new RegExp(`shown as .{0,2}Project ${st.slot}`).test(t2)],
        ];
        const bad = checks.filter(([, v]) => !v);
        if (bad.length === 0) ok(`slot ${st.slot} "${st.project_name}" dry-run receipt clean (${st.order.length} plays, ${st.sections.length} sections, ${st.layout})`);
        else fail(`slot ${st.slot} dry-run receipt missing: ${bad.map(([n]) => n).join(', ')} :: ${t2.slice(0, 300)}`);
      }
    } else if (phase === 'phase1') {
      const ports = await call('list_midi_ports', 'list_midi_ports', { pattern: ['circuit', 'novation'] });
      if (!ports.err && /circuit/i.test(ports.text)) ok('Circuit visible in MIDI ports');
      else fail(`Circuit not visible: ${ports.text.slice(0, 300)}`);
      const packs = await call('list_packs', 'list_packs', { port: PORT });
      if (!packs.err && /pack/i.test(packs.text)) ok(`list_packs answered (${packs.text.slice(0, 120).replace(/\n/g, ' ')}…)`);
      else fail(`list_packs: ${packs.text.slice(0, 300)}`);
      const s5 = await call('scan-pack5', 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 120_000);
      if (s5.err) fail(`pack5 scan error: ${s5.text.slice(0, 300)}`);
      else {
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true);
        console.log(`pack5 occupied (${occ.length}): [${occ.map((x) => `${x.location}:${x.name ?? '?'}`).join(', ')}]`);
        const bySlot = new Map(occ.map((x) => [Number(x.location), x.name ?? '']));
        const good = bySlot.size === PREMISE_OCCUPIED.length
          && PREMISE_OCCUPIED.every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''));
        if (good) ok(`pack5 premise EXACT (${PREMISE_OCCUPIED.length} occupied, dir-name lens): Stranglehold 1-6, 7-8 EMPTY, Amber 9-12, CaughtGlim 14-17, IBelieve 19-25, ClintEastwood 27-34 (old build), Breakdown 35-39, 40-45 empty, Sugar 46-55, Offering 57-63`);
        else fail('PACK 5 DOES NOT MATCH PREMISE - STOP (the card moved; re-backup, re-plan)');
      }
      // ORACLE IDENTITY GATE (plan §4 step 7): download 46-55, byte-compare.
      const first = await call('backup-preauthor-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 46, to: 55, pack: PACK,
        directory: 'samples/circuit-ncs/sugar-preauthor-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, standing authorization): ${first.text.slice(0, 220).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      const swp = await call('backup-preauthor', 'backup_device', {
        port: PORT, scope: 'stored', from: 46, to: 55, pack: PACK,
        directory: 'samples/circuit-ncs/sugar-preauthor-2026-07-30', acknowledge_duration: true,
      }, 600_000);
      console.log(`preauthor sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s (duration gate acknowledged under the campaign standing authorization)`);
      if (swp.err) { fail(`preauthor sweep ERROR: ${swp.text.slice(0, 400)}`); return; }
      const pre = loadBackupDir(PREAUTHOR_DIR);
      let identical = 0;
      for (let slot = 46; slot <= 55; slot++) {
        const a = pre.get(slot);
        const b = readFileSync(`${ORACLE_DIR}/proj${slot}__${slot - 1}_SESSION.ncs`);
        if (a !== undefined && a.equals(b)) { identical++; continue; }
        fail(`ORACLE IDENTITY GATE: slot ${slot} ${a === undefined ? 'not captured' : 'DIFFERS from card-backup-2026-07-29'} — THE CARD MOVED, STOP`);
      }
      if (identical === 10) ok('ORACLE IDENTITY GATE: all ten slots 46-55 byte-identical to card-backup-2026-07-29 (nothing touched Sugar since the oracle) — embedded names ' +
        `54="${embeddedName(pre.get(54)!)}", 55="${embeddedName(pre.get(55)!)}"`);
    } else if (phase === 'write') {
      for (const st of STAGED) {
        const t0 = Date.now();
        const r = await call(`write-${st.slot}`, 'apply_pattern', applyArgs(st.slot), 300_000);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (r.err) {
          fail(`slot ${st.slot} WRITE ERROR (${secs} s): ${r.text.slice(0, 400)}`);
          console.log('ABORTING remaining writes.');
          break;
        }
        const acked = /all frames acked/i.test(r.text) && /uploaded/i.test(r.text);
        if (acked) ok(`slot ${st.slot} "${st.project_name}" written (${secs} s)`);
        else fail(`slot ${st.slot} receipt lacks the acked-upload marker: ${r.text.slice(0, 200)}`);
      }
      console.log('settling 10 s after the final write...');
      await sleep(10_000);
    } else if (phase === 'delete') {
      // Refusal-first (plan §4 step 9). The probe's names are the pack
      // DIRECTORY names; the STORED names are proven from the identity-gated
      // preauthor bytes (0x10) right here.
      const pre = loadBackupDir(PREAUTHOR_DIR);
      const n54 = embeddedName(pre.get(54)!); const n55 = embeddedName(pre.get(55)!);
      if (n54 === 'Sugar 9/10' && n55 === 'Sugar 10/10')
        ok('stored names from the identity-gated bytes: 54="Sugar 9/10", 55="Sugar 10/10" (the plan\'s expected content, proven byte-identical to the oracle in phase1)');
      else { fail(`stored names 54="${n54}" 55="${n55}" != Sugar 9/10 / Sugar 10/10 — STOP`); return; }
      const probe = await call('delete-refusal', 'delete_project', { port: PORT, slots: [54, 55], pack: PACK }, 120_000);
      const wantRefusal = probe.err
        && probe.text.includes('PERMANENTLY DELETE')
        && probe.text.includes('Project 54 ("53_SESSION.ncs")')
        && probe.text.includes('Project 55 ("54_SESSION.ncs")');
      if (wantRefusal) ok('refusal-first: delete REFUSED naming Project 54 ("53_SESSION.ncs") + Project 55 ("54_SESSION.ncs") — the directory names of the byte-proven Sugar 9/10 + Sugar 10/10 images');
      else { fail(`refusal shape unexpected — STOP: err=${probe.err} text=${probe.text.slice(0, 400)}`); return; }
      console.log('refusal relayed. His standing form of yes covers freed-slot deletes whose content is backed up and superseded (task pre-authorization); re-calling with confirm_delete:true.');
      const del = await call('delete-confirmed', 'delete_project', {
        port: PORT, slots: [54, 55], pack: PACK, confirm_delete: true,
        directory: 'samples/circuit-ncs/sugar-predelete-2026-07-30',
      }, 300_000);
      if (del.err) { fail(`confirmed delete ERROR: ${del.text.slice(0, 400)}`); return; }
      const parsed = JSON.parse(del.text) as {
        ok?: boolean; deleted?: Array<{ slot: number; ok: boolean; name?: string; backup_path?: string; gone_by_query?: boolean; gone_by_directory?: boolean; matches_free_control?: boolean; error?: string }>;
      };
      for (const d of parsed.deleted ?? []) {
        if (d.ok === true && d.gone_by_query === true && d.gone_by_directory === true && d.matches_free_control !== false && d.backup_path)
          ok(`slot ${d.slot} ("${d.name}") erased: gone_by_query + gone_by_directory + matches_free_control, backup at ${d.backup_path}`);
        else fail(`slot ${d.slot} NOT CONFIRMED erased (${d.error ?? 'flags incomplete'}) — treat as UNKNOWN, re-READ after settle, never re-send`);
      }
      if (parsed.ok === true) ok('delete_project outcome ok:true (both slots confirmed by two oracles + free-control)');
      else fail('delete_project outcome not ok');
    } else if (phase === 'backup') {
      const first = await call('backup-authored-gate', 'backup_device', {
        port: PORT, scope: 'stored', from: 46, to: 53, pack: PACK,
        directory: 'samples/circuit-ncs/sugar-authored-2026-07-30',
      }, 60_000);
      if (first.err) console.log(`duration gate (expected, standing authorization): ${first.text.slice(0, 220).replace(/\n/g, ' ')}`);
      const t0 = Date.now();
      const swp = await call('backup-authored', 'backup_device', {
        port: PORT, scope: 'stored', from: 46, to: 53, pack: PACK,
        directory: 'samples/circuit-ncs/sugar-authored-2026-07-30', acknowledge_duration: true,
      }, 600_000);
      console.log(`authored sweep took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (swp.err) fail(`authored sweep ERROR: ${swp.text.slice(0, 400)}`);
      else ok(`authored sweep 46-53 -> sugar-authored-2026-07-30`);
      for (const [slot, label] of [[9, 'Amber 01 (levels-era canonical)'], [12, 'Amber 04'], [14, 'CaughtGlim 1'], [39, 'Breakdown P5'], [57, 'Offering 1/7 (delete-side neighbour)']] as Array<[number, string]>) {
        const nb = await call(`backup-neighbour-${slot}`, 'backup_device', {
          port: PORT, scope: 'stored', from: slot, to: slot, pack: PACK,
          directory: 'samples/circuit-ncs/sugar-neighbour-2026-07-30', acknowledge_duration: true,
        }, 120_000);
        if (nb.err) fail(`neighbour ${slot} backup ERROR: ${nb.text.slice(0, 300)}`);
        else ok(`neighbour slot ${slot} (${label}) captured`);
      }
    } else if (phase === 'scan') {
      for (let i = 1; i <= 2; i++) {
        const s5 = await call(`scan-final-${i}`, 'scan_locations', { port: PORT, pack: PACK, from: 1, to: 64 }, 120_000);
        if (s5.err) { fail(`final scan ${i} error: ${s5.text.slice(0, 300)}`); continue; }
        const parsed = JSON.parse(s5.text) as { scanned?: Array<{ location: number | string; name?: string; is_empty?: boolean }> };
        const occ = (parsed.scanned ?? []).filter((x) => x.is_empty !== true).map((x) => [Number(x.location), x.name ?? ''] as const);
        console.log(`scan ${i} occupied (${occ.length}): ${occ.map(([l, n]) => `${l}:${n}`).join(', ')}`);
        const bySlot = new Map(occ);
        const good = bySlot.size === AFTER_OCCUPIED.length
          && AFTER_OCCUPIED.every((s) => new RegExp(`^${String(s - 1).padStart(2, '0')}_SESSION`).test(bySlot.get(s) ?? ''))
          && !bySlot.has(54) && !bySlot.has(55);
        if (good) ok(`final scan ${i}: the eight Sugar slots 46-53 present, 54-55 EMPTY, everything else per the Phase 1 premise (${AFTER_OCCUPIED.length} occupied)`);
        else fail(`final scan ${i} does not match the after-state expectation`);
        if (i === 1) { console.log('settling 10 s...'); await sleep(10_000); }
      }
    } else {
      console.error(`unknown phase "${phase}"`);
      process.exitCode = 2;
      return;
    }
  } finally {
    writeFileSync(`${ROOT}/samples/_scratch/sugar-exec-${phase}.log.json`, JSON.stringify(log, null, 2));
    await c.close();
  }
  console.log(`\n${failures === 0 ? `PHASE ${phase} PASS` : `${failures} FAILURES in phase ${phase}`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('driver crashed:', e); process.exitCode = 1; });
