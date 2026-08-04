/**
 * Rewrite one MIDI note to another across stored Circuit projects, on-device.
 *
 * A general repair tool for a drum part authored onto the wrong pad note. It
 * takes `--from` / `--to` and does NOT encode any particular defect.
 *
 * ## Read this before deciding a note is "wrong"
 *
 * This script was written during an investigation that FIRST reached the wrong
 * conclusion, so the corrected understanding is recorded here to stop the next
 * reader repeating it.
 *
 * The full authored-to-pad chain is FOUR transforms, and reasoning about any
 * prefix of it produces confident wrong answers:
 *
 *   1. voice name -> General MIDI note              (device `voice_map`)
 *   2. + `note_offset: 12`, stored in the .ncs      (`external_targets`)
 *   3. the Circuit transmits MIDI-track notes an OCTAVE LOW   (commit 8a09e7c,
 *      hardware-confirmed HW-SPDSX-007 2026-06-29)
 *   4. wire note -> pad, by that pad's own `NoteNum`  (per-kit device setting)
 *
 * Stages 2 and 3 CANCEL. Stored GM+12 arrives on the wire as raw GM. So the
 * `+12` is correct and must not be "fixed" away, and a stored note only means
 * something once stages 3 and 4 are applied.
 *
 * THE MISTAKE WORTH NOT REPEATING: a stored 51 was judged wrong because 50
 * dominated the corpus. Decoded properly, 51 is GM 39, a CLAP, which the song's
 * own source confirms for those sections. Corpus frequency is not evidence about
 * a transform. Decode the chain first; only then does the majority corroborate.
 *
 * The durable fixes are a write-time pad-note gate and an explicit per-call note
 * map (so patterns stop aliasing voices through a map that can move). This
 * script only repairs data already written.
 *
 * ## Why download-patch-upload and NOT uploading a corrected local copy
 *
 * The on-disk corpus snapshots predate later edits (the mixer-level batch set
 * synth1/synth2 levels to 0 AFTER those snapshots were taken). Uploading a
 * corrected snapshot would silently REVERT every change made since. So the
 * device is always the source of truth: read it, change only the note bytes,
 * write it back.
 *
 * ── SAFETY PROPERTIES (inherited from circuit-batch-mixer-levels; each earned
 *    from a real incident, do not remove) ─────────────────────────────────────
 *  - DRY RUN by default; `--apply` required to write.
 *  - CRC GATED: `ok` only checks length, so `crcOk` is checked independently.
 *  - PER-SLOT TIMESTAMPED backups (one filename in a loop leaves only the last).
 *  - NAME ASSERTION on read-back: a write to the wrong slot is else invisible.
 *  - IDEMPOTENT: a slot with no occurrences of the wrong note is skipped.
 *  - FAIL-STOP on first failure, reporting exactly what is done vs untouched.
 *  - READ-BACK VERIFY with a COLLATERAL COUNT: the only bytes allowed to differ
 *    are the note bytes we meant to change.
 *  - CONFLICT GUARD: a pattern holding BOTH notes breaks the "one voice, two
 *    spellings" premise, so it is refused rather than silently merged.
 *  - `reconnect` returns a FRESH connection (the Circuit reboots after upload).
 *
 * Usage (dry run by default; `--from` / `--to` are REQUIRED):
 *   npx tsx scripts/circuit-fix-pad-note.ts --pack 5 --slots 1-64 --from 51 --to 50
 *   npx tsx scripts/circuit-fix-pad-note.ts --pack 5 --slots 1-64 --from 51 --to 50 --apply
 *   ... --track midi2        (default track)
 *
 * `--pack` and `--slots` are 1-BASED device numbering, as the front panel shows.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern, setNoteStepVerbatim } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { PATTERNS_PER_TRACK, type NoteTrack } from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '5');
// No defaults: which note is "wrong" depends on the section and the target kit,
// and a baked-in default is exactly how a one-off conclusion becomes a standing
// assumption. Both must be stated explicitly.
const FROM = Number(flag('--from'));
const TO = Number(flag('--to'));
if (!Number.isInteger(FROM) || !Number.isInteger(TO) || FROM < 0 || FROM > 127 || TO < 0 || TO > 127) {
  console.error('--from and --to are required, each a MIDI note 0..127.');
  console.error('  npx tsx scripts/circuit-fix-pad-note.ts --pack 5 --slots 1-64 --from 51 --to 50 [--apply]');
  process.exit(2);
}
const TRACK = (flag('--track') ?? 'midi2') as NoteTrack;

function parseSlots(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad --slots segment "${part}"`);
    const a = Number(m[1]); const b = m[2] === undefined ? a : Number(m[2]);
    for (let i = a; i <= b; i++) out.push(i);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}
const slotSpec = flag('--slots') ?? '1-64';
const slots = parseSlots(slotSpec);

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-padnote-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
// `reconnectMidi` RELEASES the old handle before opening the new one. Plain
// reassignment leaked a loop-pinning input handle per reconnect, which is what
// left this script running (and holding the port) after its last output line.
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, slots ${slotSpec}: rewrite ${TRACK} note ${FROM} -> ${TO}`);
console.log(APPLY ? `MODE: APPLY (backups -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');
if (APPLY) mkdirSync(backupDir, { recursive: true });

let patched = 0, clean = 0, blocked = 0, empty = 0;
for (const slot of slots) {
  const tag = `project ${String(slot).padStart(2)}`;
  let r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    await sleep(1500);
    r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    // An EMPTY slot is a normal pack state, not a fault: scanning a whole pack
    // must step over the gaps. Only a real read fault is fail-stop, because
    // that one means the device or transport is unhealthy and continuing would
    // write against unreliable reads.
    if (/empty slot|no readable project/i.test(r.error ?? '')) { empty++; continue; }
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  const b = r.bytes;
  const nm = nameOf(b);

  // Locate every step carrying the wrong note, and refuse any pattern that
  // holds both notes (that would be two real voices, not a mis-author).
  const edits: { pattern: number; step: number }[] = [];
  let conflict = false;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const steps = decodeNotePattern(b, TRACK, p);
    const present = new Set<number>();
    for (const s of steps) if (s.active) for (const n of s.notes) present.add(n.note);
    if (present.has(FROM) && present.has(TO)) { conflict = true; continue; }
    steps.forEach((s, i) => {
      if (s.active && s.notes.some((n) => n.note === FROM)) edits.push({ pattern: p, step: i });
    });
  }
  if (conflict) {
    console.log(`  ${tag}  "${nm}"  BLOCKED: a pattern holds BOTH ${FROM} and ${TO} — not a clean mis-author.`);
    blocked++; continue;
  }
  if (edits.length === 0) { clean++; continue; }

  if (!APPLY) {
    console.log(`  ${tag}  "${nm}"  would fix ${edits.length} step(s) ${FROM} -> ${TO}`);
    continue;
  }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  ${tag}  refusing to overwrite existing backup ${backup}`); process.exit(1); }
  writeFileSync(backup, b);

  const out = Buffer.from(b);
  for (const e of edits) {
    // Re-decode so gate / tie / delay / velocity / probability ride along
    // untouched: only the note NUMBER is wrong, and rewriting the rest from
    // defaults would flatten the part's feel while "fixing" it.
    //
    // VERBATIM, not the authoring `setNoteStep`. This is a read-modify-write of
    // real device data, and the authoring primitive normalizes a step to the
    // leading-packed shape: it would re-pack a GAPPED slot mask (the device
    // does not always leading-pack, a factory step reads mask 0x05) and
    // overwrite the muted stale records sitting in the slots the mask skips.
    // Both are bytes this script has no business moving; the collateral check
    // below would fail-stop on them, so today that is a refusal rather than
    // corruption, but the correct behaviour is to leave them alone. Verbatim
    // also carries the one corpus slot holding note number 128 through
    // unchanged instead of refusing the file.
    const src = decodeNotePattern(out, TRACK, e.pattern)[e.step]!;
    setNoteStepVerbatim(out, TRACK, e.pattern, e.step, {
      ...src,
      notes: src.notes.map((n) => (n.note === FROM ? { ...n, note: TO } : n)),
    });
  }

  const up = await uploadProject(conn, out, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`  ${tag}  UPLOAD FAILED: ${up.error ?? 'unknown'}  (original at ${backup})`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }

  const v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  ${tag}  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    process.exit(1);
  }
  // Collateral: the ONLY bytes allowed to differ are the ones we rewrote.
  let collateral = 0;
  for (let i = 0; i < b.length; i++) if (b[i] !== v.bytes[i]) collateral++;
  let remaining = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (const s of decodeNotePattern(v.bytes, TRACK, p)) {
      if (s.active) for (const n of s.notes) if (n.note === FROM) remaining++;
    }
  }
  if (remaining > 0 || collateral !== edits.length || nameOf(v.bytes) !== nm) {
    console.log(`  ${tag}  VERIFY FAILED: ${remaining} left on ${FROM}, collateral=${collateral} (expected ${edits.length}), name="${nameOf(v.bytes)}"`);
    console.log(`             restore with ${backup}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  // `collateral` EQUALS edits.length on success (one note byte per fixed step);
  // the assertion above is that nothing BEYOND those bytes moved. Saying "0
  // collateral" here would misreport what was actually checked.
  console.log(`  ${tag}  "${nm}"  ${edits.length} step(s) ${FROM} -> ${TO}  verified, no bytes changed beyond the ${edits.length} note byte(s)`);
  patched++;
  await sleep(400);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${patched} patched, ${clean} already clean, ${blocked} blocked, ${empty} empty.`);
if (APPLY && patched > 0) console.log(`restore points: ${backupDir}`);
endMidiScript();
