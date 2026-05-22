# MCP MIDI Control: Project Vision

## One-Line Pitch
Conversational, lineage-aware preset building for Fractal. Talk to Claude
the way you'd describe a tone to another player, and the right SysEx /
NRPN / CC lands on your gear (AM4, Axe-Fx II XL+, Axe-Fx III community
beta, ASM Hydrasynth Explorer, plus any USB MIDI device for generic
primitives).

## What this gives you that AxeEdit doesn't
AxeEdit is the right tool when you want to see every knob at once and
click your way to a tone you can already picture. This MCP server is the
right tool when:

- **You want to describe the tone, not build it knob-by-knob.** "Edge-
  style dotted-eighth lead with Plexi grit" lands a calibrated starting
  point in one chat turn instead of a 20-minute panel session.
- **You want lineage data informing the build.** `lookup_lineage` knows
  which Fractal amp models which real amp, the per-amp master sweet-
  spot, the per-drive boost dB, the iconic-tone cluster a model lives
  in. AxeEdit ships none of that.
- **You want to translate a tone to a different device.** `translate_preset`
  walks block roles, param-name aliases (drive.volume vs drive.level),
  enum mappings (USA IIC+ vs USA MK IIC+), and scene/channel cardinality
  (AM4 4x4 vs II 8x2 vs III 8x4). One chat turn, no manual re-authoring.
- **You want one-shot setlist builds.** `apply_setlist` runs a batch
  switch + apply + save across N locations from one chat turn.

The unifying product story: AxeEdit is for the editor's-eye-view; this
is for the player's-ear-language. Both have a place.

## The Problem (sub-version: tone description vs tone authoring)
Building presets on a hardware amp modeler or synth requires deep technical
knowledge of parameter names, signal chains, and effect types. Even experienced
players spend hours dialing in a tone that could be described in one sentence.
Sharing presets across players is fragmented and format-locked.

## The Solution
A local MCP server that bridges Claude Desktop and the user's hardware over
USB/MIDI. The user describes what they want in plain language. Claude
translates that into precise SysEx / CC / NRPN commands and sends them
directly to the device, with no vendor editor required. AM4 is the headline
device (deepest RE, hardware-verified end-to-end); additional Fractal and
ASM devices ship in the same release.

---

## Core User Experience

```
User: "Give me a preset for Amber by 311 (4 scenes, verse through solo)"

Claude: Researches Tim Mahoney's verified gear for that recording era,
        maps each block to AM4 equivalents, builds 4 scenes, confirms
        target slots are safe to write, sends to device.

Device: Preset appears on AM4. User plays it immediately.

User: "The filter is too quacky on the verse"

Claude: Reduces Filter sensitivity, re-sends, asks how it sounds now.
```

---

## Target User
- Musicians who own at least one supported USB MIDI device (Fractal AM4 is
  the headline; Axe-Fx II XL+, Axe-Fx III, Hydrasynth Explorer also supported;
  any MIDI device works through generic-MIDI primitives).
- Comfortable with Claude Desktop (free tier acceptable)
- Want authentic tones without deep technical knowledge
- Perform live and need organized preset libraries

## What It Is Not
- Not a visual preset editor (vendor-editor replacement)
- Not cloud-hosted; runs entirely local
- Not a subscription service
- Not closed-source. Apache-2.0.

---

## Success Criteria
1. Can send a complete preset to AM4 without AM4-Edit open (shipping)
2. Claude can describe a famous tone and produce a working preset (shipping)
3. Iterative refinement loop works ("more gain", "darker reverb") (shipping)
4. Preset slots are never silently overwritten; save-authorization gate
   enforced uniformly across devices (shipping; see
   [`docs/SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md))
5. Same UX works across multiple devices via the unified 17-tool surface
   (shipping: AM4, Axe-Fx II XL+, Hydrasynth Explorer; Axe-Fx III in
   community beta)

---

## Technology Stack
- **Runtime:** Node.js / TypeScript
- **MCP Framework:** @modelcontextprotocol/sdk
- **MIDI/USB:** node-midi (npm)
- **Protocol:** Fractal Audio SysEx over USB-MIDI
- **AI:** Claude Desktop (claude.ai) via MCP connector
- **Future AI:** Claude API (anthropic SDK) for standalone mode

---

## Phased Roadmap

### Phase 0: Feasibility (complete, 2026-04-14)
Proved USB/MIDI SysEx round-trip with AM4 without AM4-Edit. Session 02
confirmed AM4 follows the Axe-Fx III published 3rd-party MIDI spec with
AM4-specific extensions.

### Phase 1: Protocol Layer (complete)
Decoded the editor-write surface via the puppet-the-device approach
(per [`_private/DECISIONS.md`](_private/DECISIONS.md) 2026-04-14), with no preset-binary RE
required. AM4 + Axe-Fx II XL+ wire layers ship with byte-exact goldens
against real captures.

### Phase 2: MCP Server MVP (complete)
Wired protocol layer to MCP tools. Tone-from-description works end to
end on AM4 and Axe-Fx II.

### Phase 3: Preset Intelligence (complete)
Lineage data for amps/drives/cabs/delays/reverbs across Fractal devices.
`lookup_lineage` tool surfaces real-hardware inspiration and Fractal-
authored quotes. Iterative refinement via single-param edits in the
working buffer.

### Phase 4: Multi-device + Library Management (in progress)
- Unified 17-tool surface live across registered devices.
- Save-authorization + dirty-buffer + multi-preset overwrite gates
  enforced uniformly (see [`SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md)).
- Setlist authoring shipping for AM4 + Axe-Fx II.
- Workspace monorepo split (2026-05-04), one package per device.

### Phase 5: Polish, Distribution, Community Devices (next)
- Axe-Fx III community beta to community-captured wire decodes to write
  parity with AM4/II.
- FM9 / FM3 / VP4, Roland/Boss family, more synths. See
  [`MULTI-DEVICE-ROADMAP.md`](MULTI-DEVICE-ROADMAP.md) for the device
  target order and the planned `fractal-midi` / `asm-midi` vendor-
  protocol-package extraction.
