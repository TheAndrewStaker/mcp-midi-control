/**
 * Akai MPC One G2 (standalone, MPC OS 3.9): MIDI surface only.
 *
 * What this config owns: the port matcher, the channel env names, the tier and
 * its evidence prose, and the agent guidance. The shared behaviour lives in
 * `descriptor.ts`.
 *
 * Evidence, by source:
 *   - Akai's MPC Standalone OS User Guide v3.9 documents that an incoming
 *     Program Change selects a Sequence (or a Track, per a Preference), that
 *     drum tracks play from incoming notes, and that the unit receives MIDI
 *     Clock and MMC.
 *   - Bench-proven on a One G2 (2026-11-04): Program Change N selects sequence
 *     N + 1; a change received while stopped steps at once, and one received
 *     while playing is queued and taken at the end of the current sequence.
 *   - NOT yet exercised through this descriptor: the USB port name below (seen
 *     in the OS port list, never sent to from this server) and the drum notes.
 */
import type { MpcConfig } from './types.js';

export const MPC_ONE_G2_AGENT_GUIDANCE: Readonly<Record<string, string>> = {
  vocabulary:
    'MPC words differ from most gear. A PROGRAM is an instrument (a drum kit, a keygroup, a plugin). '
    + 'A SEQUENCE is one part of a song (verse, chorus), holding tracks that play programs. A PROJECT '
    + 'is the whole song or set. So "preset" on this device means a SEQUENCE inside the loaded project, '
    + 'not a sound. Say "sequence" to the user.',
  switch_sequence:
    'switch_preset(N) selects sequence N (1-128) of the LOADED project by Program Change N-1. It cannot '
    + 'load a project, and nothing is read back. Timing depends on transport: while stopped the MPC moves '
    + 'at once; while playing it QUEUES the sequence and switches at the end of the current one. Tell the '
    + 'user which to expect. Needs Preferences > MIDI / Sync > Program Change = Sequence on the unit.',
  setup_on_unit:
    'On the MPC: Preferences > MIDI / Sync: Program Change = Sequence; Receive Clock/MMC only if this '
    + 'computer drives transport. Never suggest Online Update (newer OS than checked).',
  two_modes:
    'STANDALONE: switch_preset and apply_pattern work, card not visible. CONTROLLER MODE ("Looking for '
    + 'Computer"): card mounts here, MIDI verbs refuse. Tell the mode from list_midi_ports ONLY: "MPC One '
    + 'Public" = Controller Mode, "MPC One USB-C Out 1" = standalone (a mounted card may be in a reader).',
  clock_and_transport:
    'Usually the MPC is CLOCK MASTER: send it no clock unless asked. To drive it: send_clock_start/stop '
    + '(Receive = MIDI Clock) or MMC via send_sysex. It cannot record audio while following clock.',
  drums:
    'apply_pattern streams notes live (the MPC records them only if the user arms a track). Notes follow '
    + 'the General MIDI drum map (kick 36, snare 38, closed hat 42, open hat 46, ...), which matches kits '
    + 'built with GM pad notes. A factory kit on the Classic MPC or Chromatic pad map will sound the wrong '
    + 'pads; ask which kit is loaded, or have the user set Edit Pad Note Map on the program. The track '
    + 'must be the current track or have its MIDI input set to this port.',
  card:
    'Card (Controller Mode or a reader): scan_locations(1, 200) lists projects (internal ones start internal:); '
    + 'get_preset(location = project) reads the FILE, not MPC memory: sequences (number, name, tempo, bars; '
    + 'parts interleave with fills, so check before switch_preset) and mpc_project.tracks (level dB, pan, mute, '
    + 'instrument, inserts). Never tell the user to eject the card.',
  card_edits:
    'apply_preset(target_location = project, spec.slots) EDITS, never rebuilds: list only rows to change, '
    + '{slot: track, block_type: "track", params: {level_db (absolute, -inf..+6), pan (-100..100), mute}} or '
    + '{slot: sequence, block_type: "sequence", params: {name, bpm}}. No save_authorized = preview. Writes back up '
    + 'the file and refuse if it changed since read. The unit hears it after the project is reloaded.',
  what_is_not_here:
    'No MIDI parameter access or program/project transfer; on the card only the track and sequence values above.',
};

export const MPC_ONE_G2: MpcConfig = {
  id: 'mpc-one-g2',
  display_name: 'Akai MPC One G2',
  // Seen on a One G2, MPC OS 3.9.1, Windows (2026-11-12). STANDALONE on USB:
  // "MPC One USB-C Out 1/2", "In 1/2" and "DAW"; a Program Change on Out 1
  // moved the sequence. CONTROLLER MODE: "MPC One Public" plus the forwarded DIN
  // jacks ("MIDI In 1", "MIDI Out A"); the unit shows "Looking for Computer" and
  // a Program Change does nothing. A bare /mpc one/ would also catch the DIN
  // forwards and send notes out of the MPC instead of into it.
  port_match: [/mpc one.*usb-c (out|in) 1\b/i, /mpc one.*public/i],
  engine_ports: { output: /mpc one.*usb-c out 1\b/i, input: /mpc one.*usb-c in 1\b/i },
  controller_mode_port: /mpc one.*public/i,
  sequence_count: 128,
  channel_env: 'MCP_MPC_CHANNEL',
  drum_channel_env: 'MCP_MPC_DRUM_CHANNEL',
  support_tier: 'generic-only',
  verification:
    'GENERIC-ONLY: Program Change, notes, clock. Sequence recall by Program Change (PC N-1 = sequence N; '
    + 'immediate while stopped, queued to the end of the current sequence while playing) is documented by '
    + 'Akai and hardware-confirmed from this computer on a One G2, MPC OS 3.9.1, running standalone on USB '
    + '(port "MPC One USB-C Out 1", 2026-11-12). In Controller Mode the unit ignores it. Pad triggering by '
    + 'GM notes is untested. Card reads parse .xpj files saved on MPC OS 3.7-3.9.1. Card edits splice only '
    + 'the edited values (backup, byte-compared re-read), from fields read off 87 projects and the measured '
    + 'fader law; an edited project is not yet confirmed loading on the unit.',
  agent_guidance: MPC_ONE_G2_AGENT_GUIDANCE,
};
