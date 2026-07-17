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
} from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import {
  roleOfSampleName, rolesByDirectory, bindingFromDirectory,
} from '@mcp-midi-control/circuit-tracks/ncs/sampleRoles.js';
import {
  readSampleDirectory, parseDirListHeader, parseDirEntry, buildReadFileRequest, fileIdFor,
  SAMPLE_DIRECTORY_CONSTANTS,
} from '@mcp-midi-control/circuit-tracks/ncs/sampleDirectory.js';
import { makeMessage, fileId, buildUploadFrames, TRANSFER_CONSTANTS as TRANSFER_SUB_CONSTANTS } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { parsePackListHeader, parsePackEntry, readPackDirectory, FILE_TYPE_PACK } from '@mcp-midi-control/circuit-tracks/ncs/packDirectory.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import {
  decodeNotePattern, setNoteStep, clearNoteStep, setNotePattern, DEFAULT_GATE, DEFAULT_NOTE_VELOCITY,
} from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { noteStepBase, NOTE_STEP_REGION, NOTE_STEP_BYTES } from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { authorPlanIntoProject, authorArrangementIntoProject, writer as circuitWriter } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';
import { writeFileSync, rmSync } from 'node:fs';
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
  writeFileSync(template, new Uint8Array(NCS_FILE_SIZE));
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
    occupied: names.filter(Boolean).length, total: 64,
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

console.log('');
if (failed > 0) { console.error(`x ${failed} ncs check(s) FAILED.`); process.exit(1); }
console.log('OK verify-circuit-ncs: .ncs drum + synth pattern codec + plan→project authoring + pack addressing verified (synthetic round-trip + byte-precision + capture-exact pack goldens).');
