<!-- Provenance: harvested from branch `hydrasynth-explorer` (commit 3d63075 "hydrasynth updates"). Source path: docs/devices/hydrasynth-explorer/OVERVIEW.md. Updated to reflect current monorepo state: NRPN map now decoded (1175 params live in `packages/hydrasynth/src/nrpn.ts`), CC catalog embedded in tool descriptions (117 entries), SysEx patch flow implemented (`hydra_apply_patch`), and `/8` patch-buffer scaling + 14-bit auto-scale rules summarized. -->

# Hydrasynth Explorer — Overview

## The device

ASM Hydrasynth Explorer. Keytar form factor (the scaled-down sibling
of the Hydrasynth Keyboard / Desktop / Deluxe). Same synthesis engine
as its larger siblings:

- 8 voices.
- 3 oscillators per voice (Osc 1 + 2 with Wave Morph + WaveScan; Osc 3
  simpler).
- 2 filters (per-voice, configurable in series or parallel).
- 5 envelopes, 5 LFOs.
- 4 Mutators (FM / ring-mod / wavefolder / phase-mod variants per slot).
- 8 Macros, 32-slot mod matrix.
- Onboard arp + Pre-FX + Delay + Reverb + Post-FX.
- Mono USB MIDI (class-compliant, no driver install) + 5-pin MIDI
  In/Out + CV/Gate/Clock outs.

Single-patch only (no multi-patch like the Deluxe). 8 banks A–H × 128
patches.

## Why we care

Adds a synth alongside the Fractal amp modeller so the project covers
more than guitar gear. Synthesis is the founder's first deep dive into
the topic from a guitar background — tool descriptions for this device
will lean pedagogical.

## Protocol surface

Source: `docs/devices/hydrasynth/manuals/Hydrasynth_Explorer_Owners_Manual_2.2.0.pdf`,
"MIDI" section pp. 80–83 + "MIDI CC Charts" pp. 94–96. NRPN map
sourced from `references/nrpn.csv` (vendored from eclab/edisyn,
Apache-2.0). SysEx encoding sourced from
`references/SysexEncoding.txt` + `references/SysexPatchFormat.txt`
(same upstream).

| Channel | Status | What's available |
|---|---|---|
| **System CCs** (always on) | 🟢 documented + used in tools | CC 0/32 Bank Select MSB/LSB, CC 1 Mod Wheel, CC 7 Master Volume, CC 11 Expression Pedal, CC 64 Sustain, CC 123 All Notes Off. Per p. 82, these are NOT affected by the Param TX/RX setting — they always work. Exposed via `hydra_set_param` (System CCs only). |
| **Engine CCs** (Param TX/RX = CC) | 🟡 documented, partly verified | 117 CCs across Osc / Mixer / Filter / Amp / Env / LFO / Mutator / Macro / Arp / FX, embedded in the `hydra_set_engine_param` tool description. **Requires the device's MIDI Param TX/RX setting set to CC** (System Setup → MIDI page 10). 117 CCs also aliased to the NRPN catalog so the same parameter name works whichever mode the device is in. |
| **Engine NRPNs** (Param TX/RX = NRPN) | 🟢 1175 params decoded | Full NRPN map in `packages/hydrasynth/src/nrpn.ts`. Address by parameter name; the schema handles multi-slot disambiguation, 14-bit value resolution, and enum name lookup. Param TX/RX = NRPN is the device's default and the path the tooling assumes by default. |
| **Program Change + Bank Select** | 🟢 documented | Bank A–H = MSB 0, LSB 0–7. PC 0–127 selects within bank. Pgm Chg TX/RX toggles on MIDI page 11. |
| **SysEx patch dump** | 🟢 envelope + base64 + CRC-32 decoded; byte-map of patch payload decoded; round-trip implemented as `hydra_apply_patch` | Wire shape from `references/SysexEncoding.txt`; byte-offset map of the patch payload from `references/SysexPatchFormat.txt`. Implementation: `sysexEnvelope.ts` (envelope codec) + `patchEncoder.ts` (byte-map writer). |
| **MPE** | 🟡 documented | On/off toggle on MIDI page 9. Out of scope for v1. |

## Value-encoding quick reference

These three rules cover most of the surprises when reading or
writing engine values. Full implementation lives in
`packages/hydrasynth/src/encoding.ts` (`resolveNrpnValue`)
and `patchEncoder.ts`.

### `/8` patch-buffer scaling

In the **patch-buffer SysEx format** (the round-tripped state behind
`hydra_apply_patch`), most engine knobs store `display = wire / 64`
on the wire but get packed into the patch buffer as `wire / 8`. So a
14-bit param with `wireMax = 8192` (engine display 0..128) lives in
the patch buffer as a byte 0..255, and bipolar params (e.g. pan,
detune, env amount) center at +64 in the patch byte. This is why
`patchEncoder.ts` divides by 8 before packing and adds +64 for bipolar
fields. The same rule does NOT apply to live NRPN writes — those send
the full 14-bit value via data-MSB+LSB.

### 14-bit auto-scale for live NRPN writes

For unipolar 14-bit NRPN params (`wireMax > 127`, not multi-slot, not
enum), numeric inputs in `0..128` are auto-scaled: `wire = round(input
× wireMax / 128)`. Callers can stay in a `0..128` mental model and the
device sees the full-resolution wire value. Trade-off: `value = 127`
lands at display `127.0`, not max; pass `128` (or any value ≥ 128) to
reach `wireMax`. Hydrasynth's UI itself uses `0..128`, not `0..127`,
so integer inputs land on integer displays this way.

Bipolar / explicit-range params (those with both `displayMin` and
`displayMax` set in the NRPN entry) bypass the auto-scale and use a
linear `(input − displayMin) × wireMax / range` mapping. OOB inputs
**throw** on bipolar params (silent fallback to percent-scaling caused
real bugs — `reverbtone=72` was displayed as `8.0` because 72
percent-scaled past the bipolar range). OOB on unipolar params
passes through as raw wire so advanced callers can address the full
range when needed.

### Enum-table resolution

NRPN entries that reference an enum table (auto-detected from the CSV
notes column) accept either an integer index or a display-name string
(`osc1type: "Sine"`, `prefxtype: "Lo-Fi"`). Tables are vendored from
edisyn's `ASMHydrasynth.java` and live in
`packages/hydrasynth/src/enums.ts`. The sparse-encoded FX
type family (prefxtype / postfxtype / delaytype / reverbtype /
reverbtime) carries an `enumValueScale` (×8 for FX types) so that
"Lo-Fi" resolves to enum index 1 × scale 8 = wire 8.

## Capability matrix

| Capability | Tool | Status |
|---|---|---|
| Set master volume / mod wheel / sustain | `hydra_set_param` (System CCs) | 🟢 ships |
| Switch patch within a bank | `send_program_change` | 🟢 ready |
| Switch patch across banks | `send_program_change` with bank MSB/LSB | 🟢 ready |
| Edit a single engine parameter (cutoff, env attack, …) | `hydra_set_engine_param` | 🟢 ships (NRPN; CC alias supported) |
| Batch a recipe of engine writes | `hydra_set_engine_params` | 🟢 ships (3ms pacing per edisyn) |
| Search the 1175-NRPN catalog by name | `hydra_param_catalog` | 🟢 ships (ranked fuzzy search) |
| Apply a fresh patch atomically | `hydra_apply_patch` | 🟢 ships (SysEx-from-INIT, audible by construction) |
| Trigger notes (test patches, demo) | `send_note` | 🟢 ready |
| List enum values for a param (e.g. all OSC waves) | `hydra_list_enum_values` | 🟢 ships |
| Read patch from device | (deferred — Request flow specified in `references/SysexEncoding.txt`, not yet wired) | 🔴 |
| Static decode of `.hydra` / `.patch` file format | (deferred — see `HYDRA-FILE-FORMAT.md`) | 🔴 |
| Multi-Hydrasynth Overflow mode | n/a — niche | (non-goal) |
| Microtonal scale uploads | n/a — deferred | (non-goal) |
| MPE routing | n/a — deferred | (non-goal) |

## Non-goals (v1)

- Multi-Hydrasynth Overflow mode (manual p. 83) — niche.
- Microtonal scale uploads — deferred.
- MPE routing — deferred.
- Hydrasynth Deluxe multi-patch mode — Explorer is single-patch
  only, so this is moot for our specific device.

## See also

- [`SYSEX-MAP.md`](./SYSEX-MAP.md): the CC chart + NRPN-catalog reference.
- [`preset-format-research.md`](./preset-format-research.md): the
  ASM-Manager `.hydra` / `.patch` file format probe findings
  (1762-byte format, distinct from the SysEx patch payload).
- `docs/_private/HYDRASYNTH-ICONIC-TONES.md`: 15 iconic synth tones
  used as hardware tests + demo portfolio (founder-private).
- Vendored edisyn artefacts (`nrpn.csv`, `SysexEncoding.txt`,
  `SysexPatchFormat.txt`, `ASMHydrasynth.java`) live in the
  maintainer's local research workspace; not committed.
