---
name: gen3-sub01-block-definition-response
class: envelope-shape
status: matched-singleton
discovered: 2026-06-09
verified_on:
  - fm9-community-capture-fw11.0 (fm9test2 reverb-sweep device-to-host stream, 3,042 frames, 18 eids x 169 polling rounds)
firmware_sensitive: unknown (record is fixed-size; name/abbreviation content is firmware-versioned)
golden: case-gen3-sub01-block-definition-response in scripts/primitives-verify.ts (decode the captured eid=66 reference frame into the 80-byte record fields)
relates_to: [iii-fn01-set-parameter-envelope, iii-byte-stream-septet-pack-8to7, editor-cache-section-record-grammar, gen3-fn1f-poll-block-bulk-read, gen3-editor-sync-read-surface]
consumed_in:
  - scripts/harvest-device-metadata.ts (consumer repo; gen-3 block-descriptor sweep records these frames raw)
---

# Gen-3 fn=0x01 sub=0x01 block-definition response

The device answers the editor's sub=0x01 "Reading Block Definition" query
(FACT-tier in the editor decompile's action14 table: code 0x01,
waits-for-reply) with a fixed 113-byte+F7 frame: the standard 6-field
fn=0x01 envelope carrying blockId14=eid, paramId14=0, tailCount14=80, and a
92-septet tail. It is a per-block METADATA record (family tag, instance,
channel count, per-channel param count, display name, abbreviation, flags),
NOT a state snapshot: each eid's frame is byte-identical across all 169
polling rounds in the capture (the editor polls every placed/system block
once per ~0.5 s round).

## Formal definition

Wire frame (115 bytes on the wire incl. F7; the MIDI Monitor export strips F7):

| Offset | Bytes | Field | Encoding |
|---|---|---|---|
| 0..4 | `F0 00 01 74 <model>` | header + model byte | literal |
| 5 | `01` | fn | literal |
| 6..7 | `01 00` | sub-action 0x01 | 14-bit LSB-first septet pair |
| 8..9 | varies | blockId (eid) | 14-bit septet pair |
| 10..11 | `00 00` | paramId | 14-bit septet pair; 0 in every captured frame |
| 12..16 | varies | value32 | 5-septet LE u32 slot (see misapplication guard) |
| 17..18 | `00 00` | modifier14 | 14-bit septet pair |
| 19..20 | `50 00` | tailCount14 = 80 | 14-bit septet pair; = DECODED byte count of the tail |
| 21..112 | varies | tail: 92 septets | 8-to-7 MSB-first septet pack ([[iii-byte-stream-septet-pack-8to7]]) of an 80-byte record; residual 4 bits zero |
| 113 | varies | checksum | XOR of F0..byte112, & 0x7F |
| (114) | `F7` | EOX | literal |

**tailCount counts DECODED bytes (80); the wire carries ceil(80*8/7) = 92
septets.** Every previously decoded fn=0x01 tail (name write 32, routing 2)
was small enough not to expose the decoded-vs-wire distinction; this frame
proves tailCount is the decoded length.

Decoded 80-byte tail record (all fields little-endian):

| Offset | Type | Field | Evidence |
|---|---|---|---|
| +0 | u32 | eid (echoes the frame's blockId, 17/17) | STRONG |
| +4 | u32 | familyTag = the effectDefinitions cache sectionTag = the fn=0x1F family tag (REVERB 12, DISTORT/amp 10, CABINET 11, DELAY 13, FUZZ/drive 25, ...) | STRONG (matches [[editor-cache-section-record-grammar]] on all 17 non-empty eids) |
| +8 | u32 | instance, 0-based (Amp 2 = 1) | STRONG |
| +12 | u32 | flag, =1 on every grid block, 0 on the system "Performance Mode" record ("grid-placeable"?) | WEAK, uninterpreted |
| +16 | u32 | unknown; nonzero on a single block in the capture | WEAK, uninterpreted |
| +20 | u32 | flag; pattern consistent with a BYPASSED flag (1 exactly on the blocks expected bypassed in the capture's preset) | INFERENCE, no ground truth |
| +24 | u32 | channelCount (4; 1 for the system record) | STRONG |
| +28 | u32 | paramCount = per-channel param stride | STRONG (17/17 cross-validation, below) |
| +32 | char[32] | display name, NUL-padded ASCII ("Reverb 1", "Multitap Delay 1") | STRONG |
| +64 | char[12] | abbreviation, NUL-padded ASCII ("REV", "MTD", "PRFM") | STRONG |
| +76 | u32 | flag; 1 for system/global records only (Controllers, Performance Mode) | INFERENCE |

Undefined or empty eids answer the same 113-byte frame with an all-zero
80-byte record rather than an error (eid 199 in the capture), so eid-space
enumeration is safe and self-identifying.

## The decisive cross-validation (paramCount = wire stride)

The +28 paramCount equals the effectDefinitions cache section record count
for the +4 familyTag on 17 of 17 non-empty eids, including the two strides
previously confirmed on the wire (DISTORT 147, REVERB 73) and 15 new ones
(Controllers 130, Input 10, Output 26, Compressor 37, Delay 90,
Multitap 121, Chorus 29, Flanger 33, Rotary 21, Phaser 35, Wah 25,
Drive 43, Performance Mode 350).

The single apparent mismatch resolved into a finding: **Cab reports 106,
the cache CABINET section holds 110 records, and exactly 4 of those are the
special cab-table records ids 0xfff0..0xfff3. The fn=0x1F wire stride
counts only ORDINARY records (id < 0xff00).** When deriving strides from
cache section counts, exclude special ids (>= 0xfff0). A CAB fn=0x1F read
(itemCount 424 = 106 x 4, not 440) would hardware-confirm.

New roster fact: eid 201 = "Performance Mode" (family tag 58, 350 params,
1 channel), beyond the previously known gen-3 blockTypes ceiling (200).

## What this is exploitable for

1. **Wire-native dictionary discovery.** One sub=0x01 query per eid hands
   over, from the device itself: family tag, channel count, per-channel
   param stride, display name, abbreviation, instance. Exactly the
   per-block stride + family table that gen-3 channel-aware `get_param`
   projection needs, today sourced from a synced editor cache. For devices
   with no real-device cache in hand this is a path to self-configuring
   strides and block rosters over USB with zero editor involvement. It
   complements, not replaces, the cache (the cache also carries
   min/max/def/step and enum rosters).
2. **A lighter-weight preset-content scan.** Enumerating ~50 eids at
   ~50 ms each is a < 3 s "what blocks does this preset have, what are
   they named" scan with 113-byte responses, versus the multi-KB
   channel-blocked burst per block ([[gen3-fn1f-poll-block-bulk-read]]).
   Whether an all-zero record means "not placed" vs "no definition" needs
   one probe on a known-absent block; until then this use is INFERENCE.
3. **The per-param variant is the follow-up jackpot.** Every captured frame
   has paramId=0 and the response is the BLOCK record. The editor's
   decompile strings ("msg_getParamInfo: EffectId ..., ParamId ...") imply
   a paramId-addressed variant whose response would be the PARAM definition
   over the wire. If that decodes the same way, the entire device-true
   dictionary becomes harvestable from hardware without any cache file.

## Misapplication failure modes

- **DO NOT read the value32 slot (bytes 12..16) as a param value.** It is
  NOT part of the definition record: it idles at raw u32 sentinels (66 on
  non-amp frames, 73 on amp frames in the capture) and, on amp
  (DISTORT-family) frames only, mirrors the device's last continuous-SET
  float32. The mirroring is a strong observation; the field's MEANING is
  open. Do not build on it.
- **DO NOT emit the host-side QUERY as confirmed bytes.** This capture is
  device-to-host only. The request shape (plain 6-field frame, sub=0x01,
  eid at bytes 8..9, zero value/modifier/tail) is INFERENCE from the editor
  decompile, never captured. Per the no-guessed-wire-paths line: the
  RESPONSE parser is evidence-backed and shippable; a capability that
  EMITS the query waits for a host-side capture or a successful
  interactive probe.
- **DO NOT treat tailCount as the wire septet count.** It counts decoded
  bytes; the wire tail is ceil(n*8/7) septets.
- **DO NOT treat the frame as per-preset state.** It is static block
  metadata; bypass/channel STATE reads live elsewhere
  ([[gen3-fn1f-poll-block-bulk-read]], [[gen3-editor-sync-read-surface]]).

## Where it does NOT apply / singleton justification

Captured on one axis point only: FM9 fw 11.0, one community capture
(device-to-host stream of an FM-Edit session). No III/FM3/VP4 capture of
this frame family exists yet, and the host query has never been captured,
so no second fixture axis is available to promote past singleton. Gen-2
(Axe-Fx II) uses a different descriptor read (fn=0x16); AM4 has no known
equivalent. Promotion path: a second device's sub=0x01 response capture
(III, FM3, or VP4), or a host-side query capture enabling a round-trip
fixture.

## Verification path

`scripts/primitives-verify.ts#case-gen3-sub01-block-definition-response`
decodes the captured eid=66 reference frame (113 parsed bytes, checksum
0x1b) and asserts `{eid: 66, familyTag: 12, instance: 0, channelCount: 4,
paramCount: 73, name: "Reverb 1", abbrev: "REV"}` plus the
tailCount=80-decoded-bytes / 92-wire-septets / zero-residual-bits
invariants. Source capture:
`samples/captured/fm9-community-2026-06-09/fm9test2-stream.jsonl`
(analysis scripts `sub01_*.py` in the same directory).

## Refinement history

- 2026-06-09: decoded from the fm9test2 community capture (3,042 frames,
  checksum 3,042/3,042, names ASCII-clean 17/17, paramCount 17/17 against
  the independently decoded cache grammar). Identified as the response leg
  of the editor's sub=0x01 "Reading Block Definition" query via the
  decompile's action14 table. CABINET wire-stride consequence applied to
  the FM9 generated range table the same session (stride 106 vs cache
  recordCount 110).
