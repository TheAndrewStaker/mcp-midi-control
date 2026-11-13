# Helping with the Arturia MicroFreak

<!-- contribution-meta
device_id: microfreak
support_tier: verified
transport: midi
preset_class: voice
owned_by_maintainer: yes
-->

## Device

Arturia's paraphonic hybrid synthesizer: one digital oscillator with a large
model roster, an analog filter, a cycling envelope, an LFO, and a touch
keyboard with an arpeggiator and sequencer. Arturia's configuration app is
**MIDI Control Center**.

The maintainer owns one, so the confirmed list below is long and the open asks
are narrow. The most useful thing another owner can do here is cover the two
things one unit cannot: a **different firmware**, and the parts of the CC table
that have not been checked by ear.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| Preset name read over SysEx | confirmed | Firmware 5.0.0, on the maintainer's unit. Name at fixed ASCII offset 21 with the sequence byte echoed; bank and index addressing proved by reading slot 129 as bank 1 index 0 (`packages/arturia/src/devices/microfreak.ts`, `verification`) |
| Full preset dump over SysEx | confirmed | A 146-packet, 4672-byte dump terminating on the documented `0x17` marker (same source) |
| `export_preset(location)` / `backup_device` byte-exact backup | confirmed | Wired 2026-08-11 over the confirmed dump flow (`packages/arturia/src/descriptor/reader.ts`, `dumpStoredPresetBinary`): one dump start plus the data pulls per preset, stored as verbatim frames in a `.syx` file. Hardware-confirmed 2026-08-14: read multiple real stored presets on the maintainer's unit, and a file it wrote round-tripped byte-exact through `import_preset` (0/6,132 bytes differed on read-back). A stalled or unterminated stream is discarded rather than saved as a truncated backup |
| `switch_preset` (Program Change + Bank Select, all 512 presets) | confirmed | 0-based Program Change reaches presets 1-128 (Program Change 4 loaded preset 5; the manual documents no Program Change support at all). **Bank Select confirmed 2026-08-14**: CC 0 (MSB) selects the bank ahead of the PC, reaching the full 512; CC 32 (LSB) is sent and ignored, so never send it. `scripts/probe-microfreak-bank-select.ts`, confirmed twice independently (a direct landing plus a second landing explained by MSB's stickiness across steps). Hardware-confirmed through the actual `switch_preset` tool call, not just the raw probe: preset 256 loaded and matched the panel exactly. Verifying this surfaced that `.mcp.json` never forwarded `MCP_MICROFREAK_CHANNEL` to the spawned server, so every channel-dependent write to this device had likely been silently landing on channel 1 instead of the device's channel 3 for the device's entire time in this project. Fixed same session |
| `get_param` / `set_system_param` on Utility globals | confirmed | Global read opcode `0x43` answers for all 128 parameter slots. Global write opcode `0x42` confirmed by writing a value that DIFFERED from the current one and verifying the change by read-back in both directions, since writing an equal value would pass even if the write did nothing (`packages/arturia/src/codec/sysex.ts`, `buildGlobalWrite`). Re-confirmed by consequence, which is stronger than any read-back: switching MIDI Thru on made the synth relay notes out of its DIN port, and a THIRD device downstream acted on them. Re-confirmed again 2026-07-28 on the RELAY path proper, which the 2026-07-26 test never exercised: a sequencer upstream drove a feature on a device downstream for a whole song, ear-confirmed |
| `send_cc` against the curated map | set-only, partly confirmed | The table is Arturia's own manual Appendix D, which is authoritative. CC 23 (cutoff) confirmed audibly, CC 83 (resonance) confirmed byte-exactly by set-CC then save then dump then diff, which moved three bytes under the preset payload's own inline `Reso` label (`packages/arturia/src/devices/microfreak.ts`). The other nineteen entries are documented but not individually checked by ear |
| Reading preset parameter values | gated | The device reports nothing back for them, and its display does not show incoming CC, contrary to the manual |
| `import_preset` byte-exact preset restore (stored slot only) | confirmed | Decoded 2026-08-13/14 from a real MIDI Control Center capture writing presets TO a MicroFreak (`packages/arturia/src/codec/sysex.ts`'s "Preset WRITE" section, `packages/arturia/src/descriptor/presetWrite.ts`): a metadata push + confirm + begin marker + 146 payload frames, each individually ACKed. The 146-frame payload was first shown BYTE-IDENTICAL to a live `export_preset` read of the same preset (0/146 frames differ), then **hardware-confirmed 2026-08-14**: this project's own implementation restored a preset to slot 506, and a fresh read-back afterward matched the source file at all 6,132 bytes. Requires `target_location`, `save_authorized`, an explicit `name` (a byte-exact dump does not carry the preset's name; only `export_preset`'s JSON response does), and `confirm_overwrite` on an occupied slot; verified by the closing read-back matching the written name, not by the per-frame acks. `save_preset` stays refused: no separate persist opcode was found, a stored-slot write over SysEx IS the persist here |
| Preset "Type"/category tag on a written preset | confirmed | The metadata push carries a 1-byte category tag. The VALUE SPACE is decoded: it is MIDI Control Center's Type field as an alphabetical ordinal (`Bass 0, Brass 1, Keys 2, Lead 3, Organ 4, Pad 5, Percussion 6, Sequence 7, SFX 8, Strings 9, Template 10, Vocoder 11`), read off the 322 non-empty presets of a device export whose names partition cleanly across the twelve. It is still NOT derivable from a byte-exact dump (it is absent from the payload at every offset), so `import_preset` takes it as an explicit `preset_type` and copies it through uninterpreted, exactly like `name`. **Hardware-confirmed 2026-08-15**: 512 consecutive writes spanning all twelve values, each overwriting a slot whose previous tag differed, and every closing read-back returned the tag just written (`decodePresetType`, offset 19). Omitting `preset_type` still writes 0x00. One caveat: 3 presets in that corpus carry bit 7 set (128/129/131); a SysEx data byte cannot exceed 127, so that flag is unwritable and those presets land as 0/1/3 |
| MCC project archive (`.mfprojz`) as a preset source | confirmed | Each `.mbp` inside the zip is a Boost text archive whose trailing vector IS the device payload, already 7-bit, and byte-identical to what `export_preset` reads. Proved against a live hardware read of slot 196 (all 4672 bytes) and against a stored dump. `packages/arturia/src/codec/mfprojz.ts` parses it and frames it for `restorePresetBinary` with no re-encoding. The filename number is a POSITION LABEL consumed in LEXICOGRAPHIC order, not a slot number (rank 11 is label "100"), which `slotOrder` implements; reading it as a slot scrambles everything from slot 11 on. No MCP surface yet; see the ask below |

Support tier: `verified`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/arturia/src/devices/microfreak.ts`; the contribution gate fails if the two disagree.
Hardware-confirmed on the maintainer's unit: the SysEx read path, Program Change recall, and the global read and write opcodes. The CC TABLE is authoritative (Arturia's own Appendix D) but only 2 of its 21 entries have been put on hardware, which is the open ask below.

**Preset parameters are write-only on every Freak.** Only `system.*` globals
read back. Never treat a CC write as verified; ask to hear it.

**The 5-pin MIDI Out is governed by three settings and we can only see two of
them.** `midi_thru` and `output_dest` read back over USB. `Utility > MIDI > Merge`
does not, because its parameter id has never been identified. So a MicroFreak
that reads perfectly healthy from this server can still be relaying nothing at
all. See "Before you start" below if your MIDI Out feeds another device.

**And it is not a transparent thru on its own receive channel.** Measured at the
far end of a real chain on 2026-07-28: it relays every channel it receives EXCEPT
the one it is set to receive on, which it absorbs in order to sound it. So a line
on that channel reaches **the MicroFreak** or **something downstream**, never
both. Nothing this server can read reports it, and no setting we know of changes
it. Give a downstream device a channel the MicroFreak does not consume.

## Confirmed on hardware

All of the following were confirmed on firmware 5.0.0 on the maintainer's own
unit. The trail is in `packages/arturia/src/devices/microfreak.ts` and
`packages/arturia/src/codec/sysex.ts`.

- SysEx preset-name read, including bank and index addressing.
- Full 146-packet preset dump.
- Program Change preset recall, and that it is 0-based.
- Utility globals READ, opcode `0x43`.
- Utility globals WRITE, opcode `0x42`, verified with a differing value in both
  directions, and separately by consequence: writing MIDI Thru on made the synth
  relay notes out of its DIN port to another device, which then acted on them. An
  echo of our own frame cannot produce that.
- The DIN **relay** path, 2026-07-28, which is a different test from the one
  above: traffic arriving at MIDI In merged onward to a downstream device and
  drove a feature there for a whole song. It also established which channel it
  does NOT relay, namely its own.
- Seven Utility globals identified by controlled differential diff. That work
  corrected a wrong community label (`0x2B` is Arp/Seq MIDI out, not "arp on
  off") and established that MIDI channels store 0-based.
- CC 23 and CC 83.
- **`import_preset` byte-exact preset WRITE, 2026-08-14.** Restored a preset
  ("Revert to Iron") to a different stored slot (505 -> 506, overwriting
  "Yggdrasil") via the decoded write protocol; a fresh `export_preset` read of
  the destination immediately after matched the source file at every one of
  6,132 bytes. The write path is confirmed, not just byte-identical-to-a-read
  in theory.
- **Discovery-probe method, 2026-08-14.** `scripts/probe-arturia-discover.ts`
  rediscovered device code `0x07` on the MicroFreak without being told,
  validating the sweep method (its result on an unowned Arturia instrument,
  e.g. the MiniFreak, can now be trusted). Read-only by construction: only
  `0x43`/`0x19`, never a write.

**Please do not re-run these.** They are done on firmware 5.0.0.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Presets on the Sample / granular engines playing after a restore | **Nothing is missing to decode, and this is NOT a preset problem.** Those firmware-5 engines play back SAMPLE MEMORY, which lives on the device separately from any preset and is NOT carried in a preset dump. A byte-exact restore of such a preset is silent when the device's sample memory is empty. Confirmed 2026-09-12 on the maintainer's unit: MCC's SAMPLES tab read **0.0s of 209.9s**, and ~25% of the tested library was silent while every classic-engine preset played. Cause: the V5 firmware update is TWO-PHASE (firmware, then a factory-sample transfer) and MCC closed itself after reporting "burn process completed successfully", so phase two never ran. Fix is in MCC's SAMPLES tab, not in any preset | Nothing pending; a device-content issue, not a codec gap |
| Restoring the factory SAMPLES after a firmware update | **Nothing to decode; two undocumented preconditions.** The V5 update is TWO-PHASE (firmware burn, then a factory-sample transfer) and the second phase is easy to lose: on the maintainer's machine MCC reported "The burn process completed successfully", printed "initializing", then CLOSED ITSELF, so the samples never transferred. **The device must also be sitting on an INIT PRESET (triple-click the Preset encoder) before it will accept a sample transfer at all** -- MCC refuses otherwise with "Please load an init preset (3 clicks on Preset Encoder) and start the sample transfer again", which is almost certainly why phase two fails silently for other owners too. The factory bank is 52 samples (~26 MB) and ships WITH MCC at `%PROGRAMDATA%\Arturia\MIDI Control Center\Templates\MicroFreak\Samples\Local\Factory`; no preset bank (`.mfprojz`) contains samples, so a bank's Sample-engine presets reference slot INDICES and will play whatever sits there. Confirmed end-to-end 2026-09-12: 0.0s of 209.9s before, all 11 reported-silent presets audible after | Nothing pending; a device-content issue |
| Writing a sample to the device (`upload_sample`) | The MCC sample-transfer wire format is undecoded. One clean USBPcap capture of a SINGLE sample into a SINGLE slot would likely be enough, the same way the preset-write capture yielded `import_preset`. Do NOT capture a 52-sample bulk run: the writes interleave and the framing is ambiguous | **An owner capture would close this.** See `docs/contributing/tools/` |
| MicroFreak invisible to MIDI after a firmware update (Windows) | **Not a device fault and not a driver fault.** After the firmware reboot the unit enumerates perfectly (`Get-PnpDevice` shows both nodes `Status OK, Problem 0`, arturiausbmidi 1.7.0.0) while exposing NO MIDI ports, because `midisrv` published no `MIDIU_*` endpoints for it. MCC shows the device under "Connected" yet reads `Firmware Revision: Unknown`. **A USB replug does NOT fix it.** An elevated `Restart-Service -Name midisrv -Force` republishes the endpoints immediately. Diagnose by comparing `SWD\MIDISRV\MIDIU_*` nodes against a device that works, not by trusting Status | Nothing pending; a Windows MIDI-stack issue |
| Reading a LIVE preset parameter value over the wire | Nothing is missing to decode: the device genuinely does not report them, and does not track CC-set values in its knob-catch position either. This is a device limitation, not a gap | Nothing can close it |
| Reading a STORED preset's parameter values | **Nothing. This is decoded as of 2026-09-12 and is no longer blocked.** The 4672-byte payload is self-describing: an inner MIDI 7-bit packing (1 marker byte + 7 data bytes, LSB-first) wrapping `#SECTION` markers and `<0x40\|nameLen><name>'c'<3-byte LE value>` records, giving 56+ named parameters across VCO, VCF, EG1, EG2, Kbd, Arp, LFO, Gen, Sys, Mat and the seven modulation-matrix columns Co1-Co7. Self-validating on two counts: the field names are READ, not inferred, and the value ranges independently match the manual (`Gen.PrstVol` has exactly 25 distinct values and Preset Volume is documented -12..+12). The earlier byte-exact CC 83 confirmation had already seen three bytes move under the payload's own inline `Reso` label; nobody generalised it. `unpack7 -> edit -> pack7` is byte-exact on 512/512 payloads, so edits can be written back through `import_preset`. **HARDWARE-CONFIRMED 2026-09-12**: a live `export_preset` of slot 313 and the same preset from its bank archive differ in 1,116 of 4,672 bytes (a front-panel Save rewrites performance state), yet decode to IDENTICAL values for 105 of 110 fields. The 5 deltas are 4 firmware-5-only fields the older archive predates (`EG2.Snap`, `Gen.SmpHash`, `Mat.KyMdSrc`, `VCO.SmpIdx`) and one LSB difference in `VCO.Type` (4 parts in 8.4 million). Two byte streams a quarter different decoding to the same values confirms the unpacking, record walk, value width, field names and scaling together. What is still missing is a TOOL surface, not evidence | No MCP surface yet; research parser at `scripts/_research/microfreak-preset-decode.py` |
| Whole-library restore through the MCP surface | Nothing is missing to decode. The wire path, the archive parse and the batch loop all exist and have run a 512-slot send on hardware; what is missing is the tool. `backup_device` sweeps a RANGE but its inverse does not exist, so restoring many presets is N calls of the single-preset `import_preset`. The verb that closes it is a `restore_device` mirroring `backup_device`'s policy, duration gate and per-call cap. It is a gap shared with every multi-slot device here (AM4 104, Axe-Fx II 384, Hydrasynth 1024, Circuit 64), not a MicroFreak one | Nothing pending; driven today by `scripts/microfreak-send-library.ts` |
| The bit-7 flag on a preset's category tag | 3 of 322 device presets carry it (128/129/131) and its meaning is unknown. It cannot be written regardless, because a SysEx data byte cannot exceed 127, so this is a fidelity note rather than a blocker | Nothing pending |
| `knob_catch` global semantics | Its label came from community notes and has not been independently re-verified by this project (`packages/arturia/src/devices/microfreak.ts`, the `knob_catch` note) | SESSION-2 |
| `output_dest` values MIDI and None | Both are inferred, never observed, because both cut the USB path every read travels over (`packages/arturia/src/devices/microfreak.ts`, the `output_dest` note) | Cannot be observed over USB by construction |
| Reading or guarding `Utility > MIDI > Merge` | Its SysEx parameter id is unknown. It is not among the eight identified by controlled differential diff, and it is one of the Utility settings the manual lists that we have never mapped. So `get_param` cannot report it, `set_param` cannot set it, and the DIN-leg warning cannot fire on it | SESSION-3 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** MIDI Control Center holds the MicroFreak's USB port
  while it is open. Quit it fully before running anything from this project, and
  quit this project's MCP host fully before opening MIDI Control Center. On
  Windows check the system tray.
- **Two globals can break a downstream device silently.** If the synth's MIDI Out
  feeds anything, `midi_thru` off stops relaying and `output_dest` set to USB-only
  drops the DIN leg. Both leave every read over USB looking perfectly healthy, so
  the failure shows up only at the other end of the cable. The server now warns
  on either write, but **only if a rig manifest declares something plugged into
  that output** (`MCP_RIG_MANIFEST`, an enabled MIDI edge out of the synth's DIN
  port). It cannot see your cabling otherwise, so with no manifest the write goes
  through silently, exactly as before. It warns rather than refuses: turning Thru
  off is a legitimate thing to want, and most owners have nothing on that jack.
- **And a third setting does the same, which nothing here can see.**
  `Utility > MIDI > Merge` (values along the lines of `USB+KBD`, `MIDI+KBD`,
  `BOTH+KBD`) selects which sources are merged into the MIDI Out. On the USB-only
  value your own playing on the keyboard still leaves the MIDI Out, while
  anything arriving at the MIDI In is **not** merged in and is silently dropped.
  If you are using the MicroFreak as a link in a chain, so that a sequencer
  upstream should reach a device downstream, this is the setting that has to be
  right, and it is not one of the eight globals we can read. **If your downstream
  device goes quiet, check its CHANNEL first (below), then Merge.** No asking
  this server will show it to you, and `midi_thru` and `output_dest` will both
  read correct while the chain is dead.

  **A claim that used to sit here has been WITHDRAWN.** It said Merge had been
  caught silently blocking a relay on the maintainer's rig. That was refuted on
  2026-07-28. The case rested on the MicroFreak's USB port showing zero channel
  messages while thousands were arriving at it, and that was never evidence
  about the DIN leg: the USB port does not report relayed traffic at all. In the
  very window its USB showed zero, its MIDI Out was measured **delivering four
  channels** to the device downstream, and Merge was `BOTH+KBD` throughout.
  **What it actually does, measured at the far end of the chain:** it relays
  every channel it receives EXCEPT the one it is set to receive on. In a
  55-second window, channels 1, 2, 4 and 10 all arrived at the downstream device
  plus clock; channel 3 was **absent**, and the synth's own Input Chan was Ch.3.
  **It absorbs its own receive channel in order to sound it.** So a line on the
  channel the MicroFreak plays can reach **the MicroFreak** or **anything
  downstream**, never both. No setting we know of changes that and nothing
  readable from here reports it: it is a topology constraint, not a settings bug.
  If you are chaining this synth, give the downstream device a channel the
  MicroFreak does not consume. The relay itself is confirmed working, and was
  ear-confirmed carrying a downstream feature for a whole song.

  One related trap worth knowing: relaying and playing are **not** the same test.
  Confirming that notes you play on the MicroFreak's own keyboard reach the next
  device proves nothing about whether a sequence arriving at its MIDI In gets
  through. Two separate things block the second while permitting the first: the
  USB-only Merge value, and the receive-channel absorption above, which blocks
  exactly one channel and passes every other.
- **The `output_dest` global can cut your own USB connection.** It is a bitmask,
  not the plain enum the manual implies: USB is bit 0 and MIDI is bit 2, so USB
  reads as 1 and BOTH as 5. Setting it to MIDI-only or None removes the path
  every read travels over. The server tracks which values keep USB alive
  (`OUTPUT_DEST_USB_ALIVE` in `packages/arturia/src/devices/microfreak.ts`), but
  do not set that global by hand mid-session.
- **Firmware updates.** Never run Arturia's firmware updater while an MCP host
  or a probe holds the port. Quit everything first.
- **What we will never ask you to do.** No firmware modification, no factory
  reset, no opening the unit.

## Asks, ranked

### SESSION-3: Find the parameter id behind `Utility > MIDI > Merge`
**Tier: SESSION | ~10 minutes | read-only probe plus one front-panel change | unlocks: the ability to READ, and to warn about, the setting that can silently kill a MIDI chain**

**Worth doing, not urgent.** A 2026-07-28 measurement that briefly blamed Merge
for a dead relay was refuted, so no chain here is known to have been broken by
it. The gap is still real: this is the one thing you can do
here. `Merge` decides whether traffic arriving at the MIDI In is merged into the
MIDI Out, and right now nothing in this project can see it, so a chain that is
dead because of it looks perfectly healthy from here.

Every other global in the table was identified the same way, by changing exactly
one front-panel setting and seeing which of the 128 parameter slots moved. That
is all this is.

With the MicroFreak connected and MIDI Control Center quit, from a source
checkout:

1. Snapshot everything:

   ```
   npx tsx scripts/probe-microfreak-globals.ts
   ```

2. On the device, go to `Utility > MIDI > Merge` and change it to a **different**
   value. Change nothing else, not one other setting, or the diff becomes
   ambiguous and the run is wasted. Write down the value before and after.

3. Snapshot again with the same command.

4. Send both outputs plus the two values you saw on the panel.

Exactly one parameter id should differ between the snapshots, and that id is
`Merge`. If more than one moved, something else changed too and the run cannot be
used; redo it.

**Read-only guarantee.** The probe sends only the read opcode `0x43`, never the
write opcode `0x42`, and it is structural rather than a promise: the opcode is
written literally in `scripts/probe-microfreak-globals.ts` rather than passed in.
The only thing that changes on your synth is the one setting you change yourself
on the front panel, and you can put it straight back.

Worth reporting even on its own: if you have this synth wired between two other
devices, say which Merge value made the relay work. That is the second half of
the answer and nobody has confirmed it yet.

### REPORT-1: Confirm the firmware 4 preset ceiling
**Tier: REPORT | ~3 minutes | unlocks: correct slot addressing on older firmware**

Everything confirmed here was confirmed on firmware 5.0.0, where the device has
512 preset slots. Firmware 4 has 384
(`MICROFREAK_PRESET_COUNT_FW5` in `packages/arturia/src/devices/microfreak.ts`).
If you are still on firmware 4, that difference is unverified and it changes
where slot addressing stops working.

In your MCP host: ask what preset is stored in a high slot, for example

> "what preset is in slot 400 on my MicroFreak?"

Report your firmware version and what came back: a name, or nothing. The name
read simply stops answering past the ceiling, so either answer settles it.

### SESSION-1: Check CC entries nobody has heard yet
**Tier: SESSION | ~10 minutes | writes CC only, nothing is saved | unlocks: confidence across the CC map**

Only two of the twenty-one CC entries have been confirmed by ear or by byte
diff. The rest come from Arturia's own Appendix D, which is authoritative, but
authoritative is not the same as heard.

Connect the MicroFreak, quit MIDI Control Center, and ask for a few:

> "Send CC 9 at value 100 to my MicroFreak, then CC 9 at value 20."

Good candidates, all from `packages/arturia/src/devices/microfreak.ts`: CC 9
(oscillator type), CC 12 (timbre), CC 13 (shape), CC 26 (filter amount), CC 28
(cycling env hold), CC 102 and CC 103 (cycling env rise and fall), CC 2 (spice).

Report which ones did what you expected and which did not. The device does not
show incoming CC on its display, so this is done by ear.

### SESSION-2: Re-verify the knob-catch global
**Tier: SESSION | ~5 minutes | reads and writes one Utility global | unlocks: a verified label on `knob_catch`**

`knob_catch` (parameter id `0x2d`, values Jump, Hook, Scaled) is the one global
in the table that came from community notes rather than from this project's own
controlled diff. Every other entry was identified by changing exactly one
front-panel setting and re-snapshotting all 128 parameters.

In your MCP host:

> "read the knob catch setting on my MicroFreak"

Compare the answer to what your Utility menu actually shows. Then change it on
the front panel, ask again, and confirm the reported value tracks. Reading is
harmless; the write path is confirmed and reversible.

Report both readings and both front-panel states.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- firmware version, which matters more here than usual because the confirmed set
  is firmware 5.0.0 specific,
- operating system,
- MIDI Control Center version,
- whether MIDI Control Center was open at the same time,
- for a SESSION ask, what you heard, since the display shows nothing.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).
