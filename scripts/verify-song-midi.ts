/**
 * Golden: the MIDI export path. `writeMidiFile` (midiFileWrite.ts) and `buildSongMidi`
 * (songMidi.ts). No hardware, no network.
 *
 *  - writer round-trips through the repo's own parser: pitch, tick, velocity, exact length;
 *  - a same-pitch re-strike on the next beat survives (offs before ons at one tick);
 *  - a same-pitch overlap is ended at the re-strike, a doubled onset kept once;
 *  - conductor carries tempo / metre / marker meta, end-of-track lands on `endTick`;
 *  - refusals: channel, velocity, duration, metre denominator, no tempo;
 *  - builder: section windows clip notes at the loop end; a fill bar is split out and the loop
 *    plays the groove bar there; identical sections collapse; `parts` silences; `borrow` copies
 *    bars from elsewhere; `sustainRepeats` holds abutting re-strikes;
 *  - percussion split: kit pieces stay, other drum notes move to one Percussion track (merge /
 *    separate / an emptied kit part dropped), every note's timing and velocity kept, a song with
 *    no percussion byte-identical to the plain build;
 *  - full chart (option `chart`): uncovered stretches cut at markers / barline tempo changes /
 *    section edges, tab-as-written pieces with the previous section's parts, a stretch equal to a
 *    loop replays it, the silent tail left out, the loops byte-identical with the option off;
 *  - melodic part filter: `dropGhosts` leaves out ghosted notes, `skipMeasures` silences tab
 *    measure ranges (a held note stops at the range); and both on a whole part read from tab
 *    JSON, a wind line engraved in three octaves with the outer two ghosted;
 *  - WHOLE SONG: an invented four-part song (Test Song B, `scripts/syntheticSong.ts`) through the
 *    flatteners and the builder: fills, `parts`, `borrow`, `sustainRepeats`, split toms and a
 *    short last bar checked structurally, then frozen by hash (and its full chart).
 *
 * Run via:  npx tsx scripts/verify-song-midi.ts
 */
import { createHash } from 'node:crypto';
import { testSongB, testSongDLine, TEST_SONG_B_MIDI_SECTIONS, TEST_SONG_B_PART, TEST_SONG_D } from './syntheticSong.js';
import {
  writeMidiFile,
  untangleNotes,
  parseMidiFile,
  buildSongMidi,
  splitPercussion,
  GM_KIT_NOTES,
  flattenSongsterrDrums,
  flattenSongsterrMelodic,
  pitchBendCurve,
  type SongsterrPart,
  type SongsterrFlat,
  type SongsterrMelodicFlat,
  type SongMidiSection,
  rebarDrums,
  rebarMelodic,
  translateRange,
  translateBorrow,
  filterMelodicPart,
} from '../packages/core/src/protocol-generic/patterns/index.js';

// Test Song B's export (the full song + its 11 sequences), frozen once the structural checks next
// to it had been read against the song. Re-freeze ONLY for a deliberate change to the export or to
// the invented song, and say why in the commit.
const FROZEN = 'e05c039534287566';
// The same song's full chart (order + its one chart piece).
const FROZEN_CHART = '7a1dad311fb29d25';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}
function throws(label: string, fn: () => unknown, want: RegExp): void {
  try { fn(); check(label, false, 'did not throw'); } catch (e) { check(label, want.test(String(e)), String(e)); }
}

/** Meta events of every track: [trackIndex, tick, type, data]. */
function metas(bytes: Uint8Array): [number, number, number, number[]][] {
  const out: [number, number, number, number[]][] = [];
  let pos = 14, t = 0;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos + 4] << 24 | bytes[pos + 5] << 16 | bytes[pos + 6] << 8 | bytes[pos + 7]) >>> 0;
    let p = pos + 8, tick = 0, rs = 0;
    const end = p + len;
    while (p < end) {
      let d = 0; for (;;) { const b = bytes[p++]; d = (d << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
      tick += d;
      let st = bytes[p]; if (st & 0x80) { p++; rs = st; } else st = rs;
      if (st === 0xff) {
        const type = bytes[p++]; const l = bytes[p++];
        out.push([t, tick, type, [...bytes.slice(p, p + l)]]); p += l;
      } else p += (st & 0xf0) === 0xc0 || (st & 0xf0) === 0xd0 ? 1 : 2;
    }
    pos = end; t++;
  }
  return out;
}

console.log('writer');
{
  const bytes = writeMidiFile({
    name: 'T', tempos: [{ tick: 0, bpm: 120 }, { tick: 1920, bpm: 90 }], meters: [{ tick: 0, numerator: 7, denominator: 8 }],
    markers: [{ tick: 960, text: 'Verse' }], endTick: 3840,
    tracks: [{ name: 'Bass', channel: 0, program: 33, notes: [
      { tick: 0, note: 40, velocity: 100, durationTicks: 960 },
      { tick: 960, note: 40, velocity: 80, durationTicks: 480 },     // re-strike right at the previous off
      { tick: 2000, note: 43, velocity: 90, durationTicks: 1000 },
      { tick: 2500, note: 43, velocity: 90, durationTicks: 100 },    // overlaps the previous 43
      { tick: 2500, note: 43, velocity: 70, durationTicks: 100 },    // doubled onset
    ] }],
  });
  const p = parseMidiFile(bytes);
  check('division 960', p.ticksPerBeat === 960);
  const got = p.notes.map((n) => `${n.tick}:${n.note}:${n.velocity}:${n.durationTicks}`).join(' ');
  check('notes round-trip (re-strike kept, overlap ended, doubled onset once)', got === '0:40:100:960 960:40:80:480 2000:43:90:500 2500:43:90:100', got);
  const m = metas(bytes);
  check('song name on the conductor', m.some(([t, , ty, d]) => t === 0 && ty === 0x03 && String.fromCharCode(...d) === 'T'));
  check('tempo 120 then 90', m.filter(([, , ty]) => ty === 0x51).map(([, k, , d]) => `${k}:${(d[0] << 16) | (d[1] << 8) | d[2]}`).join(' ') === '0:500000 1920:666667');
  check('metre 7/8', m.some(([, , ty, d]) => ty === 0x58 && d[0] === 7 && d[1] === 3));
  check('marker at 960', m.some(([, k, ty, d]) => ty === 0x06 && k === 960 && String.fromCharCode(...d) === 'Verse'));
  check('every track ends at endTick', m.filter(([, , ty]) => ty === 0x2f).every(([, k]) => k === 3840));
  check('track name', m.some(([t, , ty, d]) => t === 1 && ty === 0x03 && String.fromCharCode(...d) === 'Bass'));
  const base = { tempos: [{ tick: 0, bpm: 100 }], meters: [{ tick: 0, numerator: 4, denominator: 4 }] };
  const one = (n: object, ch = 0) => writeMidiFile({ ...base, tracks: [{ name: 'x', channel: ch, notes: [{ tick: 0, note: 60, velocity: 100, durationTicks: 10, ...n }] }] });
  throws('channel 16 refused', () => one({}, 16), /channel/);
  throws('velocity 0 refused', () => one({ velocity: 0 }), /velocity/);
  throws('duration 0 refused', () => one({ durationTicks: 0 }), /duration/);
  throws('metre /6 refused', () => writeMidiFile({ ...base, meters: [{ tick: 0, numerator: 3, denominator: 6 }], tracks: [] }), /power of two/);
  const dense = writeMidiFile({ ...base, tracks: [{ name: 'd', channel: 9, notes: Array.from({ length: 40_000 }, (_, i) => ({ tick: i * 10, note: 42, velocity: 90, durationTicks: 5 })) }] });
  check('a 40k-note track writes (no argument-limit crash)', parseMidiFile(dense).notes.length === 40_000);
  throws('a tempo the file cannot hold refused', () => writeMidiFile({ ...base, tempos: [{ tick: 0, bpm: 3 }], tracks: [] }), /3\.58/);
  // A tab doubles an accented backbeat with a ghost copy on the same tick: the accent is the hit.
  const doubled = parseMidiFile(writeMidiFile({ ...base, tracks: [{ name: 'd', channel: 9, notes: [
    { tick: 480, note: 38, velocity: 40, durationTicks: 120 }, { tick: 480, note: 38, velocity: 127, durationTicks: 60 }] }] })).notes;
  check('a doubled onset keeps the louder velocity', doubled.length === 1 && doubled[0].velocity === 127, JSON.stringify(doubled));
  check('a doubled onset keeps the longer length', untangleNotes([{ tick: 0, note: 60, velocity: 90, durationTicks: 960 },
    { tick: 0, note: 60, velocity: 90, durationTicks: 3840 }])[0].durationTicks === 3840);
  throws('an endTick before the last note-off refused', () => writeMidiFile({ ...base, endTick: 100,
    tracks: [{ name: 'd', channel: 9, notes: [{ tick: 0, note: 36, velocity: 90, durationTicks: 480 }] }] }), /before the last note-off/);
  throws('no tempo refused', () => writeMidiFile({ ...base, tempos: [], tracks: [] }), /tempo/);
}

/** Channel events of one track (1-based after the conductor): [tick, status high nibble, d1, d2]. */
function channelEvents(bytes: Uint8Array, track: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let pos = 14, t = 0;
  while (pos + 8 <= bytes.length) {
    const len = (bytes[pos + 4] << 24 | bytes[pos + 5] << 16 | bytes[pos + 6] << 8 | bytes[pos + 7]) >>> 0;
    let p = pos + 8, tick = 0, rs = 0;
    const end = p + len;
    while (p < end) {
      let d = 0; for (;;) { const b = bytes[p++]; d = (d << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
      tick += d;
      let st = bytes[p]; if (st & 0x80) { p++; if (st < 0xf0) rs = st; } else st = rs;
      if (st === 0xff) { p++; const l = bytes[p++]; p += l; continue; }
      const two = !((st & 0xf0) === 0xc0 || (st & 0xf0) === 0xd0);
      if (t === track) out.push([tick, st & 0xf0, bytes[p], two ? bytes[p + 1] : 0]);
      p += two ? 2 : 1;
    }
    pos = end; t++;
  }
  return out;
}

console.log('pitch gestures');
{
  const base = { tempos: [{ tick: 0, bpm: 100 }], meters: [{ tick: 0, numerator: 4, denominator: 4 }] };
  const leadNotes = [
    { tick: 0, note: 60, velocity: 100, durationTicks: 960, bend: [{ at: 0, semis: 0 }, { at: 480, semis: 6 }, { at: 960, semis: 12 }] },
    { tick: 960, note: 62, velocity: 100, durationTicks: 480, bend: [{ at: 0, semis: -12 }] },
  ];
  const bytes = writeMidiFile({ ...base, endTick: 1920, tracks: [{ name: 'Lead', channel: 2, bendRange: 12, notes: leadNotes }] });
  const atEnd = channelEvents(writeMidiFile({ ...base, tracks: [{ name: 'Lead', channel: 2, bendRange: 12, notes: leadNotes }] }), 1)
    .filter((e) => e[1] === 0xe0).map((e) => e[0]).join(' ');
  check('a return to centre ON the end tick is not written (past a loop\'s end)', atEnd === '0 480 960', atEnd);
  const ev = channelEvents(bytes, 1);
  const cc = ev.filter((e) => e[1] === 0xb0).map((e) => `${e[2]}=${e[3]}`).join(' ');
  check('RPN 0 announces the range at tick 0 (one message per event)', cc === '101=0 100=0 6=12 38=0 101=127 100=127', cc);
  const pb = ev.filter((e) => e[1] === 0xe0).map((e) => `${e[0]}:${(e[3] << 7 | e[2]) - 8192}`).join(' ');
  // +6 of 12 = +4096; the point at the note's end is not written; the next note's -12 wins over the reset at 960, clamped to 0 (-8192).
  check('bends: centre, +6, next note at -12, back to centre at its end', pb === '0:0 480:4096 960:-8192 1440:0', pb);
  const order = ev.filter((e) => e[0] === 960).map((e) => e[1].toString(16)).join(',');
  check('at one tick: note-off, then the bend, then note-on', order === '80,e0,90', order);
  const plain = (n: object) => () => writeMidiFile({ ...base, tracks: [{ name: 'x', channel: 0, notes: [{ tick: 0, note: 60, velocity: 100, durationTicks: 10, bend: [{ at: 0, semis: 1 }] }], ...n }] });
  throws('a bent note without bendRange refused', plain({}), /no bendRange/);
  throws('a bend past bendRange refused', plain({ bendRange: 0.5 }), /bendRange/);
  throws('bendRange 25 refused', plain({ bendRange: 25 }), /bendRange/);
  check('a note with no bend writes no pitch bend', channelEvents(writeMidiFile({ ...base, tracks: [{ name: 'x', channel: 0, notes: [{ tick: 0, note: 60, velocity: 100, durationTicks: 10 }] }] }), 1).every((e) => e[1] !== 0xe0));

  // One bar of 4/4: a scooped note bent a whole tone over two beats (Songsterr tone 100), then a falling note.
  const measures = [{ index: 0, startBeat: 0, signature: [4, 4] as [number, number], bpm: 100 }];
  const lead = { notes: [
    { beat: 0, pitch: 60, durationBeats: 2, bendBeats: 2, bend: [{ position: 0, tone: 0 }, { position: 60, tone: 100 }], slideIn: 'below' },
    { beat: 0, pitch: 72, durationBeats: 2 },     // an octave pair: monoVoice 0 keeps the 60
    { beat: 2, pitch: 64, durationBeats: 2, slideOut: 'down' },
  ], totalBeats: 4, tempos: [{ measure: 0, beat: 0, bpm: 100 }], measures } as unknown as SongsterrMelodicFlat;
  const sec: SongMidiSection[] = [{ name: 'A', from: 1, to: 1 }];
  const glide = buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: lead, monoVoice: 0, bends: 'glide' }], sec).sequences[0].notes.Lead;
  const g = glide.map((n) => `${n.tick}:${n.note}:${n.durationTicks}`).join(' ');
  // tone 100 = 2 semitones. The scoop has no step before beat 0 (skipped); the bend's +1 lands at
  // beat 0.5 and +2 at 1.5, each connected note running a 64th (60 ticks) past the next onset; the
  // fall is the last 16th, 2 below; the bent note's last step and the next written note do not overlap.
  check('glide: staircase + fall as overlapping notes', g === '0:60:540 480:61:1020 1440:62:480 1920:64:1740 3600:62:240', g);
  check('glide: no pitch bend in the file', channelEvents(buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: lead, monoVoice: 0, bends: 'glide' }], sec).sequences[0].midi, 1).every((e) => e[1] !== 0xe0));
  const pbq = buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: lead, monoVoice: 0, bends: 'pitchbend', bendRange: 2 }], sec).sequences[0];
  check('pitchbend: the written notes only', pbq.notes.Lead.map((n) => `${n.tick}:${n.note}`).join(' ') === '0:60 1920:64');
  const curve = channelEvents(pbq.midi, 1).filter((e) => e[1] === 0xe0).map((e) => [e[0], ((e[3] << 7 | e[2]) - 8192) / 4096] as const);
  check('pitchbend: starts a whole tone low (the scoop)', curve[0][0] === 0 && curve[0][1] === -2, JSON.stringify(curve.slice(0, 3)));
  const at = (t: number) => [...curve].reverse().find((c) => c[0] <= t)![1];
  check('pitchbend: half way up the bend at beat 1', Math.abs(at(960) - 1) < 0.01, String(at(960)));
  check('pitchbend: back to centre when the bent note ends', at(1920) === 0, String(at(1920)));
  check('pitchbend: the fall reaches 2 below by the end', Math.abs(at(3839) + 2) < 0.02, String(at(3839)));
  throws('pitchbend past its range refused', () => buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: lead, bends: 'pitchbend', bendRange: 1 }], sec), /past its bendRange/);
  throws('bendRange without pitchbend refused', () => buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: lead, bends: 'glide', bendRange: 12 }], sec), /bendRange needs/);
  // A tie's own bend continues the held note's curve (What I Got Lead Acoustic m37, Out of the Black
  // m25 / m56): a quarter bent to +1, a tied quarter holding then releasing to 0 with a slide down.
  const tieBend = flattenSongsterrMelodic({ tuning: [60], measures: [{ signature: [4, 4], voices: [{ beats: [
    { duration: [1, 4], notes: [{ fret: 0, string: 0, bend: { tone: 50, points: [{ position: 0, tone: 0 }, { position: 60, tone: 50 }] } }] },
    { duration: [1, 4], notes: [{ fret: 0, string: 0, tie: true, slide: 'downwards', bend: { tone: 50, points: [{ position: 0, tone: 50 }, { position: 30, tone: 50 }, { position: 60, tone: 0 }] } }] },
    { duration: [1, 2], rest: true, notes: [] },
  ] }] }] } as unknown as SongsterrPart).notes;
  const tb = tieBend[0];
  check('tie bend: one note, the envelope spans both beats', tieBend.length === 1 && tb.durationBeats === 2 && tb.bendBeats === 2, JSON.stringify(tieBend));
  check('tie bend: the rise, the hold, the release', JSON.stringify(tb.bend) === JSON.stringify([{ position: 0, tone: 0 }, { position: 30, tone: 50 }, { position: 45, tone: 50 }, { position: 60, tone: 0 }]), JSON.stringify(tb.bend));
  check('tie bend: the tie\'s slide down ends the note', tb.slideOut === 'down');
  const tc = pitchBendCurve(tb)!;
  const tcAt = (t: number) => [...tc].reverse().find((c) => c.at <= t)!.semis;
  check('tie bend: +1 at beat 1, still +1 at 1.5, back down by the end', tcAt(960) === 1 && tcAt(1440) === 1 && tcAt(1919) < -1.9, JSON.stringify(tc));
  // Vibrato: the tab's note-level `vibrato` / `wideVibrato` (and beat-level `vibrato`) are carried;
  // a tie that carries it extends the span, one that starts it starts there.
  const vq = (n: object, beat: object = {}) => ({ duration: [1, 4], ...beat, notes: [{ fret: 0, string: 0, ...n }] });
  const vibFlat = flattenSongsterrMelodic({ tuning: [60], measures: [{ signature: [4, 4], voices: [{ beats: [
    vq({ vibrato: true }), vq({ tie: true, vibrato: true }), vq({ fret: 2, wideVibrato: true }), vq({ fret: 4 }, { vibrato: true }),
  ] }] }, { signature: [4, 4], voices: [{ beats: [vq({ fret: 5 }), vq({ fret: 5, tie: true, vibrato: true }), { duration: [1, 2], rest: true, notes: [] }] }] }] } as unknown as SongsterrPart).notes;
  const vibs = vibFlat.map((n) => n.vibrato ? `${n.vibrato.kind}:${n.vibrato.from}-${n.vibrato.to}` : '-').join(' ');
  check('vibrato: note, tie-extended, wide, beat-level, started on a tie', vibs === 'normal:0-2 wide:0-1 normal:0-1 normal:1-2', vibs);
  const vNote = { beat: 0, pitch: 60, durationBeats: 2, vibrato: { kind: 'normal', from: 0, to: 2 } } as SongsterrMelodicFlat['notes'][number];
  check('vibrato: not drawn without a tempo (it is opt-in)', pitchBendCurve(vNote) === undefined);
  const vc = pitchBendCurve(vNote, 2, { bpm: 120 })!;
  const vMax = Math.max(...vc.map((c) => c.semis)), vMin = Math.min(...vc.map((c) => c.semis));
  // 120 bpm: 2 beats a second, so 5.5 Hz is a cycle every 0.364 beats; it waits 0.12 s (0.24 beat).
  check('vibrato: +/- a quarter tone', vMax > 0.24 && vMax <= 0.25 && vMin < -0.24 && vMin >= -0.25, `${vMax} ${vMin}`);
  check('vibrato: starts after the delay, ends centred', vc[0].semis === 0 && vc[1].at === 240 && vc[vc.length - 1].semis === 0, JSON.stringify(vc.slice(0, 3)));
  check('vibrato: one sample per 30 ticks at most', vc.every((c, i) => i === 0 || c.at - vc[i - 1].at >= 30));
  const wide = pitchBendCurve({ ...vNote, vibrato: { kind: 'wide', from: 0, to: 2 } }, 2, { bpm: 120 })!;
  check('vibrato: wide is twice as deep', Math.abs(Math.max(...wide.map((c) => c.semis)) - 2 * vMax) < 1e-3);
  check('vibrato: none when a whole cycle does not fit', pitchBendCurve({ ...vNote, durationBeats: 0.5, vibrato: { kind: 'normal', from: 0, to: 0.5 } }, 2, { bpm: 120 }) === undefined);
  const vMelody = { notes: [
    { beat: 0, pitch: 60, durationBeats: 2, vibrato: { kind: 'normal', from: 0, to: 2 } },
    { beat: 2, pitch: 62, durationBeats: 2, vibrato: { kind: 'normal', from: 0, to: 2 } },
    { beat: 3, pitch: 55, durationBeats: 1 },   // sounds under the second: its vibrato would bend both
  ], totalBeats: 4, tempos: [{ measure: 0, beat: 0, bpm: 120 }], bpm: 120, measures } as unknown as SongsterrMelodicFlat;
  const vSong = buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: vMelody, bends: 'pitchbend', bendRange: 2, vibrato: true }], sec);
  const vBent = vSong.sequences[0].notes.Lead.filter((n) => n.bend).map((n) => n.tick).join(' ');
  check('vibrato: only on a note sounding alone', vBent === '0', vBent);
  check('vibrato: the receipt says what was left plain', vSong.notes.some((r) => r.includes('vibrato on 1 of 2 marked note(s) (left plain: 1 with other notes sounding')), vSong.notes.join(' | '));
  // A note a sequence carries in (struck again at 0) restarts its vibrato: centred at 0, the settle,
  // then phase 0 (Redbone 01b Intro Fill re-struck a held note mid-cycle).
  const twoBars = [0, 1].map((index) => ({ index, startBeat: index * 4, signature: [4, 4] as [number, number], bpm: 120 }));
  const heldVib = { notes: [{ beat: 2, pitch: 63, durationBeats: 4, vibrato: { kind: 'normal', from: 0, to: 4 } }],
    totalBeats: 8, tempos: [{ measure: 0, beat: 0, bpm: 120 }], bpm: 120, measures: twoBars } as unknown as SongsterrMelodicFlat;
  const carried = buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: heldVib, bends: 'pitchbend', bendRange: 2, vibrato: true }],
    [{ name: 'A', from: 1, to: 1 }, { name: 'B', from: 2, to: 2 }]).sequences[1];
  const cb = carried.notes.Lead[0].bend!;
  check('vibrato carried in: struck at 0, centred', carried.notes.Lead[0].tick === 0 && cb[0].at === 0 && cb[0].semis === 0, JSON.stringify(cb.slice(0, 3)));
  check('vibrato carried in: restarts after the settle, rising from phase 0', cb[1].at === 240 && cb[1].semis > 0 && cb[1].semis < 0.1, JSON.stringify(cb.slice(0, 3)));
  check('vibrato carried in: ends centred', cb[cb.length - 1].semis === 0, JSON.stringify(cb.slice(-2)));
  const shortHeld = { ...heldVib, notes: [{ beat: 3, pitch: 63, durationBeats: 1.25, vibrato: { kind: 'normal', from: 0, to: 1.25 } }] } as unknown as SongsterrMelodicFlat;
  const shortB = buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: shortHeld, bends: 'pitchbend', bendRange: 2, vibrato: true }],
    [{ name: 'A', from: 1, to: 1 }, { name: 'B', from: 2, to: 2 }]).sequences[1].notes.Lead[0];
  check('vibrato carried in: none when no cycle fits after the re-strike', shortB.tick === 0 && shortB.bend === undefined, JSON.stringify(shortB));
  throws('vibrato without pitchbend refused',() => buildSongMidi('S', [{ name: 'Lead', channel: 0, melodic: vMelody, vibrato: true }], sec), /vibrato needs/);
  // sustainRepeats never folds a bent note into its neighbour: the fall would hold past its own note.
  const pad = { notes: [
    { beat: 0, pitch: 60, durationBeats: 2, slideOut: 'down' },
    { beat: 2, pitch: 60, durationBeats: 2 },
  ], totalBeats: 4, tempos: [{ measure: 0, beat: 0, bpm: 100 }], measures } as unknown as SongsterrMelodicFlat;
  const held = buildSongMidi('S', [{ name: 'Pad', channel: 0, melodic: pad, sustainRepeats: true, bends: 'pitchbend', bendRange: 2 }], sec).sequences[0];
  check('sustainRepeats: a bent note is not merged', held.notes.Pad.map((n) => `${n.tick}:${n.durationTicks}`).join(' ') === '0:1920 1920:1920', JSON.stringify(held.notes.Pad));
  const heldAt = channelEvents(held.midi, 1).filter((e) => e[1] === 0xe0).map((e) => e[0]);
  check('sustainRepeats: centre again where the repeat starts', heldAt[heldAt.length - 1] === 1920, heldAt.join(' '));
}

console.log('builder (synthetic)');
{
  // 8 bars of 4/4; drums: kick on every beat, bar 4 and bar 8 are fills (snare 16ths); bass whole notes.
  const measures = Array.from({ length: 8 }, (_, i) => ({ index: i, startBeat: i * 4, signature: [4, 4] as [number, number], bpm: 100 }));
  const ev: SongsterrFlat['events'] = [];
  for (let bar = 0; bar < 8; bar++) {
    if (bar === 3 || bar === 7) for (let s = 0; s < 16; s++) ev.push({ voice: 'snare', beat: bar * 4 + s / 4, gm: 38 });
    else for (let b = 0; b < 4; b++) ev.push({ voice: 'kick', beat: bar * 4 + b, gm: 36 });
  }
  const drums = { events: ev, totalBeats: 32, tempos: [{ measure: 0, beat: 0, bpm: 100 }], signature: [4, 4], measures, sections: [] } as unknown as SongsterrFlat;
  const bassNotes = Array.from({ length: 8 }, (_, i) => ({ beat: i * 4, pitch: 28 + i, durationBeats: 6 }));    // rings past the bar
  const bass = { notes: bassNotes, totalBeats: 32, tempos: [], measures } as unknown as SongsterrMelodicFlat;
  const pad = { notes: [0, 1, 2, 3].map((b) => ({ beat: b, pitch: 60, durationBeats: 1, velocity: 90 })), totalBeats: 32, tempos: [], measures } as unknown as SongsterrMelodicFlat;
  const parts = [{ name: 'Drums', channel: 9, drums }, { name: 'Bass', channel: 0, melodic: bass }, { name: 'Pad', channel: 1, melodic: pad, sustainRepeats: true }];
  const secs: SongMidiSection[] = [
    { name: 'A', from: 1, to: 4 }, { name: 'A again', from: 5, to: 8 },
    { name: 'No pad', from: 1, to: 4, parts: ['Drums', 'Bass'] },
    { name: 'Borrowed', from: 1, to: 2, borrow: { Bass: 5 } },
  ];
  const b = buildSongMidi('S', parts, secs);
  const names = b.sequences.map((q) => `${q.index} ${q.name}`).join(' | ');
  check('sequence list', names === '01 A | 01b A Fill | 02 A again | 02b A again Fill | 03 No pad | 03b No pad Fill | 04 Borrowed', names);
  const a = b.sequences[0];
  check('loop plays the groove bar in place of the fill', a.notes.Drums.every((n) => n.note === 36) && a.notes.Drums.length === 16);
  check('fill sequence holds the fill', b.sequences[1].notes.Drums.length === 16 && b.sequences[1].notes.Drums.every((n) => n.note === 38));
  check('pitched part keeps its own last bar in the loop', a.notes.Bass.map((n) => n.note).join(',') === '28,29,30,31');
  check('notes clipped at the loop end', a.notes.Bass[3].durationTicks === 3840, String(a.notes.Bass[3].durationTicks));
  check('sustainRepeats holds the pad', a.notes.Pad.length === 1 && a.notes.Pad[0].durationTicks === 3840);
  check('A again differs (bass pitches), so no collapse', b.sequences[2].plays.join() === 'A again');
  check('parts silences the pad', b.sequences[4].notes.Pad.length === 0);
  check('borrow copies bass from m5', b.sequences[6].notes.Bass.map((n) => n.note).join(',') === '32,33');
  check('loop length exact', a.beats === 16 && parseMidiFile(a.midi).notes.length === 21);
  // Drums enter late: four empty bars must not read as the groove (a verse the kit joins late).
  const late = { ...drums, events: ev.filter((e) => e.beat >= 16).map((e) => ({ ...e })) } as SongsterrFlat;
  const lb = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: late }], [{ name: 'L', from: 1, to: 7 }]);
  check('empty bars are not the groove', lb.sequences.length === 1 && lb.sequences[0].notes.Drums.length === 12, String(lb.sequences[0].notes.Drums.length));
  const dup = buildSongMidi('S', parts, [{ name: 'X', from: 1, to: 2 }, { name: 'Y', from: 1, to: 2 }]);
  check('identical sections collapse', dup.sequences.length === 1 && dup.sequences[0].plays.join() === 'X,Y');
  // A held pad rings across the section boundary: the next section still hears it.
  const held = { ...pad, notes: Array.from({ length: 32 }, (_, i) => ({ beat: i, pitch: 60, durationBeats: 1, velocity: 90 })) } as unknown as SongsterrMelodicFlat;
  const hb = buildSongMidi('S', [{ name: 'Pad', channel: 1, melodic: held, sustainRepeats: true }], [{ name: 'A', from: 1, to: 4 }, { name: 'B', from: 5, to: 7 }]);
  check('held note carries into the next section', hb.sequences.length === 2 && hb.sequences[1].notes.Pad.length === 1 && hb.sequences[1].notes.Pad[0].durationTicks === 11520,
    JSON.stringify(hb.sequences[1].notes.Pad));
  const long = { ...bass, notes: [{ beat: 14, pitch: 40, durationBeats: 6 }] } as unknown as SongsterrMelodicFlat;
  const lc = buildSongMidi('S', [{ name: 'Bass', channel: 0, melodic: long }], [{ name: 'A', from: 1, to: 4 }, { name: 'B', from: 5, to: 8 }]);
  check('a note crossing the barline is clipped in A and continues in B',
    lc.sequences[0].notes.Bass[0].durationTicks === 1920 && lc.sequences[1].notes.Bass[0].tick === 0 && lc.sequences[1].notes.Bass[0].durationTicks === 3840);
  // Same notes at a different tempo or metre are different sequences.
  const twoTempo = { ...drums, tempos: [{ measure: 0, beat: 0, bpm: 100 }, { measure: 4, beat: 16, bpm: 140 }] } as SongsterrFlat;
  const kicks = { ...twoTempo, events: ev.filter((e) => e.voice === 'kick') } as SongsterrFlat;
  const tt = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: kicks }], [{ name: 'X', from: 1, to: 2 }, { name: 'Y', from: 5, to: 6 }]);
  check('same notes at another tempo do not collapse', tt.sequences.length === 2 && tt.sequences[1].bpm === 140);
  const m34 = measures.map((m, i) => (i >= 4 ? { ...m, signature: [3, 4] as [number, number], startBeat: 16 + (i - 4) * 3 } : m));
  const odd = { ...drums, measures: m34, totalBeats: 28, events: [] } as unknown as SongsterrFlat;
  const om = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: odd }], [{ name: 'X', from: 1, to: 2 }, { name: 'Y', from: 5, to: 6 }]);
  check('same (empty) notes in another metre do not collapse', om.sequences.length === 2 && om.sequences[1].beats === 6);
  throws('borrow from m0 refused', () => buildSongMidi('S', parts, [{ name: 'Z', from: 1, to: 2, borrow: { Bass: 0 } }]), /outside the song/);
  throws('borrow across a metre change refused',
    () => buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: odd }, { name: 'Bass', channel: 0, melodic: { ...bass, measures: m34 } as unknown as SongsterrMelodicFlat }],
      [{ name: 'Z', from: 5, to: 6, borrow: { Bass: 1 } }]), /4\/4 there and 3\/4 here/);
  throws('duplicate part names refused', () => buildSongMidi('S', [parts[0], { ...parts[1], name: 'Drums' }], [{ name: 'Z', from: 1, to: 2 }]), /two parts/);
  check('kick without a source note plays GM 36', buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: { ...drums, events: [{ voice: 'kick', beat: 0 }] } as SongsterrFlat }],
    [{ name: 'Z', from: 1, to: 1 }]).sequences[0].notes.Drums[0].note === 36);
  // Two kit tracks: the fill is judged on the whole kit, and both get the groove bar in the loop.
  const kickOnly = { ...drums, events: ev.filter((e) => e.voice === 'kick') } as SongsterrFlat;
  const snareOnly = { ...drums, events: ev.filter((e) => e.voice === 'snare') } as SongsterrFlat;
  const two = buildSongMidi('S', [{ name: 'Kit', channel: 9, drums: kickOnly }, { name: 'Perc', channel: 9, drums: snareOnly }], [{ name: 'A', from: 1, to: 4 }]);
  check('a fill on the second kit track is found', two.sequences.length === 2 && two.sequences[0].notes.Perc.length === 0
    && two.sequences[0].notes.Kit.length === 16 && two.sequences[1].notes.Perc.length === 16, JSON.stringify(two.sequences.map((q) => q.name)));
  // Fill rules, on bar patterns: A = kicks on the beats, B = kick + backbeat snare,
  // a = A with a ghost on beat 1 (same hits, another velocity), F = a snare-16ths fill.
  const kit = (bars: string): SongsterrFlat => {
    const e: SongsterrFlat['events'] = [];
    [...bars].forEach((c, bar) => {
      const at = (beat: number) => bar * 4 + beat;
      if (c === 'F') for (let s = 0; s < 16; s++) e.push({ voice: 'snare', beat: at(s / 4), gm: 38 });
      else for (let q = 0; q < 4; q++) e.push({ voice: 'kick', beat: at(q), gm: 36, ...(c === 'a' && q === 0 ? { velocity: 40 } : {}) });
      if (c === 'B') for (const q of [1, 3]) e.push({ voice: 'snare', beat: at(q), gm: 38 });
    });
    const ms = Array.from({ length: bars.length }, (_, i) => ({ index: i, startBeat: i * 4, signature: [4, 4] as [number, number], bpm: 100 }));
    return { events: e, totalBeats: bars.length * 4, tempos: [{ measure: 0, beat: 0, bpm: 100 }], signature: [4, 4], measures: ms, sections: [] } as unknown as SongsterrFlat;
  };
  const seqs = (bars: string, more: Partial<SongMidiSection> = {}, extra: Parameters<typeof buildSongMidi>[1] = []) =>
    buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: kit(bars) }, ...extra], [{ name: 'X', from: 1, to: bars.length, ...more }]).sequences;
  check('a last bar already played in the section is not a fill', seqs('ABAFABAF').length === 1);
  check('a velocity-only change is not a fill', seqs('AAAa').length === 1);
  const alt = seqs('ABABABAF');
  const lastBar = alt[0].notes.Drums.filter((x) => x.tick >= 7 * 3840);
  check('a 2-bar groove keeps alternating up to the wrap', alt.length === 2 && lastBar.some((x) => x.note === 38), JSON.stringify(lastBar.map((x) => x.note)));
  check('fill: false keeps the last bar in the loop', seqs('AAAF', { fill: false }).length === 1);
  check('a muted drum part never makes a fill', seqs('AAAA', {}, [{ name: 'Tamb', channel: 9, drums: kit('AAAF'), reference: true }]).length === 1);
  const once = seqs('AAAA', { oneShot: true });
  check('oneShot marks the sequence to play once', once.length === 1 && once[0].loop === false && seqs('AAAA')[0].loop === true);
  const slow = seqs('AAAA', { bpm: 72 });
  const us72 = Math.round(60_000_000 / 72);
  const tempoMeta = [0xff, 0x51, 0x03, us72 >> 16, (us72 >> 8) & 0xff, us72 & 0xff].join(',');
  check('a section bpm sets the sequence tempo', slow[0].bpm === 72 && Array.from(slow[0].midi).join(',').includes(tempoMeta));
  throws('section past the song refused', () => buildSongMidi('S', parts, [{ name: 'Z', from: 7, to: 9 }]), /outside the song/);
  throws('unknown part refused', () => buildSongMidi('S', parts, [{ name: 'Z', from: 1, to: 2, parts: ['Keys'] }]), /unknown part/);
}

console.log('full chart (option chart)');
{
  // 14 bars: 1-10 4/4, 11-14 3/4; markers Intro m1, Verse m5, Chorus m9; tempo 100, 130 from m7 (a
  // barline change); kick on every beat and one bass note per bar (pitch = bar) to m12; m13-14 silent.
  const sig = (i: number): [number, number] => (i < 10 ? [4, 4] : [3, 4]);
  let at = 0;
  const measures = Array.from({ length: 14 }, (_, i) => {
    const m = { index: i, startBeat: at, signature: sig(i), bpm: i < 6 ? 100 : 130, marker: ({ 0: 'Intro', 4: 'Verse', 8: 'Chorus' } as Record<number, string>)[i] };
    at += sig(i)[0];
    return m;
  });
  const tempos = [{ measure: 0, beat: 0, bpm: 100 }, { measure: 6, beat: 24, bpm: 130 }];
  const ev: SongsterrFlat['events'] = measures.slice(0, 12).flatMap((m) => Array.from({ length: m.signature[0] }, (_, q) => ({ voice: 'kick', beat: m.startBeat + q, gm: 36 })));
  const drums = { events: ev, totalBeats: at, tempos, signature: [4, 4], measures, sections: [] } as unknown as SongsterrFlat;
  const bass = { notes: measures.slice(0, 12).map((m, i) => ({ beat: m.startBeat, pitch: 30 + i, durationBeats: 1 })), totalBeats: at, tempos, measures } as unknown as SongsterrMelodicFlat;
  const parts = [{ name: 'Drums', channel: 9, drums }, { name: 'Bass', channel: 0, melodic: bass }];
  const secs: SongMidiSection[] = [{ name: 'Intro', from: 1, to: 4 }, { name: 'Chorus', from: 9, to: 10, parts: ['Drums'] }];
  const off = buildSongMidi('S', parts, secs);
  const on = buildSongMidi('S', parts, secs, undefined, { chart: true });
  const steps = on.chart?.order.map((o) => `${o.index}:${o.from}-${o.to}`).join(' ');
  check('order: loops on their own bars, chart pieces cut at the marker, the barline tempo change and the section edge',
    steps === '01:1-4 c01:5-6 c02:7-8 02:9-10 c03:11-12' && on.chart?.bars === 12, steps);
  const c = on.sequences.filter((q) => q.kind === 'chart');
  check('chart pieces come after the loops, named from the tab marker in force', on.sequences.map((q) => q.index).join() === '01,02,c01,c02,c03'
    && c.map((q) => q.name).join() === 'Verse,Verse,Chorus', c.map((q) => q.name).join());
  check('a chart piece after a tempo change plays that tempo; a 3/4 stretch keeps its metre', c[1].bpm === 130 && c[2].signature.join('/') === '3/4' && c[2].beats === 6);
  check('a chart piece plays the tab as written (every kick and bass note of c01)', c[0].notes.Drums.length === 8 && c[0].notes.Bass.map((n) => n.note).join() === '34,35');
  check('a chart piece takes the parts of the section before it (c03 after Chorus: no Bass)', c[2].notes.Bass.length === 0 && c[2].notes.Drums.length === 6);
  check('the report names the silent tail and the silenced notes', on.notes.some((x) => /bars 13-14 are silent/.test(x)) && on.notes.some((x) => /2 tab note\(s\) silent in chart pieces/.test(x)), on.notes.join(' | '));
  check('chart off: no chart, and the loops are byte-identical with it on', off.chart === undefined && off.sequences.length === 2
    && off.sequences.every((q, i) => Buffer.compare(Buffer.from(q.midi), Buffer.from(on.sequences[i].midi)) === 0) && Buffer.compare(Buffer.from(off.full), Buffer.from(on.full)) === 0);
  const notesIn = (o: { index: string }) => on.sequences.find((q) => q.index === o.index)!.notes;
  const total = on.chart!.order.reduce((k, o) => k + notesIn(o).Drums.length + notesIn(o).Bass.length, 0);
  check('the order plays every tab note once but the 2 bass notes the Chorus parts silence', total === ev.length + 12 - 2 - 2, String(total));   // Chorus loop drops 2 bass notes too
  // A stretch with the same notes as a loop replays the loop instead of a new chart piece.
  const kicks = { ...drums, events: ev.filter((e) => e.beat < 16), tempos: [tempos[0]], measures: measures.slice(0, 4).map((m) => ({ ...m, marker: undefined })), totalBeats: 16 } as SongsterrFlat;
  const re = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: kicks }], [{ name: 'A', from: 1, to: 2 }], undefined, { chart: true });
  check('a stretch identical to a loop reuses the loop', re.sequences.length === 1 && re.chart?.order.map((o) => `${o.index}:${o.from}-${o.to}`).join(' ') === '01:1-2 01:3-4');
  const noMark = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: { ...kicks, events: kicks.events.filter((e) => e.beat < 8 || e.beat % 2 === 0) } as SongsterrFlat }],
    [{ name: 'A', from: 1, to: 2 }], undefined, { chart: true });
  check('a tab without markers names a piece by its bars', noMark.sequences[1]?.name === 'Bars 3-4', noMark.sequences[1]?.name);
}

console.log('re-bar');
{
  type Sig = [number, number];
  const make = (sigs: Sig[], bpm: number) => {
    let at = 0;
    const measures = sigs.map((sig, index) => { const m = { index, startBeat: at, signature: sig, bpm }; at += (sig[0] * 4) / sig[1]; return m; });
    return { measures, totalBeats: at, tempos: [{ measure: 0, beat: 0, bpm }], bpm, signature: sigs[0], sections: [] };
  };
  // Out of the Black: 4 bars of 4/4 at 80 notated half-time -> 8 bars at 160, same seconds.
  const half = { ...make([[4, 4], [4, 4], [4, 4], [3, 8]], 80), events: [{ voice: 'snare', beat: 1, gm: 38 }, { voice: 'kick', beat: 12.5, gm: 36 }] } as unknown as SongsterrFlat;
  const x2 = rebarDrums(half, [{ from: 1, to: 4, factor: 2 }]);
  check('x2: a 4/4 bar becomes two bars, 3/8 becomes one 3/4 bar', x2.flat.measures.length === 7
    && x2.flat.measures[6].signature.join('/') === '3/4' && x2.flat.totalBeats === 27, JSON.stringify(x2.flat.measures.map((m) => m.signature)));
  check('x2: beats double and the bpm doubles (same seconds)', x2.flat.events[0].beat === 2 && x2.flat.events[1].beat === 25 && x2.flat.tempos[0].bpm === 160);
  check('x2: tab measures map to their new bars', JSON.stringify(x2.map.bars) === '[[0,1],[2,3],[4,5],[6,6]]', JSON.stringify(x2.map.bars));
  const songX2 = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: x2.flat }], [{ name: 'A', ...translateRange(x2.map, 1, 3, 'A') }]);
  check('x2: the sequence plays at 160 over 6 bars', songX2.sequences[0].bpm === 160 && songX2.sequences[0].bars === 6);
  // A tempo-doubled tab: a double-time middle (bars 2-5 at 140) between normal bars at 70.
  const dbl = make([[4, 4], [4, 4], [4, 4], [4, 4], [4, 4], [4, 4]], 70);
  dbl.tempos.push({ measure: 1, beat: 4, bpm: 140 }, { measure: 5, beat: 20, bpm: 70 });
  const pad = { ...dbl, notes: [{ beat: 4, pitch: 60, durationBeats: 8 }, { beat: 20, pitch: 62, durationBeats: 4 }], tuning: [], unresolved: 0 } as unknown as SongsterrMelodicFlat;
  const h = rebarMelodic(pad, [{ from: 2, to: 5, factor: 0.5 }]);
  check('x0.5: two bars become one, the bars after shift back', h.flat.measures.length === 4 && h.flat.totalBeats === 16 && JSON.stringify(h.map.bars) === '[[0,0],[1,1],[1,1],[2,2],[2,2],[3,3]]', JSON.stringify(h.map.bars));
  check('x0.5: a note in the range halves; one after keeps its length', h.flat.notes[0].beat === 4 && h.flat.notes[0].durationBeats === 4 && h.flat.notes[1].beat === 12 && h.flat.notes[1].durationBeats === 4);
  check('x0.5: the middle plays at 70 and the bar after keeps 70', JSON.stringify(h.flat.tempos.map((t) => [t.beat, t.bpm])) === '[[0,70]]', JSON.stringify(h.flat.tempos));
  // A bend's span re-bars with its note: x2 doubles it, or the ramp would play in half its written time.
  const bentHalf = { ...make([[4, 4], [4, 4]], 80), notes: [{ beat: 1, pitch: 60, durationBeats: 1.5, bendBeats: 0.5, bend: [{ position: 0, tone: 0 }, { position: 60, tone: 100 }], vibrato: { kind: 'normal', from: 0.5, to: 1.5 } }], tuning: [], unresolved: 0 } as unknown as SongsterrMelodicFlat;
  const bx = rebarMelodic(bentHalf, [{ from: 1, to: 2, factor: 2 }]).flat.notes[0];
  check('x2: bendBeats doubles with the note', bx.beat === 2 && bx.durationBeats === 3 && bx.bendBeats === 1, JSON.stringify(bx));
  check('x2: the vibrato span doubles with the note', bx.vibrato?.from === 1 && bx.vibrato?.to === 3, JSON.stringify(bx.vibrato));
  throws('x0.5: a section starting inside a merged pair refused', () => translateRange(h.map, 3, 6, 'Verse'), /merged/);
  const odd = rebarDrums({ ...make([[4, 4], [2, 4]], 140), events: [] } as unknown as SongsterrFlat, [{ from: 1, to: 2, factor: 0.5 }]);
  check('x0.5: a lone bar halves its metre (4/4 -> 2/4, 2/4 -> 1/4)', JSON.stringify(odd.flat.measures.map((m) => m.signature)) === '[[2,4],[1,4]]', JSON.stringify(odd.flat.measures.map((m) => m.signature)));
  // Review fixes: a borrow re-bars as a whole window; x0.5 pairs stay inside their range.
  const eight = { ...make(Array.from({ length: 8 }, () => [4, 4] as Sig), 100), events: [] } as unknown as SongsterrFlat;
  const bx2 = rebarDrums(eight, [{ from: 3, to: 6, factor: 2 }]);
  throws('a borrow whose source re-bars differently refused', () => translateBorrow(bx2.map, 3, 7, 8, 'b'), /re-bars x2 but/);
  check('a borrow from the same factor translates', translateBorrow(bx2.map, 7, 7, 8, 'b') === 11);
  const bh = rebarDrums(eight, [{ from: 3, to: 6, factor: 0.5 }]);
  check('a borrow starting a merged pair is allowed', translateBorrow(bh.map, 3, 5, 6, 'b') === 3);
  const two = rebarDrums(eight, [{ from: 1, to: 3, factor: 0.5 }, { from: 4, to: 6, factor: 0.5 }]);
  check('x0.5 never pairs across two ranges', JSON.stringify(two.map.bars.slice(0, 6)) === '[[0,0],[0,0],[1,1],[2,2],[2,2],[3,3]]', JSON.stringify(two.map.bars));
  const noMap = rebarDrums({ ...make([[4, 4], [4, 4], [4, 4]], 80), tempos: [], events: [] } as unknown as SongsterrFlat, [{ from: 1, to: 2, factor: 2 }]);
  check('no tempo map: the part bpm is the fallback', JSON.stringify(noMap.flat.tempos.map((t) => [t.beat, t.bpm])) === '[[0,160],[16,80]]', JSON.stringify(noMap.flat.tempos));
  const short = rebarDrums({ ...make([[4, 4], [4, 4]], 80), totalBeats: 5, events: [] } as unknown as SongsterrFlat, [{ from: 1, to: 2, factor: 2 }]);
  check('x2 on a short last bar stays one bar inside the song', short.flat.measures.length === 3 && short.flat.totalBeats === 10
    && short.flat.measures[2].startBeat === 8, JSON.stringify(short.flat.measures.map((m) => m.startBeat)));
  throws('overlapping re-bar ranges refused', () => rebarDrums(half, [{ from: 1, to: 2, factor: 2 }, { from: 2, to: 3, factor: 2 }]), /overlap/);
}

console.log('percussion split (Drums + Percussion)');
{
  const measures = Array.from({ length: 4 }, (_, i) => ({ index: i, startBeat: i * 4, signature: [4, 4] as [number, number], bpm: 100 }));
  const flat = (events: SongsterrFlat['events']) => ({ events, totalBeats: 16, tempos: [{ measure: 0, beat: 0, bpm: 100 }], signature: [4, 4], measures, sections: [] }) as unknown as SongsterrFlat;
  const beats = Array.from({ length: 16 }, (_, b) => b);
  // Drums: kick + hat on every beat, a cowbell (56) on beat 2 of each bar, a clap (39) with a
  // 2-hit roll on the last beat of bar 2 (not the last bar: no fill), one unmapped event (no note: dropped by the writer, never moved).
  const drums = flat([
    ...beats.map((b) => ({ voice: 'kick', beat: b, gm: 36 })),
    ...beats.map((b) => ({ voice: 'hat', beat: b + 0.5, gm: 42, velocity: 70 })),
    ...[1, 5, 9, 13].map((b) => ({ voice: 'perc', beat: b, gm: 56, accent: true })),
    { voice: 'clap', beat: 7, gm: 39, roll: 2 },
    { voice: 'nothing-maps-this', beat: 2 },
  ]);
  const tamb = flat(beats.map((b) => ({ voice: 'perc', beat: b + 0.25, gm: 54, velocity: 60 })));
  const congas = flat(beats.map((b) => ({ voice: 'perc', beat: b + 0.75, gm: b % 2 ? 63 : 62 })));
  // Secondary kit: crashes (kit) plus a maracas (70, percussion).
  const overdub = flat([{ voice: 'crash', beat: 0, gm: 49 }, { voice: 'crash', beat: 8, gm: 49 }, { voice: 'perc', beat: 4, gm: 70 }]);
  const bass = { notes: [{ beat: 0, pitch: 40, durationBeats: 16 }], totalBeats: 16, tempos: [], measures } as unknown as SongsterrMelodicFlat;
  const parts = [
    { name: 'Drums', channel: 9, drums },
    { name: 'Bass', channel: 0, melodic: bass },
    { name: 'Tambourine', channel: 9, drums: tamb, reference: true },
    { name: 'Overdub', channel: 9, drums: overdub },
    { name: 'Congas', channel: 9, drums: congas },
  ];
  const secs: SongMidiSection[] = [{ name: 'A', from: 1, to: 4 }];
  const sig = (notes: readonly { tick: number; note: number; velocity: number; durationTicks: number }[]) =>
    notes.map((n) => `${n.tick}:${n.note}:${n.velocity}:${n.durationTicks}`).sort().join(',');
  const plain = buildSongMidi('S', parts, secs);
  const allPlain = sig(Object.values(plain.sequences[0].notes).flat());

  check('GM_KIT_NOTES: 31, 35-38, 40-53, 55, 57, 59, 23-26, 88-127; 39 / 54 / 56 / 58 / 60-87 are percussion',
    [23, 26, 31, 35, 38, 40, 53, 55, 57, 59, 88, 127].every((n) => GM_KIT_NOTES.has(n))
    && [22, 27, 30, 32, 34, 39, 54, 56, 58, 60, 70, 82, 87].every((n) => !GM_KIT_NOTES.has(n)) && GM_KIT_NOTES.size === 4 + 1 + 4 + 14 + 3 + 40);

  const m = splitPercussion(parts);
  const mb = buildSongMidi('S', parts, secs, m.tracks);
  const mq = mb.sequences[0];
  check('merge: Percussion right after the first kit track; all-percussion parts (played or reference) fold away',
    m.tracks.map((t) => t.name).join() === 'Drums,Percussion,Bass,Overdub' && m.percussion === 1, m.tracks.map((t) => t.name).join());
  check('merge: Drums keeps only kit pieces (16 kicks + 16 hats)', mq.notes.Drums.length === 32 && mq.notes.Drums.every((n) => GM_KIT_NOTES.has(n.note)));
  check('merge: Overdub gives up its maracas, keeps its crashes', sig(mq.notes.Overdub) === sig(plain.sequences[0].notes.Overdub.filter((n) => n.note === 49)));
  check('merge: Percussion holds cowbell x4, clap roll x2, maracas, tambourine x16, congas x16',
    mq.notes.Percussion.length === 4 + 2 + 1 + 16 + 16 && mq.notes.Percussion.every((n) => !GM_KIT_NOTES.has(n.note)), String(mq.notes.Percussion.length));
  check('merge: every note keeps its tick, velocity and length (the multiset is the plain build\'s)', sig(Object.values(mq.notes).flat()) === allPlain);
  check('merge: Percussion is on channel 9', m.tracks[1].channel === 9 && parseMidiFile(mq.midi).notes.every((n) => n.channel === 9 || n.channel === 0));
  check('merge: same sequences as the plain build (fills and collapsing decided on the parts)',
    mb.sequences.map((q) => q.index).join() === plain.sequences.map((q) => q.index).join());
  check('merge: the report names what moved', m.report.join(' | ') === 'Percussion: Drums gives up 39 x2, 56 x4 | Percussion: Overdub gives up 70 x1'
    + ' | Percussion: Tambourine folded in whole (54 x16) | Percussion: Congas folded in whole (62 x8, 63 x8)', m.report.join(' | '));

  const s = splitPercussion(parts, 'separate');
  const sq = buildSongMidi('S', parts, secs, s.tracks).sequences[0];
  check('separate: all-percussion parts keep their own tracks; stray notes still go to Percussion',
    s.tracks.map((t) => t.name).join() === 'Drums,Percussion,Bass,Tambourine,Overdub,Congas', s.tracks.map((t) => t.name).join());
  check('separate: Percussion holds only the stray notes (cowbell, clap, maracas)', sq.notes.Percussion.length === 7 && sq.notes.Tambourine.length === 16 && sq.notes.Congas.length === 16);
  check('separate: note multiset unchanged', sig(Object.values(sq.notes).flat()) === allPlain);

  // A secondary kit part whose notes are all percussion is emptied by the split: it is dropped,
  // not left as an empty kit track; and with the first drum part all percussion, Percussion takes its place.
  const emptied = [{ name: 'Drums', channel: 9, drums }, { name: 'Drum Sample', channel: 9, drums: flat([{ voice: 'perc', beat: 0, gm: 81 }, { voice: 'perc', beat: 4, gm: 70 }]) }];
  const e = splitPercussion(emptied);
  check('empty-kit drop: an all-percussion kit part leaves no track behind', e.tracks.map((t) => t.name).join() === 'Drums,Percussion', e.tracks.map((t) => t.name).join());
  const solo = splitPercussion([{ name: 'Bass', channel: 0, melodic: bass }, { name: 'Perc', channel: 9, drums: tamb }]);
  check('no kit track: Percussion sits where the folded part was', solo.tracks.map((t) => t.name).join() === 'Bass,Percussion', solo.tracks.map((t) => t.name).join());

  const none = splitPercussion([{ name: 'Drums', channel: 9, drums: flat(beats.map((b) => ({ voice: 'kick', beat: b, gm: 36 }))) }, parts[1]]);
  const noneB = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: flat(beats.map((b) => ({ voice: 'kick', beat: b, gm: 36 }))) }, parts[1]], secs, none.tracks);
  const noneP = buildSongMidi('S', [{ name: 'Drums', channel: 9, drums: flat(beats.map((b) => ({ voice: 'kick', beat: b, gm: 36 }))) }, parts[1]], secs);
  check('no percussion: the layout is one track per part and the bytes are the plain build\'s',
    none.percussion === undefined && none.report.length === 0 && Buffer.compare(Buffer.from(noneB.full), Buffer.from(noneP.full)) === 0
    && Buffer.compare(Buffer.from(noneB.sequences[0].midi), Buffer.from(noneP.sequences[0].midi)) === 0);
  check('a reference part mixing kit and percussion is left alone',
    splitPercussion([{ name: 'Drums', channel: 9, drums, reference: true }]).percussion === undefined);
  throws('a non-folded part already named Percussion refused', () => splitPercussion([parts[0], { name: 'Percussion', channel: 9, drums: overdub }]), /already named/);
  throws('a layout filtering a melodic part refused', () => buildSongMidi('S', parts, secs, [{ name: 'X', channel: 0, sources: [{ part: 1, notes: 'kit' }] }]), /not a drum part/);
  throws('a layout with two tracks of one name refused', () => buildSongMidi('S', parts, secs, [{ name: 'X', channel: 0, sources: [{ part: 1 }] }, { name: 'X', channel: 9, sources: [{ part: 0 }] }]), /two tracks/);
}

console.log('melodic part filter (dropGhosts / skipMeasures)');
{
  const measures = Array.from({ length: 4 }, (_, i) => ({ index: i, startBeat: i * 4, signature: [4, 4] as [number, number], bpm: 100 }));
  const flat = { notes: [
    { beat: 0, pitch: 48, durationBeats: 1 },
    { beat: 0, pitch: 36, durationBeats: 1, ghost: true },     // the octave below, ghosted
    { beat: 0, pitch: 60, durationBeats: 1, ghost: true },     // the octave above, ghosted
    { beat: 2, pitch: 50, durationBeats: 6 },                  // held from bar 1 into bar 2
    { beat: 5, pitch: 52, durationBeats: 1 },                  // struck in bar 2
    { beat: 12, pitch: 53, durationBeats: 1 },                 // bar 4
  ], totalBeats: 16, tempos: [{ measure: 0, beat: 0, bpm: 100 }], measures } as unknown as SongsterrMelodicFlat;
  const g = filterMelodicPart('Sax', flat, { dropGhosts: true });
  check('dropGhosts leaves out the ghosted notes only', g.flat.notes.map((n) => n.pitch).join() === '48,50,52,53' && g.report[0] === 'Sax: dropGhosts leaves out 2 ghosted note(s) of 6', g.report.join(' | '));
  const s = filterMelodicPart('Sax', flat, { skipMeasures: [[2, 3]] });
  check('skipMeasures: a note struck inside is left out, one held into it stops at the range start',
    s.flat.notes.map((n) => `${n.pitch}:${n.durationBeats}`).join() === '48:1,36:1,60:1,50:2,53:1'
    && s.report[0] === 'Sax: skipMeasures m2-3 leaves out 1 note(s), stops 1 held into it', `${s.flat.notes.map((n) => `${n.pitch}:${n.durationBeats}`).join()} | ${s.report.join(' | ')}`);
  check('skipMeasures: the bar layout is unchanged (every part still cuts on the same bars)', s.flat.measures === flat.measures && s.flat.totalBeats === 16);
  check('skipMeasures on the last bar runs to the song end', filterMelodicPart('Sax', flat, { skipMeasures: [[4, 4]] }).flat.notes.every((n) => n.pitch !== 53));
  check('no filter: the flat passes through as is (no other export changes)', filterMelodicPart('Sax', flat, {}).flat === flat && filterMelodicPart('Sax', flat, { dropGhosts: false }).flat === flat);
  check('the input flat is not mutated', flat.notes.length === 6 && flat.notes[3].durationBeats === 6);
  throws('skipMeasures past the song refused', () => filterMelodicPart('Sax', flat, { skipMeasures: [[3, 5]] }), /inside 1\.\.4/);
  throws('skipMeasures from m0 refused', () => filterMelodicPart('Sax', flat, { skipMeasures: [[0, 2]] }), /inside 1\.\.4/);
  throws('skipMeasures backwards refused', () => filterMelodicPart('Sax', flat, { skipMeasures: [[3, 2]] }), /\[from, to\]/);

  // A WHOLE PART, from its tab JSON (the invented wind line of scripts/syntheticSong.ts): m3-5 are
  // engraved in three octaves, the outer two ghosted; m7-8 are plain; the m9-12 high line is the
  // one an owner leaves out (skipMeasures). Both filters together, through the flattener and the
  // builder, not on a hand-made flat.
  const all = flattenSongsterrMelodic(testSongDLine());
  check('wind line: 60 notes, 24 ghosted, before the filter', all.notes.length === 60 && all.ghosts === 24, `${all.notes.length} / ${all.ghosts}`);
  const [hiFrom, hiTo] = TEST_SONG_D.high;
  const kept = filterMelodicPart('Sax', all, { dropGhosts: true, skipMeasures: [[hiFrom, hiTo]] });
  const secs: SongMidiSection[] = [{ name: 'Intro', from: 1, to: 6 }, { name: 'Verse', from: 7, to: 8 }, { name: 'Chorus', from: hiFrom, to: hiTo }];
  const q = buildSongMidi('S', [{ name: 'Sax', channel: 0, transpose: -12, melodic: kept.flat }], secs).sequences;
  const intro = q.find((x) => x.name === 'Intro')!.notes.Sax;
  const pitches = [...new Set(intro.map((n) => n.note))].sort((x, y) => x - y);
  const BAR = 4 * 960;
  check('wind line: the middle octave only, 12 notes in MIDI 41-46 (transpose -12), all in m3-5',
    intro.length === 12 && pitches.join(',') === '41,43,45,46'
    && intro.every((n) => n.tick >= 2 * BAR && n.tick < 5 * BAR), `${intro.length} notes, pitches ${pitches.join(',')}`);
  check('wind line: unfiltered, the same bars sound three octaves at once (36 notes, MIDI 29-58)', (() => {
    const u = buildSongMidi('S', [{ name: 'Sax', channel: 0, transpose: -12, melodic: all }], secs).sequences.find((x) => x.name === 'Intro')!.notes.Sax;
    const p = u.map((n) => n.note);
    return u.length === 36 && Math.min(...p) === 29 && Math.max(...p) === 58;
  })());
  check('wind line: the plain bars m7-8 are untouched by either filter (8 notes)', q.find((x) => x.name === 'Verse')!.notes.Sax.length === 8);
  check(`wind line: nothing in m${hiFrom}-${hiTo}`, q.find((x) => x.name === 'Chorus')!.notes.Sax.length === 0);
  check('wind line: the receipt names both', kept.report.join(' | ') === 'Sax: dropGhosts leaves out 24 ghosted note(s) of 60 | Sax: skipMeasures m9-12 leaves out 16 note(s)', kept.report.join(' | '));
}

console.log('whole song: Test Song B (invented, scripts/syntheticSong.ts)');
{
  const song = testSongB();
  const load = (id: number): SongsterrPart => song[id].part;
  const parts = [
    { name: 'Drums', channel: 9, drums: flattenSongsterrDrums(load(TEST_SONG_B_PART.drums), { splitToms: true }) },
    { name: 'Bass', channel: 0, melodic: flattenSongsterrMelodic(load(TEST_SONG_B_PART.bass)) },
    { name: 'Pad', channel: 1, sustainRepeats: true, melodic: flattenSongsterrMelodic(load(TEST_SONG_B_PART.pad)) },
  ];
  const sections = TEST_SONG_B_MIDI_SECTIONS;
  const seq = (b: ReturnType<typeof buildSongMidi>, name: string) => b.sequences.find((q) => q.name === name);
  const b = buildSongMidi('Test Song B', parts, sections);
  check('11 sequences: 8 sections, and a fill for each of choruses A, B and C (the Outro and the verses end on their groove bar)',
    b.sequences.map((q) => `${q.index} ${q.name}`).join(', ')
      === '01 Intro, 02 Verse 1, 03 Chorus A, 03b Chorus A Fill, 04 Verse 2, 05 Chorus B, 05b Chorus B Fill, 06 Breakdown, 07 Chorus C, 07b Chorus C Fill, 08 Outro',
    b.sequences.map((q) => `${q.index} ${q.name}`).join(', '));
  check('a chorus fill is its one last bar; the loop plays the groove bar there (4 bars of hats, no floor tom)',
    seq(b, 'Chorus A Fill')!.from === 16 && seq(b, 'Chorus A Fill')!.to === 16
    && seq(b, 'Chorus A Fill')!.notes.Drums.some((n) => n.note === 41)
    && !seq(b, 'Chorus A')!.notes.Drums.some((n) => n.note === 41)
    && seq(b, 'Chorus A')!.notes.Drums.filter((n) => n.note === 42).length === 32);
  check('chorus C / outro bass identical (the Outro borrows m13)', JSON.stringify(seq(b, 'Chorus C')?.notes.Bass)
    === JSON.stringify(seq(b, 'Outro')?.notes.Bass) && seq(b, 'Outro')!.notes.Bass.length === 16);
  check('the borrow is doing the work: without it the Outro plays its own, different bass',
    JSON.stringify(seq(buildSongMidi('Test Song B', parts, sections.map(({ borrow: _b, ...s }) => s)), 'Outro')?.notes.Bass)
      !== JSON.stringify(seq(b, 'Outro')?.notes.Bass));
  check('`parts` silences the pad in Verse 2 although the tab has it there; Verse 1 keeps it',
    seq(b, 'Verse 2')!.notes.Pad.length === 0 && seq(b, 'Verse 1')!.notes.Pad.length === 4
    && flattenSongsterrMelodic(load(TEST_SONG_B_PART.pad)).notes.some((n) => n.beat >= 16 * 4 && n.beat < 20 * 4));
  check('sustainRepeats: the pad\'s abutting eighths hold (Verse 1 changes pitch each bar: 4 one-bar notes; the Intro never does: 1 four-bar note)',
    seq(b, 'Verse 1')!.notes.Pad.length === 4 && seq(b, 'Verse 1')!.notes.Pad.every((n) => n.durationTicks === 4 * 960)
    && seq(b, 'Intro')!.notes.Pad.length === 1 && seq(b, 'Intro')!.notes.Pad[0].durationTicks === 16 * 960,
    JSON.stringify([seq(b, 'Verse 1')!.notes.Pad.map((n) => n.durationTicks), seq(b, 'Intro')!.notes.Pad.map((n) => n.durationTicks)]));
  check('the breakdown keeps its split tom lanes (GM 45 and 41) and its 1/4 last bar (4 bars + 1 beat)',
    seq(b, 'Breakdown')!.notes.Drums.some((n) => n.note === 45) && seq(b, 'Breakdown')!.notes.Drums.some((n) => n.note === 41)
    && parseMidiFile(seq(b, 'Breakdown')!.midi).notes.every((n) => n.tick < 17 * 960));
  check('every drum note is a GM percussion number', b.sequences.every((q) => q.notes.Drums.every((n) => n.note >= 27 && n.note <= 87)));
  check('no percussion on this kit: the split leaves the layout one track per part', splitPercussion(parts).percussion === undefined);
  const h = createHash('sha256');
  h.update(b.full);
  for (const q of b.sequences) h.update(q.midi);
  const digest = h.digest('hex').slice(0, 16);
  check('frozen output', digest === FROZEN, digest);
  // The full chart of the condensed export: the loops unchanged, chart pieces between them.
  const c = buildSongMidi('Test Song B', parts, sections, undefined, { chart: true });
  check('chart: the loops are the plain build\'s, byte for byte', b.sequences.every((q, i) => Buffer.compare(Buffer.from(q.midi), Buffer.from(c.sequences[i].midi)) === 0));
  const order = c.chart!.order;
  check('chart: the order tiles bars 1..end once', order[0].from === 1 && order.every((o, i) => !i || o.from === order[i - 1].to + 1) && order[order.length - 1].to === c.chart!.bars,
    JSON.stringify(order));
  // The two stretches no section stores: m9-12 ends on Verse 1's fill, so it is a chart piece of its
  // own; m21-24 is bar for bar the Verse 2 loop, so the chart replays that loop instead.
  check('chart: 41 bars; m9-12 is the one chart piece (c01), m21-24 replays the Verse 2 loop (04)',
    c.chart!.bars === 41 && c.sequences.filter((x) => x.kind === 'chart').map((x) => `${x.index} m${x.from}-${x.to}`).join() === 'c01 m9-12'
    && order.some((o) => o.index === 'c01' && o.from === 9 && o.to === 12) && order.some((o) => o.index === '04' && o.from === 21 && o.to === 24),
    JSON.stringify(order));
  const hc = createHash('sha256');
  hc.update(JSON.stringify(c.chart));
  for (const q of c.sequences.filter((x) => x.kind === 'chart')) hc.update(q.midi);
  const cd = hc.digest('hex').slice(0, 16);
  check('chart: frozen order + chart pieces', cd === FROZEN_CHART, `${cd} (${c.sequences.filter((x) => x.kind === 'chart').map((q) => `${q.index} ${q.name} m${q.from}-${q.to}`).join(', ')})`);
}

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall song-midi checks passed');
