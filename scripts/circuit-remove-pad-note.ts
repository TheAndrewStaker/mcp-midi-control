/**
 * Remove one MIDI note from stored Circuit projects, on-device, WITHOUT touching
 * anything else about the steps that survive.
 *
 * The sibling `circuit-fix-pad-note.ts` REWRITES a note (`--from`/`--to`). This
 * one DELETES it. The distinction is not cosmetic: a hit that the source score
 * does not sound must not be rehomed onto a different pad, because that invents
 * a note the song never had. Rewriting is right when a real voice went to the
 * wrong pad; removal is right when the hit should not exist at all.
 *
 * ## Why this had to be byte-surgical rather than `setNoteStep`
 *
 * Two independent reasons, each of which alone would rule the helper out:
 *
 *  1. GATES ARE HAND-SET AT THE DEVICE. The authoring path only ever emits
 *     `DEFAULT_GATE = 6`, yet stored projects hold gates of 12/24/48/96 (and
 *     224 in the wild). Those are note lengths the player dialled in by hand
 *     after authoring. Any path that re-derives a surviving note from defaults
 *     destroys that work, so every surviving slot's four bytes
 *     (note/gate/delay/velocity) are copied VERBATIM, never rebuilt.
 *  2. `normalizeNotes` VALIDATES gate as 0..127 (`notePattern.ts`), and gate
 *     224 (0xE0) genuinely occurs in stored data. Round-tripping real projects
 *     through that validator throws. This script reads and writes the step
 *     record directly, so a gate value it does not understand rides through
 *     untouched instead of being clamped, masked, or rejected. If a gate looks
 *     wrong, that is a REPORT, not something to repair here.
 *
 * The step header's `probability` byte is likewise preserved, and the slot mask
 * is rewritten to the leading-packed form the device itself produces
 * ((1<<k)-1), so a partially-emptied step is a shape the Circuit already makes.
 *
 * ── SAFETY PROPERTIES (inherited from circuit-fix-pad-note.ts; each earned from
 *    a real incident, do not remove) ──────────────────────────────────────────
 *  - DRY RUN by default; `--apply` required to write.
 *  - CRC GATED: `ok` only checks length, so `crcOk` is checked independently.
 *  - PER-SLOT TIMESTAMPED backups (one filename in a loop leaves only the last).
 *  - NAME ASSERTION on read-back: a write to the wrong slot is else invisible.
 *  - IDEMPOTENT: a slot with no occurrences of the note is skipped.
 *  - EMPTY SLOTS ARE NORMAL pack state, not a transport fault; only a real read
 *    fault is fail-stop.
 *  - FAIL-STOP on first failure, reporting exactly what is done vs untouched.
 *  - READ-BACK VERIFY against the EXACT expected image, not a byte count: the
 *    device must return precisely the buffer we sent, so any drift at all is
 *    caught rather than being absorbed into an "expected collateral" tally.
 *  - `reconnect` returns a FRESH connection (the Circuit reboots after upload).
 *
 * Usage (dry run by default; `--note` is REQUIRED):
 *   npx tsx scripts/circuit-remove-pad-note.ts --pack 5 --slots 46-55,7 --note 68
 *   npx tsx scripts/circuit-remove-pad-note.ts --pack 5 --slots 46-55,7 --note 68 --apply
 *   ... --track midi2        (default track)
 *
 * `--pack` and `--slots` are 1-BASED device numbering, as the front panel shows.
 * The dry run also prints each slot's full note histogram, so it doubles as the
 * read-only census you want before deciding anything.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  PATTERNS_PER_TRACK,
  STEPS_PER_PATTERN,
  NOTE_SLOTS_PER_STEP,
  NOTE_STEP_BYTES,
  noteStepBase,
  type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '5');
const NOTE = Number(flag('--note'));
if (!Number.isInteger(NOTE) || NOTE < 0 || NOTE > 127) {
  console.error('--note is required, a MIDI note 0..127 (the STORED note, before the octave-low transmit).');
  console.error('  npx tsx scripts/circuit-remove-pad-note.ts --pack 5 --slots 46-55 --note 68 [--apply]');
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

/** A step's raw slot records, read WITHOUT the 0..127 gate validator. */
interface RawSlot { note: number; gate: number; delay: number; velocity: number }
function readStepRaw(b: Uint8Array, track: NoteTrack, pattern: number, step: number): { mask: number; prob: number; slots: RawSlot[] } {
  const base = noteStepBase(track, pattern) + step * NOTE_STEP_BYTES;
  const mask = b[base];
  const slots: RawSlot[] = [];
  for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
    if ((mask >> n) & 1) {
      const s = base + 4 + n * 4;
      slots.push({ note: b[s], gate: b[s + 1], delay: b[s + 2], velocity: b[s + 3] });
    }
  }
  return { mask, prob: b[base + 1], slots };
}
/** Rewrite a step from raw slot records, preserving each record's bytes verbatim. */
function writeStepRaw(b: Uint8Array, track: NoteTrack, pattern: number, step: number, prob: number, slots: readonly RawSlot[]): void {
  const base = noteStepBase(track, pattern) + step * NOTE_STEP_BYTES;
  b[base] = (1 << slots.length) - 1;
  b[base + 1] = prob;
  b[base + 2] = 0;
  b[base + 3] = 0;
  for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
    const s = base + 4 + n * 4;
    const src = slots[n];
    if (src !== undefined) {
      b[s] = src.note; b[s + 1] = src.gate; b[s + 2] = src.delay; b[s + 3] = src.velocity;
    } else {
      // The device's own empty-slot record. Matching it keeps a partially
      // emptied step byte-identical in shape to one the Circuit itself writes.
      b[s] = 0; b[s + 1] = 0; b[s + 2] = 0; b[s + 3] = 0x60;
    }
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-removenote-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
// `reconnectMidi` RELEASES the old handle before opening the new one. Plain
// reassignment leaked a loop-pinning input handle per reconnect, which is what
// left this script running (and holding the port) after its last output line.
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, slots ${slotSpec}: REMOVE ${TRACK} note ${NOTE}`);
console.log(APPLY ? `MODE: APPLY (backups -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');
if (APPLY) mkdirSync(backupDir, { recursive: true });

let patched = 0, clean = 0, empty = 0;
for (const slot of slots) {
  const tag = `project ${String(slot).padStart(2)}`;
  let r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    await sleep(1500);
    r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    if (/empty slot|no readable project/i.test(r.error ?? '')) { empty++; continue; }
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  const b = r.bytes;
  const nm = nameOf(b);

  // Census + edit plan in one walk.
  const hist = new Map<number, number>();
  const gates = new Map<number, number>();
  const edits: { pattern: number; step: number; keep: RawSlot[]; prob: number }[] = [];
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const st = readStepRaw(b, TRACK, p, s);
      if (st.mask === 0) continue;
      for (const sl of st.slots) {
        hist.set(sl.note, (hist.get(sl.note) ?? 0) + 1);
        gates.set(sl.gate, (gates.get(sl.gate) ?? 0) + 1);
      }
      if (st.slots.some((sl) => sl.note === NOTE)) {
        edits.push({ pattern: p, step: s, keep: st.slots.filter((sl) => sl.note !== NOTE), prob: st.prob });
      }
    }
  }

  if (!APPLY) {
    const h = [...hist].sort((a, z) => a[0] - z[0]).map(([n, c]) => `${n}x${c}`).join(' ');
    const g = [...gates].sort((a, z) => a[0] - z[0]).map(([n, c]) => `${n}x${c}`).join(' ');
    const sole = edits.filter((e) => e.keep.length === 0).length;
    console.log(`  ${tag}  "${nm}"`);
    console.log(`             notes: ${h || '(none)'}`);
    console.log(`             gates: ${g || '(none)'}`);
    console.log(`             would remove ${edits.length} occurrence(s) of ${NOTE} (${sole} step(s) become empty)`);
    continue;
  }

  if (edits.length === 0) { clean++; continue; }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  ${tag}  refusing to overwrite existing backup ${backup}`); process.exit(1); }
  writeFileSync(backup, b);

  const out = Buffer.from(b);
  for (const e of edits) writeStepRaw(out, TRACK, e.pattern, e.step, e.prob, e.keep);

  const up = await uploadProject(conn, out, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`  ${tag}  UPLOAD FAILED: ${up.error ?? 'unknown'}  (original at ${backup})`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }

  // Retry the verify read exactly as the first read does. A flaked read here is
  // NOT evidence the write failed, and exiting on it strands the operator with a
  // written slot and an unverified result, which is the worst of both. Retry
  // first; only a second failure is a genuine "cannot confirm".
  let v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    await sleep(1500);
    v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  ${tag}  VERIFY READ FAILED TWICE (ok=${v.ok} crcOk=${v.crcOk}). The write may well have landed;`);
    console.log(`             re-read this slot before concluding anything. Original at ${backup}`);
    process.exit(1);
  }
  // Exact-image verify: the device must hand back byte-for-byte what we sent.
  let drift = 0, firstDrift = -1;
  for (let i = 0; i < out.length; i++) if (out[i] !== v.bytes[i]) { drift++; if (firstDrift < 0) firstDrift = i; }
  let remaining = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      for (const sl of readStepRaw(v.bytes, TRACK, p, s).slots) if (sl.note === NOTE) remaining++;
    }
  }
  let changed = 0;
  for (let i = 0; i < b.length; i++) if (b[i] !== v.bytes[i]) changed++;
  if (remaining > 0 || drift !== 0 || nameOf(v.bytes) !== nm) {
    console.log(`  ${tag}  VERIFY FAILED: ${remaining} left on ${NOTE}, drift=${drift} (first @0x${firstDrift.toString(16)}), name="${nameOf(v.bytes)}"`);
    console.log(`             restore with ${backup}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  console.log(`  ${tag}  "${nm}"  removed ${edits.length} occurrence(s) of ${NOTE}; read-back is byte-identical to the sent image (${changed} byte(s) differ from the original)`);
  patched++;
  await sleep(400);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${patched} patched, ${clean} already clean, ${empty} empty.`);
if (APPLY && patched > 0) console.log(`restore points: ${backupDir}`);
endMidiScript();
