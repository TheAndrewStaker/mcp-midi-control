---
name: am4-fn1f-atomic-read
class: fn-byte-mapping
status: matched-singleton
discovered: HW-AM4-FN1F probe (2026-05-22; hardware-verified)
verified_on:
  - am4
firmware_sensitive: false
golden: packages/fractal-midi/test/am4/setparam.test.ts (buildGetAllParams request-shape byte goldens)
relates_to: [ii-fn1f-atomic-read, septet-14bit, xor-7f-envelope-checksum, am4-pidlow-register-families]
consumed_in:
  - fractal-midi/docs/devices/am4/SYSEX-MAP.md
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt (ID enum @ 0x14141bbe0 + duplicate @ 0x14142c2e0 confirms effectId → block-symbol mapping for every effectId; resolves probe-script labels e.g. effectId 106 = ID_TREMOLO1, effectId 58 = ID_DISTORT1)
---

# AM4 fn=0x1F per-block atomic-read

AM4 exposes fn=0x1F as a **per-block** atomic-read primitive: one host
request carrying a 2-byte septet-packed effectId returns a 0x74/0x75/0x76
state-broadcast triple holding that block's full param set in one round-
trip. The 0x74 header echoes the effectId and announces chunk size; the
0x75 chunk carries the encoded payload; the 0x76 footer terminates the
triple.

This is the AM4 sibling of [[ii-fn1f-atomic-read]] but with a critical
shape difference: AM4 requires the effectId payload (the empty / all-
zero / zero14 payloads NACK with multipurpose-response result_code 0x06),
whereas II's request omits the effectId and returns the full preset's
parameter set in one frame. AM4's atomic-read is therefore N round-trips
(one per placed block) where II's is one round-trip total. AM4 still wins
over the per-paramId loop (one round-trip per param * tens-to-hundreds of
params per block).

## Formal definition

Request envelope (10 bytes):

```
F0 00 01 74 15 1F <eid_lo> <eid_hi> <cksum> F7
```

Where:

- `00 01 74` is the Fractal manufacturer ID.
- `15` is the AM4 model byte.
- `1F` is the fn byte.
- `<eid_lo> <eid_hi>` is the 14-bit effectId encoded per [[septet-14bit]]
  (LSB first).
- `cksum` is the standard XOR-7F envelope checksum per
  [[xor-7f-envelope-checksum]].

Reply: three SysEx frames in order.

```
F0 00 01 74 15 74 <eid_lo> <eid_hi> <size_lo> <size_hi> <cksum> F7
F0 00 01 74 15 75 <size_lo> <size_hi> <data ...> <cksum> F7
F0 00 01 74 15 76 <cksum> F7
```

The 0x74 header re-states the effectId and announces a 14-bit `<size>`
(septet-packed) of the upcoming 0x75 chunk's payload. The 0x76 footer
is a fixed 2-byte sentinel.

## Probe evidence (2026-05-22)

Seven payload shapes fired against the AM4 working buffer:

| Shape | Payload bytes | Verdict |
|---|---|---|
| empty | `(none)` | multipurpose_nack rc=0x06 |
| zero14 | `00 00` (effectId 0) | multipurpose_nack rc=0x06 |
| amp1 (= ID_TREMOLO1, see Refinement history 2026-05-22) | `6a 00` (effectId 106) | state_broadcast_triple, 100-byte chunk |
| preset_zero14 | `00 00` (effectId 0) | multipurpose_nack rc=0x06 (same as zero14) |
| scene1 | `01 00` (effectId 1) | state_broadcast_triple, 291-byte chunk |
| slot1_amp | `01 00 00 00` (first 2 bytes = effectId 1) | state_broadcast_triple, 291-byte chunk (identical to scene1) |
| longer_zeros | `00 00 00 00 00 00` | multipurpose_nack rc=0x06 |

Two facts to extract:

1. **Payload is exactly 2 bytes of effectId.** The slot1_amp 4-byte
   payload returned the identical chunk to scene1's 2-byte payload,
   meaning the device parsed `01 00` from the leading two bytes and
   ignored the trailing zeros.
2. **effectId 0 is invalid; effectId 1 and effectId 106 are valid.**
   Result_code 0x06 on the empty/zero/wide-zero shapes confirms the
   opcode is recognized but the addressed effectId is rejected.

Raw capture: `samples/captured/probe-am4-fn1f.syx` (local; gitignored).
Per-shape verdict: `samples/captured/decoded/probe-am4-fn1f-findings.md`.

## Misapplication failure modes

- **DO NOT** fire fn=0x1F with no payload or all-zero payload. AM4
  NACKs with result_code 0x06; the per-block atomic-read requires a
  valid effectId.
- **DO NOT** assume II and AM4 fn=0x1F are byte-compatible. II returns
  the whole preset in one frame with a no-payload request; AM4 returns
  one block per request and requires a 2-byte effectId. Treat them as
  related but distinct opcodes that share a fn byte.
- **DO NOT** read stored-preset state via fn=0x1F. Like II, AM4's
  fn=0x1F reads the working buffer; to read a stored preset, switch to
  it first (which loads its bytes into the working buffer), then issue
  fn=0x1F.

## Where it does NOT apply

- Axe-Fx II: sibling primitive at [[ii-fn1f-atomic-read]], different
  request payload, different reply granularity (whole-preset vs per-
  block).
- Axe-Fx III: uses its own atomic-read family (fn 0x19, fn 0x14); not
  byte-compatible.
- Hydrasynth: dump-by-NRPN-range, not a single atomic-read opcode.

## Verification path

`scripts/primitives-verify.ts#case-am4-fn1f-atomic-read` checks structural
shape. Wire goldens for the request shape live in
`fractal-midi/test/am4/setparam.test.ts` (`buildGetAllParams(1)` and
`buildGetAllParams(106)`).

Decode validation (against the captured probe frames at
`(founder-private capture)`): the 0x75 chunk's
itemCount field (bytes 6-7, septet-14-bit) × 3 equals the chunk's
payload byte count exactly for both captured chunks (100 ushorts → 300
bytes, 163 ushorts → 489 bytes). Decoded via the II-compatible
`decode16Packed` per [[septet-21bit-byte2-mask-preservation]].

Live wire verification: re-run `scripts/_research/probe-am4-fn1f.ts`
against AM4 hardware with AM4-Edit closed; expect `state_broadcast_triple`
on shapes `amp1`, `scene1`, `slot1_amp`.

## Refinement history

- 2026-05-22 (HW-AM4-FN1F probe): primitive discovered via the seven-
  shape probe script `scripts/_research/probe-am4-fn1f.ts`. Shape `amp1`
  + `scene1` + `slot1_amp` returned state-broadcast triples; the other
  four shapes NACKed with multipurpose-response result_code 0x06.
  Probe ran from the active working buffer; effectId 1 returned a 291-
  byte chunk (163 ushorts), effectId 106 returned a 100-byte chunk
  (100 ushorts). Falsifies the former [[ii-fn1f-atomic-read]] claim
  that "AM4 has no fn=0x1F equivalent."
- 2026-05-22 (same-session port): `buildGetAllParams(effectId)`
  codec helper shipped in `fractal-midi/src/am4/setParam.ts` +
  exported from `src/am4/index.ts`; bumped to . Descriptor-
  layer `readAllParams(conn, effectId)` shipped at
  `packages/am4/src/shared/readOps.ts`, mirroring II's
  subscribe-before-send + accumulate-triple pattern. Captured-frame
  decode validates chunk shape (matches II convention exactly:
  septet itemCount × 3 bytes-per-ushort packed-septet payload).
- 2026-05-22 (later same session, chunk position = pidHigh
  hardware-verified for amp block at effectId 58):
  - effectId sweep across 1..255 found 25 effectIds returning non-
    empty chunks plus 47 NACKs. Empty-chunk responses (header +
    chunk with itemCount=0 + footer) are valid for unplaced or
    out-of-active-preset blocks.
  - Write-probe wrote `amp.gain=7.5` via existing `set_param`
    primitive, baselined every non-empty-chunk effectId, re-read,
    and diffed. Only effectId 58 (256-ushort chunk) showed a
    paramId-shaped change at position 11; effectId 206 mirrored
    with a small secondary diff (modifier / controller cache).
  - Position-map probe wrote each of amp.{gain,bass,mid,treble,
    master,depth,presence} to distinct sentinels and recorded the
    diff. ALL seven hits matched **chunk position = pidHigh**:
    gain (0x0b)→11, bass (0x0c)→12, mid (0x0d)→13, treble
    (0x0e)→14, master (0x0f)→15, depth (0x1a)→26, presence
    (0x1e)→30. Every captured wire u16 also matched
    `round(displayValue/10 × 65534)` exactly: the [[display-q16-
    fixedpoint]] denominator (READ_VALUE_DENOMINATOR=65534) holds.

  Probes:
    - `scripts/_research/probe-am4-fn1f-effectid-sweep.ts` in the consumer repo
    - `scripts/_research/probe-am4-fn1f-find-amp.ts` in the consumer repo
    - `scripts/_research/probe-am4-fn1f-amp-positions.ts` in the consumer repo

  Output JSON:
    - `samples/captured/decoded/am4-fn1f-effectid-sweep.{md,json}`
    - `samples/captured/decoded/am4-fn1f-find-amp.json`
    - `samples/captured/decoded/am4-fn1f-amp-position-map.json`

  Position rule for amp block: **`chunkPosition === pidHigh`**.
  Hypothesis (untested but well-supported): the same rule holds
  for every block, with effectId selecting which block's chunk
  is returned. The 4 effectIds with 256-ushort chunks (58, 62,
  66, 70) likely correspond to slots / block-type registers; the
  other distinct chunk sizes (35, 38, 72, 84, 92, 96, 99, 100,
  118, 120, 128, 144, 148, 152, 163, 164, 168, 200) correspond to
  individual block types whose pidHigh space matches the chunk
  size.

- 2026-05-22 (same session, position rule universal + getPreset
  shipped):
  - **All-blocks position probe** (`scripts/_research/probe-am4-
    fn1f-all-blocks-positions.ts`) ran 53 sentinel writes across
    16 non-amp blocks (compressor / geq / peq / reverb / delay /
    chorus / flanger / rotary / phaser / wah / volpan / tremolo /
    filter / drive / enhancer / gate). Position rule
    **`chunkPosition === pidHigh` held 46/46** wrote-and-observed-
    diff cases (7 "no diff" cases were type-conditional params
    for the current preset's block-type). Combined with the amp
    7/7 in the previous step: **53/53 hardware-validated**. The
    sibling claim **`effectId === pidLow`** also held universally
    (every block's chunk lives at the effectId equal to its
    `KNOWN_PARAMS` pidLow byte).
  - **`reader.getPreset` shipped** at
    the consumer's `packages/am4/` directory:
    reads layout (4 slot bytes) + one fn 0x1F chunk per pidLow
    per placed slot, decodes `chunk[pidHigh]` via the same
    `am4Decode` path `get_param` uses. Round-trips the per-paramId
    GET answer byte-exactly (cross-check probe
    `probe-am4-get-preset-roundtrip.ts`).
  - **`atomic_read: true`** on the AM4 descriptor. Cold snapshot
    ~263 ms for a full 4-slot preset; warm with channel state ~129
    ms. ~1.8× faster than the equivalent per-paramId loop on AM4's
    fast USB MIDI, AND one tool call instead of N (the bigger win).
  - Probe outputs:
    - `samples/captured/decoded/am4-fn1f-all-blocks-position-map.json`
  - Caveats:
    - The 4 `*.channel` selectors (amp/drive/reverb/delay,
      pidHigh=0x7d2) live OUTSIDE the chunk (pidHigh far beyond
      stride). The default `getPreset` path reads the active
      selector via a per-paramId GET to label the single returned
      channel; `include_channel_state: true` reads all four
      channels A/B/C/D straight from the channel-blocked chunk and
      needs no selector read (FIXED order, quarter 0 = A).
    - The probe surfaced a catalog mislabel (orthogonal to the
      rule): several params with `unit: percent` actually store
      bipolar at the wire (filter.pan_*, enhancer.pan_*, etc.).
      Affects `get_param` AND `get_preset` equally. Filed as
      `STATE-AM4.md` open follow-up #1.

- 2026-05-22 (primitives-mine of `ghidra-am4edit-paramtables.txt`):
  the probe-evidence table's `amp1` shape label (line 71 of this
  entry) was a probe-script naming choice from early in the
  HW-AM4-FN1F session. The AM4-Edit binary's effectId enum at
  `0x14141bbe0` (dump line 135) reveals effectId 106 is actually
  `ID_TREMOLO1`, not amp. The amp/distort block lives at
  effectId 58 = `ID_DISTORT1` (dump line 87), which matches the
  subsequent amp-position probe's 256-ushort chunk findings in the
  earlier history entry. Read the probe-evidence table's `amp1`
  label as "block106 = ID_TREMOLO1" for accuracy; the underlying
  observations (state-broadcast triple, 100-byte chunk, valid
  effectId) are correct regardless of label.

- 2026-06-04 (live AM4, chunk is CHANNEL-BLOCKED ×4): the prior
  "chunk position = pidHigh" rule is the **channel-A slice** of a
  channel-blocked layout. The 0x75 body packs four contiguous copies of
  the block's slots, one per channel A-D: `index = channel × stride +
  pidHigh`, `stride = itemCount / 4`, quarter 0 = channel A. Confirmed
  READ-ONLY on connected hardware (`scripts/_research/probe-am4-channel-
  blocked.ts`): channel-bearing blocks all have `itemCount % 4 == 0` with
  DISTINCT quarters: eff 58 (amp tone) 608=152×4, eff 62 (amp cab)
  312=78×4, eff 66 292=73×4 (A/B/C/D all differ), eff 70 360=90×4. Same
  primitive as gen-3 `[[gen3-fn1f-poll-block-bulk-read]]` (×4 A-D) and II
  (×2 X/Y, block 0x6a 236≈118×2): ONE cross-Fractal atomic-read that
  differs only by model byte, value count, and channel count.
  **Consequence:** `getPreset(include_channel_state)` now reads all four
  channels A/B/C/D from the single dump at `channel × stride + pidHigh`
  (no per-param-per-channel GET loop, no channel-state mutation). Quarter
  order is FIXED A/B/C/D (quarter 0 = A), confirmed live via a reversible
  A→B→A switch that left the quarters invariant
  (`probe-am4-channel-orientation.ts` / `probe-am4-channel-switch-test.ts`).
  **Open:** the amp (eff 58) chunk was 256 ushorts in 2026-05-22 but 608
  now: amp chunk size looks type/firmware-dependent; reconcile before
  relying on amp specifically. The amp channel SELECTOR register reads back
  derived/cached firmware state (not a clean 0..3 index), so `get_param(amp,
  channel)` decodes it via a best-effort float32-packed-enum fallback;
  reverb/delay/drive selectors read clean.

- 2026-06-04 (SHIPPED): the channel-stride projection above is live in the
  consumer's `packages/am4/` reader. `getPreset(include_channel_state:true)`
  returns A/B/C/D from one fn 0x1F dump per block; the default path returns
  the active channel's quarter. No channel-state mutation on either path.

Promotion path: entry promotes from `matched-singleton` →
`cross-device-pattern` once a comparable per-block-atomic-read
ships for a non-Fractal device. Within Fractal, AM4 / II / gen-3 share the
fn byte AND the channel-blocked layout (differing in channel count + value
encoding), a confirmed cross-Fractal pattern, distinct only in model byte
+ catalog.
