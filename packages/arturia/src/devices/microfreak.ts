/**
 * MicroFreak device config.
 *
 * The only Freak this project has EVIDENCE for. Everything marked
 * hardware-confirmed below was verified on the maintainer's own unit
 * (firmware 5.0.0) on 2026-07-25; see docs/_private/STATE-MICROFREAK.md for the
 * full trail.
 */
import type { FreakConfig, FreakCc, FreakGlobal } from './types.js';
import { MICROFREAK_AGENT_GUIDANCE } from './microfreakGuidance.js';

/**
 * From **Arturia's own manual, Appendix D: CC# Values** (fw 5.0.0 manual
 * pp.145-146), which is authoritative. The widely circulated third-party charts
 * were checked against it and match exactly.
 *
 * Hardware-confirmed here: **CC 23** (audible filter sweep) and **CC 83**
 * (audible, then byte-exactly via set-CC -> save -> dump -> diff, which moved 3
 * bytes under the preset payload's own inline `Reso` label).
 */
export const MICROFREAK_CCS: readonly FreakCc[] = [
  { block: 'oscillator', param: 'type', cc: 9, label: 'Oscillator Type' },
  { block: 'oscillator', param: 'wave', cc: 10, label: 'Oscillator Wave' },
  { block: 'oscillator', param: 'timbre', cc: 12, label: 'Oscillator Timbre' },
  { block: 'oscillator', param: 'shape', cc: 13, label: 'Oscillator Shape' },

  { block: 'filter', param: 'cutoff', cc: 23, label: 'Filter Cutoff', hardware_confirmed: true },
  { block: 'filter', param: 'resonance', cc: 83, label: 'Filter Resonance', hardware_confirmed: true },
  { block: 'filter', param: 'amount', cc: 26, label: 'Filter Amount' },

  { block: 'envelope', param: 'attack', cc: 105, label: 'Envelope Attack' },
  { block: 'envelope', param: 'decay', cc: 106, label: 'Envelope Decay' },
  { block: 'envelope', param: 'sustain', cc: 29, label: 'Envelope Sustain' },

  { block: 'cycling_env', param: 'rise', cc: 102, label: 'Cycling env rise' },
  { block: 'cycling_env', param: 'fall', cc: 103, label: 'Cycling env fall' },
  { block: 'cycling_env', param: 'hold', cc: 28, label: 'Cycling Env Hold' },
  { block: 'cycling_env', param: 'amount', cc: 24, label: 'Cycling Env Amount' },

  { block: 'lfo', param: 'rate_free', cc: 93, label: 'LFO rate (free)' },
  { block: 'lfo', param: 'rate_sync', cc: 94, label: 'LFO rate (sync)' },

  { block: 'arp', param: 'rate_free', cc: 91, label: 'ARP/SEQ rate (free)' },
  { block: 'arp', param: 'rate_sync', cc: 92, label: 'ARP/SEQ rate (sync)' },

  { block: 'keyboard', param: 'glide', cc: 5, label: 'Glide' },
  { block: 'keyboard', param: 'spice', cc: 2, label: 'Spice' },
  { block: 'keyboard', param: 'hold', cc: 64, label: 'Keyboard Hold (toggle)', toggle: true },
];

/** `Output dest` values that keep the USB transport alive. */
export const OUTPUT_DEST_USB_ALIVE: ReadonlySet<number> = new Set([1, 5]);

/**
 * `Output dest` values that keep the 5-pin MIDI Out (the DIN leg) carrying.
 *
 * The setting is a bitmask with MIDI on bit 2, so DIN-alive is {4, 5} = MIDI-only
 * and BOTH. Only 5 is reachable through this server: 4 has no USB bit, so the
 * `usb_critical` refusal rejects it first. 4 is listed anyway because this set
 * states what the DEVICE does, and folding in another rule's consequence would
 * make it silently wrong the day that rule changes.
 */
export const OUTPUT_DEST_DIN_ALIVE: ReadonlySet<number> = new Set([4, 5]);

/**
 * `MIDI Thru` values that keep the DIN leg relaying: On (1) only.
 *
 * NECESSARY, NOT SUFFICIENT. `Utility > MIDI > Merge` gates the same leg and has
 * no known SysEx param id, so a synth reading `midi_thru = On` and
 * `output_dest = 5` can still relay nothing. Every `din_alive` set on this device
 * states what the READABLE globals allow, never that the leg is actually live.
 */
export const MIDI_THRU_DIN_ALIVE: ReadonlySet<number> = new Set([1]);

/**
 * Utility globals, reachable by SysEx `0x43` (read) / `0x42` (write). Every
 * entry identified by **controlled differential identification**: snapshot all
 * 128 params, change exactly ONE front-panel setting, re-snapshot, and the
 * single param that moved is that setting. Correlation alone was proved
 * insufficient (three params shared a value while only one was the target), and
 * neighbour-inference is useless because the ids are scattered rather than
 * grouped by menu section.
 *
 * NOT EXHAUSTIVE, and one absence matters. `Utility > MIDI > Merge` is missing
 * because its param id has never been identified, and Merge gates the same 5-pin
 * MIDI Out that `midi_thru` and `output_dest` gate. So this table is what the
 * server can SEE of the DIN leg, not everything that governs it.
 */
export const MICROFREAK_GLOBALS: readonly FreakGlobal[] = [
  {
    param: 'midi_input_channel', id: 0x20, label: 'MIDI Input Chan', channel: true,
    note: 'Stored 0-based. Confirmed by diff: display 3->5 moved the byte 2->4.',
  },
  {
    param: 'midi_output_channel', id: 0x21, label: 'MIDI Output Chan', channel: true,
    note: 'Stored 0-based. Confirmed in BOTH directions (3->6 gave 2->5, then back).',
  },
  {
    param: 'knob_send_ccs', id: 0x24, label: 'Knob send CCs', values: ['Off', 'On'],
  },
  {
    param: 'output_dest', id: 0x25, label: 'Output dest', usb_critical: true,
    din_alive: OUTPUT_DEST_DIN_ALIVE,
    note: 'BITMASK, not the plain enum the manual implies: USB=1, BOTH=5 observed '
      + '(so USB=bit0, MIDI=bit2). MIDI=4 and None=0 are INFERRED, never observed, '
      + 'because both cut the USB path every read travels over. Bit 2 also decides '
      + 'whether the 5-pin MIDI Out carries anything, so dropping to USB-only (1) '
      + 'silences a downstream device while every read over USB still looks healthy.',
  },
  {
    param: 'arp_seq_midi_out', id: 0x2b, label: 'Arp/Seq MIDI out', values: ['Off', 'On'],
    note: 'The community notes label 0x2B "arp on/off". That is WRONG: a controlled '
      + 'single-variable diff moved it when only Arp/Seq MIDI out was changed.',
  },
  {
    param: 'knob_catch', id: 0x2d, label: 'Knob catch', values: ['Jump', 'Hook', 'Scaled'],
    note: 'From the community notes; not independently re-verified by this project.',
  },
  {
    param: 'sync_source', id: 0x2e, label: 'Sync Source',
    values: ['Int', 'USB', 'MIDI', 'Clock', 'Auto'],
    note: 'Confirmed by diff (2->4 when set MIDI->Auto); enum order matches the manual.',
  },
  {
    param: 'midi_thru', id: 0x3b, label: 'MIDI Thru', values: ['Off', 'On'],
    din_alive: MIDI_THRU_DIN_ALIVE,
    note: 'Off stops the synth relaying what arrives at its MIDI In back out of MIDI '
      + 'Out. Confirmed by consequence 2026-07-26: written 0 -> 1, after which notes '
      + "physically left the 5-pin MIDI Out and retuned the maintainer's voice through "
      + 'a downstream VE-500. Turning it back off silences that leg, and nothing in a '
      + 'read over USB would show it.',
  },
];

/** fw5 = 512 slots, fw4 = 384. Probe-able: the name read stops answering. */
export const MICROFREAK_PRESET_COUNT_FW5 = 512;

export const MICROFREAK: FreakConfig = {
  id: 'microfreak',
  display_name: 'Arturia MicroFreak',
  // Model-specific ON PURPOSE. A broad /arturia/i would also capture a
  // MiniFreak and drive it with MicroFreak CC numbers, which address different
  // parameters on that model.
  port_match: [/micro\s*freak/i],
  ccs: MICROFREAK_CCS,
  sysex: {
    device_code: 0x07,
    globals: MICROFREAK_GLOBALS,
    preset_count: MICROFREAK_PRESET_COUNT_FW5,
    output_dest_usb_alive: OUTPUT_DEST_USB_ALIVE,
  },
  pc_max_preset: 128,
  preset_count: MICROFREAK_PRESET_COUNT_FW5,
  // Hardware-confirmed on the maintainer's own unit: the SysEx read path,
  // Program Change recall, and the global read AND write opcodes. What is
  // missing (preset-param reads, save) is missing because the DEVICE cannot do
  // it or the protocol is undecoded, not because our evidence is thin, and the
  // tier describes confidence in what ships rather than completeness of the
  // device. So `community-beta` understated it.
  //
  // Do NOT read this as "CC control is confirmed". The CC TABLE is authoritative
  // (Arturia's own Appendix D, all 21 entries), but only 2 of the 21 have been
  // put on hardware: CC 23 audibly and CC 83 byte-exactly. The remaining 19 are
  // vendor-documented and untested, which is the open HW-FREAK-003. The
  // `verification` string below states that correctly; keep it that way.
  //
  // The MiniFreak stays `generic-only`: same factory, genuinely weaker evidence,
  // which is exactly why the tier lives on the per-device config.
  support_tier: 'verified',
  channel_env: 'MCP_MICROFREAK_CHANNEL',
  verification:
    "Firmware 5.0.0, hardware-confirmed on the maintainer's unit 2026-07-25. CONFIRMED: the "
    + 'SysEx read path (preset-name read at fixed ASCII offset 21 with the seq echoed; bank/index '
    + 'addressing proved by reading slot 129 as bank 1 index 0; a full 146-packet / 4672-byte '
    + 'preset dump terminating on the documented 0x17 marker); Program Change preset recall, which '
    + 'is 0-BASED (PC 4 loaded preset 5) despite the manual documenting no PC support at all; the '
    + 'global READ opcode 0x43, which answers for all 128 param slots; and CC control (Arturia '
    + 'manual Appendix D validated, CC 23 confirmed audibly and CC 83 byte-exactly). Seven Utility '
    + 'globals identified by controlled differential diff, which corrected a wrong community label '
    + '(0x2B is Arp/Seq MIDI out, not "arp on/off") and established that MIDI channels store '
    + '0-based. The global WRITE opcode 0x42 is ALSO hardware-confirmed (2026-07-25): a value that '
    + 'DIFFERED from the current one was written and the change verified by read-back in both '
    + 'directions, since writing an equal value would pass even if the write did nothing. Every '
    + 'write is still verified by an immediate read-back. RE-CONFIRMED BY CONSEQUENCE 2026-07-26, '
    + 'which is stronger than any read-back: system.midi_thru (0x3b) was written 0 -> 1 and the '
    + 'synth then relayed notes out of its DIN MIDI Out to a downstream device, which acted on '
    + 'them. An echo of our own frame cannot produce that. Operational note for anyone whose MIDI '
    + 'Out feeds something: midi_thru = Off and output_dest set USB-only (bitmask, USB = bit 0, '
    + 'MIDI = bit 2) each kill the DIN leg while leaving every USB read looking healthy. Either '
    + 'write now returns a WARNING naming the device that went quiet, but only when a rig manifest '
    + '(MCP_RIG_MANIFEST) declares an enabled MIDI cable leaving the DIN port of this synth; with no '
    + 'manifest the server cannot see the cabling and stays silent. It warns rather than refuses, '
    + 'because most owners have nothing on that jack and a refusal for everyone would be wrong. '
    + 'A THIRD SETTING DOES THE SAME AND IS NOT READABLE FROM HERE: Utility > MIDI > Merge (values '
    + 'along the lines of USB+KBD, MIDI+KBD, BOTH+KBD) selects which sources are merged into the MIDI '
    + "Out. On the USB-only value the synth's own keyboard still reaches MIDI Out while traffic "
    + 'arriving at MIDI In is not merged into it, so a relayed sequence is dropped and nothing else '
    + 'changes. Merge has NO KNOWN SysEx param id, so unlike the other two this server can neither '
    + 'read it nor warn on it. It is still worth a front-panel check when a downstream device goes '
    + 'silent, because the USB-only value genuinely would sever a relay. BUT A PRIOR CLAIM HERE, '
    + "that Merge had been caught doing exactly that on the maintainer's rig, IS WITHDRAWN: it was "
    + "refuted 2026-07-28. That case rested on this synth's USB port showing ZERO channel messages "
    + 'while an upstream sequencer transmitted thousands, which was never evidence about the DIN '
    + 'leg: the USB port does not report relayed traffic at all. In the very window its USB showed '
    + '0 channel messages, its DIN Out was measured DELIVERING four channels downstream, and Merge '
    + 'was BOTH+KBD throughout. THE REAL RELAY BEHAVIOUR, MEASURED AT THE FAR END 2026-07-28 (by '
    + "echoing the downstream device's own DIN MIDI In back out over its USB, a 55 s window): this "
    + 'synth relays every channel it receives EXCEPT the one it is set to receive on. Channels 1, 2, '
    + '4 and 10 all arrived, plus clock; channel 3 was ABSENT, and this synth was set to Input Chan '
    + "Ch.3. It ABSORBS its own receive channel in order to sound it, so a line on the synth's own "
    + 'channel can reach THIS SYNTH or ANYTHING DOWNSTREAM, never both. No setting known to us '
    + 'changes that and nothing readable from here reports it: a topology constraint, not a settings '
    + 'bug. Give a downstream device a channel this synth does not consume. The relay itself is '
    + 'CONFIRMED WORKING and was ear-confirmed the same day carrying a downstream feature for a '
    + 'whole song, which is a STRONGER test than the 2026-07-26 midi_thru confirm above: that one '
    + 'proved only that KEYBOARD notes leave the DIN Out, and never exercised the merge-onward path. '
    + 'NOT SUPPORTED: reading preset parameters (the device reports nothing back for them and its '
    + 'display does not show incoming CC, contrary to the manual), and any preset authoring or save '
    + '(the dump payload is a self-describing TLV whose value encoding is undecoded, and no preset '
    + 'WRITE path is known).',
  agent_guidance: MICROFREAK_AGENT_GUIDANCE,
};
