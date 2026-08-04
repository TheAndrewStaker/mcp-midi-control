# Helping with the Novation Circuit Tracks

<!-- contribution-meta
device_id: circuit-tracks
support_tier: verified
transport: midi
preset_class: voice
owned_by_maintainer: yes
-->

## Device

Novation's groovebox: two polyphonic synth engines, four drum tracks, two
outward MIDI tracks, and an eight-pattern sequencer per track, all stored in
projects on a card that can hold several packs. Novation's companion apps are
**Components** (web) and **Novation Components** (desktop).

The Circuit is the one device here that is both an instrument and a **host**: it
sequences other gear through its MIDI 1 and MIDI 2 jacks, so a pattern authored
here can drive a drum pad or a synth downstream. That makes its asks unusual;
several of them are about what happens on a **second** device.

The maintainer owns one, so most of the read surface is confirmed. The write
surface has specific holes, listed below.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| Transport and drum-note triggering on channel 10 | confirmed | Owner-confirmed on hardware: an audible drum hit through this server (`packages/circuit-tracks/src/descriptor.ts`, `verification`) |
| `apply_pattern` live streaming: melodies, chords, transpose on Synth 1 and 2 | confirmed | Owner-confirmed on hardware |
| Project upload with authored note tracks and drums | confirmed | An authored project round-tripped onto the device, loaded, and played on the device clock: an octave bass on Synth 1 with a kick on Drum 1 |
| `apply_pattern condense_drums`: a full kit squeezed onto Drum 1..4, stored at mixer level 0 | hardware-unverified | Built on two confirmed halves: the drum step / `drum_choice` sample-flip encoding is owner-confirmed, and the four stored drum-level bytes were decoded by a controlled on-device differential (all four set to distinct values in one pass, saved, re-downloaded, diffed on a clean 11-byte stride). What has not been confirmed on hardware is the two together: a condensed project loaded on the device and dialled up from the mixer. Note that a Save done ON the device recaptures the physical fader positions and reverts a file-authored level |
| Note LENGTH and TIE-FORWARD: the gate lane is `tie << 7 \| gate_sixths`, magnitude 1..96 sixths of a step | confirmed | Decoded from the user guide plus a 274-file / 44,898-note corpus census, then confirmed on the maintainer's device: a tie written at a magnitude of 48 (8 steps, raw byte 176) was loaded and SAVED on the unit and read back unchanged, which also settles that the flag and the length are independent fields. The save moved the synth 1 mixer byte on its own, so the device re-serialised the project from its own state rather than echoing the uploaded image |
| `apply_pattern` authors note lengths and ties: `"c3:4"` holds four steps, `"c3:16_"` ties a drone forward | hardware-unverified | The encoding is confirmed (row above) and the authored bytes are golden-locked byte-exact against it. What has not been confirmed is a project authored WITH lengths, loaded on the device, and heard holding |
| Upload PRESERVES hand-set note lengths and ties (`preserve_template_gates`, default on) | confirmed | `apply_pattern mode:ncs_upload` template-modifies a stored project, and before this the authoring path emitted only a one-step gate, so a re-author flattened every hand-dialled note length and dropped all 1,048 tie flags in the maintainer's own songs. The template's gate and tie are now carried through per (step, note), and an inherited tie that the new arrangement no longer reaches is dropped and reported rather than left as a device no-op. Pass `preserve_template_gates:false` to opt out; the destructive direction is the one you have to ask for |
| **Test A.** A chained pattern advances at its OWN length, not on a fixed 32-step boundary, and two tracks whose length sequences MATCH stay in sync while doing it | confirmed | Confirmed by ear on the maintainer's device, 2026-07-29. A throwaway project put four patterns of 24, 24, 30 and 18 steps on Drum 1 and on Synth 1, one hit on step 0 of each, both tracks chained across all four, at 60 bpm so the quarter-note click ticks once a second. Heard: four hits per 24-second cycle, three of them landing ON a click and the fourth exactly BETWEEN two clicks, with the drum and the synth always sounding together. That off-the-click hit is the proof, because it can only occur if the 30-step and 18-step patterns advanced at their real lengths; a fixed 32-step boundary would put every hit back on a click. The stored length bytes had already been read back independently as 23, 23, 29 and 17 (the field is steps-1), which is what separates "the device ignores our lengths" from "we failed to write them". This also confirms a four-pattern chain (`end=3`) on a DRUM track, where only `[0,1]` had been device-isolated before. **What A alone cannot answer, which is why there is a Test B:** both tracks carried the SAME sequence, so one common boundary and four independent per-track boundaries produce identical audio |
| **Test B.** Two tracks holding DIFFERENT pattern lengths at the same time (a 4/4 part under a 7/8 part) | confirmed | Confirmed by ear on the maintainer's device, 2026-07-29, the same day as Test A and deliberately after it. Drum 1 chained 24, 24, 30, 18 against Synth 1 chained 18, 30, 24, 24: the same four numbers in a different order, so both total 96 steps and the two tracks must re-meet at the top of every 24-click cycle if they really are advancing independently. Equal totals are what make drift falsifiable rather than merely visible. Predicted and heard, counting clicks at 60 bpm: both together on click 1, synth alone between 5 and 6, drum alone on 7, both on 13, synth on 19, drum alone between 20 and 21, both again on 25. In his words, *"I can confirm all six events fired as expected with your click and what table you showed me."* **Two independent things are proved by two different halves of that pattern.** The four SINGLE events can only occur if each track is advancing on its own length while the other is mid-pattern, so per-track advance is genuine and not one shared boundary. The two DOUBLED events staying glued across repeated cycles prove the tracks re-sync rather than free-run, which is the failure a locked device would not have shown. **Together with Test A this device hosts mixed metre in full:** a chain may change length pattern to pattern, and two tracks may disagree about where their boundaries fall |
| Authored projects carry their own stored TEMPO (`apply_pattern` `bpm`, or `ncs_tempo`) | confirmed | A project stores its tempo in its file and the device adopts it on load, so before this the authoring path wrote nothing there and every authored project silently inherited the blank template's 120 rather than the song's tempo. The field is one byte at `0x34`, and the encoding is the BPM directly: three independent points fix it (the user guide's documented 120 default, which every never-tempo-touched project on the maintainer's card reads exactly; a 108-bpm song's project reading 108; a 122-bpm song's reading 122), and the documented 40..240 range leaves no room for an offset. Written and read back on hardware, one byte of 160,780 moved with zero collateral. Out-of-range REFUSES rather than clamping. A Save done ON the device stores the front panel's tempo instead, so re-apply after a manual save |
| Authored projects carry their own pad COLOUR (`apply_pattern` `colour`) | confirmed | Mid-set, Projects View shows a grid of LIT PADS, not names, so before this the only visual boundary between one song's projects and the next was a deliberately-blanked slot. The colour is a palette index 0..13 in an LE uint32 at `0x0C`, and it is device-confirmed in the direction that matters: two projects were stamped offline as a single-byte write (index 0 and index 8), uploaded, and the device rendered those two pads RED and GREEN in Projects View, as written. Exactly one byte of 160,780 moved per project, with no re-serialisation and no CRC fixup, so a file-authored colour is honoured and does not need the on-device Save plus Macro 1 procedure. Authoring stamps it BEFORE the transfer, so the byte rides the same CRC-gated upload as the rest of the project. Omitting it inherits the template's colour and says so in the receipt, and passing nothing leaves the file byte-identical. An unknown colour REFUSES rather than substituting one. Two of the fourteen hues have been seen rendered, so the palette ORDER between them is read off Novation's own names. Unlike tempo and the mixer levels, a device-side Save is expected to PRESERVE a file-authored colour, since the manual has Macro 1 start at the project's current colour; that specific sequence has not been exercised |
| Authored projects carry their own NAME (`apply_pattern` `project_name`) | confirmed | The stored name is a fixed 32-byte space-padded ASCII field at `0x10..0x2F`, and that exact write class is device-confirmed: the After Dark projects were renamed offline as this edit, uploaded, and they list and load on the device under the new names (2026-07-28). Before this, authoring could not set a name, so every project authored from one template listed under the template's name and needed a bespoke rename script afterwards. Omitting it keeps the template's name byte-identical and the receipt says so; a name over 32 characters or containing non-ASCII REFUSES rather than truncating, because a silently shortened name is two different songs reading identically on the card |
| Authored projects carry STORED per-track MIXER levels (`apply_pattern` `mixer_levels`) | confirmed | The synth level bytes (`0x2701C/D`) and the drum level stride (`0x26FBD + n*11`) were each decoded by a controlled on-device differential (2026-07-26), and the direction that matters is device-confirmed by the working repertoire: After Dark stores Synth 1/2 at 0 in every project (the silent vocal-target design) and plays live that way, so a file-authored level is honoured on load. The argument is PARTIAL by design: name only the tracks to set. The two SYNTH levels DEFAULT to stored-silent 0 when unnamed (the repertoire convention, 2026-07-29: external gear carries the synth voices; explicit keys override, including deliberately loud values), while an unnamed drum keeps the template's byte, and the receipt lists every track's outcome. Out of range REFUSES. A Save done ON the device recaptures the physical faders and reverts stored levels |
| `condense_drums` COMPOSES with `drum_binding` (bind first, condense onto the bound layout) | hardware-unverified | The pair used to refuse each other, which made the working repertoire impossible to re-author from source: After Dark's card carries binding `[1,2,5,11]` AND condensed internal drums together, ear-confirmed live. Both halves are individually confirmed (the binding bytes at `0x1A278..B` by an on-device differential, the flip/`drum_choice` encoding by capture), and the composition rule is golden-locked: the binding declares where each track's OWN role sample lives, condensation lays the groove onto those tracks, and per-step sample flips resolve against the BOUND slots rather than the canonical layout. A folded piece outside the four bound roles is unlocatable in a custom pool, so its flip is skipped with a warning naming the `drum_flips` remedy, never guessed. What has not been exercised is one apply_pattern call producing that composed state and being played from the device |
| Pack-addressed reads: `scan_locations`, `get_preset`, `list_samples` | confirmed | Owner-confirmed on a five-pack card. A pack's project directory listed in one round trip and matched the known layout; pattern occupancy reported across all eight patterns; a chosen pack's sample pool came back distinct from another pack's, which proves the pack byte reaches the wire |
| Wire framing and the parameter map | hardware-unverified | Transcribed byte for byte from Novation's published Programmer's Reference Guide and cross-checked against the document |
| Synth `set_param` writes over CC and NRPN | hardware-unverified | Derived from the same published guide. No on-device confirmation |
| SAMPLE write to a pack other than pack 1 | confirmed | Owner-confirmed on a two-pack device. Pack 1's whole pool was read off the device, each download gated by the device's own CRC32, and 63 slots written to pack 2. The slot number is ADDRESSED, not append-ordered, and that was proven rather than assumed: slot 0 was written alone, then slot 63 written second and out of order, and it landed at 63 instead of at the next free index. Eight slots read back off pack 2 were byte-identical to the originals and a full 64-slot name diff was clean. Not re-checked across a power-cycle: the evidence is a device read-back, not a reboot |
| PROJECT write to a pack other than pack 1 | confirmed | A separate claim with separate evidence, same day. Two authored projects were written to pack 2, each slot read-checked empty first, then independently downloaded back and CRC-verified, with every track asserted to hold the part it should rather than merely to hold something. Not yet loaded and PLAYED from that pack, and no power-cycle |
| Verifying a write by re-reading immediately | do not do this | The device flushes a pack's manifest roughly 6 to 8 seconds AFTER the transfer session closes. A read taken 1.2 seconds after a write reported 8 slots empty that a later read showed present. Poll instead: reconnect, wait about 9 seconds, then retry every 5 seconds. This device has no erase, so a false "the write failed" leads to a redo that is not harmless |
| Recording external MIDI onto a **drum** track | not supported by the device | The manual and an on-device test agree: record-capture is synth-track only. A drum part reaches the device either as a live stream or inside an uploaded project, never by recording |
| Erasing a stored PROJECT (`delete_project`) | shipped, status word pending | The wire path was decoded on 2026-07-29 by re-mining captures that had been on disk since 2026-06-27, so the capture ask this once needed was never necessary. Across seven captures the delete opcode is only ever sent for slots the device's own occupancy query calls occupied, and in two of them most of those slots are cleared and never rewritten: 62 in one (46 projects and 16 patches), 11 in another. A frame that removes a file and is followed by no write is not the "per-slot info read" it had been recorded as. The maintainer then ran it on his own unit the same day. Gates: read before delete, a mandatory CRC-verified backup, an explicit `confirm_delete`, a hard per-call ceiling, and an after-check by two independent oracles. The status word here is the maintainer's to set |
| Erasing a stored SAMPLE or PATCH | gated | The same opcode addresses them (the fileType byte is all that differs, and both are exercised in the captures above), but only the project path is wired to a tool. Samples and patches stay gated because the sample pool is what the 2026-06-27 incident emptied, and because a project can be backed up byte-exact before it is erased while a sample slot has no equivalent read-back yet |

Support tier: `verified`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/circuit-tracks/src/descriptor.ts`; the contribution gate fails if the two disagree.
The tier is set from the PRIMARY authoring surface, which is owner-confirmed on hardware. One surface remains unconfirmed and is named in the descriptor's own `verification` string: synth CC/NRPN writes, which is what `set_param` does. The pack-addressed write path used to sit alongside it and was confirmed on 2026-07-27, as two separate claims with separate evidence, one for samples and one for projects.

## Confirmed on hardware

All on the maintainer's own unit:

- Transport and drum-note triggering on channel 10.
- Live-streamed melodies, chords and transposition on both synth engines.
- Uploading an authored project that then loads and plays on the device clock.
- The pack-addressed read surface, on a five-pack card.
- The note gate lane splitting into a tie flag plus a length in sixths of a
  step, with the two independent: a tie written at 8 steps (raw byte 176)
  survived a load-and-save on the unit.
- Writing SAMPLES to a pack other than pack 1, including that the slot number is
  addressed rather than append-ordered: 63 slots cloned onto pack 2, read back
  byte-identical, with an out-of-order write landing at its own index.
- Writing PROJECTS to a pack other than pack 1: two authored projects written to
  pack 2 and independently downloaded back, CRC-verified, each track holding the
  part it should. They have not yet been played from that pack.
- **Mixed metre, in two listens that had to be separate.** Test A proved a
  chained pattern advances when its own length elapses rather than padding to 32,
  and that two tracks carrying the SAME length sequence stay together. Test B
  then put a DIFFERENT sequence on each track (the same four lengths reversed, so
  both totalled 96 steps) and heard all six predicted events per cycle: the four
  single ones prove the tracks advance independently, the two doubled ones
  holding across cycles prove they do not drift apart. A alone could not have
  answered B, because matching sequences make one shared boundary and four
  independent boundaries sound identical.

**Please do not re-run these.**

One thing that came out of the same session and is worth more than either
confirmation, because it will mislead anyone who does not know it: **the device
flushes a pack's manifest roughly 6 to 8 seconds after the transfer session
closes.** A read-back taken 1.2 seconds after a write reported 8 slots empty that
a later read showed present. Nothing had been lost; the check was too fast. When
you verify a write, poll: reconnect, wait about 9 seconds, then retry every 5
seconds, and only call a slot absent once that window has clearly passed. This
device has no erase, so concluding "the write failed" when it did not leads to a
redo that is not harmless.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Synth parameter writes over CC and NRPN | An owner confirming by ear that a written parameter moved | SESSION-1 |
| Erasing a stored SAMPLE | A sample slot cannot be read back byte-exact yet, so an erase could not be made reversible the way a project's can. The project path takes a CRC-verified backup first and that is what makes it safe to ship; without the equivalent for samples, the same opcode stays gated | (no ask; needs the sample read-back, not a capture) |

Delete was on this list until 2026-07-29 with a capture ask attached to it. It
came off without anyone capturing anything: the evidence was already in captures
filed on 2026-06-27 and had been read as a per-slot info request. Worth
remembering before asking a contributor for device time.

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity, and this device is unusually strict.** The Circuit's port
  is held by whichever process got it first. If a previous MCP session is still
  holding it, replugging the USB cable does **not** free it: restart the MCP
  connection instead. Novation Components also holds the port.
- **There is no undo and no delete.** Uploading a project or a sample to an
  occupied slot overwrites it, and this project cannot remove anything
  afterwards. Back up first. The server defaults to taking a backup before a
  transfer for exactly this reason, and you should leave that default on.
- **Power-cycle to verify a write, and never verify immediately.** The device
  rescans stored files on boot, so a freshly uploaded project or sample should be
  confirmed after a restart. Immediately is the wrong moment for a different
  reason too: the pack manifest is flushed roughly 6 to 8 seconds after the
  transfer session closes, so a read taken sooner reports slots empty that are
  simply still in flight. If you are checking from software rather than the front
  panel, poll: wait about 9 seconds, then retry every 5 seconds.
- **Firmware updates.** Never run Novation's updater while an MCP host holds the
  port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Confirm a synth parameter write by ear
**Tier: SESSION | ~10 minutes | writes to the live synth, nothing is stored | unlocks: `set_param` on the synth engines**

The parameter map is transcribed from Novation's published guide and
cross-checked against it, which is strong evidence, but no owner has confirmed
that a write actually moves the parameter.

With the Circuit connected and Novation Components quit, hold a note or run a
pattern so you can hear the engine, then:

> "Set the filter cutoff on Synth 1 to 30, then to 100."

Then try a resonance, an envelope time, and a macro.

Report which ones moved what you expected. **A parameter that moves the wrong
thing is the most valuable single report**, because it means the transcription
is wrong somewhere.

Try Synth 2 as well: only synth-scoped parameters accept the second instance,
and drum and project parameters reject it, so a Synth 2 write that lands on
Synth 1 is a bug worth catching.

### SESSION-3: Sequence a second device from the Circuit
**Tier: SESSION | ~15 minutes | writes live MIDI only | unlocks: confidence in host routing**

The Circuit's MIDI 1 and MIDI 2 jacks make it a sequencer for whatever you wire
downstream. If you have another device on one of those jacks, this is coverage
nothing else provides.

Wire your second device to MIDI 1 or MIDI 2, set it to receive on the channel
that jack sends on, and ask for a pattern that targets it, naming the track.

Report: which jack, which channel, which downstream device, and whether the
downstream device played what you expected. Note also whether your Circuit's
MIDI Thru setting duplicates the stream to both jacks; Thru set to Duplicate
means two identical outputs, not a per-track split, and that surprises people.

### DONATE-1: Send a project file from an unusual pack layout
**Tier: DONATE | ~3 minutes | no device time | unlocks: cross-layout container confidence**

Export a project from your Circuit through Novation Components and send the
file, plus a description of what is actually in it: how many patterns per track,
which tracks are used, and anything unusual like a very long pattern chain or a
pattern with a non-default length.

Pattern length in particular is worth checking: an unset length byte plays as
sixteen steps regardless of what the pattern looks like, and having more real
files to check the decode against is how that class of bug gets caught.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- Circuit Tracks firmware version,
- operating system,
- which pack and which project slot were involved,
- whether Novation Components was open at the same time,
- for a transfer ask, whether you power-cycled before checking.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

The Circuit has its own codec and shares it with no other device here, so
evidence from this page does not transfer. Host-routing evidence from SESSION-3
may close a row on the **downstream** device's page instead.
