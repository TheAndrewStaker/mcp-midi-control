/**
 * Song spec -> MIDI files + manifest, for any sequence-playing target (MPC, DAW).
 *
 *   npx tsx scripts/export-song-midi.ts <spec.json> <out dir>
 *
 * The spec names the Songsterr parts (a cached part JSON path, or a song id + part id fetched
 * into samples/songsterr-cache/), the section table (1-based inclusive measures) and the owner's
 * corrections (per-section parts, borrowed bars, held pads, a melodic part's ghosted notes or
 * measure ranges left out: `dropGhosts` / `skipMeasures`). Writes:
 *
 *   <out>/<Song> - Full.mid           whole song, section markers
 *   <out>/sections/NN <Section>.mid   one per sequence (NNb = that section's fill, cNN = a chart piece)
 *   <out>/song.json                   manifest: sequences, bars, tempo, tracks + their role (+ `chart`)
 *   <out>/pitchbend/...               only with a `bends: "glide"` part: the same files, those parts
 *                                     as real pitch-bend messages (manifest `pitchbend`)
 *
 * Drum tracks are Drums + Percussion (spec `percussion`, songMidi.ts `splitPercussion`): kit
 * pieces stay on the kit tracks, every other drum note plays on one "Percussion" kit track.
 *
 * A project writer (bouncer `mpcproject midi`) builds the MPC project from these files only.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  buildSongMidi,
  rebarDrums,
  rebarMelodic,
  translateRange,
  translateBorrow,
  type RebarMap,
  type RebarRange,
  flattenSongsterrDrums,
  flattenSongsterrMelodic,
  splitPercussion,
  partTracks,
  filterMelodicPart,
  DEFAULT_BEND_RANGE,
  type PercussionSplit,
  type SongsterrPart,
  type SongsterrMelodicFlat,
  type SongMidiPart,
  type SongMidiSection,
} from '../packages/core/src/protocol-generic/patterns/index.js';
import { fetchSongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterrFetch.js';

interface SpecPart {
  name: string;
  /** A cached part JSON (repo-relative or absolute). */
  file?: string;
  /** Or fetch: Songsterr part id (needs spec.source.songId). */
  partId?: number;
  kind: 'drums' | 'melodic';
  channel?: number;
  program?: number;
  transpose?: number;
  sustainRepeats?: boolean;
  /** Melodic: keep one voice per chord (songMidi.ts `monoVoice`: 0 lowest, -1 highest). */
  monoVoice?: number;
  /**
   * Melodic: write the tab's bends / scoops / falls (songMidi.ts `bends`). `glide`: as overlapping
   * notes a mono legato synth glides through (what an MPC project plays today: its sequences carry
   * no pitch-bend event we have evidence for); the export then ALSO writes `pitchbend/`, the same
   * files with these parts as real pitch-bend messages, for a DAW or a manual import. `pitchbend`:
   * real pitch-bend messages in the main files.
   */
  bends?: 'glide' | 'pitchbend';
  /** Semitones the pitch-bend messages are scaled to (RPN 0 in the file). Default 12. */
  bendRange?: number;
  /** Semitones an unwritten slide (scoop / fall) covers. Default 2. */
  slideSemitones?: number;
  /** With `bends: "pitchbend"`: also write the tab's vibrato as a periodic bend (songMidi.ts `vibrato`). */
  vibrato?: boolean;
  /** What plays it on a target: a drum kit, a synth plugin, or nothing (the owner plays it). */
  role: 'kit' | 'synth' | 'muted';
  /** Drums: remap source numbers the tab writes off GM, e.g. {"27": 36, "28": 38} (a GM number or a voice name). */
  drumMap?: Record<string, number | string>;
  /**
   * Melodic: leave out every note the tab marks ghost (songMidi.ts `filterMelodicPart`), e.g. a line
   * engraved in three octaves with the outer two ghosted. Drum ghosts always play soft; not for drums.
   */
  dropGhosts?: boolean;
  /**
   * Melodic: tab measure ranges (1-based inclusive, [[61, 76]]) the part is silent in, applied before
   * any re-bar and before the sections are cut. A held note stops where a range starts.
   */
  skipMeasures?: [number, number][];
}

interface Spec {
  title: string;
  artist: string;
  source: { songId?: number; revisionId?: number; note?: string };
  parts: SpecPart[];
  sections: SongMidiSection[];
  /**
   * One tempo for the whole song, replacing the tab's tempo map: for a tab whose marking is wrong
   * against the record (one tab says 95 where the record is 89). Notes keep their bars; only
   * the speed changes. Cite the reason in `notes`.
   */
  bpm?: number;
  /**
   * Re-bar tab measure ranges x2 or x0.5 (rebar.ts): a tab notated half-time or double-time
   * plays at the musical tempo with the same sound. Sections stay written in TAB measures; the
   * manifest's from/to are the new bars. A section `bpm` is the tempo it plays at on the target
   * (after the re-bar). Not combinable with a song `bpm` (which tempo would that be?).
   */
  rebar?: RebarRange[];
  /**
   * Drums + Percussion (songMidi.ts `splitPercussion`): kit pieces stay on the kit tracks; every
   * other drum note moves to one "Percussion" track right after the first kit track. `merge`
   * (default) also folds whole every drum part that is all percussion (a tab's Tambourine,
   * Congas, Perc); `separate` keeps those as their own tracks.
   */
  percussion?: 'merge' | 'separate';
  /**
   * The full chart (songMidi.ts option `chart`): for a song whose loops are condensed grooves or
   * start after bar 1, also cut every stretch no loop covers into `cNN` chart sequences, and write
   * the manifest's `chart` order (bar 1 to the end, once). A project writer plays it as a second
   * song (bouncer: Song 2 "<Title> Full").
   */
  chart?: true;
  notes?: string[];
}

const ROOT = resolve(import.meta.dirname, '..');
const CACHE = join(ROOT, 'samples', 'songsterr-cache');
const safe = (s: string) => s.replace(/[<>:"/\\|?*]/g, '').trim();

async function loadPart(spec: Spec, p: SpecPart): Promise<SongsterrPart> {
  if (p.file) return JSON.parse(readFileSync(resolve(ROOT, p.file), 'utf8')) as SongsterrPart;
  if (p.partId === undefined || spec.source.songId === undefined) throw new Error(`part "${p.name}" needs file or partId + source.songId`);
  const cached = join(CACHE, `s${spec.source.songId}`, `part-${p.partId}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as SongsterrPart;
  const got = await fetchSongsterrPart(String(spec.source.songId), { track: p.partId });
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, JSON.stringify(got.part));
  return got.part;
}

/** A melodic part's notes, with its `dropGhosts` / `skipMeasures` applied (in tab measures, before any re-bar). */
function melodicOf(p: SpecPart, raw: SongsterrPart, report: string[]): SongsterrMelodicFlat {
  const flat = flattenSongsterrMelodic(raw);
  if (p.dropGhosts === undefined && p.skipMeasures === undefined) return flat;
  const r = filterMelodicPart(p.name, flat, { dropGhosts: p.dropGhosts, skipMeasures: p.skipMeasures });
  report.push(...r.report);
  return r.flat;
}

async function main(): Promise<void> {
  const [specPath, outArg] = process.argv.slice(2);
  if (!specPath || !outArg) throw new Error('usage: export-song-midi.ts <spec.json> <out dir>');
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  // Melodic parts take the free channels in order (never 9, the GM drum channel, and never one a
  // part names explicitly); drums default to 9.
  const taken = new Set(spec.parts.map((p) => p.channel).filter((c): c is number => c !== undefined));
  const free = Array.from({ length: 16 }, (_, c) => c).filter((c) => c !== 9 && !taken.has(c));
  const parts: SongMidiPart[] = [];
  const filterReport: string[] = [];
  for (const p of spec.parts) {
    if (p.kind === 'drums' && (p.dropGhosts !== undefined || p.skipMeasures !== undefined)) throw new Error(`part "${p.name}": dropGhosts / skipMeasures are for melodic parts`);
    const raw = await loadPart(spec, p);
    const auto = p.kind === 'drums' ? 9 : free.shift();
    if (auto === undefined && p.channel === undefined) throw new Error(`part "${p.name}": no free MIDI channel left`);
    const channel = p.channel ?? auto!;
    const drumMap = p.drumMap && Object.fromEntries(Object.entries(p.drumMap).map(([k, v]) => [Number(k), v]));
    parts.push(p.kind === 'drums'
      ? { name: p.name, channel, program: p.program, reference: p.role === 'muted', drums: flattenSongsterrDrums(raw, { splitToms: true, ...(drumMap ? { drumMap } : {}) }) }
      : {
        name: p.name, channel, program: p.program, transpose: p.transpose, sustainRepeats: p.sustainRepeats, melodic: melodicOf(p, raw, filterReport),
        ...(p.monoVoice !== undefined ? { monoVoice: p.monoVoice } : {}),
        ...(p.bends !== undefined ? { bends: p.bends } : {}),
        ...(p.bends === 'pitchbend' && p.bendRange !== undefined ? { bendRange: p.bendRange } : {}),
        ...(p.slideSemitones !== undefined ? { slideSemitones: p.slideSemitones } : {}),
        ...(p.vibrato !== undefined ? { vibrato: p.vibrato } : {}),
      });
    if (p.kind === 'drums' && (p.monoVoice !== undefined || p.bends !== undefined || p.vibrato !== undefined)) throw new Error(`part "${p.name}": monoVoice / bends / vibrato are for melodic parts`);
    if (p.bendRange !== undefined && p.bends === undefined) throw new Error(`part "${p.name}": bendRange needs bends`);
    if (p.vibrato !== undefined && p.bends !== 'pitchbend') throw new Error(`part "${p.name}": vibrato needs bends "pitchbend"`);
  }
  if (spec.bpm !== undefined) {
    for (const p of parts) {
      const flat = (p.drums ?? p.melodic)!;
      flat.tempos = [{ measure: 0, beat: 0, bpm: spec.bpm }];
      flat.bpm = spec.bpm;
      for (const m of flat.measures) m.bpm = spec.bpm;
    }
  }
  let sections = spec.sections;
  if (spec.rebar?.length) {
    if (spec.bpm !== undefined) throw new Error('spec has both bpm and rebar: set the tempo per section after the re-bar instead');
    let map: RebarMap | undefined;
    for (const p of parts) {
      let m: RebarMap;
      if (p.drums) ({ flat: p.drums, map: m } = rebarDrums(p.drums, spec.rebar));
      else ({ flat: p.melodic, map: m } = rebarMelodic(p.melodic!, spec.rebar));
      // Every part must re-bar identically, or sections translated with one map cut another.
      if (map && JSON.stringify(map.bars) !== JSON.stringify(m.bars)) throw new Error(`part "${p.name}" has another bar layout than the first part: re-bar refused`);
      map = m;
    }
    sections = spec.sections.map((s) => ({
      ...s,
      ...translateRange(map!, s.from, s.to, `section "${s.name}"`),
      ...(s.borrow ? { borrow: Object.fromEntries(Object.entries(s.borrow).map(([k, at]) => [k, translateBorrow(map!, at, s.from, s.to, `section "${s.name}" borrow "${k}"`)])) } : {}),
    }));
  }
  const mode = spec.percussion ?? 'merge';
  if (mode !== 'merge' && mode !== 'separate') throw new Error(`spec percussion must be "merge" or "separate": ${String(mode)}`);
  const title = `${spec.title} (${spec.artist})`;
  let split: PercussionSplit = splitPercussion(parts, mode);
  if (spec.chart !== undefined && spec.chart !== true) throw new Error(`spec chart must be true or absent: ${String(spec.chart)}`);
  const opts = { chart: spec.chart === true };
  let build = buildSongMidi(title, parts, sections, split.tracks, opts);
  // Percussion that no sequence plays (every note outside the sections, or on a part the sections
  // silence) would be an empty kit track on the target: keep the plain layout instead.
  const pName = split.percussion !== undefined ? split.tracks[split.percussion].name : undefined;
  if (pName !== undefined && build.sequences.every((q) => q.notes[pName].length === 0)) {
    // Said on the console only: the manifest stays exactly the plain export's.
    console.log(`  note: ${pName}: no sequence plays a percussion note (${split.report.map((r) => r.slice(pName.length + 2)).join('; ')}), so no ${pName} track`);
    split = { tracks: partTracks(parts), report: [] };
    build = buildSongMidi(title, parts, sections, split.tracks, opts);
  }

  const out = resolve(outArg);
  mkdirSync(join(out, 'sections'), { recursive: true });
  writeFileSync(join(out, `${safe(spec.title)} - Full.mid`), build.full);
  for (const q of build.sequences) writeFileSync(join(out, 'sections', `${q.index} ${safe(q.name)}.mid`), q.midi);

  // `bends: "glide"` parts: the same files again under pitchbend/, those parts as real pitch bend.
  const glided = spec.parts.flatMap((p, i) => (p.bends === 'glide' ? [i] : []));
  let pitchbend: { note: string; parts: { name: string; bendRange: number }[]; full: string; sections: string[] } | undefined;
  if (glided.length) {
    const pbParts: SongMidiPart[] = parts.map((p, i) => (glided.includes(i)
      ? { ...p, bends: 'pitchbend' as const, ...(spec.parts[i].bendRange !== undefined ? { bendRange: spec.parts[i].bendRange } : {}) }
      : p));
    const pb = buildSongMidi(title, pbParts, sections, split.tracks, opts);
    const shape = (b: typeof build) => b.sequences.map((q) => `${q.index} ${q.name} ${q.from}-${q.to}`).join('|');
    if (shape(pb) !== shape(build)) throw new Error('the pitch-bend export cuts other sequences than the glide export: refused (a bend-only difference between two sections?)');
    mkdirSync(join(out, 'pitchbend', 'sections'), { recursive: true });
    const full = `pitchbend/${safe(spec.title)} - Full.mid`;
    writeFileSync(join(out, full), pb.full);
    const files = pb.sequences.map((q) => `pitchbend/sections/${q.index} ${safe(q.name)}.mid`);
    pb.sequences.forEach((q, i) => writeFileSync(join(out, files[i]), q.midi));
    pitchbend = {
      note: 'The same sequences with the bends:"glide" parts written as written notes + real pitch-bend messages (RPN 0 sets the range) instead of glide notes: for a DAW or a manual MIDI import. The project is built from sections/.',
      parts: glided.map((i) => ({ name: spec.parts[i].name, bendRange: spec.parts[i].bendRange ?? DEFAULT_BEND_RANGE })),
      full,
      sections: files,
    };
    for (const n of pb.notes.filter((x) => glided.some((i) => x.startsWith(`${spec.parts[i].name}: `) && x.includes('pitch bend')))) console.log(`  pitchbend/: ${n}`);
  }

  const manifest = {
    title: spec.title,
    artist: spec.artist,
    source: spec.source,
    ticksPerBeat: 960,
    // The synthesized Percussion track plays on a kit; every other track is its source part.
    tracks: split.tracks.map((t, i) => (i === split.percussion
      ? { name: t.name, kind: 'drums' as const, role: 'kit' as const, channel: t.channel }
      : { name: t.name, kind: spec.parts[t.sources[0].part].kind, role: spec.parts[t.sources[0].part].role, channel: t.channel })),
    sequences: build.sequences.map((q) => ({
      index: q.index, name: q.name, kind: q.kind, ...(q.loop ? {} : { oneShot: true }), from: q.from, to: q.to, bars: q.bars, beats: q.beats,
      bpm: q.bpm, signature: q.signature, plays: q.plays, file: `sections/${q.index} ${safe(q.name)}.mid`,
      notes: Object.fromEntries(Object.entries(q.notes).map(([k, v]) => [k, v.length])),
    })),
    full: `${safe(spec.title)} - Full.mid`,
    ...(build.chart ? { chart: build.chart } : {}),
    ...(pitchbend ? { pitchbend } : {}),
    ...(spec.rebar?.length ? { rebar: spec.rebar, barsNote: 'from/to are bars after the re-bar, not tab measures' } : {}),
    notes: [...(spec.notes ?? []), ...filterReport, ...split.report, ...build.notes],
  };
  writeFileSync(join(out, 'song.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const q of manifest.sequences) {
    console.log(`  ${q.index.padEnd(3)} ${q.name.padEnd(22)} m${q.from}-${q.to} ${String(q.bars).padStart(2)} bars ${q.bpm} bpm  ${JSON.stringify(q.notes)}${q.plays.length > 1 ? `  plays: ${q.plays.join(', ')}` : ''}`);
  }
  for (const n of [...filterReport, ...split.report, ...build.notes]) console.log(`  note: ${n}`);
  console.log(`wrote ${build.sequences.length} sequence(s) + full song -> ${out}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
