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
  selectRealizer,
  runSharedRealizer,
  realizeLiveStream,
  realizeRecordCapture,
  realizeNcsUpload,
} from './realizers/index.js';
