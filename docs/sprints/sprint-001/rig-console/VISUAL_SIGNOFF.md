# Rig Console: visual sign-off

The project's first UI surface, owed since the build session (flagged in
RIG-CONSOLE-NEXT.md and RIG-CONSOLE-HANDOFF-2.md). Two surfaces are covered:

- **The generated file**: `npm run rig-console` writes
  `docs/_private/rig/rig-console.html`; double-click it, no server needed.
- **The served page**: `npm run rig-console:serve` prints a
  `http://127.0.0.1:PORT/#t=...` URL (repo-run, full three panels), or the
  `open_rig_editor` tool from a chat session (rig panel live; card + setlist
  labelled absent, by design). Open the WHOLE URL including the `#t=` part.

Legend: `[A]` = verified by the agent through the Playwright browser on
2026-08-06 against the live manifest (12 devices / 20 cables / 2 bindings,
156-of-320 card capture, 17-song setlist). `[ ]` = needs your eyes; check the
box and note anything wrong in "Issues found" below. Screenshots from the
agent pass (private, gitignored): `docs/_private/rig/rig-console-served.png`
and `docs/_private/rig/rig-console-generated.png`.

## Agent-verified (machine-checkable, re-run on any change)

- [x] `[A]` The rendered diagram matches the live manifest: 12 device boxes,
      20 cables, and the header stats agree with the source chips.
- [x] `[A]` Both surfaces load with **zero console errors** (the served page's
      favicon 404 was found by this pass and fixed with a `data:` icon).
- [x] `[A]` No horizontal page scroll on either surface at 1280px.
- [x] `[A]` Keyboard: a device row takes focus, Enter selects it (6 cables
      highlighted for the Circuit, announced via the `aria-live` region),
      Escape clears. 55 focusable controls on the page.
- [x] `[A]` Selecting a song lights its projects on the card grid (5 slots for
      the first placed song), `aria-pressed` tracks the selection, and "Show
      everything" resets both filters.
- [x] `[A]` The diagram is `role="img"` with a summarising `aria-label`; the
      text peer view is present (53,730 chars) and carries the same answers.
- [x] `[A]` The served page's boot flow: the `#t=` fragment authenticates,
      is scrubbed from the URL bar (`replaceState`), panels render, and the
      change stream connects (an agent-side `edit_rig` refreshes the page).
- [x] `[A]` Security posture asserted end-to-end by
      `npm run verify-webhost-security` (36 checks: auth, Host, CSP string,
      cookie scoping, unauthenticated-route allowlist, SSE, idle expiry).

## Needs a human (judgment the agent cannot make)

- [ ] The card grid's pad colours read as the SAME colours the Circuit's
      Projects view shows under your hands (the hex table is a rendering of
      Novation's names, not sampled from hardware; page footnote explains).
      Spot-check 2 songs you know, e.g. one stamped Khaki and one stamped Cyan.
- [ ] The signal-flow diagram's reading order matches how you think of the
      rig (clock source at top, front-of-house at bottom).
- [ ] Light mode: flip the OS theme and confirm both surfaces stay readable
      (contrast, pad label legibility on pale pads).
- [ ] The text rendering, read top to bottom (or via screen reader), answers
      "what connects to what, on which channel, what fails a check, where does
      every song live" without needing the diagram.
- [ ] The phone-side story: the chat artifact (not this console) is the mobile
      surface; confirm reading the rig via `describe_rig` in the Claude app is
      good enough that no LAN bind is missed.
- [ ] Print preview (Ctrl+P) of the generated file: filters expand, buttons
      hidden, nothing clipped.

## Issues found

_(write anything wrong here; PO converts to tasks next session)_
