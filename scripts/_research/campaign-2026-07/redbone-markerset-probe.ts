/**
 * Redbone probe 2: marker-set feasibility + elision test + part facts.
 * Read-only, offline, from samples/songsterr-cache/s434040 (rev 7419203).
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums,
  flattenSongsterrMelodic,
  type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const CACHE = 'samples/circuit-ncs'.replace('circuit-ncs', 'songsterr-cache') + '/s434040';
const part = (n: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${n}.json`, 'utf8')) as SongsterrPart;

// ── per-bar signatures per part (16th grid, 4/4 = 16 steps/bar) ──────
type Ev = { beat: number; token: string };
const STEPS_PER_BEAT = 4;

function melodicEvents(p: SongsterrPart): Ev[] {
  const m = flattenSongsterrMelodic(p);
  return m.notes.map((n) => ({
    beat: n.beat,
    token: `${n.pitch}:${Math.max(1, Math.round(n.durationBeats * STEPS_PER_BEAT))}${n.velocity !== undefined ? `@${n.velocity}` : ''}`,
  }));
}
function drumEvents(p: SongsterrPart): Ev[] {
  const f = flattenSongsterrDrums(p);
  return f.events.map((e) => ({ beat: e.beat, token: `${e.voice}${e.velocity !== undefined ? `@${e.velocity}` : ''}${e.accent ? '!' : ''}${e.ghost ? '?' : ''}` }));
}

const PARTS: Record<number, Ev[]> = {
  5: melodicEvents(part(5)),
  7: melodicEvents(part(7)),
  9: melodicEvents(part(9)),
  10: drumEvents(part(10)),
};

/** bar (1-based) -> canonical body string for one part. 4/4: bar b = beats [(b-1)*4, b*4). */
function barBody(events: Ev[], bar: number): string {
  const from = (bar - 1) * 4;
  const cells = new Map<number, string[]>();
  for (const e of events) {
    if (e.beat < from - 1e-9 || e.beat >= from + 4 - 1e-9) continue;
    const step = Math.round((e.beat - from) * STEPS_PER_BEAT);
    const arr = cells.get(step) ?? [];
    arr.push(e.token);
    cells.set(step, arr);
  }
  return [...cells.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, t]) => `${s}:${t.sort().join('+')}`).join(' ');
}
const barRow = (bar: number): string => [5, 7, 9, 10].map((id) => `${id}|${barBody(PARTS[id], bar)}`).join(' # ');

// ── the 8-project marker set ─────────────────────────────────────────
const SET: { name: string; from: number; to: number }[] = [
  { name: 'Intro', from: 1, to: 10 },
  { name: 'Verse', from: 11, to: 26 },
  { name: 'PreCho+Cho1', from: 27, to: 40 },
  { name: 'PreCho2', from: 49, to: 55 },
  { name: 'Chorus2', from: 56, to: 71 },
  { name: 'BridgeA', from: 72, to: 83 },
  { name: 'BridgeB', from: 84, to: 95 },
  { name: 'Outro', from: 96, to: 107 },
];

// window images per project (2-bar windows anchored at project start; last may be 1 bar)
console.log('=== PER-PROJECT WINDOWS (union image over p5,p7,p9,p10) ===');
for (const pr of SET) {
  const windows: string[] = [];
  for (let b = pr.from; b <= pr.to; b += 2) {
    const w = b + 1 <= pr.to ? `${barRow(b)} || ${barRow(b + 1)}` : barRow(b);
    windows.push(w);
  }
  const seen = new Map<string, string>();
  const letters = windows.map((w) => {
    if (!seen.has(w)) seen.set(w, String.fromCharCode(65 + seen.size));
    return seen.get(w)!;
  });
  console.log(`${pr.name} m${pr.from}-${pr.to}: plays=${windows.length} distinct=${seen.size} order=${letters.join(' ')}`);
}

// ── V2 prefix assert ─────────────────────────────────────────────────
console.log('\n=== V2 (m41-48) vs V1 head (m11-18), per part ===');
for (const id of [5, 7, 9, 10]) {
  let same = true;
  for (let i = 0; i < 8; i++) {
    if (barBody(PARTS[id], 41 + i) !== barBody(PARTS[id], 11 + i)) { same = false; console.log(`  p${id} differs at m${41 + i}`); }
  }
  console.log(`  p${id}: ${same ? 'IDENTICAL' : 'DIFFERS'}; p${id} m11-18 empty=${Array.from({ length: 8 }, (_, i) => barBody(PARTS[id], 11 + i)).every((x) => x === '')}`);
}

// ── elision test at every boundary (Schism lesson) ───────────────────
// For each project: detect the shortest period P (bars) of its tail region,
// then test whether the NEXT project's first bar continues the cycle
// (i.e. equals the bar P earlier), which would mean the boundary elides.
console.log('\n=== BOUNDARY ELISION TEST ===');
function periodOf(from: number, to: number): number | undefined {
  const n = to - from + 1;
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    let ok = true;
    for (let b = from + p; b <= to; b++) {
      if (barRow(b) !== barRow(b - p)) { ok = false; break; }
    }
    if (ok) return p;
  }
  return undefined;
}
for (let i = 0; i < SET.length; i++) {
  const pr = SET[i];
  const nextBar = pr.to + 1;
  const period = periodOf(pr.from, pr.to);
  if (nextBar > 107) { console.log(`${pr.name}: last project (ends m107). period=${period ?? 'none'}`); continue; }
  const p = period ?? undefined;
  const elides = p !== undefined && barRow(nextBar) !== '' && barRow(nextBar) === barRow(nextBar - p);
  console.log(`${pr.name} ends m${pr.to}, next m${nextBar}: period=${p ?? 'none'} elides=${elides}`);
  // also: does next bar equal ANY in-window cycle-position bar (weaker signal)?
  const matches: number[] = [];
  for (let b = pr.from; b <= pr.to; b++) if (barRow(b) === barRow(nextBar) && barRow(nextBar) !== '') matches.push(b);
  if (matches.length) console.log(`   next-bar content matches in-window bar(s): m${matches.join(', m')}`);
}

// ── p9 chords / entries; p5 chords; drum accents ─────────────────────
console.log('\n=== p9 (Synth Strings -> MicroFreak MONO) ===');
{
  const m = flattenSongsterrMelodic(part(9));
  const byBeat = new Map<number, number>();
  for (const n of m.notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const chords = [...byBeat.values()].filter((c) => c > 1).length;
  console.log(`notes=${m.notes.length} onsets=${byBeat.size} chord-onsets=${chords}`);
  const bars = new Set<number>();
  for (const n of m.notes) bars.add(Math.floor(n.beat / 4) + 1);
  console.log('sounding bars:', [...bars].sort((a, b) => a - b).join(','));
  const durs = new Map<number, number>();
  for (const n of m.notes) { const d = Math.round(n.durationBeats * 4); durs.set(d, (durs.get(d) ?? 0) + 1); }
  console.log('note lengths (steps):', [...durs.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}x${c}`).join(' '));
}
console.log('\n=== p5 (Piano 1 -> synth2 internal) chords ===');
{
  const m = flattenSongsterrMelodic(part(5));
  const byBeat = new Map<number, number>();
  for (const n of m.notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const sizes = new Map<number, number>();
  for (const c of byBeat.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  console.log(`notes=${m.notes.length} onsets=${byBeat.size} chord sizes:`, [...sizes.entries()].sort().map(([s, n]) => `${s}-note x${n}`).join(', '));
}
console.log('\n=== p7 (Synths 1 -> synth1/Hydrasynth) ===');
{
  const m = flattenSongsterrMelodic(part(7));
  const byBeat = new Map<number, number>();
  for (const n of m.notes) byBeat.set(n.beat, (byBeat.get(n.beat) ?? 0) + 1);
  const sizes = new Map<number, number>();
  for (const c of byBeat.values()) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  console.log(`notes=${m.notes.length} onsets=${byBeat.size} chord sizes:`, [...sizes.entries()].sort().map(([s, n]) => `${s}-note x${n}`).join(', '));
}
console.log('\n=== drum accents / v127 placement ===');
{
  const f = flattenSongsterrDrums(part(10));
  const accents = f.events.filter((e) => e.accent === true).length;
  const v127 = f.events.filter((e) => e.velocity === 127);
  console.log(`accent-flagged=${accents} v127=${v127.length}`);
  const bars = new Map<number, number>();
  for (const e of v127) { const b = Math.floor(e.beat / 4) + 1; bars.set(b, (bars.get(b) ?? 0) + 1); }
  console.log('v127 by bar:', [...bars.entries()].sort((a, b) => a[0] - b[0]).map(([b, c]) => `m${b}x${c}`).join(' '));
}
// the m107 ending vs the bed cycle (drums)
console.log('\n=== drums: m101 vs m107 (ending bar), m95 vs m107 ===');
console.log('m101:', barBody(PARTS[10], 101));
console.log('m107:', barBody(PARTS[10], 107));
