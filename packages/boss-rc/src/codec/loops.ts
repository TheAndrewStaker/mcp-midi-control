/**
 * Loop summary of an RC-505mk2 memory: its tempo and which tracks hold a
 * recorded loop, read from the memory's own .RC0 file.
 *
 * Decoded 2026-11-12 from the maintainer's unit and cross-checked against the
 * audio the unit stores beside the memory files: over all 99 memories, every
 * track of a live copy that flags a recording (220 tracks) has a WAV whose
 * frame count equals the track's stored length exactly. Fields used:
 *
 *   MASTER/A   tempo x 10                      (1220 = 122.0 BPM)
 *   TRACKn/W   1 when the track holds a loop
 *   TRACKn/X   loop length in sample frames at 44.1 kHz
 *   TRACKn/V   one measure in sample frames at the memory tempo
 *
 * So X / V is the loop length in measures and X / 44100 is its length in
 * seconds.
 *
 * Per-track settings. Confirmed on the unit by changing one setting on the
 * panel and diffing the file: L loop sync, M tempo sync, R measure mode
 * (1 FREE, 2 fixed) with S the fixed measure count. Taken from the RC-600's
 * identical tag scheme and consistent with this unit's factory values, not
 * panel-diffed here: A reverse, B one-shot, C pan (50 = centre), D play level.
 */
import { getLeaf, type Rc0Doc } from './rc0.js';

const SAMPLE_RATE = 44100;

export interface LoopTrack {
  track: number;
  recorded: boolean;
  /** Loop length in measures at the memory tempo (recorded tracks only). */
  measures?: number;
  /** Loop length in seconds (recorded tracks only). */
  seconds?: number;
  /** Play level, 0..200 (100 is the default). */
  level?: number;
  /** "CENTER", "L1".."L50" or "R1".."R50". */
  pan?: string;
  reverse?: boolean;
  one_shot?: boolean;
  loop_sync?: boolean;
  tempo_sync?: boolean;
  /** "FREE", or the fixed measure count the track records to. */
  measure?: string | number;
}

export interface LoopSummary {
  tempo_bpm?: number;
  tracks: LoopTrack[];
  recorded_count: number;
}

function num(doc: Rc0Doc, path: string): number | undefined {
  const raw = getLeaf(doc, path);
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function panLabel(stored: number): string {
  if (stored === 50) return 'CENTER';
  return stored < 50 ? `L${50 - stored}` : `R${stored - 50}`;
}

function readTrackSettings(doc: Rc0Doc, path: string): Partial<LoopTrack> {
  const flag = (tag: string): boolean | undefined => {
    const v = num(doc, `${path}/${tag}`);
    return v === 0 || v === 1 ? v === 1 : undefined;
  };
  const out: Partial<LoopTrack> = {};
  const level = num(doc, `${path}/D`);
  if (level !== undefined && level >= 0 && level <= 200) out.level = level;
  const pan = num(doc, `${path}/C`);
  if (pan !== undefined && pan >= 0 && pan <= 100) out.pan = panLabel(pan);
  const reverse = flag('A');
  if (reverse !== undefined) out.reverse = reverse;
  const oneShot = flag('B');
  if (oneShot !== undefined) out.one_shot = oneShot;
  const loopSync = flag('L');
  if (loopSync !== undefined) out.loop_sync = loopSync;
  const tempoSync = flag('M');
  if (tempoSync !== undefined) out.tempo_sync = tempoSync;
  const mode = num(doc, `${path}/R`);
  const count = num(doc, `${path}/S`);
  if (mode === 1) out.measure = 'FREE';
  else if (mode === 2 && count !== undefined && count > 0) out.measure = count;
  return out;
}

export function readLoopSummary(doc: Rc0Doc, memId: string | number, trackCount: number): LoopSummary {
  const base = `database/mem#${memId}`;
  const tempoRaw = num(doc, `${base}/MASTER/A`);
  const tracks: LoopTrack[] = [];
  for (let t = 1; t <= trackCount; t++) {
    const recorded = num(doc, `${base}/TRACK${t}/W`) === 1;
    const frames = num(doc, `${base}/TRACK${t}/X`);
    const measure = num(doc, `${base}/TRACK${t}/V`);
    const settings = readTrackSettings(doc, `${base}/TRACK${t}`);
    if (!recorded || frames === undefined || frames <= 0) {
      tracks.push({ track: t, recorded: false, ...settings });
      continue;
    }
    tracks.push({
      track: t,
      recorded: true,
      ...(measure !== undefined && measure > 0 ? { measures: round2(frames / measure) } : {}),
      seconds: round2(frames / SAMPLE_RATE),
      ...settings,
    });
  }
  return {
    ...(tempoRaw !== undefined && tempoRaw > 0 ? { tempo_bpm: tempoRaw / 10 } : {}),
    tracks,
    recorded_count: tracks.filter((t) => t.recorded).length,
  };
}

/** One line for a scan row: "3 loops, 122 BPM" or "no loops". */
export function loopSummaryLine(s: LoopSummary): string {
  if (s.recorded_count === 0) return 'no loops';
  const loops = `${s.recorded_count} loop${s.recorded_count === 1 ? '' : 's'}`;
  return s.tempo_bpm !== undefined ? `${loops}, ${s.tempo_bpm} BPM` : loops;
}
