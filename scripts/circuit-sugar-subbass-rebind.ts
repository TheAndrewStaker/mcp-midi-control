/**
 * circuit-sugar-subbass-rebind.ts — rebind Sugar's Synth 1 from part 9
 * "Keyboard #3" to part 6 "Sub Bass", authored from the Songsterr source with
 * real note lengths and ties.
 *
 * Maintainer's decision, 2026-07-27, in his words: *"for sugar map, the
 * sub-bass descent 1. keyboard number three is a very simple part that I will
 * play by hand and loop manually instead of relying on it being sequenced."*
 *
 * So Synth 1 carries the Sub Bass and Keyboard #3 leaves the sequencer.
 *
 * ## Which projects, and why only those
 *
 * Part 6 sounds m25-m86 and nowhere else (124 onsets, verified against the
 * source, not assumed). On the flat 16-bar chop (project 46 = m1-16 ... project
 * 55 = m145-148) that is:
 *
 *   47 (m17-32)  Sub Bass in m25-32   -> patterns 5-8
 *   48 (m33-48)  all 16 bars          -> patterns 1-8
 *   49 (m49-64)  all 16 bars          -> patterns 1-8
 *   50 (m65-80)  all 16 bars          -> patterns 1-8
 *   51 (m81-96)  Sub Bass in m81-86   -> patterns 1-3
 *   52,53,54,55  no Sub Bass          -> Synth 1 CLEARED
 *   46 (m1-16)   no Sub Bass, and Synth 1 is already empty -> no-op
 *
 * Clearing 52-55 is the point of the change, not a side effect: he is going to
 * play Keyboard #3 by hand, and leaving the sequenced copy in would double him.
 *
 * ## RANGE — read this before running it
 *
 * Part 6 spans MIDI 16 (E0, 20.6 Hz) to MIDI 43 (G2), and 25% of its 124 notes
 * are E0. That is at or below the bottom of human hearing and below what any
 * practical monitor reproduces. For comparison: across a 289-project .ncs
 * corpus, Circuit synth 1 has never been written below MIDI 31, and the rest of
 * Sugar bottoms out at MIDI 35 (B1).
 *
 * Nothing REFUSES the low notes — the .ncs stores 0..127 and the Circuit synth
 * spans "10 octaves" (user guide) — so this script authors the part AT WRITTEN
 * PITCH by default. `--transpose 12` shifts it up an octave (E1..G3, lowest
 * note 41.2 Hz, a normal bass low E) and is the recommended setting if the
 * bottom of the part does not come through the monitors. It is NOT the default
 * because it changes the octave he will hear, and that is his call, not this
 * script's. The trade: at +12 the part tops out at G3, which is inside Synth
 * 2's register, so it stops being a clean sub-octave and starts doubling the
 * pad.
 *
 * ## Why this is NOT `apply_pattern mode:ncs_upload`
 *
 * That is the ordinary authoring path and it was the first choice, but on THIS
 * job it is a whole-project rewrite. `authorPlanIntoProject` also writes the
 * project SCALE, the pattern LENGTH byte of every track it touches, and (via
 * `authorArrangementIntoProject`, which is what an 8-pattern song needs) the
 * pattern CHAIN plus an empty-fill of every track in the union. It also reads
 * its template from a FILE, not from the device. Sugar's projects already carry
 * hand-set chains, per-project pattern lengths and, in 47, hand-set gates on
 * the other three tracks; rewriting all of that to move one track is exactly
 * the "stop and report" case.
 *
 * So the MUSIC comes through the pattern path — `flattenSongsterrMelodic` for
 * the notes and their sounding lengths, `gateSixthsFromSteps` for the gate
 * conversion, the same two functions `import_songsterr` itself uses — and only
 * the DEVICE BOUNDARY is surgical: `setNoteStep` / `clearNoteStep` on synth1,
 * nothing else. Synth 2, MIDI 1, MIDI 2, the drum tracks, the chains, the
 * lengths, the scale, the patches and the mixer levels are untouched BY
 * CONSTRUCTION.
 *
 * Note lengths and ties therefore arrive with the notes, in one pass, exactly
 * as the gate epic intended:
 *  - a note's gate is its sounding length from the source (ties folded in);
 *  - longer than the 16-step gate ceiling, or crossing a pattern boundary, and
 *    it re-articulates — the same split the rest of the build already uses;
 *  - a split that stays inside one pattern carries the TIE-FORWARD flag, so the
 *    device holds it instead of re-striking. A split ACROSS a pattern boundary
 *    does not: a tie needs its next onset in the same pattern to hold from.
 *
 * ## Pre-flight (refuses rather than assumes)
 *
 *   1. Project name matches /sugar/i.
 *   2. Every synth1 pattern this would write has LENGTH 32. A 16-step pattern
 *      would silently swallow half the bar.
 *   3. The synth1 pattern CHAIN covers every pattern this would write.
 *   4. No edit may land outside synth1's own note-step regions. Asserted per
 *      byte before anything is sent.
 *
 * ── SAFETY (same contract as circuit-sugar-gate-restore.ts) ─────────────────
 *  - DRY RUN by default; `--apply` required to write.
 *  - Device is the source of truth: download, patch, upload.
 *  - CRC GATED, TIMESTAMPED backup that refuses to overwrite, NAME ASSERTION,
 *    READ-BACK VERIFY against an exact expected-byte-set, FAIL-STOP.
 *
 * Usage:
 *   npx tsx scripts/circuit-sugar-subbass-rebind.ts                    # dry run
 *   npx tsx scripts/circuit-sugar-subbass-rebind.ts --slots 48 --apply # audition
 *   npx tsx scripts/circuit-sugar-subbass-rebind.ts --apply
 *   npx tsx scripts/circuit-sugar-subbass-rebind.ts --transpose 12 --apply
 *   npx tsx scripts/circuit-sugar-subbass-rebind.ts --offline <dir>
 *
 * `--pack` / `--slots` are 1-BASED device numbering, as the front panel shows.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { setNoteStep, clearNoteStep, decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { getNoteChain } from '../packages/circuit-tracks/src/ncs/chain.js';
import {
  PATTERNS_PER_TRACK, STEPS_PER_PATTERN, NOTE_STEP_REGION,
  META_OFFSETS, noteBlockIndex, noteStepBase, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { gateSixthsFromSteps, MAX_GATE_SIXTHS, GATE_SIXTHS_PER_STEP } from '../packages/core/src/protocol-generic/patterns/types.js';
import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import { flattenSongsterrMelodic } from '../packages/core/src/protocol-generic/patterns/songsterr.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const OFFLINE = flag('--offline');
const VERBOSE = argv.includes('--verbose');
const devicePack = Number(flag('--pack') ?? '5');
const TRANSPOSE = Number(flag('--transpose') ?? '0');

const SONG = '560358';
const PART_SUBBASS = 6;         // "Sub Bass" (Lead 8), 124 onsets, m25-86
const TRACK: NoteTrack = 'synth1';
const FIRST_SLOT = 46;          // Sugar 1/10 = bars 1-16
const BARS_PER_PROJECT = 16;
const STEPS_PER_BAR = 16;       // 4/4 at 16th resolution
const STEPS_PER_BEAT = 4;
/** Longest note the gate field holds, in STEPS. Anything longer re-articulates. */
const MAX_GATE_STEPS = MAX_GATE_SIXTHS / GATE_SIXTHS_PER_STEP;   // 16
/** Velocity the rest of the Sugar build carries (the importer's plain-hit value). */
const PLAIN_VELOCITY = 100;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

// ── source → absolute step segments ──────────────────────────────────
/** One playable segment: an onset the device can actually hold. */
interface Segment {
  /** Absolute step index from bar 1 step 0 of the song. */
  step: number;
  pitch: number;
  /** Length in steps, 1..16 (the gate ceiling). */
  lenSteps: number;
  velocity: number;
  /** Hold into the next onset instead of re-striking it. */
  tie: boolean;
  /** This segment is a continuation the format forced, not a source onset. */
  split: boolean;
}

interface SourceReceipt {
  segments: Segment[];
  onsets: number;
  low: number;
  high: number;
  splitsGateCeiling: number;
  splitsPatternBoundary: number;
  ties: number;
  rounded: number;
}

/**
 * Turn the flattened part into segments the .ncs can hold.
 *
 * A source note is cut wherever the FORMAT forces a cut and nowhere else: at
 * the 16-step gate ceiling, and at a pattern boundary (a pattern is its own
 * 32-step loop, so a note cannot run out of one). Every cut is reported.
 */
function buildSegments(
  notes: readonly { beat: number; pitch: number; durationBeats: number; velocity?: number }[],
): SourceReceipt {
  const segments: Segment[] = [];
  let splitsGate = 0;
  let splitsPattern = 0;
  let rounded = 0;
  let low = Infinity;
  let high = -Infinity;

  for (const n of notes) {
    const startExact = n.beat * STEPS_PER_BEAT;
    const start = Math.round(startExact);
    const lenExact = n.durationBeats * STEPS_PER_BEAT;
    const len = Math.max(1, Math.round(lenExact));
    if (Math.abs(startExact - start) > 1e-6 || Math.abs(lenExact - len) > 1e-6) rounded++;
    const pitch = n.pitch + TRANSPOSE;
    if (pitch < low) low = pitch;
    if (pitch > high) high = pitch;

    let cursor = start;
    const end = start + len;
    let first = true;
    while (cursor < end) {
      const patternEnd = (Math.floor(cursor / STEPS_PER_PATTERN) + 1) * STEPS_PER_PATTERN;
      const capEnd = cursor + MAX_GATE_STEPS;
      const segEnd = Math.min(end, capEnd, patternEnd);
      segments.push({
        step: cursor, pitch, lenSteps: segEnd - cursor,
        velocity: n.velocity ?? PLAIN_VELOCITY,
        tie: false, split: !first,
      });
      if (segEnd < end) {
        if (segEnd === patternEnd) splitsPattern++;
        else splitsGate++;
      }
      cursor = segEnd;
      first = false;
    }
  }
  segments.sort((a, b) => a.step - b.step || a.pitch - b.pitch);

  // TIE-FORWARD. A segment holds into the next onset only when that onset is
  // exactly where this one ends, sits in the SAME pattern (a tie has nothing to
  // hold into across a pattern boundary), and carries the identical pitch set.
  const byStep = new Map<number, Segment[]>();
  for (const s of segments) {
    const list = byStep.get(s.step) ?? [];
    list.push(s);
    byStep.set(s.step, list);
  }
  let ties = 0;
  for (const [step, group] of byStep) {
    const lens = new Set(group.map((g) => g.lenSteps));
    if (lens.size !== 1) continue;                       // mixed lengths: the flag is per STEP, so no
    const end = step + group[0].lenSteps;
    if (Math.floor(end / STEPS_PER_PATTERN) !== Math.floor(step / STEPS_PER_PATTERN)
      && end % STEPS_PER_PATTERN !== 0) continue;
    if (end % STEPS_PER_PATTERN === 0) continue;         // ends AT the boundary: nothing follows in this pattern
    const next = byStep.get(end);
    if (next === undefined) continue;
    const a = group.map((g) => g.pitch).sort((x, y) => x - y).join(',');
    const b = next.map((g) => g.pitch).sort((x, y) => x - y).join(',');
    if (a !== b) continue;
    // Only a segment that was CUT short holds forward; a source note that ended
    // where the next one begins is two real attacks, not one held note.
    if (!next.every((g) => g.split)) continue;
    for (const g of group) g.tie = true;
    ties += group.length;
  }

  return {
    segments,
    onsets: notes.length,
    low: low === Infinity ? 0 : low,
    high: high === -Infinity ? 0 : high,
    splitsGateCeiling: splitsGate,
    splitsPatternBoundary: splitsPattern,
    ties,
    rounded,
  };
}

// ── per-project planning ─────────────────────────────────────────────
interface Edit { off: number; from: number; to: number }

interface ProjectPlan {
  edits: Edit[];
  /** Patterns whose synth1 content this rewrites. */
  patterns: number[];
  notesWritten: number;
  notesCleared: number;
  refusal?: string;
  gateHist: Map<number, number>;
  ties: number;
}

function planProject(b: Uint8Array, slot: number, receipt: SourceReceipt): ProjectPlan {
  const plan: ProjectPlan = { edits: [], patterns: [], notesWritten: 0, notesCleared: 0, gateHist: new Map(), ties: 0 };
  const projectIndex = slot - FIRST_SLOT;
  const firstStep = projectIndex * BARS_PER_PROJECT * STEPS_PER_BAR;

  // What synth1 SHOULD hold, per pattern, per step.
  const wanted = new Map<number, Map<number, Segment[]>>();
  for (const s of receipt.segments) {
    const rel = s.step - firstStep;
    if (rel < 0 || rel >= PATTERNS_PER_TRACK * STEPS_PER_PATTERN) continue;
    const p = Math.floor(rel / STEPS_PER_PATTERN);
    const step = rel % STEPS_PER_PATTERN;
    const perPattern = wanted.get(p) ?? new Map<number, Segment[]>();
    const list = perPattern.get(step) ?? [];
    list.push(s);
    perPattern.set(step, list);
    wanted.set(p, perPattern);
  }

  // Patterns to rewrite: every pattern that gains content, plus every pattern
  // that currently HOLDS synth1 content and should not (the Keyboard #3 clear).
  const touched = new Set<number>(wanted.keys());
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    if (decodeNotePattern(b, TRACK, p).some((s) => s.active)) touched.add(p);
  }
  plan.patterns = [...touched].sort((x, y) => x - y);
  if (plan.patterns.length === 0) return plan;

  // PRE-FLIGHT: a pattern gaining content must be 32 steps long and inside the
  // track's chain, or half of it never plays.
  const chain = getNoteChain(b, TRACK);
  for (const p of wanted.keys()) {
    const len = b[META_OFFSETS[noteBlockIndex(TRACK, p)]] + 1;
    if (len !== STEPS_PER_PATTERN) {
      plan.refusal = `synth1 pattern ${p + 1} is ${len} steps, not ${STEPS_PER_PATTERN}; writing 32 steps into it would silently drop half the bar. Set the pattern length first.`;
      return plan;
    }
    if (chain === undefined || p < chain.start || p > chain.end) {
      plan.refusal = `synth1 pattern ${p + 1} is outside the track chain (${chain ? `${chain.start + 1}-${chain.end + 1}` : 'none'}); the authored notes would never play. Set the chain first.`;
      return plan;
    }
  }

  // Author into a COPY, then diff. The copy goes through the shipped .ncs
  // authoring primitive, so the step records are device-shaped; the diff is
  // what proves nothing outside synth1 moved.
  const out = Buffer.from(b);
  for (const p of plan.patterns) {
    const perPattern = wanted.get(p);
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const segs = perPattern?.get(s);
      if (segs === undefined || segs.length === 0) { clearNoteStep(out, TRACK, p, s); continue; }
      const tie = segs.every((g) => g.tie);
      const notes = segs.map((g) => {
        const conv = gateSixthsFromSteps(g.lenSteps);
        plan.gateHist.set(conv.gate_sixths, (plan.gateHist.get(conv.gate_sixths) ?? 0) + 1);
        return { note: g.pitch, gate: conv.gate_sixths, tie, delay: 0, velocity: g.velocity };
      });
      if (tie) plan.ties += notes.length;
      setNoteStep(out, TRACK, p, s, notes);
      plan.notesWritten += notes.length;
    }
  }

  // How many notes LEAVE the sequencer: every synth1 note that was in a pattern
  // this rewrites. It is the Keyboard #3 count, not a net figure — the two parts
  // are unrelated and netting them off would hide both.
  for (const p of plan.patterns) {
    for (const s of decodeNotePattern(b, TRACK, p)) plan.notesCleared += s.notes.length;
  }

  // Diff, and assert every changed byte is inside synth1's own step regions.
  const allowed: [number, number][] = plan.patterns.map((p) => {
    const base = noteStepBase(TRACK, p);
    return [base, base + NOTE_STEP_REGION];
  });
  for (let i = 0; i < b.length; i++) {
    if (out[i] === b[i]) continue;
    if (!allowed.some(([lo, hi]) => i >= lo && i < hi)) {
      plan.refusal = `internal error: authoring touched byte 0x${i.toString(16)}, outside synth1's step regions. Nothing written.`;
      return plan;
    }
    plan.edits.push({ off: i, from: b[i], to: out[i] });
  }
  return plan;
}

// ── shared plumbing ──────────────────────────────────────────────────
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function parseSlots(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, c] = part.split('-').map((x) => Number(x.trim()));
    for (let i = a; i <= (c ?? a); i++) out.push(i);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}
const slotSpec = flag('--slots') ?? '46-55';
const slots = parseSlots(slotSpec);

function describe(plan: ProjectPlan): void {
  const hist = [...plan.gateHist].sort((a, b) => a[0] - b[0])
    .map(([g, c]) => `${g / 6}st x${c}`).join('  ');
  console.log(`      synth1 patterns ${plan.patterns.map((p) => p + 1).join(',')}: ${plan.notesWritten} Sub Bass note(s) in, ${plan.notesCleared} Keyboard #3 note(s) out, ${plan.ties} tied`);
  if (plan.notesWritten > 0) console.log(`             lengths: ${hist}`);
}

const fetched = await fetchSongsterrPart(SONG, { track: PART_SUBBASS });
const flat = flattenSongsterrMelodic(fetched.part);
const receipt = buildSegments(flat.notes);
console.log(`Songsterr ${SONG} part ${PART_SUBBASS} "${fetched.allTracks[PART_SUBBASS]?.name ?? '?'}" (${fetched.allTracks[PART_SUBBASS]?.instrument ?? '?'})`);
console.log(`  ${receipt.onsets} source onsets, ${flat.ties_folded} tie(s) folded into length, ${flat.chords} chord beat(s)`);
console.log(`  authored range ${receipt.low} (${pitchName(receipt.low)}) .. ${receipt.high} (${pitchName(receipt.high)})   transpose ${TRANSPOSE >= 0 ? '+' : ''}${TRANSPOSE}`);
console.log(`  ${receipt.segments.length} device segment(s): ${receipt.splitsGateCeiling} split at the 16-step gate ceiling, ${receipt.splitsPatternBoundary} at a pattern boundary, ${receipt.ties} tied forward`);
if (receipt.rounded > 0) console.log(`  ${receipt.rounded} onset/length(s) did not land on the 16th grid and were rounded`);
if (TRANSPOSE === 0 && receipt.low < 31) {
  console.log(`  ⚠ ${flat.notes.filter((n) => n.pitch < 31).length} of ${receipt.onsets} notes are below MIDI 31, the lowest note any of 289 corpus projects writes on a Circuit synth.`);
  console.log('    Authoring AT WRITTEN PITCH. Re-run with --transpose 12 if the bottom of the part does not come through.');
}
console.log('');

// ── OFFLINE mode ─────────────────────────────────────────────────────
if (OFFLINE) {
  console.log(`OFFLINE plan against ${OFFLINE} (no device, no writes)\n`);
  for (const slot of slots) {
    const f = join(OFFLINE, `pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`);
    if (!existsSync(f)) { console.log(`  project ${slot}: missing ${f}`); continue; }
    const b = readFileSync(f);
    const plan = planProject(b, slot, receipt);
    if (plan.refusal !== undefined) { console.log(`  project ${slot}  "${nameOf(b)}"  REFUSED: ${plan.refusal}`); continue; }
    if (plan.edits.length === 0) { console.log(`  project ${slot}  "${nameOf(b)}"  nothing to do`); continue; }
    console.log(`  project ${slot}  "${nameOf(b)}"  ${plan.edits.length} byte(s) would change`);
    describe(plan);
    if (VERBOSE) {
      const patched = Buffer.from(b);
      for (const e of plan.edits) patched[e.off] = e.to;
      for (const p of plan.patterns) {
        const row = decodeNotePattern(patched, TRACK, p).map((s) => (s.active
          ? `${pitchName(s.notes[0].note)}${s.notes[0].tie ? '_' : ''}:${s.notes[0].gate / 6}`
          : '.')).join(' ');
        console.log(`        p${p + 1}  ${row}`);
      }
    }
  }
  process.exit(0);
}

// ── DEVICE mode ──────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-subbass-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, projects ${slotSpec}: Synth 1 -> Sub Bass (part 6), Keyboard #3 out`);
console.log(APPLY ? `MODE: APPLY (backups -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');
if (APPLY) mkdirSync(backupDir, { recursive: true });

let patched = 0, skipped = 0;
for (const slot of slots) {
  const tag = `project ${String(slot).padStart(2)}`;
  let r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    await sleep(1500);
    r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Projects after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  const b = r.bytes;
  const nm = nameOf(b);
  if (!/sugar/i.test(nm)) {
    console.log(`  ${tag}  "${nm}"  REFUSED: not a Sugar project.`);
    continue;
  }
  const plan = planProject(b, slot, receipt);
  if (plan.refusal !== undefined) {
    console.log(`  ${tag}  "${nm}"  REFUSED: ${plan.refusal}`);
    console.log(`\nFAIL-STOP. ${patched} patched. Projects after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }
  if (plan.edits.length === 0) { console.log(`  ${tag}  "${nm}"  nothing to do (Synth 1 already correct)`); skipped++; continue; }

  if (!APPLY) {
    console.log(`  ${tag}  "${nm}"  would change ${plan.edits.length} byte(s)`);
    describe(plan);
    continue;
  }

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`  ${tag}  refusing to overwrite existing backup ${backup}`); process.exit(1); }
  writeFileSync(backup, b);

  const out = Buffer.from(b);
  for (const e of plan.edits) out[e.off] = e.to;

  const up = await uploadProject(conn, out, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`  ${tag}  UPLOAD FAILED: ${up.error ?? 'unknown'}  (original at ${backup})`);
    console.log(`\nFAIL-STOP. ${patched} patched. Projects after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }

  const v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  ${tag}  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    process.exit(1);
  }
  const intended = new Map(plan.edits.map((e) => [e.off, e.to]));
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
  console.log(`  ${tag}  "${nm}"  ${plan.edits.length} byte(s) written, all verified, ZERO collateral`);
  describe(plan);
  patched++;
  await sleep(400);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${patched} patched, ${skipped} already correct.`);
if (APPLY && patched > 0) console.log(`restore points: ${backupDir}`);
endMidiScript();
