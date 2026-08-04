/**
 * Pattern-orchestrator executors: `apply_pattern` + `list_pattern_recipes`.
 *
 * Lifecycle mirrors the other executors: requireDevice → capability gate
 * (selectRealizer against `pattern_realizers`) → compile the neutral
 * pattern through the target's voice_map → openCtx → realize (the device's
 * own `writer.realizePattern` if it has one, else the shared realizer).
 */

import { readFileSync } from 'node:fs';

import { DispatchError, type RealizePlan, type RealizerMode, type StoredMixerLevels, type VoiceTarget } from '../types.js';
import { buildExternalOverrides, type ExternalTarget, type ExternalVoiceResolution } from './externalRouting.js';
import { buildCondensedDrums, type CondensedDrums } from './condenseDrums.js';
import {
  PATTERN_RECIPES,
  PatternError,
  applyRoundRobin,
  canonicalRole,
  compileToPlan,
  importMidiDrums,
  resolveDrumMapPreset,
  listPatternRecipeIds,
  parseDrumTab,
  parseMiniNotation,
  parseVoice,
  pieceCompression,
  importMidiMelodic,
  midiChannelSummary,
  resolvePatternRecipe,
  resolvePatternVoicesDetailed,
  resolveTranspose,
  runSharedRealizer,
  selectRealizer,
  type NeutralPattern,
  type PieceEntry,
  type RoundRobinSpec,
  type Step,
} from '../patterns/index.js';
import { openCtx, openOfflineCtx, requireDevice, toWirePack } from './core.js';
import { backupProjectSlot } from './backup.js';

/** Hard cap on a single blocking realize, mirroring send_sequence's 30 s budget. */
const MAX_REALIZE_MS = 30_000;

export interface ApplyPatternArgs {
  port: string;
  /** Named library recipe id (mutually exclusive with voices / notation). */
  recipe?: string;
  /** Inline per-voice map: voice name → char-grid ("x...x...") or mini-notation line. */
  voices?: Record<string, string>;
  /** Inline comma-stack mini-notation ("bd*4, hh*8, ~ sd ~ sd"). Requires `steps`. */
  notation?: string;
  /** ASCII drum tab ("HH|x-x-x-x-|" / "BD o---o---"), multi-bar + multi-system. Maps drum labels to voices. */
  tab?: string;
  /** Path to a Standard MIDI File (.mid); its drum track (channel 10, GM notes) is imported. */
  midi_file?: string;
  /** midi_file only: 1-based bar to start from (assumes 4/4). Default 1. */
  midi_from_bar?: number;
  /** midi_file only: number of bars to import (assumes 4/4). Default 2 (= 32 steps, the Circuit max). */
  midi_bars?: number;
  /** midi_file only: 1-based MIDI channel holding the drums. Default 10 (GM); drum-library groove packs often sequence on another (Mixwave Sleep Token II uses 16). */
  midi_channel?: number;
  /**
   * midi_file only: percussion remap for non-GM key maps — note number (string
   * key) → voice name ("clap") or GM number (39), OR a named preset string
   * (e.g. "mixwave-st2-grooves"). Unmapped numbers are named in warnings.
   */
  drum_map?: string | Record<string, string | number>;
  /**
   * midi_file only: ALSO import melodic channels as pitched voices — a map of
   * voice name ("bass"/"chord"/"lead"/"synth1"/…) → 1-based MIDI channel. The
   * drum track (ch10) still imports as usual; the warnings list the file's
   * channel inventory so the right channel is pickable conversationally.
   */
  midi_tracks?: Record<string, number>;
  /** Grid resolution for inline forms (required for notation / mini-notation voices). */
  steps?: number;
  /**
   * Tempo for the realized pattern. OPTIONAL, and deliberately so: `ncs_upload`
   * needs to tell "the caller stated a tempo" apart from "nobody said", because
   * a stated tempo is what the stored project should carry and a defaulted 120
   * is not evidence of anything. Undefined here means unstated; the timing math
   * falls back to `DEFAULT_BPM`.
   */
  bpm?: number;
  mode?: RealizerMode;
  repeat?: number;
  /** record_capture two-phase: pass true once Record is armed on the device. */
  armed?: boolean;
  /** ncs_upload only: path to an existing .ncs project to template-modify. */
  ncs_template?: string;
  /** ncs_upload only: target project slot 0..63 on the device. */
  ncs_slot?: number;
  /**
   * ncs_upload only: the tempo to STORE in the project, 40..240 BPM. Overrides
   * `bpm` for the stored value, for the case where the audition tempo and the
   * song's real tempo differ on purpose.
   */
  ncs_tempo?: number;
  /**
   * ncs_upload only: the PAD COLOUR to store in the project — a palette index
   * or a palette name, resolved (and refused) by the target device, whose
   * palette it is. Absent leaves the template's, which is what authoring always
   * did, so an existing call is unchanged byte-for-byte.
   */
  colour?: number | string;
  /**
   * US-spelled alias for `colour`, accepted so the American spelling is not
   * silently dropped. An unknown key vanishes at the schema boundary with no
   * error, so a caller that writes `color` would get a project stamped with the
   * template's colour and a receipt truthfully saying none was set: the exact
   * silent-no-op shape this codebase keeps paying for. Resolved via
   * `resolveColourArg`; passing BOTH spellings with different values refuses.
   */
  color?: number | string;
  /**
   * ncs_upload only: the PROJECT NAME to store in the file, the fixed
   * 32-character space-padded ASCII field the device's pack directory and
   * Components show. Same contract as `colour`: absent leaves the template's
   * name byte-identical (the backward-compat contract) and the receipt says so;
   * over-long or non-ASCII REFUSES rather than truncating. No alias: unlike
   * colour there is no spelling variant, the argument is exactly this key.
   */
  project_name?: string;
  /**
   * ncs_upload only: STORED per-track mixer levels (raw 0..127), partial by
   * design: named tracks are written; an unnamed SYNTH stores level 0 (the
   * stored-silent default, maintainer's 2026-07-29 instruction) while an
   * unnamed DRUM keeps the template's byte, and the receipt lists all sides.
   * Range-checked here, before any compile or port, so a bad fader number
   * costs nothing.
   */
  mixer_levels?: StoredMixerLevels;
  /**
   * ncs_upload only: which microSD pack to write, 1-BASED as the device numbers
   * it (`pack: 5` = the front panel's "Pack 5"). Default 1. Converted to the
   * 0-based wire index once, at `openCtx`, and carried on the ctx from there —
   * see `DispatchCtx.pack` for why it must not travel as a per-call argument.
   */
  pack?: number;
  /** Semitone shift applied to authored pitches (the C-based recipes → any key). Takes precedence over `key`. */
  transpose?: number;
  /** Target key root (C, G, Eb, F#…). Sugar for `transpose` = the root's semitone offset from C (0..11). */
  key?: string;
  /** ncs_upload only: musical scale the device constrains the pattern to (e.g. "C minor", "dorian"). Default Chromatic = literal pitches. */
  scale?: string;
  /** Spread a voice's hits across >=2 drum tracks so they overlap instead of choking (e.g. {"hat":["drum3","drum4"]}). */
  round_robin?: RoundRobinSpec;
  /** ncs_upload only: per-step sample flips — {"drum1": {"9": 2}} flips Drum1 step 9 to sample slot 2 (multiple pieces on one track). */
  drum_flips?: Record<string, Record<string, number>>;
  /**
   * ncs_upload only: point each of the 4 drum tracks (Drum1..Drum4, in order)
   * at a specific kit sample slot 0..63, overriding the default canonical
   * stoken layout (kick/snare/closed_hat/ride on slots 0..3) that authoring
   * otherwise writes. Project-global: one binding per project, so it applies
   * whether authoring a single pattern or a multi-section `arrangement`. See
   * docs/design/circuit-drum-binding.md.
   */
  drum_binding?: number[];
  /**
   * ncs_upload only: ALSO lay the drum part down, condensed, on the host's own
   * internal drum tracks at stored level 0. For the case where the real kit
   * plays an external multi-pad sampler through `external_targets` and the
   * host's four drum tracks would otherwise sit empty: the same groove is
   * squeezed onto them (per-step contention resolved, folded pieces kept
   * distinct by per-step sample flips) and stored SILENT, so the player can dial
   * it in from the mixer without re-authoring anything. Needs a device that
   * declares `drum_track_roles`.
   */
  condense_drums?: boolean;
  /**
   * ncs_upload only: keep the note LENGTHS and TIE-FORWARD flags the template
   * project already holds instead of resetting re-authored notes to a one-step
   * gate. Default TRUE. Those lengths were dialled in by hand at the device
   * (authoring could not write them until this epic), so flattening them is
   * destruction of real work and has to be asked for, never assumed.
   */
  preserve_template_gates?: boolean;
  /** ncs_upload only: overwrite gate — true to write an occupied project slot (see SAFE-EDIT-WORKFLOW.md). */
  confirm_overwrite?: boolean;
  /** ncs_upload only: backup-before-overwrite. Default true — save the slot's current project before clobbering it. */
  backup_first?: boolean;
  /**
   * Pre-flight: build, resolve, compile, and (ncs_upload) author + fit-check —
   * but send NOTHING to the device. Returns the full receipt (piece
   * compression, folds, layout, warnings) so the user can be consulted before
   * a persisting write. No reads, no gate, no backup, no transfer.
   */
  dry_run?: boolean;
  /**
   * ncs_upload only: route some/all voices to an EXTERNAL device sequenced via
   * one of the host's outward MIDI tracks (Circuit Tracks MIDI 1 / MIDI 2 → e.g.
   * a Roland SPD-SX). Each entry names the external `device` (its port id/name),
   * optionally the host `track` (defaults from the rig links: the rig manifest
   * when configured, else MCP_RIG_LINKS), and
   * optionally the `voices` to route (defaults to every pattern voice the external
   * device can place). Those voices author onto the host MIDI track using the
   * EXTERNAL device's note map; voices not listed still play the host's internal
   * sounds. The external device must be set to receive on the track's channel.
   */
  external_targets?: ExternalTarget[];
  /**
   * ncs_upload only: a multi-SECTION song arrangement (mutually exclusive with
   * the single-pattern sources). Sections play in listed order, each `repeat`
   * times, and the whole song loops. The device writer packs them into pattern
   * slots + a pattern chain (or scene-chain) and errors honestly when the song
   * exceeds the hardware (Circuit: 8 pattern slots / 4 scene steps).
   */
  arrangement?: {
    sections: ArrangementSectionArgs[];
    /**
     * Play order as section NAMES (revisits allowed: ["Verse","Chorus","Verse"]).
     * Default = the sections in listed order, each `repeat` times. When given,
     * per-section `repeat` is ignored.
     */
    order?: string[];
    /**
     * EXPLICIT scene grouping: each inner list is one scene's sections, by
     * NAME, in play order. [["Fill"],["A","B","C"],["D","E"],["F","G"]] is a
     * 1+3+2+2 split the automatic layout cannot express (it greedily merges
     * consecutive sections into the fewest scenes). The plan IS the play order
     * (scenes play 1..N then loop), so it is mutually exclusive with `order`.
     * A section may recur across scenes (a repeated ostinato costs no extra
     * pattern slots) but only once per scene; every section must be placed in
     * at least one scene; a scene's members must be adjacent in `sections`
     * (a scene stores one contiguous pattern range). Unknown names, double
     * placement within a scene, unplaced sections, and plans needing more
     * scenes than the device-confirmed range all REFUSE with the fault named.
     */
    scene_plan?: string[][];
  };
}

/** One named section of an `arrangement` (same inline grammars as the single-pattern sources). */
export interface ArrangementSectionArgs {
  /** Section name ("Intro", "Verse", "Chorus") — carried into the receipt. */
  name: string;
  /** Named library recipe id. */
  recipe?: string;
  /** Per-voice char-grid / mini-notation map (the agent-authored form). */
  voices?: Record<string, string>;
  /** Comma-stack mini-notation. Requires `steps`. */
  notation?: string;
  /** ASCII drum tab. */
  tab?: string;
  /** Grid resolution for inline forms. */
  steps?: number;
  /** Consecutive plays of this section (default 1). */
  repeat?: number;
}

export type { ExternalTarget } from './externalRouting.js';
export { buildExternalOverrides } from './externalRouting.js';


function buildPattern(args: ApplyPatternArgs): { pattern: NeutralPattern; warnings: string[] } {
  const sources = [args.recipe, args.voices, args.notation, args.tab, args.midi_file].filter((s) => s !== undefined);
  if (sources.length === 0) {
    throw new PatternError('parse_error', 'Provide one of: recipe, voices, notation, tab, or midi_file.');
  }
  if (sources.length > 1) {
    throw new PatternError('parse_error', 'Provide only one of recipe / voices / notation / tab / midi_file, not several.');
  }

  // Standard MIDI File: import the drum track (channel 10) → quantized step grid.
  if (args.midi_file !== undefined) {
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(readFileSync(args.midi_file)); } catch (e) {
      throw new PatternError('parse_error', `Could not read MIDI file '${args.midi_file}': ${e instanceof Error ? e.message : String(e)}`);
    }
    const BEATS_PER_BAR = 4; // 4/4 assumed (MVP)
    const bars = args.midi_bars ?? 2; // 2 bars × 16ths = 32 steps = the Circuit max
    const fromBeat = ((args.midi_from_bar ?? 1) - 1) * BEATS_PER_BAR;
    const drumMap = args.drum_map === undefined
      ? undefined
      : typeof args.drum_map === 'string'
        ? resolveDrumMapPreset(args.drum_map)
        : Object.fromEntries(Object.entries(args.drum_map).map(([k, v]) => [Number(k), v]));
    let imp;
    try {
      imp = importMidiDrums(bytes, {
        fromBeat, beats: bars * BEATS_PER_BAR, stepsPerBeat: 4,
        ...(args.midi_channel !== undefined ? { channel: args.midi_channel } : {}),
        ...(drumMap !== undefined ? { drumMap } : {}),
      });
    } catch (e) {
      throw new PatternError('parse_error', `'${args.midi_file}' is not a usable Standard MIDI File: ${e instanceof Error ? e.message : String(e)}`);
    }
    const voices: Record<string, { steps: Step[] }> = {};
    for (const [name, steps] of Object.entries(imp.voices)) voices[name] = { steps };
    const warnings = [...imp.warnings];

    // Melodic channels: import each requested channel as a PITCHED voice row
    // (the notes carry through Step.notes and route via the target voice_map —
    // bass/chord/lead on the Circuit's synth tracks, or any melodic device).
    if (args.midi_tracks && Object.keys(args.midi_tracks).length > 0) {
      const gridSteps = imp.steps;
      for (const [voiceName, channel] of Object.entries(args.midi_tracks)) {
        let mel;
        try {
          mel = importMidiMelodic(bytes, { channel, fromBeat, beats: bars * BEATS_PER_BAR, stepsPerBeat: 4 });
        } catch (e) {
          throw new PatternError('parse_error', `midi_tracks.${voiceName}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (mel.step_count !== gridSteps) {
          // Same window/grid math, so lengths agree; guard anyway (honest, not silent).
          throw new PatternError('bad_grid', `midi_tracks.${voiceName}: imported ${mel.step_count} steps, drum grid is ${gridSteps}.`);
        }
        voices[voiceName] = { steps: mel.steps };
        warnings.push(...mel.warnings.map((w) => `${voiceName} (ch${channel}): ${w}`));
      }
    }

    if (Object.keys(voices).length === 0) {
      const inventory = midiChannelSummary(bytes)
        .map((c) => `ch${c.channel}${c.drum ? ' (drums)' : ''}: ${c.notes} notes ${c.low}-${c.high}${c.poly >= 3 ? ' (chords)' : ''}`)
        .join('; ');
      throw new PatternError(
        'parse_error',
        `No drum (channel 10) notes found in '${args.midi_file}'${args.midi_from_bar ? ` at bar ${args.midi_from_bar}` : ''} ` +
        `(it has ${imp.total_beats} beats of drums total) and no midi_tracks were requested. ` +
        (inventory ? `Channels in this file: ${inventory}. Import a melodic channel with midi_tracks (e.g. {"bass": N}).`
          : 'The file appears to contain no notes.'),
      );
    }
    warnings.push(
      `Imported from MIDI: ${bars} bar(s) from bar ${args.midi_from_bar ?? 1} → ${imp.steps} steps ` +
      `(4/4 assumed; the file has ${imp.total_beats} beats of drums). Voices: ${Object.keys(voices).join(', ')}. ` +
      `File channels: ${midiChannelSummary(bytes).map((c) => `ch${c.channel}${c.drum ? '(drums)' : ''}=${c.notes}n ${c.low}-${c.high}${c.poly >= 3 ? '(chords)' : ''}`).join(', ')}.`,
    );
    return { pattern: { name: 'midi-drums', steps: imp.steps, bars: 1, voices }, warnings };
  }

  return buildInlinePattern(args, 'inline');
}

/**
 * Build one pattern from the INLINE grammars (recipe / tab / notation / voices).
 * Shared by the single-pattern path and each `arrangement` section.
 */
function buildInlinePattern(
  src: { recipe?: string; voices?: Record<string, string>; notation?: string; tab?: string; steps?: number },
  defaultName: string,
): { pattern: NeutralPattern; warnings: string[] } {
  if (src.recipe !== undefined) {
    const recipe = resolvePatternRecipe(src.recipe);
    if (!recipe) {
      throw new PatternError(
        'unknown_pattern',
        `Unknown pattern recipe '${src.recipe}'. Known: ${listPatternRecipeIds().join(', ')}.`,
        { known: listPatternRecipeIds() },
      );
    }
    return { pattern: recipe, warnings: [] };
  }

  // ASCII drum tab: parse drum labels → voices, columns → steps, systems → bars.
  if (src.tab !== undefined) {
    const parsed = parseDrumTab(src.tab);
    const voices: Record<string, { steps: Step[] }> = {};
    for (const [name, steps] of Object.entries(parsed.voices)) voices[name] = { steps };
    return { pattern: { name: defaultName === 'inline' ? 'drum-tab' : defaultName, steps: parsed.steps, bars: 1, voices }, warnings: parsed.warnings };
  }

  if (src.notation !== undefined) {
    if (src.steps === undefined) {
      throw new PatternError('bad_grid', 'Inline notation requires `steps`.');
    }
    const parsed = parseMiniNotation(src.notation, src.steps);
    const voices: Record<string, { steps: Step[] }> = {};
    for (const [name, steps] of Object.entries(parsed)) voices[name] = { steps };
    return { pattern: { name: defaultName, steps: src.steps, bars: 1, voices }, warnings: [] };
  }

  // Inline voices map. Char grids define their own length; if `steps` is
  // omitted, infer from the first voice and require the rest to match.
  const entries = Object.entries(src.voices ?? {});
  if (entries.length === 0) {
    throw new PatternError('parse_error', '`voices` must have at least one voice.');
  }
  const first = parseVoice(entries[0][1], src.steps);
  const steps = src.steps ?? first.length;
  const voices: Record<string, { steps: Step[] }> = {};
  for (const [name, srcLine] of entries) {
    const parsed = parseVoice(srcLine, steps);
    if (parsed.length !== steps) {
      throw new PatternError('bad_grid', `Voice '${name}' has ${parsed.length} steps, expected ${steps}.`);
    }
    voices[name] = { steps: parsed };
  }
  return { pattern: { name: defaultName, steps, bars: 1, voices }, warnings: [] };
}

/**
 * Piece-compression report lines for a pattern against a target: DRUM voices
 * only (melodic voices never fold), with hit counts, covering both the host's
 * voice_map and externally-routed destinations. Empty when the mapping is
 * clean (no folds, no merges) — silence, not ceremony. `hitsByVoice` lets the
 * arrangement path pass hit counts summed across sections.
 */
function compressionLines(
  pattern: NeutralPattern,
  caps: Parameters<typeof resolvePatternVoicesDetailed>[1],
  extResolutions?: Record<string, ExternalVoiceResolution>,
  hitsByVoice?: Record<string, number>,
): string[] {
  const overridden = new Set(Object.keys(extResolutions ?? {}));
  const hits = (v: string): number =>
    hitsByVoice?.[v] ?? pattern.voices[v].steps.filter((s) => s.on).length;
  const entries: PieceEntry[] = [];
  const hostVoices = Object.fromEntries(Object.entries(pattern.voices).filter(([v]) => !overridden.has(v)));
  if (Object.keys(hostVoices).length > 0) {
    const detail = resolvePatternVoicesDetailed({ ...pattern, voices: hostVoices }, caps);
    const foldBy = new Map(detail.folds.map((f) => [f.voice, f]));
    for (const v of Object.keys(hostVoices)) {
      if (canonicalRole(v) === undefined) continue; // melodic voices never compress
      const f = foldBy.get(v);
      entries.push({
        voice: v, hits: hits(v), target: detail.map_keys[v],
        ...(f && f.folded_to !== f.role ? { substituted_as: f.folded_to } : {}),
      });
    }
  }
  for (const [v, r] of Object.entries(extResolutions ?? {})) {
    if (!(v in pattern.voices) || canonicalRole(v) === undefined) continue;
    entries.push({
      voice: v, hits: hits(v), target: `${r.map_key} (${r.device})`,
      // Merge detection by PHYSICAL pad (device + final note): a pinned voice
      // and a mapped voice sharing one pad merge even under different labels.
      merge_key: `${r.device}#${r.note}`,
      ...(r.fold && r.fold.folded_to !== r.fold.role ? { substituted_as: r.fold.folded_to } : {}),
    });
  }
  return pieceCompression(entries).lines;
}

/**
 * Argument combinations `condense_drums` cannot serve honestly. Each one is a
 * contradiction rather than a limitation, so it refuses instead of silently
 * picking a winner:
 *
 *  - a live mode has no drum tracks to store anything on;
 *  - `also_internal` asks for the RAW voices on the host's drum tracks while
 *    condensation asks for the squeezed copy on those same tracks.
 *
 * `drum_binding` is deliberately NOT here any more: the two arguments COMPOSE
 * (bind first, condense onto the bound layout). The binding declares which
 * pool slot each track's own-role sample lives at; condensation lays the
 * groove onto those tracks; and the condenser's per-step sample flips resolve
 * against the BOUND slots rather than the canonical stoken layout (the device
 * layer owns that join: `slotForFlipRole` in the Circuit's drumBinding.ts).
 * A flip to a piece OUTSIDE the four bound roles cannot be located in a
 * custom pool, so it is skipped with a per-step warning instead of guessed.
 * The real repertoire needs the pair: After Dark's working build carries
 * binding [1,2,5,11] AND condensed internal drums.
 */
function assertCondensable(args: ApplyPatternArgs, mode: RealizerMode): void {
  if (mode !== 'ncs_upload') {
    throw new PatternError(
      'realizer_not_supported',
      `condense_drums stores a condensed kit in an authored project, so it needs mode 'ncs_upload' (got '${mode}').`,
    );
  }
  if (args.external_targets?.some((t) => t.also_internal === true)) {
    throw new PatternError(
      'parse_error',
      'condense_drums and external_targets.also_internal both claim the host\'s internal drum tracks (the raw voices vs the condensed kit). Pick one: also_internal for an un-condensed doubling, condense_drums for the squeezed silent copy.',
    );
  }
}

/** Timing fallback when no tempo was stated. Only the live/record math uses it. */
const DEFAULT_BPM = 120;
/** The device's own tempo range (Circuit Tracks user guide). Refused outside, never clamped. */
const STORED_TEMPO_MIN = 40;
const STORED_TEMPO_MAX = 240;

/**
 * The tempo an `ncs_upload` should STORE in the project, or undefined to leave
 * the template's.
 *
 * The rule, and why. A stored project carries its own tempo and the device
 * adopts it on load, so a project authored without one does not play "at no
 * tempo" — it plays at whatever the TEMPLATE held. Authoring used to always take
 * that branch, which is how a whole pack of 140-bpm song parts ended up stored
 * at the blank template's 120 with nothing anywhere to say so.
 *
 * So: an explicit `ncs_tempo` wins; failing that, a `bpm` the caller actually
 * STATED is used, because if you are storing this pattern then the pattern's
 * tempo is the project's tempo and there is no coherent reading where they
 * differ by accident. If NEITHER was given we write nothing and the realizer
 * says out loud what the template's value was, because inventing 120 over a
 * hand-set tempo is as wrong as inheriting one.
 *
 * Out of range REFUSES rather than clamping: silently storing 240 for a
 * 320-bpm pattern is the same silent-wrong-tempo bug wearing a different hat.
 */
function resolveStoredTempo(args: ApplyPatternArgs): number | undefined {
  const stated = args.ncs_tempo ?? args.bpm;
  if (stated === undefined) return undefined;
  const rounded = Math.round(stated);
  if (rounded < STORED_TEMPO_MIN || rounded > STORED_TEMPO_MAX) {
    const which = args.ncs_tempo !== undefined ? 'ncs_tempo' : 'bpm';
    throw new PatternError(
      'bad_grid',
      `A stored project's tempo must be ${STORED_TEMPO_MIN}..${STORED_TEMPO_MAX} BPM (the device's range), but ${which} is ${stated}. ` +
      `Nothing was written. Pass ncs_tempo with a tempo in range (e.g. half or double time) to store this pattern.`,
    );
  }
  return rounded;
}

/**
 * Accept either spelling of the colour argument. `colour` is canonical (it
 * matches the codec and the device's own docs), but an unknown key is stripped
 * SILENTLY at the schema boundary, so a caller writing `color` would author a
 * project carrying the template's colour while the receipt truthfully reported
 * that none was set. That is a silent no-op, the failure shape this codebase
 * has hit repeatedly (`backup_first`, `midi_channel`, `drum_map`).
 *
 * Both spellings with the SAME value is fine and passes through. Both with
 * DIFFERENT values refuses rather than picking one, because either choice
 * silently discards something the caller asked for.
 */
function resolveColourArg(args: ApplyPatternArgs): number | string | undefined {
  const { colour, color } = args;
  if (colour !== undefined && color !== undefined && colour !== color) {
    throw new PatternError(
      'bad_grid',
      `Both colour and color were passed with different values (${JSON.stringify(colour)} and ${JSON.stringify(color)}). ` +
      `Nothing was written. They are the same argument, so pass one: colour is canonical, color is accepted as an alias.`,
    );
  }
  return colour ?? color;
}

/** Track keys `mixer_levels` accepts, in receipt order. */
const MIXER_LEVEL_KEYS = ['synth1', 'synth2', 'drum1', 'drum2', 'drum3', 'drum4'] as const;

/**
 * Validate `mixer_levels` UP FRONT (before any compile, port, or template
 * read), or return undefined when the caller passed nothing. Out of range
 * REFUSES rather than clamping, in display shape: a fader silently stored at
 * the wrong loudness is the exact quiet damage the stored-level surface exists
 * to prevent. An empty object is refused too, it can only be a mistake, and
 * treating it as "set nothing" would be a silent no-op.
 */
function resolveMixerLevels(args: ApplyPatternArgs): StoredMixerLevels | undefined {
  const ml = args.mixer_levels;
  if (ml === undefined) return undefined;
  const named = MIXER_LEVEL_KEYS.filter((k) => ml[k] !== undefined);
  if (named.length === 0) {
    throw new PatternError(
      'bad_grid',
      'mixer_levels was passed but names no track. Name the tracks to set, e.g. {"synth1": 100, "drum1": 0} ' +
      `(keys: ${MIXER_LEVEL_KEYS.join(', ')}); an omitted synth stores level 0 (the stored-silent default), an omitted drum keeps the template's stored level.`,
    );
  }
  for (const k of named) {
    const v = ml[k]!;
    if (!Number.isInteger(v) || v < 0 || v > 127) {
      throw new PatternError(
        'bad_grid',
        `mixer_levels.${k} must be an integer 0..127 (the stored fader scale, the same numbers as the mixer CCs; ` +
        `100 is the factory default), got ${v}. Nothing was written.`,
      );
    }
  }
  return Object.fromEntries(named.map((k) => [k, ml[k]!]));
}

export interface ApplyPatternResult {
  device: string;
  pattern: string;
  bpm: number;
  steps: number;
  mode: RealizerMode;
  repeat: number;
  cycle_ms: number;
  ok: boolean;
  status: string;
  notes_sent?: number;
  source?: string;
  warning?: string;
  info?: string;
}

export async function executeApplyPattern(args: ApplyPatternArgs): Promise<ApplyPatternResult> {
  const descriptor = requireDevice(args.port);
  const caps = descriptor.capabilities;

  // Multi-section song arrangement: its own realize path (ncs_upload only).
  if (args.arrangement !== undefined) {
    const single = [args.recipe, args.voices, args.notation, args.tab, args.midi_file].filter((s) => s !== undefined);
    if (single.length > 0) {
      throw new PatternError('parse_error', '`arrangement` is mutually exclusive with the single-pattern sources (recipe / voices / notation / tab / midi_file). Put each section\'s content inside arrangement.sections.');
    }
    return executeApplyArrangement(args, descriptor);
  }

  // Timing tempo: the stated one, or the documented default when nobody said.
  // `args.bpm` stays the record of what the CALLER stated (see resolveStoredTempo).
  const bpm = args.bpm ?? DEFAULT_BPM;

  // Capability gate (throws PatternError if not a target / mode unsupported).
  const mode = selectRealizer(caps, args.mode);

  const built = buildPattern(args);
  // Round-robin: spread a voice's hits across multiple drum tracks so a fast
  // ringing sound overlaps instead of choking itself (the per-track monophony
  // workaround). Applied at the neutral-pattern layer so the targets route
  // through the normal voice_map.
  const rr = applyRoundRobin(built.pattern, args.round_robin);
  const pattern = rr.pattern;
  const extraWarnings = [...built.warnings, ...rr.warnings];
  // A Circuit pattern caps at 32 steps; events past 32 would collapse onto the
  // last step (silent data loss). Flag a too-long tab so the caller splits it.
  if (mode === 'ncs_upload' && pattern.steps > 32) {
    extraWarnings.push(
      `Pattern is ${pattern.steps} steps, but a Circuit pattern holds at most 32. Steps beyond 32 collapse onto the last step. ` +
      `Split the section into <=32-step parts (the Circuit chains patterns on-device).`,
    );
  }

  // ncs_upload authors a project file + pushes it; gather its bespoke inputs.
  let upload: NonNullable<RealizePlan['upload']> | undefined;
  if (mode === 'ncs_upload') {
    const storedTempo = resolveStoredTempo(args);
    const storedColour = resolveColourArg(args);
    const storedMixer = resolveMixerLevels(args);
    if (args.ncs_slot === undefined) {
      throw new PatternError('bad_grid', 'ncs_upload requires ncs_slot (the project to write, 1..64 as the device numbers it).');
    }
    if (!Number.isInteger(args.ncs_slot) || args.ncs_slot < 1 || args.ncs_slot > 64) {
      throw new PatternError('bad_grid', `ncs_slot must be 1..64, numbered exactly as the device shows it (Project 1..64), got ${args.ncs_slot}.`);
    }
    // DEVICE numbering in, WIRE numbering below: `upload.slot` stays 0-based so
    // the writer's transport calls and its "shown as Project slot+1" strings are
    // unchanged. Convert once, here.
    upload = {
      template_path: args.ncs_template, slot: args.ncs_slot - 1, scale: args.scale,
      drum_flips: args.drum_flips, drum_binding: args.drum_binding,
      preserve_template_gates: args.preserve_template_gates,
      confirm_overwrite: args.confirm_overwrite, dry_run: args.dry_run,
      ...(storedTempo !== undefined ? { tempo: storedTempo } : {}),
      ...(storedColour !== undefined ? { colour: storedColour } : {}),
      ...(args.project_name !== undefined ? { project_name: args.project_name } : {}),
      ...(storedMixer !== undefined ? { mixer_levels: storedMixer } : {}),
    };
  }

  // External-instrument routing (ncs_upload only): some/all voices resolve against
  // an EXTERNAL device's note map and author onto a host MIDI track (Circuit MIDI
  // 1/2 → SPD-SX). Each routed voice gets a destination LIST — external-only =
  // [external], also_internal = [internal, external] — and compile emits the step
  // once per destination, so no pattern cloning is needed. Built before compile.
  let overrides: Record<string, readonly VoiceTarget[]> | undefined;
  let extResolutions: Record<string, ExternalVoiceResolution> | undefined;
  if (args.external_targets && args.external_targets.length > 0) {
    if (mode !== 'ncs_upload') {
      throw new PatternError(
        'realizer_not_supported',
        `external_targets routes voices onto the host's authored MIDI tracks, so it needs mode 'ncs_upload' (got '${mode}'). ` +
        'To play an external device live, target that device directly with live_stream.',
      );
    }
    const built2 = buildExternalOverrides(args.external_targets, caps, Object.keys(pattern.voices));
    overrides = built2.overrides;
    extResolutions = built2.resolutions;
    extraWarnings.push(...built2.hints);
  }

  // Condensed internal drums: the host's own drum tracks carry a squeezed,
  // level-0 copy of the kit. Built AFTER external routing so a routed voice
  // keeps its external destinations and loses only its internal one, and
  // compiled from an AUGMENTED pattern (synthetic per-track voices) so the
  // caller's pattern stays intact for the compression report. See condenseDrums.ts.
  let compilePattern = pattern;
  if (args.condense_drums === true) {
    assertCondensable(args, mode);
    const cd = buildCondensedDrums(pattern, caps, overrides);
    if (cd === undefined) {
      extraWarnings.push('condense_drums: this pattern has no drum voices, so the internal drum tracks were left alone.');
    } else {
      compilePattern = { ...pattern, voices: { ...pattern.voices, ...cd.voices } };
      overrides = { ...(overrides ?? {}), ...cd.overrides };
      upload!.drum_flip_roles = cd.flip_roles;
      upload!.drum_levels = cd.levels;
      extraWarnings.push(...cd.hints);
    }
  }

  // Piece-compression report: folds with hit counts + merged pieces, across
  // the host voice_map AND external destinations. Empty when the mapping is
  // clean — a real report is never buried in ceremony.
  extraWarnings.push(...compressionLines(pattern, caps, extResolutions));

  // Resolve the effective transpose (explicit `transpose` wins; else derive from
  // `key`; else 0). The recipes are authored in C, so this is how "play it in G
  // minor" lands. Shared helper so the precedence is golden-locked.
  const transpose = resolveTranspose(args.transpose, args.key);

  // Clamp repeat so one blocking realize stays within the perf budget.
  let repeat = Math.max(1, Math.floor(args.repeat ?? 1));
  let clampNote: string | undefined;
  const plan0 = compileToPlan(compilePattern, caps, { bpm, mode, repeat: 1, armed: args.armed, upload, transpose, overrides });
  const maxRepeat = Math.max(1, Math.floor(MAX_REALIZE_MS / Math.max(1, plan0.cycle_ms)));
  if (repeat > maxRepeat) {
    clampNote = `repeat clamped ${repeat}→${maxRepeat} to stay within the ${MAX_REALIZE_MS / 1000}s realize budget.`;
    repeat = maxRepeat;
  }
  const plan = compileToPlan(compilePattern, caps, { bpm, mode, repeat, armed: args.armed, upload, transpose, overrides });

  // Dry run, live modes: the plan + report ARE the deliverable; nothing streams.
  // (ncs_upload dry runs continue into the writer, which authors + fit-checks
  // against the template and skips the transfer.)
  if (args.dry_run && mode !== 'ncs_upload') {
    return {
      device: descriptor.display_name,
      pattern: pattern.name,
      bpm,
      steps: pattern.steps,
      mode, repeat,
      cycle_ms: plan.cycle_ms,
      ok: true,
      status: 'dry_run',
      info: [
        `DRY RUN — nothing was sent. Would ${mode === 'live_stream' ? 'stream' : 'realize'} ${plan.events.length} note event(s), ${plan.cycle_ms} ms/cycle × ${repeat}.`,
        clampNote, ...extraWarnings,
      ].filter(Boolean).join(' ') || undefined,
    };
  }

  // A dry run reaches here only for ncs_upload (the live modes returned above):
  // the writer authors + fit-checks against the LOCAL template and stops before
  // any read, gate, or transfer, so it needs no port. Opening one would fail the
  // flag's own use case — planning with the rig unplugged.
  const wirePack = toWirePack(args.pack);
  const ctx = args.dry_run ? openOfflineCtx(descriptor, { pack: wirePack }) : openCtx(descriptor, { pack: wirePack });
  // Backup-before-overwrite (ncs_upload only, default on). ncs_upload authors a
  // project into the target slot; when confirm_overwrite authorizes clobbering
  // an occupied slot, the writer's gate skips its read, so save the slot's
  // current contents first (reversible overwrite). A read/CRC failure throws and
  // aborts before any byte is authored onto the device. A dry run touches
  // nothing, so it also reads nothing.
  let backupNote = '';
  if (mode === 'ncs_upload' && upload && args.backup_first !== false && args.confirm_overwrite && !args.dry_run) {
    const backup = await backupProjectSlot(descriptor, ctx, upload.slot + 1);   // DEVICE numbering
    backupNote = backup.note;
  }
  // ncs_upload uses the device's bespoke writer hook; live_stream / record_capture
  // run the shared device-agnostic realizers.
  const result = (mode === 'ncs_upload' && descriptor.writer.realizePattern)
    ? await descriptor.writer.realizePattern(ctx, plan)
    : await runSharedRealizer(ctx.conn, plan);

  return {
    device: descriptor.display_name,
    pattern: pattern.name,
    bpm,
    steps: pattern.steps,
    mode,
    repeat,
    cycle_ms: plan.cycle_ms,
    ok: result.ok,
    status: result.status,
    ...(result.notes_sent !== undefined ? { notes_sent: result.notes_sent } : {}),
    ...(result.source ? { source: result.source } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    info: [result.info, backupNote, clampNote, ...extraWarnings].filter(Boolean).join(' ') || undefined,
  };
}

/**
 * `apply_pattern arrangement` executor: build + compile each named section,
 * expand the play order (listed order × per-section repeat), and hand the
 * device writer the section plans — it owns the slot/chain/scene packing.
 * Conversational-first: sections are inline grammars the agent authors itself
 * (or fills from import_songsterr / any other source it consulted).
 */
async function executeApplyArrangement(
  args: ApplyPatternArgs,
  descriptor: ReturnType<typeof requireDevice>,
): Promise<ApplyPatternResult> {
  const caps = descriptor.capabilities;
  const bpm = args.bpm ?? DEFAULT_BPM;
  // Resolved up front so an out-of-range tempo (or fader level) refuses BEFORE
  // any section is compiled or any port opened, not after the work is done.
  const arrangementTempo = resolveStoredTempo(args);
  const arrangementMixer = resolveMixerLevels(args);
  const mode = selectRealizer(caps, args.mode ?? 'ncs_upload');
  if (mode !== 'ncs_upload') {
    throw new PatternError(
      'realizer_not_supported',
      `arrangement authors a multi-pattern project file, so it needs mode 'ncs_upload' (got '${mode}'). ` +
      'To audition one section live, apply it as a single pattern with live_stream first.',
    );
  }
  if (!descriptor.writer.realizeArrangement) {
    throw new PatternError(
      'realizer_not_supported',
      `${descriptor.display_name} cannot author multi-pattern arrangements (no arrangement realizer). ` +
      'Apply sections one at a time instead.',
    );
  }
  if (args.ncs_slot === undefined) {
    throw new PatternError('bad_grid', 'ncs_upload requires ncs_slot (the Project to write, 1..64, numbered as the device shows it).');
  }
  if (!Number.isInteger(args.ncs_slot) || args.ncs_slot < 1 || args.ncs_slot > 64) {
    throw new PatternError('bad_grid', `ncs_slot must be 1..64, numbered exactly as the device shows it (Project 1..64), got ${args.ncs_slot}.`);
  }
  // DEVICE numbering in, WIRE numbering below: the same single conversion the
  // single-pattern path makes. `upload.slot` is 0-based everywhere past this line.
  const slotWire = args.ncs_slot - 1;
  const sectionsIn = args.arrangement!.sections;
  if (!Array.isArray(sectionsIn) || sectionsIn.length === 0) {
    throw new PatternError('parse_error', 'arrangement.sections must list at least one section.');
  }
  if (args.drum_flips && Object.keys(args.drum_flips).length > 0) {
    throw new PatternError('parse_error', 'drum_flips is per-step within ONE pattern and is not supported with `arrangement` yet.');
  }
  const scenePlanIn = args.arrangement!.scene_plan;
  if (scenePlanIn !== undefined && args.arrangement!.order !== undefined) {
    throw new PatternError(
      'parse_error',
      'scene_plan and order are mutually exclusive: the scene plan IS the play order (scenes play 1..N in listed order, then loop). ' +
      'Keep scene_plan and drop order, or drop scene_plan for the automatic layout.',
    );
  }
  if (scenePlanIn !== undefined && (!Array.isArray(scenePlanIn) || scenePlanIn.length === 0)) {
    throw new PatternError('parse_error', 'arrangement.scene_plan must list at least one scene (a list of section names).');
  }

  // Build each section + expand the play order.
  const warnings: string[] = [];
  const built: { name: string; pattern: NeutralPattern }[] = [];
  const order: number[] = [];
  const unionVoices = new Set<string>();
  for (let i = 0; i < sectionsIn.length; i++) {
    const s = sectionsIn[i];
    if (!s.name || typeof s.name !== 'string') {
      throw new PatternError('parse_error', `arrangement section ${i + 1} needs a name ("Intro", "Verse", …).`);
    }
    const srcs = [s.recipe, s.voices, s.notation, s.tab].filter((x) => x !== undefined);
    if (srcs.length !== 1) {
      throw new PatternError('parse_error', `Section "${s.name}": provide exactly one of recipe / voices / notation / tab.`);
    }
    const one = buildInlinePattern(s, s.name);
    const rr = applyRoundRobin(one.pattern, args.round_robin);
    warnings.push(...one.warnings.map((w) => `${s.name}: ${w}`), ...rr.warnings.map((w) => `${s.name}: ${w}`));
    if (rr.pattern.steps > 32) {
      warnings.push(`${s.name}: ${rr.pattern.steps} steps, but a Circuit pattern holds at most 32 — steps beyond 32 collapse onto the last step. Split it into two sections.`);
    }
    built.push({ name: s.name, pattern: rr.pattern });
    for (const v of Object.keys(rr.pattern.voices)) unionVoices.add(v);
    if (args.arrangement!.order === undefined && scenePlanIn === undefined) {
      const rep = Math.max(1, Math.min(16, Math.floor(s.repeat ?? 1)));
      for (let r = 0; r < rep; r++) order.push(i);
    }
  }
  // Explicit play order by section name (revisits allowed: Verse→Chorus→Verse).
  if (args.arrangement!.order !== undefined) {
    if (sectionsIn.some((s) => s.repeat !== undefined)) {
      warnings.push('arrangement.order given — per-section repeat is ignored (encode repeats in the order list).');
    }
    const byName = new Map(built.map((b, i) => [b.name.toLowerCase(), i]));
    for (const name of args.arrangement!.order) {
      const idx = byName.get(String(name).toLowerCase());
      if (idx === undefined) {
        throw new PatternError('parse_error', `arrangement.order names unknown section "${name}". Sections: ${built.map((b) => b.name).join(', ')}.`);
      }
      order.push(idx);
    }
    if (order.length === 0) throw new PatternError('parse_error', 'arrangement.order must list at least one section.');
  }
  // Explicit scene grouping by section name. Resolve every name here (the
  // display-first boundary: the caller speaks section names, never indices),
  // refuse the name-level faults, and hand the writer index groups. The plan's
  // concatenation IS the play order. Layout-level checks (contiguity, the
  // confirmed-scene-count ceiling) stay in the device writer, which owns them.
  let scenePlan: number[][] | undefined;
  if (scenePlanIn !== undefined) {
    if (sectionsIn.some((s) => s.repeat !== undefined)) {
      warnings.push('arrangement.scene_plan given, so per-section repeat is ignored (repeat a section across scenes instead).');
    }
    const byName = new Map(built.map((b, i) => [b.name.toLowerCase(), i]));
    scenePlan = [];
    const placed = new Set<number>();
    for (let sc = 0; sc < scenePlanIn.length; sc++) {
      const members = scenePlanIn[sc];
      if (!Array.isArray(members) || members.length === 0) {
        throw new PatternError('parse_error', `arrangement.scene_plan scene ${sc + 1} is empty; every scene lists at least one section name.`);
      }
      const idxs: number[] = [];
      const seen = new Set<number>();
      for (const name of members) {
        const idx = byName.get(String(name).toLowerCase());
        if (idx === undefined) {
          throw new PatternError('parse_error', `arrangement.scene_plan scene ${sc + 1} names unknown section "${name}". Sections: ${built.map((b) => b.name).join(', ')}.`);
        }
        if (seen.has(idx)) {
          throw new PatternError(
            'parse_error',
            `arrangement.scene_plan scene ${sc + 1} lists "${built[idx].name}" twice; a scene plays each of its patterns once. ` +
            'To play it again, repeat it in ANOTHER scene (scenes are pointers, so that costs no pattern slot).',
          );
        }
        seen.add(idx);
        placed.add(idx);
        idxs.push(idx);
      }
      scenePlan.push(idxs);
    }
    const unplaced = built.map((b, i) => i).filter((i) => !placed.has(i));
    if (unplaced.length > 0) {
      throw new PatternError(
        'parse_error',
        `arrangement.scene_plan leaves section(s) ${unplaced.map((i) => `"${built[i].name}"`).join(', ')} in no scene, so they would ` +
        'author into pattern slots but never play. Place every section in a scene, or remove the unused section(s) from sections.',
      );
    }
    for (const scene of scenePlan) for (const i of scene) order.push(i);
  }

  // External routing built once, validated against the UNION of section voices
  // (a voice routed externally applies wherever a section uses it).
  let overrides: Record<string, readonly VoiceTarget[]> | undefined;
  let extResolutions: Record<string, ExternalVoiceResolution> | undefined;
  if (args.external_targets && args.external_targets.length > 0) {
    const ext = buildExternalOverrides(args.external_targets, caps, [...unionVoices]);
    overrides = ext.overrides;
    extResolutions = ext.resolutions;
    warnings.push(...ext.hints);
  }

  // Compile each section (repeat=1: the ARRANGEMENT owns repetition).
  // Condensation is PER SECTION: each section's groove is squeezed onto the
  // internal drum tracks on its own, and its flips ride on its OWN plan's
  // `upload`, because `authorArrangementIntoProject` authors each section's plan
  // independently into its own pattern slot. The drum LEVELS are project-global,
  // so they travel on the arrangement-level upload instead.
  if (args.condense_drums === true) assertCondensable(args, mode);
  const transpose = resolveTranspose(args.transpose, args.key);
  const sections: { name: string; plan: ReturnType<typeof compileToPlan> }[] = [];
  let condensed: CondensedDrums | undefined;
  let condensedSections = 0;
  let condensedCollisions = 0;
  for (const b of built) {
    let secPattern = b.pattern;
    let secOverrides = overrides;
    let secUpload: NonNullable<RealizePlan['upload']> | undefined;
    if (args.condense_drums === true) {
      const cd = buildCondensedDrums(b.pattern, caps, overrides);
      if (cd !== undefined) {
        secPattern = { ...b.pattern, voices: { ...b.pattern.voices, ...cd.voices } };
        secOverrides = { ...(overrides ?? {}), ...cd.overrides };
        // The binding rides on each section's own upload too: the device layer
        // resolves this section's flip ROLES against the BOUND slots, so a
        // custom-bound pool never gets a canonical-layout flip guessed at it.
        secUpload = {
          slot: slotWire, drum_flip_roles: cd.flip_roles,
          ...(args.drum_binding !== undefined ? { drum_binding: args.drum_binding } : {}),
        };
        condensed = cd;
        condensedSections++;
        condensedCollisions += cd.collisions;
      }
    }
    sections.push({
      name: b.name,
      plan: compileToPlan(secPattern, caps, {
        bpm, mode, repeat: 1, transpose, overrides: secOverrides,
        ...(secUpload !== undefined ? { upload: secUpload } : {}),
      }),
    });
  }
  if (args.condense_drums === true) {
    warnings.push(
      condensed === undefined
        ? 'condense_drums: no section has drum voices, so the internal drum tracks were left alone.'
        : `Condensed the drum part onto the ${condensed.kit.length} internal drum tracks (${condensed.kit.join(' / ')}) in ` +
          `${condensedSections} of ${built.length} section(s), stored at level 0 so it lies silent under the routed kit and the ` +
          `player dials it up from the mixer.` +
          (condensedCollisions > 0
            ? ` ${condensedCollisions} step(s) across the song had two same-family pieces competing for one track; the louder hit kept the step.`
            : ''),
    );
  }

  // Piece-compression report over the WHOLE song: one synthetic union pattern
  // (resolution is per-voice, identical across sections) with hit counts
  // summed across every play of every section, so "ride (312 hits) → hat"
  // reflects the song, not one bar.
  {
    const hitsByVoice: Record<string, number> = {};
    for (const idx of order) {
      for (const [v, data] of Object.entries(built[idx].pattern.voices)) {
        hitsByVoice[v] = (hitsByVoice[v] ?? 0) + data.steps.filter((s) => s.on).length;
      }
    }
    const unionPattern: NeutralPattern = {
      name: 'arrangement', steps: 1,
      voices: Object.fromEntries([...unionVoices].map((v) => {
        for (const b of built) { const data = b.pattern.voices[v]; if (data) return [v, data]; }
        return [v, { steps: [] as Step[] }];
      })),
    };
    warnings.push(...compressionLines(unionPattern, caps, extResolutions, hitsByVoice));
  }

  const arrangementColour = resolveColourArg(args);
  const upload: NonNullable<RealizePlan['upload']> = {
    template_path: args.ncs_template, slot: slotWire, scale: args.scale,
    drum_binding: args.drum_binding, preserve_template_gates: args.preserve_template_gates,
    confirm_overwrite: args.confirm_overwrite, dry_run: args.dry_run,
    ...(condensed !== undefined ? { drum_levels: condensed.levels } : {}),
    ...(arrangementTempo !== undefined ? { tempo: arrangementTempo } : {}),
    ...(arrangementColour !== undefined ? { colour: arrangementColour } : {}),
    ...(args.project_name !== undefined ? { project_name: args.project_name } : {}),
    ...(arrangementMixer !== undefined ? { mixer_levels: arrangementMixer } : {}),
    ...(scenePlan !== undefined ? { scene_plan: scenePlan } : {}),
  };
  // Same contract as the single-pattern path: a dry run authors against the
  // local template only, so it opens no port.
  const wirePack = toWirePack(args.pack);
  const ctx = args.dry_run ? openOfflineCtx(descriptor, { pack: wirePack }) : openCtx(descriptor, { pack: wirePack });
  // Backup-before-overwrite: same contract as the single-pattern ncs_upload.
  // A dry run touches nothing, so it also reads nothing.
  let backupNote = '';
  if (args.backup_first !== false && args.confirm_overwrite && !args.dry_run) {
    const backup = await backupProjectSlot(descriptor, ctx, upload.slot + 1);   // DEVICE numbering
    backupNote = backup.note;
  }
  const result = await descriptor.writer.realizeArrangement(ctx, sections, order, upload);
  const totalCycle = order.reduce((ms, i) => ms + sections[i].plan.cycle_ms, 0);
  return {
    device: descriptor.display_name,
    pattern: `arrangement: ${built.map((b) => b.name).join(' → ')}`,
    bpm,
    steps: Math.max(...sections.map((s) => s.plan.steps)),
    mode,
    repeat: 1,
    cycle_ms: totalCycle,
    ok: result.ok,
    status: result.status,
    ...(result.notes_sent !== undefined ? { notes_sent: result.notes_sent } : {}),
    ...(result.source ? { source: result.source } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
    info: [result.info, backupNote, ...warnings].filter(Boolean).join(' ') || undefined,
  };
}

export interface ListPatternRecipesResult {
  recipes: {
    id: string;
    name: string;
    description?: string;
    steps: number;
    voices: string[];
    tags?: readonly string[];
  }[];
  /** When `port` is given: what the target supports, so the agent can pick a realizer + compatible recipes. */
  target?: {
    device: string;
    realizers: readonly RealizerMode[];
    voices_supported: string[];
  };
}

export function executeListPatternRecipes(args: { port?: string }): ListPatternRecipesResult {
  const recipes = Object.values(PATTERN_RECIPES).map((p) => ({
    id: p.name,
    name: p.name,
    description: p.description,
    steps: p.steps,
    voices: Object.keys(p.voices),
    tags: p.tags,
  }));

  if (!args.port) return { recipes };

  const descriptor = requireDevice(args.port);
  const caps = descriptor.capabilities;
  const realizers = caps.pattern_realizers ?? [];
  if (realizers.length === 0) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} is not a pattern target (no pattern_realizers). ` +
      `Pattern targets in this rig: Circuit Tracks, SPD-SX, and any voice device with a voice_map.`,
    );
  }
  return {
    recipes,
    target: {
      device: descriptor.display_name,
      realizers,
      voices_supported: Object.keys(caps.voice_map ?? {}),
    },
  };
}
