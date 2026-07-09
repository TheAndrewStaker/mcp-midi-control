/**
 * Golden: device-neutral pattern module (no hardware).
 *
 * Covers mini-notation parsing, char grids, the Euclidean generator, the
 * grid→plan compiler, voice_map resolution, the realizer capability gate,
 * and named-library integrity.
 *
 * Run via:  npx tsx scripts/verify-patterns.ts
 */

import type { DeviceCapabilities } from '../packages/core/src/protocol-generic/types.js';
import {
  PATTERN_RECIPES,
  PatternError,
  charGridToSteps,
  compileToPlan,
  euclid,
  euclidToString,
  parseDrumTab,
  applyRoundRobin,
  resolveDrumMapPreset,
  quantizeDrumEvents,
  gmDrumToVoice,
  GM_DRUM_TO_VOICE,
  canonicalRole,
  DRUM_ROLES,
  parseMidiFile,
  importMidiDrums,
  importMidiMelodic,
  midiChannelSummary,
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

console.log('');
if (failed > 0) { console.error(`x ${failed} pattern check(s) FAILED.`); process.exit(1); }
console.log(`OK verify-patterns: ${Object.keys(PATTERN_RECIPES).length} recipe(s) + parser/euclid/compile/gate/round-robin verified.`);
