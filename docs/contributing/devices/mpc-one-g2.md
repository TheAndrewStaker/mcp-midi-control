# Helping with the Akai MPC One G2

<!-- contribution-meta
device_id: mpc-one-g2
support_tier: generic-only
transport: hybrid
preset_class: voice
owned_by_maintainer: yes
-->

## Device

Akai's standalone sampler and sequencer, running MPC OS 3. A **program** is an
instrument (a drum kit, a keygroup, a plugin), a **sequence** is one part of a
song, and a **project** holds the sequences and programs of a song or a set.

Over MIDI the MPC is a sound module with a part selector: it plays incoming
notes, follows or sends clock, and selects a sequence on Program Change. It
exposes no parameters and no file transfer over MIDI. Kits, programs and
projects reach it as files on its SD card or drive.

On USB the MPC is in one of **two modes**, and each does what the other cannot:

| Mode | MIDI ports the computer sees | Sequence select | Card and project reads |
|---|---|---|---|
| **Standalone** (normal use) | "MPC One USB-C Out 1/2", "In 1/2", "DAW" | yes, on "USB-C Out 1" | no, unless the card is in a reader |
| **Controller Mode** (the unit shows "Looking for Computer") | "MPC One Public" plus the forwarded DIN jacks | no, the unit plays nothing | yes, the card and internal drive mount over USB |

With either volume mounted, this server lists the projects on the SD card and
on the MPC's internal storage and reads one project's sequences (number, name,
tempo, length). A project on the internal storage has a location that starts
`internal:`. The volumes are ordinary mounted drives, found by their folder
layout (`Projects` and `Expansions` at the top of a card, or inside
`MPC Documents` on the internal storage); nothing over USB names them. A card in
a separate reader works too, and then the reads and the MIDI port are usable at
the same time. Nothing is written to either volume yet.

The config is `packages/akai-mpc/src/devices/mpcOneG2.ts`; other MPCs on the
same OS (Live, Key, X) would be further configs on the same factory
(`packages/akai-mpc/src/descriptor.ts`).

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `switch_preset` (selects a sequence) | **confirmed** | Akai's MPC Standalone OS User Guide documents that a Program Change selects a Sequence. Confirmed on a One G2 on MPC OS 3.9.1 running standalone on USB: `switch_preset` on "MPC One USB-C Out 1", channel 1, moved the unit to sequences 3 and 1, each seen on its screen. Numbering and timing (at once while stopped, queued while playing) were bench-proven earlier from other hardware |
| A sequence select in Controller Mode | refused | The unit ignores it there, so the server refuses and names the mode to switch to |
| `apply_pattern` (live drum notes) | hardware-unverified | Akai documents that drum tracks play from incoming notes. The voice map is General MIDI, which fits kits whose pads carry GM notes and not the Classic MPC or Chromatic pad maps |
| `send_clock_*`, MMC through `send_sysex` | hardware-unverified | Akai documents MIDI Clock and MMC receive |
| `get_param`, `set_param` | gated | The MPC has no parameter surface over MIDI. Every call refuses and says so |
| `scan_locations` (projects on the card) | confirmed | Run through this server against a real card written by a One G2 on MPC OS 3.9: 62 projects listed. Read-only |
| Projects on the internal storage | **confirmed** | Run through this server against a One G2 on MPC OS 3.9.1 in Controller Mode: the 7 projects saved on its internal storage listed beside the 69 on the card |
| `get_preset` (a project's sequences) | confirmed for the file read | The `.xpj` container (gzip, a five-line header, then JSON) was read off 28 real song projects; sequence number = the file's key + 1, the same numbering Program Change uses. It reports the FILE, not what the MPC holds in memory |
| Writing kits, programs or projects to the card | not implemented | A drum program writer exists in the codec, byte-identical to its reference, and is not reachable from any tool yet |

Support tier: `generic-only`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/akai-mpc/src/devices/mpcOneG2.ts`, and preflight fails
if the two disagree.

## Confirmed on hardware

- Sequence selection by Program Change on a One G2, MPC OS 3.9: numbering
  (Program Change 0 is sequence 1) and timing (immediate while stopped, queued
  while playing). The message came from a hardware MIDI processor on the DIN
  input, not from this server.
- Sequence selection from this computer over USB, MPC OS 3.9.1, standalone:
  the port that reaches the sequencer is "MPC One USB-C Out 1". The generic
  send tools reach it by that exact name too (`send_program_change`, confirmed).
- Controller Mode: the unit shows "Looking for Computer", ignores a Program
  Change, and mounts its card and internal drive on the computer.
- Card reads, against a card written by a One G2 on MPC OS 3.9: the project
  list, and the sequence list of a 24-sequence song project.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Port names on other systems | The standalone and Controller Mode port names were read on one unit on Windows. macOS and Linux may name them differently | SESSION-1 |
| Pad triggering with a known map | Which pad sounds for each General MIDI note on a given kit | SESSION-2 |
| Program Change channel | Whether the MPC takes a Program Change on any channel or only on one | SESSION-1 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Pick the mode for the job.** Sequence select and notes need the MPC running
  standalone. Card and project reads need Controller Mode, or the card in a
  reader. A verb in the wrong mode refuses and says which mode it needs.
- **Set one Preference.** Preferences > MIDI / Sync > Program Change must be
  **Sequence**, or a Program Change selects a track instead.
- **Clock.** If the MPC is your clock master, leave Receive off. Audio recording
  is disabled while the MPC follows external clock.
- **The card.** Reading it needs Controller Mode or the card in a reader. Remove it
  from the MPC only with the MPC powered down or after its own eject step, and
  use your operating system's safe-removal when taking it out of the reader.
- **What we will never ask you to do.** No firmware update, no Online Update, no
  factory reset.

## Asks, ranked

### SESSION-1: Select a sequence from the server
**Tier: SESSION | ~3 minutes | changes the selected sequence only | unlocks: `switch_preset`**

Load a project with at least three sequences. In your MCP host, with the MPC
connected over USB:

> "Switch my MPC to sequence 3, then back to sequence 1."

Report the tool response, the sequence the MPC screen showed after each step,
and the names of the MIDI ports your computer lists for the MPC.

### SESSION-2: Play a drum pattern into a kit
**Tier: SESSION | ~5 minutes | plays notes, records nothing | unlocks: `apply_pattern`**

Put a drum program on the current track. In your MCP host:

> "Play a one-bar rock beat on my MPC."

Report which pads lit for the kick, the snare and the hats, and which kit was
loaded.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md) for the general form. For this device,
always include:

- MPC model and MPC OS version (Preferences > Info),
- operating system of the computer,
- the MIDI port names the computer lists for the MPC,
- the Program Change Preference setting,
- what the MPC screen did, in your own words.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).
