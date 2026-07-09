---
name: windbg-trap-after-launch
class: label-extraction
status: non-matching
discovered:  (AM4-Edit label-loader hunt)
verified_on:
  - am4-edit-1.x-windows
firmware_sensitive: false
golden: STUB (structural-only; negative finding, no pure-CPU fixture; see Symptoms / grep terms)
retest_when: never (structural — labels are written once at startup before a user-attachable trap can arm, so the trap cannot fire by construction; juce-binarydata-zip is the permanent replacement)
relates_to: [juce-binarydata-zip]
consumed_in: []
---

# WinDbg trap-after-launch on the editor's label loader: does NOT work

A natural plan for recovering Fractal editor display labels is: launch
the editor under WinDbg, set a write-breakpoint on the symbol-table
buffer (or the string heap region), wait for the editor to populate
labels, inspect the call stack at the trap. This does NOT work for
AM4-Edit and (by extension) JUCE-based AxeEdit binaries.

## Why it fails

The labels are emitted once during startup, before any window-message
loop runs and before a user-attachable WinDbg trap can be armed against
the live process. By the time WinDbg breaks in, the writes are already
complete and the stack frame that performed them has unwound. The
loader site is not re-entered for the lifetime of the editor.

A launch-time trap (start the editor under the debugger) hits a
different problem: JUCE's standard Windows backend resolves the label
buffer through several layers of indirection, and the trap fires inside
a generic memory-copy primitive whose stack-frame is too shallow to
identify the calling label-loader function. See SESSIONS.md
 closing: *"bare-label std::string entries are
written ONCE at AM4-Edit startup and never overwritten. The trap-
after-launch class of approach cannot catch the label loader."*

## What works instead

[[juce-binarydata-zip]]. JUCE embeds the source files for editor
binaries (XML, palette tables, label maps) as a single deflate-
compressed ZIP in a `BinaryData` section. A 5-minute extraction
recovers 1,299 AM4-Edit labels and 10,250 AxeEdit III labels with
zero debugger involvement. The mechanism is documented in
`fractal-midi/docs/capture-guides/juce-binarydata-extraction.md`.

## What this does NOT rule out

- WinDbg as a tool generally. It is fine for *dynamic* state
  (capturing values written during a user action that the editor
  emits more than once, e.g. a fader move). Startup-only labels are
  the specific class that defeats it.
- A *kernel-mode* probe with an earlier attach point. Out of scope
  for this project; JUCE BinaryData is cheaper.

## Symptoms / grep terms

Search these before re-attempting:

- "WinDbg breakpoint label loader" / "trap-after-launch editor labels"
- "labels written once at startup" / "stack frame too shallow memcpy"
- "JUCE BinaryData ZIP" (the working alternative)

## Refinement history

- 2026-05-22 (cookbook backfill): negative finding registered after
   closure. Cited in CLAUDE.md "methods that have
  failed" digest before being demoted to a one-line cookbook pointer.
