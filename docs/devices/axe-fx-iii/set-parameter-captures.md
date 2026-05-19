# Axe-Fx III SET_PARAMETER — public-capture corpus

**Purpose.** This file archives byte-exact public captures of AxeEdit III
writing parameters to a real Axe-Fx III. They are the evidence base for
the Session 97 (2026-05-18) pivot away from the (incorrectly ported)
fn=0x02 II-style envelope and toward the byte-verified fn=0x01 +
sub-action envelope.

All frames are 23 bytes, model byte `0x10` (Axe-Fx III), function byte
`0x01`. Checksums validate against the standard Fractal XOR algorithm
(`F0` through last payload byte, XOR-7bit). Field layout decoded below
matches both capture sources and the project's own pre-existing decode
in [`axefx3-fn01-decode.md`](axefx3-fn01-decode.md).

## Captures

### Source A — FC-12 footswitch sending Drive 1/2 boost ON/OFF

Originally archived in [`fn01-decode.md`](fn01-decode.md) from a Fractal
Forum scrape (Session 79 era). Sub-action `52 00` (mouse-drag form;
the FC-12 emits this shape for binary toggles). Effect IDs 58/59
= `ID_DISTORT1` / `ID_DISTORT2` per v1.4 Appendix 1.

| Label            | Bytes |
|------------------|-------|
| Drive 1 Boost ON  | `F0 00 01 74 10 01 52 00 3A 00 28 00 00 00 00 7C 03 00 00 00 00 2B F7` |
| Drive 1 Boost OFF | `F0 00 01 74 10 01 52 00 3A 00 28 00 00 00 00 00 00 00 00 00 00 54 F7` |
| Drive 2 Boost ON  | `F0 00 01 74 10 01 52 00 3B 00 28 00 00 00 00 7C 03 00 00 00 00 2A F7` |
| Drive 2 Boost OFF | `F0 00 01 74 10 01 52 00 3B 00 28 00 00 00 00 00 00 00 00 00 00 55 F7` |

Decoded: `effectId = 58 or 59`, `paramId = 40`, `value = 508` (boost on)
or `0` (boost off).

### Source B — AxeEdit III writing Delay 1 TIME

Mountain Utilities forum, user "gabbernutter", 2019-03-13. Mark van den
Berg's site at `mountainutilities.eu/forums/axe-fx-iii` hosts the
original post. Two sub-actions captured: `09 00` (typed input, clean
envelope) and `52 00` (mouse-drag, intermediate values mid-drag).
Effect ID 70 = `ID_DELAY1`.

**Sub-action `09 00` (typed-input):**

| Label                   | Bytes |
|-------------------------|-------|
| Delay 1 TIME typed v520 | `F0 00 01 74 10 01 09 00 46 00 02 00 00 00 00 08 04 00 00 00 00 55 F7` |
| Delay 1 TIME typed v516 | `F0 00 01 74 10 01 09 00 46 00 02 00 00 00 00 04 04 00 00 00 00 59 F7` |

**Sub-action `52 00` (mouse-drag):**

| Label                  | Bytes |
|------------------------|-------|
| Delay 1 TIME drag v502 | `F0 00 01 74 10 01 52 00 46 00 02 00 74 7C 4D 76 03 00 00 00 00 32 F7` |
| Delay 1 TIME drag v502 | `F0 00 01 74 10 01 52 00 46 00 02 00 67 35 6A 76 03 00 00 00 00 4F F7` |
| Delay 1 TIME drag v503 | `F0 00 01 74 10 01 52 00 46 00 02 00 49 27 23 77 03 00 00 00 00 3B F7` |
| Delay 1 TIME drag v503 | `F0 00 01 74 10 01 52 00 46 00 02 00 11 0B 35 77 03 00 00 00 00 59 F7` |

The 3 bytes at pos 12-14 differ across the drag captures (cursor
position / drag context — not part of the value); the value field at
pos 15-16 is stable across same-value frames.

Decoded: `effectId = 70`, `paramId = 2`, `value ∈ {502, 503, 516, 520}`
(slow drag of TIME from ~500 wire-units up to ~520).

## Unified field layout

| Offset | Bytes | Field | Notes |
|---|---|---|---|
| 0–5 | `F0 00 01 74 10 01` | SysEx envelope + function 0x01 | Fixed |
| 6–7 | `09 00` / `52 00` / `04 01` | Sub-action | `09`=typed SET, `52`=mouse-drag SET, `04 01`=STATE_BROADCAST |
| 8–9 | varies | Effect ID (LS-first septet pair, 14-bit) | Decodes via v1.4 Appendix 1 |
| 10–11 | varies | Parameter ID (LS-first septet pair, 14-bit) | Per-block paramId |
| 12–14 | `00 00 00` (typed) / drag delta (drag) | Drag context | Always zero for sub-action `09 00`; cursor/delta for `52 00` |
| 15–17 | `[v0 v1 v2]` | Value (packValue16: 3-septet pack, top 2 bits at v2) | All observed III params use 14-bit values (v2 is zero); 16-bit slot exists per II convention |
| 18–20 | `00 00 00` | Reserved | Zero in every observed frame |
| 21 | varies | XOR-7bit checksum | Re-derivable |
| 22 | `F7` | SysEx end | Fixed |

## Why the project's old fn=0x02 envelope was wrong

Sessions 85+86 ported the Axe-Fx II's fn=0x02 SET_PARAMETER envelope to
the III by swapping model byte `0x03`→`0x10` and shipping the result
🟡 untested. Zero captures support fn=0x02 on the III; every captured
III parameter-write uses fn=0x01 with a sub-action discriminator. The
port was a reasonable hypothesis at the time (Ghidra mining showed
opcode 0x02 in the III binary's caller list), but the corroborating
evidence converged on fn=0x01.

The Session 82 Ghidra finding that "opcode 0x02 appears in the III
binary" remains consistent with the pivot: fn=0x02 may still exist for
some other purpose in firmware, but it is NOT the parameter-write
opcode users invoke through AxeEdit III.

## Provenance

- **Source A.** Original archive: `docs/_private/fractal-forum-text.txt`
  (gitignored), referenced from [`fn01-decode.md`](fn01-decode.md). Forum
  thread + post URL not retained in the local archive; provenance is
  the Session 79 decode commit.
- **Source B.** Web research (Session 97, 2026-05-18). Mountain
  Utilities forum, `mountainutilities.eu/forums/axe-fx-iii`, user
  "gabbernutter" / replier Mark van den Berg. Captured via the
  `general-purpose` research agent; bytes transcribed into this file
  manually and verified via `node` decode against the Fractal XOR
  checksum + field layout.

## What this corpus does NOT contain

- **Device-emitted GET responses.** All 10 frames are outbound
  (host→device). The III's response shape to fn=0x01 is undocumented;
  STATE_BROADCAST `04 01` is the closest observed inbound shape but
  it appears unsolicited rather than as a sync SET echo.
- **Captures of paramId 255 (bypass) via fn=0x01.** The II convention
  binds paramId 255 to bypass; whether the III does is unverified.
  Prefer the v1.4 PDF's 0x0A SET_BYPASS opcode for production bypass.
- **Frames at values > 16383.** All observed value fields fit in 14
  bits (pos 17 always zero). The 16-bit slot from `packValue16` is
  carried forward for compatibility but unexercised on the III.
