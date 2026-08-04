/**
 * circuit-sugar-gate-restore.ts — restore the LOST NOTE LENGTHS (and ties) to
 * the Sugar build, projects 48-55, from the Songsterr source.
 *
 * ## What is wrong
 *
 * Projects 46 (1/10) and 47 (2/10) carry real per-note durations lifted from
 * the source (gate 12 / 24 / 48 / 96 = an eighth / a quarter / a half / a whole
 * bar). Projects 48-55 carry gate 6 — ONE SIXTEENTH — on every note of every
 * melodic track, because the pass that authored them never wrote the gate lane.
 * Synth 1 and Synth 2 are both PADS: project 51's Synth 2 wants a 21-step
 * sustain and gets a 16th. That is not a nuance, it is the wrong instrument.
 *
 * ## What this does
 *
 * For each authored note in projects 48-55, tracks synth1 / synth2 / midi1, it
 * looks the note up in the Songsterr source at the beat that note's (project,
 * pattern, step) maps to, and writes the source's own sounding length into the
 * gate lane. Nothing else. It writes exactly ONE byte per note slot — the gate
 * lane at `slot+1` — so the note number, delay, velocity, slot mask, step
 * probability, pattern metadata, chains, patches, mixer levels and every other
 * track are preserved BY CONSTRUCTION, not by care.
 *
 * PITCH IS OUT OF SCOPE. This script cannot move a note: it never writes byte
 * `slot+0`. The 2026-07-27 audit put the melodic transcription at 97.8%
 * faithful (MIDI 1 at 1176/1176 exactly), and the maintainer's instruction is
 * to treat the existing content as the reference. So the source is consulted
 * for LENGTH ONLY, joined onto the authored note by pitch, never the reverse.
 *
 * ## The mapping, and why it is not a guess
 *
 * The build is a flat 16-bar chop: project 46 = bars 1-16 ... project 55 =
 * bars 145-148. Each of the 8 patterns is 32 steps at 16th resolution = 2 bars.
 * So for project P (46-based index `pi`), pattern `p`, step `s`:
 *
 *     absolute beat = ((pi * 16) + p * 2) * 4 + s / 4
 *
 * That mapping is what makes MIDI 1 match the source 1176/1176 exactly (no
 * other offset scores above 5%), so it is proved by the data, not assumed.
 *
 * ## How a length is derived
 *
 *  1. A source note of the same pitch STARTING at this step's beat: its
 *     `durationBeats` (ties already folded in by `flattenSongsterrMelodic`) is
 *     the length.
 *  2. Else a source note of the same pitch still SOUNDING through this beat
 *     (started earlier, ends later): the authored note is a re-articulation the
 *     format forced (the gate field tops out at 16 steps, and a pattern
 *     boundary cannot be crossed), so its length is the REMAINDER of that
 *     source note from here.
 *  3. Else: no source note explains it. Leave the gate alone and count it.
 *
 * Steps → sixths goes through `gateSixthsFromSteps()` (patterns/types.ts), the
 * importer-side converter that rounds, clamps and REPORTS, so the rounding and
 * the 96-sixth ceiling are handled in one place and counted in the receipt.
 *
 * ## Ties
 *
 * Bit 7 of the gate lane is the device's TIE-FORWARD flag, hardware-confirmed
 * 2026-07-27 as INDEPENDENT of the magnitude (byte 176 = 0x80|48 survived a
 * device load+save). A tie is written only when it will actually do something,
 * which is the device's own documented recipe (manual ":1879-1949", and 524/524
 * of the maintainer's own tied notes obey it):
 *
 *   - the source note runs PAST the end of the gate we are about to write, AND
 *   - the next authored onset on this track is exactly where that gate ends, AND
 *   - that onset holds the IDENTICAL chord, AND
 *   - every note on this step qualifies (the device applies the flag per STEP,
 *     never per note, so a mixed step would be a lie).
 *
 * Anything short of all four leaves the flag as it was. A tie that does not
 * reach its next onset is a device no-op at best and a stuck drone at worst.
 *
 * ## Scope
 *
 *  - Projects 48-55 only. 46 and 47 are the maintainer's own hand-set work and
 *    are REFUSED by name; `--slots` cannot select them.
 *  - Tracks synth1 / synth2 / midi1. NOT midi2: that track feeds the SPD-SX,
 *    whose pads are one-shot samples that ignore note length, and its content
 *    is drums, not one of the three melodic parts this script has a source for.
 *
 * ## The binding guard, and why it is not a comment
 *
 * This script joins an authored note to the source BY PITCH, so it is only
 * correct while a track still holds the part named in `TRACK_PART`. Synth 1's
 * binding has already moved once (`circuit-sugar-subbass-rebind.ts` swapped it
 * from part 9 "Keyboard #3" to part 6 "Sub Bass"), and a stale binding would
 * not fail loudly on its own: the two parts overlap in the 35..43 range, so a
 * handful of notes would coincidentally match and get a length belonging to a
 * different part.
 *
 * So a track whose authored notes are not FULLY explained by its part is
 * refused outright: any unmatched note drops every edit for that track and
 * reports it. In the healthy case unmatched is exactly 0 on all three tracks
 * across all eight projects, so this costs nothing and catches the rebind.
 *
 * ── SAFETY (inherited from circuit-breakdown-groove-fix.ts, each earned) ─────
 *  - DRY RUN by default; `--apply` required to write.
 *  - Device is the source of truth: download, patch, upload. Never upload a
 *    local snapshot.
 *  - CRC GATED (`ok` only checks length, so `crcOk` is checked separately).
 *  - TIMESTAMPED per-slot backup, refuses to overwrite one.
 *  - NAME ASSERTION on read-back.
 *  - READ-BACK VERIFY with an exact expected-byte-set: only the intended bytes
 *    may differ, each holding its intended value, zero collateral.
 *  - FAIL-STOP, reporting what is done vs untouched.
 *
 * Usage:
 *   npx tsx scripts/circuit-sugar-gate-restore.ts                   # dry run, 48-55
 *   npx tsx scripts/circuit-sugar-gate-restore.ts --slots 48 --apply
 *   npx tsx scripts/circuit-sugar-gate-restore.ts --offline samples/circuit-ncs/backup-sugar-...
 *
 * `--pack` / `--slots` are 1-BASED device numbering, as the front panel shows.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { decodeNotePattern, gateByte } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  PATTERNS_PER_TRACK, STEPS_PER_PATTERN, NOTE_STEP_BYTES,
  noteStepBase, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { gateSixthsFromSteps } from '../packages/core/src/protocol-generic/patterns/types.js';
import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import { flattenSongsterrMelodic, type MelodicNote } from '../packages/core/src/protocol-generic/patterns/songsterr.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const APPLY = argv.includes('--apply');
const OFFLINE = flag('--offline');
const VERBOSE = argv.includes('--verbose');
const devicePack = Number(flag('--pack') ?? '5');

/** Songsterr song id + the three melodic part indices, as audited 2026-07-27. */
const SONG = '560358';
const PART_SYNTH1 = 9;   // "Keyboard #3" (Pad 1, new age)   -> Circuit Synth 1
const PART_SYNTH2 = 8;   // "Keyboard #2" (Pad 5, bowed)     -> Circuit Synth 2
const PART_MIDI1 = 7;    // "Keyboard #1" (Orchestral Harp)  -> MicroFreak on MIDI 1
const TRACK_PART: ReadonlyArray<readonly [NoteTrack, number]> = [
  ['synth1', PART_SYNTH1], ['synth2', PART_SYNTH2], ['midi1', PART_MIDI1],
];

/** Device slot of the FIRST project of the chop (Sugar 1/10 = bars 1-16). */
const FIRST_SLOT = 46;
/** Bars per project (8 patterns x 2 bars). */
const BARS_PER_PROJECT = 16;
/** 16th-note grid: 4 steps per quarter-note beat. */
const STEPS_PER_BEAT = 4;
/** Steps in one bar of 4/4 at 16th resolution. */
const STEPS_PER_BAR = 16;
/** The maintainer's own hand-set projects. Refused, by name, not by comment. */
const HANDS_OFF = new Set([46, 47]);

// ── source ───────────────────────────────────────────────────────────
interface SourceNote { beat: number; pitch: number; durBeats: number; tie: boolean }

/** One melodic part's notes, indexed by pitch for the length lookup. */
interface PartIndex {
  byPitch: Map<number, SourceNote[]>;
  count: number;
}

function indexPart(notes: readonly MelodicNote[]): PartIndex {
  const byPitch = new Map<number, SourceNote[]>();
  for (const n of notes) {
    const list = byPitch.get(n.pitch) ?? [];
    list.push({ beat: n.beat, pitch: n.pitch, durBeats: n.durationBeats, tie: n.tie === true });
    byPitch.set(n.pitch, list);
  }
  for (const list of byPitch.values()) list.sort((a, b) => a.beat - b.beat);
  return { byPitch, count: notes.length };
}

const EPS = 1e-6;

/**
 * Length in STEPS the source wants for an authored note of `pitch` sounding at
 * `beat`, or undefined when no source note explains it.
 *
 * `startsHere` distinguishes case 1 (a fresh source onset) from case 2 (a
 * re-articulation of a note the format could not hold), which is what the tie
 * rule needs: only case 2, or a case 1 whose length was capped, can carry a tie.
 */
function sourceLength(
  idx: PartIndex, pitch: number, beat: number,
): { steps: number; startsHere: boolean } | undefined {
  const list = idx.byPitch.get(pitch);
  if (list === undefined) return undefined;
  for (const n of list) {
    if (Math.abs(n.beat - beat) < EPS) return { steps: n.durBeats * STEPS_PER_BEAT, startsHere: true };
  }
  for (const n of list) {
    if (n.beat < beat - EPS && n.beat + n.durBeats > beat + EPS) {
      return { steps: (n.beat + n.durBeats - beat) * STEPS_PER_BEAT, startsHere: false };
    }
  }
  return undefined;
}

// ── planning ─────────────────────────────────────────────────────────
interface Edit { off: number; from: number; to: number; what: string }

interface Stats {
  notes: number;      // authored note slots examined
  matched: number;    // slots a source length was found for
  unmatched: number;  // slots with no source explanation (gate left alone)
  changed: number;    // gate bytes actually different
  clamped: number;    // wanted longer than 96 sixths
  rounded: number;    // wanted a fractional sixth
  ties: number;       // steps given a tie flag
  agreed: number;     // gate byte ALREADY equal to the derived one
  overrun: number;    // derived gate ends past step 32 (runs into the next pattern)
  gateHist: Map<number, number>;  // resulting gate magnitude -> count
}

const newStats = (): Stats => ({
  notes: 0, matched: 0, unmatched: 0, changed: 0, clamped: 0, rounded: 0, ties: 0,
  agreed: 0, overrun: 0, gateHist: new Map(),
});

/**
 * Plan every gate-lane byte for one project.
 *
 * Two passes per pattern, deliberately: the tie rule needs to know where the
 * NEXT onset is and what chord it holds, which is only knowable once the whole
 * pattern's steps have been read.
 */
function planProject(
  b: Uint8Array, slot: number, parts: Map<NoteTrack, PartIndex>,
  perTrack: Map<NoteTrack, Stats>, refusals: string[] = [],
): Edit[] {
  const edits: Edit[] = [];
  const projectIndex = slot - FIRST_SLOT;

  for (const [track, partId] of TRACK_PART) {
    const idx = parts.get(track);
    if (idx === undefined) continue;
    const st = perTrack.get(track) as Stats;
    /** Where this track's edits start, so an unexplained note can drop them all. */
    const editMark = edits.length;

    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const base = noteStepBase(track, p);
      const steps = decodeNotePattern(b, track, p);
      /** Absolute source beat of step 0 of this pattern. */
      const patternBeat = ((projectIndex * BARS_PER_PROJECT + p * 2) * STEPS_PER_BAR) / STEPS_PER_BEAT;

      // Pass 1: the length every slot wants, in sixths, plus whether the source
      // note it came from runs past that length (the tie precondition).
      interface Want { gate: number; runsPast: boolean }
      const wants: (Map<number, Want> | undefined)[] = steps.map(() => undefined);
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        const step = steps[s];
        if (!step.active) continue;
        const beat = patternBeat + s / STEPS_PER_BEAT;
        const m = new Map<number, Want>();
        for (const slotNote of step.notes) {
          st.notes++;
          const found = sourceLength(idx, slotNote.note, beat);
          if (found === undefined) { st.unmatched++; continue; }
          st.matched++;
          const g = gateSixthsFromSteps(found.steps);
          if (g.clamped) st.clamped++;
          if (g.rounded) st.rounded++;
          m.set(slotNote.note, { gate: g.gate_sixths, runsPast: g.clamped && found.steps * 6 > g.gate_sixths });
        }
        if (m.size > 0) wants[s] = m;
      }

      // Pass 2: ties. A step may tie forward only when its gate lands exactly on
      // the next onset AND that onset holds the identical chord AND every note
      // on the step wants it. All four, or no tie.
      const onsets: number[] = [];
      for (let s = 0; s < STEPS_PER_PATTERN; s++) if (steps[s].active) onsets.push(s);

      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        const want = wants[s];
        const step = steps[s];
        if (want === undefined || !step.active) continue;
        const nextOnset = onsets.find((o) => o > s);
        let tie = false;
        if (nextOnset !== undefined && step.notes.every((n) => want.has(n.note))) {
          const gates = [...want.values()].map((w) => w.gate);
          const uniform = gates.every((g) => g === gates[0]);
          const reaches = uniform && gates[0] === (nextOnset - s) * 6;
          const sameChord =
            steps[nextOnset].notes.length === step.notes.length
            && steps[nextOnset].notes.every((n, i) => n.note === step.notes[i].note);
          const allRunPast = [...want.values()].every((w) => w.runsPast);
          tie = reaches && sameChord && allRunPast;
        }
        if (tie) st.ties++;

        const stepBase = base + s * NOTE_STEP_BYTES;
        let i = 0;
        for (let n = 0; n < 6; n++) {
          if (!((b[stepBase] >> n) & 1)) continue;
          const slotNote = step.notes[i++];
          const w = want.get(slotNote.note);
          if (w === undefined) continue;            // unmatched: leave the byte alone
          const to = gateByte(w.gate, tie);
          st.gateHist.set(w.gate, (st.gateHist.get(w.gate) ?? 0) + 1);
          if (s + w.gate / 6 > STEPS_PER_PATTERN) st.overrun++;
          const off = stepBase + 4 + n * 4 + 1;
          if (b[off] !== to) {
            st.changed++;
            edits.push({ off, from: b[off], to, what: `${track} p${p + 1} s${s} note ${slotNote.note}` });
          } else st.agreed++;
        }
      }
    }

    // BINDING GUARD. Every authored note on this track must be explained by the
    // part this script binds it to. One that is not means the track no longer
    // holds that part (the Sub Bass rebind is the live example), and a
    // pitch-joined length from the wrong part is worse than no change at all.
    if (st.unmatched > 0) {
      const dropped = edits.length - editMark;
      edits.length = editMark;
      st.changed = 0;
      refusals.push(
        `${track}: ${st.unmatched} of ${st.notes} authored note(s) are not in Songsterr part ${partId}. `
        + `This track no longer holds that part; ${dropped} edit(s) dropped and NOTHING written for it.`,
      );
    }
  }
  return edits;
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
const slotSpec = flag('--slots') ?? '48-55';
const slots = parseSlots(slotSpec);
// 46 and 47 are the maintainer's own hand-set gates. They are refused on any
// path that can WRITE. `--offline` writes nothing at all (it exits before the
// device section), and planning against them there is the single best available
// validation of this whole derivation: if the source-derived gates reproduce
// what he dialled in by hand, the method is proved rather than asserted.
const forbidden = slots.filter((s) => HANDS_OFF.has(s));
if (forbidden.length > 0 && OFFLINE === undefined) {
  console.log(`REFUSED: project(s) ${forbidden.join(', ')} carry the maintainer's own hand-set gates and are out of scope.`);
  console.log('  (they can be planned READ-ONLY with --offline <dir>, which writes nothing, as a check on the derivation)');
  process.exit(1);
}

function report(perTrack: Map<NoteTrack, Stats>): void {
  for (const [track] of TRACK_PART) {
    const s = perTrack.get(track) as Stats;
    if (s.notes === 0) continue;
    const hist = [...s.gateHist].sort((a, b) => a[0] - b[0])
      .map(([g, c]) => `${g}${g % 6 === 0 ? `(${g / 6}st)` : ''}x${c}`).join(' ');
    console.log(`      ${track.padEnd(7)} ${String(s.notes).padStart(4)} notes  ${s.matched} matched  ${s.unmatched} unmatched  ${s.changed} gate byte(s) change  ${s.agreed} already agree  ${s.ties} tie(s)`);
    if (s.clamped > 0 || s.rounded > 0) console.log(`              clamped to 96 sixths: ${s.clamped}   rounded to a whole sixth: ${s.rounded}`);
    if (s.overrun > 0) console.log(`              gate ends past step 32 (runs into the next pattern): ${s.overrun}`);
    if (VERBOSE) console.log(`              resulting gates: ${hist}`);
  }
}

async function loadParts(): Promise<Map<NoteTrack, PartIndex>> {
  const parts = new Map<NoteTrack, PartIndex>();
  for (const [track, partId] of TRACK_PART) {
    const fetched = await fetchSongsterrPart(SONG, { track: partId });
    if (!fetched.isMelodic) throw new Error(`part ${partId} is not melodic; the tuning array is missing`);
    const flat = flattenSongsterrMelodic(fetched.part);
    parts.set(track, indexPart(flat.notes));
    console.log(`  source part ${partId} -> ${track}: ${flat.notes.length} onsets, ${flat.ties_folded} tie(s) folded, range ${flat.range?.low}..${flat.range?.high}`);
  }
  return parts;
}

const parts = await loadParts();
console.log('');

// ── OFFLINE mode ─────────────────────────────────────────────────────
if (OFFLINE) {
  console.log(`OFFLINE plan against ${OFFLINE} (no device, no writes)\n`);
  for (const slot of slots) {
    const f = join(OFFLINE, `pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`);
    if (!existsSync(f)) { console.log(`  project ${slot}: missing ${f}`); continue; }
    const b = readFileSync(f);
    const perTrack = new Map<NoteTrack, Stats>(TRACK_PART.map(([t]) => [t, newStats()]));
    const refusals: string[] = [];
    const edits = planProject(b, slot, parts, perTrack, refusals);
    console.log(`  project ${slot}  "${nameOf(b)}"  ${edits.length} byte(s) would change`);
    for (const m of refusals) console.log(`      REFUSED ${m}`);
    report(perTrack);
    if (VERBOSE) {
      for (const e of edits.slice(0, 40)) {
        const d = (v: number): string => `${v & 0x7f}${(v & 0x80) !== 0 ? '+tie' : ''}`;
        console.log(`        ${e.what.padEnd(32)} ${d(e.from)} -> ${d(e.to)}`);
      }
      if (edits.length > 40) console.log(`        ... ${edits.length - 40} more`);
    }
    console.log('');
  }
  process.exit(0);
}

// ── DEVICE mode ──────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-sugargate-${stamp}`;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`Pack ${devicePack}, projects ${slotSpec}: Sugar note-length restore (gate lane + tie only)`);
console.log(APPLY ? `MODE: APPLY (backups -> ${backupDir})` : 'MODE: DRY RUN (nothing will be written)');
console.log('');
if (APPLY) mkdirSync(backupDir, { recursive: true });

let patched = 0, clean = 0;
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
    console.log(`  ${tag}  "${nm}"  REFUSED: not a Sugar project (the source mapping is song-specific).`);
    continue;
  }
  const perTrack = new Map<NoteTrack, Stats>(TRACK_PART.map(([t]) => [t, newStats()]));
  const refusals: string[] = [];
  const edits = planProject(b, slot, parts, perTrack, refusals);
  for (const m of refusals) console.log(`  ${tag}  REFUSED ${m}`);
  if (edits.length === 0) { console.log(`  ${tag}  "${nm}"  already correct`); clean++; continue; }

  if (!APPLY) {
    console.log(`  ${tag}  "${nm}"  would change ${edits.length} byte(s)`);
    report(perTrack);
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
    console.log(`\nFAIL-STOP. ${patched} patched. Projects after ${slot} are UNTOUCHED.`);
    process.exit(1);
  }

  const v = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  if (!v.ok || !v.crcOk || v.bytes === undefined) {
    console.log(`  ${tag}  VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`);
    process.exit(1);
  }
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
  console.log(`  ${tag}  "${nm}"  ${edits.length} gate byte(s) written, all verified, ZERO collateral`);
  report(perTrack);
  patched++;
  await sleep(400);
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${patched} patched, ${clean} already correct.`);
if (APPLY && patched > 0) console.log(`restore points: ${backupDir}`);
endMidiScript();
