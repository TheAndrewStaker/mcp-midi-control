/**
 * FM9 device-true enum overrides (read-leg {broadcast ordinal -> name}).
 *
 * The gen-3 family (III/FM3/FM9) shares one effect codec AND one model-selector
 * ordinal space: FM9 ordinals match the III/FM3 tables on every shared ordinal
 * (the shared base just omitted the models absent from any factory preset, now
 * unioned in). The roster divergence is AM4-vs-gen-3 only — AM4 (a different
 * codec generation) renumbered its amp table, so its ordinals do NOT match gen-3.
 * The amp and drive (FUZZ) rosters below are the FM9's OWN model lists,
 * mined from the FM9-Edit `effectDefinitions` cache (firmware 11.0) and emitted
 * by `scripts/gen-fm9-rosters-from-cache.ts`. Each is VALIDATED at generation
 * time against the FM9 hardware ordinal anchors:
 *   - amp: 65=SV Bass 2, 179=Texas Star Clean, 264=SV Bass 1
 *   - FUZZ/drive: 15=Blues OD, 36=Blackglass 7K
 * and each carries a self-validating `uint32` entry-count prefix in the cache
 * (amp 331 / drive 86). The broadcast ordinal IS the discrete-SET value (a select
 * sends float32(ordinal)), so these are both read labels AND settable by name
 * across the whole roster, not just the captured anchor points.
 *
 * REVERB_TYPE binds the device-true FM9 reverb roster (79) too. The cache gives
 * the FM9's own adjective-first form ("Medium Spring", "Music Hall"), what an
 * FM9 user reads on the unit and in FM-Edit. This SUPERSEDES the prior read-leg
 * fallback that borrowed AM4 REVERB_TYPES' noun-first names ("Spring, Medium",
 * "Hall, Music"), which mislabeled FM9 read-backs. The ordinal join is intact
 * (gen-3 ordinal N == AM4 REVERB_TYPES[N] semantically; only the display word
 * order differs), and set-by-name stays tolerant of BOTH forms via the
 * word-order-tolerant resolver, so "Spring, Medium" and "Medium Spring" both
 * still resolve to ordinal 16. III/FM3 keep the AM4-borrowed names until their
 * own device caches arrive.
 *
 * DISTORT_FBTYPE (amp voicing) and FILTER_TYPE remain PARTIAL hardware-captured
 * points: only the ordinals the tester selected are bound; the catalog passes
 * every other ordinal through as a raw number and never fabricates a name. Their
 * full rosters await a cache mine or a Type-dropdown capture.
 *
 * Provenance for the full rosters: the community FM9 cache set archived
 * 2026-06-09 (D. MacVicar); decode + adversarial validation in
 * `samples/captured/fm9-community-2026-06-09/FINDINGS.md`. Partial points:
 * `docs/_private/FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.md` and the cookbook entry
 * `gen3-enum-label-septet-stream`.
 */
import { FM9_AMP_ROSTER, FM9_DRIVE_ROSTER, FM9_REVERB_TYPE_ROSTER } from './rosters.generated.js';
import { FM9_CAB_BANK_NAMES } from './cabRosters.generated.js';

export const FM9_ENUM_OVERRIDES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  // DISTORT block = the gen-3 AMP (effect id 58), paramId 10 = amp model.
  // Full 331-model FM9 roster (cache-mined, hardware-anchored at 65/179/264).
  DISTORT_TYPE: FM9_AMP_ROSTER,

  // FUZZ block = the gen-3 Drive/Fuzz pedal (effect id 118), paramId 0.
  // Full 86-model FM9 roster (cache-mined, hardware-anchored at 15/36).
  FUZZ_TYPE: FM9_DRIVE_ROSTER,

  // REVERB block (effect id 66), paramId 10 = reverb type.
  // Full 79-type FM9 roster (cache-mined, anchored at 16=Medium Spring / 45=Music Hall).
  // Device-true adjective-first labels; supersedes AM4-borrowed noun-first names.
  REVERB_TYPE: FM9_REVERB_TYPE_ROSTER,

  // DISTORT block, paramId 43 = voicing selector. PARTIAL: ordinals from the
  // fn=0x1F->0x75 block bulk-read + sub=0x1a current-value label poll, FM9 hw
  // fw 11.00. Broadcast ordinal = the discrete-SET value, so settable by name.
  DISTORT_FBTYPE: {
    0: 'BASSGUY',
    39: 'TX STAR',
    53: 'FAS CLASSIC',
  },

  // FILTER block (effect id 114), paramId 0. PARTIAL: ordinal from sub=0x1a
  // current-value label poll, hand-reproduced, FM9 hw fw 11.00.
  FILTER_TYPE: {
    6: 'Peaking',
  },

  // CABINET block (effect id 100+), paramIds 0/1 = per-IR-slot BANK selectors.
  // Full 5-way vocabulary from the FM9-Edit cache CABINET_BANK enum record
  // (cross-validated across six firmware caches; see cabRosters.generated.ts).
  // The bank↔name mapping is UNCONDITIONAL (unlike CABINET_TYPE, whose
  // ordinal space is bank-conditioned and therefore ships as bank-keyed data
  // + resolveFm9CabName instead of a flat enum table). Set-by-name works:
  // "set cab bank 1 to Legacy" → ordinal 3, then set the type ordinal from
  // the resolver. Community-beta (cache-derived, no hardware anchor yet).
  CABINET_BANK1: FM9_CAB_BANK_NAMES,
  CABINET_BANK2: FM9_CAB_BANK_NAMES,
};
