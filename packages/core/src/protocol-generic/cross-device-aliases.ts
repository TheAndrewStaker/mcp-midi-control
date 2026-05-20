/**
 * BK-065 Phase 1: cross-device parameter name aliases.
 *
 * The same conceptual knob is named differently across Fractal devices.
 * The AM4 drive block has `level`; the Axe-Fx II drive block has
 * `volume`; the Axe-Fx III's catalog name is `DISTORT_LEVEL` (display
 * label "Level"). An agent that learned one device's vocabulary hits
 * sequential validation errors when it tries another device with the
 * same word.
 *
 * This file is a pure-data table plus a tiny resolver. It does NOT
 * touch the dispatcher or the device descriptors. The wiring step
 * (consulting the table inside the writer's validation path and
 * surfacing the substitution in the response) is deferred until
 * Stream A finishes rebuilding the dispatcher's validation codepath
 * (BK-059 territory). The table and helper land first so that wiring
 * is a one-line change when Stream A is ready.
 *
 * Shape:
 *   CROSS_DEVICE_ALIASES[port][block][alias] = canonical
 *
 * Lookup:
 *   resolveParamAlias('am4', 'drive', 'volume')
 *     => { canonical: 'level', aliasUsed: 'volume' }
 *
 *   resolveParamAlias('am4', 'drive', 'level')
 *     => { canonical: 'level' }           // unchanged, no aliasUsed
 *
 *   resolveParamAlias('am4', 'drive', 'mystery')
 *     => { canonical: 'mystery' }         // unknown, unchanged
 *
 * Scoping rules:
 *
 *   - Each alias is scoped per (port, block) so the same English word
 *     can resolve differently on different blocks. `level` on an AM4
 *     drive block is canonical, but if `level` ever has a different
 *     meaning on another block, the table can keep them apart.
 *
 *   - Aliases are one-directional: alias -> canonical. The agent that
 *     types the foreign-device word gets corrected toward the host
 *     device's native vocabulary; the response (when wired) surfaces
 *     the substitution so the agent learns over time.
 *
 *   - Cross-device aliases only. Within-device aliases (e.g. AM4's
 *     `decay` -> `time` on reverb, or II's `gain` -> `input_drive` on
 *     amp) already live in the per-device alias tables that ship with
 *     fractal-midi (`PARAM_ALIASES_AXEFX2`, AM4's `paramAliases.ts`).
 *     This file picks up only the cases where one device's CANONICAL
 *     name is another device's foreign word.
 *
 * Source of truth for divergences:
 *   - `docs/_private/04-BACKLOG.md` BK-065 table
 *   - cross-device-naming-divergence memory note (2026-05-18)
 *   - `fractal-midi/dist/{am4,axe-fx-ii,axe-fx-iii}/params.js`
 *     verified against the canonical name strings shipped in the
 *     packaged catalog.
 */

export type DevicePortSlug = 'am4' | 'axe-fx-ii' | 'axe-fx-iii' | 'hydrasynth';

export interface ResolvedParamAlias {
  /** Canonical name on the target device. Echoes the input if no alias matched. */
  canonical: string;
  /** Present only when an alias substitution occurred. */
  aliasUsed?: string;
}

/**
 * Per-port, per-block alias map. Keys are normalized to lowercase at
 * lookup time, so callers can pass `"Volume"` or `"VOLUME"` and still
 * hit the entry. Canonical values are the exact strings the device's
 * param registry uses (case as shipped in `fractal-midi`).
 */
export const CROSS_DEVICE_ALIASES: Readonly<
  Record<DevicePortSlug, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = Object.freeze({
  am4: Object.freeze({
    // AM4 drive uses `level` as the output knob; II calls it `volume`,
    // III's catalog name is DISTORT_LEVEL with display label "Level".
    drive: Object.freeze({
      volume: 'level',
      output: 'level',
      output_level: 'level',
      // AM4's drive gain knob is `drive` (canonical); II calls it
      // `gain`. Accept `gain` on AM4 so a cross-device agent does not
      // hit an AM4-specific validation error.
      gain: 'drive',
    }),
    // AM4 amp's main volume is `master`; II canonical is `master_volume`.
    // AM4 amp's amp-type-enum knob is `type`; II calls it `effect_type`.
    //
    // AM4 amp exposes a single `mid` knob — there is no `mid_freq` on
    // the amp block, unlike `drive` which has both. An agent that
    // learned the II/III drive vocabulary may reach for `mid_freq` /
    // `mid_frequency` on amp; route to `mid`.
    amp: Object.freeze({
      master_volume: 'master',
      output_level: 'master',
      output: 'master',
      volume: 'master',
      effect_type: 'type',
      mid_freq: 'mid',
      mid_frequency: 'mid',
    }),
    // AM4 wah's effect-type enum knob is `type`; II is `effect_type`.
    wah: Object.freeze({
      effect_type: 'type',
      model: 'type',
    }),
    // Same effect-type-enum divergence on every block that has one.
    // AM4 universally uses `type`; II uses `effect_type` on amp /
    // drive / wah / reverb / delay / chorus / flanger / phaser etc.
    reverb: Object.freeze({
      effect_type: 'type',
    }),
    delay: Object.freeze({
      effect_type: 'type',
    }),
    chorus: Object.freeze({
      effect_type: 'type',
    }),
    flanger: Object.freeze({
      effect_type: 'type',
    }),
    phaser: Object.freeze({
      effect_type: 'type',
    }),
    // NOTE: `regen` / `regeneration` aliases for delay/flanger/phaser
    // feedback live in fractal-midi's per-device PARAM_ALIASES
    // (am4/params.ts), not here. They're within-device musician-
    // vocabulary aliases, not cross-device divergences. The dispatcher's
    // resolveParamKey catches them at step 1b via block.aliases before
    // this table runs at step 3.
  }),

  'axe-fx-ii': Object.freeze({
    // II drive's output knob is `volume`; AM4 calls it `level`.
    drive: Object.freeze({
      level: 'volume',
      output: 'volume',
      output_level: 'volume',
      // II drive's gain knob is `gain` (canonical); AM4 calls it
      // `drive`. The per-device alias table inside fractal-midi
      // already handles this within the II descriptor's writer, but
      // we mirror it here so the unified-surface dispatcher can
      // resolve it without descending into the device package.
      drive: 'gain',
    }),
    // II amp's main volume is `master_volume`; AM4 is `master`.
    // II amp uses `effect_type`; AM4 uses `type`.
    amp: Object.freeze({
      master: 'master_volume',
      type: 'effect_type',
    }),
    // II uses `effect_type` block-wide; AM4 uses `type`. Accept the
    // AM4 word on the II port so a cross-device agent does not hit
    // sequential validation errors.
    wah: Object.freeze({
      type: 'effect_type',
      model: 'effect_type',
    }),
    reverb: Object.freeze({
      type: 'effect_type',
    }),
    delay: Object.freeze({
      type: 'effect_type',
    }),
    chorus: Object.freeze({
      type: 'effect_type',
    }),
    flanger: Object.freeze({
      type: 'effect_type',
    }),
    phaser: Object.freeze({
      type: 'effect_type',
    }),
    // NOTE: `regen` / `regeneration` aliases live in fractal-midi's
    // PARAM_ALIASES_AXEFX2 (axe-fx-ii/paramAliases.ts), not here.
  }),

  'axe-fx-iii': Object.freeze({
    // III params carry the family prefix in the catalog name (e.g.
    // `DISTORT_LEVEL`, `DISTORT_DRIVE`). The unified surface lets the
    // agent address them by the un-prefixed display word too. Cross-
    // device-wise the divergences mirror II: agents trained on AM4
    // reach for `level` and `type`; III's display labels usually
    // agree with AM4 ("Level", "Type"), so most cases work out of
    // the box. The entries below cover the cases where the canonical
    // form on III differs from the obvious word.
    drive: Object.freeze({
      volume: 'level',
      output: 'level',
      // III's DISTORT_DRIVE display label is "Gain"; accept either.
      drive: 'gain',
    }),
    // III amp's main volume display label is "Master"; II/AM4 aliases
    // accepted. III amp's amp-type-enum knob is `type` (matches AM4).
    amp: Object.freeze({
      master_volume: 'master',
      volume: 'master',
      effect_type: 'type',
    }),
    wah: Object.freeze({
      effect_type: 'type',
      model: 'type',
    }),
    reverb: Object.freeze({
      effect_type: 'type',
    }),
    // III's SET_PARAM is undecoded as of Session 97. The III delay
    // canonical name in the descriptor example arrays is `feed` (not
    // `feedback`), while phaser/flanger show `feedback`. We can't move
    // these aliases into a per-device PARAM_ALIASES file (no III
    // alias table exists yet in fractal-midi). When III SET_PARAM
    // lands, audit each entry — `regen → feedback` may need to become
    // `regen → feed` on delay specifically. For now, keeping them
    // here is acceptable since III apply_preset is a beta path.
    delay: Object.freeze({
      effect_type: 'type',
      regen: 'feedback',
      regeneration: 'feedback',
    }),
    chorus: Object.freeze({
      effect_type: 'type',
    }),
    flanger: Object.freeze({
      effect_type: 'type',
      regen: 'feedback',
      regeneration: 'feedback',
    }),
    phaser: Object.freeze({
      effect_type: 'type',
      regen: 'feedback',
      regeneration: 'feedback',
    }),
  }),

  hydrasynth: Object.freeze({
    // No cross-device aliases yet. Hydrasynth's vocabulary is its
    // own (oscillator / module / patch). Cross-device porting from
    // a Fractal device to the Hydrasynth is not a use case BK-065
    // is trying to unblock. Reserved for future entries.
  }),
});

/**
 * Resolve a user-supplied parameter name to its canonical form on the
 * target device. Returns `aliasUsed` only when a substitution actually
 * happened, so callers can decide whether to surface the correction
 * back to the agent.
 *
 * Case-insensitive on the alias side; canonical strings are returned
 * verbatim as the device's param registry stores them.
 *
 * Pure function. No descriptor lookups, no global state, no I/O.
 */
export function resolveParamAlias(
  port: string,
  blockType: string,
  paramName: string,
): ResolvedParamAlias {
  // Defensive normalization: tolerate whitespace and mixed case on
  // the port + block + name keys. Canonical lookups in this table
  // are stored lowercase.
  const portKey = port.trim().toLowerCase();
  const blockKey = blockType.trim().toLowerCase();
  const nameKey = paramName.trim().toLowerCase();

  const portTable = (CROSS_DEVICE_ALIASES as Record<string, Record<string, Record<string, string>>>)[portKey];
  if (!portTable) return { canonical: paramName };

  const blockTable = portTable[blockKey];
  if (!blockTable) return { canonical: paramName };

  const canonical = blockTable[nameKey];
  if (canonical === undefined) return { canonical: paramName };

  // Echo the original `paramName` casing in `aliasUsed` so the
  // surfaced correction quotes what the agent typed.
  return { canonical, aliasUsed: paramName };
}
