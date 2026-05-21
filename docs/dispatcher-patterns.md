# MCP Dispatcher Patterns

MCP-server discipline patterns that live at the **tool-surface +
dispatcher layer**, not in the codec. Cookbook is for encoding
primitives (wire-level); this doc is for how the dispatcher validates,
warns, and shapes responses.

When adding a new dispatcher pre-flight check, validation_info[]
warning class, or response shape convention, register the pattern
here in the same session. Each pattern names its verify-dispatcher
golden cases + the BK-NNN that motivated it.

---

## Pre-flight check patterns

The dispatcher caches a `BlockLayoutSnapshot` per device per request
(TTL=5s in-memory, connection-identity invalidated). Multiple pre-flight
checks share that snapshot — one grid read serves all of them.

### BK-071 / BK-075 — Phantom-param

**Trigger**: `set_param` called on a block-type that isn't placed in
any grid cell. The param "exists" in the catalog but writes to it have
no observable effect because the device routes nothing to a
non-existent block.

**Behavior**: dispatcher surfaces a `validation_info[]` warning with
the dropped param name + the suggestion ("place the block first, then
set the param"). The write does NOT proceed (this is a hard refuse,
distinct from the soft-warns below).

**Implementation**:
- `packages/core/src/protocol-generic/dispatcher/params.ts` —
  `collectPhantomParamWarnings`
- `packages/axe-fx-ii/src/descriptor/reader.ts` —
  `getBlockLayoutSnapshot` (also serves BK-076)
- `packages/axe-fx-ii/src/tools/layout.ts` — cache invalidation hooks
  on `axefx2_set_cell_routing` + `axefx2_set_block_at_cell`

**Goldens**: 7+ cases in `scripts/verify-dispatcher.ts` (positive
trap, positive silent, no-snapshot silent, no-phantom silent,
phantom-vs-routing mutual exclusivity).

### BK-076 — Routing-mask=0 cell warning

**Trigger**: `set_param` on an Axe-Fx II block whose grid cell has
`routingFlags === 0` past column 1 (placed but no cable in/out).

**Behavior**: surfaces a `validation_info[]` warning. Shares the cached
`BlockLayoutSnapshot` with BK-075. Mutually exclusive with phantom-param
(a block can't be simultaneously unplaced AND unrouted).

**Implementation**:
- `packages/core/src/protocol-generic/dispatcher/params.ts` —
  `collectRoutingMaskWarnings`
- `getBlockLayoutSnapshot` extends `BlockLayoutSnapshot` with
  optional `unroutedBlocks?: ReadonlySet<string>`

**Goldens**: 7 cases in `scripts/verify-dispatcher.ts`. Launch-
verification + agent-regression skipped initially (II mock returned
empty grid); `populated-unrouted` `MOCK_FIXTURE` filed Session 113
cont 2 (`packages/axe-fx-ii/src/midi.ts`).

### BK-077 — Channel-Y inactive warning

**Trigger**: `apply_preset` spec authors channel-nested params (X+Y
or A/B/C/D) AND at least one scene in `spec.scenes[]` explicitly
constrains that block's channel AND no scene routes to the param's
channel.

**Behavior**: dispatcher surfaces a `validation_info[]` warning. The
write still proceeds (display-first / user-agency); the agent reads
the warning and self-corrects on the next turn.

**Implementation**:
- `packages/core/src/protocol-generic/dispatcher/preset.ts` —
  `collectChannelYInactiveWarnings(spec, descriptor)` (~80 LOC)
- Wired into `executeApplyPreset` alongside the existing
  `collectTypeKnobApplicabilityWarnings` call

**Goldens**: 7 cases in `scripts/verify-dispatcher.ts` (II positive
trap, AM4 positive trap, no-scenes silent, flat-params silent,
empty-channels-map silent, multi-Y-param dropped_param-undefined).
Launch-verification: 2 BK-077 records.

---

## Validation_info[] conventions

All soft-warning collectors:

- Return an array of warning objects, NEVER throw
- Each warning object includes: `code` (BK-NNN identifier), `message`
  (display-first natural language), `dropped_params[]` (when relevant
  — the param names the agent should re-attempt placement-aware), and
  optional `suggestion` (the next action the agent should take)
- Multiple collectors compose by concatenation into a single
  `validation_info[]` field on the dispatcher response. Order matches
  collector registration order (phantom-param → routing-mask → channel-Y
  inactive).
- Mutually exclusive cases (a block can't be both phantom AND unrouted)
  are enforced at collector boundary — earlier collectors short-circuit
  for affected block-types.

When adding a new collector:

1. Define the trap condition + the user-facing message.
2. Add to the dispatcher (e.g. `dispatcher/params.ts` for `set_param`
   collectors, `dispatcher/preset.ts` for `apply_preset` collectors).
3. Add 5-7 cases to `scripts/verify-dispatcher.ts` covering: positive
   trap, positive silent, no-snapshot/empty-deps silent, mutual
   exclusivity with sibling collectors, snapshot shape invariant.
4. If the collector requires a new mock fixture, define it
   (`packages/<device>/src/midi.ts` `MockFixture` union).
5. Add an agent-regression case (`scripts/agent-regression/cases-<device>.ts`)
   verifying the recovery flow on a real agent: warning surfaced →
   agent self-corrects → second attempt succeeds.

---

## Response shape standards

All MCP tool responses follow a small invariant:

```typescript
type DispatcherResponse = {
  ok: boolean;
  // ... tool-specific success fields ...
  validation_info?: ValidationWarning[];  // soft warnings (write still proceeded)
  validation_errors?: ValidationError[];  // hard errors (write did NOT proceed)
  applied?: number;  // optional progress info for batch ops
  total?: number;
  failed?: number;
};

type ValidationWarning = {
  code: string;            // "BK-077-channel-y-inactive"
  message: string;         // display-first natural language
  dropped_params?: string[];
  suggestion?: string;
};
```

`validation_info[]` is what enables the soft-warn-and-continue pattern.
The agent reads warnings, decides whether the write succeeded as
intended, and self-corrects on the next turn. Hard refuses use
`validation_errors[]` + `ok: false`.

**Display-first**: all message strings use display units (0..10 knob,
dB, ms, ratio 4:1, enum string `'Plexi 100W High'`). Never wire-format
units (`0x4800 invalid`).

---

## Test infrastructure patterns (cross-reference)

These belong to the test harness, not the dispatcher proper, but they
support the patterns above:

### `MockFixture` per device

Each device package exposes a `MockFixture` union for agent-regression
testing without hardware:

- `'clean-scratch'` — default empty/baseline state
- `'populated-unrouted'` (II, BK-076) — grid populated but
  `routingFlags = 0` past col 1
- `'slow-response'` (AM4) — `ackLatencyMs` inflated to 1500
- `'partial-ack'` (AM4) — reads return display ~1.0 for any standard
  knob register regardless of write

### `text_contains_any` matcher (Session 113 cont 2)

OR-of-AND text assertion in `scripts/agent-regression/types.ts`. Each
inner array is an AND group; outer array is OR alternatives. At least
one inner group must fully match.

Useful for ambiguous-case detection: the ambiguous case has two
legitimate paths (clarifying question OR explicit defaults narration),
so a single AND group rejects valid answers from the other path.

### `MOCK_FIXTURE` discipline

Tests that need a non-default mock state pin the fixture explicitly
in the test case definition. Default `'clean-scratch'` keeps existing
behavior. Adding a new fixture requires updating the device package's
`MockFixture` union + the dispatcher's mock-handler dispatch.

---

## Refinement history

- BK-071 (Session 110ish): phantom-param introduced as the first
  pre-flight check pattern.
- BK-075 (Session 112): BlockLayoutSnapshot caching with TTL=5s +
  connection-identity invalidation. Pattern reused for BK-076.
- BK-076 (Session 113 cont): routing-mask=0 cell warning.
- BK-077 (Session 113): channel-Y inactive warning. Extended pattern
  to `apply_preset` spec-validation layer.
- Session 113 cont 2: adversary fixtures (slow-response, partial-ack)
  + `text_contains_any` matcher for ambiguous-case detection.
- 2026-05-22: dispatcher-patterns.md created to host these patterns
  outside the cookbook (cookbook is codec-domain; dispatcher patterns
  are MCP-server-domain).
