---
name: hydra-nrpn-14bit-with-fxaware-resolution
class: bit-level
status: matched-singleton
discovered:  (Hydrasynth NRPN catalog hardware verification)
verified_on:
  - hydrasynth-explorer-v2.2.0
firmware_sensitive: false
golden: scripts/hydrasynth/verify-nrpn-display.ts (39 hardware-locked goldens)
relates_to: [hydra-sysex-envelope-base64-crc32]
consumed_in:
  - packages/hydrasynth/src/nrpn.ts
  - packages/hydrasynth/src/encoding.ts
  - scripts/hydrasynth/verify-nrpn-display.ts
  - fractal-midi/docs/devices/hydrasynth/SYSEX-MAP.md
---

# Hydrasynth NRPN 14-bit addressing with FX-aware resolution

Hydrasynth exposes its full synthesis engine on 1175 NRPNs (Non-
Registered Parameter Numbers) when the device is configured for
`Param TX/RX = NRPN` (MIDI page 10). Each NRPN is a standard 14-bit
MSB+LSB CC pair; the value resolution priority chain is:

1. Enum name match (case-tolerant string lookup)
2. Enum index (numeric lookup against the enum's index range)
3. Explicit bipolar or unipolar range (per-param min/max)
4. 14-bit auto-scale (display fraction multiplied by 16383)
5. Pass-through (raw 14-bit wire value if input is already in range)

FX sub-parameters (effects-block params) resolve via a separate
`resolveFxAwareValue` path because effect parameter labels AND ranges
depend on the parent block's `prefxtype` enum (the FX type chosen
for the slot). A given FX param's display label changes when the
operator switches `prefxtype`, so resolution is context-sensitive.

## Formal definition

Standard 14-bit NRPN frame on a MIDI channel:

```
CC#99 (0x63) <msb>   ; NRPN MSB selector
CC#98 (0x62) <lsb>   ; NRPN LSB selector
CC#6  (0x06) <msb>   ; Value MSB
CC#38 (0x26) <lsb>   ; Value LSB
```

Value resolution (per `resolveNrpnValue` in `packages/hydrasynth/src/nrpn.ts`):

```ts
resolveNrpnValue(param: NrpnParam, input: string | number): number {
  // Step 1: enum-name match if input is a string and param has enum vals
  if (typeof input === 'string' && param.enum) {
    const match = matchEnumName(param.enum, input);
    if (match !== undefined) return match;
  }
  // Step 2: enum-index match if input is numeric and in enum range
  if (typeof input === 'number' && param.enum && input < param.enum.length) {
    return input;
  }
  // Step 3: explicit range coercion
  if (param.range) {
    return clampAndScale(input, param.range);
  }
  // Step 4: 14-bit auto-scale (display fraction in [0, 1] mapped to [0, 16383])
  if (typeof input === 'number' && input >= 0 && input <= 1) {
    return Math.round(input * 16383);
  }
  // Step 5: pass-through
  return input as number;
}
```

FX-aware resolution (`resolveFxAwareValue`):

```ts
resolveFxAwareValue(slot: FxSlot, paramKey: string, input: any): number {
  const fxType = readSlotFxType(slot);      // depends on prefxtype enum
  const paramSpec = lookupFxParam(fxType, paramKey);  // labels + ranges vary by fxType
  return resolveNrpnValue(paramSpec, input);
}
```

## Where it's used

Every Hydra MCP tool call that writes a synth parameter resolves
through `resolveNrpnValue` or `resolveFxAwareValue`. The 1175 NRPN
catalog lives in `scripts/hydrasynth/references/nrpn.csv` and is
loaded into `packages/hydrasynth/src/nrpn.ts` at module init.

39 hardware-locked goldens at `scripts/hydrasynth/verify-nrpn-display.ts`
exercise the resolution chain on representative params (oscillator
shapes, filter cutoff, modulation amounts, FX sub-params).

## Misapplication failure modes

- **DO NOT** treat NRPNs as CC. Standard CC (1-31, 64-95) carries 7-bit
  values on the same MIDI channel; NRPN uses the four-CC sequence above
  to deliver a 14-bit value. Confusion produces silent value truncation.
- **DO NOT** use the resolution chain for FX params via the standard
  path. FX param labels and ranges are context-sensitive on `prefxtype`;
  using `resolveNrpnValue` directly with an FX param's hard-coded enum
  produces the wrong value when the FX type doesn't match what the slot
  currently holds.
- **DO NOT** assume the device is in NRPN mode. The MIDI page 10 setting
  `Param TX/RX` defaults to `CC` on some firmware revs; NRPN must be
  enabled on the device front panel before NRPN writes take effect.
- **DO NOT** apply 14-bit auto-scale (step 4) when the param has an
  explicit `range:` definition. The auto-scale fallback is for
  display-fraction inputs only; explicit ranges produce a different
  wire value.

## Where it does NOT apply

- Fractal devices use SysEx fn-byte addressing, not NRPN; see
  [[ii-axeedit-opcode-table]] and [[am4-pidlow-register-families]].
- Hydrasynth patch dump / load uses the SysEx envelope
  ([[hydra-sysex-envelope-base64-crc32]]), not NRPN. NRPN is for
  live parameter automation; patches are bulk-transferred via SysEx.
- Hydrasynth envelope-time parameters use a different display-coercion
  path; see [[hydra-envelope-time-table]].

## Verification path

`scripts/primitives-verify.ts#case-hydra-nrpn-14bit-with-fxaware-resolution`
spot-checks the resolution priority chain on a handful of representative
NRPNs (enum-name lookup, range coercion, auto-scale fallback). The full
39-golden suite lives at `scripts/hydrasynth/verify-nrpn-display.ts` and
runs as part of `npm run test:hydra`.

## Refinement history

- Pre-extraction: NRPN catalog loaded from
  `scripts/hydrasynth/references/nrpn.csv` (1175 entries derived from
  the official Hydrasynth NRPN spec PDF).
- : 27 wire-to-ms envelope-time pairs hardware-verified on
  Explorer v2.2.0 (see [[hydra-envelope-time-table]] for the
  envelope-time-specific primitive).
- 2026-05-22 (Rosetta-stone primitives audit): promoted to
  primitive. Closes the iconic-tones portfolio decode work as a
  primitive entry; previously the resolution chain was implemented in
  code but not promoted to a primitive.
