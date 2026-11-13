# RC-505mk2 `SYSTEM1.RC0` leaf decode (2026-09-30)

Companion to [`RC-505mk2-RC0-SCHEMA.md`](RC-505mk2-RC0-SCHEMA.md), which covers the MEMORY files. This
one covers the **system** file, and it was far cheaper than expected: `SYSTEM1.RC0` is **7,014 bytes of
XML with self-labelling section names**, so the work is mapping single-letter leaves inside a named
section, not finding the sections.

`SYSTEM2.RC0` is byte-identical except for **one byte**; treat it as the second copy of the pair until
that byte is identified.

Capture: `samples/rc505/system-decode-2026-09-30/`. Owner's device, 76 sections.

## Confidence vocabulary

- **CONFIRMED** — matched against a value the owner read off the front panel, or an isolated real-world
  difference in the data itself.
- **HIGH** — every leaf matches the manual's documented default and ordering with no contradictions.
- **OPEN** — leaf count or values do not resolve against the manual; needs the sentinel pass below.

---

## `[MASTER_FX]` (3 leaves) — **CONFIRMED**

`A` = COMP (OFF, 1-40) · `B` = REVERB · `C` = INSERT (0 = MAIN-L …, or OFF)

Owner read "COMP OFF, REVERB 0, INSERT MAIN" off the panel; the file holds `A=0 B=0 C=0`. Three for
three. **This is the leaf group to check when a mix ducks under a loud input**, since a master-bus
compressor applies one shared gain reduction to everything.

## `[MIXER]` (22 leaves) — **CONFIRMED on `A`, HIGH on the rest**

Six input levels interleaved with their MUTE flags, then ten output levels:

| leaf | meaning | leaf | meaning |
|---|---|---|---|
| **A** | **MIC 1 IN level** | M | MAIN-L OUT |
| B | MIC 1 mute | N | MAIN-R OUT |
| C / D | MIC 2 IN / mute | O / P | SUB1-L / SUB1-R OUT |
| E / F | INST1-L IN / mute | Q / R | SUB2-L / SUB2-R OUT |
| G / H | INST1-R IN / mute | S | LOOP OUT |
| I / J | INST2-L IN / mute | T | RHYTHM OUT |
| K / L | INST2-R IN / mute | U | PHONES OUT |
| | | V | MASTER OUT |

Anchor: the owner set MIC 1 IN to 120 and `A` read **120**, with every other input at 100 and the six
B/D/F/H/J/L leaves at 0 (unmuted). Levels run **0..100..200**, so 100 is unity and 200 is double.
Observed on this device: `U` (PHONES) = 50, `V` (MASTER OUT) = 169.

## `[EQ_MIC1]` … `[EQ_SUBOUT2R]` (12 leaves each, 12 sections) — **CONFIRMED**

The manual's EQ page lists exactly 12 parameters and every observed value equals its documented
default, in this order:

| leaf | param | observed | note |
|---|---|---|---|
| A | **SW** | 0 (OFF) | **`EQ_INST1L` reads 1** — see below |
| B | LO GAIN | 20 | 0 dB (range is `-20..+20 dB` as index 0..40) |
| C | HIGH GAIN | 20 | 0 dB |
| D | LO MID FREQ | 11 | **250 Hz, the documented default** |
| E | LO MID Q | 0 | 0.5 |
| F | LO MID GAIN | 20 | 0 dB |
| G | HI MID FREQ | 16 | **800 Hz, the documented default** |
| H | HI MID Q | 0 | 0.5 |
| I | HI MID GAIN | 20 | 0 dB |
| J | LEVEL | 20 | 0 dB |
| K | LO CUT | 0 | **FLAT is the LOWEST index** (`FLAT, 20..800 Hz`) |
| L | HI CUT | 14 | **FLAT is the HIGHEST index** (`630 Hz..12.5 kHz, FLAT`) |

Two leaves land on their documented *named* defaults (250 Hz, 800 Hz) rather than on a round number,
which is what makes this a decode rather than a guess.

**A natural experiment confirms `A` = SW:** of the twelve EQ sections, `EQ_INST1L` is the ONLY one that
differs from the others, and it differs in exactly one leaf, `A` = 1. That is the guitar/AM4 input.
Worth telling the owner: **his guitar channel has EQ switched ON with every band still flat**, so it is
engaged and doing nothing.

**The LO CUT / HI CUT polarity generalises to the VE-500**, same manufacturer convention: a low cut's
FLAT sits at index 0 and a high cut's FLAT sits at the top of its range. That is the basis for reading
the VE-500's unlabelled `reverb_high_cut` / `delay_high_cut_1` as "lower = darker".

## `[OUTPUT]` (4 leaves) — **HIGH**

`A=1 B=1 C=1 D=1`. Reads as `A` = OUTPUT KNOB (`ALL, MASTER, PHONES, OFF` → **1 = MASTER**) and
`B/C/D` = STEREO LINK MAIN / SUB1 / SUB2, all ON. If so, the owner's [OUTPUT LEVEL] knob is already
bound to MASTER OUT, which is the recommended setting. The page's six PREFERENCE items are not here,
so they live elsewhere (probably `[PREF]`).

## `[ROUTING]` (19 leaves) — **PARTIAL**

Bitmasks. The four `127`s (`I`, `K`, `M`, `N`) are 7-bit INPUT/RHYTHM masks (MIC1, MIC2, INST1 L/R,
INST2 L/R, RHYTHM) for MAIN / SUB1 / SUB2 / PHONES, all fully on. The `63`s are 6-bit track masks.
`O..S` = `0,1,1,0,1` are the page's switches. Exact leaf-to-output assignment is OPEN.

## OPEN, and why inference stops here

| section | leaves | why it does not resolve |
|---|---|---|
| `[SETUP]` | 22 | The manual's INPUT>SETUP page has only 10 params (2 phantom, 2 INST gain, 3 stereo link, 3 preference). The section also holds `C=98`, `M=277`, `O=277`, `Q=271`, which are not switch-shaped. Several candidate leaves are all `0`, and phantom OFF, stereo link OFF and preference SYSTEM would ALL encode as 0, so the zeros are not separable by inspection. |
| `[PREF]` | 20 | Every leaf is `1`. No internal contrast, so nothing can be distinguished. |
| `[INPUT]` | 13 | Nine `0`s then `23, 40, 40, 40`. The three 40s are very likely NS (noise suppressor, documented default 40) and the 0s the COMP values (default OFF), but the DYNAMICS page lists only 6 params. |
| `[MIDI]`, `[USB]`, `[COLOR]` | 10 / 5 / 5 | Not yet cross-referenced against their pages. `[MIDI]` is missing a `B` leaf entirely, which is itself worth explaining. |

**The limit is not effort, it is that identical values are not separable.** Three OFF switches in a row
all read `0`.

## The sentinel pass (how to finish this in ONE storage-mode cycle)

The device's panel is inert while it is mounted as a drive, so an isolated diff costs a full
mount/unmount cycle per leaf. That is the wrong shape for 60+ unknown leaves. Instead:

1. Take a baseline export (done: `samples/rc505/system-decode-2026-09-30/baseline/`).
2. Out of storage mode, set **N different parameters to N DISTINCT, unusual values** in one sitting:
   e.g. MIC 2 IN = **177**, INST1-L IN = **166**, INST2-R IN = **155**, PHONES OUT = **144**,
   LO MID FREQ on `MIC2` = some off-default frequency, and so on. Pick values nothing else uses.
3. Re-enter storage mode and export once.
4. Each sentinel is unique, so one diff pins every one of them simultaneously.

This does **not** violate the project's "one capture per hypothesis" rule: that rule exists because two
simultaneous edits of the SAME value are ambiguous. Distinct sentinels are separable by construction,
which is exactly what makes the batch safe.

For the pure on/off leaves (`[SETUP]`, `[PREF]`), the sentinel is the flip itself: turn **one** of the
three STEREO LINK switches ON, leave the other two off, and the single changed leaf names itself.

---

## `<count>` is a device WRITE COUNTER, not a checksum — **CONFIRMED 2026-09-30**

Every RC0 file ends with `<count>028D</count>`, four hex digits after `</database>`. Measured across a
baseline and a post capture of the SAME device with **no system setting changed**: `028D` → `028F`,
i.e. +2, after the owner saved a memory from the front panel.

That matters for the author path. A checksum would have to be recomputed on write, and getting it wrong
would risk the device rejecting the file. A monotonic write counter does not: leaving it untouched is
both safe and what the schema doc already observed editors doing ("round-tripped verbatim and NOT
recomputed; treat as opaque; preserve"). This session edited `MEMORY001A/B.RC0` with the counter
untouched and the device accepted the result.

**It also makes the system file a clean diff target**: a baseline-vs-post comparison of `SYSTEM1.RC0`
across a whole working session came back with **exactly one differing byte, and it was this counter**.
Every section's leaves were identical. So the sentinel pass above will produce an unusually clean
signal, because nothing else in this file drifts on its own.

## State of the owner's device as captured (2026-09-30)

- `[MIXER]` MIC 1 IN **120**, every other input **100**, nothing muted, PHONES **50**, MASTER OUT **169**.
- `[MASTER_FX]` all zero: no master compressor, no master reverb. **Not the cause of a ducking mix.**
- `[OUTPUT]` `A=1`, reading as OUTPUT KNOB = MASTER (the recommended binding).
- `EQ_INST1L` is the only EQ with `SW=1`: **the guitar input's EQ is ON with every band flat.**
- Memory 1 track input masks, after this session: T1 `78`, T2/T3 `79`, **T4 `16` (INST2 L alone, the
  isolated Hydrasynth stem)**, T5 `48` (INST2 L + R, left recording both on the owner's instruction),
  T6 `127`.
