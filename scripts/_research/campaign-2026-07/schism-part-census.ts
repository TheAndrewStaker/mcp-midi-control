/**
 * Schism (s6700 rev 8009215) condensation census, read-only, no device.
 * Run: npx tsx samples/_scratch/schism-part-census.ts   (from repo root)
 *
 * Computes, for the settled rig parts (t2 Synth1, t3 MIDI1, t5 MIDI2 drums):
 *   1. the bar-aligned chop (planSongChop) — project windows + pattern_steps
 *   2. a per-track content signature for every pattern window (16th grid,
 *      pitch for melodic, voice for drums), so distinct-pattern counts are
 *      MEASURED, not guessed
 *   3. per-project distinct counts + within/cross-project repeats
 */
import { readFileSync } from 'node:fs';
import { toChopPart, planSongChop } from '../../packages/core/src/protocol-generic/patterns/songChop.js';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, isMelodicPart,
  type SongsterrPart, type MeasureInfo,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s6700';
const PARTS: Array<{ id: number; label: string }> = [
  { id: 2, label: 'Synth1 (t2 Double Track)' },
  { id: 3, label: 'MIDI1 (t3 Whammy)' },
  { id: 5, label: 'MIDI2 (t5 Drums)' },
];
const SPB = 4; // steps per quarter beat (16th grid)

function loadPart(id: number): SongsterrPart {
  return JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
}

interface TrackEvents { label: string; measures: MeasureInfo[]; events: { beat: number; key: string }[] }

const tracks: TrackEvents[] = PARTS.map(({ id, label }) => {
  const part = loadPart(id);
  if (isMelodicPart(part)) {
    const m = flattenSongsterrMelodic(part);
    return { label, measures: m.measures, events: m.notes.map((n) => ({ beat: n.beat, key: `p${n.pitch}` })) };
  }
  const d = flattenSongsterrDrums(part);
  return { label, measures: d.measures, events: d.events.map((e) => ({ beat: e.beat, key: `v${e.voice}` })) };
});

const chopParts = PARTS.map(({ id, label }) => toChopPart(id, label, loadPart(id)));
const plan = planSongChop(chopParts);

// beat of a displayed measure number (1-based) via the drums part measure walk
const walk = tracks[2].measures;
function measureStartBeat(displayed: number): number {
  const m = walk[displayed - 1];
  if (!m || m.index !== displayed - 1) throw new Error(`measure walk mismatch at ${displayed}`);
  return m.startBeat;
}
function measureEndBeat(displayed: number): number {
  const m = walk[displayed - 1];
  return m.startBeat + (m.signature[0] * 4) / m.signature[1];
}

// signature of a pattern window on one track: sorted (step,key) pairs
function windowSig(t: TrackEvents, fromM: number, toM: number): string {
  const b0 = measureStartBeat(fromM); const b1 = measureEndBeat(toM);
  const items = t.events
    .filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * SPB)}:${e.key}`)
    .sort();
  return items.join(',');
}

// global signature registries per track
const reg: Map<string, string>[] = tracks.map(() => new Map());
const counts: Map<string, number>[] = tracks.map(() => new Map());
function sigId(ti: number, sig: string): string {
  if (sig === '') return '-';
  const r = reg[ti];
  if (!r.has(sig)) r.set(sig, `${'SWD'[ti]}${r.size + 1}`);
  const id = r.get(sig)!;
  counts[ti].set(id, (counts[ti].get(id) ?? 0) + 1);
  return id;
}

console.log(`chop: ${plan.projects.length} projects\n`);
interface Row { project: number; name: string; window: string; patterns: number; steps: number[]; ids: string[][] }
const rows: Row[] = [];
for (const p of plan.projects) {
  const ids: string[][] = tracks.map(() => []);
  for (const w of p.pattern_windows) {
    tracks.forEach((t, ti) => { ids[ti].push(sigId(ti, windowSig(t, w.from_measure, w.to_measure))); });
  }
  rows.push({ project: p.project, name: p.name, window: `m${p.from_measure}-${p.to_measure}`, patterns: p.patterns, steps: p.pattern_steps, ids });
}
for (const r of rows) {
  console.log(`P${String(r.project).padStart(2)} ${r.name.padEnd(28)} ${r.window.padEnd(10)} ${r.patterns} pats [${r.steps.join(',')}]`);
  tracks.forEach((t, ti) => {
    const line = r.ids[ti];
    if (line.every((x) => x === '-')) return;
    const uniq = new Set(line.filter((x) => x !== '-')).size;
    console.log(`      ${'SWD'[ti]}: ${line.join(' ')}   (${uniq} distinct)`);
  });
}

console.log('\nGLOBAL distinct pattern signatures per track (non-empty):');
tracks.forEach((t, ti) => {
  const total = [...counts[ti].values()].reduce((a, b) => a + b, 0);
  console.log(`  ${t.label}: ${reg[ti].size} distinct across ${total} non-empty pattern plays`);
  const repeated = [...counts[ti].entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (repeated.length > 0) console.log(`    repeated: ${repeated.map(([id, n]) => `${id}x${n}`).join(' ')}`);
});

// per-project slot cost if authored literally (= patterns) vs with within-project pattern-level dedupe
console.log('\nPer-project: literal slots vs within-project distinct combos:');
for (const r of rows) {
  const combos = r.steps.map((_, i) => `${r.steps[i]}|${tracks.map((_, ti) => r.ids[ti][i]).join('/')}`);
  const uniq = new Set(combos).size;
  console.log(`  P${String(r.project).padStart(2)} ${r.name.padEnd(28)} literal ${String(r.patterns).padStart(2)}  distinct-combo ${uniq}${uniq < r.patterns ? '  <-- shaveable' : ''}`);
}
