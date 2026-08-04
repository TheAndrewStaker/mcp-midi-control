/**
 * circuit-after-dark-synth2-square-lead.ts: make **Synth 2** carry part 4
 * `Lead 1 (square)` across the WHOLE of After Dark, as the VE-500's dedicated
 * vocal pitch target. Displaces the pad (and, on P1, the intro piano).
 *
 * Build record: `docs/_private/rig/songs/after-dark.md`.
 * Byte-surgical shape copied from `circuit-after-dark-midi1-octave-up.ts`.
 *
 * ## The settled map (maintainer, 2026-07-28, his words)
 *
 *   "Lead 1 (square) is the vocal instrument on Songsterr. That should be mapped
 *    to Synth 2 throughout the whole song, intended to be notes for the boss
 *    ve-500 so my voice tunes to the notes as I sing. Lead 2 (sawtooth) is the
 *    one to map to MIDI 1 in the same octave Songsterr has it in. […] I will play
 *    the Songsterr instruments: Acoustic Grand Piano and Pad instruments by hand."
 *
 * So Synth 2 = part 4, everywhere part 4 sounds; the piano (parts 5 / 1) and the
 * pad (part 2) come OFF the card entirely because he plays them himself.
 *
 * ## Why ch2, and why it has to be a separate track from MIDI 1
 *
 * Measured at the VE-500's own MIDI In, 2026-07-28: channels 1, 2, 4 and 10 all
 * arrive through the Circuit -> MicroFreak -> VE-500 chain and **ch3 does not**,
 * because the MicroFreak ABSORBS its own receive channel (Input Chan 3) and
 * relays the rest. MIDI 1 is ch3, so a target there reaches the MicroFreak or the
 * VE-500, never both. Synth 2 is ch2, which is relayed, and its stored mixer
 * level is already 0, so it sequences silently: exactly the shape of a pure
 * pitch-target track.
 *
 * ## The octave, worked out rather than assumed
 *
 * The VE-500 must hear the line at the pitch he is SINGING, which is part 4 as
 * written: 43..65 = G2..F4 across the song. The Circuit transmits **12 semitones
 * below what it stores**, measured on this card on both track kinds:
 *
 *   - MIDI track: midi1 stored 51..65, arrived 39..53.
 *   - SYNTH track: synth1 (the bass) stored 39..43, arrived 27..31.
 *
 * Constant -12 at both ends on both kinds. Written 43..65 must therefore be
 * STORED 55..77, and that is what `TRANSPOSE` below is for. Per window the source
 * is narrower than the whole-song span, so each project's own expected stored
 * range is derived from its own cells and printed.
 *
 * ## Where part 4 is silent
 *
 * P1 (Intro, m1-16) is before part 4's first onset, and P6 (the Break) is a rest
 * for it. Synth 2 is CLEARED there rather than left holding the displaced piano /
 * pad. **P1 therefore ends up with no rig content at all** — bass, leads and drums
 * all start at m19 — which is correct under this map and not a failed write: he
 * plays the intro by hand.
 *
 * ## What gets written, and nothing else
 *
 *  1. synth2's 8 step regions (896 bytes each).
 *  2. synth2's 8 pattern LENGTH bytes (byte 0 of each metadata block) — only when
 *     content is written. Without it a 32-step pattern plays its first 16 steps.
 *  3. synth2's chain slot `[start, end]` at 0x2c8 — only when content is written.
 *     Without it the track loops pattern 1 forever instead of advancing 1..8.
 *
 * ## Refusals (each one is a stop, never a retry)
 *
 *  - Bad CRC, wrong project name, non-Chromatic scale (a non-Chromatic scale
 *    re-quantizes stored notes on playback, so the target would arrive on
 *    different pitches).
 *  - Any planned note outside 0..127 after the transpose. It never wraps.
 *  - Any diff byte outside synth2's step regions / length bytes / chain slot.
 *  - Any collateral byte, any per-slot mismatch against the intended pattern, or
 *    any change to synth1 / midi1 / midi2 / tempo / name / scale / mixer levels
 *    on the independent read-back.
 *
 * Reads settle past the Circuit's 6-to-8s pack-manifest flush before the first
 * read and before every verify.
 *
 * Usage:
 *   npx tsx scripts/circuit-after-dark-synth2-square-lead.ts            # dry run
 *   npx tsx scripts/circuit-after-dark-synth2-square-lead.ts --apply
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript, exitMidiScript, reconnectMidi } from './_lib/midi-lifecycle.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import {
  decodeNotePattern, setNoteStep, clearNotePattern, MAX_MIDI_NOTE,
  DEFAULT_NOTE_VELOCITY, MAX_GATE_SIXTHS, MICROTICKS_PER_STEP, type NoteStep,
} from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  noteStepBase, noteBlockIndex, META_OFFSETS, NOTE_STEP_REGION,
  PATTERNS_PER_TRACK, STEPS_PER_PATTERN, getProjectTempo,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { SCALE_TYPE_OFFSET, SCALE_ROOT_OFFSET, SCALE_CHROMATIC, SCALE_NAMES } from '../packages/circuit-tracks/src/ncs/scale.js';
import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import { importSongsterrMelodic, type MelodicCell } from '../packages/core/src/protocol-generic/patterns/songsterr.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const devicePack = Number(flag('--pack') ?? '2');

const SONG = '501859';
const PART = 4;                       // "Lead 1 (square)" — the vocal line, per the maintainer
const DST: NoteTrack = 'synth2';
const UNTOUCHED: NoteTrack[] = ['synth1', 'midi1', 'midi2'];
/** Storage = written + 12, because the Circuit transmits 12 semitones low. */
const TRANSPOSE = 12;
const MAX_GATE_STEPS = MAX_GATE_SIXTHS / MICROTICKS_PER_STEP;   // 16
const NAME_OFF = 0x10, NAME_LEN = 0x20;
const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };

/** Shared chain table (chain.ts): 8 slots x 4 bytes at 0x2c4; synth2 = slot 1. */
const CHAIN_BASE = 0x2c4, CHAIN_STRIDE = 4;
const CHAIN_SLOT: Readonly<Record<NoteTrack, number>> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const chainOffset = (t: NoteTrack): number => CHAIN_BASE + CHAIN_SLOT[t] * CHAIN_STRIDE;

/** The song's own section markers, one project per 16-bar section (build record). */
const PROJECTS: ReadonlyArray<{ slot: number; section: string; from: number; to: number }> = [
  { slot: 1, section: 'Intro', from: 1, to: 16 },
  { slot: 2, section: "Verse 1'", from: 19, to: 34 },
  { slot: 3, section: 'Chorus 1', from: 35, to: 50 },
  { slot: 4, section: 'Verse 2', from: 51, to: 66 },
  { slot: 5, section: 'Chorus 2', from: 67, to: 82 },
  { slot: 6, section: 'Break', from: 83, to: 98 },
  { slot: 7, section: 'Bridge', from: 99, to: 114 },
  { slot: 8, section: 'Chorus 3', from: 115, to: 130 },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (p: number): string => `${NOTE_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;
const hex = (n: number): string => `0x${n.toString(16)}`;
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

const stepRegions = (t: NoteTrack): { from: number; to: number }[] =>
  Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => {
    const from = noteStepBase(t, p);
    return { from, to: from + NOTE_STEP_REGION };
  });
const lengthOffsets = (t: NoteTrack): number[] =>
  Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => META_OFFSETS[noteBlockIndex(t, p)]);

const WRITABLE = ((): Set<number> => {
  const s = new Set<number>();
  for (const r of stepRegions(DST)) for (let i = r.from; i < r.to; i++) s.add(i);
  for (const o of lengthOffsets(DST)) s.add(o);
  s.add(chainOffset(DST)); s.add(chainOffset(DST) + 1);
  return s;
})();

// ── the payload, built from the source ────────────────────────────────
/** One authored onset: where it goes and exactly what bytes it becomes. */
interface Onset { pattern: number; step: number; pitches: number[]; gate: number; tie: boolean; velocity: number }

/**
 * Lay a window's cells onto 8 x 32 steps. A gate past the 96-sixth ceiling is
 * split into tied 16-step pieces, the device's own documented drone recipe and
 * the same rule `after-dark-sections.ts` used to author the rest of this song.
 */
function layout(cells: readonly MelodicCell[]): { onsets: Onset[]; splits: string[]; clamps: string[] } {
  const onsets: Onset[] = [];
  const splits: string[] = [], clamps: string[] = [];
  const taken = new Set<number>();
  for (const c of cells) {
    const velocity = c.velocity ?? DEFAULT_NOTE_VELOCITY;
    let remaining = c.gate_sixths ?? c.duration_steps * MICROTICKS_PER_STEP;
    let at = c.step;
    const pieces: number[] = [];
    while (remaining > MAX_GATE_SIXTHS) {
      const next = at + MAX_GATE_STEPS;
      if (next >= PATTERNS_PER_TRACK * STEPS_PER_PATTERN || taken.has(next)
          || Math.floor(next / STEPS_PER_PATTERN) !== Math.floor(at / STEPS_PER_PATTERN)) break;
      onsets.push({ pattern: Math.floor(at / STEPS_PER_PATTERN), step: at % STEPS_PER_PATTERN, pitches: c.pitches, gate: MAX_GATE_SIXTHS, tie: true, velocity });
      taken.add(at);
      pieces.push(MAX_GATE_SIXTHS);
      remaining -= MAX_GATE_SIXTHS;
      at = next;
    }
    if (remaining > MAX_GATE_SIXTHS) {
      onsets.push({ pattern: Math.floor(at / STEPS_PER_PATTERN), step: at % STEPS_PER_PATTERN, pitches: c.pitches, gate: MAX_GATE_SIXTHS, tie: false, velocity });
      taken.add(at);
      clamps.push(`step ${at} ${c.token}: wanted ${remaining} sixths, no room to chain, emitted ${MAX_GATE_SIXTHS}`);
    } else {
      onsets.push({ pattern: Math.floor(at / STEPS_PER_PATTERN), step: at % STEPS_PER_PATTERN, pitches: c.pitches, gate: remaining, tie: false, velocity });
      taken.add(at);
      pieces.push(remaining);
      if (pieces.length > 1) splits.push(`step ${c.step} ${c.token}: ${pieces.join('+')} sixths (${pieces.length} pieces, ${pieces.length - 1} tie flag(s))`);
    }
  }
  return { onsets, splits, clamps };
}

interface Payload { slot: number; section: string; from: number; to: number; onsets: Onset[]; splits: string[]; clamps: string[]; written: number[] }

console.log('After Dark: SYNTH 2 (ch2) carries part 4 "Lead 1 (square)" for the WHOLE SONG');
console.log(`Pack ${devicePack}, all 8 projects. Source: Songsterr ${SONG} part ${PART}, transposed +${TRANSPOSE} for storage.`);
console.log(`  the Circuit transmits 12 semitones BELOW what it stores (measured on this card: midi1 51..65 -> wire 39..53; synth1 39..43 -> wire 27..31),`);
console.log(`  so a stored note arrives 12 low, and +${TRANSPOSE} makes the line ARRIVE at the pitch Songsterr writes, which is what he sings to`);
console.log('  ch3 is absorbed by the MicroFreak (its Input Chan); ch2 is relayed, so synth2 is the only track that reaches the VE-500');
console.log('SYNTH 2\'s PAD (and P1\'s PIANO) ARE REPLACED. That is the request: he plays those by hand.');
console.log('Synth 1, MIDI 1, MIDI 2, the drums, the tempo, the scale and the mixer levels are NOT touched.');
console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY RUN (nothing will be written)');
console.log('');

const fetched = await fetchSongsterrPart(SONG, { track: PART });
const payloads: Payload[] = [];
for (const p of PROJECTS) {
  const r = importSongsterrMelodic(fetched.part, { fromMeasure: p.from, toMeasure: p.to, stepsPerBeat: 4, transpose: TRANSPOSE });
  const cells = r.cells;
  const { onsets, splits, clamps } = layout(cells);
  const written = cells.flatMap((c) => c.pitches);
  payloads.push({ slot: p.slot, section: p.section, from: p.from, to: p.to, onsets, splits, clamps, written });
  const bad = written.filter((n) => n < 0 || n > MAX_MIDI_NOTE);
  if (bad.length > 0) { console.error(`P${p.slot}: ${bad.length} note(s) leave 0..${MAX_MIDI_NOTE} after +${TRANSPOSE}. Refusing; this script never wraps.`); process.exit(1); }
  if (r.step_count !== PATTERNS_PER_TRACK * STEPS_PER_PATTERN) {
    console.error(`P${p.slot}: window m${p.from}-${p.to} imported ${r.step_count} steps, expected ${PATTERNS_PER_TRACK * STEPS_PER_PATTERN}.`);
    process.exit(1);
  }
  const range = written.length === 0 ? '(silent — part 4 does not sound here)'
    : `stored ${Math.min(...written)}..${Math.max(...written)} (${pitchName(Math.min(...written))}..${pitchName(Math.max(...written))})`
      + `  ->  arrives ${Math.min(...written) - 12}..${Math.max(...written) - 12} (${pitchName(Math.min(...written) - 12)}..${pitchName(Math.max(...written) - 12)})`;
  console.log(`  P${p.slot} ${p.section.padEnd(9)} m${String(p.from).padStart(3)}-${String(p.to).padStart(3)}  ${String(cells.length).padStart(3)} cell(s), ${String(onsets.length).padStart(3)} onset(s)  ${range}`);
  for (const s of splits) console.log(`        TIE SPLIT  ${s}`);
  for (const s of clamps) console.log(`        CLAMP      ${s}`);
}
console.log('');
{
  const all = payloads.flatMap((p) => p.written);
  console.log(`whole song: ${all.length} note(s), stored ${Math.min(...all)}..${Math.max(...all)} (${pitchName(Math.min(...all))}..${pitchName(Math.max(...all))})`
    + ` -> arrives ${Math.min(...all) - 12}..${Math.max(...all) - 12} (${pitchName(Math.min(...all) - 12)}..${pitchName(Math.max(...all) - 12)}), which is part 4 as written`);
  const dstR = stepRegions(DST);
  for (const t of UNTOUCHED) {
    if (stepRegions(t).some((a) => dstR.some((c) => a.from < c.to && c.from < a.to))) { console.log(`  ${DST} overlaps ${t}: YES - STOP`); process.exit(1); }
  }
  console.log(`${DST} writable set: ${WRITABLE.size} of 160780 (${((WRITABLE.size / 160780) * 100).toFixed(2)}%); overlaps synth1 / midi1 / midi2: none`);
  console.log('');
}

// ── snapshots + planning ─────────────────────────────────────────────
interface Snapshot { steps: NoteStep[][]; notes: number[]; activeSteps: number; ties: number }
function snapshot(b: Uint8Array, track: NoteTrack): Snapshot {
  const steps: NoteStep[][] = [];
  const notes: number[] = [];
  let activeSteps = 0, ties = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const decoded = decodeNotePattern(b, track, p);
    steps.push(decoded);
    for (const st of decoded) {
      if (st.notes.length > 0) activeSteps++;
      for (const sl of st.notes) { notes.push(sl.note); if (sl.tie) ties++; }
    }
  }
  return { steps, notes, activeSteps, ties };
}
const rangeOf = (n: number[]): string =>
  n.length === 0 ? '(empty)' : `${Math.min(...n)}..${Math.max(...n)} (${pitchName(Math.min(...n))}..${pitchName(Math.max(...n))})`;

/** Compare a decoded synth2 against the payload, per step and per note slot. */
function checkAgainstPayload(snap: Snapshot, pay: Payload): string[] {
  const bad: string[] = [];
  const want = new Map<string, Onset>();
  for (const o of pay.onsets) want.set(`${o.pattern}:${o.step}`, o);
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      const got = snap.steps[p][s];
      const o = want.get(`${p}:${s}`);
      if (o === undefined) { if (got.notes.length > 0) bad.push(`p${p + 1}s${s}: expected a rest, found ${got.notes.length} note(s)`); continue; }
      if (got.notes.length !== o.pitches.length) { bad.push(`p${p + 1}s${s}: ${got.notes.length} note(s), payload has ${o.pitches.length}`); continue; }
      for (let i = 0; i < o.pitches.length; i++) {
        const v = got.notes[i];
        if (v.note !== o.pitches[i]) bad.push(`p${p + 1}s${s}n${i}: note ${v.note} != ${o.pitches[i]}`);
        if (v.gate !== o.gate) bad.push(`p${p + 1}s${s}n${i}: gate ${v.gate} != ${o.gate}`);
        if (v.tie !== o.tie) bad.push(`p${p + 1}s${s}n${i}: tie ${v.tie} != ${o.tie}`);
        if (v.velocity !== o.velocity) bad.push(`p${p + 1}s${s}n${i}: velocity ${v.velocity} != ${o.velocity}`);
      }
    }
  }
  return bad;
}

interface Plan { after: Uint8Array; edits: number[]; refusal?: string }
function planWrite(before: Uint8Array, pay: Payload): Plan {
  const after = new Uint8Array(before);
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) clearNotePattern(after, DST, p);
  for (const o of pay.onsets) {
    setNoteStep(after, DST, o.pattern, o.step, o.pitches.map((n) => ({ note: n, gate: o.gate, tie: o.tie, velocity: o.velocity })));
  }
  if (pay.onsets.length > 0) {
    for (const off of lengthOffsets(DST)) after[off] = STEPS_PER_PATTERN - 1;
    after[chainOffset(DST)] = 0;
    after[chainOffset(DST) + 1] = PATTERNS_PER_TRACK - 1;
  }
  const edits: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!WRITABLE.has(i)) return { after, edits, refusal: `planned edit at ${hex(i)} is outside ${DST}'s step regions / length bytes / chain slot.` };
    edits.push(i);
  }
  return { after, edits };
}

// ── DEVICE ───────────────────────────────────────────────────────────
let conn = connect(CONNECT);
const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 9_000, POLL_MS = 5_000, MAX_POLLS = 6;

const readStable = async (slot: number, label: string): Promise<Awaited<ReturnType<typeof downloadProject>>> => {
  let last = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  for (let i = 1; i <= MAX_POLLS && (!last.ok || !last.crcOk || last.bytes === undefined); i++) {
    console.log(`      ${label}: read ${i} came back ok=${last.ok} crcOk=${last.crcOk}; waiting ${POLL_MS / 1000}s and retrying (manifest flush, not a failure)`);
    await sleep(POLL_MS);
    last = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
  }
  return last;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = `samples/circuit-ncs/restore-afterdark-synth2-square-${stamp}`;
if (APPLY) mkdirSync(backupDir, { recursive: true });

console.log(`settling ${SETTLE_MS / 1000}s for the pack-manifest flush before the first read...`);
await sleep(SETTLE_MS);

let written = 0, unchanged = 0;
const backups: string[] = [];
for (const pay of payloads) {
  const slot = pay.slot, tag = `P${slot}`;
  const r = await readStable(slot, tag);
  if (!r.ok || !r.crcOk || r.bytes === undefined) {
    console.log(`  ${tag}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}. Unreadable is a refusal.`);
    console.log(`\nFAIL-STOP after ${written} write(s). Projects from ${slot} on are UNTOUCHED.`);
    exitMidiScript(1);
  }
  const before = r.bytes;
  const nm = nameOf(before);
  if (nm !== `AfterDark P${slot}`) {
    console.log(`  ${tag}  REFUSED: name is "${nm}", expected "AfterDark P${slot}".`);
    exitMidiScript(1);
  }
  const scale = before[SCALE_TYPE_OFFSET];
  if (scale !== SCALE_CHROMATIC) {
    console.log(`  ${tag}  REFUSED: scale is ${scale} (${SCALE_NAMES[scale] ?? '?'}), not Chromatic; stored notes would be re-quantized on playback.`);
    exitMidiScript(1);
  }
  const was = snapshot(before, DST);
  console.log(`  ${tag}  "${nm}"  ${pay.section}  CRC ok  tempo ${getProjectTempo(before)} BPM  scale Chromatic  mixer synth1=${before[MIXER_SYNTH1_LEVEL]} synth2=${before[MIXER_SYNTH2_LEVEL]}`);
  console.log(`        ${DST} BEFORE ${String(was.notes.length).padStart(3)} notes ${rangeOf(was.notes)} over ${was.activeSteps} step(s), ${was.ties} tied`);

  const plan = planWrite(before, pay);
  if (plan.refusal !== undefined) { console.log(`        REFUSED: ${plan.refusal}`); exitMidiScript(1); }
  const planned = snapshot(plan.after, DST);
  const mismatch = checkAgainstPayload(planned, pay);
  if (mismatch.length > 0) {
    console.log(`        REFUSED: planned buffer differs from the payload in ${mismatch.length} place(s): ${mismatch.slice(0, 4).join('; ')}`);
    exitMidiScript(1);
  }
  console.log(`        ${DST} AFTER  ${String(planned.notes.length).padStart(3)} notes ${rangeOf(planned.notes)} over ${planned.activeSteps} step(s), ${planned.ties} tied`
    + `${pay.onsets.length === 0 ? '   <- CLEARED: part 4 is silent here, he plays this section by hand' : ''}`);
  if (plan.edits.length === 0) { console.log('        already exactly this; nothing to write.'); unchanged++; continue; }
  console.log(`        plan: ${plan.edits.length} byte(s)${pay.onsets.length > 0 ? `; lengths -> 32 steps; chain [0,${PATTERNS_PER_TRACK - 1}]` : '; lengths and chain left alone (empty track)'}`);

  if (!APPLY) continue;

  const backup = `${backupDir}/pack${devicePack}-proj${String(slot).padStart(2, '0')}.ncs`;
  if (existsSync(backup)) { console.log(`        REFUSED: backup ${backup} already exists.`); exitMidiScript(1); }
  writeFileSync(backup, before);
  backups.push(backup);
  console.log(`        backup: ${backup} (${before.length} bytes, full pre-edit project incl. the displaced pad/piano)`);

  const up = await uploadProject(conn, plan.after, slot - 1, { pack: devicePack - 1, reconnect });
  if (!up.ok) {
    console.log(`        UPLOAD FAILED: ${up.error ?? 'unknown'}. Original at ${backup}`);
    console.log(`\nFAIL-STOP after ${written} write(s).`);
    exitMidiScript(1);
  }

  console.log(`        settling ${SETTLE_MS / 1000}s past the manifest-flush window before the independent read-back...`);
  await sleep(SETTLE_MS);
  const v = await readStable(slot, `${tag} verify`);
  if (!v.ok || !v.crcOk || v.bytes === undefined) { console.log(`        VERIFY READ FAILED (ok=${v.ok} crcOk=${v.crcOk}). Original at ${backup}`); exitMidiScript(1); }
  const got = v.bytes;
  const intended = new Set(plan.edits);
  const wrong: string[] = [], collateral: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (intended.has(i)) { if (got[i] !== plan.after[i]) wrong.push(`${hex(i)}=${got[i]} (wanted ${plan.after[i]})`); }
    else if (got[i] !== before[i]) collateral.push(i);
  }
  const back = snapshot(got, DST);
  const backBad = checkAgainstPayload(back, pay);
  const others: string[] = [];
  for (const t of UNTOUCHED) {
    let diff = 0;
    for (const rr of stepRegions(t)) for (let i = rr.from; i < rr.to; i++) if (got[i] !== before[i]) diff++;
    others.push(`${t} ${diff === 0 ? 'identical' : `${diff} BYTES CHANGED`}`);
  }
  const nameBack = nameOf(got), tempoBack = getProjectTempo(got);
  const mixOk = got[MIXER_SYNTH1_LEVEL] === before[MIXER_SYNTH1_LEVEL] && got[MIXER_SYNTH2_LEVEL] === before[MIXER_SYNTH2_LEVEL];
  const scaleOk = got[SCALE_TYPE_OFFSET] === before[SCALE_TYPE_OFFSET] && got[SCALE_ROOT_OFFSET] === before[SCALE_ROOT_OFFSET];
  console.log(`        read-back: ${plan.edits.length - wrong.length}/${plan.edits.length} intended byte(s) landed, collateral ${collateral.length}`);
  console.log(`                   ${DST} ${back.notes.length} notes ${rangeOf(back.notes)}, ${back.ties} tied, ${back.activeSteps} step(s); vs payload: ${backBad.length === 0 ? 'IDENTICAL per slot' : backBad.slice(0, 4).join('; ')}`);
  console.log(`                   ${others.join(' | ')}  |  name "${nameBack}"  tempo ${tempoBack}  scale ${SCALE_NAMES[got[SCALE_TYPE_OFFSET]] ?? '?'}  mixer synth1=${got[MIXER_SYNTH1_LEVEL]} synth2=${got[MIXER_SYNTH2_LEVEL]}`);
  if (wrong.length > 0 || collateral.length > 0 || backBad.length > 0 || nameBack !== nm
      || tempoBack !== getProjectTempo(before) || !mixOk || !scaleOk) {
    console.log(`        VERIFY FAILED: ${wrong.length} wrong (${wrong.slice(0, 4).join(', ')}), collateral at ${collateral.slice(0, 6).map(hex).join(', ')}`);
    console.log(`        restore with ${backup}`);
    exitMidiScript(1);
  }
  console.log(`        PASS: ${plan.edits.length} byte(s) of ${before.length} changed, all inside ${DST}, ZERO collateral.`);
  written++;
  await sleep(400);
}

console.log('');
console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${written} project(s) written, ${unchanged} already correct.`);
if (APPLY && backups.length > 0) {
  console.log('restore points (each holds the displaced pad / piano):');
  for (const p of backups) console.log(`  ${p}`);
}
endMidiScript(0);
