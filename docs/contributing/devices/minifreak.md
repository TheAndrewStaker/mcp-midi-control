# Helping with the Arturia MiniFreak

<!-- contribution-meta
device_id: minifreak
support_tier: generic-only
transport: midi
preset_class: voice
owned_by_maintainer: no
-->

> **If you own a MiniFreak, this page has a one-minute ask that unblocks the
> entire device.** Everything beyond CC and Program Change is waiting on **one
> unknown byte**, and a read-only script can now find it without a sniffer,
> without MIDI Control Center, and without you reading anything off the synth.
> Skip to [PROBE-1](#probe-1-run-the-arturia-discovery-probe).

## Device

Arturia's hybrid synthesizer: two digital oscillator engines, an analog filter,
two LFOs, a cycling envelope, three onboard effect slots and assignable macros.
Arturia's configuration and editor app is **MIDI Control Center**.

This is a different instrument from the MicroFreak, not a variant, and this
project treats it as one: two oscillators instead of one, a second LFO, an
envelope Release stage, and an effects section the MicroFreak does not have at
all (`packages/arturia/src/devices/minifreak.ts`).

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `send_cc` against the curated map | set-only, hardware-unverified | A published MIDI implementation chart, transcribed from a third-party mirror because Arturia's own page rejects automated fetches. The same mirror was checked entry for entry against Arturia's own appendix for the sibling MicroFreak and matched exactly, which is indirect but real evidence for its accuracy here (`packages/arturia/src/devices/minifreak.ts`, header and the `transcribed-unvalidated` evidence label applied to every row) |
| `switch_preset` (Program Change) | hardware-unverified | Assumes the 0-based Program Change that was hardware-confirmed on the MicroFreak. Unverified here (`packages/arturia/src/devices/minifreak.ts`, `agent_guidance.presets`) |
| `get_param` on any parameter | gated | Every read refuses. Reads need SysEx, and this device has no SysEx surface at all |
| `set_system_param` on Utility globals | gated | The globals block does not exist for this device |
| Preset name read, full preset dump | gated | Needs SysEx |

Support tier: `generic-only`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/arturia/src/devices/minifreak.ts`, and preflight fails
if the two disagree. It is deliberately a weaker tier than the MicroFreak's
rather than sharing it.

Every parameter is **write-only** on this device. With SysEx unavailable there
is no readback path at all, so a write can never be reported as verified. Your
ears are the instrument.

## Confirmed on hardware

Nothing yet. This project does not own a MiniFreak, so no fact on this page has
been confirmed on one.

This is the only device page in the repo with an empty confirmed list, and
closing that is what the asks below are for.

## Blocked, and on what

Everything that is not CC or Program Change is blocked on **one unknown byte**.

Arturia's SysEx envelope is brand-level, shared across the hardware line, and
keyed by a per-product device-code byte:

```
F0  00 20 6B  <device>  01  <seq>  <len>  <cmd>  ...payload...  F7
    ^^^^^^^^  Arturia manufacturer id
              ^^^^^^^^ this byte is what we do not know
```

That is from `packages/arturia/src/codec/sysex.ts`, which also records the
codes we do know: `0x04` MiniBrute, `0x06` MatrixBrute, `0x07` MicroFreak. The
MicroFreak's is hardware-confirmed. The MiniFreak's is not.

**Guessing it is not an option.** A wrong guess addresses some other Arturia
product sitting on the same bus. So the SysEx surface is structurally absent
from this descriptor rather than shipped broken: `packages/arturia/src/devices/minifreak.ts`
omits the `sysex` config entirely, which is what makes every `get_param` refuse.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Every `get_param` | The MiniFreak's Arturia SysEx device-code byte | PROBE-1, with CAPTURE-1 as the fallback |
| `set_system_param` on Utility globals | The same byte, plus the globals parameter ids | PROBE-1, then the same controlled differential diff that identified the MicroFreak's globals |
| Preset name read and preset dump | The same byte, plus the dump-request shape | PROBE-1, with CAPTURE-1 as the fallback |
| Per-entry accuracy of the CC map | An owner confirming a handful of CCs by ear | SESSION-1 |

**The MiniFreak cannot inherit the MicroFreak's CC table.** The numbers collide
with different meanings: cutoff is CC 23 on the MicroFreak and CC 74 here,
resonance CC 83 there and CC 71 here, CC 24 is Cycling-Env Amount there and VCF
Env Amount here, CC 26 is Filter Amount there and FX2 Time here
(`packages/arturia/src/devices/minifreak.ts` header). A shared table would
silently move the wrong parameter, which is worse than no table.

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** MIDI Control Center holds the MiniFreak's USB port while
  it is open. Quit it fully before running anything from this project, and quit
  this project's MCP host fully before opening MIDI Control Center. On Windows
  check the system tray; closing a window is not quitting. The exception is
  CAPTURE-1, which deliberately wants MIDI Control Center running and this
  project's server **not** running.
- **Firmware updates.** Never run Arturia's firmware updater while an MCP host
  or a probe holds the port. Quit everything first.
- **Port matching.** The server matches this device on `/mini\s*freak/i`, not on
  a broad Arturia pattern, precisely so it cannot capture a MicroFreak and drive
  it with CC numbers that address different parameters
  (`packages/arturia/src/devices/minifreak.ts`).
- **What we will never ask you to do.** No firmware modification, no factory
  reset, no opening the unit.

## Asks, ranked

### PROBE-1: Run the Arturia discovery probe
**Tier: PROBE | ~1 minute | read-only | unlocks: the entire SysEx surface**

**The single highest-value ask on this page by a wide margin, and it needs no
extra software at all.** No sniffer, no MIDI Control Center, nothing to read off
the synth.

The Arturia SysEx envelope is brand-level and differs between products only by
one device byte. This script finds your MiniFreak's empirically: it sends a
Universal Identity Request, then sweeps all 128 possible device bytes with a
harmless read and reports which one answers.

From a source checkout, with the MiniFreak connected over USB and MIDI Control
Center quit:

```
npx tsx scripts/probe-arturia-discover.ts "MiniFreak"
```

It ends with a self-contained REPORT block. Paste the whole thing into your
issue; that block is the answer.

**Read-only guarantee, and it is structural.** The only two Arturia opcodes it
ever sends are `0x43`, read one global setting, and `0x19` with a trailing zero,
read one preset name. It never sends `0x42`, the global write, and never sends a
Program Change, a CC or a note. It imports its frame builders from the shipped
codec at `packages/arturia/src/codec/sysex.ts` rather than re-typing them, so it
cannot drift from the code it is validating
(`scripts/probe-arturia-discover.ts`).

**Why sweeping 128 bytes is safe:** a device ignores any message not addressed
to its own device byte, so the 127 wrong ones do nothing at all. The one that
matches gets a read.

**The method validates itself.** Run it against a MicroFreak and it rediscovers
`0x07` without being told, which is the hardware-confirmed answer for that
model. That self-check is what makes a result from a synth this project has
never seen trustworthy. If you own both, run it on the MicroFreak first and send
both outputs.

**A null result is a real finding, not a failed run.** If nothing answers, that
is genuinely valuable: it means the MiniFreak does not speak the MicroFreak's
global-and-name protocol at all, so it needs a different decode rather than just
a different byte. That is a completely different piece of information from "we
have not looked yet", and it redirects the work. Please report it exactly as
carefully as a hit. Then, if you are willing, CAPTURE-1 below is the fallback.

### SESSION-1: Confirm a handful of CCs by ear
**Tier: SESSION | ~10 minutes | writes CC only, nothing is saved | unlocks: confidence in the CC map**

The CC map here is second-hand. Confirming even five entries makes it real, and
finding one wrong entry is more valuable than confirming all forty.

Connect the MiniFreak, quit MIDI Control Center, and in your MCP host say:

> "Send CC 74 at value 100 on channel 1 to my MiniFreak, then CC 74 at value 20."

CC 74 should be the filter cutoff. Then try the same for CC 71 (resonance),
CC 70 (Tune 1), CC 14 (Wave 1) and CC 17 (Volume 1).

Report which ones moved what you expected, and which moved something else or
nothing at all. **A CC that moves the wrong parameter is the most valuable
single thing you can report**, because it means the transcribed table is wrong
somewhere and we need to know where.

Note: on this synth family the front panel does not show incoming CC and the
device reports nothing back, so there is no display to read. This ask is done
entirely by ear.

### REPORT-1: Tell us your exact USB port name
**Tier: REPORT | ~2 minutes | nothing is sent to the device | unlocks: correct routing**

In your MCP host, with the MiniFreak plugged in:

> "list the MIDI ports you can see"

Paste the whole list, not just the line you think matters. The server routes by
port name, so the exact string your operating system reports is what confirms
the matcher is right for your unit, your firmware and your platform. The
surrounding entries are often what identifies a routing bug.

### CAPTURE-1: Recover the device-code byte with a sniffer
**Tier: CAPTURE | ~15 minutes | sniffer required | unlocks: the entire SysEx surface**

**Fallback only. Do [PROBE-1](#probe-1-run-the-arturia-discovery-probe) first**;
it answers the same question in about a minute with nothing to install. Come
here only if the sweep found nothing, in which case a recording of the real
editor is the way to see what protocol this synth actually speaks.

One recording of MIDI Control Center talking to your MiniFreak contains the
device code **in every frame it sends**. You do not need to find it yourself;
send the recording.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).
Windows uses USBPcap plus Wireshark, macOS uses MIDI Monitor. Neither sends
anything to your synth; they only listen.

Make sure this project's MCP host is fully quit first, so it is not holding the
port MIDI Control Center needs.

1. Start recording. Write down your MiniFreak's firmware version and your MIDI
   Control Center version.
2. Open MIDI Control Center and let it connect to the MiniFreak. **The
   connection handshake alone is usually enough**, so if you stop here you have
   probably already got it.
3. Pause about three seconds. Open the device settings or globals page in MIDI
   Control Center, so it performs a read.
4. Pause about three seconds. Change one setting you can see on the device.
   Write down which one, and what you changed it to.
5. Stop and save the recording.

What we are looking for: any message beginning `F0 00 20 6B`. The byte
immediately after that identifies the product. If PROBE-1 found nothing, the
frames around it are just as important, because they show what shape this synth's
protocol actually takes.

If your capture tool shows you the bytes and you want to read them yourself: the
device code is the fifth byte of any Arturia SysEx message, counting `F0` as the
first. Tell us that byte and you have done the ask, no file needed.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- MiniFreak model (keyboard or desktop) and firmware version,
- operating system,
- MIDI Control Center version,
- whether MIDI Control Center was open at the same time,
- for PROBE-1, the whole REPORT block the script prints, including a null
  result,
- for SESSION-1, what you heard, per CC.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

For PROBE-1 specifically: landing the device code means adding a `sysex` config
to `packages/arturia/src/devices/minifreak.ts` with the recovered `device_code`,
which un-gates the read paths through the shared codec at
`packages/arturia/src/codec/sysex.ts`. The globals table stays empty until the
per-parameter ids are identified the same way the MicroFreak's were, by
controlled differential diff. If the probe comes back empty instead, record that
as a decoded negative rather than an open question: the model does not answer
the MicroFreak's global-and-name opcodes, and CAPTURE-1 becomes the route.
