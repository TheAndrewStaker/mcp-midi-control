# Changelog

All notable changes to MCP MIDI Control are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has one entry here and one corresponding commit. Fixes
ship as patch releases.

## [0.7.0]

A new package, **OpenRig**, gives the agent a structured model of a whole
multi-device rig instead of just one device at a time: `describe_rig` now
returns a declared topology (nodes, cables, bindings) plus live validation
and drift against what's actually connected, and the new `edit_rig` tool
adds/removes/toggles cables by conversation. The agent also gains real ears:
`measure_loudness` reads BS.1770 LUFS and true peak from any OS audio input
(a modeler's own USB audio interface, a mic, a bus), so loudness-matching
across scenes or devices no longer depends on eyeballing a meter that may not
exist. Three devices get new or deeper support: Fractal **AX8** (a fractal-gen2
config) gains `apply_preset`/`apply_setlist`, Boss **RC-600** gets live
recall plus byte-confirmed storage reads, and Boss **VE-500** gains recall
plus a cataloged system-parameter surface. Novation **Circuit Tracks**
patterns and samples can now target any storage pack, not just Pack 1
(`list_packs` lists them by name). AM4 cabinet/leveling defaults moved from
guidance text into enforced executor behavior (BK-103b/c), closing a class of
"the agent was told the right defaults but didn't apply them" gaps. Also
fixes the release ZIP that shipped without the ve-500/boss-rc/roland-midi/
openrig packages (#15).

### Added

- **OpenRig**: a new package (`packages/openrig`) modeling a rig as typed
  nodes (devices) and edges (cables), with per-device capability declarations
  and editable cross-device bindings. `describe_rig` (existing tool,
  substantially expanded) now returns the declared manifest, a structural
  validator (dangling cables, illegal capability assignments, MIDI-loop and
  clock-well-formedness checks that account for which devices actually relay
  vs. consume a signal), and presence-only drift against what's connected
  right now. The new `edit_rig` tool adds or removes a cable, or enables/
  disables one, against the configured manifest (`MCP_RIG_MANIFEST`).
  Routing-aware: cycle and legality checks trace which port a signal
  actually arrives on rather than treating any drawn ring as a cycle.
- **`measure_loudness`**: real loudness sensing (BS.1770-4 LUFS integrated/
  momentary, true peak) from any OS audio input, not just devices with a
  built-in meter. K-weighting and gating verified against the BS.1770-4
  reference tables and cross-checked against an `ffmpeg ebur128` oracle.
  Feeds scene- and device-leveling workflows (match loudness across AM4
  scenes, an RC-505 loop against a synth, etc.) with a measured target
  instead of a guess.
- **AX8** (`packages/fractal-gen2`, model byte `0x08`): `apply_preset` and
  `apply_setlist` are un-gated (community-beta, hardware-unverified). The
  gen-2 apply executor is now parameterized by model byte across all ~25
  wire-builder call sites instead of hardcoding the Axe-Fx II XL+'s `0x07`,
  closing several latent AX8 write paths that had never actually been
  exercised.
- **Boss RC-600**: live recall plus storage reads (memory names, ASSIGN
  tables) decoded and byte-confirmed against real `.RC0` files.
- **Boss VE-500**: recall plus 248 SYSTEM parameters cataloged through the
  unified surface (no new tools).
- **Circuit Tracks**: `list_packs` lists storage packs by name; pattern and
  sample authoring can target any pack via `drum_binding`, not only Pack 1
  (the codec previously assumed a single fixed pack).

### Changed

- AM4 cabinet/leveling defaults (BK-103b/c): opinionated cab-polish and
  scene-leveling behavior is now enforced directly in the apply executors,
  not left to agent guidance text that could be skipped.
- AM4 DynaCab lineage corpus and cabinet/mic register selectors expanded;
  a stale duplicate DynaCab quad (wrong roster order) removed.
- The encoding-primitive corpus directory was renamed `cookbook` →
  `primitives` throughout the codebase and docs.

### Fixed

- The release ZIP was missing the `ve-500`, `boss-rc`, `roland-midi`, and
  `openrig` packages (#15); the bundling step now includes every workspace
  package the server composes.
- `apply_preset`'s declared `outputSchema` had drifted from its actual
  response shape (a field added without a matching schema update), causing
  MCP hosts that validate `structuredContent` client-side to reject
  otherwise-successful applies. A new gate (`verify-apply-output-schema`)
  strict-parses a maximal response literal against the schema so this class
  of drift fails preflight instead of failing silently in the field.
- Axe-Fx II cab parameters referenced by a non-active scene's channel are
  now resolved correctly instead of silently targeting the wrong channel.

## [0.6.1]

Maintenance and CI hardening. No new device capabilities: the codec, tools, and
server behavior are unchanged from 0.6.0 apart from one robustness fix.

### Fixed

- `list_midi_ports` no longer crashes on a machine with no MIDI backend (a
  headless environment with no ALSA sequencer, or a machine with no MIDI
  driver). It reports "no MIDI ports visible" gracefully instead, and a
  zero-ports response now names the pattern it had nothing to match against.

### Changed

- The macOS and Linux native-binary CI matrix now passes end to end, verifying
  the prebuilt N-API binary loads on darwin-arm64/x64 and linux-x64. The Linux
  leg skips the server-smoke suite (which needs a live MIDI backend the runner
  cannot provide); that suite runs on Windows and macOS.
- The preflight CI workflow mirrors the local-only gates (visual-table,
  control-char, RE-ledger, tool-annotation, preset-portability, FM9 verifiers).
- Removed em dashes from the authored Markdown documentation.
- Stopped tracking a large debug capture (kept locally, gitignored).

## [0.6.0]

The largest release since launch. Two entirely new device brands join the
roster: the **Novation Circuit Tracks** (a groovebox sequencer) and the
**Roland SPD-SX** (a sample pad), proving the descriptor model scales past
guitar gear into sequencers and samplers, and Boss support arrives on two
fronts: the **VE-500** vocal processor and the **RC-505mk2** Loop Station, a
looper that is both a live MIDI target and a mass-storage device the server can
author memories on. Underneath them, the transport abstraction was generalized
so a "device" can speak MIDI, USB-serial, or USB mass-storage (or resolve
between them at call time), the native MIDI engine was swapped for one that
ships prebuilt binaries (no compiler on any platform), and macOS gained a
one-click Claude Desktop Extension install. A new `describe_rig` tool gives the
agent a whole-rig overview, the first step toward configuring a multi-device
setup from one conversation.

### Added

- **Novation Circuit Tracks: a new first-class sequencer device.** Author
  drum grooves and melodic patterns by conversation and play them on the
  hardware. `apply_pattern` builds patterns two ways: live-streamed over MIDI
  clock, or authored into a `.ncs` project uploaded to a slot. Drum tracks,
  note tracks (synth 1/2 and the two MIDI-out tracks: chords, basslines,
  leads, routed by channel), per-step sample flips, micro-step buzz rolls, and
  scale-aware authoring are all supported. `import_songsterr`, drum-tab text,
  and standard MIDI files import a real song's groove. WAV samples upload to the
  pad pool (`upload_sample`), whole `.ncs` projects transfer verbatim
  (`upload_project`), and the drum-track→sample binding is decoded so a groove
  can target specific kit voices. Destructive slot transfers read-before-write
  and back up the existing slot first. On the synth side, `save_preset` stores
  an edited synth patch to a Flash slot (hardware-confirmed: the patch survives
  a device restart) and `get_preset("patch:N")` reads a stored synth patch back
  from the bank, so a patch can be audited, saved, and re-read by conversation.
  Hardware-confirmed end-to-end (owner tests): `live_stream` melodies and chords
  play on Synth 1/2; an `ncs_upload` authoring of drums plus a note track
  round-trips onto a stored project that loads and plays on the device clock
  (octave bass on Synth 1 + kick on Drum 1); sample upload played back audibly;
  note-track arps drove a Hydrasynth over MIDI out; `get_param` reads a patch;
  and the synth-patch save (survives a power-cycle) plus stored-patch read-back
  round-trip was confirmed on the device (2026-07-03). Drum tracks
  cannot record external MIDI, so `ncs_upload` (not live capture) is the path
  that persists a drum beat onto the device.

- **Roland SPD-SX: a new sample-pad device on a hybrid transport.** In WAVE
  MGR mode the SPD-SX mounts as a USB drive whose kits and wave pool are files;
  in AUDIO/MIDI mode it is a MIDI device. It registers as a single
  **hybrid-transport descriptor**: the dispatcher resolves the live USB mode per
  call and routes accordingly, with no device-specific tools. In storage mode
  `scan_locations` lists kits, `get_preset(location)` reads a kit's pad map,
  `list_samples` reads the wave pool, `export_preset(location)` backs up a kit,
  `upload_sample` appends a wave (append-only, with duplicate detection and
  on-import normalization to the device's canonical PCM), and the new sampler
  verb **`author_kit`** writes the pad map (per-pad wave, MIDI note, voice
  poly/mono, mute group, loop mode, and level), with a non-destructive
  per-pad-note edit mode too. In MIDI mode `switch_preset` recalls a kit and
  `apply_pattern` triggers pads. The storage codec is byte-identical to the
  device's own files, and the write path through the server is hardware-confirmed
  end-to-end: server-authored kits (including looping pads) load and play on the
  unit after a power-cycle.

- **Circuit → SPD-SX (and other gear) MIDI sequencing.** `apply_pattern` gained
  `external_targets`: a Circuit pattern can drive an outboard device on one of
  the Circuit's MIDI-out tracks (e.g. route a programmed drum groove out to the
  SPD-SX's pads) while optionally keeping the internal voices too. An optional
  `MCP_RIG_LINKS` map lets you name the targets once and then just say "drums to
  the SPD-SX."

- **Boss VE-500 Vocal Performer: new device.** A vocal multi-effect (harmony,
  pitch correct, enhancer, FX, reverb). The full wire protocol was decoded
  byte-exact from the manufacturer's own editor source, so the catalog (873
  parameters across 41 blocks) needed zero captures and zero guessing.
  `set_param`/`set_params`, `get_param`/`get_params` (Roland RQ1→DT1 read-back),
  `set_bypass`, and `switch_preset` are hardware-confirmed on the unit
  (2026-06-28), so the device ships **verified**. `apply_preset` (whole-patch
  build, with enum/type values resolved by their editor panel labels) is wired;
  `save_preset` (store the active edit buffer to a user memory) is
  hardware-confirmed (2026-07-08): a bare store command does not persist, so
  `save_preset` first sends the editor's Communication Mode ON handshake that
  gates the device's command register, then the store, then waits for the
  store-ack echo the unit sends back; a set + save + reload round-trip persisted
  on the unit. One decoded hardware quirk: the unit
  ignores a memory recall when a Bank Select precedes the Program Change, so
  `switch_preset` sends a bare Program Change (needs PC IN = ON, RX CH =
  OMNI/Ch.1); factory presets P01-P50 stay gated (their Bank Select mapping is
  undecoded). Whole-patch reads remain deferred.

- **Boss RC-505mk2 Loop Station: a new looper on a hybrid transport.** The
  RC-505mk2 is both a live USB-MIDI device and, in storage mode, a USB drive
  whose memories are `.RC0` files. It registers as one **hybrid-transport
  descriptor**: the dispatcher resolves the live surface per call. On the MIDI
  surface, `switch_preset` recalls a memory (memory M to Program Change M-1 on
  the RX CTL channel, device-confirmed), looper and track functions are driven
  by `send_cc` through the memory's own ASSIGN table, and it slaves or masters
  the MIDI clock for tempo. On the storage surface, `scan_locations` lists
  memory names, `get_preset(location)` decodes a memory's full ASSIGN
  control-routing table (each slot read as `source -> target`, e.g.
  `CC#81 -> TRK2 PLY/STP`), and `export_preset(location)` backs up the live
  `.RC0`. Authoring a memory reuses the existing `apply_preset` verb rather than
  a new tool: `apply_preset(target_location = memory, save_authorized)` writes a
  memory's name and ASSIGN table (the exact inverse of the `get_preset` shape),
  and `save_preset(location, name)` renames one. Writes honor the device's own
  A/B `<count>` double-buffer save (the edit lands in the inactive slot with a
  raised count so it goes live on storage disconnect, no power cycle) and back
  up the overwritten copy first; without `save_authorized` an author is a
  no-write preview. The `.RC0` codec and the RC-505mk2 ASSIGN dictionary are
  byte-exact against real device files, and the whole path is hardware-confirmed
  end-to-end: a scene ping-pong authored into a memory (an external CC starting
  one track and stopping another) triggered correctly over MIDI on the unit,
  confirmed by ear and front panel. No parameter read over MIDI (the unit never
  echoes state), so live control is send-and-confirm-by-ear.

- **`describe_rig`: a whole-rig overview.** A read-only tool that lists every
  registered device with best-effort connectivity, transport, support tier, and
  pattern-target capability, plus a one-line summary: the "see the whole stage"
  read an agent needs before planning a multi-device setup. Opens no MIDI
  handles. Hardware-validated via Claude Desktop (10 devices listed; the SPD-SX
  resolved as a mounted drive).

- **macOS one-click install (`.mcpb`).** A Claude Desktop Extension installs the
  server from inside Claude Desktop with no Terminal and no config editing:
  the front door for the accessibility use case (driving gear entirely by voice
  / screen reader). The `.mcpb` carries the prebuilt MIDI engine for its build
  platform; `npm run setup-mac` remains the Terminal path. The Windows release
  ZIP is unchanged.

- **Accessibility: spoken-first output.** The server now instructs the agent to
  present results so they read cleanly aloud: signal chains as a linear path
  rather than an ASCII grid, each change confirmed in one short sentence with
  the device-confirmed value, and uncertainty stated in words. The
  conversational surface is the accessibility win; this makes the replies match.

- **Stored-preset reads across the Fractal family.** `get_preset` now reads a
  stored preset straight from device flash (not just the active buffer) on more
  of the family, each in a single round-trip: the **AM4** returns a stored
  location's name, scene names, and CRC-validated structure (and decodes the
  amp block's parameter values off the stored body); the **VP4** returns a
  stored preset's name, four scene names, current scene, and 4-slot chain; the
  **gen-1 Axe-Fx Standard/Ultra** returns the spec-pinned patch-dump subset
  (name + effect-grid layout + source flag, with the undetermined param region
  surfaced honestly as a byte count). On the **modern Fractal family** (Axe-Fx
  III / FM3 / FM9), `get_preset` on the active buffer now also surfaces the
  active scene and, community-beta (the meter decode is cross-validated against a
  behavioral oracle, not yet hardware-confirmed), live CPU and output meters
  alongside the grid.

- **Song-to-rig arrangements.** `apply_pattern` can realize a whole song's
  drum arrangement in one call: it folds a General-MIDI drum track (notes
  35-81) onto the target's pads by role, reports how the arrangement was
  compressed to fit, and supports `dry_run` to preview the mapping before any
  wire traffic. The Songsterr / drum-tab / MIDI-file import path feeds it.

### Changed

- **Native MIDI engine swapped to `@julusian/midi`.** The USB-MIDI binding is
  now an API-compatible fork that ships N-API prebuilt binaries for every target
  platform (macOS arm64/x64, Windows x64/arm64/ia32, Linux), so a normal install
  needs no C++ toolchain on any OS: the change that unblocks the no-Xcode macOS
  install and the `.mcpb` extension. A latent bug surfaced and fixed in the
  swap: the new binding resets its receive-filter on `openPort`, which had to be
  re-applied *after* opening or all SysEx reads on Windows would silently drop.

- **Transport abstraction generalized.** `DeviceDescriptor` now carries a
  `transport` kind (`midi` / `serial` / `storage` / `hybrid`, default `midi`),
  and the dispatch context resolves the right endpoint per call. This is
  additive (the existing ~156 MIDI call sites are untouched) and is what lets
  the SPD-SX be one hybrid descriptor instead of a bespoke tool family, and the
  first step toward the connection arbiter that multi-device orchestration
  needs.

- **Modern Fractal family (gen-3) read rosters completed and hardened.** The
  shared amp / drive / reverb read rosters across the Axe-Fx III / FM3 / FM9 are
  filled out (union of the per-device editor data), the compressor and wah type
  rosters are gap-filled from Fractal's wiki (agreement-verified against the
  device data), the FM3 now sends a cell-select before a block insert (matching
  the editor's own sequence), and the inbound reply reject-predicate is hardened
  (length + echoed-function guard) so a malformed frame can't be mistaken for a
  valid read.

- **Modern Fractal family (gen-3) enum/type selector routing corrected
  (wrong-ordinal write fix).** Type, model, and count selectors on the Axe-Fx
  III / FM3 / FM9 were being sent as continuous floats, so the device stored the
  wrong ordinal for a "set this block to that model" write. They now route as
  discrete ordinals: roughly 92 on the III and a further 34 on the FM9 (on top of
  the ~351 FM9 selectors already corrected in 0.5.1; each gated on that device's own
  SET-then-GET round-trip as the oracle), and 473 on the FM3 (via a
  family-join against the FM9/III evidence, community-beta pending an FM3 owner
  round-trip). The wire builder is byte-identical; only the display-to-wire
  kind-classification at the catalog boundary changed, so the III byte-identity
  anchor is intact. In the same pass the FM9's factory cabinet rosters (2,237
  names across FACTORY 1/2 + LEGACY) were registered as a bank-conditioned
  resolver, the FM9's scene / tempo / status reads were unblocked (they were
  III-model-locked and threw on the FM9), the FM3 grid read was fixed (the parser
  had hardcoded 14 columns and rejected every real FM3 frame), and gen-3
  `set_block` now honestly reports `unconfirmed` when the device sends no
  confirming echo instead of a false `acked`.

- **Display-first parity gate extended to the whole Fractal family.** The
  round-trip gate that guarantees no internal index or wire byte leaks through a
  tool boundary (previously enforced device-by-device) now runs across AM4 /
  Axe-Fx II / gen-3 (III/FM3/FM9/VP4) / gen-1 with a per-device parity-pending
  allowlist whose ceilings freeze the raw-wire debt, so a new uncalibrated
  param fails the gate. It caught and fixed two live violations.

- **Grid terminology aligned to Fractal's own vocabulary.** Grid-device output
  (`chain_integrity`, `describe_device`, tool guidance) now counts content
  **blocks** and reports connecting **shunts** separately, matching the
  Axe-Fx III manual's usage, instead of folding shunts into a raw placed-cell
  count.

### Fixed

- **Circuit Tracks `.ncs` transfers no longer reboot the device on a stale
  connection handle.** Transfers now reconnect before sending and abort cleanly
  per-send if the handle has gone dead, instead of streaming bytes into a
  half-open port (which power-cycled the device). Validated with zero reboots
  across repeated transfers.

- **Circuit Tracks sample upload fails loudly instead of silently as "0/64".**
  An upload into an uninitialized pack used to report a silent partial failure;
  the upload now gates on the `SET_FILENAME` acknowledgement and fails loudly and
  clearly on a genuinely uninitialized pack. Hardware-confirmed (a music-box
  sample registered to a slot and played back). (An earlier active-pack-index
  theory was investigated and reverted after it was falsified; the upload writes
  the pack-0 slot.)

- **Axe-Fx II bug sweep (hardware-verified).** A pass over reported Axe-Fx II
  behaviors, each fixed and confirmed on the device: `find_compatible_types` now
  returns each block's own type roster instead of a false "no type enum" answer,
  and narrows by the placed model on the two blocks that carry a primary-type
  gate (compressor, multidelay); the ambiguous-enum count is reported correctly;
  fresh-build grid-clearing (which already cleared stale blocks) gained a
  regression guard so it cannot silently regress; and `chain_integrity`
  reports the content-block count rather than a shunt-inclusive placed-cell
  count. The reported "blocks read as 12" was a reporting miscount, not a
  clear-logic bug.

- **AM4 bug-sweep fixes (hardware-verified).** A companion pass over reported
  AM4 behaviors: `get_preset` now returns all four block channels (A/B/C/D)
  instead of one mislabeled active channel and reports the current location plus
  a dirty flag; the MIDI-config registers (e.g. scene CC) decode as raw ints with
  the "None" sentinel handled; a stored-but-inaudible tempo-lock advisory and a
  pseudo-block warning exemption were added; and a recipe compressor-type fix
  landed. A later pass added the channel default (writes land on channel A/X for
  flat params) and per-scene channel completion on both the AM4 and the Axe-Fx
  II, plus the `find_compatible_types` fix shared with the II. An earlier
  multi-agent review of the sweep also corrected an Axe-Fx II classifier that had
  been silently dropping phantom-param and routing-mask warnings for every block.

- **`translate_preset` gained a validated AM4↔II enum-pair audit generator.**
  Cross-device enum translations are now backed by a generated, checked mapping
  audit instead of ad-hoc pairs, so an unmapped enum is surfaced rather than
  silently passed through.

## [0.5.1]

A community contributor ran a full SET→GET roundtrip across the entire FM9 and
Axe-Fx III parameter catalogs on real hardware. It confirmed the read +
continuous-write paths catalog-wide and surfaced one real catalog bug, fixed
here. Two evidence axes are kept deliberately separate below: *device-behavior*
confirmation (the contributor's independent rig and his own encoder observed the
device behave as expected) is not the same as *this server's wire* being
confirmed end-to-end.

### Fixed

- **FM9 enum/type selectors were sent as continuous floats instead of discrete
  ordinals.** The catalog builder derived a param's discrete-vs-continuous wire
  form only from name-overlays, never from the device editor cache's own enum
  flag. Any enum the overlay missed (type/mode/model selectors like delay model,
  pitch type, drive type) shipped as continuous, so `set_param` sent a normalized
  float and the device stored the wrong ordinal. The cache's `kind:'enum'` +
  count now flows into the catalog: **~351 FM9 params are corrected from
  continuous to discrete** (`sub=0x09` float32(ordinal)). The fix is gated on the
  device editor cache, so only the FM9 changes; the III/FM3/VP4 are untouched and
  the III byte-identity is intact. Evidence: the FM9 editor cache `kind` is
  typecode-derived (self-validating), and the direction is confirmed by the
  contributor's hardware roundtrip (device-behavior-confirmed on his rig); this
  server's own discrete `sub=0x09` frame is byte-exact against captures but is
  not yet confirmed end-to-end on this server's path. New gate
  `verify-gen3-enum-flow`.

### Changed

- **Axe-Fx III and FM9 reads + continuous writes are now community
  hardware-confirmed.** A 2026-06-17 owner test ran `get_param` + continuous
  `set_param` on both devices (FM9 fw 11.0; III fw 25.04) with device echoes and
  read-backs matching the front panel: the first on-device confirmation of the
  III, the gen-3 byte-identity anchor. Status language updated across the device
  configs, server instructions, and docs. Still community-beta on both: discrete
  set-by-name, `save_preset`, `set_block`, and the live grid read.

- **Capture/testing guides re-prioritized after the contribution.** The
  catalog-wide roundtrip and the read/continuous-write confirmations are marked
  done (no longer asked for). The top remaining gen-3 ask is now a
  device-synced editor cache for the III / FM3 / VP4 (the copies on hand are
  unsynced stubs with no enum vocabulary): the same offline, no-tools file that
  unlocked the FM9 enum routing above.

## [0.5.0]

Two gen-3 read unlocks adopted from (and cross-validated against) the
MIT-licensed `ai-tone-assistant` community project, plus the first independent
FM9 hardware confirmation of this server's own read + continuous-write path.

### Added

- **Live routing-grid read for the modern Fractal family (Axe-Fx III / FM3 /
  FM9).** `get_preset` on the active buffer now returns `live_grid`: the
  positioned signal chain (row/col + the block in each cell) read in one
  round-trip via `fn=0x01 sub=0x2E`, the live counterpart to the stored
  `whole_preset.grid`. The grid also gates the per-block read poll to only the
  placed blocks. The decode was cross-validated against a real FM9 capture
  (every effect ID resolves to a known block; Input→…→Output coherent).
  Community-beta (FM9-validated; the III shares the codec, the FM3 4-row region
  offset is unconfirmed); the cable-input bitmask is surfaced raw and not yet
  decoded into edges.

- **Amp type-knob applicability for the gen-3 family.** `find_compatible_types`
  and the `apply_preset` type-knob pre-flight now answer for gen-3 amps (they
  previously returned `applicability_known: false`): an agent is told which amp
  models actually expose a given knob, and warned before writing a knob that is
  inert on the selected model: the same guard the AM4 already had. Backed by a
  331-model valid-parameter table validated against our own amp roster and
  parameter catalog.

### Changed

- **FM9 read + continuous-write path is now community hardware-confirmed.** An
  FM9 owner test (firmware 11.0, macOS) round-tripped `get_param` and continuous
  `set_param` on the device through this server (acknowledged, with values
  confirmed on the FM9-Editor display), plus channel-specific reads and alias
  resolution. The support-status language across the FM9 descriptor, agent
  guidance, and docs reflects this. Discrete set-by-name, `save_preset`,
  `set_block`, and the new live grid read remain community-beta on the FM9.

## [0.4.0]

The FM3's first hardware field test, the fixes and protocol findings it
produced, and a codebase-wide reorganization of the Fractal packages by codec
generation, including one breaking change to the `fractal-midi` npm package's
TypeScript subpaths (JSON catalog consumers are unaffected).

### Added

- **FM3 hardware confirmation (community field test, fw 12.00, macOS).** The
  serial transport, discovery, framing, the entire read path (documented
  queries + whole-block reads across 35 block types), continuous `set_param`,
  `set_bypass`, `switch_scene`, and preset switching are now confirmed
  end-to-end through this server's own probes on real FM3 hardware; set-by-name
  discrete `set_param` was separately confirmed via a community session using
  frames byte-identical to this server's encoder. Still awaiting on-device
  confirmation: `set_block` placement, `save_preset`, and the Windows
  serial-driver path.
- **FM3 `switch_preset` now uses the gen-3 SysEx-native preset switch**
  (hardware-confirmed) instead of MIDI Program Change + Bank Select. The field
  test proved the FM3 ignores CC32 with the spec's "standard" bank encoding, so
  a PC switch to any preset above 127 landed on preset-mod-128.
- **Serial transport polish:** prefers the macOS `/dev/cu.*` callout twin over
  the `tty.*` node, and logs a one-line "connected via serial <path>
  (matched: …)" notice so field reports are self-documenting.
- **Serial-only installs work without the native MIDI binding.** node-midi is
  now loaded lazily everywhere, so an `npm install --ignore-scripts` clone (no
  C++ toolchain) can run the FM3 over USB-serial; if the binding is genuinely
  needed, the error names the fix (`npm rebuild midi`).
- **Per-block channel-count read projection (gen-3).** The field test showed
  whole-block dumps are not uniformly 4-channel-blocked (some blocks carry 1 or
  2 channel copies); the reader now derives each block's channel count from the
  dump against the device-true catalog, fixing reads on blocks like Looper and
  Resonator that the uniform model mis-addressed.
- **Probe diagnostics hardened from field evidence:** the gen-3 probes now
  resolve every paramId from the device-true catalog (paramIds differ across
  the family; hardcoded FM9-shaped ids mis-addressed the FM3 run), gate
  block-placement checks on the status dump instead of poll responses (polls
  answer even for unplaced blocks), and restore via the SysEx preset switch.

### Changed

- **BREAKING (`fractal-midi` npm package): TypeScript subpaths are now
  organized by Fractal codec generation.** `fractal-midi/axe-fx-gen1` →
  `fractal-midi/gen1`; `fractal-midi/axe-fx-ii` → `fractal-midi/gen2/axe-fx-ii`;
  `fractal-midi/axe-fx-iii`, `/fm3`, `/fm9`, `/vp4` →
  `fractal-midi/gen3/<device>`. `fractal-midi/am4` and `fractal-midi/shared`
  are unchanged, and **`catalog/*.json` paths are unchanged**: JSON catalog
  consumers are unaffected. Migration table in the package README.
- **Fractal MCP packages renamed by codec generation** (internal to the
  server): `fractal-gen1` (Axe-Fx Standard/Ultra), `fractal-gen2` (Axe-Fx II;
  a future AX8 lands as a config), `fractal-gen3` (Axe-Fx III / FM3 / FM9 /
  VP4). A new device on an existing codec generation is a config file, not a
  package.
- Shared wire-encoding primitives consolidated into `fractal-midi/shared`
  (14-bit and 16-bit septet codecs, display-scale conversion) with the public
  device subpaths re-exporting them unchanged.

### Fixed

- Working-buffer dirty tracking on the VP4 no longer mis-reads two of its
  effect-id bytes as a "preset stored/loaded" signal (the VP4's write frame
  has no sub-action byte; the check now applies only to the grid devices).
- A fresh `npm install` of a source checkout no longer silently links the
  npm-registry copy of `fractal-midi` instead of the workspace copy (the
  device packages pinned an exact stale version).
- The installer's configuration pre-flight required package names that no
  longer exist after the rename; a fresh ZIP install now passes it.

## [0.3.1]

Two additions aimed at the community: a language-agnostic JSON export of every
device's parameter dictionary, and first support for connecting the FM3, the
one Fractal device that is not a USB MIDI device on any OS.

### Added

- **JSON parameter catalog (`fractal-midi/catalog/`).** Every device's full
  dictionary (params, wire ids, blocks, enum rosters, ranges) exported as one
  generated JSON file per device, shipped in the `fractal-midi` npm package and
  the repo. Built for non-TypeScript consumers (Python tooling, librarians):
  pin a version instead of vendoring source files, and every calibration fix
  and roster fill lands on your side automatically. The export is regenerated
  from the TypeScript source and CI-gated against drift; shape contract in
  `docs/CATALOG-SCHEMA.md`.
- **FM3 over USB (community beta).** The FM3's USB control channel is a serial
  device, not a MIDI device ("FM3 Communications Port" on Windows,
  `/dev/cu.usbmodem…` on macOS). The server now auto-discovers that serial port
  (falling back from MIDI-port discovery) and speaks raw MIDI over it, so an
  FM3 works over plain USB on Windows and macOS. The serial port is exclusive:
  fully quit FM3-Edit / Fractal-Bot while connected. If auto-detection misses,
  set `MCP_FM3_SERIAL_PATH`. Hardware reports welcome: the wire paths are
  collaborator-confirmed, this server's serial leg is the part awaiting a
  first field test.
- `list_midi_ports` now also lists Fractal-looking serial (USB-CDC) ports, so
  "is my FM3 visible?" is answerable from the one diagnostic tool.

### Changed

- Source installs now require Node.js 20+ (the serial transport's native
  dependency sets that floor). Release-ZIP users are unaffected: the bundled
  runtime already satisfies it.
- Mac and FM3 documentation corrected against Fractal's own USB documentation:
  the Axe-Fx III, FM9, VP4, and AM4 are class-compliant USB MIDI devices on
  macOS (no driver, no caveats); only the FM3 is serial. MIDI Monitor cannot
  capture FM3-Edit traffic, and the metadata harvest script cannot reach an
  FM3; both guides now say so instead of implying otherwise.

## [0.3.0]

Makes the modern Fractal family far more accurate and capable. The FM9 becomes a
first-class conversational target: set and read amps, drives, and reverbs by their
real model names, and tweak every knob in the unit's own display units. The AM4
and Axe-Fx II catalogs are corrected against the hardware, and the Axe-Fx III /
FM3 / FM9 gain new editing moves.

### Added

- **FM9 device-true model rosters: set and read by name.** The FM9's full amp
  (331 models), drive/fuzz (86), and reverb-type (79) lists are mined from the
  FM9-Edit definition cache and wired so a request like "set the amp to Texas Star
  Clean", "use a Blues OD drive", or "switch the reverb to Music Hall" resolves to
  the right model, and reading a block back reports the FM9's own name. Name
  matching is case- and word-order-tolerant. The rosters are anchor-validated
  against hardware-confirmed ordinals (amp 65/179/264, drive 15/36, reverb 16/45);
  the underlying parameter write stays community beta pending an owner round-trip,
  so confirm changes on the unit.
- **FM9 device-true knob ranges across the whole unit.** The FM9's complete
  parameter dictionary (every block's display range, step, and curve) is decoded
  from the FM9-Edit cache and wired into calibration. A request like "set the delay
  to 500 ms" or "reverb predelay to 80 ms" now lands on the FM9's real range and
  curve instead of an approximation borrowed from another model; over a thousand
  FM9 knobs went from rough to device-accurate.
- **AM4 expert amp parameters.** Ten amp-modeling internals that are present on the
  device but were previously unreachable are now addressable for power-user tone
  shaping: clipping type, drive/preamp type, tone-stack type, feedback type, bias
  type, pre-compression type, wave-shaper high-pass, phase-inverter ratio,
  transformer leakage, and bias offset. Their value ranges are device-confirmed;
  set by number is reliable, set by name uses the editor cache's labels.
- **Gen-3 editing moves.** On the Axe-Fx III / FM3 / FM9 you can now clear a block
  and rename a preset or a scene (community beta, decoded from the editor).
- **The complete Axe-Fx II amp list loads intact.** A receive-buffer fix lets the
  server take in large device responses without truncation, so the full 266-name
  Axe-Fx II amp roster is now available (previously cut off mid-list).

### Changed

- **FM9 reverb names are now the unit's own form.** Reverb types read back in the
  FM9's adjective-first form ("Medium Spring", "Music Hall") instead of the
  borrowed AM4 word order ("Spring, Medium", "Hall, Music"). The Axe-Fx III and FM3
  keep the AM4-borrowed names until their own device caches are mined.
- **AM4 selector lists are device-true.** Several AM4 dropdowns (dynamic-cab types,
  mic types, speaker-impedance curves, and others) now show the device's own named
  options instead of generic placeholders.
- **`clean_forward` scene-leveling recipe.** Cleans deliberately hot (clean +6 dB,
  ambient clean +5, rhythm unity, solo +2): a clean tone can be eased off with the
  volume knob and pick dynamics, while a saturated tone plays in a narrow loudness
  band with input maxed, so hot cleans are recoverable in a way hot leads are
  not. Ear-tested on stage-style material.
- **AM4 stored-location export.** `export_preset` with a `location` now works on
  the AM4 (locations A01..Z04): back up any stored preset directly from flash
  without touching what you're playing. The request encoding was confirmed on
  hardware across the full bank range.

### Fixed

- **Axe-Fx II preset export now backs up the real working buffer, unsaved edits
  included.** The previous export silently returned the preset as last SAVED
  (and the device reloads that saved copy over unsaved edits when asked for it,
  so "backing up" in-progress work could destroy it). The export now uses a
  newly decoded and hardware-confirmed edit-buffer dump request, so what you
  hear is what lands in the file, with no save required and no side effects.
- **Axe-Fx II preset snapshots report the channel that is actually playing.** On a
  scene that selects channel Y, `get_preset` previously returned channel X's
  values labeled as active, so follow-up edits could anchor on the wrong tone.
  The snapshot now returns the active channel's values, matching the AM4.
- **Cross-device translation carries the amp's gain and mid knobs.** Translating a
  preset between devices now maps the preamp-gain knob (II `input_drive`, AM4
  `gain`, modern family `drive`) and the mid knob across naming conventions, and
  carries scene names to targets that support them. Tempo divisions like
  "1/2 DOT" bound for the modern Fractal family (where they cannot be set over
  MIDI yet) are dropped with a clear warning instead of failing silently, blocks
  without channels on the target get their parameters flattened instead of
  rejected, and amp/effect model names with no cross-device mapping are called
  out so an unmapped model never passes through silently.
- **Hydrasynth macro destinations initialize their Button Value.** A macro
  destination has three fields (Destination, Button Value, Depth); newly created
  destinations previously left Button Value at the device's uninitialized -128,
  so pressing the macro's button would slam that destination fully negative. New
  destinations now start at 0 (button does nothing until deliberately set), an
  optional `button_value` argument programs it, and the tool's guidance teaches
  the correct model (there is no sweep start/min on the hardware).
- **Routing references accept both documented forms.** Grid routing previously
  documented block ids as `amp_1` while the engine wanted bare `amp`; both now
  work and the docs match the engine. Presets that include explicit routing also
  verify their signal chain automatically after applying.
- **Axe-Fx II Vol/Pan volume reads back in knob units** (0..10) instead of a raw
  internal integer.
- **MIDI port failures are loud and self-diagnosing.** Windows can refuse to open
  a MIDI port (it is exclusive: another program or a leftover server process can
  hold it) and the underlying library reported nothing, so writes silently went
  nowhere while reads timed out and reconnect claimed success. The server now
  verifies every port actually opened and, on failure, names the likely holder
  (another running server instance, a leftover process, a manufacturer editor)
  and the recovery steps, instead of pretending the connection works.
- **FM9 reverb Time is calibrated to the device.** The Time knob's range and linear
  taper ([0.1, 100] s) are confirmed from a hardware sweep, replacing the value
  previously inferred from the AM4.
- **AM4 frequency and time knobs use the correct curve.** About ninety AM4
  parameters (cuts, rates, filter frequencies) were corrected to a logarithmic
  curve, confirmed by a front-panel reading, so a mid-position cut lands where the
  panel shows it instead of skewing high.
- **Axe-Fx II compressor level range corrected** to the unit's actual -20 to +20 dB
  (was a wider convention default), read directly from the device.
- **AM4 tuner and tuning-offset settings corrected** against the device's own
  definitions (mute-type and use-offsets are proper on/off-style choices;
  per-string tuning offsets read in cents).
- Tool descriptions and capability notes across the gen-1 and gen-3 devices now
  report read and write paths accurately instead of understating what is wired.

### For contributors

- **One-command device harvest.** A new read-only "harvest" script collects
  everything a Fractal device says about itself over USB (firmware, names, ranges,
  block layout) into a single file, so adding device-true support for a new unit
  takes one sync instead of a capture session. See the capture guides for the
  priority order of ways to help: editor cache file first, harvest second.

## [0.2.0]

Adds the rest of the modern Fractal floor-unit family (FM3 and FM9) and a
one-command macOS install. The Axe-Fx III, FM3, and FM9 now run on one shared
gen-3 codec with per-device parameter catalogs mined from each unit's own editor,
so a parameter write addresses the right control on each device instead of
borrowing the III's numbering.

### Added

- **Fractal Audio FM9** (model byte 0x12) and **Fractal Audio FM3** (model byte
  0x11), community beta. They share the Axe-Fx III's gen-3 SysEx protocol, scenes,
  and A to D channels, on the FM9's 6x14 grid and the FM3's 4x12 grid, and are
  controlled through the same unified tools as every other device. Like the III,
  they ship behind a beta notice pending a hardware round-trip from an owner; see
  the per-device beta-testing guides.
- **Fractal Axe-Fx Standard / Ultra** (gen-1, model byte 0x01), community beta.
  A descriptor decoded byte-for-byte from the published gen-1 SysEx spec: 922
  parameters across 35 blocks. Both writing (`set_param` / `set_params`) and
  reading (`get_param` / `get_params`) are wired: a parameter query (function 0x02
  with the set/query flag cleared) returns the live value and the device's own
  label. Whole-preset dump, save, and preset/scene/channel switching are out of
  scope, so those tools decline cleanly. Gen-1 also participates in
  `translate_preset` as a source into Axe-Fx II and AM4. All decoded from the spec
  and unconfirmed on hardware; confirm changes on the front panel.
- **Preset backup and restore (`export_preset` / `import_preset`).** `export_preset`
  writes a byte-exact `.syx` backup of the active working buffer to disk, and
  `import_preset` re-applies a backup to the device, on Fractal AM4 and Axe-Fx II.
  `import_preset` targets the working buffer by default, or a stored
  `target_location` when save is explicitly authorized. `export_preset` also takes
  an optional `location` to dump a stored preset slot straight from device flash;
  that path is gen-3 (Axe-Fx III / FM3 / FM9), wire-confirmed on FM9 (the `fn=0x03`
  request and `fn=0x77/0x78/0x79` dump).
- **macOS install.** `npm run setup-mac` builds and registers the server with
  Claude Desktop in one command, with no config-file editing. See
  `docs/INSTALL-MAC.md`. Windows keeps its one-click installer.
- **More AM4 parameters, from hardware probes.** Amp expert controls
  (`plate_suppr_diodes`, `cab_zoom`, `dynacab_sync`), 23 global-block enum tables,
  and the amp channel LED color enum are now wired and labeled from hardware-probe
  captures, so more of the AM4's front panel is reachable by name.

### Changed

- **The modern Fractal family is one codec, not three.** The Axe-Fx III, FM3, and
  FM9 are per-device configs of a single model-byte-parameterized gen-3 codec
  factory; adding a gen-3 device is a config, not a package. The III's behavior is
  unchanged and is now frozen by a byte-identity gate.
- **Device-true parameter catalogs for FM3 and FM9.** Each device's parameter IDs
  are mined from its own editor (validated to 100 percent against the III's
  known-good table) rather than reused from the III. Parameter IDs are
  device-specific, so reusing the III's would have addressed the wrong control on
  about 13 percent (FM3) and 24 percent (FM9) of shared parameters; each device
  now uses its own.
- **One tool surface.** The Fractal device-namespaced tools (`am4_*`, `axefx2_*`,
  `axefx3_*`) are removed; every Fractal device is driven through the unified,
  port-routed tools (`apply_preset`, `set_param`, `get_param`, and the rest). If
  you had a saved prompt naming a `*_`-prefixed tool, point it at the unified tool
  with a `port` argument instead. The Hydrasynth keeps its `hydra_*` tools.
- **Signal-chain routing on the gen-3 grid.** `apply_preset` lays out the cables
  between blocks on the III/FM9 6x14 and FM3 4x12 grids (the `fn=0x01 sub=0x35`
  routing op), decoded from FM9-Edit and FM3-Edit captures, so a built preset
  passes signal end to end instead of placing unconnected blocks.

### Fixed

- The modern family's `set_bypass` and `switch_scene` now report a device
  rejection instead of always claiming the write succeeded.
- The gen-3 patch-name read used the Axe-Fx III's model byte on every device; FM3
  and FM9 reads now use their own.
- **`apply_preset` on gen-3 now sends calibrated values.** It was passing spec
  knob values (e.g. `treble: 5.5`) straight to the encoder, which rejected
  non-integers and silently sent integer knob values as raw wire (so `gain: 5`
  went out near zero instead of mid-travel). It now coerces display to wire
  through each parameter's calibration, the same path `set_param` already used.
- `set_block` is bounded to each device's grid (the FM3's 4x12 no longer accepts an
  III-sized cell), and auto-save is gated where the store envelope is unpublished.
- Port routing: a port that enumerates as a Fractal FM9 or FM3 resolves to that
  device rather than falling through to the AM4 catch-all.
- **Axe-Fx II read values round to the panel.** `get_preset` and post-apply
  read-back returned raw float noise from the wire-to-display inverse (a panel
  `7.0` reading came back as `7.000030518`), which fouled read-modify-write
  nudges. Values now round to each parameter's display resolution at the read
  boundary.
- **Axe-Fx II `channel_blocks` is now the real X/Y set.** `describe_device`
  advertised a malformed channel-block list (filtered on bypassable rather than
  channel-bearing blocks, emitted display names instead of canonical keys, and
  duplicated multi-instance blocks). An agent that trusted it sent channel params
  to a block with no channels and failed the first apply. It now lists only
  genuinely X/Y-capable block types, deduped, as canonical keys.
- **`compressor.threshold` spelling.** The Axe-Fx II compressor threshold was
  registered as `treshold`; it is now `threshold`, with `treshold` kept as a
  back-compat alias so existing prompts and recipes keep resolving.
- **AM4 save returns a verifiable receipt and guards overwrites.** `save_preset`
  reads the stored slot back after writing and reports what actually landed, and it
  pre-flight scans a non-empty target location and refuses to overwrite it unless
  overwrite is confirmed. This closes a reported case where a save appeared to go
  to one location while the slot held a different preset.
- **AM4 tone builds no longer hang.** A large `apply_preset` is bounded by a total
  time budget with diagnostic logging, so an unresponsive device degrades to a
  partial result with a clear message instead of stalling for minutes.
- **AM4 unsaved-edit gate no longer over-refuses.** The dirty-buffer check is
  rebased onto deterministic edit tracking and the device-true edited bit, so
  navigating away no longer refuses with a false "unsaved edits" warning when the
  buffer is clean.
- **AM4 scene levels read back correctly.** The per-scene Level controls (Scene
  1-4 on the Main Levels page) were decoded against the wrong dB range, so
  `get_param` / `get_preset` / `list_params` reported wrong values (a +10 dB scene
  read back as -5). The writes were always correct; only the read-back display was
  wrong. They now decode against the device's actual plus/minus 20 dB range.
- **Leveling guidance follows Fractal's unity-match philosophy.** The built-in
  volume guidance on the AM4 and Axe-Fx II steered scene balancing backwards (it
  pushed clean scenes quieter). It now matches Fractal's own approach: balance
  every scene to the white-line 0 dB average, treat the red line as headroom not
  clipping, and raise the clean scene rather than lower it. The Axe-Fx II guidance
  now points at its real per-scene control (`output.scene_N_main`).
- **Channel LED colors can be set inside `apply_preset`.** The AM4 amp slot's
  per-channel map now accepts a `color` key, so a whole preset including footswitch
  colors builds in one call instead of a follow-up write.
- **Axe-Fx II output is muted safely during `apply_preset`.** The mute and restore
  around a multi-step build are now verified and retried (a dropped mute on a flaky
  USB link could let a half-built amp screech), and the output is restored to its
  exact pre-apply level instead of a fixed value.
- **FM9 preset switching lands the right preset.** The FM9 reads MIDI Bank Select
  from CC0 (MSB), and the bank-plus-program-change is now sent as separate MIDI
  messages, fixing both a wrong bank above preset 127 and a Windows MIDI limitation
  that silently dropped the combined message. Axe-Fx III and FM3 keep the
  spec-standard bank encoding.
- **Built-in recipes are validated against each device.** Several block-stack
  recipes carried amp / block / enum names that no longer matched the catalog, so
  applying them failed; every recipe is now materialized and checked at build time.
- The server reports its real version in serverInfo instead of a hardcoded value.

### Under the hood

- A byte-identity gate freezes the Axe-Fx III's catalog and `describe_device`
  surface, so the shared factory cannot silently change the III anchor.
- The VP4 (model byte 0x14) is registered and reachable through `describe_device`
  and the read tools; device-state writes are gated pending confirmation of its
  serial-chain block-placement wire shape.
- FM9 amp-voicing, drive/fuzz, and filter type names read back from the device
  where hardware captures confirmed them; the drive/fuzz type vocabulary is shared
  across the gen-3 family. Amp *model* names still read back as numbers on gen-3
  pending an owner capture of the model list (the amp-model ordinals are
  device-specific and exist only on the hardware).
- The first hardware-captured gen-3 single-parameter GET response (the device's
  internal value plus its own display label, from a community FM9) is decoded and
  available as a read-only calibration primitive for the paramId rebind work.

## [0.1.0]

First public release. A local MCP server that lets Claude control real USB MIDI
gear by describing the sound you want, hardware-verified on Fractal AM4, Fractal
Axe-Fx II XL+, and ASM Hydrasynth Explorer, with Axe-Fx III in community beta and
generic MIDI for any USB device.

### Devices

- **Fractal Audio AM4.** Hardware-verified end-to-end. Full preset authoring,
  scene and channel control, and save-to-location.
- **Fractal Audio Axe-Fx II XL+** (firmware Quantum 8.02, model byte 0x07).
  Hardware-verified. Multi-scene preset authoring on the 4x12 grid, save to
  location, and X/Y channel state per block.
- **ASM Hydrasynth Explorer** (firmware 1.5.x). NRPN patch authoring via SysEx
  dump, mod-matrix and macro routing by name, and a patch recipe library.
- **Fractal Audio Axe-Fx III.** Community beta. The protocol is scaffolded from
  Fractal's published v1.4 MIDI implementation document and public captures, and
  every write is byte-verified against that evidence, but no round-trip has been
  confirmed on real III hardware yet. Every III tool response carries a beta
  notice. III owners can confirm what works without writing code; see
  `packages/fractal-midi/docs/capture-guides/testing-axe-fx-iii.md`.
- **Any USB MIDI device.** The generic-MIDI primitives reach gear that has no
  registered descriptor, so a Line 6 Helix, a Boss GT-1000, or any synth with a
  published CC chart is controllable from day one.

### Tool surface

- **Unified surface, same names on every device.** One port-dispatched verb set
  (`describe_device`, `list_params`, `get_param`, `set_param`, `get_params`,
  `set_params`, `set_block`, `set_bypass`, `get_preset`, `apply_preset`,
  `translate_preset`, `switch_preset`, `save_preset`, `switch_scene`,
  `scan_locations`, `lookup_lineage`, `find_compatible_types`) covers every
  registered device. Adding a device means registering a descriptor, not adding
  tools.
- **Voice-class tools for synths** (`apply_patch`, `init_patch`,
  `set_system_param`, `set_macro`, `set_macro_route`, `set_mod_route`). With
  `set_mod_route` and `set_macro_route` an agent can wire the modulation matrix
  and performance macros by name, so it builds an expressive voice, not just
  static knobs.
- **Generic-MIDI primitives** (`send_cc`, `send_note`, `send_chord`,
  `send_sequence`, `send_program_change`, `send_nrpn`, `send_sysex`,
  `send_panic`, `send_song_position`, `send_reset_controllers`,
  `send_clock_start` / `send_clock_stop` / `send_clock_continue`) plus MIDI
  utilities (`list_midi_ports`, `reconnect_midi`).
- The exact count and per-tool reference are generated from the live server into
  `docs/TOOLS.md`; preflight fails on drift.

### Tone building

- **Build a whole preset in one call.** `apply_preset` takes blocks, params,
  scenes, and a name; without a target location it writes the working buffer for
  audition, with one it switches to the location and saves. `verify_chain` reads
  back every written param and reports drift.
- **Recipes as named starting points.** `recipe_id` applies a curated starting
  point on `apply_preset` (guitar) or `apply_patch` (synth). The Hydrasynth ships
  a patch library auditioned on hardware (Prophet-5 pad, Juno-106 pad, OB-Xa Jump,
  and more); the guitar side ships utility recipes (pitch, wah, filter, auto-wah,
  diatonic pitch). The recipe library is meant to grow with community help.
- **Cross-device tone porting** (`translate_preset`). Translate a preset spec
  from one device's vocabulary to another (AM4, Axe-Fx II, Axe-Fx III): maps
  block roles, translates param names and enum values, and collapses channel and
  scene cardinality. Read-only; it returns the translated spec and warnings, and
  the agent applies it on the target.
- **Lineage corpus** (`lookup_lineage`). Authored real-hardware lineage for amp,
  drive, and cab models: what each models, manufacturer and model notes, and
  designer context. AM4 and Axe-Fx II ship lineage corpora.
- **Loudness-aware gain staging.** Per-amp loudness offsets and scene-leveling
  come from a measured corpus, so a lead scene gets louder than rhythm without
  redlining.
- **Cross-device tolerance.** Param-name aliases (`drive.volume` resolves to
  `drive.level` where the device uses that name) and case-insensitive,
  whitespace-tolerant, fuzzy enum matching, so the same instruction works across
  devices.

### Opinionated behavior, consistent across devices

- **Display-first, including enum options.** Every value in and out is what the
  front panel shows (0..10, dB, ms, a ratio, an enum name), never a wire byte or
  internal index, even for non-linear mappings. A parity gate round-trips every
  such parameter in preflight and fails the build on any leak.
- **Tempo-first when supported.** Time-based parameters prefer syncing to the
  song or preset tempo, advisory rather than a hard gate, and the tool warns when
  a param it touched is tempo-locked.
- **No silent saves.** Saving to flash requires explicit save intent from the
  user; building a tone auditions in the working buffer and does not persist.
- **No silent edit loss.** Navigating away from an edited buffer refuses unless
  the caller discards or saves first, device-sourced where the hardware exposes a
  dirty signal and heuristic where it does not.
- **No silent overwrites.** Multi-preset writes pre-flight scan the target range
  and surface what would be lost.
- **Every write is acknowledged.** Writes wait for the device echo before
  reporting success, with a cold-start retry and auto-reconnect.

### Built to the MCP spec (2025-11-25)

- **Structured tool output.** Tools with a stable result shape declare an
  `outputSchema` and return `structuredContent` plus a JSON text fallback.
- **Tool annotations on every tool** (read-only, destructive, idempotent,
  open-world hints), with a CI gate that rejects any unannotated tool.
- **Actionable errors.** Correctable input returns a structured result the agent
  can fix and retry; operational failures return a tool-execution error with a
  suggestion, valid options, and a retry action, never an opaque protocol fault.

### Engineering

- **Layered architecture.** The wire codec is published independently on npm as
  `fractal-midi` (builders, parsers, param dictionaries, calibration, lineage),
  with no MIDI transport and no MCP code. Transport sits behind one interface;
  the MCP server only boots and registers.
- **Executable contracts.** Byte-exact SysEx goldens built from real captures,
  the display-first parity gate, the tool-annotation and tool-inventory gates,
  and per-package strict typechecks all run under one command, `npm run
  preflight`.
- **Distribution.** A Windows release ZIP bundles the Node runtime, a prebuilt
  native MIDI binary, and a `setup.cmd` that registers the server with Claude
  Desktop. End users need no developer tooling.

### License

- Apache-2.0, with the patent grant, from day one. Trademark statement in
  `NOTICE`. Security policy in `SECURITY.md`.

[0.6.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.6.0
[0.5.1]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.5.1
[0.5.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.5.0
[0.4.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.4.0
[0.3.1]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.3.1
[0.3.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.3.0
[0.2.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases/tag/v0.2.0
[0.1.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases
