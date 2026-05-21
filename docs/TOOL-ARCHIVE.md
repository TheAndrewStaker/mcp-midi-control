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

_No entries yet. First removals land in T-2 (axefx2_test_apply, axefx3_get_parameter, axefx3_set_parameter, hydra_set_param) and T-6 (axefx2_atomic_apply)._

## Unrealized capabilities

Tools that were considered but never shipped, captured here so future agents do not re-derive the same hypothesis from scratch.

_No entries yet. First entry lands in T-8 (nudge_param parity for II / III / Hydra)._
