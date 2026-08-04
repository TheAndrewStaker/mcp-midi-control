/**
 * Fork Q2 = KEEP (maintainer, 2026-07-30): the hand-authored MIDI 1 drone must
 * be carried BYTE-FAITHFULLY into the re-author. The carry-over audit only
 * summarised midi1 (onset/note/gate/velocity histograms); this dumps the FULL
 * per-pattern, per-step midi1 grid for all six oracle slots so the drone can be
 * re-authored as mini-notation rows and asserted per slot in Phase 4.
 *
 * READ-ONLY, disk only. Run: npx tsx samples/_scratch/stranglehold-drone-dump.ts
 */
import { readFileSync } from 'node:fs';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getProjectName, META_OFFSETS, noteBlockIndex } from '../../packages/circuit-tracks/src/ncs/format.js';

const DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
const nameOf = (n: number): string => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

for (let slot = 1; slot <= 6; slot++) {
  const f = `${DIR}/proj${String(slot).padStart(2, '0')}__${String(slot - 1).padStart(2, '0')}_SESSION.ncs`;
  const buf = readFileSync(f);
  const u8 = buf as unknown as Uint8Array;
  const lens = [...Array(8)].map((_, p) => buf[META_OFFSETS[noteBlockIndex('midi1', p)]] + 1);
  console.log(`\n=== slot ${slot} "${getProjectName(u8)}" midi1 lengths=[${lens}] ===`);
  for (let p = 0; p < 8; p++) {
    const steps = decodeNotePattern(u8, 'midi1', p);
    const cells: string[] = [];
    for (const [i, s] of steps.entries()) {
      if (!s.active) continue;
      // Group the step's notes into ONE chord cell (the drone is dyads).
      const notes = s.notes.map((n) => `${n.note}(${nameOf(n.note)})`).join('+');
      const g = s.notes[0];
      cells.push(`${i}:${notes} v${g.velocity} g${g.gate}${s.notes.some((n) => n.tie) ? ' TIE' : ''}`
        + (new Set(s.notes.map((n) => n.gate)).size > 1 ? ` [gates ${s.notes.map((n) => n.gate).join('/')}]` : '')
        + (new Set(s.notes.map((n) => n.tie)).size > 1 ? ` [ties ${s.notes.map((n) => String(n.tie)).join('/')}]` : ''));
    }
    console.log(`  p${p + 1} (len ${lens[p]}): ${cells.length === 0 ? '(empty)' : cells.join('  |  ')}`);
  }
}
console.log('\nDone.');
