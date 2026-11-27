# Helping with the Fractal FM9

<!-- contribution-meta
device_id: fm9
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's floor-format amp modeler and multi-effects unit, on the modern
gen-3 codec shared with the Axe-Fx III, FM3 and VP4
(`packages/fractal-gen3/src/configs/fm9.ts`). Blocks sit on a grid; presets
carry scenes and per-block channels. Fractal's editor app is **FM9-Edit**, and
**Fractal-Bot** handles preset transfers.

The FM9 is the **most confirmed** gen-3 device, so most of what a new owner
could test here is already done. The remaining asks are narrow and specific.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | confirmed | A community owner test on firmware 11.0, macOS, round-tripped reads through this server, including channel-specific reads and amp-name alias resolution |
| `set_param` continuous knobs | confirmed | The same owner test, acknowledged with the value confirmed on the editor display. A later catalog-wide SET then GET round-trip on hardware confirmed the continuous path across the whole FM9 catalog |
| `set_block` placement | confirmed for single-word blocks | A Windows verify probe on firmware 11.0 placed a block and the device's own status dump listed it. On firmware 12.0 the FM9 inserts at the cursor cell unless a cell-select comes first: an owner sent select-then-insert frames built by this repo's own builders and placed Input, Drive, Amp, Cab, Delay, Reverb and Output at the cells asked (issue #23). Since 0.9.0 `set_block` sends that select before every insert; the tool call itself is not yet re-run on firmware 12 |
| Grid cables (`apply_preset` routing) | confirmed law, tool path untested | The 6-row cable formula was wrong (cables had no effect). The corrected formula was confirmed on firmware 12.0 for same-row connect, disconnect and a cross-row cable (issue #23), and 0.9.0 uses it |
| `set_block` / `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | These never resolved before 2026-08-03: the write path matched display names and group codes against the descriptor SLUG, so `graphic_eq`, `parametric_eq`, `gate_expander`, `volume_pan`, `pan_tremolo`, `multitap_delay`, `megatap_delay`, `ten_tap_delay`, `plex_delay`, `ring_modulator`, `multiband_compressor`, `tone_match`, `ir_capture`, `ir_player` and `real_time_analyzer` returned "unknown block" for a block the device really has. The resolver now matches the read path. **The effect IDs come from the v1.4 spec table and the frame is the same wire-confirmed insert, but no one has placed one of THESE blocks on hardware.** Treat as untested |
| `switch_scene`, `switch_preset`, `set_bypass` | confirmed | The firmware 11.0 probe run (scenes), and an owner session on firmware 12.0, Windows 11 (all three, issue #23) |
| `apply_preset` fresh build | hardware-unverified | New in 0.10.0. It clears the edit buffer by loading an empty template (every frame acked, FM9 evidence; read back and compared), or, failing that, clears cell by cell with 40 ms pacing (third-party reports: the axefx-sysex-maps TOPOLOGY notes and ToneCommand #250) and re-reads to confirm the buffer is empty. Without `routing[]` it lays one row from column 2 and adds Input 1, Output 1, shunts (id 1024 + n) and cables, then writes every scene (unlisted scenes copy scene 1), restores the old name when none is given, and reads the grid and each scene back (the live grid read, else the edit-buffer dump). A mismatch, or no read-back at all, returns `ok:false` and nothing is saved. Channel-nested params put the block back on its planned channel; a 0x64 code 0 or 2 on an insert is left to the read-back, and a shunt answered 2 retries with the next index. Duplicate blocks and instances past the FM9 limit are refused before any write. Built and simulator-tested; not yet run on a FM9 |
| `set_channel` | hardware-unverified | New in 0.10.0: the gen-3 fn=0x0B channel select, confirmed on the FM3, followed by a fresh status read that reports whether the channel moved |
| Knob tapers from the editor typecode | hardware-unverified | Since 0.10.0 a row with typecode `0x52` is a 0..10 knob whatever window it states, and a `0x4X` row is log10 over its window (about 200 params per device moved off linear, PEQ frequencies among them). Decoded on an FM3, firmware 12, in community PR #24; the cache grammar and typecodes are shared, so it applies here too |
| Read precision from the editor typecode | hardware-unverified | Since 0.10.0 a read prints the decimals the panel shows instead of always two: delay times as whole ms, most mixes to 0.1, input trim to 0.001 (618 params changed). The low digit of each row's typecode sets it; on the Axe-Fx II's own cache it matches the panel's decimals on 398 of 413 params. Ask: read one mix and `reverb.reverbdelay` with `get_param` and compare with the front panel |
| Preset and scene rename | confirmed | The legacy rename frame is rejected on firmware 12.0. The `fn=0x01 sub=0x28` preset rename and `sub=0x2B` scene rename both showed on the panel and persisted through a save (issue #23); 0.9.0 uses them |
| Reading a block's current type or model | hardware-unverified | Read as the bulk read's ordinal, labeled from the roster. The fn=0x01 sub=0x1F name query this used to rely on answers with the roster's first entry whatever the real type (two independent owners, firmware 11 and 12), so it is no longer used |
| Enum names for every selector | hardware-unverified | Since 0.9.1 all 507 FM9 selectors its fw 12.0 editor cache defines are named from it. That corrected lists the family overlay had wrong: LFO types from ordinal 6 ("Log" sent EXP), `delay.model` from 22, `pitch.tempo`, `inputselect` |
| `set_param` discrete set-by-name | confirmed | Amp, drive and reverb type by name and cab bank by name, on firmware 12.0 (issue #23). On the FM9 the delay's 29 model names belong to `delay.model`, not `delay.type` (8 values); 0.9.0 moved them, so `set_param(delay, model, "Vintage Digital")` is the call. 0.9.0's names are wrong from ordinal 22; 0.9.1 names all 29 from the FM9's own editor cache |
| Cab IR (`cab.type1` / `type2`) | confirmed | 0..1023 within the selected bank; Factory 2 #315 showed "4x12 1960A 300W 57" and Factory 1 #0 "1x4 Pig 57", matching the roster this server labels from (issue #23). The 0..15 cap is gone in 0.9.0 |
| Tempo divisions (`tempo` on delay and other blocks) | confirmed | The division is an ordinal into the 79-entry list the AM4 uses: 12 showed "1/8 Dot" on firmware 12.0 (issue #23). 0.9.0 ships that list; from 0.9.1 the agent sets `tempo` by name, and `pitch.tempo` (78 entries, no "None") is no longer one off |
| `save_preset` | confirmed | Firmware 12.0: the save persisted the preset and scene names, checked by switching away and back (issue #23). Mind the Display Offset setting: a unit set to number presets from 1 shows location 495 as 496 |
| `get_preset` live grid read | confirmed | Used as the read-back for every placement and cable in the firmware 12.0 session, and it matched the panel (issue #23). Its `route_flag` is a bitmask of source rows |
| Block list in a stored `get_preset` | hardware-unverified | Under 0.8.0 this list showed blocks the preset does not hold (issue #23). Since 0.9.0 it names stored blocks from the grid; not yet re-checked on an FM9. The stored read's reverb `scene_bypass` disagreed with the panel in the same report and is not yet explained |
| Live CPU and output meters inside `get_preset` | hardware-unverified | Decoded from the same grid frame, not yet front-panel confirmed |
| Writes to a block that is not in the preset | warns, hardware-unverified | Since 0.9.1 `set_param` / `set_params` read the live grid once (cached 5 s) and attach a warning when the block is not placed, or is placed with no input cable. An Axe-Fx III acknowledges such a write and reads back the last value written (issue #35), so the ack alone cannot tell |
| `export_preset` | hardware-unverified | Preset receive is confirmed on this device; the container is self-validating against the device's own CRC |
| `import_preset` | not implemented (refuses) | The gen-3 writer has no byte-restore path yet; the unified verb returns a capability error rather than emitting an unverified push |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen3/src/configs/fm9.ts`, and preflight fails if
the two disagree.

## Confirmed on hardware

- Reads, including channel-specific reads and alias resolution: firmware 11.0,
  macOS, community owner.
- Continuous `set_param`: same test, plus a catalog-wide round-trip.
- `set_block` placement and `switch_scene`: a Windows verify probe, with the
  placed block appearing in the device's own status dump.
- Preset receive, the dump path used by `export_preset`.
- Model rosters and parameter ranges are complete and device-true, from a
  community cache file. Set-by-name works across the whole amp space.
- Firmware 12.0, Windows 11 (issue #23): set-by-name, `save_preset` with names
  surviving, `switch_preset`, `switch_scene`, `set_bypass`, preset and scene
  rename, cab IR selection, the tempo-division list, the live grid read, and
  select-then-insert placement plus the corrected cable formula (sent as raw
  frames from this repo's builders).

**Please do not re-run these.** They are done, and the catalog-wide sweep in
particular does not need repeating.

## Blocked, and on what

Nothing on the FM9 is refused for an undecoded wire shape. What remains is
either a key-press or a data gap.

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Exact `ms` and `Hz` landing for log-taper knobs | Whether a continuous SET's normalized float is normalized in value space or knob-position space. The catalog round-trip used raw wire values, so it did not pin the curve | CAPTURE-1 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** FM9-Edit holds the USB port. Quit it fully before running
  a probe or driving the server. On Windows check the system tray. The exception
  is a CAPTURE ask, which wants the editor running and this project's server
  quit.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  or a probe holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Build a preset through the tools on 0.10.0
**Tier: SESSION | ~5 minutes | writes to the working buffer | unlocks: the tool path for placement, cables and rename on firmware 12**

The firmware 12.0 fixes in issue #23 were proven with raw frames. What is left is
the same build driven through the tools. On an empty location, with FM9-Edit
quit:

> "Build a preset in row 3: Drive, Amp, Cab, Delay, Reverb, wired in order. Name
> it Test Build and give it three scenes: clean (drive off), crunch (amp channel
> B), lead (drive on, delay channel B)."

Since 0.10.0 this is a fresh build: start from a preset that already has blocks
on it, so the clear is tested too. Report whether the old blocks are gone,
whether Input 1 is in column 1, the five blocks in columns 2 to 6 and Output 1 in
column 7, whether the cables connect, whether scenes 1 to 3 show the bypass and
channel asked and scenes 4 to 8 match scene 1, whether the name shows, and what
`ok` and `chain_integrity` said. Then read it back with `get_preset`
for that location and say whether the `blocks` list matches the grid.

### SESSION-2: Run the write-verify probe on a preset that has a reverb block
**Tier: SESSION | ~5 minutes | writes to the working buffer, self-restoring | unlocks: the multi-word block names, and the probe's own checks on firmware 12**

Load a preset that **has a Reverb block** first: the probe skips its reverb
tests if no reverb is placed, which is what a previous run hit.

Quit FM9-Edit, then:

- **Windows release package:** double-click `fm9-verify.cmd` in the install
  folder.
- **macOS or a source checkout:** `npm run fm9:verify`.

Self-restoring: it never saves on its own, and it records your active preset
first and reloads it at the end and on Ctrl-C. That discards any unsaved edits
you had open, so store or abandon those first.

Send back the JSON it writes, plus a note of anything the front panel did.

### SESSION-3: Check the live CPU and output meters
**Tier: SESSION | ~5 minutes | read-only in practice | unlocks: confidence in the meter decode**

The meters inside `get_preset` are decoded and cross-validated against a
capture, but no owner has compared them to the device's own display.

> "How much CPU is my current preset using?"

Compare the reported CPU percentage to the FM9's own CPU meter on its Home or
Layout page. Then, while audio is playing, glance at whether the reported left
and right output levels track the output meters.

Report both comparisons. The device INPUT meter is deliberately not surfaced;
its offset is not portable across the gen-3 family, so do not expect one.

### PROBE-1: Run the read-back probe
**Tier: PROBE | ~5 minutes | read-only | unlocks: read-path confirmation on your firmware**

A read-only diagnostic. It never writes and never changes a preset.

Quit FM9-Edit, then:

- **Windows release package:** double-click `fm9-probe.cmd`.
- **macOS or a source checkout:** `npm run fm9:probe`.

Send back `fm9-probe-output.json`.

For a wider sweep of everything the device will say about itself in one command,
see the read-only [harvest script](../tools/harvest-script.md).

### CAPTURE-1: One log-taper knob sweep with the panel readings
**Tier: CAPTURE | ~10 minutes | sniffer required | unlocks: exact `ms` and `Hz` landing**

Identical in shape to the III's version of this ask, and one capture from either
device answers it for the family. Full steps and the reason it is worth doing:
[axe-fx-iii.md](axe-fx-iii.md), CAPTURE-1.

The short version: sweep one log-taper knob, a Reverb or Delay **Time** or a Low
or High **Cut**, to at least five points across its range, pausing at each, and
**write down the exact number the display shows with its units** at every point.
Send the capture plus the ordered list of readings. Without the paired readings
the capture cannot be used.

CAPTURE-2 (a type-dropdown sweep to build name rosters) is closed: the fw 12.0
editor cache names every selector, so no capture is needed.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- FM9 firmware version,
- operating system,
- the loaded preset, number and name,
- FM9-Edit version,
- whether the editor was open at the same time,
- for a SESSION ask, what the front panel did.

## When an ask closes

1. Move the capability's row in **Support status** to its new status word and
   cite the new evidence.
2. Add a line to **Confirmed on hardware** if a device confirmed it.
3. Delete the closed ask from **Asks, ranked**, or reduce it to a one-line closed
   note if a sibling gen-3 device still needs it.
4. Update `capabilities.support_tier` and `capabilities.verification` on the
   descriptor if the tier moved. Preflight fails if the page and the descriptor
   disagree.
5. Update this device's row in [../README.md](../README.md).

Because the gen-3 family shares one codec, check whether the same evidence
closes a row on [axe-fx-iii.md](axe-fx-iii.md), [fm3.md](fm3.md) or
[vp4.md](vp4.md) too.
