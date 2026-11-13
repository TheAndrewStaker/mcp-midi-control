/**
 * Offline Songsterr for gates: swap `globalThis.fetch` so `import_songsterr` reads a GENERATED
 * song instead of the network. Nothing here is a transcription of a real recording: the three
 * songs are built by the code below, in the JSON shape the Songsterr API serves (`/api/meta/<id>`
 * and one part file per track), so the whole import path runs with no third-party tab data in
 * the tree.
 *
 * Why offline at all: a gate that hits songsterr.com is flaky by construction. On 2026-11-07
 * Songsterr answered every meta fetch with HTTP 403 for a day and preflight went red with no
 * code change.
 *
 * The songs (ids are outside Songsterr's range on purpose):
 *   - 900001 "Fixture Song A": drums only, one tempo, long enough to need several projects.
 *   - 900002 "Fixture Song B": eight tracks with the drums at index 6, a different section shape.
 *   - 900003 "Fixture Song C": seven parts over 135 measures with markers every 16 bars and two
 *     silent tails. It has the STRUCTURE of the song the project chop was first worked out on by
 *     hand (verify-project-plan case 6), with invented notes.
 *
 * Any request the generator does not cover throws, so a gate can never fall through to the wire.
 */

interface Note { fret?: number; string?: number; rest?: boolean }
interface Beat { notes: Note[]; type: number; duration: [number, number]; rest?: boolean }
interface Measure { voices: Array<{ beats: Beat[]; rest?: boolean }>; signature?: [number, number]; marker?: { text: string; width: number }; rest?: boolean }
interface Part { [k: string]: unknown; measures: Measure[] }
interface Track { instrumentId: number; instrument: string; name?: string; isDrums?: boolean; tuning?: number[] }
interface Song { meta: Record<string, unknown>; parts: Part[] }

/** One bar as eight 8th-note slots; an empty slot is a rest. */
type Bar = Note[][];

const restBar = (): Measure => ({
  voices: [{ beats: [{ notes: [{ rest: true }], type: 1, rest: true, duration: [1, 1] }], rest: true }],
  rest: true,
});

function barToMeasure(bar: Bar | undefined): Measure {
  if (bar === undefined || bar.every((slot) => slot.length === 0)) return restBar();
  const beats: Beat[] = bar.map((slot) => (slot.length === 0
    ? { notes: [{ rest: true }], type: 8, rest: true, duration: [1, 8] }
    : { notes: slot, type: 8, duration: [1, 8] }));
  return { voices: [{ beats }] };
}

const drum = (...gm: number[]): Note[] => gm.map((n, i) => ({ fret: n, string: i }));
const pitched = (fret: number, string = 0): Note[] => [{ fret, string }];

const KICK = 36, SNARE = 38, HAT = 42, OPEN = 46, CRASH = 49, TOM = 45;

/** Drum bars. Each is distinct so a section is not one repeated pattern. */
const DRUM_BARS: Record<string, Bar> = {
  verse: [drum(HAT, KICK), drum(HAT), drum(HAT, SNARE), drum(HAT), drum(HAT, KICK), drum(HAT, KICK), drum(HAT, SNARE), drum(HAT)],
  verseB: [drum(HAT, KICK), drum(HAT), drum(HAT, SNARE), drum(HAT, KICK), drum(HAT), drum(HAT, KICK), drum(HAT, SNARE), drum(OPEN)],
  chorus: [drum(CRASH, KICK), drum(OPEN), drum(OPEN, SNARE), drum(OPEN, KICK), drum(OPEN, KICK), drum(OPEN), drum(OPEN, SNARE), drum(OPEN)],
  chorusB: [drum(OPEN, KICK), drum(OPEN, KICK), drum(OPEN, SNARE), drum(OPEN), drum(OPEN, KICK), drum(OPEN), drum(OPEN, SNARE), drum(SNARE)],
  bridge: [drum(KICK), [], drum(TOM), drum(TOM), drum(KICK), [], drum(SNARE), []],
  bridgeB: [drum(KICK), drum(TOM), [], drum(TOM), drum(KICK), drum(KICK), drum(SNARE), drum(TOM)],
  fill: [drum(SNARE), drum(SNARE), drum(TOM), drum(TOM), drum(SNARE), drum(TOM), drum(SNARE, KICK), drum(CRASH, KICK)],
  intro: [drum(HAT), [], drum(HAT), [], drum(HAT), [], drum(HAT), drum(HAT)],
};

interface Section { name: string; bars: Array<Bar | undefined> }

function drumSection(name: string, a: string, b: string, bars: number): Section {
  const out: Array<Bar | undefined> = [];
  for (let i = 0; i < bars; i++) out.push(i === bars - 1 ? DRUM_BARS.fill : DRUM_BARS[i % 2 === 0 ? a : b]);
  return { name, bars: out };
}

function partFrom(songId: number, revisionId: number, partId: number, track: Track, bpm: number, sections: Section[]): Part {
  const measures: Measure[] = [];
  for (const sec of sections) {
    sec.bars.forEach((bar, i) => {
      const m = barToMeasure(bar);
      if (measures.length === 0) m.signature = [4, 4];
      if (i === 0) m.marker = { text: sec.name, width: 40 };
      measures.push(m);
    });
  }
  return {
    name: track.name ?? '',
    balance: 0,
    volume: 1,
    measures,
    frets: 24,
    ...(track.isDrums ? {} : { tuning: track.tuning ?? [64, 59, 55, 50, 45, 40] }),
    strings: 6,
    instrumentId: track.instrumentId,
    instrument: track.instrument,
    partId,
    automations: { tempo: [{ measure: 0, position: 0, bpm, type: 4 }] },
    version: 5,
    songId,
    revisionId,
  };
}

function metaFor(songId: number, revisionId: number, title: string, tracks: Track[], drumIndex: number): Record<string, unknown> {
  return {
    songId,
    revisionId,
    image: 'img',
    title,
    artist: 'Generated Fixture',
    popularTrackDrum: drumIndex,
    tracks: tracks.map((t, i) => ({
      instrumentId: t.instrumentId,
      instrument: t.instrument,
      ...(t.name !== undefined ? { name: t.name } : {}),
      hash: `h${i}`,
      ...(t.isDrums ? { isDrums: true } : {}),
    })),
  };
}

const DRUMS: Track = { instrumentId: 1024, instrument: 'Drums', isDrums: true };

function songA(): Song {
  const id = 900001, rev = 1;
  const sections = [
    drumSection('Intro', 'intro', 'intro', 4),
    drumSection('Verse 1', 'verse', 'verseB', 8),
    drumSection('Chorus', 'chorus', 'chorusB', 8),
    drumSection('Verse 2', 'verse', 'verseB', 8),
    drumSection('Chorus', 'chorus', 'chorusB', 8),
    drumSection('Bridge', 'bridge', 'bridgeB', 8),
    drumSection('Chorus', 'chorus', 'chorusB', 8),
    drumSection('Outro', 'verse', 'intro', 4),
  ];
  return { meta: metaFor(id, rev, 'Fixture Song A', [DRUMS], 0), parts: [partFrom(id, rev, 0, DRUMS, 100, sections)] };
}

function songB(): Song {
  const id = 900002, rev = 1;
  const drumSections = [
    drumSection('Intro', 'bridge', 'intro', 8),
    drumSection('Verse', 'verseB', 'verse', 12),
    drumSection('Chorus', 'chorusB', 'chorus', 8),
    drumSection('Verse', 'verseB', 'verse', 12),
    drumSection('Chorus', 'chorusB', 'chorus', 8),
    drumSection('Solo', 'bridgeB', 'chorus', 16),
    drumSection('Chorus', 'chorusB', 'chorus', 8),
  ];
  const tracks: Track[] = [
    { instrumentId: 4, instrument: 'Electric Piano 1' },
    { instrumentId: 27, instrument: 'Electric Guitar (clean)', name: 'GUITAR 1' },
    { instrumentId: 29, instrument: 'Overdriven Guitar', name: 'GUITAR 2' },
    { instrumentId: 26, instrument: 'Electric Guitar (jazz)', name: 'GUITAR 3' },
    { instrumentId: 17, instrument: 'Percussive Organ' },
    { instrumentId: 33, instrument: 'Electric Bass (finger)', tuning: [43, 38, 33, 28] },
    DRUMS,
    { instrumentId: 24, instrument: 'Acoustic Guitar (nylon)', name: 'PERC EFFECTS' },
  ];
  const parts = tracks.map((t, i) => {
    if (t.isDrums) return partFrom(id, rev, i, t, 120, drumSections);
    // Every pitched track plays a two-bar figure offset by its index, so no two are identical.
    const sections = drumSections.map((s) => ({
      name: s.name,
      bars: s.bars.map((_, b): Bar => Array.from({ length: 8 }, (_x, k) => ((k + i + b) % 3 === 0 ? pitched((k + i) % 5, i % 4) : []))),
    }));
    return partFrom(id, rev, i, t, 120, sections);
  });
  return { meta: metaFor(id, rev, 'Fixture Song B', tracks, 6), parts };
}

/**
 * Seven parts, 135 measures, markers at m1/19/35/51/67/83/99/115. The Intro is 16 sounding bars
 * plus a 2-bar silent tail, the last Chorus is 16 sounding bars plus a 5-bar silent tail, and
 * every other section is exactly 16 bars. Which part sounds where:
 *
 *   Intro    piano (1), second piano (5)
 *   Verse 1  bass (0), piano (1), drums (6)
 *   Chorus   bass (0), pad (2), saw lead (3), drums (6)
 *   Verse 2  bass (0), piano (1), square lead (4), drums (6)
 *   Break    bass (0, quarter notes), pad (2)
 *   Bridge   bass (0), square lead (4), second piano (5), drums (6)
 */
function songC(): Song {
  const id = 900003, rev = 1;
  const tracks: Track[] = [
    { instrumentId: 38, instrument: 'Synth Bass 1', tuning: [43, 38, 33, 28, 23] },
    { instrumentId: 0, instrument: 'Acoustic Grand Piano' },
    { instrumentId: 89, instrument: 'Pad 2 (warm)' },
    { instrumentId: 81, instrument: 'Lead 2 (sawtooth)' },
    { instrumentId: 80, instrument: 'Lead 1 (square)' },
    { instrumentId: 0, instrument: 'Acoustic Grand Piano', name: 'Track 1' },
    DRUMS,
  ];
  const layout: Array<{ name: string; sounding: number; tail: number; who: number[] }> = [
    { name: 'Intro', sounding: 16, tail: 2, who: [1, 5] },
    { name: 'Verse 1', sounding: 16, tail: 0, who: [0, 1, 6] },
    { name: 'Chorus', sounding: 16, tail: 0, who: [0, 2, 3, 6] },
    { name: 'Verse 2', sounding: 16, tail: 0, who: [0, 1, 4, 6] },
    { name: 'Chorus', sounding: 16, tail: 0, who: [0, 2, 3, 6] },
    { name: 'Break', sounding: 16, tail: 0, who: [0, 2] },
    { name: 'Bridge', sounding: 16, tail: 0, who: [0, 4, 5, 6] },
    { name: 'Chorus', sounding: 16, tail: 5, who: [0, 2, 3, 6] },
  ];
  // Per-part bar figures. `b` is the bar's index inside its section.
  const figure = (part: number, section: string, b: number): Bar => {
    const slots = (on: (k: number) => boolean, fret: (k: number) => number, str = 0): Bar =>
      Array.from({ length: 8 }, (_x, k) => (on(k) ? pitched(fret(k), str) : []));
    switch (part) {
      case 0: // bass: 8ths, quarters in the Break
        return section === 'Break' ? slots((k) => k % 2 === 0, () => b % 4) : slots(() => true, (k) => (b % 4) + (k === 7 ? 2 : 0));
      case 1: return slots((k) => k % 2 === 0 || k === 3, (k) => (k + b) % 5, 1); // 5 per bar
      case 2: return slots((k) => k === 0, () => b % 4, 2); // one held chord tone per bar
      case 3: return slots((k) => k !== 1 && k !== 6, (k) => (k * 2 + b) % 7, 0); // 6 per bar
      case 4: return slots((k) => k % 2 === 1, (k) => (k + b) % 6, 1); // 4 per bar
      case 5: return slots((k) => k === 0 || k === 4 || k === 6, (k) => (k + b) % 4, 3); // 3 per bar
      default: return b === 15 ? DRUM_BARS.fill : DRUM_BARS[section.startsWith('Chorus') ? (b % 2 ? 'chorusB' : 'chorus') : (b % 2 ? 'verseB' : 'verse')];
    }
  };
  const parts = tracks.map((t, i) => partFrom(id, rev, i, t, 140, layout.map((sec) => ({
    name: sec.name,
    bars: [
      ...Array.from({ length: sec.sounding }, (_x, b) => (sec.who.includes(i) ? figure(i, sec.name, b) : undefined)),
      ...Array.from({ length: sec.tail }, () => undefined),
    ],
  }))));
  return { meta: metaFor(id, rev, 'Fixture Song C', tracks, 6), parts };
}

const BUILDERS: Record<string, () => Song> = { '900001': songA, '900002': songB, '900003': songC };
const built = new Map<string, Song>();

function song(songId: string): Song {
  const make = BUILDERS[songId];
  if (make === undefined) throw new Error(`songsterr-replay: no generated song ${songId} (have ${Object.keys(BUILDERS).join(', ')})`);
  let s = built.get(songId);
  if (s === undefined) { s = make(); built.set(songId, s); }
  return s;
}

/** URLs for the generated songs, in the shape a user would paste. */
export const FIXTURE_SONG_A_URL = 'https://www.songsterr.com/a/wsa/generated-fixture-song-a-drum-tab-s900001';
export const FIXTURE_SONG_B_ID = '900002';
export const FIXTURE_SONG_C_ID = '900003';

export function installSongsterrReplay(): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const s = String(url instanceof Request ? url.url : url);
    const meta = /songsterr\.com\/api\/meta\/(\d+)/.exec(s);
    if (meta) {
      const body = song(meta[1]).meta;
      return { ok: true, status: 200, json: async () => body };
    }
    const part = /cloudfront\.net\/(\d+)\/(\d+)\/[^/]+\/(\d+)\.json$/.exec(s);
    if (part) {
      const [, songId, rev, partId] = part;
      const sg = song(songId);
      if (String(sg.meta.revisionId) !== rev) throw new Error(`songsterr-replay: song ${songId} asked for revision ${rev}, generated ${String(sg.meta.revisionId)}`);
      const p = sg.parts[Number(partId)];
      if (p === undefined) throw new Error(`songsterr-replay: song ${songId} has no part ${partId}`);
      const bytes = new TextEncoder().encode(JSON.stringify(p));
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
    }
    throw new Error(`songsterr-replay: unrecorded request ${s} (gates never touch the network)`);
  }) as unknown as typeof globalThis.fetch;
  return () => { globalThis.fetch = realFetch; };
}
