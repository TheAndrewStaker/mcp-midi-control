/**
 * circuit-card-roster.ts — the ONLY hand-carried knowledge in the card map.
 *
 * `scripts/circuit-card-map.ts` reads every fact it can from the `.ncs` files
 * themselves (name, tempo, swing, mixer levels, which tracks carry content,
 * chains, structural validity). Three things are NOT in the file and can only
 * come from a human:
 *
 *   1. WHAT A PROJECT IS. A song section, a drum groove converted from a
 *      purchased pack (whose name is a community GUESS at the source song),
 *      and protocol scratch all look alike in the bytes. The bytes cannot tell
 *      them apart, and conflating the first two is an easy error to make.
 *   2. WHICH BARS a song section covers.
 *   3. THE TEMPO WRITTEN TO THE DEVICE AFTER A CAPTURE WAS TAKEN. See
 *      `postCapture` below — this one is a trap, and it is documented there.
 *
 * Every entry carries `name`, the project's expected embedded name. The
 * generator ASSERTS it against the file and marks the row UNVERIFIED if it
 * disagrees, so a slot that gets overwritten cannot silently keep an old
 * description. That assertion is what keeps a hand-written table from rotting
 * into a lie: the worst it can do is admit it no longer knows.
 *
 * Keys are `"<devicePack>:<deviceProject>"`, both 1-based as the unit displays
 * them.
 *
 * THE ROSTER DATA IS NOT IN THIS FILE. It describes one person's card, so it
 * lives in `circuit-card-roster.local.ts` beside this module, which is local
 * only and never tracked. That file exports
 * `ROSTER: Record<string, RosterEntry>`; when it is absent the roster is empty
 * and every project on the card reads as having no roster entry.
 */

/**
 * The categories that genuinely exist on a card. The distinction between
 * `song` and `groove-mixwave` is load-bearing: a groove conversion is NOT
 * repertoire, it has no arrangement, and its NAME IS A GUESS.
 * See `docs/_private/rig/groove-library.md`.
 */
export type SlotKind =
  | 'song'                // a real song section, part of a multi-project arrangement
  | 'groove-mixwave'      // drum groove from a purchased Mixwave pack; NAME IS A GUESS
  | 'groove-transcribed'  // drum groove hand-written by ear; name is honest about intent
  | 'test'                // protocol scratch / test project, not music
  | 'unknown';            // on the card, provenance not recorded anywhere

export interface RosterEntry {
  /** Expected embedded name at 0x10. Asserted against the file at generation time. */
  name: string;
  kind: SlotKind;
  /** One line: what this project actually IS, in the maintainer's terms. */
  what: string;
  /** Song title, for the by-song index. Groove conversions deliberately have none. */
  song?: string;
  artist?: string;
  /** Which part of the arrangement, e.g. `P3 of 10`. */
  part?: string;
  /** Source bar range where it is recorded, e.g. `m35-50`. */
  bars?: string;
  /** Link target relative to `docs/_private/rig/`. */
  doc?: string;
  /** The tempo this project is MEANT to run at, where that is recorded. */
  tempoIntent?: number;
  /**
   * A tempo write that landed on the DEVICE after the capture was taken.
   *
   * ⚠ THE TRAP. `circuit-set-project-tempo.ts` writes its `restore-tempo-*`
   * backup BEFORE it patches the byte, so those directories hold the PRE-write
   * image and carry the STALE tempo, not the corrected one (verified: all 25
   * are sha256-identical to the capture). The corrected byte exists ONLY on the
   * device until the next card backup. So the generator can prove MECHANICALLY
   * that a slot was written after the capture (a restore-tempo backup exists
   * for it) but cannot read what it was written TO. That value lives here, with
   * its source, and is labelled in the map as not-yet-re-captured.
   */
  postCapture?: {
    /** The BPM believed to be on the device now. Omit if genuinely unknown. */
    bpm?: number;
    /** Where that number comes from, verbatim enough to check. */
    source: string;
    /** `verified` = a doc records a device read-back. `intended` = the target was recorded, the write is proven, the landed value is not re-read. */
    confidence: 'verified' | 'intended';
  };
  /** Surfaced inline on the slot's own row, never in a footnote. */
  hazard?: string;
}

/**
 * Load the local roster. The specifier is held in a variable on purpose: the
 * local file is absent from a fresh checkout, and a literal specifier would
 * make its absence a type error.
 */
async function loadLocalRoster(): Promise<Readonly<Record<string, RosterEntry>>> {
  const localModule = './circuit-card-roster.local.js';
  try {
    const mod = await import(localModule) as { ROSTER?: Readonly<Record<string, RosterEntry>> };
    return mod.ROSTER ?? {};
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return {};
    throw err;
  }
}

export const ROSTER: Readonly<Record<string, RosterEntry>> = await loadLocalRoster();

/** Human-facing label per category, used in the map's legend and its rows. */
export const KIND_LABEL: Readonly<Record<SlotKind, string>> = {
  song: 'song section',
  'groove-mixwave': 'groove conversion (name GUESSED)',
  'groove-transcribed': 'groove, hand-transcribed',
  test: 'test / scratch',
  unknown: 'unclassified',
};
