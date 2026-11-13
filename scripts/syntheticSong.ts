/**
 * Invented songs for the song gates (`verify-song-*.ts`). Every note here is made up for the test
 * it feeds: nothing is transcribed from a real tab. The songs are built in code, in the part JSON
 * shape the importer reads (`SongsterrPart`: measures → voices → beats → notes), so the gates
 * exercise the same flatten / chop / plan / export path a fetched tab would, on any clone.
 *
 * Each song exists for the musical features its gates assert on, and those are stated on the
 * builder. Change a song and the frozen expectations in the gates that read it change with it.
 *
 *  - `testSongA`: a five-part band song for the project PLANNER and the authoring SEEDER
 *    (live guitars, a decorative vocal, a head-trimmed intro, repeated verses / choruses that
 *    differ only in their fills, a doubled-tom breakdown ending on a fill, a live-only outro).
 *    Its hand-finished recipe and device-call golden are the two JSON files under
 *    `scripts/fixtures/synthetic-song/`.
 *  - `testSongB`: a four-part song whose choruses share a bass and a kick / snare skeleton but
 *    must NOT merge (a different cymbal voice on every bar, a pad in only one of them), plus a
 *    one-shot breakdown ending on a 1/4 bar and split tom lanes. Feeds the dedup measurement, the
 *    whole-song MIDI build and the first section-spec map.
 *  - `testSongC`: a kit plus a cymbal overdub, a bass, and a lead in octaves whose two-bar phrase
 *    carries scoops, falls and a slow bend. Feeds the pitch-gesture phrase and the second
 *    section-spec map.
 *  - `testSongDLine`: one wind line engraved in three octaves with the outer two ghosted, and a
 *    later high line a filter leaves out.
 */
import type { SongMidiSection } from '../packages/core/src/protocol-generic/patterns/songMidi.js';
import type { SongsterrPart, SsBeat, SsMeasure, SsNote } from '../packages/core/src/protocol-generic/patterns/songsterr.js';

// ── General MIDI percussion numbers the songs use ───────────────────────────
export const GM = {
  KICK: 36, SNARE: 38, HAT: 42, OPEN_HAT: 46, CRASH: 49, RIDE: 51,
  TOM_HIGH: 50, TOM_HI_MID: 48, TOM_LOW_MID: 47, TOM_LOW: 45, TOM_FLOOR_HI: 43, TOM_FLOOR: 41,
} as const;

const GUITAR_TUNING = [64, 59, 55, 50, 45, 40];
const BASS_TUNING = [43, 38, 33, 28];

// ── Builders ────────────────────────────────────────────────────────────────

/** One labelled part of an invented song. `partId` is the index a tab roster would give it. */
export interface SyntheticPart { partId: number; label: string; part: SongsterrPart }

const sixteenths = (n: number): [number, number] => [n, 16];
const rest = (steps: number): SsBeat => ({ notes: [{ rest: true }], rest: true, duration: sixteenths(steps) });

/** A bar of silence, `steps` sixteenths long (16 = one 4/4 bar). */
export function restBar(steps = 16): SsMeasure {
  return { voices: [{ beats: [rest(steps)], rest: true }], rest: true };
}

/**
 * A drum bar from one lane string per GM number, on a 16th grid: `x` a hit, `g` a ghosted hit,
 * `.` a rest. Every lane has the same length, and that length is the bar's (16 = 4/4, 4 = 1/4).
 */
export function drumBar(lanes: Record<number, string>): SsMeasure {
  const entries = Object.entries(lanes).map(([gm, lane]) => [Number(gm), lane] as const);
  const steps = entries[0][1].length;
  for (const [gm, lane] of entries) if (lane.length !== steps) throw new Error(`drumBar: lane ${gm} is ${lane.length} steps, expected ${steps}`);
  const beats: SsBeat[] = [];
  for (let i = 0; i < steps; i++) {
    const notes: SsNote[] = [];
    for (const [gm, lane] of entries) {
      if (lane[i] === 'x') notes.push({ fret: gm });
      else if (lane[i] === 'g') notes.push({ fret: gm, ghost: true });
      else if (lane[i] !== '.') throw new Error(`drumBar: lane ${gm} has "${lane[i]}" at step ${i}`);
    }
    beats.push(notes.length > 0 ? { notes, duration: sixteenths(1) } : rest(1));
  }
  return { voices: [{ beats }] };
}

/** One note (or one note of a chord) of a melodic bar: where it starts and how long, in sixteenths. */
export type LineNote = SsNote & { at: number; len: number };

/**
 * A melodic bar from notes placed on a 16th grid. Notes sharing `at` are one chord (and must share
 * `len`); the gaps between onsets are written as rests, the way a tab engraves them.
 */
export function lineBar(notes: readonly LineNote[], opts: { steps?: number; velocity?: string } = {}): SsMeasure {
  const steps = opts.steps ?? 16;
  const onsets = [...new Set(notes.map((n) => n.at))].sort((a, b) => a - b);
  const beats: SsBeat[] = [];
  let pos = 0;
  for (const at of onsets) {
    const chord = notes.filter((n) => n.at === at);
    const len = chord[0].len;
    if (chord.some((n) => n.len !== len)) throw new Error(`lineBar: the chord at step ${at} has mixed lengths`);
    if (at < pos) throw new Error(`lineBar: the note at step ${at} overlaps the one before it`);
    if (at > pos) beats.push(rest(at - pos));
    beats.push({
      notes: chord.map(({ at: _at, len: _len, ...note }) => note),
      duration: sixteenths(len),
      ...(opts.velocity !== undefined && beats.every((b) => b.rest === true) ? { velocity: opts.velocity } : {}),
    });
    pos = at + len;
  }
  if (pos > steps) throw new Error(`lineBar: the notes run ${pos} steps in a ${steps}-step bar`);
  if (pos < steps) beats.push(rest(steps - pos));
  return { voices: [{ beats }] };
}

/** `n` copies of one bar (each its own object, so a marker set on one does not leak to the rest). */
const times = (n: number, bar: () => SsMeasure): SsMeasure[] => Array.from({ length: n }, bar);

/**
 * Finish a part: stamp the section markers (1-based measure → name) and the signatures the song
 * shares across its parts, and the single tempo mark. Signatures are written only where they
 * change, as a tab does.
 */
function finish(
  base: Pick<SongsterrPart, 'tuning' | 'tuningFlat' | 'strings' | 'instrument'>,
  measures: SsMeasure[],
  song: { markers: Readonly<Record<number, string>>; signatures: Readonly<Record<number, [number, number]>>; bpm: number },
): SongsterrPart {
  measures.forEach((m, i) => {
    const marker = song.markers[i + 1];
    if (marker !== undefined) m.marker = { text: marker };
    const sig = song.signatures[i + 1];
    if (sig !== undefined) m.signature = sig;
  });
  return { ...base, measures, automations: { tempo: [{ measure: 0, position: 0, bpm: song.bpm }] } };
}

const drums = { tuningFlat: true, instrument: 'Drums' } as const;
const guitar = { tuning: GUITAR_TUNING, strings: 6 } as const;
const bass = { tuning: BASS_TUNING, strings: 4 } as const;

/** A bass bar on the lowest two strings from `[at, len, fret, string]` rows. */
const bassBar = (rows: readonly (readonly [number, number, number, number])[]): SsMeasure =>
  lineBar(rows.map(([at, len, fret, string]) => ({ at, len, fret, string })));
/** One whole-bar note (a held pad or vocal note, a guitar chord root). */
const heldBar = (fret: number, string: number, steps = 16): SsMeasure => lineBar([{ at: 0, len: steps, fret, string }], { steps });

// ═══════════════════════════════════════════════════════════════════════════
// TEST SONG A: the planner / seeder song
// ═══════════════════════════════════════════════════════════════════════════

/** Test Song A's section starts (1-based measures). 54 bars, 4/4 throughout. */
export const TEST_SONG_A_SPINE: readonly (readonly [string, number])[] = [
  ['Intro', 1], ['Verse 1', 19], ['Chorus 1', 23], ['Verse 2', 27], ['Chorus 2', 31],
  ['Bridge', 35], ['Breakdown', 39], ['Solo', 43], ['Chorus 3', 47], ['Outro', 51],
];
/** The measure of Test Song A's breakdown fill (the bar the recipe bakes to one sample). */
export const TEST_SONG_A_BREAKDOWN_FILL = 42;
/** The partIds performed live in Test Song A (the two guitars). */
export const TEST_SONG_A_LIVE = [0, 1];

/**
 * Test Song A. Five parts: two guitars (live), bass, drums, and a decorative "oohs" vocal.
 *
 *  - Intro m1-18 is 18 bars, two over the 16-bar project ceiling. Only the guitar plays m1-2; the
 *    oohs enter at m3 and the rhythm section at m5. So the trim that makes it fit is the two
 *    guitar-only head bars (m3-18 kept), and it stops at the oohs, not at the drums.
 *  - Verse 1 / Verse 2 and Chorus 1 / 2 / 3 share three groove bars and differ in the fourth (the
 *    fill), on drums AND bass: agreement 0.75, a shared groove with one differing bar each.
 *  - The Intro, the choruses and the Solo strike two tom lanes, but only inside a fill; the verses
 *    strike one; the Bridge none.
 *  - The Breakdown is driven by two tom lanes (45 and 47) on every bar, and its last bar (m42) is a
 *    fill that starts on beat 2: open hat + kick, then toms descending 50, 47, 45, 41. It is no
 *    denser than the bars before it and toms are not exceptional there, so only the crash on the
 *    Solo's downbeat marks it as a fill.
 *  - Outro m51-54 is the guitar and the oohs alone: nothing for a rhythm section to back.
 */
export function testSongA(): SyntheticPart[] {
  const song = {
    markers: Object.fromEntries(TEST_SONG_A_SPINE.map(([name, m]) => [m, name])),
    signatures: { 1: [4, 4] as [number, number] },
    bpm: 120,
  };
  const { KICK, SNARE, HAT, OPEN_HAT, CRASH, RIDE, TOM_HIGH, TOM_HI_MID, TOM_LOW_MID, TOM_LOW, TOM_FLOOR } = GM;

  // ── drums ──
  const introGroove = (): SsMeasure => drumBar({ [KICK]: 'x.......x.x.....', [SNARE]: '....x.......x...', [HAT]: 'x.x.x.x.x.x.x.x.' });
  const introFill = (): SsMeasure => drumBar({ [KICK]: 'x.......x.......', [SNARE]: '....x.x.........', [TOM_HI_MID]: '........x.x.....', [TOM_LOW]: '............x.xx' });
  /** A section's first bar carries a crash on its downbeat. */
  const opening = (lanes: Record<number, string>, first: boolean): SsMeasure => drumBar(first ? { ...lanes, [CRASH]: 'x...............' } : lanes);
  const verseGroove = (first = false): SsMeasure => opening({ [KICK]: 'x.....x...x.....', [SNARE]: '....x.......x...', [HAT]: 'x.x.x.x.x.x.x.x.' }, first);
  const verseFill1 = (): SsMeasure => drumBar({ [KICK]: 'x.....x.........', [SNARE]: '....x...x.x.xx..', [HAT]: 'x.x.x.x.........', [TOM_LOW]: '..............xx' });
  const verseFill2 = (): SsMeasure => drumBar({ [KICK]: 'x.....x.....x...', [SNARE]: '....x...xx.x....', [HAT]: 'x.x.x.x.........', [TOM_LOW]: '............x.x.' });
  const chorusGroove = (first = false): SsMeasure => opening({ [KICK]: 'x...x...x...x...', [SNARE]: '....x.......x...', [OPEN_HAT]: '..x...x...x...x.' }, first);
  const chorusFill = (hiMid: string, low: string): SsMeasure => drumBar({ [KICK]: 'x...x...........', [SNARE]: '....x...........', [OPEN_HAT]: '..x...x.........', [TOM_HI_MID]: hiMid, [TOM_LOW]: low });
  const chorus = (hiMid: string, low: string): SsMeasure[] => [chorusGroove(true), chorusGroove(), chorusGroove(), chorusFill(hiMid, low)];
  const bridgeGroove = (): SsMeasure => drumBar({ [KICK]: 'x.......x.......', [SNARE]: '........x.......', [HAT]: 'x...x...x...x...' });
  const breakdownDrive = (): SsMeasure => drumBar({ [KICK]: 'x..x..x...x..x..', [TOM_LOW_MID]: 'x.x...x.x...x.x.', [TOM_LOW]: '..x.x...x.x...x.' });
  const breakdownFill = (): SsMeasure => drumBar({
    [OPEN_HAT]: '....x...........', [KICK]: '....x.x.........',
    [TOM_HIGH]: '........x.......', [TOM_LOW_MID]: '..........x.....', [TOM_LOW]: '............x...', [TOM_FLOOR]: '..............x.',
  });
  const soloGroove = (first = false): SsMeasure => opening({ [KICK]: 'x..x..x...x.....', [SNARE]: '....x.......x...', [RIDE]: 'x.x.x.x.x.x.x.x.' }, first);
  const soloFill = (): SsMeasure => drumBar({ [KICK]: 'x..x............', [SNARE]: '....x.x.........', [RIDE]: 'x.x.............', [TOM_HIGH]: '........xx......', [TOM_LOW]: '..........xx.x.x' });

  const drumMeasures: SsMeasure[] = [
    ...times(4, restBar), ...times(13, introGroove), introFill(),                 // Intro m1-18
    verseGroove(true), verseGroove(), verseGroove(), verseFill1(),                 // Verse 1 m19-22
    ...chorus('........x.x.....', '............x.x.'),                             // Chorus 1 m23-26
    verseGroove(true), verseGroove(), verseGroove(), verseFill2(),                 // Verse 2 m27-30
    ...chorus('........xx......', '..........xx.x.x'),                             // Chorus 2 m31-34
    ...times(4, bridgeGroove),                                                     // Bridge m35-38
    ...times(3, breakdownDrive), breakdownFill(),                                  // Breakdown m39-42
    soloGroove(true), soloGroove(), soloGroove(), soloFill(),                      // Solo m43-46
    ...chorus('........x..x....', '..........x...xx'),                             // Chorus 3 m47-50
    ...times(4, restBar),                                                          // Outro m51-54
  ];

  // ── bass (string 3 = E1 28, string 2 = A1 33) ──
  const introBass = (): SsMeasure => bassBar([[0, 8, 0, 3], [8, 2, 0, 3], [10, 6, 3, 3]]);
  const verseBass = (): SsMeasure => bassBar([[0, 6, 0, 2], [6, 2, 0, 2], [10, 2, 3, 3], [12, 4, 5, 3]]);
  const verseBassTurn1 = (): SsMeasure => bassBar([[0, 6, 0, 2], [6, 2, 0, 2], [8, 4, 2, 2], [12, 4, 3, 2]]);
  const verseBassTurn2 = (): SsMeasure => bassBar([[0, 6, 0, 2], [6, 2, 0, 2], [8, 2, 5, 3], [10, 2, 3, 3], [12, 4, 0, 3]]);
  const chorusBass = (): SsMeasure => bassBar([[0, 4, 3, 3], [4, 4, 3, 3], [8, 4, 5, 3], [12, 4, 5, 3]]);
  const chorusBassTurn = (lastFret: number): SsMeasure => bassBar([[0, 4, 3, 3], [4, 4, 3, 3], [8, 8, lastFret, 3]]);
  const chorusBassBars = (lastFret: number): SsMeasure[] => [chorusBass(), chorusBass(), chorusBass(), chorusBassTurn(lastFret)];
  const bridgeBass = (): SsMeasure => bassBar([[0, 16, 2, 2]]);
  const breakdownBass = (): SsMeasure => bassBar([[0, 2, 0, 3], [3, 2, 0, 3], [6, 2, 1, 3], [10, 2, 0, 3], [13, 2, 0, 3]]);
  const breakdownBassStop = (): SsMeasure => bassBar([[0, 4, 0, 3]]);
  const soloBass = (): SsMeasure => bassBar([[0, 2, 5, 3], [2, 2, 5, 3], [4, 2, 5, 3], [6, 2, 5, 3], [8, 2, 7, 3], [10, 2, 7, 3], [12, 2, 3, 3], [14, 2, 3, 3]]);
  const soloBassTurn = (): SsMeasure => bassBar([[0, 8, 5, 3], [8, 8, 7, 3]]);

  const bassMeasures: SsMeasure[] = [
    ...times(4, restBar), ...times(14, introBass),
    verseBass(), verseBass(), verseBass(), verseBassTurn1(),
    ...chorusBassBars(7),
    verseBass(), verseBass(), verseBass(), verseBassTurn2(),
    ...chorusBassBars(8),
    ...times(4, bridgeBass),
    ...times(3, breakdownBass), breakdownBassStop(),
    soloBass(), soloBass(), soloBass(), soloBassTurn(),
    ...chorusBassBars(10),
    ...times(4, restBar),
  ];

  // ── guitars (live): the lead plays every bar, the rhythm joins with the band at m5 ──
  const sectionFret = (m: number): number => {
    let idx = 0;
    TEST_SONG_A_SPINE.forEach(([, from], i) => { if (m >= from) idx = i; });
    return [0, 5, 3, 5, 3, 2, 0, 7, 3, 0][idx];
  };
  const leadMeasures = Array.from({ length: 54 }, (_, i) => heldBar(sectionFret(i + 1), 5));
  const rhythmMeasures = Array.from({ length: 54 }, (_, i) => (i < 4
    ? restBar()
    : lineBar([{ at: 0, len: 8, fret: sectionFret(i + 1), string: 4 }, { at: 8, len: 8, fret: sectionFret(i + 1) + 2, string: 4 }])));

  // ── decorative vocal: Intro from m3, the choruses, the Outro ──
  const oohs = (m: number): boolean => (m >= 3 && m <= 18) || (m >= 23 && m <= 26) || (m >= 31 && m <= 34) || m >= 47;
  const vocalMeasures = Array.from({ length: 54 }, (_, i) => (oohs(i + 1) ? heldBar(i % 2 === 0 ? 5 : 7, 1) : restBar()));

  return [
    { partId: 0, label: 'Lead Guitar', part: finish(guitar, leadMeasures, song) },
    { partId: 1, label: 'Rhythm Guitar', part: finish(guitar, rhythmMeasures, song) },
    { partId: 2, label: 'Bass', part: finish(bass, bassMeasures, song) },
    { partId: 3, label: 'Drums', part: finish(drums, drumMeasures, song) },
    { partId: 4, label: 'Voice Oohs', part: finish(guitar, vocalMeasures, song) },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SONG B: the choruses that must not merge, the whole-song MIDI build, section-spec map 1
// ═══════════════════════════════════════════════════════════════════════════

/** Test Song B's section starts (1-based measures). 41 bars; m33 is a 1/4 bar, the rest 4/4. */
export const TEST_SONG_B_SPINE: readonly (readonly [string, number])[] = [
  ['Intro', 1], ['Verse 1', 5], ['Chorus A', 13], ['Verse 2', 17], ['Chorus B', 25],
  ['Breakdown', 29], ['Chorus C', 34], ['Outro Chorus', 38],
];
/** Bars in each of Test Song B's four choruses. */
export const TEST_SONG_B_CHORUS_BARS = 4;
/** The first measure of the chorus bass figure the maps borrow (Chorus A). */
export const TEST_SONG_B_CHORUS_BASS_FROM = 13;
/** The partIds performed live in Test Song B (the guitar). */
export const TEST_SONG_B_LIVE = [0];
/** Part indices into `testSongB()`. */
export const TEST_SONG_B_PART = { guitar: 0, bass: 1, pad: 2, drums: 3 } as const;

/**
 * Test Song B. Four parts: a guitar (live), bass, pad, drums.
 *
 *  - Four 4-bar choruses share one kick / snare skeleton. Choruses A, B and C each end on a
 *    floor-tom fill bar and play the SAME bass. What separates them is on every bar, not in the
 *    fills: the cymbal lane is a closed hat in A, a crash in B, an open hat in C and a ride in the
 *    Outro Chorus; the pad plays only in Chorus B and the Outro Chorus; and the Outro Chorus has
 *    its own bass. So they are different sections, and excluding fill bars cannot make them one.
 *  - Verse 2 repeats Verse 1 except for Verse 1's last-bar snare fill.
 *  - The pad is written the way a tab writes a held note: eight abutting eighths per bar.
 *  - The Breakdown (m29-33) is driven by a low tom and a floor tom, stops on a crash at m32, and
 *    ends on a silent 1/4 bar (m33).
 */
export function testSongB(): SyntheticPart[] {
  const song = {
    markers: Object.fromEntries(TEST_SONG_B_SPINE.map(([name, m]) => [m, name])),
    signatures: { 1: [4, 4] as [number, number], 33: [1, 4] as [number, number], 34: [4, 4] as [number, number] },
    bpm: 140,
  };
  const { KICK, SNARE, HAT, OPEN_HAT, CRASH, RIDE, TOM_LOW, TOM_FLOOR } = GM;

  // ── drums ──
  const introBar = (): SsMeasure => drumBar({ [KICK]: 'x.......x.......', [HAT]: 'x...x...x...x...' });
  const verseGroove = (): SsMeasure => drumBar({ [KICK]: 'x.....x.x.......', [SNARE]: '....x.......x...', [HAT]: 'x.x.x.x.x.x.x.x.' });
  const verseFill = (): SsMeasure => drumBar({ [KICK]: 'x.....x.........', [SNARE]: '....x...x.x.xxxx', [HAT]: 'x.x.x.x.........' });
  const chorusGroove = (cymbal: number): SsMeasure => drumBar({ [KICK]: 'x...x.....x.x...', [SNARE]: '....x.......x...', [cymbal]: 'x.x.x.x.x.x.x.x.' });
  const chorusFill = (cymbal: number, floor: string): SsMeasure => drumBar({ [KICK]: 'x...x...........', [SNARE]: '....x...x.xx....', [cymbal]: 'x.x.x.x.........', [TOM_FLOOR]: floor });
  const chorus = (cymbal: number, floor: string): SsMeasure[] => [...times(3, () => chorusGroove(cymbal)), chorusFill(cymbal, floor)];
  const breakdownDrive = (): SsMeasure => drumBar({ [KICK]: 'x.....x...x.....', [SNARE]: '....x.......x...', [TOM_LOW]: 'x.x.....x.x.....', [TOM_FLOOR]: '......x.x.....x.' });
  const breakdownStop = (): SsMeasure => drumBar({ [KICK]: 'x...............', [CRASH]: 'x...............' });

  const drumMeasures: SsMeasure[] = [
    ...times(4, introBar),                                        // Intro m1-4
    ...times(7, verseGroove), verseFill(),                         // Verse 1 m5-12
    ...chorus(HAT, '............x.xx'),                            // Chorus A m13-16
    ...times(8, verseGroove),                                      // Verse 2 m17-24
    ...chorus(CRASH, '............xx.x'),                          // Chorus B m25-28
    ...times(3, breakdownDrive), breakdownStop(), restBar(4),      // Breakdown m29-33
    ...chorus(OPEN_HAT, '..........x.x.xx'),                       // Chorus C m34-37
    ...times(4, () => chorusGroove(RIDE)),                         // Outro Chorus m38-41 (no fill: it loops out)
  ];

  // ── bass (string 3 = E1 28, string 2 = A1 33) ──
  const introBass = (): SsMeasure => bassBar([[0, 16, 0, 3]]);
  const verseBass = (): SsMeasure => bassBar([[0, 2, 0, 2], [2, 2, 0, 2], [4, 2, 0, 2], [6, 2, 0, 2], [8, 2, 3, 3], [10, 2, 3, 3], [12, 2, 5, 3], [14, 2, 5, 3]]);
  const chorusBass = (): SsMeasure => bassBar([[0, 4, 3, 2], [4, 4, 3, 2], [8, 4, 5, 2], [12, 4, 7, 2]]);
  const outroBass = (): SsMeasure => bassBar([[0, 6, 3, 2], [6, 2, 3, 2], [8, 6, 0, 2], [14, 2, 0, 2]]);
  const breakdownBass = (): SsMeasure => bassBar([[0, 2, 0, 3], [2, 2, 0, 3], [6, 2, 0, 3], [8, 2, 0, 3], [10, 2, 1, 3], [14, 2, 0, 3]]);

  const bassMeasures: SsMeasure[] = [
    ...times(4, introBass), ...times(8, verseBass), ...times(4, chorusBass), ...times(8, verseBass), ...times(4, chorusBass),
    ...times(3, breakdownBass), bassBar([[0, 16, 0, 3]]), restBar(4),
    ...times(4, chorusBass), ...times(4, outroBass),
  ];

  // ── pad: one pitch per bar as eight abutting eighths (string 0 = E4 64) ──
  const padBar = (fret: number): SsMeasure => lineBar(Array.from({ length: 8 }, (_, i) => ({ at: i * 2, len: 2, fret, string: 0 })));
  const padRun = (n: number, frets: readonly number[]): SsMeasure[] => Array.from({ length: n }, (_, i) => padBar(frets[i % frets.length]));
  const padMeasures: SsMeasure[] = [
    ...padRun(4, [7]), ...padRun(8, [7, 5]), ...times(4, restBar), ...padRun(8, [7, 5]), ...padRun(4, [10, 8]),
    ...times(4, restBar), restBar(4), ...times(4, restBar), ...padRun(4, [3, 5]),
  ];

  // ── guitar (live) ──
  const guitarMeasures: SsMeasure[] = Array.from({ length: 41 }, (_, i) => (i === 32 ? heldBar(0, 5, 4) : heldBar([0, 3, 5, 7][i % 4], 5)));

  return [
    { partId: 0, label: 'Rhythm Guitar', part: finish(guitar, guitarMeasures, song) },
    { partId: 1, label: 'Bass', part: finish(bass, bassMeasures, song) },
    { partId: 2, label: 'Pad', part: finish(guitar, padMeasures, song) },
    { partId: 3, label: 'Drums', part: finish(drums, drumMeasures, song) },
  ];
}

/**
 * The section table Test Song B is exported with (`buildSongMidi`): which measures each sequence
 * stores, which parts play in it, and where a part is borrowed from.
 *
 *  - Verse 1 and Verse 2 store only their first four bars, so m9-12 and m21-24 are covered by no
 *    section (the chart option fills them in).
 *  - Verse 2 leaves the Pad out although the tab has it there (`parts` silences it).
 *  - The Outro borrows the chorus bass figure from m13, replacing its own bass.
 */
export const TEST_SONG_B_MIDI_SECTIONS: readonly SongMidiSection[] = [
  { name: 'Intro', from: 1, to: 4, parts: ['Drums', 'Bass', 'Pad'] },
  { name: 'Verse 1', from: 5, to: 8, parts: ['Drums', 'Bass', 'Pad'] },
  { name: 'Chorus A', from: 13, to: 16, parts: ['Drums', 'Bass'] },
  { name: 'Verse 2', from: 17, to: 20, parts: ['Drums', 'Bass'] },
  { name: 'Chorus B', from: 25, to: 28, parts: ['Drums', 'Bass', 'Pad'] },
  { name: 'Breakdown', from: 29, to: 33, parts: ['Drums', 'Bass'], oneShot: true },
  { name: 'Chorus C', from: 34, to: 37, parts: ['Drums', 'Bass'] },
  { name: 'Outro', from: 38, to: 41, parts: ['Drums', 'Bass', 'Pad'], borrow: { Bass: TEST_SONG_B_CHORUS_BASS_FROM } },
];

// ═══════════════════════════════════════════════════════════════════════════
// TEST SONG C: the pitch-gesture phrase, section-spec map 2
// ═══════════════════════════════════════════════════════════════════════════

/** Test Song C's section starts (1-based measures). 42 bars, 4/4 throughout. */
export const TEST_SONG_C_SPINE: readonly (readonly [string, number])[] = [
  ['Count-In', 1], ['Band Intro', 3], ['Main Riff', 11], ['Verse', 27], ['Pre-Chorus', 31], ['Chorus', 39],
];
/** The two measures of Test Song C's lead that carry the scoops, the falls and the slow bend. */
export const TEST_SONG_C_GESTURE_PHRASE: readonly [number, number] = [19, 20];
/** Part indices into `testSongC()`. */
export const TEST_SONG_C_PART = { kit: 0, cymbals: 1, bass: 2, lead: 3 } as const;
/**
 * What the gesture phrase must render to with `monoVoice: 1, pitchGestures: 'glide'` and a
 * whole-tone slide, velocities stripped. Derived by hand from the phrase written in `testSongC`
 * (the upper octave is e4; a 16th grid, two bars; `n/3` lengths are a connected note's overlap):
 *
 *   step  1  d4          the scoop into the first note, a whole tone below, one step early
 *   step  2  e4          the first note (written steps 2-9; its last step goes to the fall)
 *   step  9  d4          its fall and the next note's scoop land on one step: ONE note
 *   step 10  e4          the second note (written steps 10-15)
 *   step 15  d4          its fall = the scoop into bar 2, again one note
 *   step 16  e4, 18 f4, 22 f#4, 26 g4
 *                        the 12-step bend up a tone and a half as a semitone staircase, each step
 *                        where the linear bend crosses a half (2, 6 and 10 steps in)
 *   step 27  a4          the upward fall on the bent note's last step, a tone above where it ended
 */
export const TEST_SONG_C_GESTURE_NOTATION =
  '~ d4:4/3 e4:22/3 ~ ~ ~ ~ ~ ~ d4:4/3 e4:16/3 ~ ~ ~ ~ d4:4/3 e4:7/3 ~ f4:13/3 ~ ~ ~ f#4:13/3 ~ ~ ~ g4:4/3 a4:1 ~ ~ ~ ~';

/**
 * Test Song C. Four parts: a kit, a second drum part holding only crashes (the way a tab splits
 * a cymbal overdub off), a bass, and a lead written in octaves.
 *
 *  - m1-2 is a silent count-in that no map stores.
 *  - The Band Intro (m3-10) plays six bars and then stops: m9-10 are silent on every part.
 *  - The Main Riff (m11-26) is 16 bars; the lead enters at its ninth bar (m19) with an 8-bar
 *    phrase whose first two bars (m19-20) are the gesture phrase: two notes that scoop in from
 *    below and fall off downwards, then a note that scoops in, bends slowly up a tone and a half
 *    and falls off upwards. Every lead onset is an octave pair, so a mono reading has to pick one.
 *  - The Pre-Chorus (m31-38) replays that 8-bar lead phrase over the riff.
 *  - The kit itself never plays a crash; every crash is in the overdub part.
 */
export function testSongC(): SyntheticPart[] {
  const song = {
    markers: Object.fromEntries(TEST_SONG_C_SPINE.map(([name, m]) => [m, name])),
    signatures: { 1: [4, 4] as [number, number] },
    bpm: 150,
  };
  const { KICK, SNARE, HAT, OPEN_HAT, CRASH } = GM;

  // ── kit ──
  const introBeat = (): SsMeasure => drumBar({ [KICK]: 'x.......x.......', [SNARE]: '....x.......x...', [HAT]: 'x...x...x...x...' });
  const riffBeat = (): SsMeasure => drumBar({ [KICK]: 'x..x..x.x..x..x.', [SNARE]: '....x.......x...', [HAT]: 'x.x.x.x.x.x.x.x.' });
  const verseBeat = (): SsMeasure => drumBar({ [KICK]: 'x.........x.....', [SNARE]: '........x.......', [HAT]: 'x.x.x.x.x.x.x.x.' });
  const chorusBeat = (): SsMeasure => drumBar({ [KICK]: 'x...x...x...x...', [SNARE]: '....x.......x...', [OPEN_HAT]: 'x.x.x.x.x.x.x.x.' });
  const kitMeasures: SsMeasure[] = [
    ...times(2, restBar), ...times(6, introBeat), ...times(2, restBar),
    ...times(16, riffBeat), ...times(4, verseBeat), ...times(8, riffBeat), ...times(4, chorusBeat),
  ];

  // ── cymbal overdub: a crash on the first downbeat of every four bars of the riff sections and the chorus ──
  const crashAt = new Set([11, 15, 19, 23, 31, 35, 39]);
  const cymbalMeasures: SsMeasure[] = Array.from({ length: 42 }, (_, i) => (crashAt.has(i + 1) ? drumBar({ [CRASH]: 'x...............' }) : restBar()));

  // ── bass (string 3 = E1 28) ──
  const introBass = (): SsMeasure => bassBar([[0, 8, 0, 3], [8, 8, 3, 3]]);
  const riffBass = (): SsMeasure => bassBar([[0, 3, 0, 3], [3, 3, 0, 3], [6, 2, 3, 3], [8, 3, 0, 3], [11, 3, 0, 3], [14, 2, 5, 3]]);
  const verseBass = (): SsMeasure => bassBar([[0, 10, 0, 3], [10, 6, 3, 3]]);
  const chorusBass = (): SsMeasure => bassBar([[0, 4, 5, 3], [4, 4, 5, 3], [8, 4, 7, 3], [12, 4, 3, 3]]);
  const bassMeasures: SsMeasure[] = [
    ...times(2, restBar), ...times(6, introBass), ...times(2, restBar),
    ...times(16, riffBass), ...times(4, verseBass), ...times(8, riffBass), ...times(4, chorusBass),
  ];

  // ── lead, in octaves: the upper note on string 2 (G3 55), the lower two frets down on string 4 (A2 45) ──
  type Extra = Omit<SsNote, 'fret' | 'string' | 'rest'>;
  const octave = (at: number, len: number, upperFret: number, extra: Extra = {}): LineNote[] => [
    { at, len, fret: upperFret, string: 2, ...extra },
    { at, len, fret: upperFret - 2, string: 4, ...extra },
  ];
  const slowBend = { tone: 150, points: [{ position: 0, tone: 0 }, { position: 60, tone: 150 }] };
  const leadPhrase = (): SsMeasure[] => [
    lineBar([...octave(2, 8, 9, { slide: 'belowdownwards' }), ...octave(10, 6, 9, { slide: 'belowdownwards' })], { velocity: 'mf' }),
    lineBar(octave(0, 12, 9, { slide: 'belowupwards', bend: slowBend })),
    lineBar([...octave(0, 4, 9), ...octave(4, 4, 12), ...octave(8, 8, 11)]),
    lineBar([...octave(0, 8, 9), ...octave(8, 4, 7), ...octave(12, 4, 9)]),
    lineBar([...octave(0, 4, 9), ...octave(4, 4, 12), ...octave(8, 8, 14)]),
    lineBar([...octave(0, 8, 12), ...octave(8, 8, 11)]),
    lineBar([...octave(0, 6, 9), ...octave(6, 6, 7), ...octave(12, 4, 4)]),
    lineBar(octave(0, 16, 9)),
  ];
  const leadMeasures: SsMeasure[] = [
    ...times(18, restBar), ...leadPhrase(), ...times(4, restBar), ...leadPhrase(), ...times(4, restBar),
  ];

  return [
    { partId: 0, label: 'Drums', part: finish(drums, kitMeasures, song) },
    { partId: 1, label: 'Drums (cymbals)', part: finish(drums, cymbalMeasures, song) },
    { partId: 2, label: 'Bass', part: finish(bass, bassMeasures, song) },
    { partId: 3, label: 'Lead Synth', part: finish(guitar, leadMeasures, song) },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST SONG D: one wind line in three octaves
// ═══════════════════════════════════════════════════════════════════════════

/** The measures of `testSongDLine`: the three-octave line, the plain line, and the high line a filter leaves out. */
export const TEST_SONG_D = { triple: [3, 5], plain: [7, 8], high: [9, 12], measures: 12 } as const;

/**
 * One melodic part, 12 bars of 4/4, quarter notes throughout:
 *
 *  - m3-5: a line engraved in THREE octaves at once. The middle one (MIDI 53..58) is plain; the
 *    octave above and the octave below are ghosted (parenthesised). 12 onsets, 36 notes, 24 ghosts.
 *  - m7-8: the same register, plain. 8 notes.
 *  - m9-12: a high plain line (MIDI 71..76). 16 notes.
 *
 * 60 notes in all, 24 of them ghosted.
 */
export function testSongDLine(): SongsterrPart {
  const song = { markers: { 1: 'Intro', 9: 'Chorus' }, signatures: { 1: [4, 4] as [number, number] }, bpm: 96 };
  // Middle line on string 3 (D3 50); +12 is string 1 (B3 59) three frets up; -12 is string 5 (E2 40) two frets down.
  const triple = (frets: readonly number[]): SsMeasure => lineBar(frets.flatMap((f, i) => [
    { at: i * 4, len: 4, fret: f + 3, string: 1, ghost: true },
    { at: i * 4, len: 4, fret: f, string: 3 },
    { at: i * 4, len: 4, fret: f - 2, string: 5, ghost: true },
  ]));
  const plain = (frets: readonly number[], string: number): SsMeasure => lineBar(frets.map((f, i) => ({ at: i * 4, len: 4, fret: f, string })));
  const measures: SsMeasure[] = [
    restBar(), restBar(),
    triple([3, 5, 7, 8]), triple([7, 5, 3, 5]), triple([3, 3, 8, 7]),
    restBar(),
    plain([3, 5, 7, 5], 3), plain([8, 7, 5, 3], 3),
    plain([7, 8, 10, 12], 0), plain([12, 10, 8, 7], 0), plain([7, 8, 10, 12], 0), plain([12, 12, 10, 7], 0),
  ];
  return finish(guitar, measures, song);
}
