/**
 * Songsterr drum JSON → drum step-grid importer (the parse + flatten half).
 *
 * A third front-end for the song-import pipeline, alongside the ASCII-tab and
 * Standard-MIDI-File paths. Songsterr serves an already-quantized score whose
 * drum track stores each hit's percussion as `note.fret` = the General-MIDI
 * percussion note number (36=kick, 38=snare, 42=closed-hat, …) — exactly what
 * `gmDrumToVoice` consumes. So this layer just walks the score and emits the
 * SAME `DrumEvent[]` intermediate `midiFile.ts` produces; everything downstream
 * (quantize → apply_pattern → Circuit author → upload) is reused unchanged.
 *
 * Like `parseMidiFile`, this module is PURE and dependency-free: it takes an
 * already-fetched, already-decompressed `DrumPart` object. The 3-hop fetch
 * (meta → CDN part JSON, gzip) is an I/O front-end and lives in the script
 * `scripts/songsterr-drum-import.ts`, not here.
 *
 * Source shape (only the fields we read), per a live capture of songs 23527 +
 * 1467797 (Sleep Token "Gethsemane"):
 *   { measures:[ { signature?:[n,d],            // emitted only when it changes
 *                  marker?:{ text:"Bridge" },   // section name, only when it changes
 *                  voices:[ { beats:[
 *                    { duration:[num,den],       // ACTUAL fraction of a whole note
 *                      velocity?:"fff"|"f"|…,     // sticky dynamic (only on change)
 *                      rest?:true,
 *                      notes:[ { fret:36 } ] } ] } ] } ],
 *     automations:{ tempo:[ { measure, position, bpm } ] } }   // multi-tempo map
 *
 * Both `signature`, `marker`, and `velocity` are STICKY — Songsterr emits them
 * only when they change, so all three are carried forward. The tempo map is a
 * list of marks keyed by measure; a windowed section must use the tempo IN FORCE
 * at its start, not `tempo[0]` (a 4-tempo song would otherwise render every
 * section past measure 0 at the wrong — often half — speed).
 */

import {
  gmDrumToVoice,
  quantizeDrumEvents,
  type DrumEvent,
  type QuantizedDrums,
} from './drumScore.js';

/** Songsterr dynamics string → accent (loud) / ghost (soft) flags. */
const ACCENT = new Set(['ff', 'fff', 'ffff', 'sf', 'sfz']);
const GHOST = new Set(['pp', 'ppp', 'pppp']);

// ── Songsterr JSON shapes (only the fields we read) ──────────────────

export interface SsNote {
  fret?: number;
  string?: number;
  rest?: boolean;
  /** Per-note grace/ghost flag (Songsterr writes flams as the same fret twice, one ghosted). */
  ghost?: boolean;
}
export interface SsBeat {
  notes?: SsNote[];
  rest?: boolean;
  velocity?: string;
  /** ACTUAL fraction of a whole note (dots folded in): [num, den]. */
  duration: [number, number];
}
export interface SsVoice {
  beats: SsBeat[];
}
export interface SsMeasure {
  voices: SsVoice[];
  /** Present only when the signature changes; carry the last one forward. */
  signature?: [number, number];
  /** Section marker (Intro/Verse/Bridge/…); present only when it changes. */
  marker?: { text?: string };
}
export interface DrumPart {
  measures: SsMeasure[];
  automations?: { tempo?: { measure: number; position?: number; bpm: number }[] };
}

// ── Flattened forms ──────────────────────────────────────────────────

/** One measure's location + state, in quarter-note beats. */
export interface MeasureInfo {
  /** 0-based measure index (the JSON order). Displayed measure numbers are this + 1. */
  index: number;
  /** Quarter-note beat where this measure starts. */
  startBeat: number;
  signature: [number, number];
  /** Tempo (bpm) in force at this measure. */
  bpm?: number;
  /** Section marker text, if this measure begins one (Songsterr is sticky). */
  marker?: string;
}

/** A tempo mark, with its measure resolved to a quarter-note beat offset. */
export interface TempoMark {
  measure: number;
  beat: number;
  bpm: number;
}

/** A named section: the marker text + the measure/beat it begins at. */
export interface SectionInfo {
  name: string;
  startMeasure: number;
  startBeat: number;
}

export interface SongsterrFlat {
  events: DrumEvent[];
  /** Total length of the track in quarter-note beats. */
  totalBeats: number;
  /** First tempo mark, if any (kept for back-compat; prefer `tempoAtBeat`). */
  bpm?: number;
  /** Full tempo map (measure → beat → bpm), sorted by beat. */
  tempos: TempoMark[];
  /** Last time signature seen (carried forward). */
  signature: [number, number];
  /** Per-measure index (start beat, signature, local tempo, section marker). */
  measures: MeasureInfo[];
  /** Named sections (the subset of measures that begin a marker). */
  sections: SectionInfo[];
  /** Count of hits whose GM number mapped to no voice (exotic percussion). */
  unmapped: number;
  /**
   * WHICH percussion numbers went unmapped, with hit counts — the actionable
   * half of `unmapped` (a bare count told nobody what to fix; "number 0 × 75"
   * is a diagnosis). Remap via the `drumMap` option.
   */
  unmapped_numbers: Record<number, number>;
  /**
   * Grace/flam doublings folded into single hits: Songsterr writes a flam as
   * the same fret twice in one beat (one note ghosted). We cannot place a
   * sub-tick grace note, so the beat emits ONE event; the fold is counted here
   * (previously these surfaced as phantom same-step "collisions").
   */
  flams_collapsed: number;
}

export interface FlattenOptions {
  /**
   * Per-source percussion remap: source number → neutral voice name ("clap")
   * or GM number (39). Applied BEFORE the GM lookup, so numbers outside (or
   * wrongly inside) GM import correctly. Example: Like That writes its clap
   * layer on number 0 → `{0: 'clap'}`.
   */
  drumMap?: Readonly<Record<number, string | number>>;
}

/**
 * Songsterr's OWN percussion numbering beyond GM — a DECODE, not a guess:
 * extracted 2026-07-02 from Songsterr's player code (the `DrumLegend` chunk's
 * percussion-constants object in the production vendor bundle at
 * static3.songsterr.com). GM defines 35-81; these are the extra numbers
 * Songsterr tabs legitimately carry. Each maps to the neutral voice of its
 * musical function; articulations a step grid cannot express (rim shot, half
 * hat, edge, chokes) collapse to their parent drum's voice. Note number 0 is
 * NOT in Songsterr's table either (their legend special-cases unknown numbers),
 * so a tab using it still needs an explicit `drumMap`. A caller `drumMap`
 * overrides every entry here.
 */
export const SONGSTERR_DRUM_EXTENSIONS: Readonly<Record<number, string>> = {
  27: 'perc',       // High Q
  28: 'perc',       // Slap
  29: 'perc',       // Scratch push
  30: 'perc',       // Scratch pull
  31: 'perc',       // Sticks
  32: 'perc',       // Square click
  33: 'woodblock',  // Metronome click
  34: 'triangle',   // Metronome bell
  82: 'maracas',    // Shaker
  83: 'perc',       // Jingle bell
  84: 'triangle',   // Bell tree
  85: 'claves',     // Castanets
  86: 'tom',        // Mute surdo
  87: 'tom',        // Open surdo
  91: 'snare',      // Snare rim shot
  92: 'hat',        // Half hi-hat
  93: 'ride',       // Ride edge
  94: 'ride',       // Ride cymbal choke
  95: 'crash',      // Splash cymbal choke
  96: 'crash',      // Chinese cymbal choke
  97: 'crash',      // Crash cymbal choke
  98: 'crash',      // Crash cymbal 2 choke
  99: 'perc',       // Low cowbell
  102: 'perc',      // High cowbell
};

/** The bpm in force at a given quarter-note beat (last mark at/before it). */
export function tempoAtBeat(flat: Pick<SongsterrFlat, 'tempos'>, beat: number): number | undefined {
  let bpm: number | undefined;
  for (const t of flat.tempos) {
    if (t.beat <= beat + 1e-9) bpm = t.bpm; else break;
  }
  return bpm ?? flat.tempos[0]?.bpm;
}

/**
 * Walk measures → voices → beats → notes, accumulating each onset's position in
 * QUARTER-NOTE beats (the unit `quantizeDrumEvents` expects: stepsPerBeat=4 →
 * 16th grid). `duration` is the actual fraction of a whole note, so a length in
 * quarter beats = (num/den) * 4. Signature, marker, AND dynamic (velocity) are
 * all carried forward (Songsterr emits each only on change). Voices within a
 * measure each run their own timeline from the measure start.
 */
export function flattenSongsterrDrums(part: DrumPart, opts: FlattenOptions = {}): SongsterrFlat {
  const events: DrumEvent[] = [];
  const measures: MeasureInfo[] = [];
  const sections: SectionInfo[] = [];
  let measureStart = 0;
  let sig: [number, number] = [4, 4];
  let dynamic: string | undefined;
  let unmapped = 0;
  const unmappedNumbers: Record<number, number> = {};
  let flamsCollapsed = 0;

  for (let mi = 0; mi < part.measures.length; mi++) {
    const measure = part.measures[mi];
    if (measure.signature) sig = measure.signature;
    const markerText = measure.marker?.text;
    measures.push({ index: mi, startBeat: measureStart, signature: [sig[0], sig[1]], marker: markerText });
    if (markerText) sections.push({ name: markerText, startMeasure: mi, startBeat: measureStart });
    const measureLen = (sig[0] * 4) / sig[1];

    for (const voice of measure.voices ?? []) {
      let pos = measureStart;
      for (const beat of voice.beats ?? []) {
        if (beat.velocity) dynamic = beat.velocity;       // sticky dynamic
        const durBeats = (beat.duration[0] / beat.duration[1]) * 4;
        if (!beat.rest) {
          // Group the beat's notes by fret: a repeated fret is FLAM/grace
          // notation (one copy ghosted) — one musical hit, un-placeable at
          // sub-tick resolution, so it folds to a single event (counted).
          const byFret = new Map<number, SsNote[]>();
          for (const note of beat.notes ?? []) {
            if (note.rest || typeof note.fret !== 'number') continue;
            const group = byFret.get(note.fret) ?? [];
            group.push(note);
            byFret.set(note.fret, group);
          }
          for (const [fret, group] of byFret) {
            if (group.length > 1) flamsCollapsed += group.length - 1;
            // Lookup order: caller remap (number → voice name or GM number) →
            // GM dictionary → Songsterr's own extended numbering (decoded from
            // their player). Unmapped numbers are counted BY NUMBER so the
            // caller can see what to remap instead of a blind total.
            const remap = opts.drumMap?.[fret];
            const target = typeof remap === 'number' ? remap : fret;
            const v = typeof remap === 'string' ? remap : (gmDrumToVoice(target) ?? SONGSTERR_DRUM_EXTENSIONS[target]);
            if (v === undefined) {
              unmapped += group.length;
              unmappedNumbers[fret] = (unmappedNumbers[fret] ?? 0) + group.length;
              continue;
            }
            // Ghost: the note's own flag (every copy ghosted) or the sticky
            // soft dynamic; a ghosted note is never also an accent.
            const ghost = group.every((g) => g.ghost === true) || (dynamic ? GHOST.has(dynamic) : false);
            const accent = !ghost && (dynamic ? ACCENT.has(dynamic) : false);
            events.push({ voice: v, beat: pos, ...(accent ? { accent } : {}), ...(ghost ? { ghost } : {}) });
          }
        }
        pos += durBeats;
      }
    }
    measureStart += measureLen;
  }

  // Resolve the tempo map: each mark's measure → its start beat. (position is a
  // sub-measure offset in the source; 0 in every sample seen, so left unapplied.)
  const tempos: TempoMark[] = (part.automations?.tempo ?? [])
    .map((t) => ({ measure: t.measure, beat: measures[t.measure]?.startBeat ?? 0, bpm: t.bpm }))
    .sort((a, b) => a.beat - b.beat);

  // Backfill each measure's in-force tempo now that the map exists.
  for (const m of measures) m.bpm = tempoAtBeat({ tempos }, m.startBeat);

  events.sort((a, b) => a.beat - b.beat);
  return {
    events, totalBeats: measureStart, bpm: tempos[0]?.bpm, tempos,
    signature: sig, measures, sections, unmapped,
    unmapped_numbers: unmappedNumbers, flams_collapsed: flamsCollapsed,
  };
}

/** Render the unmapped-number histogram as "0×75, 31×2" (empty string if none). */
export function unmappedSummary(flat: Pick<SongsterrFlat, 'unmapped_numbers'>): string {
  return Object.entries(flat.unmapped_numbers)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(', ');
}

export interface SongsterrImportOptions {
  /** First quarter-note beat of the window (0-based). Default 0. Overridden by fromMeasure/section. */
  fromBeat?: number;
  /** Window length in quarter-note beats. Default: to the next section/measure boundary, else the whole track. */
  beats?: number;
  /** Grid resolution (steps per beat). 4 = 16ths (default), 8 = 32nds. */
  stepsPerBeat?: number;
  /** Start at this DISPLAYED measure number (1-based, matching the tab UI). Resolves to its beat. */
  fromMeasure?: number;
  /** End after this displayed measure number (1-based, inclusive). Sets the window length. */
  toMeasure?: number;
  /** Start at this named section ("Bridge"); case-insensitive. Length runs to the next section unless beats/toMeasure is given. */
  section?: string;
  /** Per-source percussion remap (see FlattenOptions.drumMap): number → voice name or GM number. */
  drumMap?: Readonly<Record<number, string | number>>;
}

export interface SongsterrDrumImport extends QuantizedDrums {
  /** Total quarter-note beats of drum content found (so a caller can window it). */
  total_beats: number;
  /** Tempo IN FORCE at the window start (not tempo[0]). */
  bpm?: number;
  signature: [number, number];
  /** The resolved window, for the caller to echo back. */
  window: { fromBeat: number; beats: number; fromMeasure?: number; section?: string };
}

/** Resolve fromMeasure/toMeasure/section into a concrete {fromBeat, beats} window. */
function resolveWindow(flat: SongsterrFlat, opts: SongsterrImportOptions): { fromBeat: number; beats: number; fromMeasure?: number; section?: string } {
  let fromBeat = opts.fromBeat ?? 0;
  let fromMeasure: number | undefined;
  let sectionName: string | undefined;
  let endBeat: number | undefined;

  if (opts.section !== undefined) {
    const want = opts.section.toLowerCase();
    const idx = flat.sections.findIndex((s) => s.name.toLowerCase().includes(want));
    if (idx < 0) throw new Error(`section "${opts.section}" not found. Available: ${flat.sections.map((s) => s.name).join(', ') || '(none)'}`);
    fromBeat = flat.sections[idx].startBeat;
    fromMeasure = flat.sections[idx].startMeasure + 1;
    sectionName = flat.sections[idx].name;
    endBeat = flat.sections[idx + 1]?.startBeat ?? flat.totalBeats;  // to the next section
  }
  if (opts.fromMeasure !== undefined) {
    const m = flat.measures[opts.fromMeasure - 1];                    // displayed (1-based) → index
    if (!m) throw new Error(`measure ${opts.fromMeasure} out of range (song has ${flat.measures.length} measures)`);
    fromBeat = m.startBeat;
    fromMeasure = opts.fromMeasure;
    endBeat = undefined;
  }
  if (opts.toMeasure !== undefined) {
    const next = flat.measures[opts.toMeasure];                       // measure AFTER the last (exclusive end)
    endBeat = next ? next.startBeat : flat.totalBeats;
  }

  const beats = opts.beats ?? (endBeat !== undefined ? endBeat - fromBeat : Math.max(1, Math.ceil(flat.totalBeats) - fromBeat));
  return { fromBeat, beats, fromMeasure, section: sectionName };
}

/**
 * Flatten a Songsterr drum part and quantize a WINDOW of it onto a step grid —
 * the single-pattern entry point, mirroring `importMidiDrums`. The window can be
 * addressed by beat (fromBeat/beats), by DISPLAYED measure (fromMeasure/toMeasure,
 * 1-based), or by section NAME ("Bridge"). The returned `bpm` is the tempo IN
 * FORCE at the window start, not the song's opening tempo. For the whole song
 * (a deduped bank + arrangement), feed `flattenSongsterrDrums(...).events` to
 * `decomposeToPatterns`.
 */
export function importSongsterrDrums(part: DrumPart, opts: SongsterrImportOptions = {}): SongsterrDrumImport {
  const flat = flattenSongsterrDrums(part, { drumMap: opts.drumMap });
  const stepsPerBeat = opts.stepsPerBeat ?? 4;
  const window = resolveWindow(flat, opts);

  const windowed = flat.events
    .map((e) => ({ ...e, beat: e.beat - window.fromBeat }))
    .filter((e) => e.beat >= -0.001 && e.beat < window.beats);

  const q = quantizeDrumEvents(windowed, { beats: window.beats, stepsPerBeat });
  if (flat.unmapped > 0) {
    // Track-wide (not window-specific): name the NUMBERS so the fix is one
    // drumMap arg away, and so an empty window is not misread as "the track
    // dropped hits here".
    q.warnings.push(
      `TRACK-WIDE: ${flat.unmapped} hit(s) on non-GM percussion number(s) [${unmappedSummary(flat)}] were skipped. ` +
      `If a layer is missing, remap with drumMap (e.g. {0: 'clap'}) — check what the number plays against the song.`,
    );
  }
  if (flat.flams_collapsed > 0) {
    q.warnings.push(`TRACK-WIDE: ${flat.flams_collapsed} grace/flam doubling(s) folded into single hits (a flam is one hit at step resolution).`);
  }
  // The window's LOCAL time signature (the measure it starts in), not the song's
  // final one: a windowed section can be in a different meter.
  const startMeasure = flat.measures.filter((m) => m.startBeat <= window.fromBeat + 1e-9).pop();
  const signature = startMeasure ? startMeasure.signature : flat.signature;
  return { ...q, total_beats: flat.totalBeats, bpm: tempoAtBeat(flat, window.fromBeat), signature, window };
}
