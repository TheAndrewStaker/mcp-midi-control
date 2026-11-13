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
    'target user memory). The target is read first: a memory holding anything other than INIT PATCH is ' +
    'refused unless it is the loaded one or confirm_overwrite is passed, and the receipt reads the stored ' +
    'name and the sections that are on back from the saved memory. Presets P01–P50 are factory/read-only and rejected.',
  recall:
    'switch_preset recalls a user memory U01–U99 (or 1–99) or a factory preset P01–P50. It reads the ' +
    'Program Change IN setting of the unit first: when that is on it sends a bare Program Change on MIDI ' +
    'channel 1 (no Bank Select, which makes the unit ignore the recall); otherwise, and always for ' +
    'P01–P50, it writes the Current Patch Number register, which works whatever that setting ' +
    'is. Do NOT set system_midi.midi_program_change_in to 1 to make recall work: it is not needed, and ' +
    'it re-exposes the unit to a stray Program Change on the bus recalling a patch mid-song. Neither ' +
    'path is echoed, so switch_preset reads the loaded memory number back: confirmed_by "read_back" ' +
    'means the unit reports the target as loaded, and acked false means it did not move.',
  status:
    'Hardware-confirmed on the maintainer unit: set_param, get_param, set_bypass, user-memory ' +
    'recall, apply_preset, set-by-NAME for type/mode/voice selectors, save_preset (a name can be set ' +
    'with save_preset(location, name)), the SYSTEM params under system_-prefixed blocks, and the memory ' +
    'reads in reading. Ordinary parameter writes are not echoed, so get_param is their confirm. ' +
    'Hardware-unverified: factory preset (P01–P50) recall.',
  reading:
    'Nothing has to be loaded to look at a memory. scan_locations({from:"U01", to:"U99"}) lists every ' +
    'user memory by name in about 2 seconds; is_empty is true for a memory still named INIT PATCH, which ' +
    'is how to find a free one. get_preset({port}) reads the LOADED memory: its name, its number ' +
    '(_meta.current_location), each section on or off with its type, and the parameters of the sections ' +
    'that are on. get_preset({port, location:"U20"}) reads a STORED user memory the same way without ' +
    'loading it, so unsaved edits are untouched. Both take about 2 seconds and are summaries: a section ' +
    'that is off reports only its type, and fx1-fx4 report only their type. get_param / get_params read ' +
    'the loaded memory only. Factory presets P01-P50 cannot be read while stored. Use these reads before ' +
    'a save to check the target, and never tell the user a memory cannot be inspected without loading it.',
};
