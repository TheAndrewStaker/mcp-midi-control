---
name: iii-block-name-string-cascade
class: struct-layout
status: non-matching
discovered:  (cookbook transfer-candidate audit)
verified_on:
  - axe-edit-iii-1.40
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-iii-block-name-string-cascade
retest_when:
  - regenerated III preset-related Ghidra dumps (case-iii-block-name-string-cascade re-adjudicates the strcmp grep automatically on every cookbook-verify run)
  - a decoded III preset-body block-ORDER primitive (only the strcmp IMPLEMENTATION claim is negative; the alphabetical-ordering claim is an open question per "What this does NOT rule out")
relates_to: [alphabetical-name-cascade-block-ordering, vendor-envelope-descriptor-table]
consumed_in: []
---

# III block-name string-cascade — NO transfer

The Axe-Fx II preset serializer encodes block ordering with an inline
if-else cascade of `strcmp(name, "Amp") / "Cab" / "Chorus" / ...` calls
inside `AEImageDepot::FUN_00595260`. See
[[alphabetical-name-cascade-block-ordering]]. The transfer hypothesis
on file in that entry's "Where it does NOT apply" section is that
`ghidra-axe-edit-iii-preset-receiver.txt` "almost certainly contains
the analog."

It does NOT. Mining the III editor binary surfaces ZERO block-name
string literals in any preset-related Ghidra dump.

## Evidence

Grep for the canonical block-name needles (`Amp`, `Cab`, `Chorus`,
`Compressor`, `Drive`, `Reverb`, `Flanger`, `Phaser`, `Delay`, `Pitch`,
`Vocoder`, `Tremolo`, `Filter`) across every III dump in
`samples/captured/decoded/`:

| Dump                                                  | Size   | Hits |
|-------------------------------------------------------|--------|------|
| ghidra-axe-edit-iii-preset-receiver.txt               | 371 KB | 1*   |
| ghidra-axe-edit-iii-store-preset.txt                  |  81 KB | 3*   |
| ghidra-axe-edit-iii-actions-and-shapes.txt            | 989 KB | 0    |
| ghidra-axe-edit-iii-inbound-dispatcher.txt            | 524 KB | 1*   |
| ghidra-axe-edit-iii-patch-parsers.txt                 | 115 KB | 0    |
| ghidra-axe-edit-iii-dynamic-action-codes-decode.txt   | 291 KB | 0    |
| ghidra-axe-edit-iii-new-fnbytes-decode.txt            | 201 KB | 0    |

*All non-zero hits are unrelated: `"PresetCabBundleImport"` (an import
function name, not a block-type label) plus a few generic `Amp/Drive`
substrings inside other identifiers. None are block-name string-table
references inside a `strcmp`-driven if-else chain.

Compare to II's `ghidra-aeimagedepot-vtable.txt`, where the same
needles match the canonical `FUN_0043b7f0(*puVar3, "Chorus")` /
`"Compressor"` / `"Drive"` / `"Flanger"` / `"QuadChorus"` / `"Reverb"`
calls inside the cascade.

## Why the transfer fails

III preset serialization is **descriptor-table-driven**, not
string-cascade-driven. Table `0x1407ab940` in `.rdata` declares the
preset binary envelope as `(tag=0, mid=6, byte_count=2) + (tag=1,
mid=8, byte_count=3072)` (cookbook entry
[[vendor-envelope-descriptor-table]]). The 1024-ushort body is opaque
at the wire layer; the per-block ordering inside that ushort buffer is
either implicit in a separate index/descriptor table (not yet mined)
or encoded via a different mechanism entirely (e.g., a fixed offset
table indexed by block-id, no string lookup ever).

What this rules out:
- Re-grepping the III dumps for `"Amp"` / `"Cab"` / etc. to recover an
  if-else cascade. The strings are not there. Future agents: don't
  spend a session re-deriving this negative.
- Porting II's cascade table verbatim into a III preset-builder. The
  III's implementation mechanism is genuinely different; even if the
  block ordering on the wire turns out alphabetical (open question),
  the III code path that produces it is not the II cascade.

What this does NOT rule out:
- The III preset binary's per-block ORDER on the wire. Open question —
  needs a III preset-push hardware capture (carried HW follow-up
  per STATE.md). The cascade primitive's ordering CLAIM (alphabetical
  by display name) may or may not transfer; only the IMPLEMENTATION
  CLAIM (inline strcmp cascade) is conclusively negative.
- An indirect block-name reference via vtable / RTTI / mangled symbol
  in a non-preset Ghidra dump. The current mining campaign covers
  preset-related functions; a broader pass (ghidra-axe-edit-iii-rva-array.txt
  or fresh script) could still find a data-driven block-name table.

## How this fits in the cookbook

[[alphabetical-name-cascade-block-ordering]] is `partial-N1` on II
only. This negative entry tightens its "Where it does NOT apply"
section: the III variant is not pending discovery, it is structurally
absent from the editor's serialization code path. The cookbook reader
can stop treating the III as a near-term promotion target for that
primitive.

## Symptoms / grep terms

Search these before re-attempting:

- "III strcmp block name cascade" / "grep III dumps for Amp Cab strings"
- "port AEImageDepot cascade to III" / "III block-name string table"
- "III preset serialization descriptor-table-driven" (what it is instead)

## Refinement history

- 2026-05-22: negative finding committed after
  exhaustive grep of all 7 III preset-related Ghidra dumps. Same-
  session cookbook discipline per CLAUDE.md "negative findings are
  valuable" section.
