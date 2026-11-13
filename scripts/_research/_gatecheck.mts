/** Gate histogram per track: sixths, and what that is in steps. */
import { readFileSync } from 'node:fs';
import { decodeNotePattern, MICROTICKS_PER_STEP } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
for (const f of process.argv.slice(2)) {
  const b = new Uint8Array(readFileSync(f));
  for (const t of ['synth1', 'synth2'] as const) {
    const tally = new Map<number, number>();
    for (let p = 0; p < 8; p++) for (const s of decodeNotePattern(b, t, p)) {
      if (!s.active) continue;
      for (const n of s.notes) tally.set(n.gate, (tally.get(n.gate) ?? 0) + 1);
    }
    if (!tally.size) continue;
    const rows = [...tally].sort((a, b2) => a[0] - b2[0])
      .map(([g, c]) => `${g}s=${(g / MICROTICKS_PER_STEP).toFixed(2)}step x${c}`);
    console.log(`${f.split(/[\/]/).pop()} ${t}: ${rows.join('  ')}`);
  }
}
