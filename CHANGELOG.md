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
- **Unified tool surface (17 tools, port-dispatched, device-agnostic).**
  `set_param`, `get_param`, `set_params`, `get_params`, `list_params`,
  `apply_preset`, `apply_setlist`, `switch_preset`, `save_preset`,
  `switch_scene`, `set_block`, `set_bypass`, `rename`, `scan_locations`,
  `lookup_lineage`, `describe_device`, `restore_defaults`.
- **Generic-MIDI primitives (13 tools).** `send_cc`, `send_note`,
  `send_program_change`, `send_nrpn`, `send_sysex`, `send_panic`,
  `send_pitch_bend`, `send_clock_*`, `list_midi_ports`. Work against any
  USB MIDI device the OS exposes, registered or not.
- **Device-namespaced tools (~25 tools, `am4_*`, `axefx2_*`, `hydra_*`).**
  Carry device-unique capabilities the tool contract doesn't cover:
  Axe-Fx II grid layout reads, Hydrasynth NRPN patch dump, etc.
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
  - `docs/devices/<am4|axe-fx-ii|axe-fx-iii|hydrasynth>/SYSEX-MAP.md`:
    per-device wire-protocol decodes
    with 🟢/🟡/🔴 confidence legend and capture citations.
  - `docs/fractal-protocol-decode-status.md`: coverage index; refreshed
    by `npm run coverage-audit` reading code state directly.
  - `docs/SAFETY-FOR-MUSICIANS.md`, `docs/GETTING-STARTED.md`: plain-
    English trust model + day-one walkthroughs for non-developer users.
  - `docs/DECISIONS.md`: append-only architectural decision log.
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
