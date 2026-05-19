/**
 * BK-064 sub-deliverable 1 wiring (Session 101).
 *
 * Loads `lineage/loudness.json` (the per-amp + per-drive loudness
 * corpus from Session 100) and exposes a small accessor: given an
 * amp/drive display name, return its `master_sweet_spot_display`,
 * `relative_loudness_dB`, and free-text notes when the corpus has an
 * entry. Returns `undefined` otherwise.
 *
 * Consumed by the lookup_lineage formatter on each Fractal device to
 * surface the loudness numbers alongside lineage prose. Pure data
 * read at module load; no runtime mutation.
 *
 * Name matching: the corpus is keyed by the AM4 display name (matches
 * the `am4Name` field on Axe-Fx II lineage records). For II / III
 * lookups, the formatter must pass the AM4-equivalent name (already
 * carried by the lineage record). Case-insensitive lookup so minor
 * UI / wire string variations don't miss the corpus entry.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AmpLoudnessEntry {
  master_sweet_spot_display: number;
  relative_loudness_dB: number;
  notes?: string;
}

export interface DriveLoudnessEntry {
  /**
   * Default drive.level / drive.volume sweet-spot in display units.
   * Most drives are 0..10 knob; recipes target the agent-friendly
   * default that produces the named perceived gain at unity guitar
   * level.
   */
  default_level_display: number;
  /** Perceived gain added by the drive at default level, dB. */
  boost_response_dB: number;
  notes?: string;
}

interface LoudnessCorpus {
  amps?: Readonly<Record<string, AmpLoudnessEntry>>;
  drives?: Readonly<Record<string, DriveLoudnessEntry>>;
  _referenceAmp?: string;
  _referenceDrive?: string;
  _precision?: string;
}

function loadCorpus(): LoudnessCorpus {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, 'lineage', 'loudness.json');
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(raw) as LoudnessCorpus;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(
      `[loudness] could not load ${file}; loudness lookup disabled`,
    );
    return {};
  }
}

const CORPUS: LoudnessCorpus = loadCorpus();

const AMP_INDEX = buildIndex(CORPUS.amps);
const DRIVE_INDEX = buildIndex(CORPUS.drives);

function buildIndex<T>(
  table: Readonly<Record<string, T>> | undefined,
): Map<string, T> {
  const map = new Map<string, T>();
  if (!table) return map;
  for (const [name, entry] of Object.entries(table)) {
    map.set(name.trim().toLowerCase(), entry);
  }
  return map;
}

/**
 * Look up a per-amp loudness entry by display name. Case-insensitive,
 * whitespace-tolerant. Returns `undefined` when the corpus has no
 * entry for this amp.
 */
export function lookupAmpLoudness(name: string): AmpLoudnessEntry | undefined {
  return AMP_INDEX.get(name.trim().toLowerCase());
}

/**
 * Look up a per-drive loudness entry by display name. Same matching
 * rules as `lookupAmpLoudness`.
 */
export function lookupDriveLoudness(name: string): DriveLoudnessEntry | undefined {
  return DRIVE_INDEX.get(name.trim().toLowerCase());
}

/**
 * Reference amp / drive names from the corpus header. Surfaced by the
 * lineage formatter so the user can see what 0 dB is calibrated
 * against ("Double Verb Normal at master=6 = 0 dB").
 */
export function loudnessReferenceAnchors(): {
  amp?: string;
  drive?: string;
  precision?: string;
} {
  return {
    amp: CORPUS._referenceAmp,
    drive: CORPUS._referenceDrive,
    precision: CORPUS._precision,
  };
}

/**
 * Format a one-line loudness appendix for a lineage formatter to
 * append after the per-record text block. Returns the empty string
 * when the corpus has no entry for the name. Cross-device: callers
 * pass the AM4 display name (or the AM4-equivalent name carried by
 * non-AM4 records). One name → one line; two lines only emitted in
 * the unlikely case both an amp and a drive entry match the same
 * string.
 */
export function formatLoudnessAppendix(name: string): string {
  const lines: string[] = [];
  const amp = lookupAmpLoudness(name);
  if (amp) {
    lines.push(
      `loudness: master_sweet_spot=${amp.master_sweet_spot_display} | relative_loudness_dB=${amp.relative_loudness_dB}` +
        (amp.notes ? ` | ${amp.notes}` : ''),
    );
  }
  const drive = lookupDriveLoudness(name);
  if (drive) {
    lines.push(
      `loudness: default_level=${drive.default_level_display} | boost_response_dB=${drive.boost_response_dB}` +
        (drive.notes ? ` | ${drive.notes}` : ''),
    );
  }
  return lines.join('\n');
}
