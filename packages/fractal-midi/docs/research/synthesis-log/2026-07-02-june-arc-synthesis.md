# Synthesis pass — June 2026 arc (2026-07-02)

Third synthesis run (prior: 2026-05-22 ×2). Scope: everything since the last
pass — the gen-1/2/3 reorg, FM3 serial field test, FM9/III hardware
confirmations, the catalog-wide SET→GET roundtrip + enum-flow fixes, the VP4
write decode, sub=0x1f type-name read, the FM9 Windows verify, editor-cache
grammar exploitation, ForgeFX roster adoption, and the 2026-07-01 FM3 grid
tail-anchor decode. Items already surfaced by the 2026-07-01 five-agent review
(FM3 0x2E mine, FM9 amp-roster union, sub=0x1f ordinal-sweep lead, VP4 eid206
registers, gen-1 patch-dump lane, Drew/chihotta standing asks, integer-step
read fix, import_preset) are treated as context, not findings.

## 1. Headline connections agents have missed

**1a. The AM4 preset-dump body has never been tried against the gen-3 Huffman
codec.** The negative `cookbook/_negative/am4-preset-dump-flat-byte-diff.md`
(May: encoder "non-deterministic," ~20% of 12,352 bytes churn on a no-op
redump) predates the June whole-preset codec
(`packages/fractal-gen3/src/presetHuffman.ts`: 3-to-16 de-frame + dynamic
Huffman + CRC, byte-exact vs III preset 0x338 + FM9 152). AM4 is
protocol-family "III subset + extensions," and a *dynamic-Huffman* body is
exactly what makes a semantically-identical redump churn 20% of its bytes —
the May finding is the June codec's signature, and nobody has connected them
(zero Huffman references anywhere under `src/am4/`). We already hold the
perfect test corpus: the one-variable AM4 warm-pair dumps (baseline redump,
amp gain ch A vs B, amp master, amp type swap — registered in the private
artifacts manifest). Move: run the gen-3 de-frame + Huffman decode on one AM4
0x77/0x78/0x79 body; if the CRC validates, re-diff the warm pairs at the
*decoded* layer — the one-variable design yields field offsets immediately.
Payoff: the whole AM4 stored-preset lane (atomic apply, fast stored
`get_preset`, translate) reopens offline. If it fails, the negative entry
gains the ruled-out codec.

**1b. The record contradicts itself on the Axe-Fx II preset body — and the
adjudication is offline.** `_negative/ii-preset-binary-flat-byte-diff.md`
says the II body is "Huffman-compressed; offsets unstable."
`packages/fractal-gen2/src/presetDump.ts` (lines 23-29) says Session 113
static analysis showed it is *NOT* Huffman — a structured serialization with
data roughly every 3rd byte — and two cookbook primitives
([[preset-name-ascii-triplets]], [[block-record-stride-8]]) register *stable*
chunk-0 offsets. [[xor-fold-hash]] folds "decoded native ushorts" verified
390/390, implying a deterministic de-framed word image. Both committed claims
cannot be right. Test: de-frame a factory preset to u16 words (the 3-byte→u16
math the III preset-receiver mine confirmed byte-exact) and re-run a
one-variable diff at the *word* layer. If word diffs are stable, the
"21-capture plan" failed at the wrong layer, and the BK-070
paramBase/atomic-apply thread (partial-N1, 28 widths measured) reopens.

**1c. A gen-3 CAB roster is sitting in-hand; the 06-27 "cab: no base roster
to validate against" verdict is stale.** The synced FM9-Edit cache (fw 11.0,
in hand since 2026-06-09, the source of `src/gen3/fm9/rosters.generated.ts`)
carries complete enum rosters per [[editor-cache-section-record-grammar]] —
amp/drive/reverb were generated, CABINET (and GEQ) never were, even though the
cache demonstrably has a CABINET section (the sub=0x01 block-definition
record cites "CABINET 106 vs cache 110"). Independently, the
`fm9-enum-label-sweep-harp-2026-06-04` capture's cab/IR-picker value list
(sub=0x2e) was decoded 06-04 but never registered (remaining-value item 3 in
the artifacts manifest ever since). Move: extend
`scripts/gen-fm9-rosters-from-cache.ts` to the CABINET/GEQ sections,
cross-check against the picker list — two independent axes, both on disk.

**1d. VP4-Edit has never been pointed at the editor-emulation harness — and
the un-decoded VP4 `0x1f` routing blob is the read-side oracle for the same
placement math.** The controlled-capture simulator
(`scripts/_research/sim/fractal-editor-emulator.ts`) solved gen-3 sub=0x35
routing with 4 known-geometry cables and already overturned the
"editors filter driver class" negative for gen-3 editors. We hold the exact
reply corpus to seed a VP4 SimDevice: the fw 4.03 editor poll (1,000 frames,
100% checksum-valid). Controlled block-move drags in VP4-Edit would emit
eid206 pid10–16 frames with KNOWN slot geometry — the identical trick that
cracked sub=0x35. Read side: the 221-byte septet-packed `0x1f` blob
(`docs/devices/vp4/SYSEX-MAP.md` §effect-id table) predates both the
tail-anchor rule and the 32-bit/cell grid-bitstream layout; trying
`cell_start_bit = 46 + col·(rows·32) + row·32` with a 4-slot serial geometry
against the six in-hand blobs is pure offline work. This complements (does
not duplicate) the in-flight eid206 register mine and chihotta's sub=0x36 ask.

**1e. The FM3 ships without the enum-flow correction both its siblings got.**
FM9: ~351 selectors re-routed discrete (06-18, cache-gated). III: ~92 (06-20,
roundtrip-oracled). `src/gen3/fm3/` has *no* `roundtripDiscrete.generated.ts`
and zero kind-classification data — same editor-binary catalog provenance,
so the same latent bug class (type/count selectors routed as continuous
floats) is live on the device with our *best* hardware-confirmation story.
Drew's FM3 re-run is already queued (grid-read confirm + patched sub=0x09
probe); folding the chihotta roundtrip script into that same session is the
cheapest oracle and closes three things at once.

## 2. Un-mined inventory

- `ghidra-axe-edit-iii-misc-descriptors.txt` (~130 KB): ~25 per-fn descriptor
  tables at `0x1407aac70..0x1407abb60` — the envelope spec for every III host
  emitter. A `.descriptors.json` parse output exists on disk, but the
  manifest still lists the tables un-mined and no findings doc consumes them:
  either the mine is unfinished or the manifest has drifted. Verify, then
  consume (input: dump txt; output: per-fn `(tag, offset, count)` JSON).
- fn 0x33 action-code constants across the 93 caller bodies in
  `ghidra-axe-edit-iii-dump-descriptors.txt` (`extract-iii-action-codes.ts`
  still unwritten).
- AM4 fn=0x30 "batch set a block's parameter" descriptor table (4 emitters in
  the host-emitter map; its table lives in the already-located 54-table region
  `0x1405dc190..0x1405dd160`). Yields a native AM4 atomic multi-param write —
  directly relevant to the atomic-apply theme in 1a/1b.
- `AM4DeviceManager` vtable slots 0-15 decompiles (likely MIDI-route
  candidates; one-script follow-up).
- FM9 2026-06-04 receive capture leftovers: user-IR/cab dump envelope
  `fn=0x19 → 0x7a/0x7b/0x7c` (87 slots swept, envelope confirmed, never wired
  as import/export-IR); cab/IR picker lists unregistered (1c).
- chihotta-roundtrip-2026-06-18 JSONs: mined for *kind* only. If they stored
  wire words alongside display values, they are the value-scale oracle that
  both Drew's `param_mappings.json` and `presetBody.ts`'s deferred generic
  knob-value decode ("no value-scale ground truth") have been waiting on.
  Check the JSON shape before asking anyone for new data.
- Gen-1 AxeEdit editor binary: never mined at all (decode-status table row).
  A pattern-scan/BinaryData pass would give the in-flight gen-1 patch-dump
  lane a second oracle beyond the published spec.

## 3. 80%-complete threads, by closing cost

1. **AM4 × gen-3 Huffman test** (1a) — one script run, ~1 h, offline.
2. **FM9 cache CAB/GEQ rosters** (1c) — extend an existing generator, ~2-3 h.
3. **VP4 `0x1f` blob vs grid-bitstream layout** (1d read side) — ~2-4 h,
   offline, six fixtures in hand.
4. **II word-layer diff adjudication** (1b) — ~2 h, offline, factory banks in
   hand.
5. **FM3 enum-flow roundtrip** (1e) — script exists; gated only on bundling
   it into Drew's already-queued session.
6. **misc-descriptors consumption / manifest-drift fix** — ~1-2 h.
7. **sub=0x09 set-echo float-misparse on type params** (F1/F2 from the 06-20
   analysis) — the echo carries a septet-packed *name* on type params and the
   parser reads it as float32; small codec fix. (F3 and F7 from that same
   backlog are already DONE — `SUB_ACTION_GET_TYPE_NAME` shipped in
   `setParam.ts`, tail-anchor superseded F7 — so the F-list itself needs a
   staleness pass.)

## 4. Cross-device transfer candidates

- **Editor-emulation harness → VP4-Edit** (1d) **and AM4-Edit**: an
  AM4-prefixed SimDevice could capture the fn=0x30 batch-set frames and the
  action=0x0017 anomaly trigger without Ghidra or hardware. The
  driver-class negative is already partially overturned; test whether AM4-Edit
  accepts the port before assuming.
- **[[juce-binarydata-zip]] → Axe-Edit II** — matched on AM4/III/FM3/FM9/VP4,
  still never listed for II (the template's own lens-6 question remains
  unanswered a third pass running). Value: II layout XML → displayLabel-class
  polish and an independent roster cross-check.
- **The 6-product UI-skin dispatcher finding → AX8-Edit / FX8-Edit.** HOP-4
  proved one shared editor codebase serves Fractal-Bot / Axe-Edit / Cab-Lab /
  FX8-Edit / AX8-Edit. `SeekParamTablesII.java`-style pattern scan +
  BinaryData carve + [[editor-cache-section-record-grammar]] should therefore
  transfer to AX8-Edit — a device-true catalog for the AX8, which the project
  roadmap already names as "a config in fractal-gen2." A new-device lane with
  zero hardware.
- **[[gen3-sub2e-grid-region-tail-anchor]] → any length-variant gen-3
  frame** and → the VP4 blob (1d).
- **AM4 ↔ gen-3 status-frame parity (product):** AM4's fn=0x01 action=0x1F
  snapshot already decodes a float32 live meter, active-scene index, and
  per-slot block types (`docs/devices/am4/SYSEX-MAP.md`); gen-3 `get_preset`
  now surfaces `live_meters`/`live_grid` for free. Surfacing the AM4 analogs
  is a local-only parity win.

## 5. Cookbook seed adjustments

- **Missing, evidence supports today:** gen-3 `fn=0x19 → 0x7a/0x7b/0x7c`
  user-IR/cab dump envelope (87-slot sweep); gen-3 `fn=0x43 → 0x51/0x52`
  edit-buffer dump (shipping in `export_preset`, no entry).
- **Refinement needed:** `ii-preset-binary-flat-byte-diff` — its
  "Huffman-compressed" premise conflicts with `gen2/presetDump.ts` and two
  stable-offset primitives (1b); `am4-preset-dump-flat-byte-diff` — annotate
  with the pending gen-3-codec test (1a) so the negative's scope is "flat
  byte diff," not "diffing is impossible."
- **Hygiene:** the 06-20 codec-fix backlog (F1–F7) is partially stale (F3,
  F7 done); the private artifacts manifest disagrees with disk on
  misc-descriptors.

## 6. Five highest-leverage next moves

1. **Run gen-3 presetHuffman over an AM4 dump + warm-pair rediff** — local,
   ~1 h, potential AM4 whole-preset decode (largest single yield available).
2. **Generate FM9 CAB/GEQ rosters from the in-hand cache; cross-check the
   06-04 picker list** — local, ~2-3 h, closes the "no cab roster" gap.
3. **Try the grid-bitstream layout on the VP4 `0x1f` blobs** — local, ~2-4 h;
   even partial fit constrains eid206 placement values.
4. **Bundle the catalog SET→GET roundtrip into Drew's queued FM3 re-run** —
   community hardware, ~1 h prep; delivers the FM3 enum-flow fix + grid-read
   confirmation + the corrected sub=0x09 probe in one session.
5. **De-frame + word-layer diff one II factory preset pair** — local, ~2 h;
   adjudicates 1b and potentially reopens II atomic apply.

## 7. Plan updates suggested

- Track "FM3 enum-flow parity" as an explicit gap (it is currently invisible
  because the fix landed per-device as data arrived).
- Add the decoded-layer-diff lane (1a/1b) to the AM4 and II shards; both
  flat-diff negatives should point at it.
- Queue the VP4-Edit and AM4-Edit simulator experiments as the standing
  alternative to waiting on community captures for placement/batch-write.
- Add an "AX8/FX8-Edit mining" backlog item (new gen-2 config, zero
  hardware).
- Adopt a manifest-vs-disk drift check for `samples/captured/decoded/` (the
  misc-descriptors discrepancy shows the living-doc rule failing silently).
