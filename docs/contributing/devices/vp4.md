# Helping with the Fractal VP4

<!-- contribution-meta
device_id: vp4
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's compact four-slot effects pedal. It runs the modern gen-3 codec
but has an **AM4 shape**: a serial four-slot effect chain rather than a grid,
four scenes, A to D channels, and A01 to Z04 preset locations. It has no amp or
cab block (`packages/fractal-gen3/src/configs/vp4.ts`). Fractal's editor app is
**VP4-Edit**.

The VP4 has the fewest confirmed capabilities of the four gen-3 devices, and the
largest gap between what is decoded and what anyone has checked. If you own one,
almost anything you do here is new information.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | hardware-unverified | The parameter READ path, the gen-3 envelope and checksum, the block effect-ID table and the device-true parameter catalog are all confirmed on hardware **in a community capture**, meaning the bytes came off a real VP4. Nobody has driven the read through this server |
| `get_preset`, whole-preset structure read | hardware-unverified | Decoded from the same captures: preset name, all four scene names, the current scene index, and the four-slot chain including empty slots, in one round-trip. Oracle-matched against an annotated move cascade in both captured presets |
| `set_param` / `set_params`, continuous knobs only | hardware-unverified | The VP4's write frame is its own shape, not the other gen-3 devices': no sub-action, a `tc` sub-opcode, and a swapped-septet float. Decoded byte-exact from a community capture on firmware 4.03. Raw wire values only, calibration pending |
| `set_bypass` | hardware-unverified | Same capture |
| `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | Same defect as the grid siblings: until 2026-08-03 the write path resolved the descriptor SLUG against display names and group codes, so `graphic_eq`, `gate_expander`, `volume_pan` and twelve others refused as unknown blocks. `set_block` stays gated on this device regardless (placement math undecoded), so only `set_bypass` changes here |
| `save_preset` | hardware-unverified | Same capture |
| `set_param` on an enum or TYPE selector | gated | Refuses. No discrete type-select example exists in any VP4 capture |
| `set_block` placement | gated | The placement value to slot math is undecoded |
| `switch_scene` | gated | The scene write value mapping is undecoded. The read side is solved |
| `switch_preset`, `rename` | gated | Not decoded for this device |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen3/src/configs/vp4.ts`, and preflight fails if
the two disagree. Per-capability gating sits on top via the descriptor's write
allowlist.

## Confirmed on hardware

Nothing has been driven through this server on a real VP4.

What **has** come off real hardware, in two community captures on firmware 4.03,
is the wire evidence everything above is decoded from: a read-poll session and
an edit session whose 69 write frames map one to one onto an annotated action
list. That is strong evidence, and it is why the write path ships. It is not the
same as a confirmation, which is what the asks below are for.

## Blocked, and on what

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| `switch_scene` | The scene write value mapping. A single captured value for one scene change is not enough to solve it; exhaustive from-to pairs are | PROBE-1, then CAPTURE-1 |
| `set_block` placement | The placement value to slot math. The registers are identified and the chain state is now fully readable, so what remains is exactly the value math of the write frames | CAPTURE-1 |
| `set_param` on enum or TYPE selectors | No discrete type-select example exists in any capture | CAPTURE-2 |
| Real percentage and millisecond units on knobs | Display calibration: which wire value equals which front-panel number | DONATE-1, or CAPTURE-2 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** VP4-Edit holds the USB port. Quit it fully before running
  a probe or driving the server. On Windows check the system tray. The exception
  is a CAPTURE ask, which wants VP4-Edit running and this project's server quit.
- **The VP4 is a MIDI-class USB device**, not the FM3's serial special case. No
  extra driver is needed beyond Fractal's normal one on Windows.
- **VP4-Edit polls very fast, and that has already destroyed one capture.** See
  the warning inside CAPTURE-1 before you record anything.
- **Firmware updates.** Never run a firmware update while the server or a probe
  holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### PROBE-1: The scene-query probe
**Tier: PROBE | ~1 minute | read-only | unlocks: possibly `switch_scene`, in one frame**

The highest value per minute on this page. One read-only frame that might unlock
a whole capability.

The gen-3 family documents a read-only SCENE query. The script sends exactly
that one frame and nothing else:

```
F0 00 01 74 14 0C 7F 12 F7
```

From a source checkout, with your VP4 connected over USB and **no Fractal editor
running**:

```
npx tsx scripts/probe-vp4-scene-query.ts
```

Read-only guarantee: the `7F` byte is the documented **query sentinel**, never a
scene number, so this asks "what scene is active" and cannot set one. The script
only ever sends the query form. It prints the candidate SET frames as guidance
text and **does not send them**; sending those is a separate, later, explicitly
consented step once someone signs up to watch the front panel
(`scripts/probe-vp4-scene-query.ts`).

It prints the reply if there is one and writes a JSON report you can attach.

- **If the VP4 answers**, that is the whole ask. It very likely means
  `switch_scene` can ship on the VP4 without decoding the scene value at all.
- **If it does not answer**, that is still useful. It means the scene mapping
  needs the fuller capture work in CAPTURE-1.

Please send the result either way.

### DONATE-1: Send your VP4-Edit definition cache
**Tier: DONATE | ~2 minutes | no device time | unlocks: rosters, ranges, steps and the display calibration half of the capture asks**

For the VP4 this is still the primary unlock, more than for any of its siblings.
The copies on hand are tiny unsynced stubs.

Full instructions: [../tools/editor-cache-file.md](../tools/editor-cache-file.md).
For the VP4 the filename starts `effectDefinitions_14_`.

One device-synced file yields the VP4's complete parameter dictionary: ranges,
defaults, steps and every enum's name list. That closes the display-calibration
half of the capture asks below, offline.

### SESSION-1: Read the active preset and check it
**Tier: SESSION | ~3 minutes | read-only | unlocks: `get_preset` and `get_param`**

Nobody has ever driven a VP4 read through this server, and the whole-preset
structure read is the newest decode on the device.

With the VP4 connected and VP4-Edit quit:

> "What's loaded on my VP4 right now?"

Expect the **preset name, all four scene names, which scene is active, and the
blocks in their real slot order from one to four including empty slots**.
Everything should match the panel.

**A wrong name, wrong scene, or wrong slot order is the single highest-value bug
to report here**, because this is the first hardware exercise of that read.

Then:

> "Read the mix on the reverb."

Paste the response and say what the panel shows. Try a delay or drive parameter
too.

### SESSION-2: Confirm one continuous write
**Tier: SESSION | ~3 minutes | writes to the working buffer | unlocks: `set_param`, `set_bypass`, `save_preset`**

The VP4's write frame is decoded byte-exact from a real capture but has never
been sent by this server to a real device.

> "Set the reverb mix to 50%."

Report whether the panel moved, and to what. Values currently go out as raw wire
numbers because calibration is pending, so **the number you see on the panel is
itself the data**: tell us what you asked for and what appeared.

Then try bypassing a block, and finally, on a preset location you do not care
about, a save.

### CAPTURE-1: One comprehensive coverage session
**Tier: CAPTURE | ~15 minutes | sniffer required | unlocks: placement, scenes, type selects and display calibration**

This single session closes every remaining VP4 gap. If you can do one recording,
do this one.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).
On macOS, MIDI Monitor works well for this device.

> **Read this first, because it has already cost one capture.** A previous VP4
> recording contained only sixteen-byte read polls and zero write frames, and
> **not** because the edits were not made. VP4-Edit polls the active preset at
> roughly 390 messages per second, and the capture tool kept only its most recent
> 1000 messages, so the poll flood flushed the edit writes out of the buffer
> before the file was saved. The writes were captured and then discarded.
>
> The fix, in order of importance:
>
> 1. **Raise your capture tool's message limit** to its maximum before you start.
>    This is the key fix.
> 2. Or quit VP4-Edit right after the edit and then save, which stops the poll so
>    your edit stays near the tail.
> 3. Start recording **before** you touch anything.
> 4. One action at a time, about three seconds between actions.
> 5. **Confirm a message going TO the VP4 that is longer than sixteen bytes**
>    exists near your edit. Sixteen-byte messages to the VP4 are reads. A write is
>    a longer message. If everything to the VP4 is sixteen bytes, the write was
>    evicted; raise the limit and redo.

Keep recording throughout, pause about three seconds between steps, and **write
down the value you set at each step**. You do not need to read the pedal's
screen: since you are setting each value yourself, the number shown in the editor
is exactly what is needed.

1. **Calibration sweeps, the highest value.** Set a knob to a few exact values
   and write each down:
   - Delay **Mix**: 0%, then 50%, then 100%.
   - Delay **Feedback**: 0%, then +50%, then -50%.
   - Delay **Time**: 100 ms, then 500 ms, then 1000 ms.
2. **Discrete type select:** change the Reverb or Delay **TYPE** to a specific
   named model, and write the name down. There is no example of this anywhere.
3. **Block placement, two distinct moves:** move one block from slot 2 to slot 4,
   pause, then move a different block from slot 1 to slot 3. Note exactly which
   block and which from and to. Two moves is what lets the slot encoding be
   cracked. If you have patience for more: an adjacent move and its reverse, a
   long move, a move into an EMPTY slot and a move onto an OCCUPIED slot. The
   cascade versus no-cascade pair separates the gesture value from the resulting
   layout.
4. **Scene mapping:** switch scene 1 to 2 to 3 to 4, one at a time, pausing and
   noting each. If you can, cover more from-to directions: 4 to 1, 1 to 3, 2 to
   4. One captured scene value is not enough to solve the mapping; exhaustive
   pairs are.
5. **Bypass a second block:** bypass and re-enable a block other than reverb, to
   confirm the bypass value is not block-specific.
6. **Delete and re-add:** delete one block, noting the slot, pause, then re-add
   the same block type into a chosen slot. This captures the ADD frame, which no
   capture holds yet.
7. **From the pedal, not the editor:** do one move and one scene switch on the
   VP4's own front panel while recording. This separates what the device emits
   from what VP4-Edit merely displays.
8. **Save once** at the very end.

Stop and send the file plus your written list of actions **in order**.

### CAPTURE-2: Receive one preset with Fractal-Bot
**Tier: CAPTURE | ~5 minutes | sniffer plus Fractal-Bot | unlocks: backup and export**

1. Start the capture with the VP4 connected.
2. In Fractal-Bot choose **Receive** and grab a single preset from the device.
3. Stop. Send the capture plus device model and firmware.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- VP4 firmware version,
- operating system,
- the loaded preset,
- VP4-Edit version,
- whether VP4-Edit was open at the same time,
- for a capture, a one-line note of each action **with its order**.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**, or reduce it to a one-line closed
   note if a sibling gen-3 device still needs it.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved, and the write allowlist if a gated capability
   opened. Preflight fails if the page and the descriptor disagree.
5. Update this device's row in [../README.md](../README.md).

Because the gen-3 family shares one codec, check whether the same evidence
closes a row on [axe-fx-iii.md](axe-fx-iii.md), [fm3.md](fm3.md) or
[fm9.md](fm9.md) too. The VP4's write frame is its own shape, so write evidence
does **not** transfer in either direction.
