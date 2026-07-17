---
name: iii-sysex-dsp-message-unbound
class: fn-byte-mapping
status: non-matching
discovered: 2026-07-09 (BK-054/BK-055 outer fn-byte dispatch mine)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when:
  - never (structural: Ghidra static analysis is exhausted by three independent techniques; only a live capture can close this)
relates_to: [iii-host-emitter-fn-table, iii-async-workflow-fn-registry, byte-literal-envelope-ghidra-search, iii-fn-byte-switch-as-inbound-dispatcher]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-sysex-xref-attempt.txt
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-indirect-fn-callers.txt
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
---

# Negative: `SYSEX_DSP_MESSAGE`'s function byte cannot be recovered from AxeEdit III static analysis

`Axe-Edit III.exe` (v1.14.31) contains the ASCII string `SYSEX_DSP_MESSAGE`
(one of 23 `SYSEX_*` symbols in a contiguous `.rdata` pool at
`0x5aaf80`..`0x5ab2b0`; see the "Function names confirmed in AxeEdit III
binary" table in `docs/devices/axe-fx-iii/SYSEX-MAP.md`). BK-055 wanted its
function byte, to wire a dedicated `get_dsp_usage` tool. **Three
independent static-analysis techniques all came back negative.**

## Hypothesis ruled out

That `SYSEX_DSP_MESSAGE`'s function byte is recoverable by (a) its position
in the `SYSEX_*` string pool, (b) a direct or indirect code cross-reference
to the string's address, or (c) a named entry in the async-workflow
dispatch registry that every OTHER inbound fn-byte on III resolves through.

## Why the hypothesis fails

1. **String-offset-index fit** (`scripts/_research/mine-axeedit3-sysex-table.ts`).
   No single `fn = index + delta` constant fits all 8 anchors whose function
   byte IS known from the v1.4 PDF (`SYSEX_SETGET_BYPASS` etc.). A parallel
   scan for a compile-time `u8`/`u16`/`u32` lookup array (every stride, every
   plausible table length) also found zero hits. See
   `docs/devices/axe-fx-iii/fn01-decode.md` "Mined" section for the full
   anchor table and negative.

2. **Exhaustive code cross-reference scan**
   (`FindAxeEditIIISysexNamesIndirect.java`). Tested three hypotheses for
   *indirect* string reference that a naive LEA/MOV operand scan would miss:
   - **H1**: PE relocations targeting the string range: 36,516 relocations
     scanned, **0 hits**.
   - **H2**: a pointer-array table (any of 10 strides from 4 to 64 bytes)
     holding string addresses: **0 hits at every stride**.
   - **H3**: RIP-relative effective-address arithmetic across every
     instruction operand in the binary (1,395,080 instructions scanned):
     **0 hits for all 23 `SYSEX_*` strings**, `SYSEX_DSP_MESSAGE` included.

   Raw log: `samples/captured/decoded/ghidra-axe-edit-iii-sysex-xref-attempt.txt`.
   **No code anywhere in `Axe-Edit III.exe` references any `SYSEX_*` string
   by address**, by any addressing mode Ghidra's operand/relocation/pointer
   model can detect.

3. **Async-workflow registry name grep** (2026-07-09, this session). Every
   OTHER undocumented fn-byte on III resolves through the async-workflow
   registry (`FUN_1401f0f10`, dumped in
   `ghidra-axe-edit-iii-inbound-dispatcher.txt`; see
   [[iii-async-workflow-fn-registry]]), ~140 `FUN_14005faa0(&handle,
   "Workflow Name")` registration call sites, each pairing a human-readable
   name with the fn-bytes it listens for. Grepped the full dump
   (case-insensitive) for `dsp`, `cpu`, `usage`, `meter`, `load`,
   `overload`: **zero matches among the workflow names**. The one "meter"
   hit is a JUCE RTTI class, `A3MeterCtrl`, referenced twice, but in
   context it is a **per-parameter** UI meter widget (fed by the ordinary
   per-param value-update path, `sqrt()`-scaled VU-ballistics rendering
   keyed off a small display-type code), not a global CPU/DSP readout. If
   AxeEdit III has a status-bar DSP meter, it either (a) reads it from a
   frame this registry ALSO doesn't name (a real possibility: many
   telemetry fields ride inside an already-used opcode's reply, exactly
   like the confirmed `fn=0x01 sub=0x2E` `cpu_percent` field does, see
   below), or (b) the UI widget for it lives in a code path this dump
   didn't capture.

## What this does NOT rule out

- That `SYSEX_DSP_MESSAGE` is real, wired firmware-side, and simply never
  emitted or listened for by AxeEdit III specifically (it could be a
  different Fractal product's opcode, sharing a header/enum with III's
  binary without III's editor ever sending it).
- That a live USBPcap capture of AxeEdit III's own status-bar DSP meter
  updating would reveal the real wire path (static analysis works from
  compiled code reachability; if the feature is UI-only decoration fed by
  data already flowing through an opcode this project has decoded, no
  string reference would ever exist to find).
- **The DSP/CPU-usage CAPABILITY itself is not blocked.** `fn=0x01
  sub=0x2E`'s empty-target reply already carries `cpu_percent` (see
  `docs/devices/axe-fx-iii/SYSEX-MAP.md` "BK-055" subsection); this negative
  is scoped to the specific `SYSEX_DSP_MESSAGE` symbol/opcode, not to
  whether the III can report its DSP load at all.

## Search terms to avoid re-attempting

- "find SYSEX_DSP_MESSAGE fn byte", "bind SYSEX_* string to opcode",
  "AxeEdit III DSP usage opcode"
- "SYSEX_* string offset index mapping" (see the sibling negative in
  `fn01-decode.md`'s "Mined" section; this entry extends that one from
  "offset-index doesn't work" to "NO xref of any kind exists")
- "Ghidra find get_dsp_usage in AxeEdit III": static analysis is exhausted
  three ways; the next lane is a live capture, not more Ghidra passes.

## What to do instead

Use `fn=0x01 sub=0x2E`'s decoded `cpu_percent` field (shipped,
`liveMeters.ts`). `scripts/probe-iii-dsp-usage.ts` exercises it as its
PRIMARY (decoded) job and, separately and loudly labeled, tries a few
still-unbound standalone fn bytes (`0x00`/`0x04`/`0x08`/`0xFF`) as
EXPERIMENTAL guesses in case one of them turns out to answer.

## Refinement history

- 2026-07-09 (initial finding): filed after re-verifying the pre-existing
  `mine-axeedit3-sysex-table.ts` negative (H1: offset-index fit) and
  `FindAxeEditIIISysexNamesIndirect.java` negative (H1/H2/H3 xref scan)
  against BK-055, then adding a THIRD independent check (the async-workflow
  registry name grep) that closed the last plausible lane. All three
  results are consistent: nothing in `Axe-Edit III.exe`'s compiled code
  path connects to this string. Filed as negative so a future session
  doesn't re-run the same three checks without new evidence.
