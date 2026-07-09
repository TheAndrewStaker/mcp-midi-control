# Groove → instrument mapping (design / roadmap)

**Goal:** take a drum groove authored in MIDI, understand what each note *means*
(kick, snare, closed hat…), and have it play back as the **correct instruments**
on every device we support: Circuit Tracks today, the Roland SPD-SX next
(connected to the Circuit as a MIDI 1/2 track), and future pad/drum gear.

The design principle is a **semantic ROLE layer** between source notes and device
targets, so neither side hardcodes the other. A groove resolves to a role map;
each device resolves roles to its own pads/slots/notes.

```
  source groove (MIDI notes)
        │   Layer 1: note → role        (GM Percussion map + per-source config)
        ▼
  roles: {kick, snare, closed_hat, ride, open_hat, tom, crash, …}
        │   Layer 2: role → device target
        ▼
  ┌──────────────┬───────────────────────┬───────────────────────┐
  │ Circuit drums│ Circuit MIDI 1/2 →SPD │ future device         │
  │ 4 tracks →   │ note → SPD-SX pad     │ pad/slot map          │
  │ pool slots   │                       │                       │
  └──────────────┴───────────────────────┴───────────────────────┘
```

## Layer 1: source note → role

- **Default: the General MIDI Percussion Key Map** (notes 35–81: 36=kick,
  38=snare, 42=closed hat, 46=open hat, 49=crash, 51=ride, …). This is the
  documented standard most MIDI drum grooves and DAWs follow.
- **Per-source override config** when a groove ships its own mapping (Kontakt key
  maps, EZdrummer/Superior, Roland kit docs). The pack's own documentation is the
  source of truth when it disagrees with GM.
- We already have a working seed of this in `scripts/groove-analysis/pack_groove.py`
  (`NOTE_TO_PIECE`, confirmed-by-ear core notes + flagged guesses). That logic
  should graduate into a typed, reusable **role map** table with provenance
  (confirmed vs guessed) per entry.

**Fold layer (`core/patterns/drumFold.ts`, shipped 2026-07-01).** Full GM 35–81
coverage (latin/aux percussion now resolves to FINE roles: bongo/conga/timbale/
agogo/cabasa/maracas/whistle/guiro/claves/woodblock/cuica/triangle) plus
hand-authored, ordered **fold chains** that reduce a dense kit onto a small one
at RESOLVE time: china→crash→ride, tom→perc→snare, open_hat→closed_hat,
conga→tom→perc… Chains stay within musical function; `kick`/`snare` are
terminal (never re-voiced). Wired into `voiceMap.ts` (host resolution) and
`externalRouting.ts` (external device maps), so a 30+-piece GM groove lands on
the SPD-SX's 9 pads or the Circuit's 4 voices with every substitution REPORTED
(warn-and-play) instead of the old `unmapped_voice` hard error; a voice with no
substitute (or any melodic voice) still errors honestly. **Identity invariant
(golden-locked):** on a target that owns every role, folding never fires; a
richer kit always plays the groove more faithfully, never differently.
Follow-up (not built): usage-ranked slot allocation for the Circuit-internal
4-track + sample-flip authoring path (today that reduction lives in
`pack_groove.py` / `drum_flips`; the fold layer handles the role→existing-slot
case only).

**Idle-pad recovery (`voice_notes`, shipped 2026-07-02).** The compression
report often shows a fold NEXT TO an idle pad (the Sleep Token pack folds
busy_hat/ride_bell while its songs never touch the SPD-SX clap/crash pads).
`external_targets[].voice_notes` pins a voice to an explicit note per call
(`{"busy_hat": 39, "ride_bell": 49}`), bypassing the voice_map + fold layer;
the user loads the matching sample on that pad (`author_kit`) and the piece
keeps its own pad. Deliberately per-call, NOT descriptor-level: pad idleness is
a property of the song/kit, not the device. `tom` fold chain also reordered to
`[snare, perc]` (fills carry on the snare; perc's arbitrary texture sample is
the last resort).

**Canonical role spine (`core/patterns/drumRoles.ts`).** The dialects disagree:
GM/SPD-SX say `hat`/`openhat`, the Circuit binding says `closed_hat`/`open_hat`.
`canonicalRole(name)` reconciles them to ONE role set (`DRUM_ROLES`) via an alias
table, so a groove's `hat` voice finds the Circuit's `closed_hat` slot and the
SPD-SX's hat pad alike. EVERY device map and import keys off canonical roles
(golden-checked: all `GM_DRUM_TO_VOICE` values + the SPD-SX dialect resolve).

## Layer 2: role → device target

Each supported device contributes a **drum target map**. Roles are the shared
vocabulary (the same set the Circuit `voice_map` and `pack_groove.SAMPLE_SLOT`
already use).

- **Circuit Tracks (4 drum tracks).** Role → pool slot via the canonical layout
  (`SAMPLE_SLOT`: kick=1, snare=2, closed_hat=3, ride=4 …). Authoring writes:
  (a) the drum step patterns, (b) per-step sample *flips* for roles that share a
  track, and (c) the **drum-track→sample binding** (now decoded:
  `ncs/drumBinding.ts`, `0x1a278`) so the project loads turnkey. Only 4 tracks,
  so >4 roles pack onto tracks via Sample Flip (already built in `pack_groove`).
- **Roland SPD-SX (via Circuit MIDI 1/2).** The SPD-SX is a thin MIDI target
  (`packages/spd-sx/descriptor.ts`): pads trigger from **Note On** (default
  ascending from C4=60, kit-dependent), kits recall via Program Change. Its
  `voice_map` is the **role → pad note** map (the Layer-2 target for this device);
  it already speaks the shared vocabulary (reconciled via `canonicalRole`). So the
  Circuit sequences it as an external MIDI 1/2 track:
  1. *Author the Circuit MIDI track*: emit each role's SPD-SX note on the chosen
     channel (already supported: `midi1`/`midi2` note tracks).
  2. *Match the SPD-SX side*: the pad→note→sample assignment must agree. Kit
     BUILDING is the Wave Manager / USB-storage path (the SPD-SX Python tooling in
     `scripts/spdsx/`), NOT MIDI. When that write support is exposed as MCP tools,
     we control the pad map and can guarantee role→note→pad alignment end to end;
     until then we honor the device's existing/default note map. NOTE: the SPD-SX
     PRO is a separate, fully-SysEx device, a future descriptor.
- **Future devices** add one target map; no groove or note-map changes.

## Layer 3: resolve roles to what's actually loaded

A role only sounds right if the matching sample is actually present. Two paths:
- **By known kit layout**: when we loaded the kit (`upload_kit`), we know which
  slot holds which role.
- **By name match**: `read_sample_directory` (decoded) returns each slot's name,
  so we can map a role to a slot by meaning ("kick" → the slot named *kick*) even
  for a kit we didn't load. This is the "map samples to matching configurations"
  half of the request.

## Build order (incremental, each shippable)

1. ✅ **Drum-binding codec** (`drumBinding.ts`) + Project 33 turnkey proof. *(done 2026-06-27)*
2. ✅ **Canonical role spine** (`drumRoles.ts`, `canonicalRole`) + Circuit
   **role→slot** map (`CIRCUIT_VOICE_SLOT`, `circuitSlotForVoice` dialect-aware).
   *(done 2026-06-27)*. Remaining sub-item: graduate `pack_groove.py`'s note→role
   guesses (open_hat/tom/perc) into the typed table with provenance.
3. ✅ **Wire binding into authoring**: `apply_pattern mode:ncs_upload` writes the
   Circuit drum binding (default `[0,1,2,3]`, overridable). *(done 2026-06-27)*
4. ✅ **Name-match resolver**: `sampleRoles.ts` `bindingFromDirectory`: role →
   slot via `read_sample_directory` name matching (shuffled/partial kits handled,
   fallbacks reported). *(done 2026-06-27)*. Needs a live `read_sample_directory`
   to exercise end-to-end on hardware.
5. ✅ **SPD-SX target map + external-instrument routing** *(done 2026-06-28)*:
   role→note via the SPD-SX `voice_map` (canonical-keyed, laid out in pad order
   60..68 to match `author_kit`'s default NoteNum), sequenced from the Circuit
   MIDI 1/2 track. Built:
   - `apply_pattern external_targets:[{device,track?,voices?,also_internal?}]`
     resolves the chosen voices against the EXTERNAL device's `voice_map` and
     authors them onto the host's MIDI 1/2 note-track channel
     (`capabilities.external_tracks` declares the channels; the Circuit has
     `{midi1:3, midi2:4}`). Default = external-only ("beat on MIDI 2" → SPD-SX
     alone); `also_internal:true` plays the Circuit drums AND the SPD-SX at once.
   - `author_kit` per-pad object form `{wave, note?, voice?, mute_group?,
     dynamics?, sub_wave?}` pins the pad MIDI note (alignment) and sets POLY for
     hat rolls. Emits the device full-kit format (byte-exact vs kit016; write
     community-beta pending a hardware confirm).
   - Note-track **roll** expansion: a `6` buzz on a voice routed to the SPD-SX
     fans the note across the 6 micro-steps (per-note `delay`), so a POLY pad
     rings each retrigger as its own trail.
   - Rig topology: `MCP_RIG_LINKS` ({"midi2":"spd-sx"}) defaults a target's
     track and is surfaced by `describe_rig`.

## Open items / cautions
- Reconcile the `0x26fc7` mirror vs `chain.ts` tail-byte conflict (see
  `circuit-drum-binding.md`) before trusting chain writes.
- Layer-1 guessed notes (open_hat/tom/perc in `pack_groove`) stay flagged until
  ear-confirmed; never silently treat a guess as confirmed.
