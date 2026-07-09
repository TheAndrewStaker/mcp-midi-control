/**
 * Piece-compression report — tell the user what mapping a big groove onto a
 * small kit actually costs, in FACTS, not a score.
 *
 * Two things get reported, both with hit counts so the agent can judge the
 * musical weight (ride→hat on 64 timekeeping hits ≠ china→crash on 2 accents):
 *
 *   - FOLDS — a piece re-voiced to a different musical function's slot
 *     (`drumFold.ts` substitutions). Dialect-spelling matches are NOT folds.
 *   - MERGES — ≥2 source pieces landing on ONE destination: their distinct
 *     voices become indistinguishable there (the real "compression").
 *
 * Deliberately NO loss percentage/score: a number would be fake precision —
 * the tool reports what happened and how often; the agent phrases the musical
 * judgment and offers alternatives (bigger target, drum_flips, accept).
 *
 * Silence rule: when nothing folds and nothing merges, `lines` is EMPTY — a
 * clean mapping produces no ceremony, so a real report is never skimmed as
 * noise.
 */

/** One drum voice's resolution, prepared by the caller. */
export interface PieceEntry {
  /** The pattern's voice name as authored. */
  voice: string;
  /** Hits this voice plays in the pattern (on-steps; arrangement = summed). */
  hits: number;
  /** Destination label — the target's map key ("crash") or an external "ch4 note 49". */
  target: string;
  /**
   * Physical-destination identity for MERGE detection, when the display label
   * alone can't tell (a pinned voice and a mapped voice can share one pad under
   * different labels, e.g. "note 39 (pinned)" vs "clap"). Merges group by this
   * when present, by `target` otherwise.
   */
  merge_key?: string;
  /** Set when the voice was RE-VOICED (a real fold): the role it now plays as. */
  substituted_as?: string;
}

export interface PieceCompressionReport {
  /** Distinct source drum pieces in the pattern. */
  source_pieces: number;
  /** Distinct destinations they land on. */
  target_pieces: number;
  /** Real substitutions, loudest-first (by hits). */
  folds: { voice: string; hits: number; to: string }[];
  /** Destinations shared by ≥2 source pieces (piece identity lost there). */
  merges: { target: string; voices: string[]; hits: number }[];
  /** Human report lines. EMPTY when the mapping is clean — stay silent then. */
  lines: string[];
}

/**
 * Aggregate per-voice resolutions into the compression report. The caller
 * passes DRUM voices only (melodic voices never fold and never "compress").
 */
export function pieceCompression(entries: readonly PieceEntry[]): PieceCompressionReport {
  const folds = entries
    .filter((e) => e.substituted_as !== undefined)
    .map((e) => ({ voice: e.voice, hits: e.hits, to: e.target }))
    .sort((a, b) => b.hits - a.hits);

  const byTarget = new Map<string, PieceEntry[]>();
  for (const e of entries) {
    const key = e.merge_key ?? e.target;
    const group = byTarget.get(key);
    if (group) group.push(e);
    else byTarget.set(key, [e]);
  }
  const merges = [...byTarget.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([, group]) => ({
      // Display the union of labels (a pin + a mapped voice on one pad shows both).
      target: [...new Set(group.map((e) => e.target))].join(' = '),
      voices: group.map((e) => e.voice),
      hits: group.reduce((n, e) => n + e.hits, 0),
    }))
    .sort((a, b) => b.hits - a.hits);

  const lines: string[] = [];
  if (folds.length > 0 || merges.length > 0) {
    lines.push(
      `PIECE COMPRESSION: ${entries.length} source piece(s) → ${byTarget.size} on this kit. ` +
      'Relay this to the user before persisting; a bigger target (e.g. SPD-SX pads via external_targets) or drum_flips keeps more pieces distinct.',
    );
    for (const f of folds) lines.push(`re-voiced: ${f.voice} (${f.hits} hit${f.hits === 1 ? '' : 's'}) → "${f.to}".`);
    for (const m of merges) {
      lines.push(
        `merged: ${m.voices.join(' + ')} (${m.hits} hit${m.hits === 1 ? '' : 's'}) all play "${m.target}" — their distinct voices are lost there.`,
      );
    }
  }

  return {
    source_pieces: entries.length,
    target_pieces: byTarget.size,
    folds,
    merges,
    lines,
  };
}
