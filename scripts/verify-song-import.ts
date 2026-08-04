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
 *   - trackChoices          : the FULL part roster (the "not drum-only" guard).
 *   - flattenSongsterrMelodic / importSongsterrMelodic : the PITCHED reading,
 *     `pitch = tuning[string] + fret` → a mini-notation row, with ties folded
 *     into note length, chords as `+`-joined tokens, and every lossy case
 *     (off-grid snap, step merge, unresolved string, dropped grace) counted.
 *     Its fixtures are VERBATIM measures of Mr.Kitty "After Dark" (song 501859
 *     revision 4102120), so they are real-source goldens run offline.
 *   - executeImportSongsterr: the `import_songsterr` modes, driven against a
 *     STUBBED `fetch` so the tool surface is covered offline.
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
  layerDistance,
  planArrangement,
  parseSongRef,
  selectDrumTrack,
  trackChoices,
  fetchSongsterrPart,
  fetchSongsterrDrums,
  unmappedSummary,
  SONGSTERR_DRUM_EXTENSIONS,
  type DrumPart,
  type DrumEvent,
  type SongMeta,
} from '../packages/core/src/protocol-generic/patterns/index.js';
// Imported from their own modules rather than the barrel: the two velocity
// constants and the whole melodic path are new and the barrel is being edited
// elsewhere. Re-export them from `patterns/index.ts` and switch these to the
// barrel when convenient.
import {
  SONGSTERR_DYNAMIC_VELOCITY,
  flattenSongsterrMelodic,
  importSongsterrMelodic,
  isMelodicPart,
  pitchToken,
  layoutMelodicRow,
  renderMelodicRow,
  MAX_GATE_STEPS,
  type SongsterrPart,
  type MelodicCell,
} from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import {
  SONGSTERR_FIELDS,
  SONGSTERR_SLIDE_KINDS,
} from '../packages/core/src/protocol-generic/patterns/songsterrArticulation.js';
import {
  planSongChop,
  packPatternsOnBarLines,
  toChopPart,
  MAX_PROJECT_STEPS,
  type ChopPartFlat,
} from '../packages/core/src/protocol-generic/patterns/songChop.js';
import type { MeasureInfo } from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { GATE_SIXTHS_PER_STEP } from '../packages/core/src/protocol-generic/patterns/types.js';
import { parsePitch, parseVoice } from '../packages/core/src/protocol-generic/patterns/miniNotation.js';
import { GHOST_HIT_VELOCITY } from '../packages/core/src/protocol-generic/patterns/drumScore.js';
import { executeImportSongsterr } from '../packages/core/src/protocol-generic/dispatcher/songsterr.js';

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

// ── layered window identity (the multi-part dedup re-key, 2026-07-29) ────
// The Amber rebuild plan found the whole-song dedup keyed windows BY DRUM
// CONTENT ALONE: two windows with identical drums but DIFFERENT melodic/synth
// layers merged as "the same section" (Amber survived only because its pad
// alternated in lockstep with the drums). These pin the fix: identity is the
// UNION of all layers, the fuzz threshold holds on EVERY layer, and a
// layer-less call is byte-identical to the historical behaviour.
{
  // Two windows (16 steps @ 4/beat), IDENTICAL drums: kick on beats 1 and 3.
  const kick2 = (w: number): DrumEvent[] => [{ voice: 'kick', beat: w * 4 }, { voice: 'kick', beat: w * 4 + 2 }];
  const events: DrumEvent[] = [...kick2(0), ...kick2(1)];
  const opts = { stepsPerPattern: 16, stepsPerBeat: 4, totalBeats: 8 } as const;

  // (a) drum-identical + synth-DIFFERENT windows do NOT merge.
  const differs = [{ label: 'Pad', onsets: [{ beat: 0, token: '52:8' }, { beat: 4, token: '55:8' }] }];
  const dA = decomposeToPatterns(events, { ...opts, layers: differs });
  check('layers: drum-identical windows with DIFFERENT synth cells stay distinct',
    dA.uniquePatternCount === 2 && JSON.stringify(dA.order) === '[0,1]',
    JSON.stringify({ unique: dA.uniquePatternCount, order: dA.order }));
  check('layers: the decomposition carries the layer cells for the receipt',
    dA.layers?.length === 1 && dA.layers[0].label === 'Pad' && dA.layers[0].cells.length === 2,
    JSON.stringify(dA.layers));

  // Same pitch, DIFFERENT GATE only: still distinct (held length is identity).
  const gateOnly = [{ label: 'Pad', onsets: [{ beat: 0, token: '52:8' }, { beat: 4, token: '52:2' }] }];
  const dG = decomposeToPatterns(events, { ...opts, layers: gateOnly });
  check('layers: a gate-length-only difference is still a different window', dG.uniquePatternCount === 2, String(dG.uniquePatternCount));

  // (b) all-layer-identical windows still merge.
  const same = [{ label: 'Pad', onsets: [{ beat: 0, token: '52:8' }, { beat: 4, token: '52:8' }] }];
  const dB = decomposeToPatterns(events, { ...opts, layers: same });
  check('layers: windows identical on EVERY layer still dedupe',
    dB.uniquePatternCount === 1 && JSON.stringify(dB.order) === '[0,0]',
    JSON.stringify({ unique: dB.uniquePatternCount, order: dB.order }));

  // (c) no layers / empty layers = the historical behaviour, byte for byte.
  const plain = decomposeToPatterns(events, opts);
  const empty = decomposeToPatterns(events, { ...opts, layers: [] });
  check('layers: drum-only keying merges as before (regression)', plain.uniquePatternCount === 1, String(plain.uniquePatternCount));
  check('layers: an EMPTY layer list is byte-identical to the drum-only decomposition',
    JSON.stringify(plain) === JSON.stringify(empty));

  // (d) the fuzz near-merge respects the WEAKEST layer.
  check('layerDistance: identical rows → 0', layerDistance(['52', '', ''], ['52', '', '']) === 0);
  check('layerDistance: one differing step of 16 → 1/16', Math.abs(layerDistance(Array(16).fill(''), ['52', ...Array(15).fill('')]) - 1 / 16) < 1e-9);

  // Drums identical everywhere; pad differs by 1 step (near, 1/16 = 0.0625) in
  // W1 and by 4 steps (far, 0.25) in W2. At fuzz 0.10 only W1 folds into W0.
  const events3: DrumEvent[] = [...kick2(0), ...kick2(1), ...kick2(2)];
  const fuzzLayers = [{
    label: 'Synth', onsets: [
      { beat: 0, token: '52:4' },                                     // W0
      { beat: 4, token: '52:4' }, { beat: 6, token: '55:4' },         // W1: +1 cell
      { beat: 9, token: '60:4' }, { beat: 10, token: '60:4' }, { beat: 10.5, token: '60:4' }, { beat: 11, token: '60:4' }, // W2: 4 cells moved
    ],
  }];
  const d3 = decomposeToPatterns(events3, { stepsPerPattern: 16, stepsPerBeat: 4, totalBeats: 12, layers: fuzzLayers });
  check('layers: exact dedup keeps all 3 windows distinct', d3.uniquePatternCount === 3, String(d3.uniquePatternCount));
  const co3 = coalescePatterns(d3, { maxDistance: 0.10 });
  check('layers: fuzz folds the NEAR synth variant (1 cell) into the seed',
    co3.uniquePatternCount === 2 && JSON.stringify(co3.order) === '[0,0,1]',
    JSON.stringify({ unique: co3.uniquePatternCount, order: co3.order }));
  check('layers: the fold receipt NAMES the layers compared',
    co3.warnings.some((w) => w.includes('EVERY layer') && w.includes('Synth')), JSON.stringify(co3.warnings));

  // Drums-only would merge W0+W2 (drum distance 0); the far synth layer vetoes it.
  const coPlain = coalescePatterns(decomposeToPatterns(events3, { stepsPerPattern: 16, stepsPerBeat: 4, totalBeats: 12 }), { maxDistance: 0.10 });
  check('layers: WITHOUT layers the same three windows fold to one (the defect this fix closes)',
    coPlain.uniquePatternCount === 1, String(coPlain.uniquePatternCount));
  check('layers: the weakest layer VETOES a drums-only merge (W2 stays out)',
    co3.order[2] !== co3.order[0]);
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

// ── trackChoices + the any-part surface (the "not drum-only" guard) ──────
// The regression these lock down: a roster that showed only drum parts, plus a
// resolver that threw "no drum track" before honoring an explicit selector, made
// the import path read as drum-only when the fetch was always instrument-agnostic.
{
  const meta: SongMeta = {
    songId: 2, revisionId: 1, image: 'x', title: 'Melodic', artist: 'A', popularTrackDrum: 3,
    tracks: [
      { instrumentId: 34, instrument: 'Electric Bass (finger)', hash: 'b' },
      { instrumentId: 30, instrument: 'Overdriven Guitar', name: 'Rhythm', hash: 'g' },
      { instrumentId: 19, instrument: 'Church Organ', hash: 'o', isEmpty: true },
      { instrumentId: 1024, instrument: 'Drums', name: 'Live Kit', hash: 'd' },
    ],
  };
  const all = trackChoices(meta);
  check('trackChoices: lists EVERY part, not just drums', all.length === 4, String(all.length));
  check('trackChoices: partId is the meta-track index', JSON.stringify(all.map((t) => t.partId)) === '[0,1,2,3]');
  check('trackChoices: isDrums flags only the drum part',
    JSON.stringify(all.map((t) => t.isDrums)) === '[false,false,false,true]');
  check('trackChoices: carries the instrument name for a melodic part', all[0].instrument === 'Electric Bass (finger)');
  check('trackChoices: isEmpty only when the source says so',
    all[2].isEmpty === true && all[0].isEmpty === undefined);

  // A song with NO drum track at all: an explicit selector must still resolve,
  // because the fetch does not care what instrument a part is.
  const noDrums: SongMeta = { ...meta, popularTrackDrum: undefined, tracks: meta.tracks.slice(0, 3) };
  check('selectDrumTrack: explicit track resolves on a song with no drum part',
    selectDrumTrack(noDrums, { track: 1 }).partId === 1);
  check('selectDrumTrack: URL t-selector resolves on a song with no drum part',
    selectDrumTrack(noDrums, { trackId: 0 }).partId === 0);
  let threw = false;
  try { selectDrumTrack(noDrums, {}); } catch { threw = true; }
  check('selectDrumTrack: the DEFAULT path still requires a drum track', threw);

  check('fetchSongsterrDrums is a back-compat alias of fetchSongsterrPart',
    (fetchSongsterrDrums as unknown) === (fetchSongsterrPart as unknown));
}

// ── import_songsterr modes, over a STUBBED fetch (offline) ───────────────
// The executor is the layer an agent actually meets, so its list_tracks roster,
// its melodic-selection labelling, and its mutual-exclusion refusal are worth a
// golden. Swapping `globalThis.fetch` keeps this offline and deterministic; the
// original is restored at the end of the block.
{
  const META = {
    songId: 999, revisionId: 7, image: 'img', title: 'Test Song', artist: 'Band',
    popularTrackDrum: 3,
    tracks: [
      { instrumentId: 34, instrument: 'Electric Bass (finger)', hash: 'b' },
      { instrumentId: 30, instrument: 'Overdriven Guitar', name: 'Rhythm', hash: 'g' },
      { instrumentId: 19, instrument: 'Church Organ', hash: 'o' },
      { instrumentId: 1024, instrument: 'Drums', name: 'Live Kit', hash: 'd' },
    ],
  };
  const PART: DrumPart = {
    measures: [{ signature: [4, 4], marker: { text: 'Intro' }, voices: [{ beats: [{ notes: [{ fret: 36 }], duration: [1, 4] }] }] }],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 128 }] },
  };

  const realFetch = globalThis.fetch;
  let metaCalls = 0;
  let partCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('/api/meta/')) {
      metaCalls++;
      return { ok: true, status: 200, json: async () => META };
    }
    partCalls++;
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(PART)).buffer };
  }) as unknown as typeof globalThis.fetch;

  try {
    const roster = await executeImportSongsterr({ url: '999', list_tracks: true });
    check('list_tracks: returns mode "list_tracks"', 'mode' in roster && roster.mode === 'list_tracks');
    check('list_tracks: downloads NO part JSON', partCalls === 0, `partCalls=${partCalls}`);
    check('list_tracks: one metadata read', metaCalls === 1, `metaCalls=${metaCalls}`);
    if ('mode' in roster) {
      check('list_tracks: lists every part, not just drums', roster.tracks.length === 4, String(roster.tracks.length));
      check('list_tracks: flags only the drum part',
        roster.tracks.filter((t) => t.is_drums).map((t) => t.partId).join() === '3');
      check('list_tracks: carries the grid-scope note', roster.notes.length === 1 && roster.notes[0].includes('PERCUSSION'));
    }

    let threw = '';
    try { await executeImportSongsterr({ url: '999', list_tracks: true, whole_song: true }); } catch (e) { threw = String(e); }
    check('list_tracks: refuses when combined with whole_song', threw.includes('list_tracks only lists'), threw);

    const melodic = await executeImportSongsterr({ url: '999', track: 0 });
    check('melodic track: selection resolves and names the instrument',
      !('mode' in melodic) && melodic.track.instrument === 'Electric Bass (finger)' && melodic.track.is_drums === false,
      JSON.stringify('mode' in melodic ? melodic.mode : melodic.track));
    check('discovery call: carries all_tracks',
      !('mode' in melodic) && melodic.all_tracks?.length === 4);
    // This fixture part carries NEITHER a percussion staff NOR a `tuning`, so
    // neither reading applies and the tool says exactly that. (A real melodic
    // part DOES carry `tuning` and converts; see the After Dark block below.)
    check('untuned non-drum track: says neither reading applies',
      !('mode' in melodic) && (melodic.warnings ?? []).some((w) => w.startsWith('PART 0 is "Electric Bass (finger)"') && w.includes('neither')),
      JSON.stringify('mode' in melodic ? undefined : melodic.warnings));

    const drums = await executeImportSongsterr({ url: '999', track_name: 'Live Kit' });
    check('drum track: track_name resolves against the full roster',
      !('mode' in drums) && drums.track.partId === 3 && drums.track.is_drums === true);
    check('drum track: carries no not-a-drum warning',
      !('mode' in drums) && !(drums.warnings ?? []).some((w) => w.startsWith('PART ')));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── The GM2/GS effect block (27-34) is NOT a voice map (Sugar china defect) ──
// Songsterr's DrumLegend is a NOTATION legend: it says what glyph to DRAW for a
// number. Using it as a SOUNDING map folded Sugar's 103 `{fret:30, ghost:true}`
// engraving markers into `perc` → GM 56 → an SPD-SX china pad that the
// maintainer heard interleaved through the clap/snare part, and that Songsterr's
// own player does not sound. These lock the entries out.
{
  const beat = (fret: number): DrumPart['measures'][0]['voices'][0]['beats'][0] =>
    ({ notes: [{ fret, string: -1.5, ghost: true }], duration: [1, 4] });
  // 30 = "Scratch pull" (the Sugar case), 33 = "Metronome click", 34 = "Metronome bell".
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [beat(30), beat(33), beat(34), { notes: [{ fret: 38 }], duration: [1, 4] }] }] }],
  };
  const flat = flattenSongsterrDrums(part);
  check('effect block: number 30 (Scratch pull) produces NO voiced hit',
    !flat.events.some((e) => e.voice === 'perc'), JSON.stringify(flat.events.map((e) => e.voice)));
  check('effect block: 33/34 no longer sound as woodblock/triangle',
    !flat.events.some((e) => e.voice === 'woodblock' || e.voice === 'triangle'), JSON.stringify(flat.events.map((e) => e.voice)));
  check('effect block: the real snare alongside them still imports',
    flat.events.length === 1 && flat.events[0].voice === 'snare', JSON.stringify(flat.events));
  check('effect block: 30/33/34 are REPORTED as unmapped, not silently dropped',
    flat.unmapped === 3 && flat.unmapped_numbers[30] === 1 && flat.unmapped_numbers[33] === 1 && flat.unmapped_numbers[34] === 1,
    JSON.stringify(flat.unmapped_numbers));
  check('effect block: the unmapped summary names number 30', unmappedSummary(flat).includes('30×1'), unmappedSummary(flat));
  check('effect block: SONGSTERR_DRUM_EXTENSIONS carries no entry for 27-34',
    [27, 28, 29, 30, 31, 32, 33, 34].every((n) => SONGSTERR_DRUM_EXTENSIONS[n] === undefined),
    JSON.stringify([27, 28, 29, 30, 31, 32, 33, 34].map((n) => SONGSTERR_DRUM_EXTENSIONS[n])));
  check('effect block: 82-87 (real GM2 percussion) are KEPT',
    SONGSTERR_DRUM_EXTENSIONS[82] === 'maracas' && SONGSTERR_DRUM_EXTENSIONS[85] === 'claves'
    && SONGSTERR_DRUM_EXTENSIONS[86] === 'tom' && SONGSTERR_DRUM_EXTENSIONS[87] === 'tom',
    JSON.stringify([82, 83, 84, 85, 86, 87].map((n) => SONGSTERR_DRUM_EXTENSIONS[n])));
  // The caller keeps the last word: an explicit drumMap still routes the number.
  const mapped = flattenSongsterrDrums(part, { drumMap: { 30: 'snare' } });
  check('effect block: explicit drumMap {30:"snare"} still imports the layer',
    mapped.events.filter((e) => e.voice === 'snare').length === 2 && mapped.unmapped === 2,
    JSON.stringify({ voices: mapped.events.map((e) => e.voice), unmapped: mapped.unmapped_numbers }));
  const viaGm = flattenSongsterrDrums(part, { drumMap: { 33: 76 } });
  check('effect block: drumMap to a GM number (33→76) also routes it',
    viaGm.events.some((e) => e.voice === 'woodblock'), JSON.stringify(viaGm.events.map((e) => e.voice)));
  // The track-wide warning is how an agent finds out. It must name the number.
  const imp = importSongsterrDrums(part, { stepsPerBeat: 4 });
  check('effect block: the TRACK-WIDE warning names 30 with its count',
    imp.warnings.some((w) => /TRACK-WIDE/.test(w) && /30×1/.test(w)), JSON.stringify(imp.warnings));
}

// ── Ghost policy: a ghosted hit SOUNDS, quietly; it is never dropped ─────
// Decided 2026-07-27 against a blanket drop. Sugar's silent number-30 notes were
// inaudible because of the mapping defect above, not the ghost flag; the same
// part ghosts 3 of its 61 snares, 2 electric snares, a tom and all 3 pedal-hat
// hits, all real groove. The count is surfaced so the policy is inspectable.
{
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 38, ghost: true }], duration: [1, 4] },   // ghosted snare
      { notes: [{ fret: 36 }], duration: [1, 4] },                // plain kick
      { notes: [{ fret: 44, ghost: true }], duration: [1, 4] },   // ghosted pedal hat
      { notes: [{ fret: 42 }], duration: [1, 4] },                // plain hat
    ] }] }],
  };
  const flat = flattenSongsterrDrums(part);
  check('ghost: a ghosted hit is KEPT as an event (4 events, none dropped)', flat.events.length === 4, String(flat.events.length));
  check('ghost: it is flagged soft, not silent', flat.events[0].ghost === true && flat.events[0].voice === 'snare');
  check('ghost: plain hits stay un-ghosted', flat.events[1].ghost === undefined && flat.events[3].ghost === undefined);
  check('ghost: the count is reported (2)', flat.ghosts === 2, String(flat.ghosts));
  const q = importSongsterrDrums(part, { stepsPerBeat: 4 });
  check('ghost: quantizes to velocity 40 (soft), not an absent step',
    q.voices.snare?.[0].on === true && q.voices.snare?.[0].velocity === 40, JSON.stringify(q.voices.snare?.[0]));
  check('ghost: a plain hit carries no reduced velocity', q.voices.kick?.[4].velocity === undefined, JSON.stringify(q.voices.kick?.[4]));
  check('ghost: the policy is stated in a TRACK-WIDE warning, not left to inference',
    q.warnings.some((w) => /TRACK-WIDE/.test(w) && /GHOSTED/.test(w) && /velocity 40/.test(w)), JSON.stringify(q.warnings));
  // A sticky pp dynamic ghosts too, and is counted the same way.
  const sticky: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 38 }], duration: [1, 4], velocity: 'pp' },
      { notes: [{ fret: 38 }], duration: [1, 4] },
    ] }] }],
  };
  check('ghost: a sticky pp dynamic counts toward `ghosts` (2)', flattenSongsterrDrums(sticky).ghosts === 2,
    String(flattenSongsterrDrums(sticky).ghosts));

  // The reduced velocity is a knob, not magic. There is deliberately no value
  // that silences a ghost; the tool refuses anything outside 1..127.
  const louder = importSongsterrDrums(part, { stepsPerBeat: 4, ghostVelocity: 70 });
  check('ghost: ghostVelocity overrides the default (70, still a hit)',
    louder.voices.snare?.[0].on === true && louder.voices.snare?.[0].velocity === 70, JSON.stringify(louder.voices.snare?.[0]));
  check('ghost: overriding does NOT change the plain hits', louder.voices.kick?.[4].velocity === undefined);
  check('ghost: GHOST_HIT_VELOCITY is the documented default (40)', GHOST_HIT_VELOCITY === 40, String(GHOST_HIT_VELOCITY));
}

// ── The two defects must never be re-conflated (the pin) ─────────────────
// One fixture, both rules at once: a note in the 27-34 effect block produces NO
// voiced hit, while a ghosted note on a REAL drum voice still produces a hit at
// reduced velocity. A future agent who "simplifies" either one breaks this.
{
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 30, string: -1.5, ghost: true }], duration: [1, 4] },  // effect block + ghosted (the Sugar shape)
      { notes: [{ fret: 38, ghost: true }], duration: [1, 4] },                // ghosted SNARE (the Breakdown shape)
      { notes: [{ fret: 38 }], duration: [1, 4] },                             // plain snare, for contrast
      { notes: [{ fret: 36 }], duration: [1, 4] },
    ] }] }],
  };
  const q = importSongsterrDrums(part, { stepsPerBeat: 4 });
  check('pin: the 27-34 note produces NO voiced hit anywhere in the grid',
    !Object.values(q.voices).some((steps) => steps[0]?.on === true), JSON.stringify(Object.keys(q.voices)));
  check('pin: and it is REPORTED, not silently dropped',
    q.warnings.some((w) => /30×1/.test(w)), JSON.stringify(q.warnings));
  check('pin: the ghosted SNARE still sounds, at reduced velocity 40',
    q.voices.snare?.[4].on === true && q.voices.snare?.[4].velocity === 40, JSON.stringify(q.voices.snare?.[4]));
  check('pin: the plain snare beside it stays at full strength',
    q.voices.snare?.[8].on === true && q.voices.snare?.[8].velocity === undefined, JSON.stringify(q.voices.snare?.[8]));
  check('pin: the ghost is quieter than the plain hit, not equal and not absent',
    (q.voices.snare?.[4].velocity ?? 100) < (q.voices.snare?.[8].velocity ?? 100));
}

// ── Dynamics are a LADDER, not accent / plain / ghost ────────────────────
// Tom Petty "Breakdown" (s23527 part 6) carries NO per-note ghost flag at all:
// its drum dynamics are entirely sticky beat markings (fff×112, f×101, p×24,
// mf×8, mp×2), and the measure-1 tail snare the maintainer hears as a "light
// snare tail hit" is literally {"fret":38,"velocity":"p"}. With only an ACCENT
// set and a GHOST set, p / mp / mf all fell through to the plain hit, so that
// snare came out exactly as loud as the backbeat.
{
  const at = (fret: number, velocity?: string): DrumPart['measures'][0]['voices'][0]['beats'][0] =>
    ({ notes: [{ fret }], duration: [1, 4], ...(velocity ? { velocity } : {}) });
  // The Breakdown measure-1 shape, condensed: accent kick, hat, accent snare, soft tail snare.
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [at(36, 'fff'), at(42, 'f'), at(38, 'fff'), at(38, 'p')] }] }],
  };
  const flat = flattenSongsterrDrums(part);
  const tail = flat.events[3];
  check('dynamics: a "p" tail snare is SOFTER than the backbeat, not equal to it',
    tail.velocity === 60 && tail.accent === undefined, JSON.stringify(tail));
  check('dynamics: it is still a real hit, not a ghost-flagged one', tail.ghost === undefined && tail.voice === 'snare');
  check('dynamics: "fff" keeps its accent flag and needs no explicit velocity',
    flat.events[0].accent === true && flat.events[0].velocity === undefined, JSON.stringify(flat.events[0]));
  check('dynamics: "f" is the plain hit and carries no velocity field (unchanged behaviour)',
    flat.events[1].velocity === undefined && flat.events[1].accent === undefined, JSON.stringify(flat.events[1]));
  const q = importSongsterrDrums(part, { stepsPerBeat: 4 });
  check('dynamics: the soft tail reaches the grid at velocity 60',
    q.voices.snare?.[12].velocity === 60, JSON.stringify(q.voices.snare?.[12]));
  check('dynamics: the accented backbeat stays accented on the grid',
    q.voices.snare?.[8].accent === true && q.voices.snare?.[8].velocity === undefined, JSON.stringify(q.voices.snare?.[8]));
  // mp / mf sit between; pp still lands on the shared ghost level.
  const ladder: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [at(38, 'mp'), at(38, 'mf'), at(38, 'pp'), at(38, 'ppp')] }] }],
  };
  const lf = flattenSongsterrDrums(ladder);
  check('dynamics: mp=75, mf=90 (between a ghost and a plain hit)',
    lf.events[0].velocity === 75 && lf.events[1].velocity === 90, JSON.stringify(lf.events.map((e) => e.velocity)));
  check('dynamics: pp lands on the shared ghost level and stays flag-only (unchanged)',
    lf.events[2].ghost === true && lf.events[2].velocity === undefined, JSON.stringify(lf.events[2]));
  check('dynamics: ppp is ghosted AND softer still (28)',
    lf.events[3].ghost === true && lf.events[3].velocity === 28, JSON.stringify(lf.events[3]));
  check('dynamics: SONGSTERR_DYNAMIC_VELOCITY is anchored on the compiler ladder (f=100, fff=120, pp=40)',
    SONGSTERR_DYNAMIC_VELOCITY.f === 100 && SONGSTERR_DYNAMIC_VELOCITY.fff === 120 && SONGSTERR_DYNAMIC_VELOCITY.pp === 40,
    JSON.stringify(SONGSTERR_DYNAMIC_VELOCITY));
  // The ladder is overridable per import.
  const harder = flattenSongsterrDrums(part, { dynamicVelocity: { p: 30 } });
  check('dynamics: dynamicVelocity overrides one marking without disturbing the rest',
    harder.events[3].velocity === 30 && harder.events[0].velocity === undefined, JSON.stringify(harder.events.map((e) => e.velocity)));
}

// ── Grace-ornament beats take NO measure time ────────────────────────────
// Songsterr's second flam encoding is a separate beat flagged `graceNote`. The
// flag is a STRING ("onBeat" in Sugar, "beforeBeat" in Gethsemane), so a `===
// true` test matches neither, so the fixtures below use the real source values.
// Its `duration` is an engraving hint: censusing Sugar + Gethsemane
// (2026-07-27), every voice's durations sum to the measure length exactly once
// the grace beats are subtracted, and over it by exactly the grace duration when
// they are not. Advancing on one pushed the rest of the measure late by up to
// 0.375 quarter beats (1.5 sixteenth steps in Sugar m89).
{
  const part: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 36 }], duration: [1, 4] },                          // beat 0
      { notes: [{ fret: 38 }], duration: [1, 32], graceNote: 'onBeat' },    // grace before beat 1
      { notes: [{ fret: 38 }], duration: [1, 4] },                          // beat 1
      { notes: [{ fret: 36 }], duration: [1, 4] },                          // beat 2
      { notes: [{ fret: 38 }], duration: [1, 4] },                          // beat 3
    ] }] }],
  };
  const flat = flattenSongsterrDrums(part);
  check('grace: the cursor does not advance (onsets stay 0,1,1,2,3)',
    JSON.stringify(flat.events.map((e) => +e.beat.toFixed(4))) === '[0,1,1,2,3]',
    JSON.stringify(flat.events.map((e) => +e.beat.toFixed(4))));
  check('grace: the ornament is kept, ghosted, on the following onset',
    flat.events.filter((e) => e.beat === 1 && e.voice === 'snare').some((e) => e.ghost === true));
  check('grace: the fold is counted (1)', flat.graces_folded === 1, String(flat.graces_folded));
  check('grace: a grace counts as a ghost too', flat.ghosts === 1, String(flat.ghosts));
  const q = importSongsterrDrums(part, { stepsPerBeat: 4 });
  check('grace: grace + main share the step and the LOUD one wins (no ghost velocity)',
    q.voices.snare?.[4].on === true && q.voices.snare?.[4].velocity === undefined, JSON.stringify(q.voices.snare?.[4]));
  check('grace: the fold is surfaced as a TRACK-WIDE warning',
    q.warnings.some((w) => /TRACK-WIDE/.test(w) && /grace-ornament/.test(w)), JSON.stringify(q.warnings));
  // A grace on a DIFFERENT voice survives as its own hit rather than vanishing.
  // (Also covers the other source spelling, "beforeBeat".)
  const cross: DrumPart = {
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 38 }], duration: [1, 16], graceNote: 'beforeBeat' },
      { notes: [{ fret: 49 }], duration: [1, 1] },
    ] }] }],
  };
  const cf = flattenSongsterrDrums(cross);
  check('grace: a cross-voice grace keeps its own hit at the same onset',
    cf.events.length === 2 && cf.events.every((e) => e.beat === 0)
    && cf.events.some((e) => e.voice === 'snare') && cf.events.some((e) => e.voice === 'crash'),
    JSON.stringify(cf.events));
  check('grace: the measure still spans its signature length (4 beats)', cf.totalBeats === 4, String(cf.totalBeats));
}

// ══ MELODIC PARTS: string + fret → pitch ════════════════════════════════
// Songsterr stores a melodic note as {fret, string} against the part's own
// top-level open-string `tuning`, so `pitch = tuning[string] + fret`. The
// fixtures below are VERBATIM measures from song 501859 revision 4102120
// (Mr.Kitty "After Dark", 140 bpm, 4/4, 135 measures, one tempo mark), so these
// are real-source goldens run offline rather than invented shapes.

// ── The discriminator: `tuning` present = melodic, `tuningFlat` = drums ──
{
  const melodic: SongsterrPart = { tuning: [64, 59, 55, 50, 45, 40], strings: 6, measures: [] };
  const drums: SongsterrPart = { tuningFlat: true, strings: 6, measures: [] };
  check('melodic: a part carrying `tuning` is melodic', isMelodicPart(melodic) === true);
  check('melodic: a part carrying `tuningFlat` and no tuning is NOT', isMelodicPart(drums) === false);
  check('melodic: an empty tuning array does not count', isMelodicPart({ tuning: [], measures: [] }) === false);
  // The discriminator must not be the instrument NAME: a tab can label a part
  // anything, and this is what makes the routing free (the part JSON we already
  // downloaded answers it; no extra fetch hop).
  check('melodic: the drum part of the SAME song has no tuning at all', drums.tuning === undefined);
}

// ── pitchToken round-trips through the mini-notation parser ─────────────
// The row we emit has to re-parse to the same MIDI numbers, or apply_pattern
// plays something else. Lowercase + sharps is exactly what `parsePitch` reads.
{
  check('pitchToken: 51 → "d#3" → 51', pitchToken(51) === 'd#3' && parsePitch('d#3') === 51, pitchToken(51));
  check('pitchToken: 60 = middle C = "c4"', pitchToken(60) === 'c4' && parsePitch('c4') === 60, pitchToken(60));
  check('pitchToken: the MIDI floor and ceiling round-trip', pitchToken(0) === 'c-1' && parsePitch('c-1') === 0 && pitchToken(127) === 'g9' && parsePitch('g9') === 127,
    `${pitchToken(0)}/${pitchToken(127)}`);
  check('pitchToken: every note 0..127 round-trips',
    Array.from({ length: 128 }, (_, n) => n).every((n) => parsePitch(pitchToken(n)) === n));
}

// ── After Dark part 5 (Acoustic Grand Piano), measures 1-2, VERBATIM ────
// tuning [64,59,55,50,45,40]; measure 1's first note {"fret":6,"string":4}
// resolves as tuning[4]=45 + 6 = 51 = d#3. The index runs DOWNWARD (0 = the
// highest string). Reading it upward yields 10 chromatic pitch classes across
// this song's four melodic parts and a bass playing tritones, where the correct
// reading yields exactly 6 (a coherent key), and the drum parts' own downward
// staff positions (-0.5 through 3.5) agree.
{
  const bar = (withVelocity: boolean): SongsterrPart['measures'][0] => ({
    voices: [{ beats: [
      { notes: [{ fret: 6, string: 4 }], ...(withVelocity ? { velocity: 'f' } : {}), letRing: true, duration: [1, 4] },
      { notes: [{ fret: 6, string: 4 }], letRing: true, duration: [1, 8] },
      { notes: [{ fret: 7, string: 2 }], letRing: true, duration: [1, 4] },
      { notes: [{ fret: 7, string: 2 }], letRing: true, duration: [1, 8] },
      { notes: [{ fret: 8, string: 3 }], letRing: true, duration: [1, 4] },
    ] }],
    ...(withVelocity ? { signature: [4, 4] as [number, number], marker: { text: 'Intro' } } : {}),
  });
  const part: SongsterrPart = {
    tuning: [64, 59, 55, 50, 45, 40], strings: 6,
    measures: [bar(true), bar(false)],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 140 }] },
  };
  check('after dark p5: the part reads as melodic', isMelodicPart(part) === true);

  const flat = flattenSongsterrMelodic(part);
  check('after dark p5: tuning[4] + fret 6 = 51 (d#3), the worked example',
    flat.notes[0].pitch === 51 && pitchToken(flat.notes[0].pitch) === 'd#3', String(flat.notes[0].pitch));
  check('after dark p5: 10 onsets over 2 bars, none unresolved',
    flat.notes.length === 10 && flat.unresolved === 0, `${flat.notes.length}/${flat.unresolved}`);
  check('after dark p5: onsets at 0, 1, 1.5, 2.5, 3 (+4 in bar 2)',
    JSON.stringify(flat.notes.slice(0, 5).map((n) => n.beat)) === '[0,1,1.5,2.5,3]',
    JSON.stringify(flat.notes.map((n) => n.beat)));
  check('after dark p5: letRing carried off the beat onto the note', flat.notes.every((n) => n.letRing === true));
  check('after dark p5: range d#3..d4, 3 pitch classes (d, d#, a#)',
    flat.range?.low === 51 && flat.range?.high === 62 && JSON.stringify(flat.pitch_classes) === '[2,3,10]',
    JSON.stringify({ range: flat.range, classes: flat.pitch_classes }));

  const m = importSongsterrMelodic(part, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  // The row carries each note's LENGTH, and every beat of this fixture is
  // LET-RING, so those lengths are the sustained ones, not the written ones. This
  // is the measured cost the source-fidelity audit ranked third: verbatim, all 86
  // onsets of this part's 18-bar intro are marked let-ring, and until 2026-07-27
  // the flag reached `cells[].letRing` and died there with no warning, so every
  // note stopped when the next began and the pedalled chord never accumulated.
  //
  // Read the row against the written durations to see exactly what changed:
  //   step  0  d#3  written 4 steps, next d#3 is at step 4      -> :4   (unchanged)
  //   step  4  d#3  written 2,        next d#3 is at step 16     -> :12  (rings under d4 and a#3)
  //   step  6  d4   written 4,        next d4 is at step 10      -> :4   (unchanged)
  //   step 10  d4   written 2,        next d4 is at step 22      -> :12
  //   step 12  a#3  written 4,        next a#3 is at step 28     -> :16  (letRingMaxBeats = 4 beats)
  // and bar 2 repeats it with no later same-pitch strike inside the window, so
  // its notes take the 4-beat cap rather than reaching one.
  const EXPECTED = 'd#3:4 ~ ~ ~ d#3:12 ~ d4:4 ~ ~ ~ d4:12 ~ a#3:16 ~ ~ ~ d#3:4 ~ ~ ~ d#3:16 ~ d4:4 ~ ~ ~ d4:16 ~ a#3:16 ~ ~ ~';
  check('after dark p5: measures 1-2 at 16ths = the known-good pitch row, with LET-RING lengths',
    m.notation === EXPECTED, m.notation);
  // The pre-articulation reading is still exactly reachable, and byte-identical
  // to what this golden held before let-ring was acted on. That pins two things
  // at once: the opt-out works, and the ONLY thing that moved is the articulation.
  const written = importSongsterrMelodic(part, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4, articulations: false });
  check('after dark p5: articulations:false returns the WRITTEN lengths, unchanged from before let-ring was acted on',
    written.notation === 'd#3:4 ~ ~ ~ d#3:2 ~ d4:4 ~ ~ ~ d4:2 ~ a#3:4 ~ ~ ~ d#3:4 ~ ~ ~ d#3:2 ~ d4:4 ~ ~ ~ d4:2 ~ a#3:4 ~ ~ ~',
    written.notation);
  check('after dark p5: and articulations:false says so, naming where the unapplied markings are',
    written.warnings.some((w) => /articulations:false/.test(w) && /let-ring/.test(w) && /dropped_fidelity/.test(w)),
    JSON.stringify(written.warnings.filter((w) => /articulations/.test(w))));
  check('after dark p5: let-ring is REPORTED with a count and the knob that tunes it',
    m.articulation.let_ring_extended === 6 && m.articulations.let_rings === 10
    && m.warnings.some((w) => /LET-RING/.test(w) && /letRingMaxBeats/.test(w)),
    JSON.stringify({ report: m.articulation, counts: m.articulations }));
  check('after dark p5: a let-ring cell says what happened to it, in words',
    /let-ring to 12 step/.test(m.cells[1].articulations?.[0] ?? '') && m.cells[1].gate_sixths === 72,
    JSON.stringify(m.cells[1]));
  check('after dark p5: the cell keeps the WRITTEN length too, so the change is inspectable',
    m.cells[1].duration_steps === 2 && m.cells[1].gate_sixths === 72, JSON.stringify(m.cells[1]));
  check('after dark p5: 32 steps, 140 bpm, 4/4', m.step_count === 32 && m.bpm === 140 && m.signature[0] === 4 && m.signature[1] === 4,
    JSON.stringify({ steps: m.step_count, bpm: m.bpm, sig: m.signature }));
  check('after dark p5: nothing off-grid, nothing merged, nothing dropped',
    m.off_grid === 0 && m.merged === 0 && m.out_of_window === 0 && m.chord_overflow === 0 && m.unresolved === 0,
    JSON.stringify({ off: m.off_grid, merged: m.merged, oow: m.out_of_window, over: m.chord_overflow }));
  check('after dark p5: note LENGTH survives in cells (quarter = 4 steps, eighth = 2)',
    m.cells[0].duration_steps === 4 && m.cells[1].duration_steps === 2, JSON.stringify(m.cells.slice(0, 2)));
  check('after dark p5: window range comes back named', m.range?.low_name === 'd#3' && m.range?.high_name === 'd4', JSON.stringify(m.range));
  // The row is only useful if apply_pattern's own parser reads it back.
  const reparsed = parseVoice(m.notation, 32);
  check('after dark p5: the row re-parses through parseVoice to the same pitches',
    reparsed.filter((s) => s.on).length === 10 && reparsed[0].notes === 51 && reparsed[6].notes === 62,
    JSON.stringify({ on: reparsed.filter((s) => s.on).length, s0: reparsed[0].notes, s6: reparsed[6].notes }));

  // Direction pin: the same fixture read with the string index REVERSED gives a
  // different set of notes. If a future change flips the index, this fails.
  const reversed = importSongsterrMelodic(part, { tuning: [...(part.tuning ?? [])].reverse(), fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('after dark p5: reversing the string index changes the notes (the direction is load-bearing)',
    reversed.notation !== m.notation.split(' ').slice(0, 16).join(' ') && reversed.notation.startsWith('f4:4 '),
    reversed.notation);

  // transpose is applied after tuning+fret, for fitting a part into range.
  const down = importSongsterrMelodic(part, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, transpose: -12 });
  check('after dark p5: transpose -12 drops the whole row an octave', down.notation.startsWith('d#2:4 '), down.notation);
}

// ── After Dark part 2 (Pad 2 warm), measures 27-28: CHORDS + TIES ───────
// Verbatim: a 3-note whole-note chord, tied across the barline into a second
// whole note. This is the shape that proves both rules at once.
{
  const part: SongsterrPart = {
    tuning: [63, 58, 54, 49, 44, 39], strings: 6,
    measures: [
      { signature: [4, 4], voices: [{ beats: [{ notes: [{ fret: 9, string: 3 }, { fret: 7, string: 4 }, { fret: 0, string: 5 }], velocity: 'mf', duration: [1, 1] }] }] },
      { voices: [{ beats: [{ notes: [{ fret: 9, string: 3, tie: true }, { fret: 7, string: 4, tie: true }, { fret: 0, string: 5, tie: true }], duration: [1, 1] }] }] },
    ],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 140 }] },
  };
  const flat = flattenSongsterrMelodic(part);
  check('after dark pad: a tie is a CONTINUATION, so 3 onsets, not 6',
    flat.notes.length === 3 && flat.ties_folded === 3 && flat.ties_orphaned === 0,
    JSON.stringify({ notes: flat.notes.length, folded: flat.ties_folded, orphan: flat.ties_orphaned }));
  check('after dark pad: the tie became LENGTH (4 beats + 4 tied = 8)',
    flat.notes.every((n) => n.durationBeats === 8) && flat.notes.every((n) => n.tie === true && n.tiedBeats === 1),
    JSON.stringify(flat.notes));
  check('after dark pad: ONE struck chord (d#2, d#3, a#3); the tied bar is not a second one',
    flat.chords === 1 && JSON.stringify(flat.notes.map((n) => n.pitch)) === '[39,51,58]',
    JSON.stringify({ chords: flat.chords, pitches: flat.notes.map((n) => n.pitch) }));

  const m = importSongsterrMelodic(part, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  // `@90` is the sticky `mf` finally reaching the ROW. It resolved correctly and
  // landed in `cells[].velocity` and `steps[].velocity` from the start, and then
  // died here, because the row is what the documented workflow pastes into
  // apply_pattern and the row said nothing about loudness.
  check('after dark pad: same-offset notes emit ONE +-joined chord token, carrying its velocity',
    m.notation.startsWith('d#2+d#3+a#3:16@90_ ~'), m.notation.slice(0, 40));
  check('after dark pad: and that velocity survives the round trip back through parseVoice',
    parseVoice(m.notation, 32)[0].velocity === 90, JSON.stringify(parseVoice(m.notation, 32)[0]));
  check('after dark pad: chord tokens are ascending', m.cells[0].token === 'd#2+d#3+a#3' && JSON.stringify(m.cells[0].pitches) === '[39,51,58]',
    m.cells[0].token);
  check('after dark pad: ONE source onset, re-articulated once by the gate ceiling (30 rests, not 31)',
    m.cells.length === 1 && m.notation.split(' ').filter((t) => t === '~').length === 30, String(m.cells.length));
  check('after dark pad: the TIE survives on the cell, with its length in steps',
    m.cells[0].tie === true && m.cells[0].duration_steps === 32, JSON.stringify(m.cells[0]));
  check('after dark pad: the sticky "mf" reaches the cell as velocity 90', m.cells[0].velocity === 90, String(m.cells[0].velocity));
  check('after dark pad: the fold is REPORTED, not silent',
    m.warnings.some((w) => /TRACK-WIDE/.test(w) && /3 tie continuation/.test(w) && /duration_steps/.test(w)), JSON.stringify(m.warnings));
  // A chord token has to survive the round trip too.
  const reparsed = parseVoice(m.notation, 32);
  check('after dark pad: the chord token re-parses to 3 notes',
    JSON.stringify(reparsed[0].notes) === '[39,51,58]', JSON.stringify(reparsed[0].notes));
}

// ── The lossy cases are COUNTED, never silent ───────────────────────────
{
  const tuning = [64, 59, 55, 50, 45, 40];
  // A triplet-8th line: three onsets per beat cannot sit on a 16th grid.
  const triplets: SongsterrPart = {
    tuning,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 0, string: 0 }], duration: [1, 12] },   // beat 0
      { notes: [{ fret: 2, string: 0 }], duration: [1, 12] },   // beat 0.333 → off-grid
      { notes: [{ fret: 4, string: 0 }], duration: [1, 12] },   // beat 0.667 → off-grid
      { notes: [{ fret: 5, string: 0 }], duration: [3, 4] },    // beat 1, back on the grid
    ] }] }],
  };
  const t = importSongsterrMelodic(triplets, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('off-grid: triplet onsets are counted, not silently rounded', t.off_grid === 2, String(t.off_grid));
  check('off-grid: the warning names the fix (steps:8)',
    t.warnings.some((w) => /SNAPPED/.test(w) && /steps:8/.test(w)), JSON.stringify(t.warnings));
  check('off-grid: they are still PLACED (4 onsets survive)', t.cells.length === 4, JSON.stringify(t.cells.map((c) => c.step)));
  // At 32nds the same line has fewer off-grid onsets and no merge.
  const t8 = importSongsterrMelodic(triplets, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 8 });
  check('off-grid: a finer grid reduces the snap and never merges', t8.merged === 0 && t8.cells.length === 4, JSON.stringify({ off: t8.off_grid, merged: t8.merged }));

  // Two DISTINCT onsets snapping onto one step is the lossy case, counted apart
  // from a plain snap: a 64th pair inside one 16th step.
  const dense: SongsterrPart = {
    tuning,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 0, string: 0 }], duration: [1, 64] },   // beat 0      → step 0
      { notes: [{ fret: 1, string: 0 }], duration: [1, 64] },   // beat 0.0625 → step 0 as well
      { notes: [{ fret: 2, string: 0 }], duration: [31, 32] },
    ] }] }],
  };
  const d = importSongsterrMelodic(dense, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('merge: a second onset on a claimed step is counted as MERGED, not dropped',
    d.merged === 1 && d.cells[0].pitches.length === 2, JSON.stringify(d.cells[0]));
  check('merge: it becomes a chord token (they do sound together at this resolution)',
    d.cells[0].token === 'e4+f4', d.cells[0].token);
  check('merge: the warning distinguishes it from a plain snap',
    d.warnings.some((w) => /MERGED/.test(w) && /lossy/.test(w)), JSON.stringify(d.warnings));

  // A string index outside the tuning cannot become a pitch. Skipped + named.
  const badString: SongsterrPart = {
    tuning,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 3, string: 9 }], duration: [1, 4] },
      { notes: [{ fret: 3, string: 0 }], duration: [3, 4] },
    ] }] }],
  };
  const b = importSongsterrMelodic(badString, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('unresolved: a string index outside the tuning is skipped and counted', b.unresolved === 1, String(b.unresolved));
  check('unresolved: the warning names the string index and the tuning',
    b.warnings.some((w) => /string 9×1/.test(w) && /64, 59, 55, 50, 45, 40/.test(w)), JSON.stringify(b.warnings));
  check('unresolved: the good note beside it still imports', b.cells.length === 1 && b.cells[0].token === 'g4', JSON.stringify(b.cells));

  // A grace ornament has no step of its own; folding its PITCH onto the main
  // note would invent a chord the tab never wrote, so it is dropped + counted.
  const grace: SongsterrPart = {
    tuning,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 2, string: 0 }], duration: [1, 32], graceNote: 'beforeBeat' },
      { notes: [{ fret: 3, string: 0 }], duration: [1, 1] },
    ] }] }],
  };
  const g = importSongsterrMelodic(grace, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('grace: the ornament is dropped and counted, the main note keeps its pitch',
    g.cells.length === 1 && g.cells[0].token === 'g4', JSON.stringify(g.cells));
  check('grace: the drop is reported', g.warnings.some((w) => /grace-ornament note\(s\) dropped/.test(w)), JSON.stringify(g.warnings));
  check('grace: the cursor did not advance, so the measure keeps its timing',
    flattenSongsterrMelodic(grace).notes[0].beat === 0, String(flattenSongsterrMelodic(grace).notes[0].beat));

  // A tie with nothing abutting to hold from is an ATTACK, not a vanished note.
  const orphan: SongsterrPart = {
    tuning,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 0, string: 0 }], duration: [1, 4] },
      { notes: [{ fret: 5, string: 0 }], duration: [1, 4] },
      { notes: [{ fret: 0, string: 0, tie: true }], duration: [1, 2] },   // e4 again, but not abutting
    ] }] }],
  };
  const o = flattenSongsterrMelodic(orphan);
  check('tie: an orphan tie imports as a fresh attack, counted',
    o.notes.length === 3 && o.ties_orphaned === 1 && o.ties_folded === 0,
    JSON.stringify({ notes: o.notes.length, orphan: o.ties_orphaned, folded: o.ties_folded }));

  // No tuning at all = neither reading applies; refuse rather than guess.
  let threw = '';
  try { flattenSongsterrMelodic({ measures: [] }); } catch (e) { threw = String(e); }
  check('melodic: a part with no tuning refuses with a message naming tuningFlat',
    threw.includes('no `tuning`') && threw.includes('tuningFlat'), threw);
}

// ── import_songsterr routes a melodic part, over a STUBBED fetch ────────
{
  const META = {
    songId: 501859, revisionId: 4102120, image: 'img', title: 'After Dark', artist: 'Mr.Kitty',
    popularTrackDrum: 1,
    tracks: [
      { instrumentId: 0, instrument: 'Acoustic Grand Piano', name: 'Track 1', hash: 'p' },
      { instrumentId: 1024, instrument: 'Drums', hash: 'd' },
    ],
  };
  const PIANO_BAR = {
    voices: [{ beats: [
      { notes: [{ fret: 6, string: 4 }], velocity: 'f', letRing: true, duration: [1, 4] },
      { notes: [{ fret: 6, string: 4 }], letRing: true, duration: [1, 8] },
      { notes: [{ fret: 7, string: 2 }], letRing: true, duration: [1, 4] },
      { notes: [{ fret: 7, string: 2 }], letRing: true, duration: [1, 8] },
      { notes: [{ fret: 8, string: 3 }], letRing: true, duration: [1, 4] },
    ] }],
  };
  const PIANO = {
    tuning: [64, 59, 55, 50, 45, 40], strings: 6,
    measures: [{ ...PIANO_BAR, signature: [4, 4], marker: { text: 'Intro' } }, PIANO_BAR],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 140 }] },
  };
  const DRUMS = {
    tuningFlat: true,
    measures: [{ signature: [4, 4], voices: [{ beats: [{ notes: [{ fret: 36, string: 0 }], duration: [1, 4] }] }] }],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 140 }] },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const s = String(url);
    if (s.includes('/api/meta/')) return { ok: true, status: 200, json: async () => META };
    const part = s.includes('/0.json') ? PIANO : DRUMS;
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(part)).buffer };
  }) as unknown as typeof globalThis.fetch;

  try {
    const win = await executeImportSongsterr({ url: '501859', track: 0, from_measure: 1, to_measure: 2 });
    // Every beat of this fixture is let-ring, so the row's lengths are the
    // SUSTAINED ones; see the same expectation derived note-by-note in the
    // "after dark p5" block above.
    const EXPECTED = 'd#3:4 ~ ~ ~ d#3:12 ~ d4:4 ~ ~ ~ d4:12 ~ a#3:16 ~ ~ ~ d#3:4 ~ ~ ~ d#3:16 ~ d4:4 ~ ~ ~ d4:16 ~ a#3:16 ~ ~ ~';
    check('import_songsterr melodic: returns the pitch row under the default voice "synth1"',
      !('mode' in win) && win.voices?.synth1 === EXPECTED, JSON.stringify('mode' in win ? win.mode : win.voices));
    check('import_songsterr melodic: window carries 32 steps, bpm 140, 4/4',
      !('mode' in win) && win.window?.steps === 32 && win.window?.bpm === 140 && win.window?.signature === '4/4',
      JSON.stringify('mode' in win ? undefined : win.window));
    check('import_songsterr melodic: `melodic` carries the tuning, range and per-step cells',
      !('mode' in win) && JSON.stringify(win.melodic?.tuning) === '[64,59,55,50,45,40]'
      && win.melodic?.range?.low === 'd#3' && win.melodic?.range?.high === 'd4' && win.melodic?.cells.length === 10,
      JSON.stringify('mode' in win ? undefined : win.melodic));
    check('import_songsterr melodic: the fidelity counts are all zero on this window',
      !('mode' in win) && win.melodic?.off_grid === 0 && win.melodic?.merged === 0 && win.melodic?.unresolved === 0,
      JSON.stringify('mode' in win ? undefined : win.melodic));
    check('import_songsterr melodic: no GM-percussion warning is emitted for a melodic part',
      !('mode' in win) && !(win.warnings ?? []).some((w) => /non-GM percussion/.test(w)),
      JSON.stringify('mode' in win ? undefined : win.warnings));
    check('import_songsterr melodic: it says HOW the pitches were derived',
      !('mode' in win) && (win.warnings ?? []).some((w) => /is MELODIC/.test(w) && /tuning\[string\] \+ fret/.test(w)),
      JSON.stringify('mode' in win ? undefined : win.warnings));
    check('import_songsterr melodic: next_step routes it to a melodic track',
      !('mode' in win) && /PITCH ROW/.test(win.next_step) && /synth1/.test(win.next_step), 'mode' in win ? '' : win.next_step);

    const named = await executeImportSongsterr({ url: '501859', track: 0, from_measure: 1, to_measure: 1, voice_name: 'midi1' });
    check('import_songsterr melodic: voice_name renames the row key',
      !('mode' in named) && named.voices?.midi1 !== undefined && named.voices?.synth1 === undefined,
      JSON.stringify('mode' in named ? undefined : named.voices));

    const shifted = await executeImportSongsterr({ url: '501859', track: 0, from_measure: 1, to_measure: 1, transpose: -12 });
    check('import_songsterr melodic: transpose reaches the row',
      !('mode' in shifted) && (shifted.voices?.synth1 ?? '').startsWith('d#2:4 '), JSON.stringify('mode' in shifted ? undefined : shifted.voices));

    // whole_song used to REFUSE a melodic part ("pitch rows are not clustered
    // that way yet"), which made the multi-project chop drum-only and left a
    // five-part song with no layout at all. It no longer refuses: a pitch row
    // needs no clustering, because the tab already carries the structure as
    // measure markers, so a melodic part is chopped on those instead.
    const ws = await executeImportSongsterr({ url: '501859', track: 0, whole_song: true });
    check('whole_song on a MELODIC part no longer throws; it returns a section-marker plan',
      !('mode' in ws) && ws.song_plan !== undefined && ws.song_plan.projects.length === 1
      && ws.song_plan.projects[0].section === 'Intro',
      JSON.stringify('mode' in ws ? undefined : ws.song_plan?.projects));
    check('whole_song melodic: the plan states the 8 x 32 = 256-step ceiling',
      !('mode' in ws) && ws.song_plan?.ceiling.max_steps === 256 && ws.song_plan?.ceiling.max_bars === 16
      && /8 patterns x 32 steps/.test(ws.song_plan?.ceiling.note ?? ''),
      JSON.stringify('mode' in ws ? undefined : ws.song_plan?.ceiling));
    check('whole_song melodic: the project carries its bar range and step count',
      !('mode' in ws) && ws.song_plan?.projects[0].from_measure === 1 && ws.song_plan?.projects[0].to_measure === 2
      && ws.song_plan?.projects[0].bars === 2 && ws.song_plan?.projects[0].steps === 32
      && ws.song_plan?.projects[0].patterns === 1,
      JSON.stringify('mode' in ws ? undefined : ws.song_plan?.projects[0]));
    check('whole_song melodic: a ONE-part chop says so (a song is several parts)',
      !('mode' in ws) && (ws.warnings ?? []).some((w) => /covers ONE part/.test(w) && /parts:\[/.test(w)),
      JSON.stringify('mode' in ws ? undefined : ws.warnings));
    check('whole_song melodic: next_step is plan-first, not author-first',
      !('mode' in ws) && /READ THIS PLAN TO THE USER BEFORE AUTHORING/.test(ws.next_step),
      'mode' in ws ? '' : ws.next_step.slice(0, 80));

    // The multi-part call: one chop, both parts, ONE set of boundaries.
    const both = await executeImportSongsterr({ url: '501859', whole_song: true, parts: [0, 1] });
    check('whole_song parts:[0,1]: one plan covering both parts',
      !('mode' in both) && both.song_plan?.parts.length === 2
      && both.song_plan?.parts.map((p) => p.partId).join(',') === '0,1',
      JSON.stringify('mode' in both ? undefined : both.song_plan?.parts));
    check('whole_song parts: every part is accounted for in every project (shared window)',
      !('mode' in both) && (both.song_plan?.projects ?? []).every((p) => p.parts.length + p.silent_parts.length === 2),
      JSON.stringify('mode' in both ? undefined : both.song_plan?.projects.map((p) => ({ s: p.parts.length, z: p.silent_parts.length }))));
    check('whole_song parts: a melodic and a drum part chop together (kind is not a barrier)',
      !('mode' in both) && both.song_plan?.parts.some((p) => p.melodic) === true
      && both.song_plan?.parts.some((p) => !p.melodic) === true,
      JSON.stringify('mode' in both ? undefined : both.song_plan?.parts));

    let threwParts = '';
    try { await executeImportSongsterr({ url: '501859', track: 0, parts: [0, 1] }); } catch (e) { threwParts = String(e); }
    check('import_songsterr: `parts` without whole_song refuses instead of silently ignoring it',
      threwParts.includes('only applies to whole_song'), threwParts);

    let threwUnknown = '';
    try { await executeImportSongsterr({ url: '501859', whole_song: true, parts: [0, 9] }); } catch (e) { threwUnknown = String(e); }
    check('import_songsterr: an unknown partId is named, with the roster',
      threwUnknown.includes('parts 9 are not on this tab') && threwUnknown.includes('Acoustic Grand Piano'), threwUnknown);

    // The drum part of the same song is untouched by all of this.
    const drums = await executeImportSongsterr({ url: '501859', track: 1, from_measure: 1, to_measure: 1 });
    check('import_songsterr: the drum part still quantizes to percussion voices',
      !('mode' in drums) && drums.voices?.kick?.startsWith('x') === true && drums.melodic === undefined,
      JSON.stringify('mode' in drums ? undefined : drums.voices));

    const roster = await executeImportSongsterr({ url: '501859', list_tracks: true });
    check('import_songsterr: the roster note now describes BOTH conversions',
      'mode' in roster && roster.notes[0].includes('PERCUSSION') && roster.notes[0].includes('pitch row')
      && roster.notes[0].includes('tuning[string] + fret'),
      'mode' in roster ? roster.notes[0] : '');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── whole_song `parts`: the union-keyed section bank (dispatcher level) ──
// The tool-surface half of the re-key: a multi-part whole_song call now returns
// `arrangement` alongside `song_plan`, its window identity the UNION of every
// selected part. Fixture: drums play the SAME bar in all four windows; the synth
// alternates two figures. Drum-keyed dedup would say "one section"; the build
// has two.
{
  const META = {
    songId: 777, revisionId: 3, image: 'img', title: 'Lockstep', artist: 'Test',
    popularTrackDrum: 1,
    tracks: [
      { instrumentId: 81, instrument: 'Lead 1 (square)', name: 'Synth', hash: 's' },
      { instrumentId: 1024, instrument: 'Drums', hash: 'd' },
    ],
  };
  // One 4/4 bar each; a 32-step window at 16ths is TWO bars, so 8 measures = 4 windows.
  const kickBar = { signature: [4, 4], voices: [{ beats: [{ notes: [{ fret: 36 }], duration: [1, 4] }, { notes: [] as { fret: number }[], duration: [3, 4] }] }] };
  const synthBar = (fret: number): unknown => ({ voices: [{ beats: [{ notes: [{ fret, string: 0 }], duration: [1, 1] }] }] });
  const DRUMS = { tuningFlat: true, measures: Array.from({ length: 8 }, () => kickBar), automations: { tempo: [{ measure: 0, position: 0, bpm: 100 }] } };
  // Windows: (bars 1-2) figure A, (3-4) figure B, (5-6) A again, (7-8) B again.
  const SYNTH = {
    tuning: [64, 59, 55, 50, 45, 40],
    measures: [0, 0, 5, 5, 0, 0, 5, 5].map((f, i) => ({ ...(synthBar(f) as object), ...(i === 0 ? { signature: [4, 4] } : {}) })),
    automations: { tempo: [{ measure: 0, position: 0, bpm: 100 }] },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const s = String(url);
    if (s.includes('/api/meta/')) return { ok: true, status: 200, json: async () => META };
    const part = s.includes('/0.json') ? SYNTH : DRUMS;
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(part)).buffer };
  }) as unknown as typeof globalThis.fetch;

  try {
    const r = await executeImportSongsterr({ url: '777', whole_song: true, parts: [0, 1], fuzz: 0 });
    const a = 'mode' in r ? undefined : r.arrangement;
    check('parts bank: a multi-part whole_song call returns arrangement AND song_plan',
      !('mode' in r) && a !== undefined && r.song_plan !== undefined);
    check('parts bank: drum-identical windows split on the synth layer (A B A B, 2 sections)',
      a !== undefined && a.sections.length === 2 && a.order.join(' ') === 'A B A B',
      JSON.stringify(a === undefined ? undefined : { sections: a.sections.length, order: a.order }));
    check('parts bank: the two sections carry IDENTICAL drum grids (the layer is the difference)',
      a !== undefined && JSON.stringify(a.sections[0].voices) === JSON.stringify(a.sections[1].voices),
      JSON.stringify(a?.sections.map((s) => s.voices)));
    check('parts bank: the receipt names the identity layers and the per-layer fuzz rule',
      !('mode' in r) && (r.warnings ?? []).some((w) => w.includes('keyed over ALL 2 selected part(s)') && w.includes('EVERY layer') && w.includes('Lead 1 (square)')),
      JSON.stringify('mode' in r ? undefined : r.warnings?.filter((w) => w.includes('keyed'))));
    check('parts bank: next_step points at the union-keyed letters',
      !('mode' in r) && r.next_step.includes('keyed over ALL selected'), 'mode' in r ? '' : r.next_step.slice(-200));

    // A drum-only part list keys as today: same letters as the track-only call.
    const single = await executeImportSongsterr({ url: '777', whole_song: true, parts: [1], fuzz: 0 });
    const plain = await executeImportSongsterr({ url: '777', track: 1, whole_song: true, fuzz: 0 });
    check('parts bank: parts:[drum] letters equal the drum-only call (one section here)',
      !('mode' in single) && !('mode' in plain)
      && JSON.stringify(single.arrangement) === JSON.stringify(plain.arrangement),
      JSON.stringify({
        single: 'mode' in single ? undefined : single.arrangement?.order,
        plain: 'mode' in plain ? undefined : plain.arrangement?.order,
      }));
    check('parts bank: drum-only letters still merge the four windows (no behaviour change)',
      !('mode' in plain) && plain.arrangement?.sections.length === 1
      && plain.arrangement.order.join(' ') === 'A A A A',
      JSON.stringify('mode' in plain ? undefined : plain.arrangement?.order));
    // An all-melodic selection has no drum grids to bank: song_plan only, as before.
    const mel = await executeImportSongsterr({ url: '777', whole_song: true, parts: [0] });
    check('parts bank: an all-melodic part list gets song_plan only (no drum bank to key)',
      !('mode' in mel) && mel.arrangement === undefined && mel.song_plan !== undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── NOTE LENGTH + TIE cross the import boundary ────────────────────────
//
// The defect this covers was SILENT: `parseVoice` accepted "c3:16_" and the
// flattener recorded `duration_steps` / `tie`, but the row handed back carried
// pitch alone, so pasting `voices` into apply_pattern authored every note ONE
// STEP long and returned a clean receipt. A pad became a blip with nothing to
// show for it. Every check here exists to make that failure loud.
{
  // After Dark's pad tuning + its worked chord: tuning[3]+9 = 58 (a#3),
  // tuning[4]+7 = 51 (d#3), tuning[5]+0 = 39 (d#2).
  const PAD_TUNING = [63, 58, 54, 49, 44, 39];
  const CHORD = [{ fret: 9, string: 3 }, { fret: 7, string: 4 }, { fret: 0, string: 5 }];
  const TIED = CHORD.map((n) => ({ ...n, tie: true as const }));
  const PAD = 'd#2+d#3+a#3';
  const tuning = [64, 59, 55, 50, 45, 40];

  // 1. The floor: a 16th at a 16th grid is ONE step, and it says so. The bare
  //    token would mean the same thing to the device, but not to a reader, and
  //    apply_pattern's preserve_template_gates would leave a stale template
  //    gate under it.
  const oneStep: SongsterrPart = {
    tuning, measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: [{ fret: 0, string: 5 }], duration: [1, 16] },   // e2, one step
      { notes: [{ fret: 0, string: 5 }], duration: [15, 16] },  // and the rest of the bar
    ] }] }],
  };
  const one = importSongsterrMelodic(oneStep, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('gate: a one-step note emits ":1", not a bare token',
    one.notation.startsWith('e2:1 e2:15 ~'), one.notation);
  check('gate: a multi-step note emits its real length (15 steps)',
    one.cells[1].duration_steps === 15 && one.notation.split(' ')[1] === 'e2:15', one.notation.split(' ')[1]);
  check('gate: nothing was split or clamped on a row that fits',
    one.gate_splits === 0 && one.gate_clamps === 0 && one.ties_emitted === 0,
    JSON.stringify({ s: one.gate_splits, c: one.gate_clamps, t: one.ties_emitted }));
  {
    const rt = parseVoice(one.notation, 16);
    check('gate: the one-step / 15-step row re-parses to gates 6 and 90 sixths',
      rt[0].gate_sixths === 1 * GATE_SIXTHS_PER_STEP && rt[1].gate_sixths === 15 * GATE_SIXTHS_PER_STEP,
      JSON.stringify({ s0: rt[0].gate_sixths, s1: rt[1].gate_sixths }));
  }

  // 2. A source tie that already fits under the ceiling is LENGTH, not a `_`.
  //    Half tied to half = 4 beats = exactly the 16-step ceiling. Emitting `_`
  //    here would slur the pad into whatever note comes next, which the source
  //    never wrote: `_` means "the next onset is this same note continuing",
  //    and nothing else.
  const tiedToCeiling: SongsterrPart = {
    tuning: PAD_TUNING,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { notes: CHORD, duration: [1, 2] },
      { notes: TIED, duration: [1, 2] },
    ] }] }],
  };
  const ceil = importSongsterrMelodic(tiedToCeiling, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('gate: a source tie folded to exactly 16 steps emits ":16" with NO tie flag',
    ceil.notation.startsWith(`${PAD}:16 ~`) && ceil.ties_emitted === 0 && ceil.gate_splits === 0,
    `${ceil.notation.slice(0, 24)} ties=${ceil.ties_emitted}`);
  check('gate: the source tie is still REPORTED as folded (3 continuations)',
    ceil.ties_folded === 3 && ceil.cells[0].tie === true && ceil.cells[0].duration_steps === 16,
    JSON.stringify({ folded: ceil.ties_folded, cell: ceil.cells[0] }));

  // 3. Past the ceiling: After Dark's pad holds a whole note tied across the
  //    barline into a second one = 32 steps, twice what one gate byte holds.
  const pad32: SongsterrPart = {
    tuning: PAD_TUNING,
    measures: [
      { signature: [4, 4], voices: [{ beats: [{ notes: CHORD, velocity: 'mf', duration: [1, 1] }] }] },
      { voices: [{ beats: [{ notes: TIED, duration: [1, 1] }] }] },
    ],
  };
  const p32 = importSongsterrMelodic(pad32, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  const t32 = p32.notation.split(' ');
  // The `@90` on both pieces is the sticky `mf`; a re-articulation carries the
  // same velocity as the onset it continues, or the tail would jump in level.
  check('gate: a 32-step chord splits into ":16_" + ":16" at step 16, velocity on both pieces',
    t32[0] === `${PAD}:16@90_` && t32[16] === `${PAD}:16@90` && t32[1] === '~',
    `${t32[0]} … ${t32[16]}`);
  check('gate: the 32-step split reports 1 split, 1 tie, 0 clamps',
    p32.gate_splits === 1 && p32.ties_emitted === 1 && p32.gate_clamps === 0,
    JSON.stringify({ s: p32.gate_splits, t: p32.ties_emitted, c: p32.gate_clamps }));
  check('gate: the source TIE survives into the emitted token (the `_` on the first piece)',
    p32.cells[0].tie === true && t32[0].endsWith('_'), t32[0]);
  check('gate: the split is REPORTED with the note named, not silent',
    p32.warnings.some((w) => /TIED CHAIN/.test(w) && w.includes(`step 0 ${PAD}: 32 steps -> 16_ + 16`)),
    JSON.stringify(p32.warnings));

  // 4. THE tail case. After Dark's last pad chord is 24 steps and must take
  //    ":16_" + ":8". Rounding the tail up to a second ":16" would invent a
  //    whole extra bar of pad the song does not have.
  const pad24: SongsterrPart = {
    tuning: PAD_TUNING,
    measures: [
      { signature: [4, 4], voices: [{ beats: [{ notes: CHORD, duration: [1, 1] }] }] },
      { voices: [{ beats: [{ notes: TIED, duration: [1, 2] }, { rest: true, duration: [1, 2] }] }] },
    ],
  };
  const p24 = importSongsterrMelodic(pad24, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  const t24 = p24.notation.split(' ');
  check('gate: the 24-step chord is one source onset of 24 steps',
    p24.cells.length === 1 && p24.cells[0].duration_steps === 24, JSON.stringify(p24.cells));
  const tail24 = String(t24[16]);
  check('gate: 24 steps emits ":16_" then a ":8" TAIL, never a second ":16"',
    t24[0] === `${PAD}:16_` && tail24 === `${PAD}:8` && !tail24.endsWith(':16'),
    `${t24[0]} … ${tail24}`);
  check('gate: the 24-step split reports the real arithmetic in its warning',
    p24.warnings.some((w) => w.includes(`step 0 ${PAD}: 24 steps -> 16_ + 8 (2 tokens, 1 tie)`)),
    JSON.stringify(p24.warnings));
  {
    // The round trip that matters: what we emit has to re-parse to the gate
    // magnitude and tie flag we intended, or apply_pattern authors something
    // else and nothing catches it.
    const rt = parseVoice(p24.notation, 32);
    check('gate: 24-step ROUND TRIP through parseVoice, step 0 = 96 sixths + tie',
      rt[0].gate_sixths === MAX_GATE_STEPS * GATE_SIXTHS_PER_STEP && rt[0].tie === true,
      JSON.stringify({ gate: rt[0].gate_sixths, tie: rt[0].tie }));
    check('gate: 24-step ROUND TRIP, step 16 = 48 sixths and NOT tied',
      rt[16].gate_sixths === 8 * GATE_SIXTHS_PER_STEP && rt[16].tie !== true,
      JSON.stringify({ gate: rt[16].gate_sixths, tie: rt[16].tie }));
    check('gate: 24-step ROUND TRIP, both pieces hold the same 3 pitches',
      JSON.stringify(rt[0].notes) === '[39,51,58]' && JSON.stringify(rt[16].notes) === '[39,51,58]',
      JSON.stringify({ a: rt[0].notes, b: rt[16].notes }));
    check('gate: 24-step ROUND TRIP, the two pieces total the source 24 steps',
      (rt[0].gate_sixths! + rt[16].gate_sixths!) / GATE_SIXTHS_PER_STEP === 24,
      String((rt[0].gate_sixths! + rt[16].gate_sixths!) / GATE_SIXTHS_PER_STEP));
    check('gate: `steps` agrees with `notation` (same gates, same tie)',
      p24.steps[0].gate_sixths === rt[0].gate_sixths && p24.steps[0].tie === true
      && p24.steps[16].gate_sixths === rt[16].gate_sixths && p24.steps[16].tie !== true,
      JSON.stringify({ s0: p24.steps[0], s16: p24.steps[16] }));
  }

  // 5. NO ROOM. The real case is After Dark P1's last piano note: 34 steps
  //    wanted from local step 30, with 2 steps of row left. There is nowhere to
  //    put a re-articulation, so it holds the ceiling and rings past the
  //    boundary — reported, not snapped in silence.
  const noRoom: SongsterrPart = {
    tuning,
    measures: [
      { signature: [4, 4], voices: [{ beats: [{ rest: true, duration: [1, 1] }] }] },
      { voices: [{ beats: [
        { rest: true, duration: [1, 2] }, { rest: true, duration: [1, 4] }, { rest: true, duration: [1, 8] },
        { notes: [{ fret: 3, string: 0 }], duration: [1, 8] },            // beat 7.5 = step 30
      ] }] },
      { voices: [{ beats: [{ notes: [{ fret: 3, string: 0, tie: true }], duration: [1, 1] }] }] },
      { voices: [{ beats: [{ notes: [{ fret: 3, string: 0, tie: true }], duration: [1, 1] }] }] },
    ],
  };
  const nr = importSongsterrMelodic(noRoom, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  const tnr = nr.notation.split(' ');
  check('gate: the no-room note is one 34-step onset at step 30',
    nr.cells.length === 1 && nr.cells[0].step === 30 && nr.cells[0].duration_steps === 34,
    JSON.stringify(nr.cells));
  check('gate: with no room to re-articulate it emits the CLAMPED ceiling, untied',
    tnr[30] === 'g4:16' && tnr[31] === '~', `${tnr[30]} / ${tnr[31]}`);
  check('gate: the clamp is counted apart from a split (1 clamp, 0 splits, 0 ties)',
    nr.gate_clamps === 1 && nr.gate_splits === 0 && nr.ties_emitted === 0,
    JSON.stringify({ c: nr.gate_clamps, s: nr.gate_splits, t: nr.ties_emitted }));
  check('gate: the clamp warning says it rings past the row and names the step',
    nr.warnings.some((w) => /RING PAST/.test(w) && /step 30 g4/.test(w) && /no room to re-articulate before step 32/.test(w)),
    JSON.stringify(nr.warnings));
  check('gate: the clamped note still re-parses to the 96-sixth maximum',
    parseVoice(nr.notation, 32)[30].gate_sixths === MAX_GATE_STEPS * GATE_SIXTHS_PER_STEP,
    String(parseVoice(nr.notation, 32)[30].gate_sixths));

  // 6. The other no-room shape: the landing step is already a DIFFERENT onset.
  //    Driven through layoutMelodicRow directly, because the guard has to hold
  //    for a cell the walk has not reached yet (a row is laid out in step order,
  //    so `row[next] === undefined` alone would happily overwrite it).
  const collide: MelodicCell[] = [
    { step: 0, pitches: [60], token: 'c4', duration_steps: 24 },
    { step: 16, pitches: [62], token: 'd4', duration_steps: 4 },
  ];
  const laid = layoutMelodicRow(collide, 32);
  check('gate: a re-articulation never displaces a real onset (clamps instead)',
    laid.clamps === 1 && laid.splits === 0 && laid.ties === 0
    && laid.row[0]?.gate_steps === MAX_GATE_STEPS && laid.row[0]?.tie === false
    && laid.row[16]?.gate_steps === 4 && JSON.stringify(laid.row[16]?.pitches) === '[62]',
    JSON.stringify({ c: laid.clamps, s: laid.splits, r0: laid.row[0], r16: laid.row[16] }));
  check('gate: renderMelodicRow writes that row as "c4:16 … d4:4"',
    renderMelodicRow(laid.row).split(' ')[0] === 'c4:16' && renderMelodicRow(laid.row).split(' ')[16] === 'd4:4',
    renderMelodicRow(laid.row).slice(0, 40));

  // 7. The opt-out is an OPT-OUT, and it says what it costs.
  const bare = importSongsterrMelodic(pad24, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4, noteLengths: false });
  check('gate: noteLengths:false restores the pitch-only row',
    bare.notation.startsWith(`${PAD} ~`) && !bare.notation.includes(':')
    && bare.notation.split(' ').filter((t) => t === '~').length === 31,
    bare.notation.slice(0, 40));
  check('gate: noteLengths:false zeroes the emit counters (nothing was written)',
    bare.gate_splits === 0 && bare.gate_clamps === 0 && bare.ties_emitted === 0,
    JSON.stringify({ s: bare.gate_splits, c: bare.gate_clamps, t: bare.ties_emitted }));
  check('gate: noteLengths:false WARNS that every note will author one step long',
    bare.warnings.some((w) => /PITCH ONLY/.test(w) && /one step long/.test(w)), JSON.stringify(bare.warnings));
  check('gate: the un-split source length is still in `cells` either way',
    bare.cells[0].duration_steps === 24 && p24.cells[0].duration_steps === 24,
    JSON.stringify({ bare: bare.cells[0].duration_steps, gated: p24.cells[0].duration_steps }));
}

// ── import_songsterr hands the lengths through, over a STUBBED fetch ────
{
  const META = {
    songId: 501859, revisionId: 4102120, image: 'img', title: 'After Dark', artist: 'Mr.Kitty',
    popularTrackDrum: 9,
    tracks: [{ instrumentId: 89, instrument: 'Pad 2 (warm)', name: 'Track 3', hash: 'p' }],
  };
  const CHORD = [{ fret: 9, string: 3 }, { fret: 7, string: 4 }, { fret: 0, string: 5 }];
  const PART = {
    tuning: [63, 58, 54, 49, 44, 39], strings: 6,
    measures: [
      { signature: [4, 4], marker: { text: 'Verse' }, voices: [{ beats: [{ notes: CHORD, duration: [1, 1] }] }] },
      { voices: [{ beats: [{ notes: CHORD.map((n) => ({ ...n, tie: true })), duration: [1, 2] }, { rest: true, duration: [1, 2] }] }] },
    ],
    automations: { tempo: [{ measure: 0, position: 0, bpm: 140 }] },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const s = String(url);
    if (s.includes('/api/meta/')) return { ok: true, status: 200, json: async () => META };
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(PART)).buffer };
  }) as unknown as typeof globalThis.fetch;

  try {
    const r = await executeImportSongsterr({ url: '501859', track: 0, from_measure: 1, to_measure: 2, voice_name: 'synth2' });
    const row = ('mode' in r ? '' : r.voices?.synth2 ?? '').split(' ');
    check('import_songsterr: the pasted-through row carries lengths and the ceiling split',
      row[0] === 'd#2+d#3+a#3:16_' && row[16] === 'd#2+d#3+a#3:8', `${row[0]} … ${row[16]}`);
    check('import_songsterr: melodic.gate_splits / ties_emitted / gate_clamps are reported',
      !('mode' in r) && r.melodic?.gate_splits === 1 && r.melodic?.ties_emitted === 1 && r.melodic?.gate_clamps === 0
      && r.melodic?.note_lengths === true,
      JSON.stringify('mode' in r ? undefined : r.melodic));
    check('import_songsterr: next_step tells the caller the row is paste-ready',
      !('mode' in r) && /NOTE LENGTHS/.test(r.next_step) && /split into tied chains/.test(r.next_step),
      'mode' in r ? '' : r.next_step);
    check('import_songsterr: the row it returns re-parses to the intended gates',
      (() => { const p = parseVoice(('mode' in r ? '' : r.voices?.synth2) ?? '', 32);
        return p[0].gate_sixths === 96 && p[0].tie === true && p[16].gate_sixths === 48 && p[16].tie !== true; })(),
      'mode' in r ? '' : r.voices?.synth2);

    const off = await executeImportSongsterr({ url: '501859', track: 0, from_measure: 1, to_measure: 2, voice_name: 'synth2', note_lengths: false });
    check('import_songsterr: note_lengths:false is an opt-out, and it is flagged',
      !('mode' in off) && (off.voices?.synth2 ?? '').startsWith('d#2+d#3+a#3 ~') && off.melodic?.note_lengths === false
      && /PITCH ONLY/.test(off.next_step),
      JSON.stringify('mode' in off ? undefined : { row: off.voices?.synth2?.slice(0, 20), nl: off.melodic?.note_lengths }));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── planSongChop: the ALIGNED multi-part section chop ──────────────────
//
// The gap this closes: `whole_song` refused a melodic part, so the project chop
// was drum-only and a five-part song had no layout at all. These cover the four
// decisions the chop makes, on synthetic parts so each one is isolated:
//
//   1. ONE set of boundaries for the whole song, never one per part;
//   2. the ceiling (8 patterns x 32 steps = 256 steps = 16 bars) is what a
//      project may hold, and a SHORT section stays short rather than borrowing;
//   3. an over-length section trims SILENT bars, tail first, and only when the
//      trim buys a whole project;
//   4. when neither end is silent, nothing is dropped: it splits evenly.
{
  const SIG: [number, number] = [4, 4];
  const barTable = (n: number, markers: Readonly<Record<number, string>> = {}): MeasureInfo[] =>
    Array.from({ length: n }, (_, i) => ({
      index: i, startBeat: i * 4, signature: SIG,
      ...(markers[i] !== undefined ? { marker: markers[i] } : {}),
    }));
  /** A part that plays 4 onsets in each of the 1-based bars listed. */
  const part = (
    partId: number, label: string, barCount: number,
    markers: Readonly<Record<number, string>>, soundingBars: readonly number[],
  ): ChopPartFlat => ({
    partId, label, melodic: true,
    measures: barTable(barCount, markers),
    sections: Object.entries(markers)
      .map(([k, v]) => ({ name: v, startMeasure: Number(k), startBeat: Number(k) * 4 }))
      .sort((a, b) => a.startMeasure - b.startMeasure),
    onsets: soundingBars.flatMap((b) => [0, 1, 2, 3].map((q) => ({ beat: (b - 1) * 4 + q, pitch: 60 }))),
  });
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

  // 1. THE ALIGNED CHOP. Three parts, two 16-bar sections, and the parts play in
  //    different places. The boundaries must be the SAME for all three: a chop
  //    computed per part would put the bass's project 2 somewhere the pad's is
  //    not, and a foot-switch would land mid-phrase on two tracks out of three.
  {
    const M = { 0: 'Verse', 16: 'Chorus' } as const;
    const p = planSongChop([
      part(0, 'bass', 32, M, range(1, 16)),          // first half only
      part(1, 'lead', 32, M, range(17, 32)),         // second half only
      part(2, 'pad', 32, M, range(1, 32)),           // throughout
    ]);
    check('chop: two marked sections become two projects on the source\'s own boundaries',
      p.projects.length === 2 && p.boundaries.join(',') === '1,17'
      && p.projects[0].from_measure === 1 && p.projects[0].to_measure === 16
      && p.projects[1].from_measure === 17 && p.projects[1].to_measure === 32,
      JSON.stringify(p.projects.map((x) => `${x.name} m${x.from_measure}-${x.to_measure}`)));
    check('chop: EVERY part is accounted for in EVERY project (one shared window set)',
      p.projects.every((x) => x.parts.length + x.silent_parts.length === 3),
      JSON.stringify(p.projects.map((x) => ({ sound: x.parts.map((y) => y.partId), silent: x.silent_parts.map((y) => y.partId) }))));
    check('chop: a part that rests through a project is listed silent, not dropped from the plan',
      p.projects[0].silent_parts.map((x) => x.partId).join(',') === '1'
      && p.projects[1].silent_parts.map((x) => x.partId).join(',') === '0',
      JSON.stringify(p.projects.map((x) => x.silent_parts.map((y) => y.partId))));
    check('chop: each project reports its own step + pattern count',
      p.projects.every((x) => x.bars === 16 && x.steps === 256 && x.patterns === 8),
      JSON.stringify(p.projects.map((x) => ({ b: x.bars, s: x.steps, p: x.patterns }))));
    check('chop: the ceiling is stated in the plan, not left to be rediscovered',
      p.ceiling.max_steps === MAX_PROJECT_STEPS && p.ceiling.max_steps === 256
      && p.ceiling.pattern_slots === 8 && p.ceiling.steps_per_pattern === 32 && p.ceiling.max_bars === 16,
      JSON.stringify(p.ceiling));
    check('chop: a sounding part carries its onset count and pitch range for the binding guard',
      p.projects[0].parts.find((x) => x.partId === 0)?.onsets === 64
      && p.projects[0].parts.find((x) => x.partId === 0)?.low_name === 'c4',
      JSON.stringify(p.projects[0].parts));
  }

  // 2. A SHORT section stays short. Borrowing four bars from the next section to
  //    fill the ceiling would move a foot-switch point off the music.
  {
    const p = planSongChop([part(0, 'a', 24, { 0: 'Verse', 12: 'Chorus' }, range(1, 24))]);
    check('chop: a 12-bar section makes a 12-bar project, not a padded 16',
      p.projects.length === 2 && p.projects.every((x) => x.bars === 12 && x.steps === 192 && x.patterns === 6),
      JSON.stringify(p.projects.map((x) => `${x.bars}b/${x.steps}s`)));
    check('chop: and it SAYS the project is short on purpose',
      p.warnings.some((w) => /use FEWER than the 8 pattern slots/.test(w) && /never padded/.test(w)),
      JSON.stringify(p.warnings));
  }

  // 3. OVER-LENGTH, silent tail. After Dark's Intro in miniature: 20 bars, the
  //    last 4 silent on every part. Trim the tail; it costs nothing.
  {
    const p = planSongChop([
      part(0, 'a', 20, { 0: 'Intro' }, range(1, 16)),
      part(1, 'b', 20, { 0: 'Intro' }, range(1, 16)),
    ]);
    check('chop: an over-length section with a silent TAIL trims the tail and fits one project',
      p.projects.length === 1 && p.projects[0].from_measure === 1 && p.projects[0].to_measure === 16
      && p.projects[0].trimmed?.tail_bars === 4 && p.projects[0].trimmed?.head_bars === 0,
      JSON.stringify(p.projects[0]));
    check('chop: the trim names the bars and says it is lossless in content, not in time',
      p.trims.length === 1 && /tail m17-20/.test(p.trims[0]) && /silent on all 2 selected part\(s\)/.test(p.trims[0])
      && /Lossless in content/.test(p.trims[0]), JSON.stringify(p.trims));
    check('chop: a trim is not a split (nothing was cut in two)', p.splits.length === 0, JSON.stringify(p.splits));
  }

  // 3b. Silence at the HEAD only. A naive "take the first 16" would keep the
  //     four dead bars and throw away four sounding ones.
  {
    const p = planSongChop([part(0, 'a', 20, { 0: 'Verse' }, range(5, 20))]);
    check('chop: silence at the HEAD is trimmed from the head, keeping every sounding bar',
      p.projects.length === 1 && p.projects[0].from_measure === 5 && p.projects[0].to_measure === 20
      && p.projects[0].trimmed?.head_bars === 4 && p.projects[0].trimmed?.tail_bars === 0,
      JSON.stringify(p.projects[0]));
  }

  // 3c. Both ends silent: the TAIL goes first (the marker names where a section
  //     STARTS, and a pickup bar lives at the head), then the head makes up the rest.
  {
    const p = planSongChop([part(0, 'a', 20, { 0: 'Verse' }, range(3, 18))]);
    check('chop: with both ends silent the tail is trimmed first, then the head',
      p.projects.length === 1 && p.projects[0].from_measure === 3 && p.projects[0].to_measure === 18
      && p.projects[0].trimmed?.tail_bars === 2 && p.projects[0].trimmed?.head_bars === 2,
      JSON.stringify(p.projects[0].trimmed));
    check('chop: that trim reports both ends', /tail m19-20/.test(p.trims[0]) && /head m1-2/.test(p.trims[0]), p.trims[0]);
  }

  // 4. NEITHER END SILENT. The case the naive answer gets wrong: there is
  //    nothing free to drop, so nothing is dropped. It splits evenly instead,
  //    and the split is reported as a mid-section foot-switch point.
  {
    const p = planSongChop([
      part(0, 'a', 20, { 0: 'Verse' }, range(1, 20)),
      part(1, 'b', 20, { 0: 'Verse' }, range(1, 20)),
    ]);
    check('chop: an over-length section with NO silent end splits, and loses nothing',
      p.projects.length === 2 && p.trims.length === 0
      && p.projects[0].from_measure === 1 && p.projects[0].to_measure === 10
      && p.projects[1].from_measure === 11 && p.projects[1].to_measure === 20
      && p.bars_planned === 20,
      JSON.stringify({ pr: p.projects.map((x) => `m${x.from_measure}-${x.to_measure}`), planned: p.bars_planned }));
    check('chop: it splits EVENLY (10 + 10), not ceiling-first (16 + 4)',
      p.projects.every((x) => x.bars === 10), JSON.stringify(p.projects.map((x) => x.bars)));
    check('chop: the split names itself a mid-phrase foot-switch point',
      p.splits.length === 1 && /NEITHER end is silent/.test(p.splits[0]) && /nothing is dropped/.test(p.splits[0])
      && /foot-switch points mid-phrase/.test(p.splits[0]), JSON.stringify(p.splits));
    check('chop: the split pieces are named 1/2 and 2/2 under their section',
      p.projects.map((x) => x.name).join(' ') === 'Verse (1/2) Verse (2/2)',
      JSON.stringify(p.projects.map((x) => x.name)));
    check('chop: a split section still reports as ONE source section',
      p.sections.length === 1 && p.sections[0].bars === 20 && p.sections[0].over_ceiling === true
      && p.sections[0].projects === 2, JSON.stringify(p.sections));
  }

  // 5. No markers at all: the chop still answers, in fixed ceiling-sized pieces,
  //    and warns that the boundaries are arithmetic rather than musical.
  {
    const p = planSongChop([part(0, 'a', 40, {}, range(1, 40))]);
    check('chop: a tab with NO section markers still lays out, in ceiling-sized pieces',
      p.projects.length === 3 && p.projects.every((x) => x.steps <= MAX_PROJECT_STEPS)
      && p.projects.map((x) => x.bars).join(',') === '14,13,13',
      JSON.stringify(p.projects.map((x) => `m${x.from_measure}-${x.to_measure}`)));
    check('chop: and it warns the boundaries are arithmetic, not musical',
      p.warnings.some((w) => /NO section markers/.test(w) && /not\s+musical/.test(w)), JSON.stringify(p.warnings));
  }

  // 6. A section every selected part rests through cannot be authored (the
  //    writer refuses an upload with no events), so it is dropped and reported.
  {
    const p = planSongChop([part(0, 'a', 32, { 0: 'Verse', 16: 'Outro' }, range(1, 16))]);
    check('chop: a section no selected part plays in is dropped, and named',
      p.projects.length === 1 && p.dropped_silent.length === 1 && /Outro \(m17-32, 16 bar\(s\)\)/.test(p.dropped_silent[0]),
      JSON.stringify({ pr: p.projects.length, dropped: p.dropped_silent }));
  }

  // 7. starts_silent, the read-back caveat: a stored project decodes pattern 1,
  //    so a project that legitimately opens on rests reads back as "empty".
  {
    const p = planSongChop([part(0, 'a', 16, { 0: 'Verse' }, range(3, 16))]);
    check('chop: starts_silent is true when nothing sounds in the first pattern',
      p.projects[0].starts_silent === true, JSON.stringify(p.projects[0]));
    const q = planSongChop([part(0, 'a', 16, { 0: 'Verse' }, range(1, 16))]);
    check('chop: starts_silent is false when the first pattern has content',
      q.projects[0].starts_silent === false, JSON.stringify(q.projects[0]));
  }

  // 8. A mid-song marker that does not start at measure 1 still leaves the
  //    opening bars addressable rather than silently dropping them.
  {
    const p = planSongChop([part(0, 'a', 24, { 8: 'Verse' }, range(1, 24))]);
    check('chop: bars before the first marker become their own project, not a gap',
      p.projects.length === 2 && p.projects[0].from_measure === 1 && p.projects[0].to_measure === 8
      && p.projects[0].section === '(unmarked)' && p.projects[1].from_measure === 9,
      JSON.stringify(p.projects.map((x) => `${x.section} m${x.from_measure}-${x.to_measure}`)));
  }

  // 9. toChopPart picks the reading off the part's own tuning, exactly as the
  //    import path does, so a drum part and a pitch row plan together.
  {
    const drum = toChopPart(6, 'Drums', {
      tuningFlat: true,
      measures: [{ signature: [4, 4], marker: { text: 'Intro' }, voices: [{ beats: [{ notes: [{ fret: 36 }], duration: [1, 4] }] }] }],
    });
    const pitched = toChopPart(0, 'Bass', {
      tuning: [64, 59, 55, 50, 45, 40],
      measures: [{ signature: [4, 4], voices: [{ beats: [{ notes: [{ fret: 3, string: 5 }], duration: [1, 4] }] }] }],
    });
    check('chop: toChopPart reads a percussion staff as drums and a tuned staff as pitches',
      drum.melodic === false && drum.onsets.length === 1 && drum.onsets[0].pitch === undefined
      && pitched.melodic === true && pitched.onsets[0].pitch === 43,
      JSON.stringify({ drum: drum.onsets, pitched: pitched.onsets }));
    check('chop: a drum part contributes its markers to the shared section set',
      planSongChop([drum, pitched]).projects[0].section === 'Intro',
      JSON.stringify(planSongChop([drum, pitched]).sections));
  }

  // 10. THE BAR-ALIGNED PACKING, which is what `patterns` now means.
  //     `ceil(steps / 32)` is only exact when a bar divides a pattern, and in
  //     4/4 at a 16th grid it does (16 steps, two bars to a pattern), which is
  //     why no song shipped before Schism noticed the difference.
  {
    const eq = (a: readonly number[], b: readonly number[]): boolean => a.join(',') === b.join(',');
    const steps = (sigs: readonly [number, number][], spb = 4, spp = 32): number[] => {
      let beat = 0;
      const ms: MeasureInfo[] = sigs.map((signature, index) => {
        const at = beat;
        beat += (signature[0] * 4) / signature[1];
        return { index, startBeat: at, signature };
      });
      return packPatternsOnBarLines(ms, 0, ms.length - 1, spb, spp).map((w) => w.steps);
    };
    const four = (n: number): [number, number][] => Array.from({ length: n }, () => [4, 4] as [number, number]);
    const rep = (sig: [number, number], n: number): [number, number][] => Array.from({ length: n }, () => sig);

    check('pack: 4/4 at a 16th grid packs two bars to a pattern, which is where the old division was right',
      eq(steps(four(4)), [32, 32]) && eq(steps(four(5)), [32, 32, 16]), JSON.stringify(steps(four(5))));
    check('pack: 7/8 bars are 14 steps, so two fit and a third does not: [28, 14], never a split bar',
      eq(steps(rep([7, 8], 3)), [28, 14]), JSON.stringify(steps(rep([7, 8], 3))));
    check('pack: 5/8 + 7/8 alternating (Schism\'s own riff) packs to a uniform 24',
      eq(steps([[5, 8], [7, 8], [5, 8], [7, 8], [5, 8], [7, 8], [5, 8], [7, 8]]), [24, 24, 24, 24]),
      JSON.stringify(steps([[5, 8], [7, 8], [5, 8], [7, 8], [5, 8], [7, 8], [5, 8], [7, 8]])));
    // 4/4 = 16 steps, 3/8 = 6, 3/4 = 12. Reading them all at the OPENING 4/4
    // would say 48 steps and two patterns of [32, 16]; their own signatures say
    // 34 steps and [22, 12]. Different boundary, different bar.
    check('pack: a bar\'s width comes from its OWN signature, not the song\'s opening one',
      eq(steps([[4, 4], [3, 8], [3, 4]]), [22, 12]), JSON.stringify(steps([[4, 4], [3, 8], [3, 4]])));
    {
      const ws = packPatternsOnBarLines(
        [[6, 8], [3, 8], [3, 4], [6, 8]].map((signature, index) => ({ index, startBeat: index * 3, signature: signature as [number, number] })),
        0, 3, 4, 32);
      check('pack: the windows TILE the range, so every bar lands in exactly one pattern and no boundary is mid-bar',
        ws[0].from_measure === 1 && ws[ws.length - 1].to_measure === 4
        && ws.every((w, i) => i === 0 || w.from_measure === ws[i - 1].to_measure + 1)
        && ws.every((w, i) => w.slot === i + 1),
        JSON.stringify(ws));
    }
    {
      // At 12 steps per quarter a 7/8 bar is 42 steps and a pattern holds 32.
      // That is the grid Schism's briefing rules out for exactly this reason. No
      // split rescues it, so it is emitted flagged rather than silently truncated.
      const ws = packPatternsOnBarLines(
        [{ index: 0, startBeat: 0, signature: [7, 8] as [number, number] }], 0, 0, 12, 32);
      check('pack: a bar WIDER than one pattern is emitted flagged oversize, not truncated',
        ws.length === 1 && ws[0].steps === 42 && ws[0].oversize === true, JSON.stringify(ws));
    }
  }

  // 11. THE CASE THE DIVISION GETS WRONG, in miniature: a section whose STEP
  //     total fits the 256-step ceiling but whose BAR-ALIGNED packing does not
  //     fit 8 patterns. Sixteen 6/8 bars are 192 steps, so `ceil(192/32)` says
  //     6 patterns and it would author as one project; packed on bar lines a
  //     pattern holds two 6/8 bars plus nothing (12 + 12 = 24, and a third bar
  //     would be 36), so it needs 8. Add one 5/4 bar and it needs 9 and splits.
  {
    const sigs: [number, number][] = [...Array.from({ length: 16 }, () => [6, 8] as [number, number]), [5, 4]];
    let beat = 0;
    const ms: MeasureInfo[] = sigs.map((signature, index) => {
      const at = beat;
      beat += (signature[0] * 4) / signature[1];
      return { index, startBeat: at, signature, ...(index === 0 ? { marker: 'Bridge' } : {}) };
    });
    const p = planSongChop([{
      partId: 0, label: 'a', melodic: true, measures: ms,
      sections: [{ name: 'Bridge', startMeasure: 0, startBeat: 0 }],
      onsets: ms.map((m) => ({ beat: m.startBeat, pitch: 60 })),
    }]);
    check('chop: a section that FITS the 256-step ceiling but needs 9 bar-aligned patterns still splits',
      p.projects.length === 2 && p.sections[0].steps === 212 && p.sections[0].steps <= MAX_PROJECT_STEPS
      && p.sections[0].patterns === 9 && p.sections[0].over_ceiling === true,
      JSON.stringify({ projects: p.projects.length, section: p.sections[0] }));
    check('chop: and the split says PATTERNS, not steps, so the reason is legible',
      p.splits.length === 1 && /9 bar-aligned pattern\(s\) against the 8-pattern budget/.test(p.splits[0]),
      JSON.stringify(p.splits));
    check('chop: every project reports its own chain, and each pattern is a whole number of bars',
      p.projects.every((x) => x.pattern_steps.length === x.patterns
        && x.pattern_windows.reduce((s, w) => s + w.bars, 0) === x.bars
        && x.pattern_steps.every((s) => s <= 32)),
      JSON.stringify(p.projects.map((x) => x.pattern_steps)));
    check('chop: a sounding part repeats the chain lengths per TRACK and reports its onsets per pattern',
      p.projects[0].parts[0].pattern_steps.join(',') === p.projects[0].pattern_steps.join(',')
      && p.projects[0].parts[0].pattern_onsets.length === p.projects[0].patterns
      && p.projects[0].parts[0].pattern_onsets.reduce((s, n) => s + n, 0) === p.projects[0].parts[0].onsets,
      JSON.stringify(p.projects[0].parts[0]));
  }

  // 12. THE 4/4 REGRESSION GUARD. Everything shipped before Schism is 4/4 at a
  //     16th grid, where the packing and the old division agree exactly. This is
  //     the check that the fix costs those songs nothing.
  {
    const p = planSongChop([part(0, 'a', 32, { 0: 'Verse', 16: 'Chorus' }, range(1, 32))]);
    check('chop: in plain 4/4 the packing reproduces the old ceil(steps/32) answer exactly',
      p.projects.every((x) => x.patterns === Math.ceil(x.steps / 32) && x.patterns === 8
        && x.uniform_patterns === true && x.pattern_steps.every((s) => s === 32)),
      JSON.stringify(p.projects.map((x) => x.pattern_steps)));
    check('chop: and the plan states the metre is NOT mixed, so max_bars is exact',
      p.ceiling.mixed_metre === false && /same signature, so the bar figure is exact/.test(p.ceiling.note),
      p.ceiling.note);
  }
}

// ── THE SCHISM ACCEPTANCE: 114 patterns, 20 projects ───────────────────
//
// Tool's Schism is the song the bar-aligned packing was built for, and its real
// numbers are the acceptance test. Source: Songsterr `s6700`, revision
// `8009215`, six parts, 238 bars, ten distinct time signatures and 198 bar-to-bar
// metre changes. The metre map, the section markers and each part's sounding bars
// below are that fetch, transcribed run-length so the golden runs offline; the
// briefing is `docs/_private/rig/songs/schism-interview.md`.
//
// The three numbers this pins, all of them measured before the fix and quoted in
// that briefing: the old `ceil(steps / 32)` reported 97 patterns; the true
// bar-aligned count is 114; and the m102-117 Bridge is the one section whose
// under-count changed the PLAN, reading as 8 patterns when it needs 9, so it
// splits and the song costs 20 projects rather than 19.
{
  const METRE_RLE =
    '5/4x2 4/4 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 '
    + '5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 6/8 7/8 6/8 7/8 6/8 7/8 6/8 7/8 5/8 7/8 '
    + '5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 6/8 7/8 6/8 7/8 6/8 7/8 6/8 7/8 4/4 2/4 4/4 2/4 '
    + '4/4 2/4 4/4 3/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 6/8 7/8 6/8 7/8 '
    + '6/8 7/8 6/8 8/8 9/8 5/8 9/8 5/8 9/8 5/8 9/8 5/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 '
    + '6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 6/8x3 3/8 3/4 '
    + '6/8x3 3/8 3/4 6/8x2 2/4 6/8x2 4/4 6/8x2 2/4 6/8x2 2/4 6/8 3/8 6/8x2 7/8 6/8 3/8 6/8x2 7/8 6/8 3/8 6/8 '
    + '7/8 6/8 3/8 5/8 9/8 5/8 9/8 5/8 9/8 5/8 6/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 7/8 5/8 '
    + '7/8 4/4x9';
  /** 0-based measure index → the source's own marker text. */
  const MARKERS: Readonly<Record<number, string>> = {
    0: 'Intro I', 3: 'Intro II - Bass', 11: 'Intro III - with Band', 19: 'Verse 1', 43: 'Bridge',
    51: 'Verse 2', 67: 'Bridge', 75: 'Heavy Part', 85: 'Verse 3', 101: 'Bridge', 117: 'Interlude',
    191: 'Between supposed...', 213: 'Outro',
  };
  /** 1-based bar ranges each part sounds in. Occupancy is all the chop reads. */
  const SOUNDING: Readonly<Record<string, string>> = {
    'Vocals': '20-43,52-67,76-101,160-163,167-168,172-173,177-178,192-195,197-200,202,214-229',
    'Lead Guitar': '1-2,7,11-20,28,32,34-237',
    'Double Track/Delay': '43-51,67-85,101-177,190-237',
    'Bass Overdrive/Whammy': '138-158',
    'Bass': '1-117,128-130,138-178,180-237',
    'Drums': '11-117,183-237',
  };

  const sigs: [number, number][] = [];
  for (const tok of METRE_RLE.split(/\s+/)) {
    const [sig, n] = tok.split('x');
    const [a, b] = sig.split('/').map(Number);
    for (let i = 0; i < (n === undefined ? 1 : Number(n)); i++) sigs.push([a, b]);
  }
  let beat = 0;
  const measures: MeasureInfo[] = sigs.map((signature, index) => {
    const at = beat;
    beat += (signature[0] * 4) / signature[1];
    return {
      index, startBeat: at, signature,
      ...(MARKERS[index] !== undefined ? { marker: MARKERS[index] } : {}),
    };
  });
  const sections = Object.entries(MARKERS)
    .map(([k, name]) => ({ name, startMeasure: Number(k), startBeat: measures[Number(k)].startBeat }))
    .sort((a, b) => a.startMeasure - b.startMeasure);
  const chopParts: ChopPartFlat[] = Object.entries(SOUNDING).map(([label, spec], partId) => ({
    partId, label, melodic: label !== 'Drums', measures, sections,
    onsets: spec.split(',').flatMap((r) => {
      const [lo, hi] = r.split('-').map(Number);
      const out: { beat: number; pitch?: number }[] = [];
      for (let m = lo; m <= (hi ?? lo); m++) out.push({ beat: measures[m - 1].startBeat, ...(label !== 'Drums' ? { pitch: 60 } : {}) });
      return out;
    }),
  }));

  check('schism: the fixture is the real source (238 bars, 10 signatures, 198 metre changes, 13 markers)',
    measures.length === 238 && new Set(sigs.map((s) => s.join('/'))).size === 10
    && sigs.filter((s, i) => i > 0 && s.join('/') !== sigs[i - 1].join('/')).length === 198
    && sections.length === 13,
    JSON.stringify({ bars: measures.length, sigs: new Set(sigs.map((s) => s.join('/'))).size }));

  const p = planSongChop(chopParts);
  const naive = p.projects.reduce((s, x) => s + Math.ceil(x.steps / 32), 0);

  check('schism: 20 PROJECTS, one more than the 19 sections, because a Bridge does not pack into 8 patterns',
    p.projects.length === 20 && p.sections.length === 13,
    JSON.stringify(p.projects.map((x) => `${x.name} m${x.from_measure}-${x.to_measure}`)));
  check('schism: 114 PATTERNS bar-aligned, against the 97 the old ceil(steps/32) reported',
    p.patterns_planned === 114 && p.projects.reduce((s, x) => s + x.patterns, 0) === 114,
    JSON.stringify({ packed: p.patterns_planned, naive_on_packed_projects: naive }));
  check('schism: TWELVE distinct pattern lengths, 10 to 32, which is what the metre map demands',
    p.pattern_lengths.join(',') === '10,12,14,16,18,20,22,24,26,28,30,32' && p.pattern_lengths.length === 12,
    p.pattern_lengths.join(','));
  check('schism: the m102-117 Bridge is the section that splits, 4 + 5 patterns, and nothing is dropped',
    p.projects.filter((x) => x.section === 'Bridge' && x.name.includes('/')).length === 2
    && p.projects.find((x) => x.name === 'Bridge (1/2)' && x.from_measure === 102 && x.to_measure === 109)?.patterns === 4
    && p.projects.find((x) => x.name === 'Bridge (2/2)' && x.from_measure === 110 && x.to_measure === 117)?.patterns === 5
    && p.trims.length === 0 && p.bars_planned === 238,
    JSON.stringify(p.projects.filter((x) => x.section === 'Bridge').map((x) => `${x.name} m${x.from_measure}-${x.to_measure} ${x.patterns}p`)));
  check('schism: that Bridge is exactly where the OLD division under-counted: 228 steps read as 8, needs 9',
    Math.ceil(228 / 32) === 8
    && (p.projects.find((x) => x.name === 'Bridge (1/2)')?.patterns ?? 0)
      + (p.projects.find((x) => x.name === 'Bridge (2/2)')?.patterns ?? 0) === 9,
    JSON.stringify(p.projects.filter((x) => x.name.startsWith('Bridge (')).map((x) => x.pattern_steps)));
  check('schism: the riff sections author as a UNIFORM 24-step chain (5/8 + 7/8 pairs)',
    p.projects.find((x) => x.name === 'Intro II - Bass')?.pattern_steps.join(',') === '24,24,24,24'
    && p.projects.find((x) => x.name === 'Intro II - Bass')?.uniform_patterns === true,
    JSON.stringify(p.projects.find((x) => x.name === 'Intro II - Bass')));
  check('schism: the Interlude needs a genuinely MIXED chain, [24,30,24,30,24,30,24,18]',
    p.projects.find((x) => x.name === 'Interlude (1/4)')?.pattern_steps.join(',') === '24,30,24,30,24,30,24,18'
    && p.projects.find((x) => x.name === 'Interlude (1/4)')?.uniform_patterns === false,
    JSON.stringify(p.projects.find((x) => x.name === 'Interlude (1/4)')?.pattern_steps));
  check('schism: the Outro tail is the twelve-length extreme, a 10-step pattern under a chain of 24s',
    p.projects.find((x) => x.name === 'Outro (1/2)')?.pattern_steps.join(',') === '24,24,24,24,24,24,10',
    JSON.stringify(p.projects.find((x) => x.name === 'Outro (1/2)')?.pattern_steps));
  check('schism: every project fits the 8-pattern budget and every pattern is a whole number of bars',
    p.projects.every((x) => x.patterns <= 8 && x.pattern_steps.every((s) => s > 0 && s <= 32)
      && x.pattern_windows.reduce((s, w) => s + w.bars, 0) === x.bars
      && x.pattern_windows.every((w) => w.oversize !== true)),
    JSON.stringify(p.projects.map((x) => `${x.name}:${x.patterns}`)));
  check('schism: the plan flags the mixed metre so max_bars is not read as the constraint',
    p.ceiling.mixed_metre === true && /CHANGES METRE/.test(p.ceiling.note), p.ceiling.note);
  check('schism: and it says which projects need a mixed chain, citing the hardware that permits it',
    p.warnings.some((w) => /MIXED-length pattern chain/.test(w) && /2026-07-29/.test(w)),
    JSON.stringify(p.warnings.filter((w) => /MIXED/.test(w))));
}

// ── ARTICULATION: what each source marking becomes ─────────────────────
//
// Every fixture below is VERBATIM from a live 2026-07-27 fetch of the
// source-fidelity audit's own corpus, so these are real-source goldens run
// offline. Each block states the song, part and measure it came from.
{
  // 1. SLIDE, the worked example. Schism (s6700) part 3, the whammy part,
  //    measures 138-139 verbatim. That part carries 39 `slide:"legato"` markings
  //    and 38 of them sit on the LOW note of an octave pair whose target is
  //    exactly +12, which is the gesture: pluck the low note, whammy up an
  //    octave, let the octave ring.
  //
  //    The intended authoring is a launch note whose gate reaches PAST the
  //    target's onset (so the target is not heard as a second pluck) and a target
  //    at its full tied length. Gate OVERLAP, not the tie flag: `layoutMelodicRow`
  //    deliberately refuses to tie into a different pitch, and a 130-file factory
  //    census found 279 real notes whose gate runs past the next onset at a
  //    different pitch, so overlap is normal stored content needing no tie.
  const WHAMMY: SongsterrPart = {
    tuning: [43, 38, 33, 26], strings: 4,
    measures: [
      { signature: [6, 8], voices: [{ beats: [
        { duration: [1, 16], velocity: 'mp', notes: [{ fret: 9, string: 0, slide: 'legato' }] },
        { duration: [1, 16], velocity: 'f', notes: [{ fret: 21, string: 0 }] },
        { duration: [1, 8], notes: [{ fret: 21, string: 0, tie: true }] },
        { duration: [1, 8], rest: true, notes: [{ rest: true }] },
        { duration: [1, 16], velocity: 'mp', notes: [{ fret: 12, string: 0, slide: 'legato' }] },
        { duration: [1, 16], velocity: 'f', notes: [{ fret: 24, string: 0 }] },
        { duration: [1, 8], notes: [{ fret: 24, string: 0, tie: true }] },
        { duration: [1, 8], rest: true, notes: [{ rest: true }] },
      ] }] },
      { voices: [{ beats: [
        { duration: [1, 16], velocity: 'mp', notes: [{ fret: 9, string: 0, slide: 'legato' }] },
        { duration: [1, 16], velocity: 'f', notes: [{ fret: 21, string: 0 }] },
        { duration: [1, 8], notes: [{ fret: 21, string: 0, tie: true }] },
        { duration: [1, 8], rest: true, notes: [{ rest: true }] },
        { duration: [1, 16], velocity: 'mp', notes: [{ fret: 14, string: 0, slide: 'legato' }] },
        { duration: [1, 16], velocity: 'f', notes: [{ fret: 26, string: 0 }] },
        { duration: [1, 8], notes: [{ fret: 26, string: 0, tie: true }] },
        { duration: [1, 8], rest: true, notes: [{ rest: true }] },
      ] }] },
    ],
    automations: { tempo: [{ measure: 0, bpm: 107 }] },
  };
  const wf = flattenSongsterrMelodic(WHAMMY);
  check('slide: the octave pair decodes as +12 (43+9 = 52, 43+21 = 64)',
    wf.notes[0].pitch === 52 && wf.notes[1].pitch === 64 && wf.notes[1].pitch - wf.notes[0].pitch === 12,
    JSON.stringify(wf.notes.slice(0, 2).map((n) => n.pitch)));
  check('slide: `legato` is read as a TARGETED slide, so it becomes a legato connection',
    wf.notes[0].legato === 'slide_legato' && wf.legato.slide_legato === 4 && Object.keys(wf.slides_unauthored).length === 0,
    JSON.stringify({ legato: wf.legato, un: wf.slides_unauthored }));

  const wm = importSongsterrMelodic(WHAMMY, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4 });
  const wt = wm.notation.split(' ');
  // 6/8 = 3 quarter beats = 12 steps a measure. The launch 16th is 1 step (6
  // sixths) written; +2 sixths of overlap = 8 sixths = 4/3 of a step. The target
  // is a 16th tied into an eighth = 3 steps = 18 sixths.
  check('slide: THE WORKED EXAMPLE, launch note gate 8/6 and target gate 18/6',
    wm.cells[0].gate_sixths === 8 && wm.cells[1].gate_sixths === 18,
    JSON.stringify(wm.cells.slice(0, 2)));
  check('slide: the launch note gate lands in the intended 7..9 sixths (it must OVERLAP, not abut)',
    (wm.cells[0].gate_sixths as number) > GATE_SIXTHS_PER_STEP && (wm.cells[0].gate_sixths as number) <= 9,
    String(wm.cells[0].gate_sixths));
  check('slide: written as a step FRACTION, so the sub-step overlap survives the notation boundary',
    wt[0] === 'e3:4/3@75' && wt[1] === 'e4:3', `${wt[0]} ${wt[1]}`);
  check('slide: and it re-parses to the same 8 sixths through apply_pattern\'s own parser',
    parseVoice(wm.notation, wm.step_count)[0].gate_sixths === 8
    && parseVoice(wm.notation, wm.step_count)[1].gate_sixths === 18,
    JSON.stringify(parseVoice(wm.notation, wm.step_count).slice(0, 2)));
  check('slide: the launch note is NOT tied (a tie into a different pitch is refused on purpose)',
    parseVoice(wm.notation, wm.step_count)[0].tie === undefined, JSON.stringify(parseVoice(wm.notation, wm.step_count)[0]));
  check('slide: all four launch notes in the two bars connect, none left unconnected',
    wm.articulation.legato_connected === 4 && wm.articulation.legato_unconnected === 0,
    JSON.stringify(wm.articulation));
  check('slide: the connection is REPORTED with the count and the knob that tunes it',
    wm.warnings.some((w) => /LEGATO-connected/.test(w) && /legatoOverlapSixths/.test(w) && /not a tie/.test(w)),
    JSON.stringify(wm.warnings.filter((w) => /LEGATO/.test(w))));
  check('slide: legato_overlap_sixths 0 turns it off and returns the written 6 sixths',
    importSongsterrMelodic(WHAMMY, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4, legatoOverlapSixths: 0 }).cells[0].gate_sixths === GATE_SIXTHS_PER_STEP,
    String(importSongsterrMelodic(WHAMMY, { fromMeasure: 1, toMeasure: 2, stepsPerBeat: 4, legatoOverlapSixths: 0 }).cells[0].gate_sixths));

  // 2. HAMMER-ON / PULL-OFF: the same mechanism, one marking. Schism part 4
  //    (Justin Chancellor's bass) measure 4 verbatim, the opening riff's figure.
  //    `hp` sits on the note the transition STARTS from, decoded from this very
  //    shape: the run is 38[hp] 48[hp] 50, three notes and two transitions, with
  //    the flag on the two that LAUNCH one and never on the 50 that ends the run.
  const BASS: SongsterrPart = {
    tuning: [43, 38, 33, 26], strings: 4,
    measures: [{ signature: [5, 8], voices: [{ beats: [
      { duration: [1, 8], notes: [{ fret: 10, string: 0 }] },
      { duration: [1, 8], notes: [{ fret: 0, string: 1 }] },
      { duration: [1, 8], notes: [{ fret: 9, string: 0 }] },
      { duration: [1, 8], notes: [{ fret: 0, string: 1 }] },
      { duration: [1, 24], notes: [{ fret: 0, string: 1, hp: true }] },
      { duration: [1, 24], notes: [{ fret: 10, string: 1, hp: true }] },
      { duration: [1, 24], notes: [{ fret: 12, string: 1 }] },
    ] }] }],
  };
  const bf = flattenSongsterrMelodic(BASS);
  check('hp: the flag marks the LAUNCH note of each transition, so 38 and 48 carry it and 50 does not',
    bf.notes.filter((n) => n.legato === 'hp').map((n) => n.pitch).join(',') === '38,48'
    && bf.notes[bf.notes.length - 1].pitch === 50 && bf.notes[bf.notes.length - 1].legato === undefined,
    JSON.stringify(bf.notes.map((n) => [n.pitch, n.legato ?? '-'])));
  const bm = importSongsterrMelodic(BASS, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 8 });
  // The overlap is measured against WHERE THE TARGET LANDED, not against the
  // written length: these are 32nd triplets snapped to a 32nd grid, so one pair
  // sits 1 step apart and the next 2, and each launch note reaches its own target
  // plus the 2-sixth overlap. Asserting a fixed gate here would have been asserting
  // the wrong thing, and would break the moment the grid changed.
  const bmSteps = bm.cells.map((c) => c.step);
  check('hp: a hammered pair authors as gate OVERLAP reaching PAST its own target\'s onset',
    bm.cells.filter((c) => c.legato === 'hp').every((c) => {
      const next = bmSteps.find((s) => s > c.step) as number;
      return c.gate_sixths === (next - c.step) * GATE_SIXTHS_PER_STEP + 2;
    }) && bm.articulation.legato_connected === 2,
    JSON.stringify(bm.cells.map((c) => [c.token, c.step, c.gate_sixths, c.legato ?? '-'])));
  check('hp: the un-hammered notes of the same bar keep their written length, untouched',
    bm.cells.filter((c) => c.legato === undefined).every((c) => c.articulations === undefined),
    JSON.stringify(bm.cells.filter((c) => c.legato === undefined).map((c) => [c.token, c.gate_sixths])));

  // 3. PALM MUTE + ACCENT + a sticky dynamic on the SAME notes: the precedence
  //    case, and it is not hypothetical. Schism part 1 (Adam Jones's lead guitar)
  //    measure 12 verbatim: every beat is palm-muted, and the part alternates a
  //    `p` melody note carrying an ACCENT glyph against an `f` pedal note.
  //
  //    This fixture is why an accent must be a BUMP on the dynamic rather than an
  //    absolute level. Read as absolute 120, the accented `p` melody note would
  //    come out LOUDER than the unaccented `f` pedal (120 vs 100), inverting the
  //    tab's own written dynamic. Composed, it lands just under it, which is what
  //    the part does: the pedal drives and the melody note ghosts through it.
  const LEAD: SongsterrPart = {
    tuning: [64, 59, 55, 50, 45, 38], strings: 6,
    measures: [{ signature: [5, 8], voices: [{ beats: [
      { duration: [1, 8], velocity: 'p', palmMute: true, notes: [{ fret: 3, string: 2, accentuated: 1 }] },
      { duration: [1, 8], velocity: 'f', palmMute: true, notes: [{ fret: 0, string: 3 }] },
      { duration: [1, 8], velocity: 'p', palmMute: true, notes: [{ fret: 2, string: 2, accentuated: 1 }] },
      { duration: [1, 8], velocity: 'f', palmMute: true, notes: [{ fret: 0, string: 3 }] },
      { duration: [1, 24], palmMute: true, notes: [{ fret: 0, string: 3, hp: true }] },
      { duration: [1, 24], palmMute: true, notes: [{ fret: 3, string: 3, hp: true }] },
      { duration: [1, 24], palmMute: true, notes: [{ fret: 5, string: 3 }] },
    ] }] }],
  };
  const lm = importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('palm mute: the GATE is capped at 3 sixths (half a step at a 16th grid), from a written 2 steps',
    lm.cells[0].duration_steps === 2 && lm.cells[0].gate_sixths === 3, JSON.stringify(lm.cells[0]));
  check('palm mute: the cap is stated in absolute BEATS, so a 32nd grid gets the same real ring',
    importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 8 }).cells[0].gate_sixths === 6,
    String(importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 8 }).cells[0].gate_sixths));
  check('palm mute: the VELOCITY is trimmed x0.85, so an unmarked muted note is 85 not 100',
    lm.cells[1].velocity === 85, JSON.stringify(lm.cells[1]));
  check('PRECEDENCE, dynamic + accent: `p` (60) + accent 1 (+20) = 80, then the mute x0.85 = 68',
    lm.cells[0].velocity === 68 && lm.cells[0].accent === 1, JSON.stringify(lm.cells[0]));
  check('PRECEDENCE, and the point of it: the ACCENTED `p` note stays QUIETER than the unaccented `f` note',
    (lm.cells[0].velocity as number) < (lm.cells[1].velocity as number),
    `${lm.cells[0].velocity} vs ${lm.cells[1].velocity}`);
  check('PRECEDENCE, damping beats legato: a palm-muted hammer-on gets the SHORT gate, not the overlap',
    lm.cells[4].legato === 'hp' && lm.cells[4].palmMute === true && lm.cells[4].gate_sixths === 3
    && lm.articulation.damping_over_legato >= 1,
    JSON.stringify({ cell: lm.cells[4], report: lm.articulation }));
  check('PRECEDENCE: and the cell SAYS damping won, in words, rather than leaving it to be inferred',
    (lm.cells[4].articulations ?? []).some((a) => /damping beats the legato overlap/.test(a)),
    JSON.stringify(lm.cells[4].articulations));
  check('palm mute: both halves reach the notation row, gate as a fraction and velocity as @vel',
    lm.notation.split(' ')[0] === 'a#3:1/2@68', lm.notation.split(' ').slice(0, 3).join(' '));
  check('palm mute: and both survive the round trip back through apply_pattern\'s parser',
    parseVoice(lm.notation, lm.step_count)[0].gate_sixths === 3 && parseVoice(lm.notation, lm.step_count)[0].velocity === 68,
    JSON.stringify(parseVoice(lm.notation, lm.step_count)[0]));
  check('palm mute: the two halves disable INDEPENDENTLY (gate off keeps the velocity trim)',
    importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, palmMuteGateBeats: 0 }).cells[1].gate_sixths === 12
    && importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, palmMuteGateBeats: 0 }).cells[1].velocity === 85,
    JSON.stringify(importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, palmMuteGateBeats: 0 }).cells[1]));
  check('palm mute: velocity off keeps the short gate (and the accent bump lands unscaled: 60+20 = 80)',
    importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, palmMuteVelocityScale: 1 }).cells[0].gate_sixths === 3
    && importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, palmMuteVelocityScale: 1 }).cells[0].velocity === 80,
    JSON.stringify(importSongsterrMelodic(LEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4, palmMuteVelocityScale: 1 }).cells[0]));
  check('palm mute: the warning names the count, both halves, and the two knobs',
    lm.warnings.some((w) => /DAMPED/.test(w) && /palmMuteGateBeats/.test(w) && /palmMuteVelocityScale/.test(w)),
    JSON.stringify(lm.warnings.filter((w) => /DAMPED/.test(w))));

  // 4. ACCENT on a DRUM part, where velocity is the only channel there is (the
  //    .ncs drum step has no gate and no tie). Redbone (s434040) part 10 measure 1
  //    verbatim: 28 heavy accents (`accentuated: 2`) across the part and not one
  //    per-note ghost, so before this was read its groove imported dead flat.
  const RB_DRUMS: SongsterrPart = {
    tuningFlat: true,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { duration: [1, 2], velocity: 'f', notes: [{ fret: 36, string: 3.5, accentuated: 2 }] },
      { duration: [1, 8], notes: [{ fret: 36, string: 3.5, accentuated: 2 }] },
      { duration: [1, 8], notes: [{ fret: 36, string: 3.5, accentuated: 2 }] },
      { duration: [1, 8], rest: true, notes: [{ rest: true }] },
      { duration: [1, 8], notes: [{ fret: 36, string: 3.5, accentuated: 2 }] },
    ] }] }],
  };
  const rd = importSongsterrDrums(RB_DRUMS, { fromMeasure: 1, toMeasure: 1 });
  check('accent (drums): level 2 is the HEAVY accent, `f` (100) + 34 clamped to 127',
    rd.accents === 4 && rd.voices.kick?.filter((s) => s.on).every((s) => s.velocity === 127),
    JSON.stringify(rd.voices.kick?.filter((s) => s.on).map((s) => s.velocity)));
  check('accent (drums): level 1 is the plain accent and lands on the compiler\'s own 120',
    importSongsterrDrums({
      tuningFlat: true,
      measures: [{ signature: [4, 4], voices: [{ beats: [{ duration: [1, 4], notes: [{ fret: 36, accentuated: 1 }] }] }] }],
    }, { fromMeasure: 1, toMeasure: 1 }).voices.kick?.[0].velocity === 120,
    JSON.stringify(importSongsterrDrums({
      tuningFlat: true,
      measures: [{ signature: [4, 4], voices: [{ beats: [{ duration: [1, 4], notes: [{ fret: 36, accentuated: 1 }] }] }] }],
    }, { fromMeasure: 1, toMeasure: 1 }).voices.kick?.[0]));
  check('accent (drums): reported as a SECOND dynamics channel, not as a replacement for the ladder',
    rd.warnings.some((w) => /per-note ACCENT/.test(w) && /SECOND dynamics channel/.test(w) && /accentBump/.test(w)),
    JSON.stringify(rd.warnings.filter((w) => /ACCENT/.test(w))));

  // 5. STACCATO, and a let-ring chord on the same bar. Redbone part 5 (Electric
  //    Piano 1) measure 6 verbatim: five staccato 8ths over a tied, let-ring chord.
  const EPIANO: SongsterrPart = {
    tuning: [64, 59, 55, 50, 45, 40], strings: 6,
    measures: [
      { signature: [4, 4], voices: [{ beats: [{ duration: [3, 8], letRing: true, notes: [{ fret: 7, string: 1 }, { fret: 8, string: 2 }, { fret: 8, string: 3 }, { fret: 6, string: 4 }] }, { duration: [1, 8], notes: [{ fret: 6, string: 0, staccato: true }] }, { duration: [1, 8], notes: [{ fret: 11, string: 0, staccato: true }] }, { duration: [1, 8], notes: [{ fret: 13, string: 0, staccato: true }] }, { duration: [1, 8], notes: [{ fret: 14, string: 0, staccato: true }] }] }] },
    ],
  };
  const ep = importSongsterrMelodic(EPIANO, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('staccato: a written 8th (2 steps) halves to one step; staccato SCALES, unlike a mute\'s fixed cap',
    ep.cells[1].duration_steps === 2 && ep.cells[1].gate_sixths === 6 && /staccato caps the gate/.test(ep.cells[1].articulations?.[0] ?? ''),
    JSON.stringify(ep.cells[1]));
  // And the LET-RING RUN BOUND, on the same bar: the chord is marked let-ring but
  // the very next beat is NOT, so the player has damped by then and the chord must
  // stop there rather than ringing on under the staccato figure. It keeps its
  // written 6 steps, unchanged. This is the bound that stops one marked bass note
  // ringing for twenty bars, and it is why let-ring is not simply "extend a lot".
  check('let-ring: the extension STOPS where the source stops marking let-ring, not at the cap',
    ep.cells[0].letRing === true && ep.cells[0].duration_steps === 6
    && ep.cells[0].gate_sixths === 6 * GATE_SIXTHS_PER_STEP && ep.cells[0].articulations === undefined,
    JSON.stringify(ep.cells[0]));
  check('staccato: the damping is counted, and no let-ring extension is claimed on this bar',
    ep.articulation.damped === 4 && ep.articulation.let_ring_extended === 0, JSON.stringify(ep.articulation));

  // 6. DEAD notes: the X notehead, a percussive click.
  const DEAD: SongsterrPart = {
    tuning: [64, 59, 55, 50, 45, 40], strings: 6,
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { duration: [1, 4], notes: [{ fret: 5, string: 5, dead: true }] },
      { duration: [1, 4], notes: [{ fret: 5, string: 5 }] },
      { duration: [1, 4], palmMute: true, notes: [{ fret: 5, string: 5, dead: true }] },
      { duration: [1, 4], notes: [{ fret: 5, string: 5 }] },
    ] }] }],
  };
  const dm = importSongsterrMelodic(DEAD, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('dead: a written quarter becomes a 2-sixth click at velocity 70, from an unmarked 100',
    dm.cells[0].duration_steps === 4 && dm.cells[0].gate_sixths === 2 && dm.cells[0].velocity === 70,
    JSON.stringify(dm.cells[0]));
  check('dead: the plain note beside it is untouched (no gate change, no velocity)',
    dm.cells[1].gate_sixths === 24 && dm.cells[1].velocity === undefined, JSON.stringify(dm.cells[1]));
  check('PRECEDENCE, damping does NOT compound: dead + palm mute takes the STRONGEST, not the product',
    dm.cells[2].gate_sixths === 2 && dm.cells[2].velocity === 70, JSON.stringify(dm.cells[2]));
}

// ── dropped_fidelity: what the source carries and we do not ────────────
{
  // Sugar (s560358) part 0 measures 14 and 23 verbatim: a note-level `bend` with
  // its full point list, `beat.text` lyrics, and a `slide:"legato"` that IS
  // carried. Plus a `slide:"downwards"` (no written destination) and one field
  // invented here to prove the report is self-maintaining.
  const SUGAR: SongsterrPart = {
    tuning: [64, 59, 55, 50, 45, 40], strings: 6,
    measures: [
      { signature: [4, 4], voices: [{ beats: [
        { duration: [1, 4], text: { text: 'Need', width: 32 }, notes: [{ fret: 11, string: 2 }] },
        { duration: [1, 4], notes: [{ fret: 9, string: 2, bend: { tone: 100, points: [{ position: 0, tone: 100 }, { position: 30, tone: 0 }, { position: 60, tone: 0 }] } }] },
        { duration: [1, 8], notes: [{ fret: 9, string: 2, slide: 'legato' }] },
        { duration: [1, 8], notes: [{ fret: 8, string: 2 }] },
        { duration: [1, 4], notes: [{ fret: 9, string: 3, slide: 'downwards' }] },
      ] }] },
    ],
  };
  const s = importSongsterrMelodic(SUGAR, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  const d = s.dropped_fidelity;

  check('dropped_fidelity: a field we NEVER read lands in not_parsed, with a count and a first measure',
    d.not_parsed['note.bend']?.count === 1 && d.not_parsed['note.bend']?.first_measure === 1,
    JSON.stringify(d.not_parsed['note.bend']));
  check('dropped_fidelity: and it says what it would TAKE to author, not just that it is missing',
    /continuous-controller field/.test(d.not_parsed['note.bend']?.needs ?? ''),
    d.not_parsed['note.bend']?.needs);
  check('dropped_fidelity: `beat.text` is a second not_parsed field, so the list is per FIELD not per class',
    d.not_parsed['beat.text']?.count === 1, JSON.stringify(d.not_parsed['beat.text']));
  check('dropped_fidelity: a field we read AND authored is absent from BOTH loss buckets',
    d.not_parsed['note.slide=legato'] === undefined && d.parsed_not_authored['note.slide=legato'] === undefined
    && d.not_parsed['beat.duration'] === undefined && d.parsed_not_authored['beat.duration'] === undefined,
    JSON.stringify({ np: Object.keys(d.not_parsed), pna: Object.keys(d.parsed_not_authored) }));
  check('dropped_fidelity: a field we READ and did not author lands in parsed_not_authored, per VALUE',
    d.parsed_not_authored['note.slide=downwards']?.count === 1
    && /READ this and authored nothing/.test(d.parsed_not_authored['note.slide=downwards']?.why ?? ''),
    JSON.stringify(d.parsed_not_authored));
  check('dropped_fidelity: per-VALUE is load-bearing, one slide value carried and another not, same field',
    s.articulations.legato.slide_legato === 1 && s.articulations.slides_unauthored.downwards === 1,
    JSON.stringify(s.articulations));
  check('dropped_fidelity: engraving / already-in-duration fields are listed as not_a_loss, never as a loss',
    d.not_a_loss['beat.dots'] !== undefined || d.not_a_loss['part.strings'] !== undefined,
    JSON.stringify(Object.keys(d.not_a_loss)));
  check('dropped_fidelity: parsed_not_authored is stated FIRST in the warnings, as the indictment it is',
    s.warnings.findIndex((w) => /parsed then NOT authored/.test(w)) >= 0
    && s.warnings.findIndex((w) => /parsed then NOT authored/.test(w)) < s.warnings.findIndex((w) => /not parsed \(/.test(w)),
    JSON.stringify(s.warnings.filter((w) => /DROPPED FIDELITY/.test(w))));

  // THE self-maintaining property, and the reason this is derived rather than
  // written: a field nobody has heard of surfaces on its own. Cast because the
  // whole point is that it is NOT in the source-shape interface.
  const FUTURE = {
    tuning: [64, 59, 55, 50, 45, 40],
    measures: [{ signature: [4, 4], voices: [{ beats: [
      { duration: [1, 4], notes: [{ fret: 5, string: 5 }], quarterToneTrill: 'up' },
    ] }] }],
  } as unknown as SongsterrPart;
  const f = importSongsterrMelodic(FUTURE, { fromMeasure: 1, toMeasure: 1, stepsPerBeat: 4 });
  check('dropped_fidelity: a field the importer has NEVER SEEN reports itself, with no list to update',
    f.dropped_fidelity.not_parsed['beat.quarterToneTrill']?.count === 1
    && f.dropped_fidelity.not_parsed['beat.quarterToneTrill']?.means === 'unknown to this importer',
    JSON.stringify(f.dropped_fidelity.not_parsed));
  check('dropped_fidelity: and the warning flags it as unjudged rather than as a known gap',
    f.warnings.some((w) => /not even in the importer's field table/.test(w)),
    JSON.stringify(f.warnings.filter((w) => /DROPPED/.test(w))));

  // THE GATE (audit section 6.2): every field the real corpus carries must have a
  // declared disposition, so a new source field fails this before it ships.
  const declared = Object.keys(SONGSTERR_FIELDS);
  check('dropped_fidelity: every field in the table is namespaced "<level>.<field>"',
    declared.every((k) => /^(part|measure|voice|beat|note)\.[A-Za-z]+$/.test(k)),
    JSON.stringify(declared.filter((k) => !/^(part|measure|voice|beat|note)\.[A-Za-z]+$/.test(k))));
  // The 40 field names the audit counted across its six-song corpus, minus the
  // one song deliberately dropped from the repertoire. If the source grows a
  // field, `dropped_fidelity` reports it at runtime AND this list is how a
  // reviewer sees it was judged.
  const CORPUS_FIELDS = [
    'part.measures', 'part.tuning', 'part.tuningFlat', 'part.automations', 'part.trackAutomations', 'part.sounds',
    'part.volume', 'part.balance', 'part.newLyrics', 'part.withLyrics', 'part.instrument', 'part.instrumentId',
    'part.strings', 'part.frets', 'part.name', 'part.partId', 'part.songId', 'part.revisionId', 'part.version',
    'measure.voices', 'measure.signature', 'measure.marker', 'measure.rest', 'measure.doubleBarline',
    'voice.beats', 'voice.rest',
    'beat.notes', 'beat.duration', 'beat.rest', 'beat.velocity', 'beat.palmMute', 'beat.letRing', 'beat.graceNote',
    'beat.type', 'beat.dots', 'beat.beamStart', 'beat.beamStop', 'beat.tuplet', 'beat.tupletStart', 'beat.tupletStop',
    'beat.text', 'beat.chord', 'beat.gradualVelocity', 'beat.vibrato', 'beat.vibratoWithTremoloBar', 'beat.tremolo',
    'beat.tapping', 'beat.wahwah', 'beat.brushStroke', 'beat.upStroke',
    'note.fret', 'note.string', 'note.rest', 'note.tie', 'note.ghost', 'note.accentuated', 'note.hp', 'note.dead',
    'note.staccato', 'note.slide', 'note.bend', 'note.vibrato', 'note.wideVibrato', 'note.harmonic',
    'note.harmonicFret', 'note.pickScrape',
  ];
  const missing = CORPUS_FIELDS.filter((k) => SONGSTERR_FIELDS[k] === undefined);
  check(`dropped_fidelity: THE GATE, all ${CORPUS_FIELDS.length} fields the audit corpus carries have a declared disposition`,
    missing.length === 0, `missing: ${missing.join(', ')}`);
  check('dropped_fidelity: every slide value the corpus carries is classified, connects or not',
    ['shift', 'legato', 'downwards', 'below', 'above', 'upwards', 'belowupwards'].every((v) => SONGSTERR_SLIDE_KINDS[v] !== undefined)
    && Object.entries(SONGSTERR_SLIDE_KINDS).filter(([, f2]) => f2.connects).map(([v]) => v).sort().join(',') === 'legato,shift',
    JSON.stringify(Object.fromEntries(Object.entries(SONGSTERR_SLIDE_KINDS).map(([v, f2]) => [v, f2.connects]))));
}

if (failed > 0) { console.error(`\n${failed} check(s) FAILED`); process.exit(1); }
console.log('\nAll song-import golden checks passed.');
