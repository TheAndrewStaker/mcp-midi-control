---
name: iii-fn40-as-store-preset-begin
class: fn-byte-mapping
status: non-matching
discovered: 2026-05-22 (cookbook-mine of ghidra-axe-edit-iii-store-preset.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; negative finding; caller-chain evidence in ghidra-axe-edit-iii-store-preset.txt; see Symptoms / grep terms)
retest_when: never (caller-chain proven; fn=0x40 is LOAD_PRESET, identified by the 3000-byte inbound-buffer read signature; the store path is the 0x77/0x78/0x79 exchange itself with the preset index patched into the 0x77 header)
relates_to: [iii-host-emitter-fn-table, vendor-envelope-descriptor-table, msb-first-14bit-preset-payload]
consumed_in: []
---

# Axe-Fx III fn=0x40 is NOT "STORE_PRESET BEGIN"

A natural hypothesis when decoding the III's `0x77/0x78/0x79` multi-
frame preset-push exchange is that fn=0x40 acts as a handshake or
"begin" marker preceding the dump frames. It does NOT. fn=0x40 on the
Axe-Fx III is a LOAD_PRESET (read-side) request and is unrelated to
the store workflow.

## Scope of the negative

This applies specifically to the hypothesis "fn=0x40 is part of the
III save/store pipeline." The III's actual store workflow has no
separate handshake fn-byte; the target preset index is encoded
directly into the first `0x77` PRESET_DUMP_HEADER frame via
[[msb-first-14bit-preset-payload]].

## Refutation evidence

Caller-chain analysis of `Axe-Edit III.exe` v1.14.31 (decompile in
`fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`):

1. `FUN_140337060` (envelope positions 8-231 of the dump) is the
   fn=0x40 builder. It walks the [[vendor-envelope-descriptor-table]]
   at `0x1407ab2f0` (declares two single-byte fields at wire offsets
   6 and 7), septet-encodes a 2-byte payload, and emits via
   `FUN_1403437d0(..., 0x40, ...)` at L182.
2. `FUN_140337060` has exactly ONE caller: `FUN_1402990d0`
   (L236-265). The caller's body:
   - Allocates a **3000-byte inbound buffer** via
     `FUN_14032eb90(local_res18, 3000)` at L249 BEFORE issuing the
     send.
   - Calls `FUN_140337060(lVar1, local_res10)` at L251 with the
     1-byte input that becomes the request payload.
   - Wires the resulting buffer into the III host's pending-response
     list at L260 for the async receive path.
3. `FUN_14014d400` (L350-1271) is the actual STORE_PRESET UI
   dispatcher, identifiable by its `"permanently overwrite N presets
   in your ..."` warning string (L573-575). It dispatches the store
   work via a switch on store-mode (cases 3, 4, 5, 7, 8 covering
   single / bank / IR-only / FullRes IR-bank variants). **None of
   these switch cases call `FUN_140337060`.** Case 4 (bank-store)
   calls the `0x77` PRESET_DUMP_HEADER stream-patcher `FUN_14014d2a0`
   directly.

The 3000-byte inbound allocation is the diagnostic signature of a
READ/LOAD request. Store/write requests don't allocate a large
inbound buffer because they don't expect a sizable response.

## What works instead

- The III's actual store path is the multi-frame `0x77/0x78/0x79`
  exchange. The target preset index is patched into the `0x77`
  PRESET_DUMP_HEADER via [[msb-first-14bit-preset-payload]] (see
  `FUN_14014d2a0` in the same dump, L322-339).
- For LOAD (the operation fn=0x40 actually performs), no project
  consumer exists yet; the wire shape `(0, 6, 1) + (1, 7, 1)` from
  the descriptor table at `0x1407ab2f0` is documented in
  `docs/devices/axe-fx-iii/fn-byte-envelopes-ghidra.md:38`.

## What this does NOT rule out

- fn=0x40 itself. It IS a host-emittable opcode on the III; it just
  does LOAD, not STORE_BEGIN.
- Other "handshake fn-byte" hypotheses for other fn-byte families.
  Some III opcodes do come in begin/data/end triples; this rule-out
  is specific to fn=0x40.

## Cookbook discipline note (generalization candidate)

A 1-byte fn-byte emitter whose caller allocates a large inbound
buffer (hundreds to thousands of bytes) before sending should be
treated as a READ/LOAD request, not a WRITE/STORE handshake. STORE
calls don't pre-allocate response buffers of that size. This
heuristic, applied during caller-chain analysis, would have ruled
out the fn=0x40-as-store-begin hypothesis without needing the full
STORE-dispatcher trace. Filed for future cookbook synthesis review.

## Symptoms / grep terms

Search these before re-attempting:

- "fn 0x40 store preset begin" / "III save handshake fn byte"
- "0x40 is LOAD_PRESET" / "store workflow has no handshake fn-byte"
- "3000-byte inbound buffer" (the read-request diagnostic signature)

## Refinement history

- 2026-05-22 (cookbook-mine of `ghidra-axe-edit-iii-store-preset.txt`):
  negative finding registered. Earlier project notes and community
  RE conversations had floated fn=0x40 as the III's STORE_BEGIN; the
  caller-chain trace refutes this. Second-source confirmation in
  `fractal-midi/docs/devices/axe-fx-iii/fn-byte-envelopes-ghidra.md`
  lines 38 and 94-110.
