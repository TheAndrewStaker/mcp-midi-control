/**
 * Golden: `buildSectionsFromSpec` (songSectionSpec.ts), the section-table + routing builder every
 * explicit song map now runs on. No hardware, no network: small synthetic parts for the rules, and
 * two whole-song maps over the invented songs of `scripts/syntheticSong.ts`.
 *
 *  - windowing: a stored window splits into 2-bar patterns whose step counts come from the SOURCE,
 *    so an odd bar or a short-metre bar is never padded to an assumed 16 steps;
 *  - drum union across parts (kit + overdub), accents carried;
 *  - silence carried as one all-rest lane, and reported;
 *  - per-row `voices` and `borrow`;
 *  - every refusal (name cap, name collision, duplicate slot, window past the song, unknown route,
 *    two routes on one track in one row);
 *  - MAP 1, Test Song B: split toms, a borrowed chorus bass, a sustained pad restricted by `voices`,
 *    and a section ending on a 1/4 bar (a 4-step pattern, never an assumed 16); frozen;
 *  - MAP 2, Test Song C: a cymbal overdub unioned into the kit, a silent two-bar stop, the name
 *    cap, and the bend-rendered lead checked; frozen.
 *
 * Run via:  npx tsx scripts/verify-song-section-spec.ts
 */
import { createHash } from 'node:crypto';
import {
  testSongB, testSongC, TEST_SONG_B_CHORUS_BASS_FROM, TEST_SONG_B_PART, TEST_SONG_C_GESTURE_NOTATION, TEST_SONG_C_PART,
} from './syntheticSong.js';
import {
  buildSectionsFromSpec,
  buildStompMap,
  formatStompMap,
  buildProjectOps,
  SectionSpecError,
  type SongsterrPart,
  type SectionSpecRow,
  type SongRouting,
  type PoolItem,
  type SongRecipe,
} from '../packages/core/src/protocol-generic/patterns/index.js';
import { adaptOps } from '../packages/circuit-tracks/src/authorAdapter.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}
function refuses(label: string, fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (e) {
    check(label, e instanceof SectionSpecError && pattern.test((e as Error).message), (e as Error).message);
  }
}

// ── synthetic parts ────────────────────────────────────────────────────────
type Beat = SongsterrPart['measures'][0]['voices'][0]['beats'][0];
const rest = (d: [number, number] = [1, 1]): Beat => ({ duration: d, rest: true, notes: [{ rest: true }] } as Beat);
const drumBar = (hits: number[][]): SongsterrPart['measures'][0] => ({
  signature: [4, 4],
  voices: [{ beats: hits.map((frets) => (frets.length === 0 ? rest([1, 4]) : { duration: [1, 4], notes: frets.map((f) => ({ fret: f, string: 0 })) } as Beat)) }],
} as SongsterrPart['measures'][0]);
const drums = (bars: SongsterrPart['measures']): SongsterrPart => ({ measures: bars } as SongsterrPart);
const melodicBar = (fret: number | undefined): SongsterrPart['measures'][0] => ({
  signature: [4, 4],
  voices: [{ beats: [fret === undefined ? rest() : { duration: [1, 1], notes: [{ fret, string: 0 }] } as Beat] }],
} as SongsterrPart['measures'][0]);
const melodic = (frets: (number | undefined)[]): SongsterrPart => ({ tuning: [40], measures: frets.map(melodicBar) } as unknown as SongsterrPart);

const KIT = drums([
  drumBar([[36], [38], [36], [38]]),
  drumBar([[36], [38], [36], [38]]),
  drumBar([[], [], [], []]),          // bar 3: silent (a stop)
  drumBar([[36], [], [], []]),
  drumBar([[36], [38], [36], [38]]),
]);
const OVERDUB = drums([
  drumBar([[49], [], [], []]),
  drumBar([[], [], [], []]),
  drumBar([[], [], [], []]),
  drumBar([[], [], [], []]),
  drumBar([[], [], [], []]),
]);
const BASS = melodic([0, 2, undefined, 5, 7]);
const LEAD = melodic([12, undefined, undefined, 14, 16]);
const LAYOUT = { layout: 'internal-condense' as const, levels: { drum1: 100 } };
const routing: SongRouting = {
  drums: [KIT, OVERDUB],
  melodic: [
    { key: 'bass', part: BASS, target: { track: 'synth1' } },
    { key: 'lead', part: LEAD, target: { track: 'midi1' } },
  ],
  drumLayout: LAYOUT,
};

{
  const rows: SectionSpecRow[] = [
    { name: 'A', stored: 'Song A', slot: 1, from: 1, to: 5 },
    { name: 'B', stored: 'Song B', slot: 2, from: 4, to: 5, voices: ['bass'], borrow: { bass: 1 } },
  ];
  const { sections, report } = buildSectionsFromSpec(rows, routing);
  const a = sections[0];
  check('windowing: a 5-bar window is 3 patterns (2 + 2 + 1 bars)', a.patterns.length === 3, String(a.patterns.length));
  check('windowing: step counts come from the source (32, 32, 16), never an assumed full pattern',
    a.patterns.map((p) => p.steps).join(',') === '32,32,16', a.patterns.map((p) => p.steps).join(','));
  check('drum union: the overdub crash lands in the same pattern as the kit (kick + snare + crash)',
    a.patterns[0].drumVoices.crash?.startsWith('x') === true && a.patterns[0].drumVoices.kick !== undefined,
    JSON.stringify(a.patterns[0].drumVoices));
  check('routing: each melodic voice lands on its own track',
    a.patterns[0].melodic?.bass?.target.track === 'synth1' && a.patterns[0].melodic?.lead?.target.track === 'midi1');
  check('silence: bar 3 has a kick hit in bar 4, so pattern 2 is NOT silent; no silent pattern reported',
    report[0].silentPatterns.length === 0, JSON.stringify(report[0].silentPatterns));
  check('voices: a row restricted to ["bass"] carries no lead', sections[1].patterns.every((p) => p.melodic?.lead === undefined));
  check('borrow: row B reads its bass from m1-2 (e2, f#2 = the song\'s own m1-2), not m4-5',
    /^e2:/.test(sections[1].patterns[0].melodic?.bass?.steps ?? '') && /f#2/.test(sections[1].patterns[0].melodic?.bass?.steps ?? ''),
    sections[1].patterns[0].melodic?.bass?.steps);
  check('report: the default pattern name is the section name plus a letter', a.patterns.map((p) => p.name).join(',') === 'AA,AB,AC');
  check('report: a chain past 2 patterns is flagged for an on-load ear check', report[0].longChain && !report[1].longChain);

  // A fully silent window becomes one all-rest lane, and says so.
  const silentOnly: SongRouting = { ...routing, drums: [drums([drumBar([[], [], [], []])])], melodic: [{ key: 'bass', part: melodic([undefined]), target: { track: 'synth1' } }] };
  const s = buildSectionsFromSpec([{ name: 'Stop', stored: 'Stop', slot: 9, from: 1, to: 1 }], silentOnly);
  check('silence: a window with no voice at all is one all-rest kick lane of the source\'s own length',
    s.sections[0].patterns[0].drumVoices.kick === '.'.repeat(16) && Object.keys(s.sections[0].patterns[0].drumVoices).length === 1,
    JSON.stringify(s.sections[0].patterns[0]));
  check('silence: and the report names it', s.report[0].silentPatterns.join(',') === '1');

  // Shared track across rows is fine; in the same row it is refused.
  const shared: SongRouting = { ...routing, melodic: [...routing.melodic, { key: 'lead2', part: LEAD, target: { track: 'midi1' } }] };
  const ok = buildSectionsFromSpec([
    { name: 'X', stored: 'X', slot: 1, from: 1, to: 2, voices: ['bass', 'lead'] },
    { name: 'Y', stored: 'Y', slot: 2, from: 1, to: 2, voices: ['bass', 'lead2'] },
  ], shared);
  check('routing: two routes MAY share a track in different sections (one synth, two source parts)', ok.sections.length === 2);
  refuses('refuses: two routes on the same track in ONE row',
    () => buildSectionsFromSpec([{ name: 'Z', stored: 'Z', slot: 1, from: 1, to: 2 }], shared), /both play on midi1/);
  refuses('refuses: a stored name over the device cap',
    () => buildSectionsFromSpec([{ name: 'A', stored: 'Seventeen chars!!', slot: 1, from: 1, to: 1 }], routing, { nameMax: 16 }), /over 16 characters/);
  refuses('refuses: two sections stored under the same name',
    () => buildSectionsFromSpec([
      { name: 'A', stored: 'Same', slot: 1, from: 1, to: 1 },
      { name: 'B', stored: 'Same', slot: 2, from: 2, to: 2 },
    ], routing, { nameMax: 16 }), /both be stored as "Same"/);
  refuses('refuses: two sections in one slot',
    () => buildSectionsFromSpec([
      { name: 'A', stored: 'A', slot: 1, from: 1, to: 1 },
      { name: 'B', stored: 'B', slot: 1, from: 2, to: 2 },
    ], routing), /both claim slot 1/);
  refuses('refuses: a window past the last measure',
    () => buildSectionsFromSpec([{ name: 'A', stored: 'A', slot: 1, from: 4, to: 9 }], routing), /past the song's last measure/);
  refuses('refuses: a backwards window',
    () => buildSectionsFromSpec([{ name: 'A', stored: 'A', slot: 1, from: 3, to: 2 }], routing), /not a forward range/);
  refuses('refuses: a row naming a route the routing does not define',
    () => buildSectionsFromSpec([{ name: 'A', stored: 'A', slot: 1, from: 1, to: 1, voices: ['pad'] }], routing), /route "pad"/);
  refuses('refuses: a borrowed window outside the song',
    () => buildSectionsFromSpec([{ name: 'A', stored: 'A', slot: 1, from: 1, to: 2, borrow: { bass: 5 } }], routing), /outside the song/);
}

// ── The STOMP MAP: what one "next part" footswitch has to send ─────────────
{
  const rows = (slots: number[]): SectionSpecRow[] =>
    slots.map((slot, i) => ({ name: `S${i}`, stored: `S${i}`, slot, from: i + 1, to: i + 1 }));
  const walk = buildStompMap(rows([31, 32, 33]));
  check('stomp map: project N is queued PC 63+N and instant PC N-1 (Novation\'s own 64..127 = queued)',
    walk.steps.map((s) => `${s.slot}:${s.pcQueued}/${s.pcInstant}`).join(' ') === '31:94/30 32:95/31 33:96/32',
    JSON.stringify(walk.steps));
  check('stomp map: consecutive slots in performance order = one pedal walks the song, presses = parts - 1',
    walk.monotonic && walk.presses === 2 && walk.note === undefined, JSON.stringify(walk));
  const revisit = buildStompMap(rows([31, 32, 31, 33]));
  check('stomp map: a REVISITED part (a slot that steps backwards) is flagged, not silently walked',
    !revisit.monotonic && /absolute PC/.test(revisit.note ?? ''), JSON.stringify(revisit.note));
  check('stomp map: a GAP in the slots is flagged too (a bare "next" pedal would land on a stranger)',
    !buildStompMap(rows([31, 33])).monotonic);
  check('stomp map: the rendered lines name the press, the project and the PC',
    /press\s+1\s+P32.*PC 95 queued/.test(formatStompMap(walk)) && /one "next project" pedal/.test(formatStompMap(walk)),
    formatStompMap(walk));
}

// ── WHOLE-SONG MAPS (the invented songs of scripts/syntheticSong.ts) ────────
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ROLE = ['kick', 'snare', 'closed_hat', 'ride', 'open_hat', 'busy_hat', 'snare_roll', 'crash', 'tom', 'ride_bell', 'sticks', 'china', 'perc'];
const LEVELS = { drum1: 100, drum2: 100, drum3: 100, drum4: 100, synth1: 0, synth2: 0 };

// MAP 1, Test Song B: a kit with split toms, a bass, a pad; a borrowed chorus bass; a one-shot
// breakdown whose last bar is 1/4.
{
  const song = testSongB();
  const W = ['bass', 'pad'], N = ['bass'], C = { bass: TEST_SONG_B_CHORUS_BASS_FROM };
  const rows: SectionSpecRow[] = [
    { name: 'Intro', stored: 'SongB Intro', slot: 7, from: 1, to: 4, voices: W },
    { name: 'Verse 1', stored: 'SongB Verse 1', slot: 8, from: 5, to: 12, voices: W },
    { name: 'Chorus A', stored: 'SongB Chorus A', slot: 9, from: 13, to: 16, voices: N },
    { name: 'Verse 2', stored: 'SongB Verse 2', slot: 10, from: 17, to: 24, voices: N },
    { name: 'Chorus B', stored: 'SongB Chorus B', slot: 11, from: 25, to: 28, voices: W },
    { name: 'Breakdown', stored: 'SongB Breakdown', slot: 12, from: 29, to: 33, voices: N, playback: 'one-shot' },
    { name: 'Chorus C', stored: 'SongB Chorus C', slot: 13, from: 34, to: 37, voices: N },
    { name: 'Outro', stored: 'SongB Outro', slot: 14, from: 38, to: 41, voices: W, borrow: C },
  ];
  const r: SongRouting = {
    drums: [song[TEST_SONG_B_PART.drums].part],
    drumImport: { splitToms: true },
    melodic: [
      { key: 'bass', part: song[TEST_SONG_B_PART.bass].part, target: { track: 'synth1' } },
      { key: 'pad', part: song[TEST_SONG_B_PART.pad].part, target: { track: 'midi1' }, import: { sustainRepeats: true } },
    ],
    drumLayout: { layout: 'internal-condense', levels: LEVELS },
  };
  const { sections } = buildSectionsFromSpec(rows, r, { patternName: (row, i) => `${row.name.replace(/\s+/g, '')}${String.fromCharCode(65 + i)}` });
  const pool: PoolItem[] = [...ROLE, 'tom_hi', 'tom_mid', 'tom_lo'].map((name, i) => ({ name, wireSlot: i, source: 'kit' as const }));
  const recipe: SongRecipe = { globals: { pack: 3, template: 'samples/circuit-tracks/blank_slot20.ncs', tempo: 140, colour: 'Cyan', soundingPitch: true }, pool, sections, clearSlots: [] };
  const calls = adaptOps(buildProjectOps(recipe), { pool, port: 'circuit' });
  const bySlot = (slot: number) => sections.find((s) => s.slot === slot)!;
  check('Test Song B: 8 projects, 21 patterns (4-bar sections 2, 8-bar verses 4, the 5-bar breakdown 3)',
    sections.length === 8 && sections.map((s) => s.patterns.length).join(',') === '2,4,2,4,2,3,2,2', sections.map((s) => s.patterns.length).join(','));
  const bd = bySlot(12);
  check('Test Song B: m33 is a 1/4 bar, so the Breakdown\'s last pattern is 4 steps of silence, not 16',
    bd.patterns.length === 3 && bd.patterns[2].steps === 4 && bd.patterns[2].drumVoices.kick === '....'
    && Object.keys(bd.patterns[2].drumVoices).length === 1 && bd.patterns[2].melodic === undefined,
    JSON.stringify(bd.patterns[2]));
  check('Test Song B: splitToms reaches the flattener (split tom lanes, no single `tom`)',
    calls.some((c) => JSON.stringify(c.args).includes('"tom_flo"')) && calls.some((c) => JSON.stringify(c.args).includes('"tom_lo"'))
    && !calls.some((c) => JSON.stringify(c.args).includes('"tom":')));
  check('Test Song B: the Outro plays the borrowed chorus bass (Chorus A\'s row), and it is not the Outro\'s own',
    bySlot(14).patterns[0].melodic?.bass?.steps === bySlot(9).patterns[0].melodic?.bass?.steps
    && buildSectionsFromSpec(rows.map(({ borrow: _b, ...row }) => row), r).sections.find((s) => s.slot === 14)!.patterns[0].melodic?.bass?.steps
      !== bySlot(14).patterns[0].melodic?.bass?.steps);
  check('Test Song B: `voices` keeps the pad out of Verse 2 (the tab has it there) and in Verse 1',
    bySlot(10).patterns.every((p) => p.melodic?.pad === undefined) && bySlot(8).patterns.every((p) => p.melodic?.pad !== undefined));
  check('Test Song B: sustainRepeats holds the pad (one 16-step note per bar, not eight eighths)',
    bySlot(8).patterns[0].melodic?.pad?.steps === ['b4:16', ...new Array<string>(15).fill('~'), 'a4:16', ...new Array<string>(15).fill('~')].join(' '),
    bySlot(8).patterns[0].melodic?.pad?.steps);
  // Frozen once the checks above had been read against the song. Re-freeze only for a deliberate
  // change to the builder, the adapter or the invented song.
  const FROZEN_SONG_B = '705c1fc2ea5998f417fb9fd3a804ec1ee1a1827c02a46bdb5e2d24d9da1c9c12';
  const got = digest(calls);
  check(`Test Song B: the 8 authored calls match the frozen golden (${got.slice(0, 12)})`, calls.length === 8 && got === FROZEN_SONG_B, got);
}

// MAP 2, Test Song C: a kit plus a cymbal overdub, a bass, and a lead in octaves rendered through
// the pitch-gesture path; a silent stop; the 16-character stored-name cap.
{
  const song = testSongC();
  const S = 31;
  const rows: SectionSpecRow[] = ([
    ['Band Intro', 'SongC Intro', 3, 10], ['Main Riff', 'SongC MainRiff', 11, 26], ['Verse', 'SongC Verse', 27, 30],
    ['Pre-Chorus', 'SongC PreChorus', 31, 38], ['Chorus', 'SongC Chorus', 39, 42],
  ] as [string, string, number, number][]).map(([name, stored, from, to], i) => ({ name, stored, slot: S + i, from, to }));
  const routing = (drums: SongsterrPart[]): SongRouting => ({
    drums,
    melodic: [
      { key: 'bass', part: song[TEST_SONG_C_PART.bass].part, target: { track: 'synth1' } },
      { key: 'lead', part: song[TEST_SONG_C_PART.lead].part, target: { track: 'midi1' }, import: { monoVoice: 1, pitchGestures: 'glide', slideSemitones: 2 } },
    ],
    drumLayout: { layout: 'internal-condense', levels: LEVELS },
  });
  const kit = song[TEST_SONG_C_PART.kit].part;
  const r = routing([kit, song[TEST_SONG_C_PART.cymbals].part]);
  const { sections, report } = buildSectionsFromSpec(rows, r, { nameMax: 16 });
  const pool: PoolItem[] = ROLE.map((name, i) => ({ name, wireSlot: i, source: 'kit' as const }));
  const recipe: SongRecipe = { globals: { pack: 3, template: 'samples/circuit-tracks/blank_slot20.ncs', tempo: 150, colour: 'Red', soundingPitch: true }, pool, sections, clearSlots: [] };
  const calls = adaptOps(buildProjectOps(recipe), { pool, port: 'circuit' });
  check('Test Song C: 5 projects, 20 patterns', sections.length === 5 && sections.reduce((a, s) => a + s.patterns.length, 0) === 20,
    sections.map((s) => s.patterns.length).join(','));
  const riff = sections.find((s) => s.slot === S + 1)!;
  check('Test Song C: the lead enters at the Main Riff\'s 9th bar (pattern 5), not before',
    riff.patterns.length === 8 && riff.patterns.slice(0, 4).every((p) => p.melodic?.lead === undefined) && riff.patterns[4].melodic?.lead?.target.track === 'midi1');
  check('Test Song C: the lead\'s first pattern is the rendered scoop / fall + bend staircase line',
    riff.patterns[4].melodic?.lead?.steps.replace(/@90/g, '') === TEST_SONG_C_GESTURE_NOTATION,
    riff.patterns[4].melodic?.lead?.steps);
  const pre = sections.find((s) => s.slot === S + 3)!;
  check('Test Song C: the Pre-Chorus plays the same lead phrase as the Main Riff\'s second half',
    pre.patterns.length === 4 && pre.patterns.every((p) => p.melodic?.lead !== undefined)
    && pre.patterns.map((p) => p.melodic?.lead?.steps).join('|') === riff.patterns.slice(4).map((p) => p.melodic?.lead?.steps).join('|'));
  check('Test Song C: the cymbal overdub part is unioned into the Main Riff drums (the kit alone has no crash)',
    riff.patterns[0].drumVoices.crash === `x${'.'.repeat(31)}` && riff.patterns[1].drumVoices.crash === undefined
    && buildSectionsFromSpec(rows, routing([kit])).sections.every((s) => s.patterns.every((p) => p.drumVoices.crash === undefined)),
    JSON.stringify(riff.patterns[0].drumVoices));
  check('Test Song C: the union leaves the kit\'s own lanes as they were',
    riff.patterns[0].drumVoices.kick === buildSectionsFromSpec(rows, routing([kit])).sections.find((s) => s.slot === S + 1)!.patterns[0].drumVoices.kick);
  check('Test Song C: Band Intro ends on the silent two-bar stop (pattern 4), carried as one all-rest lane',
    report[0].silentPatterns.join(',') === '4' && JSON.stringify(sections[0].patterns[3].drumVoices) === `{"kick":"${'.'.repeat(32)}"}`
    && report.slice(1).every((x) => x.silentPatterns.length === 0));
  check('Test Song C: a stored name over the 16-character cap refuses the build',
    (() => { try { buildSectionsFromSpec(rows.map((row, i) => (i === 3 ? { ...row, stored: 'SongC Pre-Chorus One' } : row)), r, { nameMax: 16 }); return false; } catch (e) { return e instanceof SectionSpecError; } })());
  // Frozen once the checks above had been read against the song. Re-freeze only for a deliberate
  // change to the builder, the adapter or the invented song.
  const FROZEN_SONG_C = '7962343056974732d98baa5eed464620e6567206a0e4b5efa9165fa66eccff93';
  const got = digest(calls);
  check(`Test Song C: the 5 authored calls match the frozen golden (${got.slice(0, 12)})`, calls.length === 5 && got === FROZEN_SONG_C, got);
}

if (failed > 0) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll song-section-spec golden checks passed.');
