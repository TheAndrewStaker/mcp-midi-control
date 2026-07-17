/**
 * `import_songsterr` executor: fetch a Songsterr drum tab and return its data
 * ready for `apply_pattern`. Read-only, device-free (no `port`): it GETs public
 * Songsterr endpoints and hands back structured display data.
 *
 * Two-step conversational flow (deliberately NOT folded into apply_pattern):
 *   1. Call with a url/query → see the drum tracks, sections, and tempo map.
 *   2. Call again naming a window (section / from_measure) → get the per-voice
 *      step grids + the LOCAL tempo, then pass `voices` + `bpm` to apply_pattern.
 *
 * Keeping the fetch separate keeps apply_pattern device-focused and makes the
 * import an inspectable step (the agent can see "two drum tracks: II vs
 * Programmed Drums; sections Intro/Verse/Bridge" before committing).
 */

import {
  importSongsterrDrums,
  quantizedToGrids,
  fetchSongsterrDrums,
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
} from '../patterns/index.js';

export interface ImportSongsterrArgs {
  /** Songsterr URL (…-s1467797t11) or bare id (1467797 / 1467797t11). */
  url?: string;
  /** Name search ("Sleep Token Gethsemane"); resolves to a song when you don't have the URL. */
  query?: string;
  /** Drum-track index override (a song may have several). */
  track?: number;
  /** Pick the drum track by name/instrument substring ("Programmed", "electronic"). */
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
  /** whole_song only: fuzzy-merge threshold 0..1 (default 0.10). Higher folds near-identical grooves (fills) together, shrinking the bank toward the 8 slots; 0 = exact dedup. */
  fuzz?: number;
  /**
   * Per-source percussion remap for numbers this tab uses outside (or wrongly
   * inside) GM: source number → neutral voice name ("clap") or GM number (39).
   * The result's warnings NAME any unmapped numbers with hit counts; pass this
   * to import them instead of skipping. JSON keys arrive as strings.
   */
  drum_map?: Record<string, string | number>;
}

export interface ImportSongsterrResult {
  song: { songId: number; revisionId: number; title: string; artist: string };
  track: { partId: number; name: string };
  drum_tracks: { partId: number; name: string; views?: number; popular: boolean }[];
  ambiguous_track?: boolean;
  search_results?: SearchHit[];
  sections: { name: string; measure: number; beat: number }[];
  tempo_map: { measure: number; bpm: number }[];
  /** Present when a window was requested: the grids to feed apply_pattern. */
  window?: { section?: string; from_measure?: number; from_beat: number; beats: number; bpm?: number; steps: number; signature: string };
  voices?: Record<string, string>;
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
  warnings?: string[];
  next_step: string;
}

const hasWindow = (a: ImportSongsterrArgs): boolean =>
  a.section !== undefined || a.from_measure !== undefined || a.to_measure !== undefined || a.from_beat !== undefined || a.beats !== undefined;

export async function executeImportSongsterr(args: ImportSongsterrArgs): Promise<ImportSongsterrResult> {
  let ref = args.url;
  let searchResults: SearchHit[] | undefined;
  if (ref === undefined) {
    if (!args.query) throw new Error('Provide a `url` (Songsterr URL or id) or a `query` (song name to search).');
    searchResults = await searchSongsterr(args.query);
    if (searchResults.length === 0) throw new Error(`No Songsterr song found for "${args.query}".`);
    ref = String(searchResults[0].songId);   // best match; alternatives returned in search_results
  }

  const fetched: SongsterrFetched = await fetchSongsterrDrums(ref, { track: args.track, trackName: args.track_name });
  // A caller-supplied percussion remap re-flattens the part (fetched.flat is
  // the map-less default). JSON object keys arrive as strings → Number them.
  const drumMap = args.drum_map !== undefined
    ? Object.fromEntries(Object.entries(args.drum_map).map(([k, v]) => [Number(k), v]))
    : undefined;
  const flat = drumMap !== undefined ? flattenSongsterrDrums(fetched.part, { drumMap }) : fetched.flat;

  // Track-level import-fidelity facts, surfaced on EVERY return shape (a bare
  // count buried in one window's warnings misreads as "this window is silent").
  const trackWarnings: string[] = [];
  if (flat.unmapped > 0) {
    trackWarnings.push(
      `TRACK-WIDE: ${flat.unmapped} hit(s) on non-GM percussion number(s) [${unmappedSummary(flat)}] were skipped. ` +
      `If a layer is missing, look at where the number lands in the song and re-import with drum_map (e.g. {"0": "clap"}).`,
    );
  }
  if (flat.flams_collapsed > 0) {
    trackWarnings.push(`TRACK-WIDE: ${flat.flams_collapsed} grace/flam doubling(s) folded into single hits (a flam is one hit at step resolution).`);
  }

  const base: ImportSongsterrResult = {
    song: { songId: fetched.songId, revisionId: fetched.revisionId, title: fetched.title, artist: fetched.artist },
    track: { partId: fetched.selectedPartId, name: fetched.drumTracks.find((t) => t.partId === fetched.selectedPartId)?.name ?? '' },
    drum_tracks: fetched.drumTracks.map((t) => ({ partId: t.partId, name: t.name, views: t.views, popular: t.popular })),
    sections: flat.sections.map((s) => ({ name: s.name, measure: s.startMeasure + 1, beat: s.startBeat })),
    tempo_map: flat.tempos.map((t) => ({ measure: (flat.measures.find((m) => m.startBeat === t.beat)?.index ?? 0) + 1, bpm: t.bpm })),
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
    const stepsPerBeat = args.steps ?? 4;
    const decomp = decomposeToPatterns(flat.events, { totalBeats: flat.totalBeats, stepsPerPattern: 32, stepsPerBeat });
    const barsPerWindow = 32 / stepsPerBeat / 4; // 2 bars at 16ths, 1 bar at 32nds (4/4)
    const co = coalescePatterns(decomp, { maxDistance: args.fuzz ?? 0.10 });
    const plan = planArrangement(co, { maxPatterns: 8, barsPerWindow });
    const warnings = [...trackWarnings, ...decomp.warnings, ...co.warnings];
    if (flat.tempos.length > 1) {
      warnings.push(
        `This song has ${flat.tempos.length} tempo marks (${flat.tempos.map((t) => t.bpm).join(' → ')} bpm); the arrangement plays at ONE bpm ` +
        '(per-scene tempo is not authorable yet). Pick the dominant tempo or arrange the constant-tempo span.',
      );
    }
    // Name each bank section by its label + where it is first heard (marker /
    // measure), so the conversation can stay musical ("B is the chorus groove").
    const markerAt = (measure: number): string | undefined => {
      let name: string | undefined;
      for (const s of flat.sections) { if (s.startMeasure <= measure) name = s.name; else break; }
      return name;
    };
    const sections = co.patterns.map((q, i) => {
      const firstWindow = co.order.indexOf(i);
      const firstMeasure = Math.floor(firstWindow * barsPerWindow); // 0-based, 4/4 approximation
      const marker = markerAt(firstMeasure);
      // A SILENT window (a count-in, a tab's empty measures) quantizes to no
      // voices at all. `voices: {}` is unusable downstream: apply_pattern refuses
      // "`voices` must have at least one voice", so a whole-song arrangement
      // containing a rest bar could not be authored (it killed both the Amber
      // intro upload and the Blindside outro, 2026-07-16). Emit an explicit
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
    const bpm = flat.tempos.length > 0 ? tempoAtBeat(flat, 0) : flat.bpm;
    base.arrangement = {
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
      base.arrangement.project_plan = planProjects(sections, base.arrangement.order);
    }
    base.warnings = warnings.length ? warnings : undefined;
    const fitNote = co.order.length <= 8
      ? 'The whole order fits the Circuit pattern chain directly.'
      : plan.sceneCount <= 4 && plan.fitsInPatternSlots
        ? `Needs scene mode (${plan.sceneCount} scene steps).`
        : `Too long for one project as-is (${co.order.length} plays, ${plan.sceneCount} scene steps vs 8 chained patterns / 4 scenes). ` +
          `USE \`arrangement.project_plan\`: it already chunked the song into ${base.arrangement?.project_plan?.projects.length ?? 0} project(s) that each fit, in song order; ` +
          'drive one apply_pattern call per entry (its `order` + the matching `sections`) and foot-switch between them. ' +
          'Only fall back to raising fuzz (lossy: flattens fills) or arranging a sub-span with from_measure/to_measure if you do NOT want the whole song.';
    base.next_step =
      `Pass \`arrangement: {sections, order}\` (with each section's voices/steps) to apply_pattern ` +
      `(mode ncs_upload + ncs_slot/ncs_template${bpm !== undefined ? `, bpm:${bpm}` : ''}). ${fitNote}`;
    return base;
  }

  if (!hasWindow(args)) {
    const egSection = flat.sections[0]?.name ?? 'Intro';
    base.warnings = trackWarnings.length ? trackWarnings : undefined;
    base.next_step = base.ambiguous_track
      ? `This song has ${fetched.drumTracks.length} drum tracks. Confirm with track_name, then call again with a section (e.g. section:"${egSection}") to get the grids.`
      : `Call again with a window (e.g. section:"${egSection}" or from_measure:N) to get the voice grids, then pass them to apply_pattern. Or call with whole_song:true for the full-song arrangement.`;
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
  });
  const sig = `${q.signature[0]}/${q.signature[1]}`;
  const warnings = [...q.warnings];
  if (q.steps > 32) {
    warnings.push(`This window is ${q.steps} steps but a Circuit pattern holds 32. ${stepsPerBeat === 8 ? 'At a 32nd grid one pattern = 1 bar, so narrow the window (one bar) ' : 'Split into <=32-step parts '}or let apply_pattern chain them.`);
  }
  // apply_pattern's live realizers assume 4 beats/bar; a non-4/4 section auditions
  // at the wrong rate (the grids are correct; the metronome is not).
  if (q.signature[1] !== 4 || q.signature[0] !== 4) {
    warnings.push(`This section is ${sig}: the step grids are correct, but apply_pattern's live audition assumes 4/4, so set bpm/steps to match the meter (the stored Circuit path is unaffected).`);
  }

  base.window = { section: q.window.section, from_measure: q.window.fromMeasure, from_beat: q.window.fromBeat, beats: q.window.beats, bpm: q.bpm, steps: q.steps, signature: sig };
  base.voices = quantizedToGrids(q);
  base.warnings = warnings.length ? warnings : undefined;
  base.next_step = `Pass these voices to apply_pattern (port:<device>, voices:<above>, bpm:${q.bpm ?? '?'}). Choose mode by intent: live_stream to audition, ncs_upload (+ ncs_slot/ncs_template) to store on a Circuit Tracks slot. Drum voices map via the target voice_map.`;
  return base;
}
