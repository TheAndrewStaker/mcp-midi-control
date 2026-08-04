/**
 * Circuit Tracks DeviceWriter.
 *
 * Scope (v1):
 *   - set_param / set_params, live CC + NRPN writes (Synth 1 / drums /
 *     project, channel per the registry). Non-destructive (RAM / live).
 *   - switch_preset, PROJECT select via Program Change on ch16 (the
 *     "switch the whole thing" semantic; instant recall, 0..63). Synth
 *     PATCH select per part uses send_program_change on ch1/ch2.
 *
 *   - save_preset, persist a synth part's current (RAM) sound to a Flash PATCH
 *     slot 0..63 (instance 1 = Synth 1, 2 = Synth 2). Reads the live body back
 *     via a Dump Request (codec/patchTransfer), then re-frames it as a "Replace
 *     Patch" write — the 340-byte body is an opaque container, so no structured
 *     decode is needed. Overwrite gate is refuse-by-default (Flash slots can't
 *     be previewed). COMMUNITY-BETA: the Flash write framing is spec-derived,
 *     hardware-confirmed 2026-07-03 (persists across a power-cycle).
 *
 * Deliberately omitted in v1 (documented follow-ons, NOT silent gaps):
 *   - apply_patch, set_params covers multi-param builds; a sparse-override
 *     apply is a thin follow-on over the same live codec.
 *   - offline patch authoring (needs the §13 record-array decode: mod matrix +
 *     macros, offsets 124-339). Structured get_param ships (see reader.ts).
 *   - set_block / set_bypass / switch_scene, no MIDI path on this device
 *     (scene/pattern selection is a confirmed dead-end); dispatcher returns
 *     capability_not_supported.
 *   - realizePattern, NOT needed: live_stream / record_capture run through
 *     the shared device-agnostic realizers using the descriptor's voice_map.
 *
 * Writes are fire-and-forget: the Circuit does not acknowledge CC/NRPN, so
 * `acked` means "sent", confirmed by ear / front panel (handoff §0).
 */

import type {
  BatchWriteResult,
  DeviceWriter,
  DispatchCtx,
  KitUploadItem,
  KitUploadOutcome,
  LocationRef,
  ProjectDeleteResult,
  ProjectUploadOutcome,
  SampleUploadOutcome,
  SlotWriteOptions,
  StoredMixerLevels,
  WriteOp,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { canonicalRole, rollVelocity } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

import { readFileSync } from 'node:fs';

import type { RealizePlan } from '@mcp-midi-control/core/protocol-generic/types.js';

import { CH_SYNTH1, CH_SYNTH2, CH_MIDI1, CH_MIDI2, CH_DRUMS, decodeParamWire, findParam, listParamNames, type CircuitParam } from '../params.js';
import { paramMessages, paramWire } from '../codec/live.js';
import { encodePatchName, NAME_LEN } from '../codec/blob.js';
import { readCurrentPatch, savePatch, instanceToSynthLoc } from '../codec/patchTransfer.js';
import { DISTINCT_COLOURS, META_OFFSETS, NCS_FILE_SIZE, NOTE_SLOTS_PER_STEP, PATTERNS_PER_TRACK, STEPS_PER_PATTERN, applyProjectColour, applyProjectName, checkNcsStructure, drumBlockIndex, getDrumLevel, getProjectTempo, ncsStructureNote, noteBlockIndex, projectColourName, setDrumLevel, setDrumLevels, setProjectTempo, setSynthLevel, type NoteTrack, type ProjectColourStamp, type ProjectNameStamp } from '../ncs/format.js';
import { setDrumPattern } from '../ncs/drumPattern.js';
import { setDrumSampleBinding, slotForFlipRole, DEFAULT_DRUM_BINDING, NUM_DRUM_TRACKS as DRUM_TRACK_COUNT } from '../ncs/drumBinding.js';
import {
  decodeNotePattern, setNotePattern, describeGate,
  DEFAULT_GATE, MAX_GATE_SIXTHS, MICROTICKS_PER_STEP, MIN_GATE_SIXTHS, type NoteSlot,
} from '../ncs/notePattern.js';
import { clearDrumChains, clearNoteChain, setDrumChain, setNoteChain } from '../ncs/chain.js';
import { setSceneChain, setSceneDrumChain, setSceneNoteChain } from '../ncs/sceneChain.js';
import {
  getProjectScale, setProjectScale, resolveScaleName, notesOutsideScale, describeScaleChange,
  SCALE_CHROMATIC, type ProjectScale,
} from '../ncs/scale.js';
import { uploadProject as uploadProjectTransport, probeProjectSlot } from '../ncs/uploadProject.js';
import { deleteSlots, FILE_TYPE } from '../ncs/fileDelete.js';
import { uploadSample as uploadSampleDriver, uploadSampleKit } from '../samples/uploadSample.js';

/** Circuit drum trigger notes (ch10) → drum track index (Drum1..4 = 0..3). */
const NOTE_TO_DRUM_TRACK: Readonly<Record<number, number>> = { 60: 0, 62: 1, 64: 2, 65: 3 };

/** Note-track channels → the .ncs note track they author (handoff §3). */
const CHANNEL_TO_NOTE_TRACK: Readonly<Record<number, NoteTrack>> = {
  [CH_SYNTH1]: 'synth1',
  [CH_SYNTH2]: 'synth2',
  [CH_MIDI1]: 'midi1',
  [CH_MIDI2]: 'midi2',
};

/** Result of authoring a compiled plan into a project buffer (for diagnostics). */
export interface AuthoredTracks {
  drum_tracks: number[];     // Drum1..4 indices (0..3) written
  note_tracks: NoteTrack[];  // synth1/synth2/midi1/midi2 written
  unrouted: number;          // events that matched no track (e.g. a ch10 note that is not a pad)
  flips_applied?: number;    // per-step sample flips written (drum_choice)
  drum_binding?: number[];   // Drum1..4 → 0-based pool slot written for turnkey load (when drums authored)
  drum_levels?: number[];    // Drum1..4 stored mixer levels written (condensed kits go in at 0)
  flip_warnings?: string[];  // flips that could not be applied (rest step, bad range)
  /** Authored notes that inherited a NON-default gate/tie from the template (see `preserveTemplateGates`). */
  gates_preserved?: number;
  /** Of those, how many inherited a TIE-FORWARD flag (the hand-made drones). */
  ties_preserved?: number;
  /** Authored notes whose length came from the PATTERN's own `gate_sixths` rather than the one-step default. */
  gates_authored?: number;
  /** Of those, how many the pattern asked to TIE forward (and that reach their next onset). */
  ties_authored?: number;
  /** Ties dropped for not reaching a matching next onset, and note lengths a micro-step roll overrode. */
  gate_warnings?: string[];
  /** The project scale before authoring, when a note track was written (else undefined). */
  prior_scale?: ProjectScale;
  /** The scale the project was set to (Chromatic by default, or the caller's choice). */
  scale_set?: ProjectScale;
  /** Distinct authored pitch-classes a chosen non-Chromatic scale will shift on playback (0 = none / Chromatic). */
  out_of_scale?: number;
}

/**
 * Merge two per-step flip maps ({track: {step: slot}}), `wins` taking the step
 * on a collision. Used to fold the condenser's role-resolved flips together
 * with the caller's own explicit slot flips; an explicit slot is the more
 * specific instruction, so it wins.
 */
function mergeFlipMaps(
  base: Readonly<Record<string, Record<string, number>>>,
  wins: Readonly<Record<string, Record<string, number>>> | undefined,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [track, steps] of Object.entries(base)) out[track] = { ...steps };
  for (const [track, steps] of Object.entries(wins ?? {})) out[track] = { ...(out[track] ?? {}), ...steps };
  return out;
}

/**
 * TEMPLATE GATE + TIE PRESERVATION. Seed each authored note's gate length and
 * tie-forward flag from the note the TEMPLATE already holds at the same step,
 * instead of flattening everything to `DEFAULT_GATE`.
 *
 * WHY THIS IS NOT OPTIONAL. `ncs_upload` template-modifies an existing project,
 * and this authoring path only ever emits a one-step gate. So every other gate
 * in a stored project came from the player's hands in Gate View: a 274-file
 * corpus census found 12 distinct hand-set gate values across the maintainer's
 * pack (all exact multiples of six, i.e. pad-press granularity) plus 1,048
 * TIE-FORWARD flags that no code path here can even write. Those ties are the
 * held pads and drones in Stranglehold / I Believe / Clint Eastwood / Caught
 * Glimpse / Amber / Breakdown. Re-authoring without this turns every one of
 * them into a one-step blip, invisibly, with no diff anyone is looking at.
 *
 * MATCHING RULE: exact (step, note number), preferring the same micro-step
 * delay, each template slot consumed at most once. Deliberately strict. Seeding
 * from "whatever else was on that step" would hang a 16-step drone gate on a
 * passing sixteenth that merely landed on the same step, which is worse than
 * the default. A note the template does not hold gets `DEFAULT_GATE`, untied.
 *
 * A note whose PATTERN states its own length wins: the caller asking for a
 * specific gate is a more specific instruction than "whatever was here before",
 * and without that rule the new duration surface would be unusable on any
 * template that already had a hand-set gate at the same (step, note).
 *
 * Slots that inherited a tie are returned so `dropUnreachableTies` can tell an
 * inherited drone from an authored one when it reports what it dropped.
 */
function preserveGatesFromTemplate(
  buf: Uint8Array, track: NoteTrack, patternIndex: number,
  cells: NoteSlot[][], rollSteps: ReadonlySet<number> | undefined,
  authoredGates: ReadonlySet<NoteSlot>,
): { preserved: number; inheritedTies: Set<NoteSlot> } {
  const template = decodeNotePattern(buf, track, patternIndex);
  const inheritedTies = new Set<NoteSlot>();
  let preserved = 0;

  for (let s = 0; s < cells.length; s++) {
    if (cells[s].length === 0 || rollSteps?.has(s)) continue;
    const pool = [...template[s].notes];
    for (const slot of cells[s]) {
      if (authoredGates.has(slot)) continue;   // the pattern stated its own length
      let i = pool.findIndex((t) => t.note === slot.note && t.delay === slot.delay);
      if (i < 0) i = pool.findIndex((t) => t.note === slot.note);
      if (i < 0) continue;
      const [src] = pool.splice(i, 1);
      if (src.gate === DEFAULT_GATE && !src.tie) continue;   // nothing hand-set to keep
      slot.gate = src.gate;
      slot.tie = src.tie;
      preserved++;
      if (src.tie) inheritedTies.add(slot);
    }
  }
  return { preserved, inheritedTies };
}

/**
 * TIE REACHABILITY, applied to every tie on a track whether it was inherited
 * from the template or authored by the caller: one rule, one place, so the two
 * routes cannot drift apart.
 *
 * The device's rule (manual ":1908", and 524 of 524 real ties in the corpus) is
 * that a tied note's gate must end EXACTLY where the next onset begins, and
 * that onset must carry the same note. Wrapping past the pattern's last step
 * into its own first onset counts, since that is the manual's worked example.
 * A tie that does not reach is DROPPED (the note LENGTH is kept) and reported,
 * because a tie into silence is a silent no-op at best and a hung note at worst.
 */
function dropUnreachableTies(
  track: NoteTrack, cells: NoteSlot[][], patternSteps: number,
  inheritedTies: ReadonlySet<NoteSlot>,
): { droppedInherited: number; warnings: string[] } {
  const warnings: string[] = [];
  let droppedInherited = 0;
  const onsets: number[] = [];
  for (let s = 0; s < cells.length; s++) if (cells[s].length > 0) onsets.push(s);
  for (let s = 0; s < cells.length; s++) {
    for (const slot of cells[s]) {
      if (!slot.tie) continue;
      const later = onsets.find((o) => o > s);
      const target = later ?? (onsets.length > 0 ? onsets[0] + patternSteps : undefined);
      const targetStep = later ?? onsets[0];
      const reaches = target !== undefined && s * MICROTICKS_PER_STEP + slot.gate === target * MICROTICKS_PER_STEP;
      const samePitch = targetStep !== undefined && cells[targetStep].some((n) => n.note === slot.note);
      if (reaches && samePitch) continue;
      const inherited = inheritedTies.has(slot);
      slot.tie = false;
      if (inherited) droppedInherited++;
      warnings.push(
        `${track} step ${s + 1} note ${slot.note}: ${inherited ? "the template's" : 'the'} tie-forward was dropped because a ` +
        `${describeGate(slot.gate, false)} does not end on a matching next onset. The note length was kept.`,
      );
    }
  }
  return { droppedInherited, warnings };
}

/**
 * Author a compiled, voice_map-resolved RealizePlan into a 160,780-byte .ncs
 * project buffer IN PLACE (pattern 0 of each touched track). Pure: no MIDI I/O,
 * so it is golden-testable against the codec decoders. Routing is by CHANNEL
 * (the Circuit multiplexes its tracks by channel): ch10 → drum pads (note →
 * Drum1..4), ch1/2/3/4 → the Synth1/Synth2/MIDI1/MIDI2 note tracks. Events on
 * the same (track, step) merge into a chord (capped at the 6 note slots).
 *
 * `scale` controls how the device treats those authored pitches. The Circuit
 * re-quantizes every note a track plays to the project scale (a non-Chromatic
 * scale would shift out-of-scale notes — e.g. an authored maj7 B → Bb in the
 * default C Natural Minor). Note tokens are ABSOLUTE pitches, so when a note
 * track is written we set the project to Chromatic by default (all 12 notes ⇒
 * literal playback). A caller that WANTS the device's scale feature (so the
 * pattern stays in-key and the on-device Scale knob remaps it musically) passes
 * a scale string ("C minor", "G mixolydian", "dorian", "chromatic"); the
 * authored notes then play through it. Drums are unaffected (pads play samples,
 * not scale tones), so a drums-only author never touches the scale.
 *
 * NOTE LENGTHS come from three places, in this order of specificity:
 *
 *  1. the PATTERN, when a step states `gate_sixths` (authored as `"c3:4"` in
 *     the mini-notation, arriving here on `RealizeNoteEvent.gate_sixths` in the
 *     device's own unit, sixths of a step);
 *  2. the TEMPLATE's existing note at the same (step, note), when
 *     `preserveTemplateGates` is on and the pattern stated nothing;
 *  3. `DEFAULT_GATE`, one step, untied.
 *
 * `preserveTemplateGates` (default TRUE) is not a negotiable default. Before
 * (1) existed this path emitted ONLY a one-step gate, so every other gate in a
 * stored project was dialled in by hand at the device, and a re-author that
 * resets them to one step is silent destruction of real work.
 */
export function authorPlanIntoProject(
  buf: Uint8Array, plan: RealizePlan, scale?: string, patternIndex = 0, preserveTemplateGates = true,
): AuthoredTracks {
  if (!Number.isInteger(patternIndex) || patternIndex < 0 || patternIndex >= PATTERNS_PER_TRACK) {
    throw new DispatchError('bad_location', DEVICE_LABEL, `pattern index must be 0..${PATTERNS_PER_TRACK - 1}, got ${patternIndex}`);
  }
  // Fail fast: validate the scale arg BEFORE any buffer mutation, so a typo'd
  // scale name is rejected without a wasted (and discarded) grid write.
  const chosen = scale !== undefined ? resolveScaleName(scale) : undefined;
  const stepMs = plan.cycle_ms / Math.max(1, plan.steps);
  const stepOf = (timeMs: number): number =>
    Math.max(0, Math.min(STEPS_PER_PATTERN - 1, Math.round(timeMs / stepMs)));

  const drumGrids = new Map<number, { active: boolean; velocity: number; microHits?: number; sampleSlot?: number }[]>();
  const noteGrids = new Map<NoteTrack, NoteSlot[][]>();
  // Steps whose notes came from a micro-step ROLL. A roll is deliberate
  // retriggers, so its slots keep DEFAULT_GATE and are held out of template
  // gate inheritance (a roll fans one note across a step at several delays, so
  // there is no one-to-one note to inherit from anyway).
  const rollSteps = new Map<NoteTrack, Set<number>>();
  // Slots whose length came from the PATTERN (`Step.gate_sixths`) rather than
  // from the one-step default. Template inheritance skips these: an explicit
  // "hold this for four steps" is a more specific instruction than "keep
  // whatever was here before".
  const authoredGates = new Set<NoteSlot>();
  const gateWarnings: string[] = [];
  let unrouted = 0;

  /**
   * The event's note length as a device gate MAGNITUDE. Bounded here rather
   * than clamped: a caller who asks for a length the field cannot hold gets
   * told, because silently shortening a drone to 16 steps (or lengthening a
   * zero to a full step) is the exact class of quiet damage this whole surface
   * exists to prevent. `compileToPlan` already rejects the same range, so
   * reaching this is a programmatic caller bypassing the compiler.
   */
  const gateOf = (e: RealizePlan['events'][number]): number => {
    if (e.gate_sixths === undefined) return DEFAULT_GATE;
    if (!Number.isInteger(e.gate_sixths) || e.gate_sixths < MIN_GATE_SIXTHS || e.gate_sixths > MAX_GATE_SIXTHS) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        `Note length ${e.gate_sixths} sixths of a step is outside what the Circuit's gate field holds: ` +
        `${MIN_GATE_SIXTHS}..${MAX_GATE_SIXTHS} sixths, i.e. ${MIN_GATE_SIXTHS / MICROTICKS_PER_STEP} to ` +
        `${MAX_GATE_SIXTHS / MICROTICKS_PER_STEP} steps (${MICROTICKS_PER_STEP} = one step).`,
      );
    }
    return e.gate_sixths;
  };

  for (const e of plan.events) {
    // A micro-placed onset's time_ms includes its intra-step offset (compile
    // adds micro/6 of a step); subtract it back out so the event maps to its
    // BASE step — delay 3 must not round up into the next step.
    const micro = e.micro ?? 0;
    const step = stepOf(e.time_ms - (micro / 6) * stepMs);
    // Drums first: a ch10 event triggers a pad (note → Drum1..4). A ch10 event
    // whose note is not a pad has no home — count it, don't fabricate one.
    if (e.channel === CH_DRUMS) {
      const track = NOTE_TO_DRUM_TRACK[e.note];
      if (track === undefined) { unrouted++; continue; }
      let grid = drumGrids.get(track);
      if (!grid) { grid = Array.from({ length: STEPS_PER_PATTERN }, () => ({ active: false, velocity: 0 })); drumGrids.set(track, grid); }
      // Micro-hit mask — POSITIONAL, bit k = micro-tick k, additive
      // (HW-confirmed 2026-07-03; drumPattern.ts cites the capture). A roll
      // (micro_hits 2..6) fans across the step with the SAME spacing as the
      // note-track fan below, so the internal drum and an externally-routed
      // copy of the same roll stay time-aligned; a placed onset sets its
      // tick's bit; a plain hit is bit 0. Same-step events MERGE: masks OR
      // together, the loudest velocity wins.
      let mask: number;
      if (e.micro_hits !== undefined && e.micro_hits > 1) {
        const n = Math.min(6, e.micro_hits);
        mask = 0;
        for (let k = 0; k < n; k++) mask |= 1 << Math.round((k * 5) / (n - 1));
      } else {
        mask = 1 << micro;
      }
      const cell = grid[step];
      grid[step] = {
        ...cell,
        active: true,
        velocity: Math.max(cell.active ? cell.velocity : 0, e.velocity),
        microHits: ((cell.active ? cell.microHits ?? 1 : 0) | mask) & 0x3f,
      };
      continue;
    }
    // Note tracks: route by channel; accumulate notes per step into a chord.
    const nt = CHANNEL_TO_NOTE_TRACK[e.channel];
    if (!nt) { unrouted++; continue; }
    let cells = noteGrids.get(nt);
    if (!cells) { cells = Array.from({ length: STEPS_PER_PATTERN }, () => [] as NoteSlot[]); noteGrids.set(nt, cells); }
    const slots = cells[step];
    // Micro-step ROLL on a note track (e.g. a hat roll bound for an external
    // SPD-SX pad): fan the SAME note across the step via the per-note `delay`
    // field (0..5 micro-steps, byte-decoded in notePattern.ts), so the device
    // retriggers it N times within one step. On a POLY pad each retrigger rings
    // its own trail (the whole point of routing rolls to the SPD-SX). Any roll
    // 2..6 spreads evenly — the same spacing the drum route's mask uses above.
    if (e.micro_hits !== undefined && e.micro_hits > 1) {
      const n = Math.min(e.micro_hits, NOTE_SLOTS_PER_STEP);
      let placed = 0;
      // A roll and a note length are contradictory instructions for the same
      // step (retrigger N times vs hold once), so say which one won rather than
      // dropping the gate quietly.
      if (e.gate_sixths !== undefined && e.gate_sixths !== DEFAULT_GATE) {
        gateWarnings.push(
          `${nt} step ${step + 1} note ${e.note}: the ${describeGate(gateOf(e), false)} was ignored because this step is a ` +
          `${e.micro_hits}-hit micro-step roll, and a roll is deliberate retriggers. Drop the roll digit to hold the note instead.`,
        );
      }
      for (let k = 0; k < n && slots.length < NOTE_SLOTS_PER_STEP; k++) {
        const delay = Math.round((k * 5) / (n - 1)); // n > 1 ⇒ n-1 >= 1
        // Retriggers DECAY like real roll bounces (rollVelocity) — identical
        // velocities are the "machine-gun" tell on velocity-sensitive pads.
        // gate stays DEFAULT_GATE (one step) and untied: a roll is deliberate
        // retriggers, so lengthening or tying them would smear the bounces.
        slots.push({ note: e.note, gate: DEFAULT_GATE, tie: false, delay, velocity: rollVelocity(e.velocity, k) });
        placed++;
      }
      let rolls = rollSteps.get(nt);
      if (!rolls) { rolls = new Set(); rollSteps.set(nt, rolls); }
      rolls.add(step);
      // Honest count: if the slots filled before the fan finished (the step already
      // held notes from another voice routed to this track), report the dropped hits.
      if (placed < n) unrouted += n - placed;
      continue;
    }
    // Dedup by (note, delay): the same note may legitimately repeat within a
    // step at DIFFERENT micro-ticks (a 16th + its 32nd "and" = delays 0 and 3
    // — the micro-placement feature, B0-confirmed); only an identical
    // (note, tick) pair is a duplicate.
    if (slots.some((s) => s.note === e.note && s.delay === micro)) continue;
    if (slots.length >= NOTE_SLOTS_PER_STEP) { unrouted++; continue; } // chord full (6 slots); honest count
    // NOTE LENGTH. The event's `gate_sixths` is the pattern's own duration, in
    // the device's own unit (sixths of a step, 1..96), carried down from
    // `Step.gate_sixths` without passing through milliseconds: the .ncs has no
    // ms concept and a bpm round-trip would not reproduce the caller's exact
    // value. A step that states no length gets DEFAULT_GATE (one step, untied),
    // which is what every pattern authored before this field existed gets, so
    // nothing already written moves. A stored project's OTHER lengths were
    // hand-set at the device, which is what `preserveTemplateGates` keeps.
    const slot: NoteSlot = {
      note: e.note, gate: gateOf(e), tie: e.tie === true, delay: micro, velocity: e.velocity,
    };
    if (e.gate_sixths !== undefined) authoredGates.add(slot);
    slots.push(slot);
  }

  // Per-step SAMPLE FLIPS (ncs_upload): set a hit's drum_choice to an absolute
  // sample slot 0..63 so that step plays a DIFFERENT sample than the track's
  // default — the device's Sample Flip feature, which lets several drum pieces
  // (kick + snare + sticks) live on ONE track. A flip on a rest is reported and
  // ignored (a flip only colours an existing hit). HW-confirmed encoding.
  const flipWarnings: string[] = [];
  let flipsApplied = 0;
  // Two flip surfaces converge here. `drum_flips` is the caller's own absolute
  // sample slots. `drum_flip_roles` is what the device-neutral CONDENSER emits:
  // per-step drum ROLES ("crash", "tom"), because it deliberately refuses to
  // name a device slot, and resolving a role to this device's pool slot is exactly
  // this layer's job (CIRCUIT_VOICE_SLOT via circuitSlotForVoice, so any dialect
  // spelling lands on the same slot the kit was uploaded in). Roles are resolved
  // FIRST so an explicit slot from the caller wins a conflict on the same step.
  const drumFlipRoles = plan.upload?.drum_flip_roles;
  // Roles resolve against the EFFECTIVE binding (`slotForFlipRole`): with a
  // custom `drum_binding` the caller has declared the pool's layout, so a role
  // among the four bound track roles resolves to ITS bound slot (a ride flip
  // plays the caller's ride sample wherever they put it), and any other role is
  // unlocatable there, skipped with a warning rather than guessed from the
  // canonical layout, because a guessed slot plays whatever sample happens to
  // live at it. This join is what lets condense_drums COMPOSE with a custom
  // binding instead of refusing it.
  const flipBinding = plan.upload?.drum_binding;
  const resolvedRoleFlips: Record<string, Record<string, number>> = {};
  if (drumFlipRoles) {
    for (const [trackName, stepMap] of Object.entries(drumFlipRoles)) {
      const perStep: Record<string, number> = {};
      for (const [stepStr, role] of Object.entries(stepMap)) {
        const slot = slotForFlipRole(String(role), flipBinding);
        if (slot === undefined) {
          flipWarnings.push(
            flipBinding !== undefined && canonicalRole(String(role)) !== undefined
              ? `${trackName} step ${stepStr}: the custom drum_binding does not say where "${role}" lives in this pack's pool ` +
                `(it locates only the four track samples), so the flip was skipped and the hit keeps the track's bound sound. ` +
                `To keep "${role}" distinct, pass drum_flips with its pool slot, or drop drum_binding for the canonical kit layout.`
              : `${trackName} step ${stepStr}: no Circuit sample slot for drum role "${role}", flip skipped`,
          );
          continue;
        }
        perStep[stepStr] = slot;
      }
      resolvedRoleFlips[trackName] = perStep;
    }
  }
  const drumFlips = drumFlipRoles || plan.upload?.drum_flips
    ? mergeFlipMaps(resolvedRoleFlips, plan.upload?.drum_flips)
    : undefined;
  if (drumFlips) {
    for (const [trackName, stepMap] of Object.entries(drumFlips)) {
      const m = /^drum([1-4])$/i.exec(String(trackName).trim());
      if (!m) { flipWarnings.push(`unknown drum track "${trackName}" (use drum1..drum4)`); continue; }
      const track = Number(m[1]) - 1;
      const grid = drumGrids.get(track);
      for (const [stepStr, slot] of Object.entries(stepMap)) {
        const step1 = Number(stepStr);
        if (!Number.isInteger(step1) || step1 < 1 || step1 > STEPS_PER_PATTERN) {
          flipWarnings.push(`drum${track + 1} step "${stepStr}" out of range 1..${STEPS_PER_PATTERN}`); continue;
        }
        if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
          flipWarnings.push(`drum${track + 1} step ${step1}: sample slot ${slot} out of range 0..63`); continue;
        }
        const cell = grid?.[step1 - 1];
        if (!cell || !cell.active) {
          flipWarnings.push(`drum${track + 1} step ${step1} is not a hit, flip to slot ${slot} ignored`); continue;
        }
        cell.sampleSlot = slot;
        flipsApplied++;
      }
    }
  }

  for (const [track, grid] of drumGrids) setDrumPattern(buf, track, patternIndex, grid);
  // Note tracks: seed gates + ties from the template BEFORE writing (the read
  // has to happen while the template's own bytes are still in the buffer), then
  // lay the pattern down. Each track is independent, so decoding one while
  // another has already been written is safe.
  let gatesPreserved = 0;
  let tiesPreserved = 0;
  let gatesAuthored = 0;
  let tiesAuthored = 0;
  const patternSteps = Math.max(1, Math.min(STEPS_PER_PATTERN, plan.steps));
  for (const [track, cells] of noteGrids) {
    let inherited: ReadonlySet<NoteSlot> = new Set<NoteSlot>();
    if (preserveTemplateGates) {
      const kept = preserveGatesFromTemplate(buf, track, patternIndex, cells, rollSteps.get(track), authoredGates);
      gatesPreserved += kept.preserved;
      tiesPreserved += kept.inheritedTies.size;
      inherited = kept.inheritedTies;
    }
    // Every tie on the track goes through the same reachability rule, inherited
    // or authored, so an authored drone that cannot hold is reported instead of
    // being written as a device no-op.
    const dropped = dropUnreachableTies(track, cells, patternSteps, inherited);
    tiesPreserved -= dropped.droppedInherited;
    gateWarnings.push(...dropped.warnings);
    // Count the pattern's OWN lengths after the reachability pass, so a tie
    // reported as dropped is never also reported as written.
    for (const slots of cells) {
      for (const s of slots) {
        if (!authoredGates.has(s)) continue;
        gatesAuthored++;
        if (s.tie) tiesAuthored++;
      }
    }
    setNotePattern(buf, track, patternIndex, cells);
  }
  // Set the pattern LENGTH so the device plays all authored steps instead of the
  // default 16 (byte 0 of a pattern's meta block = steps-1; see
  // circuit-ncs-format-decode.md). HARDWARE-CONFIRMED for drum tracks
  // (2026-06-22) AND note tracks (2026-06-30 — see chain.ts).
  const lengthByte = Math.max(0, Math.min(STEPS_PER_PATTERN, plan.steps) - 1);
  for (const track of drumGrids.keys()) buf[META_OFFSETS[drumBlockIndex(track, patternIndex)]] = lengthByte;
  for (const track of noteGrids.keys()) buf[META_OFFSETS[noteBlockIndex(track, patternIndex)]] = lengthByte;

  // Drum-track → sample-slot BINDING (turnkey, decoded 2026-06-27 — drumBinding.ts):
  // point each of the 4 drum tracks at its pool slot so the project loads with the
  // right kit pieces, no on-device hand-assignment. Defaults to the canonical role
  // layout [0,1,2,3] = kick/snare/closed_hat/ride; override via upload.drum_binding.
  // Written only when drums were authored (so an all-note project doesn't rebind
  // unused drum tracks). setDrumSampleBinding validates the 4-slot shape + range.
  let drumBinding: number[] | undefined;
  if (drumGrids.size > 0) {
    const requested = plan.upload?.drum_binding;
    if (requested !== undefined && requested.length !== DRUM_TRACK_COUNT) {
      throw new DispatchError('value_out_of_range', DEVICE_LABEL, `drum_binding must be ${DRUM_TRACK_COUNT} slots (Drum 1..4), got ${requested.length}`);
    }
    drumBinding = requested ? [...requested] : [...DEFAULT_DRUM_BINDING];
    setDrumSampleBinding(buf, drumBinding);
  }

  // Stored drum-track mixer LEVELS (decoded 2026-07-26, see format.ts). Written
  // whenever the plan asks, drums authored or not, because the level is project
  // state rather than pattern data. This is what makes a CONDENSED kit usable:
  // it is laid in at level 0, inaudible under the externally-routed kit, and the
  // player dials a track up from the mixer when they want it. A runtime CC could
  // not do this, because a project change overwrites the live value, so only the stored
  // byte survives the next song-part switch.
  const drumLevels = plan.upload?.drum_levels;
  if (drumLevels !== undefined) {
    if (drumLevels.length !== DRUM_TRACK_COUNT) {
      throw new DispatchError('value_out_of_range', DEVICE_LABEL, `drum_levels must be ${DRUM_TRACK_COUNT} levels (Drum 1..4), got ${drumLevels.length}`);
    }
    setDrumLevels(buf, drumLevels);
  }

  const result: AuthoredTracks = {
    drum_tracks: [...drumGrids.keys()],
    note_tracks: [...noteGrids.keys()],
    unrouted,
    flips_applied: flipsApplied,
    ...(drumBinding ? { drum_binding: drumBinding } : {}),
    ...(drumLevels !== undefined ? { drum_levels: [...drumLevels] } : {}),
    ...(flipWarnings.length > 0 ? { flip_warnings: flipWarnings } : {}),
    ...(gatesPreserved > 0 ? { gates_preserved: gatesPreserved } : {}),
    ...(tiesPreserved > 0 ? { ties_preserved: tiesPreserved } : {}),
    ...(gatesAuthored > 0 ? { gates_authored: gatesAuthored } : {}),
    ...(tiesAuthored > 0 ? { ties_authored: tiesAuthored } : {}),
    ...(gateWarnings.length > 0 ? { gate_warnings: gateWarnings } : {}),
  };
  // Set the scale only when a note track was written (drums are scale-immune).
  if (result.note_tracks.length > 0) {
    result.prior_scale = getProjectScale(buf);
    const target = chosen ?? { type: SCALE_CHROMATIC, root: undefined };
    setProjectScale(buf, target.type, target.root);
    const set = getProjectScale(buf);
    result.scale_set = set;
    // How many distinct authored pitch-classes this scale will shift on playback
    // (0 for Chromatic / a fully in-key pattern) — the guardrail against the
    // very re-quantization this feature exists to prevent, now on the opt-in path.
    const authoredNotes: number[] = [];
    for (const cells of noteGrids.values()) {
      for (const slots of cells) for (const s of slots) authoredNotes.push(s.note);
    }
    result.out_of_scale = notesOutsideScale(authoredNotes, set.type, set.root);
  }
  return result;
}

const DEVICE_LABEL = 'Novation Circuit Tracks';
const PROJECT_CHANNEL = 16;

/** Max scene steps confirmed writable (sceneChain.ts stride confirmed 1..4). */
const MAX_SCENE_STEPS = 4;

/**
 * Receipt line for stored drum-track levels. Names the caveat every time,
 * because the levels are the whole point of a condensed kit AND a hand-Save on
 * the device silently reverts them from the physical faders (format.ts).
 */
function drumLevelNote(levels: readonly number[] | undefined): string {
  if (levels === undefined) return '';
  const silent = levels.every((l) => l === 0);
  return ` Drum-track levels stored at ${levels.join('/')} (Drum 1..4)` +
    (silent
      ? ', i.e. SILENT: the condensed kit sits under the routed drums until the user raises a drum track on the mixer.'
      : '.') +
    ' A Save done on the device recaptures the physical fader positions and reverts these, so re-apply them after any manual save.';
}

/**
 * Write the project's STORED tempo (or deliberately leave the template's), and
 * return the receipt line that says which happened.
 *
 * Never silent, in either direction. A stored project carries its own tempo and
 * the device adopts it on load, so the two possible outcomes are "this project
 * now plays at the tempo you asked for" and "this project will play at whatever
 * the template was set to" — and the second one is a wrong-speed song if nobody
 * notices. Authoring took that branch unconditionally until this shipped, which
 * is how a pack of 140-bpm parts came to be stored at the template's 120.
 *
 * Mutates `buf` in place, before the transfer, so the byte rides the same
 * CRC-gated upload as everything else authored into the file.
 */
function applyStoredTempo(buf: Uint8Array, up: { tempo?: number }): string {
  const had = getProjectTempo(buf);
  if (up.tempo === undefined) {
    return ` TEMPO: not set by this call, so the project keeps the template's ${had} BPM` +
      ` — pass bpm (or ncs_tempo) if the song is not ${had}, or set Tempo on the device.`;
  }
  setProjectTempo(buf, up.tempo);
  return ` Tempo stored at ${up.tempo} BPM${had !== up.tempo ? ` (template held ${had})` : ''};` +
    ' the device adopts it when the project loads. A Save done on the device stores the front panel\'s' +
    ' current tempo instead, so re-apply after any manual save.';
}

/**
 * Write the project's STORED PAD COLOUR (or deliberately leave the template's),
 * and return the receipt line that says which happened. Same shape and same
 * never-silent contract as {@link applyStoredTempo}.
 *
 * Why it earns a line in every receipt: mid-set, Projects View shows a grid of
 * LIT PADS, not names, so an uncoloured project is findable only by counting
 * slots. A pack whose projects all inherited one template colour looks exactly
 * like a pack nobody organised, and the inherit branch is the only place that
 * can say so.
 *
 * Refuses an unknown colour instead of substituting one, and does it HERE —
 * before the authoring, the overwrite gate and the transfer — so a typo costs
 * nothing. `resolveProjectColour` throws a `RangeError` naming the palette;
 * that is re-thrown as a structured `DispatchError` so the tool surface reports
 * it like every other bad argument.
 *
 * Mutates `buf` in place, before the transfer, so the byte rides the same
 * CRC-gated upload as everything else authored into the file.
 */
function applyStoredColour(buf: Uint8Array, up: { colour?: number | string }): string {
  let stamp: ProjectColourStamp;
  try {
    stamp = applyProjectColour(buf, up.colour);
  } catch (err) {
    throw new DispatchError(
      typeof up.colour === 'string' ? 'unknown_enum_value' : 'value_out_of_range',
      DEVICE_LABEL,
      `${err instanceof Error ? err.message : String(err)}. Nothing was written.`,
    );
  }
  if (stamp.inherited) {
    return ` COLOUR: not set by this call, so the project's pad stays the template's` +
      ` ${projectColourName(stamp.previous)} in Projects View. Pass colour to make it findable mid-set` +
      ` (most-separable first: ${DISTINCT_COLOURS.map(projectColourName).join(' > ')}).`;
  }
  return ` Pad colour stored as ${projectColourName(stamp.index)}` +
    `${stamp.changed ? ` (template held ${projectColourName(stamp.previous)})` : ' (the template already held it)'};` +
    ' the device lights that project\'s pad this colour in Projects View.';
}

/** A stored name for a receipt: quoted, with the blank template made readable. */
function nameLabel(name: string): string {
  return name === '' ? '(unnamed)' : `"${name}"`;
}

/**
 * Write the project's STORED NAME (or deliberately leave the template's), and
 * return the receipt line that says which happened. Same shape and same
 * never-silent contract as {@link applyStoredColour}: an unset name means every
 * project authored from one template lists under the template's name, which is
 * the "which project is this song?" problem again, so the inherit branch says
 * so out loud.
 *
 * Refuses an over-long or non-ASCII name instead of truncating, and does it
 * HERE, before the authoring, the overwrite gate and the transfer, so a bad
 * name costs nothing. `applyProjectName` throws a `RangeError` naming the
 * limit; re-thrown as a structured `DispatchError` like every other bad
 * argument. Mutates `buf` in place, before the transfer, so the bytes ride the
 * same CRC-gated upload as everything else authored into the file.
 */
function applyStoredName(buf: Uint8Array, up: { project_name?: string }): string {
  let stamp: ProjectNameStamp;
  try {
    stamp = applyProjectName(buf, up.project_name);
  } catch (err) {
    throw new DispatchError(
      'value_out_of_range', DEVICE_LABEL,
      `${err instanceof Error ? err.message : String(err)}. Nothing was written.`,
    );
  }
  if (stamp.inherited) {
    return ` NAME: not set by this call, so the project keeps the template's ${nameLabel(stamp.previous)}.` +
      ' Pass project_name (up to 32 ASCII characters) to name it.';
  }
  return ` Project name stored as "${stamp.name}"` +
    `${stamp.changed ? ` (template held ${nameLabel(stamp.previous)})` : ' (the template already held it)'}.`;
}

/**
 * Write the caller's STORED per-track mixer levels (`mixer_levels`), plus the
 * STORED-SILENT SYNTH DEFAULT: when the caller does not name synth1/synth2,
 * BOTH synths are stored at level 0. The repertoire convention, on the
 * maintainer's explicit 2026-07-29 instruction ("I want it to default that
 * way"): external gear carries the synth voices, so the internal engines stay
 * silent unless a fader is raised live. This DELIBERATELY replaces the old
 * keep-the-template's-byte branch for the two synth level bytes; an explicit
 * `mixer_levels` key overrides, including a deliberately loud value. Drum
 * tracks are unchanged: condensation stores its own 0 (reported by
 * drumLevelNote) and a non-condensed unnamed drum keeps the template's byte.
 *
 * The receipt says which happened for every track (explicit sets, the
 * stored-silent default, what stayed at the template's values), because
 * "which faders did this touch" is exactly what a musician cannot check from
 * a byte diff.
 *
 * Runs AFTER the authoring pass on purpose: a drum key here overrides the
 * condensed kit's stored 0 for that track (the caller's explicit number is the
 * more specific instruction), and the receipt says so when it happens.
 */
function applyMixerLevels(buf: Uint8Array, up: { mixer_levels?: StoredMixerLevels; drum_levels?: number[] }): string {
  const ml = up.mixer_levels ?? {};
  const tracks: { key: keyof StoredMixerLevels; label: string; drum?: number }[] = [
    { key: 'synth1', label: 'Synth 1' }, { key: 'synth2', label: 'Synth 2' },
    { key: 'drum1', label: 'Drum 1', drum: 0 }, { key: 'drum2', label: 'Drum 2', drum: 1 },
    { key: 'drum3', label: 'Drum 3', drum: 2 }, { key: 'drum4', label: 'Drum 4', drum: 3 },
  ];
  const set: string[] = [];
  const defaulted: string[] = [];
  const kept: string[] = [];
  let overrodeCondensed = false;
  for (const t of tracks) {
    const explicit = ml[t.key];
    if (explicit === undefined && t.drum !== undefined) {
      // Unchanged drum behaviour. An unset drum key under condense_drums is
      // NOT at the template's value: the condensed kit just stored it
      // (drumLevelNote reports those), so listing it as "template held" here
      // would be false. Skip it.
      if (up.drum_levels !== undefined) continue;
      kept.push(`${t.label}=${getDrumLevel(buf, t.drum)}`);
      continue;
    }
    // An unnamed synth takes the stored-silent default (maintainer, 2026-07-29).
    const level = explicit ?? 0;
    try {
      if (t.drum === undefined) setSynthLevel(buf, t.key === 'synth1' ? 1 : 2, level);
      else {
        setDrumLevel(buf, t.drum, level);
        if (up.drum_levels !== undefined) overrodeCondensed = true;
      }
    } catch (err) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        `mixer_levels.${t.key}: ${err instanceof Error ? err.message : String(err)}. Nothing was written.`,
      );
    }
    if (explicit === undefined) defaulted.push(`${t.label}=0`);
    else set.push(`${t.label}=${level}${level === 0 ? ' (silent)' : ''}`);
  }
  const segments: string[] = [];
  if (set.length > 0) {
    segments.push(`stored ${set.join(', ')} (raw 0..127 fader scale)` +
      (overrodeCondensed ? ', overriding the condensed kit\'s stored level on the named drum track(s)' : ''));
  }
  if (defaulted.length > 0) {
    segments.push(`${defaulted.join(', ')} (stored-silent default; pass mixer_levels to override)`);
  }
  return ` MIXER: ${segments.join('; ')}` +
    `; left as the template held: ${kept.length > 0 ? kept.join(', ') : 'none'}.` +
    ' A Save done on the device recaptures the physical faders and reverts stored levels, so re-apply after any manual save.';
}

/**
 * Receipt line for note LENGTHS: what the pattern asked for, what survived from
 * the template, and anything that could not be honored. Said out loud on every
 * write that touches either, because "your hand-set note lengths survived" and
 * "the pad you asked to hold is actually holding" are exactly the facts a
 * musician cannot check from a byte diff.
 */
function gatePreserveNote(authored: readonly AuthoredTracks[]): string {
  const sum = (k: keyof AuthoredTracks): number =>
    authored.reduce((a, x) => a + ((x[k] as number | undefined) ?? 0), 0);
  const gates = sum('gates_preserved');
  const ties = sum('ties_preserved');
  const written = sum('gates_authored');
  const writtenTies = sum('ties_authored');
  const warnings = authored.flatMap((x) => x.gate_warnings ?? []);
  if (gates === 0 && written === 0 && warnings.length === 0) return '';
  return (written > 0
    ? ` Wrote ${written} note length(s) from the pattern` + (writtenTies > 0 ? `, ${writtenTies} of them tied forward.` : '.')
    : '') +
    (gates > 0
      ? ` Kept ${gates} hand-set note length(s) from the template` + (ties > 0 ? `, including ${ties} tied/drone note(s).` : '.')
      : '') +
    (warnings.length > 0 ? ` Note-length warnings: ${warnings.join('; ')}` : '');
}

/** How an authored arrangement advances on the device. */
export interface ArrangementLayout {
  /** 'single' = one pattern, no chain. 'chain' = patterns 1..L auto-advance (HW-confirmed
   * primitive). 'scenes' = scene-chain steps each play a pattern range once (community-beta). */
  kind: 'single' | 'chain' | 'scenes';
  /** Section name authored into each pattern slot, in slot order. */
  slots: string[];
  /** scenes only: each scene step's inclusive pattern range. */
  scenes?: { start: number; end: number }[];
}

/**
 * Author a multi-section ARRANGEMENT into a .ncs project buffer: each section is
 * one compiled RealizePlan; `order` lists section indices in play order (repeats
 * allowed). Layout strategy, most-hardware-confirmed first:
 *
 *  1. `order.length <= 8` → CHAIN: author each occurrence into its own pattern
 *     slot (repeats duplicate the section — slots are cheap, the chain primitive
 *     is the HW-confirmed one) and chain [0, L-1] on every authored track.
 *  2. Else, if the unique sections fit the 8 slots AND the order compresses into
 *     <= 4 runs of consecutive-ascending slots → SCENES: each run becomes one
 *     scene step selecting that pattern range (a scene plays its range once,
 *     then the next scene starts — manual p.83), scene-chain loops the song.
 *     COMMUNITY-BETA (scene tables decoded 2026-07-01 from one capture).
 *  3. Else → typed error naming both limits and what to trim.
 *
 * `scenePlan` OVERRIDES the layout choice: each inner list is one scene's
 * section indices, in play order, and the layout is forced to SCENES with
 * exactly that grouping (this is how a chosen 1+3+2+2 split is expressed when
 * the greedy run-compression would merge it into fewer scenes). Each scene must
 * select CONSECUTIVE sections in listed order (a scene stores one contiguous
 * pattern range); the same section may recur across scenes (three scenes can
 * point at one ostinato pattern rather than duplicating it). `order` must be
 * the plan's concatenation; the dispatcher builds it that way.
 *
 * Scene mode also CLEARS the authored tracks' plain pattern-chain slots back to
 * the fresh default [0,0]: a stale plain-chain range left in the template is
 * still partly followed by the device once a scene chain is active (heard on
 * hardware 2026-07-23, scenes sounded duplicated), so the two advance
 * mechanisms must never coexist in an authored file.
 *
 * Tracks a section doesn't use are authored EMPTY in that section's slot(s) (the
 * template's leftover pattern data must not leak into the song), with the
 * section's length so all tracks stay in step. Pure buffer mutation, no I/O.
 */
export function authorArrangementIntoProject(
  buf: Uint8Array,
  sections: readonly { name: string; plan: RealizePlan }[],
  order: readonly number[],
  scale?: string,
  drumBinding?: readonly number[],
  drumLevels?: readonly number[],
  preserveTemplateGates = true,
  scenePlan?: readonly (readonly number[])[],
): { layout: ArrangementLayout; authored: AuthoredTracks[]; union_drums: number[]; union_notes: NoteTrack[] } {
  if (sections.length === 0 || order.length === 0) {
    throw new DispatchError('bad_location', DEVICE_LABEL, 'Arrangement needs at least one section.');
  }
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= sections.length) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Arrangement order references section ${i}; there are ${sections.length}.`);
    }
  }

  // Pick the layout BEFORE any buffer mutation (fail fast on an unfittable song).
  let layout: ArrangementLayout;
  let slotPlans: { name: string; plan: RealizePlan; section: number }[];
  if (scenePlan !== undefined) {
    // Explicit scene grouping: the caller chose which sections land in which
    // scene, so the greedy run-compression is bypassed and the layout is
    // forced to scenes. Every check refuses rather than regrouping.
    if (sections.length > PATTERNS_PER_TRACK) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        `Arrangement has ${sections.length} distinct sections; the Circuit holds ${PATTERNS_PER_TRACK} patterns per track. ` +
        'Merge similar sections (or split the song across two project slots).',
      );
    }
    if (scenePlan.length < 2) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        'scene_plan has one scene, which is just the pattern chain wearing a scene\'s clothes. ' +
        'Drop scene_plan (the automatic layout chains up to 8 plays) or split the grouping into 2 or more scenes.',
      );
    }
    if (scenePlan.length > MAX_SCENE_STEPS) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        `scene_plan needs ${scenePlan.length} scenes, but the Circuit's per-scene tables are device-confirmed only for ` +
        `Scenes 1..${MAX_SCENE_STEPS}, so writes past Scene ${MAX_SCENE_STEPS} are refused until a wider capture lands ` +
        '(queued as hardware task HW-CIRCUIT-009: build a Scene 1-8 chain on the device, save, download, diff). ' +
        `Regroup into <=${MAX_SCENE_STEPS} scenes or split the song across two project slots.`,
      );
    }
    const runs: { start: number; end: number }[] = [];
    for (let sc = 0; sc < scenePlan.length; sc++) {
      const members = scenePlan[sc];
      if (members.length === 0) {
        throw new DispatchError('value_out_of_range', DEVICE_LABEL, `scene_plan scene ${sc + 1} is empty; every scene needs at least one section.`);
      }
      for (const i of members) {
        if (!Number.isInteger(i) || i < 0 || i >= sections.length) {
          throw new DispatchError('bad_location', DEVICE_LABEL, `scene_plan scene ${sc + 1} references section ${i}; there are ${sections.length}.`);
        }
      }
      for (let j = 1; j < members.length; j++) {
        if (members[j] !== members[j - 1] + 1) {
          throw new DispatchError(
            'value_out_of_range', DEVICE_LABEL,
            `scene_plan scene ${sc + 1} lists "${sections[members[j - 1]].name}" then "${sections[members[j]].name}", which are not ` +
            'adjacent in `sections`. A scene stores ONE contiguous pattern range, and sections land in pattern slots in listed ' +
            'order, so a scene\'s members must be consecutive in `sections`. Reorder `sections` to make them adjacent.',
          );
        }
      }
      runs.push({ start: members[0], end: members[members.length - 1] });
    }
    slotPlans = sections.map((s, i) => ({ name: s.name, plan: s.plan, section: i }));
    layout = { kind: 'scenes', slots: slotPlans.map((s) => s.name), scenes: runs };
  } else if (order.length <= PATTERNS_PER_TRACK) {
    slotPlans = order.map((i) => ({ name: sections[i].name, plan: sections[i].plan, section: i }));
    layout = {
      kind: order.length === 1 ? 'single' : 'chain',
      slots: slotPlans.map((s) => s.name),
    };
  } else {
    if (sections.length > PATTERNS_PER_TRACK) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        `Arrangement has ${sections.length} distinct sections; the Circuit holds ${PATTERNS_PER_TRACK} patterns per track. ` +
        'Merge similar sections (or split the song across two project slots).',
      );
    }
    // Scene mode: compress the order into maximal runs of consecutive-ascending
    // section indices ([0,1,2] → one scene [0,2]); each run plays once per pass.
    const runs: { start: number; end: number }[] = [];
    for (const i of order) {
      const last = runs[runs.length - 1];
      if (last && i === last.end + 1) last.end = i;
      else runs.push({ start: i, end: i });
    }
    if (runs.length > MAX_SCENE_STEPS) {
      throw new DispatchError(
        'value_out_of_range', DEVICE_LABEL,
        `Arrangement needs ${order.length} pattern plays in ${runs.length} scene steps; the Circuit fits ${PATTERNS_PER_TRACK} chained patterns ` +
        `or ${MAX_SCENE_STEPS} scene steps (scenes 1..4 are the device-confirmed range). Reduce repeats or merge sections; ` +
        'sections that play back-to-back in listed order compress into one scene step.',
      );
    }
    slotPlans = sections.map((s, i) => ({ name: s.name, plan: s.plan, section: i }));
    layout = { kind: 'scenes', slots: slotPlans.map((s) => s.name), scenes: runs };
  }

  // Author every slot; collect per-slot results, then union the touched tracks.
  const authored: AuthoredTracks[] = [];
  for (let slot = 0; slot < slotPlans.length; slot++) {
    authored.push(authorPlanIntoProject(buf, slotPlans[slot].plan, scale, slot, preserveTemplateGates));
  }
  const unionDrums = [...new Set(authored.flatMap((a) => a.drum_tracks))].sort((a, b) => a - b);
  const unionNotes = [...new Set(authored.flatMap((a) => a.note_tracks))] as NoteTrack[];

  // Empty-fill: a track a section doesn't use must play SILENCE in that slot,
  // not the template's leftover pattern. Length = that section's steps.
  for (let slot = 0; slot < slotPlans.length; slot++) {
    const a = authored[slot];
    const steps = slotPlans[slot].plan.steps;
    const lb = Math.max(0, Math.min(STEPS_PER_PATTERN, steps) - 1);
    for (const track of unionDrums) {
      if (a.drum_tracks.includes(track)) continue;
      setDrumPattern(buf, track, slot, Array.from({ length: STEPS_PER_PATTERN }, () => ({ active: false, velocity: 0 })));
      buf[META_OFFSETS[drumBlockIndex(track, slot)]] = lb;
    }
    for (const track of unionNotes) {
      if (a.note_tracks.includes(track)) continue;
      setNotePattern(buf, track, slot, Array.from({ length: STEPS_PER_PATTERN }, () => [] as NoteSlot[]));
      buf[META_OFFSETS[noteBlockIndex(track, slot)]] = lb;
    }
  }

  // Drum binding once, project-global (authorPlanIntoProject wrote it per drum
  // section already; re-assert the caller's choice deterministically).
  if (unionDrums.length > 0) {
    const binding = drumBinding ? [...drumBinding] : [...DEFAULT_DRUM_BINDING];
    setDrumSampleBinding(buf, binding);
  }
  // Drum LEVELS are project-global too, so they are written once here rather
  // than per section: a condensed kit is silent across the whole song, not
  // per pattern slot. Same shape rule as the binding: all four or none.
  if (drumLevels !== undefined) {
    if (drumLevels.length !== DRUM_TRACK_COUNT) {
      throw new DispatchError('value_out_of_range', DEVICE_LABEL, `drum_levels must be ${DRUM_TRACK_COUNT} levels (Drum 1..4), got ${drumLevels.length}`);
    }
    setDrumLevels(buf, drumLevels);
  }

  // Advance wiring.
  const lastSlot = slotPlans.length - 1;
  if (layout.kind === 'chain') {
    for (const track of unionNotes) setNoteChain(buf, track, { start: 0, end: lastSlot });
    if (unionDrums.length > 0) setDrumChain(buf, { start: 0, end: lastSlot });
  } else if (layout.kind === 'scenes') {
    const runs = layout.scenes!;
    for (let sc = 0; sc < runs.length; sc++) {
      for (const track of unionNotes) setSceneNoteChain(buf, sc, track, runs[sc]);
      for (const track of unionDrums) setSceneDrumChain(buf, sc, track, runs[sc]);
    }
    if (runs.length >= 2) setSceneChain(buf, runs.length);
    // Clear the authored tracks' PLAIN pattern-chain slots (fresh default
    // [0,0]). A stale plain-chain range inherited from the template is still
    // partly followed by the device once a scene chain is active, and scenes
    // then sound duplicated (heard on hardware 2026-07-23, fixed the same day
    // as a single-byte clear per track). Tracks outside the union are left
    // alone: their template content, chains included, is deliberately kept.
    for (const track of unionNotes) clearNoteChain(buf, track);
    if (unionDrums.length > 0) clearDrumChains(buf);
  }

  return { layout, authored, union_drums: unionDrums, union_notes: unionNotes };
}

/**
 * Resolve the wire channel for a param given the `instance` arg. The Circuit
 * has two identical synth engines; instance 1 (default) = Synth 1 (ch1),
 * instance 2 = Synth 2 (ch2). Only synth-scoped params (registry channel ch1)
 * have a second instance; drums (ch10) and project (ch16) reject instance > 1.
 */
function effectiveChannel(cp: CircuitParam, instance?: number): number {
  const inst = instance ?? 1;
  if (inst === 1) return cp.channel;
  if (inst === 2) {
    if (cp.channel !== CH_SYNTH1) {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        `instance 2 (Synth 2) only applies to synth params; '${cp.block}.${cp.name}' is global/drum (ch${cp.channel}). Drop the instance arg.`,
      );
    }
    return CH_SYNTH2;
  }
  throw new DispatchError(
    'capability_not_supported',
    DEVICE_LABEL,
    `Circuit Tracks has two synth instances (1 = Synth 1, 2 = Synth 2); instance ${inst} is not addressable.`,
  );
}

function requireParam(block: string, name: string) {
  const cp = findParam(block, name);
  if (!cp) {
    const known = listParamNames(block);
    throw new DispatchError(
      'unknown_param',
      DEVICE_LABEL,
      known.length > 0
        ? `Unknown param '${block}.${name}'. Known params for '${block}': ${known.join(', ')}.`
        // This branch fires on an unknown BLOCK, which the census does answer,
        // so the portless-and-blockless call is correct here. It no longer
        // claims to return "the param surface": it returns the block roster,
        // and the params come from a follow-up call naming a block.
        : `Unknown block '${block}'. Call list_params({port:"circuit"}) for the block roster, then pass one as \`block\` for its params.`,
      known.length > 0 ? { valid_options: known } : { retry_action: 'list_params({port:"circuit"})' },
    );
  }
  return cp;
}

/**
 * Resolve a caller-supplied project location to the 0-based WIRE number.
 *
 * The tool surface speaks the device's own numbering: **Project 1..64**, exactly
 * as the front panel shows it. The wire is 0..63. Convert here, once, so the
 * 0-based form never appears above this line — and never in anything an agent
 * repeats to a musician.
 *
 * This used to accept 0..63 verbatim, which was a display-first violation: the
 * panel says "Project 35" and the argument wanted 34. Because the two ranges
 * OVERLAP over 1..63, a caller using the wrong base got no error at all, just a
 * silent write to the neighbouring project. That is precisely why this is a
 * conversion and not merely a relabelled range check.
 */
function parseProjectNumber(location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `Project must be 1..64, numbered exactly as the device shows it, got '${location}'. For queued switching send_program_change(channel:16, program:64..127).`,
    );
  }
  return n - 1;
}

/**
 * Resolve a `save_preset` location to a Flash PATCH slot (0..63 per the v3
 * Programmer's Reference Guide: "Replace Patch" patch number is 00–3F). These
 * are PATCH slots — distinct from the 0..63 PROJECT slots that switch_preset /
 * upload_project address (the device UI shows 128 patches as four pages of 32,
 * but the writable Replace-Patch range is the 64-patch bank 0..63).
 */
function parsePatchNumber(location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
  if (!Number.isInteger(n) || n < 0 || n > 63) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `Synth patch slot must be 0..63, got '${location}'. These are PATCH slots (the synth patch bank), ` +
      `distinct from the PROJECT slots used by switch_preset / upload_project.`,
    );
  }
  return n;
}

/**
 * Device-facing name for a 0-based wire pack index: wire 0 → "Pack 1".
 *
 * Every user-facing string about a pack goes through this. The wire is 0-based
 * and the front panel is 1-based, and an off-by-one here means a receipt that
 * names the wrong pack — on a destructive write, the receipt is the only thing
 * telling the user what was just overwritten.
 */
function packLabel(pack: number | undefined): string {
  return `Pack ${(pack ?? 0) + 1}`;
}

/**
 * Overwrite gate for a PROJECT slot (cf. `docs/SAFE-EDIT-WORKFLOW.md`). The
 * Circuit's project slots are readable, so the gate is occupancy-driven rather
 * than a blanket refuse-by-default: an EMPTY slot is written without friction;
 * an OCCUPIED slot — or one whose occupancy could not be confirmed — is held
 * unless the user authorized the overwrite (`confirmOverwrite`). On a refusal it
 * throws `overwrite_confirmation_required`, which the unified tool handler
 * formats into the canonical refusal text. Returns a short note (for the success
 * receipt) when the write is allowed to proceed. Costs one slot READ on the
 * non-confirmed path only.
 *
 * The gate reads `ctx.pack` — the SAME field the write reads — so it can never
 * check one pack's occupancy while the write lands on another. Do not add a
 * `pack` PARAMETER here: a parameter can be passed at the write and forgotten
 * at the gate, and that divergence is a silent clobber (the gate clears an
 * empty Pack 1 slot while the write destroys a project on Pack 5). Pinned by
 * the divergence golden in `scripts/verify-circuit-pack-gate.ts`.
 */
async function gateProjectOverwrite(
  ctx: DispatchCtx, slot: number, confirmOverwrite: boolean | undefined,
): Promise<string> {
  const where = packLabel(ctx.pack);
  if (confirmOverwrite) return `Overwrite authorized by the user for project slot ${slot} on ${where}.`;
  const probe = await probeProjectSlot(ctx.conn, slot, { pack: ctx.pack, reconnect: ctx.reconnect });
  if (probe.status === 'empty') {
    return `Project slot ${slot} on ${where} was read-checked and is empty, nothing to overwrite.`;
  }
  if (probe.status === 'occupied') {
    const what = probe.name || `Project ${slot + 1}`;
    throw new DispatchError(
      'overwrite_confirmation_required',
      DEVICE_LABEL,
      `Project slot ${slot} on ${where} already holds "${what}" (the device shows it as "Project ${slot + 1}"). ` +
      `Writing here OVERWRITES that project permanently. Tell the user what is stored there and ask before ` +
      `replacing it, then re-call with confirm_overwrite:true. To keep both, pick an empty slot instead.`,
      { retry_action: `Re-call with confirm_overwrite:true to replace "${what}", or choose an empty slot.` },
    );
  }
  // status === 'unknown': the occupancy read failed, so we cannot confirm the
  // slot is empty. Read-before-write contract: "can't confirm" → ask, never clobber.
  throw new DispatchError(
    'overwrite_confirmation_required',
    DEVICE_LABEL,
    `Could not read project slot ${slot} on ${where} to check whether it is occupied (${probe.error}), so the upload is held ` +
    `rather than risk overwriting a stored project. Reconnect_midi and retry so the slot can be read first; or, ` +
    `if the user wants to write slot ${slot} regardless, re-call with confirm_overwrite:true.`,
    { retry_action: `reconnect_midi and retry, or re-call with confirm_overwrite:true to write regardless.` },
  );
}

/**
 * Overwrite gate for SAMPLE slots. Unlike projects, the Circuit exposes no
 * sample-directory read yet, so occupancy can never be confirmed — the gate
 * therefore refuses by default (a slot that "may exist and can't be confirmed"
 * is treated as occupied) and asks for explicit authorization. When the
 * dir-listing decode lands this graduates to the same empty-slot-no-friction
 * behavior as projects. `slotsDesc` is device-facing (e.g. "slot 5" / "slots 1..8").
 */
function gateSampleOverwrite(slotsDesc: string, confirmOverwrite: boolean | undefined): void {
  if (confirmOverwrite) return;
  throw new DispatchError(
    'overwrite_confirmation_required',
    DEVICE_LABEL,
    `Uploading to sample ${slotsDesc} will OVERWRITE whatever is stored there. The Circuit offers no ` +
    `sample-directory read yet, so the tool cannot confirm the ${slotsDesc.includes('..') ? 'slots are' : 'slot is'} empty, ` +
    `so it holds the write rather than risk clobbering a sample the user made. Confirm with the user, then re-call with ` +
    `confirm_overwrite:true (loading a fresh kit is usually overwrite-intent, but check the range first).`,
    { retry_action: `Re-call with confirm_overwrite:true once the user authorizes overwriting sample ${slotsDesc}.` },
  );
}

/**
 * Gate a caller-supplied `.ncs` TEMPLATE before anything is authored onto it.
 *
 * Authoring copies the template's ~97% of constant scaffolding verbatim and
 * edits a few hundred bytes, so a template that is not a project produces an
 * authored project that is not a project either, and the failure surfaces at the
 * device as an unloadable slot rather than here as an argument error. The
 * length check alone does not catch it: a de-framed download is exactly
 * 160,780 bytes (2026-07-29, `card-backup-2026-07-27T16-49Z` pack1 project 64),
 * and if that file is sitting in the user's samples directory it is precisely
 * the kind of thing that gets picked up as a template.
 */
function assertNcsTemplate(buf: Uint8Array, path: string): void {
  if (buf.length !== NCS_FILE_SIZE) {
    throw new DispatchError('bad_location', DEVICE_LABEL, `Template is ${buf.length} bytes, expected a ${NCS_FILE_SIZE}-byte .ncs project.`);
  }
  const structure = checkNcsStructure(buf);
  if (!structure.ok) {
    throw new DispatchError(
      'bad_location', DEVICE_LABEL,
      `ncs_template '${path}' is the right size but is NOT a Circuit Tracks project. ${ncsStructureNote(structure.faults)} ` +
      `Authoring onto it would produce an unloadable project. Pick a different template; a backup entry marked ` +
      `"CRC verified" does not vouch for structure, since the device's transfer CRC covers the encoded stream, not the decoded file.`,
    );
  }
}

export const writer: DeviceWriter = {
  // ── Pure builders ────────────────────────────────────────────────
  buildSetParam(block, name, wireValue): number[] {
    return paramWire(requireParam(block, name), wireValue);
  },

  buildSwitchPreset(location): number[] {
    const proj = parseProjectNumber(location);
    return [0xc0 | ((PROJECT_CHANNEL - 1) & 0x0f), proj & 0x7f];
  },

  // ── Execute ──────────────────────────────────────────────────────
  async setParam(ctx, block, name, wireValue, _channel, instance): Promise<WriteResult> {
    const cp = requireParam(block, name);
    const ch = effectiveChannel(cp, instance);
    for (const msg of paramMessages(cp, wireValue, { channel: ch })) ctx.conn.send(msg);
    const which = ch === CH_SYNTH2 ? ' (Synth 2)' : cp.channel === CH_SYNTH1 ? ' (Synth 1)' : '';
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: wireValue,
      display_value: decodeParamWire(cp, wireValue),
      acked: true,
      info:
        `Sent on ch${ch} (${cp.addr.kind.toUpperCase()})${which}. Circuit Tracks does not acknowledge ` +
        `CC/NRPN, confirm by ear / front panel.` +
        // B5: surface a param's wire-address caveat (e.g. sidechain2.depth's
        // UNVERIFIED 2:69) at write time — a guessed address must be loud, not
        // buried in the registry, so a silent wrong-param write is visible.
        (cp.notes ? ` WARNING, UNVERIFIED ADDRESS: ${cp.notes}` : ''),
    };
  },

  async setParams(ctx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        const r = await writer.setParam!(ctx, op.block, op.name, op.value as number, op.channel, op.instance);
        writes.push(r);
        acked_count++;
      } catch (err) {
        writes.push({
          op: 'set_param',
          target: `${op.block}.${op.name}`,
          block: op.block,
          name: op.name,
          acked: false,
          warning: err instanceof Error ? err.message : String(err),
        });
        unacked_count++;
      }
    }
    return { writes, acked_count, unacked_count };
  },

  async switchPreset(ctx, location: LocationRef): Promise<WriteResult> {
    const proj = parseProjectNumber(location);      // wire, 0-based
    const shown = proj + 1;                          // what the device displays
    ctx.conn.send([0xc0 | ((PROJECT_CHANNEL - 1) & 0x0f), proj & 0x7f]);
    return {
      op: 'switch_preset',
      target: `project ${shown}`,
      acked: true,
      info:
        `Selected project ${shown} (instant) via Program Change on ch${PROJECT_CHANNEL}. ` +
        `Requires PGM Rx enabled in Setup View. For a tempo-quantized section change, send ` +
        `program 64..127 (queued) via send_program_change.`,
    };
  },

  // save_preset: persist a synth part's CURRENT (RAM) sound to a Flash PATCH
  // slot. The save reads the chosen part's live buffer back via a Dump Request
  // (instance 1 = Synth 1, 2 = Synth 2), then re-frames the SAME 340-byte body
  // as a "Replace Patch" (Flash) write — the body round-trips verbatim as an
  // opaque container, so NO structured decode is needed to PRESERVE a sound
  // (only to read/author one). The overwrite gate is the device-agnostic one
  // (reader.checkOverwriteTarget refuses-by-default since a Flash slot can't be
  // previewed); the explicit save_preset call IS the save authorization, so
  // there is no separate save-auth check here.
  async savePreset(ctx, location: LocationRef, name?: string, instance?: number): Promise<WriteResult> {
    const patchNum = parsePatchNumber(location);
    const loc = instanceToSynthLoc(instance);
    const synthLabel = loc === 0 ? 'Synth 1' : 'Synth 2';
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        `save_preset needs a bidirectional MIDI connection (input + output): it reads ${synthLabel}'s current ` +
        `sound back from the device before writing it to a Flash patch slot. The Circuit input port was not available.`,
      );
    }
    const read = await readCurrentPatch(ctx.conn, loc, { reconnect: ctx.reconnect });
    if (!read.ok || !read.body) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        `Could not read ${synthLabel}'s current patch to save it: ${read.error ?? 'no reply'}. Make sure the Circuit ` +
        `is powered, USB-connected, and not mid-transfer; reconnect_midi and retry.`,
      );
    }
    const body = Uint8Array.from(read.body);
    const renamed = name && name.length > 0 ? name.slice(0, NAME_LEN) : undefined;
    if (renamed !== undefined) encodePatchName(body, name!); // encodePatchName truncates/pads to 16
    // Persist via savePatch — the HARDWARE-CONFIRMED protocol (2026-07-03, survives
    // power-cycle): a file-transfer session (OPEN → handshake → browse → CLOSE →
    // post-CLOSE 0x08) wraps a byte-CLEAN Replace-Patch (body[17]=0x00, the dirty
    // marker cleared) sent FIRE-AND-FORGET as the last message. The device commits
    // to flash silently over a few seconds; any session opened afterward aborts it.
    const result = await savePatch(ctx.conn, Array.from(body), patchNum);
    if (!result.ok) {
      throw new DispatchError('no_ack', DEVICE_LABEL, `save_preset failed to send: ${result.error ?? 'unknown'}. reconnect_midi and retry.`);
    }
    return {
      op: 'save_preset',
      target: `patch slot ${patchNum}`,
      acked: true, // "sent": the Circuit commits silently; confirmed to persist across power-cycle
      info:
        `Saved ${synthLabel}'s current sound to patch slot ${patchNum}` +
        (renamed !== undefined ? ` as "${renamed}"` : '') +
        (name && name.length > NAME_LEN ? ` (name truncated to ${NAME_LEN} chars)` : '') +
        `. On the device it is Patch ${patchNum + 1} (the UI numbers patches from 1). The write is fire-and-forget: ` +
        `the Circuit commits to flash silently over a few seconds and keeps it across a power-cycle ` +
        `(hardware-confirmed 2026-07-03). Load Patch ${patchNum + 1} on the synth to hear it, or read it back with ` +
        `get_preset("patch:${patchNum}") (it reflects save_preset writes).`,
    };
  },

  // ncs_upload realizer (apply_pattern mode:ncs_upload). Template-modify a real
  // project file from the compiled pattern — drum tracks AND the four note
  // tracks (Synth1/Synth2 internal, MIDI1/MIDI2 to external gear), routed by
  // channel — then push it to a stored slot over SysEx. Hardware-confirmed
  // transport (2026-06-18). The dispatcher only routes ncs_upload here;
  // live_stream / record_capture use the shared realizers.
  async realizePattern(ctx, plan) {
    const up = plan.upload;
    if (!up) {
      throw new DispatchError('capability_not_supported', DEVICE_LABEL, 'ncs_upload requires ncs_slot.');
    }
    if (!up.template_path) {
      throw new DispatchError(
        'capability_not_supported', DEVICE_LABEL,
        'ncs_upload requires ncs_template: a path to an exported .ncs project to modify (the device cannot author one from scratch). Export one via Components or the microSD Sessions folder.',
      );
    }
    const dryRun = up.dry_run === true;
    if (!ctx.conn.hasInput && !dryRun) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'ncs_upload needs a bidirectional MIDI connection (input + output) to read the transfer ACKs; the Circuit input port was not available.',
      );
    }
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(readFileSync(up.template_path));
    } catch (err) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Could not read ncs_template '${up.template_path}': ${err instanceof Error ? err.message : String(err)}`);
    }
    assertNcsTemplate(buf, up.template_path);

    // Author the compiled pattern onto pattern 0 of every track it touches
    // (drums by note→pad on ch10; melodic voices onto the note tracks by
    // channel). When a note track is written, the project scale is set so the
    // authored pitches play right — Chromatic (literal) by default, or the
    // caller's `scale`. Refuse an empty author rather than uploading unchanged.
    // `preserve_template_gates` defaults to PRESERVING: the destructive
    // direction (flatten the template's hand-set note lengths and ties) is the
    // one a caller has to ask for explicitly.
    // Stored tempo, before the authoring: a caller-stated tempo replaces the
    // template's, and an unstated one is reported rather than left silent.
    const tempoNote = applyStoredTempo(buf, up);
    // Stored pad colour, same contract as the tempo above it: an asked-for
    // colour is stamped at birth, an unstated one is reported rather than
    // silently inherited. Undefined touches no byte.
    const colourNote = applyStoredColour(buf, up);
    // Stored project NAME, same contract again: stamped at birth or reported
    // inherited, refused (over-long / non-ASCII) before anything else runs.
    const nameNote = applyStoredName(buf, up);
    const authored = authorPlanIntoProject(buf, plan, up.scale, 0, up.preserve_template_gates !== false);
    // Stored mixer levels (explicit keys + the stored-silent synth default),
    // AFTER the authoring pass so a named drum track overrides the condensed
    // kit's stored 0 (the more specific instruction wins), exactly as an
    // explicit drum_flips slot beats a role flip.
    const mixerNote = applyMixerLevels(buf, up);
    if (authored.drum_tracks.length === 0 && authored.note_tracks.length === 0) {
      throw new DispatchError(
        'capability_not_supported', DEVICE_LABEL,
        'Pattern produced no Circuit-routable events: drum voices land on ch10 pads (kick/snare/hat/clap) and ' +
        'melodic voices on the note tracks (synth1/synth2/midi1/midi2). Nothing was uploaded.',
      );
    }
    const tracksDesc = [
      ...authored.drum_tracks.sort((a, b) => a - b).map((t) => `Drum${t + 1}`),
      ...authored.note_tracks,
    ].join(', ');

    // Dry run: the authoring (against the local template) already validated
    // everything device-independent; report what WOULD happen and stop —
    // no slot read, no gate, no transfer.
    if (dryRun) {
      const dryScaleNote = authored.scale_set && authored.prior_scale
        ? describeScaleChange(authored.prior_scale, authored.scale_set, authored.out_of_scale ?? 0)
        : '';
      return {
        ok: true, mode: 'ncs_upload', status: 'dry_run',
        info:
          `DRY RUN: nothing was sent (no reads, no gate, no transfer). "${plan.pattern_name}" authored cleanly against the template. ` +
          `Would write project slot ${up.slot} (shown as "Project ${up.slot + 1}") on ${packLabel(ctx.pack)} after the overwrite gate. Tracks: ${tracksDesc}.${dryScaleNote}` +
          tempoNote +
          colourNote +
          nameNote +
          drumLevelNote(authored.drum_levels) +
          mixerNote +
          gatePreserveNote([authored]) +
          ((authored.flips_applied ?? 0) > 0 ? ` Sample flips: ${authored.flips_applied}.` : '') +
          (authored.flip_warnings && authored.flip_warnings.length > 0 ? ` Flip warnings: ${authored.flip_warnings.join('; ')}.` : '') +
          (authored.unrouted > 0 ? ` ${authored.unrouted} event(s) could not be placed.` : '') +
          ' Re-call without dry_run to write it.',
      };
    }

    // Overwrite gate: ncs_upload writes a STORED project slot, so it honors the
    // same read-before-write contract as upload_project. An empty slot writes
    // through; an occupied one refuses unless the user authorized the overwrite.
    const gateNote = await gateProjectOverwrite(ctx, up.slot, up.confirm_overwrite);

    const res = await uploadProjectTransport(ctx.conn, buf, up.slot, { pack: ctx.pack, reconnect: ctx.reconnect });
    if (!res.ok) {
      return { ok: false, mode: 'ncs_upload', status: 'error', warning: `Upload failed: ${res.error}.` };
    }
    // The SysEx transfer is hardware-confirmed end-to-end (acked), the drum
    // codec is, and the note-track (melodic) authoring leg is too: a 2026-06-19
    // device test uploaded a SINGLE-NOTE octave bassline (Synth 1) + a kick
    // (Drum 1), loaded it, and played it back on the device's own clock — steps
    // + pitches correct. Chord WRITE is byte-identical (same setNotePattern + the
    // already-hw-confirmed 28-byte step format), but chord PLAYBACK under a
    // non-Chromatic scale is not yet hardware-checked (two authored notes can
    // collapse onto one scale degree); the out-of-scale advisory below flags that.
    const scaleNote = authored.scale_set && authored.prior_scale
      ? describeScaleChange(authored.prior_scale, authored.scale_set, authored.out_of_scale ?? 0)
      : '';
    // Pattern LENGTH is set for every authored track (drum blocks HW-confirmed
    // 2026-06-22; note blocks HW-confirmed 2026-06-30), so a short pattern plays
    // its real length, not 32 with a silent tail.
    const lengthNote = plan.steps < 32
      ? ` Pattern length set to ${plan.steps} steps automatically on all authored tracks (no silent tail).`
      : '';
    const flipNote = (authored.flips_applied ?? 0) > 0
      ? ` Sample flips: ${authored.flips_applied} step(s) flipped to other sample slots, so multiple drum pieces share one track.`
      : '';
    const flipWarnNote = authored.flip_warnings && authored.flip_warnings.length > 0
      ? ` Flip warnings: ${authored.flip_warnings.join('; ')}.`
      : '';
    return {
      ok: true,
      mode: 'ncs_upload',
      status: 'uploaded',
      // B3: "acked" = every transfer FRAME was device-acked (frame-level
      // handshake). We do NOT yet decode the device's final CRC PASS/FAIL
      // verdict — the protocol CRC-gates the commit, but reading that verdict
      // back is a follow-up. The INFO text states this so the receipt is honest.
      source: 'device_confirmed',
      info:
        `Uploaded "${plan.pattern_name}" to project slot ${up.slot} on ${packLabel(ctx.pack)} (${res.blocks} blocks, all frames acked; ` +
        `the device's final CRC verdict is not yet read back). ${gateNote} ` +
        `Tracks written: ${tracksDesc}.${scaleNote}${lengthNote}${flipNote}${flipWarnNote}${tempoNote}${colourNote}${nameNote}${drumLevelNote(authored.drum_levels)}${mixerNote}${gatePreserveNote([authored])} On the device: select ${packLabel(ctx.pack)}, then Projects view, load project slot ${up.slot}, ` +
        `shown as "Project ${up.slot + 1}" (the device numbers projects from 1).` +
        (authored.unrouted > 0
          ? ` Note: ${authored.unrouted} event(s) could not be placed (a ch10 note that is not a pad, or a chord past the 6-note slot limit).`
          : ''),
    };
  },

  // Arrangement realizer (apply_pattern `arrangement`): author a MULTI-SECTION
  // song into one project — each section its own pattern slot(s), advanced by a
  // pattern chain (HW-confirmed) or a scene-chain (community-beta) — then push
  // it, same transport + gates as realizePattern.
  async realizeArrangement(ctx, sections, order, up) {
    if (!up.template_path) {
      throw new DispatchError(
        'capability_not_supported', DEVICE_LABEL,
        'Arrangement upload requires ncs_template: a path to an exported .ncs project to modify (the device cannot author one from scratch).',
      );
    }
    const dryRun = up.dry_run === true;
    if (!ctx.conn.hasInput && !dryRun) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'ncs_upload needs a bidirectional MIDI connection (input + output) to read the transfer ACKs; the Circuit input port was not available.',
      );
    }
    if (up.drum_flips && Object.keys(up.drum_flips).length > 0) {
      throw new DispatchError(
        'capability_not_supported', DEVICE_LABEL,
        'drum_flips is per-step within ONE pattern and is not yet supported with `arrangement` (ambiguous across sections). Drop it or author a single pattern.',
      );
    }
    let buf: Uint8Array;
    try {
      buf = new Uint8Array(readFileSync(up.template_path));
    } catch (err) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Could not read ncs_template '${up.template_path}': ${err instanceof Error ? err.message : String(err)}`);
    }
    assertNcsTemplate(buf, up.template_path);
    // One project, one stored tempo — an arrangement's sections all play at it.
    const tempoNote = applyStoredTempo(buf, up);
    // One project, one pad colour: the whole song is a single lit pad in
    // Projects View, whatever its section count. Undefined touches no byte.
    const colourNote = applyStoredColour(buf, up);
    // One project, one stored NAME too. Undefined touches no byte.
    const nameNote = applyStoredName(buf, up);

    const res = authorArrangementIntoProject(
      buf, sections, order, up.scale, up.drum_binding, up.drum_levels,
      up.preserve_template_gates !== false, up.scene_plan,
    );
    // Stored mixer levels (explicit keys + the stored-silent synth default),
    // AFTER the arrangement authoring so a named drum track overrides the
    // condensed kit's project-global stored 0.
    const mixerNote = applyMixerLevels(buf, up);
    if (res.union_drums.length === 0 && res.union_notes.length === 0) {
      throw new DispatchError(
        'capability_not_supported', DEVICE_LABEL,
        'Arrangement produced no Circuit-routable events: drum voices land on ch10 pads and melodic voices on the note tracks. Nothing was uploaded.',
      );
    }

    const tracksDesc = [
      ...res.union_drums.map((t) => `Drum${t + 1}`),
      ...res.union_notes,
    ].join(', ');
    const slotDesc = res.layout.slots.map((n, i) => `pattern ${i + 1}=${n}`).join(', ');
    const advanceDesc = res.layout.kind === 'chain'
      ? `patterns 1..${res.layout.slots.length} auto-advance via the pattern chain (HW-confirmed primitive; ranges past [1,2] are decoded-beta) and loop`
      : res.layout.kind === 'scenes'
        ? `${res.layout.scenes!.length} scene steps (${res.layout.scenes!.map((r) => r.start === r.end ? `pattern ${r.start + 1}` : `patterns ${r.start + 1}-${r.end + 1}`).join(' → ')})` +
          `${up.scene_plan !== undefined ? ', grouped exactly as scene_plan asked,' : ''} auto-advance and loop; the template's plain pattern-chain was cleared on the authored tracks so it cannot shadow the scenes. ` +
          'COMMUNITY-BETA: the per-scene pattern tables were decoded 2026-07-01 from one capture; confirm by ear'
        : 'a single pattern loops';
    const unrouted = res.authored.reduce((n, a) => n + a.unrouted, 0);
    const firstScale = res.authored.find((a) => a.scale_set);
    const scaleNote = firstScale?.scale_set && firstScale.prior_scale
      ? describeScaleChange(firstScale.prior_scale, firstScale.scale_set, Math.max(...res.authored.map((a) => a.out_of_scale ?? 0)))
      : '';
    // Flip warnings, surfaced like the single-pattern path does: a skipped flip
    // (e.g. a condensed piece the custom drum_binding cannot locate) must reach
    // the receipt, not sit silently on the per-section results.
    const arrFlipWarnings = res.authored.flatMap((a) => a.flip_warnings ?? []);
    const flipWarnNote = arrFlipWarnings.length > 0 ? ` Flip warnings: ${arrFlipWarnings.join('; ')}.` : '';

    // Dry run: the layout fit-check + authoring already ran against the local
    // template; report the would-be project and stop — no reads, no transfer.
    if (dryRun) {
      return {
        ok: true, mode: 'ncs_upload' as const, status: 'dry_run',
        info:
          `DRY RUN: nothing was sent (no reads, no gate, no transfer). The ${sections.length}-section arrangement authored cleanly ` +
          `and FITS: ${slotDesc}. Advance: ${advanceDesc}. Tracks: ${tracksDesc}.${scaleNote}${flipWarnNote}${tempoNote}${colourNote}${nameNote}${drumLevelNote(up.drum_levels)}${mixerNote}${gatePreserveNote(res.authored)}` +
          (unrouted > 0 ? ` ${unrouted} event(s) could not be placed.` : '') +
          ` Would write project slot ${up.slot} (shown as "Project ${up.slot + 1}") on ${packLabel(ctx.pack)} after the overwrite gate. Re-call without dry_run to write it.`,
      };
    }

    const gateNote = await gateProjectOverwrite(ctx, up.slot, up.confirm_overwrite);
    const sent = await uploadProjectTransport(ctx.conn, buf, up.slot, { pack: ctx.pack, reconnect: ctx.reconnect });
    if (!sent.ok) {
      return { ok: false, mode: 'ncs_upload' as const, status: 'error', warning: `Upload failed: ${sent.error}.` };
    }
    return {
      ok: true,
      mode: 'ncs_upload' as const,
      status: 'uploaded',
      source: 'device_confirmed',
      info:
        `Uploaded a ${sections.length}-section arrangement to project slot ${up.slot} on ${packLabel(ctx.pack)} (${sent.blocks} blocks, all frames acked; ` +
        `the device's final CRC verdict is not yet read back). ${gateNote} ` +
        `Sections: ${slotDesc}. Advance: ${advanceDesc}. Tracks written: ${tracksDesc}.${scaleNote}${flipWarnNote}${tempoNote}${colourNote}${nameNote}${drumLevelNote(up.drum_levels)}${mixerNote}${gatePreserveNote(res.authored)} ` +
        `On the device: select ${packLabel(ctx.pack)}, then Projects view, load slot ${up.slot}, shown as "Project ${up.slot + 1}".` +
        (unrouted > 0 ? ` Note: ${unrouted} event(s) could not be placed.` : ''),
    };
  },

  async uploadSample(ctx, wav, slot, filename, opts?: SlotWriteOptions): Promise<SampleUploadOutcome> {
    // Circuit's pool is slot-addressed: a destination slot is required (unlike
    // append-only pools such as the SPD-SX wave pool, where the dispatcher
    // passes undefined and the device allocates the next index).
    if (slot === undefined) {
      throw new DispatchError(
        'bad_location', DEVICE_LABEL,
        'Circuit Tracks sample slots are slot-addressed: pass a destination slot 1..64.',
      );
    }
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'upload_sample needs a bidirectional MIDI connection (input + output) to read the transfer ACKs; the Circuit input port was not available.',
      );
    }
    // Overwrite gate: sample slots can't be read to check occupancy, so refuse
    // unless the user authorized the overwrite (see SAFE-EDIT-WORKFLOW.md).
    gateSampleOverwrite(`slot ${slot + 1}`, opts?.confirmOverwrite);
    // Reconnect-before-transfer (restart-research H2): refresh a possibly idle-
    // suspended handle before the burst so it self-heals instead of no-ACKing.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const r = await uploadSampleDriver(conn, wav, slot, filename, { reconnect: ctx.reconnect, packIndex: ctx.pack });
    const where = packLabel(ctx.pack);
    if (!r.ok) {
      return {
        ok: false, slot, blocks: r.blocks, converted: r.converted, filename, info: '',
        warning: `Sample upload to slot ${slot + 1} on ${where} failed: ${r.error}. The device may be busy (being played) or the handle stale; reconnect_midi and retry.`,
      };
    }
    const packNote = (ctx.pack ?? 0) !== 0
      ? ` Writing samples to a NONZERO pack is hardware-confirmed (2026-07-27): 63 slots were cloned onto Pack 2 and read back off the device byte-identical (md5), and a deliberately out-of-order write landed at its own index, so the slot byte is ADDRESSED, not append-ordered.`
      : '';
    return {
      ok: true, slot, blocks: r.blocks, converted: r.converted, filename,
      // The wire frames are byte-identical to a real Components capture
      // (verify-circuit-ncs-transfer); the upload is acked frame-by-frame. The
      // device's final CRC verdict is not yet read back — stated honestly here.
      info:
        `Uploaded "${filename}" to sample slot ${slot + 1} (device shows 1..64; wire slot ${slot}) on ${where}, ${r.blocks} blocks, all frames acked. ` +
        `${r.note} ` +
        `This OVERWROTE sample slot ${slot + 1} on ${where}; its previous sample is gone (overwrite was authorized via confirm_overwrite). ` +
        `Read that pack's pool with list_samples pack:${(ctx.pack ?? 0) + 1} and target the SAME pack when you write the project, or the project's drum bindings point at a different pool.${packNote} ` +
        `On the device: select ${where}, then any Drum track, open Sample (two pages of 32), the new sample is at position ${slot + 1}. ` +
        `The device's final CRC verdict is not read back yet. ` +
        `VERIFY-TOO-SOON WARNING: the device flushes a pack's sample manifest roughly 6-8 SECONDS AFTER the transfer session closes, so a list_samples taken straight afterwards can report this slot empty while the write is perfectly fine. Wait ~10 s and re-read before concluding anything, and never re-send on the strength of one early read: this device has no erase.`,
    };
  },

  // Upload a prepared whole-project .ncs VERBATIM to a project slot (the
  // "play a pre-made project" path, e.g. the swappable groove sets). Distinct
  // from realizePattern, which AUTHORS a pattern into a template before sending;
  // here the file is already complete and goes byte-for-byte. Same hardware-
  // confirmed transport (2026-06-18).
  async uploadProject(ctx, project, slot, opts?: SlotWriteOptions): Promise<ProjectUploadOutcome> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'upload_project needs a bidirectional MIDI connection (input + output) to read the transfer ACKs; the Circuit input port was not available.',
      );
    }
    if (project.length !== NCS_FILE_SIZE) {
      throw new DispatchError(
        'bad_location', DEVICE_LABEL,
        `Project file is ${project.length} bytes, expected a ${NCS_FILE_SIZE}-byte .ncs project. Export one from Components or the microSD Sessions folder.`,
      );
    }
    // STRUCTURAL PRE-FLIGHT. Right length is not the same as right file: a
    // de-framed download is exactly the right length and is not a project
    // (2026-07-29, `card-backup-2026-07-27T16-49Z` pack1 project 64). Writing one
    // into a slot destroys whatever was there and leaves an unloadable project.
    // `delete_project` can now erase it (2026-07-29 decode), but erase is not a
    // repair: the prior contents are gone either way, so the cheap fix is to
    // refuse the bad file here rather than to rely on cleanup afterwards.
    // Refuse here, at the tool boundary, so the caller gets a structured error
    // naming the fault rather than the transport's RangeError backstop.
    const structure = checkNcsStructure(project);
    if (!structure.ok) {
      throw new DispatchError(
        'bad_location', DEVICE_LABEL,
        `Refusing to upload: this file is the right size but is NOT a Circuit Tracks project. ` +
        `${ncsStructureNote(structure.faults)} ` +
        `If it came from a backup, note that a "CRC verified" backup entry does NOT vouch for this: the ` +
        `device's transfer CRC covers the encoded stream, not the decoded file. Restore from a different copy.`,
      );
    }
    // Overwrite gate: read the slot first (unless authorized). Empty → write
    // through; occupied → refuse and name what's there (see SAFE-EDIT-WORKFLOW.md).
    const gateNote = await gateProjectOverwrite(ctx, slot, opts?.confirmOverwrite);
    // Reconnect-before-transfer (Circuit restart-research H2): the handle has been
    // idle since the last tool call and may be USB-suspended/poisoned; a stale
    // handle silently no-ACKs the session open, indistinguishable from "device
    // busy". Refresh it FIRST so the idle/suspend case self-heals without a manual
    // reconnect_midi, and a subsequent no-ACK is genuinely a busy/held device.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const r = await uploadProjectTransport(conn, project, slot, { pack: ctx.pack, reconnect: ctx.reconnect });
    if (!r.ok) {
      return {
        ok: false, slot, blocks: r.blocks, info: '',
        warning: `Project upload to slot ${slot} failed: ${r.error}. The device may be busy (being played) or the handle stale; reconnect_midi and retry.`,
      };
    }
    return {
      ok: true, slot, blocks: r.blocks,
      // The project file-transfer is hardware-confirmed end-to-end (2026-06-18);
      // every frame is acked. The device's final CRC verdict is not read back.
      info:
        `Uploaded a ${NCS_FILE_SIZE}-byte project to slot ${slot} on ${packLabel(ctx.pack)} (${r.blocks} blocks, all frames acked; ` +
        `the device's final CRC verdict is not yet read back). ${gateNote} ` +
        `On the device: select ${packLabel(ctx.pack)}, then Projects view, load project slot ${slot}, shown as "Project ${slot + 1}" ` +
        `(the device numbers projects from 1). Each drum track plays whatever sample is assigned in ` +
        `Drum track > Sample, so load the matching kit (upload_sample / upload_kit) and assign D1..D4.`,
    };
  },

  async uploadKit(ctx, items, opts?: SlotWriteOptions): Promise<KitUploadOutcome> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'upload_kit needs a bidirectional MIDI connection (input + output) to read the transfer ACKs; the Circuit input port was not available.',
      );
    }
    if (items.length === 0) {
      return { ok: false, uploaded: [], info: '', warning: 'No samples to upload.' };
    }
    // Overwrite gate for the whole slot range (sample slots can't be read to
    // check occupancy, so authorize once for the batch — see SAFE-EDIT-WORKFLOW.md).
    const loSlot = items[0].slot + 1;
    const hiSlot = items[items.length - 1].slot + 1;
    gateSampleOverwrite(loSlot === hiSlot ? `slot ${loSlot}` : `slots ${loSlot}..${hiSlot}`, opts?.confirmOverwrite);

    // Per-sample sessions (known-working: lands audio). On the first failure STOP.
    // Reconnect-before-transfer (restart-research H2): refresh a possibly idle-
    // suspended handle before the batch so it self-heals instead of no-ACKing.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const r = await uploadSampleKit(conn, items, { reconnect: ctx.reconnect, packIndex: ctx.pack });
    const where = packLabel(ctx.pack);
    if (!r.ok) {
      return {
        ok: false, uploaded: [],
        failed: { slot: items[0].slot, filename: items[0].filename, error: r.error ?? 'unknown' },
        info: 'Kit upload session failed; the session is atomic, so treat all slots as unwritten.',
        warning: `Kit upload to ${where} failed: ${r.error}. Call reconnect_midi and retry the whole kit.`,
      };
    }
    const uploaded = r.uploaded.map((u) => ({ slot: u.slot, filename: u.filename, converted: u.converted }));
    const converted = uploaded.filter((u) => u.converted).length;
    const packNote = (ctx.pack ?? 0) !== 0
      ? ` Writing samples to a NONZERO pack is hardware-confirmed (2026-07-27: a 63-slot clone onto Pack 2, read back byte-identical, with the slot byte proven ADDRESSED rather than append-ordered).`
      : '';
    return {
      ok: true, uploaded,
      info:
        `Uploaded ${uploaded.length} sample(s) to slots ${loSlot}..${hiSlot} (device 1..64) on ${where} in one sample-directory session, all frames acked` +
        (converted ? `; ${converted} normalized to 48 kHz mono 16-bit` : '') + '. ' +
        `Each OVERWROTE its slot's previous sample on ${where} (overwrite authorized via confirm_overwrite). ` +
        `Written with the capture-proven sample-directory prelude (0x05 dir + 0x0d scan) that commits the pack manifest; ` +
        `confirm by ear, and that they survive a device restart. Target the SAME pack when writing the project that binds these slots.${packNote} ` +
        `VERIFY-TOO-SOON WARNING: that manifest is flushed roughly 6-8 SECONDS AFTER the session closes, so a list_samples taken straight afterwards can report these slots empty while the write is fine. Wait ~10 s and re-read before concluding a failure; there is no erase, so a needless re-send is not free. ` +
        `On the device: select ${where}, then Drum track > Sample positions ${loSlot}..${hiSlot}.`,
    };
  },

  /**
   * ERASE stored projects. The wire half only: for each slot this reads
   * occupancy one instruction before the destructive frame, refuses that slot
   * unless it reads OCCUPIED, sends the delete, requires the device's ack for
   * that exact slot, and re-reads. Evidence + frame shapes: `ncs/fileDelete.ts`.
   *
   * It does NOT back anything up, check authorization, or enforce the per-call
   * ceiling. Those gates are in `dispatcher/deleteProject.ts` so they are
   * enforced once for every device and can be tested without hardware, and so a
   * new project-memory device inherits them on registration day. A caller that
   * reaches this method has already passed them; nothing here re-checks, which is
   * exactly why nothing but the dispatcher may call it.
   *
   * The in-session re-read is only HALF the verification. The other oracle, the
   * pack directory, is read afterwards in a FRESH session by the dispatcher,
   * because this device flushes its pack manifest seconds after a session closes
   * and a directory read taken too soon lies.
   */
  async deleteProjects(ctx, slots): Promise<readonly ProjectDeleteResult[]> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'Deleting a project needs a bidirectional MIDI connection (input + output): the slot must be read before it is erased and re-read afterwards, and the Circuit input port was not available. Close Novation Components so the port is free, then retry.',
      );
    }
    // Reconnect-before-transfer (restart-research H2), same as every other
    // session-driving path here: a handle idle since the last tool call may be
    // USB-suspended, and a stale handle no-ACKs indistinguishably from a busy
    // device. On a delete that matters more than usual, because "no answer" has
    // to be reported as "the slot's state is UNKNOWN", which is the worst
    // outcome available.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const wire = await deleteSlots(conn, FILE_TYPE.PROJECT, slots.map((s) => s - 1), { pack: ctx.pack });
    return wire.map((r) => ({
      slot: r.slot + 1,
      ok: r.ok,
      gone_by_query: r.gone_by_query,
      error: r.error,
    }));
  },
};
