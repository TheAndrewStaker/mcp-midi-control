# Mining report: ghidra-axe-edit-iii-store-preset.txt

**Target dump.** `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt` (80,586 bytes, 5 ROOT functions + 7 callers; output of `DumpAxeEditIIIStorePresetFlow.java` against `Axe-Edit III.exe` v1.14.31).

**Roots covered** (by line range):
- `FUN_140337060` @ L8-231 (fn=0x40 LOAD_PRESET builder) + caller `FUN_1402990d0` @ L236-265.
- `FUN_14014d2a0` @ L269-345 (stream-patcher for the 0x77 PRESET_DUMP_HEADER) + caller `FUN_14014d400` @ L350-1271.
- `FUN_14033f2d0` @ L1274-1317 (8-to-7-bit byte-stream packer) + caller `FUN_14033ec70` @ L1325-1531.
- `FUN_1401e3fb0` @ L1535-1559 (fn=0x12 one-byte command) + 3 callers L1564-1717.
- `FUN_140253360` @ L1721-1942 (sends fn=0x12 payload `0x1b`) + caller `FUN_14025dbd0` @ L1947-end.

## Section 1. Instances of existing cookbook primitives

### 1.1 [[vendor-envelope-descriptor-table]], fn=0x40 LOAD_PRESET descriptor at `0x1407ab2f0`

**Location.** `FUN_140337060` @ L51-83. The function walks the table with 12-byte stride (`0xc`) and `-1` sentinel, exactly the cookbook shape.

```c
piVar12 = &DAT_1407ab2f0;                                    // L51
pbVar13 = pbVar9;
do {
  uVar6 = (int)pbVar7 + *(int *)(pbVar13 + 0x1407ab2f8);    // accumulate byte_count (field +8)
  pbVar7 = (byte *)(ulonglong)uVar6;
  pbVar3 = pbVar3 + 1;
  pbVar13 = (byte *)((longlong)pbVar3 * 0xc);                // 12-byte stride
} while (*(int *)(pbVar13 + 0x1407ab2f0) != -1);             // tag (field +0) = -1 sentinel
```

Then L74-83 perform a second pass searching for tag=0 to read its byte_count (`piVar4[2]`), and L130-139 do the same for tag=1. This is the canonical `(tag, mid, byte_count)` triple walk.

Per `docs/devices/axe-fx-iii/fn-byte-envelopes-ghidra.md:38`, the table at `0x1407ab2f0` declares `(0,6,1)(1,7,1)`, two single-byte fields at wire offsets 6 and 7. Decoded role: **LOAD_PRESET / SELECT_PRESET request**, NOT the older "STORE_PRESET BEGIN" hypothesis (see same file L94-110 for the correction; the AxeEdit III store-workflow caller `FUN_14014d400` does not call `FUN_140337060` anywhere in its chain).

**Proposed cookbook update.** Add to `vendor-envelope-descriptor-table.md`'s `consumed_in:` list:

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_140337060 walks 0x1407ab2f0; L51-83)
```

`0x1407ab2f0` is already mentioned in `xor-fold-hash.md` (as the III store-preset descriptor candidate) but the current cookbook body for `vendor-envelope-descriptor-table` doesn't list it explicitly. The table is in-range of the catalog's `0x1407aac70..0x1407abb60` summary but the per-table breakdown skips it. Promoting it from the existing fn-byte-envelopes-ghidra.md catalog into the cookbook body is a small refinement.

### 1.2 [[msb-first-14bit-preset-payload]], stream-patched into every embedded 0x77 header

**Location.** `FUN_14014d2a0` @ L322-339. The function takes a buffer (`param_4`), iterates looking for the 6-byte prefix `F0 00 01 74 <model> 0x77` (the `local_48 = 0x740100f0` + `local_43 = 0x77` constant block at L308-310, searched via `FUN_140343690` with length 6), and patches bytes 6-7 of each match.

```c
local_48 = 0x740100f0;                          // L308: F0 00 01 74 envelope prefix (little-endian)
local_44 = *(undefined1 *)(param_1 + 0x30);     // L309: model byte (III = 0x10)
local_43 = 0x77;                                // L310: fn = 0x77 PRESET_DUMP_HEADER
...
iVar4 = FUN_140343690(iVar8 + lVar1,(int)lVar2 - iVar8,&local_48,6);   // L322: find prefix
...
uVar6 = param_3 >> 0x1f & 0x7f;                                          // L324: sign bit (0 for +ve)
iVar5 = param_3 + uVar6;
local_68 = (ushort)(iVar5 >> 7) & 0xff;                                  // L326: high byte (MSB)
local_66 = ((ushort)iVar5 & 0x7f) - (short)uVar6 & 0xff;                 // L327: low byte (LSB)
```

For positive `param_3`, this reduces to `(p >> 7, p & 0x7F)`, the canonical MSB-first 14-bit preset encoding. The patcher then `memcpy`s the pair into the matched envelope's offset 6-7.

**Why this matters.** The MSB-first-14-bit cookbook entry currently lists `consumed_in: fractal-midi/src/gen3/axe-fx-iii/setParam.ts (buildSwitchPreset)`. The Ghidra dump reveals a SECOND use case in the editor's bank-store workflow: build a template bank stream once, then patch the per-preset index into each `0x77` header before sending. This is a wire-level confirmation of MSB-first as the encoding for fn=0x77's preset-target field (not just fn=0x03/0x14/0x1d/0x3c).

The caller `FUN_14014d400` (the AxeEdit III "Save Preset" UI dispatcher; identifiable by its `"permanently overwrite N presets in your ..."` warning string at L573-575) invokes `FUN_14014d2a0` from switch case 4 (L692) with `param_3 = local_2a0[0] << 7`. That left-shift-by-7 is the **starting preset number for a bank** (e.g. bank A = 0, B = 128, C = 256), confirming the MSB-first encoding is used as a base + offset across the patched stream.

**Proposed cookbook update.** Add to `msb-first-14bit-preset-payload.md`'s `consumed_in:` list:

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14014d2a0 stream-patcher; L322-339)
```

### 1.3 [[septet-14bit]], six instances in `FUN_14033ec70` + two in `FUN_140337060`

**Location 1 (`FUN_140337060`).** L122-127 and L175-179 septet-encode the two single-byte input fields by repeatedly shifting the input by 7 and masking 0x7F:

```c
do {                                                          // L122-127
  *pbVar13 = bVar1 >> ((byte)pbVar16 & 0x1f) & 0x7f;        // shift = 0, 7, 14, ...
  pbVar13 = pbVar13 + 1;
  pbVar16 = (byte *)(ulonglong)((int)pbVar16 + 7);
  uVar15 = uVar15 - 1;
} while (uVar15 != 0);
```

Since the descriptor declares `byte_count = 1` for each tag (the per-field width that the loop count comes from), this collapses to writing one septet. For a 14-bit field the loop would produce two septets, the loop is the universal septet-pack inner kernel.

**Location 2 (`FUN_14033ec70`).** L1379-1380, L1407-1408, L1435-1436, L1493-1495, L1521-1522 are textbook 2-byte LSB-first septet pairs:

```c
*pbVar4 = (byte)uVar1 & 0x7f;                  // low septet
pbVar4[1] = (byte)(uVar1 >> 7) & 0x7f;         // high septet
```

These pack `param_3[0..2]` and `param_3[4..5]` (Fields A, B, C, E, F of the fn=0x01 builder per `fn01-builder-ghidra.md`).

**Proposed cookbook update.** Add to `septet-14bit.md`'s `consumed_in:` list:

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14033ec70 + FUN_140337060)
```

### 1.4 [[iii-fn01-set-parameter-envelope]], `FUN_14033ec70` is the canonical builder

**Location.** L1325-1531. The entire function body matches the C-equivalent in `fn01-builder-ghidra.md:18-64` line-for-line. The 15-byte fixed header + variable-length tail layout (Fields A-F + tail) is the exact builder for fn=0x01 SET_PARAMETER and its sibling sub-actions (`04 01` STATE_BROADCAST, `01 00` long broadcast, `09 00` typed input, `52 00` mouse-drag).

The size formula at L1340, `iVar2 = (int)(param_3[5] * 8 + 6) / 7 + 0xf`, is the wire-budget for "15 fixed bytes + `ceil(tailCount * 8 / 7)` packed-tail bytes." It calls `FUN_14033f2d0` (the byte-stream septet packer) when `param_3[5] != 0`. This is the algorithm hookpoint that the cookbook currently elides as "5-byte septet-encoded packed-float per the AM4-derived `packValue` algorithm" without showing the surrounding fields.

**Observation worth flagging (not a correction).** The cookbook's `verified_on` corpus interprets Field D as `value=508` (Drive 1 Boost ON capture). The Ghidra builder packs Field D as a 32-bit LSB-first 5-septet. Drive 1 Boost ON's Field D bytes `00 00 00 7C 03` decode as `0x3F800000` = **IEEE-754 float 1.0**, not integer 508. (The integer-508 reading comes from reading positions 15-16 alone as a 2-septet 14-bit pair, which is a numerical coincidence under that sub-action's actual encoding.) The cookbook says "packed-float" but the verification fixture names `value=508`. Both interpretations produce the same 5 wire bytes for this particular value, but consumers building NEW values per the fixture will get incorrect packing for non-trivial values.

This is a clarification-candidate refinement, not a wire bug. The existing `buildSetParameter(effectId=58, paramId=40, value=508)` golden continues to round-trip because `508` interpreted as a 14-bit int and `1.0` interpreted as float bits happen to produce the same low 5 septet bytes. The cookbook entry would benefit from naming Fields A-F per `fn01-builder-ghidra.md` and making the float-vs-int ambiguity explicit.

**Proposed cookbook update.** Add to `iii-fn01-set-parameter-envelope.md`'s `consumed_in:` list:

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14033ec70 is the canonical 6-field builder; L1325-1531)
```

And optionally add a short Refinement-history entry noting the float-1.0 / int-508 ambiguity for follow-up.

### 1.5 [[iii-host-emitter-fn-table]], confirms fn=0x40, fn=0x12, fn=0x01

**Location.** Three caller-to-fn pairs are directly visible in the dump:

| fn | Builder | Line | Payload |
|---|---|---|---|
| 0x40 | `FUN_140337060` calls `FUN_1403437d0(..., 0x40, ...)` | L182 | 2-byte payload (LOAD_PRESET) |
| 0x12 | `FUN_1401e3fb0` calls `FUN_1403437d0(..., 0x12, ...)` | L1552 | 1-byte payload |
| 0x12 | `FUN_140253360` calls `FUN_1403437d0(..., 0x12, ...)` with literal `0x1b` | L1885 | 1-byte payload (`0x1b`) |
| 0x01 | `FUN_14033ec70` calls `FUN_1403437d0(..., 1, ...)` | L1527 | 15-byte fixed + variable tail |

These confirm the entries already in `iii-host-emitter-fn-table`'s mined list. The two distinct fn=0x12 builders (`FUN_1401e3fb0` taking a runtime byte, `FUN_140253360` hard-coding `0x1b`) match `fn-byte-envelopes-ghidra.md:32` calling fn=0x12 a "FS_PASSTHRU_MESSAGE", a one-byte command-code dispatch.

**Proposed cookbook update.** Add to `iii-host-emitter-fn-table.md`'s `consumed_in:` list:

```
- fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (confirms fn=0x40, 0x12, 0x01 emitters; L182, L1552, L1885, L1527)
```

## Section 2. Candidate net-new primitives

### 2.1 `iii-byte-stream-septet-pack-8to7`, general 8-to-7-bit MIDI-safe stream packer

**One-line summary.** Pack an arbitrary N-byte raw buffer into `ceil(N*8/7)+1` SysEx-safe bytes by walking input bytes and emitting 7-bit chunks with carry, the standard MIDI 7-of-8 packing scheme.

**Proposed frontmatter.**

```yaml
---
name: iii-byte-stream-septet-pack-8to7
class: bit-level
status: matched-singleton
discovered: 2026-05-22 (cookbook mining of ghidra-axe-edit-iii-store-preset.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-iii-byte-stream-septet-pack-8to7  # TBD
relates_to: [septet-14bit, septet-21bit-byte2-mask-preservation, vendor-envelope-descriptor-table, iii-fn01-set-parameter-envelope]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14033f2d0; L1278-1317)
---
```

**Body sketch.**

```
Given an N-byte raw input buffer and an output buffer of size
ceil(N * 8 / 7) + 1, pack as follows:

  carry = 0
  outIdx = 0
  bitsConsumed = 1
  for inIdx in 0..N:
    if bitsConsumed == 8:
      out[outIdx++] = carry & 0x7F
      bitsConsumed = 1
      carry = 0
    else:
      b = in[inIdx]
      out[outIdx++] = ((b >> bitsConsumed) & 0x7F) | carry
      carry = (b & ~(0x7F << bitsConsumed)) << (7 - bitsConsumed)
      bitsConsumed += 1
  out[outIdx] = carry              // flush
  return outIdx + 1
```

Every output byte has bit 7 = 0 (SysEx-safe). Source: `FUN_14033f2d0` @
L1278-1317.

This is distinct from [[septet-14bit]] (which packs a single 14-bit
value into 2 bytes) and [[septet-21bit-byte2-mask-preservation]] (which
packs a single 21-bit value into 3 bytes with reserved high-5-bits in
byte 2). The 8-to-7 stream packer is used for VARIABLE-LENGTH raw
payloads where the input doesn't carve cleanly into 14- or 21-bit
units, e.g. the III's fn=0x01 long-broadcast tail (64 raw bytes →
74 wire bytes) per `fn01-builder-ghidra.md`.
```

**N-count.** N=1 fixture (only `FUN_14033f2d0` in this dump file). Status `matched-singleton` is supportable: the algorithm is well-known as MIDI's universal 7-of-8 packing scheme; the III binary is one verified axis point. Path to `matched` requires finding the same algorithm in the II AxeEdit binary or AM4-Edit (likely present as the inverse-of-unpack path for fn=0x77/0x78/0x79 preset push, but not yet decompiled into the cookbook).

**Why it warrants a cookbook entry.** Three existing cookbook entries hint at this primitive but none formalize it. `septet-21bit-byte2-mask-preservation` covers a fixed 21-bit-per-ushort layout; `septet-14bit` covers fixed 14-bit fields; neither covers the general byte-stream case. The fn=0x01 long-broadcast and the fn=0x78 chunk payload both need the stream form. Naming it lets future fn-byte decode work cite it instead of re-deriving.

### 2.2 `iii-fn01-six-field-builder`: refinement promoting the full 6-field fn=0x01 envelope to a cookbook primitive

**Status.** This is BORDERLINE between "refinement of [[iii-fn01-set-parameter-envelope]]" and "new primitive." Recommend the former (refine in place) but document here so the founder can choose.

**One-line summary.** AxeEdit III's `FUN_14033ec70` builds EVERY fn=0x01 envelope from a 6-field struct `{action14, blockId14, paramId14, value32, modifier14, tailCount14, tail[]}`, covering not just SET_PARAMETER but STATE_BROADCAST (`04 01`), typed input (`09 00`), mouse-drag (`52 00`), and the 87-byte long broadcast (`01 00` with 64-item tail).

**Why it matters.** The existing cookbook entry [[iii-fn01-set-parameter-envelope]] documents the SET sub-action specifically (status `matched`) but the underlying builder is broader. Promoting the 6-field structure into the cookbook entry's "Formal definition" section means:
- Future decoders for the STATE_BROADCAST and long-broadcast envelopes can cite the same primitive.
- The Field D (32-bit IEEE-754 float) ambiguity vs the cookbook's "value=508" fixture gets clarified.
- The relationship to `iii-byte-stream-septet-pack-8to7` (used for the tail) becomes explicit.

**Proposed refinement note for `iii-fn01-set-parameter-envelope.md`.**

```
Field map (per FUN_14033ec70 + fn01-builder-ghidra.md):

| Field | Payload bytes | Width | Role |
|---|---|---|---|
| A | 0-1 | 14-bit septet | sub-action (09 00 typed, 52 00 drag, 04 01 state-broadcast, 01 00 long broadcast) |
| B | 2-3 | 14-bit septet | effect_id / block id |
| C | 4-5 | 14-bit septet | param_id |
| D | 6-10 | 32-bit 5-septet (4-bit high tail at byte 4) | value (IEEE-754 float bits, NOT raw integer; 0x3F800000 = 1.0) |
| E | 11-12 | 14-bit septet | modifier / scene slot |
| F | 13-14 | 14-bit septet | tail item count |
| Tail | 15..14+ceil(F*8/7) | variable | items packed via [[iii-byte-stream-septet-pack-8to7]] |
```

**N-count.** Refining the existing `matched` entry, no new fixture count needed.

### 2.3 `iii-stream-patch-preset-index`: workflow pattern, NOT recommended for cookbook promotion

**One-line summary.** Bank-store workflow: build a single SysEx stream containing N consecutive `F0 00 01 74 <model> 0x77 ...` envelopes once, then iterate the buffer finding each 0x77 header and patch in the per-preset target index at offsets 6-7 (MSB-first 14-bit).

**Why I'm not proposing promotion.** The cookbook hosts encoding primitives (bit-level, struct-layout, checksum, envelope-shape, label-extraction, fn-byte-mapping, coercion). This is a builder workflow that USES existing primitives ([[msb-first-14bit-preset-payload]] + the III 0x77 PRESET_DUMP_HEADER envelope) but doesn't define a new encoding shape. The pattern is interesting operationally: it confirms that III preset dump bodies are INDEX-INDEPENDENT (the body bytes don't encode the preset slot; only the 0x77 first-frame header does), which informs how our future III store-preset implementation can batch presets. But that's a project-level note, not a cookbook primitive.

**Recommendation.** Note this insight in `STATE-AXEFX3.md` or `docs/devices/axe-fx-iii/store-preset-decoded.md` (if/when that file gets created), not in the cookbook.

## Section 3. Negative findings

### 3.1 fn=0x40 is NOT "STORE_PRESET BEGIN"

**Hypothesis ruled out.** Earlier reverse-engineering (community + project guesses) labelled fn=0x40 as the start-of-store handshake for the 0x77/0x78/0x79 sequence on the III. The dump file refutes this.

**Evidence.**

1. **Caller chain.** `FUN_140337060` (the fn=0x40 builder) has exactly ONE caller: `FUN_1402990d0` (L236-265). `FUN_1402990d0` is a leaf; its sole callers are entry points that take a single byte (preset number) and allocate a 3000-byte INBOUND buffer (`FUN_14032eb90(local_res18, 3000)` at L249) before sending. This is the canonical "send request, wait for large response" pattern of a LOAD/READ envelope, not a STORE.
2. **Store-workflow chain.** `FUN_14014d400` is the actual STORE_PRESET UI dispatcher (identifiable by the `"permanently overwrite N presets in your ..."` warning string at L575). Its switch cases 3, 4, 5, 7, 8 cover every store-preset variant (single, bank, IR-only, FullRes IR-bank). None of these cases call `FUN_140337060`. Case 4 (the bank-store path) calls `FUN_14014d2a0` (the fn=0x77 stream-patcher) directly.
3. **Independent confirmation.** `docs/devices/axe-fx-iii/fn-byte-envelopes-ghidra.md:38, 94-110` already documents this correction; the current dump is a SECOND verification.

**Proposed negative cookbook entry.**

```yaml
---
name: iii-fn40-as-store-preset-begin
status: non-matching
discovered: 2026-05-22 (cookbook mining of ghidra-axe-edit-iii-store-preset.txt)
ruled_out_by:
  - axe-edit-iii-binary (FUN_140337060 caller-chain trace)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt
relates_to: [iii-host-emitter-fn-table, vendor-envelope-descriptor-table]
---

# fn=0x40 is NOT STORE_PRESET BEGIN

fn=0x40 on Axe-Fx III is a LOAD_PRESET request, NOT the start of a
store handshake. The III's actual STORE_PRESET workflow has NO separate
BEGIN marker, the target preset is encoded in the fn=0x77
PRESET_DUMP_HEADER's preset-index field (see
[[msb-first-14bit-preset-payload]]).

Search terms (for future agents avoiding re-derivation):
- "fn 0x40 store begin"
- "0x40 STORE_PRESET handshake"
- "axe-fx iii bank store opcode"
- "1407ab2f0 store"

Refutation evidence: caller-chain analysis. FUN_140337060 (the fn=0x40
builder) is invoked only by FUN_1402990d0, which allocates a 3000-byte
inbound buffer before sending, the signature of a LOAD request, not a
STORE. The STORE workflow caller FUN_14014d400 (identifiable by its
"permanently overwrite N presets" warning string) does not call
FUN_140337060 anywhere in its switch cases 3/4/5/7/8.

Cookbook discipline: when a 1-byte fn-byte envelope's caller allocates
a large inbound buffer before send, treat it as a READ/LOAD request,
not a WRITE/STORE handshake. The presence of a 3000-byte inbound
allocation is the tell.
```

### 3.2 fn=0x01 Field D ≠ raw integer (subtle)

**Hypothesis flagged for cookbook clarification.** The existing [[iii-fn01-set-parameter-envelope]] verification fixture reads `value=508` for Drive 1 Boost ON. The dump confirms via `FUN_14033ec70` that Field D is a 32-bit LSB-first 5-septet field whose bytes `00 00 00 7C 03` decode to `0x3F800000` = IEEE-754 float `1.0`, not integer `508`.

The two readings coincide for the SET_PARAMETER capture corpus because all four captured values (boost ON, boost OFF, time 520, time 516) sit in the low 14 bits of Field D; the high 21 bits are always zero, so the bytes look identical under integer-vs-float interpretation. But a consumer that builds a new write with `value=1000000` per the cookbook fixture's integer interpretation will pack `0x40 0x42 0x0F 0x00 0x00` (1000000 as LSB-first 5-septet integer) into Field D, while the device firmware likely expects `value=1000000.0` packed as IEEE-754 float bits `0x49742400`. These produce DIFFERENT 5-byte sequences, and the wire write will be silently incorrect.

**This is not a cookbook bug per se**: the entry says "5-byte septet-encoded packed-float per the AM4-derived `packValue` algorithm." But the explicit `value=508` in the fixture text is ambiguous given the float interpretation. A clarifying refinement to the Verification path section, naming Field D's contents as `float-bits(value)` not raw `value`, would prevent a future misuse.

I'm not proposing this as a `_negative` entry (the cookbook entry is not wrong, just under-specified). Recommended instead: refinement-history note on `iii-fn01-set-parameter-envelope.md`.

## Summary of proposed cookbook actions

| Action | Target | Class |
|---|---|---|
| Add `consumed_in:` path | `vendor-envelope-descriptor-table.md` | Refinement |
| Add `consumed_in:` path | `msb-first-14bit-preset-payload.md` | Refinement |
| Add `consumed_in:` path | `septet-14bit.md` | Refinement |
| Add `consumed_in:` path + clarify Field D as IEEE-754 float | `iii-fn01-set-parameter-envelope.md` | Refinement |
| Add `consumed_in:` path | `iii-host-emitter-fn-table.md` | Refinement |
| **NEW** primitive entry | `iii-byte-stream-septet-pack-8to7.md` (or generalize to `byte-stream-septet-pack-8to7.md`) | matched-singleton |
| **NEW** negative entry | `_negative/iii-fn40-as-store-preset-begin.md` | non-matching |

All seven actions are founder-gated. No cookbook files modified by this report.

## Appendix: function-to-purpose cheat sheet

| Function | Line | Role |
|---|---|---|
| `FUN_140337060` | L8-231 | fn=0x40 LOAD_PRESET builder, walks descriptor `0x1407ab2f0`. Sends 2-byte payload, dispatches receive based on first payload byte (4 → action 0x43, 5/8 → action 0x103). |
| `FUN_1402990d0` | L236-265 | Single caller of `FUN_140337060`. Allocates 3000-byte inbound buffer via `FUN_14032eb90(..., 3000)`, confirms READ semantics. |
| `FUN_14014d2a0` | L269-345 | Stream-patcher for fn=0x77 PRESET_DUMP_HEADER. Searches buffer for 6-byte prefix `F0 00 01 74 <model> 0x77`, patches MSB-first 14-bit preset index at offsets 6-7. |
| `FUN_14014d400` | L350-1271 | AxeEdit III STORE_PRESET UI dispatcher. Switch on store-mode (3/4/5/7/8) selects which envelope path to invoke. Case 4 = bank store, case 7 = IR cab, case 8 = IR bank. |
| `FUN_14033f2d0` | L1278-1317 | General 8-to-7-bit byte-stream septet packer. Output size = `ceil(N*8/7) + 1`. Candidate new cookbook primitive (§2.1). |
| `FUN_14033ec70` | L1325-1531 | fn=0x01 6-field envelope builder. Header = 15 bytes (3×14-bit + 1×32-bit-5septet + 2×14-bit) + variable tail via FUN_14033f2d0. Canonical SET_PARAMETER builder + sibling sub-actions (see [[iii-fn01-set-parameter-envelope]] refinement §2.2). |
| `FUN_1401e3fb0` | L1535-1559 | fn=0x12 one-byte command emitter; runtime byte. |
| `FUN_140253360` | L1721-1942 | fn=0x12 emitter with hard-coded payload `0x1b`. Both `FUN_1401e3fb0` and `FUN_140253360` confirm fn=0x12 = FS_PASSTHRU_MESSAGE per existing catalog. |

End of report.
