/**
 * circuit-after-dark-p2-clear-midi1.ts: clear MIDI 1 on `AfterDark P2`.
 *
 * Build record: `docs/_private/rig/songs/after-dark.md` §2c.
 *
 * P2 (Pack 2 project 2, m19-34) was authored with the SQUARE lead (part 4) on
 * MIDI 1, 48 notes at 46..51. The maintainer's 2026-07-27 whole-song decision is
 * the literal reading: **MIDI 1 carries part 3, the sawtooth, and nothing else.**
 * Part 3 is silent in m19-34, so P2's MIDI 1 must be EMPTY. This clears it.
 *
 * ## Why byte-surgical rather than a re-author
 *
 * Re-authoring an occupied slot needs `confirm_overwrite`, which is the one
 * switch that turns off `gateProjectOverwrite`'s occupancy check, and this
 * device has no decoded delete. Abandoning slot 2 and re-authoring into a free
 * one breaks the contiguous 1-8 run. The surgery is the same technique as the
 * rename: bounded, backed up, and reversible.
 *
 * ## The edit is structurally confined to MIDI 1
 *
 * It uses the codec's OWN primitive, `clearNotePattern(buf, 'midi1', p)`, for
 * p = 0..7. That writes the device-native empty step (header `00 07 00 00`,
 * then six slots of `00 00 00 60`) at `noteStepBase('midi1', p) + step*28`, so
 * every byte it touches is inside midi1's own eight 896-byte pattern regions.
 * The script asserts that rather than trusting it, and the read-back tolerates
 * ZERO collateral: synth1, synth2 and midi2 must come back byte-identical.
 *
 * ## Refusals
 *
 *  - CRC-gated read; a bad CRC is a refusal.
 *  - The project name must be exactly `AfterDark P2`. It will not touch a
 *    project it did not author.
 *  - MIDI 1 must currently hold the square lead (48 notes, 46..51). Anything
 *    else is a refusal, EXCEPT already-empty, which exits clean as a no-op.
 *  - The backup must not already exist.
 *  - Any collateral byte, or any intended byte that did not land, is a
 *    fail-stop with the restore path printed.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-p2-clear-midi1.ts --offline  # no device at all
 *   npx tsx scripts/circuit-after-dark-p2-clear-midi1.ts            # dry run, reads the device
 *   npx tsx scripts/circuit-after-dark-p2-clear-midi1.ts --apply
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { connect, closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern, clearNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { getNoteChain } from '../packages/circuit-tracks/src/ncs/chain.js';
import { noteStepBase, NOTE_STEP_REGION, PATTERNS_PER_TRACK, type NoteTrack } from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const OFFLINE = argv.includes('--offline');
const devicePack = Number(flag('--pack') ?? '2');
const SLOT = Number(flag('--slot') ?? '2');

const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const EXPECT_NAME = 'AfterDark P2';
const TARGET: NoteTrack = 'midi1';
/** What MIDI 1 holds today: the square lead over m19-34. */
const EXPECT_NOTES = 48;
const EXPECT_LO = 46;
const EXPECT_HI = 51;
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** Every byte offset belonging to a note track's eight pattern regions. */
function trackRegions(track: NoteTrack): { from: number; to: number }[] {
  return Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => {
    const from = noteStepBase(track, p);
    return { from, to: from + NOTE_STEP_REGION };
  });
}
const inRegions = (off: number, regions: { from: number; to: number }[]): boolean =>
  regions.some((r) => off >= r.from && off < r.to);

function countNotes(b: Uint8Array, track: NoteTrack): { notes: number[]; steps: number } {
  const notes: number[] = [];
  let steps = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (const st of decodeNotePattern(b, track, p)) {
      if (st.notes.length) steps++;
      for (const sl of st.notes) notes.push(sl.note);
    }
  }
  return { notes, steps };
}

async function main(): Promise<void> {
  console.log(`Clear MIDI 1 on Pack ${devicePack} project ${SLOT} ("${EXPECT_NAME}")`);
  console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
  console.log('');

  // ── offline sanity: does clearNotePattern reproduce a never-written track? ──
  // If clearing an ALREADY-empty midi1 changes nothing, then the bytes this
  // script writes are exactly the bytes a never-written track holds, and the
  // cleared P2 is indistinguishable from a project authored without midi1.
  {
    const tpl = new Uint8Array(readFileSync(TEMPLATE));
    const probe = new Uint8Array(tpl);
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) clearNotePattern(probe, TARGET, p);
    let diff = 0;
    for (let i = 0; i < tpl.length; i++) if (tpl[i] !== probe[i]) diff++;
    console.log(`offline check: clearNotePattern over a never-written midi1 changes ${diff} byte(s)` +
      `${diff === 0 ? '  -> the cleared bytes ARE the device-native empty step' : '  -> WARNING: not byte-identical to an unwritten track'}`);
    // and the blast radius, in numbers
    const regions = trackRegions(TARGET);
    console.log(`  ${TARGET} occupies ${regions.length} region(s) of ${NOTE_STEP_REGION} bytes: ` +
      regions.map((r) => `0x${r.from.toString(16)}-0x${r.to.toString(16)}`).join(', '));
    const total = regions.reduce((a, r) => a + (r.to - r.from), 0);
    console.log(`  max possible blast radius: ${total} bytes of ${tpl.length} (${((total / tpl.length) * 100).toFixed(2)}%)`);
    for (const t of ['synth1', 'synth2', 'midi2'] as NoteTrack[]) {
      const rs = trackRegions(t);
      const clash = rs.some((a) => regions.some((b) => a.from < b.to && b.from < a.to));
      console.log(`  overlaps ${t}: ${clash ? 'YES - STOP' : 'no'}`);
      if (clash) exitMidiScript(1);
    }
  }
  console.log('');
  if (OFFLINE) { console.log('OFFLINE: stopping before any device contact.'); return; }

  let conn = connect(CONNECT);
  const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };

  // The Circuit flushes its pack manifest ~6-8s AFTER a session closes, so a
  // fast read can report a slot empty (or fail) when nothing is wrong. Settle
  // before the first read and retry rather than concluding a failure.
  const SETTLE_MS = 9_000, POLL_MS = 5_000, MAX_POLLS = 6;
  const sleep = (ms: number): Promise<void> => new Promise((x) => setTimeout(x, ms));
  const readStable = async (label: string): Promise<Awaited<ReturnType<typeof downloadProject>>> => {
    let last = await downloadProject(conn, SLOT - 1, { pack: devicePack - 1, reconnect });
    for (let i = 1; i <= MAX_POLLS && (!last.ok || !last.crcOk || last.bytes === undefined); i++) {
      console.log(`   ${label}: read ${i} came back ok=${last.ok} crcOk=${last.crcOk}; waiting ${POLL_MS / 1000}s and retrying (manifest flush, not a failure)`);
      await sleep(POLL_MS);
      last = await downloadProject(conn, SLOT - 1, { pack: devicePack - 1, reconnect });
    }
    return last;
  };

  console.log(`settling ${SETTLE_MS / 1000}s for the pack manifest flush before the first read...`);
  await sleep(SETTLE_MS);
  const r = await readStable('pre-read');
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`REFUSED: read failed (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}. Unreadable is a refusal.`);
    exitMidiScript(1);
  }
  const before = r.bytes;
  const name = nameOf(before);
  console.log(`project ${SLOT}  name "${name}"  CRC ok`);
  if (name !== EXPECT_NAME) {
    console.log(`REFUSED: name is "${name}", expected "${EXPECT_NAME}". Not touching a project this script did not author.`);
    exitMidiScript(1);
  }

  // ── what every track holds right now ───────────────────────────────
  const snapshot: Record<string, { notes: number[]; steps: number }> = {};
  for (const t of ['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]) {
    snapshot[t] = countNotes(before, t);
    const s = snapshot[t];
    const lo = s.notes.length ? Math.min(...s.notes) : 0, hi = s.notes.length ? Math.max(...s.notes) : 0;
    console.log(`   ${t.padEnd(7)} ${String(s.notes.length).padStart(4)} notes  ${s.notes.length ? `${lo}..${hi}` : '(empty)'}`);
  }
  const chainBefore = getNoteChain(before, TARGET);
  console.log(`   ${TARGET} chain ${chainBefore ? `[${chainBefore.start}, ${chainBefore.end}]` : '(none read)'}  (left alone: an empty pattern chained is silence, and touching it widens the blast radius for nothing)`);
  console.log('');

  const cur = snapshot[TARGET];
  if (cur.notes.length === 0) {
    console.log(`NO-OP: ${TARGET} is already empty. Nothing to do.`);
    endMidiScript(0);
    return;
  }
  const lo = Math.min(...cur.notes), hi = Math.max(...cur.notes);
  if (cur.notes.length !== EXPECT_NOTES || lo !== EXPECT_LO || hi !== EXPECT_HI) {
    console.log(`REFUSED: ${TARGET} holds ${cur.notes.length} notes at ${lo}..${hi}, expected the square lead (${EXPECT_NOTES} notes, ${EXPECT_LO}..${EXPECT_HI}).`);
    console.log('        Something other than this build wrote that track. Stopping.');
    exitMidiScript(1);
  }
  console.log(`${TARGET} holds the square lead as expected: ${cur.notes.length} notes, ${lo}..${hi}, across ${cur.steps} step(s)`);

  // ── build the edit, and prove it is confined to midi1 ──────────────
  const after = new Uint8Array(before);
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) clearNotePattern(after, TARGET, p);
  const edits: { off: number; to: number }[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) edits.push({ off: i, to: after[i] });
  const regions = trackRegions(TARGET);
  const stray = edits.filter((e) => !inRegions(e.off, regions));
  console.log(`edit: ${edits.length} byte(s), all within ${TARGET}'s 8 pattern regions: ${stray.length === 0}`);
  if (stray.length > 0) {
    console.log(`REFUSED: ${stray.length} edit(s) fall OUTSIDE ${TARGET} (first at 0x${stray[0].off.toString(16)}). Refusing to write.`);
    exitMidiScript(1);
  }
  // and nothing outside midi1 may differ, by construction; assert it anyway
  for (const t of ['synth1', 'synth2', 'midi2'] as NoteTrack[]) {
    const rs = trackRegions(t);
    const hit = edits.filter((e) => inRegions(e.off, rs));
    if (hit.length > 0) { console.log(`REFUSED: ${hit.length} edit(s) land inside ${t}.`); exitMidiScript(1); }
  }
  const post = countNotes(after, TARGET);
  console.log(`after the edit (in memory): ${TARGET} holds ${post.notes.length} notes`);
  if (post.notes.length !== 0) { console.log('REFUSED: the clear did not empty the track in memory.'); exitMidiScript(1); }

  if (!APPLY) {
    console.log('\nDRY RUN complete. Re-run with --apply to write.');
    endMidiScript(0);
    return;
  }

  // ── backup, write, verify ──────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `samples/circuit-ncs/restore-afterdark-p2-midi1-${stamp}`;
  mkdirSync(backupDir, { recursive: true });
  const backup = `${backupDir}/pack${devicePack}-proj${String(SLOT).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`REFUSED: backup ${backup} already exists.`); exitMidiScript(1); }
  writeFileSync(backup, before);
  console.log(`\nbackup written: ${backup} (${before.length} bytes, the FULL pre-edit project)`);

  const up = await uploadProject(conn, after, SLOT - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`UPLOAD FAILED: ${up.error ?? 'unknown'}. Original at ${backup}`);
    exitMidiScript(1);
  }
  console.log('upload ok');

  console.log(`settling ${SETTLE_MS / 1000}s for the pack manifest flush before verifying...`);
  await sleep(SETTLE_MS);
  const v = await readStable('verify');
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    exitMidiScript(1);
  }
  const intended = new Map(edits.map((e) => [e.off, e.to]));
  const wrong: string[] = [];
  let collateral = 0;
  const collateralOffs: number[] = [];
  for (let i = 0; i < before.length; i++) {
    const w = intended.get(i);
    if (w !== undefined) { if (v.bytes[i] !== w) wrong.push(`0x${i.toString(16)}=${v.bytes[i]} (wanted ${w})`); }
    else if (v.bytes[i] !== before[i]) { collateral++; if (collateralOffs.length < 6) collateralOffs.push(i); }
  }
  console.log(`\nread-back: ${edits.length - wrong.length}/${edits.length} intended byte(s) landed, collateral ${collateral}`);
  if (wrong.length > 0 || collateral !== 0) {
    console.log(`VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 4).join(', ')}), collateral at ${collateralOffs.map((o) => `0x${o.toString(16)}`).join(', ')}`);
    console.log(`restore with ${backup}`);
    exitMidiScript(1);
  }

  // decoded assertions, not just bytes
  let ok = true;
  for (const t of ['synth1', 'synth2', 'midi1', 'midi2'] as NoteTrack[]) {
    const now = countNotes(v.bytes, t);
    const was = snapshot[t];
    const want = t === TARGET ? 0 : was.notes.length;
    const same = now.notes.length === want && (t === TARGET || now.notes.every((x, i) => x === was.notes[i]));
    if (!same) ok = false;
    const l = now.notes.length ? Math.min(...now.notes) : 0, h = now.notes.length ? Math.max(...now.notes) : 0;
    console.log(`   ${t.padEnd(7)} ${same ? 'OK  ' : 'FAIL'} ${String(now.notes.length).padStart(4)} notes ${now.notes.length ? `${l}..${h}` : '(empty)'}   ${t === TARGET ? '[wanted EMPTY]' : `[wanted unchanged: ${was.notes.length}]`}`);
  }
  const chainAfter = getNoteChain(v.bytes, TARGET);
  console.log(`   ${TARGET} chain ${chainAfter ? `[${chainAfter.start}, ${chainAfter.end}]` : '(none read)'} (unchanged, as intended)`);
  console.log(ok ? '\nVERDICT: PASS. MIDI 1 is empty, everything else is byte-identical.' : '\nVERDICT: FAIL. Investigate before playing.');
  console.log(`restore point: ${backup}`);
  endMidiScript(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exitCode = 1; });
