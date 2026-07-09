# Testing: VP4

> The VP4 **reads** are implemented (get_param, get_preset) and hardware-unverified. `get_preset` now includes the **whole-preset structure read** (decoded 2026-07-01 from the fw 4.03 captures): preset name, all four scene names, the CURRENT scene, and the 4-slot chain in one round-trip. **First writes ship too**, decoded byte-exact from a community capture (fw 4.03) and untested on hardware: continuous-knob set_param (raw wire values, %/ms calibration pending), set_bypass, and save_preset. Block placement (set_block / apply_preset), scene switching, and enum/TYPE sets stay **gated** until their wire shapes are captured. See [captures-vp4.md](captures-vp4.md) for what unlocks the rest — including a zero-cost read-only scene-query probe (P0 there).

See [README.md](README.md) for setup.

The VP4 is **AM4-shape**: a serial 4-slot effect chain with 4 scenes, A-D channels, and A01--Z04 preset locations. It has no amp/cab block.

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your VP4 connected:

> "What can you see about my VP4?"

Paste the response. Confirms detection and shape (4-slot serial chain).

---

## T2 -- Read the active preset
**~3 min | no tools**

> "What's loaded on my VP4 right now?"

Expect the **preset name, the four scene names, which scene is active, and the blocks in
their real slot order (1..4, empty slots included)** — all from the newly decoded
structure read. Everything should match the panel. **A wrong name, scene, or slot order is
the single highest-value bug to report** (it's the first hardware exercise of this read).

---

## T3 -- Read a parameter
**~3 min | no tools**

> "Read the mix on the reverb."

Paste the JSON and what the panel shows. Try a delay or drive parameter too.

---

## T4 -- Confirm write gate fires
**~1 min | no tools**

Try a write request -- for example: "Set the reverb mix to 50%." The server should **refuse** with an "untested on hardware" message. Paste the response to confirm the gate fires correctly.

---

## T5 -- Probe

There is no standalone VP4 probe script yet (unlike the III / FM3 / FM9, which ship one). T1--T4 above cover the same ground through Claude Desktop on any platform, so no extra step is needed here. If a VP4 probe script is added later, it will appear in the install folder and this page will describe it.

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: VP4 firmware, loaded preset, VP4-Edit version.
