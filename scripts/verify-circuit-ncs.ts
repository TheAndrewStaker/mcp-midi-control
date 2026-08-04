/**
 * Golden: Circuit Tracks `.ncs` drum-pattern codec (no hardware, no corpus).
 *
 * Synthetic: builds an in-memory 160,780-byte project buffer, writes drum
 * patterns, decodes them back, and asserts the surgical-edit byte-precision
 * (an added hit changes EXACTLY its velocity + rhythm byte, nothing else).
 * The real exported-project corpus (gitignored) validated these offsets during
 * the decode spike; this locks the codec math in CI without shipping private data.
 *
 * Run via:  npx tsx scripts/verify-circuit-ncs.ts
 */

import {
  NCS_FILE_SIZE, drumBlockIndex, drumRowBase, META_OFFSETS,
  DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE, drumLevelOffset,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
  PROJECT_TEMPO_OFFSET, PROJECT_SWING_OFFSET,
  TEMPO_MIN_BPM, TEMPO_MAX_BPM, TEMPO_DEFAULT_BPM,
  SWING_MIN, SWING_MAX, SWING_DEFAULT,
  getProjectTempo, setProjectTempo, getProjectSwing,
  NCS_MAGIC, NCS_TOTAL_SESSION_SIZE_OFFSET, checkNcsStructure, ncsStructureNote, assertNcsStructure,
  PROJECT_COLOUR_OFFSET, PROJECT_COLOURS, PROJECT_COLOUR_DEFAULT, DISTINCT_COLOURS,
  getProjectColour, setProjectColour, resolveProjectColour, projectColourName, applyProjectColour,
  PROJECT_NAME_OFFSET, PROJECT_NAME_LEN, getProjectName, setProjectName, applyProjectName,
  MIXER_LEVEL_MAX, getSynthLevel, setSynthLevel, getDrumLevel, setDrumLevel,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import {
  decodeDrumPattern, setDrumStep, setDrumPattern, drumPatternToString,
} from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';
import {
  setAllDrumLengths, setDrumChain, setNoteChain, getNoteChain, lengthByte,
} from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import {
  setSceneChain, getSceneChainEnd, MAX_SCENES,
  setSceneNoteChain, getSceneNoteChain,
  setSceneDrumChain, getSceneDrumChain,
} from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import {
  setDrumSampleBinding, getDrumSampleBinding, DRUM_BINDING_OFFSET,
  CIRCUIT_VOICE_SLOT, DEFAULT_DRUM_BINDING, bindingForTrackVoices, DRUM_TRACK_BASE_VOICES, circuitSlotForVoice,
  slotForFlipRole,
} from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import {
  roleOfSampleName, rolesByDirectory, bindingFromDirectory,
} from '@mcp-midi-control/circuit-tracks/ncs/sampleRoles.js';
import {
  readSampleDirectory, readProjectDirectory, parseDirListHeader, parseDirEntry, buildReadFileRequest, fileIdFor,
  SAMPLE_DIRECTORY_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/sampleDirectory.js';
import { makeMessage, fileId, buildUploadFrames, TRANSFER_CONSTANTS as TRANSFER_SUB_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { parsePackListHeader, parsePackEntry, readPackDirectory, FILE_TYPE_PACK } from '@mcp-midi-control/circuit-tracks/ncs/packDirectory.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import {
  decodeNotePattern, setNoteStep, setNoteStepVerbatim, clearNoteStep, setNotePattern,
  splitGateByte, gateByte, noteStepTie, describeGate,
  DEFAULT_GATE, DEFAULT_NOTE_VELOCITY, MIN_GATE_SIXTHS, MAX_GATE_SIXTHS, GATE_TIE_FLAG, MICROTICKS_PER_STEP,
  type NoteStep,
} from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import {
  noteStepBase, NOTE_STEP_REGION, NOTE_STEP_BYTES, NOTE_TRACKS, PATTERNS_PER_TRACK, STEPS_PER_PATTERN,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { authorPlanIntoProject, authorArrangementIntoProject, writer as circuitWriter } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';
import { scanPatternOccupancy, renderNoteTrack } from '@mcp-midi-control/circuit-tracks/descriptor/reader.js';
import { writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getProjectScale, setProjectScale, resolveScaleName, notesOutsideScale, describeScaleChange,
  SCALE_CHROMATIC, SCALE_ROOT_OFFSET, SCALE_TYPE_OFFSET,
} from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import type { RealizePlan, RealizeNoteEvent } from '@mcp-midi-control/core/protocol-generic/types.js';
import { compileToPlan, type NeutralPattern } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}
const hits = (s: string): number[] => [...s].flatMap((c, i) => (c === 'x' ? [i] : []));

/**
 * An empty but STRUCTURALLY VALID project buffer, for anything that goes through
 * a path which accepts a `.ncs` as a project (the template gate, the upload
 * pre-flight). A bare `new Uint8Array(NCS_FILE_SIZE)` is the right length and is
 * not a project: it has no `USER` magic and its self-declared `totalSessionSize`
 * reads 0. That was invisible while nothing checked, and since 2026-07-29 those
 * paths refuse it, so a fixture built that way would be testing the argument gate
 * instead of the behaviour it names. Buffers that only exercise the pure step
 * codecs stay bare on purpose; they never pass a gate.
 */
function blankProject(): Uint8Array {
  const b = new Uint8Array(NCS_FILE_SIZE);
  for (let i = 0; i < NCS_MAGIC.length; i++) b[i] = NCS_MAGIC.charCodeAt(i);
  new DataView(b.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, NCS_FILE_SIZE, true);
  return b;
}

// Offsets (validated against the real corpus in the spike).
check('drumBlockIndex(0,0)=16 (Drum1 pattern0)', drumBlockIndex(0, 0) === 16);
check('drumBlockIndex(3,7)=47 (Drum4 pattern7)', drumBlockIndex(3, 7) === 47);
check('drumRowBase(0,0)=0xCD74', drumRowBase(0, 0) === 0xcdf4 - 144 + 16, `0x${drumRowBase(0, 0).toString(16)}`);
check('META has 64 blocks', META_OFFSETS.length === 64);

// Build a clean project buffer and write a four-on-the-floor kick into D1 p0.
const buf = new Uint8Array(NCS_FILE_SIZE);
setDrumPattern(buf, 0, 0, [0, 4, 8, 12].reduce((g, s) => { g[s] = { active: true, velocity: 110 }; return g; }, new Array(16).fill(false)));
const dec = decodeDrumPattern(buf, 0, 0);
check('decode four-on-the-floor → hits at 0,4,8,12', JSON.stringify(hits(drumPatternToString(dec))) === '[0,4,8,12]', drumPatternToString(dec));
check('decoded velocity = 110 on active steps', dec[0].velocity === 110 && dec[4].velocity === 110);
check('decoded inactive steps have velocity 0', dec[1].velocity === 0 && dec[1].active === false);
check('grid render = x...x...x...x... + 16 rests', drumPatternToString(dec) === 'x...x...x...x...' + '.'.repeat(16));

// Surgical edit: add a NEW hit on an empty step → writes all 4 drum rows
// (velocity, probability, drum_choice, rhythm) and nothing else.
{
  const b2 = buf.slice();
  const changed = setDrumStep(b2, 0, 0, 2, { active: true, velocity: 90 });
  const diff: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (buf[i] !== b2[i]) diff.push(i);
  check('add hit writes exactly its 4 drum rows (vel/prob/drum_choice/rhythm)',
    diff.length === 4 && JSON.stringify(diff.slice().sort((a, b) => a - b)) === JSON.stringify([...changed].sort((a, b) => a - b)),
    JSON.stringify(diff));
  check('new hit sets drum_choice=0xFF (no sample flip) + probability=7',
    b2[changed[1]] === 7 && b2[changed[2]] === 0xff);
}

// SAMPLE FLIP: a step authored with sampleSlot writes drum_choice = that absolute
// sample slot 0..63 (HW-confirmed encoding 2026-06-22: flips to slot 2 / 15 read
// back as drum_choice 2 / 15). This is how multiple drum pieces share one track.
{
  const b5 = new Uint8Array(NCS_FILE_SIZE);
  setDrumStep(b5, 0, 0, 0, { active: true });                                 // default (no flip)
  setDrumStep(b5, 0, 0, 8, { active: true, velocity: 100, sampleSlot: 2 });   // snare flip
  setDrumStep(b5, 0, 0, 12, { active: true, velocity: 100, sampleSlot: 15 }); // sticks flip
  const d = decodeDrumPattern(b5, 0, 0);
  check('sample flip: default hit → drum_choice 0xFF', d[0].drumChoice === 0xff, String(d[0].drumChoice));
  check('sample flip: step 8 → drum_choice 2', d[8].drumChoice === 2, String(d[8].drumChoice));
  check('sample flip: step 12 → drum_choice 15', d[12].drumChoice === 15, String(d[12].drumChoice));
  check('sampleSlot out of range (64) throws',
    (() => { try { setDrumStep(new Uint8Array(NCS_FILE_SIZE), 0, 0, 0, { active: true, sampleSlot: 64 }); return false; } catch { return true; } })());
}

// Patterns are independent: editing D1 p0 leaves D2 p0 and D1 p1 untouched.
{
  const b3 = new Uint8Array(NCS_FILE_SIZE);
  setDrumStep(b3, 0, 0, 0, { active: true });
  check('Drum2 p0 unaffected by Drum1 p0 edit', decodeDrumPattern(b3, 1, 0).every((s) => !s.active));
  check('Drum1 p1 unaffected by Drum1 p0 edit', decodeDrumPattern(b3, 0, 1).every((s) => !s.active));
}

// Idempotent round-trip: decode then re-apply yields the identical buffer.
{
  const b4 = buf.slice();
  const before = buf.slice();
  setDrumPattern(b4, 0, 0, decodeDrumPattern(b4, 0, 0).map((s) => ({ active: s.active, velocity: s.velocity })));
  let same = true;
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (before[i] !== b4[i]) { same = false; break; }
  check('decode → re-encode is byte-identical (idempotent)', same);
}

// Validation guards.
check('wrong buffer size throws', (() => { try { decodeDrumPattern(new Uint8Array(10), 0, 0); return false; } catch { return true; } })());
check('bad track throws', (() => { try { drumBlockIndex(4, 0); return false; } catch { return true; } })());
check('velocity > 127 throws', (() => { try { setDrumStep(buf.slice(), 0, 0, 0, { active: true, velocity: 200 }); return false; } catch { return true; } })());

// ── Note pattern codec (Synth1/Synth2/MIDI1/MIDI2, one shared format) ──────
// Region geometry (validated against the real corpus during the decode spike).
check('NOTE_STEP_REGION = 896 (32 steps x 28 bytes)', NOTE_STEP_REGION === 896);
check('noteStepBase(synth1,0) = META[0]-896 = 0x2e4', noteStepBase('synth1', 0) === 0x664 - 896, `0x${noteStepBase('synth1', 0).toString(16)}`);
check('noteStepBase(synth2,0) = META[8]-896', noteStepBase('synth2', 0) === 0x6ba4 - 896);
check('noteStepBase(midi1,0) = META[48]-896', noteStepBase('midi1', 0) === 0x1a5fc - 896);
check('noteStepBase(midi2,0) = META[56]-896', noteStepBase('midi2', 0) === 0x20b3c - 896);

{
  const sb = new Uint8Array(NCS_FILE_SIZE);
  // Single note: C4 on step 0 → slotMask bit 0, note decodes back.
  setNoteStep(sb, 'synth1', 0, 0, [60]);
  let d = decodeNotePattern(sb, 'synth1', 0);
  check('single note: step 0 active, note 60', d[0].active && d[0].notes[0].note === 60);
  check('single note: slotMask = 0x01 (one leading slot)', d[0].slotMask === 0x01);
  check('single note: defaults gate=6, velocity=96, delay=0',
    d[0].notes[0].gate === DEFAULT_GATE && d[0].notes[0].velocity === DEFAULT_NOTE_VELOCITY && d[0].notes[0].delay === 0);
  check('single note: step probability defaults to 7', d[0].probability === 7);

  // Explicit gate/velocity/delay round-trip (byte order note/gate/delay/velocity).
  setNoteStep(sb, 'synth1', 0, 1, [{ note: 55, gate: 5, delay: 2, velocity: 110 }]);
  d = decodeNotePattern(sb, 'synth1', 0);
  check('note fields round-trip (note55 gate5 delay2 vel110)',
    d[1].notes[0].note === 55 && d[1].notes[0].gate === 5 && d[1].notes[0].delay === 2 && d[1].notes[0].velocity === 110);

  // Chord: 3 notes on step 4 → slotMask 0x07 (NOT a count of 3).
  setNoteStep(sb, 'synth1', 0, 4, [60, 64, 67]);
  d = decodeNotePattern(sb, 'synth1', 0);
  check('chord: slotMask = 0x07 for 3 notes (bitmask, not count)', d[4].slotMask === 0x07);
  check('chord: decodes all 3 notes [60,64,67]', JSON.stringify(d[4].notes.map((n) => n.note)) === '[60,64,67]');

  // Clear: step returns to empty, slotMask 0.
  clearNoteStep(sb, 'synth1', 0, 0);
  d = decodeNotePattern(sb, 'synth1', 0);
  check('clear: step 0 inactive, slotMask 0', !d[0].active && d[0].slotMask === 0);
}

// MIDI tracks use the identical codec, just a different block range.
{
  const m = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(m, 'midi1', 0, 2, [48]);
  check('midi1: note authored + decoded back', decodeNotePattern(m, 'midi1', 0)[2].notes[0].note === 48);
  check('midi1 edit does NOT touch synth1 region', decodeNotePattern(m, 'synth1', 0).every((s) => !s.active));
  check('midi2 unaffected by midi1 edit', decodeNotePattern(m, 'midi2', 0).every((s) => !s.active));
}

// Byte-precision: setting one step touches exactly its 28 bytes, nothing else.
{
  const a = new Uint8Array(NCS_FILE_SIZE);
  setNotePattern(a, 'synth1', 0, new Array(16).fill(undefined)); // lay down empty baseline
  const c = a.slice();
  setNoteStep(c, 'synth1', 0, 5, [72]);
  const diff: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (a[i] !== c[i]) diff.push(i);
  const stepBase = noteStepBase('synth1', 0) + 5 * NOTE_STEP_BYTES;
  check('note edit touches only its 28-byte step',
    diff.length > 0 && diff.every((o) => o >= stepBase && o < stepBase + NOTE_STEP_BYTES), `${diff.length} bytes`);
}

// Independence + guards.
{
  const g = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(g, 'synth1', 0, 0, [60]);
  check('Synth2 unaffected by Synth1 edit', decodeNotePattern(g, 'synth2', 0).every((s) => !s.active));
  check('Synth1 p1 unaffected by Synth1 p0 edit', decodeNotePattern(g, 'synth1', 1).every((s) => !s.active));
  check('>6 notes throws', (() => { try { setNoteStep(g, 'synth1', 0, 0, [1, 2, 3, 4, 5, 6, 7]); return false; } catch { return true; } })());
  check('note > 127 throws', (() => { try { setNoteStep(g, 'synth1', 0, 0, [200]); return false; } catch { return true; } })());
}

// ── GATE LANE = `tie << 7 | gate_sixths` ──────────────────────────────────────
// Decoded 2026-07-26 from a 274-file / 44,898-note corpus census
// (`scripts/circuit-gate-census.ts`) plus the Circuit Tracks user guide. The
// magnitude is FRACTIONAL, in sixths of a step, 1..96; bit 7 is the device's
// documented per-step TIE-FORWARD flag. The previous validator bounded the raw
// BYTE to 0..127, which both rejected the 1,048 real notes that read 224 and
// accepted 97..127, which the device never produces.
//
// The two fields are INDEPENDENT, hardware-confirmed 2026-07-27: byte 176
// (tie ON at a magnitude of 48, i.e. 8 steps) was written into pack 5 project
// 42, then LOADED and SAVED on the maintainer's device, and read back as 176.
// The save also moved the synth 1 mixer byte 0 -> 57 on its own, which is what
// makes it device evidence: mixer levels are composed from the physical faders
// at save time and were never sent over the wire, so the device re-serialised
// the project from its own state rather than echoing our image back. Every tie
// in the corpus sits at 96 because that is how ties get dialled in by hand, not
// because the format requires it.
const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
{
  let joinOk = true, splitOk = true;
  for (let g = MIN_GATE_SIXTHS; g <= MAX_GATE_SIXTHS; g++) {
    for (const tie of [false, true]) {
      const byte = gateByte(g, tie);
      if (byte !== ((tie ? GATE_TIE_FLAG : 0) | g)) joinOk = false;
      const back = splitGateByte(byte);
      if (back.gate !== g || back.tie !== tie) splitOk = false;
    }
  }
  check(`gate lane: join is tie<<7|magnitude over the whole ${MIN_GATE_SIXTHS}..${MAX_GATE_SIXTHS} range, tied and untied`, joinOk);
  check('gate lane: splitGateByte inverts gateByte exactly for all 192 combinations', splitOk);
  check('gate lane: MICROTICKS_PER_STEP=6, MAX_GATE_SIXTHS=96 (one step / sixteen steps)',
    MICROTICKS_PER_STEP === 6 && MAX_GATE_SIXTHS === 96);
  const b224 = splitGateByte(224);
  check('gate lane: the corpus byte 224 splits to {gate 96, tie true}', b224.gate === 96 && b224.tie === true);
  const b176 = splitGateByte(176);
  check('gate lane: 176 splits to {gate 48, tie true} (device-confirmed 2026-07-27: a tie at 8 steps, not 16)', b176.gate === 48 && b176.tie === true);
  check('gate lane: an untied 96 is still just byte 96', gateByte(96, false) === 96 && splitGateByte(96).tie === false);
}

// Goldens through the real buffer: magnitude + tie in, exact lane byte out.
{
  const b = new Uint8Array(NCS_FILE_SIZE);
  const lane = (step: number, slot = 0): number =>
    b[noteStepBase('midi1', 0) + step * NOTE_STEP_BYTES + 4 + slot * 4 + 1];
  setNoteStep(b, 'midi1', 0, 0, [{ note: 60, gate: 6 }]);
  setNoteStep(b, 'midi1', 0, 1, [{ note: 60, gate: 24 }]);
  setNoteStep(b, 'midi1', 0, 2, [{ note: 60, gate: 96 }]);
  setNoteStep(b, 'midi1', 0, 3, [{ note: 60, gate: 9 }]);
  setNoteStep(b, 'midi1', 0, 4, [{ note: 60, gate: 1 }]);
  check('gate write: 6/24/96 → bytes 6/24/96 byte-exact', lane(0) === 6 && lane(1) === 24 && lane(2) === 96);
  check('gate write: a FRACTIONAL 9 (1.5 steps) → byte 9, and a sub-step 1 → byte 1', lane(3) === 9 && lane(4) === 1);
  setNoteStep(b, 'midi1', 0, 5, [{ note: 60, gate: 96, tie: true }]);
  setNoteStep(b, 'midi1', 0, 6, [{ note: 60, gate: 48, tie: true }]);
  check('gate write: {gate 96, tie} → byte 224 (the 1,048-instance corpus value)', lane(5) === 224);
  check('gate write: {gate 48, tie} → byte 176 (any magnitude may carry the flag)', lane(6) === 176);

  const d = decodeNotePattern(b, 'midi1', 0);
  check('gate decode: 224 comes back as {gate 96, tie true}, NOT clamped and NOT masked',
    d[5].notes[0].gate === 96 && d[5].notes[0].tie === true);
  check('gate decode: 176 comes back as {gate 48, tie true}', d[6].notes[0].gate === 48 && d[6].notes[0].tie === true);
  check('gate decode: an untied note reports tie=false', d[0].notes[0].tie === false);
  check('regression: the authoring default is STILL gate 6, untied',
    d[0].notes[0].gate === DEFAULT_GATE && DEFAULT_GATE === 6 && d[0].notes[0].tie === false);

  // The device applies the tie to the whole STEP (manual :1948; 380/380 corpus
  // chord steps agree, 0 mixed). noteStepTie reports that, and names a mixed
  // step rather than silently picking one slot's answer.
  setNoteStep(b, 'midi1', 0, 8, [{ note: 60, gate: 96, tie: true }, { note: 64, gate: 96, tie: true }]);
  setNoteStep(b, 'midi1', 0, 9, [{ note: 60, gate: 96, tie: true }, { note: 64, gate: 96 }]);
  const dc = decodeNotePattern(b, 'midi1', 0);
  check('tie is per STEP: a uniformly tied chord reports true', noteStepTie(dc[8]) === true);
  check('tie is per STEP: a half-tied chord reports "mixed" (never observed on a device)', noteStepTie(dc[9]) === 'mixed');
  check('tie is per STEP: an empty step is untied', noteStepTie(dc[20]) === false);

  // The validator bounds the MAGNITUDE, after the flag has been split off.
  check('gate magnitude 0 throws (the device never writes it)', throws(() => setNoteStep(b, 'midi1', 0, 10, [{ note: 60, gate: 0 }])));
  check('gate magnitude 97 throws (nothing in 97..127 exists in 44,898 notes)', throws(() => setNoteStep(b, 'midi1', 0, 10, [{ note: 60, gate: 97 }])));
  check('the raw BYTE 224 passed as a magnitude throws; the tie belongs in `tie`', throws(() => setNoteStep(b, 'midi1', 0, 10, [{ note: 60, gate: 224 }])));
  check('gate magnitude 96 with a tie is accepted, not rejected as "> 127 territory"',
    !throws(() => setNoteStep(b, 'midi1', 0, 10, [{ note: 60, gate: 96, tie: true }])));
  check('a non-boolean tie throws rather than coercing', throws(() => setNoteStep(b, 'midi1', 0, 10, [{ note: 60, gate: 6, tie: 1 as unknown as boolean }])));
}

// ── setNoteStepVerbatim: the byte-faithful inverse of decodeNotePattern ───────
{
  const b = new Uint8Array(NCS_FILE_SIZE);
  // Reproduces pack0/projects/project_11.ncs synth1 pattern 4 step 13 exactly:
  // mask 0x03, prob 7, slot 0 = note 70 gate 8, slot 1 = NOTE 128 gate 3 delay 4
  // vel 31. One slot in 44,898 holds a note number past the MIDI ceiling.
  const oddball: NoteStep = {
    active: true, slotMask: 0x03, probability: 7,
    notes: [
      { note: 70, gate: 8, tie: false, delay: 0, velocity: 91 },
      { note: 128, gate: 3, tie: false, delay: 4, velocity: 31 },
    ],
  };
  check('note 128: setNoteStep still REFUSES to author it (a MIDI note-on cannot carry it)',
    throws(() => setNoteStep(b, 'synth1', 4, 13, [{ note: 128 }])));
  setNoteStepVerbatim(b, 'synth1', 4, 13, oddball);
  const d = decodeNotePattern(b, 'synth1', 4)[13];
  check('note 128: setNoteStepVerbatim carries the out-of-range byte through unchanged',
    d.notes[1].note === 128 && d.notes[1].gate === 3 && d.notes[1].delay === 4 && d.notes[1].velocity === 31);
  check('note 128: the rest of the record round-trips too', d.slotMask === 0x03 && d.probability === 7 && d.notes[0].note === 70 && d.notes[0].gate === 8);

  // A real device mask is not always leading-packed, and the verbatim writer
  // must not re-pack it (project_11 synth1 pattern 4 step 12 reads mask 0x05).
  const gapped: NoteStep = {
    active: true, slotMask: 0x05, probability: 7,
    notes: [
      { note: 72, gate: 9, tie: false, delay: 0, velocity: 83 },
      { note: 98, gate: 3, tie: false, delay: 2, velocity: 84 },
    ],
  };
  setNoteStepVerbatim(b, 'synth1', 4, 12, gapped);
  const dg = decodeNotePattern(b, 'synth1', 4)[12];
  const gapBase = noteStepBase('synth1', 4) + 12 * NOTE_STEP_BYTES;
  check('verbatim: a non-leading-packed mask 0x05 is preserved, not re-packed to 0x03',
    dg.slotMask === 0x05 && b[gapBase] === 0x05);
  check('verbatim: notes land at THEIR mask positions (slot 0 and slot 2)',
    b[gapBase + 4] === 72 && b[gapBase + 4 + 2 * 4] === 98 && b[gapBase + 4 + 1 * 4] === 0);
  check('verbatim: a mask that disagrees with the note count throws',
    throws(() => setNoteStepVerbatim(b, 'synth1', 4, 11, { active: true, slotMask: 0x07, probability: 7, notes: [] })));
  check('verbatim: a gate magnitude carrying bit 7 throws (the tie belongs in `tie`)',
    throws(() => setNoteStepVerbatim(b, 'synth1', 4, 11, {
      active: true, slotMask: 0x01, probability: 7, notes: [{ note: 60, gate: 224, tie: false, delay: 0, velocity: 96 }],
    })));
}

// ── Corpus anchors (gitignored local scratch; skipped where samples/ is absent) ─
{
  const repoRoot = join(import.meta.dirname, '..');
  const read = (rel: string): Uint8Array | undefined => {
    const p = join(repoRoot, rel);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
  };
  /** Decode every note track/pattern and write it straight back. Byte-identical or bust. */
  const roundTrip = (src: Uint8Array): { diffs: number; first?: number } => {
    const out = src.slice();
    for (const track of NOTE_TRACKS) {
      for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
        const steps = decodeNotePattern(src, track, p);
        for (let s = 0; s < STEPS_PER_PATTERN; s++) setNoteStepVerbatim(out, track, p, s, steps[s]);
      }
    }
    let diffs = 0; let first: number | undefined;
    for (let i = 0; i < src.length; i++) if (src[i] !== out[i]) { diffs++; first ??= i; }
    return { diffs, first };
  };

  // GateTest16, the maintainer's own single-variable A/B: note 60 at step 0
  // tied forward into the same note 60 at step 16. Byte 0x1a281 is midi1 /
  // pattern 0 / step 0 / slot 0's gate lane, and it reads 224 on disk. Anchored
  // to the FILE, not to a literal someone could "fix" to match a bug.
  const TIE_ANCHOR = 0x1a281;
  const proj42 = read('samples/circuit-ncs/pack5/proj42.ncs');
  if (!proj42) {
    console.log('  SKIP  corpus tie anchor: samples/circuit-ncs/pack5/proj42.ncs not present (samples/ is gitignored)');
  } else {
    check('corpus: 0x1a281 IS midi1/pattern0/step0/slot0\'s gate lane',
      noteStepBase('midi1', 0) + 4 + 1 === TIE_ANCHOR, `0x${(noteStepBase('midi1', 0) + 5).toString(16)}`);
    check('corpus: proj42.ncs ("GateTest16") holds raw gate byte 224 at 0x1a281', proj42[TIE_ANCHOR] === 224, String(proj42[TIE_ANCHOR]));
    const tied = decodeNotePattern(proj42, 'midi1', 0)[0].notes[0];
    check('corpus: that byte decodes to {gate 96, tie true}, a 16-step tied drone', tied.gate === 96 && tied.tie === true);
    check('corpus: re-joining it reproduces 224 exactly', gateByte(tied.gate, tied.tie) === 224);
    const rt = roundTrip(proj42);
    check('corpus: proj42.ncs round-trips byte-identical through decode → verbatim re-encode (the test the old 0..127 validator failed)',
      rt.diffs === 0, `${rt.diffs} byte(s) differ, first at 0x${rt.first?.toString(16)}`);
    check('corpus: the OLD authoring validator would still refuse that byte as a magnitude',
      throws(() => setNoteStep(proj42.slice(), 'midi1', 0, 0, [{ note: 60, gate: 224 }])));
  }

  // The factory "Hello Tracks" pack: 64 distinct gate values including 1,033
  // sub-step notes, plus the single note-128 slot. notePattern.ts has always
  // CLAIMED a byte-exact round-trip against this pack; this wires the claim into
  // the gate.
  const packDir = join(repoRoot, 'samples/circuit-tracks/pack0/projects');
  if (!existsSync(packDir)) {
    console.log('  SKIP  corpus round-trip: samples/circuit-tracks/pack0/projects not present (samples/ is gitignored)');
  } else {
    const files = readdirSync(packDir).filter((f) => f.toLowerCase().endsWith('.ncs')).sort();
    let bad = 0; let notes = 0; const detail: string[] = [];
    for (const f of files) {
      const buf = new Uint8Array(readFileSync(join(packDir, f)));
      if (buf.length !== NCS_FILE_SIZE) continue;
      for (const track of NOTE_TRACKS) {
        for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (const s of decodeNotePattern(buf, track, p)) notes += s.notes.length;
      }
      const rt = roundTrip(buf);
      if (rt.diffs !== 0) { bad++; detail.push(`${f}: ${rt.diffs} @0x${rt.first?.toString(16)}`); }
    }
    check(`corpus: all ${files.length} factory "Hello Tracks" projects round-trip byte-identical (${notes} note slots)`,
      bad === 0 && files.length > 0, detail.join('; '));

    // The note-128 slot, by file and offset so it cannot be "fixed" away.
    const NOTE128_AT = 0x36f8;
    const p11 = read('samples/circuit-tracks/pack0/projects/project_11.ncs');
    if (!p11) {
      console.log('  SKIP  note-128 anchor: project_11.ncs not present');
    } else {
      check('note 128: project_11.ncs ("Woke Code") holds note byte 128 at 0x36f8', p11[NOTE128_AT] === 128, String(p11[NOTE128_AT]));
      const step13 = decodeNotePattern(p11, 'synth1', 4)[13];
      check('note 128: it sits on a MASK-ACTIVE slot of an otherwise well-formed record',
        step13.slotMask === 0x03 && step13.probability === 7 && step13.notes.length === 2 && step13.notes[1].note === 128);
      check('note 128: the record\'s other lanes are all sane (gate 3, delay 4, vel 31), not corruption',
        step13.notes[1].gate === 3 && step13.notes[1].delay === 4 && step13.notes[1].velocity === 31);
      check('note 128: it is 1 of 1 across the pack, so it is not a high-bit FLAG like the gate\'s',
        (() => {
          let hi = 0;
          for (const f of readdirSync(packDir).filter((x) => x.toLowerCase().endsWith('.ncs'))) {
            const buf = new Uint8Array(readFileSync(join(packDir, f)));
            if (buf.length !== NCS_FILE_SIZE) continue;
            for (const track of NOTE_TRACKS) {
              for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
                for (const s of decodeNotePattern(buf, track, p)) for (const n of s.notes) if (n.note > 127) hi++;
              }
            }
          }
          return hi === 1;
        })());
      check('note 128: a whole-file round-trip preserves it (we keep the byte, we do not rewrite it)',
        roundTrip(p11).diffs === 0);
    }
  }
}

// ── authorPlanIntoProject: a compiled RealizePlan → buffer (the ncs_upload realizer's core) ──
// Routing is by CHANNEL: ch10 → drum pads, ch1/2/3/4 → synth1/synth2/midi1/midi2.
// Same-(track,step) events merge into a chord; step = round(time_ms / stepMs).
{
  const mk = (channel: number, note: number, time_ms: number, velocity = 100): RealizeNoteEvent =>
    ({ channel, note, velocity, time_ms, duration_ms: 100 });
  // 16 steps over a 2000 ms cycle → stepMs 125; steps 0/4/8 at 0/500/1000 ms.
  const plan: RealizePlan = {
    pattern_name: 'mixed', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      mk(1, 48, 0), mk(1, 51, 0), mk(1, 55, 0),     // Cm chord on Synth1, step 0
      mk(3, 36, 500, 90),                            // bass C2 on MIDI1, step 4
      mk(10, 60, 0, 110), mk(10, 60, 1000, 110),     // kick (Drum1) on steps 0 and 8
      mk(2, 72, 0),                                  // a lead note on Synth2, step 0
    ],
  };
  const pb = new Uint8Array(NCS_FILE_SIZE);
  const res = authorPlanIntoProject(pb, plan);

  check('author: drum_tracks=[0], note_tracks=[synth1,midi1,synth2], unrouted=0',
    JSON.stringify(res.drum_tracks) === '[0]' &&
    JSON.stringify([...res.note_tracks].sort()) === '["midi1","synth1","synth2"]' &&
    res.unrouted === 0, JSON.stringify(res));

  const s1 = decodeNotePattern(pb, 'synth1', 0);
  check('author: Synth1 step0 is the 3-note chord [48,51,55]',
    JSON.stringify(s1[0].notes.map((n) => n.note)) === '[48,51,55]' && s1[0].slotMask === 0x07, JSON.stringify(s1[0].notes.map((n) => n.note)));
  check('author: chord carries the event velocity (100)', s1[0].notes.every((n) => n.velocity === 100));

  const m1 = decodeNotePattern(pb, 'midi1', 0);
  check('author: MIDI1 step4 = bass note 36 vel90', m1[4].notes[0]?.note === 36 && m1[4].notes[0]?.velocity === 90);

  const s2 = decodeNotePattern(pb, 'synth2', 0);
  check('author: Synth2 step0 = lead note 72', s2[0].notes[0]?.note === 72);

  const d1 = decodeDrumPattern(pb, 0, 0);
  check('author: Drum1 hits at steps 0 and 8', d1[0].active && d1[8].active && !d1[4].active);

  // Micro-step rolls on drum tracks: the mask is POSITIONAL and additive
  // (HW-confirmed 2026-07-03, drumPattern.ts cites the capture). A partial
  // roll fans to evenly-spaced ticks with the SAME spacing as the note-track
  // fan: n=3 → ticks {0,3,5} = 0x29. Drum4 = note 65.
  const rollPlan: RealizePlan = {
    pattern_name: 'roll', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      { channel: 10, note: 65, velocity: 100, time_ms: 0, duration_ms: 100, micro_hits: 6 },    // buzz @ step 0
      { channel: 10, note: 65, velocity: 100, time_ms: 500, duration_ms: 100, micro_hits: 3 },   // spaced triple @ step 4
      { channel: 10, note: 65, velocity: 100, time_ms: 1000, duration_ms: 100 },                 // plain @ step 8
    ],
  };
  const rb = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(rb, rollPlan);
  const d4 = decodeDrumPattern(rb, 3, 0); // Drum4
  check('author: micro_hits 6 → microHits mask 0x3F (buzz) on Drum4 step 0', d4[0].active && d4[0].microHits === 0x3f, JSON.stringify(d4[0]));
  check('author: micro_hits 3 → evenly-spaced mask 0x29 (ticks 0,3,5 — note-fan spacing)', d4[4].active && d4[4].microHits === 0x29, String(d4[4].microHits));
  check('author: plain hit → microHits 1 (single) on Drum4 step 8', d4[8].active && d4[8].microHits === 1, String(d4[8].microHits));

  // NOTE-TRACK roll (e.g. a hat roll bound for an external SPD-SX pad on MIDI2,
  // ch4): micro_hits fans the SAME note across the step via the per-note `delay`
  // field (0..5 micro-steps), so a POLY pad rings each retrigger as its own trail.
  const noteRoll: RealizePlan = {
    pattern_name: 'note-roll', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      { channel: 4, note: 62, velocity: 100, time_ms: 0, duration_ms: 100, micro_hits: 6 },  // buzz @ MIDI2 step 0
      { channel: 4, note: 62, velocity: 100, time_ms: 500, duration_ms: 100 },               // plain @ step 4
    ],
  };
  const nb = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(nb, noteRoll);
  const m2 = decodeNotePattern(nb, 'midi2', 0);
  check('author: note-track micro_hits 6 → 6 same-note slots on MIDI2 step 0',
    m2[0].notes.length === 6 && m2[0].notes.every((n) => n.note === 62), JSON.stringify(m2[0].notes.map((n) => n.note)));
  check('author: note roll spreads delays across the 6 micro-steps 0..5',
    JSON.stringify(m2[0].notes.map((n) => n.delay)) === '[0,1,2,3,4,5]', JSON.stringify(m2[0].notes.map((n) => n.delay)));
  check('author: roll retriggers DECAY like real bounces (100,85,72,61,52,44 — anti machine-gun)',
    JSON.stringify(m2[0].notes.map((n) => n.velocity)) === '[100,85,72,61,52,44]', JSON.stringify(m2[0].notes.map((n) => n.velocity)));
  check('author: a plain note-track hit stays a single slot (delay 0)',
    m2[4].notes.length === 1 && m2[4].notes[0].delay === 0, JSON.stringify(m2[4].notes));

  // Micro-tick PLACEMENT (Front B, B0-hardware-confirmed 2026-07-02): an event
  // carrying `micro` writes its note slot with that delay byte. Its time_ms
  // already includes the +micro/6-step offset (compile adds it), so the writer
  // must map it back to its BASE step — delay 3 at step 4 arrives at 562 ms
  // (4.5 × 125) and must land on step 4, not round up to step 5. The same note
  // repeating at a DIFFERENT tick in one step is two slots, not a dupe.
  const placePlan: RealizePlan = {
    pattern_name: 'placed', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      { channel: 4, note: 54, velocity: 100, time_ms: 500, duration_ms: 100 },            // 16th @ step 4, tick 0
      { channel: 4, note: 54, velocity: 100, time_ms: 563, duration_ms: 100, micro: 3 },  // its 32nd "and", tick 3
      { channel: 4, note: 54, velocity: 90, time_ms: 833, duration_ms: 100, micro: 4 },   // triplet offset @ step 6 (750 + 4/6×125)
      { channel: 10, note: 60, velocity: 100, time_ms: 63, duration_ms: 100, micro: 3 },  // internal drum: PLACES via the positional mask
      { channel: 10, note: 60, velocity: 90, time_ms: 0, duration_ms: 100 },              // plain kick on the same step → masks OR to 0x09
    ],
  };
  const plb = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(plb, placePlan);
  const pm2 = decodeNotePattern(plb, 'midi2', 0);
  check('author: micro places 16th + 32nd "and" as two slots (delays [0,3]) on the SAME step',
    JSON.stringify(pm2[4].notes.map((n) => n.delay)) === '[0,3]' && pm2[4].notes.every((n) => n.note === 54),
    JSON.stringify(pm2[4].notes));
  check('author: micro 3 does NOT round up into the next step', !pm2[5].active, JSON.stringify(pm2[5]));
  check('author: triplet-offset onset lands on its base step with delay 4',
    pm2[6].notes.length === 1 && pm2[6].notes[0].delay === 4 && pm2[6].notes[0].velocity === 90,
    JSON.stringify(pm2[6].notes));
  const pd1 = decodeDrumPattern(plb, 0, 0);
  check('author: internal drum PLACES micro 3 + plain hit as additive mask 0x09, loudest velocity',
    pd1[0].active && pd1[0].microHits === 0x09 && pd1[0].velocity === 100, JSON.stringify(pd1[0]));

  // also_internal END-TO-END (author side): compile emits a hit on BOTH the
  // internal (ch10) and external (ch4 = MIDI2) channel at the same step; authoring
  // must land a Drum pad hit AND a MIDI2 note at that step — "both at once".
  const bothPlan: RealizePlan = {
    pattern_name: 'both', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [mk(10, 60, 0, 100), mk(4, 60, 0, 100)], // kick on Drum1 + SPD-SX kick note on MIDI2, step 0
  };
  const bb = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(bb, bothPlan);
  check('author: also_internal lands a Drum1 hit AND a MIDI2 note at the same step (both at once)',
    decodeDrumPattern(bb, 0, 0)[0].active && decodeNotePattern(bb, 'midi2', 0)[0].notes[0]?.note === 60,
    JSON.stringify({ drum: decodeDrumPattern(bb, 0, 0)[0].active, midi2: decodeNotePattern(bb, 'midi2', 0)[0].notes[0]?.note }));

  // Honesty: a ch10 note that is not a pad, and an over-wide chord, are counted, not faked.
  const odd: RealizePlan = {
    pattern_name: 'odd', bpm: 120, steps: 4, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      mk(10, 99, 0),                                              // ch10 but not a pad → unrouted
      mk(1, 40, 0), mk(1, 41, 0), mk(1, 42, 0), mk(1, 43, 0), mk(1, 44, 0), mk(1, 45, 0), mk(1, 46, 0), // 7 notes, same step
    ],
  };
  const ob = new Uint8Array(NCS_FILE_SIZE);
  const ores = authorPlanIntoProject(ob, odd);
  check('author: counts unrouted (1 non-pad ch10 + 1 chord-overflow past 6 slots)', ores.unrouted === 2, JSON.stringify(ores));
  check('author: the 6-slot cap holds (chord truncated to 6, not a crash)',
    decodeNotePattern(ob, 'synth1', 0)[0].notes.length === 6);
}

// ── TEMPLATE GATE + TIE PRESERVATION (the hand-set note lengths) ─────────────
// ncs_upload template-modifies a REAL project, and the authoring path only ever
// emits a one-step gate, so every other gate in a stored project was dialled in
// by hand at the device. Re-authoring without this flattens them to 6 and wipes
// the 1,048 tie-forward flags that make the pads and drones hold.
{
  const mk = (channel: number, note: number, step: number, velocity = 100): RealizeNoteEvent =>
    ({ channel, note, velocity, time_ms: step * 125, duration_ms: 100 });
  const plan = (steps: number, events: RealizeNoteEvent[]): RealizePlan =>
    ({ pattern_name: 'reauthor', bpm: 120, steps, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: steps * 125, events });

  // Template: MIDI1 holds a hand-made drone. C4 at step 0 with a 16-step TIED
  // gate (byte 224) running into the same C4 at step 16, which itself carries a
  // hand-set 2-step gate (12). Exactly the shape Clint Eastwood / Amber use.
  const tpl = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(tpl, 'midi1', 0, 0, [{ note: 60, gate: 96, tie: true }]);
  setNoteStep(tpl, 'midi1', 0, 16, [{ note: 60, gate: 12 }]);
  const tieLane = noteStepBase('midi1', 0) + 5;
  check('preserve: the template really does hold gate byte 224 before authoring', tpl[tieLane] === 224);

  // Re-author the same part (plus one NEW note the template does not hold).
  const same = plan(32, [mk(3, 60, 0), mk(3, 60, 16), mk(3, 67, 24)]);
  const kept = tpl.slice();
  const kres = authorPlanIntoProject(kept, same);
  const kd = decodeNotePattern(kept, 'midi1', 0);
  check('preserve: the hand-set 16-step TIED gate survives a re-author (byte still 224)',
    kd[0].notes[0].gate === 96 && kd[0].notes[0].tie === true && kept[tieLane] === 224, `gate=${kd[0].notes[0].gate} tie=${kd[0].notes[0].tie} byte=${kept[tieLane]}`);
  check('preserve: the hand-set 2-step gate at step 16 survives too', kd[16].notes[0].gate === 12 && kd[16].notes[0].tie === false);
  check('preserve: a note the template does NOT hold gets the one-step default, untied',
    kd[24].notes[0].gate === DEFAULT_GATE && kd[24].notes[0].tie === false);
  check('preserve: the receipt counts what it kept (2 gates, 1 of them a tie)',
    kres.gates_preserved === 2 && kres.ties_preserved === 1 && kres.gate_warnings === undefined, JSON.stringify({ g: kres.gates_preserved, t: kres.ties_preserved, w: kres.gate_warnings }));

  // The regression this guards: with preservation off, the same re-author
  // flattens the drone to a one-step blip and silently drops the tie.
  const flat = tpl.slice();
  authorPlanIntoProject(flat, same, undefined, 0, false);
  const fd = decodeNotePattern(flat, 'midi1', 0);
  check('preserve: opting OUT reproduces the old flattening (gate 6, tie gone), the bug, pinned',
    fd[0].notes[0].gate === DEFAULT_GATE && fd[0].notes[0].tie === false && flat[tieLane] === 6);

  // The manual's worked example: a tie may reach past the last step into the
  // pattern's own first onset (GateTest16 is exactly this, in 16 steps).
  const wrapTpl = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(wrapTpl, 'midi1', 0, 0, [{ note: 60, gate: 96, tie: true }]);
  const wrapped = wrapTpl.slice();
  const wres = authorPlanIntoProject(wrapped, plan(16, [mk(3, 60, 0)]));
  check('preserve: a tie that wraps to the pattern\'s own first onset is KEPT (the manual\'s example)',
    decodeNotePattern(wrapped, 'midi1', 0)[0].notes[0].tie === true && wres.ties_preserved === 1);

  // ...but a tie whose gate no longer reaches the next onset is a silent no-op
  // on the device (manual :1908; 524/524 real ties obey it), so it is dropped
  // LOUDLY and the note LENGTH is still kept.
  const moved = wrapTpl.slice();
  const mres = authorPlanIntoProject(moved, plan(32, [mk(3, 60, 0), mk(3, 60, 8)]));
  const md = decodeNotePattern(moved, 'midi1', 0);
  check('preserve: a tie that no longer reaches the next onset is dropped, and said out loud',
    md[0].notes[0].tie === false && (mres.gate_warnings?.length ?? 0) === 1, JSON.stringify(mres.gate_warnings));
  check('preserve: dropping the tie keeps the hand-set LENGTH (96), it does not reset to 6',
    md[0].notes[0].gate === 96);

  // A roll is deliberate retriggers, so it stays on the default gate even when
  // the template holds a long note for that pitch on that step.
  const rollTpl = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(rollTpl, 'midi2', 0, 0, [{ note: 60, gate: 48 }]);
  const rolled = rollTpl.slice();
  authorPlanIntoProject(rolled, plan(16, [{ channel: 4, note: 60, velocity: 100, time_ms: 0, duration_ms: 100, micro_hits: 3 }]));
  const rd = decodeNotePattern(rolled, 'midi2', 0);
  check('preserve: a micro-step ROLL keeps DEFAULT_GATE, untied (bounces must not smear)',
    rd[0].notes.length === 3 && rd[0].notes.every((n) => n.gate === DEFAULT_GATE && !n.tie));

  // Arrangements inherit per pattern slot, and default to preserving as well.
  const arrTpl = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(arrTpl, 'midi1', 1, 0, [{ note: 60, gate: 48 }]);
  const arrBuf = arrTpl.slice();
  const arr = authorArrangementIntoProject(
    arrBuf,
    [{ name: 'A', plan: plan(16, [mk(3, 62, 0)]) }, { name: 'B', plan: plan(16, [mk(3, 60, 0)]) }],
    [0, 1],
  );
  check('preserve: authorArrangementIntoProject preserves per pattern slot by default',
    decodeNotePattern(arrBuf, 'midi1', 1)[0].notes[0].gate === 48 &&
    decodeNotePattern(arrBuf, 'midi1', 0)[0].notes[0].gate === DEFAULT_GATE &&
    arr.authored[1].gates_preserved === 1);
}

// ── AUTHORED NOTE LENGTH: the pattern's own gate reaches the stored byte ─────
// Before this, every authored note got a one-step gate and a "pad" was really a
// blip whose sustain came from the receiving synth's amp envelope. Swap the
// synth (a MicroFreak took over the Circuit's MIDI 1 track from a Hydrasynth)
// and the pad is gone. These pin the whole path: neutral sixths in, exact lane
// byte out.
{
  const ev = (note: number, step: number, gate_sixths?: number, tie?: boolean): RealizeNoteEvent => ({
    channel: 3, note, velocity: 100, time_ms: step * 125, duration_ms: 100,
    ...(gate_sixths !== undefined ? { gate_sixths } : {}),
    ...(tie ? { tie: true } : {}),
  });
  const plan = (steps: number, events: RealizeNoteEvent[]): RealizePlan =>
    ({ pattern_name: 'gated', bpm: 120, steps, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: steps * 125, events });
  const laneAt = (b: Uint8Array, step: number, slot = 0): number =>
    b[noteStepBase('midi1', 0) + step * NOTE_STEP_BYTES + 4 + slot * 4 + 1];

  const b = new Uint8Array(NCS_FILE_SIZE);
  const res = authorPlanIntoProject(b, plan(32, [
    ev(60, 0, 6), ev(62, 1, 24), ev(64, 2, 96), ev(65, 3, 9), ev(67, 4, 1), ev(69, 5),
  ]));
  check('authored gate: 6/24/96 sixths reach the lane as bytes 6/24/96, byte-exact',
    laneAt(b, 0) === 6 && laneAt(b, 1) === 24 && laneAt(b, 2) === 96,
    `${laneAt(b, 0)}/${laneAt(b, 1)}/${laneAt(b, 2)}`);
  check('authored gate: a FRACTIONAL 9 (1.5 steps) and a sub-step 1 survive the writer',
    laneAt(b, 3) === 9 && laneAt(b, 4) === 1);
  check('authored gate: an event with NO gate_sixths still gets DEFAULT_GATE (nothing already written moves)',
    laneAt(b, 5) === DEFAULT_GATE);
  check('authored gate: the receipt counts what the PATTERN asked for, separately from template inheritance',
    res.gates_authored === 5 && res.ties_authored === undefined && res.gates_preserved === undefined,
    JSON.stringify({ a: res.gates_authored, t: res.ties_authored, p: res.gates_preserved }));

  // A tie that reaches its next onset with the same pitch is written as bit 7.
  const tb = new Uint8Array(NCS_FILE_SIZE);
  const tres = authorPlanIntoProject(tb, plan(32, [ev(60, 0, 96, true), ev(60, 16, 12)]));
  check('authored tie: {96 sixths, tie} lands as raw lane byte 224 (the corpus value)',
    laneAt(tb, 0) === 224, String(laneAt(tb, 0)));
  check('authored tie: it decodes back as {gate 96, tie true}',
    (() => { const d = decodeNotePattern(tb, 'midi1', 0)[0].notes[0]; return d.gate === 96 && d.tie === true; })());
  check('authored tie: the receipt counts it', tres.ties_authored === 1 && tres.gates_authored === 2);

  // Any magnitude may carry the flag. Hardware-confirmed 2026-07-27: the device
  // itself re-serialised a project holding byte 176 (tie at 8 steps) and kept
  // it, so authoring a tie at a magnitude other than 96 is confirmed behaviour,
  // not an assumption this codec is making.
  const hb = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(hb, plan(16, [ev(60, 0, 48, true), ev(60, 8, 6)]));
  check('authored tie: an 8-step tie lands as byte 176, not forced to 224 (device-confirmed independence)',
    laneAt(hb, 0) === 176, String(laneAt(hb, 0)));

  // The manual's rule, applied to AUTHORED ties as well as inherited ones: a tie
  // that does not end on a matching next onset is a device no-op, so it is
  // dropped loudly and the length is kept.
  const ub = new Uint8Array(NCS_FILE_SIZE);
  const ures = authorPlanIntoProject(ub, plan(32, [ev(60, 0, 12, true), ev(60, 16)]));
  check('authored tie: one that cannot reach the next onset is DROPPED (byte 12, not 140)',
    laneAt(ub, 0) === 12 && (ures.gate_warnings?.length ?? 0) === 1, `byte=${laneAt(ub, 0)}`);
  check('authored tie: the drop is said out loud, in steps, not in raw sixths',
    /gate 2 steps/.test(ures.gate_warnings?.[0] ?? ''), ures.gate_warnings?.[0]);
  check('authored tie: a dropped tie is not also counted as written', ures.ties_authored === undefined);

  // The pattern's own length is MORE specific than the template's, so it wins.
  const tpl = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(tpl, 'midi1', 0, 0, [{ note: 60, gate: 48 }]);
  setNoteStep(tpl, 'midi1', 0, 8, [{ note: 62, gate: 24 }]);
  const wb = tpl.slice();
  const wres = authorPlanIntoProject(wb, plan(16, [ev(60, 0, 12), ev(62, 8)]));
  check('authored gate BEATS template inheritance on the same (step, note)', laneAt(wb, 0) === 12, String(laneAt(wb, 0)));
  check('the template still fills in the notes the pattern said nothing about',
    laneAt(wb, 8) === 24 && wres.gates_preserved === 1 && wres.gates_authored === 1,
    JSON.stringify({ b: laneAt(wb, 8), p: wres.gates_preserved, a: wres.gates_authored }));

  // Out of range is REFUSED, not clamped: silently shortening a 16-step drone is
  // the exact damage this surface exists to prevent.
  const throwsRange = (gate: number): boolean => {
    try { authorPlanIntoProject(new Uint8Array(NCS_FILE_SIZE), plan(16, [ev(60, 0, gate)])); return false; } catch { return true; }
  };
  check('writer: gate 0 sixths is refused, not clamped up', throwsRange(0));
  check('writer: gate 97 sixths is refused, not clamped down to 96', throwsRange(97));
  check('writer: the raw byte 224 passed as a magnitude is refused (the tie belongs in `tie`)', throwsRange(224));

  // A roll and a length contradict each other on one step; say which won.
  const rb = new Uint8Array(NCS_FILE_SIZE);
  const rres = authorPlanIntoProject(rb, plan(16, [
    { channel: 3, note: 60, velocity: 100, time_ms: 0, duration_ms: 100, micro_hits: 3, gate_sixths: 48 },
  ]));
  check('writer: a note length on a micro-step ROLL is reported, not silently dropped',
    (rres.gate_warnings?.length ?? 0) === 1 && /roll/.test(rres.gate_warnings?.[0] ?? ''), JSON.stringify(rres.gate_warnings));
  check('writer: the roll itself still writes DEFAULT_GATE retriggers',
    decodeNotePattern(rb, 'midi1', 0)[0].notes.every((n) => n.gate === DEFAULT_GATE && !n.tie));
}

// ── describeGate: display-first, and a tie is never invisible ────────────────
{
  check('describeGate 6 = "gate 1 step"', describeGate(6, false) === 'gate 1 step', describeGate(6, false));
  check('describeGate 24 = "gate 4 steps"', describeGate(24, false) === 'gate 4 steps', describeGate(24, false));
  check('describeGate 96 = "gate 16 steps"', describeGate(96, false) === 'gate 16 steps', describeGate(96, false));
  check('describeGate 1 = "gate 1/6 step" (exact fraction, never 0.1666)', describeGate(1, false) === 'gate 1/6 step', describeGate(1, false));
  check('describeGate 3 = "gate 1/2 step"', describeGate(3, false) === 'gate 1/2 step', describeGate(3, false));
  check('describeGate 4 = "gate 2/3 step"', describeGate(4, false) === 'gate 2/3 step', describeGate(4, false));
  check('describeGate 9 = "gate 1 1/2 steps"', describeGate(9, false) === 'gate 1 1/2 steps', describeGate(9, false));
  check('describeGate names the TIE (the drone that used to print identically to a plain note)',
    describeGate(96, true) === 'gate 16 steps, TIED forward', describeGate(96, true));
}

// ── get_preset / describe_device rendering makes a tie VISIBLE ───────────────
// `renderNoteTrack` used to print a tied note and an untied one of the same
// length identically, so all 1,048 hand-made ties in the maintainer's corpus
// were invisible in every read surface.
{
  const b = new Uint8Array(NCS_FILE_SIZE);
  setNoteStep(b, 'midi1', 0, 0, [{ note: 60, gate: 96, tie: true }]);
  setNoteStep(b, 'midi1', 0, 4, [{ note: 60, gate: 96 }]);
  setNoteStep(b, 'midi1', 0, 8, [{ note: 60, gate: 6, tie: true }]);
  setNoteStep(b, 'midi1', 0, 12, [{ note: 60, gate: 6 }]);
  const rendered = renderNoteTrack(decodeNotePattern(b, 'midi1', 0)).content;
  check('render: a tied 16-step note is distinguishable from an untied one',
    rendered.includes('step 1: C4(gate 16 steps, TIED forward)') && rendered.includes('step 5: C4(gate 16 steps)'),
    rendered);
  check('render: a tie at the DEFAULT length is annotated too (it used to render bare)',
    rendered.includes('step 9: C4(gate 1 step, TIED forward)'), rendered);
  check('render: a plain default note stays unannotated (no new noise on ordinary patterns)',
    rendered.includes('step 13: C4,') || rendered.endsWith('step 13: C4'), rendered);
}

// ── Project Scale codec (tail offsets) + resolveScaleName ───────────────
{
  check('SCALE offsets: root=0x26D0C, type=0x26D0D', SCALE_ROOT_OFFSET === 0x26d0c && SCALE_TYPE_OFFSET === 0x26d0d);

  const sc = new Uint8Array(NCS_FILE_SIZE); // zero buffer = root 0 (C), type 0 (Natural Minor)
  check('getProjectScale default zero buffer = C Natural Minor', (() => { const s = getProjectScale(sc); return s.root === 0 && s.type === 0 && s.rootName === 'C' && s.name === 'Natural Minor'; })());

  setProjectScale(sc, SCALE_CHROMATIC);
  check('setProjectScale Chromatic → type byte 15, name Chromatic', sc[SCALE_TYPE_OFFSET] === 15 && getProjectScale(sc).name === 'Chromatic');

  setProjectScale(sc, 4, 7); // Mixolydian, root G
  check('setProjectScale type+root → G Mixolydian', (() => { const s = getProjectScale(sc); return s.type === 4 && s.root === 7 && s.name === 'Mixolydian' && s.rootName === 'G'; })());
  check('setProjectScale rejects out-of-range type', (() => { try { setProjectScale(sc, 16); return false; } catch { return true; } })());
  check('setProjectScale rejects out-of-range root', (() => { try { setProjectScale(sc, 0, 12); return false; } catch { return true; } })());

  // resolveScaleName: spoken → {type, root?}
  check('resolveScaleName "C minor" → type 0, root 0', (() => { const r = resolveScaleName('C minor'); return r.type === 0 && r.root === 0; })());
  check('resolveScaleName "G mixolydian" → type 4, root 7', (() => { const r = resolveScaleName('G mixolydian'); return r.type === 4 && r.root === 7; })());
  check('resolveScaleName "Eb major" → type 1, root 3', (() => { const r = resolveScaleName('Eb major'); return r.type === 1 && r.root === 3; })());
  check('resolveScaleName "chromatic" → type 15, no root', (() => { const r = resolveScaleName('chromatic'); return r.type === 15 && r.root === undefined; })());
  check('resolveScaleName "dorian" (bare) → type 2, no root', (() => { const r = resolveScaleName('dorian'); return r.type === 2 && r.root === undefined; })());
  check('resolveScaleName rejects unknown scale', (() => { try { resolveScaleName('klingon'); return false; } catch { return true; } })());
}

// ── authorPlanIntoProject sets the scale (Chromatic default; honors a choice) ──
{
  const mk = (channel: number, note: number, time_ms: number): RealizeNoteEvent => ({ channel, note, velocity: 100, time_ms, duration_ms: 100 });
  const plan = (events: RealizeNoteEvent[]): RealizePlan => ({ pattern_name: 'p', bpm: 120, steps: 4, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000, events });

  // Note track written, no scale arg → forced to Chromatic (literal pitches).
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    const r = authorPlanIntoProject(b, plan([mk(1, 60, 0)])); // synth1
    check('author note track defaults scale → Chromatic', r.scale_set?.name === 'Chromatic' && getProjectScale(b).type === SCALE_CHROMATIC);
    check('author records prior scale (was C Natural Minor)', r.prior_scale?.name === 'Natural Minor');
  }
  // Note track written WITH a scale choice → that scale is set.
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    const r = authorPlanIntoProject(b, plan([mk(2, 60, 0)]), 'C minor'); // synth2, C minor
    check('author honors chosen scale "C minor"', r.scale_set?.name === 'Natural Minor' && r.scale_set?.rootName === 'C' && getProjectScale(b).type === 0);
  }
  // Drums only → scale untouched (no note track; pads are scale-immune).
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    b[SCALE_TYPE_OFFSET] = 1; // pretend the template was Major
    const r = authorPlanIntoProject(b, plan([mk(10, 60, 0)])); // kick only
    check('drums-only author leaves the scale untouched', r.scale_set === undefined && getProjectScale(b).type === 1);
  }
  // Bad scale name → throws FAIL-FAST, before mutating the buffer.
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    const before = b.slice();
    check('bad scale name throws', (() => { try { authorPlanIntoProject(b, plan([mk(2, 60, 0)]), 'klingon'); return false; } catch { return true; } })());
    check('bad scale name left the buffer untouched (fail-fast)', b.every((v, i) => v === before[i]));
  }
}

// ── notesOutsideScale + the out-of-scale guardrail (the opt-in path) ───────
{
  const mk = (channel: number, note: number): RealizeNoteEvent => ({ channel, note, velocity: 100, time_ms: 0, duration_ms: 100 });
  const plan = (events: RealizeNoteEvent[]): RealizePlan => ({ pattern_name: 'p', bpm: 120, steps: 4, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000, events });

  // notesOutsideScale: C natural minor (type 0, root 0) contains C/D/Eb/F/G/Ab/Bb.
  check('notesOutsideScale: C maj7 [C,E,G,B] vs C minor → 2 out (E, B)', notesOutsideScale([60, 64, 67, 71], 0, 0) === 2);
  check('notesOutsideScale: Cm7 [C,Eb,G,Bb] vs C minor → 0 (all in-key)', notesOutsideScale([60, 63, 67, 70], 0, 0) === 0);
  check('notesOutsideScale: anything vs Chromatic → 0', notesOutsideScale([60, 61, 62, 63], SCALE_CHROMATIC, 0) === 0);
  check('notesOutsideScale: A minor (root 9) accepts A/C/E', notesOutsideScale([57, 60, 64], 0, 9) === 0);

  // authorPlanIntoProject reports the real out-of-scale count on the opt-in path.
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    const r = authorPlanIntoProject(b, plan([mk(2, 64), mk(2, 71)]), 'C minor'); // E + B authored under C minor
    check('author under C minor flags 2 out-of-scale (E, B)', r.out_of_scale === 2 && r.scale_set?.name === 'Natural Minor');
  }
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    const r = authorPlanIntoProject(b, plan([mk(2, 60), mk(2, 63), mk(2, 67)]), 'C minor'); // C, Eb, G all in-key
    check('author in-key under C minor → 0 out-of-scale', r.out_of_scale === 0);
  }
  {
    const b = new Uint8Array(NCS_FILE_SIZE);
    const r = authorPlanIntoProject(b, plan([mk(2, 61)])); // default Chromatic
    check('author default Chromatic → 0 out-of-scale (literal)', r.scale_set?.name === 'Chromatic' && r.out_of_scale === 0);
  }
}

// ── describeScaleChange formatter (pure; the result-text branches) ─────────
{
  const chrom = { root: 0, type: SCALE_CHROMATIC, rootName: 'C', name: 'Chromatic' };
  const cmin = { root: 0, type: 0, rootName: 'C', name: 'Natural Minor' };
  const prior = cmin;
  check('describeScaleChange Chromatic → "play literally"', describeScaleChange(prior, chrom, 0).includes('play literally'));
  check('describeScaleChange in-key non-Chromatic → "All authored notes are in-key"', describeScaleChange(chrom, cmin, 0).includes('All authored notes are in-key'));
  check('describeScaleChange out-of-scale → WARNING with the count', (() => { const s = describeScaleChange(chrom, cmin, 2); return s.includes('WARNING') && s.includes('2 authored') && s.includes('chromatic'); })());
  check('describeScaleChange has no undefined-undefined leak', !describeScaleChange(prior, chrom, 0).includes('undefined'));
}

// ── Pattern length + chain (chain.ts) ─────────────────────────────────
{
  const buf = new Uint8Array(NCS_FILE_SIZE);
  check('lengthByte(32)=0x1f, (16)=0x0f', lengthByte(32) === 0x1f && lengthByte(16) === 0x0f);
  setAllDrumLengths(buf, 32);
  check('setAllDrumLengths: every drum block length byte = 0x1f',
    [16, 31, 47].every((bi) => buf[META_OFFSETS[bi]] === 0x1f));

  // Anchor: chain [0,1] must reproduce the hardware-confirmed Project-43 bytes
  // (end byte = 1 at 0x2d5/0x2d9/0x2dd/0x2e1, tail 0x0c at 0x26fc7), now also
  // writing start=0 (the template default) explicitly.
  const changed = setDrumChain(buf, { start: 0, end: 1 });
  check('setDrumChain[0,1]: end byte = 1 at the 4 known track offsets',
    [0x2d5, 0x2d9, 0x2dd, 0x2e1].every((o) => buf[o] === 1), [0x2d5, 0x2d9, 0x2dd, 0x2e1].map((o) => buf[o]).join(','));
  check('setDrumChain[0,1]: start byte = 0 at 0x2d4/0x2d8/0x2dc/0x2e0',
    [0x2d4, 0x2d8, 0x2dc, 0x2e0].every((o) => buf[o] === 0));
  check('setDrumChain: enable tail 0x0c at 0x26fc7', buf[0x26fc7] === 0x0c);
  check('setDrumChain: returns 9 changed offsets (4×2 + tail)', changed.length === 9, String(changed.length));

  // Wider range writes [start,end] per track (decoded-beta).
  const buf2 = new Uint8Array(NCS_FILE_SIZE);
  setDrumChain(buf2, { start: 0, end: 3 });
  check('setDrumChain[0,3]: end byte = 3 per track', [0x2d5, 0x2d9, 0x2dd, 0x2e1].every((o) => buf2[o] === 3));

  let threw = false; try { setDrumChain(buf2, { start: 2, end: 1 }); } catch { threw = true; }
  check('setDrumChain: end<start throws', threw);
  let threw2 = false; try { setDrumChain(buf2, { start: 0, end: 8 }); } catch { threw2 = true; }
  check('setDrumChain: end>=8 throws', threw2);
}

// ── Note-track pattern chain (chain.ts) ───────────────────────────────
// HARDWARE-CONFIRMED anchors (2026-07-01 before/after device diffs on the
// maintainer's Circuit Tracks). Shared chain table base 0x2c4; note tracks are
// slots 0-3 (synth1,synth2,midi1,midi2), so midi1=0x2cc, midi2=0x2d0. Program 1
// chained MIDI 1 to patterns 1→3 (end=2); Program 2 chained MIDI 2 to 1→4
// (end=3). Note chains touch ONLY the 2-byte slot (no tail byte).
{
  const buf = new Uint8Array(NCS_FILE_SIZE);
  // midi2 = slot 3 = 0x2d0. Program-2 device save: [0, 3].
  const chM2 = setNoteChain(buf, 'midi2', { start: 0, end: 3 });
  check('setNoteChain(midi2,[0,3]): start=0 @0x2d0, end=3 @0x2d1',
    buf[0x2d0] === 0 && buf[0x2d1] === 3, `${buf[0x2d0]},${buf[0x2d1]}`);
  check('setNoteChain(midi2): touches only the 2 slot bytes (no tail)',
    chM2.length === 2 && buf[0x26fc7] === 0, String(chM2.length));

  // midi1 = slot 2 = 0x2cc. Program-1 device save: [0, 2].
  const buf1 = new Uint8Array(NCS_FILE_SIZE);
  setNoteChain(buf1, 'midi1', { start: 0, end: 2 });
  check('setNoteChain(midi1,[0,2]): end=2 @0x2cd, midi2 slot untouched',
    buf1[0x2cd] === 2 && buf1[0x2d0] === 0 && buf1[0x2d1] === 0);

  // Synth note tracks (slots 0/1 = 0x2c4/0x2c8), device-observed order.
  const buf3 = new Uint8Array(NCS_FILE_SIZE);
  setNoteChain(buf3, 'synth1', { start: 0, end: 1 });
  setNoteChain(buf3, 'synth2', { start: 0, end: 1 });
  check('setNoteChain(synth1/synth2): ends @0x2c5/0x2c9',
    buf3[0x2c5] === 1 && buf3[0x2c9] === 1);

  // Round-trip + unchained sentinel.
  check('getNoteChain(midi2) round-trips → [0,3]',
    JSON.stringify(getNoteChain(buf, 'midi2')) === JSON.stringify({ start: 0, end: 3 }));
  check('getNoteChain on an unchained ([0,0]) track → undefined',
    getNoteChain(new Uint8Array(NCS_FILE_SIZE), 'midi2') === undefined);

  let nThrew = false; try { setNoteChain(buf, 'midi2', { start: 2, end: 1 }); } catch { nThrew = true; }
  check('setNoteChain: end<start throws', nThrew);
}

// ── Scene chain (sceneChain.ts) ───────────────────────────────────────
// Anchor: a Scene 1→4 chain must reproduce the hardware-confirmed Project-64
// bytes (decoded 2026-06-24 by before/after device diff): end byte 0x03 at
// 0x2c1 — the byte right after the 16-scene stack (0x51 + 16*0x27 = 0x2c1) —
// plus the two scene-select state bytes the device sets for an active chain
// (0x00 @0x26fbc, 0x07 @0x26fd2).
{
  check('MAX_SCENES = 16', MAX_SCENES === 16);
  check('scene stack math: 0x51 + 16*0x27 = 0x2c1 (chain end sits after the stack)', 0x51 + 16 * 0x27 === 0x2c1);

  const buf = new Uint8Array(NCS_FILE_SIZE);
  const changed = setSceneChain(buf, 4);
  check('setSceneChain(4): end byte 0x03 at 0x2c1 (= last scene, 0-based)', buf[0x2c1] === 0x03, `0x${buf[0x2c1].toString(16)}`);
  check('setSceneChain(4): state bytes 0x00 @0x26fbc, 0x07 @0x26fd2', buf[0x26fbc] === 0x00 && buf[0x26fd2] === 0x07);
  check('setSceneChain: returns 3 changed offsets', changed.length === 3, String(changed.length));
  check('getSceneChainEnd round-trips → 4 (1-based last scene)', getSceneChainEnd(buf) === 4, String(getSceneChainEnd(buf)));

  const buf2 = new Uint8Array(NCS_FILE_SIZE);
  check('getSceneChainEnd on a no-chain buffer → undefined', getSceneChainEnd(buf2) === undefined);
  setSceneChain(buf2, 16);
  check('setSceneChain(16): end byte 0x0f', buf2[0x2c1] === 0x0f);

  let chThrew = false; try { setSceneChain(new Uint8Array(NCS_FILE_SIZE), 1); } catch { chThrew = true; }
  check('setSceneChain(1) throws (a 1-scene "chain" is just a scene)', chThrew);
  let chThrew2 = false; try { setSceneChain(new Uint8Array(NCS_FILE_SIZE), 17); } catch { chThrew2 = true; }
  check('setSceneChain(17) throws (> 16 scenes)', chThrew2);
}

// ── Per-scene note-track selection (sceneChain.ts) ─────────────────────
// Anchor: device before/after diff (Project 4, 2026-07-01). Each scene block is
// 0x50 + N*0x28; note sub-table at +0x18 (synth1/synth2/midi1/midi2); flag +0x10.
// Scene 1 held synth1=[0,3] @0x68/0x69 and midi2=[1,1] @0x74/0x75 (block 0 = 0x50).
{
  const buf = new Uint8Array(NCS_FILE_SIZE);
  // midi2 = slot 3 → block0 + 0x18 + 3*4 = 0x50 + 0x24 = 0x74. Capture: [1,1].
  const ch = setSceneNoteChain(buf, 0, 'midi2', { start: 1, end: 1 });
  check('setSceneNoteChain(scene0,midi2,[1,1]): 0x74=1, 0x75=1', buf[0x74] === 1 && buf[0x75] === 1, `${buf[0x74]},${buf[0x75]}`);
  check('setSceneNoteChain: marks the scene defined (flag 0x01 @0x60)', buf[0x60] === 0x01);
  check('setSceneNoteChain: returns 3 offsets (slot start/end + flag)', ch.length === 3, String(ch.length));
  // synth1 = slot 0 → 0x50 + 0x18 = 0x68. Capture: [0,3].
  setSceneNoteChain(buf, 0, 'synth1', { start: 0, end: 3 });
  check('setSceneNoteChain(scene0,synth1,[0,3]): 0x68=0, 0x69=3', buf[0x68] === 0 && buf[0x69] === 3);
  // Scene 2 block sits 0x28 later (0x78); midi2 there = 0x78+0x24 = 0x9c.
  setSceneNoteChain(buf, 1, 'midi2', { start: 0, end: 0 });
  check('setSceneNoteChain(scene1): writes the 0x28-later block (midi2 @0x9c)', buf[0x9c] === 0 && buf[0x78 + 0x10] === 0x01);
  check('getSceneNoteChain round-trips scene0 midi2 → [1,1]',
    JSON.stringify(getSceneNoteChain(buf, 0, 'midi2')) === JSON.stringify({ start: 1, end: 1 }));
  check('getSceneNoteChain on an undefined scene → undefined', getSceneNoteChain(new Uint8Array(NCS_FILE_SIZE), 5, 'midi2') === undefined);
  let sThrew = false; try { setSceneNoteChain(buf, 8, 'midi2', { start: 0, end: 0 }); } catch { sThrew = true; }
  check('setSceneNoteChain beyond the device-confirmed range (scene 9) throws', sThrew);
}

// ── Drum-track → sample-slot binding (drumBinding.ts) ─────────────────
// Anchor: HARDWARE-CONFIRMED 2026-06-27 by a controlled on-device diff of
// Project 33 (export_preset before/after a single Drum-2 reassignment). The 4
// drum tracks' sample slots are 4 consecutive 0-based bytes at 0x1a278; a clean
// reload+change of Drum 2 (crash slot 7 → snare_roll slot 6) flipped ONLY
// 0x1a279 (0x07→0x06). The canonical stoken role layout is [0,1,2,3].
{
  check('DRUM_BINDING_OFFSET = 0x1a278', DRUM_BINDING_OFFSET === 0x1a278);

  // Role→slot map (Layer 2) + derived default binding.
  check('CIRCUIT_VOICE_SLOT canonical: kick=0, snare=1, closed_hat=2, ride=3, china=11',
    CIRCUIT_VOICE_SLOT.kick === 0 && CIRCUIT_VOICE_SLOT.snare === 1 && CIRCUIT_VOICE_SLOT.closed_hat === 2 &&
    CIRCUIT_VOICE_SLOT.ride === 3 && CIRCUIT_VOICE_SLOT.china === 11);
  check('DEFAULT_DRUM_BINDING derives from the 4 base voices → [0,1,2,3]',
    JSON.stringify([...DEFAULT_DRUM_BINDING]) === JSON.stringify([0, 1, 2, 3]) &&
    JSON.stringify(DRUM_TRACK_BASE_VOICES) === JSON.stringify(['kick', 'snare', 'closed_hat', 'ride']));
  check('bindingForTrackVoices maps voices → slots',
    JSON.stringify(bindingForTrackVoices(['kick', 'crash', 'tom', 'china'])) === JSON.stringify([0, 7, 8, 11]));
  check('bindingForTrackVoices rejects an unknown voice',
    (() => { try { bindingForTrackVoices(['kick', 'snare', 'closed_hat', 'zither']); return false; } catch { return true; } })());
  // Cross-dialect: a GM/SPD-SX "hat" voice resolves to the Circuit closed_hat slot.
  check('circuitSlotForVoice reconciles dialects: hat→2, "open hat"→4, kick→0',
    circuitSlotForVoice('hat') === 2 && circuitSlotForVoice('open hat') === 4 && circuitSlotForVoice('kick') === 0);
  check('circuitSlotForVoice: unknown voice → undefined', circuitSlotForVoice('didgeridoo') === undefined);
  check('bindingForTrackVoices accepts a dialect voice (hat → closed_hat slot 2)',
    JSON.stringify(bindingForTrackVoices(['kick', 'snare', 'hat', 'ride'])) === JSON.stringify([0, 1, 2, 3]));

  const buf = new Uint8Array(NCS_FILE_SIZE);
  const changed = setDrumSampleBinding(buf, [0, 1, 2, 3]);
  check('setDrumSampleBinding([0,1,2,3]) writes 00 01 02 03 at 0x1a278',
    buf[0x1a278] === 0 && buf[0x1a279] === 1 && buf[0x1a27a] === 2 && buf[0x1a27b] === 3);
  check('setDrumSampleBinding returns the 4 changed offsets',
    changed.length === 4 && changed[0] === 0x1a278 && changed[3] === 0x1a27b);
  check('getDrumSampleBinding round-trips [0,1,2,3]',
    JSON.stringify(getDrumSampleBinding(buf)) === JSON.stringify([0, 1, 2, 3]));

  // Single-track change is surgical (the Drum-2 anchor: only 0x1a279 moves).
  const buf2 = new Uint8Array(NCS_FILE_SIZE);
  setDrumSampleBinding(buf2, [0, 7, 2, 3]); // Drum 2 = crash (slot 7)
  const before = buf2.slice();
  setDrumSampleBinding(buf2, [0, 6, 2, 3]); // Drum 2 → snare_roll (slot 6)
  const diff = before.reduce((n, b, i) => (b !== buf2[i] ? n + 1 : n), 0);
  check('changing only Drum 2 moves exactly 1 byte (0x1a279)',
    diff === 1 && buf2[0x1a279] === 6, `${diff} bytes`);

  check('getDrumSampleBinding reads high slots (e.g. china = slot 11)',
    (() => { const b = new Uint8Array(NCS_FILE_SIZE); setDrumSampleBinding(b, [11, 7, 7, 8]); return getDrumSampleBinding(b)[0] === 11; })());

  let dbThrew = false; try { setDrumSampleBinding(new Uint8Array(NCS_FILE_SIZE), [0, 1, 2]); } catch { dbThrew = true; }
  check('setDrumSampleBinding with !=4 slots throws', dbThrew);
  let dbThrew2 = false; try { setDrumSampleBinding(new Uint8Array(NCS_FILE_SIZE), [0, 1, 2, 64]); } catch { dbThrew2 = true; }
  check('setDrumSampleBinding with slot > 63 throws', dbThrew2);
}

// ── authorPlanIntoProject wires the turnkey binding ──────────────────
{
  const mkPlan = (events: RealizeNoteEvent[], drum_binding?: number[]): RealizePlan => ({
    pattern_name: 'p', bpm: 120, steps: 4, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events, ...(drum_binding ? { upload: { slot: 0, drum_binding } } : {}),
  });
  const ev = (channel: number, note: number): RealizeNoteEvent => ({ channel, note, time_ms: 0, velocity: 100, duration_ms: 100 });

  // Drums authored → canonical [0,1,2,3] binding written + reported.
  const b1 = new Uint8Array(NCS_FILE_SIZE);
  const r1 = authorPlanIntoProject(b1, mkPlan([ev(10, 60)])); // kick on ch10
  check('author(drums) sets canonical binding [0,1,2,3]',
    JSON.stringify(getDrumSampleBinding(b1)) === JSON.stringify([0, 1, 2, 3]));
  check('author(drums) reports drum_binding', JSON.stringify(r1.drum_binding) === JSON.stringify([0, 1, 2, 3]));

  // Override honored.
  const b2 = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(b2, mkPlan([ev(10, 60)], [0, 7, 2, 11])); // snare-track→crash, drum4→china
  check('author(drums) honors drum_binding override',
    JSON.stringify(getDrumSampleBinding(b2)) === JSON.stringify([0, 7, 2, 11]));

  // Note-only author → does NOT write a drum binding (leaves the region as-is).
  const b3 = new Uint8Array(NCS_FILE_SIZE);
  const r3 = authorPlanIntoProject(b3, mkPlan([ev(1, 60)])); // synth1 note only
  check('author(notes only) writes no drum binding',
    r3.drum_binding === undefined && b3[DRUM_BINDING_OFFSET] === 0 && b3[DRUM_BINDING_OFFSET + 3] === 0);

  // Bad override length → validation_error, fail-fast.
  check('author with !=4 drum_binding throws',
    (() => { try { authorPlanIntoProject(new Uint8Array(NCS_FILE_SIZE), mkPlan([ev(10, 60)], [0, 1, 2])); return false; } catch { return true; } })());
}

// ── authorArrangementIntoProject: multi-section song → patterns + chain/scenes ──
{
  const ev = (channel: number, note: number, time_ms = 0): RealizeNoteEvent =>
    ({ channel, note, time_ms, velocity: 100, duration_ms: 100 });
  const mkPlan = (name: string, events: RealizeNoteEvent[], steps = 16): RealizePlan => ({
    pattern_name: name, bpm: 120, steps, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000, events,
  });

  // CHAIN mode: 3 occurrences (verse ×2 + chorus) ≤ 8 slots → duplicate slots + chain [0,2].
  {
    const verse = mkPlan('verse', [ev(10, 60), ev(4, 38, 500)]);          // kick + a MIDI2 note
    const chorus = mkPlan('chorus', [ev(10, 62), ev(1, 48)], 8);          // snare pad + synth1, 8 steps
    const b = new Uint8Array(NCS_FILE_SIZE);
    const r = authorArrangementIntoProject(b, [
      { name: 'verse', plan: verse }, { name: 'chorus', plan: chorus },
    ], [0, 0, 1]);
    check('arrangement chain: layout kind=chain, slots [verse,verse,chorus]',
      r.layout.kind === 'chain' && JSON.stringify(r.layout.slots) === '["verse","verse","chorus"]', JSON.stringify(r.layout));
    check('arrangement chain: verse kick authored in patterns 0 AND 1 (duplicate slots)',
      decodeDrumPattern(b, 0, 0)[0].active && decodeDrumPattern(b, 0, 1)[0].active);
    check('arrangement chain: chorus snare-pad (Drum2) in pattern 2 only',
      decodeDrumPattern(b, 1, 2)[0].active && !decodeDrumPattern(b, 1, 0)[0].active);
    check('arrangement chain: every authored note track chained [0,2]',
      JSON.stringify(getNoteChain(b, 'midi2')) === '{"start":0,"end":2}' &&
      JSON.stringify(getNoteChain(b, 'synth1')) === '{"start":0,"end":2}');
    // Empty-fill: chorus has no MIDI2 content — pattern 2 must be SILENT there,
    // and verse has no synth1 — patterns 0/1 silent on synth1.
    check('arrangement chain: empty-fill silences midi2 in the chorus slot',
      decodeNotePattern(b, 'midi2', 2).every((s) => !s.active) &&
      decodeNotePattern(b, 'midi2', 0)[4].active);
    check('arrangement chain: empty-fill silences synth1 in the verse slots',
      decodeNotePattern(b, 'synth1', 0).every((s) => !s.active) &&
      decodeNotePattern(b, 'synth1', 2)[0].active);
    // Per-pattern lengths: verse 16 steps, chorus 8.
    check('arrangement chain: per-pattern lengths (16,16,8) incl. empty-fill tracks',
      b[META_OFFSETS[drumBlockIndex(0, 0)]] === 15 && b[META_OFFSETS[drumBlockIndex(0, 2)]] === 7);
    check('arrangement chain: single section → kind single, no chain',
      authorArrangementIntoProject(new Uint8Array(NCS_FILE_SIZE), [{ name: 'a', plan: verse }], [0]).layout.kind === 'single');

    // 5th param `drumBinding`: project-global override, same contract as
    // authorPlanIntoProject's plan.upload.drum_binding (tested above).
    const bOverride = new Uint8Array(NCS_FILE_SIZE);
    authorArrangementIntoProject(bOverride, [
      { name: 'verse', plan: verse }, { name: 'chorus', plan: chorus },
    ], [0, 0, 1], undefined, [0, 7, 2, 11]);
    check('arrangement: drumBinding override honored (Drum2=crash slot7, Drum4=china slot11)',
      JSON.stringify(getDrumSampleBinding(bOverride)) === JSON.stringify([0, 7, 2, 11]));
    check('arrangement: drumBinding defaults to canonical [0,1,2,3] when omitted',
      JSON.stringify(getDrumSampleBinding(b)) === JSON.stringify([0, 1, 2, 3]));
  }

  // SCENES mode: 9 plays don't fit the 8-slot chain; runs compress to ≤4 scenes.
  {
    const a = mkPlan('A', [ev(10, 60)]);
    const bPlan = mkPlan('B', [ev(10, 62)]);
    // order: A B A B A B A B A → 9 plays, runs = [0,1]×4 + [0] = 5 runs → REFUSED.
    check('arrangement: 5 scene runs refused honestly',
      (() => {
        try {
          authorArrangementIntoProject(new Uint8Array(NCS_FILE_SIZE),
            [{ name: 'A', plan: a }, { name: 'B', plan: bPlan }], [0, 1, 0, 1, 0, 1, 0, 1, 0]);
          return false;
        } catch { return true; }
      })());
    // order: [0,1] ×4 + tail dropped → 8 plays fits the chain, no scenes needed.
    // A real scenes case: 3 sections, order A B C A B C A B C = 9 plays,
    // runs = [0..2]×3 = 3 scenes.
    const c = mkPlan('C', [ev(10, 65)]);
    const buf = new Uint8Array(NCS_FILE_SIZE);
    const r = authorArrangementIntoProject(buf,
      [{ name: 'A', plan: a }, { name: 'B', plan: bPlan }, { name: 'C', plan: c }],
      [0, 1, 2, 0, 1, 2, 0, 1, 2]);
    check('arrangement scenes: kind=scenes, 3 runs of [0,2]',
      r.layout.kind === 'scenes' && r.layout.scenes!.length === 3 &&
      r.layout.scenes!.every((s) => s.start === 0 && s.end === 2), JSON.stringify(r.layout));
    check('arrangement scenes: unique sections authored once (A kick p0, B snare p1, C clap p2)',
      decodeDrumPattern(buf, 0, 0)[0].active && decodeDrumPattern(buf, 1, 1)[0].active && decodeDrumPattern(buf, 3, 2)[0].active);
    check('arrangement scenes: scene drum selections [0,2] on all 3 scenes',
      [0, 1, 2].every((sc) => JSON.stringify(getSceneDrumChain(buf, sc, 0)) === '{"start":0,"end":2}'));
    check('arrangement scenes: scene-chain end = 3 scenes', getSceneChainEnd(buf) === 3);
  }
}

// ── apply_pattern plumbing: compileToPlan forwards upload.drum_binding ──
// setDrumSampleBinding + authorPlanIntoProject/authorArrangementIntoProject
// were already wired (tested above); the actual gap was one layer up:
// apply_pattern's tool schema and the dispatcher's CompileOptions.upload
// never carried a caller-supplied override through to RealizePlan.upload.
// Golden-lock the identity passthrough so a future refactor can't silently
// drop it again (compileToPlan just spreads opts.upload onto the plan).
{
  const pattern: NeutralPattern = {
    name: 'plumbing', steps: 4, bars: 1,
    voices: { kick: { steps: [{ on: true }, { on: false }, { on: false }, { on: false }] } },
  };
  const withOverride = compileToPlan(pattern, CIRCUIT_TRACKS_DESCRIPTOR.capabilities, {
    bpm: 120, mode: 'ncs_upload', upload: { slot: 5, drum_binding: [0, 7, 2, 11] },
  });
  check('compileToPlan forwards upload.drum_binding unchanged',
    JSON.stringify(withOverride.upload?.drum_binding) === JSON.stringify([0, 7, 2, 11]), JSON.stringify(withOverride.upload));
  const withoutOverride = compileToPlan(pattern, CIRCUIT_TRACKS_DESCRIPTOR.capabilities, {
    bpm: 120, mode: 'ncs_upload', upload: { slot: 5 },
  });
  check('compileToPlan: drum_binding absent stays undefined (not defaulted at this layer)',
    withoutOverride.upload?.drum_binding === undefined);
}

// ── dry_run: author + fit-check with ZERO device I/O ──────────────────
await (async () => {
  const ev = (channel: number, note: number, time_ms = 0): RealizeNoteEvent =>
    ({ channel, note, time_ms, velocity: 100, duration_ms: 100 });
  const mkPlan = (upload: NonNullable<RealizePlan['upload']>): RealizePlan => ({
    pattern_name: 'dry', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [ev(10, 60), ev(1, 48, 500)], upload,
  });
  // A stub connection that THROWS on any send — proof a dry run never talks
  // to the device (and hasInput:false proves the ACK gate is skipped too).
  const forbidden = () => { throw new Error('dry_run touched the device'); };
  const stubCtx = {
    conn: { hasInput: false, send: forbidden, request: forbidden },
    reconnect: () => { throw new Error('dry_run reconnected'); },
  } as unknown as Parameters<NonNullable<typeof circuitWriter.realizePattern>>[0];

  const template = join(tmpdir(), `verify-ncs-dry-${process.pid}.ncs`);
  // Structurally valid, not merely the right length: the template gate
  // (`assertNcsTemplate`, 2026-07-29) refuses a file that is the right size and
  // is not a project, which an all-zero buffer is. See `blankProject`.
  writeFileSync(template, blankProject());
  try {
    const single = await circuitWriter.realizePattern!(stubCtx, mkPlan({ template_path: template, slot: 5, dry_run: true }));
    check('dry_run (single): ok, status dry_run, zero device I/O',
      single.ok === true && single.status === 'dry_run', JSON.stringify(single));
    check('dry_run (single): receipt names tracks + the would-be slot',
      /Drum1/.test(single.info ?? '') && /synth1/.test(single.info ?? '') && /slot 5/.test(single.info ?? ''), single.info);

    const arr = await circuitWriter.realizeArrangement!(
      stubCtx,
      [
        { name: 'verse', plan: mkPlan({ template_path: template, slot: 5, dry_run: true }) },
        { name: 'chorus', plan: mkPlan({ template_path: template, slot: 5, dry_run: true }) },
      ],
      [0, 1],
      { template_path: template, slot: 5, dry_run: true },
    );
    check('dry_run (arrangement): ok, status dry_run, fit reported',
      arr.ok === true && arr.status === 'dry_run' && /FITS/.test(arr.info ?? ''), JSON.stringify(arr));
    check('dry_run (arrangement): layout described (pattern 1=verse, chain advance)',
      /pattern 1=verse/.test(arr.info ?? '') && /pattern chain/.test(arr.info ?? ''), arr.info);
  } finally {
    rmSync(template, { force: true });
  }

  // ── upload.preserve_template_gates: the TOOL-surface default ─────────────
  // The plan-level flag is what `apply_pattern preserve_template_gates` sets.
  // Omitted must mean PRESERVE, because the destructive direction (flatten the
  // maintainer's hand-set note lengths and ties) is the one you have to ask for.
  const droneLane = noteStepBase('midi1', 0) + 5;
  const withDrone = blankProject();   // written out as a TEMPLATE below, so it must pass the gate
  setNoteStep(withDrone, 'midi1', 0, 0, [{ note: 60, gate: 96, tie: true }]);
  setNoteStep(withDrone, 'midi1', 0, 16, [{ note: 60, gate: 12 }]);
  const tpl2 = join(tmpdir(), `verify-ncs-gates-${process.pid}.ncs`);
  writeFileSync(tpl2, withDrone);
  const reauthor = (upload: Partial<NonNullable<RealizePlan['upload']>>): RealizePlan => ({
    pattern_name: 'reauthor', bpm: 120, steps: 32, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 4000,
    events: [ev(3, 60, 0), ev(3, 60, 2000)],
    upload: { template_path: tpl2, slot: 5, dry_run: true, ...upload },
  });
  try {
    const kept = await circuitWriter.realizePattern!(stubCtx, reauthor({}));
    check('upload.preserve_template_gates omitted = PRESERVE (the hand-set drone survives)',
      /Kept 2 hand-set note length\(s\).*including 1 tied/.test(kept.info ?? ''), kept.info);
    const flattened = await circuitWriter.realizePattern!(stubCtx, reauthor({ preserve_template_gates: false }));
    check('upload.preserve_template_gates:false is the OPT-OUT, and it says nothing was kept',
      !/Kept \d+ hand-set/.test(flattened.info ?? ''), flattened.info);
    const explicitTrue = await circuitWriter.realizePattern!(stubCtx, reauthor({ preserve_template_gates: true }));
    check('upload.preserve_template_gates:true behaves exactly like omitting it',
      (explicitTrue.info ?? '') === (kept.info ?? ''));
    // Prove the flag reaches the BYTES, not just the receipt wording.
    const flatBuf = withDrone.slice();
    authorPlanIntoProject(flatBuf, reauthor({}), undefined, 0, false);
    const keptBuf = withDrone.slice();
    authorPlanIntoProject(keptBuf, reauthor({}), undefined, 0, true);
    check('preserve_template_gates reaches the stored byte: 224 kept vs flattened to 6',
      keptBuf[droneLane] === 224 && flatBuf[droneLane] === 6,
      `kept=${keptBuf[droneLane]} flat=${flatBuf[droneLane]}`);
  } finally {
    rmSync(tpl2, { force: true });
  }
})();

// ── Sample-directory READ, re-decoded 2026-07-09 (sampleDirectory.ts) ──
// Literal bytes lifted directly from samples/captured/get_pack_from_circuit_tracks.pcapng
// (Novation Components "Get Pack from Circuit Tracks", a genuine READ action;
// decoded via scripts/_research/decode-circuit-usbmidi.py). Anchors the parser
// + request-builder byte-exactly, and the mocked round trip below golden-locks
// the safety property this whole re-decode exists for: the listing NEVER sends
// a WRITE_INIT/DATA/FINISH/SET_FILENAME frame (the destructive 2026-06-27 bug).
{
  const SUB = TRANSFER_SUB_CONSTANTS.SUBCMD;

  // DIR_CONTROL reply headers (sub 0x0b): project 52 entries, patch-bank 16.
  const projectHeader = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0b, 0x03, 0x00, 0x34, 0x00, 0xf7];
  const ph = parseDirListHeader(projectHeader);
  check('parseDirListHeader: project dir header → fileType 3, pack 0, count 52',
    ph?.fileType === 0x03 && ph?.pack === 0 && ph?.count === 52, JSON.stringify(ph));

  const patchHeader = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0b, 0x04, 0x00, 0x10, 0x00, 0xf7];
  const pph = parseDirListHeader(patchHeader);
  check('parseDirListHeader: patch-bank dir header → fileType 4, pack 0, count 16',
    pph?.fileType === 0x04 && pph?.pack === 0 && pph?.count === 16, JSON.stringify(pph));

  check('parseDirListHeader: rejects a non-DIR_CONTROL message',
    parseDirListHeader([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0c, 0, 0, 0, 0xf7]) === undefined);

  // DIR_ENTRY replies (sub 0x0c): project slot 0, patch-bank slot 5.
  const name0 = [...'00_Hello Tracks.ncs'].map((c) => c.charCodeAt(0));
  const entry0 = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0c, 0x03, 0x00, 0x00, ...name0, 0xf7];
  const e0 = parseDirEntry(entry0);
  check('parseDirEntry: project slot 0 → "00_Hello Tracks.ncs"',
    e0?.fileType === 0x03 && e0?.pack === 0 && e0?.slot === 0 && e0?.name === '00_Hello Tracks.ncs', JSON.stringify(e0));

  const name5 = [...'05_PATCHBANK.cpb'].map((c) => c.charCodeAt(0));
  const entry5 = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0c, 0x04, 0x00, 0x05, ...name5, 0xf7];
  const e5 = parseDirEntry(entry5);
  check('parseDirEntry: patch-bank slot 5 → "05_PATCHBANK.cpb"',
    e5?.fileType === 0x04 && e5?.pack === 0 && e5?.slot === 5 && e5?.name === '05_PATCHBANK.cpb', JSON.stringify(e5));

  check('parseDirEntry: rejects a non-DIR_ENTRY message', parseDirEntry(projectHeader) === undefined);

  check('fileIdFor builds the shared [fileType,pack,slot] shape',
    JSON.stringify(fileIdFor(0x05, 0, 11)) === JSON.stringify([0x05, 0, 11]));

  // Per-file READ REQUEST: byte-exact vs the capture's sample slot-0 request,
  // and the project slot-7 request (same shape, only fileType/slot differ).
  const reqSample0 = buildReadFileRequest(SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE, 0, 0);
  const capturedSample0 = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x02, 0xf7];
  check('buildReadFileRequest(sample, pack0, slot0) byte-exact vs the capture',
    JSON.stringify(reqSample0) === JSON.stringify(capturedSample0),
    reqSample0.map((b) => b.toString(16).padStart(2, '0')).join(' '));

  const reqProject7 = buildReadFileRequest(SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_PROJECT, 0, 7);
  const capturedProject7 = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x07, 0x02, 0xf7];
  check('buildReadFileRequest(project, pack0, slot7) byte-exact vs the capture',
    JSON.stringify(reqProject7) === JSON.stringify(capturedProject7));

  // ── scanPatternOccupancy (2026-07-17): all 8 patterns, not just pattern 1 ──
  // get_preset decodes only the PLAYED pattern (1). When pattern 1 is silent by
  // design (an intro, or a project_plan `starts_silent` layout), the old readback
  // said "empty" and was indistinguishable from a failed write. The scan reports
  // where content actually lives so success ≠ "nothing landed". In-memory, so no
  // extra wire cost. Built on the same setDrumStep/setNotePattern writers used above.
  {
    // Content ONLY in pattern 3 (drum1) and pattern 4 (synth1) — pattern 1 silent.
    const p = new Uint8Array(NCS_FILE_SIZE);
    setDrumStep(p, 0, 2, 0, { active: true, velocity: 100 });          // drum1, pattern 3 (0-based 2)
    setNotePattern(p, 'synth1', 3, [{ note: 60 }]);                     // synth1, pattern 4 (0-based 3)
    const occ = scanPatternOccupancy(p);
    check('scanPatternOccupancy: total = 8', occ.total === 8);
    check('scanPatternOccupancy: occupied = [3, 4] (union across tracks, 1-based)',
      JSON.stringify(occ.occupied) === JSON.stringify([3, 4]), JSON.stringify(occ.occupied));
    check('scanPatternOccupancy: pattern 1 is NOT in the occupied set (it is silent)',
      !occ.occupied.includes(1));
    check('scanPatternOccupancy: by_track pins drum1→[3], synth1→[4]',
      JSON.stringify(occ.by_track.drum1) === JSON.stringify([3]) && JSON.stringify(occ.by_track.synth1) === JSON.stringify([4]),
      JSON.stringify(occ.by_track));
    check('scanPatternOccupancy: a silent track is absent from by_track (no drum2 key)',
      occ.by_track.drum2 === undefined && occ.by_track.midi1 === undefined);

    // Content IN pattern 1 → the normal case.
    const p1 = new Uint8Array(NCS_FILE_SIZE);
    setDrumStep(p1, 0, 0, 0, { active: true });
    check('scanPatternOccupancy: content in pattern 1 → occupied includes 1',
      scanPatternOccupancy(p1).occupied.includes(1));

    // A truly empty project → occupied [] (the ONLY case that is genuinely empty).
    check('scanPatternOccupancy: empty project → occupied [] (distinguishes empty from silent-pattern-1)',
      JSON.stringify(scanPatternOccupancy(new Uint8Array(NCS_FILE_SIZE)).occupied) === JSON.stringify([]));
  }

  // ── readSampleDirectory: full mocked round trip, no hardware ──
  // A scripted MidiConnection stub: replies are keyed off what was just sent,
  // queued for the NEXT matching receive (mirrors the real register-before-send
  // ordering readSampleDirectory uses). Backlog is a deliberate simplification
  // of the real transport (which drops unmatched messages instead of queueing
  // them) so a message that arrives before anyone is listening for it can
  // still be picked up later — exactly the "stale reply sitting in the queue"
  // shape the 2026-07-10 prelude-desync bug needs to reproduce. `register`
  // honors a real timeout (via setTimeout) so production's best-effort drain
  // step doesn't hang the test when there is nothing queued to drain.
  function makeMockDirConn(scriptedReply: (msg: number[]) => number[][] | undefined): { conn: MidiConnection; sent: number[][] } {
    const sent: number[][] = [];
    const backlog: number[][] = [];
    const waiters: { predicate: (m: number[]) => boolean; resolve: (v: number[]) => void; timer?: ReturnType<typeof setTimeout> }[] = [];
    function deliver(msg: number[]): void {
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx !== -1) {
        const w = waiters.splice(idx, 1)[0];
        if (w.timer) clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        backlog.push(msg);
      }
    }
    function register(predicate: (m: number[]) => boolean, timeoutMs?: number): Promise<number[]> {
      const idx = backlog.findIndex(predicate);
      if (idx !== -1) return Promise.resolve(backlog.splice(idx, 1)[0]);
      return new Promise<number[]>((resolve, reject) => {
        const waiter: { predicate: (m: number[]) => boolean; resolve: (v: number[]) => void; timer?: ReturnType<typeof setTimeout> } =
          { predicate, resolve };
        waiters.push(waiter);
        if (timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i !== -1) waiters.splice(i, 1);
            reject(new Error('mock receive timeout'));
          }, timeoutMs);
        }
      });
    }
    const conn = {
      hasInput: true,
      send: (bytes: number[]) => {
        sent.push(bytes);
        const replies = scriptedReply(bytes);
        if (replies) for (const r of replies) deliver(r);
      },
      receiveSysEx: (t?: number) => register(() => true, t),
      receiveSysExMatching: (predicate: (m: number[]) => boolean, t?: number) => register(predicate, t),
    } as unknown as MidiConnection;
    return { conn, sent };
  }

  await (async () => {
    const { conn, sent } = makeMockDirConn((bytes) => {
      if (bytes[7] === SUB.DIR_CONTROL && bytes[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE) {
        const kick = [...'kick'].map((c) => c.charCodeAt(0));
        const snare = [...'snare'].map((c) => c.charCodeAt(0));
        return [
          makeMessage(SUB.DIR_CONTROL, [0x05, 0x00, 0x02, 0x00]), // count = 2
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x05, 0x00, 0x03, ...kick]),  // slot 3
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x05, 0x00, 0x0a, ...snare]), // slot 10
        ];
      }
      // OPEN_SESSION / QUERY_INFO / the two probe DIR_CONTROL calls: any placeholder reply.
      return [makeMessage(SUB.ACK, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
    });

    const result = await readSampleDirectory(conn);
    check('readSampleDirectory (mocked): occupied=2, total=64',
      result.occupied === 2 && result.total === 64, JSON.stringify({ occupied: result.occupied, total: result.total }));
    check('readSampleDirectory (mocked): slot 3 = "kick", slot 10 = "snare"',
      result.slots[3].name === 'kick' && result.slots[10].name === 'snare');
    check('readSampleDirectory (mocked): unlisted slots stay empty (e.g. slot 0)',
      result.slots[0].name === undefined && result.slots[0].device_slot === 1);
    check('readSampleDirectory (mocked): carries the hardware-confirmed listing caveat',
      /hardware-confirmed/i.test(result.capacity_note ?? ''), result.capacity_note);
    check('readSampleDirectory (mocked): NEVER sends WRITE_INIT/DATA/FINISH/SET_FILENAME (the 2026-06-27 destructive shape)',
      sent.every((m) => !([SUB.WRITE_INIT, SUB.WRITE_DATA, SUB.WRITE_FINISH, SUB.SET_FILENAME] as number[]).includes(m[7])));
    check('readSampleDirectory (mocked): closes the session',
      sent[sent.length - 1][7] === SUB.CLOSE_SESSION);
  })();

  // ── readSampleDirectory PACK-AWARE (2026-07-17): pack N reads pack N's pool ──
  // The cross-pack name-mismatch trap (read Pack 1's names, write the project to
  // Pack 5, wrong samples play) is closed by threading `pack` into the listing.
  // This proves: (a) the listing request carries the chosen pack byte, (b) only
  // replies for THAT pack are accepted, and a wrong-pack straggler is ignored,
  // (c) the result reports the pack and the CURRENT nonzero-pack status.
  //
  // (c) changed 2026-07-27. It used to assert the note called the nonzero-pack
  // path "community-beta"; the nonzero-pack sample WRITE was hardware-confirmed
  // that day (63 slots cloned onto Pack 2, read back byte-identical, and an
  // out-of-order write landing at its own index proving the slot byte is
  // addressed), so that assertion was pinning a claim that had become false.
  // The replacement pins the corrected claim in BOTH directions: the confirmed
  // status word must be present AND the retired one absent, so neither a silent
  // revert of the note nor a silent revert of this check can pass.
  await (async () => {
    const WIRE_PACK = 4; // device "Pack 5"
    const { conn, sent } = makeMockDirConn((bytes) => {
      if (bytes[7] === SUB.DIR_CONTROL && bytes[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE) {
        const kik5 = [...'kick_p5'].map((c) => c.charCodeAt(0));
        return [
          // A wrong-pack straggler FIRST (pack 0 header): the matcher must skip it.
          makeMessage(SUB.DIR_CONTROL, [0x05, 0x00, 0x01, 0x00]),
          // A wrong-pack entry too (pack 0, slot 0): must not be accepted.
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x05, 0x00, 0x00, ...[...'WRONG'].map((c) => c.charCodeAt(0))]),
          // The REAL pack-4 header (count 1) + its one entry.
          makeMessage(SUB.DIR_CONTROL, [0x05, WIRE_PACK, 0x01, 0x00]),
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x05, WIRE_PACK, 0x07, ...kik5]), // slot 7
        ];
      }
      return [makeMessage(SUB.ACK, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
    });

    const result = await readSampleDirectory(conn, WIRE_PACK);
    const listing = sent.find((m) => m[7] === SUB.DIR_CONTROL && m[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE);
    check('readSampleDirectory(pack 4): listing request carries the chosen pack byte',
      listing !== undefined && listing[9] === WIRE_PACK, JSON.stringify(listing));
    check('readSampleDirectory(pack 4): reads pack-4 slot 7 = "kick_p5" (wrong-pack straggler skipped)',
      result.slots[7].name === 'kick_p5' && result.occupied === 1, JSON.stringify({ occupied: result.occupied, s7: result.slots[7].name }));
    check('readSampleDirectory(pack 4): the wrong-pack entry did NOT land on slot 0',
      result.slots[0].name === undefined);
    check('readSampleDirectory(pack 4): result reports pack 4 (0-based wire)',
      result.pack === WIRE_PACK, JSON.stringify(result.pack));
    check('readSampleDirectory(pack 4): capacity_note reports the nonzero-pack WRITE as hardware-confirmed, and no longer as community-beta',
      /nonzero-pack sample WRITE is hardware-confirmed/i.test(result.capacity_note ?? '')
      && !/community-beta/i.test(result.capacity_note ?? ''), result.capacity_note);
    check('readSampleDirectory(pack 4): capacity_note warns that a verification read races the ~6-8 s manifest flush',
      /6-8 s|6-8s/i.test(result.capacity_note ?? ''), result.capacity_note);
  })();

  // ── readProjectDirectory (2026-07-17): pack occupancy in ONE round trip ──
  // The project directory (fileType 0x03) reuses the SAME listing machinery the
  // sample directory does, so this proves the shared core is fileType-correct:
  // the listing request carries 0x03 (not 0x05), and occupied project slots come
  // back by name in one exchange (no get_preset-per-slot).
  await (async () => {
    const { conn, sent } = makeMockDirConn((bytes) => {
      if (bytes[7] === SUB.DIR_CONTROL && bytes[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_PROJECT) {
        const nm = (s: string) => [...s].map((c) => c.charCodeAt(0));
        return [
          makeMessage(SUB.DIR_CONTROL, [0x03, 0x00, 0x02, 0x00]), // fileType 3, pack 0, count 2
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x03, 0x00, 0x00, ...nm('00_Intro.ncs')]),
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x03, 0x00, 0x05, ...nm('05_Verse.ncs')]),
        ];
      }
      return [makeMessage(SUB.ACK, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
    });
    const dir = await readProjectDirectory(conn);
    const listing = sent.find((m) => m[7] === SUB.DIR_CONTROL && (m[8] === 0x03 || m[8] === 0x05));
    check('readProjectDirectory: listing request uses fileType 0x03 (project), not 0x05 (sample)',
      listing !== undefined && listing[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_PROJECT, JSON.stringify(listing?.slice(7, 10)));
    check('readProjectDirectory: occupied=2, total=64',
      dir.occupied === 2 && dir.total === 64, JSON.stringify({ occupied: dir.occupied, total: dir.total }));
    check('readProjectDirectory: slot 0 = "00_Intro.ncs", slot 5 = "05_Verse.ncs"',
      dir.slots[0].name === '00_Intro.ncs' && dir.slots[5].name === '05_Verse.ncs');
    check('readProjectDirectory: an unlisted slot is empty', dir.slots[1].name === undefined);
    check('readProjectDirectory: NEVER sends a WRITE frame (non-destructive listing)',
      sent.every((m) => !([SUB.WRITE_INIT, SUB.WRITE_DATA, SUB.WRITE_FINISH, SUB.SET_FILENAME] as number[]).includes(m[7])));
    check('readProjectDirectory: closes the session', sent[sent.length - 1][7] === SUB.CLOSE_SESSION);

    // Through the descriptor's scan_locations: filters the whole-pack listing to a range.
    const storageCtx = { conn: (makeMockDirConn((bytes) => {
      if (bytes[7] === SUB.DIR_CONTROL && bytes[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_PROJECT) {
        const nm = (s: string) => [...s].map((c) => c.charCodeAt(0));
        return [
          makeMessage(SUB.DIR_CONTROL, [0x03, 0x00, 0x02, 0x00]),
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x03, 0x00, 0x02, ...nm('02_Chorus.ncs')]),
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x03, 0x00, 0x09, ...nm('09_Outro.ncs')]),
        ];
      }
      return [makeMessage(SUB.ACK, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
    })).conn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as import('@mcp-midi-control/core/protocol-generic/types.js').DispatchCtx;
    // Projects are addressed as the DEVICE numbers them (1..64) and converted to
    // the 0..63 wire slot inside the reader. So projects 1..5 are wire slots
    // 0..4, which is the range this mock's directory reply covers.
    //
    // Watch the two numbering systems here, because they genuinely differ: the
    // mock puts an entry on WIRE slot 2, whose stored filename is "02_Chorus.ncs"
    // (the device names its files 0-based), and that comes back as device-shown
    // location "3". A filename and a location that disagree by one is correct.
    const scan = await CIRCUIT_TRACKS_DESCRIPTOR.reader.scanLocations!(storageCtx, 1, 5);
    check('scan_locations(1..5): returns exactly the requested range (5 projects)', scan.scanned.length === 5);
    check('scan_locations(1..5): wire slot 2 reports as project 3, named "02_Chorus.ncs"',
      scan.scanned[2].location === '3' && scan.scanned[2].name === '02_Chorus.ncs' && scan.scanned[2].is_empty === false);
    check('scan_locations(1..5): project 1 (wire slot 0) is empty', scan.scanned[0].is_empty === true);
    check('scan_locations(1..5): out-of-range wire slot 9 is NOT included', scan.scanned.every((s) => Number(s.location) <= 5));
  })();

  // ── readSampleDirectory: STALE PRELUDE REPLY does not desync the listing
  // (2026-07-10 hardware bug: occupied=0 on a real 64-sample pack) ──
  // Byte-cited from the 2026-07-10 bench diagnostic: a short, non-listing
  // DIR_CONTROL reply — `f0 00 20 29 01 64 03 0b 02 05 f7` (sub=0x0b, but
  // msg[8]=0x02, only 11 bytes) — was still sitting in the receive queue when
  // the listing phase opened. The queue then also held the REAL sample
  // listing header (`0b 05 00 40 00` — fileType=SAMPLE, pack 0, count
  // 0x40=64) and all 64 DIR_ENTRY replies with names matching Components
  // ("00_PCM.wav", "01_stoken_4_02_kick2.wav", ...). Placing the stale frame
  // FIRST in the mock's delivery order (ahead of the real header) reproduces
  // exactly the ordering the bug hit: the OLD loose matcher
  // (`m[7] === SUB.DIR_CONTROL`) would have consumed the stale frame and
  // returned occupied=0; the fixed STRICT matcher must skip it and still find
  // the real header + all 64 entries.
  await (async () => {
    const STALE_HEADER_FRAME = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0b, 0x02, 0x05, 0xf7];
    check('stale frame fixture matches the bench diagnostic byte-for-byte',
      JSON.stringify(STALE_HEADER_FRAME) === JSON.stringify([0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, 0x0b, 0x02, 0x05, 0xf7]));
    check('stale frame is too short to be a well-formed listing header (11 < 13 bytes)',
      STALE_HEADER_FRAME.length === 11 && STALE_HEADER_FRAME.length < 13);
    check('parseDirListHeader rejects the stale frame outright', parseDirListHeader(STALE_HEADER_FRAME) === undefined);

    // Slots 0/1 are the exact names cited in the 2026-07-10 bench diagnostic
    // ("samples pack 0 ... correct names (00_PCM.wav,
    // 01_stoken_4_02_kick2.wav, ...)"); the remaining 62 are synthetic filler
    // so the round trip exercises the full 64-entry count the device reported.
    const names = Array.from({ length: 64 }, (_, i) => {
      if (i === 0) return '00_PCM.wav';
      if (i === 1) return '01_stoken_4_02_kick2.wav';
      return `${String(i).padStart(2, '0')}_sample.wav`;
    });

    const { conn, sent } = makeMockDirConn((bytes) => {
      if (bytes[7] === SUB.DIR_CONTROL && bytes[8] === SAMPLE_DIRECTORY_CONSTANTS.FILE_TYPE_SAMPLE) {
        const realHeader = makeMessage(SUB.DIR_CONTROL, [0x05, 0x00, 0x40, 0x00]); // count 0x40 = 64
        const entries = names.map((name, slot) =>
          makeMessage(SAMPLE_DIRECTORY_CONSTANTS.DIR_ENTRY, [0x05, 0x00, slot, ...[...name].map((c) => c.charCodeAt(0))]));
        // Stale frame arrives FIRST, ahead of the real header + all 64 entries.
        return [STALE_HEADER_FRAME, realHeader, ...entries];
      }
      return [makeMessage(SUB.ACK, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])];
    });

    const result = await readSampleDirectory(conn);
    check('readSampleDirectory (stale-frame mocked): occupied=64, total=64 (matcher skipped the stale frame)',
      result.occupied === 64 && result.total === 64, JSON.stringify({ occupied: result.occupied, total: result.total }));
    check('readSampleDirectory (stale-frame mocked): slot 0 = "00_PCM.wav"',
      result.slots[0].name === '00_PCM.wav', result.slots[0].name);
    check('readSampleDirectory (stale-frame mocked): every slot 0..63 has the expected name',
      names.every((name, i) => result.slots[i].name === name));
    check('readSampleDirectory (stale-frame mocked): carries the hardware-confirmed listing caveat',
      /hardware-confirmed/i.test(result.capacity_note ?? ''), result.capacity_note);
    check('readSampleDirectory (stale-frame mocked): NEVER sends WRITE_INIT/DATA/FINISH/SET_FILENAME',
      sent.every((m) => !([SUB.WRITE_INIT, SUB.WRITE_DATA, SUB.WRITE_FINISH, SUB.SET_FILENAME] as number[]).includes(m[7])));
    check('readSampleDirectory (stale-frame mocked): closes the session',
      sent[sent.length - 1][7] === SUB.CLOSE_SESSION);
  })();
}

// ── Name-match resolver: sample directory → roles → binding (sampleRoles.ts) ──
{
  const dir = (names: (string | undefined)[]) => ({
    occupied: names.filter(Boolean).length, total: 64, pack: 0,
    slots: names.map((name, i) => ({ slot: i, device_slot: i + 1, ...(name ? { name } : {}) })),
  });

  check('roleOfSampleName strips index prefix + resolves dialect',
    roleOfSampleName('01_kick') === 'kick' && roleOfSampleName('closed hat') === 'closed_hat' &&
    roleOfSampleName('garbage') === undefined);

  // Our role-ordered kit (01_kick..04_ride) → exact [0,1,2,3], no fallbacks.
  const ours = bindingFromDirectory(dir(['01_kick', '02_snare', '03_closed_hat', '04_ride', '05_open_hat']));
  check('bindingFromDirectory(role-ordered kit) → [0,1,2,3], no fallbacks',
    JSON.stringify(ours.binding) === JSON.stringify([0, 1, 2, 3]) && ours.fallbacks.length === 0);

  // Roles in a SHUFFLED layout are found by name, not position.
  const shuffled = bindingFromDirectory(dir(['ride', 'kick', 'open hat', 'snare', 'closed_hat']));
  check('bindingFromDirectory(shuffled) name-matches: kick@1, snare@3, closed_hat@4, ride@0',
    JSON.stringify(shuffled.binding) === JSON.stringify([1, 3, 4, 0]) && shuffled.fallbacks.length === 0);

  // A missing role falls back to the canonical slot + is reported.
  const partial = bindingFromDirectory(dir(['kick', 'snare', undefined, 'ride']));
  check('bindingFromDirectory(missing closed_hat) falls back to canonical slot 2 + reports track 2',
    partial.binding[2] === CIRCUIT_VOICE_SLOT.closed_hat && partial.fallbacks.includes(2));

  check('rolesByDirectory maps name→slot (kick at slot 5)',
    rolesByDirectory(dir([undefined, undefined, undefined, undefined, undefined, 'kick'])).get('kick')?.[0] === 5);
}

// ── Pack addressing + pack directory goldens ──────────────────────────
//
// The mechanical guard against re-introducing the pre-2026-07-16 septet model,
// which read the fileId's middle byte as (slot >> 7) and silently pinned every
// transfer to Pack 1.
//
// EVIDENCE TIERS (do not conflate):
//  - CAPTURE-EXACT: the parser + header/entry checks use byte strings lifted
//    verbatim from real Components captures in samples/captured/ (see
//    packDirectory.ts "Evidence"), plus the 0b 02 05 frame off the maintainer's
//    own 5-pack device.
//  - GENERALIZED: the pack-2/pack-4 fileId + buildUploadFrames checks assert the
//    decoded byte POSITION for fileType/pack combinations no capture contains
//    (no capture shows a project write to pack 2 or 4). They encode the
//    "positional, not a type quirk" claim the two captures jointly support, not
//    literal observed bytes. Sound, but an inference — flagged, not smuggled in.
//
// The PURE layer is below; the async I/O driver (readPackDirectory's prelude
// sequencing, matcher races, entry loop) is pinned in its own section further
// down, added 2026-07-16 to close the gap flagged in circuit-pack-addressing.md §6.
{
  const SYX = (...tail: number[]) => [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, ...tail, 0xf7];

  // fileId = [fileType, pack, slot]. Pack 0 default keeps every legacy byte.
  check('fileId(slot) defaults to pack 0 (byte-identical to the pre-fix septet model for all legal slots 0..63)',
    [0, 1, 42, 63].every((s) => {
      const f = fileId(s);
      return f[0] === 0x03 && f[1] === 0x00 && f[2] === s && f[1] === ((s >> 7) & 0x7f);
    }));

  // Capture send-pack-to-circuit-tracks-pack-2-*.pcapng: `0d 03 01 03` =
  // fileType 03 (project), pack 01 (= device Pack 2), slot 03. The septet model
  // would decode that middle byte as slot 128+, which does not exist (64 slots).
  check('fileId(3, pack 1) = [03,01,03], matching the pack-2 capture 0d 03 01 03',
    fileId(3, 1).join() === [0x03, 0x01, 0x03].join());

  check('fileId pack byte is independent of slot (pack 2 + slot 0 = [03,02,00], per the pack-3 capture 0d 05 02 00 shape)',
    fileId(0, 2).join() === [0x03, 0x02, 0x00].join());

  // buildUploadFrames must scope the session to the SAME pack it writes to.
  {
    const ncs = new Uint8Array(NCS_FILE_SIZE);
    const framesP1 = buildUploadFrames(ncs, 5);       // default pack 0
    const framesP5 = buildUploadFrames(ncs, 5, undefined, 4); // device Pack 5
    const listing = (fr: ReturnType<typeof buildUploadFrames>) =>
      fr.find((f) => f.label === 'dir_listing')!.bytes;
    check('buildUploadFrames dir_listing carries pack 0 by default (0b 03 00, the legacy bytes)',
      listing(framesP1).join() === makeMessage(0x0b, [0x03, 0x00]).join());
    check('buildUploadFrames dir_listing carries the target pack (pack 4 → 0b 03 04; capture shows 0b 03 01 for Pack 2)',
      listing(framesP5).join() === makeMessage(0x0b, [0x03, 0x04]).join());
    check('buildUploadFrames write_init fid carries the pack byte (pack 4, slot 5)',
      framesP5.find((f) => f.label === 'write_init')!.ack!.fid.join() === [0x03, 0x04, 0x05].join());
    check('buildUploadFrames rejects an out-of-range pack', (() => {
      try { buildUploadFrames(ncs, 0, undefined, 32); return false; } catch { return true; }
    })());
  }

  // PACK listing header: 11 bytes `0b 02 <count>` (no pack field, single-byte
  // count) — two bytes shorter than a 13-byte FILE header.
  check('parsePackListHeader reads count=1 (pack-2 capture: 0b 02 01 → one entry)',
    parsePackListHeader(SYX(0x0b, FILE_TYPE_PACK, 0x01))?.count === 1);
  check('parsePackListHeader reads count=2 (pack-3 capture: 0b 02 02 → two entries)',
    parsePackListHeader(SYX(0x0b, FILE_TYPE_PACK, 0x02))?.count === 2);
  // The maintainer's own device, 2026-07-10 bench run — the frame sampleDirectory.ts
  // recorded as an 11-byte "malformed straggler". It is this header, count=5,
  // matching the 5 packs the device shows on its front panel.
  check('parsePackListHeader reads count=5 from the 2026-07-10 device frame 0b 02 05 (the "malformed straggler")',
    parsePackListHeader(SYX(0x0b, FILE_TYPE_PACK, 0x05))?.count === 5);
  // A 13-byte FILE header must never be mistaken for a pack header, and vice versa.
  check('parsePackListHeader REJECTS a 13-byte FILE header (0b 03 00 34 00 = project dir, 52 entries)',
    parsePackListHeader(SYX(0x0b, 0x03, 0x00, 0x34, 0x00)) === undefined);
  check('parsePackListHeader REJECTS a sub=0x0c DIR_ENTRY',
    parsePackListHeader(SYX(0x0c, FILE_TYPE_PACK, 0x00, 0x41)) === undefined);

  // PACK entry: name starts at msg[10] (no slot byte). Parsing it with the FILE
  // entry layout would eat "0" as a slot and yield "0_ST & Roland".
  {
    const name = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const e0 = parsePackEntry(SYX(0x0c, FILE_TYPE_PACK, 0x00, ...name('00_ST & Roland')));
    check('parsePackEntry reads index 0 + full name "00_ST & Roland" (pack-2 + pack-3 captures)',
      e0?.index === 0 && e0?.name === '00_ST & Roland');
    const e1 = parsePackEntry(SYX(0x0c, FILE_TYPE_PACK, 0x01, ...name('00_invasion-test-og')));
    check('parsePackEntry reads index 1 + name "00_invasion-test-og" (pack-3 capture)',
      e1?.index === 1 && e1?.name === '00_invasion-test-og');
    check('parsePackEntry does NOT eat the name\'s first char as a slot byte (the FILE-entry layout bug)',
      e0?.name !== '0_ST & Roland');
    check('parsePackEntry REJECTS a FILE-type DIR_ENTRY (fileType 0x03)',
      parsePackEntry(SYX(0x0c, 0x03, 0x00, 0x00, ...name('00_Hello.ncs'))) === undefined);
  }
}

// ── readPackDirectory: the async I/O DRIVER, mocked (no hardware) ──────────
//
// Closes the gap named in circuit-pack-addressing.md §6 ("readPackDirectory has
// no offline test"). It is hardware-confirmed (2026-07-16, 5 packs read by name
// first attempt) but was not regression-pinned, while its sibling
// readSampleDirectory has mocked round-trips INCLUDING a prelude-desync repro.
// They share the identical prelude, so this driver is exposed the same way: a
// stale short DIR_CONTROL frame left in the receive queue can be mistaken for
// the listing header and yield a confident, wrong "0 packs".
{
  const name = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const SUB_DIR_CONTROL = 0x0b;
  const SUB_DIR_ENTRY = 0x0c;
  const SUB_CLOSE_SESSION = 0x41;
  const MSG = (...tail: number[]) => [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x03, ...tail, 0xf7];

  /** Mock conn: scripted replies + a backlog, mirroring makeMockDirConn above. */
  function mockConn(scripted: (msg: number[]) => number[][] | undefined): { conn: MidiConnection; sent: number[][] } {
    const sent: number[][] = [];
    const backlog: number[][] = [];
    const waiters: { predicate: (m: number[]) => boolean; resolve: (v: number[]) => void; timer?: ReturnType<typeof setTimeout> }[] = [];
    const deliver = (msg: number[]): void => {
      const idx = waiters.findIndex((w) => w.predicate(msg));
      if (idx !== -1) {
        const w = waiters.splice(idx, 1)[0];
        if (w.timer) clearTimeout(w.timer);
        w.resolve(msg);
      } else backlog.push(msg);
    };
    const register = (predicate: (m: number[]) => boolean, timeoutMs?: number): Promise<number[]> => {
      const idx = backlog.findIndex(predicate);
      if (idx !== -1) return Promise.resolve(backlog.splice(idx, 1)[0]);
      return new Promise<number[]>((resolve, reject) => {
        const waiter: { predicate: (m: number[]) => boolean; resolve: (v: number[]) => void; timer?: ReturnType<typeof setTimeout> } = { predicate, resolve };
        waiters.push(waiter);
        if (timeoutMs !== undefined) {
          waiter.timer = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i !== -1) waiters.splice(i, 1);
            reject(new Error('mock receive timeout'));
          }, timeoutMs);
        }
      });
    };
    const conn = {
      hasInput: true,
      send: (bytes: number[]) => { sent.push(bytes); const r = scripted(bytes); if (r) for (const m of r) deliver(m); },
      receiveSysEx: (t?: number) => register(() => true, t),
      receiveSysExMatching: (p: (m: number[]) => boolean, t?: number) => register(p, t),
    } as unknown as MidiConnection;
    return { conn, sent };
  }

  // THREE packs, deliberately NOT five. The pack header's count byte sits at
  // msg[9] and the maintainer's card holds 5 packs — so a fixture of 5 would
  // "pass" against a reader that read the count from the wrong place, or from a
  // frame that merely happens to carry a 5. That is exactly the coincidence that
  // nearly confirmed the old `readActivePackIndex` model (5 packs, on Pack 5).
  // A count that matches nothing else in the fixture cannot be right by luck.
  const PACK_NAMES = ['00_73 pack from CT', '00_ST & Roland', '00_invasion-test-og'];
  // The pack listing header is EXACTLY 11 bytes: [F0 hdr(6) 0b 02 count F7].
  const packHeader = (count: number) => MSG(SUB_DIR_CONTROL, FILE_TYPE_PACK, count);
  const listingReplies = (): number[][] => [
    packHeader(PACK_NAMES.length),
    ...PACK_NAMES.map((n, i) => MSG(SUB_DIR_ENTRY, FILE_TYPE_PACK, i, ...name(n))),
  ];

  await (async () => {
    const { conn, sent } = mockConn((b) =>
      (b[7] === SUB_DIR_CONTROL && b[8] === FILE_TYPE_PACK) ? listingReplies() : undefined);
    const r = await readPackDirectory(conn);
    check('readPackDirectory (mocked): count matches the device header',
      r.count === PACK_NAMES.length, JSON.stringify({ count: r.count }));
    check('readPackDirectory (mocked): every pack name decoded in order',
      r.packs.length === PACK_NAMES.length && r.packs.every((p, i) => p.name === PACK_NAMES[i]),
      JSON.stringify(r.packs.map((p) => p.name)));
    check('readPackDirectory (mocked): index is 0-based wire, device_pack is 1-based panel',
      r.packs.every((p, i) => p.index === i && p.device_pack === i + 1),
      JSON.stringify(r.packs.map((p) => [p.index, p.device_pack])));
    check('readPackDirectory (mocked): read-only, sends no write/transfer subcommand',
      sent.every((m) => ![0x01, 0x02, 0x03, 0x07].includes(m[7])));
    check('readPackDirectory (mocked): closes the session',
      sent[sent.length - 1][7] === SUB_CLOSE_SESSION, JSON.stringify(sent[sent.length - 1]));
  })();

  // CROSS-TALK, the pack reader's mirror of the 2026-07-10 sample-pool desync.
  //
  // Note which direction the hazard runs here. The frame that desynced the
  // SAMPLE reader was `0b 02 05` — and for the PACK reader that is not garbage
  // at all: it is a well-formed pack header reading count 5. (That frame is the
  // maintainer's own 5-pack device announcing five packs; misreading it as an
  // "active pack index" is the bug the decode corrected.) So the pack reader's
  // exposure is the opposite one: a 13-byte FILE listing header (fileType 0x03
  // project / 0x05 sample) still in the queue must NOT be consumed as a pack
  // header. Delivered FIRST, ahead of the real pack header.
  await (async () => {
    const FILE_HEADER = MSG(SUB_DIR_CONTROL, 0x05, 0x00, 0x40, 0x00); // 13-byte sample listing header, count 64
    const { conn } = mockConn((b) =>
      (b[7] === SUB_DIR_CONTROL && b[8] === FILE_TYPE_PACK) ? [FILE_HEADER, ...listingReplies()] : undefined);
    const r = await readPackDirectory(conn);
    check('readPackDirectory (cross-talk mocked): a FILE listing header in the queue is not read as a pack header',
      r.count === PACK_NAMES.length && r.packs.length === PACK_NAMES.length,
      JSON.stringify({ count: r.count, packs: r.packs.length, note: 'a count of 64 here would mean it ate the sample header' }));
    check('readPackDirectory (cross-talk mocked): names still land in order',
      r.packs.every((p, i) => p.name === PACK_NAMES[i]), JSON.stringify(r.packs.map((p) => p.name)));
  })();

  // A device that answers NOTHING must report zero packs, not hang or throw:
  // list_packs is the pre-flight for a destructive write, so its failure mode
  // has to be a clean, readable answer.
  await (async () => {
    const { conn } = mockConn(() => undefined);
    const r = await readPackDirectory(conn);
    check('readPackDirectory (silent device): returns count 0 rather than throwing',
      r.count === 0 && r.packs.length === 0, JSON.stringify(r));
  })();
}

// ---------------------------------------------------------------------------
// Drum-track mixer LEVELS (decoded 2026-07-26 by controlled differential).
// These four offsets are the whole point of being able to author a condensed
// drum part SILENTLY under an external kit, so a silent edit to the constants
// would break that feature invisibly. Pin the measured values, not a formula
// derived from them.
// ---------------------------------------------------------------------------
{
  // The measured offsets: Drum 1..4 set to 10/20/30/40 in one pass, exactly
  // four bytes moved, each to its own value, on an 11-byte stride.
  const MEASURED = [0x26fbd, 0x26fc8, 0x26fd3, 0x26fde];
  check('drum levels: base is the measured Drum 1 offset', DRUM_LEVEL_BASE === MEASURED[0]);
  check('drum levels: stride is the measured 11 bytes', DRUM_LEVEL_STRIDE === 11);
  check('drum levels: drumLevelOffset reproduces all four measured offsets',
    [0, 1, 2, 3].every((t) => drumLevelOffset(t) === MEASURED[t]),
    JSON.stringify([0, 1, 2, 3].map((t) => drumLevelOffset(t).toString(16))));
  check('drum levels: out-of-range track throws',
    [-1, 4, 1.5].every((t) => { try { drumLevelOffset(t); return false; } catch { return true; } }));
  // The drum levels live in their OWN region, well before the synth/audio
  // mixer block — conflating the two is the mistake this guards against.
  check('drum levels: region is distinct from the synth mixer block',
    MEASURED.every((o) => o < MIXER_SYNTH1_LEVEL) && MIXER_SYNTH2_LEVEL > MIXER_SYNTH1_LEVEL);
}

// ---------------------------------------------------------------------------
// PROJECT TEMPO (+ swing), the header field the authoring path now writes.
//
// This exists because the field was MISSING end to end, and the cost of that
// was invisible: `apply_pattern mode:ncs_upload` never wrote the byte, so every
// project it authored silently inherited the TEMPLATE's tempo. A whole pack of
// 140-bpm song parts sat on the device stored at the blank template's 120, and
// nothing in any receipt, diff, or read-back said so — the only symptom was the
// song playing at the wrong speed. So the guards here are (a) the encoding
// constants, which are the device's documented range and not ours to drift,
// and (b) byte precision, because a tempo write that scribbles on anything else
// would corrupt authored step data with no way to notice.
// ---------------------------------------------------------------------------
{
  // The user guide's own numbers. Pinned, not derived: if one of these is
  // edited to something the device does not accept, this fails loudly rather
  // than shipping a project the Circuit will not play.
  check('tempo: offset is the decoded header byte 0x34', PROJECT_TEMPO_OFFSET === 0x34);
  check('tempo: swing is the ADJACENT byte 0x35 (the front panel edits the pair)', PROJECT_SWING_OFFSET === 0x35);
  check('tempo: documented device range is 40..240 BPM', TEMPO_MIN_BPM === 40 && TEMPO_MAX_BPM === 240);
  check('tempo: documented new-project default is 120 BPM', TEMPO_DEFAULT_BPM === 120);
  check('swing: documented range 20..80, default 50 (even)', SWING_MIN === 20 && SWING_MAX === 80 && SWING_DEFAULT === 50);

  // The encoding is IDENTITY (the byte is the BPM), which is only sound because
  // 40..240 fits a byte with no room for an offset. Prove the second half here:
  // any positive offset would push the top of the range past 0xff.
  check('tempo: the documented range fits one byte with no offset available',
    TEMPO_MAX_BPM <= 0xff && TEMPO_MIN_BPM >= 0);

  // Round-trip across the whole documented range, endpoints included, since the
  // endpoints are exactly where an off-by-one or a clamp would hide.
  const tb = new Uint8Array(NCS_FILE_SIZE);
  const roundTrips = [40, 60, 108, 120, 122, 140, 160, 240].every((bpm) => {
    setProjectTempo(tb, bpm);
    return getProjectTempo(tb) === bpm;
  });
  check('tempo: round-trips every tempo across the range, endpoints included', roundTrips,
    JSON.stringify([40, 60, 240].map((n) => { setProjectTempo(tb, n); return getProjectTempo(tb); })));

  // 60 specifically: the metre sync test reads its result off a one-per-second
  // click, which is only true at 60 BPM. A regression here makes that test lie.
  setProjectTempo(tb, 60);
  check('tempo: 60 BPM (one beat per second, the metre-test premise) stores as 60', tb[0x34] === 60);

  // BYTE PRECISION: setting the tempo moves exactly one byte. The tempo sits in
  // the header, well clear of the pattern-data regions, and this is what proves
  // a tempo write can never scribble on authored steps.
  const before = new Uint8Array(NCS_FILE_SIZE);
  setDrumPattern(before, 0, 0, [{ active: true }, { active: false }, { active: true }]);
  const after = new Uint8Array(before);
  setProjectTempo(after, 138);
  const moved: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (after[i] !== before[i]) moved.push(i);
  check('tempo: a tempo write moves EXACTLY one byte, and it is 0x34',
    moved.length === 1 && moved[0] === PROJECT_TEMPO_OFFSET, JSON.stringify(moved.slice(0, 8)));
  check('tempo: authored drum steps survive a tempo write untouched',
    decodeDrumPattern(after, 0, 0).filter((s) => s.active).length === 2);

  // setProjectTempo REFUSES out of range rather than clamping. A clamp would
  // turn "this song is 320 bpm" into a project that plays at 240 and says
  // nothing, which is the same silent-wrong-tempo failure by another route.
  const refuses = (v: number): boolean => {
    const b = new Uint8Array(NCS_FILE_SIZE);
    b[PROJECT_TEMPO_OFFSET] = 111;
    try { setProjectTempo(b, v); return false; } catch { return b[PROJECT_TEMPO_OFFSET] === 111; }
  };
  check('tempo: refuses below the device minimum (and leaves the byte alone)', refuses(39));
  check('tempo: refuses above the device maximum (and leaves the byte alone)', refuses(241));
  check('tempo: refuses a fractional BPM (the internal clock is integer-only)', refuses(107.5));
  check('tempo: refuses a wrong-size buffer', (() => {
    try { setProjectTempo(new Uint8Array(16), 120); return false; } catch { return true; }
  })());

  // setProjectTempo reports what it DISPLACED, so a caller can say "this
  // replaced the template's 120" instead of writing over it silently.
  const rb = new Uint8Array(NCS_FILE_SIZE);
  setProjectTempo(rb, TEMPO_DEFAULT_BPM);
  check('tempo: returns the previous value so a receipt can name what it replaced',
    setProjectTempo(rb, 140) === TEMPO_DEFAULT_BPM);

  // Swing is READ but never written by the authoring path: it is a feel setting
  // dialled by hand, and guessing at it is not this codec's business.
  const sb2 = new Uint8Array(NCS_FILE_SIZE);
  sb2[PROJECT_SWING_OFFSET] = SWING_DEFAULT;
  check('swing: reads the adjacent byte', getProjectSwing(sb2) === 50);
  setProjectTempo(sb2, 96);
  check('swing: a tempo write does NOT disturb swing', getProjectSwing(sb2) === SWING_DEFAULT);

  // The tempo byte must not collide with any other decoded region. The name
  // field is the near neighbour (0x10..0x30) and the mixer/drum levels are far
  // away; a future offset edit that lands inside either would be caught here.
  check('tempo: offset is clear of the project-name field (0x10..0x30)',
    PROJECT_TEMPO_OFFSET >= 0x30);
  check('tempo: offset is clear of the mixer and drum-level regions',
    PROJECT_TEMPO_OFFSET < DRUM_LEVEL_BASE && PROJECT_TEMPO_OFFSET < MIXER_SYNTH1_LEVEL);
  check('tempo: offset is clear of every pattern-data block',
    META_OFFSETS.every((m) => PROJECT_TEMPO_OFFSET < m));
}

// ── Structural gate: the check the device's CRC cannot do (2026-07-29) ──────
//
// The device's WRITE_FINISH CRC32 covers the ENCODED STREAM, not the decoded
// `.ncs`, so a de-framing failure arrives CRC-clean. `checkNcsStructure` is the
// decode-side gate every accept-a-project path now runs, and this locks its
// three invariants plus the one real specimen we have of the failure.
{
  const valid = (): Uint8Array => {
    const b = new Uint8Array(NCS_FILE_SIZE);
    for (let i = 0; i < NCS_MAGIC.length; i++) b[i] = NCS_MAGIC.charCodeAt(i);
    new DataView(b.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, NCS_FILE_SIZE, true);
    return b;
  };
  check('structure: a well-formed project passes with no faults',
    (() => { const v = checkNcsStructure(valid()); return v.ok && v.faults.length === 0; })());

  check('structure: wrong length fails, and reports only the length (the rest is unreadable)',
    (() => { const v = checkNcsStructure(new Uint8Array(1024)); return !v.ok && v.faults.length === 1 && /length 1024/.test(v.faults[0]); })());

  check('structure: right length, missing USER magic fails',
    (() => { const b = valid(); b[0] = 0x00; const v = checkNcsStructure(b); return !v.ok && v.faults.some((f) => /magic/.test(f)); })());

  // THE case. Right length, right magic, and the file's own totalSessionSize
  // disagrees with its length. Nothing but this check catches it.
  check('structure: right length AND right magic, wrong totalSessionSize still fails',
    (() => {
      const b = valid();
      new DataView(b.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, 267_395_056, true);
      const v = checkNcsStructure(b);
      return !v.ok && v.faults.length === 1 && /totalSessionSize/.test(v.faults[0]);
    })());

  // The CRC-clean wording must be DISTINCT from the plain wording, because the
  // two conditions call for opposite next actions (retry vs never retry).
  {
    const faults = checkNcsStructure(new Uint8Array(4)).faults;
    const plain = ncsStructureNote(faults);
    const crcClean = ncsStructureNote(faults, { crcVerified: true });
    check('structure: crcVerified wording is distinct from a plain failure', plain !== crcClean);
    check('structure: crcVerified wording says the transfer was clean and not to retry',
      /CRC-VERIFIED BUT STRUCTURALLY INVALID/.test(crcClean) && /retrying will fetch the same bytes/.test(crcClean));
    check('structure: plain wording does NOT claim anything about a CRC',
      !/CRC/.test(plain));
  }

  check('structure: assertNcsStructure throws on a bad buffer and is silent on a good one',
    (() => {
      let threw = false;
      try { assertNcsStructure(new Uint8Array(8)); } catch { threw = true; }
      if (!threw) return false;
      try { assertNcsStructure(valid()); return true; } catch { return false; }
    })());

  // The real specimen. `samples/` is gitignored, so this is a bonus check where
  // the file exists rather than a requirement: the synthetic cases above already
  // lock the logic. Where it DOES exist it is the best fixture available,
  // because it is the actual file that a backup manifest recorded as
  // crc_verified while being structurally invalid.
  const CORRUPT = join('samples', 'circuit-ncs', 'card-backup-2026-07-27T16-49Z', 'pack1', 'proj64__63_OOO.ncs');
  if (existsSync(CORRUPT)) {
    const b = new Uint8Array(readFileSync(CORRUPT));
    const v = checkNcsStructure(b);
    check(`structure: real corrupt capture ${CORRUPT} is the right LENGTH (so length alone cannot catch it)`,
      b.length === NCS_FILE_SIZE, `${b.length}`);
    check('structure: real corrupt capture carries a valid USER magic (so magic alone cannot catch it either)',
      String.fromCharCode(b[0], b[1], b[2], b[3]) === NCS_MAGIC);
    check('structure: real corrupt capture is REJECTED, on its totalSessionSize',
      !v.ok && v.faults.some((f) => /totalSessionSize/.test(f)), v.faults.join('; '));
    // Guard the specific number so a future refactor that reads the field at the
    // wrong offset or endianness fails loudly instead of silently passing.
    check('structure: real corrupt capture declares 267,395,056 where 160,780 is required',
      new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, true) === 267_395_056);
    // And the sibling projects from the same capture must all PASS, or the check
    // is just rejecting everything.
    const sibDir = join('samples', 'circuit-ncs', 'card-backup-2026-07-27T16-49Z', 'pack1');
    const sibs = readdirSync(sibDir).filter((f) => f.endsWith('.ncs') && f !== 'proj64__63_OOO.ncs');
    const badSibs = sibs.filter((f) => !checkNcsStructure(new Uint8Array(readFileSync(join(sibDir, f)))).ok);
    check(`structure: the other ${sibs.length} project(s) in that same capture all pass`,
      sibs.length > 0 && badSibs.length === 0, badSibs.join(', '));
  } else {
    console.log(`  SKIP  structure: real corrupt capture not on disk (${CORRUPT}); synthetic cases above still ran`);
  }
}

// ── PROJECT PAD COLOUR (offset 0x0C), hardware-confirmed 2026-07-29 ─────────
//
// Two projects were written on hardware (index 0 = Red, index 8 = Green) and the
// device rendered both in Projects View, one byte changed per file. These lock
// the codec side of that: the palette, the surgical byte precision the hardware
// test observed, the refusal behaviour, and the authoring-time stamp.
{
  const validProject = (): Uint8Array => {
    const b = blankProject();
    b[PROJECT_COLOUR_OFFSET] = PROJECT_COLOUR_DEFAULT;   // as every untouched project reads
    setProjectTempo(b, TEMPO_DEFAULT_BPM);
    b[PROJECT_SWING_OFFSET] = SWING_DEFAULT;
    return b;
  };

  // ── Palette + round-trip, every index ────────────────────────────────────
  check('colour: the palette is the device\'s 14 (user guide "Changing Project Colours")',
    PROJECT_COLOURS.length === 14 && PROJECT_COLOURS[0] === 'Red' && PROJECT_COLOURS[8] === 'Green' && PROJECT_COLOURS[13] === 'Pink');
  {
    const bad: string[] = [];
    for (let i = 0; i < PROJECT_COLOURS.length; i++) {
      const b = validProject();
      const prev = setProjectColour(b, i);
      if (prev !== PROJECT_COLOUR_DEFAULT) bad.push(`${i}: previous ${prev}`);
      if (getProjectColour(b) !== i) bad.push(`${i}: read back ${getProjectColour(b)}`);
      if (b[PROJECT_COLOUR_OFFSET + 1] !== 0 || b[PROJECT_COLOUR_OFFSET + 2] !== 0 || b[PROJECT_COLOUR_OFFSET + 3] !== 0) bad.push(`${i}: high bytes not zero`);
    }
    check('colour: every palette index 0..13 round-trips set → get, high bytes zero, previous returned', bad.length === 0, bad.join('; '));
  }
  {
    const bad: string[] = [];
    for (let i = 0; i < PROJECT_COLOURS.length; i++) {
      if (resolveProjectColour(PROJECT_COLOURS[i]) !== i) bad.push(`${PROJECT_COLOURS[i]} → ${resolveProjectColour(PROJECT_COLOURS[i])}`);
      if (resolveProjectColour(PROJECT_COLOURS[i].toUpperCase()) !== i) bad.push(`${PROJECT_COLOURS[i]} uppercase`);
      if (resolveProjectColour(i) !== i) bad.push(`index ${i}`);
      if (projectColourName(i) !== PROJECT_COLOURS[i]) bad.push(`name ${i}`);
    }
    check('colour: every name resolves to its index, case-insensitively, and back to its name', bad.length === 0, bad.join('; '));
  }
  {
    const b = validProject();
    setProjectColour(b, ' green ');
    check('colour: a name resolves by NAME, so call sites read as colours not magic numbers', getProjectColour(b) === 8, String(getProjectColour(b)));
  }
  check('colour: the untouched default is 11 = Blue (474/474 of the maintainer\'s saved projects)',
    PROJECT_COLOUR_DEFAULT === 11 && PROJECT_COLOURS[PROJECT_COLOUR_DEFAULT] === 'Blue');

  // ── Byte precision: the property the hardware test actually observed ──────
  {
    const before = validProject();
    const after = before.slice();
    setProjectColour(after, 'Red');
    const diff: number[] = [];
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (before[i] !== after[i]) diff.push(i);
    check('colour: a write changes EXACTLY ONE byte of 160,780, and that byte is 0x0C',
      diff.length === 1 && diff[0] === PROJECT_COLOUR_OFFSET && PROJECT_COLOUR_OFFSET === 0x0c,
      `${diff.length} byte(s): ${diff.map((o) => `0x${o.toString(16)}`).join(',')}`);
  }
  {
    const b = validProject();
    const same = b.slice();
    setProjectColour(same, PROJECT_COLOUR_DEFAULT);
    let diffs = 0;
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (b[i] !== same[i]) diffs++;
    check('colour: re-writing the colour it already holds is a zero-byte no-op', diffs === 0, `${diffs}`);
  }
  {
    // The field is an LE uint32, so a stale high byte would leave a value that
    // Novation's own validator refuses ("Session colour out of range").
    const b = validProject();
    b[PROJECT_COLOUR_OFFSET + 1] = 0x7f; b[PROJECT_COLOUR_OFFSET + 3] = 0x01;
    setProjectColour(b, 'Green');
    const word = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(PROJECT_COLOUR_OFFSET, true);
    check('colour: the whole LE uint32 is written, so a dirty high byte cannot leave an out-of-range word',
      word === 8 && getProjectColour(b) === 8, String(word));
  }
  {
    // Nothing else in the header moves. Tempo/swing are the near neighbours and
    // the name field starts 4 bytes later.
    const b = validProject();
    for (let i = 0; i < 10; i++) b[0x10 + i] = 'ColourTest'.charCodeAt(i);
    const nameBefore = Array.from(b.slice(0x10, 0x30)).join(',');
    setProjectColour(b, 'Purple');
    check('colour: a colour write leaves tempo, swing and the project name alone',
      getProjectTempo(b) === TEMPO_DEFAULT_BPM && getProjectSwing(b) === SWING_DEFAULT &&
      Array.from(b.slice(0x10, 0x30)).join(',') === nameBefore);
  }

  // ── Refusal, never a clamp (same contract as setProjectTempo) ────────────
  {
    const b = validProject();
    const rejected = [-1, 14, 99, 1.5, NaN, Infinity].every((v) => throws(() => setProjectColour(b, v)));
    check('colour: an out-of-range INDEX is refused, not clamped (-1 / 14 / 99 / 1.5 / NaN / Infinity)', rejected);
    check('colour: an unknown NAME is refused, and the error names the palette',
      (() => {
        try { setProjectColour(b, 'Chartreuse'); return false; }
        catch (e) { return e instanceof RangeError && /Chartreuse/.test(String(e)) && /Red/.test(String(e)) && /Pink/.test(String(e)); }
      })());
    check('colour: a numeric STRING is refused rather than silently parsed (a name typo must not become an index)',
      throws(() => setProjectColour(b, '8')));
    check('colour: an empty name is refused', throws(() => setProjectColour(b, '')));
    check('colour: a refused write leaves the byte untouched', getProjectColour(b) === PROJECT_COLOUR_DEFAULT, String(getProjectColour(b)));
    check('colour: a wrong-size buffer is refused by both accessors',
      throws(() => getProjectColour(new Uint8Array(16))) && throws(() => setProjectColour(new Uint8Array(16), 0)));
  }

  // ── Offset hygiene: 0x0C must not collide with anything else decoded ─────
  check('colour: offset is clear of the magic and of totalSessionSize (0x00..0x07)',
    PROJECT_COLOUR_OFFSET >= NCS_TOTAL_SESSION_SIZE_OFFSET + 4);
  check('colour: offset is clear of the project-name field (0x10..0x30)',
    PROJECT_COLOUR_OFFSET + 4 <= 0x10);
  check('colour: offset is clear of tempo, swing, the mixer and the drum levels',
    PROJECT_COLOUR_OFFSET < PROJECT_TEMPO_OFFSET && PROJECT_COLOUR_OFFSET < PROJECT_SWING_OFFSET &&
    PROJECT_COLOUR_OFFSET < MIXER_SYNTH1_LEVEL && PROJECT_COLOUR_OFFSET < DRUM_LEVEL_BASE);
  check('colour: offset is clear of every pattern-data block',
    META_OFFSETS.every((m) => PROJECT_COLOUR_OFFSET < m));

  // ── DISTINCT_COLOURS: the high-contrast ordering ────────────────────────
  // A naive song-1=0, song-2=1 assignment yields hues a performer cannot tell
  // apart on a lit pad, because the palette is a spectrum and adjacent entries
  // are close by construction. These pin the properties the ordering claims.
  {
    const dist = (a: number, b: number): number => { const d = Math.abs(a - b); return Math.min(d, PROJECT_COLOURS.length - d); };
    check('distinct: every entry is a real palette index, with no repeats',
      DISTINCT_COLOURS.every((c) => Number.isInteger(c) && c >= 0 && c < PROJECT_COLOURS.length) &&
      new Set(DISTINCT_COLOURS).size === DISTINCT_COLOURS.length, DISTINCT_COLOURS.join(','));
    check('distinct: the first six are pairwise NON-ADJACENT on the 14-step wheel (the confusable pairs are all adjacent)',
      (() => {
        const six = DISTINCT_COLOURS.slice(0, 6);
        for (let i = 0; i < six.length; i++) for (let j = i + 1; j < six.length; j++) if (dist(six[i], six[j]) < 2) return false;
        return true;
      })(), DISTINCT_COLOURS.slice(0, 6).map(projectColourName).join(' > '));
    check('distinct: it opens on the two HARDWARE-RENDERED anchors\' colours, Red first',
      DISTINCT_COLOURS[0] === 0 && DISTINCT_COLOURS.includes(8));
    check('distinct: Blue is LAST, because "still Blue" is the signal a project was never stamped',
      DISTINCT_COLOURS[DISTINCT_COLOURS.length - 1] === PROJECT_COLOUR_DEFAULT);
    check('distinct: it never puts the doc\'s named confusable pairs (Cyan/Blue, Green/Teal) inside the first six',
      (() => {
        const six = new Set(DISTINCT_COLOURS.slice(0, 6));
        return !(six.has(10) && six.has(11)) && !(six.has(8) && six.has(9));
      })());
    check('distinct: eight songs\' worth, which clears the practical ceiling of a 64-slot pack',
      DISTINCT_COLOURS.length === 8);
  }

  // ── AUTHORING-TIME STAMP: born the right colour, no post-pass ────────────
  {
    const plan: RealizePlan = {
      pattern_name: 'coloured', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
      events: [
        { channel: 10, note: 60, velocity: 110, time_ms: 0, duration_ms: 100 },
        { channel: 1, note: 48, velocity: 100, time_ms: 500, duration_ms: 100 },
      ],
    };

    // The path the maintainer will actually use: author, then stamp, then the
    // file is ready to upload — structurally valid, with the colour readable.
    const authored = validProject();
    const res = authorPlanIntoProject(authored, plan);
    const stamp = applyProjectColour(authored, 'Green');
    const structure = checkNcsStructure(authored);
    check('authored+colour: the authored project is STRUCTURALLY VALID (the upload pre-flight would accept it)',
      structure.ok, structure.faults.join('; '));
    check('authored+colour: its colour reads back as the one asked for, by name',
      getProjectColour(authored) === 8 && projectColourName(getProjectColour(authored)) === 'Green', String(getProjectColour(authored)));
    check('authored+colour: the stamp receipt reports the change and what it displaced',
      stamp.inherited === false && stamp.changed === true && stamp.index === 8 && stamp.previous === PROJECT_COLOUR_DEFAULT,
      JSON.stringify(stamp));
    check('authored+colour: stamping does NOT disturb the authored pattern data',
      decodeDrumPattern(authored, 0, 0)[0].active && decodeNotePattern(authored, 'synth1', 0)[4].notes[0]?.note === 48 &&
      res.unrouted === 0);

    // BACKWARD COMPATIBILITY: a caller that passes nothing gets exactly the old
    // behaviour — the project inherits the template's colour, byte untouched.
    const untouched = validProject();
    authorPlanIntoProject(untouched, plan);
    const baseline = untouched.slice();
    const inherit = applyProjectColour(untouched);
    let moved = 0;
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (baseline[i] !== untouched[i]) moved++;
    check('authored+colour: passing NO colour is a zero-byte no-op that inherits the template\'s',
      moved === 0 && inherit.inherited === true && inherit.changed === false &&
      inherit.index === PROJECT_COLOUR_DEFAULT && inherit.previous === PROJECT_COLOUR_DEFAULT,
      JSON.stringify({ moved, ...inherit }));
    check('authored+colour: a bad colour is refused at the stamp, before any upload',
      throws(() => applyProjectColour(validProject(), 14)) && throws(() => applyProjectColour(validProject(), 'Beige')));

    // Stamping a whole song's worth of projects: walk DISTINCT_COLOURS and every
    // project comes out a different, well-separated colour. This is the pack
    // organisation the decode doc recommends, exercised.
    const pack = DISTINCT_COLOURS.slice(0, 4).map((c) => {
      const p = validProject();
      authorPlanIntoProject(p, plan);
      applyProjectColour(p, c);
      return getProjectColour(p);
    });
    check('authored+colour: a 4-project pack stamped from DISTINCT_COLOURS gets 4 different colours',
      new Set(pack).size === 4 && JSON.stringify(pack) === JSON.stringify(DISTINCT_COLOURS.slice(0, 4)),
      pack.map(projectColourName).join(', '));
  }

  // ── Corpus: the real card backup (gitignored; skipped where absent) ──────
  {
    const backupPack = join('samples', 'circuit-ncs', 'card-backup-2026-07-27T16-49Z', 'pack1');
    if (!existsSync(backupPack)) {
      console.log(`  SKIP  colour corpus: ${backupPack} not present (samples/ is gitignored); synthetic cases above still ran`);
    } else {
      const files = readdirSync(backupPack).filter((f) => f.toLowerCase().endsWith('.ncs'));
      const offPalette: string[] = []; const dirtyHigh: string[] = []; const seen = new Set<number>();
      let checked = 0;
      for (const f of files) {
        const b = new Uint8Array(readFileSync(join(backupPack, f)));
        if (!checkNcsStructure(b).ok) continue;   // the known-corrupt specimen is excluded by structure, not by name
        checked++;
        const c = getProjectColour(b);
        seen.add(c);
        if (c >= PROJECT_COLOURS.length) offPalette.push(`${f}=${c}`);
        if (b[PROJECT_COLOUR_OFFSET + 1] !== 0 || b[PROJECT_COLOUR_OFFSET + 2] !== 0 || b[PROJECT_COLOUR_OFFSET + 3] !== 0) dirtyHigh.push(f);
      }
      check(`colour corpus: all ${checked} structurally-valid projects in the card backup read an ON-PALETTE colour`,
        checked > 0 && offPalette.length === 0, offPalette.join(', '));
      check('colour corpus: their high bytes are all zero, so the field really is a small LE uint32',
        dirtyHigh.length === 0, dirtyHigh.join(', '));
      // Not an assertion about which colour: just reported, since the decode's
      // corpus leg is precisely "everything the maintainer saved reads Blue".
      console.log(`        (colours present in that pack: ${[...seen].sort((a, b) => a - b).map(projectColourName).join(', ')})`);
    }
  }
}

// ── PROJECT NAME: 0x10..0x2F, 32 bytes of space-padded ASCII ────────────────
//
// The write class the After Dark renames shipped on hardware (2026-07-28,
// `scripts/circuit-after-dark-rename.ts`): space-pad the whole field so no
// stale tail survives, refuse (never truncate) anything the field cannot hold.
{
  const diffs = (a: Uint8Array, b: Uint8Array): number[] => {
    const d: number[] = [];
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (a[i] !== b[i]) d.push(i);
    return d;
  };
  check('name: offset is the decoded header field 0x10', PROJECT_NAME_OFFSET === 0x10);
  check('name: the field is 32 bytes (0x10..0x2F), the template\'s space-filled width', PROJECT_NAME_LEN === 32);
  check('name: offset is clear of the colour word (0x0C..0x0F) and of tempo/swing (0x34/0x35)',
    PROJECT_NAME_OFFSET >= PROJECT_COLOUR_OFFSET + 4 && PROJECT_NAME_OFFSET + PROJECT_NAME_LEN <= PROJECT_TEMPO_OFFSET);

  const b = blankProject();
  const control = b.slice();
  const prev = setProjectName(b, 'AfterDark Verse');
  check('name: the blank template reads as no name, returned as the displaced value', prev === '');
  check('name: round-trips through the accessor', getProjectName(b) === 'AfterDark Verse', getProjectName(b));
  {
    const d = diffs(control, b);
    check('name: the write changes EXACTLY the 32 field bytes (chars + space padding), zero collateral',
      d.length === PROJECT_NAME_LEN && d.every((o) => o >= PROJECT_NAME_OFFSET && o < PROJECT_NAME_OFFSET + PROJECT_NAME_LEN),
      JSON.stringify(d.slice(0, 8)));
    check('name: the tail really is spaces, not zeros (the padding IS the terminator)',
      b[PROJECT_NAME_OFFSET + 15] === 0x20 && b[PROJECT_NAME_OFFSET + PROJECT_NAME_LEN - 1] === 0x20);
  }
  {
    const again = b.slice();
    setProjectName(again, 'Z');
    const d = diffs(b, again);
    check('name: re-naming stays confined to the field (a shorter name space-pads the rest)',
      d.every((o) => o >= PROJECT_NAME_OFFSET && o < PROJECT_NAME_OFFSET + PROJECT_NAME_LEN) && getProjectName(again) === 'Z',
      JSON.stringify(d.slice(0, 8)));
  }
  {
    const full = blankProject();
    const name32 = 'A'.repeat(PROJECT_NAME_LEN);
    setProjectName(full, name32);
    check('name: a 32-character name exactly fills the field and round-trips', getProjectName(full) === name32);
  }
  // REFUSALS: over-long, non-ASCII, empty, control characters, and a refused
  // write leaves the field untouched (nothing partially applied).
  {
    const r = blankProject();
    setProjectName(r, 'Keep Me');
    const held = r.slice();
    check('name: 33 characters refuse (never truncated to 32)', throws(() => setProjectName(r, 'A'.repeat(33))));
    check('name: non-ASCII refuses, naming the charset', throws(() => setProjectName(r, 'Größe')));
    check('name: an empty name refuses', throws(() => setProjectName(r, '')));
    check('name: a control character refuses', throws(() => setProjectName(r, 'a\tb')));
    check('name: a refused write leaves the field untouched',
      diffs(held, r).length === 0 && getProjectName(r) === 'Keep Me');
    check('name: a wrong-size buffer is refused by both accessors',
      throws(() => setProjectName(new Uint8Array(16), 'x')) && throws(() => getProjectName(new Uint8Array(16))));
  }
  // AUTHORING-TIME STAMP: same contract as applyProjectColour.
  {
    const s = blankProject();
    setProjectName(s, 'Template 42');
    const baseline = s.slice();
    const inherit = applyProjectName(s);
    check('name: applyProjectName with NO name is a zero-byte no-op that reports the template\'s',
      diffs(baseline, s).length === 0 && inherit.inherited === true && inherit.changed === false
      && inherit.name === 'Template 42' && inherit.previous === 'Template 42', JSON.stringify(inherit));
    const stamp = applyProjectName(s, 'AfterDark Break');
    check('name: an asked-for name stamps and the receipt reports what it displaced',
      stamp.inherited === false && stamp.changed === true && stamp.name === 'AfterDark Break'
      && stamp.previous === 'Template 42' && getProjectName(s) === 'AfterDark Break', JSON.stringify(stamp));
  }
}

// ── STORED MIXER LEVELS: per-track accessors (synth 0x2701C/D, drums stride 11) ──
//
// The synth offsets and the drum base/stride are the 2026-07-26 differential
// decodes already pinned above; what these add is the SINGLE-track write class
// the partial `mixer_levels` surface uses (name only the tracks to touch).
{
  const diffs = (a: Uint8Array, b: Uint8Array): number[] => {
    const d: number[] = [];
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (a[i] !== b[i]) d.push(i);
    return d;
  };
  const b = blankProject();
  const control = b.slice();
  const prev1 = setSynthLevel(b, 1, 10);
  check('mixer: setSynthLevel(1) writes EXACTLY the confirmed 0x2701C byte and returns the displaced value',
    prev1 === 0 && diffs(control, b).length === 1 && diffs(control, b)[0] === MIXER_SYNTH1_LEVEL && getSynthLevel(b, 1) === 10,
    JSON.stringify(diffs(control, b)));
  const prev2 = setSynthLevel(b, 2, 20);
  check('mixer: setSynthLevel(2) writes EXACTLY the confirmed 0x2701D byte',
    prev2 === 0 && b[MIXER_SYNTH2_LEVEL] === 20 && getSynthLevel(b, 2) === 20);
  {
    const before = b.slice();
    for (let t = 0; t < 4; t++) {
      const p = setDrumLevel(b, t, 30 + t * 10);
      check(`mixer: setDrumLevel(${t}) writes EXACTLY its stride-11 byte (0x${drumLevelOffset(t).toString(16)}) and returns the displaced value`,
        p === 0 && getDrumLevel(b, t) === 30 + t * 10);
    }
    const d = diffs(before, b);
    check('mixer: the four single-track drum writes changed exactly the four level bytes, zero collateral',
      d.length === 4 && d.every((o, i) => o === drumLevelOffset(i)), JSON.stringify(d));
  }
  // REFUSALS: out of range / non-integer, refused write leaves the byte alone.
  {
    const r = blankProject();
    setSynthLevel(r, 1, 100);
    setDrumLevel(r, 2, 100);
    const held = r.slice();
    check('mixer: level 128 refuses (the CC scale tops at 127), -1 refuses, 63.5 refuses',
      throws(() => setSynthLevel(r, 1, MIXER_LEVEL_MAX + 1)) && throws(() => setSynthLevel(r, 2, -1))
      && throws(() => setDrumLevel(r, 0, 63.5)) && throws(() => setDrumLevel(r, 3, 128)));
    check('mixer: an out-of-range drum track refuses', throws(() => setDrumLevel(r, 4, 0)));
    check('mixer: a refused write leaves every byte untouched', diffs(held, r).length === 0);
    check('mixer: a wrong-size buffer is refused by all four accessors',
      throws(() => setSynthLevel(new Uint8Array(16), 1, 0)) && throws(() => getSynthLevel(new Uint8Array(16), 1))
      && throws(() => setDrumLevel(new Uint8Array(16), 0, 0)) && throws(() => getDrumLevel(new Uint8Array(16), 0)));
  }
}

// ── slotForFlipRole: the condense_drums × drum_binding join ─────────────────
//
// Canonical layout when unbound (byte-identical to circuitSlotForVoice, the
// pre-composition path); the caller's BOUND slots for the four track roles when
// a custom binding is declared; unlocatable (undefined) for everything else,
// because a custom binding means the canonical layout no longer describes the
// pool and a guessed slot would flip a step to an arbitrary sample.
{
  check('flip join: with NO binding, every canonical role resolves exactly as circuitSlotForVoice',
    Object.keys(CIRCUIT_VOICE_SLOT).every((r) => slotForFlipRole(r) === circuitSlotForVoice(r)));
  const bound = [1, 2, 5, 11];   // After Dark's ear-confirmed binding (stoken_4 pool)
  check('flip join: the four track roles resolve to the BOUND slots (kick→1, snare→2, closed_hat→5, ride→11)',
    slotForFlipRole('kick', bound) === 1 && slotForFlipRole('snare', bound) === 2
    && slotForFlipRole('closed_hat', bound) === 5 && slotForFlipRole('ride', bound) === 11);
  check('flip join: dialect spellings resolve through the role spine ("hat" → the bound closed_hat slot)',
    slotForFlipRole('hat', bound) === 5);
  check('flip join: off-kit roles are unlocatable under a custom binding (crash / tom / ride_bell), never guessed',
    slotForFlipRole('crash', bound) === undefined && slotForFlipRole('tom', bound) === undefined
    && slotForFlipRole('ride_bell', bound) === undefined);
  check('flip join: an unknown voice is undefined with and without a binding',
    slotForFlipRole('kazoo') === undefined && slotForFlipRole('kazoo', bound) === undefined);
  check('flip join: an EXPLICIT canonical binding still means "caller declares the pool" (crash unlocatable by design)',
    slotForFlipRole('kick', [...DEFAULT_DRUM_BINDING]) === CIRCUIT_VOICE_SLOT.kick
    && slotForFlipRole('crash', [...DEFAULT_DRUM_BINDING]) === undefined);
}

// ── COMBINED STAMP: every authoring field at once, exact offsets, no collateral ──
{
  const b = blankProject();
  const control = b.slice();
  setProjectName(b, 'Zz');
  setProjectColour(b, 5);
  setSynthLevel(b, 1, 10); setSynthLevel(b, 2, 20);
  for (let t = 0; t < 4; t++) setDrumLevel(b, t, 30 + t * 10);
  setDrumSampleBinding(b, [1, 2, 5, 11]);
  const allowed = new Set<number>([
    ...Array.from({ length: PROJECT_NAME_LEN }, (_, i) => PROJECT_NAME_OFFSET + i),
    PROJECT_COLOUR_OFFSET,
    MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL,
    ...[0, 1, 2, 3].map(drumLevelOffset),
    ...[0, 1, 2, 3].map((t) => DRUM_BINDING_OFFSET + t),
  ]);
  const d: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (control[i] !== b[i]) d.push(i);
  check('combined stamp: name + colour + synth/drum levels + binding all land inside their own fields, nothing else moves',
    d.every((o) => allowed.has(o)), JSON.stringify(d.filter((o) => !allowed.has(o)).slice(0, 8)));
  check('combined stamp: every stamp reads back through its own accessor',
    getProjectName(b) === 'Zz' && getProjectColour(b) === 5 && getSynthLevel(b, 1) === 10 && getSynthLevel(b, 2) === 20
    && [0, 1, 2, 3].every((t) => getDrumLevel(b, t) === 30 + t * 10)
    && JSON.stringify(getDrumSampleBinding(b)) === '[1,2,5,11]');
  check('combined stamp: the stamped file is still structurally a project', checkNcsStructure(b).ok);
}

console.log('');
if (failed > 0) { console.error(`x ${failed} ncs check(s) FAILED.`); process.exit(1); }
console.log('OK verify-circuit-ncs: .ncs drum + synth pattern codec + plan→project authoring + pack addressing verified (synthetic round-trip + byte-precision + capture-exact pack goldens).');
