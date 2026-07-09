---
name: am4-query-states-fn0e-transfer
class: fn-byte-mapping
status: non-matching
verified_on:
  - am4-edit
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (closed at both layers; AM4-Edit never emits fn 0x0E across 21036 frames, and the 2026-05-30 firmware probe answered with a near-empty body, not per-block state records)
relates_to: [ii-fn0e-query-states, am4-fn1f-atomic-read, am4-pidlow-register-families]
consumed_in: []
---

# AM4 fn 0x0E QUERY_STATES editor transfer: NO transfer

The Axe-Fx II fn 0x0E QUERY_STATES whole-preset block-state read
([[ii-fn0e-query-states]]) does NOT transfer to AM4 at the editor level.
AM4-Edit never issues fn 0x0E.

## Evidence

Across all 6 non-empty AM4-Edit captures (`samples/captured/
session-59-am4-*.syx`), AM4-Edit's entire wire vocabulary is four
function bytes:

- fn 0x01 PARAM_RW dispatcher
- fn 0x08 firmware-version
- fn 0x47 device-info
- fn 0x64 multipurpose-response

ZERO fn 0x0E frames appear in 21036 total Fractal frames. AM4-Edit
reads and syncs entirely via fn 0x01 action=0x0D long-descriptor reads
(the bulk of editor traffic), with no fn 0x1F atomic read and no fn
0x77/0x78/0x79 preset dump in its sync flow.

## Consequence

Our `reader.getPreset` fn 0x1F atomic-read path ([[am4-fn1f-atomic-read]])
is already faster than AM4-Edit's own read path: the editor walks
per-param fn 0x01 action=0x0D long-descriptor reads, while we issue a
single fn 0x1F per block.

## What this rules out

- Re-grepping AM4-Edit captures for a fn 0x0E whole-preset state read.
  The editor does not use one; the bytes are not there.
- Porting the II QUERY_STATES record layout into an AM4 reader as an
  editor-mirroring read path. AM4-Edit has no such path to mirror.

## Firmware-level probe result (2026-05-30): answers, but NOT with per-block state

The hardware probe is now done (`scripts/_research/probe-am4-fn0e.ts`,
read-only). The AM4 FIRMWARE DOES answer `F0 00 01 74 15 0E 1E F7`: it is
not silent and not a fn 0x64 NACK. It replies with a 41-byte fn 0x0E frame
whose 33-byte body is `1e 01 [00 x7] 2d 2d [00 x22]` (checksum 0x01,
validated).

But the body is NOT the II-style per-block QUERY_STATES record array. With
4 blocks placed (drive/amp/delay/reverb, all channel A, verified via
get_preset), the body is essentially all zeros plus a `1e 01` head and a
`2d 2d` ("--") marker, with no per-block engaged/channel records. So fn
0x0E does NOT give AM4 the whole-preset minimal-path state read that II
gets from it, and is NOT a usable shortcut for batching AM4 get_preset
channel state. The per-channel fn 0x02 walk remains the only way to read
AM4 B/C/D (now opt-in via include_channel_state since the get_preset
default flipped OFF). The "Rank 4" get_preset perf optimization via fn 0x0E
is therefore CLOSED.

Single capture (one preset). A one-variable confirmation (toggle a
scene/bypass and re-probe to confirm the body is invariant) would harden
it, but payoff is low now that AM4 get_preset defaults to active-only.

## Symptoms / grep terms

Search these before re-attempting:

- "AM4 fn 0x0E QUERY_STATES" / "port II QUERY_STATES to AM4"
- "AM4 whole-preset block-state read shortcut" / "batch AM4 channel state"
- "AM4-Edit fn-byte vocabulary" (fn 0x01 / 0x08 / 0x47 / 0x64 only)

## Refinement history

- 2026-05-28: negative finding committed after auditing all 6
  non-empty AM4-Edit captures (4-fn-byte vocabulary, zero fn 0x0E in
  21036 frames). Firmware-level fn 0x0E response remained an open
  read-only probe.
- 2026-05-30: firmware-level probe DONE (`probe-am4-fn0e.ts`). AM4 firmware
  answers fn 0x0E with a 41-byte fn 0x0E reply (body `1e 01 .. 2d 2d ..`,
  mostly zeros), NOT a per-block state array and NOT a 0x74/0x75/0x76
  state-broadcast triple. The II QUERY_STATES transfer fails at the
  firmware level too, not just the editor level; the fn 0x0E perf-shortcut
  for AM4 get_preset is closed. Editor-transfer claim above unchanged.
