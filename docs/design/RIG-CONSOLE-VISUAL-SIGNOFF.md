# Rig Console visual sign-off — Phase A–C (the overlay design)

The founder's checklist for the first review of the full overlay design on
the REAL console, per the global visual-sign-off convention (adapted to this
repo's docs/design/ layout — no sprint tree here). Check items off and note
issues in the section at the bottom; the next session converts issues to
work items. Once these flows have Playwright coverage plus the screenshot
baseline (Phase D), this file retires.

> **Phase D landed 2026-08-24** (`npm run verify-console-flows`, in preflight:
> 18 flow specs + a 4-shot win32 screenshot baseline over a synthetic fixture).
> Items marked `[auto]` below now have automated coverage — for those, the
> remaining review is the judgment half only (does it LOOK right / feel fast).
> `[manual]` items stay yours entirely. The 2026-08-24 mid-dogfood feedback
> round (map to the top-right quadrant, status to the bottom-left corner,
> Show Everything removed, one item always inspected, served-shell height fix
> that unblocked the MIDI Flow button) is already built and covered.

**How to launch:** IntelliJ run config "Rig Console (serve)" (or
`npm run rig-console:serve`), then open the printed tokenised URL. For the
static fallback: `npm run rig-console` → `docs/_private/rig/rig-console.html`.

## Shell + theme

- [ ] `[auto]` The page opens in the tactical look: deep blue ground, gold
      location line under the title, real fonts (squarish UI face + tech
      mono — the gate asserts RigUI/RigMono actually load; the LOOK is
      yours to judge).
- [ ] `[auto]` `[` and `]` cycle Rig / Songs / Packs; clicking tabs works;
      the amber location line follows the page.
- [ ] `[manual]` After an agent-side `edit_rig`, the page refreshes WITHOUT
      bouncing you off the page you were on. (Served-shell behavior; the
      file:// gate cannot drive the host.)
- [ ] `[auto]` No status dots anywhere. Source status is now the amber
      SYSTEM corner at bottom-left (your 2026-08-24 note), not top chips.
- [ ] `[auto]` Print preview (Ctrl+P): all sections appear, tabs/chrome
      hidden, white paper background.

## The living map (Rig page)

- [ ] `[auto+judgment]` The map fills the RIGHT HALF, tall (your rounds 2-3:
      top-right AND bottom-right quadrants, mild overscan ok): uniform
      modules snapped to four column tracks, a dim spine through the hub's
      track, 1-2 line wrapped labels. Inspect top-left, system status
      bottom-left as a right-aligned ledger, legend bottom-right. The old
      diagram+list are gone from view (they return in print).
- [ ] `[auto]` One item is ALWAYS selected: the hub inspects on load, and
      a flow switch keeps the selection when the device survives it.
- [ ] `[auto]` It opens in AUDIO flow: RC-505 rooted at the top, feeders
      below by hop, front of house above the root. Quadra is ABSENT here —
      it carries no audio, and absence is the honest rendering.
- [ ] `[auto]` Toggle to MIDI flow (the button is clickable again — the
      served shell's collapsed-height bug is fixed): devices GLIDE to the
      band layout; audio wires ghost faintly beneath where both ends stay.
- [ ] `[auto+judgment]` Wires are line+arc only — the gate bans bezier
      kinks outright; whether every connection is FOLLOWABLE on your rig
      stays your call.
- [ ] `[auto]` Drag pans; wheel zooms; click a DEVICE → the floating
      inspect fills with its full detail; click a CABLE → its endpoints,
      kind, and label.
- [ ] `[auto]` Click the Circuit → "View card mapping" appears in its
      inspect and jumps to the Packs page.
- [ ] `[judgment]` Map labels render at the list body size when the modules
      can hold the longest visible line; a crowded fit caps them smaller so
      neighbouring labels never collide. Confirm the size still reads at
      arm's length.

## Songs + Packs (the dogfood loop)

- [ ] `[auto]` Songs page: the table is grouped "On the board" / "Staging"
      (a card-less song now appears exactly once — the double-draw the
      fixture caught is fixed).
- [ ] `[auto+judgment]` Selecting a song lights its project run on the
      Packs grids; whether pad colors match the device under your hands is
      yours.
- [ ] `[auto+judgment]` The gold VOICES panel: selecting a song fills it
      from song-mappings.json. ALL 17 set songs now have voice rows
      (BK-VOICES-FILING, 2026-08-24): ear-picked ones `proposed` for your
      confirm, unpicked ones `owed` so the audition work is visible per
      song. Is this fast enough to act on mid-session?
- [ ] `[auto]` Packs page: CLICK any used pad — a floating detail panel
      shows the project's name, song, section, pad colour, BPM, and
      markers; Esc or re-click closes it. Hover tooltips still work.

## Issues found

- (write here)
