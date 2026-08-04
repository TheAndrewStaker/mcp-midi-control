/**
 * Agent-facing guidance for the MicroFreak, surfaced through `describe_device`.
 *
 * Keyed sections (the descriptor contract is `Record<string, string>`; keys are
 * device-defined). `read_write_asymmetry` comes first deliberately: it is the
 * thing most likely to make an agent report a fabricated success on this device.
 */
export const MICROFREAK_AGENT_GUIDANCE: Readonly<Record<string, string>> = {
  overview:
    'Arturia MicroFreak: a paraphonic (up to 4-voice) synth with a digital oscillator and an '
    + 'analog filter. No onboard effects at all, so a user wanting reverb or delay needs it '
    + 'downstream (a mixer send, or a sequencer with per-input FX sends).',

  read_write_asymmetry:
    'READ THIS BEFORE REPORTING ANY WRITE AS CONFIRMED. Preset parameters (filter.cutoff, '
    + 'oscillator.timbre, envelope.attack, ...) are driven by MIDI CC and are WRITE-ONLY. The '
    + 'device sends nothing back for them, does not show incoming CC on its display (contrary to '
    + "Arturia's own manual), and its knob-catch position does not track CC-set values either. "
    + 'get_param on these REFUSES by design. Never claim a preset-param write was verified: it '
    + 'cannot be. Ask the user to listen, or save the preset and dump it. By contrast, the '
    + 'system.* Utility globals DO read back over SysEx, and every write to one is automatically '
    + 'verified by an immediate read-back.',

  presets:
    '512 slots on firmware 5, 384 on firmware 4; scan_locations stops answering at the ceiling, '
    + 'so the firmware is probe-able. The device answers for exactly ONE slot past the last full '
    + 'bank (a range-check off-by-one reproduced across both firmwares), so treat a lone trailing '
    + 'answer as out of range. switch_preset uses Program Change and is 0-BASED (PC 4 loads preset '
    + '5), hardware-confirmed, even though the manual documents no Program Change support at all. '
    + 'Only presets 1-128 are reachable: Bank Select for the higher banks is NOT decoded, so '
    + 'switch_preset refuses beyond 128 rather than silently loading the wrong sound.',

  paraphony:
    'Chords work, up to 4 voices, but Paraphony is a PER-PRESET setting and is also bounded by the '
    + 'Utility voice count. A chord sent to a mono preset collapses to a single note silently, so '
    + 'do not assume chord parts will play on an arbitrary preset.',

  sync:
    'Utility > Sync > Source sets the tempo source for the internal arp/sequencer ONLY. It does '
    + 'NOT gate note reception, so a device that appears not to respond is never explained by this '
    + 'setting. On `MIDI` the arp/seq freezes whenever no external clock arrives, which makes the '
    + 'unit look dead on a bench; `Auto` follows external clock when present and free-runs '
    + 'otherwise, which is usually what a user wants.',

  midi_out_leg:
    'The 5-pin MIDI Out is a SEPARATE path from the USB this server talks over, and THREE Utility '
    + 'settings can silence it without anything looking wrong. TWO ARE READABLE FROM HERE: '
    + 'system.midi_thru set to Off stops the synth relaying what arrives at its MIDI In, and '
    + 'system.output_dest dropped to USB-only clears the MIDI bit of its bitmask. THE THIRD IS NOT: '
    + 'Utility > MIDI > Merge (USB+KBD / MIDI+KBD / BOTH+KBD) selects which sources get merged into '
    + "the MIDI Out, and on the USB-only value the synth's own keyboard still passes while traffic "
    + 'arriving at MIDI In is dropped. Merge has no known SysEx param id, so get_param cannot report '
    + 'it, set_param cannot change it, and no warning can fire on it. '
    + 'WHEN A USER SAYS SOMETHING DOWNSTREAM WENT SILENT: read system.midi_thru and '
    + 'system.output_dest first, and if BOTH read healthy do NOT conclude the synth is fine and the '
    + 'fault is elsewhere. Say plainly that a third setting governs that leg and this server cannot '
    + 'see it, and ask the user to check Merge on the front panel. Measured 2026-07-27 on the '
    + "maintainer's rig: thousands of channel messages arriving, the synth audibly playing them, "
    + 'clock passing through to within 0.1 BPM, and zero channel messages leaving, with every '
    + 'readable global correct. That Merge is the cause is a strong inference rather than a '
    + 'measurement, precisely because Merge cannot be read; report it that way. Related trap: the '
    + 'relay path and the keyboard path are NOT the same test, so a user confirming that notes '
    + 'played ON the synth reach the downstream device has not confirmed that a relayed sequence '
    + 'does. When a rig manifest declares a device on that output, a write that silences the leg via '
    + 'either READABLE global still goes through (it may be exactly what the user wants) but comes '
    + 'back with a warning naming the device that just went quiet. Do not treat that warning as a '
    + 'failed write, and do not silently undo it; tell the user what is now disconnected.',

  channel:
    'The receive channel is user-set on the device (Utility > MIDI > Input Chan) and cannot be '
    + 'discovered over the wire. This server sends on channel 1 unless MCP_MICROFREAK_CHANNEL says '
    + 'otherwise. If writes appear to do nothing, read system.midi_input_channel and compare '
    + 'before assuming anything else is wrong.',

  not_supported:
    'get_preset, apply_preset, save_preset and rename all refuse honestly rather than faking it. '
    + 'The preset DUMP path is decoded and works (146 packets, a self-describing TLV carrying '
    + 'parameter names inline), but its value encoding is undecoded and no preset WRITE path is '
    + 'known at all, so authoring and saving are impossible today. Saving must be done on the '
    + 'device.',
};
