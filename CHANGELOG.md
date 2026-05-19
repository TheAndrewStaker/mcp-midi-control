# Changelog

All notable changes to MCP MIDI Control are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release cadence

- **Pre-announce (current).** v0.1.0 is in active development. Commits land
  on `main` and are periodically squashed; this file's `[0.1.0]` section is
  the source of truth for what ships in the first public release, not the
  commit log.
- **Post-announce.** Every merge to `main` bumps the version (semver) and
  adds an entry below.

## [0.1.0] (Unreleased)

First public release. Hardware-verified MCP server for controlling USB MIDI
gear from Claude in plain English.

### Added

- **Device support.**
  - Fractal Audio AM4: hardware-verified end-to-end. 91% block-parameter
    coverage; full preset authoring, scene/channel control, save-to-location.
  - Fractal Audio Axe-Fx II XL+ (firmware Q8.02): hardware-verified.
    Multi-scene preset authoring, 4×12 grid layout, save-to-slot, X/Y
    channel state per block.
  - ASM Hydrasynth Explorer (firmware 1.5.x): full NRPN patch dump
    workflow + 117-parameter registry.
  - Fractal Audio Axe-Fx III: community beta. Protocol scaffolded from
    Fractal's published v1.4 MIDI Implementation PDF; all unified-surface
    operations wired with the byte-verified `fn=0x01 PARAMETER_SETGET`
    envelope (10 public captures). Beta warning banner on every response;
    III owners can confirm what works without writing code.
- **Unified tool surface (19 tools, port-dispatched, device-agnostic).**
  `set_param`, `get_param`, `set_params`, `get_params`, `list_params`,
  `apply_preset`, `apply_setlist`, `switch_preset`, `save_preset`,
  `switch_scene`, `set_block`, `set_bypass`, `rename`, `scan_locations`,
  `lookup_lineage`, `describe_device`, `restore_defaults`,
  `find_compatible_types`, `port_preset`.
- **Generic-MIDI primitives (17 tools).** `send_cc`, `send_note`,
  `send_program_change`, `send_nrpn`, `send_sysex`, `send_panic`,
  `send_pitch_bend`, `send_channel_pressure`, `send_reset_controllers`,
  `send_song_position`, `send_clock_start`, `send_clock_stop`,
  `send_clock_continue`, `list_midi_ports`, `reconnect_midi`,
  `play_note`, `play_chord`. Work against any USB MIDI device the OS
  exposes, registered or not. `play_note` / `play_chord` give the
  agent an audition surface (auto-off, configurable duration) so it
  can demonstrate a tone without the user reaching for a guitar.
- **Device-namespaced tools (41 tools, `am4_*`, `axefx2_*`, `axefx3_*`,
  `hydra_*`).** Carry device-unique capabilities the unified contract
  doesn't cover: Axe-Fx II grid layout reads, Axe-Fx III looper +
  tuner + tempo-tap, Hydrasynth NRPN patch dump, per-device reconnect
  helpers.
- **Cross-device tone porting** (`port_preset`). Translate a preset
  built for device A into an equivalent preset on device B. Handles
  differences in chain topology, block availability, parameter
  names (via the BK-065 alias table), enum values (via BK-066 enum
  mapping), and scene / channel counts. Surfaces a structured
  compatibility report alongside the ported preset so users can see
  what mapped one-to-one and what required a substitution. (BK-067.)
- **Read-after-write integrity check** (`verify_chain` flag on
  `apply_preset`). Opt-in per-call: when set, the dispatcher reads
  the device's actual state after the apply finishes and returns
  structured chain-break diagnostics if anything didn't land. Lets
  the agent catch silent wire-level drops without polling the device
  itself. (BK-057.)
- **Cross-device parameter name aliases.** Same conceptual knob
  resolves under either device's preferred name. `drive.volume` on
  AM4 (which calls it `drive.level`) and `wah.effect_type` on AM4
  (which calls it `wah.type`) both resolve cleanly. Reduces the
  cross-device discovery loop the agent ran on every port. (BK-065.)
- **Cross-device enum tolerance.** Enum value resolution is case-
  insensitive, whitespace-tolerant, and fuzzy-match-friendly across
  all devices. `"USA CLEAN"` against the AM4 (which stores
  `"USA Pre Clean"`) returns a disambiguation response with closest
  matches instead of a hard error. Phase 2 adds cross-device concept-
  key resolution: the dispatcher recognizes the same amp model
  spelled differently per device and maps between them during porting.
  (BK-066 phases 1 + 2.)
- **Loudness intelligence rollup.** Per-amp master sweet-spot ranges
  baked into lineage data, scene-leveling recipes that write to
  Output blocks (tone-preserving), drive-boost compensation, auto-wah
  recipe, and diatonic pitch recipes. Lets the agent reason about
  perceived loudness across devices without users having to teach it.
  Hydrasynth received a parallel loudness guidance entry mirroring the
  Fractal pattern. (BK-064 parts 1 + 2 + 3.)
- **Pitch + wah + filter static-position recipe library.** Hardcoded
  named-configuration library (`octave_up`, `harmony_third`,
  `cocked_wah`, high-cut / low-cut shaping, etc.) the agent applies
  by intent. Expands into concrete `apply_preset` slot params. No
  new wire decode required. (BK-061 + BK-062.)
- **Parameter documentation flags.** `list_params` accepts
  `include_descriptions: boolean`; `get_param` accepts
  `include_description: boolean`. When set, responses carry the
  parameter's display label and behavior notes alongside the value.
  Cuts the agent's "what does this knob do" round-trip during tone
  authoring.
- **Cross-device safe-edit contract** (`docs/SAFE-EDIT-WORKFLOW.md`).
  Three gates enforced consistently across devices:
  - `on_active_preset_edited`: refuse navigation away from edited buffer
    unless caller explicitly discards or saves first. AM4 uses a working-
    buffer fingerprint poll (no push signal exists); Axe-Fx II uses the
    device's state broadcast; Hydrasynth omits this gate (no MIDI-exposed
    dirty signal).
  - `save_authorized`: apply-and-save tools refuse unless the caller
    explicitly authorizes the destructive save. Default refusal text
    teaches the agent the retry path.
  - Multi-preset overwrite scan: `apply_setlist` pre-flights the target
    range and surfaces what would be overwritten before writing.
- **Display-first tool API.** Every tool accepts and returns display
  units (musician-facing values from the device front panel, e.g.
  `amp.gain: 4.5`, `amp.type: 'Plexi 100W High'`). Wire-format details
  are internal and never leak through tool I/O.
- **Protocol-layer goldens.** 254 byte-exact SysEx wire tests built from
  captured frames, plus pack/unpack round-trips and IR-transpile cases.
  Wired into preflight + Windows-latest CI on every push and PR.
- **Distribution.** Windows release ZIP that bundles the Node runtime, a
  prebuilt native MIDI binary, and a `setup.cmd` that registers the
  server with Claude Desktop. End users need no developer tooling.
- **Documentation.**
  - `docs/devices/<am4|axe-fx-ii|axe-fx-iii|hydrasynth>/`: per-device
    home with SYSEX-MAP.md (wire-protocol decodes, 🟢/🟡/🔴 confidence
    legend, capture citations), README, and `manuals/` subfolder
    holding the vendor reference extracts (`.txt` checked in, PDFs
    gitignored). Cross-device Fractal manuals (Blocks Guide, MIMIC
    Technology) stay in top-level `docs/manuals/`.
  - `docs/research/`: cross-device methodology and exploratory notes
    (Ghidra mining workflow, loudness data methodology, broadcast vs
    poll research, fractal-midi extraction plan, protocol decode
    status). `npm run coverage-audit` refreshes
    `fractal-protocol-decode-status.md` from code state directly.
  - `docs/AXEFX3-BETA-TESTING.md`: contributor-facing beta playbook
    for the Axe-Fx III community testing program.
  - `docs/SAFETY-FOR-MUSICIANS.md`, `docs/GETTING-STARTED.md`: plain-
    English trust model + day-one walkthroughs for non-developer users.
  - `docs/_private/DECISIONS.md`: append-only architectural decision
    log (founder-private; not in the public repo).
- **Contributor terms.** `CONTRIBUTING.md` carries an explicit
  maintainer-grant clause (CLA-equivalent): contributors keep
  Apache 2.0 freedoms for users of the project AND grant the
  maintainer a separate license to use, modify, sublicense, and
  relicense their contributions under any terms. Opening a pull
  request counts as agreement; no signature ceremony required.
- **License.** Apache-2.0 from day one. Patent grant included to protect
  contributors adding device support against upstream-vendor patent
  claims. Trademark statement in `NOTICE`.
- **Security policy** (`SECURITY.md`) with private contact and AM4-
  bricking threat-model scope.

### Known limitations

- **Windows-only release ZIP.** Source installs work on macOS/Linux
  (preflight + smoke tests pass) but the bootstrap script relies on
  PowerShell. macOS/Linux release artifacts are post-v0.1.
- **Axe-Fx III is community beta.** Wire shapes for parameter writes are
  byte-verified against 10 public captures, but no contributor-confirmed
  round-trip on real hardware has been logged yet. Beta warning banner
  appears in every III tool response.
- **Hydrasynth has no MIDI-exposed dirty signal.** The
  `on_active_preset_edited` gate is structurally omitted for Hydra;
  tool descriptions instruct the agent to ask the user before navigating
  instead.

[0.1.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases
