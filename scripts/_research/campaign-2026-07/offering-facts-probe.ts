/**
 * OFFERING facts probe — READ-ONLY, OFFLINE.
 *
 * Decode all seven "The Offering" projects (Pack 5, device Projects 57-63) from
 * their newest canonical capture and write down EVERYTHING that must survive the
 * populate pass:
 *
 *   - name / colour / tempo / swing / scale
 *   - the six stored mixer levels + the drum sample binding
 *   - the top-level plain-chain table (0x2c4) per track, incl. the offset-721
 *     stale-chain fix on the three scene projects
 *   - the scene stack: defined flags, the four NOTE sub-tables, the four DRUM
 *     sub-tables, the scene-chain END byte + its two state bytes
 *   - every midi2 note pattern (the SPD-SX leg) as note/velocity/gate/tie/delay
 *   - the three voice_notes pins (60/61/62 + note_offset 12 = stored 72/73/74)
 *   - per-track pattern LENGTH bytes
 *   - a reconstruction of each pattern slot's DRUM VOICES by inverting the
 *     SPD-SX voice_map (+12), which is the payload the condensed layer needs
 *
 * Run: npx tsx samples/_scratch/offering-facts-probe.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, NOTE_TRACKS, PATTERNS_PER_TRACK, STEPS_PER_PATTERN,
  drumBlockIndex, noteBlockIndex, getProjectName, getProjectColour, projectColourName,
  getProjectTempo, getProjectSwing, checkNcsStructure,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
  type NoteTrack,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd, getSceneNoteChain, getSceneDrumChain } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { getProjectScale } from '@mcp-midi-control/circuit-tracks/ncs/scale.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const ROOT = 'C:/dev/mcp-midi-tools';
/** Newest canonical per slot: the 2026-07-30 binding-pass verify sweep, then the populate pass's own sweep for 57. */
const CANON_DIRS = [
  `${ROOT}/samples/circuit-ncs/bindings-2026-07-30/verify`,
  `${ROOT}/samples/circuit-ncs/populate-preauthor-2026-07-30`,
  `${ROOT}/samples/circuit-ncs/populate-authored-2026-07-30`,
];
const SLOTS = [57, 58, 59, 60, 61, 62, 63];

/** SPD-SX voice_map (GM), and the +12 the Circuit's midi2 leg carries. */
const SPDSX_GM: Record<string, number> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const NOTE_OFFSET = 12;
const STORED_TO_VOICE = new Map<number, string>(
  Object.entries(SPDSX_GM).map(([v, n]) => [n + NOTE_OFFSET, v]),
);
/** The three baked SPD-SX fills, pinned via voice_notes (pin + note_offset = stored). */
const PINS: Record<number, string> = { 72: 'bridgeroll(pin 60)', 73: 'buildupflurry(pin 61)', 74: 'breakdownroll(pin 62)' };

interface Capture { slot: number; file: string; buf: Uint8Array; when: string }

function newestPerSlot(): Map<number, Capture> {
  const out = new Map<number, Capture>();
  for (const dir of CANON_DIRS) {
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.ncs')) continue;
      const m = /pack5-project(\d+)-.*?-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.ncs$/.exec(f);
      if (!m) continue;
      const slot = Number(m[1]);
      if (!SLOTS.includes(slot)) continue;
      const when = m[2];
      const prev = out.get(slot);
      if (prev === undefined || when > prev.when) {
        out.set(slot, { slot, file: path.join(dir, f), buf: new Uint8Array(readFileSync(path.join(dir, f))), when });
      }
    }
  }
  return out;
}

const hex = (n: number): string => `0x${n.toString(16)}`;

interface SlotFacts {
  slot: number; file: string; when: string;
  name: string; colour: string; colour_byte: number; tempo: number; swing: number;
  scale: unknown;
  levels: { synth1: number; synth2: number; drums: number[] };
  binding: number[];
  chain: Record<string, { start: number; end: number } | undefined>;
  chain_bytes: Record<string, [number, number]>;
  scene_chain_end: number | undefined;
  scene_state: { a: number; b: number };
  scenes: Array<{ defined: boolean; notes: Record<string, string>; drums: string[] }>;
  midi2_patterns: Array<{
    pattern: number; length: number; hits: number;
    voices: Record<string, string>;
    unknown_notes: number[];
    pins: string[];
  }>;
  drum_patterns: Array<{ track: number; pattern: number; length: number; hits: number }>;
  note_lengths: Record<string, number[]>;
}

function factsFor(cap: Capture): SlotFacts {
  const buf = cap.buf;
  if (buf.length !== NCS_FILE_SIZE) throw new Error(`${cap.file} is ${buf.length} bytes`);
  const st = checkNcsStructure(buf);
  if (!st.ok) throw new Error(`${cap.file} structure faults: ${st.faults.join('; ')}`);

  const chain: SlotFacts['chain'] = {};
  const chainBytes: SlotFacts['chain_bytes'] = {};
  const CHAIN_BASE = 0x2c4;
  const trackOrder = ['synth1', 'synth2', 'midi1', 'midi2', 'drum1', 'drum2', 'drum3', 'drum4'];
  for (let i = 0; i < 8; i++) {
    const off = CHAIN_BASE + i * 4;
    chainBytes[trackOrder[i]] = [buf[off], buf[off + 1]];
  }
  for (const t of NOTE_TRACKS) chain[t] = getNoteChain(buf, t);

  const scenes: SlotFacts['scenes'] = [];
  for (let sc = 0; sc < 4; sc++) {
    const block = 0x50 + sc * 0x28;
    const defined = buf[block + 0x10] === 0x01;
    const notes: Record<string, string> = {};
    for (const t of NOTE_TRACKS) {
      const r = getSceneNoteChain(buf, sc, t);
      notes[t] = r ? `[${r.start},${r.end}]` : '(undef)';
    }
    const drums: string[] = [];
    for (let d = 0; d < 4; d++) {
      const r = getSceneDrumChain(buf, sc, d);
      drums.push(r ? `[${r.start},${r.end}]` : '(undef)');
    }
    scenes.push({ defined, notes, drums });
  }

  // midi2 patterns, decoded into voices by inverting the SPD-SX map.
  const midi2: SlotFacts['midi2_patterns'] = [];
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const steps = decodeNotePattern(buf, 'midi2', p);
    const len = buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1;
    const grids = new Map<string, string[]>();
    const unknown = new Set<number>();
    const pins = new Set<string>();
    let hits = 0;
    for (let s = 0; s < STEPS_PER_PATTERN; s++) {
      for (const slot of steps[s]?.notes ?? []) {
        hits++;
        const pin = PINS[slot.note];
        if (pin !== undefined) { pins.add(`${pin}@step${s + 1}v${slot.velocity}`); continue; }
        const v = STORED_TO_VOICE.get(slot.note);
        if (v === undefined) { unknown.add(slot.note); continue; }
        let g = grids.get(v);
        if (g === undefined) { g = Array.from({ length: STEPS_PER_PATTERN }, () => '~'); grids.set(v, g); }
        // Keep the loudest if a voice somehow repeats on one step.
        const cur = g[s];
        const tok = `${v}@${slot.velocity}${slot.delay ? `d${slot.delay}` : ''}`;
        if (cur === '~') g[s] = tok;
      }
    }
    const voices: Record<string, string> = {};
    for (const [v, g] of grids) voices[v] = g.join(' ');
    midi2.push({
      pattern: p, length: len, hits, voices,
      unknown_notes: [...unknown].sort((a, b) => a - b),
      pins: [...pins],
    });
  }

  const drumPats: SlotFacts['drum_patterns'] = [];
  for (let t = 0; t < 4; t++) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const g = decodeDrumPattern(buf, t, p);
      const hits = g.filter((c) => c.active).length;
      drumPats.push({ track: t, pattern: p, length: buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1, hits });
    }
  }

  const noteLengths: Record<string, number[]> = {};
  for (const t of NOTE_TRACKS) {
    noteLengths[t] = Array.from({ length: PATTERNS_PER_TRACK }, (_, p) => buf[META_OFFSETS[noteBlockIndex(t as NoteTrack, p)]] + 1);
  }

  return {
    slot: cap.slot, file: path.basename(cap.file), when: cap.when,
    name: getProjectName(buf),
    colour: projectColourName(getProjectColour(buf)), colour_byte: getProjectColour(buf),
    tempo: getProjectTempo(buf), swing: getProjectSwing(buf),
    scale: getProjectScale(buf),
    levels: {
      synth1: buf[MIXER_SYNTH1_LEVEL], synth2: buf[MIXER_SYNTH2_LEVEL],
      drums: [0, 1, 2, 3].map((n) => buf[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE]),
    },
    binding: getDrumSampleBinding(buf),
    chain, chain_bytes: chainBytes,
    scene_chain_end: getSceneChainEnd(buf),
    scene_state: { a: buf[0x26fbc], b: buf[0x26fd2] },
    scenes,
    midi2_patterns: midi2,
    drum_patterns: drumPats,
    note_lengths: noteLengths,
  };
}

const caps = newestPerSlot();
const all: SlotFacts[] = [];
for (const slot of SLOTS) {
  const c = caps.get(slot);
  if (c === undefined) { console.log(`slot ${slot}: NO CANONICAL CAPTURE FOUND`); continue; }
  const f = factsFor(c);
  all.push(f);
  console.log(`\n========== Project ${slot} — "${f.name}" (${f.file}) ==========`);
  console.log(`  colour ${f.colour} (${f.colour_byte})  tempo ${f.tempo}  swing ${f.swing}  scale ${JSON.stringify(f.scale)}`);
  console.log(`  levels synth1=${f.levels.synth1} synth2=${f.levels.synth2} drums=[${f.levels.drums.join(',')}]  binding=[${f.binding.join(',')}]`);
  console.log(`  plain chain table (${hex(0x2c4)}): ${Object.entries(f.chain_bytes).map(([t, [s, e]]) => `${t}=[${s},${e}]`).join(' ')}`);
  console.log(`  midi2 END byte @721 = ${f.chain_bytes.midi2[1]}`);
  console.log(`  scene-chain end = ${f.scene_chain_end ?? '(none)'}   state a@0x26fbc=${f.scene_state.a} b@0x26fd2=${f.scene_state.b}`);
  for (let sc = 0; sc < 4; sc++) {
    const s = f.scenes[sc];
    console.log(`    scene ${sc + 1}: defined=${s.defined} notes{${Object.entries(s.notes).map(([k, v]) => `${k}${v}`).join(' ')}} drums[${s.drums.join(' ')}]`);
  }
  console.log(`  note pattern lengths: ${Object.entries(f.note_lengths).map(([t, l]) => `${t}=[${l.join(',')}]`).join('  ')}`);
  const drumHits = f.drum_patterns.filter((d) => d.hits > 0);
  console.log(`  internal drum content: ${drumHits.length === 0 ? 'NONE (all 32 drum patterns empty)' : drumHits.map((d) => `d${d.track + 1}p${d.pattern}=${d.hits}`).join(' ')}`);
  for (const p of f.midi2_patterns) {
    if (p.hits === 0) { console.log(`  midi2 p${p.pattern}: EMPTY (len ${p.length})`); continue; }
    console.log(`  midi2 p${p.pattern}: len ${p.length}, ${p.hits} note-slot(s), voices: ${Object.keys(p.voices).join(', ') || '(none)'}` +
      `${p.pins.length ? `  PINS: ${p.pins.join(', ')}` : ''}${p.unknown_notes.length ? `  UNKNOWN NOTES: ${p.unknown_notes.join(',')}` : ''}`);
  }
}

writeFileSync(`${ROOT}/samples/_scratch/offering-facts.json`, JSON.stringify(all, null, 2));
console.log(`\nwrote samples/_scratch/offering-facts.json (${all.length} projects)`);
