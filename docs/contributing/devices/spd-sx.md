# Helping with the Roland SPD-SX

<!-- contribution-meta
device_id: spd-sx
support_tier: verified
transport: hybrid
preset_class: voice
owned_by_maintainer: yes
-->

## Device

Roland's sampling percussion pad: nine pads plus trigger inputs, 100 kits, and a
pool of user waves. Roland's companion app is the **SPD-SX Wave Manager**.

This device has **two completely separate surfaces**, and which one you can use
depends on the USB mode the pad is in. That is the single most important thing
to understand before doing anything on this page.

| Surface | USB mode | What it does |
|---|---|---|
| **MIDI** | AUDIO/MIDI mode | Kit recall by Program Change, pad triggering by note |
| **Storage** | WAVE MGR mode | Reads and authors kits and the wave pool over the mounted drive. This is filesystem work, not MIDI |

They are mutually exclusive. The pad is in one mode or the other, never both.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| Kit recall by `switch_preset` (MIDI) | hardware-unverified | Documented in Roland's Owner's Manual: kit recall by Program Change (`packages/spd-sx/src/descriptor.ts`, `verification`) |
| Pad triggering by note (MIDI) | hardware-unverified | Same source |
| Live parameter control over MIDI | not supported by the device | There is no MIDI parameter surface on this pad, so no blocks are registered |
| `save_preset` over MIDI | not supported by the device | The SPD-SX has no editable working buffer over MIDI. Kits are authored as files |
| Importing waves over storage (`upload_sample`) | **confirmed** | Hardware-confirmed end to end through this server on the maintainer's unit: waves were appended to the pool |
| Authoring a kit over storage (`author_kit`) | **confirmed** | Hardware-confirmed end to end: an authored kit PLAYS after a power-cycle, with four imported waves audible |
| The kit and wave-parameter file codec | confirmed offline | Decoded byte-exact and golden-verified against real device files |
| In-process resampling of non-44.1 kHz or non-16-bit input | hardware-unverified | Golden-verified and riding the same confirmed write path, but a resampled wave has not been auditioned by ear |

Support tier: `verified`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/spd-sx/src/descriptor.ts`; the contribution gate fails if the two disagree.
The tier is set from this device's PRIMARY authoring surface, which is STORAGE: the kit and wave codec is byte-exact and hardware-confirmed through this server's own packaged path. Its MIDI surface is documented-only, and the `verification` string leads with that split so the single tier cannot overstate the weaker half.


## Confirmed on hardware

On the maintainer's own unit:

- Importing waves into the pool over storage.
- Authoring a kit over storage, confirmed by the kit **playing after a
  power-cycle** with its imported waves audible. That is the real test: the
  device only rescans files on boot, so a kit that looks right on disk has not
  been proven until it survives a restart.

**Please do not re-run these.** The storage write path is done.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Kit recall and pad triggering over MIDI | Nobody has driven the MIDI surface end to end through this server. It is documented in Roland's manual and shipping, and unconfirmed | SESSION-1 |
| Resampled waves sounding correct | The resample path is golden-verified but nobody has listened to a resampled wave on the device | SESSION-2 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **The two USB modes are mutually exclusive, and this is the thing that trips
  everyone.** Kit recall and pad triggers need **AUDIO/MIDI mode**. Kit and wave
  authoring needs **WAVE MGR mode**, where the pad mounts as a drive and is not a
  MIDI device at all. Switch modes on the pad itself. If a MIDI ask does nothing,
  check the mode before anything else.
- **Confirm a new kit after a power-cycle.** The device only rescans its files on
  boot. A kit written while in WAVE MGR mode does not exist to the pad until it
  restarts.
- **Wave import is append-only by design.** Nothing overwrites an existing wave
  index. Back up before any authoring session anyway.
- **Port exclusivity.** In AUDIO/MIDI mode the Wave Manager and this server
  compete for the port. Quit the Wave Manager first.
- **Firmware updates.** Never run Roland's updater while an MCP host holds the
  port or the drive.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Confirm kit recall and pad triggering over MIDI
**Tier: SESSION | ~10 minutes | sends MIDI only, nothing is stored | unlocks: the whole MIDI surface**

The MIDI surface is documented in Roland's Owner's Manual and shipping, and
nobody has driven it through this server on a real pad. It is the cheapest
unclaimed confirmation on this device.

Put the pad in **AUDIO/MIDI mode**, quit the Wave Manager, and:

> "Switch my SPD-SX to kit 12."

Check the pad's display. Then:

> "Trigger the snare pad on my SPD-SX."

Report whether the kit changed and whether the pad sounded. Also report your
pad's **global MIDI channel** setting, since kit recall depends on it and a
mismatch is the most likely reason for a silent failure.

### SESSION-2: Import a wave that needs resampling, and listen to it
**Tier: SESSION | ~15 minutes | writes files, back up first | unlocks: the resample carve-out**

Wave import and kit authoring are confirmed, with one carve-out: a wave that
arrives at something other than 44.1 kHz and 16 bit is resampled in process. That
path is golden-verified and rides the same confirmed write path, but nobody has
listened to the result.

Put the pad in **WAVE MGR mode** so it mounts as a drive. Take a wave file that
is clearly not 44.1 kHz or not 16 bit, a 48 kHz or 24 bit file is ideal, and
import it, then author a kit that uses it.

Power-cycle, then play the pad.

Report: the source file's sample rate and bit depth, and whether it sounds right,
wrong pitch, wrong speed, or noisy. Pitch or speed being wrong would point
straight at the resample ratio.

### REPORT-1: Tell us your pad's global MIDI channel and its port name
**Tier: REPORT | ~3 minutes | nothing is sent to the device | unlocks: correct routing**

In AUDIO/MIDI mode, with the pad connected:

> "list the MIDI ports you can see"

Paste the whole list. Then check the pad's own global MIDI channel setting in
its menu and report it.

Kit recall goes out on the global channel, so a wrong assumption there produces
a silent failure that looks like a bug in the wire.

### DONATE-1: Send a kit folder from a pad other than the maintainer's
**Tier: DONATE | ~5 minutes | no device time | unlocks: cross-firmware codec confidence**

Put the pad in WAVE MGR mode, and copy off the Roland folder for one kit,
together with the wave-parameter files.

The kit and wave codecs are decoded byte-exact and golden-verified against real
device files, but all of those files came from one pad on one firmware. Real
files from a second unit are the cheapest possible check that the format does not
drift.

Send the folder plus your firmware version and a description of what the kit
actually contains, so the decode can be checked against ground truth.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- SPD-SX firmware version,
- operating system,
- **which USB mode the pad was in**, AUDIO/MIDI or WAVE MGR,
- the pad's global MIDI channel, for any MIDI ask,
- whether you power-cycled before checking, for any storage ask.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree, and the tier-versus-prose disagreement noted above should be
   resolved in the descriptor at the same time.
5. Update this device's row in [../README.md](../README.md).

The SPD-SX has its own codec and shares it with no other device here, so
evidence from this page does not transfer.
