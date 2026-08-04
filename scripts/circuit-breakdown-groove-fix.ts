/**
 * circuit-breakdown-groove-fix.ts — restore the Tom Petty "Breakdown" groove
 * on-device: 32nd-note micro-timing + a real ghost snare.
 *
 * ## What is wrong and why
 *
 * The authored Breakdown projects put every hit on a 16th-note step line with
 * micro-hit mask 0x01 (plain on-beat) and only two velocities, 100 and 120.
 * The Songsterr source (song 23527, 108 bpm) says otherwise on both counts:
 *
 *  TIMING. 258 of 614 source events sit at 16th offset .5 — a 32nd note AFTER
 *  the step line. Zero source events fail to fit a 96th grid, and the Circuit's
 *  step is divided into exactly SIX micro-ticks, so micro-tick 3 of 6 lands on
 *  that 32nd EXACTLY. The device can represent the groove perfectly; the author
 *  just never used the field. Every off-beat hit is therefore playing a 32nd
 *  EARLY — 69 ms at 108 bpm — which is what flattens the shuffle out of the
 *  opening bars.
 *
 *  VELOCITY. The source marks the figure's last snare `p` while every backbeat
 *  is `fff`. The importer's GHOST set is {pp, ppp} and its ACCENT set does not
 *  contain `p` either, so a `p` fell through BOTH and imported as a plain hit.
 *  That is the "last snare should be much softer" the maintainer hears. This
 *  tab carries zero `ghost` flags and zero grace notes — the dynamic mark is
 *  the ONLY signal, which is why the ghost policy never fired.
 *
 * ## The rule (derived from the source, not invented)
 *
 * Source onsets occur at 16ths {0,4,8,12} (on the line) and {2.5,6.5,10.5,14.5}
 * (a 32nd late). Every step present in the Breakdown patterns is one of those,
 * so:  (step % 16) in {2,6,10,14}  =>  micro-tick 3;  else on the line.
 *
 * Velocity, taken from SONGSTERR_DYNAMIC_VELOCITY so this patch matches what a
 * fresh re-import would produce, byte for byte:
 *   fff  kick + backbeat snares  -> 120   (already correct, untouched)
 *   f    hats                    -> 100   (already correct, untouched)
 *   p    the snare tail @ 16th 14->  60   (was 100)  <- THE ONLY VELOCITY CHANGE
 *
 * NOTE this song carries no `ghost` flag anywhere and no grace notes: its
 * dynamics are sticky markings only. The grace-note cursor-drift defect fixed
 * upstream does NOT affect Breakdown — every measure's durations already sum to
 * exactly one bar (verified measure 1: 32/32).
 *
 * ## Both drum tracks AND the MIDI feed, together
 *
 * The internal Circuit drums (D1 kick / D2 snare / D3 hat) and the MIDI2 track
 * that drives the SPD-SX play the SAME groove in parallel. Moving one and not
 * the other would flam every off-beat hit against itself. They are always
 * written together.
 *
 * ## Byte-surgical, deliberately
 *
 * Writes the four affected bytes directly (drum velocity + rhythm rows; note
 * slot delay + velocity) instead of going through setDrumStep / setNoteStep.
 * That preserves probability, drum_choice, note number and GATE verbatim by
 * construction — gate can legitimately carry 224 (tie flag bit 7 over magnitude
 * 96) and a 0..127 validator would eat the tie bit.
 *
 * ── SAFETY (inherited from circuit-fix-pad-note.ts; each earned from a real
 *    incident, do not remove) ─────────────────────────────────────────────────
 *  - DRY RUN by default; `--apply` required to write.
 *  - Device is the source of truth: download, patch, upload. Never upload a
 *    local snapshot (it would revert later edits, e.g. the mixer-level batch).
 *  - CRC GATED (`ok` only checks length, so `crcOk` is checked separately).
 *  - TIMESTAMPED per-slot backup, refuses to overwrite one.
 *  - NAME ASSERTION on read-back (a write to the wrong slot is else invisible).
 *  - READ-BACK VERIFY with an exact expected-byte-set: the only bytes allowed to
 *    differ are the ones this script intended to write, and each must hold the
 *    intended value.
 *  - FAIL-STOP, reporting what is done vs untouched.
 *
 * Usage:
 *   npx tsx scripts/circuit-breakdown-groove-fix.ts                 # dry run, slot 35
 *   npx tsx scripts/circuit-breakdown-groove-fix.ts --apply
 *   npx tsx scripts/circuit-breakdown-groove-fix.ts --slots 35-39 --apply
 *   npx tsx scripts/circuit-breakdown-groove-fix.ts --offline samples/circuit-ncs/pack5
 *
 * `--pack` / `--slots` are 1-BASED device numbering, as the front panel shows.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  PATTERNS_PER_TRACK, NUM_DRUM_TRACKS, NOTE_STEP_BYTES,
  drumRowBase, noteStepBase, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const OFFLINE = flag('--offline');
const devicePack = Number(flag('--pack') ?? '5');

// ── the source-derived scheme ────────────────────────────────────────
/** Steps (mod 16) whose source onset is a 32nd LATE => micro-tick 3 of 6. */
const LATE_STEPS = new Set([2, 6, 10, 14]);
/** Positional micro-hit mask for micro-tick 3 (HW-confirmed 2026-07-03: pos3 = 0x08). */
const MASK_LATE = 0x08;
const MASK_ON = 0x01;
/** Note-track equivalent of micro-tick 3: the per-slot delay field, 0..5. */
const DELAY_LATE = 3;
const DELAY_ON = 0;

// Velocities come from SONGSTERR_DYNAMIC_VELOCITY (patterns/songsterr.ts), NOT
// from a scheme invented here, so this interim patch lands on exactly the same
// numbers a fresh re-import through the fixed importer would produce. Under that
// ladder only ONE velocity in the whole groove actually moves.
const VEL_ACCENT = 120;  // fff — kick, backbeat snares          (already correct)
const VEL_HAT = 100;     // f   — hats                            (already correct)
const VEL_GHOST = 60;    // p   — the snare tail at 16th 14       <- the only change

/** Drum track index -> voice. D1 kick, D2 snare, D3 hat (verified against the source). */
const DRUM_VOICE = ['kick', 'snare', 'hat', 'unused'] as const;
/** MIDI2 stored note -> voice. Stored = GM+12 (`note_offset:12`); the Circuit sends an octave low, so it arrives as raw GM. */
const NOTE_VOICE: Record<number, 'kick' | 'snare' | 'hat'> = { 48: 'kick', 50: 'snare', 54: 'hat' };

/** Target velocity for a voice at a step. The ONLY place the scheme is decided. */
function targetVelocity(voice: string, step: number): number {
  if (voice === 'hat') return VEL_HAT;
  if (voice === 'snare' && step % 16 === 14) return VEL_GHOST;   // the ghost tail
  return VEL_ACCENT;
}
const isLate = (step: number): boolean => LATE_STEPS.has(step % 16);

interface Edit { off: number; from: number; to: number; what: string }

/** Collect every byte this fix would change in one project buffer. */
function planEdits(b: Uint8Array): Edit[] {
  const edits: Edit[] = [];
  const push = (off: number, to: number, what: string): void => {
    if (b[off] !== to) edits.push({ off, from: b[off], to, what });
  };

  // Drum tracks: velocity row (+step) and rhythm row (+96+step).
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    const voice = DRUM_VOICE[t];
    if (voice === 'unused') continue;
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const rb = drumRowBase(t, p);
      const steps = decodeDrumPattern(b, t, p);
      steps.forEach((s, i) => {
        if (!s.active) return;
        // Only touch a step whose mask is a PLAIN single on-beat hit. A step
        // already carrying a roll/flam mask is deliberate authoring and is left
        // alone rather than flattened by this rule.
        const raw = b[rb + 96 + i];
        if ((raw & 0x3f) === MASK_ON || (raw & 0x3f) === MASK_LATE) {
          const want = isLate(i) ? MASK_LATE : MASK_ON;
          push(rb + 96 + i, (raw & 0xc0) | want, `D${t + 1} p${p + 1} s${i} ${voice} micro`);
        }
        push(rb + i, targetVelocity(voice, i), `D${t + 1} p${p + 1} s${i} ${voice} vel`);
      });
    }
  }

  // MIDI2 (the SPD-SX feed): per-slot delay (+2) and velocity (+3). Note number,
  // gate and the step header are never touched.
  const track: NoteTrack = 'midi2';
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const base = noteStepBase(track, p);
    const steps = decodeNotePattern(b, track, p);
    steps.forEach((s, i) => {
      if (!s.active) return;
      const stepBase = base + i * NOTE_STEP_BYTES;
      const mask = b[stepBase];
      let slot = 0;
      for (let n = 0; n < 6; n++) {
        if (!((mask >> n) & 1)) continue;
        const o = stepBase + 4 + n * 4;
        const voice = NOTE_VOICE[b[o]];
        slot++;
        if (voice === undefined) continue;           // not a mapped drum voice: leave alone
        push(o + 2, isLate(i) ? DELAY_LATE : DELAY_ON, `midi2 p${p + 1} s${i} ${voice} delay`);
        push(o + 3, targetVelocity(voice, i), `midi2 p${p + 1} s${i} ${voice} vel`);
      }
      void slot;
    });
  }
  return edits;
}

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function parseSlots(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}
const slotSpec = flag('--slots') ?? '35';
const slots = parseSlots(slotSpec);

function summarise(b: Uint8Array, edits: Edit[]): void {
  const byKind = new Map<string, number>();
  for (const e of edits) {
    const k = e.what.replace(/ p\d+ s\d+ /, ' ');
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  for (const [k, c] of [...byKind].sort()) console.log(`      ${k.padEnd(24)} ×${c}`);
  // show pattern 1 before/after so the change is legible
  console.log('      pattern 1 (bar 1, 16ths 0-15):');
  for (let t = 0; t < 3; t++) {
    const rb = drumRowBase(t, 0);
    const steps = decodeDrumPattern(b, t, 0);
    const line = steps.slice(0, 16).map((s, i) => {
      if (!s.active) return ' . ';
      const late = isLate(i);
      const v = targetVelocity(DRUM_VOICE[t], i);
      void rb;
      return late ? `>${v === VEL_GHOST ? 'g' : 'x'} ` : ` ${v === VEL_GHOST ? 'g' : 'x'} `;
    }).join('');
    if (steps.slice(0, 16).some((s) => s.active)) console.log(`        D${t + 1} ${DRUM_VOICE[t].padEnd(6)} ${line}`);
  }
  console.log(`        legend: "x"=on the line  ">x"=a 32nd late  "g"=ghost (vel ${VEL_GHOST})`);
}

// ── OFFLINE mode: plan against on-disk snapshots, write nothing ──────
if (OFFLINE) {
  console.log(`OFFLINE plan against ${OFFLINE} (no device, no writes)\n`);
  for (const slot of slots) {
    const f = join(OFFLINE, `proj${String(slot).padStart(2, '0')}.ncs`);
    if (!existsSync(f)) { console.log(`  project ${slot}: missing ${f}`); continue; }
    const b = readFileSync(f);
    const edits = planEdits(b);
    console.log(`  project ${slot}  "${nameOf(b)}"  ${edits.length} byte(s) would change`);
    summarise(b, edits);
    console.log('');
  }
  process.exit(0);
}

// ── DEVICE mode ──────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-breakdown-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
// `reconnectMidi` RELEASES the old handle before opening the new one. Plain
// reassignment leaked a loop-pinning input handle per reconnect, which is what
// left this script running (and holding the port) after its last output line.
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, slots ${slotSpec}: Breakdown groove fix (32nd micro-timing + ghost snare)`);
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
  if (!/breakdown/i.test(nm)) {
    console.log(`  ${tag}  "${nm}"  REFUSED: not a Breakdown project (the scheme is song-specific).`);
    continue;
  }
  const edits = planEdits(b);
  if (edits.length === 0) { console.log(`  ${tag}  "${nm}"  already correct`); clean++; continue; }

  if (!APPLY) {
    console.log(`  ${tag}  "${nm}"  would change ${edits.length} byte(s)`);
    summarise(b, edits);
    console.log('');
    continue;
  }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  ${tag}  refusing to overwrite existing backup ${backup}`); process.exit(1); }
  writeFileSync(backup, b);

  const out = Buffer.from(b);
  for (const e of edits) out[e.off] = e.to;

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
  // Exact expected-byte-set check: every intended byte must hold its intended
  // value, and NO other byte may have moved.
  const intended = new Map(edits.map((e) => [e.off, e.to]));
  const wrong: string[] = [];
  let collateral = 0;
  for (let i = 0; i < b.length; i++) {
    const want = intended.get(i);
    if (want !== undefined) {
      if (v.bytes[i] !== want) wrong.push(`0x${i.toString(16)} = ${v.bytes[i]} (wanted ${want})`);
    } else if (v.bytes[i] !== b[i]) collateral++;
  }
  if (wrong.length > 0 || collateral !== 0 || nameOf(v.bytes) !== nm) {
    console.log(`  ${tag}  VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 5).join(', ')}), collateral=${collateral}, name="${nameOf(v.bytes)}"`);
    console.log(`             restore with ${backup}`);
    process.exit(1);
  }
  console.log(`  ${tag}  "${nm}"  ${edits.length} byte(s) written, all verified, ZERO collateral`);
  summarise(v.bytes, []);
  patched++;
  await sleep(400);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${patched} patched, ${clean} already correct, ${empty} empty.`);
if (APPLY && patched > 0) console.log(`restore points: ${backupDir}`);
// Without this the script printed its last line and then sat forever holding
// the Circuit's port: an open input port pins the event loop. See
// scripts/_lib/midi-lifecycle.ts.
endMidiScript();
