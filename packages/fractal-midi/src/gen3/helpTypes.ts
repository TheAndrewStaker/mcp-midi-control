/**
 * Gen-3 block & parameter help — the shape of the curated "what does this
 * do" copy surfaced in editor tooltips / status areas.
 *
 * This is HAND-WRITTEN, factual, paraphrased copy — NOT a reproduction of
 * any vendor manual. Keep entries tight (tooltip-length), original, and
 * focused on the practical / audible effect.
 *
 * Keying strategy
 * ───────────────
 * The whole gen-3 family (Axe-Fx III / FM3 / FM9 / VP4) shares one block
 * roster and one set of param-family symbols, and the great majority of
 * blocks behave identically across devices. So help lives at the `gen3`
 * level keyed by:
 *   - block: the param-family symbol (e.g. `'REVERB'`, `'DELAY'`,
 *     `'DISTORT'` for the Amp, `'CABINET'`, `'FUZZ'` for the Drive block).
 *     This is the same key `*_PARAMS_BY_FAMILY` and the effectId tables use.
 *   - param: the device editor's stable symbol name (e.g. `'REVERB_TIME'`,
 *     `'DISTORT_DRIVE'`) — i.e. `Param.name`. Stable across firmware of a
 *     generation, so it survives paramId renumbering between devices.
 *
 * Device-specific notes (e.g. "Axe-Fx III only", FullRes IRs, longer max
 * delay time on III/FM9) are layered on top via {@link HelpOverrides} so we
 * never duplicate the shared text per device.
 */

/** Curated help for one block family. */
export interface BlockHelp {
  /** One-liner: what it is + typical use. Target ≤ ~140 chars. */
  summary: string;
  /** Optional second sentence for a richer panel. Keep it short. */
  detail?: string;
}

/** Curated help for one parameter. */
export interface ParamHelp {
  /** What it does + audible effect. Target ≤ ~120 chars. */
  blurb: string;
  /** Optional practical tip. */
  tip?: string;
}

/**
 * A self-contained help record for one block: the block-level copy plus a
 * map of `Param.name` → {@link ParamHelp}. Not every param needs an entry —
 * the common mix/level/bypass tail is covered once in the shared catalog.
 */
export interface BlockHelpEntry {
  block: BlockHelp;
  /** Keyed by `Param.name` (the editor symbol), e.g. `'REVERB_TIME'`. */
  params: Readonly<Record<string, ParamHelp>>;
}

/**
 * The whole catalog: param-family symbol → {@link BlockHelpEntry}.
 * e.g. `help['DISTORT']` is the Amp block; `help['REVERB']` the Reverb.
 */
export type HelpCatalog = Readonly<Record<string, BlockHelpEntry>>;

/**
 * A sparse per-device patch over the shared catalog. Only carries the
 * deltas the guide actually flags as device-specific; everything else
 * resolves to the shared text. Block-level fields and individual params
 * are shallow-merged onto the shared entry by {@link resolveHelp}.
 */
export interface BlockHelpOverride {
  block?: Partial<BlockHelp>;
  params?: Readonly<Record<string, ParamHelp>>;
}

/** family symbol → patch. */
export type HelpOverrides = Readonly<Record<string, BlockHelpOverride>>;

/**
 * Merge a per-device override patch onto the shared catalog, producing the
 * resolved catalog a consumer should display for that device. Pure; inputs
 * are not mutated. Families present only in the override are added.
 */
export function resolveHelp(shared: HelpCatalog, overrides?: HelpOverrides): HelpCatalog {
  if (!overrides) return shared;
  const out: Record<string, BlockHelpEntry> = {};
  const families = new Set([...Object.keys(shared), ...Object.keys(overrides)]);
  for (const fam of families) {
    const base = shared[fam];
    const patch = overrides[fam];
    if (!patch) {
      out[fam] = base;
      continue;
    }
    out[fam] = {
      block: { ...(base?.block ?? { summary: '' }), ...patch.block },
      params: { ...(base?.params ?? {}), ...patch.params },
    };
  }
  return out;
}
