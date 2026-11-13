# Rig Console menu language (tactical-overlay system)

Distilled 2026-08-23 from a design-organization research pass over the owner's
named references (MGS V's iDroid system, surveyed firsthand via the Interface
In Game and Game UI Database galleries, plus Final Fantasy menu conventions).
These are REUSABLE INTERACTION CONVENTIONS phrased as rules for our own
original UI — we take the organizational grammar, never the artifact (no
copied icons, marks, typefaces, screen text, or traced layouts). Sources at
the bottom. The owner's own reference screenshots and reactions live in
RIG-CONSOLE-WORKPLAN.md.

## Structure

1. **The top strip is PLACES, not actions** — 3-5 destinations max, bracketed
   by the traversal-key glyphs (`[` `]` for us); whatever sits between the
   glyphs is what those keys cycle. Actions never live in the top strip.
2. **Two-tier traversal:** at root, the side-keys switch hubs; descending into
   a section replaces the hub strip with a section-local sub-strip (same keys,
   new scope). Never show two levels of tabs at once.
3. **Wayfinding is a stamp, not a widget:** a permanent identity/version mark
   in the top-left corner, with the current location hanging off it in the
   "location" accent as a plain text breadcrumb. The one always-true answer to
   "where am I".
4. **Child menus stack IN PLACE over a dimmed, blurred parent** — depth reads
   as sheets lifting, not page navigation.

## Screen grammar

5. **Fix the four corners product-wide:** top-left = identity + location;
   top-right = persistent long-running state (for us: clock/transport or an
   active gate run); bottom-left = one-sentence screen caption + the primary
   action chip; bottom-right = the vitals cluster (last run, counts). Users
   learn them once; transitions never move them.
6. **Panels float; the background layer is ambience, never information.** Our
   background layer is the rig wire graph (their map). All data lives in the
   panels; the graph is the SUBJECT only on the Rig page.
7. **Split container-list from content-list** as two side-by-side panes (their
   tapes/tracks; our banks/patches, packs/projects, songs/parts) instead of a
   deep drill.
8. **Every list screen self-documents:** one plain sentence stating what the
   screen is for, docked next to the single primary action.
9. **Results/confirmations get a separate centered grammar** (big grade, stat
   row); browsing screens stay quiet and rectangular. For us: a gate-run
   result could use this; nothing else does.

## Lists, tables, detail

10. **Headers are icons; cells are letters, counts, short numerals.** Build a
    small fixed grade vocabulary and reuse it everywhere.
11. **Selection = a full-width brightness band** (never an outline or color
    swap). **Sort column = a tinted vertical band + direction caret**, with
    the active sort ALSO stated in words near the footer.
12. **Panels never resize with their data** — pad tables with ruled empty rows
    so geometry is constant.
13. **One cursor per screen.** Secondary panes react to the selection; they
    are never a second focus.
14. **Quantitative bars share one grammar:** label left, track right,
    proportional fill, exact numerals adjacent; deltas append to the SAME bar
    in the good/bad accents, never a second bar.
15. **Two altitudes of the same list behind one toggle** (table view vs card
    view), not two screens.

## State + color

16. **Monochrome base + exactly two reserved accents.** Accent A
    (amber/gold) = location + new/noteworthy, NEVER interactive chrome.
    Accent B (red-warm) = cost/penalty/danger. Selection is brightness, never
    a third color. (Our base: the deep blue-cyan already chosen.)
17. **Badge counts at the SOURCE** (on the tab, on the category icon) so new
    content is discoverable from anywhere above it.
18. **Locked/absent things stay visible:** dimmed-in-place with their
    unlock/missing requirement; undiscovered things as placeholders. The
    space itself communicates scope. (Maps directly onto our
    verified/proposed/owed vocabulary.)
19. **Texture discipline:** grain/scanlines/shimmer live on panel grounds and
    empty regions only; every text block sits on a calm dark band. Ship a
    "calm" toggle from day one (the community readability mods for the
    reference game are the cautionary tale).

## Input + motion

20. **Verbs are footer chips (key glyph + word), primary verb leftmost, chip
    style constant across screens.** Pane-scoped verbs dock BESIDE their pane,
    not in the global footer.
21. **Animate only the content sheet** (fast slide/fade, <200 ms), over a
    continuously-alive background; corner anchors never move. Every overlay
    dismissable the frame it appears.
22. **Long-running state gets a slim persistent strip** on every screen, never
    a screen you're trapped in.
23. **Responsiveness is a hard requirement decoration must never tax** (the
    FF XVI review's failure list: decorative transitions that drop menu
    responsiveness, one screen that loads differently from the rest,
    non-dismissable overlays with slow tallies — all named anti-patterns).
24. From classic FF: **one window chrome everywhere + a fixed verb vocabulary
    in fixed order**; from FF XIV: **user-adjustable layout** and semantic
    color constancy at scale — the long-term direction if the console grows
    dense.

## Sources

Interface In Game MGSV gallery (interfaceingame.com/games/metal-gear-solid-v-
the-phantom-pain/), Game UI Database MGSV catalog (gameuidatabase.com/
gameData.php?id=98), Metal Gear Wiki iDroid page, Durczok's FF XVI interface
analysis (medium.com/@I_am_PD), FFXIV official UI guide
(na.finalfantasyxiv.com/uiguide/know/), readability-mod evidence
(nexusmods.com MGSV mods 227, 2339).

## Addenda from live mockup reactions (2026-08-23)

25. **Type hierarchy is anchored to the map:** list/table body text matches
    the map-label size; only corner informational bits (vitals, hints,
    breadcrumb) drop to fine print. (Owner rule after reading the live
    overlay mockup.)
26. **Pages own their content — never duplicate a panel across pages**
    (owner ruling 2026-08-23, reversing a brief experiment). The RIG page is
    map + inspect; the song list lives on SONGS only. The top-left region is
    standing usable space on the RIG page for FUTURE rig-specific content
    (e.g. a device list — distinct content, not a copy of the songs panel).
27. **Pointer-capture panning retargets click events** — element inspection
    must resolve the element at pointer-DOWN and fire on a movement-free
    release, never via the click event (bug found live in the mockup).

## Song-list scaling design (2026-08-23, owner ask: dozen+ songs, categories, new-markers, setlists)

Why the mockup shows 4: it reads `song-mappings.json`, which holds only the
songs with FILED, testable claims. The real library (15+ songs) lives in the
setlist/card sources the actual console already joins — Phase B binds the
songs page to that join, so the full roster appears with no new data work.

The design, per the existing rules:
- **Roster = the setlist join, not the gate manifest.** Songs without filed
  claims appear DIMMED-IN-PLACE with "no claims filed" (rule 18) — scope
  stays visible, the gate's authority stays honest.
- **Categories = a section-local filter strip** on the SONGS page (rule 2):
  ALL · <setlist name> · STAGING · NEW, traversed with Shift+[ / Shift+]
  (the page keys stay [ ]). Filters are chips in the strip, counts as gold
  numeric badges AT THE SOURCE (rule 17) — never dots (owner rule).
- **NEW markers:** a gold NEW text tag on recently-filed rows; requires a
  `filed` date in the song-mappings schema (small schema addition, next
  session that touches the JSON).
- **Setlists/performances as containers** (rule 7, container/content):
  a setlist is an ordered song grouping (setlist-sync already exists);
  a PERFORMANCE is a dated gig holding a setlist snapshot. Long-term: the
  filter strip's set selector cycles saved setlists; a performance view is
  a future page, not a filter.

28. **The design is THEMEABLE by construction** (owner rule 2026-08-23):
    the organization drives semantics, structure, and markup; the visual
    identity lives entirely in the token + component-style layer. Markup
    classes are named by ROLE (.panel-h, .inspect, .vitals, .filter-strip),
    never by appearance; every color, face, size, and effect resolves
    through tokens; a completely different look = a different theme
    stylesheet with ZERO markup change. Phase A implication: theme.ts
    ships the tactical theme as THE FIRST theme, not the only possible
    one — the existing quiet-dark could persist as an alternate — and the
    verify-console-design gate enforces the separation (no literal
    colors/fonts/sizes outside the theme layer), which is what makes
    "change our mind later" a stylesheet swap instead of a rebuild.

## The device-map contract (2026-08-23, owner requirement)

29. **Every first-class device ships a MAPPING SURFACE** — a visual render
    of its storage the way the DEVICE presents it, wearing the device's own
    lit colors (the Circuit pack grid with glowing pads is the canonical
    form and the required bar). Storage shapes per device: Circuit = 8×8
    project pads per pack; AM4 = the A01–Z04 bank×4 grid; Hydrasynth =
    bank strip × 128 slots; MicroFreak = 512-slot bank pages; SPD-SX = kit
    grid. The surface is a COMPONENT of the design system, not a page.
30. **Two projections of the same surface, reached by cross-links:**
    - RIG page → select a device → its detail links to the FULL map (all
      songs/patches across that device's storage, colored by song).
    - SONGS page → select a song → per-device chips link to the SCOPED map
      (that song's footprint lit, everything else dimmed-in-place, rule 18).
    Possibly combined in a list-detail arrangement later; the projections
    share one component with a highlight parameter, never two renderers.
31. **This is a FIRST-CLASS REQUIREMENT, not decoration:** a device claiming
    first-class support in the console must provide its mapping-surface
    model (storage dimensions, addressing labels, occupancy, per-slot color/
    song binding). Long-term this belongs beside the descriptor the same way
    recipes and guidance do — the console renders any device that declares
    the model, and variations (full vs scoped) are parameters, not forks.

32. **Wire routing is COMPUTED, never hand-drawn** (2026-08-23, from the
    live mockup's clipping wires): each end anchors on the node box
    PERIMETER with a standoff gap (wires never touch a box stroke),
    departs PERPENDICULAR to its edge, and multiple wires on one edge
    spread across distinct ports. Runs between stubs are STRAIGHT
    (owner refinement: bezier S-curves read as wiggle) — a short
    perpendicular stub at each box, one direct segment between, rounded
    joints. The real console's gutter-lane router already obeys the
    spirit of this; any new map surface must too.

33. **Device glyphs are drawn IN-HOUSE, never sourced** (2026-08-23):
    class-recognizable wireframe silhouettes in the system's stroke
    grammar (single stroke, currentColor, no fills, no brand art), one
    per device, declared beside the device's mapping-surface model
    (rule 29+). Sourced icon sets fail licensing provenance, stroke-
    grammar coherence, and themeability all at once.

34. **Map bands are DERIVED FROM CONNECTION TYPES, never hand-grouped**
    (owner direction 2026-08-23): devices that RECEIVE notes (the voices
    you play) form the primary band, grouped center under the clock
    master; devices receiving only clock/transport plus pure routers form
    the infrastructure flank. Vertical position still encodes hop depth
    within a band; glyphs live INSIDE the boxes. Position and wire color
    thereby encode the same voice-vs-timing distinction (redundant
    channels by design), and the cable truth stays honest — a voice fed
    via the router is drawn from the flank into the band, never as a
    fake direct line.

35. **Map routing is CURVED — smooth long arcs** (owner FINAL ruling
    2026-08-23, reversing a brief orthogonal take after seeing both live):
    perpendicular stubs, then one smooth cubic between stub ends, reach
    scaled with distance. The earlier "wiggle" complaint was S-bends from
    double-perpendicular beziers on an unorganized scatter — once the BAND
    LAYOUT organized the boxes (rule 34) and anchors got standoffs/spread
    ports (rule 32), curves read clean. REFINEMENT (owner, 2026-08-24): each wire is a
    SINGLE ARC that never inflects AND never kinks — no straight stub
    segments in the path (stubs meeting a curve at an angle read as
    kinks, the owner's second correction). The wire runs anchor to
    anchor as ONE quadratic whose control sits at the intersection of
    the two edge normals: it leaves and arrives tangent to its boxes
    and bends exactly once (a quadratic's curvature cannot change
    sign). Entries prefer the FACING SIDE of the target box when
    laterally offset, so significant wires are perpendicular pairs =
    clean corner arcs; the rare parallel pair gets a gentle
    near-straight cubic.
    OPEN: the audio-flow TREE view
    (rule 36/38) may want a modified indentation/shape to suit curves —
    resolve when Phase C builds the tree layout.
36. **The map's musician-default orientation is AUDIO FLOW, rooted at the
    audio hub** — the owner's own sketch rooted the rig at the RC-505,
    the box the performance terminates in. MIDI remains a co-equal view;
    both graphs live in the manifest.
37. **Grid + user-movable nodes:** auto-layout gives the deterministic
    default; nodes snap to a grid and the user drags to their ideal.
    Layout is VIEW STATE (persisted locally, per view), never manifest
    data. The owner supplies his ideal arrangement as a reference layout.
38. **FLOW TOGGLE — ACCEPTED BY THE OWNER: default AUDIO view, toggle to
    MIDI, each with its OWN deterministic layout** computed from that
    flow's topology (audio tree roots at the hub; MIDI tree roots at the
    clock master). One layout cannot serve both graphs faithfully —
    forcing it is what produced the crossing soup. Build terms from the
    challenge: toggling resets spatial memory, so devices ANIMATE to
    their new homes (<200 ms, rule 21) keeping glyph/label identity; the
    non-focused flow may GHOST at low opacity but never drives layout;
    user-drag customization saves per view; a combined overlay view is
    deliberately rejected.
