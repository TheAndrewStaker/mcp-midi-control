---
name: virtual-midi-bridge-interposition
class: capture-method
status: non-matching
discovered:  cont (loopMIDI / ipMIDI bridge attempts)
verified_on:
  - axe-edit-ii-on-windows
  - am4-edit-on-windows
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (structural: AxeEdit II / AM4-Edit filter MIDI ports by driver class, so a bridge between editor and real device cannot appear in the picker; the gen-3 AXE-prefixed loopMIDI EMULATION carve-out is already a shipped positive lane and is explicitly not ruled out here)
relates_to: []
consumed_in: []
---

# Virtual MIDI driver bridges as editor-traffic interposers: does NOT work

A natural plan for capturing the editor → device direction is: install
a class-compliant virtual MIDI port (loopMIDI, ipMIDI, MIDI-OX patch),
configure the Fractal editor to send to the virtual port, forward to
the real device with a logger in between. Fractal editors filter this
out by design.

## Why it fails

Fractal editors enumerate MIDI ports via the Windows MM API
(`midiInGetDevCaps`, `midiOutGetDevCaps`), inspect the device-driver
class, and refuse to talk to ports whose driver class is not the
expected USB MIDI class. Class-compliant virtual drivers (including
loopMIDI's, ipMIDI's, and most kernel-bridged variants) present a
different driver class and never appear in the editor's port picker,
or appear and silently drop the connection. This is intentional
filtering, not a bug, and it is consistent across AxeEdit II,
AxeEdit III, and AM4-Edit. See memory `feedback_capture_methodology`.

## What works instead

- **USBPcap + Wireshark** at the USB-class layer. Captures both
  directions including the editor → device traffic the virtual-port
  approach tried to intercept. The maintainer's default for editor-
  write decode. See `fractal-midi/docs/capture-guides/` for the
  step-by-step.
- **Directed probe scripts** (`scripts/probe*.ts`) when only the
  device → host direction is needed and one hypothesis at a time.
  Cheap, scriptable, default for unknown wire envelopes.

## What this does NOT rule out

- Virtual MIDI ports for non-Fractal devices. The interposition
  failure is Fractal-specific (other vendors do not filter by
  driver class).
- ipMIDI for *network* MIDI between two real ports, neither of
  which is a Fractal editor. The filtering applies only when the
  Fractal editor is one endpoint.
- **Full device EMULATION (not bridging), and FM9-Edit specifically.**
  This entry rules out *interposing* a virtual port between an editor and
  a *real* device. It does not rule out emulating the device outright. And
  the gen-3 editor is more permissive than AxeEdit II / AM4-Edit:
  **FM9-Edit accepts a loopMIDI port whose name carries the `AXE` prefix**
  (e.g. `AXEloopMIDI Port`) and connects to it with no hardware. This was
  used to capture the gen-3 editor-write surface with zero hardware. See
  the [loopMIDI editor-emulation capture guide](../../../capture-guides/loopmidi-editor-emulation.md)
  and [[gen3-fn01-grid-set-position-insert]]. The driver-class filter
  documented above still applies to AxeEdit II / AM4-Edit on Windows.

## Symptoms / grep terms

Search these before re-attempting:

- "loopMIDI bridge capture editor traffic" / "virtual MIDI port interpose Fractal editor"
- "editor filters ports by driver class" / "port missing from editor picker"
- "use USBPcap instead" (the working capture lane); note the carve-out:
  full device EMULATION via an `AXE`-prefixed loopMIDI port is NOT ruled out

## Refinement history

- 2026-05-22 (primitives backfill): negative finding registered.
  The bridge approach kept resurfacing as "the obvious solution"
  in fresh decode sessions; one primitive entry should be enough
  to forestall a fourth attempt.
