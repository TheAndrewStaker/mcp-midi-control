# Helping with the Fractal Axe-Fx III

<!-- contribution-meta
device_id: axe-fx-iii
support_tier: community-beta
transport: midi
preset_class: layout
owned_by_maintainer: no
-->

## Device

Fractal Audio's flagship rackmount amp modeler and multi-effects processor.
Blocks sit on a grid, presets carry scenes and per-block channels. Fractal's
editor app is **Axe-Edit III**, and **Fractal-Bot** handles preset transfers.

The III is the **byte-identity anchor** for the modern Fractal family: the III,
FM3, FM9 and VP4 share one codec, differing by model byte, grid and scene shape,
and a device-specific parameter catalog
(`packages/fractal-gen3/src/configs/axe-fx-iii.ts`,
`packages/fractal-gen3/src/factory.ts`). Confirming something on the III raises
confidence family-wide, which is why III evidence is worth more than its own
device.

## Support status

| Capability | Status | Evidence |
|---|---|---|
| `get_param` / `get_params` | confirmed | A community owner test on firmware 25.04 read back a value matching the front panel |
| `set_param` continuous knobs | confirmed | The same owner test set amp gain on channel A with a device echo. A later community round-trip then exercised SET then GET across the entire III catalog on hardware |
| `set_param` discrete set-by-name | confirmed | A Mk I owner on firmware 32.06 set Amp 1 channel A from 5F1 Tweed to Plexi 100W High by name and saw it in Axe-Edit, with channels B to D and the active channel untouched; a reverb type set by ordinal (45, Music Hall) read back 45 (issue #25). Type and model selectors use the discrete form, routed from the catalog round-trip oracle |
| `get_preset`, including the live grid read | hardware-unverified | Decoded from the shared gen-3 grid frame |
| Block list in a stored `get_preset` | hardware-unverified | Blocks are named by pairing the stored block chain with the grid, which holds for all 384 factory presets (fw 28). A fw 32 report had Input shown as Vol/Pan, Output as PEQ and several blocks missing, because the old method named blocks by parameter-table size and those sizes move with firmware. Not yet re-run on a fw 32 unit; if the pairing ever fails the response says so and falls back |
| `set_block` placement | hardware-unverified | Placement is hardware-confirmed on the sibling FM9 and FM3. Not yet on the III |
| `set_block` / `set_bypass` on the 15 multi-word blocks | **hardware-unverified, newly reachable** | These never resolved before 2026-08-03: the write path matched display names and group codes against the descriptor SLUG, so `graphic_eq`, `parametric_eq`, `gate_expander`, `volume_pan`, `pan_tremolo`, `multitap_delay`, `megatap_delay`, `ten_tap_delay`, `plex_delay`, `ring_modulator`, `multiband_compressor`, `tone_match`, `ir_capture`, `ir_player` and `real_time_analyzer` returned "unknown block" for a block the device really has. Effect IDs come from the v1.4 spec table and the frame is unchanged, but none of THESE blocks has been placed or bypassed on hardware |
| `switch_scene`, `set_bypass` | confirmed | The write-verify probe on a Mk I, firmware 32.06: the scene change showed on the front panel and the bypass was accepted, in two runs with identical results (issue #25) |
| `apply_preset` fresh build | hardware-unverified | New in 0.10.0. It clears the edit buffer by loading an empty template (sent un-acked; the per-frame ack is FM9-only evidence; read back and compared), or, failing that, clears cell by cell with 40 ms pacing (third-party reports: the axefx-sysex-maps TOPOLOGY notes and ToneCommand #250) and re-reads to confirm the buffer is empty. Without `routing[]` it lays one row from column 2 and adds Input 1, Output 1, shunts (id 1024 + n) and cables, then writes every scene (unlisted scenes copy scene 1), restores the old name when none is given, and reads the grid and each scene back (the live grid read, else the edit-buffer dump). A mismatch, or no read-back at all, returns `ok:false` and nothing is saved. Channel-nested params put the block back on its planned channel; a 0x64 code 0 or 2 on an insert is left to the read-back, and a shunt answered 2 retries with the next index. Duplicate blocks and instances past the III limit are refused before any write. Built and simulator-tested; not yet run on a III |
| `set_channel` | hardware-unverified | New in 0.10.0: the gen-3 fn=0x0B channel select, confirmed on the FM3, followed by a fresh status read that reports whether the channel moved |
| Knob tapers from the editor typecode | hardware-unverified | Since 0.10.0 a row with typecode `0x52` is a 0..10 knob whatever window it states, and a `0x4X` row is log10 over its window (about 200 params per device moved off linear, PEQ frequencies among them). Decoded on an FM3, firmware 12, in community PR #24; the cache grammar and typecodes are shared, so it applies here too |
| Read precision from the editor typecode | hardware-unverified | Since 0.10.0 a read prints the decimals the panel shows instead of always two: delay times as whole ms, most mixes to 0.1, input trim to 0.001 (724 params changed). The low digit of each row's typecode sets it; on the Axe-Fx II's own cache it matches the panel's decimals on 398 of 413 params. Ask: read one mix and `reverb.reverbdelay` with `get_param` and compare with the front panel |
| `switch_preset` | hardware-unverified, self-checking | A community sweep on a Mk I (firmware 32.06) showed the III honours bank select on CC0 and ignores CC32, so the old Program Change path could land on the wrong bank and still report success. The switch now goes by SysEx, and the tool reads the current preset number back and reports the switch as not acknowledged when the unit did not move |
| `scan_locations`, preset names in `get_preset` | hardware-unverified | The stored-name query answers from flash without loading the preset. Same sweep: names used to come back with trailing padding, now cut at the first NUL |
| `save_preset` | confirmed | On a Mk I, firmware 32.06: the overwrite gate refused a save onto an occupied location, the same save with `confirm_overwrite` landed at exactly that location with the edited gain, and the neighbouring locations were untouched (issue #25). The tool also reads the stored name back after a save and reports a mismatch as not acknowledged |
| Live meters in `get_preset` | output meters only | The CPU figure is omitted on the III: the same sweep read 72 % where the front panel showed 20.0 %, so the sibling formula is falsified here and one reading cannot pin a new one |
| Writes to a block that is not in the preset | warns, hardware-unverified | The III acknowledges such a write and reads back the last value written, so neither the ack nor a read can tell (issue #35). Since 0.9.1 `set_param` / `set_params` read the live grid once (cached 5 s) and attach a warning when the block is not placed, or is placed with no input cable |
| Short block names (`vol_pan`, `tremolo`, `megatap`, `ring_mod`, `multi_delay`, "Tone Match") | resolve, hardware-unverified | `set_param`, `get_param` and `set_bypass` take them since 0.9.0; `set_block` takes the same names since 0.9.1 (it needed the full catalog name before, issue #35) |
| Resonator and Looper reads | hardware-unverified | The same sweep left 20 Resonator and 6 Looper params unreadable: the counts fit a Resonator dump of 2 channels x 40 and a Looper dump of 3 x 24, which the old 4-channel split cut short. Since 0.9.1 the reader splits each block by the stride in the III's own editor cache (issue #13) |
| `include_channel_state` on the active `get_preset` | not honoured, says so | Slots carry channel A only: all four channels of every placed block would pass the response size limit. The response now says so; read other channels with `get_params` and a `channel` per query |
| `export_preset` | active buffer: no answer; stored location: hardware-unverified | On a Mk I, firmware 32.06, the active-buffer request (fn 0x43) got no answer (issue #35). An export by location uses the stored dump, which the III answers; its container is self-validating against the device's own CRC |
| `import_preset` | not implemented (refuses) | The gen-3 writer has no byte-restore path yet; the unified verb returns a capability error rather than emitting an unverified push |

Support tier: `community-beta`. This mirrors `capabilities.support_tier` on the
descriptor at `packages/fractal-gen3/src/configs/axe-fx-iii.ts`, and preflight
fails if the two disagree.

## Confirmed on hardware

- `get_param` and continuous `set_param`: confirmed on firmware 25.04 by a
  community owner. Amp gain on channel A, device echo, read-back matching the
  front panel.
- A catalog-wide SET then GET round-trip on hardware, which confirmed the read
  and continuous-write paths across the whole III parameter catalog and produced
  the oracle used to correct type and model selectors to discrete routing.
- On a Mk I, firmware 32.06, macOS (issue #25, 2026-10-29): the read-back probe
  (patch name, active scene, tempo and status dump answered; 40 of 42 block
  types returned data), the write-verify probe (continuous set, a reverb type
  by ordinal, `set_bypass`, `switch_scene`), a set-by-name amp model change,
  and a `save_preset` behind the overwrite gate. Its `set_block` result was a
  false pass under 0.8.0 (the block replaced the one at the cursor); 0.9.0
  sends a cell-select first and is not yet re-tested on the III.

**Please do not re-run these.** Reads, continuous and discrete writes, scenes,
bypass and save are done on the III. What is still open is `set_block`
placement and the live grid read.

## Blocked, and on what

Nothing on the III is blocked in the strict sense: no capability is refused for
an undecoded wire shape. Everything above either is confirmed or is
evidence-backed and shipping while it waits for a key-press.

The community cache from issue #13 (firmware 32.06) now supplies both the
device-true display ranges (gated by `npm run verify-iii-ranges`) and every
enum name: since 0.9.1, all 546 III selectors the cache defines are named from
it (`scripts/gen-gen3-enum-names-from-cache.ts`). That corrected lists the
family overlay had wrong, so a set by name sent a different value: LFO types
from ordinal 6, `delay.model` from 22, `pitch.tempo` (no "None" on the device),
and `inputselect`. Untested on hardware; the names are the editor's own.

One genuine data gap remains, and it is not a wire shape:

| Blocked capability | Missing evidence | Closed by |
|---|---|---|
| Exact `ms` and `Hz` landing for log-taper knobs | Whether the normalized float a continuous SET carries is normalized in value space or in knob-position space. The two readings differ a lot mid-range | CAPTURE-1 |

## Before you start

Read [../SAFETY.md](../SAFETY.md) once. The device-specific parts:

- **Port exclusivity.** Axe-Edit III and Fractal-Bot hold the USB port. Quit them
  fully before running a probe or driving the server, and quit the MCP host
  before opening them again. On Windows check the system tray. On macOS an open
  Axe-Edit III made no difference in one owner's runs (two runs, one with the
  editor open, gave byte-identical results), but quitting it is still the safe
  default.
- **Watching a run on a Mk I on macOS.** During the write-verify probe the Mk I
  front panel showed only the scene changes, not the parameter writes. Keep
  Axe-Edit III open to watch, then quit it before the next probe. The exception is
  CAPTURE-1, which wants the editor running and this project's server quit.
- **Firmware updates.** Never run Fractal-Bot's firmware update while the server
  or a probe holds the port.
- **What we will never ask you to do.** No firmware modification, no opening the
  unit, no factory reset.

## Asks, ranked

### SESSION-1: Run the write-verify probe
**Tier: SESSION | ~5 minutes | writes to the working buffer, self-restoring | unlocks: `set_block` placement**

Set-by-name, `set_bypass` and `switch_scene` are confirmed (issue #25). What a
new run on 0.9.1 or later still settles is `set_block`: under 0.8.0 the probe
reported a pass while the block replaced the one at the cursor, 0.9.0 sends a
cell-select before every insert, and 0.9.1 lets `set_block` place every III grid
block (issue #35). Check the grid in Axe-Edit III, not
only the probe's verdict.

Quit Axe-Edit III first, then:

- **Windows release package:** double-click `axefx3-verify.cmd` in the install
  folder.
- **macOS or a source checkout:** `npm run axefx3:verify`.

Load a preset that **has a Reverb block and no Drive block** before you start:
the probe skips the reverb tests if no reverb is placed, and skips the placement
test if a Drive is already there.

Self-restoring: it never saves, it records your active preset number first and
reloads it at the end and on Ctrl-C, which discards every working-buffer change.
It also discards any unsaved edits you had open, so store or abandon those
first.

Send back the JSON it writes, plus a note of anything the front panel did.

SESSION-2 (set-by-name) and SESSION-3 (save) are closed: both confirmed on a Mk I,
firmware 32.06 (issue #25).


### DONATE-1: Send your Axe-Edit III definition cache
**Tier: DONATE | ~2 minutes | no device time | unlocks: cross-validation of ranges and enum rosters on your firmware**

The 2026-07-02 community cache already delivered the III's device-true display
ranges (shipped, gated by `npm run verify-iii-ranges`) and carries the full enum
name vocabulary, so the original ask is closed. A cache from YOUR install still
helps: a second cache from a different firmware cross-validates the ranges and
the rosters, exactly how the FM9's fw 11.0 and 12.0 caches caught its amp-roster
growth, and mechanically double-checks the discrete routing correction that
rests on the 2026-06-18 round-trip oracle.

Full instructions, including where the file lives and how to tell a real cache
from a placeholder: [../tools/editor-cache-file.md](../tools/editor-cache-file.md).
For the III the filename starts `effectDefinitions_10_`.

Five Mk I caches arrived with issue #25 (firmware 21.01, 27.01, 27.02, 32.04 and
32.06). The 32.06 one agrees with the shipped ranges at 2,847 of 2,850 shared
records, with no roster name changed; the three that differ are Mk I limits (512
presets instead of 1024), and the Mk I has no Full-Res IR mode or "USER 3 (FR)"
bank. A cache from firmware 33 is still worth sending; another 32.x is not.
### PROBE-1: Run the read-back probe
**Tier: PROBE | ~5 minutes | read-only | unlocks: read-path confirmation on your firmware**

Done on a Mk I, firmware 32.06 (issue #25). Worth running again on a Mk II or
Turbo, or on firmware 33, because the block roster and preset count differ.

A read-only diagnostic. It polls your active preset, runs a set of read-only
queries, and writes a JSON file. It never writes and never changes a preset.

Quit Axe-Edit III, then:

- **Windows release package:** double-click `axefx3-probe.cmd`.
- **macOS or a source checkout:** `npm run axefx3:probe`.

Send back the JSON file it writes: `axefx3-probe-output.json` on your Desktop
from the Windows package, or `axe-fx-iii-probe-output.json` in the checkout
folder from `npm run`.

If you would rather send everything the device will say about itself in one
sweep, the read-only [harvest script](../tools/harvest-script.md) covers more
ground in one command.

### CAPTURE-1: One log-taper knob sweep with the panel readings
**Tier: CAPTURE | ~10 minutes | sniffer required | unlocks: exact `ms` and `Hz` landing**

One narrow question, and only a capture answers it. A continuous SET carries a
normalized float. For a knob with a log taper, a Reverb or Delay **Time**, or a
Low or High **Cut**, we do not know whether that float is normalized in value
space or in knob-position space. Until it is settled, "set delay time to 500 ms"
may land somewhere else on the panel for log-taper knobs. Linear knobs like amp
Gain are already correct.

One-time tool setup: [../tools/capture-setup.md](../tools/capture-setup.md).

1. Start the capture. Open the editor and pick a Reverb or Delay **Time** knob.
2. Drag it to a LOW value, pause, and **write down the exact number the display
   shows, with its units**, for example `0.30 s`.
3. Drag to a MID value, pause, write down the number.
4. Drag to a HIGH value, pause, write down the number.
5. Keep going to **at least five points across the full range**. More is better.
6. Stop. Send the capture **plus the ordered list of panel readings**.

> **The display readings are the whole point.** The wire floats alone cannot
> reveal the curve. Without the paired numbers the capture cannot be used, and
> that is the most common reason a calibration capture comes back unusable.

A second knob in a different unit, a frequency knob in Hz, in the same recording
roughly doubles the value for one extra minute.

Reload the preset afterwards to revert. Nothing is stored.

CAPTURE-2 (the tempo-division selector) is closed: the division is an ordinal
into the same 79-entry list the AM4 uses, confirmed on an FM9 (ordinal 12 shows
"1/8 Dot", issue #23). 0.9.0 ships that list on every gen-3 device, and from
0.9.1 the agent sets `tempo` by name.

### CAPTURE-3: Receive one preset with Fractal-Bot
**Tier: CAPTURE | ~5 minutes | sniffer plus Fractal-Bot | unlocks: frame-count confirmation**

Preset receive is confirmed on the FM9. The III shares the envelope but differs
in frame count, so one receive capture confirms the count is right for this
device.

1. Start the capture with the III connected.
2. In Fractal-Bot choose **Receive** and grab a single preset from the device.
3. Stop right after it finishes. Send the capture plus device model and
   firmware.

## Submitting

See [../SUBMITTING.md](../SUBMITTING.md). For this device, always include:

- III firmware version,
- operating system,
- the loaded preset, number and name,
- Axe-Edit III version,
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
closes a row on [fm3.md](fm3.md), [fm9.md](fm9.md) or [vp4.md](vp4.md) too.
