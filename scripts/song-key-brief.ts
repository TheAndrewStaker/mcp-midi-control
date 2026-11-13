/**
 * KEY + DENSITY BRIEF for a song fixture: the measured basis for writing a part the source does not
 * have (BK-AMBIENT-LAYER-CODIFY, first cut 2026-09-28).
 *
 * WHY THIS EXISTS. The owner's ask: nu-metal / hardcore / djent records carry ambient synth layers
 * (Periphery, Spiritbox, Deftones), usually a motif, a dissonance or a plain atmosphere bed, and he
 * wants them on songs whose tabs have no synth staff at all. Inventing one by feel is how you get a
 * part in the wrong key that fights the guitars. The web has plenty on ambient SOUND DESIGN (slow
 * movement, drones, heavy reverb) and almost nothing on WHICH NOTES to play against a given riff, so
 * the notes have to come from the song itself. This prints that evidence.
 *
 * WHAT IT MEASURES, per section and for the whole song:
 *   - a DURATION-WEIGHTED pitch-class histogram (a held root outweighs a passing note, which a plain
 *     note count gets wrong),
 *   - the inferred ROOT (the weighted-heaviest class) and which scale degrees are present above it,
 *     named as intervals, so `b2` shows up as the Phrygian tell it is and `#4/b5` as the tritone,
 *   - the best-fitting MODE from the usual metal set, scored by weight inside vs outside the scale,
 *   - ONSET DENSITY per bar and the REGISTER each part occupies (min/max/median MIDI), which is what
 *     says where a pad can sit without masking and which sections are sparse enough to want one.
 *
 * It does NOT write a part. It prints the constraints a part must satisfy; the judgement stays human.
 * Read `rig/TONE-ambient-synth-layer.md` for how those constraints turn into notes.
 *
 * READ-ONLY, offline: reads `scripts/fixtures/<slug>/` only. No network, no device.
 *
 * Run: npx tsx scripts/song-key-brief.ts <fixture-slug> [--parts 0,1,2] [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
/** Interval names from the root, spelled the way a metal player reads them. */
const DEG = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'] as const;
/** The modes worth fitting on this repertoire, as semitone sets from the root. */
const MODES: ReadonlyArray<{ name: string; set: readonly number[] }> = [
  { name: 'Phrygian', set: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Phrygian dominant', set: [0, 1, 4, 5, 7, 8, 10] },
  { name: 'Aeolian (natural minor)', set: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Dorian', set: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Locrian', set: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'minor pentatonic', set: [0, 3, 5, 7, 10] },
  { name: 'minor pentatonic + b5 (blues)', set: [0, 3, 5, 6, 7, 10] },
];

interface Note { fret?: number; string?: number }
interface Beat { notes?: Note[]; duration?: [number, number]; rest?: boolean }
interface Voice { beats?: Beat[] }
interface Measure { voices?: Voice[]; marker?: { text?: string }; signature?: [number, number] }
interface Part { partId: number; name?: string; instrument?: string; tuning?: number[]; measures?: Measure[] }

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const json = args.includes('--json');
const only = (() => {
  const i = args.indexOf('--parts');
  if (i < 0) return undefined;
  return new Set((args[i + 1] ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isInteger));
})();
if (slug === undefined) {
  console.error('usage: npx tsx scripts/song-key-brief.ts <fixture-slug> [--parts 0,1,2] [--json]');
  process.exit(1);
}
const dir = join(import.meta.dirname, 'fixtures', slug);

const roster = JSON.parse(readFileSync(join(dir, 'tracklist.json'), 'utf8')) as {
  title: string; artist: string; songId: number; revisionId: number;
};
const parts: Part[] = readdirSync(dir)
  .filter((f) => /^part-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Part)
  .filter((p) => Array.isArray(p.tuning) && p.tuning.length > 0) // melodic only; drums carry no tuning
  .filter((p) => only === undefined || only.has(p.partId))
  .sort((a, b) => a.partId - b.partId);

if (parts.length === 0) {
  console.error(`no melodic part in ${dir} (drums carry no tuning and are excluded by design)`);
  process.exit(1);
}

/** Section markers, read off whichever part carries them. */
interface Section { name: string; from: number; to: number }
function sections(all: Part[]): Section[] {
  const src = all.find((p) => (p.measures ?? []).some((m) => m.marker?.text !== undefined));
  const bars = src?.measures?.length ?? 0;
  const out: Section[] = [];
  (src?.measures ?? []).forEach((m, i) => {
    const t = m.marker?.text;
    if (t !== undefined && t !== '') {
      if (out.length > 0) out[out.length - 1].to = i; // 1-based exclusive-of-next
      out.push({ name: t, from: i + 1, to: bars });
    }
  });
  if (out.length === 0) out.push({ name: '(whole song)', from: 1, to: bars });
  return out;
}

/** Duration-weighted pitch weight + onset count for one part over a bar range. */
function scan(p: Part, from: number, to: number): { weight: Map<number, number>; onsets: number; pitches: number[] } {
  const weight = new Map<number, number>();
  const pitches: number[] = [];
  let onsets = 0;
  const ms = (p.measures ?? []).slice(from - 1, to);
  for (const m of ms) {
    for (const v of m.voices ?? []) {
      for (const b of v.beats ?? []) {
        if (b.rest === true) continue;
        const [num, den] = b.duration ?? [1, 4];
        const beats = (num / den) * 4; // quarter-beats
        for (const n of b.notes ?? []) {
          if (typeof n.string !== 'number' || typeof n.fret !== 'number') continue;
          const pitch = (p.tuning ?? [])[n.string] + n.fret;
          if (!Number.isFinite(pitch)) continue;
          onsets += 1;
          pitches.push(pitch);
          weight.set(pitch % 12, (weight.get(pitch % 12) ?? 0) + beats);
        }
      }
    }
  }
  return { weight, onsets, pitches };
}

const merge = (into: Map<number, number>, from: Map<number, number>): void => {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
};

function fit(weight: Map<number, number>): { root: number; mode: string; inside: number; degrees: string[] } {
  const total = [...weight.values()].reduce((a, b) => a + b, 0);
  let root = 0, best = -1;
  for (const [pc, w] of weight) if (w > best) { best = w; root = pc; }
  let mode = '(none)', score = -1;
  for (const m of MODES) {
    const explained = [...weight].reduce((a, [pc, w]) => a + (m.set.includes((pc - root + 12) % 12) ? w : 0), 0);
    // Prefer the tightest scale that still explains the weight: fewer notes wins a tie.
    const s = explained / Math.max(total, 1) - m.set.length * 1e-4;
    if (s > score) { score = s; mode = m.name; }
  }
  const insideW = [...weight].reduce((a, [pc, w]) => {
    const m = MODES.find((x) => x.name === mode)!;
    return a + (m.set.includes((pc - root + 12) % 12) ? w : 0);
  }, 0);
  const degrees = [...weight]
    .sort((a, b) => b[1] - a[1])
    .map(([pc, w]) => `${DEG[(pc - root + 12) % 12]}(${PC[pc]}) ${((w / Math.max(total, 1)) * 100).toFixed(0)}%`);
  return { root, mode, inside: insideW / Math.max(total, 1), degrees };
}

const secs = sections(parts);
const label = (p: Part): string => `${p.partId} ${p.instrument ?? '?'}${p.name !== undefined ? ` "${p.name.slice(0, 40)}"` : ''}`;
const med = (xs: number[]): number => (xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);

const whole = new Map<number, number>();
for (const p of parts) merge(whole, scan(p, 1, p.measures?.length ?? 0).weight);
const songFit = fit(whole);

const report = {
  song: `${roster.artist} — ${roster.title} (s${roster.songId} rev ${roster.revisionId})`,
  parts: parts.map(label),
  key: { root: PC[songFit.root], mode: songFit.mode, explains_pct: +(songFit.inside * 100).toFixed(1), degrees: songFit.degrees },
  sections: secs.map((s) => {
    const w = new Map<number, number>();
    const per = parts.map((p) => {
      const r = scan(p, s.from, s.to);
      merge(w, r.weight);
      return {
        part: p.partId,
        onsets: r.onsets,
        per_bar: +(r.onsets / Math.max(s.to - s.from + 1, 1)).toFixed(1),
        low: r.pitches.length > 0 ? Math.min(...r.pitches) : null,
        high: r.pitches.length > 0 ? Math.max(...r.pitches) : null,
        median: r.pitches.length > 0 ? med(r.pitches) : null,
      };
    });
    const f = fit(w);
    return { name: s.name, from: s.from, to: s.to, bars: s.to - s.from + 1, root: PC[f.root], mode: f.mode, top_degrees: f.degrees.slice(0, 5), parts: per };
  }),
};

if (json) { console.log(JSON.stringify(report, null, 1)); process.exit(0); }

console.log(`\n=== KEY + DENSITY BRIEF: ${report.song} ===\n`);
console.log(`melodic parts: ${report.parts.join(' | ')}`);
console.log(`\nWHOLE SONG: root ${report.key.root}, best fit ${report.key.mode} (explains ${report.key.explains_pct}% of the weighted pitch)`);
console.log(`  degrees by weight: ${report.key.degrees.join(' · ')}`);
console.log('\nPER SECTION (onsets/bar per part, register as MIDI low..high med):');
for (const s of report.sections) {
  console.log(`\n  ${s.name}  m${s.from}-${s.to} (${s.bars}b)  root ${s.root} ${s.mode}`);
  console.log(`    ${s.top_degrees.join(' · ')}`);
  for (const p of s.parts) {
    const reg = p.low === null ? 'silent' : `${p.low}..${p.high} med ${p.median}`;
    console.log(`    part ${p.part}: ${String(p.onsets).padStart(4)} onsets, ${String(p.per_bar).padStart(5)}/bar, ${reg}`);
  }
}
console.log('\nHow to read this for an ambient layer: the sparsest sections by onsets/bar are where a');
console.log('motif fits; the densest want a sustained drone instead. Put the pad ABOVE the bass\'s high');
console.log('and clear of the guitars\' median, and take its notes from the degrees listed above, not');
console.log('from a scale you assumed. See rig/TONE-ambient-synth-layer.md.\n');
