/**
 * Novation Circuit Tracks DeviceDescriptor.
 *
 * The project's first sequencer/orchestrator. Two halves:
 *  - TONE: synths + drums, controlled like any synth (preset_class 'voice',
 *    set_param/set_params over CC/NRPN). See params.ts / codec/.
 *  - ORCHESTRATOR: a pattern TARGET (capabilities.pattern_realizers +
 *    voice_map) the device-neutral pattern module realizes onto.
 *
 * Support tier: community-beta. The wire framing + param map are
 * transcribed byte-for-byte from the v3 Programmer's Reference Guide and
 * cross-checked against the PDF; not yet hardware-confirmed end-to-end.
 */

import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

import { buildBlocks, CH_DRUMS, CH_SYNTH1, CH_SYNTH2, CH_MIDI1, CH_MIDI2 } from './params.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';
import { CIRCUIT_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';

export const CIRCUIT_TRACKS_DESCRIPTOR: DeviceDescriptor = {
  id: 'circuit-tracks',
  display_name: 'Novation Circuit Tracks',
  preset_class: 'voice',
  // Needle for the connection registry: must SUBSTRING-match the OS port name
  // "Circuit Tracks". 'circuit-tracks' (hyphen) would NOT match "circuit tracks";
  // 'circuit' does and is unique among registered devices.
  connection_label: 'circuit',
  port_match: [
    { pattern: /circuit ?tracks/i },
    { pattern: /circuit/i },
  ],
  capabilities: {
    slot_model: 'linear',
    slot_count: 64, // 64 synth Flash patches per part
    support_tier: 'community-beta',
    verification:
      'Wire framing + param map transcribed byte-for-byte from the v3 Programmer\'s Reference Guide and ' +
      'cross-checked against the PDF. Transport + drum-note triggering (ch10) are owner-confirmed on ' +
      'hardware (2026-06-18: an audible Drum 1 hit, note 60, through this server). The pattern ' +
      'orchestrator is owner-confirmed too: live_stream melodies/chords/transpose play on Synth 1/2 ' +
      '(2026-06-19), and ncs_upload note-track + drum authoring round-trips onto a stored project that ' +
      'loads and plays on the device clock (2026-06-19: octave bass on Synth 1 + kick on Drum 1). Synth ' +
      'CC/NRPN writes still await on-device confirmation. Drum tracks do NOT record ' +
      'external MIDI (manual p.38 + on-device test 2026-06-18): record-capture is synth-track only; a ' +
      'drum beat is live_stream/audition only over MIDI (NCS upload, phase C, is the only drum-onto-device path).',
    has_scenes: false, // no MIDI scene/pattern selection (confirmed dead-end)
    has_channels: false,
    // The two synth engines are addressed as instances: instance 1 = Synth 1
    // (ch1), instance 2 = Synth 2 (ch2). Only synth-scoped params (incl. macros
    // + mod matrix) accept instance 2; drum/project params reject it (writer).
    has_block_instances: true,
    // Intentionally false (2026-07-08): has_macros advertises macro-position
    // READBACK in describe_device, which is not wired. SETTING macros IS
    // available (set_macro / set_macro_route). Do NOT flip this on the presence
    // of the set tools; it stays false until live macro-position readback lands.
    has_macros: false,
    // supports_save = "persistence is HARDWARE-VERIFIED". CONFIRMED 2026-07-03:
    // save_preset writes a synth patch to a Flash slot and it survives a
    // power-cycle (two independent patches confirmed by ear after power-cycle).
    supports_save: true,
    save_note:
      'save_preset persists a synth part\'s current (RAM) sound to a Flash PATCH slot 0..63 (instance 1 = ' +
      'Synth 1, 2 = Synth 2); on the device it is Patch <slot+1> (1-indexed). It dumps the live patch, cleans ' +
      'its dirty-edit marker, and writes it via a file-transfer-session-wrapped Replace-Patch sent fire-and-forget ' +
      '(the device commits to flash silently over a few seconds). HARDWARE-CONFIRMED 2026-07-03: survives a ' +
      'power-cycle. Load Patch <slot+1> on the synth to hear it (the Circuit has no patch-name display). ' +
      'Read the saved patch back with get_preset("patch:N") (it reflects save_preset writes). ' +
      'PATCH slots are distinct from the PROJECT slots switch_preset/upload_project use.',
    supports_lineage: false,
    // Orchestrator axis: the Circuit is a pattern target.
    //  - live_stream: audition a beat live (sound module).
    //  - ncs_upload: write the beat as a real project onto a device slot over
    //    SysEx (template-modify + transfer), hardware-confirmed 2026-06-18.
    // record_capture is built + tested but NOT advertised (drum tracks do not
    // record external MIDI, manual-confirmed; it is synth-track only).
    pattern_realizers: ['live_stream', 'ncs_upload'],
    // The voice→track map. Two families:
    //  - DRUMS (ch10): the four pads are notes 60/62/64/65. Abstract drum
    //    voices map onto the four pads (kick/snare/hat/clap); patterns using
    //    other drum voices (openhat/tom/…) raise an honest unmapped-voice error.
    //  - NOTE TRACKS (ch1/2/3/4 = Synth1/Synth2/MIDI1/MIDI2): melodic voices.
    //    The voice_map note here is only the DEFAULT pitch for an un-pitched
    //    rhythmic hit; a melodic line carries its own pitch per step
    //    (Step.notes via note tokens like "c2", "c3+eb3+g3"). The CHANNEL is
    //    what routes a voice to a track. Neutral names (bass/lead/chord/arp)
    //    let the shared library recipes resolve here; the explicit track names
    //    (synth1/synth2/midi1/midi2) let an agent route deliberately — e.g.
    //    MIDI1 → an external Hydrasynth, MIDI2 → an SPD-SX. ncs_upload authors
    //    these into the .ncs; live_stream plays them as a sound module.
    voice_map: {
      kick: { channel: CH_DRUMS, note: 60 },
      snare: { channel: CH_DRUMS, note: 62 },
      hat: { channel: CH_DRUMS, note: 64 },
      clap: { channel: CH_DRUMS, note: 65 },
      // Explicit pad aliases so a caller can target a specific pad by name
      // (e.g. route a hi-hat roll deliberately onto Drum 4) instead of relying
      // on the abstract kick/snare/hat/clap mapping. Same four pads, same notes.
      drum1: { channel: CH_DRUMS, note: 60 },
      drum2: { channel: CH_DRUMS, note: 62 },
      drum3: { channel: CH_DRUMS, note: 64 },
      drum4: { channel: CH_DRUMS, note: 65 },
      // Melodic — neutral names with a sensible default track + octave.
      bass: { channel: CH_SYNTH1, note: 36 },   // C2 — Synth 1
      chord: { channel: CH_SYNTH1, note: 60 },  // C4 — Synth 1 (shares with bass; merged per step)
      lead: { channel: CH_SYNTH2, note: 72 },   // C5 — Synth 2
      arp: { channel: CH_SYNTH2, note: 60 },    // C4 — Synth 2
      // Explicit track routing (deliberate placement onto a specific track).
      synth1: { channel: CH_SYNTH1, note: 60 },
      synth2: { channel: CH_SYNTH2, note: 60 },
      midi1: { channel: CH_MIDI1, note: 60 },
      midi2: { channel: CH_MIDI2, note: 60 },
    },
    // The two outward MIDI tracks that sequence EXTERNAL gear (apply_pattern
    // external_targets routes a groove onto one of these, using the connected
    // device's note map). MIDI 1 transmits on ch3, MIDI 2 on ch4 by default.
    external_tracks: { midi1: CH_MIDI1, midi2: CH_MIDI2 },
  },
  canonical_terms: {
    block: 'parameter group',
    slot: 'track',
    preset: 'patch / project',
    scene: '(no MIDI scene control)',
    channel: 'track channel',
    location: 'project (0-63)',
  },
  blocks: buildBlocks(),
  reader,
  writer,
  agent_guidance: CIRCUIT_AGENT_GUIDANCE,
  // Cross-device synth concept-keys. Circuit is outside the Fractal-family
  // `DevicePortSlug` union the shared CONCEPT_KEYS registry is keyed by, so it
  // declares its slice here directly; the dispatcher resolves it via
  // `resolveDescriptorConceptKey`. Only NAME-router concepts that mean the same
  // selector/knob as on other synths are listed — the canonical word reaches the
  // right Circuit param. Pass the fully-qualified key (e.g. `osc.waveform`) since
  // the Circuit osc/lfo blocks are `osc1`/`osc2` and `lfo1`/`lfo2`; resolution
  // checks the local name against the caller's block. Env/LFO TIMES are
  // deliberately excluded: Circuit exposes them as raw 0..127 counts (not the
  // display ms/seconds Hydrasynth uses), so a shared time key would imply a
  // numeric portability the values don't have.
  concept_keys: {
    'filter.cutoff': 'frequency',
    'filter.resonance': 'resonance',
    'osc.waveform': 'wave',
    'lfo.waveform': 'waveform',
  },
  // example_spec intentionally omitted, voice-class device, no apply_preset.
};
