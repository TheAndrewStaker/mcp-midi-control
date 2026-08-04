/**
 * circuit-card-roster.ts — the ONLY hand-carried knowledge in the card map.
 *
 * `scripts/circuit-card-map.ts` reads every fact it can from the `.ncs` files
 * themselves (name, tempo, swing, mixer levels, which tracks carry content,
 * chains, structural validity). Three things are NOT in the file and can only
 * come from a human:
 *
 *   1. WHAT A PROJECT IS. "Sugar 4/10" is a song section; "Granite" is a drum
 *      groove from a purchased pack whose name is a community GUESS at the
 *      source song; "GateTest16" is protocol scratch. The bytes cannot tell
 *      them apart, and conflating the first two is an error this rig's docs
 *      have already made once and had to correct.
 *   2. WHICH BARS a song section covers.
 *   3. THE TEMPO WRITTEN TO THE DEVICE AFTER A CAPTURE WAS TAKEN. See
 *      `postCapture` below — this one is a trap, and it is documented there.
 *
 * Every entry carries `name`, the project's expected embedded name. The
 * generator ASSERTS it against the file and marks the row UNVERIFIED if it
 * disagrees, so a slot that gets overwritten cannot silently keep an old
 * description. That assertion is what keeps a hand-written table from rotting
 * into a lie: the worst it can do is admit it no longer knows.
 *
 * Keys are `"<devicePack>:<deviceProject>"`, both 1-based as the unit displays
 * them.
 */

/**
 * The categories that genuinely exist on this card. The distinction between
 * `song` and `groove-mixwave` is load-bearing: a groove conversion is NOT
 * repertoire, it has no arrangement, and its NAME IS A GUESS.
 * See `docs/_private/rig/groove-library.md`.
 */
export type SlotKind =
  | 'song'                // a real song section, part of a multi-project arrangement
  | 'groove-mixwave'      // drum groove from a purchased Mixwave pack; NAME IS A GUESS
  | 'groove-transcribed'  // drum groove hand-written by ear; name is honest about intent
  | 'test'                // protocol scratch / test project, not music
  | 'unknown';            // on the card, provenance not recorded anywhere

export interface RosterEntry {
  /** Expected embedded name at 0x10. Asserted against the file at generation time. */
  name: string;
  kind: SlotKind;
  /** One line: what this project actually IS, in the maintainer's terms. */
  what: string;
  /** Song title, for the by-song index. Groove conversions deliberately have none. */
  song?: string;
  artist?: string;
  /** Which part of the arrangement, e.g. `P3 of 10`. */
  part?: string;
  /** Source bar range where it is recorded, e.g. `m35-50`. */
  bars?: string;
  /** Link target relative to `docs/_private/rig/`. */
  doc?: string;
  /** The tempo this project is MEANT to run at, where that is recorded. */
  tempoIntent?: number;
  /**
   * A tempo write that landed on the DEVICE after the capture was taken.
   *
   * ⚠ THE TRAP. `circuit-set-project-tempo.ts` writes its `restore-tempo-*`
   * backup BEFORE it patches the byte, so those directories hold the PRE-write
   * image and carry the STALE tempo, not the corrected one (verified: all 25
   * are sha256-identical to the capture). The corrected byte exists ONLY on the
   * device until the next card backup. So the generator can prove MECHANICALLY
   * that a slot was written after the capture (a restore-tempo backup exists
   * for it) but cannot read what it was written TO. That value lives here, with
   * its source, and is labelled in the map as not-yet-re-captured.
   */
  postCapture?: {
    /** The BPM believed to be on the device now. Omit if genuinely unknown. */
    bpm?: number;
    /** Where that number comes from, verbatim enough to check. */
    source: string;
    /** `verified` = a doc records a device read-back. `intended` = the target was recorded, the write is proven, the landed value is not re-read. */
    confidence: 'verified' | 'intended';
  };
  /** Surfaced inline on the slot's own row, never in a footnote. */
  hazard?: string;
}

const song = (
  name: string, songTitle: string, artist: string, part: string,
  doc: string | undefined, tempoIntent: number,
  extra: Partial<RosterEntry> = {},
): RosterEntry => ({
  name, kind: 'song', what: `${songTitle} — ${part}`,
  song: songTitle, artist, part, doc, tempoIntent, ...extra,
});

/**
 * A Mixwave groove conversion. `folder` is the anonymised source folder and
 * `bpm` is the one thing about it that IS source truth (it is in the folder
 * name). The song title next to it is not. Pass `alreadyCorrect` for the two
 * grooves whose source BPM genuinely is 120, so the map does not claim a
 * correction that never happened.
 */
const mixwave = (name: string, folder: string, bpm: number, alreadyCorrect = false): RosterEntry => ({
  name, kind: 'groove-mixwave',
  what: `Drum groove from a purchased Mixwave pack (source ${folder}). **The name is a community GUESS at the source song and can be wrong.** Not repertoire.`,
  doc: 'groove-library.md', tempoIntent: bpm,
  ...(alreadyCorrect ? {} : { postCapture: GROOVE_FIX(bpm) }),
});

const transcribed = (name: string): RosterEntry => ({
  name, kind: 'groove-transcribed',
  what: 'Drum groove hand-written by ear as a "recognizable starter". Not repertoire, not an arrangement.',
  doc: 'groove-library.md',
});

const test = (name: string, what: string): RosterEntry => ({ name, kind: 'test', what });

/** Tempo corrections applied on 2026-07-27 AFTER the 16:53Z capture. See `postCapture`. */
const GROOVE_FIX = (bpm: number): RosterEntry['postCapture'] => ({
  bpm,
  source: 'groove-library.md "The register": the ten attributed grooves were corrected in place on the device 2026-07-27, each verified by read-back',
  confidence: 'verified',
});
const GETHSEMANE_FIX: RosterEntry['postCapture'] = {
  bpm: 72,
  source: 'circuit-pack-inventory.md: "All three surviving Gethsemane projects were set to 72 BPM on 2026-07-27". 72 not the notated 74 is a deliberate ruling — the baked hat clip GHATLIN72 is measured at 72',
  confidence: 'verified',
};
// After Dark's 140 used to live here as a `postCapture` correction. It is gone
// on purpose: the 2026-07-29 relocation re-wrote all five projects and the
// tempo byte now reads 140 in the files themselves, so the map measures it.
const LIKETHAT_FIX: RosterEntry['postCapture'] = {
  bpm: 148,
  source: 'LOOSE-ENDS-2026-07-27.md B5: "Its source is 148 bpm; I measured all five projects storing 120". A restore-tempo backup exists for all five, so a write ran; the landed value is not recorded anywhere',
  confidence: 'intended',
};

export const ROSTER: Readonly<Record<string, RosterEntry>> = {
  // ── Pack 1 · `00_73 pack from CT` — the maintainer's original pack ──────────
  '1:1': test('B0 DELAY TEST', 'Delay scratch project. Not music.'),

  '1:2': song('Gethsemane ACC', 'Gethsemane', 'Sleep Token', 'variant ACC (accurate micro-step placement)', 'circuit-pack-inventory.md', 72, {
    postCapture: GETHSEMANE_FIX,
    hazard: 'One of THREE live Gethsemane variants (projects 2, 3, 9). **Which is current is UNRESOLVED** and none may be retired or overwritten until the maintainer rules. A fourth Gethsemane project (the note-44 trigger for the baked GHATLIN72 hat line) is GENUINELY LOST — it predates every backup.',
  }),
  '1:3': song('Gethsemane ST', 'Gethsemane', 'Sleep Token', 'variant ST (flat-buzz baseline)', 'circuit-pack-inventory.md', 72, {
    postCapture: GETHSEMANE_FIX,
    hazard: 'One of three live Gethsemane variants; which is current is unresolved. Do not retire.',
  }),
  '1:4': song('LT Intro', 'Like That', undefined as unknown as string, 'P1 Intro', 'SONG-COVERAGE-2026-07-27.md', 148, {
    postCapture: LIKETHAT_FIX,
    what: 'Like That — P1 Intro. Built as a micro-step accuracy test as much as a song; whether it is still wanted is an open question for the maintainer.',
  }),
  '1:5': song('LT Verse 1 A', 'Like That', undefined as unknown as string, 'P2 Verse 1 A', 'SONG-COVERAGE-2026-07-27.md', 148, { postCapture: LIKETHAT_FIX }),
  '1:6': song('LT Verse 1 B', 'Like That', undefined as unknown as string, 'P3 Verse 1 B', 'SONG-COVERAGE-2026-07-27.md', 148, { postCapture: LIKETHAT_FIX }),
  '1:7': song('LT Chorus', 'Like That', undefined as unknown as string, 'P4 Chorus', 'SONG-COVERAGE-2026-07-27.md', 148, {
    postCapture: LIKETHAT_FIX,
    hazard: 'Projects 7 and 8 carry the SAME name "LT Chorus". They are different files; tell them apart by slot, not by name.',
  }),
  '1:8': song('LT Chorus', 'Like That', undefined as unknown as string, 'P5 Chorus', 'SONG-COVERAGE-2026-07-27.md', 148, {
    postCapture: LIKETHAT_FIX,
    hazard: 'Same name as project 7. Different file.',
  }),
  '1:9': song('Gethsemane ST2', 'Gethsemane', 'Sleep Token', 'variant ST2 (v2 decayed-roll)', 'circuit-pack-inventory.md', 72, {
    postCapture: GETHSEMANE_FIX,
    hazard: 'One of three live Gethsemane variants; which is current is unresolved. Do not retire.',
  }),

  '1:11': {
    name: 'User Session', kind: 'test',
    what: 'An untouched blank project — byte-identical to the authoring template `samples/circuit-tracks/blank_slot20.ncs`, which is what identifies it. It carries no notes on any track. Effectively a free slot that the device reports as occupied, and (with no decoded erase) the closest thing on this card to reclaimable space.',
    doc: 'circuit-pack-inventory.md',
  },
  '1:12': {
    name: 'User Session', kind: 'unknown',
    what: 'A five-hit kick/snare figure on MIDI 2 (notes 48 and 50, plus a 56 on the downbeat), one unchained pattern. Provenance not recorded anywhere; the shape says scratch, not song.',
    doc: 'circuit-pack-inventory.md',
    hazard: 'The private KIT-PLAN notes describe a "Circuit Project 12, 72 bpm, note 44 once per loop" that triggers the baked `GHATLIN72` hat line. **This is NOT that project** — its MIDI 2 notes were decoded and there is no note 44 anywhere in it. The real one is gone, it predates every backup, and there is nothing to restore. Rebuilding it is one note-44 trigger per loop at 72 BPM on MIDI 2.',
  },

  '1:33': mixwave('The Summoning', 'Song 01', 110),
  '1:34': mixwave('Granite', 'Song 02', 135),
  '1:35': { ...mixwave('The Offering', 'Song 03', 170),
    hazard: '**Name collision.** Pack 5 projects 57-63 are the REAL 7-project The Offering arrangement. This is a groove whose name is a guess. Unrelated builds.' },
  '1:36': mixwave('Take Me Back To', 'Song 04', 170),
  '1:37': mixwave('Aqua Regia', 'Song 05', 150),
  '1:38': { ...mixwave('Ascensionism', 'Song 06', 120, true),
    hazard: 'Reads 120 BY RIGHT — 120 genuinely IS its source BPM, so it was left alone by the 2026-07-27 correction pass. Do not "fix" it, and do not read its 120 as evidence the pass was incomplete.' },
  '1:39': { ...mixwave('Hypnosis', 'Song 07', 120, true),
    hazard: 'Reads 120 BY RIGHT — 120 genuinely IS its source BPM. Do not "fix" it.' },
  '1:40': mixwave('Chokehold', 'Song 08', 135),
  '1:41': mixwave('Vore', 'Song 09', 160),
  '1:42': mixwave('Rain', 'Song 10', 160),

  '1:49': { ...transcribed('TP Breakdown'),
    hazard: '**Three things are called Breakdown.** This is a hand-written Tom Petty starter. Pack 5 projects 35-39 are the imported Breakdown arrangement. `grooves/breakdown__3scene.ncs` on disk is a scene-chain test.' },
  '1:50': transcribed('Back in Black'),
  '1:51': transcribed('Rock and Roll'),
  '1:52': transcribed('We Will Rock You'),
  '1:53': transcribed('Baba ORiley'),
  '1:54': transcribed('Sweet Home Ala'),
  '1:55': transcribed('Sweet Child'),
  '1:56': transcribed('Fortunate Son'),

  '1:64': {
    name: 'OOO', kind: 'unknown',
    what: 'Not a usable project. Its header region is malformed.',
    doc: 'circuit-pack-inventory.md',
  },

  // ── Pack 2 · `00_PACK` — After Dark, Schism, Redbone, Brain Stew, ──────────
  //    What I Got, Billie Jean. Six songs, each on its own row boundary.
  //
  // NOTE ON EVERY NAME BELOW: the generator compares against `readName`, which
  // reads 0x10..0x1f — SIXTEEN characters. Several projects on this card store
  // LONGER names (`BillieJean 4 PreCh2Cho` is 22), so the roster carries the
  // 16-character truncation, not the name the build docs quote. A roster entry
  // holding the full name reads as a NAME MISMATCH even though nothing is wrong.
  //
  // After Dark RELOCATED 8 projects → 5 on 2026-07-29 (the campaign's first
  // condensation) and the names moved from numbers to ROLES at the same time,
  // because the numbers now lie: slot 4 is the old P6 Break and slot 5 the old
  // P7 Bridge. Slots 6-8 were deleted the same day, backed up.
  '2:1': song('AfterDark Intro', 'After Dark', 'Mr.Kitty', 'P1 Intro', 'songs/after-dark.md', 140, {
    bars: 'm1-16',
    hazard: 'SILENT by design — the rig plays nothing here and he plays the intro piano by hand over a silent loop. It looks like a dead project and is not one.',
  }),
  '2:2': song('AfterDark Verse', 'After Dark', 'Mr.Kitty', "P2 Verse 1'", 'songs/after-dark.md', 140, { bars: 'm19-34' }),
  '2:3': song('AfterDark Chorus', 'After Dark', 'Mr.Kitty', 'P3 Chorus (re-stomped for Chorus 2 and 3)', 'songs/after-dark.md', 140, { bars: 'm35-50' }),
  '2:4': song('AfterDark Break', 'After Dark', 'Mr.Kitty', 'P4 Break (was P6)', 'songs/after-dark.md', 140, {
    bars: 'm83-98', hazard: 'Eight bars of NOTHING (the source is tacet) then eight of bass alone. Also the AM4 preset-swap window.',
  }),
  '2:5': song('AfterDark Bridge', 'After Dark', 'Mr.Kitty', 'P5 Bridge (was P7)', 'songs/after-dark.md', 140, { bars: 'm99-114' }),

  // 2:6 / 2:7 / 2:8 ERASED 2026-07-29 with backups (`backup-before-delete` rows
  // in `~/mcp-midi-backups/index.jsonl`): the old After Dark P6/P7/P8, made
  // redundant by the 8→5 relocation. P4/P5/P8 were content-duplicates of
  // P2/P3/P3; P6 and P7 moved up to slots 4 and 5.

  // Schism, BUILT 2026-07-29 (s6700 r8009215), Cyan, tempo 108, PC 72-87.
  // Sixteen projects — the campaign's largest song, and deliberately so: the
  // metre is 5/8+7/8 throughout and nothing repeats cleanly. The TAIL FIX of
  // the same day re-authored slots 17-20/23/24 so a loop wrap closes its riff
  // before restarting. FOUR AM4 presets: A 72-75, B 76-79, C 80-83, D 84-87,
  // HOLD-swapped inside parts 4, 8 and 12.
  '2:9': song('Schism 01 Intro', 'Schism', 'TOOL', 'P1 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, {
    bars: 'm4-19',
    hazard: 'The Play press is the m4 DOWNBEAT, not m1: he plays m1-m3 free against the phones click. Drums enter m11 (one entrance bar) and go full at m12.',
  }),
  '2:10': song('Schism 02 V1a', 'Schism', 'TOOL', 'P2 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm20-31' }),
  '2:11': song('Schism 03 V1b', 'Schism', 'TOOL', 'P3 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm32-43' }),
  '2:12': song('Schism 04 Br1', 'Schism', 'TOOL', 'P4 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm44-51', hazard: 'The AM4 A→B preset HOLD-swap window (no vocal here).' }),
  '2:13': song('Schism 05 V2', 'Schism', 'TOOL', 'P5 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm52-67' }),
  '2:14': song('Schism 06 Br2Hvy', 'Schism', 'TOOL', 'P6 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, {
    bars: 'm68-85', hazard: 'SCENE CHAIN [1-1] → [1-8]: the bridge riff plays TWICE, then the Heavy Part, with no stomp. Lingering past m85 wraps to the bridge, not the Heavy.',
  }),
  '2:15': song('Schism 07 V3', 'Schism', 'TOOL', 'P7 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm86-101' }),
  '2:16': song('Schism 08 Br3', 'Schism', 'TOOL', 'P8 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, {
    bars: 'm102-117', hazard: 'SCENE CHAIN [1-6] → [6-8]: the 9/8+5/8 half arrives at m110 WITHOUT a stomp. Also the B→C preset swap window.',
  }),
  '2:17': song('Schism 09 Int1', 'Schism', 'TOOL', 'P9 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm118-137', hazard: 'Tail-fix boundary (2026-07-29). Linger test: the wrap must close the d4/c4 answer bar before restarting.' }),
  '2:18': song('Schism 10 Int2', 'Schism', 'TOOL', 'P10 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, {
    bars: 'm138-157', hazard: 'Tail-fix boundary. THE MICROFREAK OCTAVE TEST lives here: its first notes are E3 then E4, an octave flick UP. Muddy/low = the pending melodic-octave defect.',
  }),
  '2:19': song('Schism 11 Int3', 'Schism', 'TOOL', 'P11 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm158-174' }),
  '2:20': song('Schism 12 Int4', 'Schism', 'TOOL', 'P12 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, {
    bars: 'm175-191', hazard: 'Drums return at m183 INSIDE the part, no stomp. The C→D preset swap window (18 bars, about 40 s).',
  }),
  '2:21': song('Schism 13 Btwn1', 'Schism', 'TOOL', 'P13 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm192-202' }),
  '2:22': song('Schism 14 Btwn2', 'Schism', 'TOOL', 'P14 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm203-213' }),
  '2:23': song('Schism 15 Out1', 'Schism', 'TOOL', 'P15 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm214-227', hazard: 'Tail-fix boundary. Linger test: the wrap must close the 7/8 chord bar.' }),
  '2:24': song('Schism 16 Out2', 'Schism', 'TOOL', 'P16 of 16', 'songs/schism-build-plan-2026-07-29.md', 108, { bars: 'm228-238', hazard: 'Ends in the song\'s only 4/4 bar. Let it loop and stop by hand.' }),

  // Redbone, BUILT 2026-07-29 (s434040 r7419203), Green, tempo 80, PC 88-95.
  // All plain chains. The first build where the Circuit\'s OWN synth engine is
  // a real voice (Synth 2 = the piano), stored silent since 2026-07-30.
  '2:25': song('Redbone 1 Intro', 'Redbone', 'Childish Gambino', 'P1 of 8', 'songs/redbone.md', 80, {
    bars: 'm1-10', hazard: 'Hand-started. One high d#6 string note holds ALL TEN BARS as a tied chain across five patterns. Whether the device sustains it across a pattern seam is this build\'s one unproven edge.',
  }),
  '2:26': song('Redbone 2 Verse', 'Redbone', 'Childish Gambino', 'P2 of 8', 'songs/redbone.md', 80, {
    bars: 'm11-26', hazard: 'RE-STOMPED at m41 to serve Verse 2 (m41-48); stomp out after 8 bars.',
  }),
  '2:27': song('Redbone 3 PreCho', 'Redbone', 'Childish Gambino', 'P3 of 8', 'songs/redbone.md', 80, { bars: 'm27-40' }),
  '2:28': song('Redbone 4 PreCh2', 'Redbone', 'Childish Gambino', 'P4 of 8', 'songs/redbone.md', 80, {
    bars: 'm49-55', hazard: 'A 7-BAR loop: the short final pattern is 16 steps. It must not feel like a dropped beat; the next stomp lands m56 exactly.',
  }),
  '2:29': song('Redbone 5 Chorus', 'Redbone', 'Childish Gambino', 'P5 of 8', 'songs/redbone.md', 80, { bars: 'm56-71', hazard: 'The AM4 A→B preset-swap window (16 bars).' }),
  '2:30': song('Redbone 6 Bridge', 'Redbone', 'Childish Gambino', 'P6 of 8 (Bridge A)', 'songs/redbone.md', 80, { bars: 'm72-83' }),
  '2:31': song('Redbone 7 Bridge', 'Redbone', 'Childish Gambino', 'P7 of 8 (Bridge B)', 'songs/redbone.md', 80, {
    bars: 'm84-95', hazard: 'The strings note at m93 re-swells at the m94 seam (the writer\'s cyclic tie rule cannot carry it into a different-pitched pattern head). Known, accepted.',
  }),
  '2:32': song('Redbone 8 Outro', 'Redbone', 'Childish Gambino', 'P8 of 8', 'songs/redbone.md', 80, {
    bars: 'm96-107', hazard: 'Lingering replays the m107 ending figure (the "Amber trade"). Same re-swell at the m106 seam as slot 31.',
  }),

  // Brain Stew, BUILT 2026-07-29 (s8644 r7493187), Yellow, tempo 76, PC 96-101.
  '2:33': song('BrainStew 1 Solo', 'Brain Stew', 'Green Day', 'P1 of 6', 'songs/brain-stew.md', 76, {
    bars: 'm1-12', hazard: 'A SILENT looping project by design (the solo-intro count-in pattern): he plays the riff and verse 1 alone for 12 bars. Press Play on his own downbeat; stomp during bars 11-12 to land m13 exactly.',
  }),
  '2:34': song('BrainStew 2 Band', 'Brain Stew', 'Green Day', 'P2 of 6', 'songs/brain-stew.md', 76, { bars: 'm13-24' }),
  '2:35': song('BrainStew 3 Chor', 'Brain Stew', 'Green Day', 'P3 of 6', 'songs/brain-stew.md', 76, {
    bars: 'm25-28 AND m37-40', hazard: 'RE-STOMPED for chorus 2 at m37. One 2-bar cell, loops.',
  }),
  '2:36': song('BrainStew 4 Vers', 'Brain Stew', 'Green Day', 'P4 of 6 (Verse 3)', 'songs/brain-stew.md', 76, { bars: 'm29-36' }),
  '2:37': song('BrainStew 5 Vers', 'Brain Stew', 'Green Day', 'P5 of 6 (Verse 4)', 'songs/brain-stew.md', 76, { bars: 'm41-48', hazard: 'The AM4 A→B preset-swap window (25 s at 76).' }),
  '2:38': song('BrainStew 6 Outr', 'Brain Stew', 'Green Day', 'P6 of 6', 'songs/brain-stew.md', 76, {
    bars: 'm49-63', hazard: 'The Hydrasynth fuzz bass enters here. The m61 ring-out RE-SWELLS at m63 with the final crash (the device\'s tie rule cannot carry it across that seam) — expected, not a fault. Lingering replays the whole 15-bar outro.',
  }),

  // What I Got, BUILT 2026-07-29/30 (s211 r6610547), Orange, tempo 96, PC 104-112.
  // The campaign\'s first UNION drum lane (p14 kit ∪ p15 programming, 555
  // loudest-wins folds, six velocity levels).
  '2:41': song('WhatIGot 1 Intro', 'What I Got', 'Sublime', 'P1 of 9', 'songs/what-i-got.md', 96, {
    bars: 'm1-5', hazard: 'Hand-started, and bar 1 is a HALF BAR (the tab opens 2/4): the beat picks up mid-bar-2. Press Play on his own downbeat.',
  }),
  '2:42': song('WhatIGot 2 Verse', 'What I Got', 'Sublime', 'P2 of 9 (Verse 1)', 'songs/what-i-got.md', 96, { bars: 'm6-17' }),
  '2:43': song('WhatIGot 3 Solo', 'What I Got', 'Sublime', 'P3 of 9', 'songs/what-i-got.md', 96, { bars: 'm18-21', hazard: 'The MicroFreak whistle rides m19 — one bar, which is all the tab carries.' }),
  '2:44': song('WhatIGot 4 Verse', 'What I Got', 'Sublime', 'P4 of 9 (Verse 2)', 'songs/what-i-got.md', 96, { bars: 'm22-33', hazard: 'Bud Gaugh\'s kit joins the programmed loop here — the union lane\'s density step.' }),
  '2:45': song('WhatIGot 5 Choru', 'What I Got', 'Sublime', 'P5 of 9 (Chorus)', 'songs/what-i-got.md', 96, { bars: 'm34-41', hazard: 'The AM4 A→B preset-swap window (8 bars = 20 s, the calmest boundary).' }),
  '2:46': song('WhatIGot 6 Verse', 'What I Got', 'Sublime', 'P6 of 9 (Verse 3)', 'songs/what-i-got.md', 96, { bars: 'm42-49' }),
  '2:47': song('WhatIGot 7 Inter', 'What I Got', 'Sublime', 'P7 of 9 (Interlude)', 'songs/what-i-got.md', 96, {
    bars: 'm50-55', hazard: 'The DJ stab is the Circuit\'s OWN Synth 2, stored silent — raise the fader or the interlude has no hook.',
  }),
  '2:48': song('WhatIGot 8 Choru', 'What I Got', 'Sublime', 'P8 of 9 (Chorus 2)', 'songs/what-i-got.md', 96, { bars: 'm56-63', hazard: 'Through-composed: eight distinct bars, no loop. Lingering replays all of it.' }),
  '2:49': song('WhatIGot 9 Outro', 'What I Got', 'Sublime', 'P9 of 9', 'songs/what-i-got.md', 96, { bars: 'm64-67', hazard: 'Lingering replays the 4-bar close. The tab\'s last four empty bars are not stored.' }),

  // Billie Jean, BUILT 2026-07-30 (s10586 r8048414), Pink, tempo 117, PC 120-127.
  // All plain chains. NOTE the stored names run to 22 characters; the roster
  // holds the 16-character truncation the generator actually reads.
  '2:57': song('BillieJean 1 Gro', 'Billie Jean', 'Michael Jackson', 'P1 of 8 (Groove)', 'songs/billie-jean.md', 117, {
    bars: 'm1-34 and m55-74 (one 2-bar cell, loops)',
    hazard: 'Hand-started. THE beat: kick 1&3, snare 2&4, straight 8th hats, maracas every bar (note 82 — kit 40 needs that pad). The m34/m74 ghost-snare drags are NOT in the loop.',
  }),
  '2:58': song('BillieJean 2 Pre', 'Billie Jean', 'Michael Jackson', 'P2 of 8 (Pre-Chorus 1)', 'songs/billie-jean.md', 117, { bars: 'm35-42', hazard: 'Raise Synth 2 for the Rhodes; the MicroFreak answers with the m36/m40 brass licks.' }),
  '2:59': song('BillieJean 3 Cho', 'Billie Jean', 'Michael Jackson', 'P3 of 8 (Chorus 1)', 'songs/billie-jean.md', 117, { bars: 'm43-54', hazard: 'Chorus CLAPS arrive on SPD-SX note 51 — kit 40 needs a clap pad there, and Sugar deliberately folds its claps onto the snare instead.' }),
  '2:60': song('BillieJean 4 Pre', 'Billie Jean', 'Michael Jackson', 'P4 of 8 (Pre-Chorus 2 into Chorus)', 'songs/billie-jean.md', 117, {
    bars: 'm75-90', hazard: 'ONE stomp carries pre-chorus INTO chorus at bar 9 (m83, the crash lands it). The AM4 A→B swap window, 16 bars = 32 s.',
  }),
  '2:61': song('BillieJean 5 Cho', 'Billie Jean', 'Michael Jackson', 'P5 of 8 (Chorus 2b)', 'songs/billie-jean.md', 117, {
    bars: 'm91-102', hazard: 'At the m94→m95 seam the tied brass note is STORED as a doubled 16th re-articulation (the named tie fallback). If it reads as a stutter, that is the known one.',
  }),
  '2:62': song('BillieJean 6 Int', 'Billie Jean', 'Michael Jackson', 'P6 of 8 (Interlude)', 'songs/billie-jean.md', 117, { bars: 'm103-114', hazard: 'Claps DROP OUT m103-110 and return m111 — the breakdown is real, not a defect.' }),
  '2:63': song('BillieJean 7 Cho', 'Billie Jean', 'Michael Jackson', 'P7 of 8 (Chorus 3)', 'songs/billie-jean.md', 117, { bars: 'm115-126', hazard: 'The densest strings of the song (the tremolo-region bars).' }),
  '2:64': song('BillieJean 8 Out', 'Billie Jean', 'Michael Jackson', 'P8 of 8 (Outro)', 'songs/billie-jean.md', 117, {
    bars: 'm127-140', hazard: 'The string vamp loops in whole 2-bar cycles — linger forever. The record\'s fade is NOT authored: end it by hand.',
  }),

  // ── Pack 3 · `01_PACK` — the disposable test pack ──────────────────────────
  '3:1': {
    name: 'MetreTest A', kind: 'test',
    what: 'Mixed-length pattern-chain hardware test (lengths 24/24/30/18, one hit per pattern, Drum 1 + Synth 1 chained 1-4). **PASSED BY EAR 2026-07-29** (HW-CIRCUIT-008): a chained pattern advances at its OWN length, not on a 32-step boundary, and two tracks with matching length sequences stay together. Test B (project 2) passed the same day, so this is now a SPENT throwaway and the slot is reclaimable.',
    tempoIntent: 60,
    postCapture: { bpm: 60, source: 'circuit-metre-test-a.ts: the test is designed at 60 bpm so a step is 250 ms; circuit-set-project-tempo.ts --pack 3 --slot 1 --bpm 60', confidence: 'intended' },
    hazard: 'Written AFTER the capture. Pack 3 reads 0 of 64 occupied in the backup and is described elsewhere as "the only free pack on the card" — **it is no longer empty**, and this project has never been backed up.',
  },
  '3:2': {
    name: 'MetreTest B', kind: 'test',
    what: 'Mixed lengths ACROSS tracks (Drum 1 at 24/24/30/18 against Synth 1 at 18/30/24/24, both totalling 96 steps so the tracks must re-meet each cycle; one hit per pattern; both chained 1-4). **PASSED BY EAR 2026-07-29** (HW-CIRCUIT-009): all six predicted events per 24-click cycle fired, so two tracks holding DIFFERENT lengths advance independently AND do not drift. Answered what A could not. Spent throwaway; the slot is reclaimable.',
    tempoIntent: 60,
    postCapture: { bpm: 60, source: 'circuit-metre-test-b.ts writes the tempo byte at author time rather than correcting it afterwards, and the read-back asserts it; re-read 2026-07-29 from a fresh process past the manifest-flush window as 60', confidence: 'verified' },
    hazard: 'Written 2026-07-29, after the capture, so it is not in the backup. Drum 1 is bound to pool slot 1 `00_sidestick.wav`, read off the device rather than assumed, because a drum track pointed at an empty slot is silent and Pack 3 holds almost nothing.',
  },

  // ── Pack 4 · `02_PACK` ─────────────────────────────────────────────────────
  '4:1': {
    name: 'Sugar 2/10', kind: 'test',
    what: 'Staging copy of Sugar 2/10 from the 2026-07-26 mixer-level differential capture — the **before** image, synth levels at the factory 100/100. Byte-identical to `pack5-proj47-before.ncs` and `restore-pack5-proj47.ncs`, which is what identifies it (the pack inventory records its provenance as unknown; sha256 says otherwise).',
    doc: 'circuit-pack-inventory.md',
    hazard: '**Four projects on this card are named "Sugar 2/10"** (Pack 4 projects 1 and 2, Pack 5 projects 7 and 47) and no two are identical. Diff before reclaiming any of them; the name will not tell you which is live. The live one is Pack 5 project 47.',
  },
  '4:2': {
    name: 'Sugar 2/10', kind: 'test',
    what: 'Staging copy of Sugar 2/10 from the same 2026-07-26 experiment — the **silenced** image, both synth levels written to 0. Byte-identical to `pack5-proj47-silenced.ncs`.',
    doc: 'circuit-pack-inventory.md',
    hazard: 'See project 1. Four distinct files share this name across the card.',
  },

  // Smooth (with the Havana section inside it), BUILT 2026-07-30 (s17608
  // r7965244), Sand, tempo 116, PC 72-84. The first song on Pack 4. Organ →
  // MIDI 1, piano → Synth 2, horns → Synth 1; the drum lane is a FOUR-PART
  // Latin union (kit + timbales + congas + guiro) folded to the SPD-SX 9-role
  // map. THREE AM4 presets: A 73-76, B 77-80, C 81-84; slot 9 hand-started.
  '4:9': song('Smooth 1 Intro', 'Smooth', 'Santana feat. Rob Thomas', 'P1 of 13', 'songs/smooth.md', 116, {
    bars: 'm1-9', hazard: 'Hand-started, and bar 1 IS the pickup roll (toms + snare + timbales). Press Play on his own downbeat.',
  }),
  '4:10': song('Smooth 2 Verse1', 'Smooth', 'Santana feat. Rob Thomas', 'P2 of 13', 'songs/smooth.md', 116, { bars: 'm10-25 (organ pickup at m25)' }),
  '4:11': song('Smooth 3 PreChor', 'Smooth', 'Santana feat. Rob Thomas', 'P3 of 13 (Pre-Chorus 1)', 'songs/smooth.md', 116, {
    bars: 'm26-35', hazard: 'The MicroFreak organ pads arrive here — 29 notes, the ONLY organ in the song.',
  }),
  '4:12': song('Smooth 4 Cho1Int', 'Smooth', 'Santana feat. Rob Thomas', 'P4 of 13 (Chorus 1 into Interlude)', 'songs/smooth.md', 116, {
    bars: 'm36-47', hazard: 'One stomp carries Chorus 1 INTO the interlude at bar 9. At the m43→m44 seam a held horn stack re-articulates as a doubled 16th (the stored tie fallback).',
  }),
  '4:13': song('Smooth 5 Verse2', 'Smooth', 'Santana feat. Rob Thomas', 'P5 of 13', 'songs/smooth.md', 116, { bars: 'm48-63', hazard: 'The AM4 A→B preset-swap window.' }),
  '4:14': song('Smooth 6 PreChor', 'Smooth', 'Santana feat. Rob Thomas', 'P6 of 13 (Pre-Chorus 2)', 'songs/smooth.md', 116, { bars: 'm64-73' }),
  '4:15': song('Smooth 7 Chorus2', 'Smooth', 'Santana feat. Rob Thomas', 'P7 of 13', 'songs/smooth.md', 116, { bars: 'm74-82', hazard: 'Ends on a triplet turnaround fill, snapped to the grid — it still has to throw him into the solo.' }),
  '4:16': song('Smooth 8 SoloA', 'Smooth', 'Santana feat. Rob Thomas', 'P8 of 13', 'songs/smooth.md', 116, { bars: 'm83-98', hazard: 'A fully authored bed, no loops — the kit varies every few bars like the record. Same horn tie fallback at the m55→m56 seam class.' }),
  '4:17': song('Smooth 9 SoloCho', 'Smooth', 'Santana feat. Rob Thomas', 'P9 of 13 (Solo into Chorus 3)', 'songs/smooth.md', 116, {
    bars: 'm99-108', hazard: 'Stomping in lands m99, TWO BARS before Chorus 3: stomp on the turnaround. The B→C preset swap happens while he sings Chorus 3.',
  }),
  '4:18': song('Smooth 10 Havana', 'Havana', 'Camila Cabello feat. Young Thug', 'the Havana section, INSIDE Smooth', 'songs/smooth.md', 116, {
    bars: 'hand-authored, no source bars — the plan\'s §H rows ARE the record',
    hazard: 'THE ONLY FULLY HAND-AUTHORED PROJECT ON THE CARD. Its riff pitches are our habanera realization of the researched changes, NOT a transcription: the pitch oracle is his MuseScore sheet and is still owed. It runs at Smooth\'s 116 in half-time, not Havana\'s own 105. Synth 2 wants a SUB patch here, not the piano.',
  }),
  '4:19': song('Smooth 11 Outro1', 'Smooth', 'Santana feat. Rob Thomas', 'P11 of 13', 'songs/smooth.md', 116, { bars: 'm109-120', hazard: 'Stomping OUT of Havana into this slot IS the whole-step lift, Gm up to Am.' }),
  '4:20': song('Smooth 12 Outro2', 'Smooth', 'Santana feat. Rob Thomas', 'P12 of 13', 'songs/smooth.md', 116, {
    bars: 'm121-132', hazard: 'At the very end a held horn chord is cut by the slot boundary about 2 beats early — the one truncation the build flagged as possibly audible.',
  }),
  '4:21': song('Smooth 13 Outro3', 'Smooth', 'Santana feat. Rob Thomas', 'P13 of 13', 'songs/smooth.md', 116, { bars: 'm133-144', hazard: 'The song ends itself: ghost snare rolls, final crash, guiro and piano close, then a silent ring-out bar.' }),

  // Love Song, BUILT 2026-07-30 (s671 r3982169), Teal, tempo 69, PC 88-92.
  // The campaign\'s first ZERO-mid-song-preset-swap build: ONE AM4 preset covers
  // it, slot 25 hand-started. Synth 1 and MIDI 1 are EMPTY by his split.
  '4:25': song('Love Song 1 Intr', 'Love Song', '311', 'P1 of 5', 'songs/love-song.md', 69, {
    bars: 'm1-9', hazard: 'Hand-started. Bar 1 IS the half-bar snare-drag pickup, and the drag is SMEARED by the 16th grid (the build\'s one named feel cost).',
  }),
  '4:26': song('Love Song 2 Vrs1', 'Love Song', '311', 'P2 of 5 (Verse 1 into Interlude)', 'songs/love-song.md', 69, { bars: 'm10-21', hazard: 'One stomp carries Verse 1 into the ride-led interlude at bar 9.' }),
  '4:27': song('Love Song 3 Vrs2', 'Love Song', '311', 'P3 of 5 (Verse 2 into Chorus 1)', 'songs/love-song.md', 69, { bars: 'm22-36', hazard: 'Ends on the m36 kick-accent turnaround that throws him into the solo.' }),
  '4:28': song('Love Song 4 Solo', 'Love Song', '311', 'P4 of 5 (Solo into Verse 3)', 'songs/love-song.md', 69, {
    bars: 'm37-52', hazard: 'THE MONEY MOMENT: crash ring at m45, TWO SILENT DRUM BARS at m46-47 (the tab\'s own breakdown), then the smeared drag re-entry at m48. Linger the silence with the Synth 2 fader up.',
  }),
  '4:29': song('Love Song 5 Chor', 'Love Song', '311', 'P5 of 5 (Chorus 2)', 'songs/love-song.md', 69, { bars: 'm53-61', hazard: 'Crash-stop hit at m60 then a silent ring-out bar. The song ends itself.' }),

  // No Diggity, BUILT 2026-07-30 (HYBRID: hand-authored hook + s287014 r3656036
  // drums), Rose, tempo 89, PC 96-99. FOUR jam states, not a chart. ONE AM4
  // preset; slot 33 hand-started at pack load, so scene 1 is the RE-ENTRY.
  '4:33': song('NoDiggity 1 Groo', 'No Diggity', 'Blackstreet', 'P1 of 4 (Groove)', 'songs/no-diggity.md', 89, {
    bars: 'm1-4', hazard: 'THE HOOK IS THE HYDRASYNTH (ch1), not the Circuit: Synth 1 is stored silent and the riff must sound from the first Play with NO fader move. If it does not, check the Hydra before anything else. Key is F# minor and his ear is the final oracle.',
  }),
  '4:34': song('NoDiggity 2 Hook', 'No Diggity', 'Blackstreet', 'P2 of 4 (Hook)', 'songs/no-diggity.md', 89, { bars: 'm29-32', hazard: 'Same riff, snare drops out. Which of 33/34 serves verse vs hook is his call live; swapping them is a rename.' }),
  '4:35': song('NoDiggity 3 Drop', 'No Diggity', 'Blackstreet', 'P3 of 4 (Drop)', 'songs/no-diggity.md', 89, {
    bars: 'm41-44', hazard: 'The beat CUTS for three bars (the tab\'s own all-rest bars) and the riff walks alone, then a kick-snare-kick fill throws back in. Stomp out ON the fill; linger and it loops deliberately.',
  }),
  '4:36': song('NoDiggity 4 HeyY', 'No Diggity', 'Blackstreet', 'P4 of 4 (Hey-Yo)', 'songs/no-diggity.md', 89, { bars: 'm89-92', hazard: 'Kick-only chant bed, riff OUT. Stomping to slot 33 is the song\'s own re-entry.' }),

  // ── Pack 5 · `03_PACK` — the song pack ─────────────────────────────────────
  // Re-authored from source (s403 r8042866) IN PLACE 2026-07-30, Peach, PC 64-69,
  // zero deletes. The kit is part 8 at this revision, NOT the old part 7. Each
  // project also carries his hand-authored MIDI 1 E3+B3 drone (kept by his call,
  // carried byte-faithfully from the pre-re-author card).
  //
  // NAMES ARE THE 16-CHARACTER TRUNCATION. These projects store 20-character
  // names (`Stranglehold 1 Intro`) but the generator reads 0x10..0x1f, so the
  // roster must carry what `readName` returns or every row reads NAME MISMATCH.
  '5:1': song('Stranglehold 1 I', 'Stranglehold', 'Ted Nugent', 'P1 Intro', 'songs/stranglehold.md', 72, {
    bars: 'm1-8',
    hazard: 'Hand-started (his bar 1); the kit answers at bar 6. HIS HAND-AUTHORED MICROFREAK DRONE (a held E3+B3 on MIDI 1) plays under all six projects from the first Play press. It is NOT in the source, it is his, and nothing listened on ch3 until 2026-07-25, so he has probably never heard it.',
  }),
  '5:2': song('Stranglehold 2 M', 'Stranglehold', 'Ted Nugent', 'P2 Main (the workhorse vamp)', 'songs/stranglehold.md', 72, { bars: 'm9-52, 117-120, 129-144' }),
  '5:3': song('Stranglehold 3 B', 'Stranglehold', 'Ted Nugent', 'P3 BassSolo', 'songs/stranglehold.md', 72, { bars: 'm33-36', hazard: 'The ride groove now runs the full 4-bar cycle WITH its exit fill; the entry crash returns every 4 bars — that is the loop, not a stutter.' }),
  '5:4': song('Stranglehold 4 S', 'Stranglehold', 'Ted Nugent', 'P4 Solo3 (58-bar jam)', 'songs/stranglehold.md', 72, {
    bars: 'm53-110', hazard: 'The AM4 A→B HOLD-swap window — 58 bars, so the swap costs nothing. Open question by ear: four variations every 4 bars against the record\'s 8-to-16 bar spacing. A sparser chain is a one-slot re-author.',
  }),
  '5:5': song('Stranglehold 5 B', 'Stranglehold', 'Ted Nugent', 'P5 Bridge (both passages)', 'songs/stranglehold.md', 72, { bars: 'm111-116, 121-128', hazard: 'The one place the feel is approximated: the tab\'s triplet snare rolls are straightened onto the 16th grid.' }),
  '5:6': song('Stranglehold 6 O', 'Stranglehold', 'Ted Nugent', 'P6 Outro (ends itself)', 'songs/stranglehold.md', 72, { bars: 'm145-152', hazard: 'Hat shuffle, then TWO SILENT BARS, then the final crash. Let it ring and press Stop.' }),

  // 5:7 ERASED 2026-07-30 on the maintainer's authorization, after the byte census
  // settled what it was: an AUDIBLE stray, not a duplicate (its synths read 10/20,
  // and 136 of its 138 differing bytes were Synth 1 note data left over from before
  // project 47 was rebound from part 9 "Keyboard #3" to part 6 "Sub Bass"). Its bytes
  // survive in card-backup-2026-07-29 and in the tool's own pre-delete backup, so the
  // slot is now genuinely free: stomping past Stranglehold P6 lands on silence.

  // 5:8 ERASED 2026-07-30 with a backup: the old `Amber P1`, made redundant by
  // the 5→4 from-source re-author (the campaign's FIRST from-source rebuild).
  //
  // Amber, RE-AUTHORED 2026-07-29 (s24430 r3852308), Purple, tempo 83, PC 72-75.
  // ONE AM4 preset, four sequential stomps at m17 / m37 / m53, no mid-song HOLD.
  '5:9': song('Amber 01 Intro', 'Amber', '311', 'P1 of 4', 'songs/amber.md', 83, {
    bars: 'm1-16',
    hazard: 'Hand-started (Play = bar 1). His hand-authored Em chord pad starts at once on the MicroFreak, which is MONO — the stored 3-note chords collapse to one note. That is how it has sounded since the MicroFreak took ch3, not a regression. Drums enter at m9.',
  }),
  '5:10': song('Amber 02', 'Amber', '311', 'P2 of 4', 'songs/amber.md', 83, {
    bars: 'm17-36', hazard: 'SCENE CHAIN, 4 steps [1-4][1-2][5-6][5-6]: after 8 bars the next section arrives WITHOUT a stomp.',
  }),
  '5:11': song('Amber 03', 'Amber', '311', 'P3 of 4', 'songs/amber.md', 83, { bars: 'm37-52', hazard: 'Carries the one-off `H` fill.' }),
  '5:12': song('Amber 04 Outro', 'Amber', '311', 'P4 of 4', 'songs/amber.md', 83, {
    bars: 'm53-70', hazard: 'SCENE CHAIN, 3 steps [1-4][1-2][5-7]. The ending figure lands at m69-70; lingering replays the whole 18-bar outro cycle (the "Amber trade", which is where the name comes from).',
  }),

  '5:14': song('CaughtGlim P1', 'Caught a Glimpse', 'Blindside', 'P1 of 4', undefined, 77),
  '5:15': song('CaughtGlim P2', 'Caught a Glimpse', 'Blindside', 'P2 of 4', undefined, 77),
  '5:16': song('CaughtGlim P3', 'Caught a Glimpse', 'Blindside', 'P3 of 4', undefined, 77),
  '5:17': song('CaughtGlim P4', 'Caught a Glimpse', 'Blindside', 'P4 of 4', undefined, 77),

  // SURGICAL PASS 2026-07-30 (`songs/surgical-pass-2026-07-30.md`): renamed and
  // stamped RED. Content untouched, byte-proven — the only bytes that moved on
  // these seven are 0x0c (colour) and 0x10..0x2f (name). Names stay NUMBERED
  // because no doc records which bars each project covers; the interview is a
  // blank skeleton and the chop is not section-aligned, so a section name would
  // lie. Resolving the spans is a read-only alignment job, not a rename.
  //
  // STILL NO `bars:` ON THESE SEVEN, AND THAT IS A MEASURED FACT, not an omission
  // waiting on someone to look it up. The 2026-07-31 populate measured the card's
  // own bytes: the seven are assembled from a REUSED 2-bar cell pool (22 distinct
  // midi2 drum cells, 9 of them shared across project boundaries; only 3 distinct
  // midi1 chord cells for the whole song), so they are NOT seven consecutive
  // 16-bar spans and no `bars:` value can be derived from the files. The one
  // anchor: 5:19's pattern 1 is drumless and its pattern 2 holds 3 hits, matching
  // the source's drums entering at m4, so 5:19 is the opening. Full gap writeup in
  // `songs/i-believe.md` § State/Outstanding.
  //
  // INTERNAL DRUMS POPULATED 2026-07-31: all seven carry the condensed four-voice
  // copy of their own midi2 part, bound [1,2,5,11], all six levels 0.
  '5:19': song('I Believe 1/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P1 of 7', 'songs/i-believe.md', 128, {
    hazard: '**Two-tempo song, one tempo byte.** The tab runs 128 then 96 and per-project tempo cannot follow it mid-part. The 96 mark is at m109 (the Outro tail only), so the standing default is to end the song live at m108 rather than spend a project on it.',
  }),
  '5:20': song('I Believe 2/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P2 of 7', 'songs/i-believe.md', 128),
  '5:21': song('I Believe 3/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P3 of 7', 'songs/i-believe.md', 128),
  '5:22': song('I Believe 4/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P4 of 7', 'songs/i-believe.md', 128),
  '5:23': song('I Believe 5/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P5 of 7', 'songs/i-believe.md', 128),
  '5:24': song('I Believe 6/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P6 of 7', 'songs/i-believe.md', 128),
  '5:25': song('I Believe 7/7', 'I Believe In A Thing Called Love', 'The Darkness', 'P7 of 7', 'songs/i-believe.md', 128),

  // Re-authored from source 2026-07-30 (s8562 r6899599), 8 in place, Lime.
  // The old `ClintEastwood P1..P8` names are gone; so is the MIDI 1 pad and its
  // guessed key rule (the source is Ebm throughout — plan §0c).
  '5:27': song('Clint 01 Intro', 'Clint Eastwood', 'Gorillaz', 'P1 of 8', 'songs/clint-eastwood.md', 85, {
    bars: 'm1-15',
    hazard: 'Four-lane build: Synth Bass 2 → Synth 1, El. Grand → Synth 2, String Ensemble → MIDI 1 (MicroFreak), t14 ∪ t15 drums → MIDI 2 (SPD-SX +12) + a silent condensed layer on binding [1,2,5,11]. Both synths stored SILENT — raise Synth 2 for the piano hook. Slots 31/32 use SCENE CHAINS (no plain chain).',
  }),
  '5:28': song('Clint 02 Verse 1', 'Clint Eastwood', 'Gorillaz', 'P2 of 8', 'songs/clint-eastwood.md', 85, { bars: 'm16-31' }),
  '5:29': song('Clint 03 Chorus', 'Clint Eastwood', 'Gorillaz', 'P3 of 8 (Chorus 1)', 'songs/clint-eastwood.md', 85, { bars: 'm32-41' }),
  '5:30': song('Clint 04 Verse 2', 'Clint Eastwood', 'Gorillaz', 'P4 of 8', 'songs/clint-eastwood.md', 85, { bars: 'm42-57' }),
  '5:31': song('Clint 05 Cho2 So', 'Clint Eastwood', 'Gorillaz', 'P5 of 8 (Chorus 2 + Solo 1)', 'songs/clint-eastwood.md', 85, {
    bars: 'm58-84',
    hazard: 'The FUSION: one stomp covers Chorus 2 AND Solo 1, the solo arriving at m68 via a 4-step scene chain [1-2][1-6][5-6][5-8] — the device-confirmed ceiling, met exactly. Solo 1 is not independently stompable.',
  }),
  '5:32': song('Clint 06 Solo 2', 'Clint Eastwood', 'Gorillaz', 'P6 of 8', 'songs/clint-eastwood.md', 85, {
    bars: 'm85-103', hazard: 'Scene chain [1-2][1-6][5][7]; pattern 7 is the 16-step m103 tail.',
  }),
  '5:33': song('Clint 07 Solo 3', 'Clint Eastwood', 'Gorillaz', 'P7 of 8', 'songs/clint-eastwood.md', 85, { bars: 'm104-117' }),
  '5:34': song('Clint 08 Outro', 'Clint Eastwood', 'Gorillaz', 'P8 of 8', 'songs/clint-eastwood.md', 85, { bars: 'm118-123' }),

  // SURGICAL PASS 2026-07-30 (`songs/surgical-pass-2026-07-30.md`): renamed and
  // stamped PINK. Content untouched, byte-proven. This song holds the library's
  // ONLY ear-confirmed fix (the 2026-07-27 micro-tick + 60-against-120 tail
  // snare); the surgical treatment exists precisely so that fix is never
  // re-derived. Names are the flat-chop `N/5` convention, not section names:
  // the cuts are 16-bar windows, not section boundaries, so `Intro`/`Verse`
  // would be wrong (`breakdown-rebuild-plan-2026-07-30.md` §1).
  '5:35': song('Breakdown 1/5', 'Breakdown', 'Tom Petty', 'P1 of 5', 'songs/breakdown.md', 108, { bars: 'm1-16' }),
  '5:36': song('Breakdown 2/5', 'Breakdown', 'Tom Petty', 'P2 of 5', 'songs/breakdown.md', 108, { bars: 'm17-32', hazard: 'Projects 36-39 have never been heard. Same patch as P1, which is ear-confirmed.' }),
  '5:37': song('Breakdown 3/5', 'Breakdown', 'Tom Petty', 'P3 of 5', 'songs/breakdown.md', 108, { bars: 'm33-48' }),
  '5:38': song('Breakdown 4/5', 'Breakdown', 'Tom Petty', 'P4 of 5', 'songs/breakdown.md', 108, { bars: 'm49-62' }),
  '5:39': song('Breakdown 5/5', 'Breakdown', 'Tom Petty', 'P5 of 5', 'songs/breakdown.md', 108, { bars: 'm63-77' }),

  // 5:41-45 ERASED 2026-07-29 with backups: ArpTest / GateTest16 / TieFixTest /
  // GateTest16b / TempoTest, five contiguous protocol-scratch projects. The run
  // 40-45 is now free.

  // Sugar, RE-AUTHORED 2026-07-30 (s560358 r3001145), Khaki, tempo 122, PC
  // 109-116. The 10-project flat chop became 8 SECTION-ALIGNED parts and 5:54/55
  // were deleted (their images live in `samples/circuit-ncs/sugar-predelete-2026-07-30/`;
  // they are the campaign's only deletes with NO row in the backup index).
  // TWO AM4 presets: A 110/111/112/113, B 114/115/109/116; slot 46 hand-started.
  '5:46': song('Sugar 1 IntroVrs', 'Sugar', 'Sleep Token', 'P1 of 8 (Intro + Verse 1)', 'songs/sugar.md', 122, {
    bars: 'm1-24, and serves m121-128 by RE-STOMP',
    hazard: 'Hand-started (Play = the B-major harp arpeggio at bar 1). SCENE TABLE [1-4][1-8]. It is also preset B scene 3: the outro head is a re-stomp of this project, proven identical, so nothing on the card stores those bars twice. No internal drums (the source has none here) — that is deliberate.',
  }),
  '5:47': song('Sugar 2 Chorus1', 'Sugar', 'Sleep Token', 'P2 of 8', 'songs/sugar.md', 122, {
    bars: 'm25-40',
    hazard: 'The first TWO chorus bars now carry their drums; the pre-2026-07-30 build missed them. The CLAP plays on the SNARE pad on purpose — kit 40 has no pad on the clap note. (Billie Jean, by contrast, asks for a real clap pad at note 51.)',
  }),
  '5:48': song('Sugar 3 Verse2', 'Sugar', 'Sleep Token', 'P3 of 8', 'songs/sugar.md', 122, { bars: 'm41-56' }),
  '5:49': song('Sugar 4 Chorus2', 'Sugar', 'Sleep Token', 'P4 of 8', 'songs/sugar.md', 122, {
    bars: 'm57-72', hazard: 'Where the tab DOUBLES the harp with its ghost layer, the whole doubled chord rides at the ghost velocity (the format stores one velocity per chord) — the named softness.',
  }),
  '5:50': song('Sugar 5 Bridge1', 'Sugar', 'Sleep Token', 'P5 of 8', 'songs/sugar.md', 122, {
    bars: 'm73-88',
    hazard: 'THE minor-third moment (the D naturals). Nothing here may sound "corrected": a D that sounds like a D# is a real fault. Also the AM4 A→B HOLD-swap window, about 31 s.',
  }),
  '5:51': song('Sugar 6 Bridge2', 'Sugar', 'Sleep Token', 'P6 of 8', 'songs/sugar.md', 122, {
    bars: 'm89-104',
    hazard: 'Drums ALONE for 16 bars, faithfully — the source carries this section on guitar and bass, which are his hands. The kit here and in Chorus 3 now follows the tab bar-for-bar; the old build had 27 bars misassembled and 7 content bars dropped, and was never ear-signed. "Different but tighter" is the fix landing.',
  }),
  '5:52': song('Sugar 7 Chorus3', 'Sugar', 'Sleep Token', 'P7 of 8', 'songs/sugar.md', 122, { bars: 'm105-120', hazard: 'The finale: the kit varies every bar.' }),
  '5:53': song('Sugar 8 Outro', 'Sugar', 'Sleep Token', 'P8 of 8', 'songs/sugar.md', 122, {
    bars: 'm129-148', hazard: 'SCENE TABLE [1-4][1-6]: drone verse twice then the 4-bar pad tail. No internal drums (source has none). The song ends itself.',
  }),

  // SURGICAL PASS 2026-07-30 (`songs/surgical-pass-2026-07-30.md`): renamed and
  // stamped CYAN. Content untouched, byte-proven — the scene chains on 57/60/61
  // and the stale-chain fix at offset 721 are exactly as they were.
  // `Ofr`, not `Offering`: the names are held to <=16 characters (see the doc's
  // name-width finding) and OFR is already his own handle for this song on the
  // SPD-SX (waves OFRBRTOM / OFRBUHAT / OFRBDSNR).
  '5:57': song('Ofr 1 Chorus', 'The Offering', 'Sleep Token', 'P1 Chorus', 'songs/the-offering.md', 135, {
    bars: 'm16-31', hazard: 'Hand-started (Circuit Play), not stomped. 4-SCENE CHAIN: the m16-17 pickup fill is isolated in Scene 1 so it does not refire every loop.',
  }),
  '5:58': song('Ofr 2 Chorus 2', 'The Offering', 'Sleep Token', 'P2 Chorus 2', 'songs/the-offering.md', 135, { bars: 'm61-76' }),
  '5:59': song('Ofr 3 Verse 2', 'The Offering', 'Sleep Token', 'P3 Verse 2', 'songs/the-offering.md', 135, {
    bars: 'm77-92', hazard: 'Hand-started. Sourced from the E-drums part (t15), not the acoustic kit — the acoustic track is nearly silent here.',
  }),
  '5:60': song('Ofr 4 Bridge', 'The Offering', 'Sleep Token', 'P4 Bridge', 'songs/the-offering.md', 135, {
    bars: 'm95-110', hazard: '4-SCENE CHAIN (m95-96 tom crescendo isolated in Scene 1). Front half of a 32-bar section.',
  }),
  '5:61': song('Ofr 5 Buildup', 'The Offering', 'Sleep Token', 'P5 Buildup', 'songs/the-offering.md', 135, {
    bars: 'm125-140', hazard: '4-SCENE CHAIN, and the one that needed it: the m140 hat flurry sits in Scene 4 alone. Scenes 1-3 all point at the SAME pattern 0, so no slots are spent duplicating the ostinato.',
  }),
  '5:62': song('Ofr 6 Breakdown', 'The Offering', 'Sleep Token', 'P6 Breakdown', 'songs/the-offering.md', 135, {
    bars: 'm141-156', hazard: 'Left on a PLAIN chain deliberately: its fill is at the END of its content (m155-156), right before the natural section change, not where a loop-wrap hits it first.',
  }),
  '5:63': song('Ofr 7 Outro', 'The Offering', 'Sleep Token', 'P7 Outro', 'songs/the-offering.md', 135, {
    bars: 'm157-172', hazard: 'Hand-started. Represents the whole tail including the m173-196 Fadeout, which measured as the same density as this groove rather than a distinct idea.',
  }),
};

/** Human-facing label per category, used in the map's legend and its rows. */
export const KIND_LABEL: Readonly<Record<SlotKind, string>> = {
  song: 'song section',
  'groove-mixwave': 'groove conversion (name GUESSED)',
  'groove-transcribed': 'groove, hand-transcribed',
  test: 'test / scratch',
  unknown: 'unclassified',
};
