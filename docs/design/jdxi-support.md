# Roland JD-Xi support — design plan (BK-020)

Status: **design ready, no code written**. This document is a plan only; it
proposes files that do not yet exist and cites the sources that ground each
decision. Written 2026-07-10.

## 0. Read this first — a backlog/ownership discrepancy

The task that produced this document states "the founder owns and uses a
JD-Xi; it is the chosen next Roland device." The **current, non-archived**
`docs/_private/BACKLOG.md` agrees: BK-020's own entry (line 1286) says
"founder actively uses it" / "likely first Roland target," and a 2026-06-28
note (line 1213) calls it "founder-owned." I have treated this as ground
truth for the whole plan below.

However, `docs/_private/STATE.md` (Session 25, an early planning session,
lines ~6194-6203 and ~1485-1605) records a **later decision to demote BK-020**:
the founder was to replace the JD-Xi with an ASM Hydrasynth Explorer, and
BK-020 was to become "future community contribution, founder-hardware
[-independent]." `docs/_private/HARDWARE-TASKS-ARCHIVE.md` (lines 352-359)
echoes that demoted status ("the founder no longer owns the device").
Session 25 is chronologically very early in this project's history (the repo
has since passed session 120+); the Hydrasynth Explorer shipped as BK-031 and
is now a first-class device per `CLAUDE.md`. It is not clear from the
committed docs whether the founder actually gave up the JD-Xi, kept both, or
re-acquired it — `BACKLOG.md`'s own live BK-020 section was never edited to
reflect the Session-25 demotion, which reads as either an oversight or a
reversed decision.

**Action needed (not taken by this document):** reconcile `STATE.md` /
`HARDWARE-TASKS-ARCHIVE.md`'s "founder no longer owns it" language against
`BACKLOG.md`'s live "founder-owned" language before starting Phase 1 (below).
If the founder in fact owns both a Hydrasynth Explorer and a JD-Xi, no
reconciliation is needed beyond a note; if the JD-Xi was sold, Phase 1's bench
checkpoints (which require the founder's own unit) block on reacquiring one
or finding a community co-tester. This plan is written either way: the
codec/design work (Phases 0-1 catalog + reads) needs no hardware at all
(evidence-backed, ships community-beta per the shipping-bar policy in
`CLAUDE.md`); only the hardware-confirmation checkpoints need an owner.

## 1. Device overview

The JD-Xi is a 4-part crossover synthesizer: one Analog Synth Part (monophonic,
true analog VCO/VCF/VCA), two Digital Synth Parts (SuperNATURAL, 3 partials
each), and one Drum Kit Part (PCM rompler, multiple keys/partials, no
user-sample import). A **Program** bundles all 4 parts plus a shared
Arpeggiator, a 2-send Effects section (Reverb, Delay), a Vocal Effect
(vocoder/auto-pitch, fed by the mic input), and per-part MIDI routing. Each
part's underlying sound (a **Tone**) can also be recalled independently of
the Program via its own Bank-Select+PC on that part's MIDI channel, so the
device has a genuine two-level preset hierarchy: Program (whole combo) and
Tone (one part's patch) — see §4.

Source: Roland JD-Xi MIDI Implementation, Model: JD-Xi, Date: May 1 2015,
Version 1.00 — <https://static.roland.com/assets/media/pdf/JD-Xi_MIDI_Imple_e01_W.pdf>
(mirror: <https://synthmania.com/wp-content/uploads/2022/12/JD-Xi_MIDI_Imple_e01_W.pdf>).
Page-numbered citations below are against the ManualsLib rendering of the
same document: <https://www.manualslib.com/manual/1993286/Roland-Jd-Xi.html>.

## 2. Evidence inventory

Per `CLAUDE.md`'s shipping bar: evidence tier and hardware confirmation are
independent axes. Nothing below is hardware-confirmed yet (no probe has run);
the tier column says how strong the *paper* evidence is, which determines
whether it ships as community-beta on day one or waits.

| Capability | Evidence tier | Source | Ships day one? |
|---|---|---|---|
| SysEx envelope (`F0 41 <dev> 00 00 00 0E <cmd> <addr:4> <data/size> <cksum> F7`) | **STRONG** — published, byte-exact | MIDI Impl. p.16 (Exclusive Message format); matches `roland-midi/shared/sysex.ts` verbatim | Yes |
| DT1 (`0x12`) / RQ1 (`0x11`) command bytes | **STRONG** — published | MIDI Impl. p.16 example frame (`F0 41 10 00 00 00 0E 12 ...`) | Yes |
| Roland checksum (`128 - (sum % 128)`) | **STRONG** — published, and already implemented byte-identically for VE-500 | MIDI Impl. p.16 ("checksum ... inverting the lower 7 bits"); `roland-midi/shared/checksum.ts` | Yes (zero new code) |
| 4-byte 7-bit address encoding | **STRONG** — published; same shape as VE-500's `RolandTarget`/`addrToBytes` | MIDI Impl. p.8 top-level address table (all addresses shown as 4 space-separated 7-bit-safe bytes, e.g. `19 00 00 00`) | Yes (zero new code in `roland-midi/shared`) |
| Top-level address map (Setup `01000000`, System `02000000`, Temporary Program `18000000`, Temporary Tone Digital1 `19000000`/Digital2 `19200000`/Analog `19400000`/Drums `19600000`) | **STRONG** — published | MIDI Impl. p.8 | Yes |
| Program Common / Program Effect 1/2 / Program Vocal Effect substructure sizes (e.g. Program Common `00 00`-`00 1F`, Program Vocal Effect size `00 00 00 18`) | **STRONG** — published | MIDI Impl. p.9 | Yes |
| Program Change (0-127, "Program No.1-128"), Bank Select (CC0/32) supported, standard multitimbral recall | **STRONG** — published MIDI Implementation Chart | MIDI Impl. p.17 | Yes (`switch_preset`) |
| NRPN/RPN + a CC chart for realtime performance knobs (cutoff, resonance, attack/decay/release, portamento, vibrato rate/depth/delay, reverb/delay send) | **STRONG** — published, standalone from SysEx | MIDI Impl. p.2, p.17 | Yes — bonus fast path, see §9 |
| USB-MIDI class-compliant on Windows in "Generic" mode (no Roland driver needed for MIDI; "Vendor" driver only needed for the JD-Xi's audio-interface/ASIO feature) | **STRONG** — Roland support docs + community confirmation | <https://support.roland.com/hc/en-us/articles/213650826-JD-Xi-Connecting-to-a-Computer>; Roland Clan forum threads | Yes (zero new transport code — reuses `@julusian/midi`, exactly like VE-500) |
| Exact Program bank lettering/count (BACKLOG's working assumption: "256 programs, 128 preset + 128 user") | **MEDIUM** — a WebFetch pass returned a garbled duplicate ("Preset Banks A-D: 256 programs" AND "User Banks E-H: 256 programs", which can't both be literally 256) | MIDI Impl. Program List table, not yet read cleanly (see §11 R1) | Not blocking — Phase 1 targets the *active/Temporary* Program+Tone areas, which don't need the bank table resolved first |
| Full per-part param catalog (every Digital/Analog/Drum offset + range + enum) | **STRONG evidence path, not yet transcribed** — the PDF publishes it exhaustively (this is Roland's flagship "publishes full address maps" device per `BACKLOG.md` line 809) | MIDI Impl. pp. 8-15 (not fully read in this pass — see §7) | Generated mechanically once transcribed; see §7 |
| Pattern/step-sequencer content over SysEx | **NO EVIDENCE PATH FOUND YET** — the top-level address map (p.8) shows only Setup / System / Temporary Program / Temporary Tone regions; no visible "Pattern"/"Sequence" memory region | Absence in MIDI Impl. p.8; JDXI-Editor's own "4×16 step sequencer" feature was not confirmed to round-trip via SysEx vs. live MIDI capture (see §11 R4) | **No** — treat as out of scope until a capture or a fuller PDF read proves otherwise |
| Community priors: 3 independent open-source editors exist (`markxbrooks/JDXI-Editor`, Python/Qt/RtMidi; `Magiczne/JD-XI-Editor`; `brasno/JD-Xi-manager`, Python/tkinter) plus a commercial one (Patch Base) | Cross-validation oracle, not yet mined | <https://github.com/markxbrooks/JDXI-Editor>, <https://github.com/Magiczne/JD-XI-Editor>, <https://github.com/brasno/JD-Xi-manager>, <https://coffeeshopped.com/patch-base/editor/roland/jd-xi> | Use to cross-check the transcribed catalog before shipping (§7) |

## 3. What generalizes for free vs. what's new

Everything in `roland-midi/shared` (envelope, checksum, address transform,
`Size`/`encodeWire`/`decodeWire` value packing) is **protocol-generic across
the whole Roland/Boss family** and needs zero changes. This was true by
design — `packages/roland-midi/package.json`'s description already lists
"RC-505 / SPD-SX / JD-Xi planned" next to VE-500 — and the JD-Xi's own
manual confirms the same envelope shape byte-for-byte (§2). The **only**
VE-500-specific things that do NOT transfer are:

- **`editorCommMode` store handshake** (`roland-midi/ve-500/save.ts`). This
  was reverse-engineered from the VE-500 Editor's connect sequence and is a
  VE-500 quirk (a bare store command was hardware-refuted; the mode-on
  command turned out to gate the `0x7F0000xx` command register). The JD-Xi's
  published implementation shows no `0x7F0000xx` command-register scheme at
  all — Program/Tone writes are ordinary DT1s to the Temporary areas, and
  persistence (if any exists as a MIDI-triggered "write to user memory"
  action, vs. only a front-panel WRITE button) is undocumented in the MIDI
  Implementation PDF. **Do not assume the VE-500 handshake applies.** Treat
  JD-Xi `save_preset` as unresolved until a capture or a front-panel-only
  fallback is confirmed (§11 R2).
- **VE-500's alternate "Current Patch Number" SysEx-register recall**
  (`roland-midi/ve-500/patch.ts`) was reverse-engineered because the VE-500
  Editor doesn't use Program Change for recall at all. The JD-Xi's own
  published MIDI Implementation Chart **does** document standard Bank
  Select + Program Change (§2 table), which is strictly better evidence —
  no editor-JS RE is needed for `switch_preset`.
- **The generated-catalog pipeline itself** (`scripts/generate-ve500-catalog.ts`)
  evaluates the **VE-500 Editor's own JavaScript** (`address_map.js`) in a
  Node `vm` sandbox to mechanically walk its address tree. The JD-Xi has no
  such JS artifact to eval — the open-source editors are Python/Qt, not a
  bundled Chromium/JS app the way Boss's 500-series editors are (per
  `BACKLOG.md` line 811-812, this JS-extractable-editor path is a Boss
  quirk, not a Roland-family universal). §7 proposes the JD-Xi-specific
  substitute: a hand-transcribed structured intermediate file (the PDF *is*
  the address_map.js equivalent — it's just paper, not executable), cross-
  checked against the Python editors' own hardcoded offset tables.

## 4. Archetype decision: `voice` class, Program/Part/Tone hierarchy

`docs/ARCHITECTURE.md` §"Preset-class architecture" already anticipates this
device by name: the `voice` class table lists devices as "ASM Hydrasynth,
**Roland SPD-SX** (drum sampler, 9-pad fixed topology), **future Roland
synths**." The JD-Xi is exactly that future Roland synth. Decision:
**`preset_class: 'voice'`**, using the `apply_patch` tool family (sparse
override map on a fixed topology), the same family Hydrasynth already
registers.

### Why not `layout` (VE-500's class)

VE-500 is a linear signal chain: fixed sections, no fixed "voice" shape, no
oscillators/envelopes. The JD-Xi's Digital/Analog Synth Tones are
canonical **voice**-shaped (osc → filter → env → LFO → fx), exactly the shape
`apply_patch` was built for. Forcing the JD-Xi through `apply_preset`'s
`PresetSpec` (`slots[].block_type` from a cross-device layout union) would
require inventing `block_type` enum entries for "digital synth partial,"
which don't belong in a signal-chain union built for guitar-style slot
placement (`docs/ARCHITECTURE.md` explains this exact rationale for
Hydrasynth already — it applies unchanged here).

### The two-level hierarchy is the real design wrinkle

Unlike Hydrasynth (one voice = one patch = one slot), the JD-Xi's **Program**
is a container of 4 independently-recallable **Tones** (parts). Two
recall granularities exist on the real device and both need a home:

1. **Program recall** (all 4 parts + arp + effects at once) — this is the
   unit `switch_preset`/`save_preset` should target. Standard Bank
   Select + Program Change on the JD-Xi's own receive channel, per §2.
2. **Per-part Tone recall** (swap only the Analog part's sound, leave
   Digital 1/2/Drums alone) — normally done by sending Bank Select + PC on
   *that part's own MIDI channel* (each part has an independent Rx channel
   set in Program Common). This is standard multitimbral behavior, not a
   JD-Xi quirk, but it has NOT been checked against the JD-Xi's exact
   Program Common Rx-channel semantics in this pass — flagged as a bench
   item (§11 R3), not blocking Phase 1.

**Decision: block ids are per-part-prefixed, not a generic `instance`
argument.** The dispatcher already has a generic multi-instance mechanism
(`capabilities.has_block_instances` + an `instance` arg on `set_param` /
`set_bypass`, used by the grid Fractal devices for "Amp 1 / Amp 2"). It does
not fit here as cleanly as it looks: `has_block_instances` was built for
*identical* repeated block types (two Amps), and the JD-Xi's 4 parts are
NOT identical (Digital 1 and Digital 2 share a shape; Analog and Drums are
each their own distinct shape). The pattern that already exists and fits
exactly is **VE-500's own precedent for repeated same-shape sections**
(`harmony1`/`harmony2`/`harmony3`, `fx1`..`fx4`, `reverb1`/`reverb2` —
`packages/roland-midi/src/ve-500/catalog.ts`, `packages/ve-500/src/descriptor/schema.ts`):
give each part its own block-id prefix. Proposed block namespace:

- `digital1_common`, `digital1_partial1`, `digital1_partial2`, `digital1_partial3`, `digital1_lfo`, ...
- `digital2_common`, `digital2_partial1`, ... (identical param shape to `digital1_*`, generated from the same struct twice — exactly how VE-500's generator already re-uses one struct across System/Temporary via a `region` tag; here it's the same struct at two different Tone base addresses)
- `analog_osc`, `analog_filter`, `analog_amp`, `analog_lfo`, `analog_env`
- `drums_common`, `drums_key<NN>` (one block per playable key/partial — count pending §7 transcription)
- `program_common`, `program_effect1`, `program_effect2`, `program_vocal_fx`, `program_arp` (Program-level, not per-part)

`apply_patch`'s JD-Xi implementation therefore takes `{block, name, value}`
triples (matching `set_param`'s own contract), NOT Hydrasynth's flat
`{name, value}` shape — Hydrasynth can get away with a flat namespace
because it has exactly one voice and its NRPN catalog has no name
collisions; the JD-Xi's four parts WILL collide on names (`osc1_wave`
exists on both `digital1` and `digital2`) if not block-scoped. This is a
per-device choice, not a contract violation: `apply_patch` is registered
directly by each voice-class device package today (see
`packages/hydrasynth/src/tools/patch.ts` — there is no generic
dispatcher-level `apply_patch` yet, only a naming convention every
voice-class device is expected to reuse), so the JD-Xi package is free to
shape its own input schema as long as the tool is still named `apply_patch`
and still takes a sparse override map on a fixed topology.

### Drum Part: `voice`, not a second storage-transport device

The task asks for an explicit drum-part-vs-sampler-archetype call.
`docs/ARCHITECTURE.md` already resolves the general question by example:
the SPD-SX's drum *kit* is itself `voice`-class ("9-pad fixed topology"),
and SPD-SX ALSO separately ships a `storage`-transport tool family
(`spdsx_*`) ONLY because it accepts arbitrary user WAV uploads over a
mounted drive. The JD-Xi's Drum Kit Tone has **no documented WAV-import
path** — the MIDI Implementation PDF's drum-part parameters are ROM
wave-select (an enum choosing a factory PCM sample per key) plus
level/pan/tune/envelope, all ordinary DT1-addressable parameters, same as
every other part. **Decision: the Drum Part is `voice`-class only, folded
into the same Program/apply_patch surface as the other 3 parts. No second
storage-transport device is needed for the JD-Xi** (unlike SPD-SX).

## 5. Package shape

Mirrors the VE-500 split exactly (codec in `roland-midi`, device package
wraps it), with `@mcp-midi-control/jd-xi` at `packages/jd-xi/` — **not**
`packages/roland-jd-xi`, superseding the older BK-016 umbrella sketch
(`docs/_private/BACKLOG.md` line 1059) which predates the naming convention
that actually shipped (`@mcp-midi-control/ve-500`, `@mcp-midi-control/spd-sx`
— no vendor prefix).

### `packages/roland-midi` (codec, new subpath `./jd-xi`)

```
packages/roland-midi/src/jd-xi/
  model.ts              -- JD-Xi model id [0x00,0x00,0x00,0x0E], default device id 0x10,
                            JD-Xi RolandTarget, Temporary Program/Tone base addresses,
                            program bank layout (pending §11 R1)
  catalog.source.ts     -- hand-transcribed intermediate data: the PDF's address map,
                            structured the same shape as VE-500's RawBlock/RawParam
                            (section name, offset, size, min/max, enum table refs).
                            THIS is the JD-Xi equivalent of address_map.js — see §7.
  catalog.generated.ts  -- AUTO-GENERATED (same discipline as VE-500's file): flat
                            Jdxi ParamDef[] arrays per part namespace, produced by
                            walking catalog.source.ts the same way generate-ve500-
                            catalog.ts walks address_map.js
  catalog.ts            -- findParam/blockParams/allBlocks lookup (byKey/byBlock maps),
                            near-identical port of ve-500/catalog.ts
  program.ts            -- Program-level recall: buildSwitchProgram (Bank Select +
                            Program Change; §2 table), buildSwitchTone (per-part
                            recall on the part's own Rx channel — §11 R3 pending)
  setParam.ts            -- buildSetParam/buildGetParam/decodeParam/decodeParamReply/
                            paramReplyMatcher, port of ve-500/setParam.ts (base address
                            resolves per-part instead of per-user-patch)
  save.ts                -- ONLY if/when §11 R2 resolves a MIDI-triggered persist path;
                            otherwise omitted (front-panel-WRITE-only, like a device
                            with supports_save:false)
  index.ts               -- barrel, mirrors roland-midi/ve-500/index.ts
```

`packages/roland-midi/package.json`'s `exports` map gains a `"./jd-xi"` entry
identical in shape to the existing `"./ve-500"` one.

### `packages/jd-xi` (device package, new)

```
packages/jd-xi/src/
  descriptor.ts                  -- JDXI_DESCRIPTOR: preset_class:'voice', capabilities,
                                     canonical_terms (program/part/tone/partial — new
                                     vocabulary, see §6), blocks, block_aliases,
                                     reader, writer, agent_guidance
  descriptor/schema.ts            -- buildBlocks() from roland-midi/jd-xi's catalog:
                                     per-part block namespace (§4), enum_values joined
                                     from catalog.source.ts option tables (mirrors
                                     ve-500/descriptor/schema.ts's makeEncode/makeDecode)
  descriptor/reader.ts            -- getParam/getParams: RQ1->DT1 round trip, port of
                                     ve-500/descriptor/reader.ts almost verbatim
  descriptor/writer.ts            -- setParam/setParams/setBypass(arp on/off + per-part
                                     mute if documented)/switchPreset(Program)/
                                     switchTone(per-part, if §11 R3 resolves)
  descriptor/agentGuidance.ts     -- JD-Xi vocabulary teaching (program/part/tone/
                                     partial; arp; vocal fx; analog-part quirks)
  tools/patch.ts                  -- registerJdxiPatchTools(server): apply_patch
                                     (per-part-scoped override map, §4), init_patch
                                     (load a documented INIT Tone per part if one
                                     exists in the PDF; else refuse cleanly)
```

## 6. Tool mapping onto the unified surface

| Verb | Maps to | Notes |
|---|---|---|
| `switch_preset` | Program recall (Bank Select + PC on the device's own channel) | Strong evidence (§2); Phase 1 |
| `switch_preset` with a `part` argument, OR a dedicated Tone-recall path | Per-part Tone recall | Needs §11 R3 confirmation of per-part Rx-channel semantics before committing to the exact call shape; may ship as a JD-Xi-specific extension to `switchPreset`'s `location` argument (e.g. `"A01/analog"`) rather than a new tool — a genuinely novel capability would only justify a new verb if it can't be expressed as a location-string variant |
| `set_param` / `get_param` / `set_params` / `get_params` / `list_params` | Direct per-param DT1/RQ1, block-scoped (§4) | Phase 1; identical mechanism to VE-500, different addresses |
| `set_bypass` | Arp on/off (`program_arp.switch`), and per-part "part mute" if the Program Common area documents one (not yet confirmed) | Phase 2 |
| `apply_patch` | Build a whole Program (all 4 parts + arp + fx) as a sparse override map | JD-Xi-registered tool per §4; implementation is a per-param DT1 write loop, structurally like VE-500's `applyPreset` (a for-loop of individual writes), NOT like Hydrasynth's monolithic chunked-SysEx patch dump — the JD-Xi has no analogous "atomic patch blob" wire format, it is pure per-parameter addressing, which makes this actually SIMPLER to implement than Hydrasynth's version |
| `save_preset` | Persist a Program to a user memory | Gated on §11 R2 — omit `writer.savePreset` entirely (like a `supports_save:false` device) until a MIDI-triggered persist path is found or confirmed absent |
| `describe_device` | Program/Part/Tone/Partial vocabulary, arp, vocal fx | Phase 1 |
| tempo / arp | Arp tempo is a Program-level param (`program_arp.tempo` or synced to a `tempo` enum) | Treat as advisory per the existing cross-device "tempo-first" convention (`docs/_private` decisions log), not a hard gate; no new tool |
| pattern/step-sequencer | **Not mapped — no evidence path (§2, §11 R4)** | Out of scope this round; if it turns out to be a live-MIDI-capture feature (not SysEx-addressable memory), the existing `send_sequence`/`apply_pattern` `live_stream` realizer mode already covers "drive the JD-Xi as a note-target," no new capability needed |

`canonical_terms` proposal (new vocabulary to add alongside the existing
Fractal/VE-500/Hydrasynth rows once implemented):

| Canonical term | JD-Xi word |
|---|---|
| preset | Program |
| slot | Part (1-4: Digital 1, Digital 2, Analog, Drums) |
| block | Tone section (Common/Partial/OSC/Filter/Env/LFO within a part) or Program-level section (Effect/Vocal FX/Arp) |
| scene | n/a (JD-Xi has no scene concept) |
| channel | n/a (no per-block A/B/X/Y variation; "channel" in the JD-Xi's own vocabulary means MIDI receive channel per part, a different concept — don't collide the words in `agent_guidance`) |
| location | Program number within a bank (bank letter + 2-digit number; exact bank lettering pending §11 R1) |

## 7. Catalog generation

The mechanical pattern is the same one used for VE-500
(`scripts/generate-ve500-catalog.ts`): produce one generated TS file of flat
`{block, param, display_name, addr, size, ofs, min, max, enum_values?}`
entries, then a thin `findParam`/`blockParams`/`allBlocks` lookup layer. The
JD-Xi's **input** differs because there is no single JS file to `vm.runInContext`:

1. **Transcribe the PDF's address tables into `catalog.source.ts`.** The PDF
   (pp. 8-15, not fully read in this research pass) gives section names,
   offsets, sizes, and — for enumerated parameters — either an inline value
   list or a reference to a named table (waveform names, filter types, LFO
   shapes, effect types, arpeggio styles). This is manual, careful,
   one-time transcription work (the JD-Xi is a comparatively well-organized,
   single-model document, unlike AM4's from-scratch capture-based RE this
   is copying numbers off a table, not reverse-engineering them), structured
   in the same shape as VE-500's `RawBlock`/`RawParam` so the SAME
   `collectEntries`-style walker can produce the generated catalog.
2. **Cross-check against the three open-source Python editors** before
   trusting a transcription: `markxbrooks/JDXI-Editor`, `Magiczne/JD-XI-Editor`,
   and `brasno/JD-Xi-manager` each independently hardcode JD-Xi offsets in
   their own source (Python constants/dicts analogous to `address_map.js`).
   Where two of three agree with the transcription, confidence is high;
   where they disagree, that's a specific transcription error to chase down
   before shipping the catalog. This is the same "re-mine before you
   request" discipline the project already uses — three independent
   community re-implementations of the SAME published spec is a strong
   oracle, not a fresh RE effort.
3. **Estimated per-part param counts** (order-of-magnitude, pending
   transcription — do not hardcode these numbers into code, they're planning
   estimates only):
   - Digital Synth Tone (×2, Digital 1 & 2): Common + 3 Partials × (OSC, Filter,
     Amp, LFO, Env) — likely 150-250 params per Tone based on comparable
     SuperNATURAL Roland synths' published maps (JD-800/JD-990-family
     precedent per `sagamusix/JDTools`), i.e. 300-500 combined for both
     digital parts.
   - Analog Synth Tone: single-oscillator analog voice (OSC/Filter/Amp/LFO/
     Env), much smaller — plausibly 30-60 params.
   - Drum Kit Tone: Common + N keys × (wave select, level, pan, tune, envelope) —
     count depends on how many keys the JD-Xi's drum kit addresses (community
     editors will confirm N directly); likely 200-400 params total across all
     keys given a rompler kit typically spans 2-3 octaves of assignable pads.
   - Program-level (Common, Effect 1, Effect 2, Vocal Effect, Arpeggio): a few
     dozen params total, already partially confirmed (§2: Program Common
     size `0x1F` = 31 bytes of packed fields, Program Vocal Effect size `0x18`
     = 24 bytes).
   - **Total estimate: roughly 700-1200 params**, comparable in scale to the
     AM4 catalog, well within the existing generation pipeline's proven
     capacity.
4. **Display-first requirements.** Most JD-Xi params are linear knobs (0-127
   or a signed bipolar range) and are display-first automatically, same as
   VE-500's plain numeric params. The traps, per the non-linear-param rule
   in `CLAUDE.md`:
   - **Envelope times and LFO rates** are very likely bucketed/exponential
     tables on the JD-Xi (same family as the Hydrasynth's env/LFO tables
     the project already had to invert) rather than raw linear 0-127 —
     confirm against the PDF's per-param value-table column before assuming
     linearity; do not ship a raw-wire-index leak.
   - **Enum selectors** (waveform, filter type, effect type, arp style,
     octave range) need their label tables joined the same way VE-500's
     generator joins `option-tbl.js` — for the JD-Xi these tables live
     inline in the PDF's per-param rows (Roland format: "0-Sine, 1-Tri,
     2-Saw...") rather than a separate JS file, so the transcription step
     (①) should capture them directly into `catalog.source.ts`'s per-param
     `enum_values`, skipping the separate join step VE-500 needed.
   - Add every JD-Xi non-linear param to `npm run verify-display-first-fractal`'s
     tracked allowlist only as a last resort (an uncalibrated param should
     get its inverse formula before shipping, not a permanent carve-out);
     note this gate is currently Fractal-named/scoped — confirm whether it
     already covers non-Fractal devices or needs a parallel Roland-family
     gate (this project's own convention, not something this research pass
     verified).

## 8. Safe-edit gates mapping

Per `docs/SAFE-EDIT-WORKFLOW.md`'s cross-device contract:

- **Buffer-dirty gate (`on_active_preset_edited` / `guardActiveBufferOrSave`).**
  The MIDI Implementation PDF documents no dirty/edit-buffer-state SysEx
  query (same situation as Hydrasynth). **Omit `writer.guardActiveBufferOrSave`
  entirely** — the dispatcher already treats omission as "no gate, proceed,"
  which is the documented fallback for devices without a MIDI dirty signal.
- **Save-authorization gate (`save_authorized`).** Even though `apply_patch`
  isn't dispatcher-enforced today (§4), Hydrasynth's own tool handler
  manually replicates the gate (`packages/hydrasynth/src/tools/patch.ts`,
  the `if (save === true && save_authorized !== true)` block). The JD-Xi's
  `apply_patch` MUST copy this same manual check — it is not automatic
  just because the type contract documents it as "always enforced at the
  dispatcher," because `apply_patch` for voice-class devices does not
  currently run through that dispatcher path.
- **Multi-preset overwrite gate.** Only relevant once `save_preset`/batch
  Program writes exist; deferred with §11 R2's save-path question.
- **Read-before-write.** `CLAUDE.md`'s house rule. Since the JD-Xi's RQ1
  read is cheap (single round trip per param or per section, §9), the
  writer should default to reading a part's current Tone name/state before
  a destructive `apply_patch` targeting a NON-active Program location the
  same way VE-500 doesn't need to (VE-500 only edits the active buffer) —
  the JD-Xi's `apply_patch` target model (§4) needs to decide whether it
  edits the ACTIVE program only (like VE-500 and Hydrasynth's default RAM
  path) or can target an arbitrary stored Program directly. **Recommendation:
  active-Program-only for Phase 1** (matches every existing `voice`/`layout`
  device's default behavior — build in the working buffer, persist is a
  separate, explicitly-gated action), deferring "write directly into a
  non-active stored Program" until `save_preset`'s wire path is known (§11 R2).

## 9. Performance budget

SysEx round-trips are ~30-60ms per the project's standing budget. Two reads
strategies are available, and the design should default to the cheaper one
once §7's catalog exists:

- **Per-param reads (VE-500's exact current pattern):** `buildGetParam` issues
  an RQ1 sized to exactly one param's `wireByteCount`. Simple, proven, but
  N params = N round trips (a full Program status: ~700-1200 reads worst
  case ≈ tens of seconds — over the ">1s needs explicit progress" budget
  line, and probably over the "avoid >5s" line for a whole-Program read).
- **Structured section reads (recommended optimization, not required for
  Phase 1):** RQ1's `size` field is not restricted to one param — it can
  request an entire contiguous struct (e.g., all of Digital Synth Tone
  Common in one RQ1, given its total documented size) and get the whole
  section back in a single DT1 reply. This is mechanically supported by the
  ALREADY-IMPLEMENTED `buildRQ1`/`parseDT1` primitives (no roland-midi
  changes needed, just calling them with a bigger `size` than one param);
  VE-500's reader simply never needed it because a "whole preset" get was
  out of scope there. For the JD-Xi, a `get_preset`-shaped atomic-ish read
  (one RQ1 per structural section: Program Common, Digital1 Common+3
  Partials, Digital2 same, Analog, Drums Common+keys, Effects, Arp — maybe
  8-15 round trips total for an entire Program) would land comfortably
  inside the "2-5 wire transactions... < 1s" budget tier and could set
  `capabilities.atomic_read: true`-equivalent behavior. **Recommend
  scoping this as a Phase 2/3 stretch goal**, not blocking Phase 1's
  per-param `get_param`/`set_param`.
- `apply_patch` building a full 4-part Program from scratch (worst case
  ~700-1200 individual DT1 writes) is squarely in the "> 1s, needs explicit
  progress" tier, likely into the ">5s, avoid" tier for a truly exhaustive
  build. In practice an agent-authored patch touches tens of params, not
  the whole catalog (same as Hydrasynth's real-world `apply_patch` calls),
  so this is a soft risk, not a hard blocker — but `apply_patch`'s
  description should warn the agent (as Hydrasynth's already does) to keep
  a single call's override map reasonably scoped, and the tool should
  surface elapsed-time + step count in its response the way every other
  writer here already does.

## 10. Phased delivery, with bench checkpoints

Each phase is buildable and mergeable on its own evidence (per the shipping
bar: ship community-beta on strong paper evidence, do not wait for hardware).
Bench checkpoints require the founder's own unit (or a community co-tester —
see §0's ownership caveat).

**Phase 0 — Catalog + codec (no hardware needed).**
- Transcribe `catalog.source.ts` from the PDF (§7①); cross-check against the
  three open-source editors (§7②).
- `roland-midi/jd-xi`: model, catalog, generated params, setParam builders,
  program (Bank Select + PC) builder.
- `verify-msg.ts`-style golden cases built from the PDF's own worked example
  (p.16 shows a concrete Reverb Send Level = 100 frame with its checksum —
  use it as a byte-exact golden, the same discipline as every other
  device's golden cases).
- Exit gate: `npm run preflight` green with the new codec package, zero
  hardware required (matches the "evidence, not hardware" shipping bar).

**Phase 1 — Reads + continuous param writes on ONE part (bench checkpoint 1).**
- Ship `descriptor.ts`/`reader.ts`/`writer.ts` with `set_param`/`get_param`/
  `set_params`/`get_params`/`list_params`/`describe_device` wired for the
  **Analog Synth Part only** (smallest param count, fastest to verify
  end-to-end, and it's the device's headline "true analog" feature —
  matches the project's own phasing precedent of starting with the
  smallest/simplest surface, e.g. FM3 before FM9/III).
  - `switch_preset` (Program recall, Bank Select + PC) ships alongside —
    strong evidence, low risk, cheap to verify on the bench in the same
    session.
- **Bench checkpoint 1:** founder confirms one `set_param` (e.g. Analog
  Filter Cutoff) is audible + matches the front panel, one `get_param`
  round-trips the value the front panel shows, and `switch_preset` recalls
  the right Program. Mirrors the FM3/FM9 field-test pattern already used
  for every other community-beta device in this repo.
- Exit gate: matches Phase 1's device-confirmed subset in
  `docs/_private`'s per-device hardware-task-list convention.

**Phase 2 — Digital Synth Parts 1 & 2 + Drum Part (bench checkpoint 2).**
- Extend the catalog/blocks to `digital1_*`, `digital2_*`, `drums_*`
  (§4's block namespace). Verify the per-part-prefix block-id scheme
  resolves cleanly with no name collisions (a mechanical test, not a
  hardware one).
- **Bench checkpoint 2:** founder confirms `set_param` on a Digital part
  (e.g. OSC 1 waveform) and the Drum part (e.g. a key's level) land
  correctly and independently (i.e., editing Digital 1 doesn't leak into
  Digital 2 — the exact bug class the block-namespace design in §4 exists
  to prevent).

**Phase 3 — `apply_patch` (whole-Program authoring) + Program-level sections
(Effects/Vocal FX/Arp) (bench checkpoint 3).**
- Ship `tools/patch.ts`'s `apply_patch` (per-part-scoped override map, §4/§6).
- Wire `program_effect1`/`program_effect2`/`program_vocal_fx`/`program_arp`
  blocks.
- **Bench checkpoint 3:** founder builds a full 4-part Program via one
  `apply_patch` call (e.g. "warm pad on Digital 1, plucky pluck on Digital
  2, sub bass on Analog, a simple beat on Drums" — the exact BACKLOG-cited
  useful workflow) and confirms all 4 parts sound correct together.

**Phase 4 — Per-part Tone recall + `save_preset` (bench checkpoint 4,
gated on §11 R2/R3).**
- Only after R2 (persist path) and R3 (per-part Rx-channel recall) resolve.
- If R2 resolves "no MIDI persist path exists, front-panel WRITE only,"
  ship with `supports_save: false` and a `save_note` explaining the
  front-panel-only limitation (same documented pattern already used
  elsewhere in this repo for devices with real save gaps), rather than
  leaving the phase open-ended.

## 11. Risks / unknowns, with the specific resolving probe

| # | Risk/unknown | Resolving action |
|---|---|---|
| R1 | Exact Program bank lettering/count (a WebFetch pass returned a garbled "both A-D and E-H are 256" reading) | Re-fetch/read the MIDI Implementation PDF's own Program List table cleanly (a dedicated pass, ideally via a proper PDF text extraction tool rather than the HTML-conversion WebFetch path used in this research pass — `pdftoppm`/poppler was unavailable in this environment; try `pdftotext` or a different extraction path) before hardcoding `preset_location_format` |
| R2 | Whether a MIDI-triggered "persist Program/Tone to user memory" exists at all, vs. front-panel WRITE button only | Read the PDF's Setup/System address-map rows for anything resembling VE-500's command register, AND check the three open-source editors' own save/write code paths (they would have had to solve this if it's possible over MIDI) |
| R3 | Per-part independent Tone recall: does sending Bank Select + PC on a part's configured Rx channel actually swap just that part's Tone without disturbing the rest of the Program, and what exactly is addressable in Program Common for per-part Rx channel | Bench checkpoint 2 (Phase 2): founder sends a PC on the Digital 2 part's configured channel while Digital 1/Analog/Drums are live, confirms only Digital 2 changed |
| R4 | Whether the step-sequencer feature (seen in JDXI-Editor's README) is SysEx-addressable memory or a live-MIDI-capture feature with no persistent on-device representation | Read the JDXI-Editor source directly (not just its README) for its sequencer's MIDI I/O code, or ask its maintainer; if it's live-capture-only, formally close this as "not a SysEx target, use `apply_pattern`'s `live_stream` realizer mode instead" rather than leaving it an open question |
| R5 | Non-linear param tables (envelope/LFO time, if any) — which JD-Xi params are exponential-bucketed vs. linear | Confirm against the PDF's per-param value tables during §7's transcription; do not assume linearity by default the way a first pass might |
| R6 | Whether `verify-display-first-fractal`-equivalent gating already covers non-Fractal (Roland-family) devices, or needs a parallel gate | Check `package.json` scripts + the gate's own source before Phase 0 exit, not assumed in this document |
| R7 | Ownership/backlog discrepancy (§0) | Founder reconciles `BACKLOG.md` vs. `STATE.md`/`HARDWARE-TASKS-ARCHIVE.md` before Phase 1's bench checkpoints are scheduled |

## 12. Appendix — key citations

- Roland JD-Xi MIDI Implementation, Model: JD-Xi, May 1 2015, v1.00:
  <https://static.roland.com/assets/media/pdf/JD-Xi_MIDI_Imple_e01_W.pdf>
  (mirror <https://synthmania.com/wp-content/uploads/2022/12/JD-Xi_MIDI_Imple_e01_W.pdf>);
  page citations in this document are against the ManualsLib rendering,
  <https://www.manualslib.com/manual/1993286/Roland-Jd-Xi.html> (append
  `?page=N`).
- JD-Xi USB connectivity (Generic/class-compliant vs Vendor driver mode):
  <https://support.roland.com/hc/en-us/articles/213650826-JD-Xi-Connecting-to-a-Computer>
- Community editors: <https://github.com/markxbrooks/JDXI-Editor>,
  <https://github.com/Magiczne/JD-XI-Editor>,
  <https://github.com/brasno/JD-Xi-manager>,
  <https://coffeeshopped.com/patch-base/editor/roland/jd-xi>,
  Roland Clan forum thread (JDXi Manager):
  <https://forums.rolandclan.com/viewtopic.php?t=52354>
- Related Roland-family precedent for offset tables (JD-800/JD-990):
  <https://github.com/sagamusix/JDTools>
- Codebase grounding: `packages/roland-midi/src/shared/*` (envelope,
  checksum, address, packValue — reused unchanged), `packages/roland-midi/src/ve-500/*`
  (model/catalog/setParam/save/patch — the direct template),
  `packages/ve-500/src/descriptor*` (schema/reader/writer/agentGuidance —
  the direct template), `scripts/generate-ve500-catalog.ts` (catalog
  generation pattern), `packages/core/src/protocol-generic/types.ts`
  (`PresetClass`, `DeviceCapabilities`, `DeviceDescriptor`, `DeviceWriter`/
  `DeviceReader`, `GuardResult`), `packages/hydrasynth/src/descriptor.ts` +
  `packages/hydrasynth/src/tools/patch.ts` (the `voice`-class /
  `apply_patch` precedent), `docs/ARCHITECTURE.md` §"Preset-class
  architecture" (explicitly names "future Roland synths" under `voice`),
  `docs/SAFE-EDIT-WORKFLOW.md` (safe-edit gate contract),
  `docs/_private/BACKLOG.md` (BK-020, BK-016 sections), `docs/_private/STATE.md`
  and `docs/_private/HARDWARE-TASKS-ARCHIVE.md` (the ownership discrepancy, §0).
