# MCP spec alignment

How the tool surface lines up with the current Model Context Protocol
specification, the decisions made about which spec features to adopt,
and what is left on the upstream side.

**Last refreshed:** 2026-05-31. Spec revision compared against
**[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)**,
the current stable revision. A 2026-07-28 revision exists as a release
candidate; it is not stable, so this document targets 2025-11-25.

## Why this doc exists

This is a multi-device MCP server (Fractal AM4, Axe-Fx II, Axe-Fx III,
ASM Hydrasynth, plus generic MIDI). There is one tool surface, the
unified port-dispatched surface plus the voice-class, generic-MIDI, and
utility tools. The agent picks a target via the `port` argument and one
tool handles every registered device.

The earlier design also shipped a **device-namespaced surface**
(`am4_*`, `axefx2_*`, `axefx3_*`, `hydra_*`) for cases where the wire
semantics or response shape seemed device-specific enough that a unified
contract would be lossy. That surface has been **removed**. The unified
surface absorbed every case, and the device-namespaced tools are no
longer registered. Any doc or transcript that tells a caller to invoke
`axefx3_get_preset_name`, `hydra_apply_patch`, and the like is stale;
the real calls are the unified tools with the appropriate `port`, or the
voice-class `apply_patch` for the Hydrasynth.

The spec's wording around dispatcher patterns, tool annotations,
structured output, and error envelopes is directly relevant to the
unified surface. This doc records what we found, what we adopted, and
what is still upstream-blocked.

## Tool surface size

The server registers **38 tools** in four groups:

- **Unified surface (17 tools):** `describe_device`, `list_params`,
  `get_param`, `set_param`, `get_params`, `set_params`, `set_block`,
  `set_bypass`, `get_preset`, `apply_preset`, `translate_preset`,
  `switch_preset`, `save_preset`, `switch_scene`, `scan_locations`,
  `lookup_lineage`, `find_compatible_types`. Port-dispatched and
  device-agnostic.
- **Voice class (6 tools):** `apply_patch`, `init_patch`,
  `set_system_param`, `set_macro`, `set_macro_route`, `set_mod_route`.
  Synth patch and routing tools.
- **Generic-MIDI primitives (13 tools):** `send_cc`, `send_note`,
  `send_chord`, `send_sequence`, `send_program_change`, `send_nrpn`,
  `send_sysex`, `send_panic`, `send_song_position`,
  `send_reset_controllers`, `send_clock_start`, `send_clock_stop`,
  `send_clock_continue`. These reach any USB MIDI device.
- **Utilities (2 tools):** `list_midi_ports`, `reconnect_midi`.

## Spec changes worth tracking

The two 2025-11-25 changes that affect us:

1. **SEP-1303** clarifies that input validation errors MUST be returned
   as Tool Execution Errors (`isError: true` on the result), NOT as
   JSON-RPC Protocol Errors. The rationale matches our pattern: only
   Tool Execution Errors carry enough actionable text to let an LLM
   self-correct and retry.
2. **Tasks (experimental, SEP-1686)** add `execution.taskSupport:
   "forbidden" | "optional" | "required"` on the Tool, letting clients
   poll for long-running operations instead of holding the connection.
   Not yet exposed on the SDK's `registerTool` config object; tracked
   under "Upstream gaps" below. The 2026-07-28 RC moves Tasks out of
   core into an extension, so adopt only after that extension
   stabilizes.

Formal `outputSchema` and `Tool.icons` were already present in the
2025-06-18 revision; we adopted `outputSchema` and not icons.

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
prompts to any tool without explicit annotations. Without annotations,
every one of our reads (`list_params`, `get_param`, `scan_locations`,
`describe_device`, `lookup_lineage`) would be treated as potentially
destructive. Clients still let calls through because tool-annotation
enforcement is advisory, not blocking, but the UI signal was wrong.

Every registered tool now carries explicit annotations:

| Category | Example tools | Annotations |
|---|---|---|
| **Pure read** (no MIDI write) | `describe_device`, `list_params`, `list_midi_ports`, `lookup_lineage`, `find_compatible_types`, `scan_locations`, `get_param`, `get_params`, `get_preset` | `readOnlyHint: true, idempotentHint: true, openWorldHint: false` |
| **Working-buffer write** (additive, reversible) | `set_param`, `set_params`, `set_block`, `set_bypass`, `switch_preset`, `switch_scene`, `apply_patch` (audition), `init_patch`, `set_macro`, `set_macro_route`, `set_mod_route`, `set_system_param` | `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false` |
| **Destructive flash write** | `save_preset`, `apply_preset` (can save with `target_location` + `save_authorized`), `send_sysex` (arbitrary bytes) | `destructiveHint: true, idempotentHint: true, openWorldHint: false` (or `openWorldHint: true` for raw `send_*` primitives) |
| **Non-idempotent transient** | `send_note`, `send_chord`, `send_sequence`, `send_clock_start`, `send_clock_continue` | `destructiveHint: false, idempotentHint: false, openWorldHint: per-tool` |
| **Generic MIDI primitive** (unregistered device, open world) | `send_cc`, `send_program_change`, `send_nrpn`, `send_song_position`, `send_panic`, `send_reset_controllers`, `send_clock_stop` | `idempotentHint: true, openWorldHint: true` (target is unknown to us) |
| **Connection-cache reset** | `reconnect_midi` | `destructiveHint: false, idempotentHint: true, openWorldHint: false` |

**Choices we made explicit (worth documenting because the call wasn't
obvious):**

- `apply_preset` is marked `destructiveHint: true` even though it is
  most commonly audition-mode. The runtime path can land in either
  audition or save mode depending on args; the safer client-hint posture
  is to assume it may save. Our `save_authorized` runtime gate is the
  actual enforcement; annotations are just the upfront signal.
- `send_sysex` is `destructiveHint: true` and `openWorldHint: true`
  because we have no way to know what arbitrary SysEx will do on an
  arbitrary target device. Caller-beware primitive.
- `send_note` is `idempotentHint: false`. Each invocation sounds a note;
  calling twice produces two notes, not one. The spec calls idempotent
  "no additional effect," which sounding a note does not satisfy.
- `openWorldHint: false` on registered-device tools, `true` on `send_*`
  primitives. Spec wording: "the world of a web search tool is open,
  whereas that of a memory tool is not." Our registered devices are
  bounded; the generic primitives can hit anything.

## structuredContent + outputSchema

The spec contract:

> Structured content is returned as a JSON object in the
> `structuredContent` field of a result. For backwards compatibility, a
> tool that returns structured content SHOULD also return the serialized
> JSON in a TextContent block. Tools may also provide an output schema
> for validation of structured results. If an output schema is provided,
> servers MUST provide structured results that conform to this schema.

**What we ship:**

- Every unified-surface tool returns `structuredContent` via the shared
  `asText()` helper (`packages/core/src/protocol-generic/tools/shared.ts`).
- The companion TextContent block the spec asks for is kept, and is the
  COMPACT serialization (2026-08-02). The spec asks for "the serialized
  JSON", which compact satisfies; it says nothing about indentation. The
  block used to be indented, which made it 2-24% longer than the
  structured copy and left the two disagreeing about the size of the same
  response — a difference that matters because host tool-result size
  limits are enforced in characters. Claude Code measurably counts (and
  forwards) the compact structured copy and discards this text block
  entirely; emitting one length for both means a host that reads the
  other field measures the same number, so no host can be over a size
  cliff that `verify-describe-device-budget.ts` reports as green. Full
  evidence in the `asText` docstring.
- `outputSchema` (zod) is declared on tools with simple stable shapes so
  MCP clients can validate responses.
- We deliberately do NOT declare `outputSchema` on tools with rich or
  variable response shapes (`apply_preset`, `apply_patch`,
  `describe_device`). These return many optional fields
  (chain_integrity, validation_info, warnings, and so on), and the spec
  requires the response to conform to a declared schema. Premature
  commitment risks a spec violation every time we add a return field.
  Revisit when the response shapes stabilize.

The mocked-agent test (`scripts/mcp-test-agent-retry-paths.ts`)
exercises the full envelope: tools with `outputSchema` declared get
their responses validated by the MCP framework.

## Error envelopes: DispatchError + asError pattern

Validated by SEP-1303.

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

- **The unified-surface dispatcher** throws `DispatchError` everywhere
  (`packages/core/src/protocol-generic/dispatcher/`). The
  `executeApplyPreset` / `executeSetParam` paths catch the underlying
  device-writer throws and re-emit them with index annotations.
- **Device writers** (`packages/<device>/src/descriptor/writer.ts`)
  throw `DispatchError` exclusively.

The MCP framework forwards `isError: true` results to the model (unlike
Protocol Errors, which are typically squelched from the model's view).
This is the actual recovery path: the agent reads the error message plus
`Valid options: ...` and retries with a verbatim name. Without the
inline text, the agent guesses.

## Dispatcher pattern: Toolhost validation

The unified surface (`set_param(port, block, name, value)` and the rest)
is the
[**Toolhost pattern**](https://glassbead-tc.medium.com/design-patterns-in-mcp-toolhost-pattern-59e887885df3).
Recipe:

- Consolidate many closely related tools behind a single dispatcher
  argument (in our case, `port`).
- Mitigate the loss of per-target visibility with a discovery surface
  (`describe_device(port)`) that returns capabilities, vocabulary,
  example specs, and concept-key mappings.

Concrete recommendations the article surfaces that we already do:

- `describe_device.example_spec` per device: a clone-able `apply_preset`
  payload literal.
- `describe_device.concept_keys` cross-device alias map.
- `describe_device.block_params_summary`: the per-device curated top-N
  knobs, so the agent can skip the full param catalog walk for the
  common case.

What we don't do that's worth considering:

- **No `available_operations` field** on the dispatcher tools. We
  describe the unified shape in prose but don't programmatically expose
  the operation list. Decision: defer. Our `tools/list` already surfaces
  every operation, so the agent has the same visibility either way.

## AWS prescriptive guidance: what we follow / skip

[AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-strategies/mcp-tool-strategy-organization.html)
on MCP tool organization:

| Rule | Status | Notes |
|---|---|---|
| Domain-noun-verb naming | followed | The unified surface uses noun-verb (`set_param`) with the domain implicit in the `port` argument. Pattern intentional. |
| Soft upper-bound of 50 tools per server | within cap | 38 tools, under the soft cap. Most are discovery and primitives; the unified surface tells the agent "for any registered device, use this set of actions." |
| Split servers by read/write | rejected | Would multiply install complexity for end users with mixed setups. Not worth the marginal gain. |
| Split servers by device | rejected | Same reason. |
| Conditional server loading | rejected | Out of scope for a local-machine MCP server; this is a hosted-agent strategy. |

## Upstream gaps (waiting for SDK / spec)

1. **`execution.taskSupport` not on `registerTool` config.** The `Tool`
   type in the 2025-11-25 spec carries `execution: { taskSupport }`, and
   the runtime SDK has a `ToolExecution` schema, but the
   `server.registerTool(name, config, cb)` config object does not accept
   `execution` in the current SDK. Workaround: none short of dropping to
   the lower-level Server API and constructing the Tool object manually.
   Plan: wait for the SDK to expose the field, then add
   `execution.taskSupport: "optional"` to any tool that consistently
   exceeds 30 s wall time.
2. **`Tool.icons` not adopted.** The spec lets servers ship icons for
   display in clients. We have no icons today and no immediate need;
   could ship one per device family for visual distinction. Cosmetic,
   not priority.
3. **`Annotations.audience` / `Annotations.priority` on content
   blocks.** The spec lets tool results tag content as `audience:
   ["user"]` vs `audience: ["assistant"]`. We could mark diagnostic
   prose (raw SysEx hex dumps, ack counter detail) as `audience:
   ["assistant"]` only. Decision: defer. Not all clients honor audience
   filtering yet, and our current text is dual-purpose.
4. **`Resource` / `resourceLink` content type.** Tools can return links
   to MCP resources. Could be useful for `describe_device` to point at a
   static device-spec resource instead of embedding all the prose
   inline. Inline is fine today; revisit if the payload grows.

## Sources

- [MCP spec 2025-11-25, Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP spec 2025-11-25, Changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
- [MCP schema.ts, Tool / ToolAnnotations / CallToolResult](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts)
- [glassBead, Toolhost dispatcher pattern (Medium)](https://glassbead-tc.medium.com/design-patterns-in-mcp-toolhost-pattern-59e887885df3)
- [AWS Prescriptive Guidance, MCP tool organization](https://docs.aws.amazon.com/prescriptive-guidance/latest/mcp-strategies/mcp-tool-strategy-organization.html)
- [TypeScript SDK, server.md (outputSchema + annotations)](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
