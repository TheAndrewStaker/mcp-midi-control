/**
 * Diagnostic (read-only, disk only): where does each ORACLE drum bar actually
 * sit against the SOURCE timeline? For every stored midi2 bar in old slots
 * 47-53, find every source bar (snap+fold lens, clap->snare) whose cell set
 * matches it exactly (positions+notes, velocity ignored). Reveals whether the
 * old build's drum lane is bar-aligned (stored bar b == source bar b) or
 * shifted, and names the residue.
 *
 * Also: the harp mixed-velocity chord question — what token does the importer
 * emit for m72 (the v40 ghost layer riding under def notes)?
 *
 * Run: npx tsx samples/_scratch/sugar-diag-align.ts
 */
import { readFileSync } from 'node:fs';
import {
  importSongsterrMelodic, flattenSongsterrDrums, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const CACHE = `${ROOT}/samples/songsterr-cache/s560358`;
const ORACLE = `${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack5`;
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

const kit = flattenSongsterrDrums(load(10));
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };
const FOLD: Readonly<Record<string, string>> = { clap: 'snare' };
// source bar signature (positions+notes only), snap+fold lens
const srcBar = new Map<number, Set<string>>();
for (const e of kit.events) {
  const stepG = Math.round(e.beat * 4);
  const bar = Math.floor(stepG / 16) + 1;
  const note = GM12[FOLD[e.voice] ?? e.voice];
  if (!srcBar.has(bar)) srcBar.set(bar, new Set());
  srcBar.get(bar)!.add(`${stepG % 16}|${note}`);
}
const sigOf = (s: Set<string> | undefined): string => (s === undefined || s.size === 0) ? '' : [...s].sort().join(',');
const srcSig = new Map<number, string>();
for (let m = 1; m <= 148; m++) srcSig.set(m, sigOf(srcBar.get(m)));

console.log('=== oracle drum bars vs source bars ===');
for (let slot = 47; slot <= 53; slot++) {
  const buf = readFileSync(`${ORACLE}/proj${slot}__${slot - 1}_SESSION.ncs`);
  const chopStart = 16 * (slot - 46) + 1;
  const rows: string[] = [];
  for (let p = 0; p < 8; p++) {
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2', p);
    for (const half of [0, 1]) {
      const storedBar = chopStart + 2 * p + half;
      const set = new Set<string>();
      steps.forEach((s, i) => {
        if (!s.active || i < half * 16 || i >= (half + 1) * 16) return;
        for (const n of s.notes) set.add(`${i - half * 16}|${n.note}`);
      });
      const sig = sigOf(set);
      if (sig === '') { rows.push(`m${storedBar}: (rest)`); continue; }
      const matches: number[] = [];
      for (let m = 1; m <= 148; m++) if (srcSig.get(m) === sig) matches.push(m);
      const aligned = matches.includes(storedBar);
      rows.push(`m${storedBar}: ${aligned ? 'ALIGNED' : `matches src [${matches.map((m) => `m${m}`).join(',') || 'NONE'}]`}${aligned && matches.length > 1 ? ` (also ${matches.filter((m) => m !== storedBar).length} twins)` : ''}`);
    }
  }
  const misaligned = rows.filter((r) => !r.includes('ALIGNED') && !r.includes('(rest)'));
  console.log(`slot ${slot}: ${rows.filter((r) => r.includes('ALIGNED')).length} aligned, ${rows.filter((r) => r.includes('(rest)')).length} rest, ${misaligned.length} misaligned`);
  for (const r of misaligned) console.log(`   ${r}`);
}

console.log('\n=== harp m72 mixed-velocity chord emission ===');
const imp = importSongsterrMelodic(load(7), { stepsPerBeat: 4, fromMeasure: 71, toMeasure: 72 });
console.log(`notation: ${imp.notation}`);
const imp2 = importSongsterrMelodic(load(7), { stepsPerBeat: 4, fromMeasure: 1, toMeasure: 2 });
console.log(`m1-2 notation: ${imp2.notation}`);
