# Agent-regression harness

Drives each test case through `claude -p` (non-interactive Claude Code)
against the shipped MCP server. Each case is a **fresh agent session**
— no prior context, no privileged hints — so the agent reads tool
descriptions cold the same way Claude Desktop does.

Bills against the **Claude Max subscription** of whoever is logged
into Claude Code (no `ANTHROPIC_API_KEY` required).

## Why this exists

The founder e2e in Claude Desktop (`docs/_private/regression/<device>.md`)
is the human-driven runbook. This harness is the automated tier-2.5
mirror — runs the same prompts unattended, captures the agent's tool
sequence, asserts efficient + correct usage, and catches **silent
no-op regressions** a human reading the chat would miss.

## Tool surface — MCP-only via `--tools ""`

Each `claude -p` invocation is launched with `--tools ""`, which removes
every Claude Code built-in (Bash, Edit, Read, Grep, Glob, Skill, Task*,
ToolSearch, WebFetch, etc.) from the agent's tool surface. MCP servers
pass through independently via `--mcp-config`.

This mirrors a Claude Desktop user's environment — Desktop users don't
have Grep / Skill / TaskCreate either — and isolates the test to the
quality of the MCP tool *descriptions* on this server. Without this
filter, Sonnet sometimes fell back to grep'ing our local codebase
("What amp models does this support?" → 11× Grep against `docs/`) or
reaching for Claude Code's planning surface (`Skill → TaskCreate →
TaskUpdate`), which made the harness test the wrong thing.

`--allowedTools` (note: different flag) is permission-tier and was
verified ineffective for surface filtering — per the Claude Code CLI
docs, `--tools` is the one that filters what the model can see.

The motivating example: in the H1 hero run, the agent picked
`reverb.type = "Hall, Large Deep"`, wrote `reverb.time = 6`, the
device ACKed the write, and the agent reported "Decay locked in at 6
seconds." It looked like a pass. But Hall algorithms on AM4 are
fixed-decay — the write silently no-op'd, the actual decay never
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

The startup banner reports which transport is active —
`Transport: mock transport (no USB).` vs `Transport: real hardware
(USB MIDI).` — so it's obvious which mode you're in.

Drive one case during development (uses mock by default — set the env
var for real hardware):

```bash
npx tsx scripts/agent-regression/runner.ts am4-h1-sunday-morning
```

The `--verbose` flag echoes every stream-json event from `claude -p`
as it arrives — useful when authoring a new case's assertions.

## Where this fits in the test pyramid

| Trigger | Command | Time | $ | What runs |
|---|---|---|---|---|
| Mid-edit | `npm test` | ~30s | $0 | byte-equiv goldens, smoke-server, build |
| Pre-commit | `npm run preflight` | ~60s | $0 | typecheck + `npm test` |
| Pre-release ritual | **`npm run release-gate`** | ~10-15min | ~$1-2 | preflight + launch-verify + agent-sweep |
| At-bench | `npm run launch-verify` | ~30s | $0 | live HW probe + audition |

`release-gate` is the founder-driven gate before tagging a release. It
does NOT run on every push — `git push` triggers nothing, by design.
The cadence matches release tagging, not commit frequency. The
agent-sweep auto-detects connected devices and skips hardware-tier
cases for any unconnected device, so `release-gate` works at the
bench OR away from it (subset coverage when away).

## Retry-on-flake

Sonnet is non-deterministic. A failed case is retried ONCE before
declaring fail. If the retry passes, the case is flagged `⚠ flake`
in the summary table — visible signal, not silent — but doesn't
block the gate. Override with `--max-retries=0` for CI-debug mode.

## Authoring a new case

1. Add an entry to the right `cases-<device>.ts` file. Required fields:
   `id`, `device`, `tier`, `description`, `prompt`, `expectations`.
2. Pick the assertions:
   - `must_call` — bare tool names that MUST appear (optional; omit when
     the case accepts multiple valid paths).
   - `must_call_any` — BK-072 OR-of-AND alternation: `[[a], [b, c]]`
     accepts "called a" OR "called both b and c". Use when the agent
     has multiple equivalent end-state paths (e.g. `apply_preset` vs
     primitive `set_block + set_params`). Pair with `optional: true`
     on any tool_call_validators that only apply to one path.
   - `min_tools` — floor on total tool calls. Default 1; set to 0 when
     an upfront refusal is an acceptable agent path.
   - `max_tools` — efficiency ceiling.
   - `max_repeats` — per-tool retry ceiling (catches enum / type-mismatch loops).
   - `tool_call_validators` — argument-level predicates over a specific tool call.
     Set `optional: true` on a validator that should silently pass when
     the tool wasn't called — "if you fired this tool, verify args, but
     not firing it is also acceptable."
   - `should_avoid_dropped_param_warning` — flag for the H1-silent-no-op class.
   - `text_not_contains` — guards against false-confidence narration.
   - `mockFixture` — pin a non-default mock-transport profile for cases
     that exercise alternate device-state shapes (`populated-z01` for
     overwrite-gate coverage, `device-quirk-scene-7fff` for the scene-
     boundary regression, etc.). Default omitted = `clean-scratch`. The
     env-var side door (`MOCK_FIXTURE=...`) still works for ad-hoc runs;
     case-spec wins when both are present.
3. Run with `--verbose` once to see the actual tool sequence, tune the
   bounds, and commit.

### Assertion-design rule of thumb

Test for *behavior*, not *tool sequence*. Sonnet's correct response to
"set amp gain to 12.5 on the AM4" might be:
  (a) call `set_param` and let the validator-layer reject, OR
  (b) read `describe_device` first and refuse upfront, OR
  (c) refuse from training-data knowledge that AM4 gain caps at 10.
All three are right answers. Forcing `must_call: ['set_param']` rejects
(b) and (c) as failures, which is a harness bug — assertion was too
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
buffer mode — but the bare substring fires either way.

**Always shape `text_not_contains` patterns as the positive claim
the agent would emit on the failure mode**, never the bare verb +
preposition:

  - ✗ `'saved to'` — fires on "Not saved to flash yet" (correct
    disclaimer = false positive).
  - ✗ `'set gain to'` — fires on "I won't set gain to 12.5" (correct
    refusal = false positive).
  - ✓ `'I saved'`, `'now saved to'`, `'preset is saved'` — only the
    failure mode (agent claiming persistence) emits these.
  - ✓ `'gain is now 12'`, `'set gain to 12 successfully'` — only the
    failure mode (agent claiming the out-of-range write landed).

Subject + verb (or auxiliary + past-participle) is the structural
pattern that won't appear in negation. "I saved" almost never appears
inside "I have NOT saved" because English speakers (and Sonnet) write
"I haven't saved" instead, breaking the substring.

If a case needs to assert absence of a concept that doesn't have a
clean positive-claim phrasing, use a regex via `tool_call_validators`
on the apply_preset / set_param result envelope instead — that scopes
to wire-layer output where negation noise is structurally absent.

## Tier-skipping

- `tier: 'no-hardware'` cases run anywhere (descriptor introspection,
  schema validation, etc.).
- `tier: 'hardware'` cases require the device. At sweep startup the
  harness probes `list_midi_ports`; hardware-tier cases whose device
  isn't visible are skipped cleanly (release-gate stays green away
  from the bench).
- **Mid-sweep disconnect detection.** A hardware case that starts with
  the device visible but loses it mid-run (USB blip, founder unplugs,
  another worktree grabs the port) used to silently pass if its
  validators only checked tool-call *arguments* — the agent made the
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

Each case is ~5-15k tokens (tool definitions + system + agent loop).
A full AM4 sweep (~10-15 cases) runs in 5-10 minutes wall time and
consumes equivalent of a small Claude Desktop session. Subscription
rate limits apply.

## File layout

```
scripts/agent-regression/
├── README.md              # this file
├── mcp-config.json        # MCP server config passed to claude -p
├── types.ts               # AgentRegressionCase / Expectations types
├── runner.ts              # spawn + stream-json parser + assertion engine
├── cases-am4.ts           # AM4 cases (H1/H2/H3 + §2 surface coverage)
├── cases-axe-fx-ii.ts     # Axe-Fx II cases (BK-058 X/Y channel + discovery)
├── cases-axe-fx-iii.ts    # Axe-Fx III cases (fn=0x01 SET_PARAMETER envelope + discovery)
├── cases-hydrasynth.ts    # Hydrasynth cases (System CC + macro + discovery)
├── cases-all.ts           # aggregator
└── index.ts               # CLI entry
```
