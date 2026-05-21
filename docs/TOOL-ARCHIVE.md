# Tool Archive

This file is the canonical record of MCP tools that were once shipped by this project but have since been removed from the registered surface. Tools listed here are NOT deprecated. They are removed-but-documented capabilities that future agents (human or Claude) can resurrect when product context or wire-level evidence warrants it.

## Why this file exists

The project ships a single MCP server with a fixed registered tool list. When a tool is cut, its source is deleted from the tree. Without an archive, the capability knowledge (what it did, what wire opcodes it spoke, what user prompts it served) vanishes with the file. This archive preserves enough context that an agent reading it months later can:

1. Understand what the tool used to do at the user-facing level.
2. Recover the original source from git history via the cited commit.
3. Decide whether the original implementation is still viable or whether new captures / decode work is needed.
4. Find any associated captures, tests, or research notes.

## Conventions

- **No "deprecated" labels.** This is an archive of removed capabilities, not deferred-removal warnings.
- **One entry per removed tool.** Tools removed together get separate entries so each can be resurrected independently.
- **Cite a git commit.** Every entry names the SHA where the tool's source last lived. Reviving the tool starts with `git show <sha>:<path>`.
- **Cite wire opcodes when known.** If the tool spoke a wire-native primitive, name the SysEx function byte or NRPN number. If the wire layer was never decoded, mark it as "unrealized" and link to the HARDWARE-TASKS hypothesis.
- **Same-commit archive rule.** Every PR that removes a tool from registration MUST add its archive entry in the same commit. The CLAUDE.md living-documentation table enforces this at session-wrap.

## Entry shape

```markdown
### <tool_name> (removed: YYYY-MM-DD)

**Wire function:** <SysEx fn byte / NRPN / "none, derived primitive" / "unrealized">.
**Original use case:** <one-sentence user-facing UX description>.
**Why cut:** <one-sentence architectural reason: superseded / pure overlap / research-only / layout-fragile / unverified>.
**Resurrection instructions:**
- Source last lived at commit `<sha>` in `<path>`.
- Recover: `git show <sha>:<path> > <path>` then re-register in `<server registration site>`.
- Tests: `<test file paths>` (recover similarly if needed).
- Captures: `<samples/captured/<filename>>` (gitignored, local-only; cite by filename).
**Stability note:** <wire format settled / needs new capture / N=1 only / Test Crunch only / etc.>.
```

## Documented exceptions to description-budget cap

Tools listed here are allowed to exceed the 1000-char hard cap or 600-char warn threshold for the cited reason. Each exception requires a `// description-budget-override: <chars> <reason>` comment adjacent to the registration. Linter (T-19) reads this list.

| Tool | Allowed chars | Reason | Override site |
|---|---|---|---|
| _(none yet)_ | | | |

## Removed tools

### axefx2_test_apply (removed: 2026-05-21)

**Wire function:** none unique (delegated to `runApplyPresetAtOps` + GET_GRID_LAYOUT response parsing; same wire path the unified `apply_preset({port:'axe-fx-ii', spec, verify_chain:true})` uses).

**Original use case:** Working-buffer-only apply + chain-integrity verify in one call. Pre-dated the unified surface, served as the early "did the apply land correctly?" check.

**Why cut:** Pure superset by `apply_preset({port:'axe-fx-ii', spec, verify_chain:true})`. Unified version provides chain verify + working-buffer apply + scenes[] + cross-device aliases + validation_info[] surfacing + the full PresetSpec shape. The device-namespaced tool was already labeled DEPRECATED in its description and pointed callers at the unified replacement.

**Resurrection instructions:**
- Source last lived at commit `108ecc7^` (pre-T-2). To recover: `git show 108ecc7^:packages/axe-fx-ii/src/tools/preset.ts` then re-add `registerAxeFxIIPresetTools` import + call to `packages/axe-fx-ii/src/tools.ts:registerAxeFxIITools`.
- No tests to restore (no goldens dedicated to this tool; `axefx2_test_apply` shared coverage with the underlying applyExecutor which still ships).

**Stability note:** wire path is unchanged (the underlying executor + grid-layout response shape are stable). Resurrection would just re-expose an already-deprecated alias; recommend updating the caller to the unified `apply_preset` instead.

### axefx2_atomic_apply (removed: 2026-05-21)

**Wire function:** FN_PATCH_DUMP (0x03), FN_PATCH_HEADER (0x77), FN_PATCH_CHUNK (0x78), FN_PATCH_FOOTER (0x79), STORE_PRESET (0x1d). The full dump → patch → push → save sequence.

**Original use case:** Atomic multi-block, multi-scene, multi-param preset modification in one round-trip. Designed to kill the BK-058 race condition (`SET_BLOCK_CHANNEL` fn 0x11 dropping channel-Y writes on inactive scenes) by patching the preset binary directly and pushing it back atomically instead of streaming per-frame channel writes.

**Why cut:** The dump → patch → push → save pipeline is wire-correct, but the (chunk, ushort) coordinates in `BLOCK_LAYOUT_MAP` are calibrated only against the Test Crunch 6-block composition (compressor / drive / amp / cab / delay / reverb at row 2). Hardware probing in Session 116 cont 3 proved layout positions SHIFT per-preset (adding a Chorus block shifts Compressor's X paramBase by +50 ushorts). Ghidra confirmed the encoder lives in firmware; the sort algorithm cannot be RE'd from AxeEdit. Shipping the tool as-is means silent writes to the wrong ushorts whenever the target preset does not match Test Crunch. Functional equivalent for multi-channel writes already lives on the unified surface via `apply_preset` with `slots[].params.X / .Y` nested params (BK-058 writer fix + BK-077 channel-Y inactive warning).

**Resurrection instructions:**
- Source preserved at `packages/axe-fx-ii/src/research/atomicApply.ts` (moved 2026-05-21; not registered).
- Last live registration shipped at commit `e9dcf3e` (May 2026). To recover the registration call site: `git show e9dcf3e:packages/axe-fx-ii/src/tools/atomicApply.ts` then re-add `registerAxeFxIIAtomicApplyTool(server)` to `packages/axe-fx-ii/src/tools.ts:registerAxeFxIITools`.
- Research probes: `scripts/_research/test-atomic-apply.ts`, `scripts/_research/test-atomic-dual-channel.ts`. Both still register the tool standalone (separate from the production server) for ad-hoc Test-Crunch-composition runs.
- Resurrection prerequisite: a layout-discovery step that runs BEFORE the patch phase and resolves (chunk, ushort) coordinates against the actual target preset's composition. Two candidate decode paths: (a) mine the AxeEdit III binary for a parallel implementation; (b) ship a calibration-probe v2 that probes-and-confirms each ushort cell pre-write. Until either lands, treat the tool as wire-correct-but-layout-fragile.

**Stability note:** wire format is settled (the dump / push primitives mirror what `registerAxeFxIIPresetBinaryTools` already ships safely). The layout-map data is N=1 calibration; needs a real solution before the tool resurrects.

## Unrealized capabilities

Tools that were considered but never shipped, captured here so future agents do not re-derive the same hypothesis from scratch.

### nudge_param on Axe-Fx II / III / Hydrasynth (unrealized; 2026-05-21)

**Wire function:** Unknown on II / III / Hydrasynth.

**Original use case:** Relative-change parameter nudges ("turn it up a touch", "a hair less drive") for conversational tone-building. Already implemented on AM4 using a wire-native primitive — Fractal action bytes 0x03 (INCR), 0x04 (INCR_COARSE), 0x05 (DECR), 0x06 (DECR_COARSE) — see `fractal-midi/src/am4/setParam.ts:32-35` and `packages/am4/src/descriptor/writer.ts:127-147`. One SysEx round-trip per nudge; the device decodes the action byte and applies a per-param quantum (fine ≈ ±0.01 display units, coarse ≈ ±0.1).

**Why not implemented elsewhere:**
- **Axe-Fx II:** No relative-change opcode appears in the published Fractal "Axe-Fx II MIDI for Third-Party Devices" PDF or in the AxeEdit binary opcode table mined Session 103. The II's wire vocabulary uses 0x02 SET_PARAMETER + 0x11 SET_BLOCK_CHANNEL + 0x1F GET_ALL_PARAMS; no INCR / DECR. Could exist as an undocumented opcode (Fractal historically hides primitives — see fn 0x28 enum-dump only mined Session 107) but no capture evidence yet.
- **Axe-Fx III:** Same situation, scaled. The v1.4 PDF defines fn 0x01 SET_PARAMETER as raw 16-bit write; no relative opcode documented. III owners using AxeEdit III could capture an editor-side nudge gesture to test if a hidden opcode exists.
- **Hydrasynth:** NRPN-based wire format is fundamentally different (no per-param opcodes, just CC + NRPN addressed by parameter number). A relative-change NRPN would require a Hydra-specific design; ASM's published spec covers absolute writes only.

**Resurrection instructions:**
- AM4 path is shipping (`registerParamTools` in `packages/core/src/protocol-generic/tools/params.ts`); reuses the dispatcher capability gate that returns `capability_not_supported` on II / III / Hydra.
- To enable II / III / Hydra parity: (1) capture an editor-side relative-change gesture via USBPcap + Wireshark with AxeEdit / AxeEdit III / Hydrasynth Manager running; (2) decode the captured bytes against the device's wire-format envelope; (3) if a relative-change opcode exists, add the wire builder to `fractal-midi/src/<device>/` and a `descriptor.writer.nudgeParam` implementation in `packages/<device>/src/descriptor/writer.ts`. The unified dispatcher picks it up automatically without a tool-shape change.
- Hardware-tasks entries to file: `HARDWARE-TASKS-AXEFX2.md` ("HW-NNN: capture AxeEdit relative-change nudge — drag amp gain knob slowly in AxeEdit, capture inbound bytes, decode action byte"), `HARDWARE-TASKS-AXEFX3.md` (same shape against AxeEdit III).
- Negative-finding fallback: if the capture proves no opcode exists (matching the cookbook negative-findings pattern), file `fractal-midi/docs/research/cookbook/_negative/<device>-no-relative-change.md` so a future agent does not re-attempt the same probe.

**Stability note:** AM4 implementation is shipping and wire-byte-verified. II / III / Hydra parity is a one-capture hypothesis (~5 min per device with hardware connected); no decode work in flight today.
