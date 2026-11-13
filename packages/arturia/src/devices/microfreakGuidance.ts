/**
 * Agent-facing guidance for the MicroFreak, surfaced through `describe_device`.
 *
 * Keyed sections (the descriptor contract is `Record<string, string>`; keys are
 * device-defined). `read_write_asymmetry` comes first deliberately: it is the
 * thing most likely to make an agent report a fabricated success on this device.
 */
export const MICROFREAK_AGENT_GUIDANCE: Readonly<Record<string, string>> = {
  overview:
    'Arturia MicroFreak: a paraphonic (up to 4-voice) synth, digital oscillator into an analog '
    + 'filter. No onboard effects, so reverb or delay comes from downstream (a mixer '
    + 'send, or a sequencer with per-input FX sends).',

  read_write_asymmetry:
    'READ THIS BEFORE REPORTING ANY WRITE AS CONFIRMED. Preset parameters (filter.cutoff, '
    + 'oscillator.timbre, envelope.attack, ...) are driven by MIDI CC and are WRITE-ONLY: the '
    + 'device sends nothing back, does not show incoming CC on its display (contrary to '
    + "Arturia's own manual), and knob-catch does not track CC-set values. get_param on these "
    + 'REFUSES by design. Never claim a preset-param write was verified, it cannot be; ask the '
    + 'user to listen. By contrast the system.* Utility globals DO read back over SysEx, and '
    + 'every write to one is verified by an immediate read-back.',

  presets:
    '512 slots on firmware 5, 384 on firmware 4; scan_locations stops answering at the ceiling, '
    + 'so the firmware is probe-able. The device answers for exactly ONE slot past the last full '
    + 'bank (a range-check off-by-one on both firmwares), so treat a lone trailing answer as out of '
    + 'range. switch_preset uses Program Change and is 0-BASED (PC 4 loads preset 5), '
    + 'hardware-confirmed, though the manual documents no Program Change support. All 512 are '
    + 'reachable: Bank Select (CC 0) precedes the PC, hardware-confirmed.',

  sequenced_bends:
    'Nothing sequenced can bend this synth: a stored Circuit step carries no pitch bend and no CC '
    + 'reaches pitch. For a bent lead, import with import_songsterr pitch_gestures:"glide" (plus '
    + 'mono_voice for a chord line) and bends become OVERLAPPING notes. A moderate Glide knob '
    + 'setting sweeps them, hardware-confirmed; its cost is that DETACHED notes also swoop. '
    + 'Envelope Legato governs envelope RETRIGGER, not pitch glide. Patch setup is front-panel '
    + 'work; tell the user.',

  paraphony:
    'Chords work up to 4 voices, but Paraphony is PER-PRESET and bounded by the Utility voice '
    + 'count. A chord sent to a mono preset silently collapses to one note, so never assume a '
    + 'chord part will play on an arbitrary preset.',

  sync:
    'Utility > Sync > Source sets the tempo source for the internal arp/sequencer ONLY. It does NOT '
    + 'gate note reception, so it never explains a device that will not respond. On `MIDI` the '
    + 'arp/seq freezes with no external clock, which looks dead on a bench; `Auto` follows external '
    + 'clock when present and free-runs otherwise, usually what you want.',

  midi_out_leg:
    'The 5-pin MIDI Out is a SEPARATE path from the USB this server talks over, and THREE Utility '
    + 'settings silence it with nothing looking wrong. TWO ARE READABLE: system.midi_thru Off stops '
    + 'the synth relaying its MIDI In, and system.output_dest on USB-only clears the MIDI bit. THE '
    + 'THIRD IS NOT: Utility > MIDI > Merge drops MIDI-In traffic on its USB-only value and has no '
    + 'known SysEx id, so if a downstream device goes silent with both readable globals healthy, ask '
    + 'the user to check Merge. Two measured facts: the synth relays every channel EXCEPT its own '
    + 'receive channel, so give a downstream device a different channel; and USB never reports '
    + 'relayed traffic, so USB silence proves nothing about the DIN leg. A write that silences the '
    + 'leg still goes through and warns: not a failure, do not undo it, tell the user.',

  silent_presets:
    'WHY A PRESET SOUNDS SILENT OR QUIET. These are DIFFERENT problems; check the DEVICE first. '
    + 'SILENT: presets on the Sample or granular engines play back device SAMPLE MEMORY, which no '
    + 'preset dump carries, so they are silent however perfect the preset. One unit read 0.0s of 209.9s after a two-phase firmware update whose sample phase '
    + 'never ran, silencing a quarter of its library; Vocoder presets need mic input. Read the '
    + 'front-panel oscillator name before analysing preset data. QUIET is separate: three '
    + 'PER-PRESET settings, only ONE a level control, none with a MIDI CC. Preset Volume (-12..+12) '
    + 'is the real one: 30% of a measured library sat at -4 or below, authors use it as a mix '
    + 'control. Velo Amp Mod (0..10) is modulation DEPTH: RAISE THE SEQUENCED VELOCITY, do not '
    + 'flatten the patch. Amp Mod OFF is routing and legitimate design (a drawbar organ works that '
    + 'way); flipping it ON SILENCES any preset whose envelope is at zero.',

  channel:
    'The receive channel is user-set (Utility > MIDI > Input Chan), not discoverable over '
    + 'the wire. This server sends on channel 1 unless MCP_MICROFREAK_CHANNEL says otherwise. If '
    + 'writes appear to do nothing, read system.midi_input_channel and compare first.',

  not_supported:
    'get_preset, apply_preset, save_preset and rename refuse rather than faking it. Whole '
    + 'presets move byte-exact: export_preset dumps a stored slot, import_preset writes one back '
    + '(that write IS the persist). The payload format IS decoded (self-describing name/value '
    + 'records, 56+ params) but no per-param authoring is wired to a tool yet, so editing one knob '
    + 'is still front-panel work.',
};
