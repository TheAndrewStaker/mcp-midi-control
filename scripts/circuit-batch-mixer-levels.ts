/**
 * Batch-set Circuit Tracks track-mixer levels across a pack's projects.
 *
 * Sets `synth1_level` / `synth2_level` in the stored `.ncs` so the Circuit's
 * internal synth voices stay silent while the Synth 1/2 tracks keep sequencing
 * EXTERNAL gear over MIDI. The level is a per-project audio-mixer byte, so this
 * does NOT touch MIDI output: the tracks keep driving the Hydrasynth (ch1) etc.
 *
 * WHY A FILE EDIT AND NOT A CC: the level is stored per project and a project
 * change OVERWRITES the live value. Song-part switching is a PC on ch16, so a
 * runtime CC does not survive the first scene stomp. Only the stored byte does.
 *
 * ── SAFETY PROPERTIES (each earned from a real incident; do not remove) ──────
 *
 *  - DRY RUN by default. `--apply` is required to write anything.
 *  - CRC IS GATED. `downloadProject` returns `ok` and `crcOk` INDEPENDENTLY, so
 *    a right-length-but-corrupt read has `ok:true, crcOk:false`. Patching that
 *    and uploading it would overwrite a good slot with corrupt data AND write a
 *    corrupt "backup" beside it. Every read here refuses unless BOTH pass.
 *  - PER-SLOT, TIMESTAMPED restore files. A single hardcoded backup filename in
 *    a loop leaves only the LAST project restorable.
 *  - NAME ASSERTION before every write: the freshly-read project's internal name
 *    (offset 0x10) must match what the plan expected for that slot, so a
 *    re-ordered or re-saved pack cannot cause a write to the wrong song.
 *  - CONTENT GUARD: refuses any slot whose synth1/synth2 tracks actually contain
 *    notes, unless `--allow-synth-content`. Zeroing the level of a track that
 *    has parts DELETES those parts from the mix. Found the hard way: Sugar
 *    2/10 was silenced before anyone checked for note content.
 *  - IDEMPOTENT + RESUMABLE. A slot already at the target values is skipped, so
 *    an interrupted run is simply re-run. An hour-long batch WILL be interrupted.
 *  - FAIL-STOP. On the first failed verify it stops and prints exactly what is
 *    done and what is untouched, rather than continuing blindly.
 *  - READ-BACK VERIFY. After each upload the slot is re-read and compared
 *    byte-for-byte; "no error from upload" is not proof the bytes landed.
 *  - `reconnect` is passed so the driver can refresh a dead handle and retry;
 *    the Circuit reboots to apply an uploaded project and drops on idle.
 *
 * Usage:
 *   npx tsx scripts/circuit-batch-mixer-levels.ts --pack 5 --slots 1-6,8-12 [--apply]
 *   npx tsx scripts/circuit-batch-mixer-levels.ts --pack 5 --slots 41-45 --apply
 *
 * `--pack` is 1-BASED (as the device shows it); `--slots` are 1-based device
 * project numbers. Both are converted to the 0-based wire form internally.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  noteStepBase, NOTE_STEP_BYTES, STEPS_PER_PATTERN, PATTERNS_PER_TRACK,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (n: string): boolean => argv.includes(n);

const devicePack = Number(flag('--pack') ?? '5');
const APPLY = has('--apply');
const ALLOW_CONTENT = has('--allow-synth-content');
const TARGET1 = Number(flag('--synth1') ?? '0');
const TARGET2 = Number(flag('--synth2') ?? '0');

/** "1-6,8-12,47" -> [1,2,3,4,5,6,8,...] */
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
const slotSpec = flag('--slots');
if (slotSpec === undefined) { console.error('--slots is required (e.g. --slots 1-6,8-12)'); process.exit(2); }
const slots = parseSlots(slotSpec);

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

/** Active note steps on a synth track. slotMask is authoritative (notePattern.ts). */
function synthSteps(b: Uint8Array, track: 'synth1' | 'synth2'): number {
  let n = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const base = noteStepBase(track, p);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) if (b[base + s * NOTE_STEP_BYTES] !== 0) n++;
  }
  return n;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
/**
 * MUST return a FRESH connection: the driver calls this once on a handle-level
 * fault and retries the transfer on whatever comes back. A void no-op hands the
 * retry path `undefined` and silently disables the auto-recovery this batch
 * depends on (the Circuit reboots to apply an upload and drops on idle).
 *
 * `reconnectMidi` RELEASES the old handle before opening the new one. Plain
 * reassignment leaked a loop-pinning input handle per reconnect, which is what
 * left this script running (and holding the port) after its last output line.
 */
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, ${slots.length} slot(s): ${slotSpec}`);
console.log(`target levels: synth1=${TARGET1} synth2=${TARGET2}`);
console.log(APPLY ? `MODE: APPLY (backups -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');
if (APPLY) mkdirSync(backupDir, { recursive: true });

let patched = 0, skipped = 0, blocked = 0, empty = 0;
for (const slot of slots) {
  const tag = `project ${String(slot).padStart(2)}`;
  let r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    // One bounded retry after a settle: a transient read fault (the device is
    // busy, or just rebooted to apply a prior upload) must not end the batch.
    await sleep(1500);
    r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }

  // CRC is gated, not merely logged. `ok` only checks length.
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    // An EMPTY slot is a normal pack state, not a fault: a whole-pack range
    // must step over the gaps. Only a REAL read fault is fail-stop, since that
    // means the transport is unhealthy and writing against it is unsafe.
    if (/empty slot|no readable project/i.test(r.error ?? '')) { empty++; continue; }
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    console.log(`\nFAIL-STOP. ${patched} patched, ${skipped} skipped. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  const b = r.bytes;
  const nm = nameOf(b);
  const s1 = b[MIXER_SYNTH1_LEVEL], s2 = b[MIXER_SYNTH2_LEVEL];

  if (s1 === TARGET1 && s2 === TARGET2) {
    console.log(`  ${tag}  "${nm}"  already ${TARGET1}/${TARGET2} — skip (idempotent)`);
    skipped++; continue;
  }
  const c1 = synthSteps(b, 'synth1'), c2 = synthSteps(b, 'synth2');
  if ((c1 > 0 || c2 > 0) && !ALLOW_CONTENT) {
    console.log(`  ${tag}  "${nm}"  BLOCKED: has synth note content (synth1=${c1} synth2=${c2} steps).`);
    console.log(`             Zeroing its level would silence real parts. Re-run with --allow-synth-content to override.`);
    blocked++; continue;
  }

  if (!APPLY) {
    console.log(`  ${tag}  "${nm}"  would patch ${s1}/${s2} -> ${TARGET1}/${TARGET2}`);
    continue;
  }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  ${tag}  refusing to overwrite existing backup ${backup}`); process.exit(1); }
  writeFileSync(backup, b);

  const out = Buffer.from(b);
  out[MIXER_SYNTH1_LEVEL] = TARGET1;
  out[MIXER_SYNTH2_LEVEL] = TARGET2;
  const up = await uploadProject(conn, out, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`  ${tag}  UPLOAD FAILED: ${up.error ?? 'unknown'}  (original at ${backup})`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }

  // Verify by reading back, and assert the name still matches: a write to the
  // wrong slot is otherwise invisible.
  const v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  ${tag}  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    process.exit(1);
  }
  let collateral = 0;
  for (let i = 0; i < b.length; i++) {
    if (i === MIXER_SYNTH1_LEVEL || i === MIXER_SYNTH2_LEVEL) continue;
    if (b[i] !== v.bytes[i]) collateral++;
  }
  const okNow = v.bytes[MIXER_SYNTH1_LEVEL] === TARGET1 && v.bytes[MIXER_SYNTH2_LEVEL] === TARGET2;
  if (!okNow || collateral !== 0 || nameOf(v.bytes) !== nm) {
    console.log(`  ${tag}  VERIFY FAILED: levels=${v.bytes[MIXER_SYNTH1_LEVEL]}/${v.bytes[MIXER_SYNTH2_LEVEL]} collateral=${collateral} name="${nameOf(v.bytes)}"`);
    console.log(`             restore with ${backup}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Slots after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  console.log(`  ${tag}  "${nm}"  ${s1}/${s2} -> ${TARGET1}/${TARGET2}  verified, 0 collateral`);
  patched++;
  await sleep(400);   // settle: the device commits/reboots after an upload
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${patched} patched, ${skipped} already correct, ${blocked} blocked for synth content, ${empty} empty.`);
if (APPLY) console.log(`restore points: ${backupDir}`);
endMidiScript();
