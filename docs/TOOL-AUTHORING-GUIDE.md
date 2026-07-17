# Tool Authoring Guide

**Last verified against MCP spec: 2026-05-31.** Current stable spec
revision is 2025-11-25 (live at <https://modelcontextprotocol.io/>). A
2026-07-28 revision exists as a release candidate; it is not stable, so
do not target it yet. Monitor it for breaking changes.

How to write a new MCP tool (or extend an existing one) that survives
agent interaction at production quality. This guide captures the
patterns the project has accumulated, plus the safety contracts the
codebase has learned the hard way.

Read this before adding a new tool to the unified surface or before
implementing a new device's writer/reader. It complements `CLAUDE.md`
(project conventions) and `docs/ARCHITECTURE.md` (system overview).

---

## Spec references and freshness

MCP is a young protocol (launched November 2024); both the spec and
the SDK evolve quickly. **The live spec at
<https://modelcontextprotocol.io/> and the
`@modelcontextprotocol/sdk` package are the source of truth, not
this guide.** This guide captures how those patterns are applied in
this project, plus the project-specific learnings on top.

### When to re-verify against the live spec

A future agent (or maintainer) should re-verify this guide against
the upstream MCP spec when any of these happen:

- An SDK upgrade (`@modelcontextprotocol/sdk` minor / major bump)
  introduces new tool annotations or response-shape fields.
- A new MCP capability lands upstream (resources, prompts, sampling,
  logging) that this project doesn't currently use.
- A tool annotation in our `verify-tool-annotations` test fails
  against a fresh SDK version.
- A new tool author reports the guide felt out of date.

When that happens, update the "Last verified against MCP spec" date
at the top, walk the spec sections below for changes, and revise the
guide entries that drifted.

### Sections most likely to drift

- **Idempotency annotations** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`): the spec may add new hint
  fields. Cross-check against the `Tool` interface in the SDK's
  `types.ts` after every SDK bump.
- **Response shape**: `structuredContent` is the field this project
  relies on for structured tool responses. The spec may add new
  envelope fields (annotations, citations) we'd want to surface.
- **Error envelope**: `isError: true` + `content` is the current
  pattern. Spec may evolve toward structured error codes (the SDK
  already supports `ErrorCode` enum on the McpError class).
- **Capability declarations**: server-side capabilities advertised
  during `initialize`. Project doesn't use most of these today;
  watch for additions that would benefit a hardware-MIDI surface
  (e.g., long-running operations, partial-result streams).

### What this project explicitly relies on

When auditing for drift, these are the project's load-bearing MCP
features:

| Feature | Why this project uses it | Where it lives |
|---|---|---|
| `server.registerTool` | Every tool registered via the SDK's tool builder | `packages/core/src/protocol-generic/tools/*.ts` |
| Tool annotations | Drives agent retry/safety heuristics | All `server.registerTool({annotations:...})` calls |
| `structuredContent` | Machine-readable tool responses for agent regression | `asText` helper in `tools/shared.ts` |
| `isError + content` | Structured error surface with retry_action hints | `asError` helper, `DispatchError` throws |
| `StdioClientTransport` | Test infrastructure spawns the server via stdio | `scripts/mcp-test-*.ts` |

If an SDK upgrade breaks any of these, the project breaks. Re-verify.

### What this project explicitly does NOT use yet

Watch for upstream advances we could adopt:

- **Resources** (`server.registerResource`). Used today for `guidance://`
  per-device docs + `lineage://` corpora, but ONLY as a human-pin
  surface (Claude Code `@`-completion). The agent does not auto-read
  resources; see "Tools vs resources, what we learned" below before
  adding any model-consumed resource.
- **Prompts** (`server.registerPrompt`). Pre-built tone-shaping
  prompts could ship as MCP prompts rather than embedded in agent
  guidance.
- **Sampling** (`server.createMessage`). Server-side LLM calls; not
  applicable to this surface.
- **Logging** (`server.sendLoggingMessage`). Live device-status
  streaming during apply_preset would benefit from structured
  logging.
- **Progress notifications + Tasks**. Evaluated empirically 2026-05-22
  against Enter Sandman traces; deferred. Notifications fire DURING a
  tool call, but the 76-85% of wall time in our slow cases is silent
  model planning between tools, where notifications don't help. The
  2026-07-28 RC moves Tasks out of core into an extension, so adopt
  only after that extension stabilizes.

---

## Tools vs resources, what we learned

**Tools are model-controlled; resources are application-driven.**
This is spec language and we verified it empirically.

### The empirical study (2026-05-22)

Counts across our agent-regression traces + Claude Desktop production
logs:

- **176** `lookup_lineage` tool calls vs **0** `resources/read` calls
  across 104 traces.
- **27** `lookup_lineage` tool calls vs **0** `resources/read` calls
  in Claude Desktop production logs.
- One experiment shipped a `resource_link` content item in a tool
  result pointing at `lineage://am4/amp`. The agent received text
  saying `[Resource link: amp lineage corpus] lineage://am4/amp` and
  did NOT issue a `resources/read`. The `claude -p` client serialized
  the structured `resource_link` to plain text before the model saw
  it; the agent never had the chance to follow it.

The 2025-11-25 spec (`server/resources`) confirms the design intent:
*"Resources in MCP are designed to be application-driven, with host
applications determining how to incorporate context based on their
needs."* Claude Code's docs say resources are *"automatically fetched
and included as attachments when referenced"*: that is, the **user**
references them via `@`, the model doesn't auto-discover.

### Implications for tool design

- **For data the model consumes**, build a tool. Tools are the
  model-controlled surface; the agent invokes them autonomously.
- **For docs a human pins** (per-device guidance, lineage corpora as
  human-readable references), a resource is fine. The 54 `guidance://`
  resources we register today have this use case.
- **Do NOT mix the two**. Don't expose lineage as both a tool and a
  resource expecting the agent to choose. Empirically the agent uses
  the tool 100% of the time and ignores the resource.
- **Do NOT extend `lineage://` with new model-consumed corpora**. The
  existing resource is back-compat scaffolding for human pinning.
  Adding more for model consumption is dead-end work.

---

## Surface choice

**Unified surface is the default.** New tools go on the port-dispatched
`set_param` / `get_preset` / etc. family in
`packages/core/src/protocol-generic/`. The device-namespaced tools
(`am4_*`, `axefx2_*`, `hydra_*`) have been removed; do not add new ones.
Synth-voice tools live in the voice class (`apply_patch`, `init_patch`,
`set_macro`, `set_macro_route`, `set_mod_route`, `set_system_param`).

To add a tool:
1. Add the optional method to `DeviceReader` or `DeviceWriter` in
   `packages/core/src/protocol-generic/types.ts`.
2. Add the executor (`executeXxx`) in `dispatcher/<family>.ts` with a
   capability check that throws `capability_not_supported` when the
   device descriptor omits the method.
3. Re-export the executor from `dispatcher.ts`.
4. Register the MCP tool in `tools/<family>.ts`.
5. Implement the method on each device descriptor that supports it.

---

## Display-first contract

The MCP surface accepts and returns **display units**: knob 0..10, dB,
ms, percent, enum names. Wire-format details (septet-encoded 14-bit
ints, Q15 packed values, packed-float bytes, sliding-window packing)
are internal. They do not leak through tool I/O.

- Error messages use display shape: `"amp.gain out of range [0..10]: 12.5"`,
  not `"wire value 0x4800 invalid"`.
- Param descriptions reference display units only: "1% of full range"
  not "66 of 65534 internal ticks".
- Enum responses surface the device's display label, not the wire index.

Display to wire coercion happens once at the tool boundary via
`resolveValue` / `resolveEnumValue` / per-param `encode`/`decode`
closures. Everything below the tool layer takes wire and is type-checked
against it.

---

## Tempo-first

Time-based params (delay time, modulation rate, LFO time) default to
tempo-sync where the device supports it, so a value tracks the song
tempo rather than a fixed millisecond figure. This is advisory, not a
hard gate: a tool may still accept an absolute time, and the caller can
opt out of sync. When a tool exposes a time param, document whether it
syncs and how the caller overrides it.

---

## Safety: refuse, don't misroute

When a device-level quirk would cause a silent misroute (write lands at
the wrong register, or reads back the wrong field), **refuse with a
structured `DispatchError` and a `retry_action` pointing at the safe
alternative**. Do not silently misroute; the wire ack does not mean
audible effect.

Examples in the codebase:
- AM4 AMP slot has no bypass register (pidHigh=0x03 is BOOST).
  `set_bypass(amp)` refuses with a clear redirect to
  `set_param(amp, master, 0)` or `set_param(amp, boost)`.
- Axe-Fx II channel pointer is shared across scenes. When
  `set_param` is called with explicit `channel` ≠ active channel, the
  writer refuses with a `switch_scene` redirect rather than silently
  corrupting other scenes' channel state.
- AM4 type-knob silent no-op: many `block.type` values gate which knobs
  are exposed. `apply_preset` calls `find_compatible_types` upfront to
  refuse incompatible (type, knob) combinations before sending wire.

When implementing a new device or capability, ask:

> "Is there a case where the wire layer will accept my write but the
> audible effect will not match the user's intent?"

If yes, add a refusal gate with a `retry_action`. Tests for these gates
live in `scripts/mcp-test-agent-retry-paths.ts`.

---

## Source-of-data contract: working buffer vs stored preset

Every tool that reads, dumps, or restores preset data MUST state which
source it actually touched: the ACTIVE WORKING BUFFER (edit RAM) or a
STORED preset slot (flash), and the claim must be derived from the wire
operation's PROVEN semantics, never from the tool's intent. The two
diverge exactly when the user has unsaved edits, which is exactly when a
backup matters most: claiming "active working buffer" while dumping flash
turns the backup feature into the data-loss scenario it exists to prevent
(shipped bug, caught live 2026-06-10 on the Axe-Fx II; fixed the same day
when a probe confirmed the II accepts the AM4-style edit-buffer sentinel).

Per-device dump-request semantics (the wire ops behind `export_preset` /
`get_preset(location)` / `import_preset`), all hardware-confirmed:

| Device | Edit-buffer dump | Stored-slot dump |
|---|---|---|
| AM4 | fn 0x03 + sentinel `7F 7F 00` | fn 0x03 + `[bank, sub, 0x00]` (no buffer side effect) |
| Axe-Fx II | fn 0x03 + sentinel `7F 7F` (tracks live edits, no side effect, round-trips) | fn 0x03 + `[hi, lo]`. **CAUTION: reloads the stored preset over the working buffer.** Not exposed as a tool path for this reason. |
| Gen-3 (III/FM3/FM9/VP4) | fn 0x43 (edit-buffer dump) | fn 0x03 + preset# |
| Gen-1, Hydrasynth | not implemented (capability_not_supported) | not implemented |

Rules when authoring or changing one of these paths:

1. The response's `source` field describes the wire op that ran, in
   buffer/stored vocabulary. Never write "active working buffer" unless
   the request provably targets the edit buffer (sentinel or dedicated fn).
2. Live reads (`get_preset` with no location, `get_param`) read the
   working buffer on every device; stored-location reads must say
   "stored" in their response.
3. A new device's reader doesn't ship `dumpActivePresetBinary` until the
   buffer-vs-stored question is answered with evidence for ITS dump
   request. "The request returned plausible bytes" is not that evidence:
   rename/edit the buffer first, dump, and check WHICH version came back
   and whether the buffer SURVIVED the request (the II's slot-addressed
   dump request silently reloads flash over the buffer).
4. Byte-exact dump comparisons need a volatile-bytes mask on some
   devices (the AM4 dump drifts in a fixed offset cluster between
   identical dumps; see the AM4 preset-dump research note).

---

## Capability discoverability

Capabilities are advertised via `describe_device(port).capabilities`.
Agents branch on these flags before calling tools.

**Set explicit booleans on every device**, not undefined. Asymmetric
flag presence (some devices set the field, others omit it) forces
agents into "missing means false" guessing. Add `false` explicitly when
a device doesn't support a capability so the surface stays symmetric.

Capabilities currently defined (`DeviceCapabilities` in `types.ts`):
- `slot_model`: `'linear'` (AM4, Hydra) or `'grid'` (II, III)
- `has_scenes`, `scene_count`: scene model
- `has_channels`, `channel_names`, `channel_blocks`: channel model
- `supports_save`, `supports_lineage`: feature flags
- `atomic_read`: whether `get_preset` is implemented
- `has_macros`: macro support

When adding a capability, set it on every existing device descriptor
explicitly (true or false), then enforce it via the descriptor type.

---

## Response shape: snapshot vs spec

When a tool returns state that mirrors an input shape (e.g.
`get_preset` returns a PresetSpec-like envelope), **use a distinct type
name** so callers can statically distinguish snapshot from spec.

Why: `apply_preset` has FRESH-BUILD CLEARING semantics (unlisted slots
clear, unlisted scenes reset). If `get_preset` returns `PresetSpec`,
agents naturally feed the response back to `apply_preset` and reset
scenes/routing they didn't intend to touch.

Pattern:
- `PresetSpec` = write-side input. `apply_preset` takes this.
- `PresetSnapshot` = read-side output. `get_preset` returns this.
- Snapshot carries the same structural fields PLUS read metadata
  (`_meta` envelope with device label, timestamp, partial-info flags;
  `active_scene`, per-slot `channel_status`).
- The `_meta` envelope is **structurally distinct** so the spec
  shape can be extracted by dropping `_meta` / `active_scene` /
  `channel_status`.

Document in the tool description: "DO NOT feed the whole response into
apply_preset; use set_param / set_params for targeted edits."

---

## Error contract (SEP-1303)

The 2025-11-25 spec formalized two distinct error paths and the
project follows both:

1. **Input validation / agent-correctable failures** return a normal
   tool response carrying `{ok: false, validation_errors[]}` (or
   equivalent). The model sees the same envelope shape as a success
   and self-corrects on the next turn. Used by `apply_preset` for
   preflight failures (unknown block, out-of-range value, alias miss),
   batch operations for per-entry failures, etc.

2. **Operational / capability failures** throw `DispatchError` inside
   the tool body. The shared `asError()` helper at
   `packages/core/src/protocol-generic/tools/shared.ts` catches and
   shapes them into `{isError: true, content: [text]}` per SEP-1303.
   The structured `suggestion` / `valid_options` / `valid_options_tool`
   / `retry_action` fields on the DispatchError surface as actionable
   text the agent can follow on retry.

**Never throw plain `Error`** from a tool body. The MCP SDK turns
unwrapped throws into JSON-RPC `-32603` Internal Error, which gives
the agent no actionable info. Always either:
- Return `{ok: false, validation_errors}` (correctable input), or
- Throw `DispatchError(code, device, message, {suggestion, ...})`
  and let `asError()` shape it.

Use `isError: true` for: bad input (zod parse failure outside the
schema layer), unknown enum values, capability gaps, alias-resolution
misses. Use JSON-RPC errors only for protocol-level failures
(malformed envelope, unknown tool name), and even those, prefer
catching at the tool boundary.

---

## outputSchema + structuredContent

Declare `outputSchema` for tools whose return shape matters to the
model's plan-of-attack. The model uses the schema BEFORE invoking the
tool, which improves first-call accuracy.

Pattern:
```ts
server.registerTool('apply_preset', {
  annotations: { ... },
  description: '...',
  inputSchema: { ... },
  outputSchema: {
    ok: z.boolean(),
    steps: z.number().int(),
    duration_ms: z.number(),
    validation_errors: z.array(validationErrorShape).optional(),
    // ...
  },
}, async (args) => { ... });
```

Pair with `structuredContent` (the shared `asText()` helper at
`packages/core/src/protocol-generic/tools/shared.ts` already emits it
for plain-object payloads). The spec also requires a `TextContent`
block carrying the JSON string for backwards compatibility, and
`asText()` ships both.

Hand-roll outputSchema to match the actual return shape; don't
hand-wave with `z.unknown()`. The schema is a contract the model
reads to plan how to use the result.

---

## Recipe surface

For tone-building tools that bundle multiple decisions
(`apply_preset`-style), prefer per-device recipe registration over
inlining the data in `describe_device`. Recipe authoring has its own
guide: `docs/RECIPE-AUTHORING-GUIDE.md`.

Pattern:
- Recipe data lives in `packages/core/src/protocol-generic/recipes/`
  per family (block_stack, auto_wah, pitch for guitar devices;
  patch-archetype for the Hydrasynth).
- `recipe_id` rides BOTH apply tools: `apply_preset` (guitar devices)
  and `apply_patch` (Hydrasynth). Both accept `recipe_id` + `overrides`.
  The dispatcher materializes recipe + overrides into a normal spec
  before preflight, so all existing gates (type-knob applicability,
  phantom-param, channel-Y inactive on guitar; range and routing checks
  on synth) still fire.
- `describe_device.recipes[]` ships SLIM for block_stack: id, family,
  description, slot_count, target_blocks, signature_params. Full
  slots are materialized server-side via `recipe_id`. Single-block
  recipes (auto_wah, pitch, wah, filter) stay inline: they're
  small and the agent needs the params directly.
- The response's `applied_spec` field echoes the spec the writer
  consumed (recipe + override merge resolved). The agent confirms
  what landed without a follow-up get_preset call.

Empirical motivation: most of the agent wall time in multi-scene
preset builds was silent compose-thinking between the last
lookup_lineage and apply_preset (measured from production traces).
Recipes short-circuit the compose phase by giving the agent a curated
starting point.

### What we tried and dropped: `dry_run`

The initial migration shipped `dry_run: true` as a "preview the
materialized spec without writing" affordance. It was removed after a
hard look:

- On the preflight-fail path, dry_run and committed apply are bit-
  identical in cost. Preflight returns errors before the writer
  runs either way; no wire writes, no cache invalidation, no gate
  evaluation.
- On the preflight-pass path, the only unique behavior was
  surfacing `applied_spec`. We now surface that field on committed
  applies too, so the affordance moved to the always-on path.
- An agent reaching for dry_run to inspect what a recipe contains
  is a smell that the recipe discovery surface is incomplete.
  Better fix is to grow `describe_device.recipes[]` self-
  description (`signature_params`, `target_blocks`, source notes)
  so the agent never needs to write-to-inspect.
- Smaller tool surface = better first-call accuracy.

Batch tools (if reintroduced) may keep their own `dry_run` with
different semantics (short-circuiting per-entry navigation + save
loop, validating the whole batch up front).

`signature_params` on each block_stack recipe is REQUIRED: a
hand-authored Record<string, number | string> of the 2-4 most
distinctive enum picks per device. Validated at CI
(`verify-recipe-tables.ts`) to be a subset of `slots_per_device`'s
authored values; drift fails the build.

---

## Performance characterization

CLAUDE.md performance budget:

- **Ideal: < 200 ms** per tool call (single set_param, set_block, etc.).
- **Acceptable: < 1 s** for tools that make 2-5 wire transactions.
- **Requires explicit progress: > 1 s** must announce upfront.
- **Avoid: > 5 s** in a single conversational turn.

Tool descriptions must include performance characterization:

> "Performance: ~1.5 to 2 s on Axe-Fx II for a typical 12-block preset.
> Announce the wait to the user before calling."

For tools that exceed 1 s, the description should suggest the agent
tell the user ("reading what you have, about 2 seconds") so the user
doesn't think the agent stalled.

**Live-measure performance numbers, don't extrapolate.** When a tool
description carries a wall-time number, the number must come from a
live measurement on real hardware (logged via `live-regression-*` or
similar). Estimates extrapolated from probe scripts skew pessimistic
and undermine agent confidence in the surface. Real example:
`get_preset` was once documented at 1.5 to 2 s based on worst-case
probe data; live measurement showed ~420 ms for a typical 11-block
preset on Q8.02. Always update the description after the first
hardware-validation pass.

---

## The guidance field must know about the feature you just added

**Named pitfall, cost a review to catch (2026-07-17).** When a result carries a
"what do I do next" field (`next_step`, `retry_action`, a fit note), that field is
the contract for steering the agent. It is computed in the same function as the
feature, by different code, and it silently rots the moment the two disagree.

The case: `import_songsterr whole_song` gained `project_plan` (a song chunked into
device-sized projects) attached exactly when the song does not fit one project. But
`next_step`'s "does not fit" branch was untouched and still said *"raise fuzz to
merge more, or arrange a sub-span with from_measure/to_measure"* — the two lossy
workarounds `project_plan` was built to replace. So **the exact condition that
computed the feature also told the agent to do the old thing instead.** An agent
reading `next_step` literally (which is its documented contract) would never
discover the plan sitting beside it in the same response.

Nothing failed. Tests passed, the field was populated, and the shape was correct.
It was invisible precisely because both halves were individually right.

The rule: **when you add a field, grep the result's guidance text for the condition
that gates it.** If a branch of `next_step` fires under the same predicate as your
new field and does not mention it, that branch is now wrong. Same applies to
`retry_action` on an error whose remedy you just changed.

Corollary: a feature that is only discoverable AFTER calling the tool is
half-shipped. Declare an `outputSchema` (see above) so the model can plan around
the shape before it calls, rather than learning it from the response.

## Agent guidance for tool use

The unified tool descriptions stay focused on the tool's mechanics.
Behavioral guidance about WHEN and HOW to use the tool lives in
`describe_device(port).agent_guidance`, keyed by topic.

Examples:
- `state_anchoring`: when to call `get_preset` vs `get_param` vs
  `get_params`, what the response means, post-write validation.
- `save_intent_required`: how to interpret user vocabulary for
  save-vs-audition.
- `channel_model`: per-device channel semantics + the cross-scene
  channel-write hazard.
- `relative_change`: how to handle "a touch more", "a bit less"
  language (guides the agent through `get_param` + `set_param`
  read-modify-write).

Add a new guidance key when:
- A tool has multiple correct invocation patterns and the choice
  depends on user vocabulary or device state.
- A pattern emerges across multiple tools (read-mutate-write,
  post-write validation, etc.).

Each guidance entry should answer: "Given this user phrase, which
tool do I call, with what shape, and what do I do with the response?"

---

## WriteResult shape

Every write tool returns a `WriteResult` envelope (see
`packages/core/src/protocol-generic/types.ts`). The fields:

```ts
interface WriteResult {
  op?: string;           // 'set_param', 'switch_preset', etc.
  target?: string;       // 'amp.gain', 'M03', etc.
  acked: boolean;        // wire-level ack received
  info?: string;         // routine post-success advisory text
  warning?: string;      // genuine "something is off" or no-ack diagnostic

  // param-write specific (only set_param family)
  block?: string;
  name?: string;
  wire_value?: number;
  display_value?: number | string;
  channel?: string;
}
```

### `info` vs `warning`

- **`info`** is for routine, post-success advisory text: "switched to
  Z03, any unsaved buffer edits were discarded", "amp.gain +1 fine
  step, now at 4.51". Calls succeeded; this is helpful context for
  the agent to summarise back to the user.
- **`warning`** is for genuine concerns: no-ack timeouts, partial-
  failure cases, soft-fails where the wire acked but the side effect
  may not have landed. The agent should surface warnings to the user
  before claiming success.

Don't pad `info` with static facts (e.g. "Two toggles return to the
original state") that don't depend on the call result. That bloats
the agent's context window across repeated calls. Put static guidance
in the tool description or in `agent_guidance` instead.

### When to populate `wire_value` + `display_value`

Two cases:
1. **Relative writes** where the agent can't compute the target value
   client-side. A hypothetical `nudge_param`-style tool (removed,
   but the pattern still applies to future tools) sends a relative
   delta and the response carries the new value so the agent can
   confirm to the user without a follow-up `get_param`.
2. **Toggle-style writes** where the response carries post-state.
   `set_bypass` reports `display_value: 'bypassed'` or `'active'`
   from the bypass flag in the ack response.

For absolute writes (`set_param(x, 5)`), the new value is exactly
what the agent passed; `wire_value` is mostly redundant but harmless
to populate for symmetry.

### Decoding values from acks

The shape of the wire ack varies per opcode family. AM4 has three
predicate-distinct ack shapes:

- `isCommandAck` (18 bytes): addressing-only echo (save, rename).
  Carries no value; just confirms the command landed.
- `isWriteEcho` (64 bytes, hdr4=0x28, action=0x01): SET_PARAM /
  placement / scene-switch echo. The first 4 raw payload bytes are
  the param's new wire value, encoded as u32 LE.
- `isNudgeOrToggleAck` (64 bytes, hdr4=0x28, action echoes outgoing):
  INCR/DECR/SET_NORM/TOGGLE echo. Same layout as isWriteEcho except
  the action byte echoes the request action (0x03/0x05/0x07/etc)
  rather than the canonical WRITE 0x01. For continuous params (nudge
  on amp.gain) the u32 at bytes 16-20 carries the new value. For
  toggle_bypass, the U32 at 16-20 is the param's underlying register
  value (often unrelated to bypass state); the bypass FLAG is at
  byte 22 (`LONG_READ_BYPASS_FLAG_BYTE`), 0x01 = bypassed,
  0x00 = active. Always read byte 22 for bypass direction.

When implementing a new ack decode, capture a sample response from
hardware FIRST, then decode against the capture. Don't extrapolate
from related opcodes; ack shapes can carry different fields at the
same offsets.

### Round-trip normalization

AM4 wire values are u32 LE encoding `internal × 65534`. To decode
to display via the schema's `decode(param, internalFloat)`, divide
the u32 by `READ_VALUE_DENOMINATOR` (65534) FIRST. Forgetting this
is how a wire value of 29556 (display 4.51) decodes to 295560 instead
of 4.51: the decode function takes the normalized [0,1] internal
float, not the raw u32. (Live-caught during `get_preset` development;
the lesson is why this section exists.)

---

## Idempotency annotations

Every tool registration declares behavioral hints:

```ts
annotations: {
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
}
```

- `readOnlyHint: true` for read-only tools (`get_param`, `get_preset`,
  `list_params`, `describe_device`, `scan_locations`).
- `destructiveHint: true` for tools that persist state to flash
  (`apply_preset` with `save_authorized: true`, `save_preset`).
- `idempotentHint: true` when calling the tool twice with the same
  args lands in the same final state. `set_param(x, 5)` is
  idempotent. A relative-delta tool or a toggle-style tool would NOT
  be (each call shifts/flips state). Mark accordingly.
- `openWorldHint`: usually false for hardware tools.

The verify-tool-annotations script in CI rejects unannotated tools.

---

## Wire-byte goldens

Every new wire envelope needs a byte-exact golden in
`scripts/verify-msg.ts`. Pattern:

```ts
{
  label: 'buildNudgeParam(amp.gain, incr, fine): MESSAGE_INCR @ AMP.GAIN',
  built: buildNudgeParam(KNOWN_PARAMS['amp.gain'], 'incr', 'fine'),
  expected: 'f000017415013a000b0003000000000023f7',
}
```

The `expected` hex is derived once from a captured wire frame and then
becomes the regression bar. When the builder's output drifts from the
golden, the test fails loudly. This is the single best guard against
septet-encoding bugs in 14-bit fields.

For new device opcodes, source the golden from a hardware capture in
`samples/captured/` and cite the file path in a comment.

---

## End-to-end regression: mocked-agent retry paths

`scripts/mcp-test-agent-retry-paths.ts` spawns the shipped server with
`MCP_MOCK_TRANSPORT=1` and drives end-to-end MCP tool calls. Use this
for:

- Capability gating (does `tool(port: unsupported)` return
  capability_not_supported with a retry_action?)
- Refusal gates (does the safety check trip on the bad input?)
- Success paths (does structuredContent come back well-formed?)
- Vocabulary-recovery hints (does the error name a `valid_options`
  list?)

Each device's `midi.ts` carries a mock responder (`mockAxeFxIIConnection`,
`am4MockResponder`, etc.). When adding a tool that does a new read,
extend the mock to synthesize the response shape so the regression can
exercise the read path without hardware.

---

## No-em-dash convention

Em dashes (U+2014) and en dashes (U+2013) are AI tells and don't appear
in the project's prose. Substitute commas, parens, periods, or sentence
restructuring depending on flow. Applies to:

- Tool descriptions (agent-facing strings)
- Agent guidance entries
- Code comments
- Commit messages
- Markdown docs (this guide intentionally avoids them)

`scripts/verify-no-internal-refs.ts` catches internal session/ticket
references in agent-visible strings; it does not catch em dashes (yet).
Manual review applies.

---

## Internal references in agent-visible strings

`scripts/verify-no-internal-refs.ts` rejects internal session-log,
hardware-task, and backlog references (the project's own ticket
identifiers) in tool descriptions and `agent_guidance` strings. The
agent doesn't care about your session log; cite via the user-facing
phenomenon ("hardware-verified on AMP.GAIN") not the internal ticket.

JSDoc comments (`/** ... */`) and `// line comments` may reference
internal IDs freely. Only `description:`/`agent_guidance` string
literals trip the lint.

---

## Test infrastructure summary

Run before every commit:

```
npm run preflight
```

Chains:
- `npm run typecheck` (per-package strict typecheck)
- `npm test` (verify-pack + verify-msg + verify-transpile + many
  per-device suites)
- `npm run verify-no-internal-refs`
- `npm run coverage-audit` (catalog vs params.ts vs verify-msg coverage)
- `npm run coverage-cross-ref-audit` (drift guard on mislabeled wire entries)

After changes to `packages/core/src/`, run:

```
npm run build --workspace=@mcp-midi-control/core
```

before `npm run preflight` so per-package typechecks see the new types.

---

## Common pitfalls (learned the hard way)

1. **Don't trust the wire ack as audible confirmation.** Many AM4 /
   II / III writes ack regardless of whether the device applied the
   change (type-gated params silently no-op; block not placed; AMP
   bypass routes to boost). The agent must verify via read-back when
   it matters.

2. **Don't WebFetch for protocol docs the project already has.**
   Check `docs/REFERENCES.md` and per-device `SYSEX-MAP.md` files
   first. Most common questions are answered by a local PDF
   extracted to `.txt` for grep-ability.

3. **Don't propose hardware captures before exhausting hardware-free
   lanes.** Check `docs/devices/captures-inventory.md` for existing
   captures, then try Ghidra mining of the editor binaries (~30 min
   wall time for full opcode-table dumps). Hardware capture asks
   should answer at least 5× more questions than existing-capture
   inspection + Ghidra mining would.

4. **Don't assume opcode bytes are portable across model bytes.**
   Each Fractal device family has its own envelope decode. AM4's
   `0x77` save envelope is inert on Axe-Fx II XL+ (confirmed via
   hardware probe). Decode per-device.

5. **Don't ship a tool description that claims round-trip safety
   without verifying.** The structural symmetry between `get_preset`
   output and `apply_preset` input is partial (no scenes, no
   routing). Make the limit explicit.

6. **Don't add a new device-namespaced tool.** The device-namespaced
   surface has been removed. The unified surface is the only live
   contract. New tools register there.

---

## Reference: tool surface ledger

| Tool family | File | Tools |
|---|---|---|
| Discovery | `tools/discovery.ts` | describe_device, list_params, lookup_lineage, find_compatible_types |
| Params | `tools/params.ts` | get_param, set_param, get_params, set_params |
| Layout | `tools/layout.ts` | set_block, set_bypass |
| Navigation | `tools/navigation.ts` | switch_preset, save_preset, switch_scene, scan_locations |
| Preset | `tools/preset.ts` | get_preset, apply_preset, translate_preset |

Device-namespaced tools (`am4_*`, `axefx2_*`, `axefx3_*`, `hydra_*`)
have been removed from the registered surface. Code is preserved in
`packages/<device>/src/tools/` for reference; the unified surface is
the sole live contract.
