/**
 * track-swap-census.mts - OFFLINE, read-only. What every project holds on its four NOTE tracks, ahead
 * of the 2026-10-19 swap (external synths move Synth 1/2 -> MIDI 1/2).
 *
 * Per project: note onsets per track, pattern chain, scene selections, synth mixer levels, and - the
 * question a block move cannot answer by itself - whether any note BLOCK carries content OUTSIDE its
 * 896-byte step region and length byte. A note block is 3240 bytes; the step region is the only part
 * the swap moves, so anything else that differs from the blank template (automation lanes, most
 * likely) would stay behind on its old track. On a MIDI track that content would start sending CCs to
 * an external synth, so it has to be found before the move, not after.
 *
 * Usage: npx tsx scripts/_research/track-swap-census.mts <sweepRoot>   (root holding pack1/ ... pack5/)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NCS_FILE_SIZE, META_OFFSETS, NOTE_STEP_REGION, PATTERNS_PER_TRACK, getProjectName, getSynthLevel,
  noteBlockIndex, noteStepBase, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getNoteChain } from '../../packages/circuit-tracks/src/ncs/chain.js';
import { getSceneNoteChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
/** Bytes per note block: the distance between consecutive META offsets of one track kind. */
const BLOCK = META_OFFSETS[1] - META_OFFSETS[0];
const BLANK = new Uint8Array(readFileSync('samples/circuit-tracks/blank_slot20.ncs'));

export function notes(buf: Uint8Array, t: NoteTrack): number {
  let n = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) for (const s of decodeNotePattern(buf, t, p)) if (s.active) n += s.notes.length;
  return n;
}

/** Bytes in a track's 8 blocks, outside step region + length byte, that differ from the blank template. */
export function extraBlockBytes(buf: Uint8Array, t: NoteTrack): number {
  let n = 0;
  for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
    const stepBase = noteStepBase(t, p);
    const meta = META_OFFSETS[noteBlockIndex(t, p)];
    const blockStart = stepBase;
    for (let i = blockStart; i < blockStart + BLOCK; i++) {
      if (i < stepBase + NOTE_STEP_REGION || i === meta) continue;
      if (buf[i] !== BLANK[i]) n++;
    }
  }
  return n;
}

const root = process.argv[2];
if (!root) throw new Error('usage: track-swap-census.mts <sweepRoot>');
const totals = { projects: 0, vocalTarget: 0, extra: 0 };
for (const pack of ['pack1', 'pack2', 'pack3', 'pack4', 'pack5']) {
  const dir = join(root, pack);
  if (!existsSync(dir)) continue;
  console.log(`\n=== ${pack}`);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs')).sort()) {
    const buf = new Uint8Array(readFileSync(join(dir, f)));
    if (buf.length !== NCS_FILE_SIZE) { console.log(`  ${f}: wrong size ${buf.length}`); continue; }
    totals.projects++;
    const slot = /project0*(\d+)-/.exec(f)?.[1] ?? '?';
    const n = Object.fromEntries(TRACKS.map((t) => [t, notes(buf, t)])) as Record<NoteTrack, number>;
    const ch = TRACKS.map((t) => { const c = getNoteChain(buf, t); return c ? `${c.start}-${c.end}` : '-'; });
    const scenes = [0, 1, 2, 3].filter((sc) => TRACKS.some((t) => getSceneNoteChain(buf, sc, t) !== undefined)).length;
    const extra = TRACKS.map((t) => extraBlockBytes(buf, t));
    if (n.midi1 > 0) totals.vocalTarget++;
    if (extra.some((e) => e > 0)) totals.extra++;
    console.log(`  ${slot.padStart(2)} ${getProjectName(buf).padEnd(22)} notes s1 ${String(n.synth1).padStart(4)} s2 ${String(n.synth2).padStart(4)}` +
      ` m1 ${String(n.midi1).padStart(4)} m2 ${String(n.midi2).padStart(4)}  lvl ${getSynthLevel(buf, 1)}/${getSynthLevel(buf, 2)}` +
      `  chain ${ch.join(' ')}${scenes ? `  scenes ${scenes}` : ''}${extra.some((e) => e) ? `  EXTRA ${extra.join('/')}` : ''}`);
  }
}
console.log(`\n${totals.projects} projects; ${totals.vocalTarget} carry MIDI 1 notes; ${totals.extra} carry non-step note-block bytes`);
