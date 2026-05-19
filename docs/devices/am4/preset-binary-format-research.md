# Preset binary format research (BK-036 / launch-gating)

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

The implication for BK-036's launch-gate goal is described in §6.

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

**TL;DR — there is no clean evidence of a stream cipher with a
seed we can isolate. The "per-export scramble" that BK-036 noted
is real but the diff pattern is more consistent with cleartext
plus per-export volatile fields than with a uniform XOR cipher.**

### 3.1 What BK-036 observed

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
only 47 / 3,074 chunk-1 diffs — 1.5%. Every other pair of the same
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
— substantial Hamming distance) yet differ in only 47 chunk-1 bytes.
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
  yet tight — there may be 2 records per slot, or a different
  structure entirely.

What's NOT in this cleartext region:

- The **preset name** is not visible as ASCII anywhere in chunk 1
  or chunk 2, with or without 7-of-8 bit unpacking. If it lives in
  the chunks at all, it's either heavily encoded or in the
  scrambled tail. **Note:** this is about the bank-file / exported
  preset dump only. The live device exposes names directly via the
  `READ_PRESET_NAME` query (action 0x0012, decoded HW-070); names
  are not bank-file-readable but ARE device-readable. AM4-Edit's
  "Refresh Preset Names" menu may also be a bulk variant of that
  query — HW-073 captures it.
- **Per-channel parameter values** (e.g., the gain knob value that
  changed from 3.00 to 4.00 between `orig` and `gain1`) do not
  appear in this region. Diffs between `orig` and `gain1` are
  concentrated at offsets 0x70+ in chunk 1 (the disputed region)
  and across most of chunk 2.
- **Scene-to-channel assignments** (4 scenes × 4 blocks = 16
  pointers) are not obviously visible here either.

### 3.5 Why this matters for BK-036

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
preset name without first decoding the disputed region — and the
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

- `encodeBlockLayoutRecord(slot)` — the 3-byte record format is
  visible in §3.4 but the byte0/byte1/sel meaning is not yet
  bound to a known field. Best guess: byte0+byte1 form a 14-bit
  packed value (block type ID and channel state), byte2 is bypass.
  Verifying this requires placing known blocks in known slots
  and observing the exact bytes — i.e., a hardware capture.

- `encodePerChannelParamsAndScenesAndName(...)` — the disputed
  region in §3.5. We can't encode this without a decode.

- `computeFooterHash(chunks)` — algorithm unknown. The bank file
  exposes 104 (chunks, footer) pairs as ground truth. Standard
  CRC-24, CRC-16-CCITT, sum-mod-prime, etc. brute-force would
  identify it in under an hour if it's a documented algorithm.
  If it's a Fractal-internal mix, it won't be discoverable
  without further RE.

## 6. What the founder's HW probe needs to verify before we ship

Before we can ship `encodePresetForSlot`, three hardware actions
are needed; HW-068's lessons (working-buffer side effects, ack
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
   of what Session 04-06 did for the wire `0x01 SET_PARAM`
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
   No hardware needed — just CPU time. If no standard algorithm
   matches all 104 pairs, the footer is a Fractal-internal hash
   and we'll need to either skip footer validation on the device
   side (probably tolerated; AM4-Edit has been observed to produce
   slightly different footers for the same content) or RE the
   hash function from `AM4-Edit.exe`.

If (1) and (3) succeed but (2) doesn't, we have a partial path:
direct-to-slot writes for the **layout-only** portion of a fresh
preset, with the device's existing live-write protocol filling in
per-channel parameters after the slot-write. That's still a win
for HW-068's failure mode — the user's currently-loaded preset
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

3. **Chunk count = 4 is hard-coded — but most of chunks 3, 4 and
   half of chunk 2 are zeros.** The wire protocol could presumably
   support smaller dumps (`0x77 + 1 chunk + 0x79`). The device may
   refuse anything other than 4 chunks; we have no captures of a
   non-4-chunk dump from AM4-Edit. Try the minimal version on
   hardware before assuming.

4. **AM4-Edit's preset translation classes
   (`PresetTranslator`, `PresetTranslatorGen3`).** These exist in
   the binary and presumably know how to read AM4 chunks (since
   they translate from one device family to another). A focused
   Ghidra session on those classes — specifically tracing the call
   chain from the `Translate Preset` menu item — might surface a
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

## 8. What this means for the BK-036 launch-gate

The original BK-036 plan was: **decode chunks completely, build
a fresh-preset encoder, ship direct-to-slot writes that bypass
the working buffer, fix the HW-068 smearing bug.**

The honest read after this analysis: that plan is **not
achievable on a static-analysis-only timeline**. The disputed
region is too large and behaves too inconsistently to decode by
diffing five session-03 captures.

Two realistic paths considered at the time:

- **Ship without the encoder, with the workaround documented.**
  Tell the user "don't move the front-panel preset knob during
  agent batch operations; we're working on it." Loud and ugly but
  honest. BK-036 stays open as follow-up research.
- **Ship a partial encoder for layout-only.** Implement the §5
  pseudocode minus the disputed-region step, write the layout
  changes via direct-to-slot, then drive per-channel params via
  the existing working-buffer route. Mid-sequence the working
  buffer still gets touched, so the smearing bug isn't fully
  fixed, but the layout part is reliable. Probably ~3 days of
  hardware probes + implementation.

Neither path delivers the full BK-036 promise. The chosen call
(see §9) was to ship without the encoder and queue the hardware
probe series in §6 as follow-up.

## 9. Status decision (2026-05-09, Session 52)

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
- Tier 2 extraction (names + block layout) ships in Session 52
  via live-wire readout, not static decode. That gives the agent
  a reference table for "what's at factory X" without depending on
  encoder progress. Tier 3 (full param/scene/channel state) is
  reachable today via slow live-readout (~30-45 min one-time) or
  fast static decode after §6.

**Followup tasks queued:**

- Task #22 — §6 hardware probe series (block-layout records,
  param encoding, footer hash). Includes the cleartext-volatile-
  state confirmation capture as a prelude.
- Task #23 — tier 3 factory-data extraction (live-wire readout
  path or via task #22's encoder, whichever lands first).
- The cleartext-volatile-state confirmation is fast and high-
  information; if hardware time opens up, it's the next BK-036
  step worth taking even before §6.

This artefact stays the source of truth for chunk binary
structure. Update §3.x when new diff captures land; update §4
when record-meaning is pinned; close out §6 items as probes
complete.
