<!-- Provenance: harvested from branch `hydrasynth-explorer` (commit 3d63075 "hydrasynth updates", last touched by 742b763). Source path: docs/devices/hydrasynth-explorer/MIDI-MAP.md. Inline paths updated to current monorepo layout (`src/devices/hydrasynth-explorer/...` → `packages/hydrasynth/src/...`); content otherwise preserved. -->

# Hydrasynth Explorer — MIDI map

Human-readable companion to the auto-generated 1175-NRPN catalog in
`packages/hydrasynth/src/nrpn.ts` and 117-CC table embedded
in the tool descriptions. Use this file to look up a parameter by
module / number when reading captures or writing new tools; the
code-side catalog is fed by `references/nrpn.csv` and stays in sync
via `npm run hydra:gen-nrpn`.

Page references in this file are to the official Owner's Manual
v2.2.0 located at
`docs/manuals/Hydrasynth_Explorer_Owners_Manual_2.2.0.pdf`
(text-extracted alongside as `…_2.2.0.txt`).

Status legend:
- 🟢 **confirmed** — verified against captured bytes from the device.
- 🟡 **structural** — derived from the manual but not yet hardware-
  verified.
- 🔴 **unknown / blocked** — needs capture, document, or community
  decode work.

---

## 1. Channel basics

- **Default MIDI receive channel:** 1 (configurable, MIDI page 1).
- **Class-compliant USB MIDI** (Type B port). No driver install on
  Windows / macOS / Linux. Appears as "Hydrasynth Explorer" or
  similar in the OS MIDI device list.
- **5-pin MIDI In/Out** also present. USB and 5-pin are separate
  endpoints; both can be active simultaneously.

---

## 2. System CCs (always on)

🟢 These CCs work regardless of the **Param TX/RX** setting on
MIDI page 10 — the manual explicitly lists them as exempt (p. 82).
They are the safest first-smoke targets.

| CC | Parameter | Notes |
|---|---|---|
| 0 | Bank Select MSB | Fixed at 0 for all 8 patch banks A–H. |
| 1 | Modulation Wheel | Standard MIDI mod wheel. RX togglable on MIDI page 8. |
| 7 | Master Volume | Audible immediately, no patch wiring needed. **Recommended first-smoke target.** |
| 11 | Expression Pedal | Routed to whatever the patch's mod matrix has wired. |
| 32 | Bank Select LSB | 0–7 selects bank A–H. Combined with PC 0–127 to choose any of 1024 patch slots. |
| 64 | Sustain Pedal | RX togglable on MIDI page 9. |
| 123 | All Notes Off | Standard MIDI panic. |

---

## 3. Engine CCs (Param TX/RX = CC)

🟡 The full synthesis engine is exposed on CCs per the chart in the
manual (pp. 94–96), but **only when the device is configured with
Param TX/RX = CC** on MIDI page 10. With NRPN selected instead, the
same parameters move to 14-bit NRPNs and these CCs are inert for
engine control.

> Status note: every entry below is 🟡 — it comes from the manual
> but has not yet been verified against captured bytes from the
> founder's device.

### 3.1 Full chart, sorted by CC number

The canonical ordering (since CC # is the unique key on the wire).
Decimal values; pad to two-digit hex when constructing wire bytes
(e.g., CC 74 → `0x4A`).

| CC | Module | Parameter |
|---|---|---|
| 0  | System    | Bank Select MSB |
| 1  | System    | Modulation Wheel |
| 3  | Mixer     | Noise Vol |
| 5  | Voice     | GlidTime |
| 7  | System    | Master Volume |
| 8  | Mixer     | Noise Pan |
| 9  | Mixer     | Ring Mod Vol |
| 10 | Mixer     | Ring Mod Pan |
| 11 | System    | Expression Pedal |
| 12 | Pre-FX    | PRE-FX Param 1 |
| 13 | Pre-FX    | PRE-FX Param 2 |
| 14 | Delay     | Delay Feedback |
| 15 | Delay     | Delay Time |
| 16 | Macros    | Macro 1 |
| 17 | Macros    | Macro 2 |
| 18 | Macros    | Macro 3 |
| 19 | Macros    | Macro 4 |
| 20 | Macros    | Macro 5 |
| 21 | Macros    | Macro 6 |
| 22 | Macros    | Macro 7 |
| 23 | Macros    | Macro 8 |
| 24 | OSC 1     | OSC1 WaveScan |
| 25 | ENV 4     | ENV4 Attack |
| 26 | OSC 2     | OSC2 WaveScan |
| 27 | ENV 4     | ENV4 Decay |
| 28 | LFO 2     | LFO2 Gain |
| 29 | Mutator 1 | Mutator1 Ratio |
| 30 | Mutator 1 | Mutator1 Depth |
| 31 | Mutator 1 | Mutator1 Dry/Wet |
| 32 | System    | Bank Select LSB |
| 33 | Mutator 2 | Mutator2 Ratio |
| 34 | Mutator 2 | Mutator2 Depth |
| 35 | Mutator 2 | Mutator2 Dry/Wet |
| 36 | Mutator 3 | Mutator3 Ratio |
| 37 | Mutator 3 | Mutator3 Depth |
| 39 | Mutator 3 | Mutator3 Dry/Wet |
| 40 | Mutator 4 | Mutator4 Ratio |
| 41 | Mutator 4 | Mutator4 Depth |
| 42 | Mutator 4 | Mutator4 Dry/Wet |
| 43 | Mixer     | RM12 Depth |
| 44 | Mixer     | OSC1 Vol |
| 45 | Mixer     | OSC1 Pan |
| 46 | Mixer     | OSC2 Vol |
| 47 | Mixer     | OSC2 Pan |
| 48 | Mixer     | OSC3 Vol |
| 49 | Mixer     | OSC3 Pan |
| 50 | Filter 1  | Filter 1 Drive |
| 51 | Filter 1  | Filter 1 Keytrack |
| 52 | Filter 1  | Filter 1 LFO1amt |
| 53 | Filter 1  | Filter 1 Vel Env |
| 54 | Filter 1  | Filter 1 ENV1amt |
| 55 | Filter 2  | Filter 2 Cutoff |
| 56 | Filter 2  | Filter 2 Res |
| 57 | Filter 2  | Filter 2 Type |
| 58 | Filter 2  | Filter 2 Keytrack |
| 59 | Filter 2  | Filter 2 LFO1amt |
| 60 | Filter 2  | Filter 2 Vel Env |
| 61 | Filter 2  | Filter 2 ENV1amt |
| 62 | Amp       | Amp LFO2amt |
| 63 | Delay     | Delay Wet Tone |
| 64 | System    | Sustain Pedal |
| 65 | Reverb    | Reverb Time |
| 66 | Voice     | Glide |
| 67 | Reverb    | Reverb Tone |
| 68 | Post-FX   | POST-FX Param 1 |
| 69 | Post-FX   | POST-FX Param 2 |
| 70 | LFO 1     | LFO1 Gain |
| 71 | Filter 1  | Filter 1 Res |
| 72 | LFO 1     | LFO1 Rate |
| 73 | LFO 2     | LFO2 Rate |
| 74 | Filter 1  | Filter 1 Cutoff |
| 75 | LFO 3     | LFO3 Gain |
| 76 | LFO 3     | LFO3 Rate |
| 77 | LFO 4     | LFO4 Gain |
| 78 | LFO 4     | LFO4 Rate |
| 79 | LFO 5     | LFO5 Gain |
| 80 | LFO 5     | LFO5 Rate |
| 81 | ENV 1     | ENV1 Attack |
| 82 | ENV 1     | ENV1 Decay |
| 83 | ENV 1     | ENV1 Sustain |
| 84 | ENV 1     | ENV1 Release |
| 85 | ENV 2     | ENV2 Attack |
| 86 | ENV 2     | ENV2 Decay |
| 87 | ENV 2     | ENV2 Sustain |
| 88 | ENV 2     | ENV2 Release |
| 89 | ENV 3     | ENV3 Attack |
| 90 | ENV 3     | ENV3 Decay |
| 91 | Reverb    | Reverb Dry/Wet |
| 92 | Delay     | Delay Dry/Wet |
| 93 | Pre-FX    | PRE-FX Mix |
| 94 | Post-FX   | POST-FX Mix |
| 95 | Voice     | Detune |
| 96 | ENV 3     | ENV3 Sustain |
| 97 | ENV 3     | ENV3 Release |
| 102 | ENV 5    | ENV5 Attack |
| 103 | ENV 5    | ENV5 Decay |
| 104 | ENV 5    | ENV5 Sustain |
| 105 | ENV 5    | ENV5 Release |
| 106 | ARP      | ARP Division |
| 107 | ARP      | ARP Gate |
| 108 | ARP      | ARP Mode |
| 109 | ARP      | ARP Ratchet |
| 110 | ARP      | ARP Chance |
| 111 | OSC 1    | OSC1 Cent |
| 112 | OSC 2    | OSC2 Cent |
| 113 | OSC 3    | OSC3 Cent |
| 114 | Mixer    | OSC3 FRate |
| 115 | Mixer    | Noise FRate |
| 116 | Mixer    | RM12 FRate |
| 117 | Voice    | StWidth |
| 118 | Mixer    | OSC1 FRate |
| 119 | Mixer    | OSC2 FRate |
| 120 | ARP      | ARP Octave |
| 122 | ARP      | ARP Length |
| 123 | System   | All Notes Off |
| 124 | ENV 4    | ENV4 Release |
| 125 | ENV 4    | ENV4 Sustain |

**Gaps** (no CC assignment in the chart): 2, 4, 6, 38, 98–101, 121,
126, 127. These are intentionally unassigned by ASM (or reserved
for standard MIDI uses we already cover via System CCs).

### 3.2 Macros (CCs 16–23)

🟢 Macros sit on a contiguous block of CCs and are the
highest-value CC targets after the System block: each patch
defines what its 8 Macros do, so "raise Macro 1" is a meaningful
patch-dependent gesture. They're verified across both sort
orders in the chart.

### 3.3 Naming inconsistencies in the source chart

A few entries are spelled slightly differently between the two
sort orders in the manual. Treat the by-CC version as canonical:

| CC | by-Module spelling | by-CC spelling | Use |
|---|---|---|---|
| 24 | "OSC1 wavscan" | "OSC1 wavscan" | "OSC1 WaveScan" (matches engine UI) |
| 26 | "OSC2 WavScan" | "OSC2 WavScan" | "OSC2 WaveScan" |
| 55 | "Filter 2 Cutoff" | "Flt2 Cutoff" | "Filter 2 Cutoff" |
| 56 | "Filter 2 Res" | "Flt2 Res" | "Filter 2 Res" |
| 57 | "Filter 2 Type" | "Flt2 Type" | "Filter 2 Type" |
| 50–54, 58–61, 71, 74 | "Filter 1 …" / "Filter 2 …" | "Filter1 …" / "Filter2 …" | space-separated form |
| 111 | "OSC 1 Cent" | "OSC1 Cent" | "OSC1 Cent" |
| 1 | "Modulation wheel." (trailing period) | (same) | "Modulation Wheel" |

These are presentation differences in the manual, not different
parameters. The catalog generator uses one canonical spelling per
parameter — matching the device's on-screen UI where possible.

---

## 4. NRPNs (Param TX/RX = NRPN)

🟢 1175 NRPN parameters are now decoded and live in
`packages/hydrasynth/src/nrpn.ts`. The map is generated
from `docs/devices/hydrasynth-explorer/references/nrpn.csv`
(vendored from eclab/edisyn, Apache-2.0); regenerate via
`npm run hydra:gen-nrpn`. The manual itself does not publish the
NRPN mapping (p. 83 only states that NRPN mode "addresses the same
parameters as CC mode at higher resolution") — the catalog comes
entirely from the edisyn RE work.

Notes on the NRPN map (see `nrpn.ts` JSDoc for full coverage):

- **Multi-slot families** (osc1/2/3, mutator1..4, mod1..32, etc.)
  share an NRPN address per family and disambiguate via the
  **data-MSB byte** carrying a slot index. Auto-detected at
  generation time from shared-NRPN-address sibling entries.
- **CC↔NRPN aliases.** 117 of the 1175 entries are reachable via
  the manual's CC chart as well; those entries carry a `cc:` field
  and the CC-style id (e.g. `mixer.osc1_vol`) is registered as an
  alias for the NRPN-style id (e.g. `mixerosc1vol`).
- **14-bit auto-scale.** For unipolar 14-bit params (`wireMax > 127`,
  not multi-slot, not enum), inputs in `0..128` are scaled to the
  full wire range via `wire = round(input × wireMax / 128)`. So
  `value=55` → `wire=3520` → display `55.0` exact. Trade-off:
  `value=127` lands at display `127.0`, not the max; pass `128` (or
  any value ≥ 128) to reach `wireMax`. See `encoding.ts`
  `resolveNrpnValue` for the full resolution priority (enum-name →
  enum-index → explicit bipolar/unipolar range → 14-bit auto-scale →
  pass-through).

NRPN access from outside the schema is via raw bytes through the
generic `send_nrpn` BK-030 primitive — usable, but requires the
caller to already know the MSB/LSB pair.

---

## 5. Program Change + Bank Select

🟢 Documented on MIDI page 11 (p. 83):

```
Patch Bank   CC# 0 (MSB)   CC# 32 (LSB)   PC
A            0             0              0–127
B            0             1              0–127
C            0             2              0–127
D            0             3              0–127
E            0             4              0–127
F            0             5              0–127
G            0             6              0–127
H            0             7              0–127
```

To switch banks, **all three** messages are required, in this
order: Bank Select MSB (CC 0), Bank Select LSB (CC 32), Program
Change. Without a bank change, PC alone selects within the
current bank.

`Pgm Chg TX` (send PC on patch select) and `Pgm Chg RX` (act on
incoming PC) are independent toggles on MIDI page 11.

---

## 6. SysEx

🟢 Envelope + base64 + CRC-32 wrapping decoded and implemented in
`packages/hydrasynth/src/sysexEnvelope.ts`. The encoding
comes from `references/SysexEncoding.txt` (edisyn). Two known
triggers from the device:

- **MIDI page 10 → "Send Patch"** action button — emits the current
  patch as SysEx out USB / 5-pin MIDI.
- **MIDI page 10 → "Send All Patches"** — emits all 8 banks.

These are *outbound* from the device. Inbound SysEx (load patch)
exists too and is implemented as the `hydra_apply_patch` tool flow:
it sends the patch bytes wrapped in the documented envelope. See
`patchEncoder.ts` for the byte-map.

For the ASM-Manager-specific `.hydra` / `.patch` file format (different
from the SysEx-encoded patch), see `HYDRA-FILE-FORMAT.md` in this
folder.

---

## 7. Aftertouch & per-channel data

- Channel and Polyphonic aftertouch supported (MIDI page 8). Set
  via "Aftertouch transmit" knob (Off / Mono / Poly).
- The Explorer keybed itself does not have polyphonic aftertouch
  hardware, but it **forwards** poly aftertouch from another
  Hydrasynth model when connected.

---

## Open follow-ups

- **Hardware verification of the CC chart.** A spot-check of 5–10
  parameters across different modules — fire the documented CC,
  confirm the on-device parameter moves. Cheap, builds confidence,
  catches any chart errata.
- **Hardware verification of the NRPN catalog beyond the params
  covered by ICONIC-TONES test runs.** The 1175-entry catalog is
  derived from edisyn RE; the subset exercised by the
  iconic-tones portfolio is the only part hardware-verified by us
  to date.
