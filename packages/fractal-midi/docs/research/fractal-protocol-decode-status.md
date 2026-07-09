# Fractal protocol decode, status & references

**One-stop reference** for the cross-device Fractal protocol RE
work. If you're a new session (human or agent) trying to figure
out "what do we know about the Fractal protocol family, and where
is everything documented?", start here.

Last meaningful update: 2026-07-02. **AM4 stored-dump body DECODED: it is
the gen-3 preset container, verbatim.** The AM4 `0x77/0x78/0x79` dump body
(13 B header + 4 × 3,082 B chunks + 11 B footer) unpacks with the shared
container codec: chunk payload = 2-byte `[00 08]` discriminator + 3,072
packed bytes; 3-to-16 unpack → 8,192 B `raw_patch` (word[1]=`0xAA55` magic,
CRC-16/CCITT init `0xAA55` @0x04, 32-char ASCII name @0x08, decomp/comp
sizes @0x48/0x4A, gen-3 dynamic-Huffman body @0x4C, `fn 0x79` footer =
septet-packed u16 XOR of the words). Valid on all 104 fw 1.01 factory
presets + 13 fw 2.00 hardware exports (`scripts/verify-am4-preset-container.ts`,
890 checks / 117 dumps). The 2026-05 "encoder non-determinism" verdict is
explained: dynamic-Huffman table churn + one volatile decoded u16 @ body
`0x140E`; a no-op redump diffs by exactly 2 bytes at the decoded layer, so
decoded-layer one-variable diffing now works on AM4. **BODY block-record chain
DECODED for the AMP block (2026-07-02):** the body is a walkable chain, not a
fixed table (an amp type-swap shrank one body's `decompSize` 5344→4528). Each
block = an effectId marker (== block pidLow; amp = `0x003A`) + a `0x0E`-byte
header + 4 per-channel records at stride `0x130`; param word =
`marker + ch*0x130 + 0x0E + pidHigh*2`. Four warm-pair anchors CONFIRM it
(amp.type, amp.gain chA @`0x0958` / chB @`0x0A88`, amp.master chA @`0x0960`, all
`0x828E`=5.1). The amp marker's base is config-dependent: `0x0934` in 70/104
factory presets, `0x0A92` in 17, absent in 17, so `locateAm4AmpBlock` WALKS +
validates the record shape (zero false positives across the bank). Codec:
container primitives in `fractal-midi/shared` (`src/shared/presetContainer.ts`),
AM4 decoder `decodeAm4RawPatch` + body-chain walker `decodeAm4AmpBlock`
(`src/am4/bodyChain.ts`). Cookbook `[[am4-gen3-preset-container]]`.
The decode is WIRED to the MCP surface: `get_preset({ location: 'A01'..'Z04' })`
requests the stored flash dump (fn 0x03, no working-buffer side effect),
reassembles + decodes it, and returns preset name + 4 scene names + the CRC
flag **+ the AMP block's per-channel (A/B/C/D) param VALUES** on
`PresetSnapshot.whole_preset` (`source: 'stored-dump'`, `amp: {…}`,
community-beta, one ~150-200 ms round-trip;
`packages/am4/src/descriptor/reader.ts`). Amp: four fields hardware-anchored,
the rest formula-extrapolated on the same geometry. NON-amp block VALUES stay
LABELED-OMITTED; their per-block formula isn't capture-confirmed (5 UNMINED
one-variable captures would close it). Reader drive + amp walk covered by
`verify-am4-preset-container.ts` (§1 bank 70/17/17, §3 anchors, §4 mock fn-0x03).

Same-day (2026-07-02), the sister decode on the II side: **the Axe-Fx II
de-framed preset image is a self-describing TLV chain.** From word 130 of
the 4096-word image: `[wire_id, payload_len, payload...]` repeats until
wire_id 0: modifier records (slots 1..20, len 15) first, then effect
blocks ALPHABETICAL by squashed AxeEdit display name, then a fixed system
tail (`[Tone Match?, Noisegate, Output, FB Send?, FB Return?,
Controllers]`). `paramBase = tlvWord + 2`; channel-Y at `+payload_len/2`.
Confirmed 388/388 (384 Q8.02 factory presets + 4 live hardware dumps),
with the BK-070 one-variable hardware diffs landing at exactly the
predicted words (amp.bass ch-Y w252, amp.master_volume ch-Y w255 on Test
Crunch). This REFUTES the record-table-as-layout hypothesis (words
36..129 are grid-order metadata with ≥200 placeholders), retires the
static-width/calibration-probe paramBase path (widths drift across
firmware: factory Amp payload 234 vs live 236), and reopens the II atomic
read-modify-write apply, pending the screech-class safety review before
any MCP-facing tool ships. Decoder
`packages/fractal-gen2/src/presetImageTlv.ts`; sweep
`scripts/verify-ii-preset-image-tlv.ts`; SYSEX-MAP § 6b; cookbook
`[[ii-preset-image-tlv-chain]]` (+ `parambase-plus-paramid` promoted to
matched, `block-record-stride-8` corrected).

Prior meaningful update: 2026-07-01. **The June 2026 hardware arc: the modern
Fractal family got its first on-device confirmations.** The Axe-Fx III (the
gen-3 byte-identity anchor) was confirmed on real hardware for the first time
(2026-06-17 community owner test, fw 25.04, macOS): `set_param` (amp gain,
channel A) with a device echo plus a `get_param` read-back matching the front
panel, closing the long-open GET-response-shape 🟡 (Open question 1, now
CLOSED). The same owner test round-tripped `get_param` + continuous
`set_param` on FM9 hardware (fw 11.0), including channel-specific reads and
alias resolution. 2026-06-18: a full catalog-wide SET→GET hardware roundtrip
across FM9 + III (GitHub issue #6; saved at
`samples/captured/chihotta-roundtrip-2026-06-18/`) confirmed the read +
continuous-write paths catalog-wide and surfaced an FM9 enum-flow bug (~351
enum/type selectors routing as continuous floats instead of discrete
ordinals, fixed); the III got the same correction 2026-06-20 (~92 selectors)
using the roundtrip itself as the device oracle (kind-classification only,
no wire builder changed, byte-identity intact). 2026-06-19/20 Windows verify
probe (FM9): `set_block` placement hardware-confirmed (the placed block
appeared in the device's own fn=0x13 status dump), `switch_scene` round-trip
confirmed, and the current-type-by-NAME read (`fn=0x01 sub=0x1f`, MSB-first
septet ASCII) wire-confirmed. Earlier in the month, the FM3 field test
(2026-06-12, fw 12.00, macOS, USB-CDC serial) confirmed serial transport,
reads (incl. the `fn=0x1F` bulk poll, 35/42 blocks), continuous `set_param`,
`set_bypass`, `switch_scene`, and `switch_preset` via SysEx sub=0x27
end-to-end through this codec's own frames (CC32 bank select
hardware-FALSIFIED on the FM3); discrete set-by-name was
FM3-hardware-confirmed 2026-06-10 (community session, frames byte-identical
to our encoder). Also shipped: the original Axe-Fx Standard/Ultra (gen-1,
model `0x01`) as a community-beta device: 922 params / 35 blocks decoded
from the published spec, param SET + parameter READ-back over its own
nibble-split codec (new devices-table row below).

Prior meaningful update: 2026-05-29. AM4 `fn 0x01 action=0x1F`
snapshot deepened and its request frame isolated. Body fields beyond the
preset/scene names decoded against existing captures: `0x08` = active
scene index (verified `0 -> 1 -> 2 -> 3 -> 0` sweep), `0x0C` = float32-LE
live meter, `0xB0` = four per-slot block-type codes (`BLOCK_TYPE_VALUES`
pidLows; single-primitive). The exact 18-byte request frame
(`F0 00 01 74 15 01 4E 01 00 00 1F 00 00 00 00 00 41 F7`, length field
`00 00` vs the reply's `40 01`) was isolated from the AM4-Edit connect
USB capture. AM4 UI-MISSING confirmed CLOSED (live three-way join = 0;
remainders are GHOST or `paramId >= 65000` chrome). Axe-Fx II `fn 0x18`
GET_MODIFIER_INFO confirmed request-only, now active-hardware-confirmed
(Ares 2.00): even with a target set via `fn 0x37` (device 0x64-acks) and a
modifier assigned, `fn 0x18` emits no reply. Modifiers are READ over
`fn 0x07` (field-indexed: `[effId][slot][field][value16][ASCII label]`;
field 0x08/0x09 = target effectId/paramId, 0x00 = source). Cookbook
`[[ii-fn07-modifier-read]]`; SYSEX-MAP § 5i. `fn 0x37` SET_TARGET_BLOCK
wire shape (effectId septet payload) confirmed in the same capture. Grounded the III param-info request shape
(committed synthesis-logs): param ops ride `fn=0x01` (builder
`FUN_14033ec70`), a 6-field struct whose `action14` field is per-caller;
`action 0x1c` IS a real action14 value (`FUN_1401e42a0`), and the "Query
All Param Definitions" workflow registers reply fn-bytes
`{0x0a,0x0d,0x0c,0x47}`. Open: whether 0x1c specifically is getParamInfo,
and the reply body stride (do not assume the II `fn 0x16` 25-byte layout
transfers). Details in "Open questions" below.

Prior meaningful update: 2026-05-18. III SET_PARAMETER
pivot: open-web research surfaced 6 byte-exact public captures
(a Mountain Utilities forum thread, 2019) that contradicted the
shipping `fn=0x02` II-port envelope and corroborated the project's
own pre-existing `fn=0x01` decode. Combined with the 4 FC-12 captures
in `docs/devices/axe-fx-iii/fn01-decode.md`, the corpus is now **10 captures from
2 community sources** on `fn=0x01`. `src/gen3/axe-fx-iii/setParam.ts`
pivoted to `fn=0x01` + sub-action `09 00` (typed-input SET); 4 encoder
goldens + 4 capture-parse goldens added in
`scripts/verify-axe-fx-iii-encoding.ts`. Capture provenance archived
in `docs/devices/axe-fx-iii/set-parameter-captures.md`. SET 🟡 → 🟢; GET still 🟡
(no captured response frames). HW-AXEFX3-002 reframed from "verify the
shipping envelope" to "verify the device responds to the captured
envelope shape", still contributor-gated, but the SET wire shape no
longer needs hardware validation. Also closed 15 more AM4
entries (PEQ/COMP/GATE/INPUT/CHORUS/TREMOLO/ENHANCER),
lifting AM4 placeable coverage **91% → 93%**; drift guard
`WIRED_MISLABEL_CEILING=161 → 167`.

Prior meaningful update:  (2026-05-17 / 18, closed
(AM4 GLOBAL family `pidLow=0x0001` cracked + 98 entries wired);
 closed (Hydrasynth envelope time wire→ms tables verified
across 27 sample points);  closed (Axe-Fx II `apply_setlist`
3-preset round-trip on Q8.02 XL+);  closeout across PATCH /
CABINET / DISTORT lifted AM4 placeable coverage 84% → 91%;
`displayLabel` resolver landed in `list_params` `display_name` +
116-entry XML splice pass on shipped entries; cross-ref audit drift
guard at `WIRED_MISLABEL_CEILING=161` bumped from 154 for the
7 intentional context-disambig MISLABELs in the  closeout).

> **Run `npm run coverage-audit` before trusting any state claim in
> this doc.** The audit reads `packages/*/src/params.ts` +
> `scripts/verify-msg.ts` directly and reports current AM4-placeable
> coverage by-device, most reliable single-command answer to "where
> are we?" As of : AM4 placeable coverage is **91%**
> (716 catalog entries / 741 placeable params.ts entries; 791 total
> entries in `src/am4/params.ts` once GLOBAL's 98 system-
> settings entries and CABINET cross-block bonus are counted). 183
> distinct (pidLow, pidHigh) goldens carry byte-exact wire tests
> in `scripts/verify-msg.ts`. Cross-ref audit
> (`scripts/_research/coverage-cross-ref-audit.ts`) joins Ghidra
> catalog ↔ AM4-Edit XML ↔ `params.ts` and currently reports
> **WIRED-MATCHED=585 / =161 / =28 /
> GHOST=49 / PIDLOW-UNKNOWN=909**. Wired into preflight as a drift
> guard at `WIRED_MISLABEL_CEILING=161`. (Note: GLOBAL family is now
> classified via `PIDLOW_TO_FAMILY[0x0001]='GLOBAL'` with a per-family
> carve-out that treats GLOBAL entries as WIRED-MATCHED whenever
> the wire address is bound, GLOBAL's `name` field is the canonical
> wire symbol; the user-facing label is surfaced via `displayLabel`.)

---

## Devices covered

| Device | Model byte | Protocol family | Editor binary | Ghidra project | Decode state |
|---|---|---|---|---|---|
| AM4 | `0x15` | Axe-Fx III (subset + extensions) | `AM4-Edit.exe` | local Ghidra project | **Most complete.** 791 entries in `src/am4/params.ts` (741 placeable + 98 GLOBAL system-settings + cross-block bonus); placeable coverage **91%** of AM4-placeable catalog. PATCH family closed (routing, §6n-patch; scene-MIDI 48 params, §6n-scene-midi; scene-MIDI test-send partial, §6n-scene-midi-test, open). **GLOBAL family closed** (`pidLow=0x0001` cracked from `samples/captured/session-95-am4-global-pidlow.pcapng`; 98 entries wired; see `docs/devices/am4/SYSEX-MAP.md` §6bb). **Closeout** added 50 PATCH / CABINET / DISTORT entries from the AM4-Edit XML to Ghidra catalog join (`scripts/_research/list-ui-missing.ts`). 1732 paramId/name pairs across 47 families mined (catalog). Optional `displayLabel` field generated from AM4-Edit XML, now surfaced through `list_params` `display_name` resolver; 116-entry XML splice pass made every MISLABEL entry resolver-friendly. Cross-ref audit: WIRED-MATCHED=585 / WIRED-MISLABEL=161 / UI-MISSING=28 / GHOST=49. **Stored-dump body DECODED (2026-07-02): the gen-3 preset container verbatim** (4 chunks → 8,192 B CRC'd raw_patch → dynamic-Huffman body; `decodeAm4RawPatch` in `src/am4/presetContainer.ts`, oracle-validated over 117 dumps). **BODY block-record chain decoded for the AMP block:** walkable chain (marker=block pidLow + `0x0E` header + 4 per-channel records @ stride `0x130`; param word = `marker + ch*0x130 + 0x0E + pidHigh*2`), 4 warm-pair anchors byte-exact (amp.type/gain chA+chB/master), config-dependent base walked (`0x0934`/`0x0A92`/absent = 70/17/17, zero false positives); `locateAm4AmpBlock`/`decodeAm4AmpBlock` in `src/am4/bodyChain.ts`. AM4 stored `get_preset(location)` now surfaces `whole_preset.amp` (all 4 channels, community-beta; 4 fields HW-anchored, rest formula-extrapolated). Non-amp block VALUES omitted pending 5 UNMINED captures. Decoded-body field map still PARTIAL (name, 4 scene names, amp block, volatile word @0x140E). |
| Axe-Fx III | `0x10` | Axe-Fx III (full spec + community RE) | `Axe-Edit III.exe` (v1.14.31) | local Ghidra project | **Most of decode shipped via open-web captures, no III hardware needed.** v1.4 PDF opcodes shipping (bypass/channel/scene/tempo/looper/status). Ghidra mined **2,216 paramIds across 49 families** + **21 fn bytes confirmed in binary** (vs 10 in v1.4 PDF). **PIVOT**: SET_PARAMETER is `fn=0x01` + sub-action `09 00` (typed-input), 23-byte envelope, NOT `fn=0x02` as the earlier II-derived port assumed. Byte-verified against 10 public captures spanning two effect blocks (Drive 1/2 boost, Delay 1 TIME) and two sub-action codes (`09 00` typed-input + `52 00` mouse-drag) from an FC-12 forum scrape + a Mountain Utilities forum scrape. Capture provenance: `docs/devices/axe-fx-iii/set-parameter-captures.md`. 4 encoder + 4 capture-parse goldens in `scripts/verify-axe-fx-iii-encoding.ts`. **SET + GET now 🟢 hardware-confirmed (2026-06-17/18)**: a community owner test (fw 25.04, macOS) ran `set_param` (amp gain, channel A) through this codec's frames with a device echo and a `get_param` read-back matching the front panel (the FIRST on-device III confirmation, closing the long-open GET-response-shape 🟡), followed by a full catalog-wide SET→GET hardware roundtrip across III + FM9 (2026-06-18, GitHub issue #6; `samples/captured/chihotta-roundtrip-2026-06-18/`). That roundtrip then served as the device oracle for re-routing ~92 III type/model/count selectors from continuous-float to discrete (2026-06-20; kind-classification at the catalog boundary only, no wire builder changed, byte-identity intact). Discrete set-by-name + `save_preset` stay community-beta. Preset-save 0x77/0x78/0x79 community-known (forum thread #159885). **III lifted to Codec ✅ + Calibration ✅ in `fractal-midi`**: 302 round-trip codec goldens (build, parse, equality across 264 cases + 2 parseStateBroadcast assertions), `enumOverlay.ts` runtime vocabulary module with `provenance` tagging, `apply-calibration-overlay.ts` post-gen pass drove `'unverified'` 572 to 16 (string-typed only, exempted), calibration acceptance gate at `test/axe-fx-iii/calibration.test.ts`. The overlay mechanism is the template for FM3/FM9, see `fractal-midi-extraction-plan.md` §"Post-extraction." |
| Axe-Fx II XL+ | `0x07` | Axe-Fx II (separate family) | `Axe-Edit.exe` | local Ghidra project | **1,126 params shipping** via wiki + capture decode + Ghidra direct-pattern-scan addendum (221 net-new entries). `0x02 SET_PARAMETER` hardware-verified. `apply_setlist` 3-preset round-trip hardware-verified on Q8.02 XL+. Earlier "skip Ghidra for II" recommendation overturned, the 32-bit binary's param tables are recoverable via byte-pattern scan even when dispatcher xrefs fail; see `scripts/ghidra/SeekParamTablesII.java`. **Preset-image TLV chain DECODED (2026-07-02):** the de-framed 4096-word dump body is self-describing: `[wire_id, payload_len, payload]` from word 130, `paramBase = tlvWord + 2`, ch-Y at `+payload_len/2`; 388/388 corpus + BK-070 hardware anchors exact; walker `packages/fractal-gen2/src/presetImageTlv.ts`, SYSEX-MAP § 6b, cookbook `[[ii-preset-image-tlv-chain]]`. Unblocks atomic read-modify-write apply (MCP tool gated on the screech-class safety review). |
| Hydrasynth (line) | (vendor: ASM, not Fractal) | NRPN-based | n/a | n/a | Functional but separate workstream, included here for cross-reference. Founder owns the Explorer model; same SysEx/NRPN engine across Keyboard / Deluxe / Desktop / Explorer per ASM. Closed, envelope time wire→ms mapping verified across 27 sample points; `src/hydrasynth/nrpnDisplay.ts` `timeTable` confirmed zero-correction against device. Verify script: `scripts/hydrasynth/verify-nrpn-display.ts`. |
| FM3 / FM9 / VP4 | `0x11` / `0x12` / `0x14` | Axe-Fx III family | FM3/FM9/VP4-Edit | local + community capture | Device-true catalogs mined from each editor binary (`src/{fm3,fm9,vp4}/`), shipping via `fractal-gen3` configs (community-beta). **June 2026 hardware confirmations, FM3 (2026-06-12 field test, fw 12.00, macOS, USB-CDC serial):** serial transport, reads (incl. the `fn=0x1F` bulk poll, 35/42 blocks), continuous `set_param`, `set_bypass`, `switch_scene`, and `switch_preset` via SysEx sub=0x27 all confirmed end-to-end (CC32 bank select hardware-FALSIFIED on the FM3); discrete set-by-name FM3-hardware-confirmed 2026-06-10 (community session, frame byte-identical to our encoder). **FM9 (fw 11.0):** `get_param` + continuous `set_param` round-tripped on hardware 2026-06-17 (channel-specific reads + alias resolution); the 2026-06-18 catalog-wide SET→GET roundtrip (GitHub issue #6) surfaced + fixed the FM9 enum-flow bug (~351 enum/type selectors routed continuous instead of discrete); a 2026-06-19/20 Windows verify probe hardware-confirmed `set_block` placement (the placed block appeared in the device's own fn=0x13 status dump) + `switch_scene` round-trip, and wire-confirmed the current-type-by-NAME read (`fn=0x01 sub=0x1f`, MSB-first septet ASCII). Discrete set-by-name, `save_preset`, and the live grid read stay community-beta on the FM9. **VP4 read path now hardware-confirmed (fw 4.03):** a community editor-poll capture (Kevin Iudicello, 2026-06-08) byte-validates the VP4 `fn=0x01` PARAMETER GET wire shape, the gen-3 envelope/checksum, the block effect-ID table (Delay/Phaser/Wah/Drive), and the device-true paramId catalog for the Delay block; see `docs/devices/vp4/SYSEX-MAP.md`. **Family-wide read-path action item:** VP4-Edit reads via `fn=0x01` GET (effectId@pos6-7, no sub-action), NOT the `fn=0x1F` bulk poll the shipping reader assumes, and existing **FM3/FM9 editor captures** (`fm9-edit-connect.syx` 0/181 sub-action, `fm3-edit-connect-sync`) confirm FM3/FM9-Edit do the same (23-byte; VP4 is the 16-byte compact variant). `fn=0x1F` appears in no gen-3 editor capture we hold, and `buildGetParameter`/`buildSetParameter` inject a `09 00`/`52 00` sub-action + parse eid@pos8-9 (right for the III public captures, wrong for FM/VP editor frames). The shared-fn=0x01-layout assumption is only partly true (III ≠ FM/VP); audit the gen-3 codec's FM/VP addressing. See `samples/captured/decoded/vp4-403/FINDINGS.md` §8. **VP4 WRITE path decoded (2026-06-09 edit-session capture; corrected after workflow review):** 69 write frames mapped 1:1 to an annotated edit sequence. The 21-byte `fn=0x01` SET frame is known (`tc` sub-opcode at pos 9: 0x01 discrete / 0x02 continuous / 0x1b SAVE / 0x17 gesture), value codec = 5-septet LE float32 with the top two septets swapped (d18=s4, d19=s3), normalized [0,1] for continuous params. **Every write is synchronously echoed** (same eid/pid/tc, value verbatim for discrete) and SAVE has a distinct 16-byte completion ack; that echo is the write-confirmation channel (NOT get_param; the readback is telemetry-mixed). **Shipped community-beta `untested` (fractal-gen3 `write_allowlist`):** continuous `set_param`/`set_params` (raw 0..65534 wire value → normalized float; %/ms calibration pending), `set_bypass` (enable=0.0 / bypass-on replicated), `save_preset` (exact frame). Discrete/enum `set_param` refuses (zero captured evidence). **Still gated (wire bytes genuinely undecoded, not just untested):** `set_block`/`apply_preset` (eid206 pid10–16 placement; value→slot math open, cannot construct a move; register identities pinned 2026-07-01: pid10=delete, pid15/16=move pair, pid13=scene gesture), `switch_scene` (value↔scene mapping; a zero-cost read-only fn=0x0C scene-query probe may bypass pid13 entirely, see `captures-vp4.md` P0). **VP4 whole-preset STRUCTURE READ decoded (2026-07-01, mining pass over both captures):** the eid206 pid0 tc=0x1f blob is field-decoded: 220 packed bytes (chunked 8→7 unpack, [[iii-byte-stream-septet-pack-8to7]] promoted to `matched` on this second device axis) → 192 raw carrying the preset name, all 4 scene names, the CURRENT scene index (corrects the "no readable scene register" claim), and the serial 4-slot CHAIN (4×u32 LE effectId, 0=empty), oracle-matched against the annotated move cascade + scene switch across both presets; the v1 negatives ("preset name not in the capture", "slot order not recoverable") are OVERTURNED; both were unpack-scheme misses. Shipped: `fractal-midi/gen3/vp4/structureBlob.ts` + goldens (`test/gen3/vp4/structureblob.test.ts`, cookbook `vp4-eid206-structure-blob`); `fractal-gen3` `get_preset` (active) on VP4 now returns name + scene names + active scene + real chain-position slots in ONE round-trip (community-beta, untested on hardware; the fn=0x1F per-param audit item above stands). See `docs/devices/vp4/SYSEX-MAP.md` (STRUCTURE blob + PARAMETER SET) + `samples/captured/decoded/vp4-403-v2/{FINDINGS,CODEC-PLAN}.md`. The III's overlay-lift in `fractal-midi` is the template for FM3/FM9 calibration. |
| Axe-Fx Standard/Ultra (gen-1) | `0x01` | Its **own** nibble-split codec (pre-II: 8-bit fields split into two low-nibble-first bytes, fn `0x02`, trailing query(0)/set(1) flag, no checksum; not gen-2 septet, not gen-3 sub-action) | gen-1 AxeEdit (not mined) | n/a (spec-derived) | **Community-beta, spec-derived, no hardware confirmation yet.** 922 params / 35 blocks decoded byte-exactly from the published gen-1 SysEx param-set doc + its 0..255 conversion table (`src/gen1/`). Param SET + parameter READ-back both ship: fn `0x02` with the query flag → MIDI_PARAM_VALUE reply carrying the value + the device's own display label. Whole-patch dump (`0x03`→`0x04`): the pinned subset SHIPS as `get_preset` (name + 4×12 effect-grid layout + edit-buffer/stored flag, `src/gen1/patchDump.ts`); the ~1790-byte param block and the bank-C request byte stay open; one dump-with-ground-truth capture is the unlock (see the gen-1 capture guide, C1). Wire reference: `docs/devices/axe-fx-gen1/SYSEX-MAP.md`. |

---

## What's in each doc

### Wire-format references (committed, public)

| Doc | Covers |
|---|---|
| [`docs/devices/am4/SYSEX-MAP.md`](devices/am4/SYSEX-MAP.md) | AM4 wire spec. §6a is the `0x01` SET_PARAM dispatcher; §6p is the canonical finding: `pidLow=block, pidHigh=catalog paramId`. §6b value encoding (8-to-7 bit-pack), §6c block placement, §6k cab cross-block, §6l Main Levels (`preset.level / balance / scene_{1..4}_level`), §6m preset-name read, §6n-patch PATCH routing, §6n-scene-midi 48 scene-MIDI params, §6n-scene-midi-test test-send wire frame `action=0x0004 / pidHigh=0x0070` (🟡 partial), §6bb GLOBAL family `pidLow=0x0001` (system settings, float32 LE encoding, enum ints packed as floats). |
| [`docs/devices/axe-fx-iii/SYSEX-MAP.md`](devices/axe-fx-iii/SYSEX-MAP.md) | III wire spec. Covers v1.4 PDF (10 documented functions) + 21 fn bytes confirmed via Ghidra caller trace + the 49-effect dispatcher catalog. **0x01 PARAMETER_SETGET** documents the byte-verified III parameter-write envelope (fn=`0x01` plus sub-action `09 00`), with the 10-capture community-evidence chain; SET and GET are both 🟢 (hardware-confirmed 2026-06-17/18, see top-of-file summary). The old `fn=0x02` II-port is preserved only as a closed historical hypothesis. Documents what III's SET_PARAM ISN'T (fn=0x1f ruled out). |
| [`docs/devices/axe-fx-ii/SYSEX-MAP.md`](devices/axe-fx-ii/SYSEX-MAP.md) | II wire spec, community RE work + Ghidra direct-scan addendum. |
| [`docs/BLOCK-PARAMS.md`](BLOCK-PARAMS.md) | AM4 block reference. Header table maps each AM4 block to its pidLow, catalog family, dispatcher case, and catalog param count. Points at the Ghidra catalog as the primary source. |
| [`docs/research/ghidra-mining-workflow.md`](ghidra-mining-workflow.md) | **Workflow recipe**: how to mine a new Fractal editor binary. Captures the 3-tier proven technique, v1 failure modes to avoid, dispatcher discovery, ParamDescriptor struct layout, headless runner pattern, cross-block addressing pattern. Addendum: direct-pattern-scan technique for 32-bit binaries where dispatcher-xref fails. Read this first before opening a new Ghidra project. |
| [`docs/research/fractal-midi-extraction-plan.md`](fractal-midi-extraction-plan.md) | **Vendor protocol package plan**. Per-file move table covering `src/shared/`, `src/am4/`, `src/gen2/axe-fx-ii/`, `src/gen3/axe-fx-iii/`; consumer-facing API surface for `fractal-midi` (codec-only, no `node-midi`). |

### Research / decode-history (committed)

| Doc | Covers |
|---|---|
| [`docs/devices/axe-fx-iii/fn01-decode.md`](devices/axe-fx-iii/fn01-decode.md) | III function 0x01, three-mode envelope. -82 RE work. |
| [`docs/devices/axe-fx-iii/preset-format-research.md`](devices/axe-fx-iii/preset-format-research.md) | III preset-save format research (forum thread #159885 archive). |
| [`docs/devices/axe-fx-ii/community-re-methodology.md`](devices/axe-fx-ii/community-re-methodology.md) | II community RE methodology background. |
| `founder-private decision log` (founder-private; gitignored) | Architectural decisions. 2026-05-16 entry covers the Ghidra-as-canonical-RE-method decision. 2026-05-17 entry locks in the `fractal-midi` vendor-package split. |

### Ghidra outputs (gitignored, regenerate locally)

All under `samples/captured/decoded/`:

| File | How to regenerate |
|---|---|
| `ghidra-am4-paramnames.json` | `scripts/ghidra/run-am4-paramnames.cmd` |
| `ghidra-axeedit3-paramnames.json` | `scripts/ghidra/run-axeedit3-paramnames.cmd` |
| `ghidra-axeedit3-message-builders.txt` | `scripts/ghidra/run-axeedit3-message-builders.cmd` |
| `ghidra-axeedit3-v2.txt` (mining sweep) | `scripts/ghidra/run-axeedit3-v2.cmd` (if exists; else run via GUI) |
| `am4-params-proposed.ts` | `npx tsx scripts/_research/generate-am4-params-from-catalog.ts` |
| `am4-coverage-report.md` | `npx tsx scripts/_research/am4-catalog-coverage-report.ts` |

---

## Ghidra scripts (committed, regenerate outputs locally)

Under `scripts/ghidra/`:

### Per-device scripts

| Script | Targets | Purpose |
|---|---|---|
| `MineAxeEditIII.java` / `MineAxeEditIIIv2.java` | Axe-Edit III.exe | Broad protocol-string sweep, symbol-table walk + byte-pattern hits + instruction-walk fallback |
| `MineAxeEditIIIParamResolver.java` | Axe-Edit III.exe | Rank functions by # of param-symbol references, identifies the dispatcher |
| `DumpAxeEditIIIParamNames.java` | Axe-Edit III.exe | Extract per-effect `(paramId, name)` pairs from the dispatcher |
| `DumpAxeEditIIIParamTables.java` / `V2.java` | Axe-Edit III.exe | Earlier table-extraction iterations (superseded by ParamNames) |
| `TraceAxeEditIIIMessageBuilders.java` | Axe-Edit III.exe | Walk callers of generic SysEx builders to enumerate fn bytes |
| `MineAM4EditParamResolver.java` | AM4-Edit.exe | AM4 equivalent of the III resolver script |
| `DumpAM4ParamNames.java` | AM4-Edit.exe | AM4 equivalent of the III param-names dumper |
| `MineAxeEditIIParamResolver.java` | Axe-Edit.exe (II) | II equivalent, dispatcher-xref dead end on the 32-bit binary; see SeekParamTablesII instead |
| `SeekParamTablesII.java` | Axe-Edit.exe (II) | ** direct-pattern-scan miner.** Recovers 1,113 (paramId, symbol) entries from the 32-bit II binary at 99% indexed-symbol coverage; works even when dispatcher xrefs fail. Output post-processed by `scripts/_research/generate-axe-fx-ii-params-from-ghidra.ts`. |
| `run-*.cmd` | (runners) | Headless invocation wrappers |
| Earlier-era scripts (`FindEncoder.java`, `FindAxeEditRouting.java`, etc.) | AM4-Edit / II | Original techniques the -83 work was built on |

### Analysis helpers (TypeScript)

Under `scripts/_research/`:

| Script | Purpose |
|---|---|
| `survey-axeedit3-anchors.ts` | Bucket strings JSON by prefix family to pick Ghidra anchors |
| `analyze-param-symbol-tables.ts` | Find contiguous runs in offset-sorted string lists |
| `find-axeedit3-sysex-fnbyte-array.ts` | Scan binary for parallel fn-byte arrays (negative result on III) |
| `mine-axeedit3-sysex-table.ts` | Extract+sort SYSEX_* strings |
| `parse-ghidra-axeedit3-mine.ts` | Post-Ghidra structured extraction (switch cases, decompile blocks) |
| `compare-am4-params-coverage.ts` / `v2.ts` | Audit params.ts against Ghidra catalog |
| `generate-am4-params-from-catalog.ts` | Emit proposed `params.ts` entries from catalog (verified wire mapping) |
| `generate-axe-fx-ii-params-from-ghidra.ts` | Emit proposed II `params.ts` entries from  direct-scan output, preserving the hardware-verified header + Ghidra addendum block across regens |
| `validate-params-against-catalog.ts` | Validate `params.ts` correctness against catalog + blockTypes.ts |
| `am4-catalog-coverage-report.ts` | Emit per-block markdown coverage report |
| `coverage-cross-ref-audit.ts` | **Three-way join (catalog ↔ XML ↔ params.ts)**: cont, refreshed  with GLOBAL family classification + carve-out. Classifies every catalog entry as WIRED-MATCHED /  /  / GHOST / PIDLOW-UNKNOWN. Wired into preflight as a drift guard at `WIRED_MISLABEL_CEILING=161`. Output: `samples/captured/decoded/coverage-cross-ref-audit.md` |
| `list-ui-missing.ts` |, uncapped  dump for one or more families (the shipping audit caps at top 50). `npx tsx scripts/_research/list-ui-missing.ts PATCH CABINET DISTORT` |
| `list-mislabel-without-displaylabel.ts` |, surfaces  entries that the `displayLabel` resolver doesn't already cover. Drives the idempotent label-splice pass. |
| `inplace-patch-display-labels.ts` |, idempotent regenerator. Joins (block_pidLow, pidHigh) → Ghidra catalog symbol → AM4-Edit XML label, splices `displayLabel: "..."` into any entry that doesn't already have one. Safe to re-run. |
| `generate-am4-global-block.ts` |, regenerates the GLOBAL family params.ts block (98 entries under pidLow=0x0001) from the Ghidra catalog + XML labels. Source-of-truth for -derived GLOBAL entries. |
| `add-display-labels.ts` | Idempotent generator that populates the optional `displayLabel` field on `params.ts` entries from AM4-Edit XML |
| `decode-session-85-scene-midi.ts` | Decode scene-MIDI captures into 16-msg Type/Channel/Value rows |
| `decode-hw110.ts` | Decode scene-MIDI test-send capture |
| `probe-dirty-gate.ts` | Regression probe that hashes the AM4 working buffer twice + asserts dirty-after-set_param differs + asserts switch_preset refuses with structured warning. Locks in the SysEx assembler fix. |

---

## Key findings cheat sheet

### Wire mapping (verified 99% on AM4)

- `pidLow` = block-type pidLow from `src/am4/blockTypes.ts`
- `pidHigh` ≥ 10 = Ghidra catalog paramId for that block's family
- `pidHigh` 0-9 = generic shared params (0=level, 1=mix, 2=balance, 4=bypass_mode; 7+8 partially documented)
- `pidHigh` = 0x07D2 (2002) = channel-select register (separate code path)

### Cross-block addressing on AM4

- AMP + DRIVE both pull from DISTORT family (case 0xa, 143 params).
  AMP via `pidLow=0x003a`, DRIVE via `pidLow=0x0076`.
- AMP has NO separate dispatcher case. Closes the 
  "missing AMP dispatcher" question.

### Non-placeable addressable blocks

These pidLows are addressable but not in `BLOCK_TYPE_VALUES`:

- `0x0025` Input Noise Gate (`ingate.*`, INPUT family)
- `0x003e` Cabinet (CABINET family, §6k)
- `0x00CE` PATCH family (case 0x3c, 85 params, preset.level/balance, scene_{1..4}_level, routing_slot_{2,3,4}, scene_{1..4}_midi_{1..4}_{type,channel,value}). Decoded in the PATCH + scene-MIDI arc, §6n-patch + §6n-scene-midi. The PATCH `PATCH_SCENE_OUTPUT1..4` entries are NOT a phantom per-scene output mode, they're the Scene N Level knobs already shipping at `preset.scene_{1..4}_level` (closure). `PATCH_4CM` is a firmware ghost with no AM4-Edit UI (4CM on AM4 is a wiring pattern, not a software toggle).
- `0x0001` GLOBAL family (case 0x1, 99 paramIds in catalog, system settings: USB level, tap-tempo mode, tuner reference, delay spillover, etc.). Closed, see `docs/devices/am4/SYSEX-MAP.md` §6bb. 98 entries wired into `src/am4/params.ts` under `block: 'global'`; two byte-exact verify-msg goldens (`global.usblevel1`, `global.tap_tempo_mode`) confirm the dispatcher path. Wire-value encoding: float32 little-endian written into the standard SET_PARAM tail (enum ints packed as floats, e.g. `GLOBAL_TAP_TEMPO_MODE = 1.0` = "Last Two").

### Transport-layer fix

`https://github.com/TheAndrewStaker/mcp-midi-control/tree/main/packages/core/src/midi/transport.ts:createSysExAssembler` (pure
exported function, ~50 LOC) buffers bytes between F0…F7 across
multiple WinMM callbacks before invoking downstream handlers.
RtMidi's WinMM input callback delivers SysEx in 1024-byte chunks
without waiting for `F7`, so a 3082-byte AM4 preset dump arrived
as 3 to 4 separate `message` events and the dirty-gate's preset-dump
receiver rejected every chunk as malformed → fingerprint cache
never populated → every navigation silently discarded dirty edits.
The fix is wired into `connect()` and covered by 7 byte-exact
goldens in `scripts/verify-sysex-assembler.ts` (3082-byte AM4
4-fragment case, 2KB 2-fragment case, single-fragment, back-to-
back SysEx, interleave, empty fragments). Affects every device
that reads messages >1024 bytes (AM4 preset dumps + factory
restore; II preset dumps are larger).

### III function-byte inventory (-83)

21 fn bytes confirmed via FUN_1403437d0 caller trace, vs 10 in v1.4 PDF:

`0x0A 0x0B 0x0C 0x0D 0x0E 0x0F 0x10 0x11 0x12 0x13 0x14 0x19 0x1A 0x1B 0x1F 0x3F 0x40 0x46 0x47 0x5A 0x5B 0x5C 0x74 0x75 0x76 0x77 0x78 0x79 0x7A 0x7B 0x7C`

III SET_PARAM status: **🟢 SET + GET hardware-confirmed**: `fn=0x01` PARAMETER_SETGET plus sub-action `09 00` (23-byte envelope), byte-verified against 10 public captures, and then confirmed on a real III (2026-06-17 owner test: `set_param` with device echo + `get_param` read-back matching the front panel; 2026-06-18 catalog-wide SET→GET roundtrip). The earlier `fn=0x02` II-port (model-byte swap `0x03`→`0x10`) was superseded by the open-web capture sweep; see the top-of-file summary. fn=0x1f was ruled out as the SET opcode (caller decompile shows a 16-bit payload, too small). See `docs/devices/axe-fx-iii/SYSEX-MAP.md` 0x01 PARAMETER_SETGET section.

---

## Open questions / next-session candidates

In rough order of impact:

1. ~~**Verify the III responds to the byte-verified `fn=0x01` SET_PARAMETER envelope on real hardware**~~ **CLOSED 2026-06-17/18 on hardware.** A community III owner (fw 25.04, macOS) ran `set_param` (amp gain, channel A) through our tool with a device echo and a `get_param` read-back matching the front panel, and the 2026-06-18 catalog-wide SET→GET roundtrip (GitHub issue #6; `samples/captured/chihotta-roundtrip-2026-06-18/`) confirmed the read + continuous-write paths across the entire III catalog: SET 🟢 end-to-end and the GET response shape decoded from live replies.

2. ~~**Close the AM4 UI-MISSING params**~~ **CLOSED.** A live three-way join (Ghidra catalog + `__block_layout` XML + current `params.ts`) via `scripts/_research/list-ui-missing.ts` now reports UI-MISSING = **0** across every family. The previously-expected gaps (PATCH 29 / DISTORT 19 / CABINET 13 / COMP 4 / PEQ 2 / GEQ 1 / TREMOLO 2 / GATE 1 / CHORUS 1 / ENHANCER 1 / VOLUME 1 / INPUT 5) were absorbed by the placeable-coverage closeout passes; every remaining unwired catalog symbol is either GHOST (no XML control) or a `paramId >= 65000` UI widget (Name/Cab/ALIGN/Graph/Copy-menu chrome, `*_ZEROEQ` "Zero All" buttons), not a wire param. The audit tool's hardcoded params path was stale (`packages/am4/src/params.ts` predated the `fractal-midi` extraction); fixed to `packages/fractal-midi/src/am4/params.ts`.

3. **: decode the scene-MIDI test-send per-row payload byte packing** ( cont). Per-scene "Send All" payload fully decoded: `byte[2] = (scene_idx<<5) | 0x0F`. Per-row payload partial. Closes SYSEX-MAP §6n-scene-midi-test from 🟡 → 🟢. P3, non-blocking.

4. ** review pass** (161 entries, ceiling at `WIRED_MISLABEL_CEILING=161`). After the  `displayLabel` resolver + 116-entry XML splice, every MISLABEL entry already surfaces the friendly AM4-Edit label to the LLM via `display_name`, the underlying `name`-vs-XML mismatch is a cosmetic audit metric, not a UX gap. Most are intentional disambiguation (cabinet `_1`/`_2` pairs, COMP `sidechain_*` prefixes, four `delay.lfo_{1,2,3,4}_type` entries all displaying as "LFO Type"). Targeted reviews tightened the count over later passes; further passes could lower the ceiling but the agent-facing UX is already covered by `displayLabel`. Use `scripts/_research/list-mislabel-without-displaylabel.ts` to find entries that still need `displayLabel` attention.

5. **action=0x0017 anomaly trigger still unknown.** ruled out test-send buttons via  (16 per-row + 4 per-scene clicks → zero `action=0x0017` frames; test-send fires `action=0x0004 / pidHigh=0x0070` instead). Next candidate hypotheses: "Quick Build" button or another page-level AM4-Edit action. NOT blocking any user-facing feature.

6. **Investigate generic `pidHigh` 7 and 8**: currently seen on `delay.kill_dry` and `amp.out_boost_level` respectively. Are they cross-block (a fifth and sixth generic slot) or block-specific overflows?

7. **Verify `amp.cab1_distance` `pidHigh`**: ~~validator-flagged~~ **resolved **: hardware-verified at pidHigh=0x02 under cab pidLow=0x3e (cross-block addressing per §6k). Ghidra catalog's `CABINET_PROXIMITY1` (paramId 20) is a separate unbound cab param. Kept here as a pointer; not a real open question.

8. **`SYSEX_DSP_MESSAGE` decode**: confirmed string in III binary, fn byte unknown. Would unlock `get_dsp_usage` per  forum-wishlist Item 3.

9. **AM4-Edit alternate dispatcher hunt**: case 0x3a in `FUN_1402e3da0` returns an empty table. What's its purpose? (Same on III's `FUN_140397a40`.) Are there OTHER dispatchers we haven't found?

10. **Cross-publish AM4 / III catalogs**: both binaries use the same Fractal symbolic names. A shared `fractal-shared/catalog/` package could centralize the per-family paramId enums (so amp.gain on AM4 and reverb.time on III both pull canonical names from one source). Architectural, would prep the unified surface. Some of this prep landed (`docs/research/fractal-midi-extraction-plan.md`).

### Ranked next-decode leads (from the read-only correctness + related-paths sweep)

Ranked by payoff-per-cost. Hardware-gated leads have a matching entry in
the project's per-device hardware-task list with the exact read-only frame.

| Rank | Lead | Cracking artifact | Hardware-free? | Payoff |
|---|---|---|---|---|
| 1 | ~~fn 0x0E QUERY_STATES bypass + scene bit semantics~~ **CLOSED on hardware**: tag bit `0x01` = engaged vs bypassed, bit `0x02` = active channel, frame is active-scene-derived; `b1..b4` = a per-block address/offset (INVARIANT across bypass/channel/scene), not a state bitmap. See cookbook `ii-fn0e-query-states`. | done | done | Whole-preset minimal-path state read is field-decoded |
| 2 | ~~fn 0x16 enum-count catalog reconciliation (II)~~ **CLOSED on hardware (2026-06-09)**: the receive path now reassembles node-midi's 2048-byte WinMM fragments (`createSysExAssembler`), and the post-fix fn 0x28 re-run captured the full amp table in one untruncated frame: **266 labels (ordinals 0..265), 266/266 display-equal vs the shipped catalog**. The fn 0x16 `G2` "265" reading was the max ordinal, not the count; the 7 names the old capture lost (FRIEDMAN BE C45 .. SKULL CRUSHER) were independently confirmed by the Axe-Edit cache (cookbook `editor-cache-section-record-grammar`). See II SYSEX-MAP §5g/§5h. | done | done | II amp roster complete and hardware-confirmed |
| 3 | ~~fn 0x16 G2/G3 max-vs-default role~~ **CLOSED on hardware**: `G0` = default (not current), `G1` = min, `G2` = enum value count (or internal max for knobs), `G3` = `1.0` sentinel, `G4` = step / resolution. See cookbook `ii-fn16-get-param-info`. Remaining: the continuous-param `G2`/`G3` internal-vs-display split. | done | done | fn 0x16 descriptor roles labeled |
| 4 | ~~AM4 fn 0x01 action=0x1F snapshot~~ **mostly closed**. Body fields decoded: `0x08`=active scene index (verified `0->3` sweep), `0x0C`=float32 live meter, `0xB0`=four per-slot block-type codes (`BLOCK_TYPE_VALUES` pidLows). Request frame isolated (18-byte, `... 1F 00 00 00 00 00 41 F7`). Remaining: promote the footer block-type transition to N>=2 via a second one-variable block-swap capture. | Second one-variable block-swap action=0x1F capture | Single capture left | Confirms footer[slot] = block-type ID rather than slot-occupancy |
| 5 | III param-info / block-definition reply body shape + fn 0x0E scene-name reply shape. GROUNDED (committed synthesis-logs, gitignored dumps regenerate via `MineAxeEditIIIActionsAndShapes.java` / `FindAxeEditIIIInboundDispatcher.java`): the host requests param ops via `fn=0x01` (builder `FUN_14033ec70`), a 6-field struct `[action14:2][effectId14:2][paramId14:2][value32:5][modifier14:2][tailCount14:2][tail:N]` whose `action14` is per-caller; `action 0x1c` is a real action14 value (`FUN_1401e42a0`, uniform across model bytes). The "Query All Param Definitions" workflow registers INBOUND reply fn-bytes `{0x0a,0x0d,0x0c,0x47}` (`+0x0b` for singular "Query Param Definition"). OPEN: whether `action 0x1c` specifically is the getParamInfo request (the `msg_getParamInfo` caller's workflow label lives in the gitignored dump) and the reply body stride (the fn=0x01 `value32` field is 5-septet 32-bit packing, but the param-definition REPLY rides fn 0x0a/0x0c/0x0d/0x47, whose body is not decoded; do NOT assume the II fn 0x16 fixed 25-byte layout transfers). | Passive III USBPcap of AxeEdit's own block-definition read (request + reply pair) to pin the reply body stride; the request fn=0x01 + action shape is already grounded | No (contributor-gated) | Pins which action14 is param-info and the reply body stride |
| 6 | INDEX.md axis-legend clarification: do footswitch-wire and editor-wire count as two capture-context axes? | Documentation only | Yes | Removes the axis-classification ambiguity that makes `iii-fn01-set-parameter-envelope` matched-status thin |
| 7 | Make the cookbook-verify golden pointer load-bearing (warn when a non-STUB pointer names a missing fixture key) | `scripts/cookbook-verify.ts` | Yes | Prevents silent drift between frontmatter golden pointers and the actual fixture table |

**Closed since last update:**

- ~~Capture AM4 GLOBAL block pidLow~~, closed: `pidLow=0x0001`, 98 entries wired, see SYSEX-MAP §6bb. Wire encoding: float32 LE, enum ints packed as floats.
- ~~Hydrasynth envelope time wire→ms decode~~, closed: 27 (N, display) pairs verified front-panel against `src/hydrasynth/nrpnDisplay.ts` timeTable; zero corrections needed. Verify script `scripts/hydrasynth/verify-nrpn-display.ts` now ships 39 hardware-locked goldens (was 12).
- ~~Axe-Fx II `apply_setlist` 3-preset round-trip~~, closed: hardware-verified on Q8.02 XL+ via Claude Desktop; safe-edit overwrite gate confirmed working.
- ~~"Skip Ghidra for II" recommendation~~, overturned: direct-pattern-scan (`scripts/ghidra/SeekParamTablesII.java`) recovered 1,113 (paramId, symbol) entries at 99% indexed-symbol coverage; 221 net-new params merged into `src/gen2/axe-fx-ii/params.ts` (addendum). 32-bit dispatcher-xref is still a dead end, but byte-pattern scan is not.
- ~~Capture AM4 PATCH block pidLow~~, closed (`pidLow=0x00CE`, §6n-patch).
- ~~Decode the 0x3e81 action=0x0017 scene-MIDI anomaly~~, decoupled: scene-MIDI uses standard `action=0x0001 SET_PARAM`; the 0x0017 anomaly is a different (unknown-trigger) operation.
- ~~PATCH_SCENE_OUTPUT1..4 + PATCH_4CM coverage gaps~~, closed: the SCENE_OUTPUT entries ARE the Scene N Level knobs (already shipping); `PATCH_4CM` is a firmware ghost with no UI.
- ~~SysEx fragmentation breaking AM4 dirty-gate~~, closed (`createSysExAssembler` in `transport.ts` + 7 goldens).

---

## Where to find what

| Question | Answer |
|---|---|
| What does a SysEx envelope look like? | `docs/devices/am4/SYSEX-MAP.md` §2, `docs/devices/axe-fx-iii/SYSEX-MAP.md` "Envelope" |
| What pidLow does block X use? | `src/am4/blockTypes.ts` (placeable) + `docs/devices/am4/SYSEX-MAP.md` §6p (non-placeable: cab, ingate, patch, global) |
| What params does block X have? | `samples/captured/decoded/ghidra-am4-paramnames.json` (regenerate via `.cmd`) + coverage report |
| What's verified vs hypothesized? | This doc's "Devices covered" + "Open questions" |
| How do I decode a new Fractal device? | `docs/research/ghidra-mining-workflow.md` |
| Why does AMP share DISTORT? | `docs/devices/am4/SYSEX-MAP.md` §6p + this doc's cross-block section |
| What's the next high-impact decode work? | This doc's "Open questions", items 1-4 are the unlocks |

---

## Session log (high-level)

- **AM4 protocol arc**: AM4 protocol reverse-engineering via USB capture
  + hand-decode. Built `params.ts` (~400 entries), all 4 slots, scenes,
  channels, preset save/rename. Detailed in `founder-private session log`
  (gitignored, founder's local log).
- **-79**: Mock transport for agent-regression; III forum-
  scrape research; III function 0x01 decode.
- **-81**: III 0x64 result-code table extracted from AxeEdit
  III binary (28 codes); III v1.4 non-addressable IDs marked
  (ID_CONTROL, ID_MIDIBLOCK, ID_FOOTCONTROLLER, ID_PRESET_FC).
- **** (2026-05-16): **Ghidra mining sweep**. Extracted
  full per-effect param dictionaries for AM4 (1732 pairs / 47
  families) and III (2,216 pairs / 49 families). 21 III fn bytes
  confirmed via caller trace.
- **2026-05-16 overnight**: **AMP=DISTORT closure +
  documentation hardening**. Validator, coverage report, full
  workflow recipe, II mining script staged. fn=0x1f walk-back.
- **2026-05-16**: **Two AM4 hardware decodes closed in
  one session.** Main Levels (`preset.level / balance /
  scene_{1..4}_level`, §6l). PATCH family (`pidLow=0x00CE`,
  §6n-patch): routing toggles, 10 new MCP params, 185/185
  verify-msg goldens green.
- **Scene-MIDI arc** (2026-05-16): **Scene-MIDI bank decoded
  end-to-end.** 48 new MCP-addressable params
  (`preset.scene_{1..4}_midi_{1..4}_{type,channel,value}`),
  Type-enum-folds-CC# encoding screenshot-confirmed (§6n-scene-midi).
  Axe-Fx III SET_PARAMETER initially ported from II as `fn=0x02`
  (untested); later superseded by the byte-verified `fn=0x01` envelope,
  see top-of-file summary.
- **** (2026-05-16): **AM4 dirty-gate fixed at the
  transport root.** `createSysExAssembler` in
  `https://github.com/TheAndrewStaker/mcp-midi-control/tree/main/packages/core/src/midi/transport.ts` (~50 LOC pure function)
  buffers F0…F7 across WinMM's 1024-byte SysEx chunks; closes a
  bug where 3082-byte AM4 preset dumps arrived as 3 to 4 separate
  events and the dirty-gate silently fell through to proceed.
  Verified live against AM4 via `probe-dirty-gate.ts`.
- ** cont** (2026-05-16): **Cross-ref audit infra +
  displayLabel field + scene-MIDI test-send wire shape.**
  `coverage-cross-ref-audit.ts` joins catalog ↔ XML ↔ params.ts
  (=135 / =298 / GHOST=61 initially, wired
  into preflight). `Param.displayLabel` optional field added.
   closed (test-send fires `action=0x0004 / pidHigh=0x0070`,
  NOT the 0x0017 anomaly); per-scene "Send All" payload decoded;
  per-row payload partial ( open). Coverage-audit now
  reports by-device with placeable-only TOTAL.
- **Catalog closeout arc** (2026-05-16/17): ** closeout
  passes** lifted AM4 placeable coverage 50% → 84%. DISTORT,
  REVERB, DELAY, CHORUS, FLANGER, PHASER, FILTER, TREMOLO,
  ENHANCER, COMPRESSOR, CABINET batches handled via the
  paramNames-overlay path (no direct params.ts hand-edits).
   drifted 135 → 158 then tightened to 154 via
  targeted REVERB rename pass (/96).
- **** (2026-05-17): **Axe-Fx II Ghidra direct-scan
  breakthrough.** `SeekParamTablesII.java` byte-pattern scans the
  32-bit Axe-Edit binary directly and recovers 1,113 (paramId,
  symbol) entries at 99% indexed-symbol coverage. 470 NEW II
  params became mineable (entire VOCODER/RESONATOR/MOD blocks).
  221 net-new entries paste-merged into `src/gen2/axe-fx-ii/
  params.ts` (905 → 1,126). "Skip Ghidra for II" overturned;
  documented in `docs/research/ghidra-mining-workflow.md` 
  technique addendum. Also: `docs/research/fractal-midi-extraction-plan.md`
  drafted (vendor protocol package, codec-only).
- **** (2026-05-17): ** closed.** Hydrasynth
  envelope time wire→ms tables verified across 27 (N, display)
  pairs front-panel, zero corrections to `nrpnDisplay.ts`
  `timeTable`. `scripts/hydrasynth/verify-nrpn-display.ts` grew
  12 → 39 hardware-locked goldens. Decoder seconds-format regex
  tightened to keep one decimal + match device suffix "Sec".
- **** (2026-05-17): ** closed, AM4 GLOBAL
  family cracked.** `pidLow=0x0001` decoded from
  `samples/captured/session-95-am4-global-pidlow.pcapng`. 98 of
  99 catalog GLOBAL paramIds wired into `src/am4/
  params.ts` under `block: 'global'` with two byte-exact
  verify-msg goldens (`global.usblevel1`, `global.tap_tempo_mode`).
  Wire encoding: float32 LE, enum ints packed as floats. See
  SYSEX-MAP §6bb. `displayLabel` field now surfaced through the
  unified `list_params` `display_name` resolver (commit `077c1c0`).
  REVERB rename pass (commit `d7d7d78`) trimmed 
  158 → 154.
- ** cont** (2026-05-17): ** closed, Axe-Fx II
  `apply_setlist` 3-preset round-trip hardware-verified on Q8.02
  XL+** via Claude Desktop. Safe-edit overwrite gate confirmed
  working (pre-flight `scan_preset_range` surfaced existing names,
  agent paused for confirmation).
