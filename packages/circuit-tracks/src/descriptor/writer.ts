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
  ProjectUploadOutcome,
  SampleUploadOutcome,
  SlotWriteOptions,
  WriteOp,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { rollVelocity } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

import { readFileSync } from 'node:fs';

import type { RealizePlan } from '@mcp-midi-control/core/protocol-generic/types.js';

import { CH_SYNTH1, CH_SYNTH2, CH_MIDI1, CH_MIDI2, CH_DRUMS, decodeParamWire, findParam, listParamNames, type CircuitParam } from '../params.js';
import { paramMessages, paramWire } from '../codec/live.js';
import { encodePatchName, NAME_LEN } from '../codec/blob.js';
import { readCurrentPatch, savePatch, instanceToSynthLoc } from '../codec/patchTransfer.js';
import { META_OFFSETS, NCS_FILE_SIZE, NOTE_SLOTS_PER_STEP, PATTERNS_PER_TRACK, STEPS_PER_PATTERN, drumBlockIndex, noteBlockIndex, type NoteTrack } from '../ncs/format.js';
import { setDrumPattern } from '../ncs/drumPattern.js';
import { setDrumSampleBinding, DEFAULT_DRUM_BINDING, NUM_DRUM_TRACKS as DRUM_TRACK_COUNT } from '../ncs/drumBinding.js';
import { setNotePattern, DEFAULT_GATE, type NoteSlot } from '../ncs/notePattern.js';
import { setDrumChain, setNoteChain } from '../ncs/chain.js';
import { setSceneChain, setSceneDrumChain, setSceneNoteChain } from '../ncs/sceneChain.js';
import {
  getProjectScale, setProjectScale, resolveScaleName, notesOutsideScale, describeScaleChange,
  SCALE_CHROMATIC, type ProjectScale,
} from '../ncs/scale.js';
import { uploadProject as uploadProjectTransport, probeProjectSlot } from '../ncs/uploadProject.js';
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
  flip_warnings?: string[];  // flips that could not be applied (rest step, bad range)
  /** The project scale before authoring, when a note track was written (else undefined). */
  prior_scale?: ProjectScale;
  /** The scale the project was set to (Chromatic by default, or the caller's choice). */
  scale_set?: ProjectScale;
  /** Distinct authored pitch-classes a chosen non-Chromatic scale will shift on playback (0 = none / Chromatic). */
  out_of_scale?: number;
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
 */
export function authorPlanIntoProject(buf: Uint8Array, plan: RealizePlan, scale?: string, patternIndex = 0): AuthoredTracks {
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
  let unrouted = 0;

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
      for (let k = 0; k < n && slots.length < NOTE_SLOTS_PER_STEP; k++) {
        const delay = Math.round((k * 5) / (n - 1)); // n > 1 ⇒ n-1 >= 1
        // Retriggers DECAY like real roll bounces (rollVelocity) — identical
        // velocities are the "machine-gun" tell on velocity-sensitive pads.
        slots.push({ note: e.note, gate: DEFAULT_GATE, delay, velocity: rollVelocity(e.velocity, k) });
        placed++;
      }
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
    // gate is a full step (DEFAULT_GATE): the event's duration_ms is deliberately
    // NOT mapped — the Circuit gate is a 0..6 micro-tick field, not milliseconds,
    // and the neutral model has no per-step duration input, so every authored
    // note gets a clean one-step gate (live_stream honors duration_ms; the .ncs
    // doesn't carry it).
    slots.push({ note: e.note, gate: DEFAULT_GATE, delay: micro, velocity: e.velocity });
  }

  // Per-step SAMPLE FLIPS (ncs_upload): set a hit's drum_choice to an absolute
  // sample slot 0..63 so that step plays a DIFFERENT sample than the track's
  // default — the device's Sample Flip feature, which lets several drum pieces
  // (kick + snare + sticks) live on ONE track. A flip on a rest is reported and
  // ignored (a flip only colours an existing hit). HW-confirmed encoding.
  const flipWarnings: string[] = [];
  let flipsApplied = 0;
  const drumFlips = plan.upload?.drum_flips;
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
  for (const [track, cells] of noteGrids) setNotePattern(buf, track, patternIndex, cells);
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

  const result: AuthoredTracks = {
    drum_tracks: [...drumGrids.keys()],
    note_tracks: [...noteGrids.keys()],
    unrouted,
    flips_applied: flipsApplied,
    ...(drumBinding ? { drum_binding: drumBinding } : {}),
    ...(flipWarnings.length > 0 ? { flip_warnings: flipWarnings } : {}),
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
  if (order.length <= PATTERNS_PER_TRACK) {
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
    authored.push(authorPlanIntoProject(buf, slotPlans[slot].plan, scale, slot));
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
        : `Unknown block '${block}'. Call list_params({port:"circuit"}) for the param surface.`,
      known.length > 0 ? { valid_options: known } : { retry_action: 'list_params({port:"circuit"})' },
    );
  }
  return cp;
}

function parseProjectNumber(location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
  if (!Number.isInteger(n) || n < 0 || n > 63) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `Project number must be 0..63 (instant recall), got '${location}'. For queued switching send_program_change(channel:16, program:64..127).`,
    );
  }
  return n;
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
 * Overwrite gate for a PROJECT slot (cf. `docs/SAFE-EDIT-WORKFLOW.md`). The
 * Circuit's project slots are readable, so the gate is occupancy-driven rather
 * than a blanket refuse-by-default: an EMPTY slot is written without friction;
 * an OCCUPIED slot — or one whose occupancy could not be confirmed — is held
 * unless the user authorized the overwrite (`confirmOverwrite`). On a refusal it
 * throws `overwrite_confirmation_required`, which the unified tool handler
 * formats into the canonical refusal text. Returns a short note (for the success
 * receipt) when the write is allowed to proceed. Costs one slot READ on the
 * non-confirmed path only.
 */
async function gateProjectOverwrite(
  ctx: DispatchCtx, slot: number, confirmOverwrite: boolean | undefined,
): Promise<string> {
  if (confirmOverwrite) return `Overwrite authorized by the user for project slot ${slot}.`;
  const probe = await probeProjectSlot(ctx.conn, slot, { reconnect: ctx.reconnect });
  if (probe.status === 'empty') {
    return `Project slot ${slot} was read-checked and is empty, nothing to overwrite.`;
  }
  if (probe.status === 'occupied') {
    const what = probe.name || `Project ${slot + 1}`;
    throw new DispatchError(
      'overwrite_confirmation_required',
      DEVICE_LABEL,
      `Project slot ${slot} already holds "${what}" (the device shows it as "Project ${slot + 1}"). ` +
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
    `Could not read project slot ${slot} to check whether it is occupied (${probe.error}), so the upload is held ` +
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
    const proj = parseProjectNumber(location);
    ctx.conn.send([0xc0 | ((PROJECT_CHANNEL - 1) & 0x0f), proj & 0x7f]);
    return {
      op: 'switch_preset',
      target: `project ${proj}`,
      acked: true,
      info:
        `Selected project ${proj} (instant) via Program Change on ch${PROJECT_CHANNEL}. ` +
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
    if (buf.length !== NCS_FILE_SIZE) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Template is ${buf.length} bytes, expected a ${NCS_FILE_SIZE}-byte .ncs project.`);
    }

    // Author the compiled pattern onto pattern 0 of every track it touches
    // (drums by note→pad on ch10; melodic voices onto the note tracks by
    // channel). When a note track is written, the project scale is set so the
    // authored pitches play right — Chromatic (literal) by default, or the
    // caller's `scale`. Refuse an empty author rather than uploading unchanged.
    const authored = authorPlanIntoProject(buf, plan, up.scale);
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
          `Would write project slot ${up.slot} (shown as "Project ${up.slot + 1}") after the overwrite gate. Tracks: ${tracksDesc}.${dryScaleNote}` +
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

    const res = await uploadProjectTransport(ctx.conn, buf, up.slot, { reconnect: ctx.reconnect });
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
        `Uploaded "${plan.pattern_name}" to project slot ${up.slot} (${res.blocks} blocks, all frames acked; ` +
        `the device's final CRC verdict is not yet read back). ${gateNote} ` +
        `Tracks written: ${tracksDesc}.${scaleNote}${lengthNote}${flipNote}${flipWarnNote} On the device: Projects view, load project slot ${up.slot}, ` +
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
    if (buf.length !== NCS_FILE_SIZE) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Template is ${buf.length} bytes, expected a ${NCS_FILE_SIZE}-byte .ncs project.`);
    }

    const res = authorArrangementIntoProject(buf, sections, order, up.scale, up.drum_binding);
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
        ? `${res.layout.scenes!.length} scene steps (${res.layout.scenes!.map((r) => r.start === r.end ? `pattern ${r.start + 1}` : `patterns ${r.start + 1}-${r.end + 1}`).join(' → ')}) auto-advance and loop. COMMUNITY-BETA: the per-scene pattern tables were decoded 2026-07-01 from one capture; confirm by ear`
        : 'a single pattern loops';
    const unrouted = res.authored.reduce((n, a) => n + a.unrouted, 0);
    const firstScale = res.authored.find((a) => a.scale_set);
    const scaleNote = firstScale?.scale_set && firstScale.prior_scale
      ? describeScaleChange(firstScale.prior_scale, firstScale.scale_set, Math.max(...res.authored.map((a) => a.out_of_scale ?? 0)))
      : '';

    // Dry run: the layout fit-check + authoring already ran against the local
    // template; report the would-be project and stop — no reads, no transfer.
    if (dryRun) {
      return {
        ok: true, mode: 'ncs_upload' as const, status: 'dry_run',
        info:
          `DRY RUN: nothing was sent (no reads, no gate, no transfer). The ${sections.length}-section arrangement authored cleanly ` +
          `and FITS: ${slotDesc}. Advance: ${advanceDesc}. Tracks: ${tracksDesc}.${scaleNote}` +
          (unrouted > 0 ? ` ${unrouted} event(s) could not be placed.` : '') +
          ` Would write project slot ${up.slot} (shown as "Project ${up.slot + 1}") after the overwrite gate. Re-call without dry_run to write it.`,
      };
    }

    const gateNote = await gateProjectOverwrite(ctx, up.slot, up.confirm_overwrite);
    const sent = await uploadProjectTransport(ctx.conn, buf, up.slot, { reconnect: ctx.reconnect });
    if (!sent.ok) {
      return { ok: false, mode: 'ncs_upload' as const, status: 'error', warning: `Upload failed: ${sent.error}.` };
    }
    return {
      ok: true,
      mode: 'ncs_upload' as const,
      status: 'uploaded',
      source: 'device_confirmed',
      info:
        `Uploaded a ${sections.length}-section arrangement to project slot ${up.slot} (${sent.blocks} blocks, all frames acked; ` +
        `the device's final CRC verdict is not yet read back). ${gateNote} ` +
        `Sections: ${slotDesc}. Advance: ${advanceDesc}. Tracks written: ${tracksDesc}.${scaleNote} ` +
        `On the device: Projects view, load slot ${up.slot}, shown as "Project ${up.slot + 1}".` +
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
    const r = await uploadSampleDriver(conn, wav, slot, filename, { reconnect: ctx.reconnect });
    if (!r.ok) {
      return {
        ok: false, slot, blocks: r.blocks, converted: r.converted, filename, info: '',
        warning: `Sample upload to slot ${slot + 1} failed: ${r.error}. The device may be busy (being played) or the handle stale; reconnect_midi and retry.`,
      };
    }
    return {
      ok: true, slot, blocks: r.blocks, converted: r.converted, filename,
      // The wire frames are byte-identical to a real Components capture
      // (verify-circuit-ncs-transfer); the upload is acked frame-by-frame. The
      // device's final CRC verdict is not yet read back — stated honestly here.
      info:
        `Uploaded "${filename}" to sample slot ${slot + 1} (device shows 1..64; wire slot ${slot}), ${r.blocks} blocks, all frames acked. ` +
        `${r.note} ` +
        `This OVERWROTE sample slot ${slot + 1} in the current Pack; its previous sample is gone (overwrite was authorized via confirm_overwrite). ` +
        `On the device: select any Drum track, open Sample (two pages of 32), the new sample is at position ${slot + 1}. ` +
        `The device's final CRC verdict is not read back yet.`,
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
    // Overwrite gate: read the slot first (unless authorized). Empty → write
    // through; occupied → refuse and name what's there (see SAFE-EDIT-WORKFLOW.md).
    const gateNote = await gateProjectOverwrite(ctx, slot, opts?.confirmOverwrite);
    // Reconnect-before-transfer (Circuit restart-research H2): the handle has been
    // idle since the last tool call and may be USB-suspended/poisoned; a stale
    // handle silently no-ACKs the session open, indistinguishable from "device
    // busy". Refresh it FIRST so the idle/suspend case self-heals without a manual
    // reconnect_midi, and a subsequent no-ACK is genuinely a busy/held device.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const r = await uploadProjectTransport(conn, project, slot, { reconnect: ctx.reconnect });
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
        `Uploaded a ${NCS_FILE_SIZE}-byte project to slot ${slot} (${r.blocks} blocks, all frames acked; ` +
        `the device's final CRC verdict is not yet read back). ${gateNote} ` +
        `On the device: Projects view, load project slot ${slot}, shown as "Project ${slot + 1}" ` +
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
    const r = await uploadSampleKit(conn, items, { reconnect: ctx.reconnect });
    if (!r.ok) {
      return {
        ok: false, uploaded: [],
        failed: { slot: items[0].slot, filename: items[0].filename, error: r.error ?? 'unknown' },
        info: 'Kit upload session failed; the session is atomic, so treat all slots as unwritten.',
        warning: `Kit upload failed: ${r.error}. Call reconnect_midi and retry the whole kit.`,
      };
    }
    const uploaded = r.uploaded.map((u) => ({ slot: u.slot, filename: u.filename, converted: u.converted }));
    const converted = uploaded.filter((u) => u.converted).length;
    return {
      ok: true, uploaded,
      info:
        `Uploaded ${uploaded.length} sample(s) to slots ${loSlot}..${hiSlot} (device 1..64) in one sample-directory session, all frames acked` +
        (converted ? `; ${converted} normalized to 48 kHz mono 16-bit` : '') + '. ' +
        `Each OVERWROTE its slot's previous sample (overwrite authorized via confirm_overwrite). ` +
        `Written with the capture-proven sample-directory prelude (0x05 dir + 0x0d scan) that commits the pack manifest; ` +
        `confirm by ear, and that they survive a device restart. On the device: Drum track > Sample positions ${loSlot}..${hiSlot}.`,
    };
  },
};
