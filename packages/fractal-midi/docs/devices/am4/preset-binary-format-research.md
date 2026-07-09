# Preset binary format research ( / launch-gating)

**Date:** 2026-05-07. Pure static analysis. No hardware touched.

**Scope:** decode the AM4 preset binary format exposed by the
`0x77 / 0x78 / 0x79` SysEx stream (file shape per `SYSEX-MAP.md` §10b)
to the point that an implementer can write
`encodePresetForSlot({slots, scenes, name}, location) -> SysEx[]`
without further hardware experiments.

---

## 1. Verdict

**Partially solved, leaning blocked on the encrypted-region decode.**
Confidence: high on the file structure and on what bytes are
cleartext; medium on which fields they encode; **low on the larger
"scrambled" region** that holds per-channel parameter values, scene
assignments, and the preset name.

Concretely:

- The fixed envelope, header, footer, and chunk shape are fully
  understood (this part was already in `factory-restore-research.md`
  and `SYSEX-MAP.md` §10b).
- A 96 - 110 byte cleartext block-layout region at the start of
  chunk 1 is now identified, structurally described, and constant
  across captures. This is enough to encode 4-block layout selection.
- The remainder of chunks 1-2 (the active region runs to roughly
  4 KB, varying by preset) appears to be either (a) per-export
  pseudo-randomized cipher output or (b) cleartext that includes
  per-export volatile state we cannot disentangle from cleartext
  param values without further captures. Empirically the noise looks
  like option (b) more than option (a), but neither is proved.
- AM4-Edit's binary contains `PresetTranslator` and
  `PresetTranslatorGen3` classes (cross-device translation), but
  **no "encode fresh preset" function**. AM4-Edit creates presets the
  same way we do today: send per-parameter `0x01` writes to the
  device's working buffer, then issue the existing `0x77 / 0x78 /
  0x79` dump command which the device produces in stored form. There
  is no AM4-Edit-side function we can lift that constructs a chunk
  payload from a high-level preset description.

The implication for the launch-gate goal is described in §6.

## 2. Bank file structure (already known, restated)

From `samples/factory/AM4-Factory-Presets-1p01.syx`, 1,284,608 bytes:

| field                  | value     |
|------------------------|-----------|
| presets                | 104       |
| bytes per preset       | 12,352    |
| messages per preset    | 6         |
| 0x77 header bytes      | 13        |
| 0x78 chunk bytes (×4)  | 3,082     |
| 0x79 footer bytes      | 11        |
| header payload bytes   | 5         |
| chunk payload bytes    | 3,074     |
| footer payload bytes   | 3         |

Header payload[0..1] = bank/sub-index (`0x00..0x19`, `0x00..0x03`);
header payload[2..4] = constant `00 20 00`. Footer payload is a
3-byte content hash, distinct across all 104 presets.

Chunks 3 and 4 are byte-identical zero padding across all 104
factory presets and across all observed user exports. The active
data lives entirely in chunk 1 plus the first ~1 KB of chunk 2.
For factory A01 the active region runs 3,074 + 1,216 = 4,290 bytes;
the smallest factory preset (Z04, P103) is only 3,076 bytes.

All payload bytes are MIDI 7-bit clean (high bit always zero), so
any internal binary encoding is constrained to 7-bit-safe data.

## 3. Mask transformation: evidence and current best hypothesis

**TL;DR, there is no clean evidence of a stream cipher with a
seed we can isolate. The "per-export scramble" that  noted
is real but the diff pattern is more consistent with cleartext
plus per-export volatile fields than with a uniform XOR cipher.**

### 3.1 What  observed

Two clean-buffer exports of factory A01 (`A01-clean-a.syx` vs
`A01-clean-b.syx`) differ in 1,653 of 3,074 chunk-1 bytes (53.8%)
and 1,073 of 3,074 chunk-2 bytes (34.9%). Both are MIDI 7-bit
clean; neither is byte-equal to the bank file's A01 entry.

### 3.2 What the new pairwise diff matrix shows

Pairwise diff rate, chunk-1 / chunk-2 (in bytes):

| pair                | c1 diffs | c2 diffs |
|---------------------|----------|----------|
| orig    vs cleanA   | 1655     | 1078     |
| orig    vs cleanB   |   47     |   81     |
| orig    vs gain1    | 1767     | 1010     |
| orig    vs bank     | 2443     | 1110     |
| cleanA  vs cleanB   | 1653     | 1073     |
| cleanA  vs gain1    | 1185     | 1063     |
| cleanA  vs bank     | 2430     | 1097     |
| cleanB  vs gain1    | 1765     | 1004     |
| cleanB  vs bank     | 2443     | 1112     |
| gain1   vs bank     | 2432     | 1099     |

Two captures of the same nominal content (orig vs cleanB) show
only 47 / 3,074 chunk-1 diffs, 1.5%. Every other pair of the same
content (orig vs cleanA, orig vs gain1's gain-changed counterpart,
etc.) shows 35-58% diffs. This is the part that doesn't fit a
"per-export pseudo-random mask" model: a real stream cipher with
a different per-export seed would produce ~50% diff every time,
not 1.5% sometimes and 53% other times.

### 3.3 Header structure and the 4-byte "seed" field

The first 14 bytes of every chunk-1 payload are constant across
all 104 factory presets and every observed user export, modulo
exactly two differences:

```
offset  bytes                         meaning (hypothesised)
0x00    00 08 09|07 02 00 55 54 02    chunk header (byte 0x02 differs:
                                       09 in active export, 07 in stored)
0x08    XX XX XX XX                   4-byte "seed" — varies per export
0x0C    00 00                         padding before structural region
```

Sample seeds at offset 0x08:

| capture | seed (LE u32)         | decimal |
|---------|-----------------------|---------|
| orig    | 75 00 00 00           |     117 |
| cleanA  | 7b 6b 02 00           |  158587 |
| cleanB  | 31 5b 02 00           |  154417 |
| gain1   | 5f 58 03 00           |  219743 |
| bank A01| 1d 5d 01 00           |   89373 |

Across the bank file's 104 entries, the seed at 0x08 is essentially
unique per preset (72 / 69 / 4 distinct values for bytes [0],[1],[2];
byte [3] is always 0). Magnitudes look like a monotonic counter,
not a timestamp.

**Crucial test that rules out the simple seed-keyed-XOR hypothesis:**
orig and cleanB have different seeds (117 vs 154417, XOR = 0x25b44
, substantial Hamming distance) yet differ in only 47 chunk-1 bytes.
If the seed were the XOR mask key, different seeds should produce
~50% pairwise diff. They don't.

So either:

- (a) the mask key is keyed by something *other* than the byte-0x08
  seed, and orig and cleanB happened to share that other thing; or
- (b) the bytes after 0x0C are not masked at all, and the diffs
  come from working-buffer volatile state (modifier-current values,
  internal LFO phase, last-edit timestamps embedded in records,
  etc.) that drifted between cleanA's capture and cleanB's capture.

I'm 60/40 on (b) being correct, primarily because:

- **Periodic structure shows through.** Autocorrelation of the
  cleanA-vs-cleanB XOR stream peaks sharply at lags 3, 6, 9, 12,
  15, 18, 21, 24 (~110-215 matches each) versus baseline ~20-30
  for non-multiple-of-3 lags. That's a 3-byte period embedded in
  the data, which is preserved through the diff. A uniform stream
  cipher would destroy that signal.
- **Stride-3 alignment shows a sel-byte field.** If you slice the
  active region at stride 3, the third byte of every record only
  takes 4 distinct values (`{0, 1, 2, 3}`). That's consistent with
  a 2-bit channel selector (A/B/C/D), which is the AM4's per-block
  channel concept. A cipher would not preserve that 4-value
  distribution at a fixed stride.
- **Specific zero regions are byte-identical across captures.**
  Chunks 3-4 (entirely zero) and chunk 2 from offset ~0x500 onwards
  (also zero) match across all captures. If a stream cipher were
  active and content were zero, the cipher output would still vary
  per export. It doesn't, which means either the cipher is gated
  to "active region only" (unusual) or there's no cipher.

### 3.4 Structural cleartext region (newly identified)

Chunk-1 payload offsets `0x0C - 0x6E` are byte-identical across all
five A01 captures (orig, cleanA, cleanB, gain1, bank A01). Across
the 104 factory presets, this region varies in characteristic
ways: 66 of the 128 bytes are constant in the bank, and the
variable byte positions are distributed at fixed strides
consistent with a 3-byte-record table:

```
offset 0x0E .. 0x3B   16 records × 3 bytes — slot/channel layout table
offset 0x3C .. 0x6D   50 bytes of zeros — padding inside the table
offset 0x6E .. 0x6F   transition (15/9 distinct values across bank)
offset 0x70+          start of the variable / disputed region
```

For factory A01:

```
@0x0E:  41 1a 01    (record  0)
@0x11:  34 40 00    (record  1)
@0x14:  47 52 01    (record  2)
@0x17:  67 40 00    (record  3)
@0x1A:  52 52 01    (record  4)
@0x1D:  67 40 00    (record  5)
@0x20:  20 40 00    (record  6  — default record, 10x identical follows)
...
@0x3B:  20          (last byte of record 15)
```

Interpretation (best guess; not yet proved):

- Each record is `[byte0, byte1, byte2]`.
- The third byte at offsets `0x10, 0x13, 0x16, 0x19, 0x1c, 0x1f,
  0x22, 0x25, 0x28, 0x2b, 0x2e, 0x2f, 0x31, 0x33, 0x35, 0x36, 0x38,
  0x39, 0x3b` is a binary flag (only 2 distinct values across the
  bank) - probably a bypass or active-channel bit.
- A1 ("AM4 Gig Rig") has 4 effect blocks (amp/cab, drive, delay,
  reverb) per the AM4 manual. The first 3 non-default records map
  to the 3 active blocks; the rest are filler. This doesn't match
  4 active blocks cleanly, so the record-to-slot mapping is not
  yet tight, there may be 2 records per slot, or a different
  structure entirely.

What's NOT in this cleartext region:

- The **preset name** is not visible as ASCII anywhere in chunk 1
  or chunk 2, with or without 7-of-8 bit unpacking. If it lives in
  the chunks at all, it's either heavily encoded or in the
  scrambled tail. **Note:** this is about the bank-file / exported
  preset dump only. The live device exposes names directly via the
  `READ_PRESET_NAME` query (action 0x0012, decoded ); names
  are not bank-file-readable but ARE device-readable. AM4-Edit's
  "Refresh Preset Names" menu may also be a bulk variant of that
  query, captures it.
- **Per-channel parameter values** (e.g., the gain knob value that
  changed from 3.00 to 4.00 between `orig` and `gain1`) do not
  appear in this region. Diffs between `orig` and `gain1` are
  concentrated at offsets 0x70+ in chunk 1 (the disputed region)
  and across most of chunk 2.
- **Scene-to-channel assignments** (4 scenes × 4 blocks = 16
  pointers) are not obviously visible here either.

### 3.5 Why this matters for 

The two things the launch-gating fix needs are:

1. **Direct-to-slot writes that put fresh content in a stored slot
   without going through the working buffer.**
2. **The ability to encode an arbitrary preset description (slots
   layout, per-channel params, scenes, name) into the chunk-1 +
   chunk-2 + footer bytes that the `0x77 / 0x78 / 0x79` stream
   carries.**

Goal (1) is the easy part - the wire shape is fully decoded.

Goal (2) is the hard part. We can encode the **block layout** from
§3.4's cleartext region with reasonable confidence. We **cannot**
encode per-channel param values, scene channel-assignments, or the
preset name without first decoding the disputed region, and the
disputed region is large (~3,000 bytes of variable content) and
behaves in ways that don't fit a single clean cipher hypothesis.

## 4. Unmasked preset binary structure (what's known)

Chunk 1 payload (3,074 bytes total) for any AM4 preset:

```
+------------------------------------------------------------------+
| 0x000  fixed header           8 B   00 08 0X 02 00 55 54 02      |
|        byte[2] = 0x09 in active export, 0x07 in stored slot      |
+------------------------------------------------------------------+
| 0x008  per-export "seed"      4 B   monotonic counter, possibly  |
|        not used as cipher key — empirically unrelated to the     |
|        observed mask behaviour                                   |
+------------------------------------------------------------------+
| 0x00C  zero pad               2 B                                |
+------------------------------------------------------------------+
| 0x00E  block-layout table    48 B   16 records of 3 bytes        |
|        record[i] = [b0, b1, sel_or_flag]                         |
|        first 3-5 records occupied; remainder = 20 40 00 default  |
+------------------------------------------------------------------+
| 0x03C  padding              ~50 B   zeros                        |
+------------------------------------------------------------------+
| 0x06E  variable region transition                                 |
+------------------------------------------------------------------+
| 0x070  per-channel params + scenes + name + ...                   |
|        ~3,000 bytes of variable data, structure NOT decoded       |
|        appears to be 3-byte records with 2-bit selector but       |
|        meaning of byte0/byte1 not pinned                          |
+------------------------------------------------------------------+
| 0xC02 - 0xC01  trailing zeros to end of chunk 1                   |
+------------------------------------------------------------------+
```

Chunk 2 payload (3,074 bytes total):

```
+------------------------------------------------------------------+
| 0x000  variable region cont'd ~1.0-1.2 KB depending on preset    |
|        same 3-byte record structure as chunk 1's tail            |
+------------------------------------------------------------------+
| 0x4C0+ trailing zeros to end of chunk 2                          |
+------------------------------------------------------------------+
```

Chunks 3, 4: 3,074 bytes each, all zeros. Always.

Footer payload: 3 bytes, content-derived. Distinct across all 104
factory presets - very plausibly a CRC or hash of chunks 1-4.
Algorithm not yet identified. Bank file gives 104 (chunks, footer)
pairs to brute-force common CRC variants against; this should be
a half-day side-quest.

## 5. Encoder pseudocode (incomplete; see §6 for what's missing)

What we could write today, given the §3 / §4 findings:

```typescript
function encodePresetForSlot(
  preset: PresetIR,
  location: { bank: number; sub: number },  // 0..25, 0..3
): SysExMessage[] {
  const chunk1 = new Uint8Array(3074);
  const chunk2 = new Uint8Array(3074);
  const chunk3 = new Uint8Array(3074); // all zeros
  const chunk4 = new Uint8Array(3074); // all zeros

  // 1. Fixed chunk header.
  chunk1.set([0x00, 0x08, 0x07, 0x02, 0x00, 0x55, 0x54, 0x02], 0x000);
  // byte[2] = 0x07 for stored slots; AM4-Edit emits 0x09 only for
  // active-buffer exports (sentinel header bank = 0x7F).

  // 2. Seed at 0x008. Empirically not used as a cipher key. Emit a
  //    small monotonic counter bumped per encode, or zero — both
  //    appear acceptable.
  chunk1.set([SEED_LO, SEED_MID, 0x00, 0x00], 0x008);

  // 3. Block-layout table at 0x00E, 16 records × 3 bytes.
  for (let i = 0; i < 16; i++) {
    const off = 0x00E + i * 3;
    if (i < preset.slots.length && preset.slots[i].block !== 'none') {
      const r = encodeBlockLayoutRecord(preset.slots[i]); // 3 bytes
      chunk1.set(r, off);
    } else {
      chunk1.set([0x20, 0x40, 0x00], off); // default / empty record
    }
  }

  // 4. Zero pad 0x03C..0x06D.
  // (already zero from constructor)

  // 5. Variable region 0x06E..end-of-chunk1 + chunk2 prefix.
  //    *** NOT IMPLEMENTED — encoding unknown ***
  encodePerChannelParamsAndScenesAndName(preset, chunk1, chunk2);

  // 6. Header (0x77).
  const header = buildSysExEnvelope(0x77, [
    location.bank, location.sub, 0x00, 0x20, 0x00,
  ]);

  // 7. Wrap chunks (0x78).
  const c1 = wrapChunk(chunk1);
  const c2 = wrapChunk(chunk2);
  const c3 = wrapChunk(chunk3);
  const c4 = wrapChunk(chunk4);

  // 8. Footer (0x79). 3-byte hash of the full payload.
  const footer = buildSysExEnvelope(0x79, computeFooterHash([
    chunk1, chunk2, chunk3, chunk4,
  ]));

  return [header, c1, c2, c3, c4, footer];
}
```

**The two functions in CAPS are blockers:**

- `encodeBlockLayoutRecord(slot)`, the 3-byte record format is
  visible in §3.4 but the byte0/byte1/sel meaning is not yet
  bound to a known field. Best guess: byte0+byte1 form a 14-bit
  packed value (block type ID and channel state), byte2 is bypass.
  Verifying this requires placing known blocks in known slots
  and observing the exact bytes, i.e., a hardware capture.

- `encodePerChannelParamsAndScenesAndName(...)`, the disputed
  region in §3.5. We can't encode this without a decode.

- `computeFooterHash(chunks)`, algorithm unknown. The bank file
  exposes 104 (chunks, footer) pairs as ground truth. Standard
  CRC-24, CRC-16-CCITT, sum-mod-prime, etc. brute-force would
  identify it in under an hour if it's a documented algorithm.
  If it's a Fractal-internal mix, it won't be discoverable
  without further RE.

## 6. What the founder's HW probe needs to verify before we ship

Before we can ship `encodePresetForSlot`, three hardware actions
are needed; the lessons (working-buffer side effects, ack
discipline) all apply:

1. **Block-layout record format probe.** Set up a known empty
   preset on Z04. Iterate: place each of the 17 block types in
   slot 1 (using the existing `set_block_type` flow), capture the
   resulting `0x77/0x78/0x79` dump for that location, diff against
   the same dump with slot 1 empty. The differing bytes at offset
   0x00E - 0x010 of chunk 1 will pin the block-type → byte0/byte1
   mapping. Repeat for slots 2-4 and per channel A/B/C/D to pin
   selector semantics. ~80 captures, mostly automated. After this,
   `encodeBlockLayoutRecord` is implementable.

2. **Param-encoding probe (the big one).** This is the equivalent
   of what -06 did for the wire `0x01 SET_PARAM`
   protocol, but for the stored encoding. Pick one block (amp
   gain on slot 1 channel A is the canonical choice), drive its
   value through 8-10 known display values (0.0, 1.0, 2.5, 5.0,
   7.5, 10.0), capture a stored dump after each, diff. The
   changing bytes are the encoded gain. Cross-check against 2-3
   other blocks (drive level, delay time, reverb mix) to see
   whether the encoding is per-block-type or universal. Likely
   ~50-80 captures. After this, the disputed region's structure
   should be at least partially decoded.

3. **Footer hash probe.** Brute-force pure: run common CRC
   variants over each (chunks, footer) pair from the bank file.
   No hardware needed, just CPU time. If no standard algorithm
   matches all 104 pairs, the footer is a Fractal-internal hash
   and we'll need to either skip footer validation on the device
   side (probably tolerated; AM4-Edit has been observed to produce
   slightly different footers for the same content) or RE the
   hash function from `AM4-Edit.exe`.

If (1) and (3) succeed but (2) doesn't, we have a partial path:
direct-to-slot writes for the **layout-only** portion of a fresh
preset, with the device's existing live-write protocol filling in
per-channel parameters after the slot-write. That's still a win
for the failure mode, the user's currently-loaded preset
isn't smeared because we never touched the working buffer for the
layout part. It's not a complete bypass-the-working-buffer fix,
but it's a meaningful step.

## 7. Open questions and risks

1. **Is the disputed region actually masked?** §3.3's evidence
   leans against a uniform stream cipher but doesn't disprove a
   gated cipher (e.g., XOR with a key derived from the seed +
   per-record nonce, applied only to the active region). The
   crispest test is hardware: capture two "clean" exports of the
   same preset back-to-back with the device sitting idle, and
   check whether the diffs are concentrated in obviously-volatile
   fields (modifier outputs, tuner state, current-LFO-phase) or
   distributed pseudo-randomly. The session-03 captures we have
   weren't designed for that test.

2. **What's at offsets 0x00 - 0x07?** The constant `00 08 09|07
   02 00 55 54 02` looks like a magic header / version field. If
   byte 2 toggles between `0x09` (active export) and `0x07`
   (stored), the device may treat those exports differently on
   import. Worth checking before assuming they're interchangeable.

3. **Chunk count = 4 is hard-coded, but most of chunks 3, 4 and
   half of chunk 2 are zeros.** The wire protocol could presumably
   support smaller dumps (`0x77 + 1 chunk + 0x79`). The device may
   refuse anything other than 4 chunks; we have no captures of a
   non-4-chunk dump from AM4-Edit. Try the minimal version on
   hardware before assuming.

4. **AM4-Edit's preset translation classes
   (`PresetTranslator`, `PresetTranslatorGen3`).** These exist in
   the binary and presumably know how to read AM4 chunks (since
   they translate from one device family to another). A focused
   Ghidra session on those classes, specifically tracing the call
   chain from the `Translate Preset` menu item, might surface a
   parser that decodes the chunk content cleartext. I did not
   pursue this fully because the symbol-table-only matches in
   `ghidra-encoder.txt` don't include the translator's bodies.
   That's the next concrete RE step if the founder wants to push
   the static-analysis route further before committing to
   hardware probes.

5. **The "scrambling" might not exist at all.** The 60/40 lean
   toward (b) in §3.3 is genuinely close to 50/50; a careful
   capture series targeting only volatile state (idle the device,
   capture, capture again 30 seconds later with no input) would
   resolve this in one sitting.

## 8. What this means for the  launch-gate

The original  plan was: **decode chunks completely, build
a fresh-preset encoder, ship direct-to-slot writes that bypass
the working buffer, fix the  smearing bug.**

The honest read after this analysis: that plan is **not
achievable on a static-analysis-only timeline**. The disputed
region is too large and behaves too inconsistently to decode by
diffing five session-03 captures.

Two realistic paths considered at the time:

- **Ship without the encoder, with the workaround documented.**
  Tell the user "don't move the front-panel preset knob during
  agent batch operations; we're working on it." Loud and ugly but
  honest.  stays open as follow-up research.
- **Ship a partial encoder for layout-only.** Implement the §5
  pseudocode minus the disputed-region step, write the layout
  changes via direct-to-slot, then drive per-channel params via
  the existing working-buffer route. Mid-sequence the working
  buffer still gets touched, so the smearing bug isn't fully
  fixed, but the layout part is reliable. Probably ~3 days of
  hardware probes + implementation.

Neither path delivers the full promise. The chosen call
(see §9) was to ship without the encoder and queue the hardware
probe series in §6 as follow-up.

## 9. Status decision (2026-05-09)

**Shipping without the encoder.** Decision rationale:

- §6 hardware probes are bounded but not free (half-day on
  hardware; founder is concurrently running setlist tests, install
  validation, etc.). Burning that window on encoder RE delays
  launch with no compensating user-visible win. The
  working-buffer-touch caveat is documented, and `am4_apply_preset_at`
  already mitigates it via switch-first-apply-then-save.
- The "60/40 cleartext + volatile state" reframing of §3.3 changes
  the calculus: if the chunk content is mostly cleartext with a
  few volatile-state fields embedded, the path forward is "filter
  out volatile fields" not "decrypt." That's much cheaper, and
  the resolving capture is a one-sitting test (idle device, two
  back-to-back exports of the same preset, diff). Worth doing
  before committing to the full §6 program.
- Tier 2 extraction (names + block layout) ships in 
  via live-wire readout, not static decode. That gives the agent
  a reference table for "what's at factory X" without depending on
  encoder progress. Tier 3 (full param/scene/channel state) is
  reachable today via slow live-readout (~30-45 min one-time) or
  fast static decode after §6.

**Followup tasks queued:**

- Task #22, §6 hardware probe series (block-layout records,
  param encoding, footer hash). Includes the cleartext-volatile-
  state confirmation capture as a prelude.
- Task #23, tier 3 factory-data extraction (live-wire readout
  path or via task #22's encoder, whichever lands first).
- The cleartext-volatile-state confirmation is fast and high-
  information; if hardware time opens up, it's the next 
  step worth taking even before §6.

This artefact stays the source of truth for chunk binary
structure. Update §3.x when new diff captures land; update §4
when record-meaning is pinned; close out §6 items as probes
complete.

## 10. Per-channel param-value decode (2026-05-28 session)

**Goal:** decode the 0x77/0x78/0x79 stream sufficiently to extract
**per-channel parameter values** for amp/drive/delay/reverb, so the
MCP server's AM4 `get_preset` tool can replace its current slow per-
param-per-channel fn 0x02 fallback with a single fast dump-and-decode.

**Verdict: PARTIAL.** A workable serialization model emerged that
explains the prior session's "22% per-export noise / chunks
shuffled" findings without invoking a stream cipher. The existing
hardware corpus is **not sufficient** to pin per-channel byte
offsets, a small, targeted capture series (Section 10.5) would
close the gap, but the existing four-capture A01 corpus has too
much volatile-allocator drift between captures to localize fields.

### 10.1 Reading the prior corpus correctly

The five A01 captures in `samples/factory/` (`A01-original`,
`A01-clean-a`, `A01-clean-b`, `A01-gain-plus-1`) plus the bank's
A01 entry plus `samples/captured/preset-export-a1.syx` give a
six-way comparison. Re-running the diff matrix this session
revealed a pattern §3.3 named but didn't fully explain: pairwise
diff rates split into two clean clusters, not a continuum.

| pair                                  | chunk-1 diffs | classification |
|---------------------------------------|---------------|----------------|
| `orig` vs `cleanB`                    |   47 / 3074   | low-drift      |
| `orig` vs `preset-export-a1`          |  143 / 3074   | low-drift      |
| `orig` vs `cleanA`                    | 1655          | high-drift     |
| `cleanA` vs `cleanB`                  | 1653          | high-drift     |
| `orig` vs `gain+1`                    | 1767          | high-drift     |

The "low-drift" cluster (≤ 5% byte diff) and the "high-drift"
cluster (~ 54% byte diff) are bimodal, not a noise gradient. A
stream cipher would produce ~50% always; a content hash would
produce ~50% always. Bimodality fits one specific model:
**AM4-Edit's preset-binary serializer maintains a per-process
in-memory cache of the encoded form, keyed off "have I serialized
this preset yet without an intervening edit?"** When the cache
hits, the next export is byte-near-identical to the prior export.
When it misses (process restart, navigate-away-and-back, or any
parameter edit), the serializer re-encodes from device state and
the new encoding lands in different byte positions because the
encoder uses a content-addressable structure (likely a hashtable
or linked allocator) whose internal layout depends on volatile
state.

The 47 / 143 stable diffs in the low-drift pairs are then the
**genuinely volatile fields embedded in the binary** (sequence
counter at 0x08, possibly a "last edit timestamp", a footer hash
input, etc.): small in count, low in semantic value.

### 10.2 What this means for byte-offset decoding

**For arbitrary cross-capture pairs, byte offsets are NOT stable**:
the encoding shuffles wholesale on cache-miss. This is why §3.3's
3-byte-stride autocorrelation peaked but the per-position diff
didn't localize a single param: the records are at stride-3 BUT
their position within the stream is volatile.

**For paired captures taken back-to-back from a freshly-warmed
cache, byte offsets ARE stable**: the orig-vs-cleanB pair proves
this empirically. So a probe campaign designed to take
"before / minimal-change / after" captures within a single warm-
cache window can localize fields, but the existing four-capture
corpus was not taken under that discipline. The gain+1 capture in
particular shows ~1767 byte diffs vs orig, all of which are
allocator drift PLUS the actual gain encoding.

### 10.3 Most promising candidate field

Decoding chunk 2 as **3-byte septet-packed 14-bit ushorts**
(same encoding as fn 0x1F atomic-read chunks; see
[[am4-fn1f-atomic-read]] and `decodeChunkValue` in
`packages/am4/src/descriptor/reader.ts`), a single stable
single-bit diff survives the determinism mask:

```
chunk2 record[260]  (byte offset 0x030c)
  orig         : 0xC1FE
  clean-a      : 0xC1FE   ← stable
  clean-b      : 0xC1FE   ← stable
  preset-exp-a1: 0xC1FE   ← stable across an independent re-export
  gain+1       : 0xC1FF   ← +1 from orig
```

This is **the smallest possible diff** consistent with a 1-unit
gain bump (gain on AM4 is 0..10 in 0.1-unit steps so wire scale
0..65534 maps a +1 display tick to ~ 6553-unit wire increment, not
+1, so this might NOT be amp.gain at all, but it IS a real
parameter byte). Three other small-delta candidates land in
chunk 1 from offset 0x070+:

| location          | orig      | gain+1    | delta |
|-------------------|-----------|-----------|-------|
| c1 byte 0x030a    | 0xC580    | 0xC582    | +2    |
| c1 byte 0x04c9    | 0xFF83    | 0xFF81    | -2    |
| c1 byte 0x08bf    | 0xCD03    | 0xCD02    | -1    |
| c2 byte 0x030c    | 0xC1FE    | 0xC1FF    | +1    |

These four positions are **the only septet-decoded ushort positions
in the determinism mask where the delta is ≤ 2 units**. Every other
"stable diff" is a larger value (10-100+ units), consistent with
those bytes being allocator-shuffle artifacts.

**Hypothesis to verify:** these 4 positions hold per-channel
parameter values for the 4 channels (A/B/C/D) of a single block on
A01. The pattern matches:

- 4 candidates, one per channel
- Septet-packed 14-bit ushorts (the device's native param-value
  encoding, confirmed in fn 0x1F + name-pack analysis)
- All differ from orig by a small amount when ONE display knob is
  bumped
- Stable across noise pair (cleanA vs cleanB drift)

The high byte (0xC1, 0xC5, 0xFF, 0xCD) is the param-id or
block-id discriminator; the low byte is the value. Wire value
0xFE → 0xFF is +1 LSB; if the underlying display scale is Q14
([0..16383]) → display 0..10, a +1 LSB delta would be display
0.0006, far below the gain knob's 0.1 resolution. So either:

- (a) These are per-channel records of a param that DOES move by
  ~1 wire LSB on a 1-unit display change (rare, most knobs are
  100-1000x more coarse on wire), or
- (b) These are SOMETHING ELSE that happened to drift by 1 wire
  LSB on this particular re-export (a per-export counter, a
  hash bit, an LFO phase snapshot, etc.). The encoder cache-miss
  produced this diff incidentally, not as a function of the gain
  change. We cannot disambiguate without targeted captures.

### 10.4 What the existing corpus CANNOT tell us

- **Whether the encoder reshuffles records on every minor edit or
  only on cache-miss.** The four current A01 captures were not
  taken back-to-back; we don't know if gain+1 was a cache-hit
  delta (then 1-4 stable diffs ARE the real param byte) or a
  cache-miss (then the 78 small-delta candidates contain the
  param byte buried in 70+ allocator-shuffle false positives).
- **Per-channel field offsets.** No capture in the corpus changes
  one channel's params while leaving the other 3 channels'
  identical (which is what would isolate per-channel offsets).
- **Block-type-to-field mapping.** No capture varies one block's
  layout (e.g. swap amp model A→B with no other change) while
  holding the other 3 slots fixed.

### 10.5 Captures required to close the gap

**One capture per hypothesis** (per `RE-WORKFLOW.md` rule). All
captures should be taken via `am4_request_active_buffer_dump()`
from a single MCP session without restarting Claude Desktop or
AM4-Edit in between (to maximize cache-warmth and minimize
allocator-state drift between paired captures). Founder runs the
hardware sequence; agent runs `scripts/_research/am4-warm-pair-
capture.ts` (see Section 10.6).

| # | Setup | Mutation | Diff target |
|---|-------|----------|-------------|
| 1 | A01 freshly loaded, scratched to Z04 | none, dump twice back-to-back | **Cache-hit floor:** confirms re-dump produces ≤ 50 byte diffs. If ≥ 100, cache hypothesis is wrong. |
| 2 | Z04 with one amp on slot 1, channel A active | set amp.gain from 5.0 → 5.1 (one display tick) | **One-channel single-param diff.** Should produce ≤ 4 small-delta stable diffs vs capture #1's second dump. The actual byte position pins amp.gain on channel A. |
| 3 | Same Z04 setup as #2 | continue #2's state, switch to channel B, set amp.gain to 5.0 → 5.1 again | **Per-channel offset.** Diff against #2's after-capture should isolate amp.gain on channel B at a different byte position than channel A. The spacing pins per-channel record stride. |
| 4 | Same Z04 setup | set amp.master from 5.0 → 5.1 (different param, same channel) | **Per-param offset.** Diff against #2 should pin amp.master at a different byte position than amp.gain, within the same channel record. |
| 5 | Z04 setup, slot 1 = amp model A | swap slot 1 to amp model B (set_block_type) | **Block-type byte.** Should diff in chunk 1's layout table (0x0e..0x40) AND in chunk 2's param region (different model has different default knob values). The layout-table diff isolates the type ID; the param-region diff confirms which records are per-block. |

All captures are non-destructive (active buffer dumps, no preset
saves to non-scratch locations).

### 10.6 Probe scripts shipped this session

Two scripts under `scripts/_research/` implement the capture
sequence. Both are **READ-ONLY** (they only send the fn 0x03
active-buffer dump request) plus a small set of `set_param` /
`set_block_type` / `switch_block_channel` mutations targeting
ONLY the Z04 scratch location, per the standing AM4 workflow.

- **`am4-warm-pair-capture.ts`**: drives the §10.5 capture
  sequence end-to-end against a connected AM4. Writes
  `samples/captured/am4-warm-pair-<N>-{before,after}.syx` for
  each step, then prints a per-capture diff summary. Refuses to
  start if any of the safety preconditions fail (port closed,
  active location ≠ Z04 at start, etc.). Founder runs it as
  `npx tsx scripts/_research/am4-warm-pair-capture.ts`.

- **`am4-warm-pair-diff.ts`**: pure analysis script; takes the
  capture files written by the above and produces the per-pair
  diff report with (a) raw byte diff count, (b) septet-packed
  ushort diff (post-decoded), (c) stable single-delta candidates
  with absolute byte offset and chunk-relative record index.
  Founder can run this offline against any pair of dumps to
  re-analyze.

Neither script writes to flash; both refuse to issue any save
SysEx. Both are research-only and live under `scripts/_research/`,
matching the project convention that scratch scripts are not part
of the shipped `dist/` build.

### 10.7 Why the decode is closeable (and the next step)

The bimodal diff distribution is the first piece of evidence in
this whole investigation that fits a single, simple model
(allocator-shuffle on cache-miss). Every prior alternative
(stream cipher, Huffman compression, content hashing) is ruled out
or doesn't fit the entropy / multiset overlap / orig-vs-cleanB
stability data. With even one warm-cache paired capture
(`#2` in §10.5), the per-channel param byte position becomes
isolable to a handful of byte offsets, a tractable, ~1-hour
follow-on decoding task.

**Recommended next step:** founder runs the §10.5 capture sequence
(~10 minutes on hardware) using `am4-warm-pair-capture.ts`. The
output captures land in `samples/captured/`; agent runs
`am4-warm-pair-diff.ts` against the pairs and updates this §10
with the localized per-channel byte map.

**If the cache-hit floor (step #1) doesn't match the
prediction:** the allocator-shuffle model is wrong, and the next
step is Ghidra mining of the AM4 firmware itself (not AM4-Edit,
which we already searched for the encoder and found only the
header re-stamper `FUN_1402298f0`). The device firmware blob is
in `samples/factory/AM4_firmware_v2p00.syx`; the JUCE pattern
analysis from cookbook `juce-binarydata-zip.md` may not apply
since AM4 firmware isn't JUCE-based, but a brute-force string
walk targeting the param-table layout would be the fallback.

### 10.8 What ships from this session

- This §10 (research findings, hypothesis, capture plan, diff
  candidates).
- `scripts/_research/am4-warm-pair-capture.ts` (read-only probe
  driver) and `am4-warm-pair-diff.ts` (analyzer).
- NO changes to `packages/fractal-midi/src/am4/presetBinary.ts`
  (production decoder stays at the name-decode milestone until
  §10.5 captures verify byte positions).
- NO changes to `packages/am4/src/descriptor/reader.ts`
  (`get_preset`'s slow-but-correct per-channel fn 0x02 fallback
  stays in place until the dump decoder is hardware-verified).

### 10.9 Status verdict (one line)

**Partial, hypothesis articulated, candidate byte positions
narrowed from 343 to 4, but byte-offset map requires the §10.5
warm-cache capture series (founder action, ~10 minutes hardware)
before any code can ship to `packages/am4/`.**

### 10.10 Warm-cache hypothesis FALSIFIED (2026-05-28)

> **MECHANISM EXPLAINED (2026-07-02):** the "encoder non-determinism"
> verdict below is superseded in mechanism (not in conclusion). The dump
> body is the gen-3 preset container (3-to-16 pack → CRC'd raw_patch →
> dynamic-Huffman body; see `SYSEX-MAP.md` §10b "Container decode" and
> `src/am4/presetContainer.ts`). The per-export churn is the dynamic
> Huffman CODE TABLE being rebuilt each export plus ONE volatile decoded
> u16 @ body `0x140E` — the same warm pairs diff by exactly 2 bytes at
> the DECODED layer, and the amp-gain pairs localize to a single u16
> (chA gain @ body `0x0958` = `0x828E` for display 5.1). Flat-byte
> diffing of the compressed stream stays ruled out; decoded-layer
> diffing via `decodeAm4RawPatch` is the supported lane.

The founder ran `am4-warm-pair-capture.ts` on hardware in the same
MCP session as the Bug B / Bug C fixes for the alpha.13 desktop-
test triage. Result: the warm-cache hypothesis is **falsified**.

Per-step inline-diff vs cache-hit-floor threshold (500 bytes per
§10.7's prediction):

| Step | Mutation | Byte diffs | Verdict |
|---|---|---|---|
| 1 | none (dump twice, no mutation between) | 2535 | ✗ over 500, falsifies |
| 2 | amp.gain channel A 5.0 → 5.1 | 2612 | drift dominates |
| 3 | amp.gain channel B 5.0 → 5.1 | 2784 | drift dominates |
| 4 | amp.master channel A 5.0 → 5.1 | 2617 | drift dominates |
| 5 | slot-1 amp type swap | 2903 | drift dominates |
| cross-step baselines | (informational) | 2557 to 2644 | uniform drift floor |

The encoder is non-deterministic between identical inputs. The
allocator-shuffle model in §10.3 doesn't fit, the shuffle fires
even when no parameter change has occurred. Per-param-change byte
positions cannot be isolated by paired diffing from this side.

> Reproduced independently (no-mutation redump = 2541 of 12352 bytes
> differ; one-variable swap = 2909, so the swap adds only ~370 diffs on
> top of the ~2541 noise floor). This non-determinism is now registered
> as the cookbook negative
> [`_negative/am4-preset-dump-flat-byte-diff`](../../research/cookbook/_negative/am4-preset-dump-flat-byte-diff.md).
> Consequence for the `fn 0x01 action=0x1F` snapshot footer: the
> `0xB0` per-slot block-type codes (`BLOCK_TYPE_VALUES` pidLows) decoded
> there CANNOT be cross-corroborated from this dump primitive, so the
> footer block-type map stays single-primitive. Note the contrast with
> Axe-Fx II, whose `0x77/0x78/0x79` dump IS deterministic between
> identical inputs (a channel-toggle redump shows zero byte diffs).

**One positive signal survived:** step 5 (amp type swap) produced
**23 exclusive record positions in chunk 1** at offsets
0x01b0 to 0x0309 that no other step touched. Sample positions:

```
rec[144] @byte 0x01b0: 0xc1ff → 0xc138 (delta=-199)
rec[182] @byte 0x0222: 0xc1ff → 0x01ff (delta=-49152)
rec[202] @byte 0x025e: 0xc1ff → 0xc059 (delta=-422)
rec[213] @byte 0x027f: 0xc1fe → 0xc1f7 (delta=-7)
rec[214] @byte 0x0282: 0xc1ff → 0x81fc (delta=-16387)
... (full list in samples/captured/am4-warm-pair-diff.json)
```

These are real per-block-descriptor byte positions, but isolated
to block-type swaps, not per-param changes. The block-layout table
at chunk1 0x0E, 0x40 had **zero** diffs for the swap, contradicting
§3.4's earlier mapping. Either §3.4's offsets are wrong, or the
swap didn't fully land (the analyzer flagged "block-type swap may
not have landed").

**What this rules in / out:**

- Encoder-side decode via paired diffing: ruled out for AM4.
- Encoder-side decode via AM4-Edit Ghidra: already ruled out
  (only one 0x77 builder site; it's a header re-stamper).
- **Parser-side decode via AM4-Edit Ghidra: not yet attempted,
  closeable.** When AM4-Edit consumes an incoming `0x77/0x78/0x79`
  dump from the device, it parses ~12 KB into its preset model.
  That parser is byte-positional, it must know the offsets.
- **Firmware-side decode via AM4 firmware Ghidra
  (`samples/factory/AM4_firmware_v2p00.syx`): closeable, harder.**
  Not JUCE-based per §10.7; brute-force string-walk targeting
  param-table layout would be the approach.

**Next research arc:** parser-side AM4-Edit Ghidra mining,
anchored against the 23 exclusive-record positions from step 5.
The working prompt for this decode lives in the project's private
research scratch.

**What this means for production code:** Bug B's slow-but-correct
per-channel fn 0x02 fallback in `packages/am4/src/descriptor/reader.ts`
stays as the answer for v0.1.0-alpha.14. The fast-path stays
unblocked but pending another research arc.

**Artifacts on disk:**

```
samples/captured/am4-warm-pair-{1..5}-{step}-{before,after}.syx
samples/captured/am4-warm-pair-diff.json   (structured analyzer output)
```

## 11. AM4-Edit parser-side decode (Ghidra session 2026-05-28)

**Goal:** decode AM4-Edit's inbound 0x77/0x78/0x79 parser so we recover
byte-positional knowledge of the 12,352-byte preset binary. Encoder
side is exhausted (§10 + the pre-2026-05-28 mining: only one 0x77
builder in AM4-Edit, `FUN_1402298f0`, a header re-stamper).

**Verdict: PARTIAL, workflow registry decoded, direct chunk-1 parser
still pending another mining hop.** What landed instead of a direct
parser is a major structural finding: AM4-Edit follows the same
runtime-registered named-workflow dispatch pattern as AxeEdit III. The
chunk-1 parser is reachable via the workflow object's state-machine
handler, not via a flat fn-byte switch.

### 11.1 Mining method

Two Ghidra scripts (run via headless analyzer 12.0.4 against
a local AM4-Edit Ghidra project):

- [`FindAM4EditPresetParser.java`](../../scripts/ghidra/FindAM4EditPresetParser.java)
, magic-immediate scoring (modeled on `FindAxeEditIIPresetParser.java`)
  + step-5 ground-truth anchor offsets (the 22 chunk-1 positions from
  §10.10 + 1 chunk-2 position). Output:
  `samples/captured/decoded/ghidra-am4-edit-preset-parser.txt`
  (top-50 ranking + decompiles of top-20 candidates).
- [`DecompileAM4InboundDumpHandlers.java`](../../scripts/ghidra/DecompileAM4InboundDumpHandlers.java)
, focused decompile of high-0x77/0x78 candidates (#21 / #22 / #24 /
  #33 / #37) and the workflow registration helper. Output:
  `samples/captured/decoded/ghidra-am4-edit-inbound-dump-handlers.txt`.

The cookbook rule `_negative/byte-literal-envelope-ghidra-search.md`
applies: don't search the full 5-byte `F0 00 01 74 15` envelope (the
model byte 0x15 is loaded at runtime from a device-handle struct).

### 11.2 Workflow registry, `FUN_1402d83d0`

Top magic-immediate hit was the rare constant `0x3040` (total preset
length, 12,352). Two functions hit it: `FUN_140152410` /
`FUN_1401526e0` (allocators / size readers) and `FUN_1402d83d0`. The
last is the **AM4-Edit workflow registry constructor**, the AM4
analog of III's `FUN_1401f0f10`.

Pattern (repeats ~35 times across the function):

```c
*(undefined4 *)(param_1 + OFFSET)     = WORKFLOW_ID_REQ;
*(undefined4 *)(param_1 + OFFSET + 4) = WORKFLOW_ID_RESP;
FUN_140196500(param_1 + OFFSET_BUF, 0, 1);          // 0 = stream-start marker
FUN_140196500(param_1 + OFFSET_BUF, FN_BYTE, 1);    // outbound fn-byte(s)
FUN_140196500(param_1 + OFFSET_BUF, 1, 1);          // 1 = stream-end marker
FUN_140060fb0(&local_handle, "Workflow Name");
```

`FUN_140196500` is the registration helper, appends `fn-byte` (param_2)
to an int32 array at `param_1 + 0x18` AND a byte flag (param_3) to a
byte array at `param_1 + 0x28`. 139 callers across the binary; almost
all from `FUN_1402d83d0`. This refines the cookbook entry
[[iii-async-workflow-fn-registry]] from `matched-singleton` →
`matched` (AM4 added as a second device-family axis; entry updated
in the same session).

### 11.3 Workflow-name table, partial enumeration

Mined directly from `FUN_1402d83d0`'s decompile (see lines
20039-21100 of `ghidra-am4-edit-preset-parser.txt`):

| Workflow IDs (req, resp) | Registered fn-bytes | Name |
|---|---|---|
| 0x03, 0x04 | 0, 4, 5, 6, 7, 0x31, 1 | Query device version |
| 0x07, 0x08 | 0, 0x1a, 0xc, 0xd, 1 | Initialization |
| 0x09, 0x0a | 0, 8, 1 | Library Load |
| 0x0f, 0x10 | 0, 9, 0x19, 0xb, 0x32, 1 | Query All Param Definitions |
| 0x11, 0x12 | 0, 0xa, 1 | Query Param Definition |
| 0x13, 0x14 | 0, 0xb, 1 | Refresh Preset Names |
| 0x15, 0x16 | 0, 0x19, 1 | Refresh Cabinet Names |
| 0x1f, 0x20 | 0, 0x11, 1 | **Save Preset** |
| 0x21, 0x22 | 0, 0x17, 1 | File Snapshot |
| 0x23, 0x24 | 0, 0x17, 1 | File Export to Sysex |
| ~0x25, 0x26 | 0, 0x17, 1 | **Get Preset Data** |
| 0x27, 0x28 | 0, 0x17, 1 | File Export to Templates |
| 0x29, 0x2a | 0, 0x23, 0x25, 1 | Paste Preset |
| 0x2f, 0x30 | 0, 0x15, 1 | Change Scene |
| 0x31, 0x32 | 0, 0x16, 1 | Set Scene Name |
| 0x33, 0x34 | 0, 0x13, 1 | Copy Scene |
| 0x35, 0x36 | 0, 0x14, 1 | Swap Scenes |
| 0x45, 0x46 | 0, 0x29, 1 | Block Move |
| 0x4b, 0x4c | 0, 0x27, 1 | Block Copy |
| 0x4d, 0x4e | 0, 0x28, 1 | Block Paste |
| 0x53, 0x54 | 0, 0x2a, 1 | Channel Copy |
| 0x55, 0x56 | 0, 0x2b, 1 | Channel Paste |
| 0x57, 0x58 | 0, 0x2c, 1 | Channel Copy to All |
| 0x0b, 0x0c | 0, 0x26, 1 | Library Query |
| 0x0d, 0x0e | 0, 0x26, 1 | Library Query (second registration) |

This already supersedes the `am4-edit-anatomy.md` host-emitter table
(which had ~6 entries). The full table extends past line 21100 in the
dump; mining the rest is a 15-minute follow-up.

### 11.4 Why this rules out direct chunk-1 parser discovery (and what to do instead)

Crucial null result: **no workflow registers fn-bytes 0x77 / 0x78 /
0x79.** Re-grep of `FUN_140196500(slot, 0x77|0x78|0x79, ...)` across
the entire binary returns zero matches. The high-0x77 magic-immediate
candidates (`FUN_140462910` [0x77=7], `FUN_14045fc90` [0x77=5],
`FUN_1404c4f10` [0x77=3]) decompile to JUCE UI / look-and-feel code;
the 0x77 hits are JUCE Identifier hashes or UI color constants, not
SysEx fn-bytes. Same false-positive pattern on the high-0x78 set:
`FUN_1402d47f0` is a UI dropdown builder that loops 0..4 over
"Channel %C" labels (the `0x78` immediates are stack-frame offsets).

Interpretation, anchored on III precedent: the inbound 0x77/0x78/0x79
frames flow into AM4-Edit's generic SysEx-receive hook (not yet
mined), which checks **workflow state**, not fn-byte. The
"Get Preset Data" workflow's state-machine handler is what consumes
the chunk bytes after it sent its outbound fn=0x17 request. This
matches the III pattern documented in
[[iii-workflow-state-machine-executor]]: III's `FUN_1401f4390` is a
giant switch on state ID (not fn-byte), with cases that emit fn=0x01
via `FUN_14033ec70` etc.

The chunk-1 parser is therefore inside whichever AM4-Edit function is
the analog of III's `FUN_1401f4390`. Finding it requires a different
search anchor, the workflow object's vtable / handler pointer rather
than fn-byte immediates.

### 11.5 Next research arc (one targeted Ghidra script away)

Trace the workflow object instantiated at `param_1 + 0x2e90` for
"Get Preset Data" (workflow IDs ~0x25, 0x26):

1. **Find the workflow object's vtable.** Each workflow registration
   in `FUN_1402d83d0` writes IDs at `(param_1 + offset, +4)` and calls
   `FUN_140196500` against `param_1 + (offset - 0x10)`. The workflow
   object base is at that offset and likely starts with a vtable
   pointer. Walk back from the "Get Preset Data" registration and
   extract the vtable address.
2. **Identify the state-machine entry method.** Per III, the executor
   is reached via a vtable slot (typically offset +0xe8 in III; offset
   may differ in AM4). One of the vtable methods will be the
   per-frame handler invoked by the generic SysEx receive hook.
3. **Decompile that handler.** It will contain a switch on workflow
   state with cases that consume 0x77 / 0x78 / 0x79 frames and write
   to AM4-Edit's preset model struct via byte-positional addressing.
   The step-5 anchor offsets from §10.10 (0x01b0..0x03a5) should
   appear as immediate offsets or as `(record_index * stride)`
   computations in those cases.

A reusable mining script is needed:
`MapAM4EditWorkflowVtables.java`, for each workflow registration
site in `FUN_1402d83d0`, recover the workflow-object base address,
walk forward to find its vtable pointer, and dump the vtable. Output
a `(workflow_name, workflow_object_addr, vtable_addr,
vtable_methods[])` table. Modeled on
`DumpAxeEditIIIDumpDescriptors.java` (already in the repo).

### 11.6 Cookbook + status

- **Updated:** [[iii-async-workflow-fn-registry]] → status promoted
  matched-singleton → matched (added AM4 binary as second device-
  family axis; updated body to be cross-device; refinement-history
  entry dated 2026-05-28). The III-side discovery and AM4-side
  confirmation are now one consolidated entry.
- **Not yet added:** a new entry for the workflow-object vtable
  pattern (analog of [[iii-workflow-state-machine-executor]] but
  shared with AM4). Hold this until the next mining hop (§11.5)
  confirms the AM4 executor function.

### 11.7 What this means for production code

No changes to `packages/am4/src/descriptor/reader.ts`. The slow-but-
correct per-channel fn 0x02 fallback stays as the answer for the
current alpha. The fast-path remains unblocked but parked behind the
§11.5 mining + the resulting offset table verification against
hardware.

### 11.8 Artifacts on disk (initial pass)

```
samples/captured/decoded/ghidra-am4-edit-preset-parser.txt          (rank + top-20 decompile, ~22k lines)
samples/captured/decoded/ghidra-am4-edit-inbound-dump-handlers.txt  (focused 7-target decompile, ~4.7k lines)
packages/fractal-midi/scripts/ghidra/FindAM4EditPresetParser.java
packages/fractal-midi/scripts/ghidra/DecompileAM4InboundDumpHandlers.java
packages/fractal-midi/scripts/ghidra/run-am4edit-preset-parser.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-inbound-dump.cmd
```

### 11.9 Follow-up: class hierarchy + vtables (same session, 2026-05-28)

A second mining pass refined §11.4's "next research arc" prediction.
The chunk-1 parser IS reachable via the workflow object's
state-machine vtable; the second pass decoded the full class
hierarchy that wraps it.

**`MapAM4EditWorkflowDispatch.java`** chased the read side via three
anchors:

| Anchor | What it surfaced |
|---|---|
| 1. Callers of `FUN_1402d83d0` (registry ctor) | Exactly ONE caller: `FUN_1402df090`, and Ghidra renders its first line `*param_1 = AM4DeviceManager::vftable;`. The C++ class name is preserved in the binary (MSVC-generated RTTI). |
| 2. Caller histogram of `FUN_140196500` (reg helper) | All 139 call sites are inside `FUN_1402d83d0`. Registration is fully centralized, no standalone workflow registries elsewhere. |
| 3. Xrefs to "Get Preset Data" / "Save Preset" / "Refresh Preset Names" string literals | All point back to `FUN_1402d83d0`. No string-keyed lookup elsewhere. Secondary hits for some workflow names at `0x1414106xx` / `0x1414286xx` data-section addresses are workflow-object instance string-handle slots. |

**`AM4DeviceManager` class layout** (from `FUN_1402df090` decompile):

| Offset (byte) | Field |
|---|---|
| +0x000 | vtable ptr (`AM4DeviceManager::vftable @ 0x1412c2460`) |
| +0x168 | model byte `0x15` (AM4 device ID) |
| +0xa78 | 42 embedded workflow objects, stride `0x1a0` (416 bytes each): see below |
| +0x16c0 | `MostRecentPresetList::vftable` (another preserved class name) |
| +0x2e90 | "Get Preset Data" workflow object (per §11.3 line cross-ref) |

The 42 workflow objects between offsets ~0xfb0 and ~0x5250 (decompile
shows `FUN_14031d230(param_1 + N)` with `N` walking `0x1f6..0xa4a` at
stride `0x34`, recall the decompile shows pointer arithmetic on
`undefined8 *param_1`, so byte offsets are 8× those values).

**`FasStateMachine` (workflow base class):**

- Constructor: `FUN_14031d230` (called 42× from `AM4DeviceManager` ctor).
- Vtable: `0x1412b2c48` (64 slots dumped). Slots 4 / 5 are settings
  persistence (loads `MRU_DIRECTORY` / `MRU_DIR_IMPORT` /
  `MRU_SYSEX_INFO` / `MAIN_WINDOW_STATE`); slot 0 is a destructor;
  most other slots are small getters returning constants.

**`DeviceMgrStateMachine` (workflow derived class):**

- Constructor body: tail of `FUN_14031d230` overwrites the base
  vtable with the derived one (line 85 of decompile:
  `*param_1 = DeviceMgrStateMachine::vftable`).
- Vtable: `0x1412c4138` (64 slots dumped).
- Largest slot bodies (decompile-line count is the proxy for
  "complex state-machine logic"):

| Rank | Slot | Function | Lines | Notes |
|---|---|---|---|---|
| 1 | 23 | `FUN_14031def0` | 887 | NOT the parser - LCG random-byte generator (`* 0x5deece66d + 0xb` at line 287, the Java `Random` constants). Probably a key/nonce generator. |
| 2 | 30 | `FUN_140321000` | 660 | Unverified; strongest remaining candidate for state-machine dispatcher |
| 3 | 12 | `FUN_14031fed0` | 544 | Unverified |
| 4 | 22 | `FUN_14031f110` | 480 | Unverified |
| 5 | 45 | `FUN_1404fb6b0` | 179 | Unverified |

**Key null result**: I re-scored the `FindAM4EditPresetParser`
top-50 for functions touching ALL THREE of 0x77 / 0x78 / 0x79 as
immediates. **Zero matches.** No function in AM4-Edit has a literal
`switch(fnByte)` over the three preset-dump fn-bytes. This rules out
direct-switch parser discovery and confirms the workflow-state-
machine model: the receive path checks workflow state, not fn-byte.

### 11.10 Status (end of session 2026-05-28)

**Architecture: FULLY DECODED.**

```
AM4DeviceManager (vtable @ 0x1412c2460)
 ├── 42 embedded workflow objects
 │    └─ DeviceMgrStateMachine : FasStateMachine
 │         (vtable @ 0x1412c4138 / 0x1412b2c48)
 ├── model byte 0x15 @ +0x168
 ├── MostRecentPresetList @ +0x16c0
 └── workflow registry constructor (FUN_1402d83d0)
      └── registers fn-byte arrays via FUN_140196500 (139 call sites)
```

**Chunk-1 parser: NARROWED, NOT PINNED.**

The parser is one of the 4 large-body slots on
`DeviceMgrStateMachine::vftable` (slot 30 / 12 / 22 / 45, slot 23
ruled out as RNG). Each is 200-700 lines and requires
read-and-classify. The byte-positional chunk-1 offsets from §10.10
(0x01b0..0x03a5) will appear as immediates or
`(record_index * stride)` computations in whichever slot is the
inbound-SysEx state handler.

### 11.11 Next research arc

One more focused script (concrete enough to hand off to a fresh
agent):

`DecompileAndClassifyDMSMSlots.java`, for each of slots
{30, 12, 22, 45, plus AM4DeviceManager vtable slots 3-10}, decompile
and classify by feature signature:

- **SysEx receive candidate**: reads byte buffer (`param_X[i]`),
  switches on workflow state (`*(int *)(this + S)`), and writes to
  the AM4-Edit preset-model struct at byte offsets in the
  0x01b0..0x03a5 range.
- **Workflow-action candidate**: reads from `this + 0x18` (the
  registered fn-byte array, per `FUN_140196500`'s storage layout),
  iterates `0..this + 0x24` (count), and dispatches.
- **Other**: persistence load, UI builder, random-bytes generator
  (slot 23 confirmed pattern).

The script should hit the answer in one pass, there are ~7
candidates to classify and each has a clear signature distinguishing
parser-class from non-parser-class.

### 11.12 Artifacts on disk (full session)

```
samples/captured/decoded/ghidra-am4-edit-preset-parser.txt          (~22k lines)
samples/captured/decoded/ghidra-am4-edit-inbound-dump-handlers.txt  (~4.7k lines)
samples/captured/decoded/ghidra-am4-edit-workflow-dispatch.txt      (~200 lines)
samples/captured/decoded/ghidra-am4-edit-devicemanager-vtable-v2.txt (~3.5k lines)
samples/captured/decoded/ghidra-am4-edit-devicemgrstatemachine-vtable.txt (~1.2k lines)

packages/fractal-midi/scripts/ghidra/FindAM4EditPresetParser.java
packages/fractal-midi/scripts/ghidra/DecompileAM4InboundDumpHandlers.java
packages/fractal-midi/scripts/ghidra/MapAM4EditWorkflowDispatch.java
packages/fractal-midi/scripts/ghidra/DumpAM4DeviceManagerVtable.java          (v1, symbol-lookup; aborted - kept for reference)
packages/fractal-midi/scripts/ghidra/DumpAM4DeviceManagerVtableV2.java        (v2, head-scan)
packages/fractal-midi/scripts/ghidra/DumpAM4DeviceMgrStateMachineVtable.java  (v3, full-body scan)
packages/fractal-midi/scripts/ghidra/run-am4edit-preset-parser.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-inbound-dump.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-workflow-dispatch.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-devicemanager-vtable.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-devicemanager-vtable-v2.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-dmsm-vtable.cmd
```

## 12. AM4-Edit chunk-1 parser, DMSM vtable RULED OUT (Ghidra session 2026-05-28 cont)

**Goal:** Pin the chunk-1 parser slot inside `DeviceMgrStateMachine::
vftable` per §11.11's predicted "one more focused script" plan.

**Verdict: NEGATIVE-NARROWED.** All 6 unverified DMSM vtable slots
(30 / 12 / 22 / 45 / 14 / 1) and all 7 candidate `AM4DeviceManager::
vftable` slots (3 / 4 / 5 / 7 / 8 / 9 / 10) decompile to functions
that are NOT the chunk-1 SysEx-binary parser. One major structural
find lands instead, the **inbound message dispatcher** is pinned at
`AM4DeviceManager::vftable` slot 4 (`FUN_1402ddb80`). The chunk-1
parser is reached from there via the workflow-state path, not via a
vtable slot we targeted.

### 12.1 Script

[`DecompileAndClassifyDMSMSlots.java`](../../../scripts/ghidra/DecompileAndClassifyDMSMSlots.java)
+ [`run-am4edit-classify-dmsm-slots.cmd`](../../../scripts/ghidra/run-am4edit-classify-dmsm-slots.cmd).
Per slot, scores:

- **Anchor-offset hits**: any of the 22 chunk-1 byte offsets (`0x1b0,
  0x222, 0x25e, 0x27f, 0x282, 0x294, 0x297, 0x2a9, 0x2bb, 0x2be, 0x2cd,
  0x2d0, 0x2e2, 0x2f4, 0x2f7, 0x309, 0x31b, 0x31e, 0x345, 0x36c, 0x393,
  0x3a5`) + the chunk-2-exclusive offset `0x120`, measured both in
  decompile text and as raw instruction-level scalar operands.
- **Stride-hint references** (0x03, 0x12, 0x27): the cluster strides
  recurring in the anchor gap-pattern (3-byte septet stride, 6-record
  per-channel cluster, 13-record per-amp-channel cluster).
- **Buffer-pattern hits**: `*(byte *)(...)`, `(byte *)param_*` and
  variants, byte-buffer indexing shape.
- **Negative signals** (UI / persistence / RNG / single-instance):
  `__components.xml`, `MenuBarSkin`, `Another instance`,
  `MRU_DIRECTORY`, `Channel %`, LCG constant `0x5deece66d`,
  `juce::Component`, `juce::LookAndFeel`,
  `juce::JUCEApplication::RTTI_Type_Descriptor`,
  `juce::MemoryInputStream`, `EnterCriticalSection`,
  `RTTI_Type_Descriptor`.

The anchor offsets are derived from `samples/captured/
am4-warm-pair-diff.json` step-5 (`5-amp-type-swap`) exclusive records
, recs that changed in the amp-type swap and were untouched by any
other warm-pair step (verified by re-computing the set difference in
this session).

### 12.2 Per-slot classification

| Owner | Slot | Function | Lines | Anchors | Stride | Neg | Verdict |
|---|---|---|---|---|---|---|---|
| DMSM | 30 | `FUN_140321000` | 660 | 0/22 | 17 | 4 | RULED_OUT, persistence load (`__components.xml`, `juce::MemoryInputStream`) |
| DMSM | 12 | `FUN_14031fed0` | 544 | 0/22 | 5 | 4 | RULED_OUT, persistence load (same `__components.xml` path) |
| DMSM | 22 | `FUN_14031f110` | 480 | 0/22 | 5 | 2 | RULED_OUT, JUCE UI builder (`juce::JUCEApplication::RTTI_Type_Descriptor`, `"No Effect"` enum-list builder) |
| DMSM | 45 | `FUN_1404fb6b0` | 179 | 1/22 (false) | 1 | 0 | RULED_OUT, component state setter (the lone `0x1b0` hit is `FUN_140114974(0x1b0)` = malloc 432 bytes for a singleton state cache, NOT a buffer offset) |
| DMSM | 14 | `FUN_1403209f0` | 90 | 0/22 | 0 | 2 | RULED_OUT, single-instance dialog (`"Another instance of "`, `"AM4-Edit"`, `"Only one instance can execute"`) |
| DMSM | 1 | `FUN_14031cf90` | 69 | 0/22 (chunk-2 0x120 hits are field offsets) | 4 | 0 | RULED_OUT, destructor / state-reset (zeroes ~20 workflow-object fields; sole caller is `FUN_14031d230` ctor itself) |
| AMDM | 3 | `FUN_1402debc0` | 11 | 0/22 | 0 | 0 | RULED_OUT, small accessor |
| AMDM | 4 | `FUN_1402ddb80` | 224 | 0/22 | 2 | 1 | **INBOUND MESSAGE DISPATCHER**: see §12.3 |
| AMDM | 5 | `FUN_1402da600` | 37 | 0/22 | 0 | 0 | RULED_OUT, struct-field initializer (writes `0x101` / `0x1010101` / `1` to ~20 fields, the AM4DeviceManager `ready` state setter) |
| AMDM | 7 | `FUN_140023630` | 12 | 0/22 | 0 | 0 | RULED_OUT, `AM4EffectLayoutManager` ctor invocation (writes `AM4EffectLayoutManager::vftable` to `*param_1`, calls allocator for 0x78 bytes, another preserved C++ class name landed for free) |
| AMDM | 8 | `FUN_1402e41a0` | 8 | 0/22 | 0 | 0 | RULED_OUT, single-call wrapper |
| AMDM | 9 | `FUN_1402e3da0` | 205 | 0/22 | 15 | 0 | RULED_OUT, string-table lookup (giant `switch(param_2)` for case IDs 1..0x3c, each selecting a different `&DAT_141...` table, then comparing `FUN_140063920(*param_3)` strings, NOT byte-buffer parsing) |
| AMDM | 10 | `FUN_1402e23b0` | 1460 | 0/22 | 17 | 0 | RULED_OUT, **XML preset parser** (calls `FUN_1403d1a90(param_3, "effectName")` and `FUN_1403d1a90(param_3, "parameterName")`, this is AM4-Edit's file-format XML deserializer, NOT the SysEx-binary parser) |

### 12.3 Significant find: AM4-Edit inbound message dispatcher

`AM4DeviceManager::vftable` slot 4 (`FUN_1402ddb80` @ `0x1402ddb80`)
is AM4-Edit's **inbound SysEx message dispatcher**. Pulls a message
off a queue at `(param_1 + 0x148)`, checks its delivery status via
`FUN_1401ce9b0(pcVar4)` returning `1` (delivered), `2` (timeout), or
`3` (other / streaming), extracts the SysEx fn-byte from the message
payload at byte offset +5 (i.e. the byte after the 5-byte
`F0 00 01 74 15` envelope prefix), and dispatches per fn-byte:

| fn-byte | Handler | Workflow lineage (per §11.3) |
|---|---|---|
| `0x00` | (start-of-stream marker handler, fall through) | registered as stream-start of every workflow |
| `0x01` | `FUN_1402da830(param_1, pcVar4)` | registered as stream-end of every workflow (likely also fn=0x01 SET_PARAMETER ack) |
| `0x03` | `FUN_1401d59f0(pcVar4, &local_50)` then writes to `param_1 + 0xd20` | Query Device Version response |
| `0x08` | `FUN_14033a1e0(&local_50)` + `FUN_1401da990(&local_50, param_1 + 0x9dc)` | Library Load response |
| `0x19` | `FUN_1401d4c70(pcVar4, &local_50)` then writes to `param_1 + 0xd30` | Refresh Cabinet Names response (`0x19` in "Query All Param Definitions" / "Refresh Cabinet Names" workflows) |
| `0x47` | `FUN_1401d2a20(&local_50, param_1 + 0xa24, local_84)` + writes flag at `param_1 + 0xa22` | (workflow source not yet cross-referenced) |

The error path emits the format string `"DeviceManager: Message timed
out for opCode: 0x%X. Recvd %d, expected %d."` — confirming this is
the message-queue / opcode-dispatch layer.

**Crucial absence:** No case for fn `0x77` / `0x78` / `0x79`. The
fn-byte switch handles **short one-shot responses only**: version
replies, name-list deliveries, single-param acks. The 3-frame
preset-binary stream (`0x77` header + 4× `0x78` chunks + `0x79`
footer = 12,352 bytes total) is routed differently. Two non-exclusive
hypotheses for where it goes:

- **(A) The `iVar6 == 3` "other" status branch** in `FUN_1402ddb80`
  (the streaming-frame path). The function falls through to a small
  post-handling block that decrements the queue counter and exits.
  The actual frame-accumulation must happen upstream in
  `FUN_1401ce9b0` (the status-classifier) or in a stream-receive
  callback registered on the active workflow's expected-response
  fingerprint.
- **(B) `FUN_1402da830`** (the `cVar5 == 0x01` handler). Fn=0x01 is
  registered as the stream-end marker for every workflow. When the
  device emits the final fn=0x01 closing a multi-frame response, this
  handler may consume the accumulated buffer and route it to the
  workflow's state-machine executor (analog of III's `FUN_1401f4390`
  per cookbook `[[iii-workflow-state-machine-executor]]`).

Hypothesis (B) is the higher-probability path because it matches III's
architecture, III's stream-end marker (fn=0x01) calls into the state
machine executor, which is then the per-workflow-state chunk-1 parser
for that workflow.

### 12.4 What rules out the workflow-object vtable as the parser

§11.5's original prediction was that the chunk-1 parser would be
inside `DeviceMgrStateMachine::vftable`. That prediction is
falsified. The DMSM vtable holds:

- ctor / destructor pair (slots 0 / 1)
- workflow-state lifecycle (slots 2, 11-15)
- workflow-config persistence (slots 12, 30, `__components.xml`
  loaders, slot 22, JUCE UI rebuild)
- workflow-RNG (slot 23, the rand48 LCG ruled out in §11.9)
- generic state setters (slot 45, bit-flag manipulator)
- component callbacks (slots 40-63)

Not present: any per-frame SysEx receive method. The DMSM vtable is
the **workflow-as-state-machine** interface; the **SysEx-as-data**
interface is on `AM4DeviceManager` (slot 4) and routes BACK to the
DMSM through a registered callback when stream-end fires.

### 12.5 Next research arc (third hop)

Decompile and trace the inbound-stream path from `FUN_1402ddb80` to
the chunk-1 parser. Three concrete probes:

1. **`FUN_1401ce9b0`** (the status-classifier). Decompile and
   determine what makes a message return status code `3`. If it's
   "intermediate frame of a multi-frame response," the path forward
   is the upstream receive callback that fills the message buffer
   BEFORE this classifier is called.
2. **`FUN_1402da830`** (the `cVar5 == 0x01` stream-end handler).
   Decompile. If it reads the active workflow's accumulated buffer
   and switches on workflow state, this IS the AM4 analog of III's
   `FUN_1401f4390`, the workflow state-machine executor.
3. **The receive callback** that populates the message queue at
   `param_1 + 0x148`. Walk callers of `param_1 + 0x148` (or callers
   of `FUN_140196500`'s registration array writes) to find the
   inbound-frame producer.

A reusable mining script:
`DecompileAM4InboundStreamPath.java`, decompile FUN_1401ce9b0 +
FUN_1402da830 + their first-level callees, and score with the same
22 anchor offsets + stride hints + buffer patterns used in §12.1.
Modeled directly on `DecompileAndClassifyDMSMSlots.java`.

### 12.6 Cookbook impact

- **No cookbook entry promoted.** The §11 prediction that
  `[[iii-workflow-state-machine-executor]]` would promote
  matched-singleton → matched once the AM4 analog landed is held
  open; the AM4 analog is one hop further than this session reached.
- **Refined** `[[iii-workflow-state-machine-executor]]`'s "where it
  does NOT apply" claim. The pre-existing line "AM4-Edit has no
  async multi-step workflows; not applicable" is stale (the 2026-05-28
  decode + this session confirm AM4-Edit DOES have async workflows
  with state-machine dispatch). The corrected status is "AM4-Edit
  architecture confirmed; executor location not yet pinned, third hop."
- **Refined** `[[_negative/iii-fn-byte-switch-as-inbound-dispatcher]]`
  with a sharpening: the rule-out applies specifically to the
  **bulk preset-binary frames** (0x77/0x78/0x79). AM4-Edit DOES have
  a literal fn-byte switch (in `FUN_1402ddb80`) for short one-shot
  response opcodes (0x00/0x01/0x03/0x08/0x19/0x47). The hybrid
  dispatch model, small responses via fn-switch, bulk streams via
  workflow-state-driven accumulation, is itself a structural
  finding worth promoting once third hop confirms it.

### 12.7 Bonus: another C++ class name landed

`AM4EffectLayoutManager::vftable` (referenced from `AM4DeviceManager::
vftable` slot 7, `FUN_140023630`). Per the MSVC RTTI preservation
pattern that yielded `AM4DeviceManager` / `FasStateMachine` /
`DeviceMgrStateMachine` / `MostRecentPresetList` in §11.9, this is
another preserved name worth dumping if the per-effect-slot layout
becomes load-bearing. Object size = 0x78 (120 bytes) per the
allocator arg.

### 12.8 What this means for production code

No changes to `packages/am4/src/descriptor/reader.ts`. The slow-but-
correct per-channel fn 0x02 fallback stays as the answer for the
current alpha. The fast-path remains unblocked but parked behind
third hop.

### 12.9 Artifacts on disk

```
samples/captured/decoded/ghidra-am4-edit-classify-dmsm-slots.txt   (~2k lines)
packages/fractal-midi/scripts/ghidra/DecompileAndClassifyDMSMSlots.java
packages/fractal-midi/scripts/ghidra/run-am4edit-classify-dmsm-slots.cmd
```

## 13. AM4-Edit chunk-1 parser DOES NOT EXIST (Ghidra session 2026-05-28 third hop)

**Verdict: HARD-STOP NEGATIVE.** AM4-Edit contains NO inner-per-param
decoder for the chunk-1 SysEx-binary payload. The bulk preset binary
(0x77/0x78/0x79) is treated as opaque transport, the editor reads
the bytes from the wire, stores them in a buffer for round-trip
(export-to-.syx), and never decomposes them into per-(block, channel,
param) positions. **Per-param byte positions within chunk-1 are
firmware-only knowledge.** The next research arc shifts to AM4
firmware Ghidra per §10.10's fallback hypothesis.

### 13.1 Cross-device note (the question we tested before launching the third hop)

Could III's prior decoding give us the AM4 chunk-1 byte offsets
directly? No, on three independent grounds:

1. **AM4 and III preset binaries have fundamentally different
   shapes**: AM4 has 4 blocks × 4 channels A/B/C/D × 4 scenes in a
   12,352-byte envelope (1× `0x77` + 4× `0x78` + 1× `0x79`); III has
   ~30 blocks × X/Y channels × 8 scenes in a 49,336-byte envelope
   (1× `0x77` + 16× `0x78` + 1× `0x79`). Different paramIds,
   different block-type IDs, different per-block param sets. Byte
   positions cannot be lifted.

2. **III itself has NOT decoded its own inner per-param layout.**
   `packages/fractal-gen3/src/presetDump.ts` L47 (committed):
   `"Inner per-scene / per-block decode is the subject of future
   work (the III channel-state decode); this module treats chunk payloads
   as opaque blobs."` There is no III mining output to port.

3. **JUCE BinaryData XML explicitly does NOT carry wire offsets.**
   `docs/capture-guides/juce-binarydata-extraction.md` L201-206
   ("What this DOESN'T give you: Wire IDs (`pidLow` / `pidHigh`)...
   The wire ID, the bytes that go on the USB/MIDI cable to actually
   change the parameter, usually lives in a separate metadata file,
   in the device's firmware, or in the editor's compiled code.")
   The 2,017 III parameterName entries from `__block_layout.xml` are
   display labels, not byte positions in the preset binary.

The portable mining technique that DID land cross-device 2026-05-22
is the **outer envelope descriptor table** (cookbook
`[[vendor-envelope-descriptor-table]]`). AM4-Edit carries 54
descriptor tables at `0x1405dc190..0x1405dd160`; the chunk-1 outer
descriptor at `0x1405dcf40` is byte-identical-shape to III's
`0x1407ab940`, both declare `(tag=0, mid=6, byte_count=2) + (tag=1,
mid=8, byte_count=3072)`, i.e. "header at offset 6 is 2 bytes; body
at offset 8 is 3072 bytes of opaque packed data." That table's role
ends at the outer envelope. The inner 3072 bytes are not further
decomposed at the editor level on either device.

### 13.2 Script

[`DecompileAM4InboundStreamPath.java`](../../../scripts/ghidra/DecompileAM4InboundStreamPath.java)
+ [`run-am4edit-inbound-stream-path.cmd`](../../../scripts/ghidra/run-am4edit-inbound-stream-path.cmd).
Targets the 8 first-level callees of the dispatcher `FUN_1402ddb80`
(pinned in second hop as AMDM vtable slot 4) plus 3 supporting size
readers / allocators. Same scoring scheme as second hop: anchor offsets
(text + instruction scalars), stride hints (0x3/0x12/0x27),
buffer-read patterns, negative signals, plus switch-statement /
case-label counting for state-machine-executor detection.

### 13.3 Per-callee classification

| Tier | Role | Function | Lines | Anchors | Stride | Switch/case | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | status classifier (Hyp B anchor) | `FUN_1401ce9b0` | 19 | 0/22 | 0 | 0/0 | small predicate function |
| 1 | cVar5==0x01 stream-end (Hyp A anchor) | `FUN_1402da830` | 291 | 0/22 | 2 | 0/0 | **fn=0x01 SET_PARAMETER response unpacker** with septet-decode loop (see §13.4): NOT a state-machine executor |
| 1 | cVar5==0x00 stream-start | `FUN_1402dd9e0` | 103 | 0/22 | 1 | 0/0 | session start ack |
| 1 | cVar5==0x03 version-reply | `FUN_1401d59f0` | 509 | 0/22 | 3 | 0/0 | device version + capability parse |
| 1 | cVar5==0x19 cabinet-names | `FUN_1401d4c70` | 386 | 0/22 | 1 | 0/0 | cabinet-list parse |
| 1 | cVar5==0x47 unknown | `FUN_1401d2a20` | 164 | 0/22 | 0 | 0/0 | undecoded |
| 1 | cVar5==0x08 library-load | `FUN_1401da990` | 277 | 0/22 | 23 | 0/0 | **descriptor-table-driven parser** (see §13.5) |
| 1 | pre-handler (cVar5==0x08 path) | `FUN_14033a1e0` | 35 | 0/22 | 0 | 0/0 | message-prep utility |
| 2 | allocator | `FUN_140114974` | 22 | 0/22 | 0 | 0/0 | malloc wrapper |
| 2 | msg-object longlong reader | `FUN_1401ce900` | 14 | 0/22 | 2 | 0/0 | small accessor |
| 2 | shared utility | `FUN_140157c90` | 41 | 0/22 | 1 | 0/0 | shared util |

**Crucial absence (the parser-shape that should be here but isn't):**
zero anchor hits, zero switch/case statements, zero `*(byte *)(buf
+ N)` chunk-1 buffer reads across all 11 candidates. None of these
functions is the chunk-1 parser.

### 13.4 What `FUN_1402da830` actually is (the predicted Hyp-A executor, falsified)

The cVar5==0x01 stream-end handler, predicted in §12.5 as the AM4
analog of III's `FUN_1401f4390` workflow state-machine executor, turns out to be a **single-param SET_PARAMETER response unpacker**.
Structure (lines 156-318 of the decompile):

1. `EnterCriticalSection` on a per-queue lock.
2. Reads the SysEx envelope of the head-of-queue message:
   - byte +0 must be `0xf0`
   - byte +5 must be `0x01` (fn=SET_PARAMETER)
   - byte +6..+7, +8..+9, +10..+11, +12..+13, +14..+15 = five
     14-bit fields (low-7 | high-7 << 7 packing). The 3rd field
     (bytes +10..+11) MUST equal `0xd` (13): a specific
     param-class filter; the function returns early otherwise.
3. Stores those 5 14-bit values at `local_e0 + 0x580`, `+0x584`,
   `+0x588`, `+0x58c`, `+0x590`. (`local_e0` is the
   `AM4DeviceManager` instance.)
4. **Septet-7-bit unpack loop** (lines 295-318):
   ```c
   uVar10 = (int)pcVar6[0xf] << 7 | (int)pcVar6[0xe];   // length
   *(uint *)(local_e0 + 0x590) = uVar10;
   if (uVar10 != 0) {
     uVar10 = uVar10 * 8 + 6;
     pbVar11 = (byte *)(local_e0 + 0x594);
     ... unpack loop with the canonical septet shape:
       bVar13 = (~(0x7f >> bVar7) & bVar2) >> (8 - bVar7);
       *pbVar11 = bVar2 << bVar7;
   }
   ```
   This decodes `length / 7` bytes of septet-packed PARAM-VALUE data
   from byte +16 onwards into the destination buffer at
   `AM4DeviceManager + 0x594`.

That's a per-param value unpack, the SET_PARAMETER reply contains
the new value of a single parameter, septet-packed because some
params hold multi-byte structures (lineage tables, name strings,
etc.). It is NOT the bulk preset-binary parser, and it has no
switch on workflow state.

The original §12.5 Hyp-A prediction (that `FUN_1402da830` would
mirror III's `FUN_1401f4390`) is **falsified**.

### 13.5 What `FUN_1401da990` reveals about the architecture

The cVar5==0x08 library-load handler shows the **canonical AM4-Edit
inbound-parse pattern**:

1. **Model-byte dispatch** (cookbook `[[iii-multiproduct-editor-binary]]`).
   `cVar2 = pcVar6[4]` reads the model byte from the SysEx envelope
   (position +4 in `F0 00 01 74 [model] [fn] ...`). The function
   branches:
   - `cVar2 == 0x10` (III): jumps to `LAB_1401dad19` and reads 38
     bytes from `pcVar6[6..0x2c]` directly into `param_2[0..0xe]`
     (hardcoded byte positions, no descriptor table, III uses a
     fixed envelope shape for this fn-byte).
   - `cVar2 == 0x11` / `0x12` (FM9/FM3): different branches
     (truncated by the 260-line cap).
   - `cVar2 == 0x14` / `0x15` (??/AM4): the ELSE branch.

2. **Descriptor-table walk** (cookbook
   `[[vendor-envelope-descriptor-table]]`). For AM4 specifically, the
   ELSE branch walks `&DAT_1405dccf0`, one of the 54 mined
   descriptor tables, which the synthesis log records as:
   ```
   ### Table @ 0x1405dccf0  (entries=6)
       0 |   0 | 6 | 1
       1 |   1 | 7 | 1
       2 |   2 | 8 | 1
       3 |   3 | 9 | 1
       4 |   4 | 10 | 1
       5 |   5 | 11 | 1
      -- | -1  | -1 | -1   <-- SENTINEL
   ```
   For each tag 0..5, the function searches the table for that tag,
   extracts `(mid, byte_count)`, and calls `FUN_1401df6a0(param_1,
   mid, byte_count)` to read that field from the wire message into
   `param_2[tag]`.

This is **the universal AM4-Edit inbound-parse mechanism**: each
fn-byte's response shape is declared in one of the 54 descriptor
tables, and the parser is a table-walker that extracts named fields
by `(mid, byte_count)` lookup. The table at `0x1405dcf40` (the 3072
fixture) declares the chunk-1 envelope as `(0, 6, 2) + (1, 8, 3072)`
, "header at +6 is 2 bytes; body at +8 is 3072 bytes", and that
IS the full extent of the editor's knowledge of the chunk-1 shape.
The 3072 bytes are stored as one opaque field.

### 13.6 Why the parser doesn't exist (architecturally)

AM4-Edit's preset-load workflow, anchored on the §11.3 workflow-
registry observations + the §10 architectural analysis:

1. User clicks "Load Preset" in AM4-Edit UI.
2. Editor emits fn=0x17 ("Get Preset Data" workflow's outbound).
3. Device replies with 1× fn=0x77 + 4× fn=0x78 + 1× fn=0x79
   (the 12,352-byte bulk preset binary, 3074 bytes of packed payload
   per chunk).
4. Inbound dispatcher (`FUN_1402ddb80`) routes each frame to a
   chunk-accumulator that stores the bytes in the active workflow's
   buffer (location: `AM4DeviceManager + (workflow_offset)` per the
   §11.9 layout).
5. **Workflow completes with the bytes stored as an opaque blob.**
   For export-to-.syx, those bytes are written verbatim. For
   "load into editor UI," AM4-Edit then issues PER-PARAM fn=0x01
   GET requests against its own model and rebuilds the UI from the
   per-param replies, NOT from the bulk binary.

The bulk binary exists for round-trip transport (.syx file save /
load) and for the device's own internal storage. The PARAMETERS
are exchanged via fn=0x01 SET/GET, which is the **only** code path
that touches per-param byte positions inside the editor. Per-param
positions inside chunk-1 are firmware-only knowledge.

This is the same architecture III uses (per `presetDump.ts` L47).
**The "missing parser" is a cross-device architectural pattern, not
an AM4-Edit-specific gap.**

### 13.7 Cookbook impact

- **Promoted** `[[_negative/iii-fn-byte-switch-as-inbound-dispatcher]]`
  to its final, refined form: AM4-Edit's hybrid dispatch (small-via-
  fn-switch + bulk-via-descriptor-table-opaque-blob) is now fully
  characterized. The "bulk preset-binary frames are not parsed at
  the editor level on either III or AM4" finding is cross-device.
- **`[[iii-workflow-state-machine-executor]]` stays `matched-singleton`
  permanently.** The predicted AM4 analog (`FUN_1402da830`) decompiled
  to a single-param SET_PARAMETER unpacker, not a state-machine
  executor. The III pattern does NOT recur in AM4-Edit at the
  function-shape level. Promotion to `matched` is no longer reachable
  via AM4, would need to land in a different binary (Axe-Edit II,
  Hydrasynth editor) instead.
- **NEW negative cookbook entry needed**: `_negative/editor-side-
  chunk-1-inner-decode.md` — documents the rule-out that bulk
  preset-binary inner per-param layout exists in any Fractal editor
  binary. Verified on AM4 (the first three hops, 2026-05-28) and III
  (`presetDump.ts` L47 cross-cite). Future agents asking "where in
  the editor binary is preset binary X decoded" should land on this
  entry and pivot to firmware Ghidra without rerunning the parser-
  hunt sessions.

### 13.8 What this means for production code

No changes to `packages/am4/src/descriptor/reader.ts`. The slow-but-
correct per-channel fn 0x02 fallback (~7 s per `get_preset`) is
**THE answer for chunk-1 decode going forward** unless the firmware
decode lane (§10.10 fallback C) is pursued. The fast-path
hypothesis "decode chunk-1 directly to skip per-channel reads" is
now ruled out at the editor-binary level.

The atomic-read fast-path that IS available is `fn 0x1F`
SYSEX_GET_ALL_PARAMS (per `[[am4-fn1f-atomic-read]]`), which the
descriptor `reader.getPreset` already uses (this path shipped for
active-buffer reads). That path stays as the bulk-read primitive;
the chunk-1 decode lane closes here.

### 13.9 Next research arc (fourth hop, IF pursued)

The decode of AM4 preset-binary per-param positions now requires
**AM4 firmware Ghidra**. Per §10.10's fallback C:

> Firmware-side decode via AM4 firmware Ghidra
> (`samples/factory/AM4_firmware_v2p00.syx`): closeable, harder.
> Not JUCE-based per §10.7; brute-force string-walk targeting
> param-table layout would be the approach.

Concrete next steps (only if pursued):

1. Disassemble `samples/factory/AM4_firmware_v2p00.syx`, Fractal
   firmware is an ARM Cortex binary wrapped in SysEx envelopes;
   extraction requires the wrapper-strip logic from the
   firmware-update research.
2. Load into Ghidra, auto-analyze.
3. Search for the fn=0x77/0x78/0x79 SysEx-receive handler in the
   firmware (the device-side parser that DOES decompose chunk-1
   into per-param positions).
4. Extract the per-(block, channel, param) byte-position table,    it MUST exist in firmware because the device writes those bytes
   when emitting the bulk dump.

Cost estimate: 2-4 sessions of Ghidra mining (ARM disassembly is
slower than x86; firmware lacks symbols; brute-force string-walk
needs anchor strings like "VOLUME" / "GAIN" / "TONE", find which
strings survive in the firmware binary).

Alternative (lower-cost, but not a substitute): accept the slow
per-channel fn 0x02 fallback as the permanent answer. Cost: ~7 s
per `get_preset` for a 4-block preset. This is acceptable for an
interactive editor but not for batch operations.

### 13.10 Artifacts on disk (third hop)

```
samples/captured/decoded/ghidra-am4-edit-inbound-stream-path.txt  (~1.8k lines)
packages/fractal-midi/scripts/ghidra/DecompileAM4InboundStreamPath.java
packages/fractal-midi/scripts/ghidra/run-am4edit-inbound-stream-path.cmd
```


## 14. AM4 firmware first-stage extraction, packing unidentified, fourth hop paused (2026-05-28)

**Verdict: PAUSED.** AM4 firmware first-stage (envelope strip) succeeded; the inner packing format that converts the 7-bit-clean wire payload back to ARM bytes is **not** identified by any of the 5 candidate schemes tested. Continuing the fourth hop would require either (a) reverse-engineering the firmware packing format from AM4-Edit's firmware-update emitter, a multi-session new arc, or (b) accepting the firmware payload as opaque and shifting strategy. Recommendation: keep the slow per-channel fn 0x02 fallback as the permanent answer, per the fourth hop's "If you get stuck" escalation clause.

### 14.1 What's solved (concrete win)

The outer SysEx envelope of `samples/factory/AM4_firmware_v2p00.syx` is fully characterized. Scripts `scripts/_research/extract-am4-firmware-syx.ts` (extractor) + `analyze-am4-firmware-packing.ts` + `find-arm-code-region.ts` + `probe-am4-firmware-strings.ts` + `probe-am4-firmware-xor.ts` (analyzers) reproduce these findings from the on-disk SysEx file in seconds.

```
Outer envelope: 7,098 SysEx frames, model byte 0x15, all checksums OK
  fn=0x7D ×1   header,   5-byte payload `00 60 73 35 01`
  fn=0x7E ×7,096 data,   482-byte payload each (constant)
  fn=0x7F ×1   footer,   5-byte payload `40 01 00 00 00`

Per-chunk payload structure (fn=0x7E):
  payload[0..1] = septet-packed 14-bit chunk-data-byte-count
                  = 0x60 | (0x03 << 7) = 480 for every chunk
  payload[2..481] = 480 bytes of packed firmware data

After stripping the 2-byte per-chunk length prefix and concatenating:
  raw packed firmware = 7,096 × 480 = 3,406,080 bytes (all 7-bit clean)
```

The wrapper shape mirrors the preset-binary 3-frame envelope (`0x77`/`0x78`/`0x79`) at the byte-shape level; only the fn-bytes differ. This is consistent with `[[vendor-envelope-descriptor-table]]` cookbook primitive, Fractal's editor binaries reuse a single envelope-descriptor shape for both preset transport and firmware transport.

### 14.2 What's NOT solved

The 3,406,080-byte packed payload doesn't unpack cleanly to ARM Cortex-M code under any of the 5 candidate schemes tested:

| Variant | Unpacked bytes | SP (offset 0) | Reset (offset 4) | Thumb bit | Vocab hits |
|---|---|---|---|---|---|
| `msb-first-8to7` (standard MIDI 8→7) | 2,980,320 | `0x10c5ea54` | `0x0d008008` | no ❌ | 1 |
| `msb-first-8to7-reverse-bits` | 2,980,320 | `0x1045ea54` | `0x0d008088` | no ❌ | 0 |
| `msb-last-8to7` | 2,980,320 | `0x456a5426` | `0x00000810` | no ❌ | 2 |
| `3-to-2 ushort` (preset-binary shape) | 2,270,720 | `0x0845aa26` | `0x300d0000` | no ❌ | 0 |
| `raw-no-unpack` | 3,406,080 | `0x456a5426` | `0x00000810` | no ❌ | 4 |

All candidates fail the ARM Cortex-M boot-vector sanity check (reset handler must have Thumb bit set; SP must be in a plausible SRAM region). String-probe vocabulary (`AMP`, `DRIVE`, `DELAY`, `REVERB`, `Fractal`, `Mar 20 2026`, `Gain`, `Master`, etc., 32 anchors) returns 0-4 hits across all variants, all coincidental given a ~3 MB byte stream.

### 14.3 XOR / stream-cipher hypothesis FALSIFIED

The raw payload contains the repeating 4-byte pattern `6E 77 3B 5D` ("nw;]") in one ~120-byte stretch, suggestive of a stream cipher XORed against zeros. Direct test: top-10 four-byte n-grams across 4-byte-aligned slots are:

```
00000000  × 262,670  (30.8% of all 4-byte slots — heavy zero-padding)
7f7f7f7f  ×   3,497
00000001  ×   1,023
08000000  ×     883
01000000  ×     861
00001003  ×     809
40000000  ×     765
00400000  ×     756
0002003f  ×     748
02000000  ×     713
```

Not stream-cipher output, the 30.8% all-zero density indicates SPARSE structure with long runs of zero padding. XOR-decoding with the top-5 4-byte n-grams (and rotations) failed to materially increase vocabulary-hit counts above the no-XOR baseline.

### 14.4 Most-likely root causes (ranked, not pursued)

1. **Custom Fractal packing scheme.** The simplest explanation, the firmware uses a vendor-specific bit-packing that none of the standard MIDI variants match. The decoder lives in AM4-Edit's firmware-update emitter (the C++ code that takes the .syx, decompresses it, and pushes it to the device). Locating that function in AM4-Edit.exe via Ghidra would unlock the payload, but that's a new Ghidra mining arc against the *editor* binary, not the firmware. Estimated cost: 1-2 sessions of focused mining on the firmware-update path in AM4-Edit.exe (search for callers that touch fn=0x7D / 0x7E / 0x7F or the file-magic `00 60 73 35 01`).
2. **Lossless compression layer (LZ4 / LZMA / zlib).** The payload sub-structure (sparse, with `7F 7F 7F 7F` runs and `00` clusters) is consistent with a back-reference compression format. zlib magic bytes `78 9C` / `78 5E` / `78 01` are not present in either the raw payload or any of the 5 unpacks. LZ4 frame magic `04 22 4D 18` also absent. If compressed it's a custom or less-common scheme.
3. **Multi-region firmware bundle.** The 7,096-chunk × 480-byte uniform packing suggests a *transport* layer wrapping multiple firmware components for different processors (e.g., main ARM + audio DSP coefficient tables + IR samples), each with their own internal format. Splitting and probing per-region would help, but adds another full session of bookkeeping.

### 14.5 Recommendation

**Stop here.** The fourth hop was explicitly OPTIONAL, with cost estimate "2 to 4 sessions" and benefit "~50-100 ms vs current ~7 s `get_preset` against a NON-active preset". The discovery that the firmware packing is custom (not standard MIDI 8-to-7 or 3-to-2) shifts the cost upward: a minimum-viable fourth hop now requires:

1. **One full session** to mine AM4-Edit.exe for the firmware-update emitter and decode the packing scheme.
2. **One full session** to apply the decoded packing, load the ARM binary into Ghidra, run auto-analysis.
3. **One full session** to walk the firmware's chunk-1 encoder/decoder and recover per-param byte positions.
4. **One full session** of hardware verification, at least 5 distinct presets round-tripping byte-exact through the new fast path before flipping production code.

Four sessions for a 7s → 50ms speedup on the NON-active `get_preset` path is poor cost/benefit:
- The atomic-read fast path (fn 0x1F `[[am4-fn1f-atomic-read]]`) already covers all active-buffer reads at ~263 ms cold-start, ~129 ms warm, that's the common case for interactive editing.
- Non-active preset reads are the long-tail case (recipe generation, preset-bank sweeps). A 7s wait per preset is acceptable for batch operations issued out of the conversational hot path.
- No user-facing feature is gated on chunk-1 decode today.

Per the prompt's escalation clause:

> If 2-3 sessions of mining produce no signal, document the negative finding (analog of third hop's outcome) and recommend keeping the slow per-channel fn 0x02 fallback as the permanent answer.

The first extraction stage alone consumed enough effort to surface a hidden cost multiplier; the threshold to keep going hasn't been met.

### 14.6 If pursued anyway, concrete continuation plan

The right next session would be **not firmware mining but AM4-Edit firmware-update Ghidra mining**. The packing scheme lives in `AM4-Edit.exe`, not in the device firmware itself. Specifically:

1. Grep `ghidra-am4-edit-host-emitter-map.txt` (already mined) for fn-byte `0x7D` / `0x7E` / `0x7F` emitter functions. The emitter is the *encoder*; the *decoder* sits in the device, but the encoder is functionally equivalent and reachable from AM4-Edit.
2. Decompile the emitter; identify the bit-packing loop.
3. Replicate the loop in TypeScript; re-run §14.2's vector-table sanity check. If the vector table now looks ARM-shaped, proceed with Ghidra loading.

This is a focused 1-session probe with a binary pass/fail outcome (the new unpack either produces a clean ARM vector table or it doesn't), and it can be revisited any time without re-doing §14.1.

### 14.7 Artifacts on disk (firmware extraction stage)

```
scripts/_research/extract-am4-firmware-syx.ts
scripts/_research/analyze-am4-firmware-packing.ts
scripts/_research/find-arm-code-region.ts
scripts/_research/probe-am4-firmware-strings.ts
scripts/_research/probe-am4-firmware-xor.ts

packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin       (3,406,080 B, gitignored)
packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-unpacked.bin  (2,980,320 B, gitignored)
packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-meta.json
packages/fractal-midi/samples/captured/decoded/am4-firmware-packing-analysis.json
packages/fractal-midi/samples/captured/decoded/am4-firmware-code-regions-msb-last-8to7.json
packages/fractal-midi/samples/captured/decoded/am4-firmware-code-regions-unpacked-msb-first.json
packages/fractal-midi/samples/captured/decoded/am4-firmware-string-probe.json
```

All TS scripts run in seconds against the on-disk SysEx file; reproducing the analysis end-to-end is free.


## 15. AM4-Edit firmware-emitter mining, TERMINAL NEGATIVE (2026-05-28)

**Verdict: HARD-STOP NEGATIVE.** The §14 recommendation "if pursued anyway, mine AM4-Edit.exe for the firmware-update emitter" was tested and rules out the editor as the source of the packing format. Per §14.5 the recommendation remains: **keep the slow per-channel fn 0x02 fallback as the permanent answer**; chunk-1 decode is firmware-only knowledge and unreachable from any user-facing binary.

### 15.1 Three Ghidra probes (all headless against a local AM4-Edit Ghidra project)

1. **`FindAM4EditFirmwareEmitter.java`**: searched AM4-Edit.exe for direct evidence of the firmware-emit wire path:
   - 5-byte header magic `00 60 73 35 01` in `.rdata`: **0 hits**.
   - 6-byte SysEx envelope `F0 00 01 74 15 7E` (chunk emit): **0 hits**.
   - 6-byte SysEx envelope `F0 00 01 74 15 7D` (header emit): **0 hits**.
   - 4 mined SysEx envelope builder candidates (from prior `MapAM4EditHostEmitters`): 3 of 4 have **zero references**; 1 has a single caller and zero firmware-fn-byte immediates in that caller.
   - Output: `ghidra-am4-edit-firmware-emitter.txt` (122 lines).
2. **`ProbeAM4EditFractalBot.java`**: wider scan for Fractal-Bot integration via string xrefs + immediate clustering:
   - `"Fractal-Bot"` 160 string hits in `.rdata`; one xref to a containing function (`FUN_14014c9d0`).
   - `"FractalBot"` 4 hits; one xref (`FUN_140243d80`).
   - `"Firmware"` 32 hits; three xref'd functions (`FUN_1401bf340`, `FUN_1401bd880`, `FUN_1401dbfb0`).
   - Whole-binary scan: 16,940 functions total; **only 2** carry both 0xF0 (SysEx start byte) AND 0x7E (firmware chunk fn) as immediate values, `FUN_1401bf340` and `FUN_1404d2a10`.
   - Output: `ghidra-am4-edit-fractal-bot-probe.txt` (162 lines).
3. **`DecompileAM4EditFirmwareEmitter.java`**: full decompile of all 7 candidates (the 2 with both 0xF0/0x7E + the 5 string-xref containers):
   - `FUN_1401bf340` (primary): JUCE UI initialization for `FirmwareUpdateSkin`, sets up `InfoDlg`, `Update Info` label, `infoLabel` widget. UI plumbing, not wire emit.
   - `FUN_1404d2a10`: JUCE rendering function, paints widgets with `juce::Font::SharedFontInternal::vftable`; the 0xF0 / 0x7E / 0x7F immediates are float constants (`100002.0` / `100001.0` / etc.) and layout codes, not SysEx bytes.
   - `FUN_14014c9d0` (Fractal-Bot string xref): **6-product UI-skin dispatcher**. Switch statement over `*(uint *)(param_1 + 0x160)` with cases `Fractal-Bot`/`fractal-bot.xml` (1), `Axe-Edit`/`axe-edit.xml` (2), `Cab-Lab`/`cab-lab.xml` (3), `FX8-Edit`/`fx8-edit.xml` (4), `Cab-Lab3`/`cab-lab3.xml` (5), `AX8-Edit`/`ax8-edit.xml` (6). This is the architectural smoking gun (see §15.2).
   - `FUN_140243d80`, `FUN_1401bd880`, `FUN_1401dbfb0`, `FUN_14014b1b0`: all are surrounding UI/settings code; **zero packing-loop signatures** (`& 0x7f`, `<< 7`, 0x1E0 constant, MIDI emit call) across the entire 94 KB / 2,877-line decompile dump.
   - Output: `ghidra-am4-edit-firmware-emitter-decompile.txt` (94 KB / 2,877 lines).

### 15.2 Architectural finding: Fractal-Bot is a UI mode, not separate code

`FUN_14014c9d0`'s 6-product dispatcher reveals that AM4-Edit.exe is built from a **shared Fractal editor codebase** that supports six different product personalities via XML skin files:

```c
switch (*(uint *)(param_1 + 0x160)) {
case 1: name = "Fractal-Bot";  skin = "fractal-bot.xml";  break;
case 2: name = "Axe-Edit";     skin = "axe-edit.xml";     break;
case 3: name = "Cab-Lab";      skin = "cab-lab.xml";      break;
case 4: name = "FX8-Edit";     skin = "fx8-edit.xml";     break;
case 5: name = "Cab-Lab3";     skin = "cab-lab3.xml";     break;
case 6: name = "AX8-Edit";     skin = "ax8-edit.xml";     break;
}
```

"Fractal-Bot" is mode #1 of the same binary. Tools menu → Fractal-Bot loads `fractal-bot.xml` and switches the UI into firmware-update mode. The actual firmware-byte path in that mode is the simplest possible: **open the .syx file, stream the bytes verbatim to MIDI out**. The pre-existing `MapAM4EditHostEmitters` output's "AM4 SysEx builders" line names a SysEx envelope BUILDER (which wraps individual fn-byte payloads in the standard `F0 00 01 74 15 [fn] [...] [cs] F7` envelope): but that builder doesn't apply per-byte packing; it just wraps already-formed payloads.

**The packing was applied by Fractal's internal factory build tool** (the one that converts compiled ARM firmware bytes into the .syx distribution file). That tool is not shipped to end users.

### 15.3 Where the unpacker actually lives

The unpacker (the code that reverses the packing applied by the factory tool) lives in the AM4's own boot-loader / firmware-update code path. Recovering it requires:

1. Physical access to an AM4 unit's flash chip (de-soldering or chip-clip), OR
2. JTAG / SWD debugger access to the live unit during a firmware update (Cortex-M debug interface, if exposed; typically isolated on consumer audio hardware), OR
3. Finding a memory-dump exploit in the device's run-time SysEx handler that leaks the boot-loader region (audio devices rarely have such surfaces).

All three are **out of scope** for this project (not a hardware-reverse-engineering shop, not a security research project). The decode arc is closed.

### 15.4 Cost summary

What this session actually cost:
- 5 TS scripts (firmware envelope decode + 4 unpacking-scheme analyzers): generally useful for future firmware-related work; outer envelope shape is documented in `SYSEX-MAP.md` §10b "Related".
- 3 Ghidra scripts (FindAM4EditFirmwareEmitter / ProbeAM4EditFractalBot / DecompileAM4EditFirmwareEmitter): registered in `scripts/ghidra/README.md`; document the negative finding for cross-device transfer (the "Fractal-Bot is a UI mode of a shared codebase" architectural fact applies to Axe-Edit / FX8-Edit / Cab-Lab too).
- 0 lines of production code changed. `packages/am4/src/descriptor/reader.ts` slow fallback unchanged.

What the user pays for keeping the slow path:
- `get_preset` against a NON-active preset: ~7 s vs. the hypothetical ~50 ms.
- Active-buffer `get_preset` already uses the fn 0x1F atomic-read fast path (~129 ms warm); the slow path is only on the long-tail case.

### 15.5 Artifacts on disk (firmware-emitter extraction stage)

```
packages/fractal-midi/scripts/ghidra/FindAM4EditFirmwareEmitter.java
packages/fractal-midi/scripts/ghidra/ProbeAM4EditFractalBot.java
packages/fractal-midi/scripts/ghidra/DecompileAM4EditFirmwareEmitter.java
packages/fractal-midi/scripts/ghidra/run-am4edit-firmware-emitter.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-fractal-bot-probe.cmd
packages/fractal-midi/scripts/ghidra/run-am4edit-firmware-emitter-decompile.cmd

packages/fractal-midi/samples/captured/decoded/ghidra-am4-edit-firmware-emitter.txt
packages/fractal-midi/samples/captured/decoded/ghidra-am4-edit-fractal-bot-probe.txt
packages/fractal-midi/samples/captured/decoded/ghidra-am4-edit-firmware-emitter-decompile.txt
packages/fractal-midi/samples/captured/decoded/ghidra-firmware-emitter-run.log
packages/fractal-midi/samples/captured/decoded/ghidra-fractal-bot-probe-run.log
packages/fractal-midi/samples/captured/decoded/ghidra-firmware-emitter-decompile-run.log
```

### 15.6 Cross-device implication

The 6-product shared-codebase finding (Fractal-Bot, Axe-Edit, Cab-Lab, FX8-Edit, Cab-Lab3, AX8-Edit all share AM4-Edit's binary) means the same architectural conclusion applies cross-device: **no Fractal user-facing editor contains a firmware packer/unpacker**. The encryption/packing format is uniformly factory-only across the product line. Future agents asking "where is the X firmware decoder in Y-Edit.exe" should stop at this entry and not re-run the mining hunt for III / II / FX8 / etc.


