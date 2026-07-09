# Captures: VP4

> The VP4's parameter SET, bypass, and save frames are decoded from a community capture (fw 4.03) and ship community-beta; block placement and scene switching stay gated until their wire shapes are captured. The whole-preset STRUCTURE READ (name / scene names / current scene / 4-slot chain) is now decoded and shipping. The captures below close the gated write shapes plus display calibration. The VP4 reuses the gen-3 effects codec, so confirmed writes also validate assumptions shared with the III/FM3/FM9.

## Status (updated 2026-07-01)

Two community captures (Kevin Iudicello, VP4 fw 4.03) are decoded; see
[`docs/devices/vp4/SYSEX-MAP.md`](../devices/vp4/SYSEX-MAP.md):

- **#1 (2026-06-08, read poll):** confirmed the `fn=0x01` parameter READ path, the gen-3
  envelope/checksum, the block effect-ID table, and the device-true paramId catalog on
  hardware.
- **#2 (2026-06-09, edit session, buffer raised):** **decoded the WRITE path.** 69 write
  frames map 1:1 to an annotated action sequence. Now known: the 21-byte `fn=0x01` SET frame
  (`tc` sub-opcode at pos 9), the value codec (5-septet LE float32 with last two septets
  swapped, normalized [0,1] for continuous params), and the **SAVE**, **param SET**
  (continuous+discrete), and **bypass** frames. So C1 (param SET) and most of the write
  surface are **captured**.
- **2026-07-01 (mining pass over both captures): the eid206 pid0 `0x1f` STRUCTURE BLOB is
  field-decoded**: preset name, all four scene names, the CURRENT scene index, and the
  serial 4-slot chain (effectIds, empty slots included), oracle-matched against the
  annotated move cascade and scene switch in both presets. `get_preset` on the VP4 now
  reads the whole structure in one round-trip (community-beta, untested on hardware).
  This also overturned two earlier negatives (the preset name and the slot order WERE in
  the capture all along, wrong unpack scheme). See the SYSEX-MAP "STRUCTURE blob" section.

**Still open:** block-placement value→slot math (`set_block` stays gated; the blob's
chain table is now the diff oracle, see the surgical C1 below), the scene WRITE value
mapping (the read side is solved), display calibration, and a discrete type-select
example. VP4-Edit reads via `fn=0x01` GET and writes via `fn=0x01` `tc`-coded SET (no
`fn=0x1F`, no `09/52` sub-action); see the family-wide read-path note in the
decode-status doc.

---

## P0: fn=0x0C scene-query probe (zero cost, read-only, no capture tooling)

Highest value-per-minute ask, needs only the MCP server (or any SysEx send tool), no
Wireshark/MIDI Monitor. The gen-3 family documents a read-only scene QUERY:

```
F0 00 01 74 14 0C 7F cs F7      (cs = XOR(F0..7F) & 0x7F = 0x12)
```

Send it to the VP4 and report whether anything comes back (paste the reply bytes).
It has **no write side-effect** (the `7F` sentinel is the documented query form). If the
VP4 answers it, and then accepts the fn=0x0C SET form, `switch_scene` ships WITHOUT
needing the `pid13` value decode at all. One frame, possibly a whole capability.

**Before any capture, two no-tooling asks come first:** (1) the VP4-Edit
**cache file** (`effectDefinitions_14_*.cache`) -- its format is fully decoded, and one
device-synced file yields the VP4's complete parameter dictionary (ranges, defaults,
steps, every enum's name list), which closes the display-calibration half of C0 offline.
See [captures-gen3.md C2](captures-gen3.md) for what to send and where the file lives.
(2) The one-command read-only [harvest script](harvest-script.md), which sweeps every
read surface the VP4 answers. The captures below stay valuable for the write-direction
shapes neither can reach (block placement, scene mapping).

One-time capture tool setup: [SETUP.md](SETUP.md) -- Windows (USBPcap + Wireshark) and
Mac ([MIDI Monitor](midi-monitor-mac.md); the FW4.03 capture used this and worked well --
save as a `.mmon` session file).

---

## ⚠️ Read this first -- why the FW4.03 capture didn't unlock writes

The FW4.03 capture contained **only 16-byte read polls** and **zero write frames** -- but
**not** because the edits weren't made during recording. Diagnosis: the file held exactly
**1000 messages spanning only 2.58 s**, with **no connection handshake** (it starts
mid-poll). VP4-Edit polls the active preset at **~390 messages/second**, and MIDI Monitor
keeps only its most recent N messages -- so the constant read-poll **flushed the earlier
edit writes out of the buffer** before the file was saved. The writes were captured, then
discarded by the message cap.

So the #1 fix is to stop the poll flood from evicting the writes:

1. **Raise MIDI Monitor's message limit.** Its window/preferences cap how many messages it
   remembers (the FW4.03 file hit a 1000-message cap). Set it to the maximum / a very large
   number so nothing is discarded. **This is the key fix.**
2. **Or quit / disconnect VP4-Edit right after the edit, then save.** That stops the
   ~390 msg/s poll so your edit stays near the tail and isn't evicted. (Equivalently: do
   the single edit and **save within a second or two**.)
3. **Start recording BEFORE you touch anything**, then make the edit while it records.
4. **One action at a time**, ~3 s pause between actions (so the diff is unambiguous).
5. **Confirm a "To VP4" message LONGER than 16 bytes is present** near your edit -- 16-byte
   To-VP4 messages are just reads; a *write* is a longer SysEx going **to** the VP4. If the
   only To-VP4 messages are 16-byte, the write was evicted -- raise the limit and redo.

Always note the **front-panel** value before and after each action (the editor can show
stale state).

---

## C0 -- One comprehensive coverage session (DO THIS ONE; ~15 min)
**[SETUP.md](SETUP.md) required | buffer already raised from last time**

The 2026-06-09 capture already decoded the write FRAME, the value codec, SAVE, and bypass.
What remains: **display calibration** (which wire value = which front-panel number), **block
placement**, **scene mapping**, and **discrete type selects**. This single session closes all
of them so we don't have to keep asking. Keep recording the whole time; do each step slowly
with a ~3 s pause; **note the value you set in VP4-Edit at each step** (this is the part we
can't get any other way). You do NOT need to read the pedal's screen: since you're setting
each value yourself, the number shown in the editor is exactly what we need (the device
echoes it back, so editor and device agree for values you just set).

Start recording, then:

1. **Calibration sweeps, the highest value.** For a knob with a number on the panel, set it
   to a few *exact* values and note each:
   - Delay **Mix**: set to **0%**, then **50%**, then **100%** (pause between; note panel %).
   - Delay **Feedback**: set to **0%**, then **+50%**, then **−50%** (note panel %).
   - Delay **Time**: set to **100 ms**, then **500 ms**, then **1000 ms** (note panel ms).
   These multi-point sets let us derive the value→display curve (linear AND non-linear) for
   each knob type, the thing blocking real `%`/`ms` units.
2. **Discrete type select:** change the **Reverb (or Delay) TYPE** dropdown to a specific
   named model, note the name. (Captures a discrete value SET we have zero examples of.)
3. **Block placement, do TWO distinct moves:** move one block from slot **2 → 4**; pause;
   then move a different block from slot **1 → 3**. Note exact from/to each. (Two moves let us
   diff the routing and crack the slot encoding.)
4. **Scene mapping:** switch scene **1 → 2 → 3 → 4**, one at a time, pausing between, noting
   each. (Pins which wire value = which scene.)
5. **Bypass on a second block:** bypass then re-enable a *different* block than reverb.
   (Confirms the bypass value isn't block-specific.)
6. **Save once** at the very end.

Then stop and send the file with your noted front-panel readings. That single capture should
unlock display units + placement + scenes + type selects in one go.

---

## C1 -- Block moves + delete/re-add, minimal pairs (SURGICAL, updated 2026-07-01)
**~10 min | [SETUP.md](SETUP.md) required**

The placement REGISTERS are now identified (`eid206 pid10` = delete, `pid15`/`pid16` =
move pair) and the chain STATE is fully readable (the pid0 `0x1f` structure blob), so
what remains is exactly the **value math** of the write frames. That takes MINIMAL
PAIRS: single isolated gestures whose from/to is known, so each write value maps to one
(from, to) pair. Keep VP4-Edit's poll running (it re-reads the blob after each gesture,
that's our before/after oracle for free), pause ~3 s between actions, and note each
action + its order:

1. **Moves (the key data):** one block at a time, note from/to each:
   - move a block slot **1 → 2** (adjacent, up-chain);
   - move it back **2 → 1** (the reverse pair);
   - move a block slot **1 → 4** (long move);
   - move a block **into an EMPTY slot** (no cascade) and then **onto an occupied
     slot** (with cascade). The cascade vs no-cascade pair separates the gesture value
     from the resulting layout.
2. **Delete + re-add:** delete one block (note which slot), pause, then re-add the SAME
   block type into a chosen slot. (Pins `pid10`'s value math and captures the ADD frame,
   which no capture holds yet.)
3. **Scene pairs, exhaustive:** switch scenes covering every from→to direction you have
   patience for, at minimum `1→2, 2→3, 3→4, 4→1, 1→3, 2→4`, noting each pair. (The
   single captured `pid13` value `0x01` for a 1→3 switch is not enough to solve the
   mapping; exhaustive pairs are.)
4. **Front-panel-vs-editor causality:** do ONE move and ONE scene switch **from the
   pedal's front panel** (not the editor) while recording. This separates what the
   DEVICE emits/accepts from what VP4-Edit merely displays, and shows whether the same
   pid registers carry panel-originated changes.

---

## C2 -- Parameter SET (covered by C0 and the decoded write frame; kept as a fallback)
**~5 min | [SETUP.md](SETUP.md) required**

1. Start recording. Note preset, firmware, VP4-Edit version.
2. Click one block (Delay, Reverb, or Drive) and **drag one knob to a clearly different
   value** (e.g. Mix 20% → 80%). Note the front-panel before/after.
3. Pause ~3 s. Stop.

Re-confirms the VP4 `fn=0x01` SET wire shape (already decoded from the fw 4.03 capture:
the VP4's own 21-byte `tc`-coded frame, no gen-3 `09`/`52` sub-action). The remaining
value of this capture is the noted before/after panel values for calibration.
**Verify a >16-byte To-VP4 message is present** before sending -- that is the write.

---

## C3 -- Scene switch + bypass (unlocks switch_scene + set_bypass)
**~5 min | [SETUP.md](SETUP.md) required**

1. Start recording. Note the starting scene.
2. Switch scene (e.g. Scene 1 → Scene 3) **on the pedal or in the editor**. Pause ~3 s.
3. Bypass one block, then re-enable it. Pause ~3 s between each. Stop.

Note which action happened when. Unlocks the per-scene and bypass write paths.

---

## C4 -- Save / store a preset (unlocks save_preset)
**~3 min | [SETUP.md](SETUP.md) required**

1. Start recording. Make any small edit (so there's something to save).
2. Save/store the preset to its location from VP4-Edit (or the pedal). Stop.

Captures the store envelope so saves can be confirmed rather than gated.

---

## C5 -- Receive preset from device (unlocks backup/export)
**~5 min | [SETUP.md](SETUP.md) required | [Fractal-Bot](https://www.fractalaudio.com/fractal-bot/) required**

- Start recording. VP4 connected.
- In Fractal-Bot, choose **Receive** and grab a single preset from the device. Stop.

---

## One-shot "unlock everything" session (best single capture)

If you can only do one recording: start it, then perform C1→C2→C3→C4 in that order with a
~3 s pause between each action, narrating what you did and when. One file, the whole write
surface. (Still verify it contains >16-byte To-VP4 messages.)

---

## Sending captures

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label:
`community-beta`) with the `.pcapng` (Windows) or `.mmon` (Mac MIDI Monitor) attached.
Include: VP4 firmware, loaded preset, VP4-Edit version, and a one-line note of each action
**with its order/timing**. See [SETUP.md, "Where to send"](SETUP.md#where-to-send).
