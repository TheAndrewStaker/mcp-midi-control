# Captures: Axe-Fx III / FM3 / FM9 (gen-3)

The III, FM3, and FM9 share one codec, so one capture from any of the three usually closes the gap for all of them. Device-specific data (a device's own model rosters and ranges) is noted where it applies to one device only.

**This page is only for CAPTURES: recording real wire bytes we cannot get any other way.** Three things that get mistaken for captures live elsewhere on purpose, so they don't bury the real asks:

- **Write confirmation** (does a value our server sends actually move on the front panel?) is a **key-press TEST**, not a capture. No recording tool. It lives on the testing pages: [FM9](testing-fm9.md) (the `fm9-verify` probe) / [III](testing-axe-fx-iii.md) / [FM3](testing-fm3.md). It is valuable, but anyone can do it in two minutes, so it does not need a capture-willing owner.
- **The device's full parameter dictionary** (every range, default, step, and enum name list) is recoverable **offline** from the editor's cache file (see C2). Try that before any wire sweep.
- **Everything the device will say about itself over USB** (firmware identity, preset and scene names, placed blocks, per-block reads, label tables) is covered by the one-command, read-only **harvest script**: see [harvest-script.md](harvest-script.md). No capture tooling. The ask order is: cache file first, harvest second, and a wire capture only for the few shapes neither covers (C1/C3 below).

**Already confirmed on real FM9 hardware (no capture needed):**
- Read path (fn=0x1F poll → 0x74/0x75/0x76 burst). Shared codec, so this also covers III and FM3.
- Preset receive (fn=0x03 → 0x77/0x78/0x79 dump).
- Grid routing (fn=0x01 sub=0x35), from FM9-Edit and FM3-Edit loopMIDI captures.
- Block placement (fn=0x01 sub=0x32 `set_block`) + scene switch (fn=0x0C `switch_scene`), confirmed on the FM9 by the 2026-06-19 Windows verify probe (a placed block appeared in the device's own fn=0x13 status dump).
- Reading a block's CURRENT type/model NAME (fn=0x01 sub=0x1F → device name string), byte-exact on FM9 (reverb "Small Room", amp "59 Bassguy Bright", drive "Rat Distortion") and FM3 ("Rat Distortion").

**Already built and evidence-backed (the remaining gap is a key-press, not a capture):** the SET wire (float32 at payload position 12; discrete type/model selects use sub `09 00`, continuous knobs use sub `52 00`) is byte-exact against real FM3 and FM9 captures, set-by-name rides straight off the read rosters, and `.syx` authoring is self-validating against the device's own CRC. Confirming these is a front-panel test on the testing pages above, not a capture.

One-time capture tool setup: [SETUP.md](SETUP.md). Windows ([usbpcap-wireshark.md](usbpcap-wireshark.md)) and Mac ([midi-monitor-mac.md](midi-monitor-mac.md)).

> **Mac (MIDI Monitor): raise "Remember up to N events" in the main toolbar before capturing.** The default 1000 lets the editor's read-poll flood flush your edits out of the buffer (the #1 cause of an unusable capture), and there is no record / stop button: uncheck the source to freeze, then File > Save As. A good capture is several MB, not KB. See [midi-monitor-mac.md](midi-monitor-mac.md).

---

## C1 -- Non-linear knob SET capture *(one narrow question left, the path to first-class)*
**~10 min | [SETUP.md](SETUP.md) required | any III / FM3 / FM9**

This ask used to be a full calibration sweep; the editor cache file has since closed most of it. Device-true ranges, steps, and tapers (which knobs are linear, which are log) are now data we decode from the cache, and stored-preset values are proven to map linearly within each knob's range. **One question remains, and only a capture answers it:** a continuous-knob SET sends `float32(normalized 0..1)`, and for a knob with a log taper (a Reverb or Delay **Time**, a Low/High **Cut**) we do not yet know whether that float is normalized in *value* space or in *knob-position* space. The two readings differ by a lot mid-range. Until one capture settles it, "set delay time to 500 ms" may land somewhere else on the panel for log-taper knobs (linear knobs like amp Gain are already confirmed).

**What we need is the pairing of wire value to panel reading at several points on ONE log-taper knob (a Time or a Low/High Cut):**

1. Start the capture. Open the editor, pick a Reverb **Time** (or Delay **Time**) knob.
2. Drag it to a LOW value, pause, and **write down the exact value the display shows, with its units** (e.g. "0.30 s").
3. Drag to a MID value, pause, note the displayed number.
4. Drag to a HIGH value, pause, note the displayed number.
5. Keep going to **at least 5 points across the full range** (more is better). Stop the capture.
6. Send the `.pcapng` **plus the list of panel readings** (which number you saw at each drag), in order.

> **The display readings are the whole point.** The wire floats alone cannot reveal the curve; without the paired display numbers the capture cannot be used. This is the single most common reason a calibration capture comes back unusable.
>
> **Editor or front panel?** For a knob you are actively dragging, the editor and the hardware front panel show the same number, so reading it off the editor screen is fine. They only drift apart for a *stale* value (e.g. right after a preset load), which is not the case here. If you ever do see them disagree, the hardware front panel is the truth. Just tell us which one you read, and include the units exactly as shown.
>
> A second knob in a different unit (a frequency / Hz knob) in the same recording roughly doubles the value for one extra minute.

Reload the preset afterward to revert. Nothing is stored.

---

## C1b -- Tempo-division SET capture *(the most-requested missing feature)*
**~3 min | [SETUP.md](SETUP.md) required | any III / FM3 / FM9**

Named tempo divisions ("1/4", "1/8 dot") are the one popular request the server cannot send
on gen-3 today: the wire encoding for the TEMPO division select is undecoded, so dotted-eighth
delay prompts -- the single most common tone ask in this hobby -- fall back to "set it on the
device". The editor obviously CAN set it, so the bytes exist; one short capture reveals them.

1. Load a preset with a **Delay** block. Start the capture.
2. In the editor, open the Delay's **TEMPO** control and select, in order, with ~2 s pauses,
   **noting each selection**: `OFF` → `1/4` → `1/8 dot` → `1/2` → back to the original value.
3. Stop. Send the `.pcapng` (or `.mmon`) plus the ordered list of what you selected.

A Reverb or modulation block's TEMPO control in the same recording is a free bonus (confirms
the encoding is block-independent).

---

## C2 -- Editor cache file (full device dictionary)
**~2 min offline, no device needed during the send | the device's editor installed, synced to the device at least once | FM3 / Axe-Fx III / VP4 wanted (FM9 is DONE)**

**FM9 status: complete.** A community FM9 cache set delivered the full 331-name amp roster (shipped, set-by-name works for the whole amp space) plus the drive and reverb rosters.

The ask is now for **FM3, Axe-Fx III, and VP4 owners**, and it is bigger than amp names: the cache file format is fully decoded, so one file yields the device's complete parameter dictionary (every block's parameter ranges, defaults, steps, AND every enum's name list). One file closes dozens of would-be capture asks for that device.

**What to send (offline, no capture tool):** the editor's `effectDefinitions_<modelbyte>_<fw>.cache` file. The leading number is the device's model byte in hex: **10 = Axe-Fx III, 11 = FM3, 12 = FM9, 14 = VP4** (e.g. `effectDefinitions_11_28p0.cache` for an FM3 on firmware 28). The editor keeps one file per firmware version it has run; **send the newest**, or the whole set. Locations: Mac `~/Library/Application Support/Fractal Audio/<Editor>/`, Windows `%APPDATA%\Fractal Audio\<Editor>\`. Ignore the other files there (`color-assignments*`, `*.settings`).

**One requirement:** the editor must have actually connected to your device at least once (that sync is what fills the file). A never-connected install writes a placeholder stub with no names and filler ranges; if your file is one of those, connect the editor to the device once and let it finish syncing, then grab the file again. **Ask for the cache file before asking anyone to sweep dropdowns or capture wire traffic.**

> **Why this is the top III/FM3/VP4 ask right now (concrete payoff):** the III/FM3/VP4
> cache copies currently on hand are unsynced placeholder stubs — the III's has 1,737
> records but **zero** enum-vocabulary entries; the FM3 and VP4 copies are 3–33-record
> stubs. A **device-synced** cache carries the per-param enum kind + counts + name
> lists, and that single file is what let the FM9 correct **~351 parameters** from
> wrong-wire to right-wire (type selectors now send as discrete ordinals instead of
> continuous floats). The III and FM3 have since received the same correction from
> *indirect* evidence (the III from its 2026-06-18 hardware roundtrip as oracle; the
> FM3 from sibling family-join data, 2026-07-02) — a synced cache is the device's OWN
> dictionary, so it mechanically confirms (or corrects) those overlays, adds every
> enum's name list, and pins device-true display ranges/steps/tapers. For the VP4 it
> is still the primary unlock. All offline, no capture tools.

**Wire-sweep fallback (only if the cache is unavailable):** the wire records the ordinal, a screenshot records the name.

1. Load a preset with an Amp block placed. Open FM9-Edit.
2. **Before capturing:** open the Amp block's **Model** dropdown and screenshot the full list. Scroll slowly until every name is captured. Multiple screenshots are fine.
3. Start the capture.
4. With it running, **select** each model **top to bottom**, ~2 s pause between, in the same order you photographed.
5. Stop. Send the `.pcapng` **plus all screenshots** together.
6. While the capture tool is still running, repeat for the **Drive / Fuzz** block's Model dropdown (much shorter list). If the FM9 drive ordinals line up with the AM4 drive list, the names are already known and the screenshots are optional for Drive; just the wire capture is enough.

> Just *opening* a dropdown sends nothing. Names only cross the wire when you *select* a model. Step through them one by one. Partial (top 30 to 40) still helps. The two reasons a prior amp sweep was unusable: the tester opened the dropdown instead of selecting each model, or omitted the screenshots so the ordinals had no names to bind to.

Reload the preset afterward. Nothing is stored.

---

## C3 -- Receive preset from III or FM3 *(frame-count confirmation)*
**~5 min | [SETUP.md](SETUP.md) required | [Fractal-Bot](https://www.fractalaudio.com/fractal-bot/) required | III or FM3 only**

FM9 preset receive is confirmed. The III and FM3 share the same envelope but differ in frame count; one receive capture from an III or FM3 confirms the frame count is correct for that device.

- Start the capture. III or FM3 connected.
- In Fractal-Bot, choose **Receive** and grab a single preset from the device.
- Stop right after it finishes. Send the `.pcapng` plus device model and firmware.

---

## Device testing guides

For no-tools verification and the diagnostic probes (no capture needed), see the device-specific testing pages:
[III](testing-axe-fx-iii.md) | [FM3](testing-fm3.md) | [FM9](testing-fm9.md)

---

## Sending captures

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) with `.pcapng` and screenshots attached. Include: device model, firmware, loaded preset, editor version, one-line note of what you did. See [SETUP.md, "Where to send"](SETUP.md#where-to-send).

**Spec reference:** [Axe-Fx III MIDI for Third-Party Devices v1.4](https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf)
