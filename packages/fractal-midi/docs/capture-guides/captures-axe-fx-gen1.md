# Captures: Axe-Fx Standard / Ultra

> **What gen-1 has today:** full parameter control (set every knob, read every value, in display
> units), preset switching via standard MIDI Program Change, and `get_preset` reading a preset's
> NAME + block layout (the spec-pinned subset of the patch dump; per-param values are not decoded).
> **What it's missing:** preset AUTHORING -- `apply_preset`, block placement, save -- plus the
> patch dump's parameter region and bank-C dump requests. The published gen-1 spec documents only
> the parameter function and part of the dump, so the structural wire messages are unknown, and
> the project owns no gen-1 hardware. **One capture session from one owner closes the authoring
> gap** -- see C2.

No capture tool setup is required for C1 below -- just old files you may already have.

---

## C1 -- Legacy captures from AxeEdit or Fractal-Bot

If you have any of the following from a Standard or Ultra session, share them:

- `.pcapng` files from USBPcap / Wireshark
- `.syx` files exported from Fractal-Bot or AxeEdit
- Any MIDI Monitor logs (Mac)

What we're looking for: any **device-to-host** traffic (messages the hardware sends back to the computer). We've wired get_param from the spec, so a capture of a real MIDI_PARAM_VALUE response confirms it on hardware. The spec-pinned subset of the PATCH_DUMP (function 0x04) **now ships as `get_preset`** -- preset name + 4×12 effect-grid block layout -- so the capture ask is down to what the spec leaves open: **the ~1790-byte parameter region and the bank-C request byte** (presets ≥ 256; the spec's "or'd with unknown value" wrinkle -- any capture of the era's editor requesting a bank-C preset pins it).

**The parameter-region unlock (finishes `get_preset` with per-param values):** the published
spec pins the dump's header, 20-char name, and 4×12 effect grid, but explicitly leaves the
remaining ~1790 bytes "undetermined (assume parameter and modifier state)" -- so the parameter
body needs one real dump with known ground truth. Either of these closes it:

1. **Best (~5 min, no capture tools):** export the edit buffer to a `.syx` file TWICE,
   changing exactly ONE parameter between exports (e.g. move AMP1 GAIN and write down the
   before/after front-panel values). A Fractal-Bot or gen-1 AxeEdit preset export should be
   exactly the function-0x04 dump frame. Send both files + which param you moved and its
   two values. The byte diff pins the parameter's offset AND its value encoding in one shot.
2. **Acceptable:** any single preset `.syx` you already have, plus a note of a few parameter
   values you know that preset holds (e.g. amp type + gain), and your firmware version.

Either one also tells us whether the dump really totals 2060 bytes (the spec hedges even that).

Even captures that are years old are useful. The wire protocol for the Standard/Ultra is fixed.

---

## C2 -- The apply_preset unlock: one structural editing session (HIGHEST VALUE)

This is the single capture that converts gen-1 from "tweak the loaded preset" to **full preset
authoring** (`apply_preset`, block placement, save). The executor that builds presets on the
AM4 / Axe-Fx II / III is device-generic -- the ONLY missing piece is the bytes the gen-1 editor
sends for structural edits.

With USBPcap (Windows) or MIDI Monitor (Mac) recording, run the era's editor (gen-1 AxeEdit /
Axe-Edit 1.x) against your Standard or Ultra and do each of these ONCE, slowly, one action at a
time (one action per capture file is ideal, but one file with noted timestamps works too):

1. **Place a block** into an empty grid cell (e.g. add a Delay).
2. **Connect/route** two blocks (draw the cable).
3. **Remove a block.**
4. **Rename the preset.**
5. **Save** the preset (to the same slot is fine -- use a slot you don't care about).

That host-to-device traffic IS the missing protocol. Bonus, same session: any device-to-host
response frames double as the C1 read-path confirmation.

---

## Sending captures

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) with files attached, or email via the `author` field in the install folder's `package.json`. Include: device model (Standard vs Ultra), firmware version if known, and a one-line note of what the session was doing when the capture was taken.
