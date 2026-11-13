/**
 * types.ts: the Rig Console's view model: what the renderers consume.
 *
 * These types were born in `scripts/_lib/console-sources.ts` beside the disk
 * loaders that populate them; they moved here so the RENDERERS (diagram, page,
 * text peers) can be consumed from compiled contexts (the MCP App shell, the
 * HTTP host) without a `packages/<pkg>/src` relative import. The loaders stay
 * script-side, where the gitignored maintainer data they read lives; they
 * import these types from here, so there is exactly one definition.
 *
 * EVERY SOURCE IS OPTIONAL. `SourceStatus` distinguishes `absent` (nothing
 * configured / nothing there) from `error` (there and unreadable), because
 * collapsing those is what makes a first run unrecoverable.
 */

// ─── source status ──────────────────────────────────────────────────────────

export type SourceState = 'loaded' | 'absent' | 'error';

export interface SourceStatus {
  id: 'rig' | 'card' | 'setlist';
  label: string;
  path: string;
  state: SourceState;
  /** What was found, or why it could not be read. Always populated. */
  detail: string;
}

// ─── card ───────────────────────────────────────────────────────────────────

/** One decoded track inside a sequencer project. */
export interface TrackContent { label: string; count: number; chain?: string }

export interface ConsoleSlot {
  pack: number;
  slot: number;
  occupied: boolean;
  /** The name stored in the file itself, never the roster's expectation. */
  name?: string;
  /** Roster classification, e.g. `song`, `groove-mixwave`, `test`, `unknown`. */
  kind?: string;
  kind_label?: string;
  what?: string;
  song?: string;
  artist?: string;
  part?: string;
  doc?: string;
  /** Tempo byte as captured. */
  tempo?: number;
  /** A tempo written to the device after the capture; the byte above is stale. */
  tempo_post_capture?: number;
  tempo_post_capture_confidence?: 'verified' | 'intended';
  tracks: TrackContent[];
  markers: string[];
  notes: string[];
  hazard?: string;
  /**
   * The pad colour the DEVICE stores for this project (`.ncs` byte 0x0c), as a
   * palette index 0..13, plus Novation's own name for it.
   *
   * This is what the maintainer sees on the hardware's Projects view, and it is
   * per-song on this card (one song is Khaki, another Cyan). Rendering the grid
   * in these colours instead of in invented category colours is what makes the
   * page match the instrument.
   *
   * `colour_index` can be OUT OF RANGE. One project on this card stores 240,
   * which is not a palette entry; the field is reported as read rather than
   * clamped, and `colour` is undefined, so a corrupt value is visible instead
   * of being silently rounded into a plausible colour.
   */
  colour_index?: number;
  colour?: string;
}

export interface ConsolePack {
  pack: number;
  name: string;
  occupied: number;
  free: number;
  free_runs: { from: number; to: number }[];
  slots: ConsoleSlot[];
}

export interface ConsoleCard {
  captured_at: string;
  capture_dir: string;
  packs: ConsolePack[];
  totals: { occupied: number; free: number; slots: number };
}

// ─── setlist ────────────────────────────────────────────────────────────────

/** What a setlist's own `Built?` column claims. Never trusted; only contrasted. */
export type BuildClaim = 'yes' | 'no' | 'unclear';

export interface SetlistEntry {
  position: number;
  title: string;
  artist?: string;
  /**
   * The setlist's hand-written `Built?` cell, verbatim, and its reading.
   *
   * This is captured but NEVER used to decide whether a song is on the card.
   * It exists for one purpose: to be CONTRASTED with the measurement, because
   * a disagreement between what the setlist claims and what the capture holds
   * is the single most actionable row on the page. This rig's column was
   * inferred and wrong three times by its own admission, so surfacing the
   * disagreement is worth more than either value alone.
   */
  claim?: BuildClaim;
  claim_text?: string;
  /**
   * The maintainer's own `Ear-checked` cell, verbatim.
   *
   * This is the ONE fact about a song that no capture can supply and no script
   * may invent: has he heard it and approved it. `setlist-sync.ts` preserves it
   * across every regeneration and seeds a new row as `?`. Distinct from
   * {@link claim}, which is the legacy hand-kept `Built?` column that the sync
   * replaces precisely because it was derivable and therefore drifted.
   */
  ear_checked?: string;
}

// ─── the join ───────────────────────────────────────────────────────────────

export interface ConsoleSong {
  /** Position in the setlist. Undefined = on the card but not in the setlist. */
  position?: number;
  title: string;
  artist?: string;
  doc?: string;
  /** Every song-kind slot the roster places for this song, in card order. */
  slots: ConsoleSlot[];
  /** `Pack 5 projects 46-53`, ranges collapsed. Empty when nothing is placed. */
  where: string;
  /** The tempo its projects agree on, or undefined when they disagree. */
  tempo?: number;
  tempo_disagreement?: number[];
  /**
   * Does the capture hold occupied song-kind projects for it? COMPUTED, never
   * read from the setlist's own `Built?` column.
   *
   * DELIBERATELY NOT NAMED `built`. This measures presence on the card and
   * nothing else. A song can be fully placed and still not signed off by ear
   * (one song's own doc says "Nothing has been signed off by ear yet" over eight
   * placed projects). Calling that "built" would repeat the exact conflation
   * that made the setlist column wrong three times.
   */
  on_card: boolean;
  project_count: number;
  /** The setlist's own claim, carried through for contrast only. */
  claim?: BuildClaim;
  claim_text?: string;
  /** The maintainer's own ear-check verdict, verbatim. Never derived, never invented. */
  ear_checked?: string;
  /**
   * The setlist and the capture disagree. `stale_claim` means the setlist says
   * not built and the projects are there (the setlist is behind); `missing`
   * means it says built and nothing is on the card (the projects are gone, or
   * the roster does not know where they are). Both are actionable and neither
   * is visible from either source alone.
   */
  disagreement?: 'stale_claim' | 'missing';
  /**
   * Slot markers that mean something at SONG level: the file is corrupt, the
   * stored name no longer matches, it was never backed up, another project
   * shares its name.
   *
   * `SILENT SYNTHS` / `SILENT DRUMS` are excluded on purpose. They fire on
   * nearly every song (they are deliberate blend layers and MIDI-driving
   * projects), so aggregating them to the song row paints every song with the
   * same two badges and carries zero information. They stay on the slot row,
   * where they identify WHICH project is silent and are actionable.
   */
  alerts: string[];
  hazards: string[];
  /**
   * The voices chosen for this song, from the machine-readable mapping
   * registry (song-mappings.json claims[]): which preset each instrument is
   * set to, as picked BY EAR at the rig. Status vocabulary is the registry's
   * own (confirmed | proposed | owed); absence of the whole list means the
   * song has no claims filed yet — a real, reportable state, never hidden.
   */
  voices?: ConsoleVoice[];
}

/** One instrument's chosen voice for one song (a registry claim, rendered). */
export interface ConsoleVoice {
  /** Descriptor id from the registry (microfreak, hydrasynth, ...). */
  device: string;
  /** Front-panel slot/location as the registry records it ("A015", 163, "P2·25"). */
  slot: string;
  /** The preset/project name the device must report there. */
  name?: string;
  /** What it plays in the song. */
  role?: string;
  /** confirmed | proposed | owed (registry vocabulary, verbatim). */
  status?: string;
}

export interface SongJoin {
  songs: ConsoleSong[];
  /** Setlist rows the card knows nothing about. Reported, never dropped. */
  unplaced: SetlistEntry[];
  /** Songs on the card that the setlist does not list. Reported, never dropped. */
  not_in_setlist: string[];
  /**
   * Registry songs with voices filed that matched NOTHING in the join —
   * neither setlist nor card knows the title (e.g. a song built after the
   * last card capture). Reported, never dropped.
   */
  voices_unmatched?: string[];
}
