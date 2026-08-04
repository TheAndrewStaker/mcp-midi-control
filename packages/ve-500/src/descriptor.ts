/**
 * Boss VE-500 Vocal Performer DeviceDescriptor — top-level assembler for the
 * unified tool surface.
 *
 * The VE-500 is a `layout` / preset-signal-processor archetype: it reuses the
 * unified verbs (set_param / get_param / set_params / get_params / set_bypass /
 * switch_preset / describe_device / list_params) with NO device-specific tools.
 *
 * It is the first Roland address-based SysEx codec in the tree. The entire wire
 * surface (model id 00 00 00 55, DT1/RQ1 envelope, Roland checksum, the full
 * parameter address map, value packing) was decoded from the BOSS VE-500
 * Editor's own JavaScript (the manufacturer's authoritative encoder) and is
 * hardware-confirmed end-to-end on the maintainer's unit (support_tier verified;
 * factory preset P01-P50 recall and whole-patch reads deferred).
 *
 * Codec lives in `roland-midi` (shared Roland primitives + the VE-500 catalog).
 */

import type {
  DeviceDescriptor,
  PresetSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

import { buildBlocks } from './descriptor/schema.js';
import { reader } from './descriptor/reader.js';
import { writer } from './descriptor/writer.js';
import { VE500_AGENT_GUIDANCE } from './descriptor/agentGuidance.js';

/**
 * Working apply_preset payload an agent can clone. Each slot is a fixed VE-500
 * section (block_type = section name; the `slot` ordinal just enumerates them).
 * `bypassed` toggles a section's on/off switch; `params` are display values.
 * Working-buffer only — press WRITE on the device to keep the result.
 */
const VE500_EXAMPLE_SPEC: PresetSpec = {
  name: 'Lead Vocal',
  slots: [
    { slot: 1, block_type: 'enhancer', bypassed: false, params: { enhance: 40, compressor: 30, de_esser: 20 } },
    { slot: 2, block_type: 'pitch_correct', bypassed: false, params: { type: 'Soft', formant: 50, speed: 5 } },
    { slot: 3, block_type: 'harmony1', params: { voice_manual: '+3RD', pan: 50, level: 70 } },
    { slot: 4, block_type: 'reverb1', bypassed: false, params: { type: 'Hall', reverb_time: 50, reverb_level: 40 } },
  ],
};

export const VE500_DESCRIPTOR: DeviceDescriptor = {
  id: 've-500',
  display_name: 'Boss VE-500 Vocal Performer',
  preset_class: 'layout',
  connection_label: 've-500',
  // USB-MIDI class compliant; transport defaults to 'midi'.
  port_match: [{ pattern: /VE-?500/i }],
  capabilities: {
    // Fixed effect sections (not a placeable grid).
    slot_model: 'linear',
    support_tier: 'verified',
    verification:
      'Wire decoded from the BOSS VE-500 Editor\'s own code (model id 00 00 00 55, DT1/RQ1 envelope, ' +
      'Roland checksum, full parameter address map, value packing). HARDWARE-CONFIRMED end-to-end on ' +
      'the maintainer\'s unit (2026-06-28): set_param, get_param (RQ1→DT1 round-trip), set_bypass, and ' +
      'switch_preset for user memories U01–U99 (BARE Program Change; a prepended Bank Select makes the ' +
      'unit ignore the recall, so none is sent; requires PC IN = ON, RX CH = OMNI/Ch.1). save_preset ' +
      '(store the edit buffer to a USER memory) HARDWARE-CONFIRMED 2026-07-08: a bare store command ' +
      '(DT1 0x7F000104) did NOT persist a MIDI-set value, but the editor\'s connect handshake always sends ' +
      'Editor Communication Mode ON first, so save_preset now sends that before the store and waits for the ' +
      'device\'s store-ack echo; a set + save + recall round-trip persisted correctly on the maintainer\'s ' +
      'unit. NEWLY WIRED 2026-07-09 (community-beta, hardware-unverified): switch_preset for factory presets ' +
      'P01–P50, via a DT1 write to the "Current Patch Number" register (Setup > SetupCommon, decoded from ' +
      'the editor\'s own patch-switch handler, NOT a Program Change). The SYSTEM/global param region ' +
      '(MIDI, USB, tuner, preference, input/output + their EQs, and a few patch-shaped sections reused at ' +
      'system scope), reachable via set_param/get_param/get_params/list_params under system_* blocks, is ' +
      'HARDWARE-CONFIRMED 2026-07-26: three system params were written and read back on the maintainer\'s ' +
      'unit, corroborated by audible device behaviour rather than by read-back alone (enabling MIDI-note ' +
      'pitch correction end to end). The absolute-addressing mechanism (region:\'system\', no patch base) ' +
      'is shared by all 248. STRENGTHENED 2026-07-28: the MIDI-note pitch-correct path (M>PCR) is now ' +
      'hardware-confirmed DRIVEN FROM A SEQUENCER, over DIN, through an intermediate synth, retuning a ' +
      'LIVE SUNG VOICE for a whole song. Confirmed by ear on the maintainer\'s rig, with pitch_correct ' +
      'switch=ON, type=ELECTRIC, speed=10, stability=+5, shift=0 and pitch_correct_midi.midi_to_pcr set ' +
      'to the channel the sequencer\'s target track transmits on, with system_pref.preference_m2pcr=0 so ' +
      'the PATCH copy is live. That is a different test from the 2026-07-26 one, which was a keyboard ' +
      'played by hand. Scope note, stated narrowly on purpose: what is confirmed is the M>PCR path over ' +
      'DIN with those settings on that rig; whether M>PCR treats the incoming note as an absolute target ' +
      'or as a pitch class is STILL UNDECODED and the manual does not say. A DIAGNOSTIC WORTH KNOWING, ' +
      'found the same day: system_midi.midi_usb_out_thru echoes whatever arrives at the unit\'s DIN MIDI ' +
      'In back out over USB, so one reversible write answers "what is actually reaching this device" ' +
      'instead of inferring it from what the upstream gear claims to send. It is what found the real ' +
      'fault in that chain, which was neither device. ALSO CONFIRMED 2026-07-26: a STORED user memory answers a read on every one ' +
      'of the 874 patch params at its own base address (buildGetParam with patchBase = userPatchAddr(n)), ' +
      '874/874 first try, without recalling it and without disturbing the edit buffer. Still NOT wired: ' +
      'whole-patch get_preset (a speed problem now, not an evidence one: 874 serial round-trips is ~40s, ' +
      'so the decoded chunked section read is the right build). NOTE for recall: user-memory recall is a ' +
      'bare Program Change, so it is dead whenever the unit\'s PC IN is off; factory P01-P50 recall is a ' +
      'SysEx register write and is unaffected. switch_preset now PRE-FLIGHT READS ' +
      'system_midi.midi_program_change_in before a user-memory recall and REFUSES when it is 0, because a ' +
      'Program Change is never echoed and the previous behaviour was to report success while the patch had ' +
      'not changed. The refusal names both ways out (front panel, or set the param to 1 and accept that a ' +
      'stray Program Change on the bus can then recall a patch mid-song) and the server does not flip it. ' +
      'If the pre-flight read gets no answer the recall is still sent, flagged unverified: a read timeout ' +
      'is not evidence the setting is off. Factory recall is deliberately NOT gated.',
    has_scenes: false,
    has_channels: false,
    supports_save: true,
    save_note:
      'save_preset stores the active edit buffer to a USER memory U01–U99: it sends Editor Communication ' +
      'Mode ON, then the store command, then waits for the device\'s store-ack echo (pass ' +
      'save_authorized=true on explicit save intent). Presets P01–P50 are factory/read-only and rejected. ' +
      'HARDWARE-CONFIRMED 2026-07-08 (a set + save + flash-reload round-trip persisted; the device echoes ' +
      'the store, so acked reflects a real device ack).',
    supports_lineage: false,
    // User memories U01–U99 (1–99) and preset P01–P50.
    preset_location_format: /^(U0?[1-9][0-9]?|P0?[1-9][0-9]?|[1-9][0-9]?)$/i,
  },
  canonical_terms: {
    block: 'effect section',
    slot: 'effect section',
    preset: 'memory',
    scene: 'n/a (VE-500 has no scenes)',
    channel: 'n/a (VE-500 has no per-block channels)',
    location: 'memory U01–U99 (user) / P01–P50 (preset)',
  },
  blocks: buildBlocks(),
  reader,
  writer,
  agent_guidance: VE500_AGENT_GUIDANCE,
  example_spec: VE500_EXAMPLE_SPEC,
};
