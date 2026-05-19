# USBPcap + Wireshark Capture Guide

> The maintainer's default workflow for decoding the editor-write
> direction (what AxeEdit, AM4-Edit, or Hydrasynth Manager sends
> *to* the device). Captures both directions at the USB-class layer
> in a single `.pcapng` file.

## When to use this guide

There are two capture modes available in this project:

1. **Passive device-side capture** (`npm run capture-axefx2 / capture-am4 /
   capture-midi`). Opens the device's MIDI input port as a shared reader.
   Captures everything the device emits: responses to queries, broadcasts,
   state announcements. Five-second setup, no extra software. **Use this
   first** for anything you can decode from the device-emitted side of the
   conversation.

2. **USBPcap + Wireshark** (this guide). Captures both host-to-device and
   device-to-host frames at the USB-class layer. **Required** for the
   editor-write direction, because Windows MIDI output ports are write-only
   from the OS side and the passive script cannot observe them.

The editor-write direction is where most undecoded wire shapes live (block
placement, grid routing, parameter-page writes), so for any new write-op
decode this guide is the path.

## What does NOT work (don't try these)

These approaches have been ruled out by hardware testing:

- **Virtual MIDI driver bridges** (loopMIDI, MIDI-OX routing through a
  virtual port between editor and device). Fractal editors filter out
  class-compliant virtual drivers via `midiInGetDevCaps` /
  `midiOutGetDevCaps`. The editor's port picker never sees the bridge, so
  no traffic flows through it. This is intentional editor behaviour, not
  a bug, and applies to AxeEdit / AM4-Edit / FM9-Edit. See
  [`docs/devices/axe-fx-ii/community-re-methodology.md`](../devices/axe-fx-ii/community-re-methodology.md) for the full history.

- **WinDbg / Frida trap-after-launch** on the editor process to dump
  outgoing buffers. The stack frame at the point of the WinMM call is too
  shallow to identify which logical operation produced the bytes; the
  symbolic label is written well before the trap arms.

USBPcap + Wireshark sidesteps both issues by capturing the actual USB
class frames once they cross the kernel boundary.

## Install

1. **USBPcap** from [desowin.org/usbpcap](https://desowin.org/usbpcap/).
   Reboot after installation; the kernel filter driver needs it.
2. **Wireshark** from [wireshark.org](https://www.wireshark.org/). Any
   recent version supports USB-class MIDI decode (filter `usbaudio.midi`
   or `usb.transfer_type == 0x03 && usb.endpoint_address.direction == OUT`).

USBPcap installs a virtual capture adapter that Wireshark sees as one
or more `USBPcap1`/`USBPcap2`/... interfaces. The numbering is per USB
host controller, not per device.

## Identify the right USB device

Before capturing, find which USB hub root the MIDI device sits on so you
can filter for just its traffic.

1. Open **Device Manager** (Windows).
2. Find your MIDI device under "Sound, video and game controllers" or
   "Universal Serial Bus controllers".
3. Right-click the device's **USB Composite Device** parent entry, choose
   Properties to Details to "Bus relations" or "Parent" (the exact label
   varies by Windows version). The string contains a USB hub VID/PID and
   address you can match against the USBPcap interface list.

If you have only one external USB device, you can skip this step and
just capture on all USBPcap interfaces; filter the resulting capture by
endpoint or by the MIDI class signature.

## Capture session discipline

**One action per capture.** Single-action `.pcapng` files are dramatically
easier to decode than mixed sessions. Examples:

- "Drag a single block into grid cell (row 2, col 3)."
- "Turn the Drive knob from 5.0 to 6.0 in one motion."
- "Click File to Export Preset against the active working buffer."
- "Click the SAVE PRESET front-panel-equivalent button."

Two simultaneous edits in the same capture produce ambiguous diff bytes
and can cost a session to disambiguate. Resist the temptation to
"capture a few things at once for efficiency".

Workflow per capture:

1. Get the device into a known starting state (specific preset, specific
   active scene, no pending edits). Note the state in your capture filename.
2. Open Wireshark, choose the USBPcap interface, start the capture.
3. Perform exactly one action in the editor or on the device.
4. Stop the capture immediately (do not let other UI updates pollute it).
5. Save as `samples/captured/<device>-<action>-<date>.pcapng`. The
   `samples/` directory is gitignored, which is correct for raw captures.

## Extract MIDI SysEx from the capture

Wireshark's display filter `usbaudio.midi` highlights only MIDI Class
frames in a USB-Audio capture. From there you can:

- **Right-click frames to Export Packet Bytes** to dump the raw SysEx
  bytes from a selected packet range to a file. Save with a `.syx`
  extension so the existing decode tooling can read it.
- Use `scripts/_research/decode-pcapng.ts` for batch extraction across an
  entire capture. The script walks USB MIDI class frames, reassembles
  multi-packet SysEx into single `F0..F7` messages, and emits either a
  `.syx` or a Wireshark-style dissection.

The class frames carry a 4-byte USB-MIDI header per packet (`cable
number + code index number + data`); SysEx is sliced across multiple
packets when it exceeds 3 data bytes. The decode script handles this
reassembly automatically.

## Pair the bytes with the action

The `.pcapng` carries timestamps. For a single-action capture you can
usually identify the SysEx that corresponds to the action by:

- Filtering on `OUT` transfers (host-to-device) for editor-write ops.
- Filtering on `IN` transfers (device-to-host) for the device's ACK or
  state-broadcast response.
- Looking for the F0..F7 SysEx envelope inside the MIDI class payload.

Annotate the capture immediately while the action is still fresh in
your head ("byte at packet 12 is the drive knob value going from 5 to
6"). Six months later you will not remember.

## Cite the capture in committed docs

When a new wire-shape decode lands in `docs/SYSEX-MAP*.md`, cite the
capture file path and the byte offset that proves it. "Confirmed via
capture" without a reference is hearsay; future agents need to be able
to re-verify against the same bytes.

The capture itself stays in `samples/` (gitignored). The decoded
finding goes in the public SYSEX-MAP doc with a citation that names the
sample filename + byte offset, so a contributor with the same hardware
can reproduce the capture and check the bytes.

## See also

- `CONTRIBUTING.md`: the contributor-facing top-level capture intro.
- [`docs/devices/axe-fx-ii/community-re-methodology.md`](../devices/axe-fx-ii/community-re-methodology.md): full survey of capture
  techniques in the public Fractal RE corpus, including why this
  project chose USBPcap over virtual-MIDI-bridge approaches.
- `docs/capture-guides/juce-binarydata-extraction.md`: a complementary
  capture-free technique that pulls embedded XML / labels out of
  JUCE-built editor binaries directly, no MIDI required.
- `scripts/capture-midi-passive.ts`: the passive-capture script used
  for the device-emitted direction.
- `scripts/_research/decode-pcapng.ts`: batch SysEx extraction from
  Wireshark captures.
