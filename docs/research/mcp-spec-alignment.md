# MCP spec alignment

How our tool surface lines up with the current Model Context Protocol
specification, the decisions we made about which spec features to adopt,
and what's left on the upstream side.

Last refreshed: **2026-05-19**. Spec revision compared against:
**[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)**
(current). Prior revision **2025-06-18** referenced in some source
comments. SDK version: `@modelcontextprotocol/sdk@1.29.0`.

## Why this doc exists

This is a multi-device MCP server (Fractal AM4, Axe-Fx II, Axe-Fx III,
ASM Hydrasynth, plus generic MIDI). The tool surface is a hybrid of:

- A **unified port-dispatched surface** (`set_param`, `get_param`,
  `apply_preset`, `port_preset`, `describe_device`, `list_params`,
  etc., 14 tools) where the agent picks a target via the `port`
  argument and one tool handles every registered device.
- A **device-namespaced surface** (`am4_*`, `axefx2_*`, `axefx3_*`,
  `hydra_*`, ~50 tools) where the wire semantics or response shape
  are device-specific enough that the unified contract would be
  lossy.

The spec's wording around dispatcher patterns, tool annotations,
structured output, and error envelopes is directly relevant to both
halves. This doc records what we found in late May 2026 research, what
we adopted, and what's still upstream-blocked.

## Spec changes since the codebase was last calibrated

Source comments in our codebase reference "the 2025 MCP spec" (most
explicitly in `packages/core/src/protocol-generic/tools/shared.ts` near
`asText`). That language predates the **2025-11-25** revision. The
two changes from **2025-06-18 → 2025-11-25** that affect us:

1. **SEP-1303** explicitly clarifies that input validation errors
   MUST be returned as Tool Execution Errors (`isError: true` on the
   result), NOT as JSON-RPC Protocol Errors. The rationale is exactly
   our pattern: only Tool Execution Errors carry enough actionable
   text to let an LLM self-correct and retry. This validates the
   bucket 4 + 5 approach (commit `9ca072b`, `23533d9`).
2. **Tasks (experimental, SEP-1686)** add `execution.taskSupport:
   "forbidden" | "optional" | "required"` on the Tool. Lets clients
   poll for long-running operations instead of holding the connection.
   Not yet exposed on the SDK's `registerTool` config object as of
   `@modelcontextprotocol/sdk@1.29.0`. Tracked upstream; see "Upstream
   gaps" below.

The third interesting addition — formal `outputSchema` and `Tool.icons`
— was already present in `2025-06-18`. We just hadn't adopted them.

## Tool annotations: what we set and why

The 2025-11-25 spec defines `ToolAnnotations`:

```ts
interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;        // default false
  destructiveHint?: boolean;     // default TRUE when readOnly=false
  idempotentHint?: boolean;      // default false
  openWorldHint?: boolean;       // default true
}
```

**Critical default behavior:** `destructiveHint` defaults to `true`.
Spec-honoring clients (Claude Desktop included) may add confirmation
prompts to any tool without explicit annotations. Until bucket 6,
every one of our reads (`list_params`, `get_param`, `scan_locations`,
`describe_device`, `lookup_lineage`, `am4_get_*`, etc.) was being
treated as potentially destructive. The clients still let calls
through because tool-annotation enforcement is advisory, not blocking,
but the UI signal was wrong.

Our convention going forward (all 65+ tools in bucket 6):

| Category | Example tools | Annotations |
|---|---|---|
| **Pure read** (no MIDI write) | `describe_device`, `list_params`, `list_midi_ports`, `lookup_lineage`, `find_compatible_types`, `scan_locations`, `am4_get_*`, `axefx2_get_*`, `axefx3_get_*`, `axefx3_status_dump`, `axefx3_list_blocks`, `axefx3_get_tempo`, `axefx3_get_looper_state`, `hydra_get_active_patch`, `am4_request_active_buffer_dump` (diagnostic probe) | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` |
| **Working-buffer write** (additive, reversible) | `set_param`, `set_params`, `set_block`, `set_bypass`, `switch_preset`, `switch_scene`, `rename`, `axefx2_set_block_channel`, `axefx2_set_block_at_cell`, `axefx2_set_cell_routing`, `axefx3_set_channel`, `axefx3_set_parameter`, `axefx3_set_tempo`, `axefx3_set_tuner`, `hydra_set_param`, `hydra_set_macro`, `hydra_navigate_to`, `hydra_apply_init`, `hydra_apply_init_to`, `axefx2_test_apply` | `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false` |
| **Destructive flash write** | `save_preset`, `restore_defaults`, `apply_setlist`, `apply_preset` (can save if `target_location` + `save_authorized`), `port_preset` (same), `hydra_apply_patch` (can save if `save:true`), `send_sysex` (arbitrary bytes) | `destructiveHint: true, idempotentHint: true, openWorldHint: false` (or `openWorldHint: true` for raw `send_*` primitives) |
| **Non-idempotent transient** | `play_note`, `play_chord`, `send_note`, `axefx3_tempo_tap`, `axefx3_set_looper`, `send_clock_start`, `send_clock_continue` | `destructiveHint: false, idempotentHint: false, openWorldHint: per-tool` |
| **Generic MIDI primitive** (unregistered device, open world) | `send_cc`, `send_program_change`, `send_nrpn`, `send_pitch_bend`, `send_channel_pressure`, `send_song_position`, `send_panic`, `send_reset_controllers`, `send_clock_stop` | `idempotentHint: true, openWorldHint: true` (target is unknown to us) |
| **Read-only diagnostic with destructive twin** | `axefx2_probe_sysex`, `axefx3_probe_sysex` (arbitrary SysEx, can write) | `destructiveHint: true, idempotentHint: false, openWorldHint: false` |
| **Connection-cache reset** | `reconnect_midi`, `axefx2_reconnect_midi`, `axefx3_reconnect_midi`, `hydra_reconnect_midi` | `destructiveHint: false, idempotentHint: true, openWorldHint: false` |

**Choices we made explicit (worth documenting because the call wasn't
obvious):**

- `apply_preset` is marked `destructiveHint: true` even though it's
  most commonly audition-mode. The runtime path can land in either
  audition or save mode depending on args; the safer client-hint
  posture is to assume it may save. Our `save_authorized` runtime
  gate is the actual enforcement; annotations are just the upfront
  signal.
- `axefx2_test_apply` is marked `destructiveHint: false` because the
  tool explicitly does NOT issue `STORE_PRESET` (writes are
  reversible by loading another preset).
- `send_sysex` is `destructiveHint: true` and `openWorldHint: true`
  because we have no way to know what arbitrary SysEx will do on an
  arbitrary target device. Caller-beware primitive.
- `send_note` / `play_note` are `idempotentHint: false`. Each
  invocation sounds a note; calling twice produces two notes, not
  one. The spec calls this "no additional effect" for idempotent,
  which `play_note` clearly does not satisfy.
- `openWorldHint: false` on registered-device tools, `true` on
  `send_*` primitives. Spec wording: "the world of a web search tool
  is open, whereas that of a memory tool is not." Our registered
  devices are bounded; the generic primitives can hit anything.

## structuredContent + outputSchema

The spec contract:

> Structured content is returned as a JSON object in the
> `structuredContent` field of a result. For backwards compatibility,
> a tool that returns structured content SHOULD also return the
> serialized JSON in a TextContent block. Tools may also provide an
> output schema for validation of structured results. If an output
> schema is provided, servers MUST provide structured results that
> conform to this schema.

**What we ship:**

- Every unified-surface tool returns `structuredContent` via the
  shared `asText()` helper (`packages/core/src/protocol-generic/tools/
  shared.ts`). Pre-bucket 4, the device-namespaced tools didn't —
  they hand-rolled `{ content: [...] }` only. Buckets 4 + 5 closed
  the gap on every tool we converted to use `asError`.
- Bucket 6 adds `outputSchema` (zod) to the tools with simple stable
  shapes:
  `axefx2_set_block_channel`, `axefx2_get_block_channel`,
  `axefx3_get_bypass`, `axefx3_set_channel`, `axefx3_get_channel`,
  `axefx3_set_parameter`, `axefx3_get_parameter`,
  `hydra_set_param`, `hydra_set_macro`, `hydra_navigate_to`,
  `am4_get_block_bypass`.
- **Deliberately NOT added `outputSchema`** on tools with rich /
  variable response shapes: `apply_preset`, `apply_setlist`,
  `apply_patch`, `axefx2_test_apply`, `describe_device`. These
  return many optional fields (chain_integrity, validation_info,
  warnings, etc.) and the spec requires the response to CONFORM
  to a declared schema. Premature commitment risks spec violations
  every time we add a return field. Revisit when the response
  shapes stabilize.

The mocked-agent test (`scripts/mcp-test-agent-retry-paths.ts`, 13
cases) exercises the full envelope: tools with `outputSchema` declared
get their responses validated by the MCP framework.

## Error envelopes — DispatchError + asError pattern

Validated by SEP-1303 (formalized in 2025-11-25).

```
Plain Error (legacy)              DispatchError (current)
        |                                 |
        |                                 v
        v                          + code: ErrorCode
   { message }                     + details:
                                       suggestion?: string
                                       valid_options?: string[]
                                       valid_options_tool?: string
                                       retry_action?: string
        |                                 |
        v                                 v
        +-------> asError(err) -----------+
                       |
                       v
              { content: [{text}], isError: true }
                       |
              text includes "Valid options: ..."
              and "Retry action: ..." inline
```

Our convention:

- **Unified-surface dispatcher** throws `DispatchError` everywhere
  (`packages/core/src/protocol-generic/dispatcher/`). The
  `executeApplyPreset` / `executeSetParam` etc. paths catch the
  underlying device-writer throws and re-emit them with index
  annotations.
- **Device-namespaced tools** post-bucket-4/5 wrap callbacks in
  try/catch + `asError`. Throws are either `DispatchError` (carries
  structured detail) or plain `Error` (text only). The shared
  `asError` helper duck-types `err.candidates` for plain-Error
  candidate lists, so legacy throws still get reasonable formatting.
- **Device writers** (`packages/<device>/src/descriptor/writer.ts`)
  throw `DispatchError` exclusively post-bucket-5. Plain Error
  throws in the writer were converted in commit `23533d9`.

The MCP framework forwards `isError: true` results to the model
(unlike Protocol Errors, which are typically squelched from the
model's view). This is the actual recovery path — the agent reads
the error message + `Valid options: ...` and retries with a verbatim
name. Without the inline text, the agent guesses.

## Dispatcher pattern — Toolhost validation

Our BK-051 unified surface (`set_param(port, block, name, value)`,
14 cross-device tools) is the
[**Toolhost pattern**](https://glassbead-tc.medium.com/design-patterns-in-mcp-toolhost-pattern-59e887885df3)
glassBead documents. Recipe:

- Consolidate >20 closely related tools behind a single dispatcher
  argument (in our case, `port`).
- Mitigate the loss of per-target visibility with a discovery surface
  (`describe_device(port)`) that returns capabilities, vocabulary,
  example specs, and concept-key mappings.

Concrete recommendations the article surfaces that we already do:

- `describe_device.example_spec` per device — a clone-able
  `apply_preset` payload literal. The Toolhost pattern calls this
  `list_mcp_assets`; same idea.
- `describe_device.concept_keys` cross-device alias map (BK-066).
  Cross-device alias resolution is the workaround for the schema-
  vagueness that comes with a single tool covering N targets.
- `describe_device.block_params_summary` — the per-device curated
  top-N knobs. Lets the agent skip the full param catalog walk for
  the 80% case.

What we don't do that's worth considering:

- **No `available_operations` field** on the dispatcher tools. We
  describe the unified shape in prose ("supports per-port dispatch
  to every registered device") but don't programmatically expose
  the list of operations. The Toolhost article suggests doing this
  via an annotation. **Decision: defer.** Our `tools/list` already
  surfaces every operation including the device-namespaced ones,
  so the agent has the same visibility either way.

## AWS prescriptive guidance — what we follow / skip

[AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-strategies/mcp-tool-strategy-organization.html)
on MCP tool organization:

| Rule | Status | Notes |
|---|---|---|
| Domain-noun-verb naming (`github_issue_create`) | ✅ followed | `am4_get_block_layout`, `axefx2_set_block_channel`, `hydra_apply_patch`. Unified surface uses noun-verb (`set_param`) with the domain implicit in `port` argument. Pattern intentional. |
| Soft upper-bound of 50 tools / server | ⚠ 65+ tools | We're over the soft cap. Most are pure-data discovery on the unified surface (`list_params` per device, `lookup_lineage` per device). The cognitive load on the agent isn't 65; the unified-surface description tells the agent "for any registered device, use this set of 14 actions." |
| Split servers by read/write | ❌ rejected | Would multiply install complexity for end users with mixed setups. Not worth the marginal gain. |
| Split servers by device | ❌ rejected | Same reason. |
| Conditional server loading | ❌ rejected | Out of scope for a local-machine MCP server; this is a hosted-agent strategy. |

## Upstream gaps (waiting for SDK / spec)

1. **`execution.taskSupport` not on `registerTool` config.** The
   `Tool` type in the 2025-11-25 spec carries `execution: { taskSupport
   }`, and the runtime SDK has a `ToolExecution` schema. But the
   helper `server.registerTool(name, config, cb)` config object does
   NOT accept `execution` as of `@modelcontextprotocol/sdk@1.29.0`
   (latest at the time of this writing, 2026-05-19). Verified by
   typecheck failure when trying to add it. **Workaround:** none;
   would require dropping to the lower-level Server API and constructing
   the Tool object manually. **Plan:** wait for SDK 1.30+, then add
   `execution.taskSupport: "optional"` to `apply_setlist` (the only
   tool that consistently > 30s wall time).

2. **`Tool.icons` not adopted.** SEP-973 in 2025-11-25 lets servers
   ship icons for display in clients. We have no icons today and no
   immediate need; could ship one per device family (AM4, Axe-Fx II,
   Axe-Fx III, Hydrasynth) for visual distinction. Cosmetic, not
   priority.

3. **`Annotations.audience` / `Annotations.priority` on content
   blocks.** The spec lets tool results tag content as
   `audience: ["user"]` vs `audience: ["assistant"]`. Could mark
   diagnostic prose (raw SysEx hex dumps in tool responses, ack
   counter detail) as `audience: ["assistant"]` only, so user-facing
   clients don't surface them. **Decision: defer.** Not all clients
   honor audience filtering yet, and our current text is dual-purpose.

4. **`Resource` / `resourceLink` content type.** Tools can return
   links to MCP resources. Could be useful for `describe_device` to
   point at a static device-spec resource instead of embedding all
   the prose inline. Currently inline is fine; revisit if
   `describe_device` payload grows.

## What landed in bucket 6 (this doc's reason for existing)

Commit summary (TBD when committed):

- 65+ tool registrations gained explicit `annotations` per the table
  above.
- 11 tools with stable simple structured-content shapes gained
  `outputSchema` (zod) so MCP clients can validate responses.
- One upstream gap identified for follow-up (`execution.taskSupport`
  on `apply_setlist` when SDK exposes the field).

Mocked-agent regression
(`scripts/mcp-test-agent-retry-paths.ts`) — 13/13 pass against the
dist server with annotations + outputSchema enforced. No behavioral
change for text-only clients; spec-honoring clients get richer signal.

## Sources

- [MCP spec 2025-11-25 — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP spec 2025-11-25 — Changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [MCP schema.ts — Tool / ToolAnnotations / CallToolResult](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts)
- [glassBead — Toolhost dispatcher pattern (Medium)](https://glassbead-tc.medium.com/design-patterns-in-mcp-toolhost-pattern-59e887885df3)
- [AWS Prescriptive Guidance — MCP tool organization](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-strategies/mcp-tool-strategy-organization.html)
- [TypeScript SDK — server.md (outputSchema + annotations)](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [ForgeCode — MCP 2025-06-18 spec update summary (covers SEP-1303 reasoning)](https://forgecode.dev/blog/mcp-spec-updates/)
