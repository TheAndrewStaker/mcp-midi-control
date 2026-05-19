# Parallel Claude Code sessions on this repo

This doc covers how to run up to ~3 Claude Code sessions at once on this
repo without them stepping on each other. It assumes Claude Code
v2.1.139+ (check with `claude --version`).

The repo is already configured for the workflow below:

- `.gitignore` excludes `.claude/worktrees/`.
- `.claude/settings.local.json` sets `worktree.baseRef: "fresh"`, so new
  worktrees branch from `origin/HEAD` (i.e. `origin/main`) and don't
  inherit unpushed local commits. Switch to `"head"` only if you need a
  session to operate on in-progress work that hasn't been pushed yet.
- `.worktreeinclude` copies `docs/_private/` into each new worktree so
  every session can read `STATE.md` and the `HARDWARE-TASKS-*.md` files
  per the project's session-start protocol.

## The single-terminal pattern: Agent View

Run **`claude agents`** from this repo's root. It opens one screen showing
every background session grouped by state (`Needs input` /
`Working` / `Ready for review` / `Completed`), with PR status dots and
a peek-panel for quick replies.

Core loop:

1. Type three prompts in the dispatch input, pressing `Enter` after each
   — one prompt = one new background session.
2. `Esc` to detach. The sessions keep running with no terminal attached.
3. `claude agents` again later to peek (`Space`), attach (`Enter`),
   or stop+delete (`Ctrl+X` twice).

Each session is automatically moved into its own worktree under
`.claude/worktrees/<name>/` on its first file write. Sessions never share
a working tree — that's the conflict cure.

Keyboard quick reference (full list with `?` in Agent View):

| Key | Action |
| :-- | :-- |
| `↑` / `↓` | Move between rows |
| `Space` | Open peek panel for selected row |
| `Enter` / `→` | Attach to the selected session |
| `←` (empty input) | Detach back to Agent View |
| `Ctrl+X` | Stop the session; press again within 2s to delete |
| `Ctrl+T` | Pin to top |
| `Ctrl+R` | Rename |
| `Esc` | Close panel / clear input / exit |

`Ctrl+X` twice **deletes the worktree along with the session**. Commit
and push before pressing `Ctrl+X Ctrl+X`, or the work goes with it.

## Safe parallelization seams in this repo

Sessions can edit different files concurrently without conflict.
The natural seams here, in rough order of safety:

1. **Per-device.** AM4 / Axe-Fx II / Axe-Fx III / Hydrasynth code and
   docs are physically separated:
   - `packages/am4/`, `packages/axe-fx-ii/`, `packages/hydrasynth/`
   - `docs/devices/am4/`, `docs/devices/axe-fx-ii/`,
     `docs/devices/axe-fx-iii/`, `docs/devices/hydrasynth/`
     (each carries its own `SYSEX-MAP.md` plus per-device research)
   - `docs/_private/HARDWARE-TASKS-AM4.md` etc.
2. **Per-package in the monorepo.** Even within one device, `core` /
   `am4` / `server-all` rarely overlap.
3. **Decode-vs-tool-surface.** Protocol RE work (`params.ts`, Ghidra
   mining, `verify-msg.ts` goldens, `SYSEX-MAP*.md`) almost never
   touches MCP tool wiring (`src/server/`, `src/protocol/generic/`).
4. **Per-research-artefact.** Two different `*-research.md` files in
   `docs/` are independent by construction.

Concrete example of a clean 3-session split for a single afternoon:

| Session | Task | Files it touches |
| :-- | :-- | :-- |
| A | Decode a new Axe-Fx II param family | `packages/axe-fx-ii/src/params.ts`, `docs/devices/axe-fx-ii/SYSEX-MAP.md`, `verify-msg.ts` golden |
| B | Mine a new AM4 Ghidra coverage gap | `packages/am4/src/params.ts`, `docs/devices/am4/SYSEX-MAP.md` |
| C | Add a tool to the unified surface | `packages/core/src/protocol/generic/tools.ts`, `dispatcher.ts` |

### AM4 `params.ts` / `paramNames.ts` / `cacheParams.ts` pipeline reality

A common parallelization trap on AM4 work: prompts of the shape "only
write `paramNames.ts`, don't touch `params.ts`" sound clean but break
down for **catalog-only param ids** (entries that live in the Ghidra
dispatcher table but not in any S2/S3 cache block). The cache-gen
pipeline (`scripts/gen-params-from-cache.ts`) iterates cache blocks
and emits `cacheParams.ts` from them; ids that aren't in a cache block
have no path through `paramNames.ts` and must be authored directly in
`params.ts`. The DISTORT closeout (commit `b652491`) and CABINET closeout
(commit `c211b0d`) both hit this — both ended up writing `params.ts`
despite the "paramNames.ts only" instruction, for legitimate reasons.

For future dispatches, prefer one of:
- **Whitelist all three pipeline files** (`paramNames.ts`, `params.ts`,
  `cacheParams.ts`) for any AM4 family-coverage task. Catalog-only ids
  need direct edits; the rule "don't touch `params.ts`" is too tight.
- **Serialize the AM4 sessions** in a batch if both target the same
  block. Two agents writing `amp:` entries in `params.ts` will conflict
  even if they target different paramIds (line-range overlap).

Sessions B (DISTORT) and D (CABINET) wrote `params.ts` concurrently
and merged clean only because they targeted disjoint paramIds in
different files-of-the-block — that's luck, not design.

## Worktree isolation: required prompt header for sub-agent dispatches

When the orchestrator dispatches sub-agents via the `Agent` tool with
`isolation: "worktree"`, the harness creates a worktree under
`.claude/worktrees/<agent-id>/` and sets the sub-agent's cwd to that
path. **The harness does NOT enforce path isolation on Read / Edit /
Write tool calls** — absolute paths are honored verbatim. A sub-agent
that constructs absolute paths from the orchestrator's `C:\dev\mcp-
midi-tools\...` will silently write into the orchestrator's main
checkout instead of its assigned worktree. This is model-dependent
and prompt-sensitive (Session A 2026-05-16 hit this; B and C in the
same batch did not). The only mitigation is prompt-side.

**Every sub-agent dispatch MUST begin its prompt with this verbatim
header.** Copy-paste exactly; do not paraphrase:

```
=== WORKTREE-ISOLATION GUARDS (READ FIRST) ===
You are running in an auto-isolated git worktree. BEFORE any file operation:
1. Run `pwd`. Output MUST start with the absolute path to a directory containing `/.claude/worktrees/` (or similar isolated path). If it shows the orchestrator's main checkout root, STOP and abort — do not write anything.
2. Run `git rev-parse --show-toplevel`. Confirm the result is your worktree root, NOT `C:\dev\mcp-midi-tools` (the orchestrator's main checkout).
3. FOR ALL FILE PATHS: use RELATIVE paths only (e.g. `packages/am4/src/params.ts`). NEVER use absolute paths like `C:\dev\mcp-midi-tools\...`. The Read/Edit/Write tools resolve absolute paths verbatim — using the orchestrator's absolute path will write to the wrong directory.
4. After every Write or Edit, run `git status --short` and verify the file appears as modified in YOUR worktree, not silently elsewhere.
=== END WORKTREE-ISOLATION GUARDS ===
```

Empirical: across two batches of 3 dispatches each (6 sub-agents
total), the header was 100% effective in batches that included it.
The one failure (Session A pre-header, killed mid-investigation)
required salvaging the work-in-progress out of the orchestrator's
working tree via `git stash` and re-applying it after the rest of
the batch was merged.

## Single-writer files — pick one session per turn

These files are touched by almost every session. Two sessions writing to
the same one will conflict at merge time. Designate **one** session per
turn to update them, or leave them for a post-merge consolidation pass:

- `docs/_private/STATE.md` — session orientation; whichever session
  closes the bigger finding writes the update.
- `docs/_private/SESSIONS.md` — chronological log; same rule.
- `docs/DECISIONS.md` — non-obvious choices; the session that made the
  choice owns the entry.
- `MEMORY.md` / `~/.claude/projects/.../memory/` — auto-memory is
  per-machine, not per-worktree, so concurrent writes race.
- `CLAUDE.md` — meta-doc; rare edits, never split across sessions.
- `package.json`, `package-lock.json` — dependency churn collides
  ugly; do dep changes solo.
- `.claude/settings.local.json` — same story.

If a session needs to write one of these and another session is also
running, surface it in the peek panel and have the other session skip
that file.

## Merge-back workflow (per session)

The "Background-session role" section in `CLAUDE.md` is the contract:
when a session's cwd is under `.claude/worktrees/`, it MUST commit
and push the auto-created `worktree-<name>` branch before declaring
its task done. The orchestrator's "don't commit without instruction"
rule does NOT apply to background sessions.

Order inside the worktree, before the row leaves the `Working` group:

1. **Run `npm run preflight`** — typecheck + `verify-pack` +
   `verify-msg` + `verify-transpile`. The project's commit contract.
2. **If TypeScript under `src/` changed** and the next user step is
   testing in Claude Desktop, run **`npm run build`** in the worktree
   too. The dist is what Claude Desktop loads.
3. **Commit unstaged work** to the worktree's `worktree-<name>` branch
   with a descriptive message. No `Co-Authored-By: Claude` trailer.
   No `--no-verify` / `--no-gpg-sign`.
4. **Push** the feature branch. Never `origin/main`. The PR status
   dot on the Agent View row turns green when checks pass.
5. **Only then** post the completion summary. If preflight is red or
   push failed, the session stays open with the blocker named — the
   founder attaches and decides.

The founder merges on GitHub, then `Ctrl+X Ctrl+X` on the row in
Agent View removes the worktree and its branch.

Worktree directory the session is using is visible in the peek panel
or by attaching and running `pwd`.

## Combining batches: streaming-merge into local main (preferred)

Opening separate PRs per dispatch round is friction the founder doesn't
want. The tested-and-preferred workflow is **streaming-merge into local
main**: as each sub-agent returns, the orchestrator session merges its
branch into local main, runs preflight, and reports diff for review.
**Nothing is pushed to `origin/main`** — the founder pushes when ready
(CLAUDE.md absolute rule + founder's explicit intent: "I can choose
what's pushed"). The pushed `worktree-<agent-id>` branches on `origin`
stay as a safety net; if local main goes wrong, `git reset --hard
<pre-batch-anchor>` rolls back and the work survives on remote.

### Two dispatch patterns

**Pattern A (used in production 2026-05-16):** orchestrator calls
`Agent` with `isolation: "worktree"` + `run_in_background: true` for
each item. Sub-agents are NOT visible as rows in `claude agents` view —
they're contained in the orchestrator's conversation. Pro: fully
automated, ONE command. Con: less peek/interrupt granularity.

**Pattern B:** founder pastes 3 prompts into Agent View's dispatch
input by hand. Sub-agents show as peekable Agent View rows. Pro:
visibility, interruption easy. Con: more manual typing.

Both end with the same streaming-merge recipe below.

### Trigger phrases (orchestrator)

After each sub-agent returns its completion summary, the orchestrator
runs the per-branch merge automatically — no trigger needed for the
"normal" case. The founder explicitly says **"stream-merge"** or
**"merge as they return"** at the start of a batch to confirm intent.

### The streaming-merge recipe (per agent return)

1. **Record the pre-batch anchor** (first time only):
   `git rev-parse main > /tmp/batch-anchor` (or just note the SHA).
   This is the rollback target if any merge goes wrong.
2. **On each completion notification:** the orchestrator gets the
   sub-agent's branch name and commit hash in the return summary.
3. **`git fetch origin worktree-agent-<id>`** — pick up the pushed branch.
4. **Preview:** `git diff --stat main...origin/worktree-agent-<id>`.
   Note any files the agent touched that other already-merged
   sessions also touched — predicts conflicts.
5. **`git merge --no-ff origin/worktree-agent-<id> -m "Merge Session
   <letter>: <one-line summary>"`** into local main. Use `--no-ff`
   so each merge stays visible in `git log --graph`.
6. **Resolve conflicts inline.** The predictable ones (from the two
   2026-05-16 batches):
   - `scripts/_research/coverage-cross-ref-audit.ts` `WIRED_MISLABEL_
     CEILING` constant — two sessions both update it (one raises with
     new entries, one lowers with renames). Resolve by accepting one
     value temporarily, running the audit, then tightening to the
     actual post-merge count.
   - `packages/am4/src/params.ts` — only conflicts if two sessions
     write the same family. The 2026-05-16 batches got lucky here
     (DISTORT vs CABINET vs WIRED-MISLABEL renames touched disjoint
     line ranges). If two sessions hit the same family, resolve by
     hand and re-run `npm run preflight` after.
   - `scripts/verify-msg.ts` — if a session renamed a param key,
     grep for stragglers (`compressor.attack[^_]`, etc.) and fix
     them before declaring done.
7. **`npm run preflight`** — must be green. If red, do NOT push the
   problem forward — surface in chat and resolve before merging the
   next sibling branch.
8. **Report in chat:** what merged, files touched, preflight result,
   any conflicts you resolved + how.

### When a sub-agent doesn't honor its worktree (Session A pattern)

The 2026-05-16 batch 1 Session A wrote into the orchestrator's main
checkout instead of its worktree. Its assigned worktree branch ended
up empty; the agent was killed mid-preflight-failure investigation.

Salvage recipe:
1. `git stash push -m "session-X-wip-rescued-from-main-checkout"
   -- <the specific files the agent touched>` — preserve the WIP.
2. Note that the agent's worktree and branch were nuked by `TaskStop`
   in 2.1.139+ (verified empirically); the stash is the only surviving
   copy.
3. Merge the rest of the batch first (the well-behaved sessions).
4. `git stash pop` onto the merged main. Resolve conflicts.
5. Run `npm run build` (verify-msg.ts imports from dist, not src — a
   killed agent's WIP may not have built dist yet) then
   `npm run preflight`. Fix any dangling references the agent missed
   before being killed.
6. Commit on local main directly with a message naming the salvage
   provenance. The agent's branch is gone; no merge-commit possible.

This whole sequence is what the "Worktree isolation: required prompt
header" section above is designed to prevent on the next dispatch.

### Cleanup after the founder pushes

Once the founder pushes local main to `origin/main`:

1. The `worktree-agent-<id>` rows in Agent View / Agent tool tracking
   are safe to remove. Their commits are now in main's lineage via
   merge commits.
2. `git push origin --delete worktree-agent-<id>` for each — keeps
   the remote tidy. (Or leave them; GitHub's branch-delete-on-merge
   doesn't fire for non-PR merges, so manual delete.)
3. If a stash was used for a salvage (Session A pattern):
   `git stash drop` after you're sure local main has the work.

### Item selection (where the 3 prompts come from)

Picking the 3 items is itself an agent task: dispatch a `Plan`
subagent with a planner prompt that reads `STATE.md` +
`npm run coverage-audit` + `docs/fractal-protocol-decode-status.md` +
the open `HARDWARE-TASKS-*.md` files and returns 3 dispatch prompts
ready to paste / re-dispatch. The planner's prompt should require:

- Each item touches a different package or different files within a
  package (see "AM4 `params.ts` / `paramNames.ts` / `cacheParams.ts`
  pipeline reality" above for what counts as "different files").
- No item edits the single-writer files listed below (STATE.md,
  SESSIONS.md, DECISIONS.md, MEMORY.md, CLAUDE.md, package.json,
  settings.local.json) — the orchestrator handles those during the
  streaming-merge step.
- No hardware-capture-blocked item (founder isn't at the device per
  dispatch round; capture work serializes separately).
- **Each dispatch prompt MUST start with the worktree-isolation
  header** from the "Worktree isolation" section above. Non-
  negotiable.

End-to-end: planner → 3 dispatched sub-agents → orchestrator stream-
merges each as it returns → founder reviews local main → founder
pushes.

## Cleanup when things go sideways

If a worktree got orphaned (crash, force-quit, etc.):

```bash
git worktree list                    # see all worktrees
git worktree remove <path>           # remove one
```

Old subagent worktrees with no uncommitted state are swept at Claude
Code startup based on `cleanupPeriodDays` in settings. Worktrees created
explicitly with `--worktree` (not Agent View auto-isolation) are never
swept — remove those manually.

## Practical limits

- **Sweet spot is 4–8 concurrent sessions per developer** per published
  field reports; we aim for ~3 here so review stays manageable.
- Background sessions consume subscription quota independently. Three
  parallel sessions burn quota ~3× as fast as one — fine on Max/Team,
  watch on Pro.
- Background sessions are local — they stop on machine sleep/shutdown.
  Restart all with `claude respawn --all`.

## When NOT to parallelize

Don't dispatch parallel sessions for any of the following:

- Anything that primarily edits one of the single-writer files above.
- A refactor that crosses package boundaries (touches `packages/core/`
  + `packages/am4/` + `packages/axe-fx-ii/` together).
- A `package.json` dependency change.
- Hardware-capture-driven work where the founder is actively at the
  device — serialize so each capture is unambiguous (one capture per
  hypothesis, per the RE workflow rules in `CLAUDE.md`).

## What worked / what to remember (lessons from 2026-05-16)

Two batches of 3 sub-agent dispatches each, all via Pattern A
(orchestrator-driven `Agent` tool calls with `isolation: "worktree"`).
Six sub-agents total; one failure recoverable via stash salvage.
Cumulative coverage delta: AM4 WIRED-MATCHED 222 → 292 (+70),
WIRED-MISLABEL 135 → 112 (-23), UI-MISSING 298 → 259 (-39); III
calibrated entries 0 → 186; new Hydrasynth reference docs.

**Worked:**
- Stream-merging into local main as each agent returns (vs. batch-PR).
  Founder gets per-merge review + the ability to interrupt before a
  later session conflicts on top of a problematic earlier one.
- The worktree-isolation header on every dispatch. 0 violations across
  the 5 sessions that received it; 1 violation in the one that didn't.
- Letting sub-agents push their branches to `origin/worktree-agent-<id>`
  before declaring done. The push is the safety net — if local main
  ever goes wrong, `git reset --hard <anchor>` rolls back and the
  work survives on remote.
- The pre-merge `git diff --stat main...origin/worktree-...` preview
  caught the Session B unexpected `params.ts` write in time to plan
  for the conflict that didn't happen (different family ranges).

**Bit us:**
- `params.ts` "do not write" rule was too tight — the cache-gen
  pipeline doesn't reach catalog-only ids, so two of six agents had
  legitimate reasons to write `params.ts` directly. Documented in the
  "Safe parallelization seams" section above. Future dispatches should
  whitelist all three pipeline files (`paramNames.ts` + `params.ts` +
  `cacheParams.ts`) for AM4 family-coverage tasks.
- `docs/_private/` is gitignored, so files an agent writes there
  (e.g. Session F's harvest audit) don't propagate via merge. Workaround:
  if the founder wants the audit in main's checkout, copy it manually
  from the worktree directory (`.claude/worktrees/agent-<id>/docs/
  _private/<file>`) into the main checkout's `docs/_private/`.
- Fresh sub-agent worktrees lack `samples/` because the directory is
  gitignored — `preflight` runs `coverage-cross-ref-audit.ts` which
  reads from `samples/captured/decoded/`, so it fails standalone in
  worktrees. Fixed in `.worktreeinclude` (added the specific JSON +
  XML inputs the audit reads).
- `TaskStop` on a sub-agent wipes the worktree AND deletes its branch
  in 2.1.139+. If a sub-agent misbehaves and you need to stop it,
  stash any WIP you find in your main checkout BEFORE running
  `TaskStop` — the worktree is gone afterward.

## See also

- `code.claude.com/docs/en/agent-view` — official Agent View reference.
- `code.claude.com/docs/en/worktrees` — `--worktree` flag, `.worktreeinclude`,
  cleanup, non-git VCS hooks.
- `code.claude.com/docs/en/sub-agents` — `isolation: "worktree"` semantics
  (cwd-only, no path-prefix enforcement) and prompt design guidance.
- `CLAUDE.md` — project git discipline, preflight contract,
  living-documentation rules that every session must follow.
