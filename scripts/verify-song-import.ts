/**
 * Golden: Songsterr drum flatten + whole-song decomposition (no hardware, no network).
 *
 * Covers the pure core added for the song-import feature:
 *   - flattenSongsterrDrums : measures→voices→beats→notes → DrumEvent[] in
 *     quarter-note beats, with fret→voice mapping, dynamics→accent, signature
 *     carry-forward, and dotted/32nd durations.
 *   - decomposeToPatterns   : whole-song event list → deduped pattern bank +
 *     arrangement order (the scene-chain input).
 *   - arrangementSummary    : order → run-length label string.
 *
 * Run via:  npx tsx scripts/verify-song-import.ts
 */

import {
  flattenSongsterrDrums,
  importSongsterrDrums,
  tempoAtBeat,
  decomposeToPatterns,
  arrangementSummary,
  coalescePatterns,
  gridDistance,
  planArrangement,
  parseSongRef,
  selectDrumTrack,
  type DrumPart,
  type DrumEvent,
  type SongMeta,
} from '../packages/core/src/protocol-generic/patterns/index.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}

// ── flattenSongsterrDrums ──────────────────────────────────────────────
{
  // One 4/4 bar: kick(q), snare(q), kick(q), snare(q) — all quarter notes.
  const q = (fret: number, velocity?: string): DrumPart['measures'][0]['voices'][0]['beats'][0] =>
    ({ notes: [{ fret }], duration: [1, 4], ...(velocity ? { velocity } : {}) });
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [q(36, 'fff'), q(38), q(36), q(38)] }] }],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 120 }] },
  };
  const flat = flattenSongsterrDrums(part);
  check('flatten: 4 events from a 4-quarter bar', flat.events.length === 4, String(flat.events.length));
  check('flatten: onsets at quarter beats 0,1,2,3',
    JSON.stringify(flat.events.map((e) => e.beat)) === '[0,1,2,3]', JSON.stringify(flat.events.map((e) => e.beat)));
  check('flatten: fret 36→kick, 38→snare', flat.events[0].voice === 'kick' && flat.events[1].voice === 'snare',
    `${flat.events[0].voice}/${flat.events[1].voice}`);
  check('flatten: velocity "fff" → accent (sticky to following hits)', flat.events[0].accent === true && flat.events[1].accent === true);
  check('flatten: totalBeats = 4 (one 4/4 bar)', flat.totalBeats === 4, String(flat.totalBeats));
  check('flatten: bpm + signature carried', flat.bpm === 120 && flat.signature[0] === 4 && flat.signature[1] === 4);
}

// ── Percussion remap + honesty (drum_map / unmapped_numbers / ghost / flams) ──
{
  // A tab that hides its clap layer on non-GM number 0 (the Like That case),
  // plus a flam (same fret twice, one ghosted) and a per-note ghost.
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 0, ghost: true }, { fret: 38 }, { fret: 38, ghost: true }], duration: [1, 4] }, // clap layer + snare FLAM
      { notes: [{ fret: 36 }], duration: [1, 4] },
      { notes: [{ fret: 42, ghost: true }], duration: [1, 4] },                                        // ghosted hat
      { notes: [{ fret: 0 }], duration: [1, 4] },                                                       // bare non-GM hit
    ] }] }],
  };
  // Without a map: number 0 is skipped, NAMED with counts; the flam folds to one snare.
  const bare = flattenSongsterrDrums(part);
  check('flatten: non-GM number counted BY NUMBER (0×2)', bare.unmapped === 2 && bare.unmapped_numbers[0] === 2,
    JSON.stringify(bare.unmapped_numbers));
  check('flatten: snare flam folds to ONE event, counted', bare.events.filter((e) => e.voice === 'snare').length === 1 && bare.flams_collapsed === 1,
    JSON.stringify({ snares: bare.events.filter((e) => e.voice === 'snare').length, flams: bare.flams_collapsed }));
  check('flatten: flam keeps the MAIN hit (not ghosted)', bare.events.find((e) => e.voice === 'snare')?.ghost === undefined);
  check('flatten: per-note ghost flag → event.ghost', bare.events.find((e) => e.voice === 'hat')?.ghost === true);
  // With drumMap {0:'clap'}: the layer imports as the clap voice; nothing unmapped.
  const mapped = flattenSongsterrDrums(part, { drumMap: { 0: 'clap' } });
  check('flatten: drumMap 0→"clap" imports the layer (2 clap events, 0 unmapped)',
    mapped.events.filter((e) => e.voice === 'clap').length === 2 && mapped.unmapped === 0,
    JSON.stringify(mapped.events));
  // drumMap can also target a GM NUMBER (0 → 39 = clap through the GM dictionary).
  const viaGm = flattenSongsterrDrums(part, { drumMap: { 0: 39 } });
  check('flatten: drumMap 0→39 (GM number) also lands on clap', viaGm.events.filter((e) => e.voice === 'clap').length === 2);
  // importSongsterrDrums surfaces the numbers in a TRACK-WIDE warning + accepts drumMap.
  const imp = importSongsterrDrums(part, { stepsPerBeat: 4 });
  check('import: warning NAMES the unmapped number with count', imp.warnings.some((w) => /TRACK-WIDE/.test(w) && /0×2/.test(w)),
    JSON.stringify(imp.warnings));
  const impMapped = importSongsterrDrums(part, { stepsPerBeat: 4, drumMap: { 0: 'clap' } });
  check('import: drumMap threads through (clap voice present, no unmapped warning)',
    impMapped.voices.clap !== undefined && !impMapped.warnings.some((w) => /non-GM/.test(w)),
    JSON.stringify(Object.keys(impMapped.voices)));
}

// ── Songsterr extended numbering (decoded from their player, 2026-07-02) ──
{
  // Rim shot (91), half hat (92), crash choke (97), shaker (82): all outside GM
  // but defined by Songsterr's own table — they import WITHOUT a drumMap.
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 91 }], duration: [1, 4] },
      { notes: [{ fret: 92 }], duration: [1, 4] },
      { notes: [{ fret: 97 }], duration: [1, 4] },
      { notes: [{ fret: 82 }], duration: [1, 4] },
    ] }] }],
  };
  const flat = flattenSongsterrDrums(part);
  check('songsterr extensions: 91→snare, 92→hat, 97→crash, 82→maracas, none unmapped',
    JSON.stringify(flat.events.map((e) => e.voice)) === '["snare","hat","crash","maracas"]' && flat.unmapped === 0,
    JSON.stringify({ voices: flat.events.map((e) => e.voice), unmapped: flat.unmapped_numbers }));
  // A caller drumMap overrides the extension table.
  const over = flattenSongsterrDrums(part, { drumMap: { 91: 'perc' } });
  check('songsterr extensions: caller drumMap overrides (91→perc)',
    over.events[0].voice === 'perc', over.events[0].voice);
}

// Dotted / 32nd durations land on the right quarter-beat position.
{
  // dotted-8th (duration [3,16] = 0.75 quarter beats) then a 32nd ([1,32] = 0.125).
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 36 }], duration: [3, 16] },   // pos 0,    advance 0.75
      { notes: [{ fret: 42 }], duration: [1, 32] },   // pos 0.75, advance 0.125
      { notes: [{ fret: 38 }], duration: [1, 32] },   // pos 0.875
    ] }] }],
  };
  const flat = flattenSongsterrDrums(part);
  check('flatten: dotted-8th + 32nd positions (0, 0.75, 0.875)',
    JSON.stringify(flat.events.map((e) => +e.beat.toFixed(3))) === '[0,0.75,0.875]',
    JSON.stringify(flat.events.map((e) => +e.beat.toFixed(3))));
}

// Signature carry-forward: a 2/4 bar after a 4/4 bar without a re-stated signature.
{
  const k = { notes: [{ fret: 36 }], duration: [1, 4] as [number, number] };
  const part: DrumPart = {
    measures: [
      { signature: [4, 4], voices: [{ beats: [k, k, k, k] }] }, // 4 quarter beats
      { voices: [{ beats: [k, k] }] },                          // carries 4/4 → starts at beat 4
    ],
  };
  const flat = flattenSongsterrDrums(part);
  check('flatten: second bar starts at beat 4 (signature carried)',
    flat.events[4].beat === 4, String(flat.events[4]?.beat));
}

// ── Tempo map, measures index, sections, sticky velocity ──────────────
{
  const k = (velocity?: string): DrumPart['measures'][0]['voices'][0]['beats'][0] =>
    ({ notes: [{ fret: 36 }], duration: [1, 4], ...(velocity ? { velocity } : {}) });
  const part: DrumPart = {
    measures: [
      { signature: [4, 4], marker: { text: 'Intro' }, voices: [{ beats: [k('fff'), k(), k(), k()] }] }, // sticky fff
      { voices: [{ beats: [k(), k(), k(), k()] }] },                                                     // still fff across barline
      { marker: { text: 'Bridge' }, voices: [{ beats: [k('pp'), k(), k(), k()] }] },                     // dynamic CHANGES to pp
      { voices: [{ beats: [k(), k(), k(), k()] }] },                                                     // still pp
    ],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 120 }, { measure: 2, position: 0, bpm: 90 }] },
  };
  const flat = flattenSongsterrDrums(part);
  check('measures: 4, startBeats 0/4/8/12', JSON.stringify(flat.measures.map((m) => m.startBeat)) === '[0,4,8,12]', JSON.stringify(flat.measures.map((m) => m.startBeat)));
  check('tempos: two marks at beats 0 and 8', JSON.stringify(flat.tempos.map((t) => [t.beat, t.bpm])) === '[[0,120],[8,90]]', JSON.stringify(flat.tempos));
  check('tempoAtBeat: 120 before m2, 90 from m2', tempoAtBeat(flat, 7.9) === 120 && tempoAtBeat(flat, 8) === 90 && tempoAtBeat(flat, 14) === 90);
  check('measure 2 carries local tempo 90 + marker Bridge', flat.measures[2].bpm === 90 && flat.measures[2].marker === 'Bridge');
  check('sections: Intro@m0, Bridge@m2', JSON.stringify(flat.sections.map((s) => [s.name, s.startBeat])) === '[["Intro",0],["Bridge",8]]', JSON.stringify(flat.sections));
  // sticky velocity: fff carries to all of measure 0 AND across the barline to measure 1
  check('sticky velocity: fff carries through measures 0-1 (8 accented hits)', flat.events.slice(0, 8).every((e) => e.accent === true));
  // dynamic CHANGES to pp at the Bridge → measures 2-3 ghost, not accent
  check('sticky velocity: pp at Bridge → measures 2-3 ghost (not accent)', flat.events.slice(8, 16).every((e) => e.ghost === true && e.accent === undefined));

  // import by section name → window at the Bridge, local tempo 90
  const bySection = importSongsterrDrums(part, { section: 'bridge' });
  check('import section "bridge": window fromBeat 8, beats 8', bySection.window.fromBeat === 8 && bySection.window.beats === 8, JSON.stringify(bySection.window));
  check('import section "bridge": local tempo 90 (not opening 120)', bySection.bpm === 90, String(bySection.bpm));
  // import by displayed measure (1-based): measure 3 = index 2 = beat 8
  const byMeasure = importSongsterrDrums(part, { fromMeasure: 3, toMeasure: 3 });
  check('import fromMeasure 3..3: beats 8..12 (one bar)', byMeasure.window.fromBeat === 8 && byMeasure.window.beats === 4, JSON.stringify(byMeasure.window));
}

// ── decomposeToPatterns + arrangementSummary ──────────────────────────
{
  // 4 windows of 4 beats (16 steps @ 4/beat). W0,W1,W3 identical kick-on-1;
  // W2 distinct (snare on 2). Expect 2 unique, order [0,0,1,0].
  const kickAt = (w: number): DrumEvent => ({ voice: 'kick', beat: w * 4 });
  const snareAt = (w: number): DrumEvent => ({ voice: 'snare', beat: w * 4 + 1 });
  const events: DrumEvent[] = [kickAt(0), kickAt(1), kickAt(2), snareAt(2), kickAt(3)];
  const d = decomposeToPatterns(events, { stepsPerPattern: 16, stepsPerBeat: 4, totalBeats: 16 });
  check('decompose: 4 windows', d.windowCount === 4, String(d.windowCount));
  check('decompose: 2 unique patterns', d.uniquePatternCount === 2, String(d.uniquePatternCount));
  check('decompose: order = [0,0,1,0]', JSON.stringify(d.order) === '[0,0,1,0]', JSON.stringify(d.order));
  check('decompose: window rebased to local beat 0 (kick on step 0)',
    d.patterns[0].voices.kick?.[0].on === true);
  check('arrangement: "A×2 B A"', arrangementSummary(d) === 'A×2 B A', arrangementSummary(d));
}

// Trailing silence becomes a real empty window (gapless arrangement).
{
  const events: DrumEvent[] = [{ voice: 'kick', beat: 0 }]; // content only in window 0
  const d = decomposeToPatterns(events, { stepsPerPattern: 16, stepsPerBeat: 4, totalBeats: 8 }); // 2 windows
  check('decompose: silent trailing window kept', d.windowCount === 2 && d.order.length === 2, JSON.stringify(d.order));
  check('decompose: silent window is its own pattern', d.uniquePatternCount === 2, String(d.uniquePatternCount));
}

// Empty input still yields one (silent) window, never zero.
{
  const d = decomposeToPatterns([], { stepsPerPattern: 32, stepsPerBeat: 4 });
  check('decompose: empty events → 1 window', d.windowCount === 1 && d.uniquePatternCount === 1);
}

// ── gridDistance ──────────────────────────────────────────────────────
{
  // 3 windows: W0 & W1 differ by ONE snare hit (near); W2 is a busy kick (far).
  const events: DrumEvent[] = [
    { voice: 'kick', beat: 0 }, { voice: 'kick', beat: 2 },                         // W0 (beats 0-4)
    { voice: 'kick', beat: 4 }, { voice: 'kick', beat: 6 }, { voice: 'snare', beat: 5 }, // W1 (4-8): +1 snare
    { voice: 'kick', beat: 8 }, { voice: 'kick', beat: 8.5 }, { voice: 'kick', beat: 9 }, { voice: 'kick', beat: 9.5 }, // W2 busy
  ];
  const d = decomposeToPatterns(events, { stepsPerPattern: 16, stepsPerBeat: 4, totalBeats: 12 });
  const dist01 = gridDistance(d.windows[0], d.windows[1]);
  const dist02 = gridDistance(d.windows[2], d.windows[0]);
  check('gridDistance: identical → 0', gridDistance(d.windows[0], d.windows[0]) === 0);
  check('gridDistance: one extra hit is small (= 1/32)', Math.abs(dist01 - 1 / 32) < 1e-9, String(dist01));
  check('gridDistance: a busy bar is far', dist02 > 0.1, String(dist02));

  // ── coalescePatterns ────────────────────────────────────────────────
  const tight = coalescePatterns(d, { maxDistance: 0 });   // onset-exact → 3 clusters
  check('coalesce(0): no merge → 3 patterns', tight.uniquePatternCount === 3, String(tight.uniquePatternCount));

  const loose = coalescePatterns(d, { maxDistance: 0.05 }); // W0,W1 merge → 2 clusters
  check('coalesce(0.05): W0+W1 merge → 2 patterns', loose.uniquePatternCount === 2, String(loose.uniquePatternCount));
  check('coalesce(0.05): order folds to [0,0,1]', JSON.stringify(loose.order) === '[0,0,1]', JSON.stringify(loose.order));
  check('coalesce(0.05): merged cluster spans 2 exact variants', loose.clusters[0].variantCount === 2, String(loose.clusters[0].variantCount));
  check('coalesce(0.05): emits a fold warning', loose.warnings.some((w) => w.includes('folded')));
}

// ── planArrangement ───────────────────────────────────────────────────
{
  const chainable = { patterns: [0, 0, 0].map(() => ({ voices: {}, steps: 16, warnings: [] })), order: [0, 1, 2] };
  const p1 = planArrangement(chainable, { maxPatterns: 8, barsPerWindow: 2 });
  check('plan: each-once-in-order → fitsViaChainOnly', p1.fitsViaChainOnly === true);
  check('plan: 3 scenes for [0,1,2]', p1.sceneCount === 3, String(p1.sceneCount));

  const reused = { patterns: [0, 0].map(() => ({ voices: {}, steps: 16, warnings: [] })), order: [0, 0, 1, 0] };
  const p2 = planArrangement(reused, { maxPatterns: 8, barsPerWindow: 2 });
  check('plan: reused-out-of-order → NOT chain-only', p2.fitsViaChainOnly === false);
  check('plan: scene-chain run-length [A×2,B,A] = 3 steps', p2.sceneCount === 3, String(p2.sceneCount));
  check('plan: first scene holds 2 windows = 4 bars', p2.scenes[0].windows === 2 && p2.scenes[0].bars === 4);
  check('plan: bank of 2 fits 8 slots', p2.fitsInPatternSlots === true);

  const over = { patterns: Array.from({ length: 12 }, () => ({ voices: {}, steps: 16, warnings: [] })), order: Array.from({ length: 12 }, (_, i) => i) };
  const p3 = planArrangement(over, { maxPatterns: 8 });
  check('plan: 12 patterns exceed 8 slots', p3.fitsInPatternSlots === false && p3.notes.some((n) => n.includes('exceeds')));
}

// ── parseSongRef + selectDrumTrack (the import_songsterr resolution logic) ──
{
  check('parseSongRef: full URL with t-selector', JSON.stringify(parseSongRef('https://www.songsterr.com/a/wsa/sleep-token-gethsemane-drum-tab-s1467797t11')) === '{"songId":1467797,"trackId":11}');
  check('parseSongRef: URL without t', JSON.stringify(parseSongRef('…-s23527')) === '{"songId":23527}');
  check('parseSongRef: bare id', parseSongRef('23527').songId === 23527 && parseSongRef('23527').trackId === undefined);
  check('parseSongRef: bare id with track', JSON.stringify(parseSongRef('1467797t11')) === '{"songId":1467797,"trackId":11}');
  let threw = false; try { parseSongRef('not-a-song'); } catch { threw = true; }
  check('parseSongRef: junk throws', threw);

  // Two drum tracks (the Gethsemane shape): index 10 "II", index 11 "Programmed Drums", popular = 10.
  const meta: SongMeta = {
    songId: 1, revisionId: 1, image: 'x', title: 'T', artist: 'A', popularTrackDrum: 10,
    tracks: [
      ...Array.from({ length: 10 }, () => ({ instrumentId: 27, instrument: 'Guitar', hash: 'g' })),
      { instrumentId: 1024, instrument: 'Drums', name: 'II', hash: 'd1', views: 6514 },
      { instrumentId: 1024, instrument: 'Drums', name: 'Programmed Drums', hash: 'd2', views: 480 },
    ],
  };
  check('selectDrumTrack: t-selector wins (11)', selectDrumTrack(meta, { trackId: 11 }).partId === 11);
  check('selectDrumTrack: track index override', selectDrumTrack(meta, { track: 10 }).partId === 10);
  check('selectDrumTrack: by name "programmed" → 11', selectDrumTrack(meta, { trackName: 'programmed' }).partId === 11);
  const def = selectDrumTrack(meta, {});
  check('selectDrumTrack: default = popularTrackDrum (10), flagged ambiguous', def.partId === 10 && def.ambiguous === true);
  check('selectDrumTrack: lists both choices', def.choices.length === 2 && def.choices[1].name === 'Programmed Drums');
}

if (failed > 0) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll song-import golden checks passed.');
