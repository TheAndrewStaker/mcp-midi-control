/**
 * circuit-verify-card.ts — READ-ONLY integrity check of the card against a backup.
 *
 * ## Why this exists
 *
 * On 2026-07-27 the maintainer's PC crashed minutes after a full, CRC-verified
 * card backup. No write was in flight, so the expectation is that the device is
 * byte-for-byte as we left it — but "expected" is not "checked", and we will
 * never have a cleaner baseline to check against than a manifest with a sha256
 * per file taken minutes earlier. This re-reads the card and diffs it.
 *
 * ## Read-only by construction
 *
 * Same property as `circuit-backup-card.ts`, and for the same reason: every
 * frame is OPEN_SESSION / DIR_CONTROL / QUERY_INFO / CLOSE_SESSION or a
 * READ-flavoured WRITE_INIT. It never sends WRITE_INIT-with-size, WRITE_DATA,
 * WRITE_FINISH or SET_FILENAME, and never a Program Change. It also never
 * writes into the backup directory: differing bytes go to a SEPARATE output
 * directory, so the baseline cannot be clobbered by the tool checking it.
 *
 * ## What a difference means
 *
 * A diff is not automatically damage. Known-benign: the two mixer level bytes
 * at 0x2701c / 0x2701d are recomposed from the physical fader positions
 * whenever the device hand-saves a project, so a two-byte diff at exactly those
 * offsets means someone saved, not that a file is corrupt.
 *
 * Corruption has TWO signals here, not one, and the second was missing until
 * 2026-07-29. A CRC failure means the TRANSFER was corrupt. A structure failure
 * (`checkNcsStructure`: `USER` magic plus the file's own `totalSessionSize` at
 * 0x04) means the FILE is not a project, and it is reachable with the CRC clean,
 * because the device's WRITE_FINISH CRC32 covers the encoded stream rather than
 * the decoded `.ncs`. Both are checked on every project pulled, and reported as
 * distinct findings: "could not be read back" and "reads back CRC-clean and is
 * not a project" call for opposite next actions.
 *
 *   npx tsx scripts/circuit-verify-card.ts --dirs-only     # directories only, fast
 *   npx tsx scripts/circuit-verify-card.ts                 # + every project file
 *   npx tsx scripts/circuit-verify-card.ts --samples       # + sample-pool audio
 *   npx tsx scripts/circuit-verify-card.ts --packs 2,5
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { connect, type MidiConnection } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { NCS_FILE_SIZE, checkNcsStructure, ncsStructureNote } from '../packages/circuit-tracks/src/ncs/format.js';
import { readPackDirectory } from '../packages/circuit-tracks/src/ncs/packDirectory.js';
import {
  readProjectDirectory, readSampleDirectory, readFileDirectory, buildReadFileRequest,
  SAMPLE_DIRECTORY_CONSTANTS, type DirectorySlot,
} from '../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { makeMessage, msbDeinterleave, crc32, TRANSFER_CONSTANTS } from '../packages/circuit-tracks/src/ncs/transfer.js';

const SUB = TRANSFER_CONSTANTS.SUBCMD;
const HDR_LEN = TRANSFER_CONSTANTS.HEADER.length;
const FILE_TYPE_SAMPLE = SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE;
const FILE_TYPE_PATCH = SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_PATCH;

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const DIRS_ONLY = argv.includes('--dirs-only');
const WITH_SAMPLES = argv.includes('--samples');
const PACK_SPEC = flag('--packs');
const SETTLE_MS = Number(flag('--settle') ?? '9000');
const BASE = flag('--backup') ?? 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z';
const DIFF_OUT = flag('--diff-out') ?? 'samples/circuit-ncs/verify-2026-07-27-postcrash';

/** Known-benign: the device recomposes these from the physical faders on a hand-save. */
const MIXER_LEVEL_OFFSETS = [0x2701c, 0x2701d];

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).' } as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const core = (msg: readonly number[]): number[] => {
  let b = [...msg];
  if (b[0] === 0xf0) b = b.slice(1);
  if (b[b.length - 1] === 0xf7) b = b.slice(0, -1);
  return b;
};
const nibblesToInt = (ns: readonly number[]): number => ns.reduce((a, n) => a * 16 + (n & 0xf), 0) >>> 0;

let conn: MidiConnection = undefined as unknown as MidiConnection;
const reconnect = (): MidiConnection => { conn = reconnectMidi(conn, CONNECT); return conn; };

interface Rec { file?: string; bytes?: number; sha256?: string; crc_verified?: boolean; wire_slot?: number; device_slot?: number; name?: string; embedded_name?: string; device_project?: number; directory_name?: string }
interface PackRecord { device_pack: number; wire_pack: number; pack_name: string; projects_occupied: number; projects: Rec[]; sample_pool_occupied: number; samples: Rec[]; patch_files: Rec[] }
interface Manifest { captured_at: string; card_packs: { device_pack: number; name: string }[]; packs: PackRecord[] }

/** Every finding worth a line in the final report. */
const findings: string[] = [];
const timings: { what: string; ms: number }[] = [];

// ── directory read, twice across the flush window ────────────────────

async function readDirStable(kind: 'project' | 'sample', wirePack: number): Promise<{ occupied: number[]; names: Map<number, string>; disagreement: number[] }> {
  const read = async (): Promise<DirectorySlot[]> => {
    const t0 = Date.now();
    const r = kind === 'project' ? await readProjectDirectory(conn, wirePack) : await readSampleDirectory(conn, wirePack);
    timings.push({ what: `${kind} dir read pack${wirePack + 1}`, ms: Date.now() - t0 });
    return r.slots;
  };
  const a = await read();
  const firstOcc = a.filter((s) => s.name !== undefined).map((s) => s.slot);
  process.stdout.write(`    ${kind} dir read 1: ${firstOcc.length} occupied; settling ${SETTLE_MS} ms...\n`);
  await sleep(SETTLE_MS);
  const b = await read();
  const secondOcc = b.filter((s) => s.name !== undefined).map((s) => s.slot);
  const names = new Map<number, string>();
  for (const s of [...a, ...b]) if (s.name !== undefined && !names.has(s.slot)) names.set(s.slot, s.name);
  const occupied = [...names.keys()].sort((x, y) => x - y);
  const disagreement = occupied.filter((s) => !firstOcc.includes(s) || !secondOcc.includes(s));
  process.stdout.write(`    ${kind} dir read 2: ${secondOcc.length} occupied -> union ${occupied.length}${disagreement.length ? `  ** DISAGREED on ${disagreement.join(',')} **` : '  (agree)'}\n`);
  return { occupied, names, disagreement };
}

// ── generic read-only file pull (samples / patchbanks) ───────────────

interface FileDownload { ok: boolean; bytes?: Uint8Array; crcOk: boolean; empty?: boolean; error?: string }

async function downloadFile(fileType: number, pack: number, slot: number, waitMs = 5000): Promise<FileDownload> {
  const received: number[][] = [];
  const unsub = conn.onMessage((m) => { if (m[0] === 0xf0) received.push(core(m)); });
  const take = async (pred: (m: number[]) => boolean, timeout: number): Promise<number[] | undefined> => {
    const end = Date.now() + timeout;
    for (;;) {
      const i = received.findIndex(pred);
      if (i !== -1) return received.splice(i, 1)[0];
      if (Date.now() >= end) return undefined;
      await sleep(3);
    }
  };
  let started = false;
  try {
    conn.send(makeMessage(SUB.CLOSE_SESSION)); await sleep(200); received.length = 0;
    started = true;
    conn.send(makeMessage(SUB.OPEN_SESSION)); await sleep(300); received.length = 0;
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x01])); await sleep(100); received.length = 0;
    conn.send(makeMessage(SUB.QUERY_INFO, [0x01, 0x00])); await sleep(100); received.length = 0;
    conn.send(makeMessage(SUB.DIR_CONTROL, [0x02])); await sleep(100); received.length = 0;
    conn.send(makeMessage(SUB.DIR_CONTROL, [fileType, pack & 0x7f])); await sleep(500); received.length = 0;
    conn.send(buildReadFileRequest(fileType, pack, slot));
    const init = await take((c) => c[HDR_LEN] === SUB.WRITE_INIT && c.length >= HDR_LEN + 1 + 8 + 3 + 4 + 5, waitMs);
    if (!init) return { ok: false, crcOk: false, empty: true, error: 'no READ_INIT (empty slot)' };
    const sizeOff = HDR_LEN + 1 + 8 + 3 + 4;
    const declared = nibblesToInt(init.slice(sizeOff, sizeOff + 5));
    const raw: number[] = [];
    let crcRx: number | undefined;
    const end = Date.now() + 120_000;
    while (Date.now() < end) {
      const m = await take((c) => c[HDR_LEN] === SUB.WRITE_DATA || c[HDR_LEN] === SUB.WRITE_FINISH, waitMs);
      if (!m) break;
      if (m[HDR_LEN] === SUB.WRITE_DATA) raw.push(...msbDeinterleave(m.slice(HDR_LEN + 1 + 8 + 3)));
      else { crcRx = nibblesToInt(m.slice(HDR_LEN + 1 + 8 + 3, HDR_LEN + 1 + 8 + 3 + 8)); break; }
    }
    const bytes = Uint8Array.from(declared > 0 ? raw.slice(0, declared) : raw);
    const crcOk = crcRx === crc32(bytes);
    return { ok: bytes.length > 0 && (declared === 0 || bytes.length === declared) && crcOk, bytes, crcOk, error: crcOk ? undefined : `CRC mismatch (declared ${declared}, got ${bytes.length})` };
  } finally {
    if (started) { try { conn.send(makeMessage(SUB.CLOSE_SESSION)); } catch { /* dead handle */ } }
    unsub();
  }
}

// ── byte diff, classified ────────────────────────────────────────────

function classifyDiff(baseline: Uint8Array, now: Uint8Array): { offsets: number[]; verdict: string } {
  const offsets: number[] = [];
  const n = Math.min(baseline.length, now.length);
  for (let i = 0; i < n; i++) if (baseline[i] !== now[i]) offsets.push(i);
  if (baseline.length !== now.length) return { offsets, verdict: `LENGTH CHANGED ${baseline.length} -> ${now.length}` };
  if (offsets.length === 0) return { offsets, verdict: 'identical' };
  const onlyMixer = offsets.every((o) => MIXER_LEVEL_OFFSETS.includes(o));
  if (onlyMixer) return { offsets, verdict: 'BENIGN: mixer level bytes only (device recomposes these from the faders on a hand-save)' };
  return { offsets, verdict: `UNCLASSIFIED: ${offsets.length} differing byte(s)` };
}

const hexOff = (o: number): string => `0x${o.toString(16)}`;
function summariseOffsets(offsets: number[]): string {
  if (offsets.length <= 12) return offsets.map(hexOff).join(', ');
  const runs: string[] = [];
  let start = offsets[0], prev = offsets[0];
  for (const o of offsets.slice(1)) {
    if (o !== prev + 1) { runs.push(start === prev ? hexOff(start) : `${hexOff(start)}-${hexOff(prev)}`); start = o; }
    prev = o;
  }
  runs.push(start === prev ? hexOff(start) : `${hexOff(start)}-${hexOff(prev)}`);
  return `${offsets.length} bytes in ${runs.length} run(s): ${runs.slice(0, 10).join(', ')}${runs.length > 10 ? ' …' : ''}`;
}

// ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mp = join(BASE, 'manifest.json');
  if (!existsSync(mp)) { console.error(`no manifest at ${mp}`); process.exit(2); }
  const M = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
  console.log(`Circuit Tracks POST-CRASH VERIFY — READ-ONLY. Baseline: ${BASE} (captured ${M.captured_at})\n`);

  const tConn = Date.now();
  conn = connect(CONNECT);
  const connMs = Date.now() - tConn;
  if (!conn.hasInput) { console.log('REFUSED: no input port.'); exitMidiScript(2); }
  console.log(`PORT OPENED cleanly in ${connMs} ms (input + output).`);
  timings.push({ what: 'port open', ms: connMs });

  const tPack = Date.now();
  const packDir = await readPackDirectory(conn);
  const packMs = Date.now() - tPack;
  timings.push({ what: 'pack directory', ms: packMs });
  console.log(`Pack directory read in ${packMs} ms: ${packDir.count} pack(s)`);
  for (const p of packDir.packs) {
    const was = M.card_packs.find((c) => c.device_pack === p.index + 1);
    const same = was?.name === p.name;
    console.log(`  Pack ${p.index + 1} "${p.name}"${same ? '  (name matches backup)' : `  ** was "${was?.name ?? '(absent)'}" **`}`);
    if (!same) findings.push(`Pack ${p.index + 1} name changed: "${was?.name ?? '(absent)'}" -> "${p.name}"`);
  }
  if (packDir.count !== M.card_packs.length) findings.push(`Pack COUNT changed: backup ${M.card_packs.length}, device ${packDir.count}`);

  const available = packDir.packs.map((p) => p.index + 1);
  const packs = PACK_SPEC === undefined ? available : PACK_SPEC.split(',').map((s) => Number(s.trim())).filter((n) => available.includes(n));
  console.log(`\nIn scope: ${packs.map((p) => `Pack ${p}`).join(', ')}${DIRS_ONLY ? '   (DIRECTORIES ONLY)' : ''}\n`);

  if (!DIRS_ONLY && !existsSync(DIFF_OUT)) mkdirSync(DIFF_OUT, { recursive: true });

  const perPack: string[] = [];

  for (const devicePack of packs) {
    const wire = devicePack - 1;
    const base = M.packs.find((p) => p.device_pack === devicePack);
    console.log(`\n=== Pack ${devicePack} (wire ${wire}) ===`);
    if (base === undefined) { findings.push(`Pack ${devicePack} is not in the backup at all`); console.log('  ** not in backup **'); continue; }

    const dir = await readDirStable('project', wire);
    const baseSlots = base.projects.map((p) => p.wire_slot!).sort((a, b) => a - b);
    const nowSlots = dir.occupied;
    const newly = nowSlots.filter((s) => !baseSlots.includes(s));
    const gone = baseSlots.filter((s) => !nowSlots.includes(s));
    if (newly.length) findings.push(`Pack ${devicePack}: project slot(s) NEWLY OCCUPIED (wire) ${newly.join(',')}`);
    if (gone.length) findings.push(`Pack ${devicePack}: project slot(s) MISSING (wire) ${gone.join(',')}`);
    if (dir.disagreement.length) findings.push(`Pack ${devicePack}: the two project directory reads disagreed on wire slot(s) ${dir.disagreement.join(',')}`);
    console.log(`  projects: backup ${baseSlots.length} occupied, device ${nowSlots.length}${newly.length ? `, NEW ${newly.join(',')}` : ''}${gone.length ? `, MISSING ${gone.join(',')}` : ''}`);

    // directory NAMES
    let nameDiffs = 0;
    for (const p of base.projects) {
      const nm = dir.names.get(p.wire_slot!);
      if (nm !== undefined && nm !== p.directory_name) { nameDiffs++; findings.push(`Pack ${devicePack} project ${p.device_project}: directory name "${p.directory_name}" -> "${nm}"`); }
    }
    if (nameDiffs === 0) console.log('  project directory names: all match');

    let matched = 0, differed = 0, missing = 0, crcFail = 0, structFail = 0;

    if (!DIRS_ONLY) {
      for (const slot of nowSlots) {
        const rec = base.projects.find((p) => p.wire_slot === slot);
        if (rec === undefined) { console.log(`  Project ${String(slot + 1).padStart(2)}  NEW — not in backup, pulling for the record`); }
        let got: Uint8Array | undefined; let crcOk = false; let attempts = 0;
        for (let attempt = 1; attempt <= 3 && got === undefined; attempt++) {
          attempts = attempt;
          const t0 = Date.now();
          const d = await downloadProject(conn, slot, { pack: wire, reconnect });
          const ms = Date.now() - t0;
          timings.push({ what: `project pack${devicePack}/${slot + 1}`, ms });
          if (d.bytes && d.bytes.length === NCS_FILE_SIZE && d.crcOk) { got = d.bytes; crcOk = true; }
          else if (attempt < 3) await sleep(1500);
          else { console.log(`  Project ${String(slot + 1).padStart(2)}  ** READ FAILED after 3 attempts: ${d.empty ? 'device reported EMPTY' : d.crcOk === false ? 'CRC MISMATCH' : d.error ?? 'no bytes'} **`); crcFail++; findings.push(`Pack ${devicePack} project ${slot + 1}: could not be read back (${d.empty ? 'reported EMPTY' : 'CRC/read failure'})`); }
        }
        if (got === undefined) continue;
        // CRC-clean and still not a project. Its own finding line, never folded
        // into the read-failure count above: this one is not fixed by retrying.
        const st = checkNcsStructure(got);
        if (!st.ok) {
          structFail++;
          console.log(`  Project ${String(slot + 1).padStart(2)}  ** ${ncsStructureNote(st.faults, { crcVerified: crcOk })} **`);
          findings.push(`Pack ${devicePack} project ${slot + 1}: reads back CRC-clean and is STRUCTURALLY INVALID (${st.faults.join('; ')}). Not a transfer fault; do not restore from or to this slot.`);
        }
        if (rec === undefined) {
          writeFileSync(join(DIFF_OUT, `pack${devicePack}_proj${String(slot + 1).padStart(2, '0')}_NEW.ncs`), got);
          findings.push(`Pack ${devicePack} project ${slot + 1}: present on device, absent from backup (saved to ${DIFF_OUT})`);
          continue;
        }
        const baselineBytes = new Uint8Array(readFileSync(join(BASE, rec.file!)));
        const h = sha256(got);
        if (h === rec.sha256) { matched++; if (attempts > 1) findings.push(`Pack ${devicePack} project ${slot + 1}: matched, but needed ${attempts} read attempts`); }
        else {
          differed++;
          const { offsets, verdict } = classifyDiff(baselineBytes, got);
          const line = `Pack ${devicePack} project ${slot + 1} "${rec.embedded_name}": ${verdict} — ${summariseOffsets(offsets)} (device CRC ${crcOk ? 'OK' : 'FAILED'})`;
          findings.push(line);
          console.log(`  Project ${String(slot + 1).padStart(2)}  DIFFERS  ${verdict}`);
          console.log(`      offsets: ${summariseOffsets(offsets)}`);
          for (const o of offsets.slice(0, 16)) console.log(`      ${hexOff(o)}: backup 0x${baselineBytes[o].toString(16).padStart(2, '0')} -> device 0x${got[o].toString(16).padStart(2, '0')}`);
          writeFileSync(join(DIFF_OUT, `pack${devicePack}_proj${String(slot + 1).padStart(2, '0')}_device.ncs`), got);
        }
      }
      for (const s of gone) { missing++; }
      console.log(`  PROJECTS: ${matched} identical, ${differed} differ, ${gone.length} missing, ${crcFail} unreadable, ${structFail} CRC-clean but structurally invalid`);
    }

    // ── sample pool ───────────────────────────────────────────────
    const sdir = await readDirStable('sample', wire);
    const baseSampleSlots = base.samples.map((s) => s.wire_slot!).sort((a, b) => a - b);
    const sNew = sdir.occupied.filter((s) => !baseSampleSlots.includes(s));
    const sGone = baseSampleSlots.filter((s) => !sdir.occupied.includes(s));
    if (sNew.length) findings.push(`Pack ${devicePack}: sample slot(s) NEWLY OCCUPIED ${sNew.join(',')}`);
    if (sGone.length) findings.push(`Pack ${devicePack}: sample slot(s) MISSING ${sGone.join(',')}`);
    let sNameDiff = 0;
    for (const s of base.samples) {
      const nm = sdir.names.get(s.wire_slot!);
      if (nm !== undefined && nm !== s.name) { sNameDiff++; findings.push(`Pack ${devicePack} sample slot ${s.wire_slot}: "${s.name}" -> "${nm}"`); }
    }
    console.log(`  sample pool: backup ${baseSampleSlots.length}/64, device ${sdir.occupied.length}/64${sNew.length ? `, NEW ${sNew.join(',')}` : ''}${sGone.length ? `, MISSING ${sGone.join(',')}` : ''}${sNameDiff === 0 ? ', all names match' : ''}`);

    let sMatched = 0, sDiffered = 0;
    if (WITH_SAMPLES && !DIRS_ONLY) {
      for (const s of base.samples.filter((x) => x.file)) {
        const d = await downloadFile(FILE_TYPE_SAMPLE, wire, s.wire_slot!);
        if (!d.ok || !d.bytes) { findings.push(`Pack ${devicePack} sample ${s.wire_slot} "${s.name}": read failed (${d.error ?? 'no bytes'})`); continue; }
        const h = sha256(d.bytes);
        if (h === s.sha256) sMatched++;
        else { sDiffered++; findings.push(`Pack ${devicePack} sample ${s.wire_slot} "${s.name}": sha256 DIFFERS (${s.bytes}B -> ${d.bytes.length}B, CRC ${d.crcOk ? 'OK' : 'FAILED'})`); }
      }
      console.log(`  SAMPLE AUDIO: ${sMatched} identical, ${sDiffered} differ`);
    }

    // ── patch file store ──────────────────────────────────────────
    const pdir = await readFileDirectory(conn, FILE_TYPE_PATCH, wire);
    const patchSlots = pdir.slots.filter((s) => s.name !== undefined);
    const basePatch = base.patch_files.map((p) => p.wire_slot!);
    const pNew = patchSlots.map((s) => s.slot).filter((s) => !basePatch.includes(s));
    const pGone = basePatch.filter((s) => !patchSlots.some((x) => x.slot === s));
    if (pNew.length) findings.push(`Pack ${devicePack}: patchbank slot(s) NEW ${pNew.join(',')}`);
    if (pGone.length) findings.push(`Pack ${devicePack}: patchbank slot(s) MISSING ${pGone.join(',')}`);
    let pMatched = 0, pDiffered = 0;
    if (!DIRS_ONLY) {
      for (const s of base.patch_files.filter((x) => x.file)) {
        const d = await downloadFile(FILE_TYPE_PATCH, wire, s.wire_slot!);
        if (!d.ok || !d.bytes) { findings.push(`Pack ${devicePack} patchbank ${s.wire_slot} "${s.name}": read failed (${d.error ?? 'no bytes'})`); continue; }
        if (sha256(d.bytes) === s.sha256) pMatched++;
        else { pDiffered++; findings.push(`Pack ${devicePack} patchbank ${s.wire_slot} "${s.name}": sha256 DIFFERS`); }
      }
    }
    console.log(`  patch store: backup ${basePatch.length}, device ${patchSlots.length}${DIRS_ONLY ? '' : `; ${pMatched} identical, ${pDiffered} differ`}`);

    perPack.push(`Pack ${devicePack} "${base.pack_name}": projects ${DIRS_ONLY ? `${nowSlots.length}/${baseSlots.length} slots present` : `${matched} identical, ${differed} differ, ${gone.length} missing, ${crcFail} unreadable`}; sample pool ${sdir.occupied.length}/64 vs backup ${baseSampleSlots.length}${WITH_SAMPLES && !DIRS_ONLY ? ` (${sMatched} audio identical, ${sDiffered} differ)` : ''}; patchbanks ${patchSlots.length} vs ${basePatch.length}${DIRS_ONLY ? '' : ` (${pMatched} identical, ${pDiffered} differ)`}`);
  }

  console.log('\n================ PER-PACK ================');
  for (const l of perPack) console.log(l);

  console.log('\n================ TIMING ================');
  const proj = timings.filter((t) => t.what.startsWith('project'));
  if (proj.length) {
    const ms = proj.map((t) => t.ms).sort((a, b) => a - b);
    console.log(`project pulls: n=${ms.length} min ${ms[0]}ms median ${ms[Math.floor(ms.length / 2)]}ms max ${ms[ms.length - 1]}ms`);
    for (const t of proj.filter((x) => x.ms > 3 * ms[Math.floor(ms.length / 2)])) console.log(`  SLOW: ${t.what} ${t.ms}ms`);
  }
  for (const t of timings.filter((t) => !t.what.startsWith('project'))) console.log(`${t.what}: ${t.ms}ms`);

  console.log('\n================ FINDINGS ================');
  if (findings.length === 0) console.log('NONE. Every read matched the backup.');
  else for (const f of findings) console.log(`- ${f}`);

  endMidiScript(findings.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.stack ?? e.message : String(e)); exitMidiScript(1); });
