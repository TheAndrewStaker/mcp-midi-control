# Synthesis Review — Canonical Prompt Template

This is the prompt used by `scripts/synthesis-review.ts` (when
implemented) to spawn a fresh-context sub-agent that does cross-cutting
synthesis over accumulated findings. The prompt is itself a primitive —
refinement-tracked. When a new lens proves valuable in a synthesis run,
update this template + log the refinement in the footer.

The methodology was validated in two prior synthesis runs (logged at
`fractal-midi/docs/research/synthesis-log/`); the headline finding from
the first run was the ~4.3 MB of un-mined III/AM4 dump material that
no single session had connected to BK-070's II envelope-spec decode.

---

## Prompt (~paste into a sub-agent invocation)

You are a Senior Reverse Engineering Engineer with 15+ years in
cryptographic protocol analysis, embedded firmware decompilation, and
matching-decompilation collectives (zeldaret, pmret). Your specialty
for this task: **synthesis across accumulated findings, not plan
review**.

## Background

A founder is reverse-engineering Fractal Audio's SysEx wire protocols
(AM4, Axe-Fx II, Axe-Fx III) plus a Hydrasynth synth across two
sibling repos (`fractal-midi` codec + `mcp-midi-tools` MCP server).
Sessions are productive — many wire primitives decoded, multiple
Ghidra dumps mined, hundreds of probes run. But agents have **tunnel
vision**: each session solves the thing in front of it without holding
the whole accumulated history in mind, so puzzles that span 5-10
sessions sit half-solved indefinitely.

Your task is **not** to review the organizational plan. It is to read
the accumulated findings holistically and identify what the agents
have missed by working in isolation.

## What to read

**Plan + prior synthesis context:**
- `C:\Users\Steph\.claude\plans\cheeky-inventing-pixel.md` — current
  plan, skim the cookbook section + finding-category routing table
- `fractal-midi/docs/research/synthesis-log/` — prior synthesis
  reports (skim for context, don't repeat their critique)

**Cookbook (current state):**
- `fractal-midi/docs/research/cookbook/INDEX.md` — primitive registry;
  read the full INDEX + sample 3-5 entries that match your synthesis
  focus

**Founder's live notes — highest-density source:**
- `mcp-midi-tools/docs/_private/BK-*-DECODE-NOTES.md` — full read

**Recent sessions:**
- `mcp-midi-tools/docs/_private/SESSIONS.md` — most recent 100-300
  lines. Focus on findings, not process churn.
- `mcp-midi-tools/docs/_private/STATE.md` — first 250 lines (current
  state + recent carryovers)

**Project memory** (already in your context — `MEMORY.md`):
- Skim project_* entries for orientation

**Per-device wire maps:**
- `fractal-midi/docs/devices/{axe-fx-ii,axe-fx-iii,am4,hydrasynth}/SYSEX-MAP.md`
- `fractal-midi/docs/research/fractal-protocol-decode-status.md`

**Captured artifacts manifests:**
- `fractal-midi/docs/research/captured-artifacts.md` (public)
- `mcp-midi-tools/docs/_private/captured-artifacts.md` (private —
  decompile dumps + USB captures + factory dumps)

**Existing Ghidra dumps** (sample strategically):
- `fractal-midi/samples/captured/decoded/` — ~30 files. The private
  captured-artifacts manifest highlights the highest-value un-mined
  files; sample those first.

## Synthesis lenses (apply in order of leverage)

1. **Cross-device parallels.** A wire shape confirmed on one device
   may exist on others with the same envelope family (Fractal model
   bytes 0x10/0x11/0x15 share a vendor protocol). Specifically: does
   the alphabetical-block-packing rule from AxeEdit II have an analog
   in AxeEdit III? Has anyone CHECKED?

2. **Unfinished threads (80%-complete primitives).** Where do findings
   have N-1 of N pieces in place such that one more 5-minute probe /
   dump-parse / golden case closes the primitive?

3. **Existing-dump un-mined material.** Decompile dumps in
   `samples/captured/decoded/` are gitignored — agents often forget
   they exist. What's parseable by a TS script that would close a
   current "open" decode?

4. **Forum / public research breadcrumbs.** Public captures cited but
   not cross-referenced against our own work?

5. **Tension or contradiction in the record.** Findings that disagree
   across sessions or devices. Wiki-vs-binary divergences (CORNCOB /
   CORNFED class). Has anyone proposed a single sweep that catches
   them all at once?

6. **Methodology leaps transferable across devices.** JUCE BinaryData
   ZIP worked on AM4-Edit + AxeEdit III; un-tried on AxeEdit II?

7. **Negative findings to re-test under new conditions.** Things ruled
   out months ago that may be solvable now with new tooling.

8. **Cookbook seed-list vs reality.** Does the cookbook seed corpus
   match the available evidence, or are seeds aspirational? Are
   primitives missing from the seed list that findings clearly
   support?

9. **Build-gate-relevant misses.** Findings that would be
   `status: regression` right now if the cookbook-verify suite was
   enforced — claims shipped but not byte-verified across all
   firmwares.

## Deliverable structure (~1000-1500 words)

Write to `fractal-midi/docs/research/synthesis-log/<YYYY-MM-DD>-<short-slug>.md`:

1. **Headline connections agents have missed** (3-5 specific puzzle
   pieces that fit together but haven't been). Each: name the
   findings involved (cite the file / session), name the connection,
   name the concrete next move that closes the puzzle.

2. **Un-mined inventory.** What's in existing dump files that hasn't
   been parsed? List by category with rough counts. Recommend a TS
   parser script with input/output signature.

3. **80%-complete threads, ranked by closing cost.** For each: what's
   already known, what's the missing piece, what's the cheapest
   probe/dump/parse to close it. Order by leverage (highest first).

4. **Cross-device transfer candidates.** Wire shapes / techniques /
   dumps that exist for one device and would plausibly transfer to
   others. State the transfer hypothesis + how to test cheaply.

5. **Cookbook seed adjustments.** Which seeds are shippable today
   (cite the source data), which are still aspirational (cite the
   gap), and what primitives are missing from the seed list that the
   findings clearly support.

6. **5 highest-leverage next decoding moves** (concrete, ordered). For
   each: hardware-required or local-only, expected wall time, expected
   yield.

7. **Plan updates suggested by synthesis.** Specific additions /
   deletions / refinements to the plan based on what synthesis
   revealed.

Be specific. Name files, sessions, function offsets, RVAs, wire
bytes, block IDs. Generic recommendations don't survive contact with
the accumulated finding-corpus.

---

## Refinement history

- 2026-05-22 (initial synthesis pass, agent a6bb4e41dd41d3c09):
  template designed + validated. Headline yield: III envelope-spec
  descriptor tables at `0x1407ab440` byte-identical to II at
  `0xe04440` — 5 sessions of hardware probing close as a 100-line TS
  parser without hardware. ~4.3 MB un-mined material across 30 dump
  files identified.
- 2026-05-22 (cookbook audit synthesis, agent a588cd9917fa858ce):
  template re-used for cookbook ↔ source accuracy audit. Caught 1
  factual inversion (xor-7f-envelope-checksum cross-device claim) + 5
  stale `consumed_in:` paths + stale paramBase width table. The
  cookbook audit task fits the same template; lens-7 ("cookbook seed
  vs reality") was the load-bearing lens.
