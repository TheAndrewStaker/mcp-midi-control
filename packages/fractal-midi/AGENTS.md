# AGENTS.md, fractal-midi

Read this first if you're a Claude Code agent (or another LLM agent)
working in this repository.

## What this repo is

`fractal-midi` is the pure-TypeScript codec for Fractal Audio's SysEx
wire protocols (AM4, Axe-Fx II, Axe-Fx III). The same tree also carries
an ASM Hydrasynth codec used by the consumer server, but that codec is
developed in-tree only and is NOT part of the published `fractal-midi`
npm exports: the published npm surface is Fractal-only (`./am4`,
`./axe-fx-ii`, `./axe-fx-iii`, plus `./shared`). The codec is **consumed**
by `mcp-midi-control` (an MCP server that wraps it into Claude
Desktop-callable tools). The two repos have a strict separation:

- **This repo (`fractal-midi`)**: wire codec, parsers, builders, param
  dictionaries, block tables, calibration, fractal-shared lineage.
  No node-midi. No MCP server. No tool surface.
- **`mcp-midi-control`**: MCP server, tool descriptors, dispatcher,
  agent guidance, parallel-device agent infrastructure. Consumes
  `fractal-midi` as an npm package.

If you find yourself wanting to add `node-midi`, a tool registration,
or any agent guidance to THIS repo, stop. That work belongs in the
consumer repo.

## Reading order

**For codec / protocol RE work:**

1. **[`docs/research/primitives/INDEX.md`](docs/research/primitives/INDEX.md)**:
   the encoding primitive Rosetta stone. Before researching a new
   wire shape, scan the primitives. The shape may already be a known
   primitive.
2. **[`docs/research/INDEX.md`](docs/research/INDEX.md)**: the broader
   research entry point: per-device decode status, captured artifacts
   manifest, Ghidra script registry, per-device follow-ups,
   methodology guides.
3. **[`docs/research/ghidra-mining-workflow.md`](docs/research/ghidra-mining-workflow.md)**:
   methodology plus documented "what didn't work" entries. Don't
   re-attempt failed approaches.
4. **Per-device wire map** for the device you're touching:
   - `docs/devices/am4/SYSEX-MAP.md`
   - `docs/devices/axe-fx-ii/SYSEX-MAP.md`
   - `docs/devices/axe-fx-iii/SYSEX-MAP.md`
   - `docs/devices/hydrasynth/SYSEX-MAP.md`

**For operational state** (current phase, recent breakthroughs, open
hardware tasks), those live in the consumer repo:

5. **The consumer repo's private operational notes** (gitignored, local
   to the maintainer's working tree). If you're an OSS contributor, you
   won't have these; that's expected. Operational state isn't
   OSS-published.

## Public / private split

Both repos are OSS-intended. The split between what's committed (and
publicly publishable) vs. maintainer-private:

**Committed (this repo, public):**
- All primitive entries (encoding primitives, methodology)
- Per-device wire maps (SYSEX-MAP files)
- Ghidra mining workflow + script READMEs
- Public captured-artifacts manifest (forum captures, non-sensitive
  probe outputs)
- Per-device follow-ups (research roadmap)
- Synthesis logs (cross-cutting reports)

**Gitignored (maintainer-local, in the consumer repo's private notes):**
- Operational state (session log, hardware task queue, backlog)
- Maintainer-purchased factory dumps plus USB captures of the
  maintainer's hardware
- Decompile dumps of vendor binaries (the dumps themselves, not the
  narrative)
- Maintainer-private captured-artifacts manifest (the bytes catalogue)

The mechanism that gets agents to read gitignored files when present:
the consumer repo's `CLAUDE.md` references the private paths explicitly.
OSS contributors fall through to the next item in the reading order
when a private file is absent.

## Decompile-derived contributions: IP rule

**Decompile-derived narrative is welcome.** Param tables, opcode enums,
calling-convention writeups, decode methodology: that's the OSS public
good and what this project ships.

**Raw decompile listings are NOT welcome.** Raw disassembly or
decompiled C from any Fractal binary, AxeEdit, or AM4-Edit must not
be committed in any form. PRs that include raw decompile dumps will be
closed and the contributor asked to resubmit as narrative + cited
offsets + scripts to regenerate. Maintainer review required for any PR
that adds material the contributor describes as "extracted from the
binary."

This protects the project and the maintainer from a class of
contribution that would otherwise look helpful but creates legal
exposure.

## Session-close discipline (when you do RE work)

Before declaring a session complete:

1. **Primitive updates.** Did you discover, refine, or rule out an
   encoding primitive? Register it the same session in
   `docs/research/primitives/<name>.md` (or `_negative/` / `_partial/` /
   `_scratch/`). Don't defer to "next session."
2. **Cross-device transfer reflex.** Scan the other 3 device wire-maps
   for analogous decode gaps. File `[transfer-candidate]` follow-ups
   per the consumer repo's `CLAUDE.md` § "Cross-device transfer reflex".
3. **Capability application pre-flight** (if you wired a primitive
   into a shipping tool path in the consumer repo). 5-check protocol:
   latency / source-of-truth / bug-fix-mapping / scaffolding /
   N=1-generalization. Cite the evidence in the commit body.
4. **Artifact registration** (same-session). New Ghidra script →
   `scripts/ghidra/README.md`. New dump or capture-of-interest →
   `docs/research/captured-artifacts.md` (public) or the private
   manifest. New primitive → primitive entry.

The discipline rules are codified in the consumer repo's `CLAUDE.md` §
"Capability application discipline" and § "Same-session artifact
registration."

## Two-repo iteration workflow

When you need to change codec wire shapes (params.ts, builders,
parsers, block tables, calibration, fractal-shared lineage):

1. Edit in this repo.
2. Run this repo's tests (`npm test`).
3. Bump version in `package.json` (alpha bump is fine pre-1.0).
4. `npm pack` → produces `.tgz`.
5. In the consumer repo, run `npm install /path/to/.tgz`.
6. Test the integration.
7. When solid, push the fractal-midi commits and tag the alpha
   version. CI publishes to npm.

For quick iteration: `npm link` between the two repos avoids the
pack/install cycle. Reset to a published version before committing
in the consumer repo.

## Where things go (quick routing reference)

| Finding | Goes to |
|---|---|
| Encoding primitive (universal Fractal envelope shape, septet, hash, struct layout, etc.) | `docs/research/primitives/<name>.md` |
| Per-binary class/function/RVA finding (anatomy of AxeEdit / AM4-Edit binary) | `docs/research/ghidra/<binary>-anatomy.md` |
| Per-device wire shape (specific fn-byte payload spec for one device) | `docs/devices/<device>/SYSEX-MAP.md` |
| MCP-server dispatcher / tool surface pattern | consumer repo's `docs/dispatcher-patterns.md` |
| Test-infrastructure pattern (mock fixture, assertion shape) | consumer repo's `scripts/agent-regression/` (lives with tests) |
| Operational state (session log, hardware tasks, backlog) | consumer repo's private operational notes (maintainer-local, gitignored) |
| Methodology / workflow guide | `docs/research/<workflow-name>.md` |
| Synthesis report (cross-cutting agent run) | `docs/research/synthesis-log/<date>-<slug>.md` |
