/**
 * breakdown-drum-analysis.ts — Tom Petty "Breakdown" drum audit (READ-ONLY).
 *
 * Answers two questions the maintainer raised about the authored Breakdown
 * projects (pack 5, projects 35-39 "Breakdown P1".."Breakdown P5"):
 *
 *   1. VELOCITY. Are the drum hits flat (all DEFAULT_HIT_VELOCITY = 100) or do
 *      they carry dynamics? He believes the final snare of the opening figure
 *      should be a GHOST (quiet tail hit) and is being played at full strength.
 *   2. TIMING. Where do the hits sit, what rests exist, and can the Circuit's
 *      32-step grid + 6-tick micro-hit mask represent the source's rhythm?
 *
 * Also fetches the Songsterr source (song 23527) and reports its ghost /
 * grace-note flags so the authored grid can be diffed against source truth.
 *
 * READ-ONLY: opens no MIDI port, writes no project file. Optional --json dumps
 * the analysis for a follow-up edit script.
 *
 *   npx tsx scripts/breakdown-drum-analysis.ts              # local .ncs census
 *   npx tsx scripts/breakdown-drum-analysis.ts --source     # + Songsterr fetch
 *   npx tsx scripts/breakdown-drum-analysis.ts --source --json out.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDrumPattern, type DrumStep } from '../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../packages/circuit-tracks/src/ncs/notePattern.js';
import {
  META_OFFSETS, NOTE_TRACKS, NUM_DRUM_TRACKS, PATTERNS_PER_TRACK,
  drumBlockIndex, noteBlockIndex, getDrumLevel, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const ROOT = join(import.meta.dirname, '..');
const PACK5 = join(ROOT, 'samples', 'circuit-ncs', 'pack5');
const SONG_ID = 23527; // Tom Petty — Breakdown
const PROJECTS = [35, 36, 37, 38, 39];

const argv = process.argv.slice(2);
const wantSource = argv.includes('--source');
const jsonIdx = argv.indexOf('--json');
const jsonOut = jsonIdx >= 0 ? argv[jsonIdx + 1] : undefined;

const projName = (buf: Uint8Array): string => {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s.trim();
};

/** Render the 6-bit positional micro-hit mask as a readable tick string. */
const microStr = (m: number): string => {
  if (m === 1) return 'on-beat';
  const ticks: number[] = [];
  for (let k = 0; k < 6; k++) if ((m >> k) & 1) ticks.push(k);
  return `ticks[${ticks.join(',')}]`;
};

interface HitRow {
  project: number; name: string; track: number; pattern: number; step: number;
  velocity: number; probability: number; micro: number; drumChoice: number;
}

const hits: HitRow[] = [];
const perProject: { n: number; name: string; lengths: string; levels: number[]; noteTracks: string[] }[] = [];

console.log('='.repeat(78));
console.log('BREAKDOWN DRUM AUDIT — pack 5 projects 35-39');
console.log('='.repeat(78));

for (const n of PROJECTS) {
  const file = join(PACK5, `proj${String(n).padStart(2, '0')}.ncs`);
  let buf: Uint8Array;
  try { buf = readFileSync(file); } catch { console.log(`\nproject ${n}: MISSING (${file})`); continue; }
  const name = projName(buf);
  const levels: number[] = [];
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) levels.push(getDrumLevel(buf, t));

  // pattern lengths (byte 0 of each block's metadata = steps-1)
  const lens: string[] = [];
  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    const row: number[] = [];
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) row.push(buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1);
    lens.push(`D${t + 1}:${row.join(',')}`);
  }

  // note tracks carrying content (dual-target: drums may also drive the SPD-SX over MIDI)
  const noteInfo: string[] = [];
  for (const tr of NOTE_TRACKS) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const steps = decodeNotePattern(buf, tr as NoteTrack, p);
      const live = steps.filter((s) => s.active);
      if (live.length === 0) continue;
      const notes = [...new Set(live.flatMap((s) => s.notes.map((x) => x.note)))].sort((a, b) => a - b);
      const vels = [...new Set(live.flatMap((s) => s.notes.map((x) => x.velocity)))].sort((a, b) => a - b);
      const dels = [...new Set(live.flatMap((s) => s.notes.map((x) => x.delay)))].sort((a, b) => a - b);
      const gates = [...new Set(live.flatMap((s) => s.notes.map((x) => x.gate)))].sort((a, b) => a - b);
      const plen = buf[META_OFFSETS[noteBlockIndex(tr as NoteTrack, p)]] + 1;
      noteInfo.push(`${tr} p${p + 1} len=${plen} steps=${live.length} notes=[${notes.join(',')}] vel=[${vels.join(',')}] delay=[${dels.join(',')}] gate=[${gates.join(',')}]`);
    }
  }

  perProject.push({ n, name, lengths: lens.join('  '), levels, noteTracks: noteInfo });

  console.log(`\n--- project ${n}  "${name}" ---`);
  console.log(`  drum levels: ${levels.join(', ')}`);
  console.log(`  pattern lengths: ${lens.join('  ')}`);

  for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const steps: DrumStep[] = decodeDrumPattern(buf, t, p);
      const live = steps.map((s, i) => ({ s, i })).filter((x) => x.s.active);
      if (live.length === 0) continue;
      const plen = buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1;
      const grid = steps.slice(0, plen).map((s) => (s.active ? 'x' : '.')).join('');
      const velStr = live.map((x) => x.s.velocity).join(',');
      const micros = [...new Set(live.map((x) => x.s.microHits))];
      console.log(`  D${t + 1} p${p + 1} len=${plen}  ${grid}`);
      console.log(`      vel: ${velStr}`);
      if (micros.some((m) => m !== 1)) {
        console.log(`      micro: ${live.filter((x) => x.s.microHits !== 1).map((x) => `s${x.i}=${microStr(x.s.microHits)}`).join(' ')}`);
      }
      for (const { s, i } of live) {
        hits.push({ project: n, name, track: t, pattern: p, step: i, velocity: s.velocity, probability: s.probability, micro: s.microHits, drumChoice: s.drumChoice });
      }
    }
  }
  for (const line of noteInfo) console.log(`  NOTE ${line}`);
}

// ── velocity distribution ────────────────────────────────────────────
console.log('\n' + '='.repeat(78));
console.log('VELOCITY DISTRIBUTION (all Breakdown drum hits)');
console.log('='.repeat(78));
const dist = new Map<number, number>();
for (const h of hits) dist.set(h.velocity, (dist.get(h.velocity) ?? 0) + 1);
for (const [v, c] of [...dist].sort((a, b) => a[0] - b[0])) {
  console.log(`  velocity ${String(v).padStart(3)}  ×${String(c).padStart(4)}  ${'#'.repeat(Math.min(60, c))}`);
}
console.log(`  TOTAL hits: ${hits.length}, distinct velocities: ${dist.size}`);

const microDist = new Map<number, number>();
for (const h of hits) microDist.set(h.micro, (microDist.get(h.micro) ?? 0) + 1);
console.log('\nMICRO-HIT MASK DISTRIBUTION (drum timing nudge):');
for (const [m, c] of [...microDist].sort((a, b) => a[0] - b[0])) {
  console.log(`  mask 0x${m.toString(16).padStart(2, '0')} (${microStr(m)})  ×${c}`);
}

// ── Songsterr source ─────────────────────────────────────────────────
interface SourceOut {
  bpm?: number; signature?: [number, number]; totalBeats?: number;
  ghosts?: number; graces?: number; flams?: number;
  events?: { voice: string; beat: number; ghost?: boolean; accent?: boolean }[];
}
const source: SourceOut = {};

if (wantSource) {
  console.log('\n' + '='.repeat(78));
  console.log(`SONGSTERR SOURCE — song ${SONG_ID} (Tom Petty, Breakdown)`);
  console.log('='.repeat(78));
  const core = await import('@mcp-midi-control/core/protocol-generic/patterns/index.js');
  const part = await core.fetchSongsterrPart(String(SONG_ID));
  const flat = core.flattenSongsterrDrums(part.part ?? part);
  source.bpm = flat.bpm; source.signature = flat.signature; source.totalBeats = flat.totalBeats;
  source.ghosts = flat.ghosts; source.graces = flat.graces_folded; source.flams = flat.flams_collapsed;
  source.events = flat.events.map((e: any) => ({ voice: e.voice, beat: e.beat, ...(e.ghost ? { ghost: true } : {}), ...(e.accent ? { accent: true } : {}) }));
  console.log(`  bpm=${flat.bpm}  sig=${flat.signature.join('/')}  totalBeats=${flat.totalBeats}  measures=${flat.measures.length}`);
  console.log(`  ghosts=${flat.ghosts}  graces_folded=${flat.graces_folded}  flams_collapsed=${flat.flams_collapsed}  unmapped=${flat.unmapped}`);
  console.log(`  tempos: ${JSON.stringify(flat.tempos)}`);
  console.log(`  sections: ${flat.sections.map((s: any) => `${s.name}@m${s.startMeasure}`).join(', ')}`);

  // first 8 measures, event by event, with beat-in-measure
  console.log('\n  FIRST 8 MEASURES (beat = quarter notes from song start):');
  const beatsPerMeasure = (flat.signature[0] * 4) / flat.signature[1];
  for (const e of flat.events.filter((x: any) => x.beat < beatsPerMeasure * 8)) {
    const m = Math.floor(e.beat / beatsPerMeasure);
    const inM = e.beat - m * beatsPerMeasure;
    const sixteenth = inM * 4;
    const flags = [(e as any).ghost ? 'GHOST' : '', (e as any).accent ? 'ACCENT' : ''].filter(Boolean).join(' ');
    console.log(`    m${String(m + 1).padStart(2)}  beat ${inM.toFixed(3).padStart(6)}  (16th #${sixteenth.toFixed(2).padStart(5)})  ${e.voice.padEnd(12)} ${flags}`);
  }

  // ghost census by voice
  const ghostByVoice = new Map<string, number>();
  const allByVoice = new Map<string, number>();
  for (const e of flat.events) {
    allByVoice.set(e.voice, (allByVoice.get(e.voice) ?? 0) + 1);
    if ((e as any).ghost) ghostByVoice.set(e.voice, (ghostByVoice.get(e.voice) ?? 0) + 1);
  }
  console.log('\n  EVENTS BY VOICE (ghosted / total):');
  for (const [v, tot] of [...allByVoice].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${v.padEnd(14)} ${String(ghostByVoice.get(v) ?? 0).padStart(4)} / ${String(tot).padStart(4)}`);
  }

  // off-16th-grid check: does the source rhythm fit a 16th grid?
  const offGrid = flat.events.filter((e: any) => Math.abs(e.beat * 4 - Math.round(e.beat * 4)) > 1e-6);
  console.log(`\n  OFF-16TH-GRID events: ${offGrid.length} / ${flat.events.length}`);
  if (offGrid.length) {
    const frac = new Map<string, number>();
    for (const e of offGrid) {
      const f = (e.beat * 4) % 1;
      const key = f.toFixed(4);
      frac.set(key, (frac.get(key) ?? 0) + 1);
    }
    console.log(`    fractional-16th offsets seen: ${[...frac].sort().map(([k, c]) => `${k}×${c}`).join(', ')}`);
  }
  const offTrip = flat.events.filter((e: any) => Math.abs(e.beat * 6 - Math.round(e.beat * 6)) > 1e-6);
  console.log(`  OFF-TRIPLET(24th)-GRID events: ${offTrip.length} / ${flat.events.length}`);
  // 6 micro-ticks per 16th step => 96th-note resolution overall
  const off96 = flat.events.filter((e: any) => Math.abs(e.beat * 24 - Math.round(e.beat * 24)) > 1e-6);
  console.log(`  OFF-96TH-GRID (16th step x 6 micro-ticks) events: ${off96.length} / ${flat.events.length}`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ perProject, hits, source }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}
