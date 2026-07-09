---
name: vendor-envelope-descriptor-table
class: struct-layout
status: matched
discovered: -115 (II); synthesis pass 2026-05-22 (III byte-identical shape found in already-existing Ghidra dump); AM4 axis added 2026-05-22 (SeekVendorEnvelopeDescriptorsAM4.java)
verified_on:
  - axe-fx-ii-q8.02
  - axe-fx-ii-q9.04
  - axe-fx-iii-public-captures-v1.4
  - am4-edit-binary
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-vendor-envelope-descriptor-table
relates_to: [param-descriptor-16byte, alphabetical-name-cascade-block-ordering, msb-first-14bit-preset-payload, block-record-stride-8, xor-fold-hash, xor-7f-envelope-checksum, iii-multiproduct-editor-binary]
consumed_in:
  - packages/fractal-gen2/src/presetDump.ts (II preset push, descriptor tables at 0xe04440 + 0xdff900)
  - packages/fractal-gen3/src/presetDump.ts (III preset push, descriptor table 0x1407ab940 + factory-bank structural fixtures N=384)
  - mcp-midi-control/scripts/_research/parse-ghidra-decompile.ts (III table extractor)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-misc-descriptors.descriptors.json (24 III tables, cross-linked to caller functions)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-dump-descriptors.descriptors.json (2 III tables: 0x1407ab440 + 0x1407aba40)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_140337060 walks 0x1407ab2f0 with 12-byte stride + sentinel; L51-83)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (FUN_14033c6e0 walks three descriptor tables 0x1407ab490 / 0x1407ab590 / 0x1407abb00 with the same stride-12 + sentinel=-1 pattern, model-byte-dispatched: II XL/XL+ uses 0x590, other II uses 0x490, III/FM3/FM9 uses 0xb00; L23138-23339)
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-envelope-descriptors.txt (54 AM4 envelope descriptor tables; SeekVendorEnvelopeDescriptorsAM4.java output; address range 0x1405dc190..0x1405dd160 in AM4-Edit.exe .rdata; six byte_count values 3072/1280/768/192/160/31 match III table shapes byte-identically)
  - fractal-midi/scripts/ghidra/SeekVendorEnvelopeDescriptorsAM4.java (AM4 sibling of the II / III mining scripts; structural scan for stride-12 + sentinel=-1 records)
---

# Vendor envelope descriptor table

The universal Fractal mechanism for per-fn payload shape declaration.
Every multi-byte envelope (preset push, get-all-params, block-copy,
store-preset, etc.) has a corresponding descriptor table in the editor
binary's `.rdata` that names the wire fields of that envelope.

## Formal definition

A descriptor table is a contiguous array of records, each record being a
triple `(tag, mid, byte_count)`, terminated by a sentinel record
`(-1, -1, -1)`. The fields:

- **tag**: the per-record key (0, 1, 2, ...). The order of tags within
  the table defines the order of fields in the wire envelope after `F0`.
- **mid**: the wire-byte offset of this field from `F0`. The first
  field after the `F0 00 01 74 <model>` envelope prefix is typically at
  offset 6 (immediately after fn byte at 5).
- **byte_count**: the size of the field, OR the units count when the
  field is a packed-data block (e.g. `byte_count = 3072` for II preset
  body = 1024 ushorts × 3 bytes-per-ushort septet packing).

The interpretation of `byte_count` is context-dependent: for primitives
in the bit-level class (septet, MSB-first) it's the raw byte count; for
packed-data fields it's `units × bytes_per_unit` where the unit shape
comes from a sibling primitive (e.g. septet-21bit-byte2-mask-preservation
for II preset body's 3-byte-per-ushort packing).

## Where it's used

- II chunk descriptor table at `0xe04440` declares the preset-body
  envelope: `(tag=0, mid=6, byte_count=2)` + `(tag=1, mid=8, byte_count=3072)`.
- II footer descriptor table at `0xdff900` declares the footer envelope:
  `(tag=0, mid=6, byte_count=3)`.
- III descriptor tables at `0x1407ab440` + `0x1407aba40`: byte-identical
  shape to II. `(0, 6, 2) + (1, 8, 768)` and `(0, 6, 2) + (1, 8, 192)`
  respectively (256-ushort and 64-ushort payloads).
- III also carries 24 additional descriptor tables at
  `0x1407aac70..0x1407abb60`, one per host-emittable fn-byte family.
  All 24 extracted 2026-05-22 via `parse-ghidra-decompile.ts`; cross-
  linked to their caller functions via the misc-descriptors caller-refs
  section. Headline finding: **table `0x1407ab940` has shape
  `(tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=3072)`,
  1024 ushorts × 3 bytes/ushort septet, byte-identical to the II
  preset push payload**. This is the III analog of the II preset
  binary at the envelope-spec layer.
- AM4 carries 54 descriptor tables at `0x1405dc190..0x1405dd160` in
  AM4-Edit.exe `.rdata` (image base `0x140000000`), structurally
  byte-identical to the II / III tables: stride-12 records
  `(int32 tag, int32 mid, int32 byte_count)` with `(-1, -1, -1)`
  sentinel termination, first record always `(tag=0, mid=6, ...)`
  (mid=6 = position immediately after AM4's 6-byte envelope prefix
  `F0 00 01 74 15 [fn]`). Six byte_count values (3072, 1280, 768,
  192, 160, 31) recur byte-identically vs III misc-descriptors,
  strong evidence the same envelope shapes recur across products.
  No caller-ref binding yet (the seeker emits descriptor tables only);
  binding the 54 tables to AM4 fn-bytes is the highest-leverage
  follow-up. Source: `ghidra-am4edit-envelope-descriptors.txt`.

Other notable III tables (per JSON output):
- `0x1407ab0a0`: 1280 bytes = 427 ushorts (large packed payload)
- `0x1407ab910`: 160 bytes = 53 ushorts
- `0x1407aba40`: 192 bytes = 64 ushorts
- `0x1407ab440`: 768 bytes = 256 ushorts
- `0x1407ab8b0`: 31 bytes (uncommon shape, likely a header/metadata block)
- 19 more smaller tables (1-3 byte payloads, likely per-fn-byte command shapes)

**Model-byte-dispatched descriptor selection (fn=0x19 file snapshot / export):**
The III editor's `FUN_14033c6e0` builder selects one of three
descriptor tables at runtime based on the current device's model byte
(per [[iii-multiproduct-editor-binary]]). All three are extracted in
the misc-descriptors JSON; the dispatch rule is in
`fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`
L23138-23339:

| Model bytes              | Descriptor table |
|--------------------------|------------------|
| `6, 7, 8` (II XL/XL+)    | `0x1407ab590`    |
| `< 0x10` (other II)      | `0x1407ab490`    |
| `>= 0x10` (III/FM3/FM9)  | `0x1407abb00`    |

This is the first verified instance of "same fn-byte, three different
descriptor tables by model-byte" in the III editor binary. The
dispatch mechanism is generic; other fn-byte builders likely use it
too.

Evidence files (gitignored, see `captured-artifacts.md`):
- `fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-dump-descriptors.txt` lines 7-23
- `fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-misc-descriptors.txt` lines 50-79+
- `fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt` lines 23138-23339 (model-byte dispatch + stride-12 + sentinel=-1 walker)

## Applicability

This is the FIRST primitive to apply when decoding a new Fractal fn-byte.
If the device family has an editor binary, the per-fn envelope shape is
declared in `.rdata` as one of these tables. Mining the descriptor table
from Ghidra is faster + more accurate than diffing wire captures.

Cost: ~30 minutes Ghidra run to dump descriptor tables for a new binary;
zero hardware. Returns: full per-fn envelope spec for every host-emittable
fn-byte in the binary.

## Misapplication failure modes

- Does NOT replace `vendor-envelope-prefix` (`F0 00 01 74 <model> [fn]`);
  descriptor tables describe what comes AFTER the prefix.
- Does NOT directly encode the inbound (device → host) envelope shape;
  for inbound, the inbound dispatcher table is the analog (separate
  primitive, currently in `_scratch/` for III).
- The `byte_count` field can mean "raw bytes" OR "units × bytes-per-unit"
  depending on the field; always disambiguate via the matching bit-level
  primitive.

## Where it does NOT apply

- Hydrasynth (different vendor protocol entirely; envelope shape unknown).

## Verification path

`scripts/cookbook-verify.ts#case-vendor-envelope-descriptor-table` runs
two fixtures:
1. II preset push envelope (`0x77/0x78/0x79`), input: descriptor table
   at `0xe04440`; expected: matches captured `samples/captured/session-51-export-preset.pcapng`.
2. III preset push envelope (`0x77/0x78/0x79`), input: descriptor table
   at `0x1407ab440`; expected: matches forum-captured III preset push.

When III preset round-trip is hardware-verified by a III-owning
contributor, a third fixture (hardware capture) gets added.

## Refinement history

- 2026-05-22: II descriptor tables decoded via
  hardware probes; envelope spec mechanism named but not yet generalized.
- 2026-05-22 (synthesis pass, agent a6bb4e41dd41d3c09): III byte-identical
  descriptor tables found pre-mined in `ghidra-axe-edit-iii-dump-descriptors.txt`
  (no hardware needed). Primitive generalized to II + III, status →
  `matched`. The III equivalent of the 5-session hardware probe is
  closed by a 100-line TS parser; tracked as the v1.5 dump-extraction
  tier's headline target.
- 2026-05-22 (parser shipped): `parse-ghidra-decompile.ts` written
  (~280 lines incl. comments + format-A/B handling + caller-ref
  cross-linking). Run against both III dump files → 26 III descriptor
  tables extracted, 34 caller refs cross-linked, JSON written. Verified
  finding: III table `0x1407ab940` matches II preset binary payload
  shape exactly (1024 ushorts × 3 bytes/ushort).
- ~~AM4 transfer candidate filed in `STATE-AM4.md`.~~ Closed 2026-05-22:
  `SeekVendorEnvelopeDescriptorsAM4.java` direct-pattern-scan recovered
  54 byte-identically-shaped descriptor tables from AM4-Edit.exe at
  `0x1405dc190..0x1405dd160`. Six byte_count values (3072, 1280, 768,
  192, 160, 31) match III table shapes byte-identically. AM4 is now
  the third device axis on this primitive (alongside II + III).
  Mining report: `synthesis-log/mine-ghidra-am4edit-envelope-descriptors-2026-05-22-1820.md`.
- 2026-05-22 (III preset-push module shipped, agent a77b2de911a789ec3):
  `packages/fractal-gen3/src/presetDump.ts` + `scripts/verify-preset-dump-iii.ts`
  ship the III consumer. Per-preset wire shape: **1 x 0x77 (13B, 5-byte
  payload) + 16 x 0x78 (3082B, 3074-byte payload) + 1 x 0x79 (11B,
  3-byte payload) = 49,336B**, byte-identical-shape to AM4's chunk
  envelope but with 16 chunks instead of 4. Round-trip golden passes
  byte-identical on all 384 factory presets (3 banks x 128 each) at
  `samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/`. Header
  payload is `[bank, preset, 0x00, 0x00, 0x01]`, monotonically encoding
  bank A=0/B=1/C=2 and preset 0..127. NO live III preset-push capture
  is committed, so the round-trip is structurally verified (N=384
  factory fixtures) but NOT hardware-verified as the same bytes the
  device emits over USB; II convention chunk-0-offset-8-stride-3
  preset-name decode does NOT produce ASCII on III (different inner
  layout). Bumped from N=1-equivalent to N=384 structural fixtures
  along the per-preset axis, so `status: matched` remains supported
  for the envelope-shape claim.
