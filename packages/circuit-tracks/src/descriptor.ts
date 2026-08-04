/**
 * Novation Circuit Tracks DeviceDescriptor.
 *
 * The project's first sequencer/orchestrator. Two halves:
 *  - TONE: synths + drums, controlled like any synth (preset_class 'voice',
 *    set_param/set_params over CC/NRPN). See params.ts / codec/.
 *  - ORCHESTRATOR: a pattern TARGET (capabilities.pattern_realizers +
 *    voice_map) the device-neutral pattern module realizes onto.
 *
 * Support tier: `verified` (see `capabilities.support_tier` below, which is the
 * single source of truth and is what the contribution gate compares against).
 * The wire framing + param map are transcribed byte-for-byte from the v3
 * Programmer's Reference Guide and cross-checked against the PDF; the carve-outs
 * that are NOT hardware-confirmed are named in `capabilities.verification`.
 */

import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

import { buildBlocks, CH_DRUMS, CH_SYNTH1, CH_SYNTH2, CH_MIDI1, CH_MIDI2 } from './params.js';
import { DRUM_TRACK_BASE_VOICES } from './ncs/drumBinding.js';
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
    // microSD holds up to 32 PACKS, each a complete world of 64 projects / 128
    // patches / 64 samples, addressable by the `pack` arg (pack addressing
    // decoded + hardware-confirmed 2026-07-16, docs/design/circuit-pack-addressing.md).
    has_packs: true,
    // Set from the PRIMARY authoring surface, which is owner-confirmed on
    // hardware: transport, drum-note triggering, the pattern orchestrator,
    // note-track and drum authoring onto a stored project, and the pack-addressed
    // read surface. It is the maintainer's clock master and is dogfooded daily,
    // so `community-beta` (a decoded-but-unconfirmed codec) understated it.
    //
    // NOT "confirmed across every surface", and an earlier version of this
    // comment wrongly said so while the `verification` string ten lines below
    // named the carve-outs. ONE now remains unconfirmed on hardware, stated
    // there: **synth CC/NRPN writes** (which is what `set_param` does). The
    // nonzero-pack sample AND project write paths were both confirmed on
    // 2026-07-27 and are stated there as two SEPARATE claims with separate
    // evidence. The tier rates the primary surface; the prose carries the
    // split. Do not let this comment drift from that string again.
    support_tier: 'verified',
    verification:
      'Wire framing + param map transcribed byte-for-byte from the v3 Programmer\'s Reference Guide and ' +
      'cross-checked against the PDF. Transport + drum-note triggering (ch10) are owner-confirmed on ' +
      'hardware (2026-06-18: an audible Drum 1 hit, note 60, through this server). The pattern ' +
      'orchestrator is owner-confirmed too: live_stream melodies/chords/transpose play on Synth 1/2 ' +
      '(2026-06-19), and ncs_upload note-track + drum authoring round-trips onto a stored project that ' +
      'loads and plays on the device clock (2026-06-19: octave bass on Synth 1 + kick on Drum 1). Synth ' +
      'CC/NRPN writes still await on-device confirmation. Drum tracks do NOT record ' +
      'external MIDI (manual p.38 + on-device test 2026-06-18): record-capture is synth-track only; a ' +
      'drum beat is live_stream/audition only over MIDI (NCS upload, phase C, is the only drum-onto-device path). ' +
      'The pack-addressed READ surface is owner-confirmed on a 5-pack card (2026-07-17): scan_locations lists a ' +
      'pack\'s project directory in one round trip (Pack 5 occupancy matched the known layout exactly); get_preset ' +
      'reports pattern_occupancy across all 8 patterns (a silent pattern 1 reads as "starts silent", not "empty"); ' +
      'and list_samples reads a chosen pack\'s pool (Pack 5\'s pool came back distinct from Pack 1\'s, so the pack ' +
      'byte reaches the wire). The note gate lane is owner-confirmed on hardware (2026-07-27): a tie authored at ' +
      'magnitude 48 (raw byte 176) was loaded and SAVED on the unit and read back unchanged, and the save moved ' +
      'the synth 1 mixer byte on its own, so the device re-serialised from its own state; tie and length are ' +
      'independent fields. Authored note lengths themselves await an on-device listen. ' +
      'PATTERN length (distinct from note length) is owner-confirmed by ear on 2026-07-29, by TWO tests that had to be ' +
      'run separately because the first cannot answer what the second does. TEST A: four chained patterns at ' +
      '24/24/30/18 steps, one hit each, on Drum 1 and Synth 1 at 60 bpm produced four hits per 24 s cycle, three on ' +
      'the click and the fourth exactly between two, with both tracks always together. A chained pattern therefore ' +
      'advances when its OWN length elapses rather than padding to 32, two tracks whose length sequences MATCH stay ' +
      'in sync, and a four-pattern chain (end=3) works on a DRUM track. A alone could NOT separate one common ' +
      'boundary from genuine per-track advance, because both tracks carried the same sequence. TEST B answered that: ' +
      'Drum 1 at 24/24/30/18 against Synth 1 at 18/30/24/24, both totalling 96 steps, produced the predicted six ' +
      'events per 24-click cycle (both together on 1, synth between 5 and 6, drum on 7, both on 13, synth on 19, ' +
      'drum between 20 and 21, both again on 25). The four SINGLE events prove the tracks advance independently; the ' +
      'two DOUBLED events holding over repeated cycles prove they do not drift apart. So two tracks holding ' +
      'DIFFERENT pattern lengths at the same time stay in sync, a 4/4 part can sit under a 7/8 part, and mixed ' +
      'metre is fully expressible on this device. ' +
      'The pack-addressed WRITE path is owner-confirmed on hardware (2026-07-27) as TWO separate claims. ' +
      'SAMPLES: 63 sample slots were cloned from Pack 1 onto Pack 2, each source download gated by the device\'s ' +
      'own CRC32; a deliberately out-of-order write (slot 0, then slot 63) landed at slot 63 rather than the next ' +
      'free index, proving the slot byte is ADDRESSED not append-ordered, and eight slots read back off Pack 2 were ' +
      'md5-identical to the originals with a full 64-slot name diff clean. PROJECTS: two authored projects were ' +
      'written to Pack 2 slots 1 and 2 (both read-checked empty first) and independently downloaded back, CRC-verified, ' +
      'with every track asserted to hold the part it should. Neither claim was re-checked across a power-cycle: the ' +
      'evidence is a device read-back, not a reboot, and the projects have not yet been played from Pack 2. ' +
      'READ-BACK TIMING: the device flushes a pack manifest ~6-8 s AFTER a transfer session closes, so a verification ' +
      'read taken sooner can report a just-written slot empty (it did, for 8 slots, on 2026-07-27). Poll past the ' +
      'commit window before concluding a write failed; this device has no erase, so a needless re-send is not free.',
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
      // Drum 4 is the RIDE track under `DEFAULT_DRUM_BINDING` (its base sample
      // is the ride, slot 3) — but `clap` was the only key naming note 65, so
      // every cymbal role folded PAST this pad and landed on Drum 3, the hat.
      // Naming the role explicitly puts cymbals on the cymbal track. `clap`
      // keeps the pad too: both are legitimate Drum 4 voices, and a per-step
      // sample flip is what distinguishes them in the authored pattern.
      ride: { channel: CH_DRUMS, note: 65 },
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
    // What Drum 1..4 play by default, in track order: the roster a full kit is
    // CONDENSED onto (apply_pattern condense_drums) when the real drums are
    // routed to an external sampler over MIDI 2 and these four tracks would
    // otherwise sit empty. Same list as DRUM_TRACK_BASE_VOICES, which also
    // derives DEFAULT_DRUM_BINDING, so the roles and the sample slots the
    // project loads with cannot disagree.
    drum_track_roles: DRUM_TRACK_BASE_VOICES,
  },
  canonical_terms: {
    block: 'parameter group',
    slot: 'track',
    preset: 'patch / project',
    scene: '(no MIDI scene control)',
    channel: 'track channel',
    location: 'Project 1-64, numbered exactly as the device shows it',
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
