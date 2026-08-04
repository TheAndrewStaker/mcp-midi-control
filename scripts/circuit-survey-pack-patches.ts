/**
 * circuit-survey-pack-patches.ts — READ-ONLY inventory of what a Circuit Tracks
 * holds in its SYNTH PATCH stores, so a "clone Pack 1's patches onto Pack N"
 * question can be answered with data instead of an inference from the sample
 * path's shape.
 *
 * ## Why this is a survey and not a clone
 *
 * There are TWO different patch stores on this device and only one of them is
 * pack-addressed:
 *
 *  1. The **synth patch BANK** (64 Flash slots per synth part) — what a project
 *     references and what you hear. Written ONLY by Replace-Patch
 *     (`codec/sysex.ts buildReplaceFlashPatch`), a one-shot SysEx whose frame is
 *     `F0 00 20 29 01 64 01 00 <slotHi> <slotLo> 00 <340 body> F7`. There is NO
 *     pack byte in it. It writes whichever pack the FRONT PANEL has selected,
 *     and per `docs/design/circuit-pack-addressing.md` §2 nothing on the wire
 *     selects or even reports the active pack.
 *  2. The **patch FILE store** (file-transfer fileType 0x04, `NN_PATCHBANK.cpb`)
 *     — pack-addressed like projects (0x03) and samples (0x05), READ-decoded
 *     (`codec/patchTransfer.ts readStoredPatch`), but with NO write builder
 *     anywhere in the tree, and hardware-shown on 2026-07-03 NOT to back the
 *     synth bank (a freshly saved slot read back empty from it while being
 *     audibly present).
 *
 * So this script READS both and reports. It never sends Replace-Patch, never
 * sends WRITE_INIT/DATA/FINISH/SET_FILENAME, and never touches Flash.
 *
 * ## How the bank read distinguishes "empty" from "occupied"
 *
 * A Program Change on a synth channel loads an OCCUPIED bank slot into the
 * working buffer and does NOTHING on an empty one (hardware-confirmed
 * 2026-07-03). A naive PC→dump loop therefore re-reports the PREVIOUS slot's
 * patch for every empty slot. This loop first pushes a SENTINEL body (the live
 * buffer, renamed) with Replace-Current, then PCs, then dumps: a name that is
 * still the sentinel means the PC did nothing, i.e. the slot is empty.
 *
 * Replace-Current writes RAM only and is revertable; the original working buffer
 * is dumped up front and pushed back at the end.
 *
 * ## What it found, 2026-07-27 (full write-up: docs/design/circuit-patch-capture.md)
 *
 *  - `--diagnose` **REFUTED** the 2026-07-03 claim that a Program Change loads a
 *    bank slot. A sentinel survives 800 ms with no PC, yet PC 0 / 40 / 63 all
 *    return the SAME patch: PC reverts the live edit and ignores its number. So
 *    `readStoredPatchViaLoad` returns the CURRENTLY LOADED patch for every slot,
 *    and there is no read path for a bank slot on any pack.
 *  - `--verify-embed` **DECODED** the `.ncs` embedded patch bodies: Synth 1 at
 *    0x26d14, Synth 2 at 0x26e68, 340 bytes each, 340/340 byte-identical to the
 *    device's own dump on both parts. A project CARRIES its sounds rather than
 *    referencing the destination pack's bank, which is why an incomplete
 *    pack clone does not change how a project sounds.
 *
 * ## Usage
 *
 *   npx tsx scripts/circuit-survey-pack-patches.ts
 *   npx tsx scripts/circuit-survey-pack-patches.ts --no-bank             # file store only
 *   npx tsx scripts/circuit-survey-pack-patches.ts --diagnose            # is PC a select or a revert?
 *   npx tsx scripts/circuit-survey-pack-patches.ts --verify-embed a.ncs  # device dump vs the file's regions
 *   npx tsx scripts/circuit-survey-pack-patches.ts --check-projects 2 --slots 0-7
 *   ... --parts 1 --slots 0-15
 */
import { connect, type MidiConnection } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript } from './_lib/midi-lifecycle.js';
import { readPackDirectory } from '../packages/circuit-tracks/src/ncs/packDirectory.js';
import { readFileDirectory, SAMPLE_DIRECTORY_CONSTANTS } from '../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { readCurrentPatch } from '../packages/circuit-tracks/src/codec/patchTransfer.js';
import { buildReplaceCurrentPatch, type SynthLocation } from '../packages/circuit-tracks/src/codec/sysex.js';
import { decodePatchName, encodePatchName } from '../packages/circuit-tracks/src/codec/blob.js';
import { crc32 } from '../packages/circuit-tracks/src/ncs/transfer.js';

const FILE_TYPE_PATCH = SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_PATCH; // 0x04
const SENTINEL = '~~NOSLOT~~';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const NO_BANK = argv.includes('--no-bank');
const DIAGNOSE = argv.includes('--diagnose');
const VERIFY_EMBED = flag('--verify-embed');
const CHECK_PACK = flag('--check-projects'); // 1-based pack number
const PARTS: SynthLocation[] = (flag('--parts') ?? '1,2').split(',').map((s) => (Number(s.trim()) - 1) as SynthLocation);
const SLOT_SPEC = flag('--slots');

const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).' } as const;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function parseSlots(spec: string | undefined): number[] {
  if (spec === undefined) return Array.from({ length: 64 }, (_, i) => i);
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad --slots segment "${part}"`);
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

interface BankSlot { slot: number; name?: string; fingerprint?: number }

/**
 * Read one synth part's whole 64-slot Flash BANK by sentinel + PC + dump.
 * Read-only w.r.t. Flash. Restores the working buffer before returning.
 */
async function readBank(conn: MidiConnection, loc: SynthLocation, slots: readonly number[]): Promise<BankSlot[]> {
  const before = await readCurrentPatch(conn, loc, {});
  if (!before.ok || !before.body) throw new Error(`could not dump Synth ${loc + 1}'s working buffer: ${before.error ?? 'no reply'}`);
  const backup = Array.from(before.body);
  const sentinel = Uint8Array.from(backup);
  encodePatchName(sentinel, SENTINEL);
  const sentinelBody = Array.from(sentinel);

  // SELF-CHECK the sentinel before trusting it. If Replace-Current does not land,
  // every dump returns the buffer we started with and EVERY slot falsely reads as
  // "occupied, same patch" — the exact false positive this technique exists to
  // avoid, inverted. Refuse rather than report a fiction.
  conn.send(buildReplaceCurrentPatch(sentinelBody, loc));
  await sleep(200);
  const probe = await readCurrentPatch(conn, loc, {});
  const probeName = probe.ok && probe.body ? decodePatchName(Array.from(probe.body)) : '(no reply)';
  if (probeName !== SENTINEL) {
    conn.send(buildReplaceCurrentPatch(backup, loc));
    await sleep(150);
    throw new Error(
      `Replace-Current did not land on Synth ${loc + 1} (buffer still reads "${probeName}", expected "${SENTINEL}"). ` +
      'Without a working sentinel an empty slot is indistinguishable from an occupied one, so this survey refuses to guess.',
    );
  }

  const out: BankSlot[] = [];
  try {
    for (const slot of slots) {
      conn.send(buildReplaceCurrentPatch(sentinelBody, loc));
      await sleep(90);
      conn.send([0xc0 | (loc & 0x0f), slot & 0x7f]); // PC on the synth channel
      await sleep(220);
      const r = await readCurrentPatch(conn, loc, {});
      if (!r.ok || !r.body) { out.push({ slot }); continue; }
      const body = Array.from(r.body);
      const name = decodePatchName(body);
      if (name === SENTINEL) { out.push({ slot }); continue; } // PC did nothing => empty
      out.push({ slot, name, fingerprint: crc32(Uint8Array.from(body)) });
    }
  } finally {
    conn.send(buildReplaceCurrentPatch(backup, loc));
    await sleep(150);
  }
  return out;
}

/**
 * Discriminate WHY a bank sweep reports one identical patch for every slot.
 * Three candidate causes, each with a distinguishing observation:
 *   A. Replace-Current never lands  → step 2 reads the original buffer.
 *   B. The buffer reverts on a timer → step 2 reads the original buffer too, but
 *      step 2 uses NO PC, so a sentinel that survives 800 ms rules this out.
 *   C. Program Change does not SELECT, it only REVERTS the live edit → the
 *      sentinel survives without a PC (step 2) but three different PC numbers
 *      all return the SAME patch (steps 3-5). That is the refutation of
 *      `readStoredPatchViaLoad`'s premise.
 * Read-only w.r.t. Flash.
 */
async function diagnose(conn: MidiConnection, loc: SynthLocation): Promise<void> {
  const before = await readCurrentPatch(conn, loc, {});
  if (!before.ok || !before.body) throw new Error(`no working-buffer dump for Synth ${loc + 1}`);
  const backup = Array.from(before.body);
  const sentinel = Uint8Array.from(backup);
  encodePatchName(sentinel, SENTINEL);
  const sentinelBody = Array.from(sentinel);
  const nameNow = async (): Promise<string> => {
    const r = await readCurrentPatch(conn, loc, {});
    return r.ok && r.body ? decodePatchName(Array.from(r.body)) : '(no reply)';
  };

  console.log(`\n   Synth ${loc + 1} diagnostic (currently loaded: "${decodePatchName(backup)}")`);
  try {
    console.log('      [1] baseline dump                        -> ' + `"${await nameNow()}"`);

    conn.send(buildReplaceCurrentPatch(sentinelBody, loc));
    await sleep(800);
    const survived = await nameNow();
    console.log(`      [2] Replace-Current, 800 ms, NO PC       -> "${survived}"  ${survived === SENTINEL ? '(sentinel survives: it lands and does not self-revert)' : '(sentinel LOST: Replace-Current is not usable as a marker)'}`);

    for (const target of [0, 40, 63]) {
      conn.send(buildReplaceCurrentPatch(sentinelBody, loc));
      await sleep(150);
      conn.send([0xc0 | (loc & 0x0f), target & 0x7f]);
      await sleep(800);
      console.log(`      [3] sentinel then PC ${String(target).padStart(2)}, 800 ms          -> "${await nameNow()}"`);
    }
  } finally {
    conn.send(buildReplaceCurrentPatch(backup, loc));
    await sleep(200);
  }
}

/**
 * Oracle for the claim "a `.ncs` project EMBEDS both synth patch bodies at
 * 0x26d14 (Synth 1) and 0x26e68 (Synth 2), in the SAME 340-byte encoding the
 * SysEx Dump Request returns".
 *
 * The check is self-validating in the way that matters: it diffs the file's
 * bytes against the DEVICE's own dump of the loaded project's working buffer.
 * A wrong offset, a wrong length, or a different encoding cannot produce a
 * near-exact match across 340 bytes by accident. Body offset 17 is the
 * dirty-edit marker (`savePatch` clears it), so it is reported separately
 * rather than counted as a mismatch.
 */
async function verifyEmbed(conn: MidiConnection, ncsPath: string): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const file = readFileSync(ncsPath);
  const REGIONS: { loc: SynthLocation; off: number }[] = [{ loc: 0, off: 0x26d14 }, { loc: 1, off: 0x26e68 }];
  console.log(`EMBEDDED-PATCH ORACLE vs ${ncsPath} (${file.length} bytes)\n`);
  for (const { loc, off } of REGIONS) {
    const r = await readCurrentPatch(conn, loc, {});
    if (!r.ok || !r.body) { console.log(`   Synth ${loc + 1}: no dump (${r.error ?? 'no reply'})`); continue; }
    const live = Array.from(r.body);
    const embedded = Array.from(file.subarray(off, off + live.length));
    const diffs: number[] = [];
    for (let i = 0; i < live.length; i++) if (live[i] !== embedded[i]) diffs.push(i);
    const dirtyOnly = diffs.length === 1 && diffs[0] === 17;
    console.log(
      `   Synth ${loc + 1} @0x${off.toString(16)}: file name "${decodePatchName(embedded)}", live name "${decodePatchName(live)}", ` +
      `${live.length - diffs.length}/${live.length} bytes identical` +
      (diffs.length === 0 ? '  -> BYTE-IDENTICAL' : dirtyOnly ? '  -> identical except body[17], the dirty-edit marker' : `  -> differing offsets: ${diffs.slice(0, 12).join(',')}${diffs.length > 12 ? ` …(+${diffs.length - 12})` : ''}`),
    );
    await sleep(150);
  }
}

/**
 * Read projects OFF a pack and report which synth patch each one CARRIES at the
 * two embedded-body offsets. This is the question that actually decides whether
 * an incomplete pack clone hurt: a project that embeds its sounds does not care
 * what the destination pack's patch BANK holds. CRC-gated by the device.
 */
async function checkProjects(conn: MidiConnection, pack: number, slots: readonly number[]): Promise<void> {
  const { downloadProject } = await import('../packages/circuit-tracks/src/ncs/uploadProject.js');
  // The project name lives at 0x10, 16 ASCII chars (ncs/format.ts module docstring).
  // uploadProject.ts has a private decoder for it; inline rather than widen its API.
  const decodeProjectName = (b: Uint8Array): string =>
    Array.from(b.subarray(0x10, 0x20)).map((c) => String.fromCharCode(c & 0x7f)).join('').replace(/\s+$/u, '');
  console.log(`PROJECTS ON PACK ${pack + 1} (wire ${pack}) — the synth patch each one CARRIES:\n`);
  for (const slot of slots) {
    const dl = await downloadProject(conn, slot, { pack });
    if (dl.empty) { console.log(`   slot ${String(slot).padStart(2)}  (empty)`); continue; }
    if (!dl.bytes || dl.bytes.length < 0x26e68 + 340) { console.log(`   slot ${String(slot).padStart(2)}  READ FAILED: ${dl.error ?? 'short read'}`); continue; }
    const b = dl.bytes;
    console.log(
      `   slot ${String(slot).padStart(2)}  "${decodeProjectName(b)}"`.padEnd(38) +
      `Synth 1 = "${decodePatchName(Array.from(b.subarray(0x26d14, 0x26d14 + 340)))}"`.padEnd(30) +
      `Synth 2 = "${decodePatchName(Array.from(b.subarray(0x26e68, 0x26e68 + 340)))}"`.padEnd(28) +
      `crc=${dl.crcOk ? 'OK' : 'MISMATCH'}`,
    );
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const slots = parseSlots(SLOT_SPEC);
  console.log('Circuit Tracks PATCH-STORE SURVEY (read-only: no Replace-Patch, no file WRITE frames)\n');

  const conn = connect(CONNECT);
  if (!conn.hasInput) { console.log('REFUSED: no input port; every read here needs a bidirectional connection.'); exitMidiScript(2); }

  if (VERIFY_EMBED) { await verifyEmbed(conn, VERIFY_EMBED); endMidiScript(); return; }
  if (CHECK_PACK !== undefined) { await checkProjects(conn, Number(CHECK_PACK) - 1, slots); endMidiScript(); return; }

  // ── 1. The card's packs ────────────────────────────────────────────
  const packs = await readPackDirectory(conn);
  console.log(`CARD: ${packs.count} pack(s)`);
  for (const p of packs.packs) console.log(`   Pack ${p.device_pack}  (wire ${p.index})  "${p.name}"`);
  console.log('');
  await sleep(300);

  // ── 2. The PACK-ADDRESSED patch FILE store (fileType 0x04) ─────────
  console.log('PATCH FILE STORE (file-transfer fileType 0x04, pack-addressed, read-decoded):');
  for (const p of packs.packs) {
    const dir = await readFileDirectory(conn, FILE_TYPE_PATCH, p.index);
    const named = dir.slots.filter((s) => s.name !== undefined);
    console.log(`   Pack ${p.device_pack} (wire ${p.index}): ${dir.occupied}/${dir.total} occupied`);
    for (const s of named) console.log(`        [${String(s.slot).padStart(2)}] ${s.name}`);
    if (named.length === 0) console.log('        (none)');
    await sleep(300);
  }
  console.log('');

  if (DIAGNOSE) {
    console.log('PROGRAM-CHANGE SELECT DIAGNOSTIC (read-only w.r.t. Flash):');
    for (const loc of PARTS) if (loc === 0 || loc === 1) await diagnose(conn, loc);
    console.log('');
    endMidiScript();
    return;
  }

  if (NO_BANK) { console.log('--no-bank: skipping the live synth-bank survey.'); endMidiScript(); return; }

  // ── 3. The ACTIVE pack's synth BANK (what projects actually play) ──
  console.log('ACTIVE-PACK SYNTH BANK (Replace-Patch store; NOT pack-addressable — this is whatever pack the front panel has selected):');
  for (const loc of PARTS) {
    if (loc !== 0 && loc !== 1) { console.log(`   (skipping bad part ${loc + 1})`); continue; }
    console.log(`\n   Synth ${loc + 1}:`);
    const bank = await readBank(conn, loc, slots);
    const occupied = bank.filter((b) => b.name !== undefined);
    for (const b of bank) {
      console.log(`      [${String(b.slot).padStart(2)}] ${b.name === undefined ? '(empty)' : `"${b.name}"  crc=${(b.fingerprint! >>> 0).toString(16).padStart(8, '0')}`}`);
    }
    const distinct = new Set(occupied.map((b) => b.fingerprint));
    const names = new Set(occupied.map((b) => b.name));
    console.log(`      -- Synth ${loc + 1}: ${occupied.length}/${bank.length} occupied, ${distinct.size} distinct body/bodies, ${names.size} distinct name(s)`);
    await sleep(300);
  }

  console.log('\nSurvey complete. Nothing was written to Flash.');
  endMidiScript();
}

main().catch((e) => { console.error('ERROR:', e instanceof Error ? e.message : e); endMidiScript(1); });
