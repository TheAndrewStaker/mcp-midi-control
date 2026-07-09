---
name: iii-fn01-set-parameter-envelope
class: envelope-shape
status: matched
discovered:  (2026-05-18; pivot from incorrectly-ported fn=0x02)
verified_on:
  - axe-fx-iii-public-captures-fc12
  - axe-fx-iii-public-captures-mountain-utilities
firmware_sensitive: false
golden: scripts/verify-axe-fx-iii-encoding.ts (4 encoder goldens + 4 capture-parse goldens over the public-capture corpus)
relates_to: [septet-14bit, xor-7f-envelope-checksum, iii-host-emitter-fn-table]
consumed_in:
  - fractal-midi/src/gen3/axe-fx-iii/setParam.ts
  - fractal-midi/docs/devices/axe-fx-iii/set-parameter-captures.md
  - fractal-midi/docs/devices/axe-fx-iii/fn01-action-codes-decoded.md
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14033ec70 is the AxeEdit III canonical builder; L1325-1531)
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt (FUN_14033ec70 re-confirmed at L22641-22850; 6-field layout byte-pinned with all 93 fn=0x01 callers visible)
---

# Axe-Fx III SET_PARAMETER envelope (fn=0x01 + sub-action)

Axe-Fx III sets a parameter via fn=0x01 (NOT fn=0x02 as one would
naively port from II) with a 2-byte sub-action prefix that names the
input source (typed input, mouse-drag, footswitch, etc.). The envelope
is 23 bytes total, byte-verified against 10 public captures across two
effect blocks and two sub-action codes.

This is the cookbook's archetypal "naive port produces silent wire
mismatch" case. From  through 86 the project shipped a III
SET_PARAMETER builder that copied II's fn=0x02 verbatim with the model
byte swapped. The wire frames were SysEx-valid and accepted no reply
from the device, but mutated no state.  traced the actual
fn byte by walking AxeEdit III's call graph and matching against public
forum captures.

## Formal definition

Envelope (23 bytes total):

```
F0 00 01 74 10 01 <sub-action:2> <effect_id:2> <param_id:2> <drag-context:3> <value:3> <reserved:3> <cksum:1> F7
```

Where:

- `00 01 74` is the Fractal manufacturer ID.
- `10` is the Axe-Fx III model byte (per [[xor-7f-envelope-checksum]]).
- `01` is the fn byte (SET_PARAMETER).
- Sub-action is one of:
  - `09 00` typed input (clean envelope; final value)
  - `52 00` mouse-drag (intermediate values during a drag gesture)
  - Other sub-action codes documented in `fn01-action-codes-decoded.md`.
- `effect_id`, `param_id` are 2-byte septet-encoded 14-bit fields per
  [[septet-14bit]] (LSB-first).
- `drag-context` is 3 bytes at envelope positions 12-14. Zero for
  typed-input (`09 00`); carries cursor-delta context for mouse-drag
  (`52 00`). The device accepts either shape; typed-input is the
  clean programmatic form.
- `value` is a 3-byte septet-encoded 16-bit integer at envelope
  positions 15-17 via `packValue16` (LSB-first septet pair plus a
  2-bit byte 2 carrying bits 14-15). Range: 0..65535. All 10 public
  captures use values in 0..16383 (effectively 14-bit), so byte 2 is
  zero in every captured frame.
- `reserved` is 3 bytes of zero at envelope positions 18-20 in all captures.
- `cksum` is the standard XOR-7F envelope checksum per
  [[xor-7f-envelope-checksum]].

The wire layout above is byte-verified by `buildSetParameter` in
`fractal-midi/src/gen3/axe-fx-iii/setParam.ts` (lines 156-237) matching all
10 captured frames in `set-parameter-captures.md`. An alternative
6-field structural reading from the AxeEdit III editor binary is
documented in the Refinement-history note dated 2026-05-22 below.

## Where it's used

Every III parameter write the host initiates uses this envelope. The
implementation lives at `fractal-midi/src/gen3/axe-fx-iii/setParam.ts`
(`buildSetParameter`). The function emits sub-action `09 00` by default
(typed-input form, the agent-driven write path).

Test corpus: 10 public captures archived in
`fractal-midi/docs/devices/axe-fx-iii/set-parameter-captures.md`:

- Source A: FC-12 footswitch sending Drive 1/2 boost ON/OFF (4 frames,
  sub-action `52 00`, effect IDs 58/59 = ID_DISTORT1/2).
- Source B: AxeEdit III writing Delay 1 TIME (6 frames, sub-actions
  `09 00` and `52 00`, effect ID 70 = ID_DELAY1).

## Misapplication failure modes

- **DO NOT** use fn=0x02 for III SET_PARAMETER. fn=0x02 on III is a
  different operation; the device accepts the frame as SysEx-valid but
  the write silently fails. This was the Sessions 85-86 bug; see the
   refinement note.
- **DO NOT** omit the sub-action bytes. fn=0x01 with no sub-action is
  not a valid envelope; the bytes at offset 6-7 are part of the
  command identity, not optional metadata.
- **DO NOT** port II's `params.X / params.Y` channel-targeting concept
  to III without changing the channel axis. III uses A/B/C/D channels
  (matches AM4), not II's X/Y. See the per-device channel-axis table in
  [[ii-axeedit-opcode-table]]'s "Misapplication" section.

## Where it does NOT apply

- Axe-Fx II uses fn=0x02 SET_PARAMETER (different envelope, no
  sub-action prefix); see [[ii-axeedit-opcode-table]] and the II
  setParam path at `fractal-midi/src/gen2/axe-fx-ii/setParam.ts`.
- AM4 uses fn=0x01 BUT with a completely different payload layout
  (`pidLow / pidHigh / action / hdr4 / value`); see
  [[am4-pidlow-register-families]].
- Hydrasynth uses NRPN, not SysEx fn-byte addressing.

## Verification path

`scripts/verify-axe-fx-iii-encoding.ts` is the golden (4 encoder + 4
capture-parse goldens). Reference fixtures:

1. `buildSetParameter(effectId=58, paramId=40, value=508)` from
   `fractal-midi/src/gen3/axe-fx-iii/setParam.ts` must match Source A's
   "Drive 1 Boost ON" frame byte-for-byte.
2. `buildSetParameter(effectId=70, paramId=2, value=520)` must match
   Source B's "Delay 1 TIME typed v520" frame.

Both fixtures are committed in `set-parameter-captures.md` with full
byte sequences; `scripts/verify-axe-fx-iii-encoding.ts` covers the same
corpus.

## Refinement history

- Sessions 85-86: III SET_PARAMETER initially ported from II as
  fn=0x02. Frames passed structural validation but device accepted no
  state changes; bug undetected until live testing.
- 2026-05-18: pivot to fn=0x01. Wire shape verified
  against 10 community captures (FC-12 + Mountain Utilities forum
  2019). Sub-action prefix decoded; 4-byte reserved field identified
  as static across captures.
- 2026-05-22 (Rosetta-stone cookbook audit): promoted to cookbook
  primitive. This entry is the cookbook's archetypal "naive port
  produces silent wire mismatch" case. The two-corpus axis (FC-12 +
  Mountain Utilities) is what supports `matched` status; both are
  public captures of distinct human users on distinct dates against
  distinct effect blocks.
- 2026-05-22 (cookbook-mine of `ghidra-axe-edit-iii-store-preset.txt`):
  formal-definition section corrected from the prior layout
  (`<param_id:2> 00 00 00 00 <value:5>`, which was off-by-1 vs the
  byte-verified shipped code and mis-described the value field as a
  5-byte packed-float) to the byte-verified shipped layout
  (`<drag-context:3> <value:3 via packValue16> <reserved:3>`). The
  prior text was inherited from an early hypothesis; the
  `buildSetParameter` golden test asserts shipped output matches the
  captures byte-for-byte, so the wire bytes were always correct, but
  the cookbook entry's structural decomposition wasn't. Goldens
  continue to pass against the corrected definition.
- 2026-05-22 (same mining session): AxeEdit III editor's
  `FUN_14033ec70` builder (the function the editor invokes to compose
  its own fn=0x01 frames) packs the payload as a 6-field struct
  `{action14, blockId14, paramId14, value32, modifier14, tailCount14,
  tail[]}` with `value32` occupying envelope positions 12-16 as a
  LSB-first 5-septet 32-bit field (per Ghidra L1463-1467). For the
  captured 14-bit-value corpus this 6-field layout produces bytes
  identical to the 3-byte-`packValue16` layout above (Field D bytes
  3-4 align with `packValue16` bytes 0-1; the other 8 payload bytes
  are zero in both). The two interpretations diverge for values that
  require more than 14 bits of dynamic range OR for any fn=0x01
  sub-action that exercises the modifier or tail slots; firmware
  acceptance of the 32-bit form is unverified pending a III owner
  capturing a >14-bit value frame. Filed as an investigation target
  in `STATE-AXEFX3.md`; do not change shipped encoding behavior on
  this evidence alone.
