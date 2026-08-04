/**
 * songsterr-after-dark-melody-compare.ts: read-only. Answer one question with
 * data instead of an ear: is the intro piano (part 5) the SAME melodic line as
 * the chorus lead (parts 3 / 4), and if so at what interval?
 *
 * The shared-onset matrix in `songsterr-roster-audit.ts` cannot answer it,
 * because part 5 sounds in m1-16 and the leads do not sound until m19. Two parts
 * that never overlap in time share zero onsets, so they look unrelated whatever
 * they play. This script instead slides each part's onset list to a common
 * origin (its own first onset) and compares the sequences.
 *
 * It also splits part 4 (the square lead, which sounds nearly everywhere) into
 * its VERSE material and its CHORUS material, so "does the lead play the same
 * thing in the verse as in the chorus?" is answered rather than assumed.
 *
 * Read-only: public GETs only, no device, no writes.
 *
 * Usage: npx tsx scripts/songsterr-after-dark-melody-compare.ts
 */
import { parseSongRef } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import {
  flattenSongsterrMelodic, type SongsterrPart, type MelodicNote,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { gunzipSync } from 'node:zlib';

const REF = '501859';
const CDNS = ['https://dqsljvtekg760.cloudfront.net', 'https://d3d3l6a6rcgkaf.cloudfront.net'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json',
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pn = (p: number): string => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

const { songId } = parseSongRef(REF);
const meta = await (await fetch(`https://www.songsterr.com/api/meta/${songId}`, { headers: HEADERS })).json() as
  { revisionId: number; image: string };

async function part(id: number): Promise<SongsterrPart> {
  for (const cdn of CDNS) {
    const res = await fetch(`${cdn}/${songId}/${meta.revisionId}/${meta.image}/${id}.json`, { headers: HEADERS });
    if (!res.ok) continue;
    const buf = new Uint8Array(await res.arrayBuffer());
    const gz = buf[0] === 0x1f && buf[1] === 0x8b;
    return JSON.parse(gz ? gunzipSync(buf).toString('utf8') : Buffer.from(buf).toString('utf8')) as SongsterrPart;
  }
  throw new Error(`part ${id} unavailable`);
}

const flats = new Map<number, Awaited<ReturnType<typeof load>>>();
async function load(id: number) { return flattenSongsterrMelodic(await part(id)); }
for (const id of [3, 4, 5]) flats.set(id, await load(id));

const f4 = flats.get(4)!;
/** Quarter-note beat where measure `m` (1-based) starts. */
const beatOfMeasure = (m: number): number => f4.measures[m - 1]?.startBeat ?? Number.NaN;

interface Seg { label: string; notes: MelodicNote[] }
const slice = (id: number, fromM: number, toM: number, label: string): Seg => {
  const f = flats.get(id)!;
  const a = beatOfMeasure(fromM), b = beatOfMeasure(toM + 1);
  return { label, notes: f.notes.filter((n) => n.beat >= a - 1e-6 && n.beat < b - 1e-6) };
};

const describe = (s: Seg): string => {
  if (s.notes.length === 0) return `${s.label}: (silent)`;
  const ps = s.notes.map((n) => n.pitch);
  return `${s.label}: ${s.notes.length} onset(s), ${Math.min(...ps)}..${Math.max(...ps)} (${pn(Math.min(...ps))}..${pn(Math.max(...ps))})`;
};

/**
 * Compare two segments as SEQUENCES, each slid to its own first onset. Reports
 * whether the rhythm (relative onset offsets) matches step for step and whether
 * the pitch difference is a constant interval.
 */
function compare(a: Seg, b: Seg): void {
  console.log(`\n  ${a.label}  vs  ${b.label}`);
  if (a.notes.length === 0 || b.notes.length === 0) { console.log('     one side is silent; nothing to compare'); return; }
  if (a.notes.length !== b.notes.length) {
    console.log(`     onset COUNT differs: ${a.notes.length} vs ${b.notes.length}. Not the same line note-for-note.`);
  }
  const n = Math.min(a.notes.length, b.notes.length);
  const a0 = a.notes[0].beat, b0 = b.notes[0].beat;
  let rhythmMismatch = 0, lenMismatch = 0;
  const intervals: number[] = [];
  for (let i = 0; i < n; i++) {
    const da = a.notes[i].beat - a0, db = b.notes[i].beat - b0;
    if (Math.abs(da - db) > 1e-6) rhythmMismatch++;
    if (Math.abs(a.notes[i].durationBeats - b.notes[i].durationBeats) > 1e-6) lenMismatch++;
    intervals.push(b.notes[i].pitch - a.notes[i].pitch);
  }
  const uniq = [...new Set(intervals)].sort((x, y) => x - y);
  console.log(`     ${n} paired onset(s); rhythm mismatches ${rhythmMismatch}; note-length mismatches ${lenMismatch}`);
  console.log(`     interval B-A: ${uniq.length === 1 ? `CONSTANT ${uniq[0] >= 0 ? '+' : ''}${uniq[0]}` : `${uniq.length} distinct (${uniq.slice(0, 16).join(',')}${uniq.length > 16 ? '…' : ''})`}`);
  if (uniq.length > 1) {
    const hist = new Map<number, number>();
    for (const v of intervals) hist.set(v, (hist.get(v) ?? 0) + 1);
    console.log(`     histogram ${[...hist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([v, c]) => `${v}:${c}`).join(' ')}`);
  }
}

console.log('AFTER DARK: is the intro melody the chorus melody?\n');
console.log('Section boundaries from the source markers: Intro m1, Verse1\' m19, Chorus m35, Verse2 m51, Chorus m67, Break m83, Bridge m99, Chorus m115\n');

const introPiano = slice(5, 1, 18, 'part 5 piano "Track 1", Intro m1-18');
const ch1saw = slice(3, 35, 50, 'part 3 saw, Chorus1 m35-50');
const ch2saw = slice(3, 67, 82, 'part 3 saw, Chorus2 m67-82');
const ch3saw = slice(3, 115, 130, 'part 3 saw, Chorus3 m115-130');
const v1sq = slice(4, 19, 34, 'part 4 square, Verse1 m19-34');
const ch1sq = slice(4, 35, 50, 'part 4 square, Chorus1 m35-50');
const v2sq = slice(4, 51, 66, 'part 4 square, Verse2 m51-66');
const brsq = slice(4, 99, 114, 'part 4 square, Bridge m99-114');
const ch3sq = slice(4, 115, 130, 'part 4 square, Chorus3 m115-130');

for (const s of [introPiano, ch1saw, ch2saw, ch3saw, v1sq, ch1sq, v2sq, brsq, ch3sq]) console.log('  ' + describe(s));

console.log('\n--- IS THE INTRO THE CHORUS? ---');
compare(introPiano, ch1saw);
compare(introPiano, ch1sq);

console.log('\n--- IS THE VERSE THE CHORUS? (part 4 against itself) ---');
compare(v1sq, ch1sq);
compare(v1sq, v2sq);
compare(ch1sq, ch3sq);

console.log('\n--- DO THE THREE CHORUSES REPEAT? (part 3 against itself) ---');
compare(ch1saw, ch2saw);
compare(ch1saw, ch3saw);

console.log('\n--- WHAT REGISTER DOES +12 PUT MIDI 1 IN? ---');
const sawPs = flats.get(3)!.notes.map((n) => n.pitch);
const lo = Math.min(...sawPs), hi = Math.max(...sawPs);
console.log(`  part 3 as authored: ${lo}..${hi} (${pn(lo)}..${pn(hi)})`);
console.log(`  +12:                ${lo + 12}..${hi + 12} (${pn(lo + 12)}..${pn(hi + 12)})`);
console.log(`  +24:                ${lo + 24}..${hi + 24} (${pn(lo + 24)}..${pn(hi + 24)})`);
const pp = flats.get(5)!.notes.map((n) => n.pitch);
console.log(`  intro piano part 5: ${Math.min(...pp)}..${Math.max(...pp)} (${pn(Math.min(...pp))}..${pn(Math.max(...pp))})`);
const sq = flats.get(4)!.notes.map((n) => n.pitch);
console.log(`  part 4 square:      ${Math.min(...sq)}..${Math.max(...sq)} (${pn(Math.min(...sq))}..${pn(Math.max(...sq))})`);
