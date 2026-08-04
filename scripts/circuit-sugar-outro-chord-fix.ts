/**
 * circuit-sugar-outro-chord-fix.ts — repair the one genuine melodic
 * transcription defect in the Sugar build: project 54 (Sugar 9/10), Synth 2,
 * patterns 6/7/8 (0-based 5/6/7) = bars 139-144.
 *
 * ## The defect
 *
 * The Outro pad is a metronomic quarter-note D#3+D#4+D#5 chord: four per bar,
 * i.e. EIGHT per 2-bar pattern at steps 0,4,8,12,16,20,24,28, unbroken from
 * m137 to m148. Patterns 1-5 of this very track do exactly that. Patterns 6, 7
 * and 8 instead carry SEVEN chords, at steps 0,4,9,13,18,22,27.
 *
 * `floor(n * 32/7)` for n=0..6 is `0,4,9,13,18,22,27` — the observed steps, to
 * the step. That is seven mini-notation tokens spread evenly over a 32-step
 * pattern where eight were needed. Step 9 is the ONLY odd-numbered step in all
 * 240 melodic patterns of the build, which is the independent tell.
 *
 * Audible result: six bars where the pad limps 7-against-8 and drifts out of
 * phase with the harp, then snaps back at each pattern boundary.
 *
 * ## The fix, and why it needs no musical judgement
 *
 * Copy Synth 2 pattern 1 (0-based 0) verbatim over patterns 6, 7 and 8. This is
 * a literal region copy, NOT a re-author: every byte of the target comes from a
 * pattern already on the device, so gate, tie, velocity, probability, delay and
 * the slot mask are carried across by construction rather than regenerated.
 *
 * ⚠ WHY VERBATIM MATTERS HERE. Projects 48-55 carry gate 6 on every note (a
 * separate, known, SEPARATELY-TRACKED defect — the note-length regression). It
 * is NOT this script's business. Regenerating these patterns through an
 * authoring path would "helpfully" normalise those gates and silently entangle
 * two unrelated fixes. A verbatim copy cannot: it reproduces the source
 * pattern's gate lane exactly as it is, defect included, so the note-length
 * epic still sees the same before-state it expects.
 *
 * ── PRE-FLIGHT (all must hold, else refuse; nothing here is assumed) ──────────
 *   1. Project name is exactly the expected one.
 *   2. Patterns 1-5 are byte-identical to each other — the figure is stable, so
 *      pattern 1 is the figure and not a fluke.
 *   3. Pattern 1 really IS the eight-chord figure: 8 active steps at
 *      0,4,8,12,16,20,24,28, each a 3-note chord of the expected pitches.
 *   4. Patterns 6-8 really ARE the seven-chord figure at 0,4,9,13,18,22,27,
 *      and byte-identical to each other.
 *   5. GATE GUARD: the set of distinct raw gate-lane values across the source
 *      pattern equals the set across each target, and neither carries a tie
 *      flag. So no note's DURATION and no tie changes — only chord POSITION.
 *   6. The three targets' pattern-metadata blocks already equal the source's
 *      (length etc.), so no metadata byte needs writing. If they differ, STOP:
 *      writing metadata is out of this script's remit.
 *
 * ── SAFETY (inherited from circuit-breakdown-groove-fix.ts) ──────────────────
 *  - DRY RUN by default; `--apply` required to write.
 *  - Device is the source of truth: download, patch, upload.
 *  - CRC GATED (`ok` only checks length, so `crcOk` is checked separately).
 *  - TIMESTAMPED backup, refuses to overwrite one.
 *  - NAME ASSERTION on read-back.
 *  - READ-BACK VERIFY with an exact expected-byte-set: only intended bytes may
 *    differ, each holding its intended value, zero collateral.
 *
 * Usage:
 *   npx tsx scripts/circuit-sugar-outro-chord-fix.ts                    # dry run
 *   npx tsx scripts/circuit-sugar-outro-chord-fix.ts --apply
 *   npx tsx scripts/circuit-sugar-outro-chord-fix.ts --offline <file.ncs>
 *
 * `--pack` / `--slot` are 1-BASED device numbering, as the front panel shows.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  NOTE_STEP_BYTES, NOTE_SLOTS_PER_STEP, STEPS_PER_PATTERN, NOTE_STEP_REGION,
  META_OFFSETS, noteStepBase, noteBlockIndex, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const OFFLINE = flag('--offline');
const devicePack = Number(flag('--pack') ?? '5');
const deviceSlot = Number(flag('--slot') ?? '54');

// ── what this fix is about, stated as data so the guards can check it ───────
const EXPECT_NAME = 'Sugar 9/10';
const TRACK: NoteTrack = 'synth2';
const SRC_PATTERN = 0;                       // 0-based; the device shows it as 1
const REFERENCE_PATTERNS = [0, 1, 2, 3, 4];  // must all be byte-identical
const DST_PATTERNS = [5, 6, 7];              // 0-based; device shows 6, 7, 8
/** The correct figure: a quarter-note pulse, eight chords over two bars. */
const GOOD_STEPS = [0, 4, 8, 12, 16, 20, 24, 28];
/** The defect: floor(n*32/7), seven tokens stretched over 32 steps. */
const BAD_STEPS = [0, 4, 9, 13, 18, 22, 27];
/** D#3 + D#4 + D#5, the Outro pad stack. */
const CHORD = [51, 63, 75];
const TIE_BIT = 0x80;

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

const regionOf = (b: Uint8Array, p: number): Uint8Array => {
  const base = noteStepBase(TRACK, p);
  return b.subarray(base, base + NOTE_STEP_REGION);
};
const sameBytes = (a: Uint8Array, c: Uint8Array): boolean =>
  a.length === c.length && a.every((x, i) => x === c[i]);

/** Active step indices of a pattern (slot mask non-zero). */
function activeSteps(b: Uint8Array, p: number): number[] {
  const base = noteStepBase(TRACK, p);
  const out: number[] = [];
  for (let s = 0; s < STEPS_PER_PATTERN; s++) if (b[base + s * NOTE_STEP_BYTES] !== 0) out.push(s);
  return out;
}

/** Every live slot's [note, rawGate, delay, velocity] in a pattern. */
function liveSlots(b: Uint8Array, p: number): { step: number; note: number; gate: number; delay: number; vel: number }[] {
  const base = noteStepBase(TRACK, p);
  const out: { step: number; note: number; gate: number; delay: number; vel: number }[] = [];
  for (let s = 0; s < STEPS_PER_PATTERN; s++) {
    const sb = base + s * NOTE_STEP_BYTES;
    const mask = b[sb];
    for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
      if (!((mask >> n) & 1)) continue;
      const o = sb + 4 + n * 4;
      out.push({ step: s, note: b[o], gate: b[o + 1], delay: b[o + 2], vel: b[o + 3] });
    }
  }
  return out;
}

interface Edit { off: number; from: number; to: number }

/** Guard the whole premise, then plan the byte copy. Throws with a reason on refusal. */
function planCopy(b: Uint8Array): { edits: Edit[]; notes: string[] } {
  const notes: string[] = [];
  const refuse = (why: string): never => { throw new Error(why); };

  // 1. right project
  const nm = nameOf(b);
  if (nm !== EXPECT_NAME) refuse(`project name is "${nm}", expected "${EXPECT_NAME}"`);

  // 2. the reference figure is stable across patterns 1-5
  const src = regionOf(b, SRC_PATTERN);
  for (const p of REFERENCE_PATTERNS) {
    if (!sameBytes(regionOf(b, p), src)) refuse(`pattern ${p + 1} is not byte-identical to pattern ${SRC_PATTERN + 1}; the reference figure is not stable, refusing to pick one`);
  }
  notes.push(`patterns ${REFERENCE_PATTERNS.map((p) => p + 1).join('/')} byte-identical — the 8-chord figure is stable`);

  // 3. the source really is the eight-chord figure
  const srcSteps = activeSteps(b, SRC_PATTERN);
  if (srcSteps.join(',') !== GOOD_STEPS.join(',')) refuse(`pattern ${SRC_PATTERN + 1} active steps are [${srcSteps}], expected [${GOOD_STEPS}]`);
  const srcSlots = liveSlots(b, SRC_PATTERN);
  if (srcSlots.length !== GOOD_STEPS.length * CHORD.length) refuse(`pattern ${SRC_PATTERN + 1} holds ${srcSlots.length} notes, expected ${GOOD_STEPS.length * CHORD.length}`);
  for (const s of GOOD_STEPS) {
    const pitches = srcSlots.filter((x) => x.step === s).map((x) => x.note);
    if (pitches.join(',') !== CHORD.join(',')) refuse(`pattern ${SRC_PATTERN + 1} step ${s} holds [${pitches}], expected [${CHORD}]`);
  }
  notes.push(`pattern ${SRC_PATTERN + 1} confirmed: 8 chords at [${GOOD_STEPS}], each ${CHORD.join('+')}`);

  // 4. the targets really are the seven-chord defect, and all three the same
  const dst0 = regionOf(b, DST_PATTERNS[0]);
  for (const p of DST_PATTERNS) {
    const steps = activeSteps(b, p);
    if (steps.join(',') !== BAD_STEPS.join(',')) refuse(`pattern ${p + 1} active steps are [${steps}], expected the defect [${BAD_STEPS}] — refusing to overwrite something that is not the known defect`);
    if (!sameBytes(regionOf(b, p), dst0)) refuse(`pattern ${p + 1} is not byte-identical to pattern ${DST_PATTERNS[0] + 1}`);
  }
  notes.push(`patterns ${DST_PATTERNS.map((p) => p + 1).join('/')} confirmed: the 7-chord defect at [${BAD_STEPS}], all three identical`);

  // 5. GATE GUARD — durations and ties must be untouched by this move
  const srcGates = [...new Set(srcSlots.map((x) => x.gate))].sort((x, y) => x - y);
  for (const p of DST_PATTERNS) {
    const dGates = [...new Set(liveSlots(b, p).map((x) => x.gate))].sort((x, y) => x - y);
    if (dGates.join(',') !== srcGates.join(',')) {
      refuse(`GATE GUARD: pattern ${p + 1} carries gate value(s) [${dGates}] but the copy would give it [${srcGates}]. That changes a note DURATION, which is the note-length epic's job, not this fix. STOPPING.`);
    }
  }
  const anyTie = [...srcSlots, ...DST_PATTERNS.flatMap((p) => liveSlots(b, p))].some((x) => (x.gate & TIE_BIT) !== 0);
  if (anyTie) refuse('GATE GUARD: a tie flag is present in the source or a target pattern; a positional copy would move it. STOPPING.');
  notes.push(`gate guard passed: source and all targets carry gate ${srcGates.join('/')} only, zero tie flags — no duration and no tie changes`);

  // 6. metadata already matches, so no metadata byte is written
  const srcMeta = META_OFFSETS[noteBlockIndex(TRACK, SRC_PATTERN)];
  for (const p of DST_PATTERNS) {
    const m = META_OFFSETS[noteBlockIndex(TRACK, p)];
    for (let i = 0; i < 8; i++) {
      if (b[m + i] !== b[srcMeta + i]) refuse(`pattern ${p + 1} metadata byte ${i} is ${b[m + i]} vs source ${b[srcMeta + i]}; writing pattern metadata is out of remit. STOPPING.`);
    }
  }
  notes.push('pattern metadata (length etc.) already identical — no metadata byte written');

  // plan: verbatim region copy
  const edits: Edit[] = [];
  for (const p of DST_PATTERNS) {
    const dbase = noteStepBase(TRACK, p);
    const sbase = noteStepBase(TRACK, SRC_PATTERN);
    for (let i = 0; i < NOTE_STEP_REGION; i++) {
      if (b[dbase + i] !== b[sbase + i]) edits.push({ off: dbase + i, from: b[dbase + i], to: b[sbase + i] });
    }
  }
  return { edits, notes };
}

function summarise(b: Uint8Array, label: string): void {
  for (const p of [SRC_PATTERN, ...DST_PATTERNS]) {
    const steps = activeSteps(b, p);
    const gates = [...new Set(liveSlots(b, p).map((x) => x.gate))].sort((x, y) => x - y);
    console.log(`      ${label} p${p + 1}${p === SRC_PATTERN ? ' (source)' : ''}  ${steps.length} chord(s) @ [${steps.join(',')}]  gate ${gates.join('/')}`);
  }
}

// ── OFFLINE mode: plan against a file, write nothing ─────────────────────────
if (OFFLINE !== undefined) {
  console.log(`OFFLINE plan against ${OFFLINE} (no device, no writes)\n`);
  const b = readFileSync(OFFLINE);
  summarise(b, 'BEFORE');
  const { edits, notes } = planCopy(b);
  for (const n of notes) console.log(`      ok: ${n}`);
  console.log(`\n  ${edits.length} byte(s) would change`);
  const out = Buffer.from(b);
  for (const e of edits) out[e.off] = e.to;
  summarise(out, 'AFTER ');
  process.exit(0);
}

// ── DEVICE mode ──────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-sugar-outro-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
// `reconnectMidi` RELEASES the old handle before opening the new one. Plain
// reassignment leaked a loop-pinning input handle per reconnect, which is what
// left this script running (and holding the port) after its last output line.
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, project ${deviceSlot}: Sugar Outro chord-figure fix (${TRACK} p${DST_PATTERNS.map((p) => p + 1).join('/')} <- p${SRC_PATTERN + 1})`);
console.log(APPLY ? `MODE: APPLY (backup -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');

let r = await downloadProject(conn, deviceSlot - 1, { pack: devicePack - 1, reconnect });
if (!r.ok || !r.crcOk || r.bytes === undefined) {
  await sleep(1500);
  r = await downloadProject(conn, deviceSlot - 1, { pack: devicePack - 1, reconnect });
}
if (!r.ok || !r.crcOk || r.bytes === undefined) {
  console.log(`  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
  console.log('\nFAIL-STOP. Nothing was written.');
  process.exit(1);
}
const b = r.bytes;
const nm = nameOf(b);
console.log(`  project ${deviceSlot}  "${nm}"`);
summarise(b, 'BEFORE');

let plan: { edits: Edit[]; notes: string[] };
try {
  plan = planCopy(b);
} catch (e) {
  console.log(`\n  REFUSED: ${e instanceof Error ? e.message : String(e)}`);
  console.log('FAIL-STOP. Nothing was written.');
  process.exit(1);
}
for (const n of plan.notes) console.log(`      ok: ${n}`);
const edits = plan.edits;
if (edits.length === 0) { console.log('\n  already correct; nothing to do.'); exitMidiScript(0); }
console.log(`\n  ${edits.length} byte(s) ${APPLY ? 'to write' : 'would change'}`);

if (!APPLY) {
  const preview = Buffer.from(b);
  for (const e of edits) preview[e.off] = e.to;
  summarise(preview, 'AFTER ');
  console.log('\nDRY RUN: nothing written.');
  exitMidiScript(0);
}

mkdirSync(backupDir, { recursive: true });
const backup = `${backupDir}/pack${devicePack}-proj${String(deviceSlot).padStart(2, '0')}.ncs`;
if (existsSync(backup)) { console.log(`  refusing to overwrite existing backup ${backup}`); process.exit(1); }
writeFileSync(backup, b);
console.log(`  backup written: ${backup}`);

const out = Buffer.from(b);
for (const e of edits) out[e.off] = e.to;

const up = await uploadProject(conn, out, deviceSlot - 1, { pack: devicePack - 1, reconnect });
if (!up.ok) {
  console.log(`  UPLOAD FAILED: ${up.error ?? 'unknown'}  (original at ${backup})`);
  console.log('\nFAIL-STOP.');
  process.exit(1);
}

const v = await downloadProject(conn, deviceSlot - 1, { pack: devicePack - 1, reconnect });
if (!v.ok || !v.crcOk || v.bytes === undefined) {
  console.log(`  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
  process.exit(1);
}
const back = v.bytes;
const intended = new Map(edits.map((e) => [e.off, e.to]));
const wrong: string[] = [];
let collateral = 0;
for (let i = 0; i < b.length; i++) {
  const want = intended.get(i);
  if (want !== undefined) {
    if (back[i] !== want) wrong.push(`0x${i.toString(16)} = ${back[i]} (wanted ${want})`);
  } else if (back[i] !== b[i]) collateral++;
}
if (wrong.length > 0 || collateral !== 0 || nameOf(back) !== nm) {
  console.log(`  VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 5).join(', ')}), collateral=${collateral}, name="${nameOf(back)}"`);
  console.log(`             restore with ${backup}`);
  process.exit(1);
}
console.log(`\n  "${nm}"  ${edits.length} byte(s) written, all verified, ZERO collateral`);
summarise(back, 'AFTER ');
// Independent re-check of the whole premise against the READ-BACK bytes, not
// against what we hoped we wrote: the three targets must now be byte-identical
// to the source and hold the eight-chord figure.
const srcRegion = regionOf(back, SRC_PATTERN);
const allMatch = DST_PATTERNS.every((p) => sameBytes(regionOf(back, p), srcRegion));
console.log(`  read-back: targets byte-identical to source pattern ${SRC_PATTERN + 1}: ${allMatch ? 'YES' : 'NO'}`);
if (!allMatch) { console.log(`  restore with ${backup}`); process.exit(1); }
console.log(`\nAPPLIED. restore point: ${backup}`);
endMidiScript();
