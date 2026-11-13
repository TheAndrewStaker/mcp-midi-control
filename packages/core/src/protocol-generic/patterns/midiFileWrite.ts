/**
 * Standard MIDI File (.mid) writer: the export half of `midiFile.ts`.
 *
 * MIDI is the device-neutral output of the song pipeline: an MPC loads a `.mid`
 * straight into a sequence, every DAW imports one, and it is the only common
 * format that keeps exact note lengths and velocities. Anything a target needs
 * beyond notes (an MPC project's plugin tracks, a Circuit's step grid) is built
 * FROM these files, never in parallel with them.
 *
 * Writes format 1: track 0 is the conductor (song name, tempo map, metre map,
 * section markers), then one track per part (name, program, notes). Dependency
 * free, like the parser. Rules that keep the output unambiguous:
 *
 *  - at one tick, note-offs are written before note-ons, so a re-strike of the
 *    same pitch on the next beat is never swallowed by the previous note's off;
 *  - a same-pitch note struck while the previous one still sounds ends the
 *    previous one there (MIDI cannot sound one key twice; a reader would pair the
 *    offs arbitrarily otherwise);
 *  - a note's `bend` curve becomes pitch-bend messages (14-bit, centre 8192,
 *    scaled to the track's `bendRange`, announced by RPN 0 at tick 0), written
 *    after the tick's note-offs and before its note-ons;
 *  - every value is range-checked and refused, not clamped silently: a wrong
 *    channel or a non-power-of-two metre denominator is a caller bug.
 */

export const DEFAULT_TICKS_PER_BEAT = 960;

export interface SmfNote {
  /** Absolute tick of the note-on. */
  tick: number;
  note: number;          // 0..127
  velocity: number;      // 1..127
  durationTicks: number; // >= 1
  /**
   * A pitch-bend curve over this note: `at` ticks after the onset, `semis` semitones off the written
   * pitch (fractions allowed: a quarter-tone bend is 0.5). Written as pitch-bend messages on the
   * track's channel (it bends every note sounding there), scaled to the track's `bendRange`, and the
   * bend returns to centre when the note ends. Points at or past the note's end are not written.
   */
  bend?: { at: number; semis: number }[];
}

export interface SmfTrack {
  name: string;
  channel: number;       // 0..15 (9 = GM drums)
  /** Program change sent at tick 0 (0..127); omitted sends none. */
  program?: number;
  /**
   * Pitch-bend range in semitones (1..24) the track's `bend` curves are scaled to. When set, tick 0
   * carries RPN 0 (Pitch Bend Sensitivity, MIDI 1.0 spec: CC101 0, CC100 0, CC6 range, CC38 0, then
   * the RPN null CC101/CC100 127) and a centred bend. Required when any note carries a `bend`.
   */
  bendRange?: number;
  notes: SmfNote[];
}

export interface SmfTempo { tick: number; bpm: number }
export interface SmfMeter { tick: number; numerator: number; denominator: number }
export interface SmfMarker { tick: number; text: string }

export interface SmfSong {
  name?: string;
  ticksPerBeat?: number;
  tempos: SmfTempo[];
  meters: SmfMeter[];
  markers?: SmfMarker[];
  tracks: SmfTrack[];
  /** End of the song in ticks (a loop's exact length). Defaults to the last note-off. */
  endTick?: number;
}

function vlq(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0x0fffffff) throw new Error(`a MIDI delta time must be 0..268435455 ticks: ${n}`);
  const out = [n & 0x7f];
  let v = n >>> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return out;
}

const text = (s: string): number[] => [...Buffer.from(s, 'utf8')];

interface Ev { tick: number; order: number; bytes: number[] }

function chunk(events: Ev[], endTick: number): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    for (const x of vlq(e.tick - last)) body.push(x);
    for (const x of e.bytes) body.push(x);       // no spread: a dense track passes the argument limit
    last = e.tick;
  }
  body.push(...vlq(Math.max(0, endTick - last)), 0xff, 0x2f, 0x00);
  const n = body.length;
  return [0x4d, 0x54, 0x72, 0x6b, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].concat(body);
}

function meta(type: number, data: number[]): number[] {
  return [0xff, type, ...vlq(data.length), ...data];
}

function int(label: string, v: number, lo: number, hi: number): void {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${label} must be an integer ${lo}..${hi}: ${v}`);
}

/**
 * Notes with same-pitch overlaps resolved: the earlier one ends at the re-strike, and two onsets
 * on one tick become ONE note with the louder velocity and the longer length (a tab often doubles
 * an accented backbeat with a ghost copy; the accent is the hit).
 */
export function untangleNotes(notes: readonly SmfNote[]): SmfNote[] {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.note - b.note);
  const sounding = new Map<number, SmfNote>();
  const out: SmfNote[] = [];
  for (const n of sorted) {
    const prev = sounding.get(n.note);
    if (prev && prev.tick + prev.durationTicks > n.tick) {
      if (prev.tick === n.tick) {                     // a doubled onset: merge into one hit
        prev.velocity = Math.max(prev.velocity, n.velocity);
        prev.durationTicks = Math.max(prev.durationTicks, n.durationTicks);
        continue;
      }
      prev.durationTicks = n.tick - prev.tick;
    }
    const copy = { ...n };
    out.push(copy);
    sounding.set(n.note, copy);
  }
  return out;
}

export function writeMidiFile(song: SmfSong): Uint8Array {
  const tpb = song.ticksPerBeat ?? DEFAULT_TICKS_PER_BEAT;
  int('ticksPerBeat', tpb, 1, 0x7fff);
  if (song.tempos.length === 0) throw new Error('a MIDI song needs at least one tempo');
  if (song.meters.length === 0) throw new Error('a MIDI song needs at least one metre');

  let lastOff = 0;
  const trackEvents: Ev[][] = [];
  for (const t of song.tracks) {
    int(`track "${t.name}" channel`, t.channel, 0, 15);
    const evs: Ev[] = [{ tick: 0, order: 0, bytes: meta(0x03, text(t.name)) }];
    if (t.program !== undefined) {
      int(`track "${t.name}" program`, t.program, 0, 127);
      evs.push({ tick: 0, order: 1, bytes: [0xc0 | t.channel, t.program] });
    }
    const bends: { tick: number; order: number; semis: number }[] = [];
    for (const n of untangleNotes(t.notes)) {
      int(`track "${t.name}" note tick`, n.tick, 0, Number.MAX_SAFE_INTEGER);
      int(`track "${t.name}" note`, n.note, 0, 127);
      int(`track "${t.name}" velocity`, n.velocity, 1, 127);
      int(`track "${t.name}" duration`, n.durationTicks, 1, Number.MAX_SAFE_INTEGER);
      const off = n.tick + n.durationTicks;
      lastOff = Math.max(lastOff, off);
      evs.push({ tick: off, order: 2, bytes: [0x80 | t.channel, n.note, 0] });
      evs.push({ tick: n.tick, order: 3, bytes: [0x90 | t.channel, n.note, n.velocity] });
      if (n.bend?.length) {
        if (t.bendRange === undefined) throw new Error(`track "${t.name}" has a bent note but no bendRange`);
        for (const p of n.bend) {
          int(`track "${t.name}" bend offset`, p.at, 0, Number.MAX_SAFE_INTEGER);
          if (p.at < n.durationTicks) bends.push({ tick: n.tick + p.at, order: 1, semis: p.semis });
        }
        bends.push({ tick: off, order: 0, semis: 0 });   // back to centre; a next note's own bend at this tick wins
      }
    }
    if (t.bendRange !== undefined) {
      int(`track "${t.name}" bendRange`, t.bendRange, 1, 24);
      const r = t.bendRange;
      // One event per message (each needs its own delta time), in RPN order.
      ([[101, 0], [100, 0], [6, r], [38, 0], [101, 127], [100, 127]] as const).forEach(([c, v], i) => {
        evs.push({ tick: 0, order: 1.5 + i / 100, bytes: [0xb0 | t.channel, c, v] });
      });
      bends.push({ tick: 0, order: -1, semis: 0 });
      bends.sort((a, b) => a.tick - b.tick || a.order - b.order);
      let last: number | undefined;
      for (let i = 0; i < bends.length; i++) {
        const b = bends[i];
        if (i + 1 < bends.length && bends[i + 1].tick === b.tick) continue;   // the last word at a tick wins
        if (Math.abs(b.semis) > r + 1e-9) throw new Error(`track "${t.name}" bends ${b.semis} semitones at tick ${b.tick}, past its bendRange ${r}`);
        const v = Math.max(0, Math.min(16383, Math.round(8192 + (b.semis / r) * 8192)));
        if (v === last) continue;
        last = v;
        // Between this tick's note-offs (2) and note-ons (3): a scoop's starting bend precedes its note.
        evs.push({ tick: b.tick, order: 2.5, bytes: [0xe0 | t.channel, v & 0x7f, v >>> 7] });
      }
    }
    trackEvents.push(evs);
  }
  const end = song.endTick ?? lastOff;
  int('endTick', end, 0, Number.MAX_SAFE_INTEGER);
  if (end < lastOff) throw new Error(`endTick ${end} is before the last note-off (${lastOff}): the file would run past its end`);
  // A bend on the end tick itself (a last note's return to centre) is past a loop's end; the next
  // pass starts centred anyway (tick 0).
  for (let i = 0; i < trackEvents.length; i++) {
    trackEvents[i] = trackEvents[i].filter((e) => !((e.bytes[0] & 0xf0) === 0xe0 && e.tick > 0 && e.tick >= end));
  }
  int('track count', song.tracks.length, 0, 0xfffe);

  const cond: Ev[] = [];
  if (song.name) cond.push({ tick: 0, order: 0, bytes: meta(0x03, text(song.name)) });
  for (const m of song.meters) {
    int('metre numerator', m.numerator, 1, 255);
    const pow = Math.log2(m.denominator);
    if (!Number.isInteger(pow) || pow < 0 || pow > 7) throw new Error(`metre denominator must be a power of two: ${m.denominator}`);
    cond.push({ tick: m.tick, order: 1, bytes: meta(0x58, [m.numerator, pow, 24, 8]) });
  }
  for (const t of song.tempos) {
    const us = Math.round(60_000_000 / t.bpm);
    if (!(t.bpm > 0) || us > 0xffffff) throw new Error(`tempo must be a bpm the file can hold (3.58 or more): ${t.bpm}`);
    cond.push({ tick: t.tick, order: 2, bytes: meta(0x51, [(us >>> 16) & 0xff, (us >>> 8) & 0xff, us & 0xff]) });
  }
  for (const m of song.markers ?? []) cond.push({ tick: m.tick, order: 3, bytes: meta(0x06, text(m.text)) });

  const chunks: number[][] = [[
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    0, 1, (song.tracks.length + 1) >>> 8, (song.tracks.length + 1) & 0xff, tpb >>> 8, tpb & 0xff,
  ], chunk(cond, end), ...trackEvents.map((evs) => chunk(evs, end))];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
