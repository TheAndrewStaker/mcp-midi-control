---
name: gen3-stored-block-chain-order
class: layout
status: matched
discovered: 2026-11-12 (re-mine of the III factory banks against a community report that stored reads named Input as Vol/Pan and dropped blocks on newer firmware)
verified_on:
  - axe-fx-iii fw 28.06 (factory banks A/B/C, 384 presets, no exception)
  - fm9 (one editor export)
  - fm3 fw 13 (two hardware captures)
firmware_sensitive: false
golden: scripts/verify-gen3-preset-body.ts (per-preset "blocks are named from the grid, one per placed block" across the 384 III factory presets, plus the FM3 fw 13 capture check)
relates_to: [am4-gen3-preset-container, gen3-fn03-request-preset-dump, gen3-fn01-grid-routing]
consumed_in:
  - mcp-midi-control/packages/fractal-gen3/src/presetBody.ts (CHAIN_ORDER, labelsFromGrid, walkBlocks)
  - mcp-midi-control/packages/fractal-gen3/src/reader.ts (stored get_preset slots + read warnings)
---

# Gen-3 stored preset: the block chain lists the grid's blocks in a fixed family order

Inside the decompressed preset body, after the run of 25x1 modifier slots, the
block chain holds one entry per block placed on the grid, then one trailing
system entry (350x1 on the III). An entry's header carries its parameter-table
size (`cols` at header word 15, `rows` at word 16) and **no effect id**.

Two facts make every entry nameable anyway:

1. **Count.** Chain entries (modifier slots excluded) = distinct non-shunt
   effect ids on the grid + 1. True in all 384 III factory presets.
2. **Order.** The entries follow a fixed family order, instances ascending
   inside a family:

   Amp, Cab, Chorus, Comp, Crossover, Delay, Enhancer, Return, Send, Filter,
   Flanger, Formant, Drive, Gate, GEQ, MultiTap, Input, Megatap, Mixer,
   Multiplexer, MultiComp, Output, PEQ, Pitch, Phaser, Plex Delay, Reverb,
   RingMod, Rotary, Synth, Ten-Tap, Tremolo, Resonator, Vol/Pan, Wah,
   Tone Match, RTA, Looper, effect id 202 (unnamed in any published list).

   Sorting a preset's grid ids by this order and pairing them with the chain
   puts every family on a single table size across all 384 presets, and
   swapping any adjacent pair that shares a preset breaks at least one.

The order is empirical. It is close to alphabetical on some internal name
(Drive sorts as if "Fuzz", Send/Return as if "Feedback ...") but MultiTap,
Pitch-before-Phaser, Multiplexer-before-MultiComp and the tail do not fit a
name sort, so no naming rule is claimed.

## Why it matters

Table sizes move with firmware (III Delay 88 columns on fw 28; FM3 fw 13 Delay
89, Drive 44, Chorus 32), and several families share a size (33x4 Flanger and
PEQ; 37x4 Comp, Filter and MultiComp; 12x4 Enhancer and Formant; 10x4 is
Input, 26x4 is Output). Naming by size therefore drops blocks on new firmware
and names Input as Vol/Pan and Output as PEQ. Naming by order needs no size
table at all.

## Limits

- 29 family pairs never share a factory preset, so their relative order is
  unproven (all involve Megatap, Mixer, Multiplexer, MultiComp, Resonator,
  Ten-Tap, Tone Match, RTA, Looper or id 202). The decoder reports when a
  preset contains such a pair.
- Vocoder, Scene MIDI and IR Player appear in no preset on hand and have no
  place in the order. A preset that places one falls back to size naming and
  says so.
- The FM3 and FM9 evidence is three presets. The pairing is guarded by the
  count check, so a device that broke it would fall back, not mislabel.
- Header word 17 of a Rotary entry is a knob value, not a type id (it read
  back as "type 42597").
