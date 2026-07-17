# The Fractal protocol family: a cross-device Rosetta map

Reference for how the Fractal Audio devices relate at the wire level, and
where they diverge. The guiding question for this project is "can a new
device be added as a descriptor rather than as new tools?" The answer:
**true within a codec family, narrower across families.** A shared core of
wire primitives really is portable, but everything that carries a value,
a name, or an addressing scheme is per device, and over-generalizing the
shared core silently mis-writes.

This doc is the map of which primitives are shared (so a new device can
reuse them) and which are per device (so reusing them is a bug). The
divergence guardrails at the end name the specific over-generalizations
that turn a reuse into a silent corruption.

---

## 1. The Rosetta matrix

### Shared core (the genuinely portable layer)

| Primitive | AM4 0x15 | Axe-Fx II 0x07 | III 0x10 | FM3 0x11 | FM9 0x12 | VP4 0x14 | Hydrasynth |
|---|---|---|---|---|---|---|---|
| **Envelope** `F0 00 01 74 <model> <fn> ... [cksum] F7` | hw | hw | capture | inferred | hw | capture (fn=0x12 only) | absent (NRPN) |
| **Checksum** XOR with 0x7F mask over `F0` through last payload byte | hw | hw | capture | inferred | hw | inferred | absent |
| **Septet 14-bit** (two-septet pack: pidLow / pidHigh / preset number / tempo / location) | hw | hw | capture | inferred | hw | inferred | absent |
| **Per-effect dispatcher** addressing by `(effectId, paramId)` | hw | hw | capture | inferred | hw | inferred | absent |
| **Preset-dump envelope** fn=0x77 / 0x78 / 0x79 | hw | hw | capture | inferred | hw (8 presets, exact parser match) | inferred | absent |
| **Channel-blocked atomic read** `index = channel * stride + paramId` | hw | get_param channel-aware; get_preset reads active channel | capture | inferred | hw (block 66 = 73x4, block 58 = 147x4) | inferred | absent |

### Per-device variables (the things you must NOT share)

| Axis | AM4 | Axe-Fx II | gen-3 (III / FM3 / FM9 / VP4) |
|---|---|---|---|
| **Model byte** | 0x15 | 0x07 | 0x10 / 0x11 / 0x12 / 0x14 |
| **SET opcode** | fn=0x01 action=0x0001 | fn=0x02 | fn=0x01 sub=0x09 (no fn=0x02) |
| **Value encoding** | Q16 fixed point (wire / 65534) | Q8.02 16-bit (calibration tables) | three-septet 16-bit, or five-septet float32 |
| **fn=0x1F shape** | per block, effectId payload, state-broadcast triple | whole preset, no payload, one frame | per block, effectId payload, 0x74 / 0x75 / 0x76 burst |
| **Channels** | 4 (A to D) | 2 (X / Y) | 4 (A to D) |
| **Scenes** | 4 per preset | 8 per preset | 8 (III / FM3 / FM9), 4 (VP4) |
| **Grid** | 4-slot serial | grid | freeform grid (III / FM3 / FM9), 4-slot serial (VP4) |
| **paramId scope** | own | own | device-specific, NOT reusable across model bytes (FM3 +6.9%, FM9 +18.6%, VP4 +99.5% divergence from III) |
| **Enum source** | editor layout XML; editor `effectDefinitions` cache (hw-synced) | fn=0x28 dump | device-emitted fn=0x01 sub=0x1a / 0x2e septet stream; editor `effectDefinitions` cache (hw-synced) |

**Confirmation legend:** `hw` = byte-verified against hardware. `capture` =
byte-verified against a public or loopback capture, not against this
project's hardware. `inferred` = pattern-extended from a sibling device, no
capture yet. `absent` = the primitive does not exist on that device.

**The one-line truth:** the envelope / checksum / septet / dispatcher layer
is portable across every Fractal model byte. Everything that carries a value,
a name, or an addressing scheme is per device. Every cross-device failure
this codebase has hit lives in that second category: a value-encoding
mismatch, a paramId reused across model bytes, a channel dropped on read or
write, or the wrong function opcode ported with a model-byte swap.

---

## 2. Cross-device block resolution

Block identifiers are shared in spirit but per family in value. The codec
exposes one resolver, `resolveEffectId(modelByte, name, instance?)` in
`packages/fractal-midi/src/shared/effectId.ts`, so a caller can say
`"Reverb 1"` and get the correct wire identifier for any model byte. The
number returned is the device's own block identifier, and the meaning
differs by family on purpose:

- **AM4** returns the block `pidLow`, the address the AM4 writes (as a
  float32) into a slot register to place the block. The AM4 hosts one
  instance of each block type, so any instance above 1 is rejected.
- **Axe-Fx II** returns the per-instance `effectId` used in
  GET / SET_BLOCK_PARAMETER_VALUE. Instances are distinct ids that share a
  parameter table (Amp 1 = 106, Amp 2 = 107).
- **gen-3** returns `firstId + (instance - 1)`. The whole gen-3 family
  shares one block roster, so the same name resolves identically across the
  four model bytes. VP4 hosts a subset of the roster; its descriptor gates
  availability, while the resolver only maps name to id.

Because the identifier is per family, never join an id resolved for one
model byte onto another. The resolver is the single place that knows which
table a model byte uses.

---

## 3. Divergence guardrails

These are the over-generalizations that turn a reuse into a silent
mis-write. Each has file-cited evidence in the codec primitives corpus' `_negative/`
corpus under `packages/fractal-midi/docs/research/primitives/`.

- **G1: fn=0x1F is not one shape.** Axe-Fx II is whole-preset, no payload,
  one frame. AM4 is per block, effectId payload required, state-broadcast
  triple. gen-3 is per block, effectId payload, 0x74 / 0x75 / 0x76 burst
  (not a triple). Firing the II-style empty fn=0x1F at an AM4 returns a NACK
  (result code 0x06). Expecting the AM4 triple on gen-3 times out. See
  `ii-fn1f-atomic-read.md`, `am4-fn1f-atomic-read.md`,
  `gen3-fn1f-poll-block-bulk-read.md`.

- **G2: gen-3 paramIds do not cross model bytes.** A shared codec is not a
  shared catalog. DELAY_BYPASS is paramId 5 on FM9 but 22 on the III, and
  VP4 lacks it entirely. Divergence runs from 6.9% (FM3) to 99.5% (VP4)
  against the III. Joining an FM or VP symbol to an III paramId writes the
  wrong param with no error and no ack divergence, which is pure silent
  corruption. See `_negative/gen3-paramid-reuse-across-model-bytes.md`. This
  is why a label or calibration backport from one device to another must
  join on shared block and param name, never on numeric paramId.

- **G3: value encoding does not cross families.** AM4 uses Q16
  (wire / 65534). gen-3 uses three-septet-16-bit or five-septet float32.
  Decoding an AM4 wire value as gen-3 float32 is off by roughly 65536 times.
  A Q16 denominator transfers AM4 to Axe-Fx II (same family) but never to
  gen-3. See `display-q16-fixedpoint.md`.

- **G4: fn=0x02 is Axe-Fx II only.** gen-3 omits it and uses fn=0x01
  sub=0x09. Porting the II fn=0x02 path to gen-3 with a model-byte swap
  emits an opcode the gen-3 firmware may not honor for writes. See
  `packages/fractal-midi/docs/devices/axe-fx-ii/SYSEX-MAP.md` against
  `packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md`.

- **G5: AM4 fn=0x01 action=0x1F is a snapshot, not a whole-preset read.**
  It is a short descriptor (active scene, meter, four block-type codes), not
  the working buffer. The whole preset is fn=0x77 / 0x78 / 0x79; per-scene
  state is a separate fn=0x29. Treating the snapshot as the full buffer
  reads stale values.

- **G6: enum dictionaries are per-device-source.** AM4 enums come from the
  AM4 editor layout XML. gen-3 enums come from the device's own fn=0x01
  sub=0x1a / 0x2e septet stream. The AM4 XML arrays are stale or missing on
  the III, and even III-editor-mined enum names are not guaranteed
  wire-correct for FM3 or FM9, whose paramId-dependent enum sets differ. See
  `gen3-enum-label-septet-stream.md`. A fourth, hardware-anchored enum source
  is the editor's hw-synced `effectDefinitions_*.cache`: its per-block model
  rosters (amp/drive/reverb) extract by anchored name-walk and the record `id`
  equals the catalog `paramId`. Validated device-true on FM9 (amp 331 @
  ordinals 65/179/264, drive 86 @ 15/36, reverb 79 @ 16/45) and AM4 only; it
  requires a real-device-synced cache (an un-synced editor writes roster-empty),
  and it is a roster/enum source, NOT a reliable bulk param-range dictionary
  (the float-record walk desyncs past ~20% of the section). See the editor-cache
  lane in [`docs/RE-WORKFLOW.md`](../RE-WORKFLOW.md).

- **G7: Hydrasynth is a different protocol entirely.** It is NRPN
  (`<NRPN_high> <NRPN_low> <data>`), with no Fractal envelope. Applying
  pidLow / pidHigh dispatcher addressing or septet packing to it garbles
  every send. It rides the same product architecture (display-first I/O,
  descriptor model, safe-edit gates) but shares zero wire primitives. See
  `packages/fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md`.

---

## 4. The dividing line: descriptor or new codec

The thesis "new gear is a descriptor" is true within a codec family and
false across families. The test is the shared-core block in section 1. If a
new device shares the envelope / checksum / septet / dispatcher layer, it is
a descriptor: VP4 is a config of the gen-3 factory because it inherits that
block. If it does not share that block, it is a new codec package. A
different vendor (for example Line 6 Helix) does not inherit `F0 00 01 74` or
the XOR checksum or the param registry, so it needs its own package. What
transfers there is the architecture (display-first I/O, the channel and
scene model, the descriptor-not-tools shape, the safe-edit gates) and the
extraction workflow (editor binary pattern-scan, editor layout assets for
labels), not the wire.

The primitives corpus' job is to tell you which primitives a new device must re-mine
versus reuse. When that line is clear, adding a device on an existing codec
is a config file, and adding a new codec is a new package.
