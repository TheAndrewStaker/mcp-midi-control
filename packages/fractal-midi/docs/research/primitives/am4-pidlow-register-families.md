---
name: am4-pidlow-register-families
class: fn-byte-mapping
status: matched-singleton
discovered: Sessions 84 + 96 (PATCH + GLOBAL family decode)
verified_on:
  - am4-fw18
firmware_sensitive: false
golden: scripts/verify-msg.ts (185 PATCH-family + 2 GLOBAL-family byte-exact goldens)
relates_to: [septet-14bit]
consumed_in:
  - fractal-midi/docs/devices/am4/SYSEX-MAP.md
  - fractal-midi/src/am4/setParam.ts
  - scripts/verify-msg.ts
  - fractal-midi/samples/captured/decoded/ghidra-am4edit-paramtables.txt (PATCH table @ 0x1414216d0 = 85 entries + GLOBAL table @ 0x14141a9f0 = 99 entries; both counts byte-exact vs the primitive's claim)
---

# AM4 pidLow register families (PATCH + GLOBAL)

AM4's fn=0x01 SET_PARAMETER addresses parameters via two distinct
register families distinguished by `pidLow`:

- `pidLow = 0x00CE`: PATCH family (block slots, channel, type, rename,
  scene levels, scene MIDI). 85 params total.
- `pidLow = 0x0001`: GLOBAL family (USB level, tap-tempo mode, system
  settings). 99 params total.

`pidHigh` within each family is a 14-bit sub-register selector.
Action codes (`hdr4`) and value-encoding rules are family-specific.

## Formal definition

Both families share the AM4 fn=0x01 envelope:

```
F0 00 01 74 15 01 <pidLow:2> <pidHigh:2> <action:2> <hdr4:4> <value:5> <cksum> F7
```

Field widths (per [[septet-14bit]]):

- `pidLow`: 2 bytes, septet-LSB-first.
- `pidHigh`: 2 bytes, septet-LSB-first.
- `action`: 2 bytes, septet-LSB-first.
- `hdr4`: 4 bytes, action-code dependent.
- `value`: 5 bytes via the AM4 `packValue` sliding-window 8-to-7
  bit-pack (see `fractal-midi/src/shared/packValue.ts`).

Family selection:

- `pidLow = 0x00CE`: PATCH addressing. `pidHigh` selects the sub-register
  (e.g. `0x0010` + slot-1 = block-slot register for slot N;
  preset.level / preset.balance / scene_{1..4}_level / etc. live here).
  85 params catalogued in `params.ts`.
- `pidLow = 0x0001`: GLOBAL addressing. `pidHigh` selects system param
  (e.g. `0x0026` = `global.usblevel1`, `0x0029` = `global.tap_tempo_mode`).
  99 params catalogued.

The action code distinguishes "set value" (`0x0001`) from "save"
(`0x001B`), "rename" (`0x000C`), etc.; see the action-code table in
`fractal-midi/docs/devices/am4/SYSEX-MAP.md` §6.

## Where it's used

Every AM4 parameter write the host initiates picks one of these two
families. `fractal-midi/src/am4/setParam.ts` `buildSetParam` resolves
the param name to its `(pidLow, pidHigh)` pair via the `KNOWN_PARAMS`
registry and emits the appropriate family.

Captured evidence:

- PATCH family: 185 byte-exact verify-msg goldens at
  `scripts/verify-msg.ts` covering every param-write the project ships.
- GLOBAL family: 2 byte-exact verify-msg goldens (`global.usblevel1`,
  `global.tap_tempo_mode`).  capture at
  `samples/captured/session-95-am4-global-pidlow.pcapng`.

## Misapplication failure modes

- **DO NOT** use PATCH `pidLow=0x00CE` for a GLOBAL param. The device
  accepts the frame structurally but rejects with NACK (different
  validation path); pidLow is the family discriminator.
- **DO NOT** assume `pidLow` is a constant. Pre-Session-84 code paths
  used `pidLow=0x00CE` for everything, which silently mis-addressed
  GLOBAL writes.
- **DO NOT** confuse `pidLow` (family selector) with `pidHigh`
  (sub-register selector). pidLow values are sparse (currently 2
  distinct values: `0x00CE` and `0x0001`); pidHigh values are dense
  within each family.

## Where it does NOT apply

- Axe-Fx II uses fn=0x02 SET_PARAMETER with a different addressing
  scheme (no pidLow family discriminator); see
  [[ii-axeedit-opcode-table]].
- Axe-Fx III uses fn=0x01 + sub-action with `effectId + paramId` per
  [[iii-fn01-set-parameter-envelope]].
- Hydrasynth uses NRPN with 14-bit MSB+LSB CC pair, no SysEx
  pidLow/pidHigh fields.

## Verification path

`scripts/primitives-verify.ts#case-am4-pidlow-register-families` checks
that every entry in `fractal-midi/src/am4/KNOWN_PARAMS` belongs to
either the PATCH family (`pidLow=0x00CE`) or the GLOBAL family
(`pidLow=0x0001`), with no third value present. Also verifies the
byte-exact GLOBAL family golden in `scripts/verify-msg.ts` matches the
session-95 capture.

## PATCH sub-register classes (refinement, 2026-05-22)

Within the PATCH family (`pidLow=0x00CE`), `pidHigh` values fall into
two safety-relevant sub-classes. Treat them differently when surfacing
params to the agent layer:

- **Storage sub-registers**: writes change preset state with no
  side-effect on outbound MIDI. Examples: `block-slot register for slot N`
  (`pidHigh=0x0010 + slot`), preset.level / preset.balance / scene_{1..4}_level,
  and the 16 `SCENE_N_MIDI_MSG_M` config slots (variant-resolver
  cache_ids 64..79). Safe to expose as agent-writable wire params.
- **Trigger sub-registers**: writes have a side-effect *now* (the
  device emits something on its MIDI OUT port immediately). Confirmed
  trigger: **`pidHigh=0x0070` = `SCENE_MIDI_EXEC`**, writing this
  fires the configured Scene-MIDI message(s) regardless of scene
  state. **Do NOT register as an agent-writable param.** Decoded
  from `samples/captured/session-87-scene-midi-test-buttons.pcapng`
  (2026-05-22): every per-slot test button in AM4-Edit emits
  one fn=0x01 write to `pidLow=0xCE / pidHigh=0x70` with a payload
  encoding which scene+slot to fire; the device then produces the
  configured MIDI msg on its OUT port. If a future surface needs to
  expose this (e.g. an explicit `am4_fire_scene_midi(slot)` tool),
  gate behind a save-authorization-style intent check.

## Refinement history

- : PATCH family decode. Initial 47 PATCH params catalogued;
  pidLow value confirmed as `0x00CE` across all captures.
- 2026-05-15: GLOBAL family decode.  capture
  surfaced a non-`0x00CE` pidLow value (`0x0001`); decode pass added 99
  GLOBAL params to the catalog with byte-exact verify-msg goldens for
  two of them.
- 2026-05-22 (Rosetta-stone primitives audit): promoted to
  primitive. Pre-existing decode work covering two distinct register
  families with cross-validating goldens; PATCH + GLOBAL together
  supply the second generalization axis at the same primitive level
  (two register families, one device).
- 2026-05-22 ( decode): added PATCH sub-register classification
  (storage vs trigger). `pidHigh=0x0070` SCENE_MIDI_EXEC trigger
  decoded from session-85/86/87 captures; full decode findings at
  `samples/captured/decoded/hw108-scene-midi-findings.md` in
  mcp-midi-control (local; raw captures gitignored).
