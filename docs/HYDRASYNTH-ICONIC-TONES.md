<!-- Provenance: harvested from branch `hydrasynth-explorer` (commit 0809e2f "Hydrasynth: ICONIC-TONES.md test portfolio …", last touched by 742b763 which added the Mortal Kombat / Techno Syndrome entries). Source path: docs/devices/hydrasynth-explorer/ICONIC-TONES.md. Tool names updated to match current monorepo (`hydra_apply_patch` is shipped; `hydra_set_engine_params` is the incremental-tweak path). Test-results log retained verbatim as the audit trail. -->

# Iconic synth tones — Hydrasynth test portfolio

Curated list of recognizable synth sounds the tool aims to recreate
conversationally. Each one doubles as **(a)** a hardware test that
exercises a specific Hydrasynth capability and **(b)** a marketable
demo in the form *"Send a [iconic song] tone to the Hydrasynth"* →
patch lands.

When you do hardware tests, paste the **prompt** column verbatim
into Claude Desktop (with the connector attached + Param TX/RX = NRPN
+ device powered on). Capture which ones land cleanly vs need
iteration; the green-checked ones become the project's "tones the
tool can produce" list.

**Fresh-patch builds use `hydra_apply_patch`** (atomic SysEx dump
starting from factory INIT — audible-by-construction, all hardwired
routings intact). Do NOT use `hydra_set_engine_params` for fresh
builds; that path was removed in Session 39 because the NRPN init
prelude broke factory env→VCA routing (the 2026-04-28 Van Halen Jump
silence). Use `hydra_set_engine_params` only for incremental tweaks
on top of an already-loaded patch ("brighter, more chorus").

## Tier 1 — high recognition, high feasibility (start here)

| # | Song / artist | Original synth | What it exercises | Test prompt |
|---|---|---|---|---|
| 1 | **Van Halen "Jump"** | Oberheim OB-Xa | Polyphonic saw stack, brassy filter envelope, chorus width | *"Send the Van Halen 'Jump' lead synth tone to the hydrasynth as a fresh patch — it's the iconic OB-Xa polyphonic synth"* |
| 2 | **A-ha "Take On Me"** | Yamaha DX7 marimba | FM-style bell-pluck — first real test of the **mutators** (FM Linear mode) | *"Send the A-ha 'Take On Me' lead synth as a fresh patch — DX7-style FM marimba/bell pluck"* |
| 3 | **Stranger Things theme** | Roland Juno-60 + sequencer | Sub-bass arpeggio with filter sweep — synthwave aesthetic | *"Send the Stranger Things theme bass arpeggio as a fresh patch — Juno-60 with filter sweep"* |
| 4 | **Vangelis "Chariots of Fire"** | Yamaha CS-80 brass | Slow swell brass pad with ring-mod shimmer | *"Send the Vangelis 'Chariots of Fire' main synth pad as a fresh patch — CS-80 brass with that signature swell"* |
| 5 | **Tom Petty "Breakdown"** | Wurlitzer EP (most likely) — Benmont Tench's intro figure; some sources cite Vox Continental | Soft EP-ish keyboard tone, reference test from session 1. Original instrument under research — treat as "Breakdown intro keys", not a specific synth | *"Send the Tom Petty 'Breakdown' intro keyboard tone to the hydrasynth as a fresh patch — soft, slightly bell-like electric piano character"* |
| 6 | **Steve Winwood "While You See a Chance"** | Minimoog + Prophet-5 | Mono lead with detuned saws, glide, vibrato, chorus | *"Send a 'While You See a Chance' lead synth tone to the hydrasynth as a fresh patch — Minimoog-style with detuned saws, glide, and Prophet-5 chorus"* |
| 16a | **Techno Syndrome (1994) — intro synth lead** | 90s rave / industrial; commonly Roland JD-800 stabs + ROMpler era | Aggressive detuned-saw stab, fast filter envelope ("pew"), short percussive amp env, slight grit. Tests fast envelopes + filter drive. | *"Send the intro synthesizer LEAD tone from 'Techno Syndrome' by The Immortals (1994 Mortal Kombat theme) — classic 90s rave stab, percussive detuned saws, heavy filter envelope, slight grit."* |
| 16b | **Techno Syndrome — pulsing bass line** | Same era; classic 90s industrial bass | Mono detuned saw with low cutoff + envelope, gated/sequenced amp envelope for the "boom-boom-boom-boom" pulse | *"Send the pulsing bass line from 'Techno Syndrome' to the hydrasynth — low detuned saw, gated/percussive, with the rhythmic envelope chop"* |
| 16c | **Techno Syndrome — atmospheric pad** | Era-typical sample-pad / wavetable | Slow-attack washy pad behind the lead, often with reverb tail | *"Send the atmospheric background pad from 'Techno Syndrome' — slow-attack wash pad, dark, with long reverb"* |
| 16d | **Techno Syndrome — orchestral hit / stab** | Sample-based brass/orchestral hit, ubiquitous in 90s dance | Fast attack, fast decay brass/orchestral hit; tests Hydrasynth's ability to approximate sample-based hits via wavescan | *"Send the orchestral 'hit' stab from 'Techno Syndrome' — short percussive brass-like attack, like the sample stab between phrases"* |

## Tier 2 — recognizable but trickier

| # | Song / artist | Original synth | Why it's harder | Test prompt |
|---|---|---|---|---|
| 7 | **Daft Punk "Around the World" bass** | Roland TB-303 | Acid bass needs squelchy ladder filter + per-note retriggers | *"Send the Daft Punk 'Around the World' bassline tone as a fresh patch — TB-303 acid bass"* |
| 8 | **Pink Floyd "Shine On You Crazy Diamond"** | Minimoog | Pure singing lead with glide. Hydrasynth nails this; biggest challenge is performance vibrato/bend phrasing not patch | *"Send the 'Shine On You Crazy Diamond' lead synth as a fresh patch — Minimoog singing lead"* |
| 9 | **Phil Collins "In the Air Tonight" pad** | Sequential Prophet-5 | Slow ensemble pad with chorus | *"Send the 'In the Air Tonight' synth pad as a fresh patch — Prophet-5 ensemble pad"* |
| 10 | **Kraftwerk "The Robots" lead** | Minimoog | Minimalist square wave with portamento — tests the simplest patches honestly | *"Send the Kraftwerk 'The Robots' lead synth as a fresh patch — minimalist Minimoog square wave"* |
| 11 | **Berlin "Take My Breath Away"** | Yamaha CS-80 | String-bass pad foundation | *"Send the 'Take My Breath Away' synth pad as a fresh patch — CS-80 string bass"* |

## Tier 3 — interesting but expect partial fidelity

| # | Song / artist | Original synth | Why partial |
|---|---|---|---|
| 12 | **Yes "Owner of a Lonely Heart" stab** | Fairlight CMI samples | Sample-based, can't fully recreate; Hydrasynth wavescan can approximate |
| 13 | **Earth Wind & Fire "September" brass** | Yamaha DX7 brass | FM brass — mutator can approximate but not nail |
| 14 | **Charli XCX / hyperpop modern lead** | Serum, Vital | Wavetable with formant character — wavescan is closest analog |
| 15 | **Boards of Canada hazy pad** | Roland Juno-106 | Heavy modulation + tape-emulation character; chorus alone can't replicate |

## Recommended test order for the next 2–3 sessions

1. **Van Halen "Jump"** — highest recognition, exercises poly + saw stack + filter envelope. Gold standard 80s lead.
2. **A-ha "Take On Me"** — first real test of the **mutators** (FM mode), which we haven't touched yet. Big breadth gain.
3. **Stranger Things** — sequenced bass arp + LFO. Tests live-sequencing flow against a recognizable cultural reference.

After those three: Vangelis (ring mod), TB-303 (resonant bass), CS-80 brass. Each one extends the demo portfolio + stress-tests a different Hydrasynth capability.

## Test results log

Append rows here as tests complete. Mark patches that landed
cleanly with ✅; those needing iteration with 🟡; those that didn't
land at all with ❌.

| Date | # | Tone | Result | Notes |
|---|---|---|---|---|
| 2026-04-26 | 5 | Tom Petty "Breakdown" | ✅ | Session 1; required the fixes that became BK-035 (alias, auto-scale) before landing |
| 2026-04-28 | 6 | Steve Winwood "While You See a Chance" | ✅ | Session 2; minor glitchy artifact from chorus depth, resolved with chorus pull-back |
| 2026-04-28 | 1 | Van Halen "Jump" | 🟡 | Session 3; landed after INIT button + resend. Surfaced bleed-through bug. Initial fix `freshPatch: true` (0e2d9cc) had its own destructive prelude (BK-037 mod-matrix-target=0 silence). True fix landed Session 39: SysEx-from-INIT via `hydra_apply_patch`, plus `freshPatch` flag removed. Re-test on the new path. |
| 2026-04-28 | 1 | Van Halen "Jump" (Session 39 follow-up) | ✅ | Field-reproduced the silence symptom on `freshPatch: true`, recovered via `hydra_apply_init`, then rebuilt Jump as incremental NRPN writes on top of audible INIT — musical, all 16 writes accepted. Confirms the 3-tool workflow (apply_init reset → small-batch tweaks) until PATCH_OFFSETS coverage closes. |
