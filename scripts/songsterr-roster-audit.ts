/**
 * songsterr-roster-audit.ts: read-only. Pull EVERY part of a Songsterr song and
 * report what each one actually contains, then test the parts against each other
 * for the octave-doubling relationship a transcriber uses when they double a
 * vocal line onto a lead instrument.
 *
 * ## Why this exists
 *
 * A part's General-MIDI instrument name is not a reliable statement of what the
 * part IS. Songsterr contributors file vocal lines under whatever instrument was
 * closest to hand: Schism's Maynard vocal is filed as `Bassoon`. So "is there a
 * vocal part on this tab?" cannot be answered from the roster's instrument names
 * alone, and answering it wrong means authoring the wrong melody onto a track
 * whose whole job is to be the pitch target for a singer.
 *
 * This script therefore reports, per part:
 *   - the instrument name AND the contributor's own track name (both, always)
 *   - pitch range in MIDI numbers and note names
 *   - onset count, distinct pitch-class set, whether it is monophonic
 *   - which of the song's OWN section markers it sounds in
 *
 * and then, across parts, an interval matrix: for every ordered pair, how many
 * of A's onsets land at the same beat as one of B's, and whether the pitch
 * difference on those shared onsets is a CONSTANT interval. A constant +12 over
 * a high shared-onset count is the octave-doubling signature.
 *
 * Read-only: three public GETs per part, no device contact, no writes.
 *
 * Usage:
 *   npx tsx scripts/songsterr-roster-audit.ts 501859
 *   npx tsx scripts/songsterr-roster-audit.ts https://www.songsterr.com/a/wsa/...-s501859
 */
import {
  fetchSongsterrTracks, parseSongRef,
} from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';
import {
  flattenSongsterrMelodic, flattenSongsterrDrums, isMelodicPart,
  type SongsterrPart, type MelodicNote,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { gunzipSync } from 'node:zlib';

const REF = process.argv[2] ?? '501859';
const CDNS = ['https://dqsljvtekg760.cloudfront.net', 'https://d3d3l6a6rcgkaf.cloudfront.net'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json',
};

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pn = (p: number): string => `${NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`;

async function fetchPartJson(songId: number, rev: number, image: string, partId: number): Promise<SongsterrPart> {
  let last: unknown;
  for (const cdn of CDNS) {
    try {
      const res = await fetch(`${cdn}/${songId}/${rev}/${image}/${partId}.json`, { headers: HEADERS });
      if (!res.ok) { last = new Error(`${res.status} from ${cdn}`); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      const gz = buf[0] === 0x1f && buf[1] === 0x8b;
      return JSON.parse(gz ? gunzipSync(buf).toString('utf8') : Buffer.from(buf).toString('utf8')) as SongsterrPart;
    } catch (e) { last = e; }
  }
  throw new Error(`part ${partId}: ${String(last)}`);
}

const { songId } = parseSongRef(REF);
const roster = await fetchSongsterrTracks(REF);
// The meta hop again, for `image` (the roster shape deliberately drops it).
const meta = await (await fetch(`https://www.songsterr.com/api/meta/${songId}`, { headers: HEADERS })).json() as
  { revisionId: number; image: string; tracks: { instrumentId: number; instrument: string; name?: string; isEmpty?: boolean; views?: number }[] };

console.log(`"${roster.title}" by ${roster.artist}   song ${roster.songId}   revision ${roster.revisionId}`);
console.log(`${roster.allTracks.length} part(s)\n`);

interface Analysed {
  partId: number; instrument: string; name: string; instrumentId: number;
  melodic: boolean; notes: MelodicNote[]; lo?: number; hi?: number;
  poly: number; sections: string[]; measures: string;
}
const analysed: Analysed[] = [];

for (const t of roster.allTracks) {
  const part = await fetchPartJson(songId, meta.revisionId, meta.image, t.partId);
  const melodic = isMelodicPart(part);
  if (!melodic) {
    const flat = flattenSongsterrDrums(part);
    console.log(`part ${t.partId}  instrument "${t.instrument}"  track name "${t.name || '(none)'}"  id ${t.instrumentId}`);
    // `DrumEvent` carries the NEUTRAL voice name, not the raw GM number: the
    // flattener has already mapped it. Report the voices, which is the useful
    // reading anyway ("is there a vocal here?" is not a drum question).
    const voices = [...new Set(flat.events.map((e) => e.voice))].sort();
    console.log(`         DRUMS: ${flat.events.length} event(s), voices ${voices.join(', ')}`);
    console.log('');
    analysed.push({ partId: t.partId, instrument: t.instrument, name: t.name, instrumentId: t.instrumentId, melodic: false, notes: [], poly: 0, sections: [], measures: '' });
    continue;
  }
  const flat = flattenSongsterrMelodic(part);
  const notes = flat.notes;
  const byBeat = new Map<number, number[]>();
  for (const n of notes) {
    const k = Math.round(n.beat * 1000) / 1000;
    (byBeat.get(k) ?? byBeat.set(k, []).get(k)!).push(n.pitch);
  }
  const poly = [...byBeat.values()].filter((v) => v.length > 1).length;

  // Which of the song's own sections does this part sound in?
  const secs = flat.sections;
  const inSec = new Set<string>();
  const measuresSounding = new Set<number>();
  for (const n of notes) {
    const m = flat.measures.filter((mm) => mm.startBeat <= n.beat + 1e-6).at(-1);
    if (m) measuresSounding.add(m.index + 1);
    const s = secs.filter((ss) => ss.startBeat <= n.beat + 1e-6).at(-1);
    if (s) inSec.add(`${s.name}@m${s.startMeasure + 1}`);
  }
  const ms = [...measuresSounding].sort((a, b) => a - b);
  // Compress the measure list into runs.
  const runs: string[] = [];
  for (let i = 0; i < ms.length;) {
    let j = i; while (j + 1 < ms.length && ms[j + 1] === ms[j] + 1) j++;
    runs.push(i === j ? `${ms[i]}` : `${ms[i]}-${ms[j]}`); i = j + 1;
  }

  console.log(`part ${t.partId}  instrument "${t.instrument}"  track name "${t.name || '(none)'}"  id ${t.instrumentId}${t.isEmpty ? '  [meta says EMPTY]' : ''}`);
  console.log(`         ${notes.length} onset(s)   range ${flat.range ? `${flat.range.low}..${flat.range.high} (${pn(flat.range.low)}..${pn(flat.range.high)})` : '(none)'}`
    + `   ${poly === 0 ? 'MONOPHONIC' : `${poly} simultaneous-onset beat(s) => polyphonic`}`);
  console.log(`         pitch classes ${flat.pitch_classes.map((c) => NAMES[c]).join(' ')}`);
  console.log(`         measures ${runs.join(', ') || '(none)'}`);
  console.log(`         sections ${[...inSec].join(', ') || '(none)'}`);
  console.log(`         tuning [${flat.tuning.join(',')}]  letRing ${flat.let_rings}  legato ${JSON.stringify(flat.legato)}  ties ${flat.ties_folded}`);
  console.log('');
  analysed.push({
    partId: t.partId, instrument: t.instrument, name: t.name, instrumentId: t.instrumentId,
    melodic: true, notes, lo: flat.range?.low, hi: flat.range?.high, poly,
    sections: [...inSec], measures: runs.join(', '),
  });
}

// ── octave-doubling / same-line matrix ───────────────────────────────
console.log('SHARED-ONSET INTERVAL MATRIX (mono parts only; a constant interval over a high share = the same line in two registers)\n');
const mono = analysed.filter((a) => a.melodic && a.poly === 0 && a.notes.length > 0);
for (let i = 0; i < mono.length; i++) {
  for (let j = i + 1; j < mono.length; j++) {
    const A = mono[i], B = mono[j];
    const bMap = new Map<number, number>();
    for (const n of B.notes) bMap.set(Math.round(n.beat * 1000), n.pitch);
    const shared: number[] = [];
    let aOnly = 0;
    for (const n of A.notes) {
      const k = Math.round(n.beat * 1000);
      const p = bMap.get(k);
      if (p === undefined) { aOnly++; continue; }
      shared.push(p - n.pitch);
    }
    if (shared.length === 0) continue;
    const uniq = [...new Set(shared)].sort((a, b) => a - b);
    const constant = uniq.length === 1;
    console.log(`  part ${A.partId} "${A.instrument}"  vs  part ${B.partId} "${B.instrument}"`);
    console.log(`     ${shared.length} of ${A.notes.length} A-onsets shared with B (${B.notes.length} B-onsets), ${aOnly} A-only`);
    console.log(`     interval B-A on shared onsets: ${constant ? `CONSTANT ${shared[0] >= 0 ? '+' : ''}${shared[0]}` : `${uniq.length} distinct (${uniq.slice(0, 12).join(',')}${uniq.length > 12 ? '…' : ''})`}`);
    console.log('');
  }
}
