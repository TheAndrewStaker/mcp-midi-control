# Axe-Fx II, preset binary native encoding ( breakthrough)

The 12,951-byte `0x77/0x78/0x79` preset-dump wire stream decodes to a
**native ushort stream**, not the flat byte array our prior static
analysis treated it as. This is the missing structural insight that
unblocks the per-scene byte-offset hunt.

## Source

Ghidra against `Axe-Edit.exe` (II generation, 32-bit), project
a local Axe-Edit Ghidra project, scripts in
`fractal-midi/scripts/ghidra/`:

- `FindAxeEditIIPresetParser.java`, locates the dispatcher
- `DumpAxeEditIIPresetDispatchHandlers.java`, decompiles the
  dispatcher + each fn-byte handler + 1 level of callees
- Output: `samples/captured/decoded/ghidra-axe-edit-preset-handlers.txt`

## Wire ↔ native encoding (NEW)

Each frame's payload is a stream of **packed septets** that decode to
native uint values via:

```c
uint FUN_0055d750(buf, offset, count) {
  uint v = 0;
  for (int i = 0; i < count; i++) {
    v |= (buf[offset + i] & 0x7F) << (i * 7);
  }
  return v;  // up to 32-bit; usually used as ushort or uint
}
```

So `count=1` reads 1 wire byte → 7-bit value. `count=2` reads 2 wire
bytes → 14-bit value. `count=3` reads 3 wire bytes → 21-bit value
(fits in uint).

## 0x77 PATCH_START header parser, `FUN_0054d3d0`

```c
undefined4 FUN_0054d3d0(char *frame, undefined2 *out_state) {
  // frame[0]=F0  frame[1..3]=mfr  frame[4]=model  frame[5]=fn=0x77
  // frame[6..9] = payload (4 bytes)
  // frame[10]=cksum  frame[11]=F7

  if (frame[5] == 'w') {   // == 0x77
    // 3 fields decoded via descriptor lookup + septet reader:
    out_state[0] = decode_field(...);   // bank (4-bit?)
    out_state[1] = decode_field(...);   // preset (7-bit?)
    out_state[2] = decode_field(...);   // header-tag (14-bit, the
                                        // observed "0x00 0x20" constant)
  }
}
```

The "constant" `0x00 0x20` we observed at offsets 8-9 of the header
frame is the septet-encoding of a 14-bit value, likely a sequence
or version number. It's invariant across factory presets because all
384 factory dumps were exported at the same firmware version.

## 0x78 PATCH_DATA chunk parser, `FUN_0054d0c0`

```c
undefined4 FUN_0054d0c0(char *frame, ushort *out_state) {
  // frame[5] = fn = 0x78
  // frame[6..199] = payload (194 bytes)

  if (frame[5] == 'x') {   // == 0x78
    ushort N = FUN_0055d750(frame, 6, 1);   // 1 septet → count
    out_state[0] = N;

    // Allocate / resize ushort[N] array
    realloc(out_state[2], N * 2);

    // Read N values, each 3 wire bytes → 1 ushort
    for (int i = 0; i < N; i++) {
      ushort v = FUN_0055d750(frame, 7 + i * 3, 3);  // 21-bit value
      ((ushort*)out_state[2])[i] = v;
    }
    return 1;
  }
}
```

**This is the key.** Each chunk is `1 + N*3` wire bytes where N is up
to ~64 (since 1 + 64*3 = 193 ≤ 194 wire payload bytes).

The native form of one chunk = N × 16-bit values. Stacked across 64
chunks ≈ **4096 ushorts total** = 8192 native bytes.

## Implications for  per-scene offset hunt

### Why the static-analysis hunt failed

The prior  hunt for per-scene state operated on wire bytes:
"find a 8-byte run whose value space is `{0,1}` (channel bits) or
`{0..7}` (scene indices)". It found NONE.

That hunt was looking at the WRONG data shape. The wire bytes are
septets, every 3 consecutive bytes encode a single ushort. A scene-
channel bit lives in (e.g.) the LSB of one ushort, not in a wire
byte. So the wire byte pattern `0x00 0x01 0x00 0x01 0x00 0x01 ...`
(channel bits in 8 scenes) on the wire would look like:

```
wire: 00 00 00  01 00 00  00 00 00  01 00 00  ... (each ushort = 3 bytes)
```

The "stride 3 with mostly zero" pattern visible in the static
analysis is exactly this: the channel bit is the only non-zero byte
in each triplet, separated by 2 zero bytes from the next ushort.

### What to do next

1. **Dump the descriptor tables** `FUN_00552c30` / `FUN_00552c60`
   reference inside the chunk parser. These tell the parser how
   many wire-bytes to read per FIELD inside a chunk. Without them
   we don't know the field layout, for example, the preset name
   is 32 chars × 3 wire bytes per char, but bytes 1 and 2 of each
   name triplet are always zero. Other fields (header constants,
   block state) use full 21-bit septet packing.

2. **Refactor `presetDump.ts`** to expose a per-FIELD decoder
   driven by the descriptor table. Each field has:
   - A byte offset within the chunk payload
   - A septet-count (1, 2, or 3, controls wire-bytes-per-value)
   - A value count (length of the field's value array)

3. **Re-run the value-space hunt on the per-FIELD native stream**
   (in `scripts/_research/diff-axefx2-preset-dump.ts`):
   - Find FIELDS where `value ∈ {0, 1}` consistently across all 384
     factory presets, that's the per-scene channel bit array.
   - Find FIELDS where `value ∈ {0..7}`, that's the scene-index
     array.

4. **Hardware-paired diff stays the same**: flip one knob, dump
   before/after, diff per FIELD to localize the index. Single-knob
   change → single field/index change in the stream.

### Empirical decoding ( verify)

Each chunk payload = `count_septet (1 byte) + N × 3 wire bytes per
ushort`. Native value `v` = `(b0 & 0x7F) | ((b1 & 0x7F) << 7) |
((b2 & 0x7F) << 14)`, then truncated to 16 bits via the editor's
`*(uint16_t *) = uVar2;` cast.

**Chunk 0 of factory preset 0 ("59 Bassguy") decoded:**

```
chunk_payload[0]         = 0x40  → N = 64 native ushorts
ushort[ 0] @ wire 1..3   = 0x40080 → 0x0080  (chunk header field 0)
ushort[ 1] @ wire 4..6   = 0      (chunk header field 1)
ushort[ 2] @ wire 7..9   = 0x1A80 → 0x35 = '5' is at (v >> 7) & 0x7F
ushort[ 3] @ wire 10..12 = 0x1C80 → 0x39 = '9'
ushort[ 4] @ wire 13..15 = 0x1000 → 0x20 = ' '
ushort[ 5] @ wire 16..18 = 0x2100 → 0x42 = 'B'
ushort[ 6] @ wire 19..21 = 0x3080 → 0x61 = 'a'
ushort[ 7] @ wire 22..24 = 0x3980 → 0x73 = 's'
ushort[ 8] @ wire 25..27 = 0x3980 → 0x73 = 's'
ushort[ 9] @ wire 28..30 = 0x3380 → 0x67 = 'g'
ushort[10] @ wire 31..33 = 0x3A80 → 0x75 = 'u'
ushort[11] @ wire 34..36 = 0x3C80 → 0x79 = 'y'
ushort[12..33]           = 0x1000 (= space char in middle septet → padding)
```

**Preset name = `(ushort[2..33] >> 7) & 0x7F` per character.** Confirmed
across 8 sample presets (Bank A 0..7); all decode their known names
exactly.

The existing `extractPresetName` reads byte 0 of each name triplet
(stride 3 in wire bytes) and works because middle-septet ASCII bytes
sit at `payload[8 + i*3]` in wire offsets. The native-stream view
(`(ushort >> 7) & 0x7F`) is equivalent and exposes the rest of the
chunk uniformly.

## Chunk descriptor tables (recovered )

`FUN_0054d0c0` / `FUN_0054d3d0` / `FUN_0054d1d0` each consult a
12-byte stride descriptor table. The tables tell the parser the
**field count per chunk** plus a width tag. Recovered:

| Table addr | Used by | Entries (key, val_b=width-tag, val_c=count) |
|---|---|---|
| `0x718090` | 0x77 PATCH_START (alt) | `(0,6,1)`, `(1,7,1)`, `(2,8,2)` |
| `0x7180c0` | 0x77 PATCH_START | `(0,6,2)`, `(1,8,192)` |
| `0xe033a0` | 0x77 PATCH_START (alt) | `(0,6,1)`, `(1,7,1)`, `(2,8,3)` |
| `0xe04440` | **0x78 PATCH_DATA chunk** | `(0,6,2)`, `(1,8,3072)` |
| `0xdff900` | 0x79 PATCH_END | `(0,6,3)` |

The `0x78` table at `0xe04440` is the key one:

- `key=0`: 6-bit field × 2 values  → chunk-header (2 × ushort)
- `key=1`: 8-bit field × 3072 values  → MAIN payload across chunks

Each chunk emits **exactly 64 ushorts** in factory presets (confirmed
across all 128 Bank A presets, per-chunk count is constant). With 64
chunks × 64 ushorts = **4096 ushorts per preset**, of which the table
declares 3072 as "main data" and the rest are structural.

## Native-stream structure ( analysis)

Across all 128 factory presets of Bank A:

| Region | Indices | Variation |
|---|---|---|
| Chunk 0 header | ushort 0..1 | low-cardinality, looks like routing/version |
| Chunk 0 name | ushort 2..33 | ASCII chars in middle septet, mostly constant per slot |
| Chunk 0 tail | ushort 34..63 | mixed, block enable / first-block params? |
| Chunks 1..16 | ushort 64..1087 | parameter values, wide-cardinality 14- and 16-bit |
| **Chunks 17..20** | **ushort 1088..1343** | **highest density of per-preset variation, likely the per-block per-scene state region** |
| Chunks 21..47 | ushort 1344..3071 | constant or zero, likely modifier slots / cab IR / aux |
| Chunks 48..63 | ushort 3072..4095 | mostly zero, padding tail |

### Boolean-valued native positions (5 across 128 presets)

These are the strongest candidates for **single-bit per-scene state**:

| Chunk | Offset | Native index | Interpretation candidate |
|---|---|---|---|
| 19 | 62 | 1278 | one-bit flag (preset-level toggle) |
| 20 | 32 | 1312 | one-bit flag (block-level toggle) |
| 20 | 36 | 1316 | one-bit flag |
| 20 | 46 | 1326 | one-bit flag |
| 20 | 63 | 1343 | one-bit flag |

Only 5 BOOLs across the static analysis means most per-scene state is
NOT stored as single-bit positions. Instead it's **packed into
multi-bit fields within the 16-bit ushorts**, observable as:

- `BIN(0, 0x100)` / `BIN(0, 0x400)` / etc., 2 distinct values, one
  is zero and the other has a single bit set at position 8 / 10 /
  etc. These are individual bits packed inside multi-purpose ushorts.
- `BIN(0, 3)` at (chunk 20, offset 44): exactly 0 or 3, suggesting a
  2-bit field.
- `ENUM4(0, 1, 3)` and `ENUM4(0, 2, 3)`, 3-valued fields covering
  most of `[0..3]`, plausibly 2-bit channel selectors.

### What we still don't know

The static analysis can rule OUT certain layouts but can't assign
semantics. To localize:

- **scene_index** (0..7): no native position has value space ⊆
  `{0..7}` across all 128 factory presets, meaning either (a) the
  scene index isn't a single ushort, or (b) factory presets never
  populate all 8 scenes so the value space stays small.
- **per-block channel pointer (X/Y)**: the BOOLs above are candidates
  but only 5 exist; with 12 blocks × 8 scenes = 96 channel pointers
  expected, most must be bit-packed.
- **per-block bypass bit**: same packing problem.

The cheapest disambiguation is the existing hardware-paired diff
harness (`scripts/_research/diff-axefx2-paired-dump.ts`): flip one
knob on the device, dump before/after, diff the **native stream**
(not wire bytes). Single mutations should pinpoint single ushort
positions or single bits within ushorts. Once a few mutations land,
the surrounding structure becomes legible.

## Reference parsers / scripts

Implementations in this repo:

- `scripts/_research/decode-axefx2-preset-native.ts`, full bank
  decoder. Reads 128 factory presets, decodes each chunk to its
  64-ushort native array, concatenates to 4096-ushort stream, runs
  per-index value-space analysis.
- `scripts/_research/analyze-axefx2-native-layout.ts`, categorizes
  each (chunk, offset) by value space (BOOL, BIN, ENUM4, etc.).
- `scripts/_research/verify-axefx2-septet-encoding.ts`, sanity
  check: decode preset names from middle septet across 8 sample
  presets.

### What's left for 

The wire-byte → native ushort decode is solved and verified. What
remains is **semantic assignment** for the per-scene state region
(chunks 17..20). Static analysis across the factory bank rules out
some hypotheses (no naive scene-index ushort, no unpacked per-block
bypass byte) but can't assign semantics. The next step is the
hardware-paired diff harness, flip ONE knob on the device, dump
before/after, diff the native stream. Each single-knob mutation
pinpoints a single ushort position or single bit within an ushort.

Estimated effort: 30-60 min hardware per experiment × ~5 experiments
(channel, bypass, scene-switch, routing, preset-rename), plus ~1 hr
desk time per experiment to interpret the diff.

## 0x79 PATCH_END footer parser, `FUN_0054d1d0` (footer hash CRACKED)

Reads 3 wire bytes after the fn byte. Stores at `param_1[0x5c]`.
Compared at the end of dispatch (see FUN_00512f30) against a value
returned by `FUN_00544cc0()`, confirmed **content-hash check**.

### Footer descriptor (table @ `0xdff900`)

`(key=0, val_b=6, val_c=3)`. Single field: wire offset 6 (=
`footerPayload[0]`), 3 septet bytes. Decoded as 21-bit value, only the
**low 16 bits** are used for the hash check (per
`MOVZX EAX, word ptr [EDI + 0x5c]` at the compare site).

### Hash function, `FUN_00544cc0`

```c
ushort FUN_00544cc0(int buf, uint n) {
  ushort acc = 0;
  for (uint i = 0; i < n; i++)
    acc ^= *(ushort *)(buf + i * 2);
  return acc;
}
```

A trivial 16-bit XOR-fold over `n` ushorts at `buf`. Verified against
**390/390 presets** (128 Bank A + 128 Bank B + 128 Bank C + 6 hardware
captures from  mutation experiments).

### Hash call site (raw disasm of FUN_00512f30)

```
00513178  MOV EAX, [EDI+0x20]   ; growing-buffer byte count
0051317b  MOV EDX, [EDI+0x34]   ; expected ushort count (set by 0x77 parser)
0051317e  SHR EAX, 0x1          ; bytes / 2 = actual ushort count
00513180  CMP EAX, EDX
00513182  JNZ <fail-mismatch>
00513184  MOV ECX, [EDI+0x1c]   ; growing-buffer pointer
00513187  CALL FUN_00544cc0     ; XOR-fold(buf=ECX, n=EDX)
0051318c  MOV ECX, EAX
0051318e  MOVZX EAX, [EDI+0x5c] ; expected hash from footer
00513192  CMP ECX, EAX          ; match check
```

So the hash runs over the **growing reassembly buffer** at `EDI+0x1c`
(2 bytes per ushort × count). The buffer accumulates each chunk's
decoded ushorts via `FUN_00620810` (append-to-buffer).

### Chunk descriptor, wire encoding (newer firmware, table @ `0xe04440`)

`(key=0, val_b=6, val_c=2) + (key=1, val_b=8, val_c=3072)`. The
`val_b` field is the **wire offset** from F0, not a width tag:

- key 0: count at wire offset 6, 2 septet bytes → 14-bit value N
- key 1: data at wire offset 8, each ushort = 3 septet bytes

Since the 6-byte envelope prefix `F0 00 01 74 07 78` precedes the
payload, wire offset 6 = `chunkPayload[0]`. So:

| Bytes | Field | Encoding |
|---|---|---|
| `chunkPayload[0..1]` | count N | 14-bit septet |
| `chunkPayload[2..2+3N-1]` | N ushorts | 3 septet bytes per ushort (low 16 of 21-bit) |

Per-chunk N is variable but constant 64 across all 384 factory
presets, giving 4096 native ushorts per preset.

### Atomic apply procedure (verified 2026-05-22)

To modify a preset and push it back to flash:

1. Dump baseline via fn 0x03 `[hi, lo]` MSB-first.
2. Parse the 66 messages.
3. Modify any byte(s) in any chunk payload (each parameter occupies
   3 wire bytes from offset 2 onward, decoding to one native ushort).
4. Compute the new hash:

   ```ts
   let hash = 0;
   for (const chunk of modifiedChunks) {
     const N = (chunk[0] & 0x7f) | ((chunk[1] & 0x7f) << 7);
     for (let i = 0; i < N; i++) {
       const off = 2 + i * 3;
       const u =
         ((chunk[off] & 0x7f) |
           ((chunk[off + 1] & 0x7f) << 7) |
           ((chunk[off + 2] & 0x7f) << 14)) & 0xffff;
       hash ^= u;
     }
   }
   hash &= 0xffff;
   ```

5. Encode the new footer:

   ```ts
   const footer = new Uint8Array([
     hash & 0x7f,                  // bits 0..6
     (hash >> 7) & 0x7f,           // bits 7..13
     (origFooter[2] & 0x7c) | ((hash >> 14) & 0x03),
     // ^ preserve byte-2 high-5 bits (unknown extra metadata);
     //   overwrite low-2 bits with hash bits 14..15
   ]);
   ```

6. Re-serialize with the existing serializer; push 66 messages; call
   save_preset.

Result on hardware: **0 NACKs**, byte-exact round-trip, only the
modified data bytes and the 3 new footer bytes differ between
baseline and re-dump.

Reference impl: `scripts/_research/bk070-modified-push-with-hash.ts`
(in the mcp-midi-control repo). Verifier:
`scripts/_research/verify-footer-xor-hash.ts`.

### Byte-2 reserved bits are ROUTINELY non-zero in real presets (2026-07-09 corpus-wide confirmation)

BK-081/BK-084 (the atomic whole-preset-image read + the continuous-param
read-modify-write patch, `packages/fractal-gen2/src/presetImageRoundTrip.ts`
+ `presetImageContinuousPatch.ts`) needed a per-dump trust gate before
serving/patching a preset via the TLV-decoded image. An early draft of that
gate additionally required every word's byte-2 "reserved" top-5 bits to be
zero (on the theory that non-zero bits signal an untrustworthy dump): a
388-dump sweep (the same corpus as `verify-ii-preset-image-tlv.ts`: 384
Q8.02 factory presets + 4 hw132 live captures) REFUTED this: **386/388
real presets carry non-zero byte-2 bits somewhere in the image** (top
hotspot: word 480 = 1-based chunk 8, ushort offset 32, on 67 bank-A
presets; an earlier revision of this sentence said "word 544", an
off-by-one from 0-based chunk indexing). This is
NOT a corruption signal; it is exactly the existing, documented
behavior in primitive `septet-21bit-byte2-mask-preservation`: those bits
are routine firmware-defined state that a writeback must preserve via
read-modify-write, never assume-zero. The corrected precondition
(`verifyRoundTripIdentity`) checks only structural decode success
(deframe + strict TLV parse) plus a footer-hash-formula match, dropping
the invalid "byte-2 must be zero" requirement entirely. The actual
writeback safety comes from `writeUshortAt`'s per-target
`(origByte2 & 0x7c) | (value >> 14 & 0x03)` mask-preserve, applied only to
the specific words a patch touches, never a wholesale image
reconstruction.

### Drive block Y-channel `effect_type` word confirmed byte-exact (2026-07-10)

A reported raw-number leak (`effect_type: 32767` on a drive block's Y
channel, front panel showing BLACKGLASS 7K) was investigated against a
hardware-confirmed ground-truth capture. The per-channel addressing
formula documented above (`channel-Y param p → word[baseWord +
payloadLen/2 + p]`) holds for the Drive block exactly as it does for
Amp/Cab: for a Drive TLV `[133, 42]` at `tlvWord`, `baseWord = tlvWord +
2`, `xToYOffset = 42/2 = 21`. Channel-Y `effect_type` (paramId 0) is
`word[baseWord + 21 + 0]`, and on the ground-truth capture that word
holds `36`, and `DRIVE_EFFECT_TYPE_VALUES[36] = "BLACKGLASS 7K"`, matching
the front panel. Both the offset math and the roster entry check out;
the leak traced instead to the decode boundary emitting the bare wire
integer on ANY unmapped select ordinal (fixed in
`fractal-gen2/src/calibration.ts`'s `decodeEnumWire`, MCP-server side;
see `docs/_private/STATE-AXEFX2.md` 2026-07-10 for the full account).
No change to this codec's TLV/offset logic was needed; this section
exists so a future "drive Y decodes wrong" report starts from a
confirmed-correct baseline instead of re-deriving the offset formula.

## 2026-07-16 image-ENCODE session: grid, discrete, scenes, splice, 21-bit footer

Everything in this section is corpus-oracled against the on-disk dumps
(384 Q8.02 factory + bk070/hw132 live captures) and shipped as
community-beta / hardware-unverified encode lanes in
`packages/fractal-midi/src/gen2/axe-fx-ii/presetImage/` (Q8.02 / XL+
scoped). Goldens (root `test:codec`):
`verify-ii-image-discrete-encode.ts`, `verify-ii-image-scene-words.ts`,
`verify-ii-image-structural-splice.ts`. The shipped fractal-gen2 read
path is untouched; the substrate-identity golden pins the two
implementations byte-identical corpus-wide.

### The footer hash is a 21-BIT XOR-fold (refines the earlier 16-bit reading)

`footer = [h & 0x7f, h>>7 & 0x7f, h>>14 & 0x7f]` where `h` is the
XOR-fold of the FULL 21-bit words (`lo7 | mid7<<7 | b2<<14`, reserved
bits included). 500/503 on-disk dumps carry exactly this (the 3 misses
are the locally hand-modified push-test artifacts); the bk070 scene
pairs flip the footer's third septet in lockstep with a scene word's
byte-2 change, which a 16-bit fold cannot produce. The old
16-bit-fold + preserve-footer-byte-2 rule is the correct projection
for writes that touch no reserved bits (the continuous RMW lane).
Primitive: `xor-fold-hash` (refined). Encoder: `computeImageHash21`.

### Scene-state words: TLV-relative location + byte-2 bypass mirror

Per placed block: scene ushort at `baseWord + <block>.bypass
housekeeping paramId` (low byte = bypass mask scenes 1..8, high byte =
channel-Y mask; Y bits for scenes 5..8 pattern-extrapolated). NEW
DECODE: the byte-2 reserved bits at a scene word MIRROR the bypass
mask for scenes 1..5 (`b2 & 0x7c == (word & 0x1f) << 2`), 4093/4093
corpus-wide and hardware-paired in both directions; writes must
maintain the mirror. This decodes the Session-115 NACK 0x13 "byte-2
matters on a Delay scene word" lesson. The 32 informative bk070 pairs
replay through the encoder BYTE-identically (mirror + 21-bit footer
included). Eight families are single-channel full-payload (Filter,
Formant, MultibandComp, Resonator, RingMod, Synth, FeedbackReturn,
Output): their bypass pid sits past len/2; no Y half exists. Families
with no registered bypass pid (QuadChorus, FX Loop, FeedbackSend,
ToneMatch, Mixer, Noisegate) refuse by name. Primitive:
`scene-state-ushort` (promoted matched).

### Grid + routing matrix (words 34..129)

48 column-major 2-word cells `(blockId, 4-bit input-connector mask)`
from word 34; shunts 200..235 unique per preset; grid block multiset
== TLV chain multiset (502/502); no output-connection field exists
(implicit tap; factory extends paths to column 12 with shunts).
Supersedes the block-record-stride-8 reading. Primitive:
`ii-grid-routing-cell-matrix` (new).

### Discrete (rostered-select) words are raw ordinals

X-channel: 24k+ corpus observations, zero out-of-roster, zero
sentinels; byte-2 zero on every select word. Oracles: fn 0x28 label
dump, the 2026-07-10 front-panel-confirmed fixture (drive X word 844 =
6 T808 OD, Y word 865 = 36 BLACKGLASS 7K), BK-070 amp-ordinal-0
anchor. Y-channel hazards honored in the encoder: MultiDelay /
Controllers second halves are NOT X/Y mirrors (refuse outright);
non-clean families gate Y per-word by read-before-write
(in-roster-or-sentinel); clean families: CAB CPR GEQ GTE PEQ PHA REV
ROT WAH (MBC is single-channel, unreachable on Y). Itemized
exclusions: switches (no census), roster-less selects (cab.cab /
cab.cab_r raw IR index; display-first), dual-mode tempo selects,
bypass-pid identity words. `effect_type` patches apply (bytes pinned)
but carry a note: an image patch bypasses the live fn 0x02
dependent-param recompute; sonic equivalence hardware-unverified.

### Structural splice (PLACE / REMOVE)

Pinned mechanics: nothing outside the chain moves (word 1 == 0; header
trailing `00 20` = septet 4096; terminator = 130 + sum(2+len),
502/502; post-terminator zeros except the chain-independent tone-match
bulk at word 2048). REMOVE = whole-triplet splice + zero-fill tail +
grid id swap to a fresh shunt + 21-bit footer recompute; PLACE = the
inverse at the alphabetical squashed-display-name position. Goldens:
766/766 remove+re-add ops byte-identical to the original bank bytes;
A000 + corpus-modal Phaser == factory-A001 chain signature verbatim.
v1 refusals: tone-match presets, tail-resident blocks (139/140/141/
142/143/170), modifiers, non-shunt grid targets, headroom past word
2048. DEFAULT records ship for 5 small families only (Chorus, Flanger,
Rotary, Phaser, Wah: factory-modal, byte-identical on live hw dumps);
always-tweaked families are donor-record-only (0 full-modal matches;
synthesis would be guessing). payloadLen census: constant per wireId
per source kind; only Amp 106 drifts (factory 234 / live 236); apply
live-length preference per BLOCK FAMILY. Inserted words carry zero
reserved bits (no donor exists): named hardware residual.

### Encode-coverage inversion ledger

| Decoder reads | Encoder writes | Status |
|---|---|---|
| Continuous knob words | `presetImageContinuousPatch.ts` (fractal-gen2, shipped) | hardware-verified push (2026-05-22) |
| Rostered-select words (X, gated Y) | `presetImage/discretePatch.ts` | community-beta, hardware-unverified push |
| Scene-state words + byte-2 mirror | `presetImage/sceneWords.ts` | community-beta; 32/32 hardware pairs replay byte-exact offline |
| TLV chain membership (PLACE/REMOVE) | `presetImage/structure.ts` | community-beta; byte-identity + A001-synthesis oracles; push acceptance of novel compositions untested (label reads LOUDER) |
| Grid cell ids (block <-> shunt swap) | `presetImage/grid.ts` | community-beta (rides the splice ops) |
| Grid connector masks | NOT ENCODED (live fn 0x05/0x06 own routing) | out by design |
| Modifier records | NOT ENCODED (preserve verbatim; dangling-target warning on remove) | out: 15-word layout undecoded (payload[8] target field is WEAK) |
| Tone-match bulk (word 2048+) | NOT ENCODED (structural ops refuse tone-match presets) | out by design |
| Preset name words 2..33 | NOT ENCODED here (live rename path exists) | out of scope this session |

## Side findings

- The descriptor lookup tables FUN_00552c30/c60 use the same 3-int-
  stride pattern Fractal uses across its codebase (we saw this in
  the III EFFECT_DUMP emitter descriptors too). The III's tables are
  larger and 64-bit-pointer-aligned, but the lookup convention is
  shared.
- The preset NAME at chunk 0 payload offset 8 (32 × 3-byte ASCII
  triplets) is just **32 ushorts** in the native stream where the
  bottom 7 bits hold an ASCII character. This was unmissable evidence
  for the septet encoding the whole time, the "ASCII + 0x00 + 0x00"
  pattern IS septet-encoding (low 7 bits in byte 0, zero in bytes 1+2
  because ASCII < 128).

## Followups

-  phase 2: implement `parseChunkNativeStream` + redo the
  variance hunt. No hardware needed.
-  phase 3: hardware-paired diff with single-knob mutations
  for confirming each ushort's semantic.
- Cross-port to AM4: same septet encoding likely applies to AM4's
  preset binary too ( / `packages/am4/src/presetDump.ts`).
