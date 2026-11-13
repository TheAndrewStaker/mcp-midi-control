import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { getProjectName } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneNoteChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const RUN = 'samples/circuit-ncs/drums-up-2026-09-16';
const [dirArg, prefix] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(`${RUN}/pool-plan.json`, 'utf8')) as any;
const cur = JSON.parse(readFileSync(`${RUN}/pools-current.json`, 'utf8')) as any;

/** CARD pool: what the device holds right now (leftovers + what this session has written). */
const CARD: Record<number, string> = {
  16: '16_lofi_4_01_kick.wav', 18: '18_lofi_4_02_snare.wav', 20: '20_lofi_4_03_hatC.wav', 22: '22_lofi_4_04_hatO.wav',
  24: '24_lofi_1_04_ride.wav', 25: '25_lofi_3_04_crash.wav', 32: '32_lofi_4_01_kick.wav', 34: '34_lofi_4_02_snare.wav',
  36: '36_lofi_4_03_hatC.wav', 38: '38_lofi_4_04_hatO.wav', 41: '41_lofi_4_02_snare.wav',
  48: '48_80s_2_01_kick.wav', 50: '50_80s_2_02_snare.wav', 52: '52_80s_1_03_hatC.wav',
  56: '56_80s_2_05_ride.wav', 57: '57_80s_2_03_crash.wav', 58: '58_80s_2_04_tom.wav',
};
const pool: string[] = [...(cur.packs['1'] ?? [])];
['00_kick.wav','01_kick2.wav','02_snare.wav','03_snare_roll.wav','04_closed_hat.wav','05_busy_hat.wav','06_open_hat.wav','07_open_hat2.wav','08_ride.wav','09_crash.wav','10_tom.wav','11_ride_bell.wav','12_china.wav','13_sticks.wav','14_perc.wav'].forEach((n, i) => { pool[i] = n; });
for (const [k, v] of Object.entries(CARD)) pool[Number(k)] = v;

const ROLE: Record<number, string> = { 48: 'kick', 50: 'snare', 51: 'clap', 54: 'closed_hat', 57: 'tom', 58: 'open_hat', 61: 'crash', 63: 'ride', 68: 'perc', 82: 'maracas' };
const CYMBAL = /crash|ride|china|open_hat|hatO/i;

const dir = dirArg;
const files = readdirSync(dir).filter((f) => f.endsWith('.ncs'));
let srcTot = new Map<string, number>();
let playedTot = new Map<string, number>();
for (const f of files.sort()) {
  const buf = new Uint8Array(readFileSync(join(dir, f)));
  const nm = getProjectName(buf);
  if (!nm.startsWith(prefix)) continue;
  // which patterns actually PLAY (scene chain), so we count what is heard, not what is stored
  const played = new Set<number>();
  for (let s = 0; s < 16; s++) { const r = getSceneNoteChain(buf, s, 'midi2'); if (r) for (let p = r.start; p <= Math.min(r.end, 7); p++) played.add(p); }
  if (played.size === 0) for (let p = 0; p < 8; p++) played.add(p);
  console.log(`  [${nm}] patterns counted: ${[...played].map((x) => x + 1).join(',')}`);
  const b = getDrumSampleBinding(buf);
  for (const p of played) {
    for (const st of decodeNotePattern(buf, 'midi2', p)) {
      if (!st.active) continue;
      for (const n of st.notes) { const r = ROLE[n.note] ?? `note${n.note}`; srcTot.set(r, (srcTot.get(r) ?? 0) + 1); }
    }
    for (let t = 0; t < 4; t++) {
      for (const [, c] of decodeDrumPattern(buf, t, p).entries()) {
        if (!c.active) continue;
        const slot = c.drumChoice !== 0xff ? c.drumChoice : b[t];
        const nm2 = pool[slot] ?? `EMPTY(${slot})`;
        playedTot.set(nm2, (playedTot.get(nm2) ?? 0) + 1);
      }
    }
  }
}
console.log(`\n=== ${prefix}: MIDI 2 source (the Songsterr part, as stored) ===`);
for (const [r, c] of [...srcTot].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${r}${CYMBAL.test(r) || r === 'crash' || r === 'ride' || r === 'open_hat' ? '   <- CYMBAL' : ''}`);
console.log(`=== ${prefix}: what the CARD plays ===`);
for (const [n, c] of [...playedTot].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${n}${CYMBAL.test(n) ? '   <- CYMBAL' : ''}`);
