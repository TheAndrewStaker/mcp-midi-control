# Axe-Fx Standard / Ultra (gen-1) SysEx map

Model byte `0x01`. The first-generation Fractal flagship. Its own codec: it
shares only the Fractal manufacturer envelope with the later gen-2 (Axe-Fx II,
septet-packed) and gen-3 (modern, sub-action) families.

Sources, two documents:
- The published "Axe-FX Ultra System Exclusive Messages" doc (Ultra firmware
  10.02-10.05): the parameter-SET catalog. The wire is decoded **byte-exactly
  from that doc's worked examples and its full 0..255 conversion table**.
- The community-maintained gen-1 wiki "Axe-Fx System Exclusive Message Spec"
  (wiki.fractalaudio.com/gen1, saved at
  `docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt`): the fuller protocol
  doc that documents the bidirectional half (queries + responses + patch dump)
  the param-set catalog omits. Its SET example matches our builder byte-for-byte.

NOT hardware-verified (the project owns no gen-1 hardware), so gen-1 ships
**community-beta**.

## Parameter set / query message (function 0x02)

```
F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] 01 F7
```

| byte(s) | meaning |
|---|---|
| `F0` | SysEx start |
| `00 01 74` | Fractal manufacturer id |
| `01` | model byte (Ultra; Standard presumed same, unconfirmed) |
| `02` | function = set / query parameter value |
| `bb bb` | block id (nibble-split) |
| `pp pp` | parameter id (nibble-split) |
| `vv vv` | value (nibble-split; irrelevant when querying) |
| `01` | **query(0)/set(1) flag** (NOT a checksum, see below). Set builder emits `1`; the read path emits `0` |
| `F7` | SysEx end |

## The nibble-split encoding (the key primitive)

Every addressable field (block id, param id, AND value) is an 8-bit value
0..255 transmitted as **two MIDI bytes, low nibble first**:

```
toWire(v)   = [v & 0x0f, (v >> 4) & 0x0f]     // each byte is a single nibble 0..15
fromWire(lo,hi) = (hi << 4) | lo
```

Each transmitted byte holds one nibble (0..15), so the high bit is always clear
(MIDI-safe by construction). This is **not** the gen-2 septet pack and **not**
the gen-3 sub-action layout.

Proven from the doc:
- value 163 = 0xA3 → `0v 0v` = `03 0A` (doc's own worked example)
- Compressor 1 block decimal 100 = 0x64 → `04 06`; Amp TYPE max 70 = 0x46 → `06 04`
- Full worked example: set Compressor 2 (block 101) Knee (param 5) = SOFTER
  (value 2) → `F0 00 01 74 01 02 05 06 05 00 02 00 01 F7`
- The doc's complete **0..255 decimal→hexpair conversion table validates 256/256**
  against this encoder (see `scripts/_research/parse-gen1-sysex.ts`).

## The flag byte is set/query, not a checksum

The byte before `F7` is the **query(0)/set(1) flag**, not a checksum: the XOR of
the worked example's payload is `0x02`, not `0x01`, so no checksum is applied.
(Contrast gen-2/AM4, which DO use `fractalChecksum` XOR&0x7F.) Do not call
`fractalChecksum` for gen-1.

It read as a "fixed trailer" only because our original source (the narrow
"Ultra System Exclusive Messages" param-set doc) shows nothing but SET
messages, where this byte is always `1`. The fuller gen-1 wiki spec documents it
as the set/query selector: clear it to `0` to query.

## Reads (function 0x02 query → MIDI_PARAM_VALUE)

Read-back IS part of the gen-1 protocol (decoded from the gen-1 wiki spec;
community-beta, hardware-unconfirmed). Implemented in `readParam.ts`
(`buildGetParam` / `parseParamValue` / `isParamValueResponse`) and wired into the
device package's `DeviceReader` as `get_param` / `get_params`.

Query (value irrelevant, flag = 0):

```
F0 00 01 74 01 02 [bb bb] [pp pp] 00 00 00 F7
```

`MIDI_PARAM_VALUE` response (function 0x02, value + the device's own label):

```
F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] <ascii label…> 00 F7
```

The device returns the live value (0..254) and a null-terminated label string
("1.234 Hz", "5.00"); the label is ground truth. Older firmware used
manufacturer id `00 00 7D` (10.02+ uses `00 01 74`); the parser currently
matches the `00 01 74` envelope our SET path also uses.

## Whole-patch dump (MIDI_GET_PATCH 0x03 → MIDI_PATCH_DUMP 0x04): pinned subset SHIPPED (community-beta); param block still open

Assessed 2026-07-02 against the mirrored wiki spec
(`docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt`, sections
`===MIDI_GET_PATCH===` line 203 and `===MIDI_PATCH_DUMP===` line 443). The
spec pins the request and the dump's header / name / grid regions, but
**explicitly leaves the parameter region "Undetermined (assume parameter and
modifier state)"** (spec line 466).

**Shipped 2026-07-02 (community-beta, hardware-unverified):** the SPEC-PINNED
SUBSET is implemented in `src/gen1/patchDump.ts` (`buildGetPatchDump` /
`parsePatchDump` / `isPatchDumpResponse`) and wired into the device package as
`get_preset`: it returns the preset NAME, the 4×12 effect-grid block layout
(effect ids resolved via the fn 0x02 block-id table; the 2 per-cell state
bytes carried raw), and the edit-buffer/stored source flag. The parameter
region is returned as a byte COUNT only, never decoded, per the
no-guessed-wire-paths rule that region stays out until a real capture closes
it (the evidence class for any layout written today would be WEAK: an inferred
layout with no oracle, not spec-derived). Goldens:
`test/gen1/patchdump.test.ts` (request frames byte-exact vs every spec worked
example; synthetic dump round-trip; bank-C refusal).

### Request (fn 0x03): pinned, one spec-flagged wrinkle

Edit buffer (fully pinned, spec lines 223–236):

```
F0 00 01 74 01 03 01 00 00 F7
```

Stored preset (spec lines 207–218 + worked examples 239–245):

```
F0 00 01 74 01 03 00 [ls] [ms] F7
```

`ls = preset & 0x0f`, `ms = preset >> 4`, proven by the spec's own examples
(A000 → `00 00`, A127 → `0F 07`, B128 → `00 08`, B255 → `0F 0F`, C256 →
`00 10`). Note `ms` carries `preset >> 4`, i.e. MORE than one nibble (C256 →
`0x10`). This preset-number field is NOT the 8-bit nibble-split used by
fn 0x02. **Wrinkle:** the spec itself flags `ls` as "or'd with unknown value
when requesting presets from bank 2": its C383 example shows `7F 17` where
`383 & 0x0f = 0x0f`. Banks A/B (presets 0..255) are pinned; bank-C requests
≥ 256 with a nonzero low nibble are NOT. `buildGetPatchDump` therefore
REFUSES presets ≥ 256 (one community capture pins the OR-value).

### Dump (fn 0x04): what the spec pins (lines 443–467)

"Patch dumps **appear to be** 2060 bytes"; the spec hedges even the total.
Layout with the spec's stated sizes; the offset arithmetic is internally
consistent (7 + 6 + 42 + 22 = 77 = the spec's stated grid offset):

| offset | size | content | status |
|---|---|---|---|
| 0–6 | 7 | header `F0 00 01 74 [model] 04 [buf]`; byte 6 = `0x01` edit buffer / `0x00` stored | pinned |
| 7–12 | 6 | "patch number?" (spec's own question mark) | undetermined |
| 13–54 | 42 | 20-char patch name, ls/ms nibble pairs, + nibble-pair null terminator (20×2 + 2 = 42 ✓) | pinned |
| 55–76 | 22 | ? | undetermined |
| 77–268 | 192 | effect grid, 4×12 cells × 4 bytes: 2 bytes effect id (ls/ms nibble pair, matches the block-id table) + 2 bytes "undetermined state" | ids pinned; state bytes undetermined |
| 269–2058 | 1790 | "assume parameter and modifier state" | **NOT pinned: the open piece** |
| 2059 | 1 | `F7` | pinned |

### Why the param block cannot be spec-derived

The spec gives NO per-block param ordering, NO record framing or
block-presence markers, NO value encoding for the region, and hedges the total
size. Arithmetic kills the one obvious hypothesis: 1790 bytes as nibble pairs
= 895 eight-bit values, but the catalog holds 922 params per block *type*
(more again after duplication across the 68 block instances): "every param,
nibble-split, in catalog order" does not fit. Any layout written today would
be a guess with no way to catch a wrong answer; it stays out.

### What closes it (one community capture)

The minimal oracle is a real fn=0x04 dump plus known ground truth:

1. **Best:** two edit-buffer dumps bracketing exactly ONE noted front-panel
   param change (one-capture-per-hypothesis): the byte diff pins the offset
   AND the value encoding in one shot.
2. **Acceptable:** one dump (a Fractal-Bot / gen-1 AxeEdit preset `.syx`
   export should be exactly this frame) plus a note of a few known param
   values + firmware version.

Either also confirms or denies the 2060-byte total. The community ask lives in
`docs/contributing/devices/axe-fx-gen1.md` (ask CAPTURE-1) in the mcp-midi-control repo.

## Still not wired (capability boundary)

Documented in the wiki spec but NOT yet implemented: the patch dump's
parameter region (the pinned header/name/grid subset SHIPS as `get_preset`,
see above; the ~1790-byte param block is explicitly undetermined in the spec,
so it is surfaced as a byte count only until a capture closes it), bank-C
stored-dump requests (unknown OR-value), modifier query (0x07),
get-firmware (0x08), get-preset-name (0x0f). Not in the protocol at all: save /
store-to-location, preset-change / bank-select, scenes, X/Y channels. The device
package omits those ops; the dispatcher returns `capability_not_supported`.

## Catalog

35 blocks (68 instances), 922 parameters, 246 enum tables (3,482 enum values).
Generated from the doc via the committed pipeline (never hand-transcribed):

```
docs/manuals/AxeFx-Ultra-SysEx-Messages.htm
  → scripts/_research/parse-gen1-sysex.ts        (parse + nibble validation, 0 mismatches)
  → scripts/_research/gen1-canonicalize.ts       (snake_case keys + scaling flags)
  → packages/fractal-midi/scripts/generate-gen1-catalog.ts  (emits src/gen1/{params,blockTypes}.ts)
```

Display-first: continuous params with a documented linear range convert
display↔wire; params the doc marks non-linear (`*`) carry `scaling: 'pending'`
and refuse display conversion (raw wire pass-through) until a curve is supplied:
no fabricated linear interpolation.

## Open items

- **Standard model byte:** the doc covers the Ultra (`0x01`); the Standard is
  presumed to share it but is unconfirmed. Ship Ultra first.
- **Hardware verification:** nothing is confirmed on a physical gen-1 unit.
- **Primitives:** the nibble-split primitive warrants a primitive entry + golden
  (follow-up; the gen-1 golden in `test/axe-fx-gen1/setparam.test.ts` already
  locks the encoder).
