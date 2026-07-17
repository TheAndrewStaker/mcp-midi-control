# Testing: AX8

> The AX8 is Fractal's floor-unit multi-FX pedalboard -- the Axe-Fx II engine
> (same wire codec as the Axe-Fx II XL+ this server already hardware-verifies)
> in a different chassis, not a new protocol. **No AX8 hardware is on hand**, so
> every fact behind this config is evidence-backed (wiki + owner's manual
> citations, one independently-surfaced capture whose checksum byte matches
> this codec's own formula) but **untested end-to-end**. Reads, individual
> parameter writes (`set_param`, `set_params`, `set_block`, `set_bypass`),
> preset navigation (`switch_preset`, `switch_scene`, `save_preset`,
> `scan_locations`), whole-preset reads/backups (`get_preset`,
> `export_preset`, `import_preset`), AND the multi-step preset-BUILD tools
> (`apply_preset` / `apply_setlist`) all ship community-beta,
> hardware-unverified. The former apply gate was removed 2026-07-15: the
> shared build pipeline is now parameterized by model byte, so every frame
> it emits carries the AX8's `0x08`.

See [README.md](README.md) for setup.

The AX8 shares the Axe-Fx II's grid (4 rows x 12 columns), 8 scenes/preset, and
X/Y channel model. Its block roster is REDUCED to single-instance-only on
several groups (no Amp 2, Cab 2, Reverb 2, and others -- see
`packages/fractal-gen2/src/configs/ax8.ts`); addressing an unavailable
block/instance refuses with a clear message. 512 presets across 64 banks (8
per bank).

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your AX8 connected over USB:

> "What can you see about my AX8?"

Paste the response. Confirms port detection (the MIDI port name the server
matched against `/ax8/i`) and the reported grid/preset/scene shape.

---

## T2 -- Read the active preset
**~3 min | no tools**

> "What's loaded on my AX8 right now?"

Expect the preset name, the placed blocks with their grid positions, and
per-block bypass state. Compare to the front panel. A wrong block name, grid
position, or bypass state is the single highest-value bug to report (it is the
first hardware exercise of the AX8's `get_preset` read path).

---

## T3 -- Read and write a parameter
**~3 min | no tools**

> "Read the input drive on my amp block."

Then:

> "Set it to 6."

Confirm the read matches the panel, and that the write's audible/visible
effect matches what you asked for (Axe-Fx-family `set_param` writes are
fire-and-forget on the wire, no device ack -- your eyes/ears are the
verification).

---

## T4 -- Confirm the reduced block roster
**~2 min | no tools**

> "Can I place a second Amp block?"

The server should explain that the AX8 doesn't have a second Amp instance
(single-instance-only) and refuse cleanly, rather than silently building a
frame the device would never answer. This confirms the `availableOnAX8`
block filter is working.

---

## T5 -- Build a preset in one step (apply_preset)
**~5 min | no tools**

Ask Claude to build a small preset in one step, e.g.:

> "Build me a clean amp + reverb preset."

The multi-step build pipeline (`apply_preset`) is un-gated on the AX8 as of
2026-07-15 (every frame it emits is model-byte-addressed `0x08`), but it has
never run against real AX8 hardware. Expect the server to wipe the working
buffer's grid, place the blocks on row 2, cable them, set params, and land
audible. Report: did sound come out, did the blocks appear on the grid
(front panel / AX8-Edit after a reload), and paste any errors verbatim. This
is the single highest-value AX8 test: it exercises grid placement, cabling,
param writes, bypass, and the safety output mute in one pass.

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues)
(label: `community-beta`) or reply to the Reddit / Fractal Forum thread.
Include: AX8 firmware version, loaded preset, whether AX8-Edit was open at
the same time.
