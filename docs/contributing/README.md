# Own one of these? You can move it forward in five minutes

Most of what is still unconfirmed in this project is not a hard problem. It is a
device nobody has pointed at yet.

A capability here can be **fully built and still be unconfirmed on hardware**.
Those are separate things, and we never collapse them. When you run one command
or paste one chat response, you are converting `hardware-unverified` into
`confirmed`, and that is the single most useful thing anyone outside this repo
can do. See [EVIDENCE.md](EVIDENCE.md).

## Five ways to help, easiest first

Do one and stop. Every rung is genuinely useful on its own, and your device's
page says which one it needs **right now**.

1. **REPORT.** Tell us your device exists, or answer one factual question. No
   device time, nothing is sent to the device.
2. **DONATE.** Send a file your computer already has: an editor cache, a preset
   backup, a project file. Often the biggest jump per minute.
3. **PROBE.** Run one read-only command. It never writes to your device.
4. **SESSION.** Have a normal conversation with your gear and tell us what the
   front panel did. This is the only tier that can confirm a **write**.
5. **CAPTURE.** Record the wire while the vendor editor talks to your device.
   This is the only tier that can decode something nobody has decoded.

Full definitions, what each tier can settle, and the status vocabulary:
[TIERS.md](TIERS.md).

Before you start anything: [SAFETY.md](SAFETY.md). The one thing that catches
everybody is that this server holds your device's port **exclusively** and
blocks the vendor editor and the firmware updater while it does.

## Your device

One page per registered device, no exceptions. The filename is the device's own
id, so a device that exists in the server always has a page here.

| Device | Page | Support tier | Top ask right now | Tier of that ask |
|---|---|---|---|---|
| Fractal AM4 | [`am4`](devices/am4.md) | `verified` | Confirm a stored-location preset read | SESSION |
| Fractal AX8 | [`ax8`](devices/ax8.md) | `community-beta` | Build a small preset in one step, the first AX8 hardware run of any kind | SESSION |
| Fractal Axe-Fx Standard / Ultra | [`axe-fx-gen1`](devices/axe-fx-gen1.md) | `community-beta` | One structural editing-session capture, which unlocks preset authoring and save | CAPTURE |
| Fractal Axe-Fx II XL+ | [`axe-fx-ii`](devices/axe-fx-ii.md) | `verified` | Tell us if you own a Mark I, Mark II or non-plus XL | REPORT |
| Fractal Axe-Fx III | [`axe-fx-iii`](devices/axe-fx-iii.md) | `community-beta` | Send your Axe-Edit III definition cache | DONATE |
| Novation Circuit Tracks | [`circuit-tracks`](devices/circuit-tracks.md) | `verified` | Confirm a synth parameter write by ear | SESSION |
| Fractal FM3 | [`fm3`](devices/fm3.md) | `community-beta` | Anything at all, on Windows. The serial driver path is unrun | SESSION |
| Fractal FM9 | [`fm9`](devices/fm9.md) | `community-beta` | Confirm a discrete set-by-name write | SESSION |
| ASM Hydrasynth | [`hydrasynth`](devices/hydrasynth.md) | `verified` | Tell us if you have a Deluxe or a Keyboard | REPORT |
| Arturia MicroFreak | [`microfreak`](devices/microfreak.md) | `verified` | Run the Arturia discovery probe, which validates the method that unblocks its siblings | PROBE |
| Arturia MiniFreak | [`minifreak`](devices/minifreak.md) | `generic-only` | **Recover the Arturia device-code byte.** One read-only minute, one byte, and the entire SysEx surface unblocks | PROBE |
| Boss RC-505mk2 | [`rc-505mk2`](devices/rc-505mk2.md) | `verified` | Drive a looper CC through the server and watch the unit | SESSION |
| Boss RC-600 | [`rc-600`](devices/rc-600.md) | `generic-only` | Send a memory file with populated assign slots | DONATE |
| Roland SPD-SX | [`spd-sx`](devices/spd-sx.md) | `verified` | Confirm kit recall and pad triggering over MIDI | SESSION |
| Boss VE-500 | [`ve-500`](devices/ve-500.md) | `verified` | Confirm factory preset recall | SESSION |
| Fractal VP4 | [`vp4`](devices/vp4.md) | `community-beta` | The scene-query probe. One read-only frame, possibly a whole capability | PROBE |

The support tier column is checked against each device's descriptor in
preflight, so it cannot drift. See `scripts/verify-contribution-guides.ts`.

Unregistered USB MIDI devices still work through the generic MIDI primitives;
they just have no page here.

## The single highest-value unclaimed ask

**The Arturia MiniFreak's SysEx device-code byte.** Everything beyond CC and
Program Change on that synth is blocked on one unknown byte. Guessing it is
refused on purpose, because a wrong guess addresses a different Arturia product
on the same bus.

One owner can now recover it in about a minute with a read-only script and no
extra software: it sweeps all 128 possible device bytes with a harmless read and
reports which one answers. A null result is a real finding too, because it means
the model speaks a different protocol rather than just a different byte.

[devices/minifreak.md](devices/minifreak.md).

## Your device is not listed

Open a device support request and tell us it exists. A model nobody has asked
for is a model nobody has built for, and the fastest ports here have started
from exactly that.

Say in the issue whether you can send a file the vendor app already stores on
your computer, a preset backup, an editor cache or a project file. That is
usually the difference between a request and a working port.

**If your instrument is an Arturia, there is something concrete you can do
before anyone writes a line of code.** The Arturia SysEx envelope is
brand-level: a PolyBrute, MatrixBrute, MiniBrute or KeyStep differs from the
MicroFreak this project already supports by one device byte and nothing else in
the envelope. The discovery probe on
[devices/minifreak.md](devices/minifreak.md), PROBE-1, works on any of them:

```
npx tsx scripts/probe-arturia-discover.ts "PolyBrute"
```

It is read-only, takes about a minute, and its answer is the first real evidence
a new Arturia port would be built on. Attach the REPORT block to your device
request.

## Tooling

Only needed for the PROBE and CAPTURE tiers.

- [tools/editor-cache-file.md](tools/editor-cache-file.md): the highest-value
  DONATE ask, offline, no tools, device not even plugged in.
- [tools/harvest-script.md](tools/harvest-script.md): one read-only command that
  asks a device every question we know about and writes one file.
- [tools/capture-setup.md](tools/capture-setup.md): one-time sniffer setup for
  Windows and macOS, plus what makes a capture usable.
- [tools/usbpcap-wireshark.md](tools/usbpcap-wireshark.md): the detailed Windows
  workflow.
- [tools/midi-monitor-mac.md](tools/midi-monitor-mac.md): the macOS workflow.

## Sending it back

[SUBMITTING.md](SUBMITTING.md). Short version: open a GitHub issue with the
Hardware evidence template, put the ask id in it, attach the file, and say what
the **front panel** did.

## Writing code instead

Adding a device descriptor, decoding a protocol, or fixing a tool is covered in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md). Owning the hardware and answering an
ask on your device's page is usually worth more than writing the descriptor,
because the descriptor is the easy half.
