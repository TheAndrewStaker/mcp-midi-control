/**
 * Boss VE-500 agent guidance — per-topic prose surfaced via describe_device and
 * the device MCP resources. Teaches the VE-500's vocabulary without paying tool
 * context tax every turn.
 */

export const VE500_AGENT_GUIDANCE: Readonly<Record<string, string>> = {
  overview:
    'The Boss VE-500 Vocal Performer is a vocal multi-effects processor. A "preset" here ' +
    'is a MEMORY (user U01–U99, preset P01–P50). Its effect "blocks" are fixed sections in a ' +
    'vocal chain; there are no scenes and no per-block A/B channels. Up to 9 effects run at once.',
  blocks:
    'Sections (blocks): enhancer, pitch_correct, harmony (+ harmony1/2/3 voices, vocoder), ' +
    'fx1–fx4 (each can be one of 20 FX types: distortion, radio, lo-fi, filter, t-wah, ring mod, ' +
    'chorus, flanger, tremolo, phaser, rotary, slicer, isolator, vibrato, pan, roll, freeze, ' +
    'granular delay, delay, reverb), reverb1/reverb2, loop (phrase looper), key, master, ctl, ' +
    'assign1–assign8. Call list_params({port, block:["fx1"]}) to see a section\'s parameters. ' +
    'SYSTEM (global, device-wide, not per-patch) settings live under system_-prefixed blocks: ' +
    'system_midi, system_usb, system_tuner, system_pref, system_input (+ system_input_eq1-4), ' +
    'system_output (+ system_output_eq1-4), system_common, plus a few sections that mirror a ' +
    'per-patch section at system scope (system_enhancer, system_reverb1/2, system_key, ' +
    'system_master_reverb, system_master_bpm, system_ctl, system_*_midi). These use the SAME ' +
    'set_param/get_param/get_params/list_params calls as per-patch blocks.',
  editing:
    'set_param edits the ACTIVE patch live over SysEx (non-destructive, like an audition). ' +
    'Switching memory (switch_preset) discards unsaved edits. set_bypass turns a section on/off ' +
    'via its switch. Values are the parameter\'s integer range shown on the panel (e.g. levels 0–100); ' +
    'on/off switches accept on/off. TYPE/MODE/VOICE selectors accept and echo their PANEL LABELS by name ' +
    '(case-insensitive), e.g. fx type "Chorus", reverb type "Hall", harmony voice "+3RD", Rotary Speed ' +
    '"Fast"; EQ-gain params take dB labels like "+6dB". apply_preset accepts the same labels. Call ' +
    'list_params to see a selector\'s options.',
  save:
    'save_preset stores the active edited patch to a user memory (U01–U99) over MIDI: it sends Editor ' +
    'Communication Mode ON, then the store command, then waits for the device\'s store-ack echo (the ' +
    'device DOES echo the store, so acked reflects a real ack). HARDWARE-CONFIRMED 2026-07-08: a set + ' +
    'save + flash-reload round-trip persisted on the maintainer\'s unit. It is destructive (overwrites the ' +
    'target user memory) and there is no overwrite pre-check, so confirm the target is intended; verify a ' +
    'save by recalling the memory. Presets P01–P50 are factory/read-only and rejected. NOTE: an earlier ' +
    'bare-store-only version was hardware-refuted 2026-07-08 (the mode handshake is what fixed it).',
  recall:
    'switch_preset recalls a USER memory U01–U99 (or 1–99) by a bare Program Change on MIDI channel 1 ' +
    '(hardware-confirmed). The VE-500 must have PC IN = ON and RX CH = OMNI or Ch.1; a Bank Select is ' +
    'deliberately NOT sent (the unit ignores the recall if one precedes the PC). User-memory recall now ' +
    'PRE-FLIGHT READS system_midi.midi_program_change_in and REFUSES when it is 0, because the unit ' +
    'would ignore the Program Change and never say so. If you hit that refusal, do NOT "fix" it by ' +
    'setting midi_program_change_in to 1 on the user\'s behalf: turning it on re-exposes the unit to ' +
    'any stray Program Change on the bus recalling a patch mid-song, which is normally why it is off. ' +
    'Offer the front panel as the first option and the setting change as an explicit trade the user ' +
    'chooses. Preset (P01–P50) recall is available too (2026-07-09): it sends a DIFFERENT mechanism, a ' +
    'SysEx DT1 write to the "Current Patch Number" register (decoded from the VE-500 Editor\'s own ' +
    'patch-switch handler, not a Program Change at all); community-beta, not yet hardware-confirmed. ' +
    'It does NOT depend on PC IN and is not gated. Neither recall path is echoed, so the front panel ' +
    'is ground truth for both.',
  status:
    'Hardware-confirmed on the maintainer\'s unit (2026-06-28): set_param, get_param (RQ1→DT1), ' +
    'set_bypass, user-memory recall (switch_preset), apply_preset (whole-patch build), and set-by-NAME ' +
    'for type/mode/voice selectors all round-trip end-to-end. The wire was decoded from the BOSS VE-500 ' +
    'Editor\'s own code. Ordinary patch-address writes are not echoed, so get_param is their in-band ' +
    'confirm. save_preset (store to a user memory) is HARDWARE-CONFIRMED 2026-07-08 after a re-decode: a ' +
    'bare store command was refuted (did not persist), so it now sends Editor Communication Mode ON first ' +
    'and waits for the device\'s store-ack echo, and a set + save + reload round-trip persisted on the ' +
    'unit. Patch NAME can be set as part of save_preset(location, name). NEW 2026-07-09 (community-beta, ' +
    'hardware-unverified): factory preset (P01–P50) recall via switch_preset, and the global SYSTEM param ' +
    'region (MIDI, USB, tuner, preference, input/output + their EQs) via set_param/get_param/get_params/ ' +
    'list_params under system_-prefixed blocks. Still not available: whole-patch get_preset.',
};
