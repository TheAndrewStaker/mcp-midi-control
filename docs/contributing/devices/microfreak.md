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
| `switch_preset` (Program Change) | confirmed | 0-based: Program Change 4 loaded preset 5. Notable because the manual documents no Program Change support at all (same source) |
| `get_param` / `set_system_param` on Utility globals | confirmed | Global read opcode `0x43` answers for all 128 parameter slots. Global write opcode `0x42` confirmed by writing a value that DIFFERED from the current one and verifying the change by read-back in both directions, since writing an equal value would pass even if the write did nothing (`packages/arturia/src/codec/sysex.ts`, `buildGlobalWrite`). Re-confirmed by consequence, which is stronger than any read-back: switching MIDI Thru on made the synth relay notes out of its DIN port, and a THIRD device downstream acted on them. Re-confirmed again 2026-07-28 on the RELAY path proper, which the 2026-07-26 test never exercised: a sequencer upstream drove a feature on a device downstream for a whole song, ear-confirmed |
| `send_cc` against the curated map | set-only, partly confirmed | The table is Arturia's own manual Appendix D, which is authoritative. CC 23 (cutoff) confirmed audibly, CC 83 (resonance) confirmed byte-exactly by set-CC then save then dump then diff, which moved three bytes under the preset payload's own inline `Reso` label (`packages/arturia/src/devices/microfreak.ts`). The other nineteen entries are documented but not individually checked by ear |
| Reading preset parameter values | gated | The device reports nothing back for them, and its display does not show incoming CC, contrary to the manual |
| Preset authoring or save | gated | The dump payload is a self-describing TLV whose value encoding is undecoded, and no preset WRITE path is known |

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

**Please do not re-run these.** They are done on firmware 5.0.0.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Reading any preset parameter value | Nothing is missing to decode: the device genuinely does not report them. This is a device limitation, not a gap | Nothing can close it |
| Preset authoring and save | The dump payload is a self-describing TLV whose value encoding is undecoded, and no preset WRITE path is known at all | CAPTURE-1 |
| `knob_catch` global semantics | Its label came from community notes and has not been independently re-verified by this project (`packages/arturia/src/devices/microfreak.ts`, the `knob_catch` note) | SESSION-2 |
| `output_dest` values MIDI and None | Both are inferred, never observed, because both cut the USB path every read travels over (`packages/arturia/src/devices/microfreak.ts`, the `output_dest` note) | Cannot be observed over USB by construction |
| Reading or guarding `Utility > MIDI > Merge` | Its SysEx parameter id is unknown. It is not among the eight identified by controlled differential diff, and it is one of the Utility settings the manual lists that we have never mapped. So `get_param` cannot report it, `set_param` cannot set it, and the DIN-leg warning cannot fire on it | SESSION-3 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** MIDI Control Center holds the MicroFreak's USB port
  while it is open. Quit it fully before running anything from this project, and
  quit this project's MCP host fully before opening MIDI Control Center. On
  Windows check the system tray. The exception is CAPTURE-1, which wants MIDI
  Control Center running and this project's server not running.
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

### PROBE-1: Run the Arturia discovery probe, to validate the method
**Tier: PROBE | ~1 minute | read-only | unlocks: trust in every result the same probe returns on a synth nobody here owns**

This one is not about the MicroFreak. It is about making a result from a
**different** Arturia instrument trustworthy.

The Arturia SysEx envelope is brand-level and differs between products only by
one device byte. A discovery probe sweeps all 128 possible bytes with a harmless
read and reports which one answers. On your MicroFreak it should rediscover
`0x07` **without being told**, which is the hardware-confirmed answer here.

That is the whole point: a probe that reproduces a known answer on a known
device is a probe whose answer on an unknown device can be believed. Right now
the MiniFreak is blocked on exactly that unknown byte, and this run is what makes
its answer count for something.

With the MicroFreak connected and MIDI Control Center quit, from a source
checkout:

```
npx tsx scripts/probe-arturia-discover.ts "MicroFreak"
```

Paste the REPORT block it prints. If it returns `0x07`, the method is validated.
If it returns something else, or nothing, that is a bigger finding than the
MiniFreak ask itself, because it means the sweep does not work and the answer it
gives on any other synth cannot be trusted.

**Read-only guarantee, and it is structural.** The only two Arturia opcodes it
sends are `0x43`, read one global setting, and `0x19` with a trailing zero, read
one preset name. It never sends `0x42`, the global write, and never a Program
Change, a CC or a note. Its frame builders are imported from the shipped codec at
`packages/arturia/src/codec/sysex.ts` rather than re-typed, so it cannot drift
from the code it validates (`scripts/probe-arturia-discover.ts`).

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

### CAPTURE-1: MIDI Control Center writing a preset
**Tier: CAPTURE | ~20 minutes | sniffer required | unlocks: preset authoring and save**

There is no known preset WRITE path on this device. Reads are solved, dumps are
solved, and the dump payload's TLV container is understood structurally but its
value encoding is not. What is missing is seeing the other direction: MIDI
Control Center sending a preset **to** the synth.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

Quit this project's MCP host first so MIDI Control Center can hold the port.

1. Start recording. Note your firmware and MIDI Control Center version.
2. In MIDI Control Center, load a preset from its library into a slot on the
   device. Write down which slot.
3. Pause about three seconds. Change one clearly-named parameter in MIDI Control
   Center (a filter cutoff is ideal) and send it to the device. Write down the
   parameter and the value you set.
4. Pause about three seconds. Repeat with one more parameter.
5. Stop and save.

Send the recording plus your written list of what you changed and to what. The
paired list is what makes the bytes decodable; a capture with no notes usually
cannot be used.

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
