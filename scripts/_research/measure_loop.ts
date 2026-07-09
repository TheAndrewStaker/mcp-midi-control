/**
 * measure_loop — DETERMINISTICALLY measure a sequencer's loop period + playback
 * tempo from a captured note-on log, so a baked loop-clip can be sized to the REAL
 * playback instead of the (often wrong) notated tempo.
 *
 * Prevents the bug we hit: a hat-line clip baked at the song's notated 74 bpm left a
 * ~0.18s gap because the rig actually ran 72 bpm (RC-505 master). The clip length is
 * `bars × 4 × 60/bpm` — trust the MEASURED loop, not the notation.
 *
 * Input: the `<capture>.events.jsonl` written by capture-midi-passive.ts.
 * Method (deterministic): the ANCHOR note is the note that fires LEAST often (closest
 * to once per loop — e.g. a whole-line clip trigger); its median inter-onset interval
 * IS the loop period. Given `--bars`, implies the tempo. Reports variance so a noisy
 * measurement is visible, not hidden.
 *
 * Run: npx tsx scripts/_research/measure_loop.ts <events.jsonl> [--bars 2] [--anchor 44]
 */
import { readFileSync } from 'node:fs';

interface Ev { t_ms: number; ch: number; note: number; vel: number }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function main(): void {
  const file = process.argv[2];
  if (!file) { console.error('usage: measure_loop.ts <events.jsonl> [--bars 2] [--anchor <note>]'); process.exit(1); }
  const bars = Number(arg('bars') ?? 2);
  const events: Ev[] = readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (events.length < 4) { console.error(`only ${events.length} note-ons — play a few loops and re-capture.`); process.exit(1); }

  const byNote = new Map<number, number[]>();
  for (const e of events) { (byNote.get(e.note) ?? byNote.set(e.note, []).get(e.note)!).push(e.t_ms); }

  // Anchor: explicit, else the note with the FEWEST onsets (fires least → once/loop).
  const anchorArg = arg('anchor');
  let anchor: number;
  if (anchorArg !== undefined) anchor = Number(anchorArg);
  else anchor = [...byNote.entries()].filter(([, ts]) => ts.length >= 2).sort((a, b) => a[1].length - b[1].length)[0][0];

  const ts = (byNote.get(anchor) ?? []).sort((a, b) => a - b);
  if (ts.length < 2) { console.error(`anchor note ${anchor} fired <2 times; pass --anchor for a note that repeats.`); process.exit(1); }
  const intervals = ts.slice(1).map((t, i) => t - ts[i]);
  const loopMs = median(intervals);
  const spread = Math.max(...intervals) - Math.min(...intervals);
  const bpm = (bars * 4 * 60_000) / loopMs;

  console.log(`events: ${events.length} note-ons; notes seen: ${[...byNote.keys()].sort((a, b) => a - b).join(', ')}`);
  console.log(`anchor note ${anchor}: ${ts.length} onsets, intervals(ms)=[${intervals.map((x) => x.toFixed(0)).join(', ')}]`);
  console.log('');
  console.log(`LOOP PERIOD  : ${(loopMs / 1000).toFixed(4)} s  (median of ${intervals.length} intervals; spread ${spread.toFixed(0)} ms)`);
  console.log(`IMPLIED TEMPO: ${bpm.toFixed(2)} bpm  (assuming ${bars} bars / loop, 4/4)`);
  console.log(`BAKE the loop-clip to EXACTLY ${(loopMs / 1000).toFixed(4)} s  (== ${bars} bars @ ${bpm.toFixed(2)} bpm)`);
  if (spread > 15) console.log(`\n⚠ interval spread ${spread.toFixed(0)} ms is high — external clock jitter or the anchor fires >1×/loop; sanity-check the anchor note.`);
}

main();
