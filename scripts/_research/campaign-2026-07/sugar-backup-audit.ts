/**
 * Sugar carry-over audit: diff-grade read of the CARRY-OVER ORACLE, the ten
 * Sugar projects in samples/circuit-ncs/card-backup-2026-07-29/pack5/
 * (proj46__45 .. proj55__54 = device slots 46-55). READ-ONLY, disk only.
 *
 * Enumerates, per slot, every hand-fix class the re-author must reproduce or
 * argue away (the After Dark carry-over-inventory discipline):
 *   - name / colour / tempo / swing / scale bytes
 *   - synth mixer 0x2701c/d, drum levels 0x26fbd+n*11, binding 0x1a278
 *   - per-track chain table (base 0x2c4, stride 4) + scene-chain end
 *   - pattern length bytes per chained pattern
 *   - midi2 STORED NOTE HISTOGRAM (the drum-voicing fixes: clap on stored 50,
 *     NO stored 51 anywhere, NO china 68 anywhere, +12 register)
 *   - midi2 velocity histogram (what the old build stored)
 *   - melodic censuses: note count, gate distribution (the 1,679-byte length
 *     restore), tie count, lowest/highest stored note (the E0 question)
 *   - internal drum tracks: any content (slot 55's drum2 P1 finding)
 *
 * Run: npx tsx samples/_scratch/sugar-backup-audit.ts
 */
import { readFileSync } from 'node:fs';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getProjectName, NOTE_TRACKS, type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const CHAIN_TABLE_BASE = 0x2c4;
const NOTE_CHAIN_INDEX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };

for (let slot = 46; slot <= 55; slot++) {
  const f = `${DIR}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`;
  const buf = readFileSync(f);
  const name = getProjectName(buf as unknown as Uint8Array);
  const colour = buf[0x0c]; const tempo = buf[0x34]; const swing = buf[0x35];
  const scale = `${buf[0x26d0c]}/${buf[0x26d0d]}`;
  const mix = `${buf[0x2701c]}/${buf[0x2701d]}`;
  const drumLv = [0, 1, 2, 3].map((n) => buf[0x26fbd + n * 11]);
  const binding = [...buf.slice(0x1a278, 0x1a27c)];
  console.log(`\n=== slot ${slot} "${name}" col=${colour} bpm=${tempo} swing=${swing} scale=${scale} mix=${mix} drumLv=[${drumLv}] bind=[${binding}] sceneEnd=${getSceneChainEnd(buf as unknown as Uint8Array) ?? '-'}`);
  // chains
  const chains: string[] = [];
  for (const t of NOTE_TRACKS) {
    const off = CHAIN_TABLE_BASE + NOTE_CHAIN_INDEX[t] * 4;
    chains.push(`${t}[${buf[off]},${buf[off + 1]}]`);
  }
  for (let d = 0; d < 4; d++) {
    const off = CHAIN_TABLE_BASE + (4 + d) * 4;
    chains.push(`dr${d + 1}[${buf[off]},${buf[off + 1]}]`);
  }
  console.log(`  chains: ${chains.join(' ')}`);
  // per note-track censuses
  for (const t of NOTE_TRACKS as readonly NoteTrack[]) {
    let onsets = 0; let ties = 0;
    const gates = new Map<number, number>(); const notesSeen = new Map<number, number>();
    const vels = new Map<number, number>();
    for (let p = 0; p < 8; p++) {
      const steps = decodeNotePattern(buf as unknown as Uint8Array, t, p);
      for (const s of steps) {
        if (!s.active) continue;
        for (const n of s.notes) {
          onsets++;
          gates.set(n.gate, (gates.get(n.gate) ?? 0) + 1);
          notesSeen.set(n.note, (notesSeen.get(n.note) ?? 0) + 1);
          vels.set(n.velocity, (vels.get(n.velocity) ?? 0) + 1);
          if (n.tie) ties++;
        }
      }
    }
    if (onsets === 0) { console.log(`  ${t}: (empty)`); continue; }
    const noteList = [...notesSeen.entries()].sort((a, b) => a[0] - b[0]);
    const gateList = [...gates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`  ${t}: onsets ${onsets}, ties ${ties}, notes ${noteList.map(([n, c]) => `${n}x${c}`).join(' ')}`);
    console.log(`    gates(top): ${gateList.map(([g, c]) => `${g}x${c}`).join(' ')}  vels: ${[...vels.entries()].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v}x${c}`).join(' ')}`);
  }
  // internal drums
  for (let d = 0; d < 4; d++) {
    let hits = 0;
    for (let p = 0; p < 8; p++) {
      for (const s of decodeDrumPattern(buf as unknown as Uint8Array, d, p)) if (s.active) hits++;
    }
    if (hits > 0) console.log(`  INTERNAL drum${d + 1}: ${hits} active steps`);
  }
}
console.log('\nDone.');
