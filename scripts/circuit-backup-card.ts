/**
 * circuit-backup-card.ts — READ-ONLY whole-card backup for the Circuit Tracks.
 *
 * ## Why this exists
 *
 * A restore from a file on disk is the only undo that exists for a slot that
 * has been overwritten or erased. (Since 2026-07-29 `delete_project` CAN erase
 * a slot programmatically, which makes this backup MORE load-bearing, not less:
 * delete's own pre-flight backup lands on the same machine, so this card-wide
 * capture is the baseline everything is measured against.) As of
 * 2026-07-27 Pack 1 held 30 occupied project slots with no backup anywhere
 * (`samples/circuit-tracks/pack0/` looks like one but is a Components FACTORY
 * pack, not the maintainer's work), and Packs 2-4 had never been surveyed at
 * all. This script closes that.
 *
 * ## Read-only by construction
 *
 * Every frame it emits is one of OPEN_SESSION / DIR_CONTROL / QUERY_INFO /
 * CLOSE_SESSION / a READ-flavoured WRITE_INIT (the trailing `0x02` request
 * flag, which asks the device to send, cf. `downloadOnce` in uploadProject.ts).
 * It never sends WRITE_INIT-with-size, WRITE_DATA, WRITE_FINISH or
 * SET_FILENAME, and it never sends a Program Change, so the live project buffer
 * is never touched and there is nothing to restore. If you extend this file,
 * keep that property: it is the whole point.
 *
 * ## The two hazards this handles
 *
 * 1. **The manifest-flush window.** The device flushes a pack's directory
 *    manifest ~6-8 s AFTER a transfer session CLOSES. A listing taken sooner can
 *    report a slot empty that is not. Since "empty" here means "skip the backup
 *    of that slot", believing an early read would silently lose work. So every
 *    directory read is taken TWICE with a settle gap between and the occupancy
 *    is the UNION of the two; a disagreement is reported loudly.
 * 2. **Silent frame corruption.** The device's WRITE_FINISH carries a CRC32 over
 *    the file it just sent, so a download is self-validating. This is not
 *    optional decoration: on 2026-07-27 a downloader left the trailing `F7` on
 *    each frame, `msbDeinterleave` read it as one extra data byte per block, the
 *    whole stream shifted, and the RIFF/length checks still passed. Only the CRC
 *    said no. Nothing is written to disk here unless `crcOk` is true AND the
 *    length is exactly `NCS_FILE_SIZE`.
 * 3. **A clean transfer of a file that is not a project.** The CRC in (2) covers
 *    the ENCODED STREAM, not the decoded `.ncs`, so it cannot see a de-framing
 *    failure at all: `pack1/proj64__63_OOO.ncs` in the 2026-07-27 capture is the
 *    right length, carries the `USER` magic, reads
 *    `totalSessionSize = 267,395,056`, and its manifest entry says
 *    `"crc_verified": true`. Every project is therefore ALSO structure-checked
 *    (`checkNcsStructure`) and the verdict is recorded in the manifest as its
 *    OWN field, `structurally_valid`, never folded into `crc_verified`. The two
 *    answer different questions and a backup that cannot tell them apart will
 *    happily offer garbage as a restore source.
 *
 * ## Usage
 *
 *   npx tsx scripts/circuit-backup-card.ts --survey            # occupancy + names only, no files
 *   npx tsx scripts/circuit-backup-card.ts                     # back up projects on every pack
 *   npx tsx scripts/circuit-backup-card.ts --packs 1           # just Pack 1
 *   npx tsx scripts/circuit-backup-card.ts --samples           # + each pack's sample-pool audio
 *   ... --out samples/circuit-ncs/card-backup-<stamp>          # explicit destination
 *
 * Re-running against an existing `--out` RESUMES: a project file already on disk
 * at the exact expected size is left alone and re-hashed rather than re-pulled.
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
const SURVEY_ONLY = argv.includes('--survey');
const WITH_SAMPLES = argv.includes('--samples');
/** Re-pull even when a full-size file is already on disk (re-earns its CRC verdict). */
const FORCE = argv.includes('--force');
/** Re-render INDEX.md from an existing manifest.json. Touches no hardware. */
const INDEX_ONLY = argv.includes('--index-only');
const PACK_SPEC = flag('--packs');
/** Restrict `--samples` to these wire slots, e.g. `0,1,17,63`. Omit for the whole pool. */
const SAMPLE_SLOT_SPEC = flag('--sample-slots');
/** Gap between the two directory reads, ms. Must clear the ~6-8 s flush window. */
const SETTLE_MS = Number(flag('--settle') ?? '9000');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = flag('--out') ?? `samples/circuit-ncs/card-backup-${STAMP}`;

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
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._ -]/g, '_').trim().replace(/ +/g, '_');
/** The project's own embedded name lives at 0x10, 16 bytes, space-padded. */
const embeddedName = (b: Uint8Array): string =>
  String.fromCharCode(...b.slice(0x10, 0x20)).replace(/[^\x20-\x7e]/g, '?').trimEnd();

let conn: MidiConnection = undefined as unknown as MidiConnection;
const reconnect = (): MidiConnection => { conn = reconnectMidi(conn, CONNECT); return conn; };

// ── manifest shape ───────────────────────────────────────────────────

interface ProjectRecord {
  device_project: number;   // 1-based, as the front panel shows it
  wire_slot: number;        // 0-based, what the fileId carries
  directory_name: string;   // name from the pack's project directory listing
  embedded_name: string;    // name at offset 0x10 inside the .ncs itself
  file: string;             // path relative to the backup root
  bytes: number;
  sha256: string;
  crc_verified: boolean;    // device WRITE_FINISH CRC32 matched our crc32(bytes)
  /**
   * Does the DECODED file pass `checkNcsStructure`? A SEPARATE field from
   * `crc_verified` on purpose, and never a replacement for it: `crc_verified`
   * says the transfer was faithful, `structurally_valid` says the thing
   * transferred is a project. `OOO` (pack 1, project 64) is true/false, which is
   * a real and reachable state, so one field could not have expressed it.
   * Computable from the bytes alone, so a resumed run fills it in without the
   * device.
   *
   * OPTIONAL only because a manifest written before this check existed does not
   * carry it, and `--index-only` re-renders those. Absent means UNCHECKED, which
   * the index says in as many words rather than rendering it as a pass. Every
   * record written from here on sets it.
   */
  structurally_valid?: boolean;
  /** Why it failed, one line per invariant. Absent when `structurally_valid`. */
  structure_faults?: string[];
  attempts: number;
  source: 'device' | 'resumed-from-disk';
}
interface SampleRecord { wire_slot: number; device_slot: number; name: string; file?: string; bytes?: number; sha256?: string; crc_verified?: boolean }
interface PackRecord {
  device_pack: number; wire_pack: number; pack_name: string;
  projects_occupied: number; projects_captured: number; projects_failed: number[];
  directory_reads: { first: number[]; second: number[]; disagreement: number[] };
  projects: ProjectRecord[];
  sample_pool_occupied: number; samples: SampleRecord[];
  patch_files: SampleRecord[];
}

// ── directory reads, taken twice across the flush window ─────────────

interface StableDir { occupied: number[]; names: Map<number, string>; first: number[]; second: number[]; disagreement: number[] }

/**
 * Read a pack's directory TWICE with a settle gap and take the UNION.
 *
 * A single read can under-report while the device is still flushing its
 * manifest (~6-8 s after a session close, and this script closes a session on
 * every call). Under-reporting here means "skip that slot's backup", which is
 * exactly the failure a backup cannot afford, so the safe direction is to
 * over-report: a slot claimed occupied that is not simply costs one 5 s
 * empty-slot read.
 */
async function readDirStable(
  kind: 'project' | 'sample', wirePack: number,
): Promise<StableDir> {
  const read = async (): Promise<DirectorySlot[]> => {
    const r = kind === 'project' ? await readProjectDirectory(conn, wirePack) : await readSampleDirectory(conn, wirePack);
    return r.slots;
  };
  const a = await read();
  const firstOcc = a.filter((s) => s.name !== undefined).map((s) => s.slot);
  process.stdout.write(`    ${kind} directory read 1: ${firstOcc.length} occupied; settling ${SETTLE_MS} ms past the flush window...\n`);
  await sleep(SETTLE_MS);
  const b = await read();
  const secondOcc = b.filter((s) => s.name !== undefined).map((s) => s.slot);

  const names = new Map<number, string>();
  for (const s of [...a, ...b]) if (s.name !== undefined && !names.has(s.slot)) names.set(s.slot, s.name);
  const occupied = [...names.keys()].sort((x, y) => x - y);
  const disagreement = occupied.filter((s) => !firstOcc.includes(s) || !secondOcc.includes(s));
  process.stdout.write(`    ${kind} directory read 2: ${secondOcc.length} occupied  ->  union ${occupied.length}`);
  process.stdout.write(disagreement.length ? `  ** READS DISAGREED on slot(s) ${disagreement.join(',')}; taking the union **\n` : '  (both reads agree)\n');
  return { occupied, names, first: firstOcc, second: secondOcc, disagreement };
}

// ── generic file download (read-only), same shape as downloadProject ─

interface FileDownload { ok: boolean; bytes?: Uint8Array; crcOk: boolean; empty?: boolean; error?: string }

/**
 * Pull one stored file's bytes off `pack`/`slot` for ANY fileType the device
 * serves (0x04 patch bank, 0x05 sample). Mirrors `downloadOnce` in
 * uploadProject.ts — same session shape, same de-interleave, same CRC gate —
 * but with no fixed expected length: the size comes from the device's own
 * READ_INIT reply. Projects keep using `downloadProject` itself rather than
 * this, so the shipped, hardware-confirmed path stays the one that carries the
 * irreplaceable work.
 */
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

// ── INDEX.md, the human restore sheet ────────────────────────────────

interface Manifest { captured_at: string; card_packs: { device_pack: number; name: string }[]; packs: PackRecord[] }

/**
 * Render `INDEX.md` beside the files from `manifest.json`.
 *
 * A dated directory of 98 opaque `.ncs` files is not a backup anyone can use
 * under pressure: restoring needs pack, slot, and which song a file IS, and the
 * FILENAME cannot carry that (the device's own directory name is
 * `NN_SESSION.ncs` for most of the card, so 66 of the 98 files would be
 * indistinguishable). The project's real name lives at offset 0x10 INSIDE the
 * file, so it has to be read out and written down at capture time.
 */
function renderIndex(m: Manifest): string {
  const L: string[] = [];
  const total = m.packs.reduce((a, p) => a + p.projects.length, 0);
  const verified = m.packs.reduce((a, p) => a + p.projects.filter((x) => x.crc_verified).length, 0);
  const broken = m.packs.flatMap((p) => p.projects.filter((x) => x.structurally_valid === false).map((x) => ({ p, x })));
  const unchecked = m.packs.reduce((a, p) => a + p.projects.filter((x) => x.structurally_valid === undefined).length, 0);
  L.push('# Circuit Tracks card backup');
  L.push('');
  L.push(`Captured **${m.captured_at}** by \`scripts/circuit-backup-card.ts\` (read-only).`);
  L.push('');
  L.push(`**${total} projects, ${verified} of them CRC-verified by the device's own WRITE_FINISH CRC32, ` +
    `${total - broken.length - unchecked} of them structurally valid.**`);
  L.push('');
  L.push('Those are two different claims and this backup keeps them apart:');
  L.push('');
  L.push('- **CRC** is the device\'s own WRITE_FINISH CRC32, and it covers the **encoded stream**. It says the');
  L.push('  transfer was faithful. It cannot see a de-framing failure, because it agrees with the bytes as sent.');
  L.push('- **Structure** is checked here, on the **decoded file**: the `USER` magic and the file\'s own');
  L.push('  `totalSessionSize` at 0x04, which must read 160,780. It says the thing transferred is a project.');
  L.push('');
  L.push('A file can pass the first and fail the second, and one on this card does. **Restore only from a row');
  L.push('that is `ok` in BOTH columns.**');
  L.push('');
  if (broken.length > 0) {
    L.push('> **CRC-VERIFIED BUT STRUCTURALLY INVALID, do not restore these:**');
    L.push('>');
    for (const { p, x } of broken) {
      L.push(`> - Pack ${p.device_pack} project ${x.device_project} \`${x.embedded_name}\` (\`${x.file}\`): ${(x.structure_faults ?? []).join('; ')}`);
    }
    L.push('>');
    L.push('> These are not transfer failures. Re-running the backup will fetch the same bytes, because the');
    L.push('> bytes on the card are what is damaged. The file is kept as evidence, not as a restore source.');
    L.push('');
  }
  if (unchecked > 0) {
    L.push(`${unchecked} project record(s) predate the structural check and carry no verdict. Re-run the backup`);
    L.push('against this directory to back-fill them; it recomputes structure from the files already on disk and');
    L.push('touches no hardware for the ones it keeps.');
    L.push('');
  }
  L.push('## How to restore one project');
  L.push('');
  L.push('Use the **`upload_project` MCP tool**, which is the only pack-aware restore path:');
  L.push('');
  L.push('```');
  L.push('upload_project(file: "<Project file column>", slot: <Project column>, pack: <Device pack column>,');
  L.push('               confirm_overwrite: true)');
  L.push('```');
  L.push('');
  L.push('Both `slot` and `pack` are **1-based, exactly as the tables below and the front panel show them**.');
  L.push('The wire-slot column is diagnostic only; do not pass it.');
  L.push('');
  L.push('- **Check the Structure column first.** `upload_project` now refuses a structurally invalid file, so a');
  L.push('  bad restore is blocked rather than silently written, but the useful move is to notice before you try.');
  L.push('- The device has **NO erase**, so a restore OVERWRITES whatever is in that slot. `confirm_overwrite`');
  L.push('  is the only safety net; without it the tool reads the slot and refuses if occupied, which is the');
  L.push('  behaviour you want unless you have already decided to replace what is there.');
  L.push('- **Do NOT use `scripts/circuit-ncs-upload-file.ts` to restore anything outside Pack 1.** It takes no');
  L.push('  pack argument and its `uploadProject` call defaults to wire pack 0, so restoring a Pack 5 project');
  L.push('  with it would silently overwrite the same-numbered project on Pack 1.');
  L.push('');
  L.push('## Packs on the card');
  L.push('');
  L.push('| Device pack | Pack name | Projects | Sample pool | Patch files |');
  L.push('|---|---|---:|---:|---:|');
  for (const p of m.packs) {
    L.push(`| Pack ${p.device_pack} | \`${p.pack_name}\` | ${p.projects.length} | ${p.sample_pool_occupied}/64 | ${p.patch_files.length} |`);
  }
  L.push('');
  for (const p of m.packs) {
    if (p.projects.length === 0 && p.samples.length === 0 && p.patch_files.length === 0) continue;
    L.push(`## Pack ${p.device_pack} — \`${p.pack_name}\``);
    L.push('');
    if (p.projects.length > 0) {
      L.push('| Project | Wire slot | Project name (from 0x10) | Device filename | Bytes | CRC | Structure | File |');
      L.push('|---:|---:|---|---|---:|:-:|:-:|---|');
      for (const x of p.projects) {
        const st = x.structurally_valid === undefined ? 'not checked' : x.structurally_valid ? 'ok' : '**CORRUPT**';
        L.push(`| ${x.device_project} | ${x.wire_slot} | **${x.embedded_name}** | \`${x.directory_name}\` | ${x.bytes} | ${x.crc_verified ? 'ok' : '—'} | ${st} | \`${x.file}\` |`);
      }
      L.push('');
    }
    const withAudio = p.samples.filter((s) => s.file);
    if (p.samples.length > 0) {
      L.push(`**Sample pool: ${p.sample_pool_occupied}/64 occupied, ${withAudio.length} audio file(s) captured here.**`);
      L.push('');
      L.push('| Wire slot | Name | Bytes | Audio captured |');
      L.push('|---:|---|---:|:-:|');
      for (const s of p.samples) L.push(`| ${s.wire_slot} | \`${s.name}\` | ${s.bytes ?? ''} | ${s.file ? 'yes' : 'no (name only)'} |`);
      L.push('');
    }
    if (p.patch_files.length > 0) {
      L.push('**Patch file store (fileType 0x04):**');
      L.push('');
      for (const s of p.patch_files) L.push(`- slot ${s.wire_slot} \`${s.name}\` — ${s.bytes ?? '?'} bytes${s.file ? `, \`${s.file}\`` : ''}`);
      L.push('');
    }
  }
  L.push('## What is NOT in here');
  L.push('');
  L.push('- **The synth patch BANK** (64 Flash slots per synth part). The device has no read path for it:');
  L.push('  a Program Change was shown on 2026-07-27 to revert the live edit and ignore its slot number, so a');
  L.push('  bank slot cannot be dumped. In practice this costs nothing, because a project CARRIES its two');
  L.push('  340-byte patch bodies inline (Synth 1 at `0x26d14`, Synth 2 at `0x26e68`), so every patch actually');
  L.push('  in use by a project is inside the `.ncs` files above.');
  L.push('- **Sample audio marked "no (name only)"** above. The bytes are byte-identical to another pack that IS');
  L.push('  captured here; the slot->name mapping is recorded so a restore knows which file goes where.');
  L.push('');
  return `${L.join('\n')}\n`;
}

// ── main ─────────────────────────────────────────────────────────────

function parsePacks(spec: string | undefined, available: number[]): number[] {
  if (spec === undefined) return available;
  const want = spec.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n));
  return want.filter((n) => available.includes(n));
}

async function main(): Promise<void> {
  // Regenerate INDEX.md from an existing manifest without opening the port at
  // all. Kept separate from a capture run so a stale or reworded index is a
  // zero-risk fix rather than a reason to touch the device again.
  if (INDEX_ONLY) {
    const mp = join(OUT, 'manifest.json');
    if (!existsSync(mp)) { console.error(`no manifest at ${mp}`); process.exit(2); }
    const m = JSON.parse(readFileSync(mp, 'utf8')) as Manifest;
    writeFileSync(join(OUT, 'INDEX.md'), renderIndex(m));
    console.log(`wrote ${join(OUT, 'INDEX.md')}`);
    return;
  }

  conn = connect(CONNECT);
  if (!conn.hasInput) { console.log('REFUSED: no input port; every read here needs a bidirectional connection.'); exitMidiScript(2); }

  console.log('Circuit Tracks card backup — READ-ONLY (no WRITE_DATA / SET_FILENAME / Program Change is ever sent)\n');

  const packDir = await readPackDirectory(conn);
  const available = packDir.packs.map((p) => p.index + 1);
  console.log(`Device reports ${packDir.count} pack(s):`);
  for (const p of packDir.packs) console.log(`  Pack ${p.index + 1}  (wire ${p.index})  "${p.name}"`);
  const packs = parsePacks(PACK_SPEC, available);
  console.log(`\nIn scope: ${packs.map((p) => `Pack ${p}`).join(', ')}`);
  console.log(`Destination: ${OUT}${SURVEY_ONLY ? '   (SURVEY ONLY — no files will be written)' : ''}`);
  console.log(`Sample-pool audio: ${WITH_SAMPLES ? 'YES (--samples)' : 'names only (pass --samples for the audio)'}\n`);

  if (!SURVEY_ONLY && !existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  // MERGE, never clobber. A backup of a 5-pack card is naturally run one pack at
  // a time (each run stays inside a sane wall-clock budget), and every run
  // pointed at the same --out must ACCUMULATE into one manifest: an
  // overwrite would silently drop the record of packs captured minutes earlier
  // while their .ncs files sat on disk unlisted, which is precisely the
  // "a pile of directories nobody can restore from" failure this file exists to
  // prevent.
  const manifestPath = join(OUT, 'manifest.json');
  let manifest: Manifest = {
    captured_at: new Date().toISOString(),
    card_packs: packDir.packs.map((p) => ({ device_pack: p.index + 1, name: p.name })),
    packs: [],
  };
  // Records for the packs we are ABOUT to rewrite, kept so a resumed file can
  // inherit the CRC verdict it already earned. Without this a second run over
  // an already-captured pack silently downgrades every `crc_verified: true` to
  // `false` — the bytes on disk are unchanged and were device-verified, but the
  // manifest, which is the only thing a future restore reads, would stop saying
  // so. The verdict is only inherited when the sha256 still matches, so it can
  // never be attached to a file that changed underneath us.
  const priorByPack = new Map<number, PackRecord>();
  if (!SURVEY_ONLY && existsSync(manifestPath)) {
    try {
      const prior = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
      for (const p of prior.packs) if (packs.includes(p.device_pack)) priorByPack.set(p.device_pack, p);
      manifest = { ...prior, card_packs: manifest.card_packs, packs: prior.packs.filter((p) => !packs.includes(p.device_pack)) };
      console.log(`(merging into existing manifest: kept ${manifest.packs.length} pack record(s) from an earlier run)\n`);
    } catch { console.log('(existing manifest.json is unreadable; starting a fresh one)\n'); }
  }
  const writeManifest = (): void => {
    if (SURVEY_ONLY) return;
    manifest.packs.sort((a, b) => a.device_pack - b.device_pack);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`);
    writeFileSync(join(OUT, 'INDEX.md'), renderIndex(manifest));
  };

  for (const devicePack of packs) {
    const wire = devicePack - 1;
    const packName = packDir.packs.find((p) => p.index === wire)?.name ?? '(unnamed)';
    console.log(`\n=== Pack ${devicePack} (wire ${wire})  "${packName}" ===`);
    const packOut = join(OUT, `pack${devicePack}`);
    if (!SURVEY_ONLY && !existsSync(packOut)) mkdirSync(packOut, { recursive: true });

    const rec: PackRecord = {
      device_pack: devicePack, wire_pack: wire, pack_name: packName,
      projects_occupied: 0, projects_captured: 0, projects_failed: [],
      directory_reads: { first: [], second: [], disagreement: [] },
      projects: [], sample_pool_occupied: 0, samples: [], patch_files: [],
    };
    manifest.packs.push(rec);

    const dir = await readDirStable('project', wire);
    rec.projects_occupied = dir.occupied.length;
    rec.directory_reads = { first: dir.first, second: dir.second, disagreement: dir.disagreement };
    // NOTE: no early `continue` here when a pack holds no projects. A pack's
    // sample pool and patch store are INDEPENDENT of its project slots — a pack
    // can carry a pool with nothing sequenced against it yet — and skipping
    // ahead would report those as "0 occupied" from the initialiser rather than
    // from a measurement, which is the exact "reported empty, wasn't" failure
    // this script is built to avoid.
    if (dir.occupied.length === 0) console.log('    no occupied project slots.');
    for (const s of dir.occupied) console.log(`      Project ${String(s + 1).padStart(2)} (wire ${String(s).padStart(2)})  "${dir.names.get(s)}"`);

    if (!SURVEY_ONLY) {
      for (const slot of dir.occupied) {
        const dirName = dir.names.get(slot) ?? '';
        const base = `proj${String(slot + 1).padStart(2, '0')}__${safe(dirName.replace(/\.ncs$/i, '')) || 'unnamed'}.ncs`;
        const path = join(packOut, base);
        const rel = `pack${devicePack}/${base}`;

        if (!FORCE && existsSync(path) && readFileSync(path).length === NCS_FILE_SIZE) {
          const bytes = new Uint8Array(readFileSync(path));
          const hash = sha256(bytes);
          const was = priorByPack.get(devicePack)?.projects.find((x) => x.wire_slot === slot && x.sha256 === hash);
          // Structure is re-derived from the bytes, NEVER carried forward like
          // the CRC verdict is. The CRC is a device answer we cannot recompute
          // offline, so inheriting it is the only way to keep it; structure is a
          // property of the file in front of us, so recomputing is both free and
          // strictly better (it back-fills the field on a backup taken before
          // this check existed, which is exactly the 2026-07-27 capture).
          const st = checkNcsStructure(bytes);
          rec.projects.push({
            device_project: slot + 1, wire_slot: slot, directory_name: dirName, embedded_name: embeddedName(bytes),
            file: rel, bytes: bytes.length, sha256: hash, crc_verified: was?.crc_verified ?? false,
            structurally_valid: st.ok, structure_faults: st.ok ? undefined : st.faults,
            attempts: was?.attempts ?? 0, source: 'resumed-from-disk',
          });
          rec.projects_captured++;
          console.log(`  Project ${String(slot + 1).padStart(2)}  already on disk at full size — kept${was?.crc_verified ? ' (CRC verdict carried forward)' : ' (NO prior CRC verdict — re-run with --force to earn one)'}`);
          if (!st.ok) console.log(`  Project ${String(slot + 1).padStart(2)}  ** ${ncsStructureNote(st.faults, { crcVerified: was?.crc_verified })} **`);
          continue;
        }

        let ok = false;
        for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
          const t0 = Date.now();
          const d = await downloadProject(conn, slot, { pack: wire, reconnect });
          const el = ((Date.now() - t0) / 1000).toFixed(1);
          if (d.bytes && d.bytes.length === NCS_FILE_SIZE && d.crcOk) {
            writeFileSync(path, d.bytes);
            const en = embeddedName(d.bytes);
            // A CRC-clean transfer of a non-project is still WRITTEN to disk: it
            // is the faithful image of what the slot holds, it is the only
            // evidence of the damage, and discarding it would silently turn a
            // known-bad slot into a slot missing from the backup. What changes is
            // the RECORD and the line printed: it is not a capture failure (the
            // attempt loop must not retry it, retrying re-fetches the same bytes)
            // and it is not a clean capture either.
            const st = checkNcsStructure(d.bytes);
            rec.projects.push({
              device_project: slot + 1, wire_slot: slot, directory_name: dirName, embedded_name: en,
              file: rel, bytes: d.bytes.length, sha256: sha256(d.bytes), crc_verified: true,
              structurally_valid: st.ok, structure_faults: st.ok ? undefined : st.faults,
              attempts: attempt, source: 'device',
            });
            rec.projects_captured++;
            // The directory name is the FILE name, shaped `<wireSlot>_<embedded>.ncs`
            // (e.g. wire 32 "32_The Summoning.ncs" holds embedded "The Summoning").
            // Only flag a real divergence, not that fixed prefix/extension.
            const stem = dirName.replace(/\.ncs$/i, '').replace(/^\d+_/, '');
            const mismatch = en !== stem ? `   [dir "${dirName}" vs embedded "${en}"]` : '';
            console.log(`  Project ${String(slot + 1).padStart(2)}  CRC ok  ${d.bytes.length}B  ${el}s  "${en}"${mismatch}  -> ${rel}`);
            if (!st.ok) {
              console.log(`  Project ${String(slot + 1).padStart(2)}  ** ${ncsStructureNote(st.faults, { crcVerified: true })} **`);
              console.log(`  Project ${String(slot + 1).padStart(2)}     saved anyway (it is what the slot holds), recorded structurally_valid:false, NOT retried.`);
            }
            ok = true;
          } else {
            const why = d.empty ? 'device reported the slot EMPTY (no READ_INIT)' : (d.crcOk === false && d.bytes ? `CRC MISMATCH (${d.bytes.length}B)` : (d.error ?? 'no bytes'));
            console.log(`  Project ${String(slot + 1).padStart(2)}  attempt ${attempt} FAILED: ${why}  (${el}s)`);
            if (attempt < 3) await sleep(1500);
          }
        }
        if (!ok) { rec.projects_failed.push(slot + 1); console.log(`  Project ${String(slot + 1).padStart(2)}  ** GIVING UP after 3 attempts — nothing written **`); }
        writeManifest();
        await sleep(250);
      }
    }

    // ── sample pool ────────────────────────────────────────────────
    const sdir = await readDirStable('sample', wire);
    rec.sample_pool_occupied = sdir.occupied.length;
    for (const s of sdir.occupied) rec.samples.push({ wire_slot: s, device_slot: s + 1, name: sdir.names.get(s) ?? '' });
    console.log(`    sample pool: ${sdir.occupied.length}/64 occupied`);

    if (WITH_SAMPLES && !SURVEY_ONLY && sdir.occupied.length > 0) {
      const sampOut = join(packOut, 'samples');
      if (!existsSync(sampOut)) mkdirSync(sampOut, { recursive: true });
      const wantSlots = SAMPLE_SLOT_SPEC === undefined
        ? sdir.occupied
        : sdir.occupied.filter((s) => SAMPLE_SLOT_SPEC.split(',').map((x) => Number(x.trim())).includes(s));
      for (const slot of wantSlots) {
        const name = sdir.names.get(slot) ?? `slot${slot}`;
        const base = `s${String(slot).padStart(2, '0')}__${safe(name)}`;
        const path = join(sampOut, base);
        const relS = `pack${devicePack}/samples/${base}`;
        const r = rec.samples.find((x) => x.wire_slot === slot)!;
        if (existsSync(path)) {
          const b = new Uint8Array(readFileSync(path));
          r.file = relS; r.bytes = b.length; r.sha256 = sha256(b);
          r.crc_verified = priorByPack.get(devicePack)?.samples.find((x) => x.wire_slot === slot && x.sha256 === r.sha256)?.crc_verified ?? false;
          console.log(`    sample ${String(slot).padStart(2)}  already on disk — kept${r.crc_verified ? ' (CRC verdict carried forward)' : ''}  ${name}`);
          continue;
        }
        let done = false;
        for (let attempt = 1; attempt <= 2 && !done; attempt++) {
          const d = await downloadFile(FILE_TYPE_SAMPLE, wire, slot);
          if (d.ok && d.bytes && d.crcOk) {
            writeFileSync(path, d.bytes);
            r.file = relS; r.bytes = d.bytes.length; r.sha256 = sha256(d.bytes); r.crc_verified = true;
            console.log(`    sample ${String(slot).padStart(2)}  CRC ok  ${d.bytes.length}B  ${name}`);
            done = true;
          } else if (attempt === 2) {
            console.log(`    sample ${String(slot).padStart(2)}  FAILED: ${d.error ?? 'no bytes'}  ${name}`);
          } else { await sleep(800); }
        }
        writeManifest();
      }
    }

    // ── patch FILE store (fileType 0x04, `NN_PATCHBANK.cpb`) ────────
    //
    // Always captured, never behind --samples: these are a handful of small
    // files and they are the only patch data the device will hand over at all.
    // The synth patch BANK (64 Flash slots per part) has NO read path — a
    // Program Change was shown on 2026-07-27 to REVERT the live edit and ignore
    // its slot number, so a bank slot cannot be dumped. What saves the sounds in
    // practice is that a project CARRIES its two 340-byte patch bodies inline
    // (Synth 1 at 0x26d14, Synth 2 at 0x26e68), so the .ncs captures above hold
    // every patch actually in use.
    const pdir = await readFileDirectory(conn, FILE_TYPE_PATCH, wire);
    const patchSlots = pdir.slots.filter((s) => s.name !== undefined);
    console.log(`    patch file store (0x04): ${patchSlots.length}/64 occupied${patchSlots.length ? `  ${patchSlots.map((s) => s.name).join(' ')}` : ''}`);
    if (!SURVEY_ONLY && patchSlots.length > 0) {
      const patchOut = join(packOut, 'patchbanks');
      if (!existsSync(patchOut)) mkdirSync(patchOut, { recursive: true });
      for (const s of patchSlots) {
        const base = safe(s.name!);
        const path = join(patchOut, base);
        const rel = `pack${devicePack}/patchbanks/${base}`;
        const r: SampleRecord = { wire_slot: s.slot, device_slot: s.slot + 1, name: s.name! };
        rec.patch_files.push(r);
        if (existsSync(path)) {
          const b = new Uint8Array(readFileSync(path));
          r.file = rel; r.bytes = b.length; r.sha256 = sha256(b);
          r.crc_verified = priorByPack.get(devicePack)?.patch_files.find((x) => x.wire_slot === s.slot && x.sha256 === r.sha256)?.crc_verified ?? false;
          console.log(`    patchbank ${String(s.slot).padStart(2)}  already on disk — kept${r.crc_verified ? ' (CRC verdict carried forward)' : ''}  ${s.name}`);
          continue;
        }
        const d = await downloadFile(FILE_TYPE_PATCH, wire, s.slot);
        if (d.ok && d.bytes && d.crcOk) {
          writeFileSync(path, d.bytes);
          r.file = rel; r.bytes = d.bytes.length; r.sha256 = sha256(d.bytes); r.crc_verified = true;
          console.log(`    patchbank ${String(s.slot).padStart(2)}  CRC ok  ${d.bytes.length}B  ${s.name}  -> ${rel}`);
        } else {
          console.log(`    patchbank ${String(s.slot).padStart(2)}  FAILED: ${d.error ?? 'no bytes'}  ${s.name}`);
        }
        writeManifest();
      }
    }
    writeManifest();
  }

  // ── summary ────────────────────────────────────────────────────────
  console.log('\n================ SUMMARY ================');
  let totalProjects = 0, totalFailed = 0;
  const corrupt: string[] = [];
  for (const p of manifest.packs) {
    totalProjects += p.projects_captured; totalFailed += p.projects_failed.length;
    for (const x of p.projects) if (x.structurally_valid === false) corrupt.push(`Pack ${p.device_pack} project ${x.device_project} "${x.embedded_name}"`);
    console.log(`Pack ${p.device_pack} "${p.pack_name}": ${p.projects_occupied} occupied project slot(s), ${p.projects_captured} captured` +
      `${p.projects_failed.length ? `, FAILED ${p.projects_failed.join(',')}` : ''}; sample pool ${p.sample_pool_occupied}/64` +
      `${p.directory_reads.disagreement.length ? `; directory reads disagreed on ${p.directory_reads.disagreement.join(',')}` : ''}`);
  }
  console.log(`Total: ${totalProjects} project file(s) captured, ${totalFailed} failure(s).`);
  // Reported as its own line, never added to the failure count: nothing failed
  // here. The capture worked and the card holds a bad file. Counting it as a
  // failure would send the next person retrying a transfer that is already
  // perfect, and folding it into "captured" would hand them a restore source
  // that writes garbage.
  if (corrupt.length > 0) {
    console.log(`CAPTURED BUT NOT RESTORABLE: ${corrupt.length} project(s) transferred CRC-clean and are structurally invalid:`);
    for (const c of corrupt) console.log(`  ${c}`);
    console.log('  These are damage ON THE CARD, not transfer faults. Re-running fetches the same bytes.');
    console.log('  The files are kept as evidence; the manifest records structurally_valid:false beside crc_verified:true.');
  }
  if (!SURVEY_ONLY) console.log(`Manifest: ${join(OUT, 'manifest.json')}`);
  writeManifest();
  endMidiScript(totalFailed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.stack ?? e.message : String(e)); exitMidiScript(1); });
