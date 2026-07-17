---
name: editor-cache-section-record-grammar
class: struct-layout
status: matched
discovered: 2026-06-09
verified_on:
  - am4-edit-cache-0x15-fw2.0
  - axe-edit-ii-cache-0x07
  - axe-edit-iii-cache-0x10-fw29.0 (editor-shipped, float ranges only)
  - fm9-edit-cache-0x12-fw8.1
  - fm9-edit-cache-0x12-fw11.0
  - fm9-edit-cache-0x12-fw75.0
  - vp4-edit-cache-0x14 (stub, 33 records)
firmware_sensitive: true
golden: case-editor-cache-section-record-grammar in scripts/primitives-verify.ts (synthetic-cache walk), plus scripts/_research/parse-effectdefinitions-cache.ts --verify against real caches
relates_to: [fn28-enum-dump, gen3-fn1f-poll-block-bulk-read, gen3-enum-label-septet-stream]
consumed_in:
  - scripts/_research/parse-effectdefinitions-cache.ts (consumer repo; strict zero-resync walker, JSON output)
  - scripts/gen-fm9-ranges-from-cache.ts (consumer repo; ranges.generated.ts source data)
---

# Editor effectDefinitions cache: section/record grammar

Fractal editors (AM4-Edit, AxeEdit II/III, FM3/FM9-Edit, VP4-Edit) persist a
device-synced parameter dictionary in `effectDefinitions_<model>_<fw>.cache`
files (model = hex model byte: 15=AM4, 07=II, 10=III, 12=FM9, 14=VP4). The
file is a count-driven section/record stream that walks deterministically
with ZERO resync. It carries, per block family: every param's id, typecode,
display min/max/default/step, and (for enum params) the device-true label
roster, plus name tables (preset names, cab/IR tables).

This is the device-native range/label oracle: one cache file from a synced
editor yields the full device dictionary with no hardware probing.

## Formal definition

All integers little-endian.

```
file    := preamble , section+
section := u32 sectionTag , u32 recordCount , record{recordCount}
record  := u16 id , u16 typecode , u16 pad(=0) ,
           f32 min , f32 max , f32 default , f32 step ,
           ( enumTail | floatTail | tableTail )
enumTail  := u32 count , count * (u32 len , ascii[len]) , u32 x , u16 0
floatTail := u32 t1 , u32 t2 , u16 0            ; record = 32 bytes
tableTail := (id in 0xfff0..0xfffe only)
             u32 count , count * (u32 len , ascii[len]) ,
             u16 0 , u32 idCount , idCount * u32 wireId
```

- **Record header is 22 bytes, everywhere, all devices, all sections.**
- **Preamble**: the first section header sits at offset 0x2e for AM4/gen-3
  caches (file leads with a format-version u32: AM4=0x02, FM9=0x0b, plus an
  unexplained u32 at 0x2a). The II cache leads with version u32 0x20 and its
  first section header at 0x0e. Auto-detect: try 0x2e then 0x0e, accept where
  `1<=tag<=64 && 1<=count<=8192`.
- **Special ids**: `0xffff` = name table (plain enumTail; e.g. 104 AM4
  preset-location names, 512 FM9 preset names); `0xfff0..0xfffe` = cab/IR
  tables (tableTail: names plus a parallel u32 wire-id array).
- **enum x field**: not padding; a bitfield (AM4 mostly 4, FM9 mostly 0x8000,
  bit 15 set on FM9). Semantics undecoded; the u16 after it is always 0.
- **float t1/t2**: t1 always 0 on every cache walked; t2 small ints
  (0/1/2/16/17...), plausibly display/format flags, undecoded.
- **typecode**: DECODED same-day (see the typecode field tables in the
  consumer repo's findings): AM4 layout `[family][unit]` (2 nibbles),
  II/III/FM9 layout `[unit][family][precision]` (3 nibbles). Unit nibble:
  0=unitless, 1=dB, 2=Hz, 3=s, 4=ms, 5=percent, 6=degrees (raw radians,
  scale 180/pi), 8=pF. Family 4/5 = log10 taper, hardware-confirmed via a
  geometric-mean mid-knob reading on the Axe-Fx II (reverb Low Cut
  20..2000 Hz reads exactly 200.0 Hz at half travel). Precision nibble =
  display decimal places.

## Semantics (validated)

- **sectionTag = the device's block-family tag**, shared across devices
  (REVERB=12 and DISTORT/amp=10 and FUZZ/drive=25 on BOTH AM4 and FM9).
- **recordCount = the fn=0x1F channel-block stride** (FM9 REVERB section 12
  has 73 records = wire stride 73, itemCount 292 = 73x4 channels; DISTORT
  section 10 has 147 = known stride 147). The cache hands over the per-block
  stride table that gen-3 channel-aware reads need
  ([[gen3-fn1f-poll-block-bulk-read]]).
- **record id = paramId within the block** (cache id == catalog paramId).
- **min/max/default/step are device-true display ranges** (FM9 REVERB_TIME
  id=11: 0.1..100 step 0.02, hardware-confirmed).

## Evidence

1. **Zero-resync clean walks** across five device families: AM4 fw2.0
   (1,267 records / 25 sections), II (1,199 / 38), III fw29.0 editor-shipped
   (1,737 / 57), FM9 fw11.0 (2,600 / 49), fw75.0 (2,600), fw8.1 (2,576),
   VP4 stub (33). Section headers declare exact record counts; every section
   walks `declared == walked` to clean EOF.
2. **Hardware anchors all PASS** (FM9 fw11.0 cache): amp roster (section 10
   id 10, count 331) [65]='SV Bass 2', [179]='Texas Star Clean',
   [264]='SV Bass 1'; FUZZ roster (section 25 id 0, count 86) [15]='Blues OD',
   [36]='Blackglass 7K'; reverb-type roster (section 12 id 10, count 79)
   [16]='Medium Spring', [45]='Music Hall'; REVERB_TIME float record
   (section 12 id 11) min=0.1 max=100.
3. **Cross-device oracle (II)**: the II cache amp roster (section 5 id 0,
   266 names) matches the shipped hardware-verified II catalog at ALL 259
   overlapping ordinals, 0 mismatches, and supplies the 7 names the fn=0x28
   probe ([[fn28-enum-dump]]) lost to the 2048-byte receive cap (ordinals
   259..265: FRIEDMAN BE C45 ... SKULL CRUSHER).
4. **Independent implementations agree**: the TypeScript walker's output is
   structurally identical (every record, every field, floats included) to the
   reference Python walker on all five clean caches compared.

## Where it's used

`scripts/_research/parse-effectdefinitions-cache.ts` (consumer repo) is the
walker: emits `{sections, records}` JSON, `--verify` re-asserts the hardware
anchors above. Source data for the FM9 device-true rosters and the work queue
in the consumer repo's cache-format findings (gen-3 calibration, II roster
completion ordinals 259..265, AM4 GHOST-enum oracle, per-block stride table).

## Misapplication failure modes

- **DO NOT parse the older cache revision with this grammar.** FM9 fw
  9p0/9p1/9p2/10p0 caches use an earlier format with standalone u16 0x8000
  markers mid-stream; the strict walk halts on them (the marker lands in a
  would-be section-header count field as 0x80000000). The walker detects this
  and reports "older cache revision (0x8000 markers), not supported". Decode
  only if a use case appears; fw 11.0/75.0 supersede them.
- **DO NOT frame records as `[u16 flag][u16 id][u32 typecode]` with floats
  at +8**, and DO NOT eat the leading `00 00` into a "6-byte trailer". Both
  historical mis-framings consume the same byte stream mid-run but misplace
  boundaries at section starts; the +1-byte resync hacks they require produce
  garbage walks (the retracted "2029 floats + 408 enums" count was exactly
  this artifact). The true frame is the 22-byte header, period.
- **DO NOT greedily string-walk rosters out of the file** without the record
  grammar: a greedy length-prefixed walk merges adjacent tables (amp roster
  bleeding into preset names) and mis-addresses ordinals.
- **DO NOT treat a roster-empty cache as device truth.** Editor-shipped and
  no-device caches exist (the III 29p0 cache has full float ranges but ZERO
  enum lists; `_247`-suffixed no-device stubs halt early or carry 33 records).
  The signal that a cache is real is roster presence after a device sync.
- **enum `max == count-1` holds for true enums** (amp 331: max=330), but ~34
  FM9 records are count=147 CC-style lists where max==count. Do not use the
  max field as an ordinal bound without checking count.

## Where it does NOT apply

- Wire protocol frames. This is an editor-local disk format; nothing here
  crosses MIDI. Wire enum labels travel septet-packed
  ([[gen3-enum-label-septet-stream]]).
- Hydrasynth (different vendor, different editor, no such cache).
- FM9 fw 9p0/9p1/9p2/10p0 caches (older revision, see above).

## Verification path

Run the walker with `--verify` against an FM9 fw11.0-class or II cache:
12 FM9 anchor assertions (3 amp + 2 FUZZ + 2 reverb ordinals, 3 roster
counts, REVERB_TIME range) and 5 II assertions (266-entry roster, ordinals
0/259/264/265) must pass, and the walk must reach clean EOF with zero resync.
A primitives-verify golden is the documented follow-up.

## Refinement history

- 2026-06-09: grammar solved (22-byte record header + count-driven sections,
  no heuristics). Validated zero-resync on AM4, II, III, FM9 x3 firmware,
  VP4 caches; hardware anchors pass; II roster agrees with the shipped
  catalog 259/259. Reference Python walker ported to TypeScript with
  structurally identical output on all compared caches. Older fw-9/10 FM9
  revision identified as out of scope (0x8000 markers).
