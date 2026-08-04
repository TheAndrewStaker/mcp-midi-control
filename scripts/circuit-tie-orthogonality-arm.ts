/**
 * ARM the tie/gate orthogonality test: write a TIED note at a NON-MAXIMUM gate
 * into a stored Circuit Tracks project, then hand the device the one job only it
 * can do — re-serialise it.
 *
 * ## The question
 *
 * The per-step gate lane is decoded as `tie << 7 | gate_sixths` (notePattern.ts).
 * Every one of the 1,048 tied notes in the 274-file corpus sits at magnitude 96
 * (= 16 steps), so "the flag is orthogonal to the magnitude" rests on the manual
 * ("Tied / Drone Notes", user guide p.51-52) and not on a second observed value.
 * A tie at 8 steps should store as `0x80 | 48` = 176.
 *
 * ## Why a file round-trip alone proves NOTHING
 *
 * If we write 176, upload it, download it and read 176 back, we have proven that
 * a file carries a byte we chose. Circular. The question is what the DEVICE's
 * internal model does with it. So this script only ARMS the experiment: it puts
 * 176 in the stored project. The maintainer then LOADS project 42 on the device
 * and SAVES it, which forces the Circuit to write the project out of its own RAM
 * model. `circuit-tie-orthogonality-read.ts` then reads the byte back.
 *
 * Independent evidence that a hand-Save re-serialises device state rather than
 * echoing the loaded file: the same save path overwrites file-authored mixer
 * levels with the live fader positions — values that were never sent over the
 * wire and can only have come from the device's own state (format.ts,
 * MIXER_SYNTH1_LEVEL). Those mixer bytes double as the read-back's tell-tale
 * that a re-serialisation happened at all.
 *
 * ## Vehicle
 *
 * Pack 5 project 42 "GateTest16": MIDI 1, pattern 1, step 1, slot 1 currently
 * holds 224 (`0x80 | 96`), a tie at the full 16 steps. Its sibling project 44
 * "GateTest16b" differs in exactly 2 bytes of 160,780 (the name, and this byte
 * reading 96), so the pair is already a single-variable A/B of tie on vs off.
 * Project 44 is NOT touched — it stays as the untied control.
 *
 * ── SAFETY PROPERTIES (inherited from circuit-fix-pad-note.ts /
 *    circuit-remove-pad-note.ts; each earned from a real incident) ─────────────
 *  - DRY RUN by default; `--apply` required to write.
 *  - CRC GATED: `ok` only checks length, so `crcOk` is checked independently.
 *  - TIMESTAMPED backup before any write, refusing to clobber an existing one.
 *  - NAME ASSERTION: the slot must actually contain the expected project, else a
 *    write to the wrong slot is invisible.
 *  - START-STATE ASSERTION: the byte must currently read what we think it reads.
 *    A vehicle that has already been changed is not the experiment we designed.
 *  - IDEMPOTENT: if the byte is already the target value, nothing is written.
 *  - SINGLE-BYTE EDIT, verified as such: the uploaded image must differ from the
 *    downloaded one in exactly ONE byte, at exactly the offset we intend.
 *  - READ-BACK VERIFY against the EXACT image sent, not a byte count.
 *  - `reconnect` returns a FRESH connection (the Circuit reboots after upload).
 *
 * Usage (dry run by default):
 *   npx tsx scripts/circuit-tie-orthogonality-arm.ts
 *   npx tsx scripts/circuit-tie-orthogonality-arm.ts --apply
 *   ... --pack 5 --project 42 --track midi1 --pattern 1 --step 1 --slot 1
 *   ... --gate-steps 8        (target gate length in whole steps; default 8)
 *   ... --expect 224          (required start-state byte; --expect any to skip)
 *
 * `--pack`, `--project`, `--pattern`, `--step`, `--slot` are 1-BASED, as the
 * front panel counts them. `--gate-steps` is what the musician reads in Gate
 * View. Everything 0-based / in sixths stays inside the script.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  NCS_FILE_SIZE, NOTE_STEP_BYTES, NOTE_SLOTS_PER_STEP, STEPS_PER_PATTERN,
  PATTERNS_PER_TRACK, noteStepBase, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import {
  GATE_TIE_FLAG, GATE_MAGNITUDE_MASK, MICROTICKS_PER_STEP, MAX_GATE_SIXTHS,
} from '../packages/circuit-tracks/src/ncs/notePattern.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '5');
const project = Number(flag('--project') ?? '42');
const TRACK = (flag('--track') ?? 'midi1') as NoteTrack;
const pattern1 = Number(flag('--pattern') ?? '1');
const step1 = Number(flag('--step') ?? '1');
const noteSlot1 = Number(flag('--slot') ?? '1');
const gateSteps = Number(flag('--gate-steps') ?? '8');
const expectRaw = flag('--expect') ?? '224';

for (const [label, v, lo, hi] of [
  ['--pack', devicePack, 1, 32], ['--project', project, 1, 64],
  ['--pattern', pattern1, 1, PATTERNS_PER_TRACK], ['--step', step1, 1, STEPS_PER_PATTERN],
  ['--slot', noteSlot1, 1, NOTE_SLOTS_PER_STEP],
] as const) {
  if (!Number.isInteger(v) || v < lo || v > hi) {
    console.error(`${label} must be an integer ${lo}..${hi}, got ${String(v)}`);
    process.exit(2);
  }
}
// The gate the DEVICE would show in Gate View, converted to the wire's sixths.
// Whole steps only here: a fractional target would muddy the single variable.
if (!Number.isInteger(gateSteps) || gateSteps < 1 || gateSteps * MICROTICKS_PER_STEP > MAX_GATE_SIXTHS) {
  console.error(`--gate-steps must be an integer 1..${MAX_GATE_SIXTHS / MICROTICKS_PER_STEP}, got ${gateSteps}`);
  process.exit(2);
}
const targetSixths = gateSteps * MICROTICKS_PER_STEP;
const TARGET = GATE_TIE_FLAG | targetSixths;         // tie ON at `gateSteps` steps
if (targetSixths === MAX_GATE_SIXTHS) {
  console.error('--gate-steps 16 is the value we already observe everywhere; the test needs a NON-maximum gate.');
  process.exit(2);
}

const slot0 = project - 1;
const pack0 = devicePack - 1;
const OFFSET = noteStepBase(TRACK, pattern1 - 1)
  + (step1 - 1) * NOTE_STEP_BYTES
  + 4                                   // step header: [slotMask, probability, 0, 0]
  + (noteSlot1 - 1) * 4
  + 1;                                  // [note, GATE LANE, delay, velocity]

const hex = (n: number): string => `0x${n.toString(16)}`;
const describe = (b: number): string =>
  `${b} (${hex(b)}) = tie ${(b & GATE_TIE_FLAG) ? 'ON' : 'off'}, `
  + `gate ${b & GATE_MAGNITUDE_MASK} sixths = ${((b & GATE_MAGNITUDE_MASK) / MICROTICKS_PER_STEP).toFixed(2)} steps`;

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-tiegate-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
// `reconnectMidi` RELEASES the old handle before opening the new one. Plain
// reassignment leaked a loop-pinning input handle per reconnect, which is what
// left this script running (and holding the port) after its last output line.
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, project ${project}: ${TRACK} pattern ${pattern1} step ${step1} slot ${noteSlot1}`);
console.log(`  gate-lane offset ${hex(OFFSET)}   target ${describe(TARGET)}`);
console.log(APPLY ? `MODE: APPLY (backup -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');

let r = await downloadProject(conn, slot0, { pack: pack0, reconnect });
if (!r.ok || !r.crcOk || r.bytes === undefined) {
  await sleep(1500);
  r = await downloadProject(conn, slot0, { pack: pack0, reconnect });
}
if (!r.ok || !r.crcOk || r.bytes === undefined) {
  console.log(`READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
  console.log('Nothing was written.');
  process.exit(1);
}
const before = r.bytes;
if (before.length !== NCS_FILE_SIZE) {
  console.log(`Refusing: read ${before.length} bytes, expected ${NCS_FILE_SIZE}.`);
  process.exit(1);
}
const nm = nameOf(before);
const current = before[OFFSET];
console.log(`  project name: "${nm}"`);
console.log(`  current byte: ${describe(current)}`);

if (expectRaw !== 'any') {
  const want = Number(expectRaw);
  if (current !== want) {
    console.log('');
    console.log(`REFUSING: expected the vehicle to start at ${describe(want)}.`);
    console.log('The project is not in the state this experiment was designed around. Re-check the');
    console.log('project number, or pass --expect any if you know why it differs.');
    process.exit(1);
  }
}
if (current === TARGET) {
  console.log('');
  console.log('Already armed: the byte is already the target value. Nothing to do.');
  console.log('Next: load this project on the device and Save, then run circuit-tie-orthogonality-read.ts.');
  exitMidiScript(0);
}

const after = Buffer.from(before);
after[OFFSET] = TARGET;
let planned = 0;
for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) planned++;
if (planned !== 1) {
  console.log(`INTERNAL ERROR: the edit plan touches ${planned} bytes, expected exactly 1. Aborting.`);
  process.exit(1);
}

if (!APPLY) {
  console.log('');
  console.log(`DRY RUN: would change exactly 1 byte at ${hex(OFFSET)}: ${current} -> ${TARGET}.`);
  console.log('Re-run with --apply to write it.');
  exitMidiScript(0);
}

mkdirSync(backupDir, { recursive: true });
const backup = `${backupDir}/pack${devicePack}-proj${String(project).padStart(2, '0')}.ncs`;
if (existsSync(backup)) { console.log(`Refusing to overwrite existing backup ${backup}`); process.exit(1); }
writeFileSync(backup, before);
console.log(`  backup written: ${backup}`);

const up = await uploadProject(conn, after, slot0, { pack: pack0, reconnect });
if (!up.ok) {
  console.log(`UPLOAD FAILED: ${up.error ?? 'unknown'}  (original at ${backup})`);
  process.exit(1);
}

// A flaked verify read is NOT evidence the write failed; retry once before
// concluding, or the operator is stranded with a written slot and no verdict.
let v = await downloadProject(conn, slot0, { pack: pack0, reconnect });
if (!v.ok || !v.crcOk || v.bytes === undefined) {
  await sleep(1500);
  v = await downloadProject(conn, slot0, { pack: pack0, reconnect });
}
if (!v.ok || !v.crcOk || v.bytes === undefined) {
  console.log(`VERIFY READ FAILED TWICE (ok=${v.ok} crcOk=${v.crcOk}). The write may well have landed;`);
  console.log(`re-read the slot before concluding anything. Original at ${backup}`);
  process.exit(1);
}
let drift = 0, firstDrift = -1;
for (let i = 0; i < after.length; i++) if (after[i] !== v.bytes[i]) { drift++; if (firstDrift < 0) firstDrift = i; }
if (drift !== 0 || nameOf(v.bytes) !== nm || v.bytes[OFFSET] !== TARGET) {
  console.log(`VERIFY FAILED: drift=${drift} (first @${hex(firstDrift)}), name="${nameOf(v.bytes)}", byte=${v.bytes[OFFSET]}`);
  console.log(`restore with ${backup}`);
  process.exit(1);
}

console.log('');
console.log(`ARMED. ${hex(OFFSET)} now reads ${describe(TARGET)}; read-back is byte-identical to the image sent.`);
console.log('');
console.log('NOW, ON THE DEVICE (this is the part only the hardware can do):');
console.log(`  1. Press Projects. Use the arrow buttons to reach the page holding project ${project}.`);
console.log(`  2. Press the pad for project ${project} ("${nm}") to load it.`);
console.log('  3. Press Save, then press Save again. The pad flashes green.');
console.log('');
console.log('Then read the answer back:');
console.log(`  npx tsx scripts/circuit-tie-orthogonality-read.ts --before ${backup}`);
endMidiScript();
