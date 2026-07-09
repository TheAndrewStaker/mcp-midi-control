# MCP MIDI Control: Project Vision

## One-Line Pitch
An open-source MCP server with strict, opinionated rules for controlling
music gear by conversation, applied the same way on every device. You say
what you want in plain language; the server speaks SysEx, NRPN, and CC to
the hardware over USB and reads it back to confirm. The same instruction
and the same guarantees behave the same whether you are talking to a
guitar modeler or a synth.

## The Opinions (universal, every device)
This is not a control tool for one brand. It is a set of rules that hold
on every device the server touches, present and future:

- **Display-first.** You pass and read the values on the front panel (a
  0 to 10 knob, dB, ms, a ratio, an enum name like `'Plexi 100W High'`),
  never raw wire bytes or internal indices. Error messages are phrased in
  those same front-panel units.
- **No silent saves.** The server never persists a change unless you used
  explicit save-intent language.
- **No silent edit loss.** It will not navigate away from an edited buffer
  without telling you and getting your call on whether to keep or discard.
- **No silent overwrites.** Before writing over a stored location it reads
  the current contents and surfaces what would be lost.
- **Every write is acknowledged.** The server waits for the device to
  confirm a write before reporting success.
- **Tempo-first.** When the device supports it, time-based settings prefer
  syncing to the song tempo, so a dotted-eighth delay stays a
  dotted-eighth delay.
- **Read before write.** Every tool that mutates state gates behind a
  fingerprint read first.

## Consistency is the core value
Consistency across devices is the point, not a side effect. The rules
above are not re-litigated per device. A musician who learns the behavior
on a guitar modeler gets the identical contract on a synth: same words,
same safety, same responses. Synths are first-class, not an
afterthought. Adding a device is a descriptor, not a new set of tools, so
the surface a user learns once stays the surface.

## What runs today

### Any USB MIDI device, now
Generic-MIDI primitives (CC, NRPN, SysEx, program change, notes, clock)
reach any USB MIDI device the operating system exposes. A Line 6 Helix, a
Boss GT-1000, or any synth with a CC chart works from day one through
these primitives, under the same opinions.

### First-class, hardware-verified depth
A few devices get deeper support: whole-preset and whole-patch authoring,
real-gear lineage data, and cross-device tone translation, all verified
against real hardware captures. That tier today is:

- **Fractal AM4** (floor unit; deepest reverse-engineering,
  hardware-verified end to end)
- **Fractal Axe-Fx II XL+**
- **ASM Hydrasynth Explorer**
- **Modern Fractal family — Axe-Fx III / FM3 / FM9 / VP4** in community beta (one shared gen-3 codec, per-device catalogs)
- **Fractal Axe-Fx Standard/Ultra (gen-1)** in community beta (parameter set + read, decoded from the published gen-1 SysEx spec)
- **Novation Circuit Tracks** in community beta (groove + melody sequencing, sample / project upload, sequencing of outboard gear)
- **Roland SPD-SX** in community beta (kit + sample authoring over USB mass storage; pad triggering + kit recall over MIDI)
- **Boss VE-500 Vocal Performer** in community beta (parameter set + read, decoded byte-exact from the manufacturer's editor source)

These are named second on purpose. They are the current depth frontier,
not the identity of the project.

## What this gives you that a vendor editor doesn't
A vendor editor (AxeEdit and similar) is the right tool when you want to
see every knob at once and click your way to a tone you can already
picture. This MCP server is the right tool when:

- **You want to describe the tone, not build it knob-by-knob.** An
  Edge-style dotted-eighth lead with Plexi grit lands a calibrated
  starting point in one chat turn instead of a long panel session.
- **You want lineage data informing the build.** `lookup_lineage` knows
  which modeled amp tracks which real amp, the per-amp master sweet spot,
  the per-drive boost in dB, and the iconic-tone cluster a model lives in.
  Vendor editors ship none of that.
- **You want to translate a tone to a different device.** The agent reads
  one device's preset, walks block roles, param-name aliases
  (`drive.volume` vs `drive.level`), enum mappings (USA IIC+ vs USA MK
  IIC+), and scene or channel cardinality (AM4 4x4 vs II 8x2 vs III 8x4),
  then applies to the target via `apply_preset`. One conversation, no
  manual re-authoring.
- **You want to build an expressive synth voice by describing it.** On the
  Hydrasynth you wire the mod matrix and the macros by name ("LFO 1 to
  filter cutoff", "macro 2 controls reverb mix") instead of hunting matrix
  slots, and you start from named recipes (Prophet-5 pad, Juno-106 pad,
  OB-Xa brass) via `apply_patch` rather than the INIT patch. Recipes are a
  starting point you refine in plain language, not a fixed preset. The
  same `recipe_id` mechanism backs `apply_preset` on the guitar side.

The unifying story: a vendor editor is the editor's-eye view; this is the
player's-ear language under one consistent set of rules. Both have a place.

## The problem
Building presets on a hardware amp modeler or synth requires deep
technical knowledge of parameter names, signal chains, and effect types.
Even experienced players spend hours dialing in a tone that could be
described in one sentence. Sharing presets across players is fragmented
and format-locked. And every editor invents its own conventions, so what
you learn on one device does not carry to the next.

## The solution
A local MCP server that bridges an MCP host (Claude Desktop today) and the
user's hardware over USB MIDI. The user describes what they want in plain
language. The server translates that into precise SysEx, CC, and NRPN
commands and sends them directly to the device, with no vendor editor
required, under the universal opinions above.

---

## Core User Experience

```
User: "Give me a preset for Amber by 311 (4 scenes, verse through solo)"

Claude: Researches the verified gear for that recording era, maps each
        block to AM4 equivalents, builds 4 scenes, confirms target
        locations are safe to write, sends to device.

Device: Preset appears on AM4. User plays it immediately.

User: "The filter is too quacky on the verse"

Claude: Reduces Filter sensitivity, re-sends, asks how it sounds now.
```

---

## Target User
- Musicians who own at least one USB MIDI device. Any MIDI device works
  through generic-MIDI primitives; the first-class depth tier today is the
  Fractal AM4, Axe-Fx II XL+, and Hydrasynth Explorer (hardware-verified), with
  the modern Fractal family (Axe-Fx III / FM3 / FM9 / VP4), the original Axe-Fx
  Standard/Ultra, the Novation Circuit Tracks, the Roland SPD-SX, and the Boss
  VE-500 in community beta.
- Comfortable with an MCP host such as Claude Desktop (free tier
  acceptable).
- Want authentic tones without deep technical knowledge.
- Perform live and need organized preset libraries.

## What it is not
- Not a visual preset editor, and not a vendor-editor replacement.
- Not a single-brand control tool.
- Not cloud-hosted; runs entirely local.
- Not a subscription service.
- Not closed-source. Apache-2.0.

---

## Success Criteria
1. Can send a complete preset to AM4 without a vendor editor open
   (shipping).
2. Claude can describe a famous tone and produce a working preset
   (shipping).
3. Iterative refinement loop works ("more gain", "darker reverb")
   (shipping).
4. Stored locations are never silently overwritten; the
   save-authorization gate is enforced uniformly across devices (shipping;
   see [`docs/SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md)).
5. The same UX and the same guarantees work across multiple devices via
   the unified tool surface (shipping: AM4, Axe-Fx II XL+, Hydrasynth
   Explorer; Axe-Fx III / FM3 / FM9 and the gen-1 Axe-Fx Standard/Ultra in
   community beta). See
   [`docs/TOOLS.md`](TOOLS.md) for the full tool list.

---

## Technology Stack
- **Runtime:** Node.js / TypeScript
- **MCP Framework:** @modelcontextprotocol/sdk, MCP specification revision
  2025-11-25
- **MIDI/USB:** @julusian/midi (npm; API-compatible node-midi fork with N-API prebuilds)
- **Protocol:** device SysEx, NRPN, and CC over USB MIDI
- **Host:** an MCP host such as Claude Desktop via the MCP connector
- **Future host mode:** Claude API (anthropic SDK) for standalone mode

The tool surface is four families: a unified, device-agnostic surface for
tone building, voice-class patch authoring for synths, generic-MIDI
primitives that reach any device, and transport utilities.

---

## Roadmap

### Feasibility (done)
Proved a USB MIDI SysEx round-trip with the AM4 without a vendor editor.
Early probe work confirmed the AM4 follows the published Axe-Fx III
third-party MIDI specification with AM4-specific extensions.

### Protocol layer (done)
Decoded the editor-write surface by puppeting the device, with no
preset-binary reverse-engineering required. The AM4 and Axe-Fx II XL+ wire
layers ship with byte-exact goldens against real captures.

### MCP server (done)
Wired the protocol layer to MCP tools. Tone-from-description works end to
end on the AM4 and Axe-Fx II.

### Preset intelligence (done)
Lineage data for amps, drives, cabs, delays, and reverbs. `lookup_lineage`
surfaces real-hardware inspiration and manufacturer-authored quotes.
Iterative refinement via single-param edits in the working buffer.

### Synth voice authoring (done)
Voice-class patch authoring on the Hydrasynth: oscillators, filter,
envelopes, mod matrix wired by name, macros routed by name, and named
voice recipes applied via `apply_patch`. The synth contract matches the
guitar contract: same opinions, same response format, `recipe_id` on both
`apply_preset` and `apply_patch`.

### Multi-device and library management (in progress)
- Unified tool surface live across registered devices, plus voice-class
  patch authoring, mod-matrix and macro routing by name, generic-MIDI
  primitives, and transport utilities. Four families in all; see
  [`docs/TOOLS.md`](TOOLS.md) for the list.
- Save-authorization, dirty-buffer, and multi-preset overwrite gates
  enforced uniformly (see [`SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md)).
- Setlist authoring for AM4 and Axe-Fx II.
- Workspace monorepo split into one package per device, with the wire
  codec factored out into a standalone `fractal-midi` package.

### Community devices and distribution (next)
- Take the Axe-Fx III from community beta, through community-captured wire
  decodes, to write parity with the AM4 and Axe-Fx II.
- Add more popular gear: Line 6 Helix and other amp modelers, plus more
  instruments and synthesizers. Adding a device is a descriptor, not a new
  set of tools, so contributors can land a device without touching the
  tool surface. Contributions are open.
- The `fractal-midi` codec is already a standalone package; an equivalent
  synth-side codec split follows as that side of the catalog grows.
