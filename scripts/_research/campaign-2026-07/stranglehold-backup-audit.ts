/**
 * Stranglehold carry-over audit: diff-grade read of the CARRY-OVER ORACLE, the
 * six Stranglehold projects in samples/circuit-ncs/card-backup-2026-07-29/pack5/
 * (proj01__00 .. proj06__05 = device slots 1-6). READ-ONLY, disk only.
 *
 * The song was the FIRST built with the project-per-part method (pre-campaign,
 * ~2026-07-16..22), so this enumerates EARLY-ERA conventions alongside hand
 * fixes: name/colour/tempo/swing/scale bytes, mixer + drum levels, binding,
 * chain table + scene end, per-pattern LENGTH bytes, full midi2 per-pattern
 * grids (note/vel/gate per step), note+velocity+gate histograms, any content on
 * synth1/synth2/midi1/internal drums, and patch bodies vs blank_slot20.ncs.
 *
 * Run: npx tsx samples/_scratch/stranglehold-backup-audit.ts
 */
import { readFileSync } from 'node:fs';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  getProjectName, NOTE_TRACKS, type NoteTrack, META_OFFSETS, noteBlockIndex, drumBlockIndex,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const TEMPLATE = 'C:/dev/mcp-midi-tools/samples/circuit-tracks/blank_slot20.ncs';
const CHAIN_TABLE_BASE = 0x2c4;
const NOTE_CHAIN_INDEX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };

const tmpl = readFileSync(TEMPLATE);
const patchEq = (buf: Buffer, off: number): boolean => buf.subarray(off, off + 340).equals(tmpl.subarray(off, off + 340));

for (let slot = 1; slot <= 6; slot++) {
  const f = `${DIR}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`;
  const buf = readFileSync(f);
  const u8 = buf as unknown as Uint8Array;
  const name = getProjectName(u8);
  console.log(`\n=== slot ${slot} "${name}" col=${buf[0x0c]} bpm=${buf[0x34]} swing=${buf[0x35]} scale=${buf[0x26d0c]}/${buf[0x26d0d]} mix=${buf[0x2701c]}/${buf[0x2701d]} drumLv=[${[0, 1, 2, 3].map((n) => buf[0x26fbd + n * 11])}] bind=[${[...buf.slice(0x1a278, 0x1a27c)]}] sceneEnd=${getSceneChainEnd(u8) ?? '-'}`);
  console.log(`  patchBodies: s1=${patchEq(buf, 0x26d14) ? 'template' : 'DIFFERS'} s2=${patchEq(buf, 0x26e68) ? 'template' : 'DIFFERS'}`);
  const chains: string[] = [];
  for (const t of NOTE_TRACKS) {
    const off = CHAIN_TABLE_BASE + NOTE_CHAIN_INDEX[t] * 4;
    chains.push(`${t}[${buf[off]},${buf[off + 1]}]`);
  }
  for (let d = 0; d < 4; d++) {
    const off = CHAIN_TABLE_BASE + (4 + d) * 4;
    chains.push(`dr${d + 1}[${buf[off]},${buf[off + 1]}]`);
  }
  console.log(`  chains: ${chains.join(' ')}  tail0x26fc7=${buf[0x26fc7]}`);
  // per-pattern length bytes, midi2 + drums
  const m2len = [...Array(8)].map((_, p) => buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1);
  const d1len = [...Array(8)].map((_, p) => buf[META_OFFSETS[drumBlockIndex(0, p)]] + 1);
  console.log(`  lengths: midi2=[${m2len}] drum1=[${d1len}]`);
  // per note-track censuses + midi2 grids
  for (const t of NOTE_TRACKS as readonly NoteTrack[]) {
    let onsets = 0; let ties = 0;
    const gates = new Map<number, number>(); const notesSeen = new Map<number, number>();
    const vels = new Map<number, number>();
    const grids: string[] = [];
    for (let p = 0; p < 8; p++) {
      const steps = decodeNotePattern(u8, t, p);
      const cells: string[] = [];
      for (const [i, s] of steps.entries()) {
        if (!s.active) continue;
        for (const n of s.notes) {
          onsets++;
          gates.set(n.gate, (gates.get(n.gate) ?? 0) + 1);
          notesSeen.set(n.note, (notesSeen.get(n.note) ?? 0) + 1);
          vels.set(n.velocity, (vels.get(n.velocity) ?? 0) + 1);
          if (n.tie) ties++;
          if (t === 'midi2') cells.push(`${i}:${n.note}v${n.velocity}g${n.gate}`);
        }
      }
      if (t === 'midi2' && cells.length > 0) grids.push(`    p${p + 1}: ${cells.join(' ')}`);
    }
    if (onsets === 0) { console.log(`  ${t}: (empty)`); continue; }
    const noteList = [...notesSeen.entries()].sort((a, b) => a[0] - b[0]);
    console.log(`  ${t}: onsets ${onsets}, ties ${ties}, notes ${noteList.map(([n, c]) => `${n}x${c}`).join(' ')}`);
    console.log(`    gates: ${[...gates.entries()].sort((a, b) => b[1] - a[1]).map(([g, c]) => `${g}x${c}`).join(' ')}  vels: ${[...vels.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v}x${c}`).join(' ')}`);
    if (t === 'midi2') for (const g of grids) console.log(g);
  }
  for (let d = 0; d < 4; d++) {
    let hits = 0;
    for (let p = 0; p < 8; p++) {
      for (const s of decodeDrumPattern(u8, d, p)) if (s.active) hits++;
    }
    if (hits > 0) console.log(`  INTERNAL drum${d + 1}: ${hits} active steps`);
  }
}
console.log('\nDone.');
