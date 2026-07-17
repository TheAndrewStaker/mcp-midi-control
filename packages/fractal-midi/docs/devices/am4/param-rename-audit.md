# AM4 param-rename audit notes

Several AM4 params are registered in `src/am4/params.ts` under names
that differ from the manual / Blocks Guide spelling, because the
registered name is chosen to match the AM4-Edit / front-panel UI
label rather than the manual's longer-form name. A naive grep for
the manual wording produces false negatives ("this param is missing
from params.ts") when the param is actually shipped under a
different short form.

## The audit rule

**Before opening a "missing param" investigation, re-grep using
AM4's short canonical spellings.** Common rename patterns:

- `_sw` for switch-style enums (e.g. saturation switch → `saturation_sw`)
- `_fb` for feedback parameters (e.g. negative feedback → `negative_fb`)
- `preamp_*` / `nfb_*` / `in_*` prefix variants (e.g. boost type → `in_boost_type`)
- `supply_*` / `preamp_*` disambiguation when the manual uses one
  word for two physically distinct knobs (e.g. `amp.sag`)

A 30-minute re-investigation that ends in "actually we shipped it
already" is a worse outcome than a 5-minute careful first pass.

## Known divergences

| Manual / Blocks Guide name | Registered as | `params.ts` line |
|---|---|---|
| `amp.sag` | `amp.preamp_sag` AND `amp.supply_sag` (see note) | 4560, 879 |
| `amp.negative_feedback` | `amp.negative_fb` | 889 |
| `amp.saturation_switch` | `amp.saturation_sw` | 4557 |
| `amp.boost_type` | `amp.in_boost_type` | 4564 |

**Note on `amp.sag`:** the manual term is ambiguous in AM4. AM4
exposes TWO distinct sag knobs: `amp.preamp_sag` (Preamp Sag,
`pidHigh: 0x0067`, `unit: knob_0_10`) and `amp.supply_sag` (Power
Amp Supply Sag, separate `pidHigh`). Disambiguate by section in
the manual: if the user is reading the Preamp section, they mean
`preamp_sag`; if they are reading the Power Amp / Power Supply
section, they mean `supply_sag`. The registered names preserve the
distinction; the manual's bare `amp.sag` collapses it.

## How params get renamed

The renames happen at the `params.ts` registration step, not at
the wire layer. The wire still uses the device's native paramId.
Renames are driven by:

1. **AM4-Edit label match.** When the editor displays a knob with a
   specific short name (e.g. "Preamp Sag"), `params.ts` adopts the
   short form so `describe_device` and tool error messages match
   what the user sees in AM4-Edit.
2. **Front-panel label match.** Where AM4-Edit and front panel
   disagree, front panel wins. Front panel is ground truth per
   project CLAUDE.md.
3. **Disambiguation.** When the manual uses one term for multiple
   knobs (sag is the canonical case), each gets a prefix.

When adding a new param, check both `_partial/` of the primitives corpus and
this audit before registering; if the manual name shows up here,
use the registered name from this table to maintain consistency
with existing params.
