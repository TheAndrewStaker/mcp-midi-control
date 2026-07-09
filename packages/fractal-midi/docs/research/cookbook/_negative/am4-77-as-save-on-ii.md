---
name: am4-77-as-save-on-ii
class: envelope-shape
status: non-matching
discovered:  ( cross-model save attempt)
verified_on:
  - axe-fx-ii-xl-plus
firmware_sensitive: true
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when:
  - a decoded II save-to-location wire shape (mine AxeEdit II's save path; see STATE-AXEFX2.md. The moment II's native single-location save is known, this envelope-transfer verdict is moot rather than re-testable)
relates_to: [ii-fn1f-atomic-read, vendor-envelope-descriptor-table]
consumed_in: []
---

# AM4-shaped `0x77` envelope as a save-to-location on II: does NOT work

A natural cross-model transfer hypothesis is: AM4's `0x77` preset-
save envelope (model byte `0x15` + preset-location payload + xor-7F
checksum) might work as a save-to-location on Axe-Fx II if we
substitute model byte `0x07`. It does NOT.
sent the byte-substituted envelope to an Axe-Fx II XL+; the device
acknowledged the message at the envelope layer (no NACK) but
performed no write; the target location was untouched on the next
read-back.

## Scope of the negative

This negative applies to **the AM4-shaped wire form used as a save
attempt** (AM4 model byte 0x15 swapped to II's 0x07, AM4 payload
shape retained). It does NOT generalize to "0x77 is meaningless on
II." Axe-Fx II uses `0x77/0x78/0x79` for its OWN preset-dump
envelope, a different shape with different payload semantics; see
SESSIONS.md entries around line 1024 / 7800 / 7865 / 10604 / 10673
and memory `project_axefx2_preset_dump_path`. The II 0x77 envelope
is wire-confirmed bidirectional for preset *dump*, not for the
single-location save the AM4 wire shape performs.

## Why the transfer fails

Each device family has its own envelope decode and dispatch table.
Model byte selects the dispatcher in the firmware, not just the
namespace. The AM4 dispatcher handles `0x77` as
"single-preset-store-at-location," while the II dispatcher handles
`0x77` as the leading frame of a multi-frame preset-dump exchange.
Substituting the model byte routes the message to the wrong
dispatcher; the payload shape does not match what that dispatcher
expects and the message is silently dropped (no NACK is also a
documented Fractal behavior for malformed-but-envelope-valid input).

## What works instead

- **[[ii-fn1f-atomic-read]]:** fn=0x1F SYSEX_GET_ALL_PARAMS is the
  II atomic-read primitive recovered from AxeEdit.exe .
  Single round-trip; full per-block state.
- For save-to-location on II specifically: open question pending a
  dedicated decode (see STATE-AXEFX2.md). Do not extrapolate from
  AM4's envelope; mine AxeEdit II's save path via Ghidra
  (`SeekParamTablesII.java` style; the "skip Ghidra for II" rule
  was overturned 2026-05-17).

## What this does NOT rule out

- `0x77` on II in its native dump-envelope role. That works.
- Cross-model transfer of *primitive-level* shapes (septet
  encoding, xor-7F checksum, vendor-envelope-descriptor-table).
  Those are device-agnostic. The failure is specific to envelope-
  level dispatch.
- A future "byte-substitute the AM4 envelope" attempt against a
  Fractal device with no native save dispatcher. Out of scope.

## Symptoms / grep terms

Search these before re-attempting:

- "AM4 0x77 as save on II" / "0x77 save-to-location Axe-Fx II"
- "byte-substitute model byte save" / "swap model byte 0x15 to 0x07"
- "0x77 envelope inert" / "acked but no write"

## Refinement history

- 2026-05-22 (cookbook backfill): negative finding registered after
   closure. Wording explicitly scoped to "AM4-shaped 0x77 as
  save on II"; the broader "0x77 inert on II" claim from earlier
  CLAUDE.md text was a scope overclaim and is retired.
