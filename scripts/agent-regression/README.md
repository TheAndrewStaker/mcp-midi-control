# Agent-regression harness

Drives each test case through `claude -p` (non-interactive Claude Code)
against the shipped MCP server. Each case is a **fresh agent session**
(no prior context, no privileged hints) so the agent reads tool
descriptions cold the same way Claude Desktop does.

Bills against the **Claude Max subscription** of whoever is logged
into Claude Code (no `ANTHROPIC_API_KEY` required).

## Why this exists

A human-driven end-to-end pass in Claude Desktop is the manual runbook.
This harness is the automated mirror: it runs the same prompts
unattended, captures the agent's tool sequence, asserts efficient +
correct usage, and catches **silent no-op regressions** a human reading
the chat would miss.

## Tool surface: MCP-only via `--tools ""`

Each `claude -p` invocation is launched with `--tools ""`, which removes
every Claude Code built-in (Bash, Edit, Read, Grep, Glob, Skill, Task*,
ToolSearch, WebFetch, etc.) from the agent's tool surface. MCP servers
pass through independently via `--mcp-config`.

This mirrors a Claude Desktop user's environment (Desktop users don't
have Grep / Skill / TaskCreate either) and isolates the test to the
quality of the MCP tool *descriptions* on this server. Without this
filter, Sonnet sometimes fell back to grep'ing our local codebase
("What amp models does this support?" became 11 Grep calls against
`docs/`) or reached for Claude Code's planning surface
(`Skill`, `TaskCreate`, `TaskUpdate`), which made the harness test the
wrong thing.

`--allowedTools` (note: different flag) is permission-tier and was
verified ineffective for surface filtering: per the Claude Code CLI
docs, `--tools` is the one that filters what the model can see.

The motivating example: in the H1 hero run, the agent picked
`reverb.type = "Hall, Large Deep"`, wrote `reverb.time = 6`, the
device ACKed the write, and the agent reported "Decay locked in at 6
seconds." It looked like a pass. But Hall algorithms on AM4 are
fixed-decay: the write silently no-op'd, the actual decay never
changed, and the user got a wrong report. A human reviewer would
have missed it. This harness's `should_avoid_dropped_param_warning`
+ `tool_call_validators` catch it.

## Running

**Default = mock transport (no USB hardware needed).** Every spawned
`claude -p` child gets `MCP_MOCK_TRANSPORT=1` in its env, and each
device's `connectXXX()` short-circuits to an in-memory mock. The
agent exercises the full dispatcher pipeline (display→wire encoding,
channel switching, applyExecutor) against synthesized ack envelopes.

```bash
npm run agent-sweep                                 # all cases under mock
npm run agent-sweep:am4                             # AM4 only, mock
npm run agent-sweep:axefx2                          # Axe-Fx II only, mock
npm run agent-sweep:axefx3                          # Axe-Fx III only, mock
npm run agent-sweep:hydra                           # Hydrasynth only, mock
npx tsx scripts/agent-regression/index.ts --tier=no-hardware
npx tsx scripts/agent-regression/index.ts --case=am4-h1-sunday-morning --verbose
```

**Real-hardware mode (USB plugged in).** Opt out of the mock via the
`--real-hardware` flag (or set `AGENT_REGRESSION_REAL_HARDWARE=1` in
the env). Verifies wire-level correctness alongside agent behavior.

```bash
npm run agent-sweep:real                            # all cases against real hardware
npm run agent-sweep:am4:real                        # AM4 only, real hardware
npm run agent-sweep:axefx2:real                     # Axe-Fx II only, real hardware
npm run agent-sweep:axefx3:real                     # Axe-Fx III only, real hardware
npm run agent-sweep:hydra:real                      # Hydrasynth only, real hardware
npx tsx scripts/agent-regression/index.ts --real-hardware
```

The startup banner reports which transport is active:
`Transport: mock transport (no USB).` vs `Transport: real hardware
(USB MIDI).`, so it's obvious which mode you're in.

Drive one case during development (uses mock by default; set the env
var for real hardware):

```bash
npx tsx scripts/agent-regression/runner.ts am4-h1-sunday-morning
```

The `--verbose` flag echoes every stream-json event from `claude -p`
as it arrives, useful when authoring a new case's assertions.

## Where this fits in the test pyramid

| Trigger | Command | Time | $ | What runs |
|---|---|---|---|---|
| Mid-edit | `npm test` | ~30s | $0 | byte-equiv goldens, smoke-server, build |
| Pre-commit | `npm run preflight` | ~60s | $0 | typecheck + `npm test` |
| Pre-release ritual | **`npm run release-gate`** | ~10 to 15min | ~$1 to 2 | preflight + launch-verify + agent-sweep |
| At-bench | `npm run launch-verify` | ~30s | $0 | live HW probe + audition |

`release-gate` is the gate before tagging a release. It
does NOT run on every push; `git push` triggers nothing, by design.
The cadence matches release tagging, not commit frequency. The
agent-sweep auto-detects connected devices and skips hardware-tier
cases for any unconnected device, so `release-gate` works at the
bench OR away from it (subset coverage when away).

## Retry-on-flake

Sonnet is non-deterministic. A failed case is retried ONCE before
declaring fail. If the retry passes, the case is flagged `⚠ flake`
in the summary table (visible signal, not silent) but doesn't
block the gate. Override with `--max-retries=0` for CI-debug mode.

## Environmental failures (the Windows `0xC0000142` spawn cascade)

On Windows, a long back-to-back sweep can hit a process-spawn ceiling:
the OS refuses to initialize a new `claude.exe` (exit `3221225794` =
`STATUS_DLL_INIT_FAILED`), the case reports `0 tools / 0.0s`, and once it
starts it does NOT recover mid-run. This is the **machine, not the
case**; it would otherwise wipe a whole run's reliability numbers (one
cascade reads as a contiguous block of `✗`).

The harness handles it so a sweep still completes honestly:

- **Tagged `⊘ ENV`, not `✗ FAIL`.** A run with the spawn-failure
  signature (exit `3221225794` / spawn EPERM/ENOENT, 0 tools, near-instant)
  is classed environmental and **excluded from pass/fail accounting**
  (`runner.ts isEnvironmentalResult`, `resultsLog isEnvironmentalRow`).
  `stats.ts` and the inline history line show an `env` column and exclude
  these rows from pass-rate; legacy rows (pre-flag) are detected by the
  same signature so historical stats are trustworthy.
- **Env-retry with backoff.** An environmental result is re-spawned (up
  to 2×) after a few seconds' backoff (separate from the instant
  LLM-flake retry), giving the OS time to release per-spawn handles.
- **Inter-case spacing** (~1.2 s) between cases reduces residue buildup.
- **Abort-on-cascade.** After 3 consecutive environmental results the
  sweep stops with an actionable message rather than marking the rest
  failed.

**Before a big unscoped `npm run agent-sweep`, reap residue first:**

```bash
npm run agent-sweep:kill   # clears leftover claude/runner processes from a prior run
npm run agent-sweep
```

`agent-sweep:kill` is safe standalone but is **not** auto-run from inside
a sweep: a reap from within would match the sweep's own launcher chain
(bash → npx → tsx → node, all carrying `agent-regression/index`) and kill
its own tree. Device-scoped sweeps (`--device=am4`, 1–4 cases) rarely
cascade; the ceiling is specific to large unscoped runs starting dirty.

## Authoring a new case

1. Add an entry to the right `cases-<device>.ts` file. Required fields:
   `id`, `device`, `tier`, `description`, `prompt`, `expectations`.
2. Pick the assertions:
   - `must_call`: bare tool names that MUST appear (optional; omit when
     the case accepts multiple valid paths). **Satisfied only by a call
     that did NOT return `is_error`** — it means "the agent got this
     done", and a failed call did not. A case whose tool errored on
     every attempt fails with "called N× but EVERY call returned
     is_error", which reads differently from "never called".
   - `must_call_any`: OR-of-AND alternation: `[[a], [b, c]]`
     accepts "called a" OR "called both b and c". Use when the agent
     has multiple equivalent end-state paths (e.g. `apply_preset` vs
     primitive `set_block + set_params`). Pair with `optional: true`
     on any tool_call_validators that only apply to one path. Same
     success requirement as `must_call`.
   - `min_tools`: floor on total tool calls. Default 1; set to 0 when
     an upfront refusal is an acceptable agent path.
   - `max_tools`: efficiency ceiling.
   - `max_repeats`: per-tool retry ceiling (catches enum / type-mismatch loops).
   - `tool_call_validators`: argument-level predicates over a specific tool call.
     Set `optional: true` on a validator that should silently pass when
     the tool wasn't called: "if you fired this tool, verify args, but
     not firing it is also acceptable."
   - `should_avoid_dropped_param_warning`: flag for the H1-silent-no-op class.
   - `text_not_contains`: guards against false-confidence narration.
   - `mockFixture`: pin a non-default mock-transport profile for cases
     that exercise alternate device-state shapes (`populated-z01` for
     overwrite-gate coverage, `device-quirk-scene-7fff` for the scene-
     boundary regression, etc.). Default omitted = `clean-scratch`. The
     env-var side door (`MOCK_FIXTURE=...`) still works for ad-hoc runs;
     case-spec wins when both are present.
   - `requiresHardware`: set true for a case that needs a real device
     RESPONSE the mock can't synthesize: a SysEx readback (e.g.
     `get_preset` on a device with no mock responder) or an ack-gated
     transfer (`upload_sample`/`upload_project` on Circuit). These are
     SKIPPED under the mock (default sweep) and run only under
     `--real-hardware`. Distinct from `disabled` (which removes the case
     from every sweep): a requiresHardware case is live, just gated to the
     bench. Mock-friendly fire-and-forget / storage / introspection cases
     leave it unset.

### Two failures that fire on EVERY case, with no opt-out

Both were added on 2026-08-02, after measuring that the harness had been
scoring a live outage green.

- **Undelivered tool result.** A payload over a host limit never reaches the
  model: the host substitutes `<persisted-output>` + a sidecar path (50,000-char
  cap) or a bare "exceeds maximum allowed tokens" error
  (`MAX_MCP_OUTPUT_TOKENS`), and an MCP-only agent has no filesystem tool to
  open either. 26 of 707 archived traces carry one of these and **9 of those
  runs were scored PASS** — correct tool, correct arguments, inside the call
  budget, answering from a stub. There is no per-case opt-out, because an
  undelivered result means the run measured something other than what the case
  claims to measure. When this fires, fix the TOOL's response size (give it a
  budget, like `describe_device` and `list_params` have), not the case.
- **Device unreachable.** This scan used to run only under `--real-hardware`,
  which is backwards: on the MOCK sweep a device-not-found result means the case
  has no transport behind it and is only asserting that the agent typed the
  right argument names.

There is deliberately **no `allow_tool_errors` flag**. An agent that hits a
refusal, reads it, and retries correctly has done the right thing, and several
cases exist to test exactly that; requiring a SUCCESSFUL call (see `must_call`
above) separates "recovered" from "never got there" without an opt-out list to
maintain. `scripts/verify-agent-harness.ts` gates all of this, including an
explicit `error-then-recover still PASSES` assertion.

## Archetype coverage + how non-MIDI devices run under mock

Beyond per-tool cases, each ACTIVE device archetype has ONE
large-coverage case that exercises ≥3 distinct archetype tools in one
scenario (so a whole archetype's surface is regression-checked end to
end). See `docs/design/device-archetypes-and-transport.md` for the
taxonomy.

| Archetype | Large-coverage case | Tools |
|---|---|---|
| Preset processor | `am4-archetype-build-lineage-readback` | apply_preset + lookup_lineage + get_param |
| Synth/patch | `hydrasynth-archetype-patch-macro-system` | apply_patch + set_macro + set_system_param |
| Sequencer | `circuit-archetype-discover-audition-tweak` | list_pattern_recipes + apply_pattern + set_param |
| Sampler/storage | `spdsx-archetype-full-rundown` | scan_locations + list_samples + get_preset + author_kit(dry_run) |

Two archetypes had no headless path before and now do:

- **Sequencer (Circuit Tracks)** has no per-device mock responder. A
  generic mock-transport fallback in `connect()` (core `midi/transport.ts`,
  gated on `MCP_MOCK_TRANSPORT`, only reached by factory-less devices)
  gives Circuit a fire-and-forget connection under mock, so live_stream /
  set_param / introspection cases run headless. Read/transfer cases that
  need real SysEx responses are marked `requiresHardware`.
- **Sampler (SPD-SX)** is a storage-transport device. The runner builds a
  deterministic on-disk fixture (`getSpdsxFixtureRoot`: 3 waves + one kit
  "Demo Kit") and injects `MCP_SPDSX_ROOT` for `device: 'spd-sx'` cases,
  so scan/list/get_preset/author_kit(dry_run) all read real fixture data.
  The large case asserts `text_contains: ['Demo Kit']` to prove a real
  read, not a fabrication.
3. Run with `--verbose` once to see the actual tool sequence, tune the
   bounds, and commit.

### Assertion-design rule of thumb

Test for *behavior*, not *tool sequence*. Sonnet's correct response to
"set amp gain to 12.5 on the AM4" might be:
  (a) call `set_param` and let the validator-layer reject, OR
  (b) read `describe_device` first and refuse upfront, OR
  (c) refuse from training-data knowledge that AM4 gain caps at 10.
All three are right answers. Forcing `must_call: ['set_param']` rejects
(b) and (c) as failures, which is a harness bug: the assertion was too
prescriptive about the tool path. Prefer:
  - `min_tools: 0` (allow zero-tool refusals when correct),
  - `tool_call_validators` with `optional: true` (verify args IF the
    tool was called),
  - `text_not_contains` for false-success narration ("amp gain is now
    12.5"), which catches the actual regression we care about.

### `text_not_contains` discipline: positive-claim shapes only

`text_not_contains` is naive case-insensitive substring match. A
pattern like `'saved to'` will match BOTH the failure mode ("I saved
to flash") AND the correct disclaimer ("Not saved to flash yet").
The disclaimer is what the agent SHOULD say when running in working-
buffer mode, but the bare substring fires either way.

**Always shape `text_not_contains` patterns as the positive claim
the agent would emit on the failure mode**, never the bare verb +
preposition:

  - ✗ `'saved to'` fires on "Not saved to flash yet" (correct
    disclaimer = false positive).
  - ✗ `'set gain to'` fires on "I won't set gain to 12.5" (correct
    refusal = false positive).
  - ✓ `'I saved'`, `'now saved to'`, `'preset is saved'`: only the
    failure mode (agent claiming persistence) emits these.
  - ✓ `'gain is now 12'`, `'set gain to 12 successfully'`: only the
    failure mode (agent claiming the out-of-range write landed).

Subject + verb (or auxiliary + past-participle) is the structural
pattern that won't appear in negation. "I saved" almost never appears
inside "I have NOT saved" because English speakers (and Sonnet) write
"I haven't saved" instead, breaking the substring.

If a case needs to assert absence of a concept that doesn't have a
clean positive-claim phrasing, use a regex via `tool_call_validators`
on the apply_preset / set_param result envelope instead, which scopes
to wire-layer output where negation noise is structurally absent.

## Tier-skipping

- `tier: 'no-hardware'` cases run anywhere (descriptor introspection,
  schema validation, etc.).
- `tier: 'hardware'` cases require the device. At sweep startup the
  harness probes `list_midi_ports`; hardware-tier cases whose device
  isn't visible are skipped cleanly (release-gate stays green away
  from the bench).
- **Mid-sweep disconnect detection.** A hardware case that starts with
  the device visible but loses it mid-run (USB blip, operator unplugs,
  another worktree grabs the port) used to silently pass if its
  validators only checked tool-call *arguments*: the agent made the
  call with correct args, the tool returned a "device not found"
  error, the validator never looked at the result. The harness now
  scans every tool result on a hardware case for the device-not-found
  envelope (matches `not found in the MIDI device list`, `AM4 not
  visible`, `Axe-Fx II/III not found`, `Hydrasynth not found`, etc.)
  and fails the case loudly with a "hardware unreachable mid-sweep"
  diagnostic.

## Sonnet 4.6 default

Default model: `claude-sonnet-4-6` (matches the Desktop default). Override
with `--model=<id>` (`claude-opus-4-7`, `sonnet`, etc.).

## Cost / rate-limit notes

Each case is ~5 to 15k tokens (tool definitions + system + agent loop).
A full AM4 sweep (~10 to 15 cases) runs in 5 to 10 minutes wall time and
consumes equivalent of a small Claude Desktop session. Subscription
rate limits apply.

## File layout

```
scripts/agent-regression/
├── README.md              # this file
├── mcp-config.json        # MCP server config passed to claude -p
├── types.ts               # AgentRegressionCase / Expectations types
├── runner.ts              # spawn + stream-json parser + assertion engine
├── cases-am4.ts           # AM4 cases (H1/H2/H3 + §2 surface + preset archetype)
├── cases-axe-fx-ii.ts     # Axe-Fx II cases (X/Y channel + discovery)
├── cases-axe-fx-iii.ts    # Axe-Fx III cases (fn=0x01 SET_PARAMETER envelope + discovery)
├── cases-axefx-gen1.ts    # Axe-Fx Standard/Ultra (gen-1) cases
├── cases-fm9.ts           # FM9 cases
├── cases-hydrasynth.ts    # Hydrasynth cases (System CC + macro + synth archetype)
├── cases-circuit-tracks.ts# Circuit Tracks cases (overwrite gate + sequencer archetype)
├── cases-spd-sx.ts        # SPD-SX cases (sampler archetype, storage fixture)
├── cases-cross-device.ts  # cross-device translate / read-anchor cases
├── cases-all.ts           # aggregator
├── resultsLog.ts          # append/read the durable results.jsonl corpus (+ env-row exclusion)
├── stats.ts               # per-case pass/flake/env analytics over the corpus
├── kill-sweeps.ts         # manual reap of leftover sweep/claude processes (run BETWEEN sweeps)
└── index.ts               # CLI entry (run loop, inter-case spacing, abort-on-cascade)
```
