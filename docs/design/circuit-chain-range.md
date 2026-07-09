# Circuit Tracks pattern CHAIN range: decode (range capture queued)

## What's decoded

A Circuit `.ncs` project chains drum patterns so the device auto-advances
through a range and loops. From a before/after device diff (2026-06-22, Project
43), each drum track carries a `[start, end]` pattern range plus a chain-enable
tail byte:

| Field | Offset | Value (Project 43) |
|---|---|---|
| chain start (per track) | `0x2d4 + track*4` | `0` |
| chain end (per track) | `0x2d5 + track*4` | `1` |
| chain-enable tail | `0x26fc7` | `0x0c` |

So the captured project chains patterns **1→2** (0-based `[0,1]`) on all four
drum tracks. Codec: `packages/circuit-tracks/src/ncs/chain.ts`
(`setDrumChain`, `setAllDrumLengths`), golden in `scripts/verify-circuit-ncs.ts`.

## What's BETA (untested)

`setDrumChain` writes the same `[start, end]` integer layout for any range, but
**only `[0,1]` is hardware-confirmed.** Two things are unverified for wider
ranges:

1. **The `[start,end]` bytes are integer pattern indices**, strongly implied by
   the capture (`start=0`, `end=1`), but only one data point.
2. **The tail byte `0x0c`**: its role is unknown. It might be a fixed
   chain-enable flag (in which case wider ranges Just Work), or it might encode
   the range length / a mode (in which case a wider chain needs a different tail
   and the current code would under-specify it).

Until confirmed, treat any chain other than `[0,1]` as decoded-beta: it will
likely play the intended range, but verify by ear / on the device first.

## Capture to confirm (QUEUED)

One before/after diff settles it: on the device, set a drum track to chain
patterns **1→4** (range `[0,3]`), save to a scratch slot, download, and diff
against a baseline (the same method that produced the `[0,1]` decode).

- If `0x2d5+t*4` reads `3` and `0x26fc7` is still `0x0c` → the layout
  generalizes; promote `setDrumChain` to confirmed and drop the beta label.
- If the tail differs (e.g. scales with the range) → record the real tail
  encoding and update `setDrumChain` before any wider-range use ships.

Reuse `scripts/circuit-download-slot.ts` for the download; diff the drum-chain
region (`0x2d4..0x2e3`) + `0x26fc7`.

## Why it matters

This is the bridge for whole-song playback: `decomposeToPatterns` /
`coalescePatterns` reduce a song to a small pattern bank (often ≤8, fits the
8 pattern slots), and a chain over `[0, bankSize-1]` makes those patterns
auto-advance as the song. Confirming the range unlocks `fitsViaChainOnly` songs
playing end-to-end (the remaining piece is authoring the bank into the 8 pattern
slots of one project: `authorPlanIntoProject` currently writes only pattern 0;
generalizing it to a target pattern index is the other half of that feature).
