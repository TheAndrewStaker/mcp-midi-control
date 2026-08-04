/**
 * circuit-metre-test-b.ts — DIFFERENT LENGTHS ON DIFFERENT TRACKS. PASSED.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RESULT: PASS, confirmed by ear on the maintainer's device 2026-07-29.
 * "I can confirm all six events fired as expected with your click and what
 * table you showed me." Two tracks holding DIFFERENT pattern lengths at the
 * same time advance INDEPENDENTLY (the four single events) and do NOT drift
 * (the two doubled events, holding across cycles). With Test A this settles
 * that the Circuit honours per-pattern lengths per track and mixed metre is
 * fully expressible. Full write-up: HARDWARE-TASKS-CIRCUIT.md HW-CIRCUIT-009.
 *
 * The `--apply` gate below stays as written. It required `--test-a-passed` on
 * purpose: one test at a time, so a result can never be attributed to the wrong
 * project. Keep it if this script is ever adapted for a new question.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHAT A ANSWERED, AND WHAT IT DID NOT. Test A puts the SAME four lengths on
 * both tracks, so it asks two things: does a chained pattern advance on its own
 * length, and do two tracks agree while doing it. It cannot tell whether the
 * tracks are genuinely independent, because on that project a common boundary
 * and four independent boundaries look identical. That is the whole reason this
 * second script exists, and it is worth keeping legible: a test where every
 * participant agrees cannot distinguish "each is independent" from "all are
 * forced onto one".
 *
 * THE QUESTION HERE, NOW ANSWERED YES. Do two tracks hold DIFFERENT length sets
 * at the same time?
 * Drums 1 runs 24, 24, 30, 18 while Synth 1 runs 18, 30, 24, 24 — the same four
 * numbers reversed, so both tracks total 96 steps and must re-meet at the top of
 * every 24 s cycle if they are independent. Schism needs this the moment a 4/4
 * part sits under a 7/8 part.
 *
 * THE TIMELINE at 60 bpm (a step is 250 ms, a quarter is 1.000 s, so the
 * device's own click ticks once a second):
 *
 *     seconds   0.0   4.5   6.0   12.0   18.0   19.5   24.0
 *     click      1    5-and  7     13     19     20-and  25(=1)
 *     drums     HIT          HIT   HIT           HIT    HIT
 *     synth     HIT   HIT          HIT    HIT           HIT
 *
 * CLICKS, NOT SECONDS, are what the maintainer is asked to count: Test A's
 * feedback was that the click count is countable by ear and the seconds are not.
 * `listeningInstructions()` below is the rig-facing wording and the script prints
 * it after a clean read-back.
 *
 *   PASS  six events per cycle in that order: TOGETHER, synth alone, drum alone,
 *         TOGETHER, synth alone, drum alone — and the two TOGETHER events stay
 *         together cycle after cycle. In click terms: both on click 1; synth
 *         between clicks 5 and 6; drum on click 7; both on click 13; synth on
 *         click 19; drum between clicks 20 and 21; both again on click 25.
 *
 *   FAIL 1  every hit is a doublet, four per cycle at 0 / 6 / 12 / 19.5 s. The
 *           synth is following the DRUM's boundaries: the device forces one
 *           common pattern boundary and per-track lengths are cosmetic. A 4/4
 *           part cannot be run against a 7/8 part.
 *   FAIL 2  extra hits inside the gaps. A pattern wrapped to its own step 0 and
 *           kept playing to 32 before advancing. (Test A would already have
 *           shown this; seeing it only here would mean the wrap depends on the
 *           tracks disagreeing.)
 *   FAIL 3  the two TOGETHER events drift apart over successive cycles. The
 *           tracks free-run with no shared re-sync. This is the worst answer:
 *           worse than FAIL 1, because a locked-together device is at least
 *           predictable, and a drifting one cannot host mixed metre at all.
 *
 * WHY THIS ONE CANNOT GO THROUGH `apply_pattern`. `authorArrangementIntoProject`
 * writes ONE length byte per pattern SLOT across every track it touches — that
 * is the shipped invariant, and it is the right one for songs, where a bar line
 * is a bar line for everybody. Test B deliberately breaks it, so it builds the
 * project buffer from the same shipped `ncs/*` primitives the writer uses
 * (setDrumPattern / setNotePattern / setDrumChain / setNoteChain /
 * setProjectScale / setDrumSampleBinding + the per-track meta length byte) and
 * ships it with `uploadProject`. Because that path has no overwrite gate of its
 * own, this script carries an EXPLICIT one: the target pack's project directory
 * is read TWICE, more than 9 s apart (the device flushes a pack manifest 6-8 s
 * after a session closes), and an occupied or disagreeing listing is a refusal.
 * There is no delete on this device.
 *
 * TWO THINGS THE SCRIPT AUTHORS SO THE RIG DOES NOT HAVE TO. The project's stored
 * TEMPO byte is written to 60 (a blank template carries the device's default 120,
 * and loading a project applies its stored tempo, so an unwritten byte plays the
 * test at double speed and 125 ms a step is not countable). And Drum 1's sample
 * binding is resolved against the pack's REAL pool at write time rather than
 * assumed, because a drum track pointed at an empty slot is silent and a silent
 * Drum 1 makes the whole test unreadable. Both were learned from Test A.
 *
 * Usage:
 *   npx tsx scripts/circuit-metre-test-b.ts                          # survey + build, writes nothing
 *   npx tsx scripts/circuit-metre-test-b.ts --apply --test-a-passed  # author (only after A)
 *   npx tsx scripts/circuit-metre-test-b.ts --apply --test-a-passed --drum1-slot 5
 *   npx tsx scripts/circuit-metre-test-b.ts --verify-only            # read-only re-check, writes nothing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeAllMidiConnections } from '../packages/core/src/midi/transport.js';
import { ensureConnection } from '../packages/core/src/server-shared/connections.js';
import { endMidiScript, exitMidiScript } from './_lib/midi-lifecycle.js';
import { readProjectDirectory, readSampleDirectory } from '../packages/circuit-tracks/src/ncs/sampleDirectory.js';
import { downloadProject, uploadProject } from '../packages/circuit-tracks/src/ncs/uploadProject.js';
import { setDrumPattern, decodeDrumPattern } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { setNotePattern, decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { setDrumChain, setNoteChain, getNoteChain } from '../packages/circuit-tracks/src/ncs/chain.js';
import { setDrumSampleBinding, DEFAULT_DRUM_BINDING, DRUM_BINDING_OFFSET } from '../packages/circuit-tracks/src/ncs/drumBinding.js';
import { setProjectScale, SCALE_CHROMATIC, SCALE_TYPE_OFFSET } from '../packages/circuit-tracks/src/ncs/scale.js';
import {
  META_OFFSETS, STEPS_PER_PATTERN, drumBlockIndex, noteBlockIndex,
  setProjectTempo, PROJECT_TEMPO_OFFSET,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1]; };
const APPLY = argv.includes('--apply');
const A_PASSED = argv.includes('--test-a-passed');
/**
 * Read the authored project back WITHOUT writing anything, and run the same
 * assertions. The write path's own read-back happens ~1.5 s after the upload,
 * which is INSIDE the 6-8 s window in which the device flushes its pack
 * manifest, so it can only prove the transfer round-tripped, not that the card
 * committed. Run this a minute later, from a fresh process and a fresh port
 * open, and the evidence is independent of the write session.
 */
const VERIFY_ONLY = argv.includes('--verify-only');
const devicePack = Number(flag('--pack') ?? '3');
const SLOT = Number(flag('--slot') ?? '2');            // DEVICE numbering; Project 1 holds Test A
const wirePack = devicePack - 1;

/** The same four numbers, one track forwards and one backwards. Both total 96 steps. */
const DRUM_LENGTHS = [24, 24, 30, 18] as const;
const SYNTH_LENGTHS = [18, 30, 24, 24] as const;
const BPM = 60;
const PROJECT_NAME = 'MetreTest B';
const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const NAME_OFF = 0x10;
const NAME_LEN = 0x20;
const SYNTH_NOTE_MIDI = 60;      // c4, same as Test A
const SYNTH_GATE_SIXTHS = 12;    // 2 steps = 500 ms at 60 bpm
const DRUM_VELOCITY = 110;
const DRUM_TRACK = 0;
const NOTE_TRACK = 'synth1' as const;
const CHAIN_SYNTH1 = 0x2c4;
const CHAIN_DRUM1 = 0x2d4;
/** Where Test A put the sidestick, and where DEFAULT_DRUM_BINDING points Drum 1. */
const SIDESTICK_WIRE_SLOT = 0;
/**
 * A drum track bound to an EMPTY pool slot is silent, and a silent Drum 1 turns
 * this test into "I heard the synth four times", which answers nothing. So the
 * binding is resolved against the pack's REAL pool at write time rather than
 * assumed: `--drum1-slot N` overrides, otherwise a short dry hit is preferred by
 * name, then slot 1, and an empty pool is a refusal. The pool matters more here
 * than on a normal project because Pack 3 is the disposable test pack and holds
 * almost nothing — and the one thing it did hold before Test A was a 2.3 s hat
 * crescendo whose peak is at its END, which is unusable for judging an onset.
 */
const SHORT_DRY_HIT = /sidestick|side_stick|sidestk|rim|click|stick/i;

const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d\d\dZ$/, 'Z');
const ARTIFACTS = flag('--out') ?? `samples/circuit-ncs/metre-test-b-${STAMP}`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(NAME_OFF, NAME_OFF + NAME_LEN)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function nameBytes(name: string): number[] {
  if (name.length > 16) throw new Error(`name "${name}" is ${name.length} chars; keep it <=16`);
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`name "${name}" has non-printable-ASCII characters`);
  return Array.from({ length: NAME_LEN }, (_, i) => (i < name.length ? name.charCodeAt(i) : 0x20));
}

/** Cumulative onset times, in quarter notes, for one track's chained lengths. */
const onsetQuarters = (lengths: readonly number[]): number[] => {
  let acc = 0;
  return lengths.map((s) => { const at = acc / 4; acc += s; return at; });
};

function buildProject(drum1Slot: number): Uint8Array {
  const buf = new Uint8Array(readFileSync(TEMPLATE));
  const want = nameBytes(PROJECT_NAME);
  for (let i = 0; i < NAME_LEN; i++) buf[NAME_OFF + i] = want[i];

  // The blank template carries the device's default 120. Loading a project
  // APPLIES its stored tempo, so leaving this alone would play the test at
  // double speed with nothing in the receipt to say so — and a step would be
  // 125 ms, which is not countable against the click. Test A had to be
  // corrected on the card after the fact for exactly this; author it up front.
  const prevBpm = setProjectTempo(buf, BPM);
  if (prevBpm !== BPM) console.log(`   tempo ${prevBpm} -> ${BPM} bpm (template default displaced, deliberately)`);

  for (let p = 0; p < 4; p++) {
    // One hit on step 0, silence everywhere else. The pattern DATA is always 32
    // steps wide; the length byte is what truncates playback, so the same
    // content is correct for whatever length that track's slot carries.
    setDrumPattern(buf, DRUM_TRACK, p, Array.from({ length: STEPS_PER_PATTERN }, (_, s) =>
      ({ active: s === 0, velocity: s === 0 ? DRUM_VELOCITY : 0 })));
    setNotePattern(buf, NOTE_TRACK, p, Array.from({ length: STEPS_PER_PATTERN }, (_, s) =>
      (s === 0 ? [{ note: SYNTH_NOTE_MIDI, velocity: DRUM_VELOCITY, gate: SYNTH_GATE_SIXTHS }] : undefined)));
    // THE POINT OF THIS TEST: per-track length bytes that disagree.
    buf[META_OFFSETS[drumBlockIndex(DRUM_TRACK, p)]] = DRUM_LENGTHS[p] - 1;
    buf[META_OFFSETS[noteBlockIndex(NOTE_TRACK, p)]] = SYNTH_LENGTHS[p] - 1;
  }
  setDrumChain(buf, { start: 0, end: 3 });
  setNoteChain(buf, NOTE_TRACK, { start: 0, end: 3 });
  // Drum 1 gets the slot that was proven occupied; 2..4 keep the canonical
  // binding and are silent anyway (no pattern targets them).
  setDrumSampleBinding(buf, [drum1Slot, ...DEFAULT_DRUM_BINDING.slice(1)]);
  setProjectScale(buf, SCALE_CHROMATIC);
  return buf;
}

/** Every assertion the authored project must satisfy. Shared by the write path and `--verify-only`. */
function assertAuthored(b: Uint8Array, expectDrum1Slot: number, drum1Name: string): string[] {
  const fails: string[] = [];
  const check = (ok: boolean, label: string): void => { console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fails.push(label); };
  check(nameOf(b) === PROJECT_NAME, `project name == "${PROJECT_NAME}"`);
  const dLens = [0, 1, 2, 3].map((p) => b[META_OFFSETS[drumBlockIndex(DRUM_TRACK, p)]]);
  const sLens = [0, 1, 2, 3].map((p) => b[META_OFFSETS[noteBlockIndex(NOTE_TRACK, p)]]);
  check(dLens.every((v, i) => v === DRUM_LENGTHS[i] - 1), `Drum 1 length bytes [${dLens.join(', ')}] == [${DRUM_LENGTHS.map((s) => s - 1).join(', ')}]`);
  check(sLens.every((v, i) => v === SYNTH_LENGTHS[i] - 1), `Synth 1 length bytes [${sLens.join(', ')}] == [${SYNTH_LENGTHS.map((s) => s - 1).join(', ')}]`);
  check(dLens.some((v, i) => v !== sLens[i]), 'the two tracks really do hold DIFFERENT length bytes (this is the whole test)');
  for (let p = 0; p < 4; p++) {
    const d = decodeDrumPattern(b, DRUM_TRACK, p).map((s, i) => (s.active ? i : -1)).filter((i) => i >= 0);
    const n = decodeNotePattern(b, NOTE_TRACK, p).map((s, i) => (s.notes.length > 0 ? i : -1)).filter((i) => i >= 0);
    check(d.length === 1 && d[0] === 0 && n.length === 1 && n[0] === 0, `pattern ${p + 1}: drum hits [${d.join(', ')}], synth hits [${n.join(', ')}], both == [0]`);
  }
  const nc = getNoteChain(b, NOTE_TRACK);
  check(b[CHAIN_SYNTH1] === 0 && b[CHAIN_SYNTH1 + 1] === 3, `Synth 1 chain [${b[CHAIN_SYNTH1]}, ${b[CHAIN_SYNTH1 + 1]}] == [0, 3] (decoder ${nc ? `[${nc.start}, ${nc.end}]` : 'unchained'})`);
  check(b[CHAIN_DRUM1] === 0 && b[CHAIN_DRUM1 + 1] === 3, `Drum 1 chain [${b[CHAIN_DRUM1]}, ${b[CHAIN_DRUM1 + 1]}] == [0, 3]`);
  check(b[DRUM_BINDING_OFFSET] === expectDrum1Slot, `Drum 1 sample binding = ${b[DRUM_BINDING_OFFSET]} (pack sample ${b[DRUM_BINDING_OFFSET] + 1} = "${drum1Name}")`);
  check(b[SCALE_TYPE_OFFSET] === SCALE_CHROMATIC, `project scale == Chromatic (${SCALE_CHROMATIC})`);
  check(b[PROJECT_TEMPO_OFFSET] === BPM, `project tempo byte 0x34 = ${b[PROJECT_TEMPO_OFFSET]} == ${BPM} bpm (so nothing has to be dialled at the rig)`);
  return fails;
}

/** What Drum 1 should point at on THIS pack, or undefined if nothing can sound. */
function resolveDrum1Slot(
  pool: { slots: { slot: number; device_slot: number; name?: string }[] },
): { slot: number; name: string } | undefined {
  const occupied = pool.slots.filter((s): s is typeof s & { name: string } => s.name !== undefined);
  if (occupied.length === 0) return undefined;
  return occupied.find((s) => SHORT_DRY_HIT.test(s.name))
    ?? occupied.find((s) => s.slot === SIDESTICK_WIRE_SLOT)
    ?? undefined;
}

/**
 * What he listens for, in CLICKS. Test A's feedback was that the click count is
 * countable and the seconds are not, so seconds appear here only as a gloss.
 * At 60 bpm the device's quarter-note click ticks once a second, click 1 is the
 * top of the cycle, and the cycle is 24 clicks long.
 */
function listeningInstructions(drum1: string): string {
  return [
    '',
    '─── WHAT TO DO AT THE RIG ────────────────────────────────────────────────',
    `Load Pack ${devicePack}, Project ${SLOT} ("${PROJECT_NAME}"). It is already at ${BPM} bpm, so`,
    'nothing needs dialling. Turn the metronome/click ON — at 60 bpm it ticks once',
    'a second and that tick is the ruler for the whole test. Raise the Drum 1 and',
    `Synth 1 faders. Drum 1 plays "${drum1}"; Synth 1 plays one short middle-C note.`,
    'Press Play and let it run at least three full cycles before judging anything.',
    '',
    'A cycle is 24 clicks long. Count clicks out loud from the downbeat.',
    '',
    '─── PASS sounds like this ────────────────────────────────────────────────',
    '   click  1   BOTH together   (drum + synth, one sound)',
    '   click  5-and    SYNTH ALONE, exactly BETWEEN clicks 5 and 6',
    '   click  7   DRUM ALONE',
    '   click 13   BOTH together',
    '   click 19   SYNTH ALONE',
    '   click 20-and   DRUM ALONE, exactly BETWEEN clicks 20 and 21',
    '   click 25 = click 1 of the next cycle, BOTH together again, and it repeats.',
    '',
    'Six events per cycle. Two doubled, four single. The two DOUBLED ones are the',
    'whole test: they must stay glued together, cycle after cycle, for as long as',
    'you let it run. If they are still exactly together after three or four cycles,',
    'that is the pass.',
    '',
    '─── The two FAILURES, and how to tell them apart ─────────────────────────',
    'FAIL 1, "everything is doubled": you hear only FOUR events per cycle and every',
    '   one of them is drum-and-synth together. No single-instrument hits at all.',
    '   That means the synth is being dragged onto the drum track\'s boundaries: the',
    '   device enforces ONE common pattern boundary and per-track lengths are',
    '   cosmetic once the tracks disagree.',
    'FAIL 2, "drift": you get the six events, but over three or four cycles the two',
    '   DOUBLED ones stop being doubled — they smear into a flam and then into two',
    '   separate hits. The tracks are free-running with no shared re-sync.',
    'FAIL 3, "extra hits": a hit appears inside a gap where the list above has',
    '   nothing. A pattern wrapped to its own step 0 and kept playing before',
    '   advancing. Test A should already have ruled this out; seeing it only here',
    '   would mean the wrap depends on the two tracks disagreeing.',
    '',
    '─── WHAT THE ANSWER MEANS FOR SCHISM ─────────────────────────────────────',
    'PASS: the two tracks hold different bar lengths at the same time, so a 4/4',
    '   part can sit under a 7/8 part. Schism is authorable exactly as designed —',
    '   all 19 sections, including the 11 that need genuinely mixed chains across',
    '   150 bars — and the same unlocks Pneuma and the metre-aware splitter.',
    'FAIL 1 or FAIL 3: mixed chains ACROSS tracks are not available. The fallback',
    '   is to force every track in a project onto ONE common length per pattern',
    '   slot (which is what the shipped arrangement writer already does), so a',
    '   section can still change metre from pattern to pattern but every track has',
    '   to change with it. The cost: the 8 sections that are uniform survive',
    '   untouched, and the 11 mixed ones must each be re-cut so the parts share a',
    '   bar line — either by splitting into more projects, or by padding the',
    '   simpler part with rests until it lines up. More than half the song changes',
    '   shape, and the project count goes up from 18.',
    'FAIL 2: worse than FAIL 1. A locked-together device is at least predictable',
    '   and can be authored around; a drifting one cannot host mixed metre at all,',
    '   and the fallback becomes one length for the WHOLE project, not per slot.',
    '',
    'Report back: how many events per cycle, whether the two doubled ones stayed',
    'doubled after three or four cycles, and any hit that fell where the list above',
    'says there should be silence.',
    '──────────────────────────────────────────────────────────────────────────',
  ].join('\n');
}

/** Read-only: confirm what the card actually holds, from a fresh process. Writes nothing. */
async function verifyOnly(): Promise<void> {
  console.log(`VERIFY ONLY (read-only). Pack ${devicePack}, Project ${SLOT}. Nothing will be written.\n`);
  const reconnect = (): ReturnType<typeof ensureConnection> => ensureConnection('circuit', true);
  const dir = await readProjectDirectory(ensureConnection('circuit'), wirePack);
  console.log(`Pack ${devicePack} project directory: ${dir.occupied} of ${dir.total} occupied`);
  for (const s of dir.slots.filter((s) => s.name !== undefined)) console.log(`      project ${String(s.device_slot).padStart(2)}  "${s.name}"`);

  const pool = await readSampleDirectory(ensureConnection('circuit'), wirePack);
  const dl = await downloadProject(ensureConnection('circuit'), SLOT - 1, { pack: wirePack, reconnect });
  if (!dl.ok || !dl.crcOk || dl.bytes === undefined) {
    console.log(`READ FAILED (ok=${dl.ok} crcOk=${dl.crcOk} empty=${dl.empty}).`);
    exitMidiScript(1);
  }
  const b = dl.bytes;
  const bound = b[DRUM_BINDING_OFFSET];
  const boundName = pool.slots.find((s) => s.slot === bound)?.name;
  console.log(`\nread: ${b.length} bytes, CRC ok, name "${nameOf(b)}"`);
  const fails = assertAuthored(b, bound, boundName ?? '(EMPTY SLOT)');
  if (boundName === undefined) {
    console.log('   FAIL Drum 1 points at an EMPTY pool slot, so it will be silent');
    fails.push('drum 1 bound to an empty pool slot');
  } else {
    console.log(`   OK   Drum 1's bound slot really holds a sample ("${boundName}")`);
  }
  console.log(fails.length === 0
    ? `\nVERIFY VERDICT: PASS. The card holds Test B as authored, read from a fresh process well past the manifest-flush window.`
    : `\nVERIFY VERDICT: FAIL on ${fails.length} check(s).`);
  if (fails.length === 0) console.log(listeningInstructions(boundName ?? ''));
  endMidiScript(fails.length === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (VERIFY_ONLY) { await verifyOnly(); return; }
  console.log(`Metre test B  ->  Pack ${devicePack}, Project ${SLOT}   drums [${DRUM_LENGTHS.join(', ')}]  synth [${SYNTH_LENGTHS.join(', ')}]  chain 0..3  ${BPM} bpm`);
  console.log(APPLY && A_PASSED ? 'MODE: APPLY' : 'MODE: BUILD ONLY (nothing will be written)');
  if (APPLY && !A_PASSED) {
    console.log('\nREFUSED: --apply needs --test-a-passed as well. Run Test A, listen to it, write down the answer, THEN come back.');
    process.exitCode = 1;
    return;
  }
  console.log(`artifacts: ${ARTIFACTS}\n`);
  if (!existsSync(TEMPLATE)) { console.log(`REFUSED: template ${TEMPLATE} is missing.`); exitMidiScript(1); }
  mkdirSync(ARTIFACTS, { recursive: true });

  const dq = onsetQuarters(DRUM_LENGTHS);
  const sq = onsetQuarters(SYNTH_LENGTHS);
  const cycle = DRUM_LENGTHS.reduce((a, b) => a + b, 0) / 4;
  if (SYNTH_LENGTHS.reduce((a, b) => a + b, 0) / 4 !== cycle) {
    console.log('REFUSED: the two length sets do not total the same number of steps, so the tracks never re-meet and FAIL 3 becomes unfalsifiable.');
    exitMidiScript(1);
  }
  console.log(`at ${BPM} bpm, one quarter = 1.000 s and the click ticks once a second. Cycle ${cycle.toFixed(1)} s.`);
  console.log(`   drums hit at  ${dq.map((q) => q.toFixed(1)).join(' / ')} s`);
  console.log(`   synth hits at ${sq.map((q) => q.toFixed(1)).join(' / ')} s`);
  const together = dq.filter((q) => sq.includes(q));
  console.log(`   they coincide at ${together.map((q) => q.toFixed(1)).join(' and ')} s; everything else is one track alone.`);

  const localPath = join(ARTIFACTS, 'MetreTestB.ncs');
  const describe = (buf: Uint8Array): void => {
    console.log(`\nbuilt "${nameOf(buf)}" -> ${localPath}`);
    console.log(`   tempo byte 0x34 = ${buf[PROJECT_TEMPO_OFFSET]} bpm`);
    console.log(`   Drum 1 length bytes  [${[0, 1, 2, 3].map((p) => buf[META_OFFSETS[drumBlockIndex(DRUM_TRACK, p)]]).join(', ')}]`);
    console.log(`   Synth 1 length bytes [${[0, 1, 2, 3].map((p) => buf[META_OFFSETS[noteBlockIndex(NOTE_TRACK, p)]]).join(', ')}]`);
    console.log(`   chains: synth1 0x2c4=[${buf[CHAIN_SYNTH1]}, ${buf[CHAIN_SYNTH1 + 1]}]  drum1 0x2d4=[${buf[CHAIN_DRUM1]}, ${buf[CHAIN_DRUM1 + 1]}]`);
    console.log(`   drum binding 0x1a278 = [${[...buf.slice(DRUM_BINDING_OFFSET, DRUM_BINDING_OFFSET + 4)].join(', ')}]`);
  };

  if (!(APPLY && A_PASSED)) {
    // No port is opened in this mode, so the pool cannot be consulted; preview
    // against the slot Test A used and say so.
    const preview = buildProject(SIDESTICK_WIRE_SLOT);
    writeFileSync(localPath, preview);
    describe(preview);
    console.log(`   (preview only: Drum 1 assumed at pack sample ${SIDESTICK_WIRE_SLOT + 1}; --apply resolves it against the pack's real pool)`);
    console.log('\nBUILD ONLY. Nothing was sent, no port was opened. Re-run with --apply --test-a-passed once Test A has an answer.');
    return;
  }

  // ── Explicit overwrite gate, twice, past the manifest-flush window ────
  const conn = ensureConnection('circuit');
  const reconnect = (): ReturnType<typeof ensureConnection> => ensureConnection('circuit', true);

  const dir1 = await readProjectDirectory(conn, wirePack);
  console.log(`\nPack ${devicePack} project directory, read 1: ${dir1.occupied} of ${dir1.total} occupied`);
  for (const s of dir1.slots.filter((s) => s.name !== undefined)) console.log(`      project ${String(s.device_slot).padStart(2)}  "${s.name}"`);
  console.log('   waiting 10 s past the manifest-flush window, then re-reading');
  await sleep(10_000);
  const dir2 = await readProjectDirectory(ensureConnection('circuit'), wirePack);
  console.log(`Pack ${devicePack} project directory, read 2: ${dir2.occupied} of ${dir2.total} occupied`);

  const occ1 = new Map(dir1.slots.filter((s) => s.name !== undefined).map((s) => [s.device_slot, s.name!]));
  const occ2 = new Map(dir2.slots.filter((s) => s.name !== undefined).map((s) => [s.device_slot, s.name!]));
  if (occ1.size !== dir1.occupied || occ2.size !== dir2.occupied
    || occ1.size !== occ2.size || [...occ1.keys()].some((k) => !occ2.has(k))) {
    console.log('REFUSED: the directory reads disagree with themselves or each other. Unreadable is a refusal.');
    exitMidiScript(1);
  }
  if (occ1.has(SLOT)) {
    console.log(`REFUSED: Pack ${devicePack} Project ${SLOT} holds "${occ1.get(SLOT)}". There is no delete on this device; pick an empty slot.`);
    exitMidiScript(1);
  }
  const pre = await downloadProject(ensureConnection('circuit'), SLOT - 1, { pack: wirePack, reconnect });
  if (pre.empty !== true) {
    if (pre.ok && pre.bytes) {
      const p = join(ARTIFACTS, `pre-write-pack${devicePack}-proj${String(SLOT).padStart(2, '0')}.ncs`);
      writeFileSync(p, pre.bytes);
      console.log(`REFUSED: Project ${SLOT} is NOT empty ("${nameOf(pre.bytes)}"). Saved to ${p}.`);
    } else {
      console.log(`REFUSED: Project ${SLOT} pre-write read was inconclusive (ok=${pre.ok} crcOk=${pre.crcOk}).`);
    }
    exitMidiScript(1);
  }
  console.log(`   Project ${SLOT} is FREE in both reads`);

  // ── Resolve Drum 1 against the pack's REAL pool, then build ──────────
  const pool = await readSampleDirectory(ensureConnection('circuit'), wirePack);
  console.log(`\nPack ${devicePack} sample pool: ${pool.occupied} of ${pool.total} occupied`);
  for (const s of pool.slots.filter((s) => s.name !== undefined)) {
    console.log(`      sample ${String(s.device_slot).padStart(2)} (wire ${String(s.slot).padStart(2)})  "${s.name}"`);
  }
  const override = flag('--drum1-slot');
  const picked = override !== undefined
    ? { slot: Number(override), name: pool.slots.find((s) => s.slot === Number(override))?.name ?? '(empty — you asked for it)' }
    : resolveDrum1Slot(pool);
  if (picked === undefined) {
    console.log(`REFUSED: no sample in Pack ${devicePack} is a usable short dry hit, so Drum 1 would be SILENT and the test could not`);
    console.log('   distinguish "the drum did not fire" from "the drum is not there". Upload one (Test A does this), or');
    console.log('   force a slot with --drum1-slot N if you know what is in the pool.');
    exitMidiScript(1);
  }
  console.log(`   Drum 1 -> pack sample ${picked.slot + 1} (wire ${picked.slot}) "${picked.name}"${override !== undefined ? '  [--drum1-slot override]' : ''}`);

  const buf = buildProject(picked.slot);
  writeFileSync(localPath, buf);
  describe(buf);

  writeFileSync(join(ARTIFACTS, 'pre-write-survey.json'), JSON.stringify({
    captured_at: new Date().toISOString(), device_pack: devicePack, target_project: SLOT,
    occupied_projects: [...occ1.entries()].map(([slot, name]) => ({ slot, name })),
    sample_pool: pool.slots.filter((s) => s.name !== undefined).map((s) => ({ wire_slot: s.slot, device_slot: s.device_slot, name: s.name })),
    drum1_bound_to: { wire_slot: picked.slot, device_sample: picked.slot + 1, name: picked.name },
    authored_tempo_bpm: BPM,
    pack_wide_restore_point: 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z',
  }, null, 2));

  // ── Write, then verify by an independent read, not by the ACK ────────
  console.log(`\nuploading ${localPath} -> Pack ${devicePack} Project ${SLOT}`);
  const up = await uploadProject(ensureConnection('circuit'), buf, SLOT - 1, { pack: wirePack, reconnect });
  if (!up.ok) { console.log(`   UPLOAD FAILED: ${up.error ?? 'unknown'}`); exitMidiScript(1); }
  console.log(`   ${up.blocks} block(s) acked`);

  await sleep(1500);
  const dl = await downloadProject(ensureConnection('circuit'), SLOT - 1, { pack: wirePack, reconnect });
  if (!dl.ok || !dl.crcOk || dl.bytes === undefined) {
    console.log(`   READ-BACK FAILED (ok=${dl.ok} crcOk=${dl.crcOk} empty=${dl.empty}).`);
    exitMidiScript(1);
  }
  const b = dl.bytes;
  writeFileSync(join(ARTIFACTS, `readback-pack${devicePack}-proj${String(SLOT).padStart(2, '0')}.ncs`), b);

  console.log(`\nread-back: ${b.length} bytes, CRC ok, name "${nameOf(b)}"`);
  const fails = assertAuthored(b, picked.slot, picked.name);

  if (fails.length === 0) {
    console.log(`\nREAD-BACK VERDICT: PASS. Pack ${devicePack} Project ${SLOT} holds two DISAGREEING length sets exactly as built.`);
    const instructions = listeningInstructions(picked.name);
    console.log(instructions);
    const notes = join(ARTIFACTS, 'LISTENING-INSTRUCTIONS.txt');
    writeFileSync(notes, `${instructions}\n`);
    console.log(`\n(also written to ${notes})`);
  } else {
    console.log(`\nREAD-BACK VERDICT: FAIL on ${fails.length} check(s). Do not draw a conclusion from listening until these are explained.`);
  }
  endMidiScript(fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); closeAllMidiConnections(); process.exitCode = 1; });
