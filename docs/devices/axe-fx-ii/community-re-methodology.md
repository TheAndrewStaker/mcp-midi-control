# Axe-Fx II Community RE — Methodology, Corpus, and Our Place In It

How earlier third-party developers reverse-engineered the Fractal
Audio MIDI SysEx protocol — the capture techniques, the open-source
artefacts, the gaps still in the public corpus, and what
`mcp-midi-control` does that pushes the state of the art forward.

This is a snapshot of the public landscape as of 2026-05. Useful for
new contributors who want to know where existing community knowledge
ends and where original RE begins on this project.

---

## The non-open landscape (for context)

A closed-source third-party power-user utility exists for the
Fractal product family — manages presets and cabs, converts between
device variants (FM3 / Axe-Fx II / XL / XL+ / AX8 / Axe-Fx III /
FM9), exports CSV / XML, and ships a built-in SysEx sniffer.
Distribution is donationware; the protocol decoding is kept private
as a commercial moat. We can compare against its UI behavior and
exported CSVs but cannot inspect its protocol RE directly.

Forum thread (development context): [#112538 — for power users
only](https://forum.fractalaudio.com/threads/fractool-for-power-users-only.112538/).

Separately, **[Fractal-Bot](https://www.fractalaudio.com/fractal-bot/)**
is Fractal Audio's *official* Mac/Win utility for firmware updates
and preset/bank transfers. Closed-source first-party software, not a
reverse-engineering project. Any time community guides reference
"Fracbot," that's the tool they mean.

The relevant *open-source* comparison set for this project is below.

---

## Open-source community libraries — detailed scan

The three projects whose source we've inspected and what they cover.
The scan dates are 2026-05-10; refresh if a meaningful update lands.

### `bspaulding/axe-fx-midi` — read/navigate, Rust, MIT

- **Repository:** https://github.com/bspaulding/axe-fx-midi
- **License:** MIT — **compatible with our Apache-2.0**. We can port
  code with attribution.
- **Language / runtime:** Rust crate. Hand-port required to land in
  our TypeScript codebase (no direct dependency proposed).
- **Last meaningful commit:** 2020-07-05 ("Restored readme"). 57
  commits, 0 stars, 1 fork. **Effectively abandoned ~6 years.**
- **Device scope:** Family-wide via a `FractalModel` enum. Model
  bytes encoded: `Standard 0x00`, `Axe-Fx II 0x03`, `Axe-Fx III 0x10`.
  ⚠️ **Note:** their `Axe-Fx II = 0x03` is the original-revision model
  byte; the **Axe-Fx II XL+ uses `0x07`** (this project's Session 53
  cont, confirmed against the factory `.syx` bank). A direct lift
  would inherit this bug for XL+ owners — see "Why we still need our
  own goldens" below.
- **Function IDs implemented (read-heavy):** `0x01` get block params,
  `0x08` firmware, `0x09`/`0x28` set preset name, `0x0C`/`0x29` set
  scene number, `0x0D` get preset name, `0x0E` scene name / preset-
  blocks-flags, `0x0F` looper, `0x11` tuner toggle, `0x13` status
  dump, `0x14` get preset number, `0x17` MIDI channel, `0x1D` store-
  in-preset, **`0x20` GET grid layout/routing**, `0x3C` set preset
  number, `0x42` disconnect.
- **What it lacks (same as our gap list):** **No SET_PARAM (no
  `0x02`).** No grid-layout *write*. No block add/remove. Read-and-
  navigate only. **The editor-write surface starts where this library
  ends.**
- **Code structure:** 2 files — `src/lib.rs` (message builders +
  `wrap_msg` envelope helper) + `src/parse.rs` (response parser +
  enums). Free functions, no classes. Tests live inline as
  `#[cfg(test)] mod tests`; **no byte-exact wire-capture goldens**.

### `tysonlt/AxeFxControl` — read/navigate, Arduino C++, GPL-3.0

- **Repository:** https://github.com/tysonlt/AxeFxControl
- **License:** **GPL-3.0 — INCOMPATIBLE with Apache-2.0.** Read-only
  for reference. **Do not lift any code into our codebase**, not
  even snippets. Cross-reference for opcode confirmation only.
- **Language / runtime:** Arduino C++ library. `library.properties`
  marks it Arduino-IDE installable. Targets microcontroller memory
  (1,216 B program / 137 B RAM). NOT a host/PC library.
- **Last commit:** 2023-10-13 (v1.4). 214 commits, 33 stars.
  Actively maintained-ish.
- **Device scope:** Axe-Fx III primary + FM3 constructor. Author
  explicitly excludes the Axe-Fx II ("don't have a unit"). Model
  bytes: `AXEFX3 = 0x10`, `FM3 = 0x11`. ✓ Matches our expected III
  model byte.
- **Function IDs implemented:** `0x08` firmware, `0x0A` effect-bypass
  req, `0x0B` effect-channel req, `0x0C` scene number, `0x0D` preset
  info, `0x0E` scene info, `0x0F` looper status, `0x10` tap-tempo
  pulse, `0x11` tuner, `0x13` effect dump, `0x14` tempo. Effect
  enable/bypass payload markers `0x00`/`0x01`.
- **What it lacks:** Same gap as bspaulding. **No `0x02` SET_PARAM**,
  no `0x20` grid layout, no `0x1D` store-to-location, no block
  add/remove. Read-and-navigate only.
- **Code structure:** Public surface in `src/AxeFxControl.h` +
  `src/interface/{AxeSystem,AxeEffect,AxePreset,AxeLooper}.h`; impl
  hidden under `src/interface/private/` (15 files split by concern —
  `_Commands.cpp` builds outgoing, `_Handlers.cpp` parses incoming,
  `_Midi.cpp` does I/O, `_Callbacks.cpp` registers user hooks).
  Class-based stateful API. **No byte-exact wire captures**; example
  `.ino` sketches act as smoke tests.

### `laxu/AxeFx2VirtualPedalboard` — Axe-Fx II SET_PARAM, TypeScript, MIT

- **Repository:** https://github.com/laxu/AxeFx2VirtualPedalboard
- **License:** MIT — compatible with our Apache-2.0.
- **Language / runtime:** TypeScript browser app (WebMIDI API).
- **Activity:** 329 commits; the project itself is performance-time
  CC → SET_PARAM translation, not a protocol library, but the wire
  encoder is the load-bearing piece.
- **Device scope:** Axe-Fx II family with **runtime model-byte
  discovery** — probes the firmware-version response to pick from a
  full `MODEL_IDS` map (`II = 0x03, XL = 0x06, XL+ = 0x07,
  AX8 = 0x08`). This is more robust than bspaulding's single hard-
  coded `0x03`. Our project defaults to `0x07` (XL+) per founder's
  hardware; laxu's runtime-probe approach is an architecture worth
  borrowing if we ever support multiple II revisions concurrently.
- **Function IDs implemented:**
  - `0x02` SET_BLOCK_PARAMETER_VALUE — **this is the prior art**.
    laxu is the only open-source library that publicly implements
    SET_PARAM for any Fractal device. Performance use case only
    (writes params on already-placed blocks via CC mapping).
  - `0x02` GET, paramId=255 bypass, `0x29` scene number.
- **What it lacks (same corpus-wide gap):** grid-layout WRITE,
  block add/remove, store-to-location, scene-to-channel writes.
- **Code structure:** Encoder split across `src/api/constants.ts`
  (function IDs + model map), `src/api/axefx.ts` (the `AxeFx` class
  with `setBlockParamValue` / `getBlockParamValue` / `setBlockBypass`
  / checksum), `src/util/util.ts` (`intTo2Byte`,
  `parameterValueIntToBytes`). WebMIDI's `sendSysex(HEADER, body)`
  wraps `F0` / `F7` for the runtime, so their arrays don't include
  the framing bytes.
- **Tests:** No byte-exact wire-capture goldens. Functional WebMIDI
  round-trip testing only.

**Prior-art credit:** laxu/AxeFx2VirtualPedalboard precedes this
project for **Axe-Fx II SET_BLOCK_PARAMETER_VALUE specifically**.
Performance use case (live CC → param mapping), not editor use case
(building a tone from scratch), but the wire encoder is the same.
We credit them as the first open-source implementation of that
function on that device. Everything beyond — grid-write, block
add/remove, store-to-location, scene/channel writes on any Fractal
device, and *all* editor-write functions on Axe-Fx III / FM3 / FM9
— remains genuinely new ground in the open corpus.

### Cross-validation result (2026-05-10)

We ran a byte-by-byte comparison between laxu's SET_PARAM encoder
and ours. **Two independent TypeScript implementations of the wiki
spec agree on every byte position, every mask, the checksum
algorithm, the model-byte map, and the scene-query sentinel.**
Concrete byte vector for a sample call (Amp 1 input drive set to
32767 on an XL+):

```
F0 00 01 74 07 02 6A 00 01 00 7F 7F 01 01 <cs> F7
```

Reconstructed from laxu's code = byte-identical to ours = matches
the wiki worked example. This gives us **three independent sources
of truth** before HW-075's hardware test: the wiki spec, laxu's
encoder, our `verify-axe-fx-ii-encoding.ts` goldens. HW-075 then
landed the fourth — the device actually responded to the bytes our
encoder produced.

Two minor differences worth noting (neither affects wire output for
valid input):

- **laxu masks the third value-septet with `0x7F`; we mask with
  `0x03`.** For valid 16-bit inputs (0..65534), only the low 2 bits
  of the third septet can ever be non-zero, so both produce
  identical bytes. We additionally throw on out-of-range; laxu
  silently masks. Architectural difference; behavioural equivalence.
- **laxu's display→wire conversion sits one layer above the
  encoder.** They pre-multiply `display × 6553.4` before calling
  the encoder; we do the same in `src/server/shared/paramHelpers.ts`
  before calling our encoder. Same architecture, different file
  layout.

### The shared gap

**Every open-source library targets the read-and-navigate surface;
none implements the editor-write surface.** That includes SET_PARAM
(the canonical "change a knob" call), grid-layout writes (move a
block, draw a cable), block add/remove, and store-to-location. The
public corpus literally stops where editor-control begins. Every
existing library lets you read state and switch presets/scenes;
none lets you shape a tone from scratch.

This validates the work this project is targeting: the editor-write
surface is the genuine gap in the community RE corpus, and closing
it is net-new contribution back to the public knowledge base.

### Why the gap exists — Fractal actively gates editor traffic

The public corpus doesn't stop at the read-and-navigate surface by
accident. Hands-on testing confirmed that **both Fractal editors —
AxeEdit for the Axe-Fx II family and AM4-Edit for the AM4 — gate
class-compliant virtual MIDI ports out of their port enumeration**.
Virtual MIDI ports do not appear in either editor's Preferences →
Ports dropdown, even when the virtual port name exactly matches the
real device port name.

The diagnostic detail that pins this down: AxeEdit's port dropdown
*does* show `Microsoft GS Wavetable Synth`, a Windows built-in
software MIDI port. So the filter isn't "real hardware only" — it's
specifically excluding virtual-driver-class entries via the Windows
MIDI driver-class metadata returned by `midiInGetDevCaps` /
`midiOutGetDevCaps`. Two independent Fractal editors carrying the
same filter posture, with the same allowlist behavior, is not
coincidence.

This sharpens the project's framing materially. **The editor-write
surface isn't just undocumented — it's actively gated.** Fractal
has deliberately engineered both editors to make third-party
traffic-sniffing harder. The wiki MIDI_SysEx spec stopping at the
controller-class surface is the same posture documented at the
protocol-disclosure level: Fractal's founder has declined on-forum
(thread 219120) to commit to publishing an editor SDK; the
closed-source third-party editor's author has publicly cited legal
risk as the reason for keeping their decoded protocol private; the
wiki documents READ functions generously and SET / STORE functions
minimally.

That posture also explains why open-source hobby projects stop
where they do. Pushing past the gate to the editor-write surface
is expensive enough — both technically (needs driver-level
workarounds for the sniffer side) and politically (the legal-risk
posture) — that unpaid single-developer work doesn't follow through.
**A project with a coordinated hardware-validation contributor
workflow** (this project's BK-048) **can amortize that cost across
many contributors and accumulate decodes the hobby corpus couldn't
justify.** That's the structural edge.

Practical implication for our own RE work: capture-driven decoding
needs a driver-level workaround, or modifying our `scripts/sniff.ts`
to register a Fractal-imitating MIDI driver (significantly more
work). The fallback path is capture-free protocol RE — probe
candidate function IDs via our own `send_sysex` tool and observe
the device's response — which is slower but doesn't depend on
intercepting AxeEdit at all.

### The simpler-than-expected workaround we found (2026-05-11)

After ruling out virtual-MIDI-bridge approaches (gated by AxeEdit's
port filter, see above), we discovered a much simpler approach for
HALF the conversation:

**Windows MIDI input ports are shared-readable.** Our script can
open `AXE-FX II MIDI In` while AxeEdit is also reading it; both see
the same byte stream from the device. No virtual driver needed for
this direction.

The tradeoff: we capture **device → host** traffic only — every
SysEx the device sends back in response to AxeEdit's queries,
broadcasts, state announcements. The other direction (AxeEdit's
outgoing commands) still needs a bridge.

But for protocol RE, the device-side bytes are the half that carries
the wire format we want to decode. AxeEdit's outgoing query bytes
mostly mirror what our own encoder produces (we can compare against
our `verify-axe-fx-ii-encoding.ts` goldens). The device's responses
are the new information.

First passive-capture session 2026-05-11 yielded **~25 distinct
function bytes**, of which ~15 were undocumented in any public
corpus. Highlights:

- Function `0x01` appearing only during AxeEdit writes — matches
  AM4's EDITOR_STREAM, likely the editor-write protocol family.
- Functions `0x74/0x75/0x76` triple appearing only during writes —
  matches AM4's `0x77/0x78/0x79` preset-dump header/chunk/footer,
  likely Axe-Fx II's store-to-location wire format.
- Functions `0x12` (~1200 messages per capture) and `0x15` (~768) —
  high-frequency periodic broadcasts revealing the device's state
  model.

See `scripts/capture-midi-passive.ts` for the implementation, and
`CONTRIBUTING.md` for the workflow contributors can use against
their own Fractal hardware.

### Why we still need our own goldens — across-source consistency

The library landscape encodes the same spec with subtle variations
in how thorough the constant tables are:

- **bspaulding** hardcodes `AxeFxII = 0x03` only. Correct for the
  original Axe-Fx II, wrong for any other revision in the family
  (XL = 0x06, XL+ = 0x07, AX8 = 0x08).
- **laxu** ships the **full `MODEL_IDS` map** and probes the
  device's firmware-version response at runtime to pick which byte
  to use. Most robust approach in the corpus.
- **Our project** defaults to `0x07` (XL+) explicitly because
  that's the founder's hardware. We could borrow laxu's runtime-
  probe architecture if/when we add multi-revision support.

This is one of the things our verify-msg discipline catches: per-
firmware byte-exact goldens captured against a real device pin down
exactly which revision a given golden corresponds to. No existing
open-source library carries this discipline (laxu and bspaulding
both rely on functional / runtime validation). Our infrastructure
turns revision and firmware-version drift into a CI signal rather
than a silent runtime mismatch — which is the BK-048 contributor
workflow's foundation.

---

## Capture techniques used across the corpus

### Virtual MIDI driver bridges (historical community workaround)

Older forum guides documented sitting a class-compliant virtual MIDI
port between the editor and the device to capture traffic in transit.
This project **does not use that approach** — both AxeEdit and
AM4-Edit gate class-compliant virtual drivers out of their port
enumeration via the Windows `midiInGetDevCaps` / `midiOutGetDevCaps`
class metadata, so the bridge never sees outgoing editor traffic.
Documented here only to explain why other community projects took
that route historically.

### Passive shared-read of the device's MIDI-In port (this project's primary)

Windows MIDI input ports are shared-readable. Our capture script
opens the device's `... MIDI In` port while the vendor editor is
also reading it; both see the same byte stream from the device.
Captures every SysEx the device emits (responses, broadcasts, state
announcements) with no virtual driver, no bridge, no editor
interception. Implementation: `scripts/capture-midi-passive.ts`.

### USBPcap + Wireshark (this project's editor → device path)

For the editor-write direction (what AxeEdit / AM4-Edit / Hydrasynth
Manager *send* to the device), capture at the USB-class layer with
USBPcap + Wireshark. Both directions are visible at this layer, and
class-compliant USB-MIDI frames decode cleanly in Wireshark. The
maintainer's default workflow for any unknown editor-write op. See
`CONTRIBUTING.md` for the step-by-step.

Historical note: the older `USBPcap on Axe-Fx II XL+ (Quantum 8.02)`
attempt failed because the Windows driver of that era routed above
the USB-class layer; later firmware revisions and III / FM9 do not
share that limitation.

### MIDI Monitor / Snoize (macOS)

[MIDI Monitor by Snoize](https://www.snoize.com/MIDIMonitor/) is the
macOS equivalent for passive byte-level inspection. Equivalent role
to the passive-capture script above; macOS contributors can use
either.

### Direct `.syx` binary analysis

Used when capture isn't viable — analyse exported preset files
directly. Forum thread ["Axe-Fx III and deconstructing/parsing a
.syx (159885)"](https://forum.fractalaudio.com/threads/axe-fx-iii-and-deconstructing-parsing-a-syx-sysex-preset-file.159885/)
is the long-running thread on this approach. We use it ourselves for
the Axe-Fx II XL+ factory bank exports
(`samples/factory/Axe-Fx-II_XL+_Bank-{A,B,C}_Q8p02.syx`).

### Fractal-published 3rd-party MIDI spec

Available for Axe-Fx III, FM3, FM9. NOT available for Axe-Fx II
generation. III / FM9 tools rely heavily on this and skip sniffing;
II / XL+ tools must sniff.

---

## What the public corpus has NOT cracked for Axe-Fx II

Forum thread ["Reverse engineer undocumented sysex? (201663)"](https://forum.fractalaudio.com/threads/reverse-engineer-undocumented-sysex.201663/)
confirms the community accepts these gaps and that firmware drift
will eventually break unofficial decodes.

| Decode | Public status |
|---|---|
| Grid-layout WRITE (routing changes) | Wiki documents only the read side (function `0x20`); the write function ID is not in the public corpus. |
| Block add / remove from chain | Not in public corpus. |
| Preset save / store-to-location (II/XL/XL+) | Wiki documents preset DUMP and edit-buffer GET; the store-to-location function shape is not public. |
| Scene → per-block channel assignment WRITES | Not in public corpus. |

These are the targets that fresh capture work on the Axe-Fx II XL+
can contribute back to the broader community knowledge base.

---

## What this project does that pushes the corpus forward

The community-standard methodology — virtual-MIDI-bridge captures,
audible verification, hand-curated wire format docs — has carried the
public corpus from "no documentation" to "wiki-documented for a
Fractal-defined subset". Where we improve on it (and where we
diverge — passive shared-read + USBPcap instead of the
historically-gated bridge approach):

### Byte-exact golden test harness

`mcp-midi-control` runs three goldens on every preflight:

- **`verify-pack`** — packed-float pack/unpack round-trip (10 amp
  gain / EQ samples).
- **`verify-msg`** — built messages vs. captured wire bytes, byte-
  exact including checksum. Every new pidHigh that's added to a
  device's `params.ts` must have a matching case here built from
  capture-derived bytes.
- **`verify-transpile`** — IR → command sequence goldens.

Plus per-device verifiers (`verify-axe-fx-ii-encoding`,
`hydra:verify-encoding`, …) — all byte-exact.

**No other Axe-Fx-family RE project we surveyed does byte-exact
golden testing against captured wire bytes.** They build encoders
from spec and trust the spec. Our pattern means a wire-encoding
regression — including one introduced by a future firmware drift —
fails preflight mechanically, not in production after the user hears
a tone that doesn't match.

Doing this on the Axe-Fx II for every new decode means we'd be the
only RE project that can **detect firmware drift mechanically**. As
firmware updates ship and the wire format quietly shifts (Cygnus-
style amp model overhauls, new block IDs, renumbered paramIds), our
goldens flag the divergence the moment a contributor regenerates
from capture against a new firmware. The community accepts firmware
drift as a fact; this project intends to detect and respond to it as
a build-system event.

### Hardware-verified contribution workflow (target)

A future ambition (see `CONTRIBUTING.md` and the backlog for the
formal proposal): every new device support PR carries the wire
captures that produced its goldens. Reviewers and CI can verify the
captures came from a real device session; firmware fingerprints from
the captures provide an audit trail. This raises the bar above
"contributor says it works on their device" to "the bytes in the
golden test demonstrably came from a real device of the named
firmware version." No existing community RE project, open or
closed-source, asks for this kind of evidence today.

### Conversational verification discipline

Read-then-write relative-change discipline: the agent reads the
current value before writing a new one, so the user sees the diff
("Bass was 5.30, bumped to 6.30") rather than an opaque "Bass set."
Combined with front-panel LED + audible verification, this is a
tighter feedback loop than the standard community workflow ("send
one knob, audibly test, repeat"). It's recorded in the project's
`SESSIONS.md` as the verification log; each substantive decode lands
with the chat-transcript evidence attached.

---

## Practical port plan for the Axe-Fx III skeleton

When we land the Axe-Fx III skeleton (separate backlog item — to be
filed as BK-049 after BK-048's contributor workflow is ratified),
the build-informed-by-existing-work plan is:

### From bspaulding (MIT — port allowed with attribution)

Hand-port these to `src/fractal/axe-fx-iii/`:

- **Opcode constants** — function-byte values (0x08 firmware, 0x0D
  preset name, 0x0E scene name, 0x14 preset number, 0x20 grid
  layout, 0x29 scene number, etc.). Drop opcodes specific to the
  Axe-Fx II (0x09 set preset name v1, model byte 0x03) since the
  III uses the v2 opcodes (0x28 set preset name) and model byte
  0x10 throughout.
- **`wrap_msg` envelope helper pattern** — TypeScript equivalent
  in our existing `axe-fx-ii/setParam.ts` works; this is mostly
  algorithmic cross-check.
- **`encode_effect_id` 14-bit septet split pattern** — same
  algorithm as our existing `axe-fx-ii` helper; cross-check
  bspaulding's implementation as confidence that the III uses the
  same septet-pair effect-id encoding.
- **Response parser table shapes** — for parsing GET responses
  back from the device. Our `axe-fx-ii/setParam.ts` already has
  `parseGetPresetNameResponse` / `parseGetGridLayoutResponse` /
  etc.; bspaulding's `src/parse.rs` is a useful cross-reference
  for shape + edge cases.

Attribution requirement:
- Add `licenses/axe-fx-midi-MIT.txt` containing the verbatim MIT
  LICENSE from bspaulding's repo.
- Add a `THIRD_PARTY_LICENSES.md` row at repo root pointing at it.
- Header comment in any ported file naming **Bradley J. Spaulding**
  + original repo URL + MIT licence acknowledgement.

### From tysonlt (GPL-3.0 — read-only cross-reference)

Use the source as a confirmation oracle for opcode values and field
positions. Specifically useful for:

- **Axe-Fx III opcode confirmation** — when bspaulding's opcode for
  a function matches tysonlt's opcode for the same function, that's
  two independent implementations agreeing, which is stronger
  evidence than either alone.
- **`intToMidiBytes` septet-split implementation** — same algorithm
  as ours, two reference implementations on the same approach.
- **Class-vs-functional API tradeoffs** — tysonlt's class-based
  AxeSystem / AxeEffect / AxePreset hierarchy is the read-and-navigate
  shape; ours intentionally diverges to a flat functional surface
  because MCP tools are flat function calls, not stateful sessions.

**No code copying.** GPL-3.0 is virally incompatible with our
Apache-2.0 distribution. If we needed something only documented in
tysonlt's code, we re-implement from first principles after reading
it, document the re-implementation cleanly, and cite tysonlt in a
"reference-only" comment with the repo URL.

### What neither provides — the work that remains genuinely fresh

After the lift-and-cross-reference pass, we still write from scratch:

- **The `0x02` SET_PARAM family** — neither library implements this.
  We have the encoder for the II already; trivial transplant to the
  III since the function byte is shared and only the param-table +
  model byte differ.
- **The 929+-param registry** for the III — generated from Fractal's
  III 3rd-party MIDI spec via a `scripts/extract-axe-fx-iii-params.ts`
  extractor we write (mirrors the existing II extractor).
- **The MCP tool surface** — `axefx3_get_preset_name`,
  `axefx3_get_grid_layout`, `axefx3_set_param`, etc. — same shape as
  the II tools, none of which are in either library.
- **Display-first translation, lineage hooks, manufacturer tagging,
  Fractal-prose surfacing** — all this is project-specific UX, not
  in any RE library.

### Estimated effort

The lift-and-port plus from-scratch work for the Axe-Fx III skeleton
adds up to **roughly 1-2 focused sessions** (probably 4-6 hours
total), divided as:

- ~1 hour: read both repos in full; document deltas in this file.
- ~1 hour: write `extract-axe-fx-iii-params.ts` against Fractal's
  published III MIDI spec; commit generated `params.ts` +
  `blockTypes.ts` + `data/axe-fx-iii-lineage.json`.
- ~1 hour: transplant `axe-fx-ii/setParam.ts` to `axe-fx-iii/setParam.ts`
  with III-specific model byte + function bytes; write byte-exact
  goldens against the spec's worked examples.
- ~1 hour: write `axe-fx-iii/tools.ts` registering the 8-10
  `axefx3_*` MCP tools; smoke-server expected list update.
- ~1 hour: docs + status banners + 🟡 markers; CONTRIBUTING.md HW-NNN
  list of validation tasks for the first III contributor.

The skeleton ships `🟡 spec-derived, hardware-validation pending`.
The first III owner in the community closes the validation via the
BK-048 workflow.

## Sources

1. [Fractal wiki: MIDI SysEx](https://wiki.fractalaudio.com/wiki/index.php?title=MIDI_SysEx) — primary wire-format reference (community-built).
2. [Fractal wiki: Third-party software](https://wiki.fractalaudio.com/wiki/index.php?title=Third-party_software) — catalog of community + commercial tools.
3. [Forum: Using MidiOX to capture sysex sent from Axefx 2 (130725)](https://forum.fractalaudio.com/threads/using-midiox-to-capture-sysex-sent-from-axefx-2.130725/) — canonical community virtual-MIDI-bridge recipe (this project does not use this approach; see "Capture techniques" above).
4. [Forum: Reverse engineer undocumented sysex? (201663)](https://forum.fractalaudio.com/threads/reverse-engineer-undocumented-sysex.201663/) — community discussion of what's still undecoded + firmware-drift expectations.
5. [Forum: Axe-Fx III and deconstructing/parsing a .syx (159885)](https://forum.fractalaudio.com/threads/axe-fx-iii-and-deconstructing-parsing-a-syx-sysex-preset-file.159885/) — direct binary-format RE on saved files.
6. [Forum thread #112538](https://forum.fractalaudio.com/threads/fractool-for-power-users-only.112538/) — closed-source third-party Fractal editor's long-running development thread (commercial alternative, decode kept private).
7. [Fractal-Bot (official tool)](https://www.fractalaudio.com/fractal-bot/) — Fractal's first-party firmware/preset utility, NOT a community RE project.
8. [GitHub: bspaulding/axe-fx-midi](https://github.com/bspaulding/axe-fx-midi) — Rust crate, Fractal-wiki-sourced.
9. [GitHub: tysonlt/AxeFxControl](https://github.com/tysonlt/AxeFxControl) — Axe-Fx III spec implementation.
10. [GitHub: laxu/AxeFx2VirtualPedalboard](https://github.com/laxu/AxeFx2VirtualPedalboard) — Axe-Fx II CC → SysEx translator.
11. [Snoize MIDI Monitor](https://www.snoize.com/MIDIMonitor/) — macOS byte-level MIDI inspection tool.
