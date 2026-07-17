---
name: iii-paramid-pseudo-sentinel-ranges
class: struct-layout
status: matched-singleton
discovered: 2026-05-22 (primitives-mine of ghidra-axeedit3-paramtables-v2.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/primitives-verify.ts#case-iii-paramid-pseudo-sentinel-ranges
relates_to: [param-descriptor-16byte, per-effect-paramtable-dispatcher]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axeedit3-paramtables-v2.txt
---

# III paramId pseudo-sentinel ranges

Inside Axe-Edit III per-effect ParamDescriptor tables, paramIds in
`0xFF00..0xFFFE` are non-terminator pseudo-entries (UI separators or
placeholders). Only `0xFFFFFFFF` (-1 as int32) is the true table
terminator.

## Formal definition

When walking a ParamDescriptor table per [[param-descriptor-16byte]],
the stop condition is strictly:

```
paramId == 0xFFFFFFFF    // full 32-bit terminator
```

A paramId in the range `0xFF00..0xFFFE` (low 16 bits between 65280 and
65534) is a VALID in-table entry. It must be read past, not treated as
end-of-table.

## Where it's used

The pseudo-entries appear in two clusters in the III dump:

- **`0xFFF0..0xFFFA` (65520..65530):** block-end markers or inline
  pseudo-knobs. Appear both at table-end and mid-table.
- **`0xFF00..0xFF13` (65280..65299):** a 20-element bank, observed
  only as a tail group on case 0x0b (likely CABINET; 126 params).

Concrete sites (dump line refs):

| Site | Pattern |
|---|---|
| L15 (case 0x1) | `... 902 65520 65521 65522 44 45 46 47 ...`: mid-table pseudo cluster |
| L41 (case 0x2) | `... 173 174 65520 65521 ... 65530`: 11-element tail group |
| L69 (case 0x8) | `... 16 17 18 19 65520`: single trailing pseudo |
| L91 (case 0x0b) | `... 140 141 65520`: single pseudo before the 0xFF00 bank |
| L315 (case 0x26) | `... 45 46 65520`: singleton tail pseudo |
| L357 (case 0x33) | `... 21 65520 65521 65522 65523 65524`: 5-element tail group |
| L389 (case 0x38) | `... 1944 65520 ... 65527 5648 5649 5650 5651`: pseudo cluster between real ID groups |
| L398 (case 0x39) | `... 1331 1332 65520 65521 65522`: 3-element tail group |

Distinct 0xFFFx values observed in the dump: 65520, 65521, 65522,
65523, 65524, 65525, 65526, 65527, 65528, 65529, 65530 (11 distinct
codes across the cluster).

## Applicability

This primitive matters for any code that parses III per-effect tables.
If a mining script or consumer parser treats `paramId & 0xFFFF ==
0xFFFx` as "end of meaningful data" it will TRUNCATE legitimate
entries that follow the cluster. Worse, if a consumer maps
`paramId & 0xFFFF` into a global namespace, pseudo-entries collide
with real paramIds.

Cost: ~5 minutes of awareness when writing a parser; trivial once
known.

## Misapplication failure modes

- **Truncating on 0xFFFx instead of 0xFFFFFFFF.** Caught by reading
  the V2 script's terminator check (paramId == -1 as int32, full
  32-bit comparison).
- **Treating pseudo-entries as real paramIds in wire writes.**
  Writing wire paramId=65520 to the device will at best NACK; at
  worst hit a different register.
- **Conflating with the AM4 paramIds 0..9 reserved convention.** That
  rule is per-device LOW-range; this primitive is per-device HIGH-
  range. Different mechanism, different device, different semantics.

## Where it does NOT apply

- AM4 dump (`ghidra-am4edit-paramtables.txt`) shows no analogous
  `0xFFFx` cluster per the existing AM4 catalog cross-check
  (1,732 pairs after name filtering; presumably any pseudo-entries
  were filtered out at mining time). The AM4 axis is currently
  unconfirmed.
- II not yet tested with a stride-16 walk that preserves 0xFFFx
  entries.

## Verification path

`scripts/primitives-verify.ts#case-iii-paramid-pseudo-sentinel-ranges`:

1. Read `ghidra-axeedit3-paramtables-v2.txt`.
2. Assert ≥3 distinct `0xFFFx` values appear in non-terminator
   positions (i.e. with real paramIds following them in the same
   table OR appearing in the per-table param-list block).
3. Assert the summary line shows `Param-ID range observed: 0 ..
   65530` (the maximum 0xFFFx value seen).

## Refinement history

- 2026-05-22 (mining pass): Discovered during primitives-mine of the
  V2 III paramtables dump. Mining report:
  `synthesis-log/mine-ghidra-axeedit3-paramtables-v2-2026-05-22-1822.md`.
- Path-to-matched: re-mine AM4 with a stride-16 walker that
  preserves raw paramIds (no name-string filtering); if AM4 shows
  the same 0xFFFx cluster, promote to `matched` with both axes.
  The current AM4 catalog count (1,732 pairs vs. SeekParamTables64
  raw 2,105 entries) is consistent with name-string filtering
  rather than absence of pseudo-entries.

## Hypothesis on semantics (not yet confirmed)

The `0xFFF0..0xFFFA` cluster likely encodes UI separators or
category-group markers in the editor's parameter browser. Appearing
at table-end with the real paramIds first, occasionally mid-table, is
consistent with "after this comes a group of pseudo-knobs" or "this
position reserves a UI label not bound to a real wire register."

The 20-entry `0xFF00..0xFF13` block on case 0x0b (likely CABINET, 126
params) suggests cab-bank UI placeholders: cabinet selection options
or factory-IR slot labels. Confirming this needs a peek at the
metadata pointers for those entries; the V2 script dumps the FIRST
metadata pointer per table only, so a per-pseudo-entry dereference is
a follow-up mining task.
