---
name: ii-fn07-modifier-read
class: envelope-shape
status: matched-singleton
verified_on:
  - axe-fx-ii-ares-2.00
golden: scripts/primitives-verify.ts#case-ii-fn07-modifier-read
relates_to: [septet-14bit, ii-axeedit-opcode-table]
---

# Axe-Fx II fn 0x07 modifier read (field-indexed)

The modifier system (assigning LFO / ADSR / envelope / sequencer / scene /
external sources to a block parameter) is read over **fn 0x07**, NOT via an
fn 0x18 reply. fn 0x18 GET_MODIFIER_INFO is request-only (hardware-confirmed:
with a target set via fn 0x37 and a modifier assigned, the device acks fn 0x37
with 0x64 but emits no fn 0x18 reply). AxeEdit reads each modifier field with
fn 0x07 and the device answers with an fn 0x07 frame that carries the wire
value AND the device-rendered display label (7-bit ASCII).

Hardware-captured 2026-05-29 (Ares 2.00, XL+): Amp 1 (effectId 106) Input
Drive (paramId 1) with a modifier assigned, source toggled across several
values. Capture: `samples/captured/probe-axefx2-modifier-path.jsonl`. Decoder:
`scripts/_research/decode-axefx2-fn07-modifier.ts`.

## Reply frame

```
F0 00 01 74 07 07 [effId_lo effId_hi] [slot_lo slot_hi] [field_lo field_hi]
   [v0 v1 v2] [ASCII label ...] 00 [cs] F7
```

- effId  : 14-bit septet pair. Target block (106 = Amp 1).
- slot   : 14-bit septet pair. Modifier slot on the block (observed 1).
- field  : 14-bit septet pair. Field index 0x00..0x0e (table below).
- value  : 16-bit, 3-septet `packValue16` (`v0 | v1<<7 | (v2&3)<<14`), the same
           wire encoding as fn 0x02 param values.
- label  : NUL-terminated 7-bit ASCII, the device's rendered display string
           (ground truth; matches the AxeEdit Edit Modifier dialog readouts).

## Field map (field index -> meaning)

| field | meaning | example label |
|---|---|---|
| 0x00 | source (MOD_CTRLID); value = source index, label = source name | "LFO 1A" |
| 0x01 | Min (target-param units) | "0.00" |
| 0x02 | Max (target-param units) | "10.00" |
| 0x03 | Start (%) | "0.0 %" |
| 0x04 | Mid (%) | "50.0 %" |
| 0x05 | End (%) | "100.0 %" |
| 0x06 | Slope (%) | "50.0 %" |
| 0x07 | Damping (ms) | "10 ms" |
| 0x08 | target effectId (no label) | 106 = Amp 1 |
| 0x09 | target paramId (no label) | 1 = input_drive |
| 0x0a | bool toggle | "OFF" |
| 0x0b | bool toggle | "OFF" |
| 0x0c | percent field | "5.0 %" |
| 0x0d | Scale | "1.000" |
| 0x0e | Offset (%) | "0.0 %" |

Fields 0x00 (source), 0x01/0x02 (min/max), 0x08/0x09 (target effectId/paramId)
are **matched**: field 0x08 decoded to 106 and 0x09 to 1, exactly the assigned
Amp-1 Input-Drive target. The front-row envelope fields 0x03..0x07 are strongly
identified by their label units and dialog order. The back-half labels for
0x0a..0x0e (auto-engage / PC-reset / off-value vs scale/offset) are proposed;
the exact dialog-name binding for those five needs one capture of a modifier
with distinct non-default values in each (the toggle sweep reset the envelope to
defaults).

## Modifier-source enum (partial)

From field 0x00 across source toggles: 0 = NONE, 1 = LFO 1A, 4 = LFO 2B,
5 = ADSR 1, 26 = SCENE 1, 27 = SCENE 2. The intervening indices (LFO 1B / 2A,
ADSR 2, envelope, sequencer, pedal, external, MIDI CC...) follow the same single
contiguous index space; a full enumeration is a fn 0x07 field-0x00 sweep or an
fn 0x28 GET_PARAM_STRINGS on MOD_CTRLID.

## Where it does NOT apply

- fn 0x18 GET_MODIFIER_INFO does not carry the reply; it is request-only.
- AM4 has no modifier system; this is II-specific (III is not yet checked).

## Refinement history

- 2026-05-29: decoded from a live XL+ capture (Ares 2.00). fn 0x07 field-indexed
  read; frame structure + value packing + 15-field record + partial source enum.
  Target effectId/paramId fields byte-verified against the known Amp-1
  Input-Drive assignment. Back-half field labels (0x0a..0x0e) proposed pending a
  non-default-value capture.
