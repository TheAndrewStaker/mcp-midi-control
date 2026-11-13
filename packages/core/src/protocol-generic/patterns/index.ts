/**
 * Device-neutral pattern / sequencer-orchestrator module.
 *
 * Pure authoring + compilation (named library, mini-notation parser,
 * Euclidean generator, grid→plan compiler, voice resolution) plus the
 * shared realizers. Serves every pattern target (Circuit Tracks, SPD-SX,
 * Hydrasynth, future grooveboxes), so it lives in core, not a device
 * package. Mirrors the `recipes/` "named data + materializer" layout.
 */

export type { NeutralPattern, Voice, Step, VoiceName } from './types.js';
export {
  PatternError,
  GATE_SIXTHS_PER_STEP,
  MIN_GATE_SIXTHS,
  MAX_GATE_SIXTHS,
  DEFAULT_GATE_SIXTHS,
  gateSixthsFromSteps,
  type GateFromSteps,
} from './types.js';

export {
  charGridToSteps,
  parseVoice,
  parseVoiceLine,
  parseMiniNotation,
  parsePitch,
  tryParsePitchChord,
  keyToSemitones,
  resolveTranspose,
} from './miniNotation.js';

export { euclid, euclidToString } from './euclid.js';

export { parseDrumTab, type ParsedDrumTab } from './drumTab.js';

export { applyRoundRobin, type RoundRobinSpec, type RoundRobinResult } from './roundRobin.js';

export {
  applyLegato,
  findPitchTargetGaps,
  type LegatoOptions,
  type LegatoReport,
  type LegatoResult,
} from './legato.js';

export {
  quantizeDrumEvents,
  gmDrumToVoice,
  GM_DRUM_TO_VOICE,
  type DrumEvent,
  type QuantizeOptions,
  type QuantizedDrums,
} from './drumScore.js';

export {
  DRUM_ROLES,
  canonicalRole,
  isKnownRole,
  type DrumRole,
} from './drumRoles.js';

export {
  parseMidiFile,
  importMidiDrums,
  importMidiMelodic,
  midiChannelSummary,
  quantizedToGrids,
  type ParsedMidi,
  type MidiNote,
  type MidiDrumImportOptions,
  type MidiDrumImport,
  type MidiMelodicImportOptions,
  type MidiMelodicImport,
  type MidiDurationReport,
  type MidiChannelInfo,
} from './midiFile.js';

export {
  writeMidiFile,
  untangleNotes,
  DEFAULT_TICKS_PER_BEAT,
  type SmfNote,
  type SmfTrack,
  type SmfTempo,
  type SmfMeter,
  type SmfMarker,
  type SmfSong,
} from './midiFileWrite.js';

export {
  buildSongMidi,
  splitPercussion,
  partTracks,
  drumEventNote,
  GM_KIT_NOTES,
  PERCUSSION_TRACK,
  pitchBendCurve,
  VIBRATO_DEPTH,
  VIBRATO_HZ,
  GLIDE_OVERLAP_TICKS,
  DEFAULT_BEND_RANGE,
  filterMelodicPart,
  type MelodicPartFilter,
  type SongMidiTrack,
  type PercussionSplit,
  type SongMidiPart,
  type SongMidiSection,
  type SongMidiSequence,
  type SongMidiBuild,
  type SongMidiChart,
  type SongMidiOptions,
} from './songMidi.js';

export {
  planRebar,
  rebarDrums,
  rebarMelodic,
  translateRange,
  translateBorrow,
  type RebarRange,
  type RebarMap,
} from './rebar.js';

export {
  DRUM_MAP_PRESETS,
  MIXWAVE_ST2_GROOVES,
  resolveDrumMapPreset,
} from './drumMapPresets.js';

export { rollVelocity } from './rollDynamics.js';

export {
  flattenSongsterrDrums,
  importSongsterrDrums,
  flattenSongsterrMelodic,
  importSongsterrMelodic,
  isMelodicPart,
  pitchToken,
  tempoAtBeat,
  unmappedSummary,
  SONGSTERR_DRUM_EXTENSIONS,
  SONGSTERR_DYNAMIC_VELOCITY,
  type SongsterrPart,
  /** Back-compat alias of `SongsterrPart`; the shape was never drum-only. */
  type DrumPart,
  type SongsterrFlat,
  type SongsterrImportOptions,
  type SongsterrDrumImport,
  type FlattenOptions,
  type MelodicNote,
  type MelodicCell,
  type SongsterrMelodicFlat,
  type SongsterrMelodicImport,
  type MelodicFlattenOptions,
  type MelodicImportOptions,
  type MeasureInfo,
  type TempoMark,
  type SectionInfo,
} from './songsterr.js';

export {
  parseSongRef,
  drumTrackChoices,
  trackChoices,
  selectDrumTrack,
  searchSongsterr,
  fetchSongsterrTracks,
  fetchSongsterrPart,
  /** Deprecated alias of `fetchSongsterrPart`; the fetch was never drum-only. */
  fetchSongsterrDrums,
  type MetaTrack,
  type SongMeta,
  type DrumTrackChoice,
  type TrackChoice,
  type SearchHit,
  type SongsterrTrackList,
  type SongsterrFetched,
} from './songsterrFetch.js';

export {
  decomposeToPatterns,
  arrangementSummary,
  patternLabel,
  planProjects,
  type ProjectPlan,
  type ProjectPlanEntry,
  coalescePatterns,
  gridDistance,
  layerDistance,
  planArrangement,
  type DecomposeOptions,
  type DecomposeLayer,
  type SongDecomposition,
  type SongWindow,
  type CoalesceOptions,
  type CoalescedSong,
  type PatternCluster,
  type ArrangementScene,
  type ArrangementPlan,
} from './songStructure.js';

export {
  PATTERN_RECIPES,
  resolvePatternRecipe,
  listPatternRecipeIds,
} from './library.js';

export { compileToPlan, type CompileOptions } from './compile.js';

export {
  resolveVoiceTarget,
  resolvePatternVoices,
  resolvePatternVoicesDetailed,
  type VoiceResolution,
} from './voiceMap.js';

export {
  ROLE_FOLDS,
  foldVoice,
  indexMapByRole,
  describeFold,
  type FoldDecision,
} from './drumFold.js';

export {
  condenseToKit,
  describeCondense,
  DEFAULT_CONDENSE_KIT,
  type CondenseResult,
  type CondenseRouting,
  type CondenseCollision,
} from './drumCondense.js';

export {
  pieceCompression,
  type PieceEntry,
  type PieceCompressionReport,
} from './pieceCompression.js';

export {
  planSongChop,
  toChopPart,
  packPatternsOnBarLines,
  PATTERN_SLOTS_PER_TRACK,
  STEPS_PER_PATTERN,
  MAX_PROJECT_STEPS,
  type ChopPartFlat,
  type ChopProject,
  type ChopProjectPart,
  type ChopPatternWindow,
  type ChopSection,
  type ChopOptions,
  type SongChopPlan,
} from './songChop.js';

export {
  planSongProjects,
  formatSongProjectPlan,
  buildPartWindow,
  buildWindows,
  classify,
  barRow,
  sigOf,
  rawDrumHits,
  GM_TOMS,
  type SongProjectPlan,
  type SongProject,
  type ProjectRelation,
  type FillWorkItem,
  type FillEvent,
  type PlanOptions,
  type RawHit,
  type BarToken,
  type PartWindow,
  type Window,
  type Verdict,
  type Pair,
} from './songPlanner.js';

// Authoring engine (BK-AUTHORING-ENGINE + BK-SONG-AUTHOR-2): contract, engine, relations, seeder,
// content-merge, variants.
export * from './songAuthorTypes.js';
export { buildProjectOps, resolveVariants, SongAuthorError } from './songAuthor.js';
export { computePartRelations, findRelation } from './songPartRelations.js';
export { seedAuthoringFromPlan } from './songAuthorSeed.js';
export { mergeContent, DEFAULT_ROUTING, MergeError } from './songAuthorMerge.js';
export {
  buildSectionsFromSpec,
  formatSectionReport,
  buildStompMap,
  formatStompMap,
  SectionSpecError,
  type StompMap,
  type SectionSpecRow,
  type MelodicRoute,
  type RouteImportOptions,
  type DrumImportOptions,
  type SongRouting,
  type SectionSpecOptions,
  type SectionBuildReport,
} from './songSectionSpec.js';
export {
  reduceToMonoVoice,
  renderGlideGestures,
  roundBendSemitones,
  describeGlideGestures,
  type GlideGestureOptions,
  type GlideGestureReport,
} from './pitchGestures.js';

export {
  selectRealizer,
  runSharedRealizer,
  realizeLiveStream,
  realizeRecordCapture,
  realizeNcsUpload,
} from './realizers/index.js';
