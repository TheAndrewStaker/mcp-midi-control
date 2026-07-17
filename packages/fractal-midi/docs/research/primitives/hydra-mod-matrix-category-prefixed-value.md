---
name: hydra-mod-matrix-category-prefixed-value
class: value-encoding
status: partial-N1
discovered: 2026-05-30 (alpha.16 mod-routing epic; edisyn ASMHydrasynth.java mining)
verified_on:
  - edisyn-ASMHydrasynth.java (transcribed verbatim; NOT yet hardware-verified)
firmware_sensitive: false
golden: scripts/hydrasynth/verify-mod-routing.ts
relates_to: [hydra-nrpn-14bit-with-fxaware-resolution, hydra-sysex-envelope-base64-crc32]
consumed_in:
  - packages/hydrasynth/src/modRoutingTables.ts
  - packages/hydrasynth/src/modRouting.ts
  - packages/hydrasynth/src/encoding.ts
  - packages/hydrasynth/src/descriptor/schema.ts
  - packages/core/src/protocol-generic/dispatcher/navigation-modroute.ts
  - scripts/hydrasynth/generate-mod-routing.ts
---

# Hydrasynth mod matrix: category-prefixed 14-bit value, not an enum index

**Status:** matched-singleton (shipped in `packages/hydrasynth/src/modRouting.ts`)
**Device:** ASM Hydrasynth Explorer

---

## Primitive

The mod-matrix routing fields - `modmatrix<N>modsource`,
`modmatrix<N>modtarget`, and the macro-page `macro<M>target<S>` - do **not**
take a list index. They take a **14-bit category-prefixed wire value** drawn
from the device's own source / destination tables.

The device tells a route's *source* field apart from its *target* field by
the high-byte category prefix of the value, NOT by a separate register:
`modmatrix<N>modsource` and `modmatrix<N>modtarget` share the same NRPN
address (`msb=0x3e`, `lsb=N-1`); the value's prefix disambiguates.

```
sourceWire = categoryHi * 128 + categoryLo
```

- **Sources** carry prefixes `0x01` (Env/LFO/Keytrack/Vel/Wheel/CC),
  `0x03` (Note-Off Vel, MPE, Voice Mod). E.g. `Env 1` = `0x01*128 + 0x01`
  = 129; `Mod Wheel` = `0x01*128 + 0x18`.
- **Destinations** carry prefixes `0x02`, `0x04`, `0x05`. E.g.
  `Osc 1 Pitch` = `0x04*128 + 0x01` = 513; `Filt 1 Cutoff` =
  `0x02*128 + 0x28` = 296; `Macro 1` (as a destination) = `0x02*128 + 0x50`.

The **depth** fields (`modmatrix<N>depth`, `macro<M>depth<S>`) are a plain
bipolar 14-bit: display `-128..+128` over wire `0..8192`, center 4096.

Consequence: the generic enum path (which sends the list *index*) cannot
encode these. A separate value-table resolver is required.

---

## Evidence

Source of the tables: the edisyn reference editor
`ASMHydrasynth.java` (Apache-2.0, Sean Luke / GMU) - the same vendored
reference the shipped 1655-param `nrpn.csv` catalog was distilled from. It
holds four parallel arrays:

```
MOD_SOURCES[i]                 -> label
MOD_SOURCE_NRPN_VALUES[i]      -> wire value   (// "Env 1" = 0x01*128+0x01)
MOD_DESTINATIONS[i]            -> label
MOD_DESTINATION_NRPN_VALUES[i] -> wire value   (// "Osc 1 Pitch" = 0x04*128+0x01)
```

`MOD_SOURCE_NRPN_VALUES_TO_INDEX` / `..._DESTINATION_...` are the
reverse maps the editor builds at load. Same-source aliasing exists
(`Sustain Ped` and `CC 64` share one source wire) - expected, deduped
first-wins on the wire→label side.

---

## Application

- Generator: `scripts/hydrasynth/generate-mod-routing.ts` parses the four
  arrays (evaluating the `hi*128+lo` arithmetic, never copying the literal,
  so a typo in one factor fails the build), asserts
  `names.length === values.length` for source + destination, spot-checks
  named anchors, and emits `packages/hydrasynth/src/modRouting.ts`
  (163 sources, 330 destinations) with `MOD_SOURCE_BY_WIRE` /
  `MOD_DEST_BY_WIRE` (decode), `MOD_SOURCE_NAMES` / `MOD_DEST_NAMES`
  (discovery order), and tolerant `resolveModSource` / `resolveModDest`.
- `resolveModRoutingWire()` in `encoding.ts` runs first in
  `resolveNrpnValue`: routes the source/target fields to the value tables,
  depth fields to the bipolar encoder. **Numeric input passes through
  untouched** (the INIT buffer and any round-trip carry raw wire ints;
  wire 0 = empty/Off slot, not in the name table) - only name *strings*
  resolve through the tables.
- `descriptor/schema.ts` surfaces the fields as name-backed enums so
  `list_params` / `get_param` speak labels.
- Golden: `scripts/hydrasynth/verify-mod-routing.ts` (in `test:hydra`).

---

## Cross-device note

Any synth whose mod matrix stores a category-prefixed source/destination
value (rather than a position index) maps to the same `set_mod_route`
write primitive. The Fractal modifier/controller system is the analogous
target on the amp-modeler side (surfaced as `modifier_wirings_deferred`
in `translate_preset` output today).

## Status (partial-N1: edisyn-transcribed, not yet hardware-verified)

The wire values are transcribed verbatim from edisyn `ASMHydrasynth.java`
(the same source the shipped 1655-param `nrpn.csv` catalog rides on) and
cross-checked against edisyn's own parallel arrays + 6 byte-exact generator
anchors. They are NOT yet confirmed on hardware. Two things gate promotion:

1. **Hardware confirmation** that a known route (e.g. Env 2 → Filt 1 Cutoff)
   is audibly active after `set_mod_route`. UPDATE (live recipe audition,
   2026-05-31): the front-panel MOD MATRIX page DOES redraw to reflect
   NRPN-driven routes: a wired route read back on the screen as
   `SRC modWhl → Filt 1 Cutoff 55`, exactly as sent. The earlier
   edisyn-comment warning ("page does not redraw from MIDI") is superseded:
   the normal "front panel is ground truth" check DOES apply, so confirm by
   screen OR by audible effect. The remaining gate is route DEPTH/value
   calibration against the catalog, not whether the page reflects the route.
2. **A second device axis** - only the Hydrasynth is decoded today; the
   category-prefix scheme is Hydrasynth-specific (the prefix encodes the
   device's own module taxonomy). A second synth's matrix decoded to the
   same shape would promote toward `matched`.

This sits at the same provenance tier as the entire shipped Hydra NRPN
catalog: edisyn-derived, generator-gated against transcription error, but
awaiting a hardware round-trip.

## Macro destination start/end (hardware-observed 2026-06-01)

A macro-page destination is a **start → end pair**, not a single depth. The
`macro<M>depth<S>` field (msb 0x36) is the sweep **END**: a wired destination
read back on the panel as `... → <depth>` exactly as sent. The **START** is a
separate per-destination field; the only one not written by `set_macro_route`
is `macro<M>buttonvalue<S>` (msb 0x3d, bipolar, wire 0 → display −128), so it
is almost certainly the start (a prior analysis mislabeled it "button/latch").
On a fresh patch, slots past the first read −128 (uninitialized) as the start;
for unipolar destinations whose floor is 0 this clamps harmlessly (sweep
0 → depth), but a bipolar / non-floor start would be wrong. Confirming the
0x3d-as-start mapping with a write round-trip (write buttonvalue, read the
panel start) is the open item before `set_macro_route` should write it.

## Refinement history

- 2026-05-30: discovered + shipped during the alpha.16 mod-routing epic.
  Tables mined from edisyn `ASMHydrasynth.java` (same vendored source as
  the 1655-param `nrpn.csv` catalog), generator + golden landed same
  session. `verify-mod-routing.ts` carries 54 checks incl. the byte-exact
  wire anchors quoted above.
