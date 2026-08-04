/**
 * Golden: device-neutral pattern module (no hardware).
 *
 * Covers mini-notation parsing, char grids, the Euclidean generator, the
 * grid→plan compiler, voice_map resolution, the realizer capability gate,
 * and named-library integrity.
 *
 * The last block reaches into the Circuit Tracks authoring layer on purpose.
 * Drum CONDENSATION is a contract split across two layers (the neutral
 * condenser emits device-blind ROLES; the device layer resolves a role to its
 * own sample slot), so exercising either half alone proves nothing about the
 * join. The Circuit authoring functions it calls are pure buffer mutation with
 * no MIDI I/O, so the suite stays hardware-free.
 *
 * Run via:  npx tsx scripts/verify-patterns.ts
 */

import type { DeviceCapabilities, RealizePlan, VoiceTarget } from '../packages/core/src/protocol-generic/types.js';
import { DispatchError } from '../packages/core/src/protocol-generic/types.js';
import { buildCondensedDrums } from '../packages/core/src/protocol-generic/dispatcher/condenseDrums.js';
import { executeApplyPattern } from '../packages/core/src/protocol-generic/dispatcher/patterns.js';
import { registerDevice } from '../packages/core/src/protocol-generic/registry.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '../packages/circuit-tracks/src/descriptor.js';
import { authorArrangementIntoProject, authorPlanIntoProject, writer as circuitWriter } from '../packages/circuit-tracks/src/descriptor/writer.js';
import {
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, NCS_FILE_SIZE, NCS_MAGIC, NCS_TOTAL_SESSION_SIZE_OFFSET, PROJECT_COLOUR_DEFAULT,
  applyProjectColour, applyProjectName, checkNcsStructure, getDrumLevel, getProjectColour, getProjectName,
  getSynthLevel, projectColourName, setDrumLevels, setProjectColour, setProjectName, setSynthLevel,
} from '../packages/circuit-tracks/src/ncs/format.js';
import { SPD_SX_DESCRIPTOR } from '../packages/spd-sx/src/descriptor.js';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeDrumPattern, DEFAULT_DRUM_CHOICE } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import { CIRCUIT_VOICE_SLOT, circuitSlotForVoice, getDrumSampleBinding, slotForFlipRole } from '../packages/circuit-tracks/src/ncs/drumBinding.js';
import { getNoteChain } from '../packages/circuit-tracks/src/ncs/chain.js';
import { getSceneChainEnd, getSceneDrumChain, getSceneNoteChain } from '../packages/circuit-tracks/src/ncs/sceneChain.js';
import type { NoteTrack } from '../packages/circuit-tracks/src/ncs/format.js';
import {
  PATTERN_RECIPES,
  PatternError,
  charGridToSteps,
  compileToPlan,
  euclid,
  euclidToString,
  gateSixthsFromSteps,
  parseDrumTab,
  applyRoundRobin,
  resolveDrumMapPreset,
  quantizeDrumEvents,
  gmDrumToVoice,
  GM_DRUM_TO_VOICE,
  canonicalRole,
  condenseToKit,
  DRUM_ROLES,
  parseMidiFile,
  importMidiDrums,
  importMidiMelodic,
  midiChannelSummary,
  planProjects,
  type DrumEvent,
  keyToSemitones,
  resolveTranspose,
  parseMiniNotation,
  parsePitch,
  parseVoice,
  parseVoiceLine,
  resolvePatternRecipe,
  resolvePatternVoices,
  resolvePatternVoicesDetailed,
  foldVoice,
  indexMapByRole,
  pieceCompression,
  ROLE_FOLDS,
  selectRealizer,
  tryParsePitchChord,
  type NeutralPattern,
  type Step as NeutralStep,
} from '../packages/core/src/protocol-generic/patterns/index.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}
function hits(steps: { on: boolean }[]): number[] {
  return steps.flatMap((s, i) => (s.on ? [i] : []));
}
function threwPattern(fn: () => unknown): boolean {
  try { fn(); return false; } catch (e) { return e instanceof PatternError; }
}

// ── Mini-notation ──────────────────────────────────────────────────
{
  const g = parseVoiceLine('bd ~ ~ ~ bd ~ ~ ~', 8);
  check('mini "bd ~ ~ ~ bd ~ ~ ~" → hits at 0,4', JSON.stringify(hits(g)) === '[0,4]', JSON.stringify(hits(g)));

  const hh = parseVoiceLine('hh*8', 16);
  check('mini "hh*8" over 16 → 8 hits on even steps',
    hits(hh).length === 8 && hits(hh).every((i) => i % 2 === 0), JSON.stringify(hits(hh)));

  const sub = parseVoiceLine('bd [sd sd]', 4);
  check('mini subgroup "bd [sd sd]" over 4 → hits 0,2,3', JSON.stringify(hits(sub)) === '[0,2,3]', JSON.stringify(hits(sub)));

  const acc = parseVoiceLine('X . x .', 4);
  check('mini accent "X . x ." → accent on step 0 only',
    acc[0].on && acc[0].accent === true && acc[2].on && !acc[2].accent, JSON.stringify(acc));

  const stack = parseMiniNotation('bd*4, hh*8, ~ sd ~ sd', 16);
  check('comma-stack voices = kick/hat/snare',
    'kick' in stack && 'hat' in stack && 'snare' in stack, Object.keys(stack).join(','));
  check('comma-stack kick=4 hits, hat=8 hits, snare at 4,12',
    hits(stack.kick).length === 4 && hits(stack.hat).length === 8 && JSON.stringify(hits(stack.snare)) === '[4,12]',
    `kick=${hits(stack.kick).length} hat=${hits(stack.hat).length} snare=${JSON.stringify(hits(stack.snare))}`);

  check('mini error: unbalanced "[bd"', threwPattern(() => parseVoiceLine('[bd', 8)));
  check('mini error: unbalanced "bd]"', threwPattern(() => parseVoiceLine('bd]', 8)));
  check('mini error: empty line', threwPattern(() => parseVoiceLine('', 8)));
  check('mini error: bad repeat "bd*"', threwPattern(() => parseVoiceLine('bd*', 8)));
}

// ── Char grid ──────────────────────────────────────────────────────
{
  const g = charGridToSteps('x...x...');
  check('char grid "x...x..." → 8 steps, hits 0,4', g.length === 8 && JSON.stringify(hits(g)) === '[0,4]');
  const a = charGridToSteps('X...');
  check('char grid "X..." → accent on step 0', a[0].on && a[0].accent === true);
  check('char grid bad char errors', threwPattern(() => charGridToSteps('x.q.')));
  // parseVoice auto-detect: char grid (no spaces) vs mini (spaces)
  check('parseVoice auto-detects char grid', JSON.stringify(hits(parseVoice('x.x.'))) === '[0,2]');
  check('parseVoice auto-detects mini', JSON.stringify(hits(parseVoice('x . x .', 4))) === '[0,2]');
  // Micro-step roll digits (trap hats): 1..6 = evenly-spaced sub-hits (the
  // drum micro-hit mask is positional, HW-confirmed 2026-07-03).
  const roll = charGridToSteps('x.x.x.x.x.x.x.6.');
  check('roll grid → hits on the 8ths', JSON.stringify(hits(roll)) === '[0,2,4,6,8,10,12,14]', JSON.stringify(hits(roll)));
  check('roll digit 6 → step 14 roll=6 (buzz)', roll[14].on && roll[14].roll === 6, JSON.stringify(roll[14]));
  check('roll digit 1 = single hit (roll=1)', charGridToSteps('1...')[0].roll === 1);
  check('roll digits 2-5 now LEGAL (positional mask HW-confirmed): "3" → roll=3',
    charGridToSteps('3...')[0].roll === 3, JSON.stringify(charGridToSteps('3...')[0]));
  check('char grid digit 7 errors (max 6 micro-steps)', threwPattern(() => charGridToSteps('x.7.')));
}

// ── Pitched tokens (melodic voices) ────────────────────────────────
{
  // parsePitch: scientific pitch → MIDI (middle C = c4 = 60).
  check('parsePitch c4 = 60 (middle C)', parsePitch('c4') === 60, String(parsePitch('c4')));
  check('parsePitch c-1 = 0 (lowest)', parsePitch('c-1') === 0, String(parsePitch('c-1')));
  check('parsePitch c2 = 36', parsePitch('c2') === 36, String(parsePitch('c2')));
  check('parsePitch eb3 = 51 (flat)', parsePitch('eb3') === 51, String(parsePitch('eb3')));
  check('parsePitch f#4 = 66 (sharp)', parsePitch('f#4') === 66, String(parsePitch('f#4')));
  check('parsePitch G5 = 79 (case-insensitive, s = sharp)', parsePitch('gs5') === 80 && parsePitch('G5') === 79);
  check('parsePitch rejects drum word "bd"', parsePitch('bd') === undefined);
  check('parsePitch rejects bare "c" (no octave)', parsePitch('c') === undefined);
  check('parsePitch out-of-range throws', threwPattern(() => parsePitch('c10'))); // (10+1)*12 = 132 > 127

  // tryParsePitchChord: single + chord + malformed.
  check('tryParsePitchChord "c3" = [48]', JSON.stringify(tryParsePitchChord('c3')) === '[48]');
  check('tryParsePitchChord "c3+eb3+g3" = [48,51,55]', JSON.stringify(tryParsePitchChord('c3+eb3+g3')) === '[48,51,55]');
  check('tryParsePitchChord "hh" = undefined (drum word)', tryParsePitchChord('hh') === undefined);
  check('tryParsePitchChord "c3+zz" throws (bad chord member, no silent drop)', threwPattern(() => tryParsePitchChord('c3+zz')));

  // A bassline: one pitch per step → Step.notes carries the pitch.
  const bass = parseVoiceLine('c2 ~ g2 ~ eb2 ~ ~ ~', 8);
  check('bassline hits at 0,2,4', JSON.stringify(hits(bass)) === '[0,2,4]', JSON.stringify(hits(bass)));
  check('bassline step0.notes = 36 (c2)', bass[0].notes === 36, JSON.stringify(bass[0]));
  check('bassline step1 is a rest with no notes', !bass[1].on && bass[1].notes === undefined);

  // A chord: one step holds an array of notes.
  const chord = parseVoiceLine('c3+eb3+g3 ~ ~ ~', 4);
  check('chord step0.notes = [48,51,55]', JSON.stringify(chord[0].notes) === '[48,51,55]', JSON.stringify(chord[0].notes));

  // An arpeggio over a full grid; repeats land one note per step.
  const arp = parseVoiceLine('c3 eb3 g3 c4', 4);
  check('arp 4 distinct pitches', JSON.stringify(arp.map((s) => s.notes)) === '[48,51,55,60]', JSON.stringify(arp.map((s) => s.notes)));

  // parseVoice auto-detects a single chord token (no spaces) as mini, not a char grid.
  check('parseVoice single chord token "c3+eb3+g3" auto-detects melodic',
    JSON.stringify(parseVoice('c3+eb3+g3', 4)[0].notes) === '[48,51,55]');

  // An un-pitched x/X hit stays note-less (drum semantics; takes voice_map note).
  check('un-pitched "x . x ." has no notes (drum semantics)', parseVoiceLine('x . x .', 4)[0].notes === undefined);
}

// ── NOTE LENGTH + TIE notation (":len" / "_") ──────────────────────
// The pattern owns duration. A "pad" whose sustain comes from the receiving
// synth's amp envelope becomes a blip the moment the synth is swapped, which is
// exactly what happened when a MicroFreak took over the Circuit's MIDI 1 track.
{
  // `:len` is in STEPS (the unit the device's Gate View shows); the neutral
  // field is SIXTHS of a step, converted exactly once, here.
  const g = (src: string, steps: number, cell = 0): NeutralStep => parseVoiceLine(src, steps)[cell];
  check('gate ":4" on a pitch = 24 sixths (four steps)', g('c3:4 ~ ~ ~', 4).gate_sixths === 24, String(g('c3:4 ~ ~ ~', 4).gate_sixths));
  check('gate ":1" = 6 sixths (one step, the default made explicit)', g('c3:1', 1).gate_sixths === 6);
  check('gate ":16" = 96 sixths (the ceiling, a whole 16-step pattern)', g('c3:16', 1).gate_sixths === 96);
  check('gate ":0.5" = 3 sixths (a decimal, staccato)', g('c3:0.5 c3:0.5', 2).gate_sixths === 3);
  check('gate ":1/6" = 1 sixth (a fraction, the shortest the device holds)', g('c3:1/6', 1).gate_sixths === 1);
  check('gate ":1/3" = 2 sixths (rational, not a float rounding)', g('c3:1/3', 1).gate_sixths === 2);
  check('gate ":1.5" = 9 sixths (a fractional gate the corpus really uses)', g('c3:1.5', 1).gate_sixths === 9);
  check('gate on a DRUM word works too ("bd:2")', g('bd:2 ~', 2).gate_sixths === 12);
  check('gate on an un-pitched hit works too ("x:2")', g('x:2 ~', 2).gate_sixths === 12);
  check('gate applies to a whole CHORD token ("c3+eb3+g3:8")',
    JSON.stringify(g('c3+eb3+g3:8', 1).notes) === '[48,51,55]' && g('c3+eb3+g3:8', 1).gate_sixths === 48);
  check('gate combines with repeat, gate first ("c3:2*4")',
    parseVoiceLine('c3:2*4', 4).every((s) => s.on && s.gate_sixths === 12));

  // A length the field cannot hold is REFUSED, never rounded: a silently
  // shortened note is the failure this whole surface exists to stop.
  check('gate ":0.4" throws (2.4 sixths is not a whole sixth)', threwPattern(() => parseVoiceLine('c3:0.4', 1)));
  check('gate ":17" throws (past the 16-step ceiling)', threwPattern(() => parseVoiceLine('c3:17', 1)));
  check('gate ":0" throws (the device never writes a zero gate)', threwPattern(() => parseVoiceLine('c3:0', 1)));
  check('gate ":" with no length throws', threwPattern(() => parseVoiceLine('c3:', 1)));
  check('gate on a REST throws (a rest has no length)', threwPattern(() => parseVoiceLine('~:4 c3', 2)));
  check('gate written AFTER the repeat ("c3*4:2") throws with the order named',
    threwPattern(() => parseVoiceLine('c3*4:2', 4)));

  // TIE-FORWARD. Bare `_` COMPUTES the gate that reaches the next onset, so a
  // caller cannot author the device's silent no-op (a tie too short to reach).
  const tied = parseVoiceLine('c3_ ~ ~ ~ c3 ~ ~ ~', 8);
  check('tie "_" sets tie=true', tied[0].tie === true);
  check('tie "_" computes the gate to reach the next onset exactly (4 steps = 24)',
    tied[0].gate_sixths === 24, String(tied[0].gate_sixths));
  check('tie "_" leaves the onset it ties INTO untied and default-length',
    tied[4].tie === undefined && tied[4].gate_sixths === undefined);
  const wrap = parseVoiceLine('c3_ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~', 16);
  check('tie "_" on the ONLY onset wraps to its own next repeat (16 steps = 96), the manual\'s worked example',
    wrap[0].gate_sixths === 96 && wrap[0].tie === true, String(wrap[0].gate_sixths));
  check('tie "_" that would need more than 16 steps to reach throws',
    threwPattern(() => parseVoiceLine('c3_' + ' ~'.repeat(31), 32)));
  const both = parseVoiceLine('c3:16_ ~ ~ ~', 4);
  check('explicit length + tie ("c3:16_") keeps the stated length', both[0].gate_sixths === 96 && both[0].tie === true);
  check('a bare "_" token throws (it is a suffix, not a token)', threwPattern(() => parseVoiceLine('c3 _ ~ ~', 4)));

  // Nothing that parsed before changes meaning, and a lone gated token is
  // detected as mini-notation rather than falling through to the char grid.
  check('parseVoice auto-detects a lone "c3:4" as mini-notation', parseVoice('c3:4', 1)[0].gate_sixths === 24);
  check('parseVoice still reads a plain char grid unchanged',
    JSON.stringify(hits(parseVoice('x...x...'))) === '[0,4]');
  check('an ungated pattern carries NO gate/tie fields at all (identity for everything already authored)',
    parseVoiceLine('c3 ~ c3 ~', 4).every((s) => s.gate_sixths === undefined && s.tie === undefined));
  check('comma-stack voice naming strips the gate suffix ("bd:2*4" is still the kick voice)',
    Object.keys(parseMiniNotation('bd:2*4, hh*8', 8)).join(',') === 'kick,hat',
    Object.keys(parseMiniNotation('bd:2*4, hh*8', 8)).join(','));

  // The IMPORTER-side conversion, the other half of the same unit. An importer
  // (a .mid file, a Songsterr tab) produces arbitrary real durations, so it
  // rounds and caps and REPORTS, where hand-authored notation throws.
  check('gateSixthsFromSteps(4) = 24 exactly, nothing reported',
    (() => { const r = gateSixthsFromSteps(4); return r.gate_sixths === 24 && !r.rounded && !r.clamped; })());
  check('gateSixthsFromSteps(1/3) = 2 sixths exactly (a triplet that DOES land on a sixth)',
    (() => { const r = gateSixthsFromSteps(1 / 3); return r.gate_sixths === 2 && !r.rounded; })());
  check('gateSixthsFromSteps(0.4) rounds to 2 and SAYS it rounded',
    (() => { const r = gateSixthsFromSteps(0.4); return r.gate_sixths === 2 && r.rounded && !r.clamped; })());
  check('gateSixthsFromSteps(32) caps at the 16-step ceiling and SAYS it clamped',
    (() => { const r = gateSixthsFromSteps(32); return r.gate_sixths === 96 && r.clamped; })());
  check('gateSixthsFromSteps(0) floors at one sixth rather than emitting an illegal 0',
    (() => { const r = gateSixthsFromSteps(0); return r.gate_sixths === 1 && r.clamped; })());
}


// ── Euclid (Bjorklund) ─────────────────────────────────────────────
{
  check('euclid(3,8) = x..x..x.', euclidToString(euclid(3, 8)) === 'x..x..x.', euclidToString(euclid(3, 8)));
  check('euclid(5,16,2) = .x..x..x..x...x.', euclidToString(euclid(5, 16, 2)) === '.x..x..x..x...x.', euclidToString(euclid(5, 16, 2)));
  check('euclid(0,8) all rests', euclidToString(euclid(0, 8)) === '........');
  check('euclid(8,8) all hits', euclidToString(euclid(8, 8)) === 'xxxxxxxx');
  check('euclid bad pulses errors', threwPattern(() => euclid(9, 8)));
}

// ── Compile + voice_map ────────────────────────────────────────────
const caps = (realizers: DeviceCapabilities['pattern_realizers'], voiceMap?: DeviceCapabilities['voice_map']): DeviceCapabilities => ({
  slot_model: 'linear', has_scenes: false, has_channels: false, supports_save: false, supports_lineage: false,
  pattern_realizers: realizers, voice_map: voiceMap,
});
const DRUM_MAP = { kick: { channel: 10, note: 60 }, snare: { channel: 10, note: 62 }, hat: { channel: 10, note: 64 } };
{
  const plan = compileToPlan(PATTERN_RECIPES.four_on_the_floor, caps(['live_stream'], DRUM_MAP), { bpm: 120, mode: 'live_stream' });
  const kickTimes = plan.events.filter((e) => e.note === 60).map((e) => e.time_ms).sort((a, b) => a - b);
  check('compile four_on_the_floor @120: kick at 0/500/1000/1500ms',
    JSON.stringify(kickTimes) === '[0,500,1000,1500]', JSON.stringify(kickTimes));
  check('compile cycle_ms = 2000 (16 steps × 125ms)', plan.cycle_ms === 2000, String(plan.cycle_ms));
  check('compile kick fires on ch10', plan.events.filter((e) => e.note === 60).every((e) => e.channel === 10));

  // A melodic voice with no entry is UNFOLDABLE → typed error (no silent drop).
  const unmapped: NeutralPattern = { name: 'x', steps: 4, voices: { bass: { steps: charGridToSteps('x...') } } };
  let code = '';
  try { resolvePatternVoices(unmapped, caps(['live_stream'], DRUM_MAP)); } catch (e) { if (e instanceof PatternError) code = e.code; }
  check('unmapped melodic voice → unmapped_voice (no silent drop)', code === 'unmapped_voice', code);

  // A drum voice the map lacks FOLDS to the nearest substitute + is reported.
  const tomPat: NeutralPattern = { name: 't', steps: 4, voices: { tom: { steps: charGridToSteps('x...') } } };
  const tomRes = resolvePatternVoicesDetailed(tomPat, caps(['live_stream'], DRUM_MAP));
  check('fold: tom on a kick/snare/hat kit → snare, reported',
    tomRes.targets.tom?.note === 62 && tomRes.folds.length === 1 && tomRes.folds[0].folded_to === 'snare',
    JSON.stringify(tomRes));
  // A drum voice whose whole chain misses still errors (conga on kick/snare/hat).
  const congaPat: NeutralPattern = { name: 'c', steps: 4, voices: { conga: { steps: charGridToSteps('x...') } } };
  let congaCode = '';
  try { resolvePatternVoices(congaPat, caps(['live_stream'], DRUM_MAP)); } catch (e) { if (e instanceof PatternError) congaCode = e.code; }
  check('fold: conga with no substitute on the kit → unmapped_voice', congaCode === 'unmapped_voice', congaCode);

  // Micro-step roll carries Step.roll → event.micro_hits (drum hat with a buzz).
  const rollPat: NeutralPattern = { name: 'r', steps: 8, voices: { hat: { steps: charGridToSteps('x.x.x.6.') } } };
  const rp = compileToPlan(rollPat, caps(['ncs_upload'], DRUM_MAP), { bpm: 120, mode: 'ncs_upload' });
  const buzz = rp.events.find((e) => e.time_ms === Math.round(6 * (rp.cycle_ms / 8)));
  check('compile carries roll → event.micro_hits=6 on the buzz step', buzz?.micro_hits === 6, JSON.stringify(buzz));
  check('compile leaves micro_hits absent on plain hits', rp.events.filter((e) => e.time_ms === 0)[0].micro_hits === undefined);

  // Micro-tick PLACEMENT (Front B): Step.micro=[0,3] compiles to TWO events —
  // an on-grid one (no micro field, identity) and one at +3/6 of a step with
  // event.micro=3. 8 steps @120 → stepMs 250, so the placed onset is at 125ms.
  const microSteps = charGridToSteps('x.......');
  microSteps[0] = { ...microSteps[0], micro: [0, 3] };
  const microPat: NeutralPattern = { name: 'm', steps: 8, voices: { hat: { steps: microSteps } } };
  const mp = compileToPlan(microPat, caps(['ncs_upload'], DRUM_MAP), { bpm: 120, mode: 'ncs_upload' });
  const microTimes = mp.events.map((e) => [e.time_ms, e.micro ?? 0]);
  check('compile micro [0,3] → two events at 0ms (no micro) and 125ms (micro 3)',
    JSON.stringify(microTimes.sort((a, b) => a[0] - b[0])) === '[[0,0],[125,3]]', JSON.stringify(microTimes));
  check('compile on-grid event leaves micro absent (identity)',
    mp.events.find((e) => e.time_ms === 0)?.micro === undefined);
}

// ── Compile carries the note length + tie through to the plan ──────
{
  const bassCaps = caps(['ncs_upload'], { bass: { channel: 3, note: 36 } });
  const one = (src: string, steps: number) => compileToPlan(
    { name: 'gate', steps, bars: 1, voices: { bass: { steps: parseVoiceLine(src, steps) } } },
    bassCaps, { bpm: 120, mode: 'ncs_upload' },
  ).events;

  // 16 steps @120 bpm ⇒ stepMs 125; 4 steps @120 ⇒ stepMs 500.
  const plain = one('c3 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~', 16);
  check('compile: a step with NO stated length keeps the historical 0.9-step gate and emits no gate_sixths',
    plain[0].duration_ms === Math.round(125 * 0.9) && plain[0].gate_sixths === undefined && plain[0].tie === undefined,
    `${plain[0].duration_ms} ms`);
  const four = one('c3:4 ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~', 16);
  check('compile: ":4" carries gate_sixths 24 onto the event', four[0].gate_sixths === 24, String(four[0].gate_sixths));
  check('compile: ":4" is EXACTLY four steps of ms (500), with no 10% shave; mid-hold a shave is an audible stutter',
    four[0].duration_ms === 500, `${four[0].duration_ms} ms`);
  const sixth = one('c3:1/6 ~ ~ ~', 4);
  check('compile: a sub-step gate is honored down to the 20 ms audibility floor',
    sixth[0].duration_ms === Math.max(20, Math.round(500 / 6)), `${sixth[0].duration_ms} ms`);
  const tie = one('c3:16_ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~', 16);
  check('compile: a tie rides through to the event as tie:true alongside its length',
    tie[0].tie === true && tie[0].gate_sixths === 96);
  // A chord emits one event per note; every one carries the step's length,
  // because the device's tie is a per-STEP control.
  const chord = compileToPlan(
    { name: 'c', steps: 4, bars: 1, voices: { chord: { steps: parseVoiceLine('c3+eb3+g3:8_ ~ ~ ~', 4) } } },
    caps(['ncs_upload'], { chord: { channel: 1, note: 60 } }), { bpm: 120, mode: 'ncs_upload' },
  ).events;
  check('compile: every note of a chord carries the same length and tie',
    chord.length === 3 && chord.every((e) => e.gate_sixths === 48 && e.tie === true));

  // Programmatic callers bypass the notation, so the compiler bounds the field
  // itself rather than trusting whatever reached it.
  const bad = (gate: number): NeutralPattern =>
    ({ name: 'bad', steps: 4, bars: 1, voices: { bass: { steps: [{ on: true, gate_sixths: gate }, { on: false }, { on: false }, { on: false }] } } });
  check('compile: gate_sixths 0 throws', threwPattern(() => compileToPlan(bad(0), bassCaps, { bpm: 120, mode: 'ncs_upload' })));
  check('compile: gate_sixths 97 throws', threwPattern(() => compileToPlan(bad(97), bassCaps, { bpm: 120, mode: 'ncs_upload' })));
  check('compile: a fractional gate_sixths throws (the field holds whole sixths)',
    threwPattern(() => compileToPlan(bad(4.5), bassCaps, { bpm: 120, mode: 'ncs_upload' })));
}

// ── VELOCITY suffix: "@vel" ────────────────────────────────────────
//
// The grammar's only dynamic was the char-grid `X` accent, which is one bit, and
// one bit cannot carry a source's five-level dynamic ladder, a per-note accent, or
// a palm-mute velocity trim. Those all resolved correctly upstream, reached
// `Step.velocity`, and then died at the notation boundary, which is the boundary
// the documented workflow actually pastes through.
{
  const v = (src: string, steps: number) => parseVoiceLine(src, steps).find((s) => s.on)!;
  check('velocity "@110" on a pitch reaches Step.velocity', v('c3@110 ~ ~ ~', 4).velocity === 110, String(v('c3@110 ~ ~ ~', 4).velocity));
  check('velocity on a DRUM word works too ("bd@70")', v('bd@70 ~', 2).velocity === 70);
  check('velocity on an un-pitched hit works too ("x@70")', v('x@70 ~', 2).velocity === 70);
  check('velocity 1 and 127 are both legal (1 is the quietest AUDIBLE hit)',
    v('c3@1', 1).velocity === 1 && v('c3@127', 1).velocity === 127);
  check('velocity + gate together ("c3:4@110")',
    v('c3:4@110 ~ ~ ~', 4).velocity === 110 && v('c3:4@110 ~ ~ ~', 4).gate_sixths === 24,
    JSON.stringify(v('c3:4@110 ~ ~ ~', 4)));
  // Order-independent on purpose: an emitter that writes them the other way round
  // should not produce a string its own parser rejects.
  check('the suffixes read in EITHER order ("c3@110:4" == "c3:4@110")',
    JSON.stringify(v('c3@110:4 ~ ~ ~', 4)) === JSON.stringify(v('c3:4@110 ~ ~ ~', 4)),
    `${JSON.stringify(v('c3@110:4 ~ ~ ~', 4))} vs ${JSON.stringify(v('c3:4@110 ~ ~ ~', 4))}`);
  check('velocity + gate + TIE together ("c3:16@110_")',
    v('c3:16@110_ ~ ~ ~', 4).velocity === 110 && v('c3:16@110_ ~ ~ ~', 4).gate_sixths === 96 && v('c3:16@110_ ~ ~ ~', 4).tie === true,
    JSON.stringify(v('c3:16@110_ ~ ~ ~', 4)));
  check('velocity survives a fractional gate ("c3:1/2@68", the palm-mute shape)',
    v('c3:1/2@68', 1).velocity === 68 && v('c3:1/2@68', 1).gate_sixths === 3, JSON.stringify(v('c3:1/2@68', 1)));
  check('velocity applies to a whole CHORD token, as one set of suffixes',
    JSON.stringify(v('c3+eb3+g3:8@95', 1)) === JSON.stringify({ on: true, notes: [48, 51, 55], gate_sixths: 48, velocity: 95 }),
    JSON.stringify(v('c3+eb3+g3:8@95', 1)));
  check('velocity combines with repeat ("c3@95*4"), the suffix going BEFORE the star',
    parseVoiceLine('c3@95*4', 4).every((s) => s.on && s.velocity === 95));
  // Velocity 0 is a note-OFF on the wire, so accepting it would author silence
  // that reads as a quiet note. Out of range REFUSES rather than clamping.
  check('velocity 0 is REFUSED (0 is a note-off, not a quiet note)', threwPattern(() => parseVoiceLine('c3@0', 1)));
  check('velocity 128 is REFUSED rather than clamped', threwPattern(() => parseVoiceLine('c3@128', 1)));
  check('a bare "@" with no number is REFUSED', threwPattern(() => parseVoiceLine('c3@', 1)));
  check('a velocity with no note before it is REFUSED', threwPattern(() => parseVoiceLine('@95', 1)));
  check('a velocity on a REST is REFUSED (a rest has no loudness)', threwPattern(() => parseVoiceLine('c3 ~@95', 2)));
  check('parseVoice auto-detects a lone "c3@110" as mini-notation', parseVoice('c3@110', 1)[0].velocity === 110);
  check('an unmarked pattern still carries NO velocity (identity for everything already authored)',
    parseVoiceLine('c3 ~ c3 ~', 4).every((s) => s.velocity === undefined));
  check('comma-stack voice naming strips the velocity suffix too ("bd@70*4" is still the kick voice)',
    Object.keys(parseMiniNotation('bd@70*4, hh*8', 8)).join(',') === 'kick,hat',
    Object.keys(parseMiniNotation('bd@70*4, hh*8', 8)).join(','));
  // And it has to reach the wire, not just the Step.
  const compiled = compileToPlan(
    { name: 'v', steps: 4, bars: 1, voices: { bass: { steps: parseVoiceLine('c3@110 ~ c3@40 ~', 4) } } },
    caps(['ncs_upload'], { bass: { channel: 3, note: 36 } }), { bpm: 120, mode: 'ncs_upload' },
  );
  check('compile: an @vel step carries that velocity onto the realize event',
    compiled.events.filter((e) => e.velocity === 110).length === 1 && compiled.events.filter((e) => e.velocity === 40).length === 1,
    JSON.stringify(compiled.events.map((e) => e.velocity)));
}

// ── Even time-division at 12 / 24 / 48 tokens ──────────────────────
//
// `walk` builds each leaf's position as `index * (1/n)`, which is NOT the same
// double as `index / n`. At 12, 24 and 48 tokens that puts specific indices a hair
// LOW, so a bare floor lands them on the PREVIOUS cell and the line dies with
// "places more hits than N steps can hold". A 24-step row is a 6/8 or 12/8 bar at
// a 16th grid, i.e. every measure of a song like Schism, so this is not an exotic
// case; importing one threw until the conversion gained an epsilon.
{
  for (const n of [6, 12, 16, 24, 32, 48]) {
    const line = Array.from({ length: n }, (_, i) => `c${(i % 8) + 1}`).join(' ');
    const parsed = parseVoiceLine(line, n);
    check(`even division: ${n} tokens over ${n} steps fill every cell, one hit each, no phantom collision`,
      parsed.length === n && parsed.every((s) => s.on), `${parsed.filter((s) => s.on).length}/${n}`);
  }
  // The exact indices the float error hit, pinned so a refactor cannot reintroduce it.
  const at24 = parseVoiceLine(Array.from({ length: 24 }, (_, i) => (i === 7 || i === 14 ? 'c4' : '~')).join(' '), 24);
  check('even division: at 24 steps, tokens 7 and 14 land on cells 7 and 14 (they used to land on 6 and 13)',
    at24[7].on && at24[14].on && !at24[6].on && !at24[13].on,
    JSON.stringify(at24.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0)));
}

// ── Compile overrides: external-instrument routing (apply_pattern external_targets) ──
{
  // kick stays on the host (ch10/60); snare is OVERRIDDEN to an external pad
  // (ch4/61) — the external SPD-SX note on the host's MIDI2 track channel.
  const pat: NeutralPattern = {
    name: 'ext', steps: 8,
    voices: { kick: { steps: charGridToSteps('x...x...') }, snare: { steps: charGridToSteps('....x...') } },
  };
  const plan = compileToPlan(pat, caps(['ncs_upload'], DRUM_MAP), {
    bpm: 120, mode: 'ncs_upload', overrides: { snare: [{ channel: 4, note: 61 }] },
  });
  const kicks = plan.events.filter((e) => e.channel === 10);
  const snares = plan.events.filter((e) => e.channel === 4);
  check('override: non-overridden kick stays on host ch10/60',
    kicks.length === 2 && kicks.every((e) => e.note === 60), JSON.stringify(kicks.map((e) => [e.channel, e.note])));
  check('override: snare routed external-only to ch4/61 (not the host voice_map ch10)',
    snares.length === 1 && snares[0].note === 61 && plan.events.filter((e) => e.note === 61 && e.channel === 10).length === 0,
    JSON.stringify(snares.map((e) => [e.channel, e.note])));

  // "both at once": a voice with TWO destinations (internal + external) emits the
  // hit on each channel at the same step.
  const both = compileToPlan(pat, caps(['ncs_upload'], DRUM_MAP), {
    bpm: 120, mode: 'ncs_upload', overrides: { snare: [{ channel: 10, note: 62 }, { channel: 4, note: 61 }] },
  });
  const snStep4 = both.events.filter((e) => e.time_ms === Math.round(4 * (both.cycle_ms / 8)));
  check('override: a two-destination voice emits internal (ch10/62) AND external (ch4/61) at the same step',
    snStep4.some((e) => e.channel === 10 && e.note === 62) && snStep4.some((e) => e.channel === 4 && e.note === 61),
    JSON.stringify(snStep4.map((e) => [e.channel, e.note])));

  // An external-ONLY voice (absent from the host voice_map) must NOT trip the
  // unmapped-voice gate when supplied as an override — whole-groove-to-external.
  const ext: NeutralPattern = { name: 'extonly', steps: 4, voices: { ride: { steps: charGridToSteps('x.x.') } } };
  const eplan = compileToPlan(ext, caps(['ncs_upload'], DRUM_MAP), {
    bpm: 120, mode: 'ncs_upload', overrides: { ride: [{ channel: 4, note: 66 }] },
  });
  check('override: an external-only voice (not in host voice_map) compiles via the override',
    eplan.events.length === 2 && eplan.events.every((e) => e.channel === 4 && e.note === 66), JSON.stringify(eplan.events.map((e) => [e.channel, e.note])));
}

// ── Compile melodic: per-step pitch + chord = one event per note ────
{
  const MELODIC_MAP = { bass: { channel: 1, note: 36 }, chord: { channel: 1, note: 60 } };
  // A two-stab chord on ch1 → 3 simultaneous events per stab, all the chord notes.
  const chordPat: NeutralPattern = { name: 'c', steps: 4, voices: { chord: { steps: parseVoiceLine('c3+eb3+g3 ~ ~ ~', 4) } } };
  const plan = compileToPlan(chordPat, caps(['live_stream'], MELODIC_MAP), { bpm: 120, mode: 'live_stream' });
  const t0 = plan.events.filter((e) => e.time_ms === 0);
  check('compile chord: 3 events at t0', t0.length === 3, String(t0.length));
  check('compile chord: notes 48/51/55 all on ch1', JSON.stringify(t0.map((e) => e.note).sort((a, b) => a - b)) === '[48,51,55]' && t0.every((e) => e.channel === 1));

  // A bassline: pitch per step overrides the voice_map default note.
  const bassPat: NeutralPattern = { name: 'b', steps: 4, voices: { bass: { steps: parseVoiceLine('c2 ~ g2 ~', 4) } } };
  const bplan = compileToPlan(bassPat, caps(['live_stream'], MELODIC_MAP), { bpm: 120, mode: 'live_stream' });
  check('compile bassline: notes 36 then 43 (not the voice_map default twice)',
    JSON.stringify(bplan.events.map((e) => e.note)) === '[36,43]', JSON.stringify(bplan.events.map((e) => e.note)));

  // An un-pitched hit still uses the voice_map note.
  const rhythmPat: NeutralPattern = { name: 'r', steps: 4, voices: { bass: { steps: charGridToSteps('x...') } } };
  const rplan = compileToPlan(rhythmPat, caps(['live_stream'], MELODIC_MAP), { bpm: 120, mode: 'live_stream' });
  check('compile un-pitched bass uses voice_map note 36', rplan.events.length === 1 && rplan.events[0].note === 36);
}

// ── Transpose / key (melodic recipes are C-based) ──────────────────
{
  const MELODIC_MAP = { bass: { channel: 1, note: 36 }, chord: { channel: 1, note: 60 } };

  // keyToSemitones: root → offset from C (mode suffix ignored).
  check('keyToSemitones C=0, G=7, Eb=3, F#=6', keyToSemitones('C') === 0 && keyToSemitones('G') === 7 && keyToSemitones('Eb') === 3 && keyToSemitones('F#') === 6);
  check('keyToSemitones ignores mode suffix ("Gm"=7, "A minor"=9)', keyToSemitones('Gm') === 7 && keyToSemitones('A minor') === 9);
  check('keyToSemitones rejects junk', threwPattern(() => keyToSemitones('xyz')));

  // resolveTranspose: the apply_pattern key/transpose precedence (dispatcher seam).
  check('resolveTranspose: key "G" → 7', resolveTranspose(undefined, 'G') === 7);
  check('resolveTranspose: explicit transpose wins over key', resolveTranspose(-5, 'G') === -5);
  check('resolveTranspose: neither → 0', resolveTranspose(undefined, undefined) === 0);
  check('resolveTranspose: transpose 0 is honored (not treated as absent)', resolveTranspose(0, 'G') === 0);

  // Transpose shifts AUTHORED pitches.
  const chordPat: NeutralPattern = { name: 'c', steps: 4, voices: { chord: { steps: parseVoiceLine('c3+eb3+g3 ~ ~ ~', 4) } } };
  const up7 = compileToPlan(chordPat, caps(['live_stream'], MELODIC_MAP), { bpm: 120, mode: 'live_stream', transpose: 7 });
  check('transpose +7: chord [48,51,55] → [55,58,62]',
    JSON.stringify(up7.events.map((e) => e.note).sort((a, b) => a - b)) === '[55,58,62]', JSON.stringify(up7.events.map((e) => e.note)));

  // Transpose does NOT touch un-pitched/drum-default notes.
  const rhythmPat: NeutralPattern = { name: 'r', steps: 4, voices: { bass: { steps: charGridToSteps('x...') } } };
  const rt = compileToPlan(rhythmPat, caps(['live_stream'], MELODIC_MAP), { bpm: 120, mode: 'live_stream', transpose: 7 });
  check('transpose leaves un-pitched (voice_map) note alone: still 36', rt.events[0].note === 36, String(rt.events[0].note));

  // Out-of-range transpose is an error, not a silently clamped/wrong note.
  check('transpose past MIDI 127 throws (no silent clamp)',
    threwPattern(() => compileToPlan(chordPat, caps(['live_stream'], MELODIC_MAP), { bpm: 120, mode: 'live_stream', transpose: 80 })));
}

// ── Melodic library recipes parse + resolve ─────────────────────────
{
  const MELODIC_MAP = {
    bass: { channel: 1, note: 36 }, chord: { channel: 1, note: 60 },
    lead: { channel: 2, note: 72 }, arp: { channel: 2, note: 60 },
  };
  for (const id of ['minor_triad', 'major_triad', 'octave_bass', 'minor_arp_up', 'lead_hook']) {
    const recipe = resolvePatternRecipe(id)!;
    check(`library "${id}" exists + resolves on a melodic voice_map`,
      recipe !== undefined && (() => { try { resolvePatternVoices(recipe, caps(['ncs_upload'], MELODIC_MAP)); return true; } catch { return false; } })());
  }
  // The chord recipe really carries a chord (>1 note in a step).
  const triad = resolvePatternRecipe('minor_triad')!;
  const firstChordStep = triad.voices.chord.steps.find((s) => s.on)!;
  check('minor_triad step is a 3-note chord', Array.isArray(firstChordStep.notes) && (firstChordStep.notes as number[]).length === 3);
}

// ── Realizer gate ──────────────────────────────────────────────────
{
  check('selectRealizer default = first declared', selectRealizer(caps(['live_stream'])) === 'live_stream');
  check('selectRealizer honors supported request',
    selectRealizer(caps(['live_stream', 'record_capture']), 'record_capture') === 'record_capture');
  let c1 = '';
  try { selectRealizer(caps(['live_stream']), 'record_capture'); } catch (e) { if (e instanceof PatternError) c1 = e.code; }
  check('selectRealizer rejects unsupported mode', c1 === 'realizer_not_supported', c1);
  let c2 = '';
  try { selectRealizer(caps([])); } catch (e) { if (e instanceof PatternError) c2 = e.code; }
  check('selectRealizer rejects non-target', c2 === 'not_a_pattern_target', c2);
  let c3 = '';
  try { selectRealizer(caps(['ncs_upload']), 'ncs_upload'); } catch (e) { if (e instanceof PatternError) c3 = e.code; }
  // ncs_upload is selectable only if declared; the realizer itself throws not_implemented at run time.
  check('ncs_upload selectable when declared (run-time stub throws elsewhere)', c3 === '', c3);
}

// ── Accent only on literal 'X' (not uppercase drum tokens) ─────────
{
  const up = parseVoiceLine('BD ~ ~ ~', 4);
  check('uppercase token "BD" is a plain hit, not an accent', up[0].on && !up[0].accent, JSON.stringify(up[0]));
  const k = parseMiniNotation('K ~ K ~', 4);
  check('comma-stack "K" keys to kick, unaccented', 'kick' in k && k.kick[0].on === true && !k.kick[0].accent);
}

// ── Over-density: no silent drop ───────────────────────────────────
check('mini "hh*8" over 4 steps throws (collision, no silent drop)', threwPattern(() => parseVoiceLine('hh*8', 4)));

// ── '0' is a rest in mini-notation too (vocabulary unified) ────────
check('mini "x 0 x 0" → 0 is a rest, hits 0,2', JSON.stringify(hits(parseVoiceLine('x 0 x 0', 4))) === '[0,2]');

// ── Euclidean reachable via parseVoice / parseVoiceLine ────────────
{
  const e = parseVoice('E(3,8)');
  check('parseVoice "E(3,8)" = euclidean hits 0,3,6', JSON.stringify(hits(e)) === '[0,3,6]', JSON.stringify(hits(e)));
  const e2 = parseVoice('E(5,16)');
  check('parseVoice "E(5,16)" = 16 steps, 5 hits', e2.length === 16 && hits(e2).length === 5);
  check('E(5,16) length mismatch vs steps errors', threwPattern(() => parseVoiceLine('E(5,16)', 8)));
}

// ── bars != 1 guard (multi-bar is phase-C) ─────────────────────────
{
  const multi: NeutralPattern = { name: 'm', steps: 4, bars: 2, voices: { kick: { steps: charGridToSteps('x...') } } };
  let code = '';
  try { compileToPlan(multi, caps(['live_stream'], DRUM_MAP), { bpm: 120, mode: 'live_stream' }); } catch (e) { if (e instanceof PatternError) code = e.code; }
  check('bars != 1 throws bad_grid', code === 'bad_grid', code);
}

// ── Library integrity ──────────────────────────────────────────────
{
  let ok = true;
  let detail = '';
  for (const [id, p] of Object.entries(PATTERN_RECIPES)) {
    if (resolvePatternRecipe(id) !== p) { ok = false; detail = `resolve ${id}`; break; }
    for (const [v, voice] of Object.entries(p.voices)) {
      if (voice.steps.length !== p.steps) { ok = false; detail = `${id}.${v} len ${voice.steps.length} ≠ ${p.steps}`; break; }
    }
  }
  check('every library recipe: voices match step count + resolve by id', ok, detail);
}

// ── ASCII drum tab ─────────────────────────────────────────────────
{
  const tab = ['HH|x-x-x-x-|', 'SD|----o---|', 'BD|o---o---|'].join('\n');
  const p = parseDrumTab(tab);
  check('drum tab: 8 steps', p.steps === 8, String(p.steps));
  check('drum tab: HH→hat on even steps', JSON.stringify(hits(p.voices.hat)) === '[0,2,4,6]', JSON.stringify(hits(p.voices.hat)));
  check('drum tab: SD→snare at 4, BD→kick at 0,4',
    JSON.stringify(hits(p.voices.snare)) === '[4]' && JSON.stringify(hits(p.voices.kick)) === '[0,4]');

  // Accent / buzz roll / ghost glyphs.
  const p2 = parseDrumTab('HH|x-X-b-g-|');
  check('drum tab: X = accent', p2.voices.hat[2].on && p2.voices.hat[2].accent === true);
  check('drum tab: b = buzz roll (roll 6, the only verified micro-roll)', p2.voices.hat[4].roll === 6);
  check('drum tab: g = ghost (low velocity)', p2.voices.hat[6].velocity === 40);

  // No-pipe form + full-word labels.
  const p3 = parseDrumTab('Bass Drum o-------\nSnare     ----o---');
  check('drum tab no-pipe: "Bass Drum"→kick, "Snare"→snare',
    JSON.stringify(hits(p3.voices.kick)) === '[0]' && JSON.stringify(hits(p3.voices.snare)) === '[4]');

  // Multi-system: blank-line-separated bar groups CONCATENATE (not merge).
  const multi = ['HH|x-x-|', 'BD|o---|', '', 'HH|x-x-|', 'BD|o-o-|'].join('\n');
  const pm = parseDrumTab(multi);
  check('drum tab multi-system: concatenates to 8 steps', pm.steps === 8, String(pm.steps));
  check('drum tab multi-system: kick = sys1 ++ sys2', JSON.stringify(hits(pm.voices.kick)) === '[0,4,6]', JSON.stringify(hits(pm.voices.kick)));

  // Count rulers + prose are ignored; real voices still parse.
  const noisy = ['  |1 + 2 + 3 + 4 +|', 'HH|x-x-x-x-x-x-x-x-|', 'BD|o-------o-------|', '(verse groove)'].join('\n');
  const pn = parseDrumTab(noisy);
  check('drum tab: count/prose lines ignored', pn.voices.hat !== undefined && pn.voices.kick !== undefined && pn.steps === 16,
    JSON.stringify({ voices: Object.keys(pn.voices), steps: pn.steps }));

  check('drum tab: no recognizable lines throws', threwPattern(() => parseDrumTab('hello there\nnot a tab at all')));
}

// ── Drum-score quantizer (GP/MusicXML/MIDI importer core) ───────────
{
  // GM percussion → voice mapping.
  check('gmDrumToVoice: 36→kick, 38→snare, 42→hat, 46→openhat, 49→crash, 51→ride',
    gmDrumToVoice(36) === 'kick' && gmDrumToVoice(38) === 'snare' && gmDrumToVoice(42) === 'hat' &&
    gmDrumToVoice(46) === 'openhat' && gmDrumToVoice(49) === 'crash' && gmDrumToVoice(51) === 'ride');
  check('gmDrumToVoice: unknown note → undefined', gmDrumToVoice(99) === undefined);

  // ── Canonical drum-role spine (cross-dialect reconciliation) ──
  check('canonicalRole: hat/openhat dialects → closed_hat/open_hat',
    canonicalRole('hat') === 'closed_hat' && canonicalRole('openhat') === 'open_hat' &&
    canonicalRole('Open Hat') === 'open_hat' && canonicalRole('closed_hat') === 'closed_hat');
  check('canonicalRole: identity + normalization (kick, RIDE-BELL → ride_bell)',
    canonicalRole('kick') === 'kick' && canonicalRole('RIDE-BELL') === 'ride_bell' && canonicalRole('side stick') === 'sticks');
  check('canonicalRole: unknown → undefined', canonicalRole('didgeridoo') === undefined);
  // EVERY GM import voice must resolve to a canonical role (else imported grooves
  // can't map to any device target).
  check('every GM_DRUM_TO_VOICE value resolves to a canonical role',
    Object.values(GM_DRUM_TO_VOICE).every((v) => canonicalRole(v) !== undefined),
    Object.values(GM_DRUM_TO_VOICE).filter((v) => canonicalRole(v) === undefined).join(','));
  // The SPD-SX voice_map dialect (kit/snare/hat/clap/openhat/tom/perc) must reconcile too.
  check('SPD-SX voice dialect (hat/openhat/clap/perc/tom) all resolve',
    ['kick', 'snare', 'hat', 'clap', 'openhat', 'tom', 'perc'].every((v) => canonicalRole(v) !== undefined));
  check('DRUM_ROLES are self-canonical (each resolves to itself)',
    DRUM_ROLES.every((r) => canonicalRole(r) === r));

  // ── Fold layer (drumFold.ts): dense kit → small kit, loudly ──
  // Every fold-chain candidate must itself be a canonical role.
  check('ROLE_FOLDS: every chain entry is a canonical role',
    Object.values(ROLE_FOLDS).every((chain) => chain!.every((r) => canonicalRole(r) === r)));
  // kick/snare stay terminal — a groove's backbone is never re-voiced.
  check('ROLE_FOLDS: kick and snare are terminal (no fold chain)',
    ROLE_FOLDS.kick === undefined && ROLE_FOLDS.snare === undefined);

  const SPDSX_KEYS = ['kick', 'snare', 'hat', 'openhat', 'clap', 'tom', 'ride', 'crash', 'perc'];
  const spdIdx = indexMapByRole(SPDSX_KEYS);
  check('fold: china → the SPD-SX crash pad',
    foldVoice('china', spdIdx)?.map_key === 'crash');
  check('fold: bongo → the SPD-SX tom pad (conga absent, tom next)',
    foldVoice('bongo', spdIdx)?.map_key === 'tom');
  check('fold: dialect identity — closed_hat finds the map\'s "hat" spelling',
    foldVoice('closed_hat', spdIdx)?.map_key === 'hat' && foldVoice('closed_hat', spdIdx)?.folded_to === 'closed_hat');
  check('fold: melodic voice never folds', foldVoice('bass', spdIdx) === undefined);
  // The 30+-piece guarantee: EVERY GM 35-81 voice lands on the 9-pad SPD-SX
  // map, directly or via a fold — a dense GM groove never hard-errors there.
  check('every GM_DRUM_TO_VOICE voice resolves on the 9-pad SPD-SX map (direct or fold)',
    Object.values(GM_DRUM_TO_VOICE).every((v) => SPDSX_KEYS.includes(v) || foldVoice(v, spdIdx) !== undefined),
    Object.values(GM_DRUM_TO_VOICE).filter((v) => !SPDSX_KEYS.includes(v) && foldVoice(v, spdIdx) === undefined).join(','));
  // GM 35-81 is now FULLY covered (the 30+ piece kit ask).
  check('GM_DRUM_TO_VOICE covers every note 35..81',
    Array.from({ length: 47 }, (_, i) => 35 + i).every((n) => gmDrumToVoice(n) !== undefined),
    Array.from({ length: 47 }, (_, i) => 35 + i).filter((n) => gmDrumToVoice(n) === undefined).join(','));

  // ── Piece-compression report (pieceCompression.ts) ──
  {
    // A dense groove onto a small kit: ride re-voiced (64 hits), china + crash
    // merged onto one pad, kick/snare clean.
    const rep = pieceCompression([
      { voice: 'kick', hits: 32, target: 'kick' },
      { voice: 'snare', hits: 16, target: 'snare' },
      { voice: 'ride', hits: 64, target: 'hat', substituted_as: 'closed_hat' },
      { voice: 'china', hits: 2, target: 'crash', substituted_as: 'crash' },
      { voice: 'crash', hits: 5, target: 'crash' },
    ]);
    check('pieceCompression: 5 sources → 4 targets', rep.source_pieces === 5 && rep.target_pieces === 4, JSON.stringify(rep));
    check('pieceCompression: folds sorted loudest-first (ride 64 before china 2)',
      rep.folds.length === 2 && rep.folds[0].voice === 'ride' && rep.folds[0].hits === 64);
    check('pieceCompression: china + crash merge detected with summed hits',
      rep.merges.length === 1 && rep.merges[0].target === 'crash' &&
      JSON.stringify(rep.merges[0].voices.sort()) === '["china","crash"]' && rep.merges[0].hits === 7);
    check('pieceCompression: lines carry hit counts + the headline',
      rep.lines.some((l) => /PIECE COMPRESSION: 5 source/.test(l)) &&
      rep.lines.some((l) => /ride \(64 hits\)/.test(l)) &&
      rep.lines.some((l) => /china \+ crash/.test(l)), JSON.stringify(rep.lines));

    // Silence rule: a clean mapping (no folds, no merges) reports NOTHING.
    const clean = pieceCompression([
      { voice: 'kick', hits: 32, target: 'kick' },
      { voice: 'snare', hits: 16, target: 'snare' },
      { voice: 'hat', hits: 64, target: 'hat' },
    ]);
    check('pieceCompression: clean mapping → zero lines (silence, not ceremony)',
      clean.lines.length === 0 && clean.folds.length === 0 && clean.merges.length === 0, JSON.stringify(clean.lines));

    // Review fix (2026-07-03): merges group by PHYSICAL pad (merge_key), so a
    // pinned voice + a mapped voice on the same pad merge despite different labels.
    const padClash = pieceCompression([
      { voice: 'busy_hat', hits: 40, target: 'note 39 (pinned)', merge_key: 'SPD-SX#39' },
      { voice: 'clap', hits: 6, target: 'clap (SPD-SX)', merge_key: 'SPD-SX#39' },
      { voice: 'kick', hits: 32, target: 'kick (SPD-SX)', merge_key: 'SPD-SX#36' },
    ]);
    check('pieceCompression: pin + mapped voice on one pad merge via merge_key',
      padClash.merges.length === 1 && padClash.merges[0].hits === 46 &&
      JSON.stringify(padClash.merges[0].voices.slice().sort()) === '["busy_hat","clap"]',
      JSON.stringify(padClash.merges));
  }

  // IDENTITY INVARIANT (the full-kit smoke test): on a target that owns EVERY
  // canonical role, folding never substitutes — each voice lands on its own
  // piece. Folds fire ONLY when the target genuinely lacks the piece, so a
  // richer kit always plays the groove MORE faithfully, never differently.
  const fullKitIdx = indexMapByRole([...DRUM_ROLES]);
  check('full kit: every GM voice resolves to its OWN role (no substitution)',
    Object.values(GM_DRUM_TO_VOICE).every((v) => {
      const f = foldVoice(v, fullKitIdx);
      return f !== undefined && f.folded_to === f.role;
    }),
    Object.values(GM_DRUM_TO_VOICE)
      .filter((v) => { const f = foldVoice(v, fullKitIdx); return f === undefined || f.folded_to !== f.role; })
      .join(','));

  // One 4/4 bar on a 16th grid (4 beats × 4 = 16 steps): kick 1&3, snare 2&4, 8th hats.
  const evs: DrumEvent[] = [
    { voice: 'kick', beat: 0 }, { voice: 'kick', beat: 2 },
    { voice: 'snare', beat: 1, accent: true }, { voice: 'snare', beat: 3 },
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => ({ voice: 'hat', beat: b } as DrumEvent)),
  ];
  const q = quantizeDrumEvents(evs, { beats: 4, stepsPerBeat: 4 });
  check('quantize: 16 steps', q.steps === 16, String(q.steps));
  check('quantize: kick on steps 0,8', JSON.stringify(hits(q.voices.kick)) === '[0,8]', JSON.stringify(hits(q.voices.kick)));
  check('quantize: snare on 4,12 with accent', JSON.stringify(hits(q.voices.snare)) === '[4,12]' && q.voices.snare[4].accent === true);
  check('quantize: 8th hats on even steps', JSON.stringify(hits(q.voices.hat)) === '[0,2,4,6,8,10,12,14]');

  // Identity invariant: every on-grid onset leaves `micro` ABSENT (pre-placement
  // patterns compile byte-identically).
  check('quantize: on-grid onsets carry no micro field',
    Object.values(q.voices).every((row) => row.every((s) => s.micro === undefined)));

  // Micro-tick PLACEMENT (Front B, B0-confirmed): off-grid onsets keep their
  // position inside the step instead of rounding to it.
  // Triplet onsets (1/3, 2/3 beat @16th grid): exact steps 1.33/2.67 → placed
  // at step 1 tick 2 and step 2 tick 4 (the triplet ticks).
  const trip = quantizeDrumEvents([{ voice: 'hat', beat: 0 }, { voice: 'hat', beat: 1 / 3 }, { voice: 'hat', beat: 2 / 3 }], { beats: 1, stepsPerBeat: 4 });
  check('quantize: triplet onsets warn as PLACED (not rounded)',
    trip.warnings.some((w) => /off-grid|placed/.test(w)), JSON.stringify(trip.warnings));
  check('quantize: triplet 1/3 → step 1 micro [2]',
    JSON.stringify(trip.voices.hat[1].micro) === '[2]', JSON.stringify(trip.voices.hat[1]));
  check('quantize: triplet 2/3 → step 2 micro [4]',
    JSON.stringify(trip.voices.hat[2].micro) === '[4]', JSON.stringify(trip.voices.hat[2]));
  // A 32nd off-beat (beat 0.125 @16th grid = exact step 0.5) → step 0 tick 3.
  const thirty2 = quantizeDrumEvents([{ voice: 'hat', beat: 0.125 }], { beats: 1, stepsPerBeat: 4 });
  check('quantize: off-beat 32nd → step 0 micro [3]',
    JSON.stringify(thirty2.voices.hat[0].micro) === '[3]', JSON.stringify(thirty2.voices.hat[0]));
  // A 16th + its 32nd "and" share the cell: micro lists UNION ([0,3]), no collision.
  const pairQ = quantizeDrumEvents([{ voice: 'hat', beat: 0 }, { voice: 'hat', beat: 0.125 }], { beats: 1, stepsPerBeat: 4 });
  check('quantize: 16th + 32nd "and" union to micro [0,3], no collision warning',
    JSON.stringify(pairQ.voices.hat[0].micro) === '[0,3]' && !pairQ.warnings.some((w) => /collid/.test(w)),
    JSON.stringify({ cell: pairQ.voices.hat[0], warnings: pairQ.warnings }));
  // Fractional position past tick 5.5 carries into the NEXT step's downbeat.
  const carry = quantizeDrumEvents([{ voice: 'hat', beat: 0.2295 }], { beats: 1, stepsPerBeat: 4 });
  check('quantize: sub-tick position past tick 5 carries to the next step (micro absent)',
    JSON.stringify(hits(carry.voices.hat)) === '[1]' && carry.voices.hat[1].micro === undefined,
    JSON.stringify(carry.voices.hat));

  // Collision policy: two same-voice hits on the SAME micro-tick keep the
  // LOUDEST (the accent survives even when the ghost arrived first) + warn.
  const coll = quantizeDrumEvents([{ voice: 'kick', beat: 0 }, { voice: 'kick', beat: 0.01 }], { beats: 1, stepsPerBeat: 4 });
  check('quantize: same-tick collision is flagged, one hit kept',
    JSON.stringify(hits(coll.voices.kick)) === '[0]' && coll.warnings.some((w) => /collid/.test(w)));
  const collLoud = quantizeDrumEvents(
    [{ voice: 'snare', beat: 0, ghost: true }, { voice: 'snare', beat: 0.01, accent: true }],
    { beats: 1, stepsPerBeat: 4 },
  );
  check('quantize: collision keeps the ACCENT over the earlier ghost',
    collLoud.voices.snare[0].accent === true && collLoud.voices.snare[0].velocity === undefined,
    JSON.stringify(collLoud.voices.snare[0]));
  const collRoll = quantizeDrumEvents(
    [{ voice: 'hat', beat: 0, roll: 6, ghost: true }, { voice: 'hat', beat: 0.01, accent: true }],
    { beats: 1, stepsPerBeat: 4 },
  );
  check('quantize: a buzz roll survives a collision merge (content, not dynamics)',
    collRoll.voices.hat[0].roll === 6 && collRoll.voices.hat[0].accent === true,
    JSON.stringify(collRoll.voices.hat[0]));
}

// ── Standard MIDI File drum importer ────────────────────────────────
{
  // A format-0 SMF (division 480): drum note-ons on ch9 — kick@0, snare@480,
  // kick@960, snare@1440 (one 4/4 bar), then end-of-track. Built by hand so the
  // parser is exercised against real SMF bytes (VLQ deltas, running status path).
  const events = [
    0x00, 0x99, 36, 100,            // t0   kick (GM 36)
    0x83, 0x60, 0x99, 38, 110,      // t480 snare (vel 110 → accent)
    0x83, 0x60, 0x99, 36, 100,      // t960 kick
    0x83, 0x60, 0x99, 38, 100,      // t1440 snare
    0x00, 0xff, 0x2f, 0x00,         // end of track
  ];
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0]; // MThd fmt0 ntrks1 div480
  const len = events.length;
  const trk = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];
  const smf = Uint8Array.from([...header, ...trk, ...events]);

  const parsed = parseMidiFile(smf);
  check('parseMidiFile: ticksPerBeat = 480', parsed.ticksPerBeat === 480, String(parsed.ticksPerBeat));
  check('parseMidiFile: 4 drum note-ons on ch9', parsed.notes.filter((n) => n.channel === 9).length === 4);

  const imp = importMidiDrums(smf, { stepsPerBeat: 4 });
  check('importMidiDrums: kick on beats 0,2 → steps 0,8', JSON.stringify(hits(imp.voices.kick)) === '[0,8]', JSON.stringify(imp.voices.kick && hits(imp.voices.kick)));
  check('importMidiDrums: snare on beats 1,3 → steps 4,12', JSON.stringify(hits(imp.voices.snare)) === '[4,12]');
  check('importMidiDrums: velocity 110 → accent on the first snare', imp.voices.snare[4].accent === true);
  check('importMidiDrums: total_beats ≈ one bar', imp.total_beats === 4, String(imp.total_beats));

  // Windowing: take only beats 2..4 (the second half-bar).
  const win = importMidiDrums(smf, { fromBeat: 2, beats: 2, stepsPerBeat: 4 });
  check('importMidiDrums window: 8 steps, kick at 0, snare at 4',
    win.steps === 8 && JSON.stringify(hits(win.voices.kick)) === '[0]' && JSON.stringify(hits(win.voices.snare)) === '[4]',
    JSON.stringify({ steps: win.steps, kick: hits(win.voices.kick), snare: hits(win.voices.snare) }));

  check('parseMidiFile: non-MIDI bytes throw', (() => { try { parseMidiFile(Uint8Array.from([1, 2, 3, 4])); return false; } catch { return true; } })());

  // ── Melodic import: a bassline on ch2 (0-indexed 1) + a chord on ch1 ──
  // Bass C2(36)@0, G2(43)@960 (beats 0,2); a 3-note Cm chord on ch1 @0.
  const melEvents = [
    0x00, 0x91, 36, 90,             // t0    ch2 bass C2
    0x00, 0x90, 48, 100,            // t0    ch1 chord C3
    0x00, 0x90, 51, 100,            // t0    ch1 chord Eb3
    0x00, 0x90, 55, 100,            // t0    ch1 chord G3
    0x83, 0x60, 0x91, 43, 90,       // t480  (unused - beat 1)
    0x83, 0x60, 0x91, 43, 95,       // t960  ch2 bass G2 (beat 2)
    0x00, 0xff, 0x2f, 0x00,
  ];
  const mlen = melEvents.length;
  const mtrk = [0x4d, 0x54, 0x72, 0x6b, (mlen >>> 24) & 0xff, (mlen >>> 16) & 0xff, (mlen >>> 8) & 0xff, mlen & 0xff];
  const melSmf = Uint8Array.from([...header, ...mtrk, ...melEvents]);

  const inv = midiChannelSummary(melSmf);
  check('midiChannelSummary: ch1 (chords, poly 3) + ch2 (bass) listed, 1-based',
    inv.some((c) => c.channel === 1 && c.poly === 3) && inv.some((c) => c.channel === 2 && c.low === 'C2'),
    JSON.stringify(inv));

  const bass = importMidiMelodic(melSmf, { channel: 2, stepsPerBeat: 4 });
  check('importMidiMelodic: bass notes 36@step0 (+43 later), velocity carried',
    bass.steps[0].on && bass.steps[0].notes === 36 && bass.steps[0].velocity === 90,
    JSON.stringify(bass.steps[0]));
  check('importMidiMelodic: second bass hit at beat 1 → step 4',
    bass.steps[4]?.on === true && bass.steps[4]?.notes === 43, JSON.stringify(bass.steps[4]));

  const chord = importMidiMelodic(melSmf, { channel: 1, stepsPerBeat: 4 });
  check('importMidiMelodic: same-step notes group into a sorted chord [48,51,55]',
    JSON.stringify(chord.steps[0].notes) === '[48,51,55]', JSON.stringify(chord.steps[0].notes));

  check('importMidiMelodic: empty channel throws with the channel inventory',
    (() => { try { importMidiMelodic(melSmf, { channel: 5 }); return false; } catch (e) { return /Channels in this file/.test(String(e)); } })());

  // ── Drum import from a NON-GM key map on a non-ch10 channel (drum-library
  // groove packs, e.g. Mixwave Sleep Token II: kit on ch16, keys 0..32) ──
  const packEvents = [
    0x00, 0x9f, 1, 100,             // t0    ch16 "key 1" (library kick)
    0x83, 0x60, 0x9f, 2, 90,        // t480  ch16 "key 2" (library snare)
    0x00, 0xff, 0x2f, 0x00,
  ];
  const plen = packEvents.length;
  const ptrk = [0x4d, 0x54, 0x72, 0x6b, (plen >>> 24) & 0xff, (plen >>> 16) & 0xff, (plen >>> 8) & 0xff, plen & 0xff];
  const packSmf = Uint8Array.from([...header, ...ptrk, ...packEvents]);

  const noCh = importMidiDrums(packSmf, { stepsPerBeat: 4 });
  check('importMidiDrums: default ch10 finds nothing → warning names the channels present',
    noCh.warnings.some((w) => /No notes on MIDI channel 10/.test(w) && /ch16/.test(w)), JSON.stringify(noCh.warnings));
  const noMap = importMidiDrums(packSmf, { stepsPerBeat: 4, channel: 16 });
  check('importMidiDrums: channel 16 + no map → unmapped numbers NAMED (1×1, 2×1)',
    noMap.unmapped_numbers[1] === 1 && noMap.unmapped_numbers[2] === 1 && noMap.warnings.some((w) => /unmapped number/.test(w)),
    JSON.stringify(noMap.unmapped_numbers));
  const mappedPack = importMidiDrums(packSmf, { stepsPerBeat: 4, channel: 16, drumMap: { 1: 'kick', 2: 38 } });
  check('importMidiDrums: drumMap (1→"kick", 2→GM 38) imports both, kick accented',
    hits(mappedPack.voices.kick) .length === 1 && mappedPack.voices.kick[0].accent === true && hits(mappedPack.voices.snare).length === 1,
    JSON.stringify({ kick: mappedPack.voices.kick?.[0], snare: hits(mappedPack.voices.snare ?? []) }));

  // Named drum-map presets: the Mixwave ST2 groove-pack map resolves (5
  // ear-confirmed keys, oracle cross-validated 98.5% over 81 grooves); an
  // unknown name throws WITH the available names.
  const preset = resolveDrumMapPreset('mixwave-st2-grooves');
  check('drum-map preset: mixwave-st2-grooves resolves (1→kick, 3→snare, 14→hat, 2→hat, 41→ride)',
    preset[1] === 'kick' && preset[3] === 'snare' && preset[14] === 'hat' && preset[2] === 'hat' && preset[41] === 'ride',
    JSON.stringify(preset));
  check('drum-map preset: unknown name throws naming the available presets',
    (() => { try { resolveDrumMapPreset('nope'); return false; } catch (e) { return /mixwave-st2-grooves/.test(String(e)); } })());
  const viaPreset = importMidiDrums(packSmf, { stepsPerBeat: 4, channel: 16, drumMap: preset });
  check('drum-map preset: imports the pack SMF (key 1 → kick)',
    hits(viaPreset.voices.kick ?? []).length === 1, JSON.stringify(Object.keys(viaPreset.voices)));
}

// ── Round-robin: spread a voice's hits across tracks (anti-choke) ──────────
{
  const mk = (grid: string): NeutralPattern => ({
    name: 't', steps: grid.length, bars: 1,
    voices: { hat: { steps: charGridToSteps(grid) } },
  });
  const hits = (steps: { on: boolean }[] | undefined) => (steps ?? []).flatMap((s, i) => (s.on ? [i] : []));

  // 4 hats on steps 0,2,4,6 → alternate drum3 (0,4) / drum4 (2,6); hat consumed.
  const r = applyRoundRobin(mk('x.x.x.x.'), { hat: ['drum3', 'drum4'] });
  check('round-robin: source voice consumed', r.pattern.voices.hat === undefined);
  check('round-robin: hits dealt drum3=[0,4], drum4=[2,6]',
    JSON.stringify(hits(r.pattern.voices.drum3?.steps as { on: boolean }[])) === '[0,4]'
    && JSON.stringify(hits(r.pattern.voices.drum4?.steps as { on: boolean }[])) === '[2,6]',
    JSON.stringify({ d3: hits(r.pattern.voices.drum3?.steps as { on: boolean }[]), d4: hits(r.pattern.voices.drum4?.steps as { on: boolean }[]) }));
  check('round-robin: emits a load-same-sample warning', r.warnings.length === 1 && /same sample/i.test(r.warnings[0]));

  // 3-way rotation: hits 0,1,2,3,4,5 → a(0,3) b(1,4) c(2,5).
  const r3 = applyRoundRobin(
    { name: 't', steps: 6, bars: 1, voices: { hat: { steps: charGridToSteps('xxxxxx') } } },
    { hat: ['a', 'b', 'c'] },
  );
  check('round-robin: 3-way rotation a=[0,3] b=[1,4] c=[2,5]',
    JSON.stringify(hits(r3.pattern.voices.a?.steps as { on: boolean }[])) === '[0,3]'
    && JSON.stringify(hits(r3.pattern.voices.b?.steps as { on: boolean }[])) === '[1,4]'
    && JSON.stringify(hits(r3.pattern.voices.c?.steps as { on: boolean }[])) === '[2,5]');

  // no-op when spec is empty/undefined.
  check('round-robin: undefined spec is a no-op', applyRoundRobin(mk('x.x.'), undefined).pattern.voices.hat !== undefined);

  // Errors: <2 targets, source-in-targets, unknown source.
  check('round-robin: <2 targets throws', (() => { try { applyRoundRobin(mk('x.x.'), { hat: ['drum3'] }); return false; } catch (e) { return e instanceof PatternError; } })());
  check('round-robin: source listed as target throws', (() => { try { applyRoundRobin(mk('x.x.'), { hat: ['hat', 'drum4'] }); return false; } catch (e) { return e instanceof PatternError; } })());
  check('round-robin: unknown source voice throws', (() => { try { applyRoundRobin(mk('x.x.'), { ride: ['drum3', 'drum4'] }); return false; } catch (e) { return e instanceof PatternError; } })());
}

// ---------------------------------------------------------------------------
// Drum CONDENSATION: squeeze a full kit onto the sequencer's four drum tracks.
// ---------------------------------------------------------------------------
{
  const steps = (s: string) => ({ steps: charGridToSteps(s) });
  const hitsOf = (v?: { steps: readonly { on: boolean }[] }) =>
    (v?.steps ?? []).map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);

  // The routing case that motivated adding `ride` to the Circuit voice_map:
  // a crash must land on the RIDE track (Drum 4's real sample), not the hat.
  const c = condenseToKit({
    name: 'c', steps: 8, bars: 1,
    voices: { kick: steps('x...x...'), crash: steps('x.......'), tom: steps('....x...') },
  });
  check('condense: emits exactly one voice per kit track',
    Object.keys(c.pattern.voices).length === 4
    && ['kick', 'snare', 'closed_hat', 'ride'].every((k) => c.pattern.voices[k] !== undefined));
  check('condense: crash routes to the RIDE track, not the hat',
    JSON.stringify(hitsOf(c.pattern.voices.ride)) === '[0]'
    && hitsOf(c.pattern.voices.closed_hat).length === 0);
  check('condense: tom folds onto the snare track', JSON.stringify(hitsOf(c.pattern.voices.snare)) === '[4]');
  check('condense: kick passes through untouched', JSON.stringify(hitsOf(c.pattern.voices.kick)) === '[0,4]');

  // Identity: a folded voice carries a per-step flip back to its own sample; a
  // voice that IS the track's role carries none (nothing to restore).
  check('condense: folded voices get a per-step sample flip',
    c.flips.get(3)?.get(0) === 'crash' && c.flips.get(1)?.get(4) === 'tom');
  check('condense: exact-role voices get NO flip', c.flips.get(0) === undefined);
  check('condense: routing report marks exact vs folded',
    c.routings.find((r) => r.voice === 'kick')?.exact === true
    && c.routings.find((r) => r.voice === 'crash')?.exact === false);

  // Same-family contention: two voices, one step, one track. Louder wins at
  // equal fold distance, and the loser is REPORTED rather than silently eaten.
  const col = condenseToKit({
    name: 'col', steps: 4, bars: 1,
    voices: {
      tom: { steps: [{ on: true, velocity: 40 }, { on: false }, { on: false }, { on: false }] },
      clap: { steps: [{ on: true, velocity: 120 }, { on: false }, { on: false }, { on: false }] },
    },
  });
  check('condense: same-family collision keeps the louder hit',
    col.pattern.voices.snare?.steps[0]?.velocity === 120);
  check('condense: collision is reported with winner and loser',
    col.collisions.length === 1 && col.collisions[0]!.winner === 'clap' && col.collisions[0]!.loser === 'tom');
  check('condense: dropped count lands on the losing voice',
    col.routings.find((r) => r.voice === 'tom')?.dropped === 1);

  // Feel must survive: accent / micro placement / roll are the groove, and
  // re-deriving them instead of carrying them would quietly flatten it.
  const feel = condenseToKit({
    name: 'f', steps: 2, bars: 1,
    voices: { open_hat: { steps: [{ on: true, accent: true, micro: [0, 3], roll: 3 }, { on: false }] } },
  });
  const fs = feel.pattern.voices.closed_hat?.steps[0];
  check('condense: accent / micro / roll carried verbatim',
    fs?.accent === true && JSON.stringify(fs?.micro) === '[0,3]' && fs?.roll === 3);

  // Chained folds resolve (ride_bell -> ride), and melodic voices are left
  // alone rather than being mangled onto a drum track.
  const mixed = condenseToKit({
    name: 'm', steps: 4, bars: 1,
    voices: { ride_bell: steps('x...'), bass: steps('..x.') },
  });
  check('condense: chained fold ride_bell -> ride resolves',
    JSON.stringify(hitsOf(mixed.pattern.voices.ride)) === '[0]');
  check('condense: melodic voices are ignored, not condensed',
    mixed.ignored.includes('bass') && mixed.pattern.voices.bass === undefined);
}

// ---------------------------------------------------------------------------
// Drum condensation WIRING: the whole path, not just the pure condenser.
//
// The contract is deliberately split across two layers (the core condenser
// reports flips as device-blind ROLES, and the device layer resolves a role to
// its own pool slot), so checking either half alone proves nothing about the
// join. These checks run a Sugar-shaped call end to end: a full kit routed to
// an SPD-SX on the Circuit's MIDI 2, condensed onto the Circuit's own four drum
// tracks, and authored into a real .ncs buffer. The Circuit authoring functions
// are pure buffer mutation (no MIDI I/O), so this stays a hardware-free golden.
// ---------------------------------------------------------------------------
{
  const steps = (s: string) => ({ steps: charGridToSteps(s) });
  const caps = CIRCUIT_TRACKS_DESCRIPTOR.capabilities;
  const midi2 = caps.external_tracks!.midi2;

  // The kit as authored: five pieces, two of which have no track of their own
  // on a 4-voice kit (crash folds to the ride track, tom to the snare track).
  const kit: NeutralPattern = {
    name: 'kit', steps: 8, bars: 1,
    voices: {
      kick: steps('x...x...'),
      snare: steps('....x...'),
      hat: steps('x.x.x.x.'),
      crash: steps('x.......'),
      tom: steps('......x.'),
    },
  };
  // What external_targets [{device:'spd-sx', track:'midi2', note_offset:12}]
  // resolves to: the SPD-SX pad notes (raw GM) plus the Circuit's octave-low
  // compensation, on the MIDI 2 track's channel.
  const external: Record<string, VoiceTarget[]> = {
    kick: [{ channel: midi2, note: 48 }],
    snare: [{ channel: midi2, note: 50 }],
    hat: [{ channel: midi2, note: 54 }],
    crash: [{ channel: midi2, note: 61 }],
    tom: [{ channel: midi2, note: 57 }],
  };

  const cd = buildCondensedDrums(kit, caps, external)!;
  check('condense wiring: one synthetic voice per internal drum track',
    cd !== undefined && Object.keys(cd.voices).length === 4
    && [1, 2, 3, 4].every((n) => cd.voices[`condense:drum${n}`] !== undefined),
    JSON.stringify(Object.keys(cd.voices)));
  check('condense wiring: synthetic tracks pin to the Circuit drum pads 60/62/64/65',
    JSON.stringify([1, 2, 3, 4].map((n) => cd.overrides[`condense:drum${n}`]?.[0]?.note)) === '[60,62,64,65]',
    JSON.stringify([1, 2, 3, 4].map((n) => cd.overrides[`condense:drum${n}`]?.[0])));
  check('condense wiring: source drum voices keep ONLY their external destination',
    JSON.stringify(cd.overrides.crash) === JSON.stringify(external.crash)
    && JSON.stringify(cd.overrides.hat) === JSON.stringify(external.hat));
  check('condense wiring: flips are reported as ROLES on 1-based steps',
    cd.flip_roles.drum4?.['1'] === 'crash' && cd.flip_roles.drum2?.['7'] === 'tom',
    JSON.stringify(cd.flip_roles));
  check('condense wiring: every drum level is 0 (stored silent)',
    cd.levels.length === 4 && cd.levels.every((l) => l === 0), JSON.stringify(cd.levels));
  check('condense wiring: a drumless pattern condenses nothing rather than erroring',
    buildCondensedDrums({ name: 'm', steps: 4, bars: 1, voices: { bass: steps('x...') } }, caps) === undefined);
  check('condense wiring: a device with no internal drum tracks refuses',
    threwPattern(() => buildCondensedDrums(kit, { ...caps, drum_track_roles: undefined })));

  // Compile the augmented pattern exactly as the dispatcher does, then author it.
  const plan = compileToPlan(
    { ...kit, voices: { ...kit.voices, ...cd.voices } },
    caps,
    {
      bpm: 120, mode: 'ncs_upload', repeat: 1,
      overrides: { ...external, ...cd.overrides },
      upload: { slot: 0, drum_flip_roles: cd.flip_roles, drum_levels: cd.levels },
    },
  );
  const onCh = (ch: number) => plan.events.filter((e) => e.channel === ch);
  // 9 condensed hits (kick 2 + snare 1 + tom 1 + hat 4 + crash 1). Double that
  // would mean the source voices ALSO authored an un-condensed internal copy.
  check('condense wiring: the internal drum route carries the condensed copy ONLY',
    onCh(10).length === 9 && onCh(10).every((e) => [60, 62, 64, 65].includes(e.note)),
    `${onCh(10).length} ch10 events`);
  check('condense wiring: the external MIDI-2 copy is untouched',
    onCh(midi2).length === 9 && onCh(midi2).some((e) => e.note === 61),
    `${onCh(midi2).length} ch${midi2} events`);

  const buf = new Uint8Array(NCS_FILE_SIZE);
  const authored = authorPlanIntoProject(buf, plan);
  const d = (track: number) => decodeDrumPattern(buf, track, 0);
  check('condense wiring: all four Circuit drum tracks are authored',
    JSON.stringify(authored.drum_tracks.sort((a, b) => a - b)) === '[0,1,2,3]',
    JSON.stringify(authored.drum_tracks));
  check('condense wiring: kick lands on Drum 1 at steps 1 and 5',
    d(0)[0].active && d(0)[4].active && d(0).filter((s) => s.active).length === 2);
  check('condense wiring: the crash lands on Drum 4 flipped to the CRASH sample slot',
    d(3)[0].active && d(3)[0].drumChoice === CIRCUIT_VOICE_SLOT.crash,
    `drumChoice=${d(3)[0].drumChoice}, expected ${CIRCUIT_VOICE_SLOT.crash}`);
  check('condense wiring: the tom lands on Drum 2 flipped to the TOM sample slot',
    d(1)[6].active && d(1)[6].drumChoice === CIRCUIT_VOICE_SLOT.tom,
    `drumChoice=${d(1)[6].drumChoice}, expected ${CIRCUIT_VOICE_SLOT.tom}`);
  check('condense wiring: a piece on its OWN track keeps the track default sample',
    d(1)[4].active && d(1)[4].drumChoice === DEFAULT_DRUM_CHOICE
    && d(2).filter((s) => s.active).every((s) => s.drumChoice === DEFAULT_DRUM_CHOICE));
  check('condense wiring: role flips reached the buffer (2 flips applied, none warned)',
    authored.flips_applied === 2 && authored.flip_warnings === undefined,
    `${authored.flips_applied} applied, warnings ${JSON.stringify(authored.flip_warnings)}`);
  check('condense wiring: all four stored drum levels are 0',
    [0, 1, 2, 3].every((t) => getDrumLevel(buf, t) === 0),
    JSON.stringify([0, 1, 2, 3].map((t) => getDrumLevel(buf, t))));
  check('condense wiring: the external kit still authored onto the MIDI 2 note track',
    authored.note_tracks.includes('midi2')
    && decodeNotePattern(buf, 'midi2', 0)[0].notes.some((s) => s.note === 61));

  // A caller's own explicit slot flip is the more specific instruction, so it
  // must win over the condenser's role-resolved one on the same step.
  const buf2 = new Uint8Array(NCS_FILE_SIZE);
  authorPlanIntoProject(buf2, {
    ...plan,
    upload: { slot: 0, drum_flip_roles: cd.flip_roles, drum_flips: { drum4: { 1: 11 } }, drum_levels: cd.levels },
  });
  check('condense wiring: an explicit drum_flips slot overrides the role-resolved flip',
    decodeDrumPattern(buf2, 3, 0)[0].drumChoice === 11,
    `drumChoice=${decodeDrumPattern(buf2, 3, 0)[0].drumChoice}`);

  // ARRANGEMENT leg: condensation is per SECTION, so each section's flips ride
  // on that section's OWN plan (authorArrangementIntoProject authors each plan
  // independently into its own pattern slot), while the drum LEVELS are
  // project-global and are written once. A section-scoped flip landing in the
  // wrong pattern slot is the failure this pins.
  const secPlan = (name: string, voices: NeutralPattern['voices']) => {
    const p: NeutralPattern = { name, steps: 8, bars: 1, voices };
    const w = buildCondensedDrums(p, caps)!;
    return compileToPlan({ ...p, voices: { ...p.voices, ...w.voices } }, caps, {
      bpm: 120, mode: 'ncs_upload', repeat: 1,
      overrides: w.overrides,
      upload: { slot: 0, drum_flip_roles: w.flip_roles },
    });
  };
  const arrBuf = new Uint8Array(NCS_FILE_SIZE);
  authorArrangementIntoProject(
    arrBuf,
    [
      { name: 'verse', plan: secPlan('verse', { kick: steps('x...x...'), tom: steps('..x.....') }) },
      { name: 'chorus', plan: secPlan('chorus', { kick: steps('x...x...'), crash: steps('....x...') }) },
    ],
    [0, 1], undefined, undefined, [0, 0, 0, 0],
  );
  check('condense wiring (arrangement): the verse tom flip is in pattern 1 only',
    decodeDrumPattern(arrBuf, 1, 0)[2].drumChoice === CIRCUIT_VOICE_SLOT.tom
    && decodeDrumPattern(arrBuf, 1, 1).every((s) => s.drumChoice !== CIRCUIT_VOICE_SLOT.tom));
  check('condense wiring (arrangement): the chorus crash flip is in pattern 2 only',
    decodeDrumPattern(arrBuf, 3, 1)[4].drumChoice === CIRCUIT_VOICE_SLOT.crash
    && decodeDrumPattern(arrBuf, 3, 0).every((s) => s.drumChoice !== CIRCUIT_VOICE_SLOT.crash));
  check('condense wiring (arrangement): drum levels are written once, project-global',
    [0, 1, 2, 3].every((t) => getDrumLevel(arrBuf, t) === 0));
}

// ── .mid NOTE LENGTHS: note-off → gate_sixths (+ tie) ──────────────────────
//
// A `.mid` is the only import source that states an exact note length, so the
// note-off is the best duration evidence this project has. These fixtures are
// hand-built SMF bytes (no hardware, no network): division 480 at 4 steps per
// beat means one STEP is 120 ticks and one SIXTH of a step is 20 ticks, so
// every expected gate below is checkable by hand from the tick numbers.
{
  const DIV = 480;                       // ticks per beat
  const STEP = DIV / 4;                  // 120 ticks per 16th-note step
  const vlq = (n: number): number[] => {
    const out = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) out.unshift((v & 0x7f) | 0x80);
    return out;
  };
  interface RawEv { tick: number; bytes: number[] }
  const isOff = (e: RawEv): number => ((e.bytes[0] & 0xf0) === 0x80 ? 0 : 1);
  /** One-track SMF from absolute-tick events; note-offs sort ahead of note-ons at the same tick. */
  const smfOf = (evs: RawEv[]): Uint8Array => {
    const ord = [...evs].sort((a, b) => a.tick - b.tick || isOff(a) - isOff(b));
    const body: number[] = [];
    let last = 0;
    for (const e of ord) { body.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(0x00, 0xff, 0x2f, 0x00);
    const n = body.length;
    return Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (DIV >> 8) & 0xff, DIV & 0xff,
      0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff,
      ...body,
    ]);
  };
  // ch1 (wire 0). `held` = a note-on with its matching note-off; `hanging` = an
  // on the file never closes.
  const hanging = (tick: number, note: number, vel = 90): RawEv[] => [{ tick, bytes: [0x90, note, vel] }];
  const held = (tick: number, note: number, lenTicks: number, vel = 90): RawEv[] =>
    [{ tick, bytes: [0x90, note, vel] }, { tick: tick + lenTicks, bytes: [0x80, note, 0x40] }];
  const gates = (r: { steps: NeutralStep[] }): (number | undefined)[] =>
    r.steps.flatMap((s) => (s.on ? [s.gate_sixths] : []));

  // ── Fixture A: the length ladder ──────────────────────────────────
  // step 0  C3  60 ticks  = half a step      → 3 sixths
  // step 4  D3  120 ticks = exactly one step → 6 sixths
  // step 8  E3  480 ticks = four steps       → 24 sixths
  // step 12 F3  55 ticks  = 2.75 sixths      → 3, ROUNDED (off a whole sixth)
  // step 14 G3  3 ticks   = 0.15 of a sixth  → 1, CAPPED at the floor
  const ladder = smfOf([
    ...held(0, 48, 60), ...held(4 * STEP, 50, STEP), ...held(8 * STEP, 52, 4 * STEP),
    ...held(12 * STEP, 53, 55), ...held(14 * STEP, 55, 3),
  ]);
  const lad = importMidiMelodic(ladder, { channel: 1, beats: 4, stepsPerBeat: 4 });
  check('.mid lengths: half-step / one-step / four-step / off-sixth / sub-sixth → 3,6,24,3,1',
    JSON.stringify(gates(lad)) === '[3,6,24,3,1]', JSON.stringify(gates(lad)));
  check('.mid lengths: report counts 5 imported, 2 rounded, 1 capped at the floor',
    lad.duration_report.imported === 5 && lad.duration_report.rounded === 2
    && lad.duration_report.capped_short === 1 && lad.duration_report.capped_long === 0,
    JSON.stringify(lad.duration_report));
  check('.mid lengths: the rounding is WARNED, not silent',
    lad.warnings.some((w) => /did not land on a whole sixth/.test(w))
    && lad.warnings.some((w) => /shorter than one sixth/.test(w)),
    JSON.stringify(lad.warnings));
  check('.mid lengths: no tie inferred from a plain detached line', lad.duration_report.tied === 0);

  // Opt-out restores the pre-duration behaviour exactly: no gate, no tie, no
  // length warnings, which is what a caller with hand-set template gates wants.
  const plain = importMidiMelodic(ladder, { channel: 1, beats: 4, stepsPerBeat: 4, noteLengths: false });
  check('.mid lengths: noteLengths=false leaves every step on the default gate',
    gates(plain).every((g) => g === undefined) && plain.duration_report.imported === 0
    && !plain.warnings.some((w) => /note length|sixth/.test(w)),
    JSON.stringify({ gates: gates(plain), warnings: plain.warnings }));

  // ── Fixture B: tie, overlap, ceiling, unclosed ────────────────────
  // step 0  A3 720 ticks: still sounding 2 steps past the SAME pitch at step 4 → TIE, gate = the 4-step reach
  // step 4  A3 one step
  // step 8  B3 two steps, ending exactly on step 10's onset (abutting ≠ overlap)
  // step 10 C4 2.5 steps, running 0.5 of a step past step 12's D4 → OVERLAP (different pitch, so no tie)
  // step 12 D4 never closed → no length, counted
  // step 14 E4 20 steps → past the 16-step ceiling → capped at 96
  const mixed = smfOf([
    ...held(0, 57, 6 * STEP), ...held(4 * STEP, 57, STEP), ...held(8 * STEP, 59, 2 * STEP),
    ...held(10 * STEP, 60, 2.5 * STEP), ...hanging(12 * STEP, 62), ...held(14 * STEP, 64, 20 * STEP),
  ]);
  const mix = importMidiMelodic(mixed, { channel: 1, beats: 4, stepsPerBeat: 4 });
  check('.mid tie: a note held a full step past the next SAME-pitch onset ties, gate = the exact reach (24)',
    mix.steps[0].tie === true && mix.steps[0].gate_sixths === 24,
    JSON.stringify(mix.steps[0]));
  check('.mid tie: only that one step is tied', mix.steps.filter((s) => s.tie).length === 1);
  check('.mid lengths: an unclosed note-on takes no gate and is counted',
    mix.steps[12].on === true && mix.steps[12].gate_sixths === undefined && mix.duration_report.unclosed === 1,
    JSON.stringify({ step12: mix.steps[12], unclosed: mix.duration_report.unclosed }));
  check('.mid lengths: 20 steps is capped at the 16-step ceiling (96 sixths) and reported',
    mix.steps[14].gate_sixths === 96 && mix.duration_report.capped_long === 1
    && mix.warnings.some((w) => /capped/.test(w)),
    JSON.stringify({ gate: mix.steps[14].gate_sixths, r: mix.duration_report.capped_long }));
  check('.mid overlap: a note running past the next onset keeps its full length and is reported once',
    mix.steps[10].gate_sixths === 15 && mix.steps[10].tie === undefined
    && mix.duration_report.overlapping === 1
    && mix.warnings.some((w) => /still sounding when this voice's next note starts/.test(w)),
    JSON.stringify({ step10: mix.steps[10], overlapping: mix.duration_report.overlapping }));
  check('.mid overlap: abutting (step 8 ends exactly on step 10) is NOT an overlap',
    mix.steps[8].gate_sixths === 12 && mix.steps[8].tie === undefined);

  // ── Fixture C: the tie tolerance, from both sides ─────────────────
  // Same pitch, note ending EXACTLY on the next onset: the source re-strikes it,
  // so this is a 4-step note, not a tie. Inferring one here would melt every
  // repeated-root bassline into a drone.
  const abut = importMidiMelodic(
    smfOf([...held(0, 57, 4 * STEP), ...held(4 * STEP, 57, STEP)]),
    { channel: 1, beats: 4, stepsPerBeat: 4 },
  );
  check('.mid tie: a same-pitch note ending exactly ON the next onset is a long note, not a tie',
    abut.steps[0].tie === undefined && abut.steps[0].gate_sixths === 24 && abut.duration_report.tied === 0,
    JSON.stringify(abut.steps[0]));
  // Half a step of overlap is legato slop, under the one-step bar: still no tie,
  // but the overlap itself IS reported.
  const slop = importMidiMelodic(
    smfOf([...held(0, 57, 4.5 * STEP), ...held(4 * STEP, 57, STEP)]),
    { channel: 1, beats: 4, stepsPerBeat: 4 },
  );
  check('.mid tie: half a step of same-pitch overlap is legato, not a tie (reported as an overlap)',
    slop.steps[0].tie === undefined && slop.steps[0].gate_sixths === 27
    && slop.duration_report.tied === 0 && slop.duration_report.overlapping === 1,
    JSON.stringify({ step0: slop.steps[0], report: slop.duration_report }));
  // Held through the next onset, but that onset is a DIFFERENT pitch: nothing to
  // hold, so no tie (the device drops a tie whose target lacks the note anyway).
  const otherPitch = importMidiMelodic(
    smfOf([...held(0, 57, 6 * STEP), ...held(4 * STEP, 59, STEP)]),
    { channel: 1, beats: 4, stepsPerBeat: 4 },
  );
  check('.mid tie: sustaining into a DIFFERENT pitch is an overlap, never a tie',
    otherPitch.steps[0].tie === undefined && otherPitch.steps[0].gate_sixths === 36
    && otherPitch.duration_report.tied === 0 && otherPitch.duration_report.overlapping === 1,
    JSON.stringify(otherPitch.steps[0]));

  // ── Fixture D: a chord whose notes have different lengths ─────────
  // One step states ONE length, so the step takes the LONGEST: stretching a
  // short note is a smaller lie than truncating a held one.
  const chordMixed = importMidiMelodic(
    smfOf([...held(0, 48, 8 * STEP, 70), ...held(0, 52, STEP, 100), ...held(0, 55, 8 * STEP, 80)]),
    { channel: 1, beats: 4, stepsPerBeat: 4 },
  );
  check('.mid lengths: an uneven chord takes its longest note (48 sixths), velocity still the loudest',
    JSON.stringify(chordMixed.steps[0].notes) === '[48,52,55]' && chordMixed.steps[0].gate_sixths === 48
    && chordMixed.steps[0].velocity === 100 && chordMixed.duration_report.uneven_chords === 1
    && chordMixed.warnings.some((w) => /different lengths/.test(w)),
    JSON.stringify(chordMixed.steps[0]));

  // A file with no note-offs at all (the shape the older melodic goldens use)
  // must still import: lengths absent, everything else untouched.
  const noOffs = importMidiMelodic(
    smfOf([...hanging(0, 48), ...hanging(4 * STEP, 50)]),
    { channel: 1, beats: 4, stepsPerBeat: 4 },
  );
  check('.mid lengths: a file with no note-offs imports unchanged (no gate, counted as unclosed)',
    gates(noOffs).every((g) => g === undefined) && noOffs.duration_report.unclosed === 2
    && noOffs.steps[0].notes === 48 && noOffs.steps[4].notes === 50,
    JSON.stringify(noOffs.duration_report));

  // The parser pairs offs per (channel, note) FIFO, so a duration survives on
  // the note-on itself for any other consumer.
  const pairing = parseMidiFile(smfOf([...held(0, 48, 240), ...held(240, 48, 120)]));
  check('parseMidiFile: note-offs pair FIFO onto the note-on as durationTicks',
    JSON.stringify(pairing.notes.map((n) => n.durationTicks)) === '[240,120]',
    JSON.stringify(pairing.notes));
  // A note-on with velocity 0 IS a note-off (the running-status idiom).
  const velZero = parseMidiFile(smfOf([
    { tick: 0, bytes: [0x90, 48, 90] }, { tick: 300, bytes: [0x90, 48, 0] },
  ]));
  check('parseMidiFile: note-on velocity 0 closes the note (300 ticks), and is not itself a note',
    velZero.notes.length === 1 && velZero.notes[0].durationTicks === 300,
    JSON.stringify(velZero.notes));
}

// ── PROJECT PAD COLOUR: apply_pattern `colour` → the authored project ──────
//
// The colour BYTE is decoded, corpus-checked and golden-locked in
// verify-circuit-ncs. What is proven here is the PRODUCT PATH on top of it:
// `RealizePlan.upload.colour` reaching the Circuit realizer, the receipt saying
// which of the two outcomes happened, the refusal shape, and above all the
// backward-compatibility contract — a caller that passes no colour still
// produces a byte-identical project, because the whole feature is an opt-in
// stamp on a file that was already correct without it.
//
// It lives with the other Circuit wiring in this file (see the header note)
// rather than in verify-circuit-ncs, because that script imports the Circuit
// package by its subpath export, which resolves to the BUILT dist. These
// imports are source-relative, so the wiring is exercised as written.
await (async () => {
  // A structurally valid template that reads Blue, like every real project.
  const template = (() => {
    const b = new Uint8Array(NCS_FILE_SIZE);
    for (let i = 0; i < NCS_MAGIC.length; i++) b[i] = NCS_MAGIC.charCodeAt(i);
    new DataView(b.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, NCS_FILE_SIZE, true);
    setProjectColour(b, PROJECT_COLOUR_DEFAULT);
    return b;
  })();
  const mkPlan = (upload: NonNullable<RealizePlan['upload']>): RealizePlan => ({
    pattern_name: 'coloured', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      { channel: 10, note: 60, velocity: 110, time_ms: 0, duration_ms: 100 },
      { channel: 1, note: 48, velocity: 100, time_ms: 500, duration_ms: 100 },
    ],
    upload,
  });

  // BACKWARD COMPATIBILITY. The realizer runs applyProjectColour on the
  // template before authoring; with no colour asked for, the file it hands the
  // transport must be the same file it would have handed over before the line
  // existed. Reproduces the realizer's own order (colour stamp, then author).
  const before = template.slice();
  authorPlanIntoProject(before, mkPlan({ slot: 0 }));
  const after = template.slice();
  applyProjectColour(after, undefined);
  authorPlanIntoProject(after, mkPlan({ slot: 0 }));
  let moved = 0;
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (before[i] !== after[i]) moved++;
  check('colour wiring: an authored project with NO colour is byte-identical to one authored without the colour step',
    moved === 0, `${moved} byte(s) differ`);

  // The stamped project: the colour a caller asked for is readable in the file
  // that gets uploaded, and stamping it leaves a valid project.
  const stamped = template.slice();
  applyProjectColour(stamped, 'green');
  const authoredStamp = authorPlanIntoProject(stamped, mkPlan({ slot: 0 }));
  const structure = checkNcsStructure(stamped);
  check('colour wiring: an authored project stamped "green" reads back Green and stays structurally valid',
    getProjectColour(stamped) === 8 && projectColourName(getProjectColour(stamped)) === 'Green' && structure.ok,
    `${projectColourName(getProjectColour(stamped))} / ${structure.faults.join('; ')}`);
  check('colour wiring: the stamp does not disturb what was authored onto the tracks',
    authoredStamp.drum_tracks.length === 1 && authoredStamp.note_tracks.length === 1 && authoredStamp.unrouted === 0,
    JSON.stringify(authoredStamp.drum_tracks) + JSON.stringify(authoredStamp.note_tracks));

  // ── Through the realizer itself (dry run: authors, sends nothing) ────────
  const forbidden = () => { throw new Error('dry_run touched the device'); };
  const stubCtx = {
    conn: { hasInput: false, send: forbidden, request: forbidden },
    reconnect: () => { throw new Error('dry_run reconnected'); },
  } as unknown as Parameters<NonNullable<typeof circuitWriter.realizePattern>>[0];
  const tpl = join(tmpdir(), `verify-patterns-colour-${process.pid}.ncs`);
  writeFileSync(tpl, template);
  try {
    const inherited = await circuitWriter.realizePattern!(stubCtx, mkPlan({ template_path: tpl, slot: 0, dry_run: true }));
    check('colour wiring: omitting colour is NEVER silent, the receipt names the colour inherited from the template',
      /COLOUR: not set by this call/.test(inherited.info ?? '') && /Blue/.test(inherited.info ?? ''), inherited.info);

    const asked = await circuitWriter.realizePattern!(stubCtx, mkPlan({ template_path: tpl, slot: 0, dry_run: true, colour: 'Cyan' }));
    check('colour wiring: an asked-for colour is stamped by the realizer and the receipt names it and what it displaced',
      /Pad colour stored as Cyan \(template held Blue\)/.test(asked.info ?? ''), asked.info);

    const arr = await circuitWriter.realizeArrangement!(
      stubCtx,
      [
        { name: 'verse', plan: mkPlan({ template_path: tpl, slot: 0, dry_run: true }) },
        { name: 'chorus', plan: mkPlan({ template_path: tpl, slot: 0, dry_run: true }) },
      ],
      [0, 1],
      { template_path: tpl, slot: 0, dry_run: true, colour: 12 },
    );
    check('colour wiring: an arrangement takes one project-global colour, by index, and reports it',
      /Pad colour stored as Purple \(template held Blue\)/.test(arr.info ?? ''), arr.info);

    // REFUSAL. A colour nobody can render is refused with a structured error,
    // before the authoring, the overwrite gate and the transfer — never
    // substituted, because a pad lit the wrong colour says nothing is wrong.
    const refusal = async (colour: number | string): Promise<DispatchError | undefined> => {
      try {
        await circuitWriter.realizePattern!(stubCtx, mkPlan({ template_path: tpl, slot: 0, dry_run: true, colour }));
        return undefined;
      } catch (e) { return e instanceof DispatchError ? e : undefined; }
    };
    const badName = await refusal('Beige');
    check('colour wiring: an unknown colour NAME is refused as unknown_enum_value, and the error names the whole palette',
      badName?.code === 'unknown_enum_value' && /Red/.test(badName.message) && /Pink/.test(badName.message)
      && /Nothing was written/.test(badName.message),
      `${badName?.code}: ${badName?.message}`);
    const badIndex = await refusal(14);
    check('colour wiring: an off-palette INDEX is refused as value_out_of_range rather than clamped to 13',
      badIndex?.code === 'value_out_of_range' && /Nothing was written/.test(badIndex.message),
      `${badIndex?.code}: ${badIndex?.message}`);
  } finally {
    rmSync(tpl, { force: true });
  }

  // Plumbing: compileToPlan must carry a caller's colour through to the plan
  // untouched (the same identity passthrough drum_binding needed).
  const pattern: NeutralPattern = {
    name: 'plumbing', steps: 4, bars: 1,
    voices: { kick: { steps: charGridToSteps('x...') } },
  };
  const carried = compileToPlan(pattern, CIRCUIT_TRACKS_DESCRIPTOR.capabilities, {
    bpm: 120, mode: 'ncs_upload', upload: { slot: 0, colour: 'Red' },
  });
  const omitted = compileToPlan(pattern, CIRCUIT_TRACKS_DESCRIPTOR.capabilities, {
    bpm: 120, mode: 'ncs_upload', upload: { slot: 0 },
  });
  check('colour wiring: compileToPlan forwards upload.colour unchanged, and leaves it undefined when unset',
    carried.upload?.colour === 'Red' && omitted.upload?.colour === undefined,
    JSON.stringify({ carried: carried.upload?.colour, omitted: omitted.upload?.colour }));
})();

// ── Arrangement scene_plan: explicit scene grouping + stale-chain clear ─────
//
// GAP closed 2026-07-29: the arrangement scene mode could only GREEDILY merge
// consecutive sections into the fewest scenes, so a chosen 1+3+2+2 grouping
// (The Offering's Chorus) needed a bespoke script. `scene_plan` states the
// grouping; omitted keeps the automatic layout BYTE-IDENTICAL (goldens below
// were captured from the pre-change code). Scene mode now also clears the
// authored tracks' stale plain-chain slots (the bug the bespoke script found:
// the device partly follows the stale flat range and scenes sound duplicated).
{
  const caps = CIRCUIT_TRACKS_DESCRIPTOR.capabilities;
  const sec = (name: string, kick: string, bass?: string): { name: string; plan: RealizePlan } => {
    const voices: Record<string, { steps: NeutralStep[] }> = { kick: { steps: charGridToSteps(kick) } };
    if (bass) voices.bass = { steps: charGridToSteps(bass).map((s, i) => (s.on ? { ...s, note: 48 + (i % 5) } : s)) };
    const p: NeutralPattern = { name, steps: kick.length, bars: 1, voices };
    return { name, plan: compileToPlan(p, caps, { bpm: 120, mode: 'ncs_upload', repeat: 1, upload: { slot: 0 } }) };
  };
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const threwMatching = (fn: () => unknown, re: RegExp): boolean => {
    try { fn(); return false; } catch (e) { return e instanceof DispatchError && re.test(e.message); }
  };

  // BYTE IDENTITY, no plan. Both goldens were captured from the pre-change
  // authorArrangementIntoProject on this exact input (2026-07-29), so a hash
  // match IS the backward-compatibility proof, not a re-derivation.
  {
    const buf = new Uint8Array(NCS_FILE_SIZE);
    authorArrangementIntoProject(buf, [
      sec('verse', 'x...x...', 'x.x.x.x.'), sec('chorus', 'xx..xx..', '.x...x..'), sec('bridge', 'x.x.x.x.'),
    ], [0, 1, 2, 1]);
    check('scene_plan compat: no-plan CHAIN arrangement is byte-identical to the pre-change code (golden hash)',
      sha(buf) === 'ef566459390eb3c5131d58fe159277da847ca41c5a61d9ff6f9a672165e99081', sha(buf));
  }
  const greedySections = (): { name: string; plan: RealizePlan }[] =>
    ['s1', 's2', 's3', 's4', 's5'].map((n, i) => sec(n, ('x...'.repeat(2)).slice(0, 8 - i) + '.'.repeat(i), i % 2 ? 'x...x...' : undefined));
  {
    const buf = new Uint8Array(NCS_FILE_SIZE);
    const res = authorArrangementIntoProject(buf, greedySections(), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    check('scene_plan compat: no-plan GREEDY-SCENES arrangement (clean template) is byte-identical to the pre-change code',
      sha(buf) === '9a6e06ef568b2baf8433d0dc7e05afd097891c01873aa0dd09cde99a184a608c', sha(buf));
    check('scene_plan compat: the greedy grouping itself is unchanged (2 runs over 5 slots)',
      res.layout.kind === 'scenes' && JSON.stringify(res.layout.scenes) === '[{"start":0,"end":4},{"start":0,"end":4}]',
      JSON.stringify(res.layout));
  }

  // THE ONE DELIBERATE BYTE-LEVEL CHANGE, pinned exactly: a template carrying a
  // STALE plain chain now has the authored (union) tracks' chain slots cleared
  // in scene mode. Diffed against a clean-template authoring, the only surviving
  // difference must be the NON-union track's chain byte, which is deliberately
  // kept (tracks outside the union keep their template content).
  {
    const staleSections = (): { name: string; plan: RealizePlan }[] =>
      ['s1', 's2', 's3', 's4', 's5'].map((n, i) => sec(n, ('x...'.repeat(2)).slice(0, 8 - i) + '.'.repeat(i), 'x...x...'));
    const stale = new Uint8Array(NCS_FILE_SIZE);
    stale[0x2c4] = 0; stale[0x2c5] = 7;   // synth1 (union: bass routes there) chained [0,7]
    stale[0x2d0] = 0; stale[0x2d1] = 7;   // midi2 (NOT in the union) chained [0,7]
    for (let t = 0; t < 4; t++) { stale[0x2d4 + t * 4] = 0; stale[0x2d4 + t * 4 + 1] = 7; } // drums chained
    authorArrangementIntoProject(stale, staleSections(), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    const clean = new Uint8Array(NCS_FILE_SIZE);
    authorArrangementIntoProject(clean, staleSections(), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    const diffs: number[] = [];
    for (let i = 0; i < NCS_FILE_SIZE; i++) if (stale[i] !== clean[i]) diffs.push(i);
    check('scene mode clears the stale plain chain on authored tracks: synth1 + all drums back to the fresh [0,0]',
      getNoteChain(stale, 'synth1') === undefined && stale[0x2c5] === 0
      && [0, 1, 2, 3].every((t) => stale[0x2d4 + t * 4] === 0 && stale[0x2d4 + t * 4 + 1] === 0),
      JSON.stringify({ synth1: [stale[0x2c4], stale[0x2c5]], drum1: [stale[0x2d4], stale[0x2d5]] }));
    check('scene mode keeps a NON-union track\'s template chain: midi2 still [0,7], the only byte differing from a clean-template authoring',
      stale[0x2d1] === 7 && JSON.stringify(diffs) === JSON.stringify([0x2d1]), JSON.stringify(diffs.map((d) => `0x${d.toString(16)}`)));
    check('scene mode clear does not invent the drum-chain tail byte (0x26fc7 stays 0)', stale[0x26fc7] === 0, String(stale[0x26fc7]));
  }

  // THE OFFERING'S 1+3+2+2, through the tool path. 8 sections, the plan groups
  // them exactly as the song doc records; assert against the sceneChain READER
  // (the same decode the bespoke fix was byte-verified with).
  {
    const sections = ['fill', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => sec(n, 'x...x...', i % 2 ? 'x.......' : '..x.....'));
    const buf = new Uint8Array(NCS_FILE_SIZE);
    buf[0x2c4] = 0; buf[0x2c5] = 7; // stale synth1 plain chain, as an exported plain-chain project would carry
    const res = authorArrangementIntoProject(
      buf, sections, [0, 1, 2, 3, 4, 5, 6, 7], undefined, undefined, undefined, true,
      [[0], [1, 2, 3], [4, 5], [6, 7]],
    );
    const expect = [[0, 0], [1, 3], [4, 5], [6, 7]];
    check('scene_plan 1+3+2+2: layout is scenes with exactly the asked ranges',
      res.layout.kind === 'scenes' && JSON.stringify(res.layout.scenes) === JSON.stringify(expect.map(([s, e]) => ({ start: s, end: e }))),
      JSON.stringify(res.layout.scenes));
    check('scene_plan 1+3+2+2: the scene-chain END byte reads back 4', getSceneChainEnd(buf) === 4, String(getSceneChainEnd(buf)));
    const noteRanges = expect.map((_, sc) => getSceneNoteChain(buf, sc, 'synth1'));
    const drumRanges = expect.map((_, sc) => getSceneDrumChain(buf, sc, 0));
    check('scene_plan 1+3+2+2: per-scene NOTE ranges land in the scene tables exactly',
      JSON.stringify(noteRanges) === JSON.stringify(expect.map(([s, e]) => ({ start: s, end: e }))), JSON.stringify(noteRanges));
    check('scene_plan 1+3+2+2: per-scene DRUM ranges land in the scene tables exactly',
      JSON.stringify(drumRanges) === JSON.stringify(expect.map(([s, e]) => ({ start: s, end: e }))), JSON.stringify(drumRanges));
    check('scene_plan 1+3+2+2: the stale plain-chain byte is CLEARED (the 2026-07-23 bug cannot recur through the tool path)',
      getNoteChain(buf, 'synth1') === undefined && buf[0x2c5] === 0, `synth1=[${buf[0x2c4]},${buf[0x2c5]}]`);
  }

  // A scene may reference the SAME pattern range more than once (The Offering's
  // Buildup: three scenes point at one ostinato pattern). Also proves the plan
  // FORCES scene layout where 4 plays would otherwise ride the plain chain.
  {
    const sections = [sec('ostinato', 'x.x.x.x.'), sec('m140fill', 'xxxxxxxx')];
    const buf = new Uint8Array(NCS_FILE_SIZE);
    const res = authorArrangementIntoProject(
      buf, sections, [0, 0, 0, 1], undefined, undefined, undefined, true,
      [[0], [0], [0], [1]],
    );
    check('scene_plan repetition: three scenes reference pattern 1, the fill fires once in scene 4',
      res.layout.kind === 'scenes'
      && JSON.stringify(res.layout.scenes) === '[{"start":0,"end":0},{"start":0,"end":0},{"start":0,"end":0},{"start":1,"end":1}]'
      && getSceneChainEnd(buf) === 4,
      JSON.stringify(res.layout.scenes));
  }

  // REFUSALS (writer layer): the capability boundary is visible, never silent.
  {
    const five = ['s1', 's2', 's3', 's4', 's5'].map((n) => sec(n, 'x...x...'));
    check('scene_plan refusal: >4 scenes names the capture that unlocks it (HW-CIRCUIT-009)',
      threwMatching(
        () => authorArrangementIntoProject(new Uint8Array(NCS_FILE_SIZE), five, [0, 1, 2, 3, 4], undefined, undefined, undefined, true, [[0], [1], [2], [3], [4]]),
        /HW-CIRCUIT-009/,
      ));
    const three = ['s1', 's2', 's3'].map((n) => sec(n, 'x...x...'));
    check('scene_plan refusal: non-adjacent sections in one scene refuse (a scene is one contiguous range)',
      threwMatching(
        () => authorArrangementIntoProject(new Uint8Array(NCS_FILE_SIZE), three, [0, 2, 1], undefined, undefined, undefined, true, [[0, 2], [1]]),
        /not\s+adjacent in `sections`/,
      ));
    check('scene_plan refusal: a single-scene plan refuses (that is just the pattern chain)',
      threwMatching(
        () => authorArrangementIntoProject(new Uint8Array(NCS_FILE_SIZE), three, [0, 1, 2], undefined, undefined, undefined, true, [[0, 1, 2]]),
        /one scene/,
      ));
  }
}

// ── Arrangement scene_plan: dispatcher-level name resolution + refusals ─────
//
// The display-first boundary: the caller speaks section NAMES, and every
// name-level fault refuses with the fault named. Exercised through
// executeApplyPattern, the same function the MCP tool handler calls; all of
// these throw during resolution, before any port or template is touched.
await (async () => {
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
  const call = (arrangement: NonNullable<Parameters<typeof executeApplyPattern>[0]['arrangement']>): Promise<unknown> =>
    executeApplyPattern({
      port: 'circuit-tracks', mode: 'ncs_upload', ncs_slot: 1, ncs_template: 'unused-by-these-refusals.ncs',
      arrangement,
    });
  const refused = async (arrangement: NonNullable<Parameters<typeof executeApplyPattern>[0]['arrangement']>, re: RegExp): Promise<boolean> => {
    try { await call(arrangement); return false; } catch (e) { return e instanceof PatternError && re.test(e.message); }
  };
  const sections = [
    { name: 'Fill', voices: { kick: 'x...x...' } },
    { name: 'Verse', voices: { kick: 'x.x.x.x.' } },
    { name: 'Chorus', voices: { kick: 'xx..xx..' } },
  ];
  check('scene_plan dispatcher refusal: an unknown section name is named, with the roster',
    await refused({ sections, scene_plan: [['Fill'], ['Verse', 'Bridge'], ['Chorus']] }, /unknown section "Bridge".*Fill, Verse, Chorus/));
  check('scene_plan dispatcher refusal: the same section twice IN ONE SCENE refuses and points at cross-scene repetition',
    await refused({ sections, scene_plan: [['Fill'], ['Verse', 'Verse'], ['Chorus']] }, /lists "Verse" twice.*ANOTHER scene/));
  check('scene_plan dispatcher refusal: an unplaced section is named (it would author but never play)',
    await refused({ sections, scene_plan: [['Fill'], ['Verse']] }, /"Chorus" in no scene/));
  check('scene_plan dispatcher refusal: scene_plan and order together refuse (the plan IS the play order)',
    await refused({ sections, order: ['Fill', 'Verse'], scene_plan: [['Fill'], ['Verse'], ['Chorus']] }, /mutually exclusive/));
})();

// ── planProjects: content-driven, scene-chain-aware DEFAULT ────────────────
//
// The 2026-07-29 default change: the old `maxPlays: 8` default budgeted by PLAY
// COUNT (16 bars/project) and chopped songs into 2-8x more projects than their
// content needs. The default boundary is now distinct-content (8 slots) plus
// scene realizability (<=4 contiguous scene steps); explicit maxPlays keeps its
// old meaning exactly.
{
  const secs = (labels: string[], silent: string[] = []) =>
    labels.map((n) => ({ name: n, voices: silent.includes(n) ? { kick: '.'.repeat(32) } : { kick: 'x'.repeat(32) } }));
  const span8 = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

  // Explicit maxPlays is byte-for-byte the old behaviour.
  {
    const p = planProjects(secs(['A']), Array(9).fill('A'), { maxPlays: 8 });
    check('planProjects explicit maxPlays: A x9 still cuts 8 + 1 (the historical play budget)',
      p.projects.map((x) => x.order.length).join(',') === '8,1', JSON.stringify(p.projects.map((x) => x.summary)));
    const q = planProjects(secs(['A', 'B', 'C', 'D', 'E']), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4].map((i) => 'ABCDE'[i]), { maxPlays: 8 });
    check('planProjects explicit maxPlays: a 10-play order still splits at 8 plays',
      q.projects.length === 2 && q.projects[0].order.length === 8, JSON.stringify(q.projects.map((x) => x.summary)));
  }
  // The SAME 10-play order fits ONE project by default now: 5 distinct cells,
  // 2 scene steps. This is the Sugar-shape fix in miniature.
  {
    const p = planProjects(secs(['A', 'B', 'C', 'D', 'E']), [0, 1, 2, 3, 4, 0, 1, 2, 3, 4].map((i) => 'ABCDE'[i]));
    check('planProjects default: 2 passes over 5 cells = ONE project, advanced by scenes',
      p.projects.length === 1 && p.projects[0].advance === 'scenes' && p.projects[0].patterns.length === 5,
      JSON.stringify(p.projects.map((x) => `${x.summary} (${x.advance})`)));
    check('planProjects default: the note explains the scene-aware fit', /scene chain/.test(p.note), p.note);
  }
  // Content ceiling: 4 passes over 8 distinct cells = 32 plays in 4 scene steps
  // = one project (the full 64-bar span); the 5th pass starts project 2.
  {
    const four = [...span8, ...span8, ...span8, ...span8];
    const p = planProjects(secs(span8), four);
    check('planProjects default: 4 passes over 8 cells (32 plays) = ONE project', p.projects.length === 1 && p.projects[0].order.length === 32,
      JSON.stringify(p.projects.map((x) => x.order.length)));
    const p5 = planProjects(secs(span8), [...four, ...span8]);
    check('planProjects default: the 5th pass would need a 5th scene step, so it starts project 2',
      p5.projects.length === 2 && p5.projects[0].order.length === 32 && p5.projects[1].order.length === 8,
      JSON.stringify(p5.projects.map((x) => x.order.length)));
  }
  // Still content-bound: a 9th DISTINCT cell closes the project (8-slot ceiling),
  // and an unhelpable vamp (A x9: 9 scene steps) still cuts at the chain limit.
  {
    const nine = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    const p = planProjects(secs(nine), nine);
    check('planProjects default: a 9th distinct cell still closes the project at 8 slots',
      p.projects.length === 2 && p.projects[0].patterns.length === 8, JSON.stringify(p.projects.map((x) => x.summary)));
    const vamp = planProjects(secs(['A']), Array(9).fill('A'));
    check('planProjects default: A x9 still cuts 8 + 1 (every repeat is its own scene step, so scenes cannot help a vamp)',
      vamp.projects.map((x) => x.order.length).join(',') === '8,1', JSON.stringify(vamp.projects.map((x) => x.summary)));
  }
  // Alternation is the adversarial case for scenes (every play is a new run):
  // it must still chop on the chain budget, not overpromise.
  {
    const p = planProjects(secs(['A', 'B']), ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);
    check('planProjects default: ABAB x5 (10 runs) chops at the 8-play chain budget',
      p.projects.length === 2 && p.projects[0].order.length === 8 && p.projects.every((x) => x.advance === 'chain'),
      JSON.stringify(p.projects.map((x) => `${x.summary} (${x.advance})`)));
  }
  // maxScenes is honoured as an override on the new default.
  {
    const four = [...span8, ...span8, ...span8, ...span8];
    const p = planProjects(secs(span8), four, { maxScenes: 2 });
    check('planProjects maxScenes override: 2 scene steps halve the span (16 + 16)',
      p.projects.map((x) => x.order.length).join(',') === '16,16', JSON.stringify(p.projects.map((x) => x.order.length)));
  }
  // The phrase back-off survives the new predicate (same cut, same carry).
  {
    const order = ['A', 'A', 'B', 'B', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'D', 'D'];
    const p = planProjects(secs(['A', 'B', 'C', 'D']), order);
    const flat = p.projects.flatMap((x) => x.order);
    check('planProjects default: order is preserved across the new, larger chunks',
      flat.join(',') === order.join(','), flat.join(','));
    check('planProjects default: every emitted project is realizable (chain <=8 plays, or <=8 slots in <=4 scene steps)',
      p.projects.every((x) => {
        const runs = (() => { const slot = new Map<string, number>(); let r = 0, last = -2; for (const l of x.order) { let s = slot.get(l); if (s === undefined) { s = slot.size; slot.set(l, s); } if (s !== last + 1) r++; last = s; } return r; })();
        return x.order.length <= 8 || (x.patterns.length <= 8 && runs <= 4);
      }), JSON.stringify(p.projects.map((x) => x.summary)));
  }
}

// ── planProjects: the measured songs from the card backup (fixtures) ───────
//
// The condensation study (2026-07-29) measured every built song from the card
// backup and found the old chop 2-8x over the content floor. Reconstruct each
// song's as-built play order from the backup (each project's chain / scene
// ranges over its pattern slots, cells deduped globally per song by content
// hash) and let the NEW default replan it. Skipped when the gitignored backup
// is not on disk (CI); the numbers print for comparison against the study.
{
  const BACKUP = join('samples', 'circuit-ncs', 'card-backup-2026-07-27T16-49Z');
  if (!existsSync(BACKUP)) {
    console.log('  SKIP  planProjects fixtures: card backup not on disk (samples/ is local-only)');
  } else {
    const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
    const seq = (pack: string, from: number, to: number): string[] => {
      const files: string[] = [];
      for (let n = from; n <= to; n++) {
        files.push(join(pack, `proj${String(n).padStart(2, '0')}__${String(n - 1).padStart(2, '0')}_SESSION.ncs`));
      }
      return files;
    };
    const SONGS: { name: string; built: number; files: string[] }[] = [
      { name: 'After Dark', built: 8, files: seq('pack2', 1, 8) },
      { name: 'Amber', built: 5, files: seq('pack5', 8, 12) },
      { name: 'Clint Eastwood', built: 8, files: seq('pack5', 27, 34) },
      { name: 'Stranglehold', built: 6, files: seq('pack5', 1, 6) },
      {
        name: 'Like That', built: 5, files: [
          'pack1/proj04__03_LT_Intro.ncs', 'pack1/proj05__04_LT_Verse_1_A.ncs', 'pack1/proj06__05_LT_Verse_1_B.ncs',
          'pack1/proj07__06_LT_Chorus.ncs', 'pack1/proj08__07_LT_Chorus.ncs',
        ],
      },
      { name: 'Breakdown', built: 5, files: seq('pack5', 35, 39) },
      { name: 'Sugar', built: 10, files: seq('pack5', 46, 55) },
      { name: 'I Believe', built: 7, files: seq('pack5', 19, 25) },
      { name: 'The Offering', built: 7, files: seq('pack5', 57, 63) },
    ];
    const cellSig = (buf: Uint8Array, slot: number): { sig: string; silent: boolean } => {
      const content: unknown[] = [];
      let silent = true;
      for (const t of NOTE_TRACKS) {
        const steps = decodeNotePattern(buf, t, slot);
        const row = steps.map((s) => s.notes.map((n) => `${n.note}@${n.velocity}`).join('+'));
        if (row.some((r) => r !== '')) silent = false;
        content.push(row);
      }
      for (let d = 0; d < 4; d++) {
        const steps = decodeDrumPattern(buf, d, slot);
        const row = steps.map((s) => (s.active ? `${s.velocity}/${s.drumChoice}` : ''));
        if (row.some((r) => r !== '')) silent = false;
        content.push(row);
      }
      return { sig: createHash('sha256').update(JSON.stringify(content)).digest('hex'), silent };
    };
    // The content-bearing note track: scene / chain ranges are read from IT, so
    // a scene table written only for midi2 (The Offering) is not shadowed by a
    // sibling track's [0,0] slot in the same scene block.
    const busiestTrack = (buf: Uint8Array): NoteTrack => {
      let best: NoteTrack = 'midi2';
      let bestN = -1;
      for (const t of NOTE_TRACKS) {
        let n = 0;
        for (let p = 0; p < 8; p++) if (decodeNotePattern(buf, t, p).some((s) => s.notes.length > 0)) n++;
        if (n > bestN) { bestN = n; best = t; }
      }
      return best;
    };
    const playSlots = (buf: Uint8Array): number[] => {
      const track = busiestTrack(buf);
      const sceneEnd = getSceneChainEnd(buf);
      if (sceneEnd !== undefined) {
        const slots: number[] = [];
        for (let sc = 0; sc < sceneEnd; sc++) {
          const r = getSceneNoteChain(buf, sc, track);
          if (r) for (let s = r.start; s <= r.end; s++) slots.push(s);
        }
        if (slots.length > 0) return slots;
      }
      const end = Math.max(0, ...NOTE_TRACKS.map((t) => getNoteChain(buf, t)?.end ?? 0));
      return Array.from({ length: end + 1 }, (_, i) => i);
    };
    const rows: string[] = [];
    for (const song of SONGS) {
      const label = new Map<string, string>();
      const silentLabels = new Set<string>();
      const order: string[] = [];
      for (const f of song.files) {
        const buf = new Uint8Array(readFileSync(join(BACKUP, f)));
        for (const slot of playSlots(buf)) {
          const { sig, silent } = cellSig(buf, slot);
          let l = label.get(sig);
          if (l === undefined) { l = `P${label.size + 1}`; label.set(sig, l); if (silent) silentLabels.add(l); }
          order.push(l);
        }
      }
      const sections = [...label.values()].map((n) => ({ name: n, voices: { c: silentLabels.has(n) ? '.'.repeat(4) : 'x'.repeat(4) } }));
      const plan = planProjects(sections, order);
      const flat = plan.projects.flatMap((x) => x.order);
      // flat must be order with only SILENT plays deleted (a dropped silent-only
      // project); every content play survives in sequence.
      let fi = 0;
      let orderKept = true;
      for (const l of order) {
        if (fi < flat.length && flat[fi] === l) { fi++; continue; }
        if (!silentLabels.has(l)) { orderKept = false; break; }
      }
      orderKept = orderKept && fi === flat.length;
      check(`fixtures ${song.name}: replan preserves the as-built play order (minus dropped silent-only projects)`,
        orderKept, `${flat.length} of ${order.length} plays`);
      check(`fixtures ${song.name}: every replanned project is realizable as one apply_pattern arrangement`,
        plan.projects.every((x) => {
          const runs = (() => { const slot = new Map<string, number>(); let r = 0, last = -2; for (const l of x.order) { let s = slot.get(l); if (s === undefined) { s = slot.size; slot.set(l, s); } if (s !== last + 1) r++; last = s; } return r; })();
          return x.order.length <= 8 || (x.patterns.length <= 8 && runs <= 4);
        }), JSON.stringify(plan.projects.map((x) => x.summary)));
      check(`fixtures ${song.name}: the new default never needs MORE projects than the built chop (${plan.projects.length} vs ${song.built})`,
        plan.projects.length <= song.built, `${plan.projects.length} > ${song.built}`);
      rows.push(`${song.name}: built ${song.built} -> new default ${plan.projects.length} (cells ${label.size}, plays ${order.length}, advance ${plan.projects.map((x) => x.advance).join('/')})`);
    }
    console.log('  planProjects on the measured songs (new default vs as-built):');
    for (const r of rows) console.log(`    ${r}`);
  }
}

// ── GAP 1: condense_drums × drum_binding COMPOSE (bind first, condense on it) ──
//
// The pair used to refuse each other, but the real repertoire needs both
// (After Dark's working build: binding [1,2,5,11] AND condensed internal
// drums). The shipped rule: the binding declares where each track's OWN role
// sample lives in the pool; condensation lays the groove onto those bound
// tracks; and per-step sample flips resolve against the BOUND slots, never the
// canonical stoken layout, because a custom binding is the caller declaring
// that layout no longer describes their pool. A flip to a piece OUTSIDE the
// four bound roles is skipped with a warning (unlocatable), never guessed.
{
  const bound = [1, 2, 5, 11]; // After Dark: kick2 / snare / hatC / ride in the stoken_4 pool
  check('bind×condense: slotForFlipRole with NO binding is the canonical map for every role (byte-identity of the old path)',
    Object.keys(CIRCUIT_VOICE_SLOT).every((r) => slotForFlipRole(r) === circuitSlotForVoice(r)));
  check('bind×condense: a track role resolves to its BOUND slot (ride→11, kick→1, hat dialect→5)',
    slotForFlipRole('ride', bound) === 11 && slotForFlipRole('kick', bound) === 1 && slotForFlipRole('hat', bound) === 5,
    JSON.stringify([slotForFlipRole('ride', bound), slotForFlipRole('kick', bound), slotForFlipRole('hat', bound)]));
  check('bind×condense: an off-kit role is UNLOCATABLE under a custom binding (crash), never guessed from the canonical layout',
    slotForFlipRole('crash', bound) === undefined && slotForFlipRole('crash') === CIRCUIT_VOICE_SLOT.crash);

  const plan: RealizePlan = {
    pattern_name: 'bound', bpm: 120, steps: 8, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 4000,
    events: [
      { channel: 10, note: 64, velocity: 100, time_ms: 0, duration_ms: 100 },   // Drum 3 (hat track), step 1
      { channel: 10, note: 65, velocity: 100, time_ms: 0, duration_ms: 100 },   // Drum 4 (ride track), step 1
    ],
    upload: {
      slot: 0, drum_binding: [...bound], drum_levels: [0, 0, 0, 0],
      drum_flip_roles: { drum3: { 1: 'ride' }, drum4: { 1: 'crash' } },
    },
  };
  const buf = new Uint8Array(NCS_FILE_SIZE);
  const authored = authorPlanIntoProject(buf, plan);
  check('bind×condense: a flip to a bound track role plays the BOUND slot (drum3 step1 → 11, not canonical 3)',
    decodeDrumPattern(buf, 2, 0)[0].drumChoice === 11, `drumChoice=${decodeDrumPattern(buf, 2, 0)[0].drumChoice}`);
  check('bind×condense: the unlocatable flip is SKIPPED (hit keeps the bound sound) and the warning names drum_binding + the drum_flips remedy',
    decodeDrumPattern(buf, 3, 0)[0].drumChoice === DEFAULT_DRUM_CHOICE
    && (authored.flip_warnings ?? []).some((w) => /custom drum_binding does not say where "crash" lives/.test(w) && /drum_flips/.test(w)),
    JSON.stringify(authored.flip_warnings));
  check('bind×condense: the binding bytes land as asked',
    JSON.stringify(getDrumSampleBinding(buf)) === JSON.stringify(bound), JSON.stringify(getDrumSampleBinding(buf)));
  check('bind×condense: flips_applied counts only the landed flip', authored.flips_applied === 1, String(authored.flips_applied));
}

// ── GAPs 1-3 end-to-end: executeApplyPattern with the new authoring args ────
//
// The same function the MCP tool handler calls, dry-run (authors against the
// local template, opens no port). Proves: the composition no longer refuses
// and reaches the author with the binding; project_name and mixer_levels stamp
// with honest receipts and refuse bad input in display shape; omission is
// byte-identical; and a combined call using every new arg at once authors a
// structurally valid file.
await (async () => {
  registerDevice(CIRCUIT_TRACKS_DESCRIPTOR);
  registerDevice(SPD_SX_DESCRIPTOR);
  const template = (() => {
    const b = new Uint8Array(NCS_FILE_SIZE);
    for (let i = 0; i < NCS_MAGIC.length; i++) b[i] = NCS_MAGIC.charCodeAt(i);
    new DataView(b.buffer).setUint32(NCS_TOTAL_SESSION_SIZE_OFFSET, NCS_FILE_SIZE, true);
    setProjectColour(b, PROJECT_COLOUR_DEFAULT);
    setProjectName(b, 'Template 42');
    setSynthLevel(b, 1, 100); setSynthLevel(b, 2, 100);
    setDrumLevels(b, [100, 100, 100, 100]);
    return b;
  })();
  const tpl = join(tmpdir(), `verify-patterns-authoring-${process.pid}.ncs`);
  writeFileSync(tpl, template);
  const base = { port: 'circuit-tracks', mode: 'ncs_upload' as const, ncs_slot: 1, ncs_template: tpl, dry_run: true, bpm: 140 };
  const kitVoices = { kick: 'x...x...', hat: 'x.x.x.x.', crash: 'x.......' };
  type Args = Parameters<typeof executeApplyPattern>[0];
  const refused = async (args: Args, re: RegExp): Promise<boolean> => {
    try { await executeApplyPattern(args); return false; } catch (e) {
      return (e instanceof PatternError || e instanceof DispatchError) && re.test(e.message);
    }
  };
  try {
    // GAP 1: the pair composes end to end; the binding reaches the flip join.
    const composed = await executeApplyPattern({ ...base, voices: kitVoices, drum_binding: [1, 2, 5, 11], condense_drums: true });
    check('composition: condense_drums + drum_binding no longer refuse, and the condensation runs',
      composed.status === 'dry_run' && /Condensed the drum part/.test(composed.info ?? ''), composed.info);
    check('composition: the condenser\'s crash flip is reported unlocatable under the custom binding (resolved against BOUND slots, not canon)',
      /custom drum_binding does not say where "crash" lives/.test(composed.info ?? ''), composed.info);
    // The binding must ride each SECTION's flips in an arrangement too (the
    // per-section uploads are separate plans, so this pins the dispatcher wiring).
    const arrComposed = await executeApplyPattern({
      ...base,
      arrangement: { sections: [{ name: 'Verse', voices: kitVoices }, { name: 'Chorus', voices: { kick: 'x...x...' } }] },
      drum_binding: [1, 2, 5, 11], condense_drums: true,
    });
    check('composition (arrangement): the binding reaches each section\'s flip join (crash reported unlocatable, not canon-guessed)',
      arrComposed.status === 'dry_run' && /custom drum_binding does not say where "crash" lives/.test(arrComposed.info ?? ''),
      arrComposed.info);
    // The one genuinely contradictory case KEPT: also_internal vs the condensed copy.
    check('composition: condense_drums + external_targets.also_internal still refuses, naming both claimants',
      await refused(
        { ...base, voices: kitVoices, condense_drums: true, external_targets: [{ device: 'spd-sx', track: 'midi2', also_internal: true }] },
        /also_internal both claim the host's internal drum tracks/,
      ));

    // GAP 2: project_name. Inherited is never silent; stamped names both names;
    // over-long and non-ASCII refuse in display shape (no silent truncation).
    const inh = await executeApplyPattern({ ...base, voices: { kick: 'x...x...' } });
    check('project_name: omitting it is NEVER silent, the receipt names the template\'s name kept',
      /NAME: not set by this call, so the project keeps the template's "Template 42"/.test(inh.info ?? ''), inh.info);
    // Stored-silent synth default (maintainer's 2026-07-29 instruction): with
    // mixer_levels omitted, BOTH synths store 0 and the receipt states it.
    check('mixer_levels omitted: both synths store 0 by default and the receipt states the stored-silent default',
      /MIXER: Synth 1=0, Synth 2=0 \(stored-silent default; pass mixer_levels to override\)/.test(inh.info ?? '')
      && /left as the template held: Drum 1=100, Drum 2=100, Drum 3=100, Drum 4=100/.test(inh.info ?? ''), inh.info);
    const named = await executeApplyPattern({ ...base, voices: { kick: 'x...x...' }, project_name: 'AfterDark Verse' });
    check('project_name: a stamped name is reported with what it displaced',
      /Project name stored as "AfterDark Verse" \(template held "Template 42"\)/.test(named.info ?? ''), named.info);
    check('project_name: a 33-character name refuses naming the 32-char field (never truncated)',
      await refused({ ...base, voices: { kick: 'x...x...' }, project_name: 'A'.repeat(33) }, /33 characters.*at most 32/));
    check('project_name: a non-ASCII name refuses naming the charset',
      await refused({ ...base, voices: { kick: 'x...x...' }, project_name: 'Größe' }, /not printable ASCII/));

    // GAP 3: mixer_levels. Partial stamp with both sides reported; refusals in
    // display shape BEFORE any compile; empty object is not a silent no-op.
    const mixed = await executeApplyPattern({ ...base, voices: { kick: 'x...x...' }, mixer_levels: { synth1: 0, synth2: 0 } });
    check('mixer_levels: the receipt states the levels set (silent flagged) AND the tracks left at the template\'s values',
      /MIXER: stored Synth 1=0 \(silent\), Synth 2=0 \(silent\)/.test(mixed.info ?? '')
      && /left as the template held: Drum 1=100, Drum 2=100, Drum 3=100, Drum 4=100/.test(mixed.info ?? ''), mixed.info);
    check('mixer_levels: out of range refuses in display shape, naming the key and the 0..127 fader scale',
      await refused({ ...base, voices: { kick: 'x...x...' }, mixer_levels: { drum2: 400 } }, /mixer_levels\.drum2.*0\.\.127.*got 400/));
    check('mixer_levels: a non-integer refuses rather than rounding',
      await refused({ ...base, voices: { kick: 'x...x...' }, mixer_levels: { synth1: 63.5 } }, /mixer_levels\.synth1.*integer/));
    check('mixer_levels: an empty object refuses (it can only be a mistake, not a silent no-op)',
      await refused({ ...base, voices: { kick: 'x...x...' }, mixer_levels: {} }, /names no track/));

    // COMBINED: every new arg at once (name + colour + mixer + binding +
    // condense), one call, one receipt carrying every stamp.
    const combined = await executeApplyPattern({
      ...base, voices: kitVoices,
      project_name: 'AfterDark Verse', colour: 'Red', mixer_levels: { synth1: 0, synth2: 0 },
      drum_binding: [1, 2, 5, 11], condense_drums: true,
    });
    const ci = combined.info ?? '';
    check('combined: one call takes name + colour + mixer + binding + condense and the receipt carries every stamp',
      combined.status === 'dry_run'
      && /Project name stored as "AfterDark Verse"/.test(ci)
      && /Pad colour stored as Red/.test(ci)
      && /MIXER: stored Synth 1=0 \(silent\), Synth 2=0 \(silent\)/.test(ci)
      && /Drum-track levels stored at 0\/0\/0\/0/.test(ci)
      && /Condensed the drum part/.test(ci),
      ci);
    check('combined: the mixer receipt does not mislabel the condensed drum levels as the template\'s',
      !/left as the template held: Drum/.test(ci), ci);
  } finally {
    rmSync(tpl, { force: true });
  }

  // BYTE IDENTITY when all three new args are omitted, EXCEPT the two synth
  // level bytes: the maintainer's explicit 2026-07-29 instruction ("the synth
  // one and I also believe synth 2 are not level zero just like everything. I
  // want it to default that way") makes stored-silent synths the authoring
  // default, deliberately replacing template inheritance for EXACTLY
  // 0x2701c..0x2701d. Everything else keeps the byte-identity contract.
  const mkPlan = (): RealizePlan => ({
    pattern_name: 'identity', bpm: 120, steps: 16, bars: 1, repeat: 1, mode: 'ncs_upload', cycle_ms: 2000,
    events: [
      { channel: 10, note: 60, velocity: 110, time_ms: 0, duration_ms: 100 },
      { channel: 1, note: 48, velocity: 100, time_ms: 500, duration_ms: 100 },
    ],
    upload: { slot: 0 },
  });
  const before = template.slice();
  authorPlanIntoProject(before, mkPlan());
  const after = template.slice();
  applyProjectColour(after, undefined);
  applyProjectName(after, undefined);                     // name omitted = no-op stamp
  authorPlanIntoProject(after, mkPlan());
  setSynthLevel(after, 1, 0); setSynthLevel(after, 2, 0); // mixer omitted = the stored-silent synth default
  const movedAt: number[] = [];
  for (let i = 0; i < NCS_FILE_SIZE; i++) if (before[i] !== after[i]) movedAt.push(i);
  check('byte identity: with colour + name + mixer omitted, ONLY the two synth level bytes differ from the pre-change author (stored-silent default, maintainer 2026-07-29)',
    movedAt.length === 2 && movedAt[0] === MIXER_SYNTH1_LEVEL && movedAt[1] === MIXER_SYNTH2_LEVEL
    && getSynthLevel(after, 1) === 0 && getSynthLevel(after, 2) === 0,
    `bytes moved at ${movedAt.slice(0, 8).map((o) => `0x${o.toString(16)}`).join(',')}`);

  // THE COMBINED FILE ITSELF: reproduce the writer's order with every stamp on
  // a template copy (name, colour, author with binding + role flips + level 0,
  // then the explicit mixer) and prove the result is structurally valid with
  // every stamp readable at its own accessor.
  const steps = (s: string) => ({ steps: charGridToSteps(s) });
  const kit: NeutralPattern = { name: 'combined', steps: 8, bars: 1, voices: { kick: steps('x...x...'), hat: steps('x.x.x.x.'), crash: steps('x.......') } };
  const cd = buildCondensedDrums(kit, CIRCUIT_TRACKS_DESCRIPTOR.capabilities)!;
  const plan = compileToPlan(
    { ...kit, voices: { ...kit.voices, ...cd.voices } },
    CIRCUIT_TRACKS_DESCRIPTOR.capabilities,
    {
      bpm: 140, mode: 'ncs_upload', repeat: 1, overrides: cd.overrides,
      upload: { slot: 0, drum_binding: [1, 2, 5, 11], drum_flip_roles: cd.flip_roles, drum_levels: cd.levels },
    },
  );
  const file = template.slice();
  applyProjectName(file, 'AfterDark Verse');
  applyProjectColour(file, 'Red');
  authorPlanIntoProject(file, plan);
  setSynthLevel(file, 1, 0); setSynthLevel(file, 2, 0);   // what applyMixerLevels writes for {synth1:0, synth2:0}
  const structure = checkNcsStructure(file);
  check('combined file: structurally valid with every stamp readable (name, colour, binding, drum levels 0, synths 0)',
    structure.ok
    && getProjectName(file) === 'AfterDark Verse'
    && getProjectColour(file) === 0
    && JSON.stringify(getDrumSampleBinding(file)) === '[1,2,5,11]'
    && [0, 1, 2, 3].every((t) => getDrumLevel(file, t) === 0)
    && getSynthLevel(file, 1) === 0 && getSynthLevel(file, 2) === 0,
    structure.faults.join('; ') || `name=${getProjectName(file)} colour=${getProjectColour(file)} binding=${JSON.stringify(getDrumSampleBinding(file))}`);
})();

console.log('');
if (failed > 0) { console.error(`x ${failed} pattern check(s) FAILED.`); process.exit(1); }
console.log(`OK verify-patterns: ${Object.keys(PATTERN_RECIPES).length} recipe(s) + parser/euclid/compile/gate/round-robin/condense (core + Circuit wiring) verified.`);
