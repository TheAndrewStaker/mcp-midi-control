---
name: fn28-enum-dump
class: label-extraction
status: matched-singleton
discovered: 
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
firmware_sensitive: true
golden: STUB (structural-only; de-facto coverage: scripts/_research/probe-axefx2-enum-dump.ts diff loop vs the local capture)
relates_to: [trim-tolerant-display-match, editor-cache-section-record-grammar]
consumed_in:
  - scripts/extract-axe-fx-ii-params.ts (ENUM_VALUE_OVERRIDES generator)
  - scripts/_research/probe-axefx2-enum-dump.ts
---

# fn 0x28 device-emitted enum dump (II)

Axe-Fx II fn 0x28 returns the device's authoritative enum-value labels
for a given enum-type parameter. Hardware truth over wiki — 
surfaced 4 wiki transcription errors (CORNCOB → CORNFED, etc.) via this
mechanism.

## Formal definition

Request: standard II SysEx envelope with fn = `0x28`, payload =
`[septetLow(enumTypeId), septetHigh(enumTypeId)]`.

Response: enum labels as null-padded ASCII strings concatenated in the
response payload. Per-label length is fixed by the firmware (varies by
enum type); trailing whitespace padding requires
[[trim-tolerant-display-match]] for comparison.

## Where it's used

The Rosetta-quality label authority for II enum tables. Every II enum
table in `params.ts` is validated against this dump. `ENUM_VALUE_OVERRIDES`
generator (`scripts/extract-axe-fx-ii-params.ts`) ingests the dump and
overrides wiki values when they disagree.

## Applicability

When adding a new II enum-type parameter, run the fn 0x28 probe FIRST
and use the dump as the value source, not the wiki. Wiki transcription
errors are demonstrated to occur (CORNCOB → CORNFED is the canonical
example, but 4 others surfaced in the same  sweep).

## Misapplication failure modes

- **DO NOT** use this for III or AM4 — only the II implementation has
  been verified. The III + AM4 analogs are transfer candidates (filed
  per the cross-device protocol).
- **DO NOT** compare device-emitted labels byte-exact to wiki strings.
  Device pads trailing whitespace; use [[trim-tolerant-display-match]].

## Where it does NOT apply

- Axe-Fx III — transfer candidate. `iii-inbound-dispatcher.txt` (524KB)
  likely contains the III analog.
- AM4 — transfer candidate.

## Verification path

No inline fixture ships (golden is STUB — the capture is local-only).
The de-facto check is `scripts/_research/probe-axefx2-enum-dump.ts`'s
diff loop against `samples/captured/probe-axefx2-enum-dump.syx`. Asserts:
- 145 enum tables dumped without truncation (the original fixture has one
  truncation case at amp.effect_type, an artifact of node-midi's 2048-byte
  WinMM fragmentation, since fixed; see Refinement history)
- 1112 labels recovered total
- Trim-tolerant comparison against catalog: 0 mismatches

## Refinement history

- : fn 0x28 wire shape decoded, probe script shipped. 145
  enum tables dumped, 1112 labels recovered (1/145 truncated at
  amp.effect_type — 2048-byte node-midi cap, documented limitation).
  4 wiki transcription errors surfaced (CORNCOB → CORNFED on
  amp.tone_stack 108-109, plus 3 others).
- : catalog-missing enum expansion via `isNew: true`
  ENUM_VALUE_OVERRIDES flag. 54 new entries appended at wireIndexes
  the wiki MIDI_SysEx page never documented (amp.tone_stack 108-109,
  drive.effect_type 36, pitch.mode 0-4, delay.tempo 33-78). Re-running
  the fn 0x28 sweep against  catalog dropped mismatch count
  64 → 9; the remaining 9 were trailing-whitespace device padding,
  closed via [[trim-tolerant-display-match]] (mismatch count 9 → 0).
- 2026-06-09: the truncation was never a device limit. node-midi's WinMM
  backend fragments any inbound SysEx longer than 2048 bytes into
  multiple `message` events and the old receive path dropped the
  continuations; the II transport and the probe now reassemble fragments
  via the shared `createSysExAssembler`. The post-fix re-run captured
  the full amp table in ONE untruncated frame: 266 labels (ordinals
  0..265), 266/266 display-equal vs the shipped catalog, 0 mismatches.
  The 7 names the old capture lost (ordinals 259..265) were
  independently confirmed by the Axe-Edit cache roster
  ([[editor-cache-section-record-grammar]]). The II amp roster is
  complete and hardware-confirmed.
