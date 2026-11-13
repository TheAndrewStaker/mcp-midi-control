/**
 * `import_songsterr` executor: fetch a Songsterr tab and return its data ready
 * for `apply_pattern`. Read-only, device-free (no `port`): it GETs public
 * Songsterr endpoints and hands back structured display data.
 *
 * Conversational flow (deliberately NOT folded into apply_pattern):
 *   0. Optional, `list_tracks: true` → the song's FULL part roster and nothing
 *      else (one meta GET, no part download, no authoring).
 *   1. Call with a url/query → the tracks, sections, and tempo map.
 *   2. Call again naming a window (section / from_measure) → get the per-voice
 *      step grids + the LOCAL tempo, then pass `voices` + `bpm` to apply_pattern.
 *
 * Keeping the fetch separate keeps apply_pattern device-focused and makes the
 * import an inspectable step (the agent can see "two drum tracks: II vs
 * Programmed Drums; sections Intro/Verse/Bridge" before committing).
 *
 * Part SELECTION is instrument-agnostic, and so is grid CONVERSION now: a DRUM
 * part quantizes to GM-percussion `voices`, a MELODIC part to a mini-notation
 * PITCH ROW (`tuning[string] + fret`). Which reading a part gets is decided by
 * `fetched.isMelodic`, off the part's own top-level `tuning` array, never off
 * the instrument name.
 */

import {
  importSongsterrDrums,
  quantizedToGrids,
  fetchSongsterrPart,
  fetchSongsterrTracks,
  searchSongsterr,
  decomposeToPatterns,
  coalescePatterns,
  planArrangement,
  patternLabel,
  arrangementSummary,
  planProjects,
  type ProjectPlan,
  tempoAtBeat,
  flattenSongsterrDrums,
  unmappedSummary,
  type SongsterrFetched,
  type SearchHit,
  type TrackChoice,
} from '../patterns/index.js';
// Imported from the module rather than the barrel: the melodic entry points are
// new and `patterns/index.ts` is being edited elsewhere. Switch these to the
// barrel once its export block carries them.
import {
  importSongsterrMelodic,
  flattenSongsterrMelodic,
  isMelodicPart,
  detectPickupBar,
  type MelodicCell,
  type PickupBarInfo,
  type SongsterrFlat,
  type SongsterrPart,
} from '../patterns/songsterr.js';
import type { DecomposeLayer } from '../patterns/songStructure.js';
import {
  deriveDroppedFidelity,
  droppedFidelitySummary,
  type DroppedFidelity,
  type LegatoCause,
  type LengthArticulationReport,
} from '../patterns/songsterrArticulation.js';
import type { GlideGestureReport } from '../patterns/pitchGestures.js';
import {
  planSongChop,
  toChopPart,
  MAX_PROJECT_STEPS,
  type ChopPartFlat,
  type SongChopPlan,
} from '../patterns/songChop.js';
import { resolveClockMaster, type ClockMasterInfo } from '../clockMaster.js';

export interface ImportSongsterrArgs {
  /** Songsterr URL (…-s1234567t11) or bare id (1234567 / 1234567t11). */
  url?: string;
  /** Name search ("Artist Song Title"); resolves to a song when you don't have the URL. */
  query?: string;
  /**
   * Roster-only dry run: return every part the song has and stop. No part data
   * is downloaded, no track is selected, nothing is authored.
   */
  list_tracks?: boolean;
  /** Part index override, ANY instrument (a song may have several drum tracks too). */
  track?: number;
  /** Pick the part by name/instrument substring ("Programmed", "electronic", "bass"). */
  track_name?: string;
  /** Window by section name ("Bridge"). */
  section?: string;
  /** Window by DISPLAYED measure number (1-based, matching the tab UI). */
  from_measure?: number;
  to_measure?: number;
  /** Window by raw quarter-beat offset (advanced). */
  from_beat?: number;
  beats?: number;
  /** Grid resolution: 4 = 16ths (default), 8 = 32nds. */
  steps?: number;
  /**
   * Decompose the WHOLE song into a deduped section bank + play order, shaped
   * to paste straight into `apply_pattern`'s `arrangement` input. Mutually
   * exclusive with the window args.
   */
  whole_song?: boolean;
  /**
   * whole_song only: plan the chop across SEVERAL parts at once, on one shared
   * set of project boundaries. `'all'` takes every non-empty part on the tab;
   * an array takes those partIds. Costs one fetch per part.
   *
   * This is what makes the plan a SONG plan rather than a part plan: a song is
   * a bass and a pad and a lead and drums, and if each were windowed on its own
   * the projects would not line up. With `parts` the chop is computed once, from
   * the union of the parts' section markers and their combined per-bar
   * occupancy, and applied identically to every one of them.
   */
  parts?: number[] | 'all';
  /** whole_song only: fuzzy-merge threshold 0..1 (default 0.10). Higher folds near-identical grooves (fills) together, shrinking the bank toward the 8 slots; 0 = exact dedup. */
  fuzz?: number;
  /**
   * Per-source percussion remap for numbers this tab uses outside (or wrongly
   * inside) GM: source number → neutral voice name ("clap") or GM number (39).
   * The result's warnings NAME any unmapped numbers with hit counts; pass this
   * to import them instead of skipping. JSON keys arrive as strings.
   *
   * This is also the lever for Songsterr's engraving-only numbers 27-34 (the
   * GM2/GS effect block: High Q, Slap, Scratch Push/Pull, Sticks, Square Click,
   * Metronome Click/Bell). They are deliberately NOT in the voice table, so they
   * report as unmapped instead of inventing a percussion hit; a tab that really
   * plays one imports it with e.g. {"30": "snare"}.
   */
  drum_map?: Record<string, string | number>;
  /**
   * How loud a hit the tab marks GHOSTED sounds, 1..127. Default 40, against a
   * plain hit of 100 and an accent of 120. A ghost note is a real hit played
   * very quietly (the soft tail snare that makes a groove recognisable), so it
   * is never dropped and there is no value that silences it: raise this if the
   * ghosts are inaudible on the target's pads, lower it for a lighter touch.
   */
  ghost_velocity?: number;
  /** Read a swung tab straight: ignore the source's triplet-feel (swing) marking. Default false. */
  straight_feel?: boolean;
  /**
   * MELODIC parts only: the key the returned pitch row is filed under in
   * `voices`, i.e. which track of the target plays it. Default "synth1".
   * Use the target's own voice names (Circuit Tracks: synth1 / synth2 /
   * midi1 / midi2).
   */
  voice_name?: string;
  /**
   * MELODIC parts only: semitones to shift the whole part, applied after
   * `tuning[string] + fret`. Use -12 / +12 to bring a part into a target's
   * playable range without changing the tab.
   */
  transpose?: number;
  /**
   * MELODIC parts only: write each note's LENGTH and TIE into the `voices` row
   * (`"c3:16_"`). Default TRUE. Set false only for a bare pitch row, which
   * authors every note ONE STEP long whatever the source holds.
   */
  note_lengths?: boolean;
  /**
   * Carry the source's ARTICULATIONS (palm mute, per-note accent, let-ring,
   * hammer-on/pull-off, targeted slides) into real gate and velocity. Default
   * TRUE. False returns the written lengths and unarticulated velocity, and says
   * so; the markings are then listed in `dropped_fidelity.parsed_not_authored`.
   */
  articulations?: boolean;
  /** How long a palm-muted note rings, in quarter beats. Default 0.125. 0 leaves lengths alone. */
  palm_mute_gate_beats?: number;
  /** Palm-mute velocity multiplier. Default 0.85. 1 leaves velocity alone. */
  palm_mute_velocity_scale?: number;
  /** Cap on a let-ring extension, in quarter beats. Default 4 (one 4/4 bar). 0 disables let-ring. */
  let_ring_max_beats?: number;
  /** Sixths a legato launch note holds past its target's onset. Default 2. 0 disables legato. */
  legato_overlap_sixths?: number;
  /**
   * MELODIC parts only: render bends and slides into / out of unwritten pitches as overlapping glide
   * notes for a mono synth set to glide. See `pitchGestures.ts`. Off by default.
   */
  pitch_gestures?: 'glide';
  /** MELODIC parts only: keep one note of each chord (0 = lowest, -1 = highest), for a mono synth. */
  mono_voice?: number;
  /** `pitch_gestures` only: semitones a scoop starts below / a fall drops. Default 2. */
  slide_semitones?: number;
}

/** One row of the part roster, as returned to the agent. */
export interface TrackRow {
  /** Pass this back as `track` to import this part. */
  partId: number;
  /** Contributor-supplied name, often empty. */
  name: string;
  /** General MIDI instrument name ("Drums", "Electric Bass (finger)", "Church Organ"). */
  instrument: string;
  is_drums: boolean;
  is_empty?: boolean;
}

/**
 * `list_tracks: true` result: the song's part roster and nothing else.
 *
 * A distinct shape (not a half-filled `ImportSongsterrResult`) because in this
 * mode there IS no selected track, no section list and no tempo map: the part
 * JSON that carries them was deliberately not downloaded.
 */
export interface ImportSongsterrTrackList {
  mode: 'list_tracks';
  song: { songId: number; revisionId: number; title: string; artist: string };
  /** EVERY part, drum and melodic alike, in the song's own track order. */
  tracks: TrackRow[];
  /** The drum subset, with `popular` marking the song's canonical drum track. */
  drum_tracks: { partId: number; name: string; views?: number; popular: boolean }[];
  /** The `t`-selector carried by the input URL, if any. */
  url_track?: number;
  search_results?: SearchHit[];
  /**
   * Scope note: what a drum row and a melodic row each convert to. Present on
   * every roster so the caller knows before choosing.
   */
  notes: string[];
  next_step: string;
}

export interface ImportSongsterrResult {
  song: { songId: number; revisionId: number; title: string; artist: string };
  /** The part this call resolved to, drum or melodic. */
  track: { partId: number; name: string; instrument: string; is_drums: boolean };
  drum_tracks: { partId: number; name: string; views?: number; popular: boolean }[];
  /**
   * EVERY part in the song (discovery calls only, where the roster is what the
   * caller is deciding from). Omitted once a window / whole_song is requested:
   * the choice is already made and the payload is large.
   */
  all_tracks?: TrackRow[];
  ambiguous_track?: boolean;
  search_results?: SearchHit[];
  sections: { name: string; measure: number; beat: number }[];
  tempo_map: { measure: number; bpm: number }[];
  /**
   * The song's tempo, as an actionable "set the clock master to N BPM" instruction
   * (see TempoSetupInfo). Present whenever the tab carries a tempo. Reports the
   * tempo the clock-slaved sequencer needs rather than leaving it to be guessed;
   * the target device is resolved by role from the rig manifest, so it names
   * whichever device is the clock master (not hardwired to any one box).
   */
  tempo_setup?: TempoSetupInfo;
  /** Present when a window was requested: the grids to feed apply_pattern. */
  window?: { section?: string; from_measure?: number; from_beat: number; beats: number; bpm?: number; steps: number; signature: string };
  /**
   * Present when the song OPENS with a pickup (anacrusis) bar and this reply
   * covers the song's head. Carries the pad that squares the head to a whole
   * bar so clock-slaved gear (a looper's measure-quantized record-start, an
   * in-ear click counted from MIDI Start) stays on the song's barlines.
   * `padded_voices`, when present, is `voices` with `pad_steps` leading rest
   * steps — a paste-ready aligned head. NOT applied automatically: authoring
   * the padded head changes the Play press from "press = the pickup downbeat"
   * to "press = a short count before the pickup", which is the user's call.
   */
  pickup?: PickupBarInfo & { padded_voices?: Record<string, string> };
  /**
   * The step content to pass to apply_pattern. A DRUM part fills this with one
   * char grid per percussion voice; a MELODIC part fills it with ONE
   * mini-notation pitch row keyed by `voice_name`.
   */
  voices?: Record<string, string>;
  /**
   * Present when the windowed part was MELODIC: everything the pitch row in
   * `voices` cannot carry. `cells` is the per-step detail (velocity, note
   * length in steps, tie-forward, let-ring), keyed by `step`.
   */
  melodic?: {
    /** The key `voices` filed the pitch row under. */
    voice: string;
    /** The part's open-string tuning, the input to `pitch = tuning[string] + fret`. */
    tuning: number[];
    /** Lowest / highest note in the window, as names. */
    range?: { low: string; high: string };
    /** Per-step detail; see MelodicCell. */
    cells: MelodicCell[];
    /** Import-fidelity counts (all reported, never silent). */
    off_grid: number;
    merged: number;
    out_of_window: number;
    chord_overflow: number;
    unresolved: number;
    ties_folded: number;
    /** Notes past the 16-step gate ceiling written as a tied chain (full length kept). */
    gate_splits: number;
    /** Notes past the ceiling with no room to re-articulate (length genuinely lost). */
    gate_clamps: number;
    /** Tie (`_`) flags written into the row. */
    ties_emitted: number;
    /** False only when the caller passed note_lengths:false; the row is then pitch-only. */
    note_lengths: boolean;
    /**
     * What the source MARKS, track-wide, whether or not it was applied: the scale
     * of the articulation in this part.
     */
    articulations: {
      accents: number;
      palm_mutes: number;
      dead_notes: number;
      staccatos: number;
      let_rings: number;
      /** Source-marked legato connections by marking (the renderer's own `glide` is not a source marking). */
      legato: Record<Exclude<LegatoCause, 'glide'>, number>;
      /** Slide values with no written destination (or unknown to us), by value. */
      slides_unauthored: Record<string, number>;
    };
    /** What the length articulations DID in this window (extended, connected, damped). */
    articulation_applied: LengthArticulationReport;
    /** Chord notes `mono_voice` dropped, track-wide. Absent when none. */
    mono_dropped?: number;
    /** What `pitch_gestures` rendered, track-wide. Absent when the option is off. */
    pitch_gestures?: GlideGestureReport;
  };
  /** Present in whole_song mode: paste into apply_pattern's `arrangement` input. */
  arrangement?: {
    sections: { name: string; voices: Record<string, string>; steps: number; first_heard?: string }[];
    order: string[];
    /** Run-length display of the order ("A×15 B A×3 …"). */
    summary: string;
    bpm?: number;
    windows: number;
    scene_steps: number;
    fits: { one_pattern: boolean; chain_only: boolean; pattern_slots: boolean };
    /**
     * How to lay the song across MULTIPLE projects when it does not fit one
     * (the normal case: a real song is ~25 patterns / ~33 plays vs the device's
     * 8 and 8). Each entry is ready to drive one apply_pattern call; play them
     * in listed order. Present only when the song needs more than one project.
     */
    project_plan?: ProjectPlan;
  };
  /**
   * Present in whole_song mode for a MELODIC part, or whenever `parts` was
   * given: the SECTION-MARKER chop, one project layout shared by every selected
   * part.
   *
   * The complement of `arrangement`, not a replacement. `arrangement` INFERS a
   * drum track's structure by clustering its grooves; `song_plan` READS the
   * structure the tab already wrote as measure markers, which is the only thing
   * that works for a pitch row and is the only thing that can align several
   * parts on one set of boundaries. It is a plan and nothing else: no device is
   * touched, and the projects are meant to be shown to the user before any
   * authoring call is made.
   */
  song_plan?: SongChopPlan;
  /**
   * TRACK-WIDE: every source field this part carries that the authoring path did
   * NOT, split into `not_parsed` (never read: an honest gap) and
   * `parsed_not_authored` (read, and then thrown away: the dangerous one, and the
   * class of defect that made an imported groove sound wrong while every
   * capability box was ticked).
   *
   * Present on EVERY return shape, including the discovery call, because it is a
   * property of the part rather than of a window: seeing "792 palm-muted notes,
   * 3 bends, a mid-song patch-change map" before choosing a window is the whole
   * point. Derived by subtracting the fields the flattener acted on from the
   * fields the part actually contains, so a field the source starts emitting
   * appears here with nobody updating a list.
   */
  dropped_fidelity?: DroppedFidelity;
  warnings?: string[];
  next_step: string;
}

/**
 * A song's tempo resolved to an actionable instruction. The stored drum patterns
 * are tempo-independent step grids and the sequencer that plays them is slaved to
 * the rig's clock master, so the tempo has to be set on that device before the
 * song plays at the right speed. This reports it. SCOPED to single-tempo songs:
 * a tab with more than one distinct tempo gets a per-section notice, not a
 * per-region tempo plan.
 */
export interface TempoSetupInfo {
  /** Distinct tempos the tab carries, in first-appearance order. */
  bpms: number[];
  /** True when the tab carries >1 distinct tempo (no single automatic BPM). */
  multi_tempo: boolean;
  /** The clock-master device name(s), when a rig manifest (MCP_RIG_MANIFEST) names one. */
  clock_master?: string;
  /** The clock-follower device name(s) slaved to it, when the manifest names them. */
  followers?: string[];
  /** Plain-language instruction to set the tempo before playing. */
  instruction: string;
}

/** Distinct bpm values from a tempo map, in first-appearance order. */
export function distinctTempos(tempos: readonly { bpm: number }[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const t of tempos) if (!seen.has(t.bpm)) { seen.add(t.bpm); out.push(t.bpm); }
  return out;
}

/** "A" / "A and B" / "A, B, and C". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** BPM as a clean string (no float noise on the common integer case). */
function fmtBpm(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Build the "set the clock master to N BPM" instruction from a song's distinct
 * tempos + the rig's resolved clock master. Returns undefined when the tab
 * carries no tempo at all (nothing to instruct). Names the clock master when the
 * rig manifest declares one, else uses a generic "your clock master" phrase, so
 * the guidance works with or without a configured rig.
 */
export function buildTempoSetup(bpms: number[], cm: ClockMasterInfo): TempoSetupInfo | undefined {
  if (bpms.length === 0) return undefined;
  const masterName = cm.masters.length > 0 ? andList(cm.masters) : undefined;
  const masterPhrase = masterName ? `your clock master (${masterName})` : 'your clock master';
  const followPhrase = cm.followers.length > 0
    ? ` ${andList(cm.followers)} follow its clock, so the tempo has to live there.`
    : ' The clock-slaved sequencer follows its clock, so the tempo has to live there.';
  const common = {
    bpms,
    ...(masterName ? { clock_master: masterName } : {}),
    ...(cm.followers.length > 0 ? { followers: cm.followers } : {}),
  };
  if (bpms.length === 1) {
    return {
      ...common,
      multi_tempo: false,
      instruction: `Set ${masterPhrase} to ${fmtBpm(bpms[0])} BPM before you play this.${followPhrase}`,
    };
  }
  return {
    ...common,
    multi_tempo: true,
    instruction:
      `This song changes tempo (${bpms.map(fmtBpm).join(' → ')} BPM). This tool sets ONE tempo, so set ` +
      `${masterPhrase} to the tempo of the section you are laying down (${fmtBpm(bpms[0])} BPM for the opening) ` +
      `and change it by hand at each tempo boundary.${followPhrase}`,
  };
}

/** A short tempo pointer to append to `next_step` (the full text lives in tempo_setup). */
function tempoHint(ts: TempoSetupInfo | undefined): string {
  if (ts === undefined) return '';
  const where = ts.clock_master ?? 'your clock master';
  return ts.multi_tempo
    ? ` This song changes tempo: see tempo_setup and set ${where} per section (starts at ${fmtBpm(ts.bpms[0])} BPM).`
    : ` Set the tempo on ${where} to ${fmtBpm(ts.bpms[0])} BPM first (see tempo_setup).`;
}

const hasWindow = (a: ImportSongsterrArgs): boolean =>
  a.section !== undefined || a.from_measure !== undefined || a.to_measure !== undefined || a.from_beat !== undefined || a.beats !== undefined;

/** Codec-side `TrackChoice` to the snake_case row the tool returns. */
const toTrackRow = (t: TrackChoice): TrackRow => ({
  partId: t.partId,
  name: t.name,
  instrument: t.instrument,
  is_drums: t.isDrums,
  ...(t.isEmpty === true ? { is_empty: true } : {}),
});

/**
 * Where a melodic pitch row lands in `voices` when the caller names no
 * `voice_name`. "synth1" is the first melodic track on the Circuit Tracks
 * voice_map and reads as a melodic voice on any target; it is a default, not a
 * device assumption, and any target's own voice name can be passed instead.
 */
const DEFAULT_MELODIC_VOICE = 'synth1';

/**
 * The one scope sentence every roster carries. Written once so the list mode
 * and the tool description cannot drift apart on what melodic support means.
 */
const GRID_SCOPE_NOTE =
  'Any part here can be selected with `track` (its partId) or `track_name`, and both kinds convert. A DRUM part reads '
  + 'each note as a General MIDI PERCUSSION number and returns one char grid per voice (kick/snare/hat/...). A MELODIC '
  + 'part reads each note as string+fret against the part\'s own open-string tuning (pitch = tuning[string] + fret) and '
  + 'returns ONE mini-notation pitch row ("d#3:4 ~ ~ ~ d4:2 ~", chords as +-joined tokens), filed under `voice_name` '
  + '(default "synth1"). The row CARRIES NOTE LENGTH (":len" in steps) and TIE ("_"), so pasting it into apply_pattern '
  + 'authors the durations the tab wrote; a note past the 16-step gate ceiling is split into a tied chain. Per-step '
  + 'velocity and the un-split source length are also in `melodic.cells`.';

/**
 * The whole-song groove bank: decompose → fuzzy-coalesce → sections + order +
 * (when the song does not fit one project) `project_plan`.
 *
 * One implementation for BOTH whole_song shapes. The drum-only path calls it
 * with no `layers` and gets the historical drum-keyed bank, byte for byte. The
 * multi-part path (`parts`) passes every other selected part as an identity
 * layer, so two windows share a section letter only when EVERY layer of the
 * build matches — the drum grid alone is a false certificate there (two windows
 * with identical drums but different synth/pad content are NOT the same
 * section; a 2026-07-29 build plan hit exactly that and survived by luck).
 */
function buildWholeSongBank(
  src: SongsterrFlat,
  stepsPerBeat: number,
  fuzz: number | undefined,
  layers?: DecomposeLayer[],
  totalBeats?: number,
  /**
   * Quarter-note beats of leading rest to prepend to the WHOLE timeline before
   * windowing. Set when the song opens with a pickup bar: the fixed 32-step
   * windows chop from beat 0, so without the pad EVERY window boundary of a
   * pickup song sits off the barlines (and two musically-identical sections
   * whose windows cut them at different bar phases stop deduping).
   */
  padBeats = 0,
): { arrangement: NonNullable<ImportSongsterrResult['arrangement']>; warnings: string[] } {
  const events = padBeats > 0 ? src.events.map((e) => ({ ...e, beat: e.beat + padBeats })) : src.events;
  const shiftedLayers = padBeats > 0 && layers !== undefined
    ? layers.map((l) => ({ ...l, onsets: l.onsets.map((o) => ({ ...o, beat: o.beat + padBeats })) }))
    : layers;
  const decomp = decomposeToPatterns(events, {
    totalBeats: (totalBeats ?? src.totalBeats) + padBeats,
    stepsPerPattern: 32,
    stepsPerBeat,
    ...(shiftedLayers !== undefined && shiftedLayers.length > 0 ? { layers: shiftedLayers } : {}),
  });
  const barsPerWindow = 32 / stepsPerBeat / 4; // 2 bars at 16ths, 1 bar at 32nds (4/4)
  const co = coalescePatterns(decomp, { maxDistance: fuzz ?? 0.10 });
  const plan = planArrangement(co, { maxPatterns: 8, barsPerWindow });
  // Name each bank section by its label + where it is first heard (marker /
  // measure), so the conversation can stay musical ("B is the chorus groove").
  const markerAt = (measure: number): string | undefined => {
    let name: string | undefined;
    for (const s of src.sections) { if (s.startMeasure <= measure) name = s.name; else break; }
    return name;
  };
  const sections = co.patterns.map((q, i) => {
    const firstWindow = co.order.indexOf(i);
    // 0-based, 4/4 approximation; pad-corrected back into SOURCE measure time.
    const firstMeasure = Math.max(0, Math.floor((firstWindow * barsPerWindow * 4 - padBeats) / 4));
    const marker = markerAt(firstMeasure);
    // A SILENT window (a count-in, a tab's empty measures) quantizes to no
    // voices at all. `voices: {}` is unusable downstream: apply_pattern refuses
    // "`voices` must have at least one voice", so a whole-song arrangement
    // containing a rest bar could not be authored (it killed one song's
    // intro upload and another's outro, 2026-07-16). Emit an explicit
    // rest-only line instead, which carries the window's LENGTH and produces
    // no events — the same shape a hand-authored silent section uses.
    const grids = quantizedToGrids(q);
    const voices = Object.keys(grids).length > 0 ? grids : { kick: '.'.repeat(q.steps) };
    return {
      name: patternLabel(i),
      voices,
      steps: q.steps,
      ...(marker !== undefined || firstWindow >= 0
        ? { first_heard: `${marker ? `${marker}, ` : ''}measure ${firstMeasure + 1}` }
        : {}),
    };
  });
  const bpm = src.tempos.length > 0 ? tempoAtBeat(src, 0) : src.bpm;
  const arrangement: NonNullable<ImportSongsterrResult['arrangement']> = {
    sections,
    order: co.order.map((i) => patternLabel(i)),
    summary: arrangementSummary(co),
    ...(bpm !== undefined ? { bpm } : {}),
    windows: co.windowCount,
    scene_steps: plan.sceneCount,
    fits: {
      one_pattern: plan.fitsInOnePattern,
      chain_only: plan.fitsViaChainOnly,
      pattern_slots: plan.fitsInPatternSlots,
    },
  };
  // A song that does not fit ONE project needs a per-project plan, or the caller
  // is left chunking the order by hand (the 2026-07-16 friction). Only attach it
  // when it is actually needed, so a song that fits one project stays simple.
  if (!(plan.fitsViaChainOnly && plan.fitsInPatternSlots)) {
    arrangement.project_plan = planProjects(sections, arrangement.order);
  }
  return { arrangement, warnings: [...decomp.warnings, ...co.warnings] };
}

export async function executeImportSongsterr(args: ImportSongsterrArgs): Promise<ImportSongsterrResult | ImportSongsterrTrackList> {
  let ref = args.url;
  let searchResults: SearchHit[] | undefined;
  if (ref === undefined) {
    if (!args.query) throw new Error('Provide a `url` (Songsterr URL or id) or a `query` (song name to search).');
    searchResults = await searchSongsterr(args.query);
    if (searchResults.length === 0) throw new Error(`No Songsterr song found for "${args.query}".`);
    ref = String(searchResults[0].songId);   // best match; alternatives returned in search_results
  }

  // Roster-only dry run. One meta GET, no part download, no selection, and no
  // drum-track requirement, so it also answers for a song that has no drums at
  // all (the case the default path refuses).
  if (args.list_tracks === true) {
    // Refuse rather than silently drop the ignored args: a caller that passed
    // both wanted grids and would otherwise get a roster back with no
    // explanation (the silent-no-op pitfall in TOOL-AUTHORING-GUIDE.md).
    if (args.whole_song === true || args.parts !== undefined || hasWindow(args)) {
      throw new Error('list_tracks only lists the song\'s parts; drop whole_song / parts / the window args (section / from_measure / …), or drop list_tracks to fetch a part.');
    }
    const roster = await fetchSongsterrTracks(ref);
    const tracks = roster.allTracks.map(toTrackRow);
    const drums = roster.drumTracks;
    return {
      mode: 'list_tracks',
      song: { songId: roster.songId, revisionId: roster.revisionId, title: roster.title, artist: roster.artist },
      tracks,
      drum_tracks: drums.map((t) => ({ partId: t.partId, name: t.name, views: t.views, popular: t.popular })),
      ...(roster.urlTrackId !== undefined ? { url_track: roster.urlTrackId } : {}),
      ...(searchResults && searchResults.length > 1 ? { search_results: searchResults.slice(0, 5) } : {}),
      notes: [GRID_SCOPE_NOTE],
      next_step: drums.length === 0
        ? `No drum part on this tab (${tracks.length} part(s) listed). Call again with track:<partId> plus a window (section / from_measure) to import one of them as a pitch row.`
        : `Call again with track:<partId> (or track_name) plus a window (section / from_measure) to get the grids. Omit both to default to the drum part${drums.length > 1 ? `s (${drums.length} here, so name one)` : ''}.`,
    };
  }

  // `parts` only means something to the chop, so a caller who passes it without
  // whole_song would silently get a single-part window back and never know the
  // other parts were ignored (the silent-no-op pitfall).
  if (args.parts !== undefined && args.whole_song !== true) {
    throw new Error(
      '`parts` plans ONE project layout across several parts at once and only applies to whole_song:true. '
      + 'Add whole_song:true for the multi-part chop, or drop `parts` and use `track` + a window (section / from_measure) for a single part.',
    );
  }

  const fetched: SongsterrFetched = await fetchSongsterrPart(ref, { track: args.track, trackName: args.track_name });
  // A caller-supplied percussion remap re-flattens the part (fetched.flat is
  // the map-less default). JSON object keys arrive as strings → Number them.
  const drumMap = args.drum_map !== undefined
    ? Object.fromEntries(Object.entries(args.drum_map).map(([k, v]) => [Number(k), v]))
    : undefined;
  if (args.ghost_velocity !== undefined && (args.ghost_velocity < 1 || args.ghost_velocity > 127)) {
    throw new Error(`ghost_velocity must be 1..127 (a ghost note is played quietly, never silenced), got ${args.ghost_velocity}.`);
  }
  // Re-flatten when the caller changed how the source is read. `fetched.flat` is
  // the default-options result, so anything set here invalidates it.
  const flattenOpts = {
    ...(drumMap !== undefined ? { drumMap } : {}),
    ...(args.ghost_velocity !== undefined ? { ghostVelocity: args.ghost_velocity } : {}),
    ...(args.straight_feel === true ? { straightFeel: true } : {}),
  };
  const flat = Object.keys(flattenOpts).length > 0 ? flattenSongsterrDrums(fetched.part, flattenOpts) : fetched.flat;

  // Leading pickup (anacrusis) bar, detected ONCE off the measure walk and
  // surfaced as DATA on every head-covering reply (never applied in place —
  // the pad changes the Play-press feel, which is the user's decision). The
  // measure walk is part-independent, so this serves the melodic path too.
  const pickup = detectPickupBar(flat.measures, args.steps ?? 4);
  const pickupWarning = (padded: boolean): string =>
    `PICKUP BAR: m1 is ${pickup!.pickup_signature} (${pickup!.pickup_steps} steps) against the song's `
    + `${pickup!.prevailing_signature} bar (${pickup!.prevailing_bar_steps}). From MIDI Start every barline of the whole `
    + `song then sits ${pickup!.pad_steps} steps off the 4-beat grid a clock-slaved device counts, so a looper's `
    + 'measure-quantized record-start can NEVER land on the song\'s one, and a chain whose cycle is a non-whole-bar '
    + `total drifts further every wrap. `
    + (padded
      ? '`pickup.padded_voices` is this head with the pad already prepended. '
      : `To align, author the HEAD with ${pickup!.pad_steps} leading rest steps so it fills a whole bar. `)
    + 'ASK THE USER before authoring the padded head: it changes the Play press from "press = the pickup downbeat" '
    + `to "press = a ${pickup!.pad_steps / 4}-beat count before the pickup".`;

  // Which reading does this part want? The part's own top-level `tuning` array,
  // not the instrument name: only a melodic staff carries open-string tunings,
  // and Songsterr marks a percussion staff `tuningFlat` instead.
  const melodicPart = fetched.isMelodic;

  // The articulation knobs, threaded once. Only what the caller actually set, so
  // the codec's own defaults stay the single source of truth for each default.
  const artOpts = {
    ...(args.articulations !== undefined ? { articulations: args.articulations } : {}),
    ...(args.palm_mute_gate_beats !== undefined ? { palmMuteGateBeats: args.palm_mute_gate_beats } : {}),
    ...(args.palm_mute_velocity_scale !== undefined ? { palmMuteVelocityScale: args.palm_mute_velocity_scale } : {}),
    ...(args.let_ring_max_beats !== undefined ? { letRingMaxBeats: args.let_ring_max_beats } : {}),
    ...(args.legato_overlap_sixths !== undefined ? { legatoOverlapSixths: args.legato_overlap_sixths } : {}),
    ...(args.straight_feel === true ? { straightFeel: true } : {}),
  };

  /**
   * The track-wide fidelity receipt, from whichever reading this part wants.
   *
   * Computed lazily and cached: the windowed paths already have it off their own
   * import, and only the discovery / whole_song replies pay for the extra walk.
   * A MELODIC part must be censused by the melodic flattener, not by `flat` (the
   * drum reading runs for every part but reads `fret` as a percussion number, so
   * its applied-field set would credit the wrong fields).
   */
  let fidelityCache: DroppedFidelity | undefined;
  const trackFidelity = (): DroppedFidelity => {
    if (fidelityCache === undefined) {
      const source = melodicPart ? flattenSongsterrMelodic(fetched.part, artOpts) : flat;
      fidelityCache = deriveDroppedFidelity(source.field_census, source.fields_applied);
    }
    return fidelityCache;
  };

  // Track-level import-fidelity facts, surfaced on EVERY return shape (a bare
  // count buried in one window's warnings misreads as "this window is silent").
  // The drum-fidelity counts below come from reading `fret` as a GM percussion
  // number, which is meaningless on a melodic part, so they are skipped there;
  // the melodic path reports its OWN counts from importSongsterrMelodic.
  const trackWarnings: string[] = [];
  if (melodicPart) {
    trackWarnings.push(
      `PART ${fetched.selectedPartId} is MELODIC (tuning [${(fetched.part.tuning ?? []).join(', ')}]), so it imports as a `
      + 'PITCH ROW: pitch = tuning[string] + fret, returned as one mini-notation line in `voices` '
      + `(key "${args.voice_name ?? DEFAULT_MELODIC_VOICE}"). Each hit carries its NOTE LENGTH (":len" in steps), its `
      + 'VELOCITY ("@vel") and its TIE ("_"), so the row can be pasted into apply_pattern as-is; the un-split source '
      + 'length and the per-cell articulations are in `melodic.cells`. drum_map does not apply here; ghost_velocity does '
      + `(ghosted notes import at ${args.ghost_velocity ?? 40}).`,
    );
  }
  // Swing is a measure-level marking, so the drum walk's count holds for a melodic part too.
  if (flat.swung_measures > 0) {
    trackWarnings.push(
      `TRACK-WIDE: SWUNG. ${flat.swung_measures} measure(s) carry the tab's triplet feel `
      + `(${[...new Set(flat.measures.flatMap((m) => (m.swing !== undefined ? [m.swing] : [])))].join(', ')}), so their written `
      + 'straight pairs import as triplet long-short (the second note lands 2/3 of the way through the pair). '
      + 'Use steps 6 (either feel) to land them on the grid; at steps 4 they are placed on micro-ticks (drums) or snapped (pitch rows).',
    );
  }
  if (!melodicPart && flat.unmapped > 0) {
    trackWarnings.push(
      `TRACK-WIDE: ${flat.unmapped} hit(s) on non-GM percussion number(s) [${unmappedSummary(flat)}] were skipped. ` +
      `If a layer is missing, look at where the number lands in the song and re-import with drum_map (e.g. {"0": "clap"}).`,
    );
  }
  if (!melodicPart && flat.flams_collapsed > 0) {
    trackWarnings.push(`TRACK-WIDE: ${flat.flams_collapsed} grace/flam doubling(s) folded into single hits (a flam is one hit at step resolution).`);
  }
  if (!melodicPart && flat.graces_folded > 0) {
    trackWarnings.push(`TRACK-WIDE: ${flat.graces_folded} grace-ornament beat(s) folded onto the following onset (a grace note takes no time in the measure).`);
  }
  // Ghost policy, stated rather than left to inference: a ghosted hit is PLAYED
  // quietly (40 by default, tunable), never dropped. One tab's silent china turned
  // out to be an unmapped effect NUMBER, not the ghost flag, and the same part
  // ghosts real snare/tom/pedal-hat hits that a blanket drop would delete.
  if (!melodicPart && flat.ghosts > 0) {
    trackWarnings.push(
      `TRACK-WIDE: ${flat.ghosts} hit(s) are GHOSTED in the source and import as soft hits (velocity ${args.ghost_velocity ?? 40}), not silence: ` +
      'a ghost note is played quietly, and that soft tail hit is often what makes a groove recognisable. ' +
      'Tune it with ghost_velocity (1..127), or route the layer elsewhere with drum_map.',
    );
  }

  // Resolve the selected part against the FULL roster, not the drum subset: a
  // melodic selection looked up in `drumTracks` came back `name: ''` with no
  // instrument, which reads as "nothing was selected".
  const selected = fetched.allTracks.find((t) => t.partId === fetched.selectedPartId);
  // A non-drum part with NO tuning either: neither reading applies. This is the
  // one case that is genuinely unconvertible, so it says so rather than handing
  // back GM-percussion nonsense.
  if (selected !== undefined && !selected.isDrums && !melodicPart) {
    trackWarnings.push(
      `PART ${selected.partId} is "${selected.instrument}"${selected.name ? ` (${selected.name})` : ''}, and carries neither a percussion staff `
      + 'nor an open-string `tuning`, so neither the drum nor the pitch reading applies. '
      + 'The fetch, sections, tempo map and measures are correct, but `voices` will be empty or nonsense for this part.',
    );
  }

  // The song's tempo, as an actionable "set the clock master to N BPM" line. The
  // target device is resolved by ROLE from the rig manifest (clock_master role),
  // so it names whichever node holds tempo, not a hardcoded box; single-tempo
  // scope, multi-tempo gets a per-section notice. Distinct tempos (not raw tempo
  // marks) gate it: two marks at the same bpm are not a tempo change.
  const tempoSetup = buildTempoSetup(distinctTempos(flat.tempos), resolveClockMaster());

  const base: ImportSongsterrResult = {
    song: { songId: fetched.songId, revisionId: fetched.revisionId, title: fetched.title, artist: fetched.artist },
    track: {
      partId: fetched.selectedPartId,
      name: selected?.name ?? '',
      instrument: selected?.instrument ?? '',
      is_drums: selected?.isDrums ?? false,
    },
    drum_tracks: fetched.drumTracks.map((t) => ({ partId: t.partId, name: t.name, views: t.views, popular: t.popular })),
    sections: flat.sections.map((s) => ({ name: s.name, measure: s.startMeasure + 1, beat: s.startBeat })),
    tempo_map: flat.tempos.map((t) => ({ measure: (flat.measures.find((m) => m.startBeat === t.beat)?.index ?? 0) + 1, bpm: t.bpm })),
    ...(tempoSetup ? { tempo_setup: tempoSetup } : {}),
    next_step: '',
    ...(searchResults && searchResults.length > 1 ? { search_results: searchResults.slice(0, 5) } : {}),
  };
  // Ambiguous if multiple drum tracks and the caller didn't disambiguate.
  if (fetched.drumTracks.length > 1 && args.track === undefined && args.track_name === undefined && !/-s\d+t\d+/.test(args.url ?? '')) {
    base.ambiguous_track = true;
  }

  // Whole-song decomposition: dedup + fuzzy-coalesce the full drum track into a
  // small section bank + play order — the exact shape apply_pattern's
  // `arrangement` input takes.
  if (args.whole_song) {
    if (hasWindow(args)) {
      throw new Error('whole_song decomposes the full track; drop the window args (section / from_measure / …) or drop whole_song.');
    }
    // TWO whole-song answers, and which one applies is decided by the data, not
    // by a flag:
    //
    //   • a DRUM part on its own still gets the groove bank below: clustering
    //     percussion grids is a real reading of a drum track and it is what the
    //     `arrangement` input takes.
    //   • a MELODIC part, or ANY selection of several parts, gets the
    //     SECTION-MARKER chop. A pitch row cannot be clustered, but it does not
    //     need to be: the tab already carries the structure as measure markers.
    //     And a multi-part chop MUST be computed once for the song, because
    //     per-part boundaries would not line up.
    if (melodicPart || args.parts !== undefined) {
      const chopSteps = args.steps ?? 4;
      // Resolve WHICH parts. 'all' means every part the tab actually has content
      // for; Songsterr flags a stub part `isEmpty` and fetching one costs a round
      // trip for nothing.
      const roster = fetched.allTracks;
      const wanted: number[] = args.parts === 'all'
        ? roster.filter((t) => t.isEmpty !== true).map((t) => t.partId)
        : args.parts !== undefined
          ? [...new Set(args.parts)]
          : [fetched.selectedPartId];
      const unknown = wanted.filter((id) => !roster.some((t) => t.partId === id));
      if (unknown.length > 0) {
        throw new Error(
          `parts ${unknown.join(', ')} are not on this tab. Available: `
          + roster.map((t) => `${t.partId}:"${t.instrument}"${t.name ? ` (${t.name})` : ''}`).join(', ') + '.',
        );
      }
      if (wanted.length === 0) throw new Error('No non-empty part on this tab to plan a chop over.');

      const label = (id: number): string => {
        const t = roster.find((x) => x.partId === id);
        return t === undefined ? `part ${id}` : `${t.instrument}${t.name ? ` "${t.name}"` : ''}`;
      };
      const chopParts: ChopPartFlat[] = [];
      const rawParts = new Map<number, SongsterrPart>();
      for (const id of wanted) {
        // The anchor part is already downloaded; only the others cost a fetch.
        const p = id === fetched.selectedPartId ? fetched.part : (await fetchSongsterrPart(ref, { track: id })).part;
        rawParts.set(id, p);
        chopParts.push(toChopPart(id, label(id), p));
      }

      const plan = planSongChop(chopParts, { stepsPerBeat: chopSteps });

      // ── the union-keyed groove bank ──────────────────────────────────
      // The drum-only whole_song path dedupes 2-bar windows into a section bank,
      // and its identity (and the `fuzz` merge) covered the DRUM GRID ALONE. In
      // a multi-part build that key is a false certificate: two windows with
      // identical drums but different synth/pad content merged as "the same
      // section" (the 2026-07-29 plan defect; that build survived only because
      // its pad alternated in lockstep with the drums). When the caller names
      // the parts, the SAME bank is built here with every selected part in the
      // window identity: the first drum part supplies the grids, every other
      // part is an identity layer, and two windows share a letter only when
      // EVERY layer matches, the fuzz threshold holding per layer.
      const drumId = wanted.find((id) => !isMelodicPart(rawParts.get(id)!));
      let bankNote: string | undefined;
      let bankWarnings: string[] = [];
      if (drumId !== undefined) {
        const drumFlat = drumId === fetched.selectedPartId
          ? flat
          : flattenSongsterrDrums(rawParts.get(drumId)!, flattenOpts);
        const layers: DecomposeLayer[] = [];
        for (const id of wanted) {
          if (id === drumId) continue;
          const p = rawParts.get(id)!;
          if (isMelodicPart(p)) {
            const m = flattenSongsterrMelodic(p, artOpts);
            layers.push({
              label: label(id),
              onsets: m.notes.map((n) => ({
                beat: n.beat,
                token: `${n.pitch}:${Math.max(1, Math.round(n.durationBeats * chopSteps))}`,
              })),
            });
          } else {
            const df = flattenSongsterrDrums(p, flattenOpts);
            layers.push({ label: label(id), onsets: df.events.map((e) => ({ beat: e.beat, token: e.voice })) });
          }
        }
        // Windows must cover the LONGEST selected part, not just the drums: a
        // pad outro past the last drum hit is still content to key on.
        const walkEnd = (cp: ChopPartFlat): number => {
          const lm = cp.measures[cp.measures.length - 1];
          return lm === undefined ? 0 : lm.startBeat + (lm.signature[0] * 4) / lm.signature[1];
        };
        const totalBeats = Math.max(drumFlat.totalBeats, ...chopParts.map(walkEnd));
        const bank = buildWholeSongBank(
          drumFlat, chopSteps, args.fuzz, layers, totalBeats,
          pickup !== undefined ? pickup.pad_steps / chopSteps : 0,
        );
        base.arrangement = bank.arrangement;
        bankWarnings = bank.warnings;
        if (pickup !== undefined) {
          bankWarnings = [
            ...bankWarnings,
            `\`arrangement\` windows are cut from a timeline padded by ${pickup.pad_steps} rest steps (the m1 pickup), `
            + 'so every window boundary is a real barline; the head window therefore begins with those rests.',
          ];
        }
        if (layers.length > 0) {
          bankNote =
            `\`arrangement\` is keyed over ALL ${wanted.length} selected part(s): grids from ${label(drumId)}; `
            + `identity layers ${layers.map((l) => l.label).join(', ')}. Two windows share a section letter only when `
            + `EVERY layer matches, and the fuzz threshold (${args.fuzz ?? 0.10}) holds PER LAYER, never on the drums `
            + 'alone — so a letter certifies the BUILD\'s identity. Two sections may therefore show IDENTICAL drum '
            + 'grids under different letters: they differ on a melodic layer, and folding them would silently merge '
            + 'genuinely different sections.';
        }
      }

      base.song_plan = plan;
      base.dropped_fidelity = trackFidelity();
      const chopWarnings = [
        ...trackWarnings, ...plan.warnings, ...bankWarnings,
        ...(bankNote !== undefined ? [bankNote] : []),
        ...droppedFidelitySummary(base.dropped_fidelity),
      ];
      if (pickup !== undefined) {
        base.pickup = { ...pickup };
        chopWarnings.push(
          `${pickupWarning(false)} The plan's project-1 head window includes m1, so its authored head pattern should be `
          + `its listed steps + ${pickup.pad_steps} (rests first) once the user confirms.`,
        );
      }
      if (flat.tempos.length > 1) {
        chopWarnings.push(
          `This song has ${flat.tempos.length} tempo marks (${flat.tempos.map((t) => t.bpm).join(' → ')} bpm); a stored project `
          + 'plays at ONE bpm, so each project needs the tempo in force where it starts (the windowed import returns it). '
          + 'Pass that as apply_pattern\'s `bpm` and the project is STORED at it; omit it and the project silently keeps the ncs_template\'s tempo.',
        );
      }
      if (wanted.length === 1) {
        chopWarnings.push(
          `This chop covers ONE part (${label(wanted[0])}). A song is several parts, and they must share project boundaries `
          + 'or the projects do not line up: pass parts:[…] (or parts:"all") to plan them together in one call.',
        );
      }
      base.warnings = chopWarnings.length ? chopWarnings : undefined;
      const first = plan.projects[0];
      const mixedChains = plan.projects.filter((p) => !p.uniform_patterns).length;
      base.next_step =
        `READ THIS PLAN TO THE USER BEFORE AUTHORING ANYTHING. ${plan.projects.length} project(s), `
        + `${plan.patterns_planned} pattern(s), ${plan.parts.length} part(s), cut on the source's own section markers at m`
        + `${plan.boundaries.join(', m')}; every part shares those bars. Ceiling: ${plan.ceiling.note} `
        + 'Then, once the user confirms the layout and which part goes on which track: for EACH project call '
        + 'import_songsterr again with track:<partId> + from_measure/to_measure from the plan (only the parts listed as '
        + 'sounding in that project), stack the returned rows into ONE apply_pattern call per project '
        + '(mode ncs_upload + ncs_slot + ncs_template), and announce the cost first, because a project write is seconds '
        + `of wire work each. Example for project 1: from_measure:${first?.from_measure ?? 1}, to_measure:${first?.to_measure ?? 1}`
        + `${first !== undefined && first.parts.length > 0 ? `, track:${first.parts[0].partId}` : ''}.`
        + (mixedChains > 0
          ? ` ${mixedChains} project(s) need a MIXED-length pattern chain: author each project as an \`arrangement\` whose `
            + 'sections are that project\'s `pattern_windows`, each with its own `steps` from `pattern_steps`, and import '
            + 'each window on its own from_measure/to_measure. Collapsing the chain to one length would move the bar lines.'
          : '')
        + (base.arrangement !== undefined
          ? ' `arrangement` carries the groove bank for the same build, its section letters keyed over ALL selected '
            + 'parts (see warnings): use those letters, not drum-content eyeballing, to decide which windows are the '
            + 'same section.'
          : '')
        + tempoHint(tempoSetup);
      return base;
    }
    const stepsPerBeat = args.steps ?? 4;
    const bank = buildWholeSongBank(
      flat, stepsPerBeat, args.fuzz, undefined, undefined,
      pickup !== undefined ? pickup.pad_steps / stepsPerBeat : 0,
    );
    base.dropped_fidelity = trackFidelity();
    const warnings = [...trackWarnings, ...bank.warnings, ...droppedFidelitySummary(base.dropped_fidelity)];
    if (pickup !== undefined) {
      base.pickup = { ...pickup };
      warnings.push(
        `${pickupWarning(false)} The \`arrangement\` windows are already cut from a timeline padded by those `
        + `${pickup.pad_steps} rest steps, so its head window begins with them and every window boundary is a real barline.`,
      );
    }
    if (flat.tempos.length > 1) {
      warnings.push(
        `This song has ${flat.tempos.length} tempo marks (${flat.tempos.map((t) => t.bpm).join(' → ')} bpm); the arrangement plays at ONE bpm ` +
        '(per-scene tempo is not authorable yet). Pick the dominant tempo or arrange the constant-tempo span, and pass it as apply_pattern\'s ' +
        '`bpm` so the project is STORED at it; omit it and the project silently keeps the ncs_template\'s tempo.',
      );
    }
    base.arrangement = bank.arrangement;
    base.warnings = warnings.length ? warnings : undefined;
    const bpm = bank.arrangement.bpm;
    const fitNote = bank.arrangement.order.length <= 8
      ? 'The whole order fits the Circuit pattern chain directly.'
      : bank.arrangement.scene_steps <= 4 && bank.arrangement.fits.pattern_slots
        ? `Needs scene mode (${bank.arrangement.scene_steps} scene steps).`
        : `Too long for one project as-is (${bank.arrangement.order.length} plays, ${bank.arrangement.scene_steps} scene steps vs 8 chained patterns / 4 scenes). ` +
          `USE \`arrangement.project_plan\`: it already chunked the song into ${base.arrangement?.project_plan?.projects.length ?? 0} project(s) that each fit, in song order; ` +
          'drive one apply_pattern call per entry (its `order` + the matching `sections`) and foot-switch between them. ' +
          'Only fall back to raising fuzz (lossy: flattens fills) or arranging a sub-span with from_measure/to_measure if you do NOT want the whole song.';
    base.next_step =
      `Pass \`arrangement: {sections, order}\` (with each section's voices/steps) to apply_pattern ` +
      `(mode ncs_upload + ncs_slot/ncs_template${bpm !== undefined ? `, bpm:${bpm}` : ''}). ${fitNote}` +
      tempoHint(tempoSetup);
    return base;
  }

  if (!hasWindow(args)) {
    const egSection = flat.sections[0]?.name ?? 'Intro';
    // The discovery call is where the caller decides WHICH part to take, so it
    // gets the whole roster. `drum_tracks` alone hid every melodic part and made
    // this tool read as drum-only.
    base.all_tracks = fetched.allTracks.map(toTrackRow);
    // The fidelity receipt belongs HERE most of all: this is the call where the
    // caller decides which part to take, and "this guitar carries 792 palm-muted
    // notes and 3 bends" is exactly the kind of thing that should inform it.
    base.dropped_fidelity = trackFidelity();
    const discoveryWarnings = [...trackWarnings, ...droppedFidelitySummary(base.dropped_fidelity)];
    base.warnings = discoveryWarnings.length ? discoveryWarnings : undefined;
    base.next_step = (base.ambiguous_track
      ? `This song has ${fetched.drumTracks.length} drum tracks. Confirm with track_name, then call again with a section (e.g. section:"${egSection}") to get the grids.`
      : `Call again with a window (e.g. section:"${egSection}" or from_measure:N) to get the voice grids, then pass them to apply_pattern. Or call with whole_song:true for the full-song arrangement. all_tracks lists every other part of this song; pass one of its partIds as track to fetch that part instead.`)
      + tempoHint(tempoSetup);
    return base;
  }

  // Windowed extract, MELODIC: one mini-notation pitch row + the LOCAL tempo.
  // Same window resolution, same grid math, same tempo rule as the drum path;
  // only the note reading differs.
  if (melodicPart) {
    const stepsPerBeat = args.steps ?? 4;
    const voiceName = args.voice_name ?? DEFAULT_MELODIC_VOICE;
    const m = importSongsterrMelodic(fetched.part, {
      stepsPerBeat,
      ...(args.from_beat !== undefined ? { fromBeat: args.from_beat } : {}),
      ...(args.beats !== undefined ? { beats: args.beats } : {}),
      ...(args.from_measure !== undefined ? { fromMeasure: args.from_measure } : {}),
      ...(args.to_measure !== undefined ? { toMeasure: args.to_measure } : {}),
      ...(args.section !== undefined ? { section: args.section } : {}),
      ...(args.transpose !== undefined ? { transpose: args.transpose } : {}),
      ...(args.note_lengths !== undefined ? { noteLengths: args.note_lengths } : {}),
      // ghost_velocity reaches melodic parts too (2026-09-03, BK-SONGSTERR-GHOST-
      // MELODIC): the flattener always honoured it, only this call dropped it, so a
      // synth sub-bass line whose tab ghosts two thirds of its notes rode at 40
      // against 100 with no knob to compress the spread.
      ...(args.ghost_velocity !== undefined ? { ghostVelocity: args.ghost_velocity } : {}),
      ...(args.pitch_gestures !== undefined ? { pitchGestures: args.pitch_gestures } : {}),
      ...(args.mono_voice !== undefined ? { monoVoice: args.mono_voice } : {}),
      ...(args.slide_semitones !== undefined ? { slideSemitones: args.slide_semitones } : {}),
      ...artOpts,
    });
    const msig = `${m.signature[0]}/${m.signature[1]}`;
    const mwarnings = [...trackWarnings, ...m.warnings];
    if (m.step_count > 32) {
      mwarnings.push(`This window is ${m.step_count} steps but a Circuit pattern holds 32. ${stepsPerBeat === 8 ? 'At a 32nd grid one pattern = 1 bar, so narrow the window (one bar) ' : 'Split into <=32-step parts '}or let apply_pattern chain them.`);
    }
    // The ceiling that decides every multi-project layout, stated where it bites.
    if (m.step_count > MAX_PROJECT_STEPS) {
      mwarnings.push(
        `This window is ${m.step_count} steps, MORE THAN ONE PROJECT HOLDS: a note track is 8 patterns x 32 steps = `
        + `${MAX_PROJECT_STEPS} steps, i.e. 16 bars at a 16th grid in 4/4. It cannot be authored as one project. `
        + 'Call whole_song:true (with parts:[…] for the whole band) for a section-aligned chop that already respects it.',
      );
    }
    if (m.signature[1] !== 4 || m.signature[0] !== 4) {
      mwarnings.push(`This section is ${msig}: the pitch row is correct, but apply_pattern's live audition assumes 4/4, so set bpm/steps to match the meter (the stored Circuit path is unaffected).`);
    }
    base.window = { section: m.window.section, from_measure: m.window.fromMeasure, from_beat: m.window.fromBeat, beats: m.window.beats, bpm: m.bpm, steps: m.step_count, signature: msig };
    base.voices = { [voiceName]: m.notation };
    if (pickup !== undefined && m.window.fromBeat === 0) {
      // This window covers the song's head: surface the pad as data + a
      // paste-ready padded row ('~' is the melodic rest token). Never applied
      // in place — `cells` keeps describing the UNPADDED row.
      base.pickup = {
        ...pickup,
        padded_voices: { [voiceName]: [...Array<string>(pickup.pad_steps).fill('~'), m.notation].join(' ') },
      };
      mwarnings.push(
        `${pickupWarning(true)} The padded head is ${m.step_count + pickup.pad_steps} steps (use that as its section `
        + 'steps); `melodic.cells` describes the UNPADDED row.',
      );
    }
    base.melodic = {
      voice: voiceName,
      tuning: [...(fetched.part.tuning ?? [])],
      ...(m.range !== undefined ? { range: { low: m.range.low_name, high: m.range.high_name } } : {}),
      cells: m.cells,
      off_grid: m.off_grid,
      merged: m.merged,
      out_of_window: m.out_of_window,
      chord_overflow: m.chord_overflow,
      unresolved: m.unresolved,
      ties_folded: m.ties_folded,
      gate_splits: m.gate_splits,
      gate_clamps: m.gate_clamps,
      ties_emitted: m.ties_emitted,
      note_lengths: args.note_lengths !== false,
      articulations: m.articulations,
      articulation_applied: m.articulation,
      ...(m.mono_dropped > 0 ? { mono_dropped: m.mono_dropped } : {}),
      ...(m.pitch_gestures !== undefined ? { pitch_gestures: m.pitch_gestures } : {}),
    };
    base.dropped_fidelity = m.dropped_fidelity;
    base.warnings = mwarnings.length ? mwarnings : undefined;
    const artNote = args.articulations === false
      ? ' Articulations are OFF (you passed articulations:false), so the lengths are the WRITTEN ones.'
      : m.articulation.damped + m.articulation.legato_connected + m.articulation.let_ring_extended > 0
        ? ` It also carries the source's ARTICULATIONS: ${m.articulation.damped} damped (palm mute / dead / staccato, short gate + trimmed velocity), `
          + `${m.articulation.legato_connected} legato-connected (gate overlapping the next onset), ${m.articulation.let_ring_extended} let-ring `
          + '(sustained to the next strike of the same pitch). Do not "fix" the short or overlapping gates; they are the articulation.'
        : '';
    const lengthNote = args.note_lengths === false
      ? 'It carries PITCH ONLY (you passed note_lengths:false), so every note will author one step long.'
      : `It carries NOTE LENGTHS (":len" in steps), VELOCITIES ("@vel") and ties ("_"), so paste it AS-IS${m.gate_splits > 0 ? `; ${m.gate_splits} long note(s) are already split into tied chains` : ''}.${artNote}`;
    base.next_step =
      `Pass these voices to apply_pattern (port:<device>, voices:<above>, steps:${m.step_count}, bpm:${m.bpm ?? '?'}). ` +
      `\`${voiceName}\` is a PITCH ROW${m.range ? ` spanning ${m.range.low_name}..${m.range.high_name}` : ''}, so route it to a melodic track ` +
      '(Circuit Tracks: synth1 / synth2 / midi1 / midi2) and rename the key with voice_name if the target calls it something else. ' +
      `${lengthNote} ` +
      'Import the song\'s other parts the same way with track:<partId> and stack them into one apply_pattern call.' +
      tempoHint(tempoSetup);
    return base;
  }

  // Windowed extract: the grids + LOCAL tempo, ready for apply_pattern.
  const stepsPerBeat = args.steps ?? 4;
  const q = importSongsterrDrums(fetched.part, {
    stepsPerBeat,
    ...(args.from_beat !== undefined ? { fromBeat: args.from_beat } : {}),
    ...(args.beats !== undefined ? { beats: args.beats } : {}),
    ...(args.from_measure !== undefined ? { fromMeasure: args.from_measure } : {}),
    ...(args.to_measure !== undefined ? { toMeasure: args.to_measure } : {}),
    ...(args.section !== undefined ? { section: args.section } : {}),
    ...(drumMap !== undefined ? { drumMap } : {}),
    ...(args.ghost_velocity !== undefined ? { ghostVelocity: args.ghost_velocity } : {}),
    ...(args.articulations !== undefined ? { articulations: args.articulations } : {}),
    ...(args.straight_feel === true ? { straightFeel: true } : {}),
  });
  const sig = `${q.signature[0]}/${q.signature[1]}`;
  const warnings = [...q.warnings];
  if (q.steps > 32) {
    warnings.push(`This window is ${q.steps} steps but a Circuit pattern holds 32. ${stepsPerBeat === 8 ? 'At a 32nd grid one pattern = 1 bar, so narrow the window (one bar) ' : 'Split into <=32-step parts '}or let apply_pattern chain them.`);
  }
  if (q.steps > MAX_PROJECT_STEPS) {
    warnings.push(
      `This window is ${q.steps} steps, MORE THAN ONE PROJECT HOLDS: a track is 8 patterns x 32 steps = `
      + `${MAX_PROJECT_STEPS} steps, i.e. 16 bars at a 16th grid in 4/4. It cannot be authored as one project. `
      + 'Call whole_song:true (with parts:[…] for the whole band) for a section-aligned chop that already respects it.',
    );
  }
  // apply_pattern's live realizers assume 4 beats/bar; a non-4/4 section auditions
  // at the wrong rate (the grids are correct; the metronome is not).
  if (q.signature[1] !== 4 || q.signature[0] !== 4) {
    warnings.push(`This section is ${sig}: the step grids are correct, but apply_pattern's live audition assumes 4/4, so set bpm/steps to match the meter (the stored Circuit path is unaffected).`);
  }

  base.window = { section: q.window.section, from_measure: q.window.fromMeasure, from_beat: q.window.fromBeat, beats: q.window.beats, bpm: q.bpm, steps: q.steps, signature: sig };
  base.voices = quantizedToGrids(q);
  if (pickup !== undefined && q.window.fromBeat === 0) {
    // Head window: paste-ready padded grids ('.' is the drum rest char).
    base.pickup = {
      ...pickup,
      padded_voices: Object.fromEntries(
        Object.entries(base.voices).map(([k, row]) => [k, '.'.repeat(pickup.pad_steps) + row]),
      ),
    };
    warnings.push(
      `${pickupWarning(true)} The padded head is ${q.steps + pickup.pad_steps} steps (use that as its section steps).`,
    );
  }
  base.dropped_fidelity = q.dropped_fidelity;
  base.warnings = warnings.length ? warnings : undefined;
  base.next_step = `Pass these voices to apply_pattern (port:<device>, voices:<above>, bpm:${q.bpm ?? '?'}). Choose mode by intent: live_stream to audition, ncs_upload (+ ncs_slot/ncs_template) to store on a Circuit Tracks slot. Drum voices map via the target voice_map.`
    + tempoHint(tempoSetup);
  return base;
}
