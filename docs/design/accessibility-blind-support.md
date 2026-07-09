# Accessibility: making this a real tool for blind musicians

**Status:** research + planning, for discussion. Prompted by a blind Fractal owner
(Reddit, 2026-06-18): *"The fractal editors are accessible with modern screen readers
on Windows and Mac. That doesn't mean they are easy to navigate. Being able to describe
what I want to do would be an actual game changer."*

This is squarely on-mission. The project already exists to let a non-developer control
gear by conversation. A blind guitarist is the user for whom that conversational model
isn't just convenient — it can be the difference between a usable rig and an unusable one.

---

## The core insight: the interface is already the accessibility win

A screen-reader user's problem with the Fractal editors is **spatial navigation** —
hunting a parameter across a grid of blocks, tabs, and dropdowns by ear. Our tool
replaces that with **intent**: *"add a lush hall reverb after the amp and back the mix
off to 20%."* No grid to traverse, no focus to chase. The output is text, which is the
screen reader's native medium.

So we don't need to *build* an accessible UI — Claude Desktop's chat is already a
linear, text-first surface that VoiceOver/NVDA handle well. We need to do two things:

1. **Get the tool installed** without forcing a blind user through the parts of macOS
   that are genuinely hostile to a screen reader (Terminal build steps, the Xcode
   dialog, Gatekeeper "unidentified developer" walls).
2. **Make sure what the tool says back is built for ears**, not eyes (no ASCII grids,
   clear spoken confirmations).

Everything below serves those two.

## Where Mac support stands today (the honest baseline)

- The server **works on macOS** — all three gen-3 hardware confirmations (FM3
  2026-06-12, FM9 + III 2026-06-17) were on macOS. We have **not** explicitly recorded
  whether those Macs were Apple Silicon or Intel (worth asking the contributor; the
  fix below makes it moot).
- The current Mac install (`docs/INSTALL-MAC.md`) is a **source build**: install Node
  from a `.pkg`, run `xcode-select --install` (the C++ toolchain), `git clone`, then
  `npm run setup-mac`. It's deliberately a local compile because that's the only
  *fee-free* path with **zero Gatekeeper friction at runtime** (locally-compiled native
  code is never quarantined). See `docs/_private/MAC-DISTRIBUTION-RESEARCH-2026-06-02.md`.

That trade is right for a sighted tinkerer. **For a blind user it's the wrong trade**:
every step it leans on (Terminal paste-and-pray, the `xcode-select` GUI dialog, reading
build output to know if it failed) is exactly the screen-reader-hostile surface we want
to avoid. The source build should stay as the developer/fallback path, not the front door.

## The front door for a blind Apple Silicon user: the `.mcpb` Desktop Extension

The prior research already identified `.mcpb` (Claude Desktop's one-click extension
format) as the best long-term Mac UX. The accessibility lens makes it the **clear
priority**, because it removes every screen-reader-hostile step at once:

- **Install = one action inside Claude Desktop** (Extensions → Install, or open the
  `.mcpb`). Claude Desktop writes its own config — no editing
  `claude_desktop_config.json`, no Terminal.
- **No Node, no Xcode, no compile.** Claude Desktop ships its own Node runtime; the
  extension bundles the prebuilt native MIDI binary.
- **No Gatekeeper "unidentified developer" wall.** Claude Desktop unpacks the `.mcpb`
  *internally* — the user never launches a standalone unsigned app/binary, which is the
  thing macOS blocks. This sidesteps the entire signing/notarization problem **without
  the $99 Apple Developer fee.**

### What `.mcpb` requires from us (the one real engineering prerequisite)

Swap the native MIDI dependency from **`midi`** (justinlatimer/node-midi — compiles from
source, no prebuilds) to **`@julusian/midi`** (an **API-compatible drop-in** that ships
**N-API prebuilt binaries**, including `darwin-arm64` — confirmed to exist). N-API is
ABI-stable, so the prebuilt loads under Claude Desktop's bundled Node with no
version-exact match.

- **Why it's the enabler:** with prebuilds, there's no compiler step, so the binary can
  ride inside the `.mcpb` (or be fetched by `npm install` without quarantine).
- **Blast radius (from the prior research):** the transport is well-isolated —
  `packages/core/src/midi/*Transport*` plus a few device `midi.ts` re-importers, and the
  `package.json`s that depend on `midi`. Bounded, but it's a native swap, so it needs a
  full `npm run preflight` pass **and a real CoreMIDI SysEx round-trip on Mac hardware**
  before shipping. The maintainer is on Windows, so that validation needs a Mac (a
  contributor's, or a macOS CI runner).

### The FM3 caveat carries over

The FM3 talks over USB-serial (`serialport`), not MIDI. `serialport` also ships N-API
prebuilds, so it fits the same `.mcpb` model — but the FM3's exclusive-port rule (quit
FM3-Edit while Claude talks to it) is an extra thing a blind user must manage. The
class-compliant USB-MIDI devices (III / FM9 / VP4 / AM4 / Hydrasynth) are the cleaner
first target.

## Runtime accessibility: make the answers built for ears

Once installed, the conversation is the product. An audit pass to make tool *output*
screen-reader-friendly:

- **No ASCII-art grids or aligned tables in tool responses.** The gen-3 `live_grid` /
  preset-layout data is the main risk — a 6×14 grid rendered as monospace art is
  meaningless to a screen reader. Return it as **linear prose the model can narrate**
  ("Row 2: drive into amp into cab into reverb; the reverb is bypassed in scene 1"),
  not a diagram. (The model usually narrates anyway, but the underlying data shape and
  any examples in tool descriptions should encourage prose, not tables.)
- **Confirmations that read cleanly aloud.** "Set amp gain to 5.0, confirmed on the
  device" beats a JSON blob. Our write results already carry display values and
  warnings; check they phrase well when spoken.
- **Safety gates speak clearly.** The read-before-write / overwrite warnings are exactly
  the moments a blind user most needs an unambiguous spoken sentence ("This would
  overwrite preset A03, named 'Lead Tone'. Say 'overwrite' to proceed.").
- **Errors are plain language**, already a project value (display-shape errors, not wire
  hex) — confirm that holds for the paths a new user hits first (device not found, port
  busy because an editor is open).

These are low-risk, high-leverage polish items, mostly in tool descriptions and result
phrasing, and they help *every* user, not just screen-reader users.

## Proposed phasing (for discussion, not committed)

1. **Phase 0 — talk to the Reddit user.** He's the perfect design partner and tester.
   Confirm: his Mac (Apple Silicon?), his screen reader (VoiceOver?), his device, and
   whether he'd test an install. Cheapest, highest-value step.
2. **Phase 1 — runtime accessibility audit.** Output/prose/confirmation polish. No native
   work, helps everyone, can ship in a normal patch. Good "we heard you" first delivery.
3. **Phase 2 — the `@julusian/midi` swap.** The native prerequisite. Needs Mac hardware
   validation. Unlocks both prebuilt `npm install` and the `.mcpb`.
4. **Phase 3 — ship a `.mcpb` Desktop Extension.** The real install win. Built on CI,
   validated on a Mac. Becomes the front-door Mac install; source build stays as fallback.
5. **Phase 4 — accessible install guide**, written and tested *with* a screen reader,
   covering the `.mcpb` flow end to end.

## Open questions to decide together

1. **Priority vs the gen-3 unlocks.** This is mission-level. Do we put it ahead of the
   discrete-set-by-name confirmations and the synced-cache asks?
2. **The `@julusian/midi` swap** is the linchpin and needs Mac validation we can't do on
   Windows. Use the Reddit user / chihotta as the Mac validator, or stand up a macOS CI
   runner?
3. **`.mcpb` scope.** Ship MIDI-class devices first (III/FM9/VP4/AM4/Hydrasynth) and add
   the FM3 serial path later, or do both at once?
4. **How far on runtime polish now?** A quick `live_grid`-to-prose pass plus confirmation
   wording, or a fuller audit of every tool's spoken output?
5. **Do we want a blind beta tester loop** as a standing thing (like the device owners),
   and how do we credit/support it?

## Related

- `docs/INSTALL-MAC.md` — current source-build Mac install (keep as fallback).
- `docs/_private/MAC-DISTRIBUTION-RESEARCH-2026-06-02.md` — the distribution research this
  builds on (Gatekeeper, `.mcpb`, `@julusian/midi`, the $99 boundary).
- `docs/SAFETY-FOR-MUSICIANS.md` — the safety gates whose spoken phrasing matters most.
