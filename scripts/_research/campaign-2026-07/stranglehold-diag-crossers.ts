/**
 * Diagnostic for the two staging failures (2026-07-30 execution):
 *   (1) 3 snapped onsets cross a bar line — WHICH, and do they land in a
 *       STAGED window (where a relocation would change stored content)?
 *   (2) the double-crash unison count is 4, not the plan §0e's 3 — enumerate
 *       every same-cell crash fold with its window.
 * READ-ONLY. Run: npx tsx samples/_scratch/stranglehold-diag-crossers.ts
 */
import { readFileSync } from 'node:fs';
import { flattenSongsterrDrums, type SongsterrPart } from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s403';
const p8 = JSON.parse(readFileSync(`${CACHE}/part-8.json`, 'utf8')) as SongsterrPart;
const kit = flattenSongsterrDrums(p8);
const barStartStep = (m1: number): number => Math.round(kit.measures[m1 - 1].startBeat * 4);

/** The staged 2-bar windows (start bar), from the plan §1 part set. */
const STAGED_WINDOWS = [5, 7, 11, 19, 31, 33, 35, 61, 73, 93, 103, 111, 113, 115, 127, 145, 147, 151];
const inStaged = (bar: number): string[] =>
  STAGED_WINDOWS.filter((w) => bar === w || bar === w + 1).map((w) => `m${w}-${w + 1}`);

console.log('=== (1) bar-line crossers under the nearest-16th snap ===');
for (const e of kit.events) {
  const exact = e.beat * 4;
  const stepG = Math.round(exact);
  const bar = Math.floor(e.beat / 4) + 1;
  if (stepG < barStartStep(bar) || stepG >= barStartStep(bar) + 16) {
    const toBar = Math.floor(stepG / 16) + 1;
    console.log(`  m${bar} ${e.voice} beat ${e.beat} (exact step ${exact}) -> step ${stepG} = m${toBar} s${stepG % 16}` +
      `  | source bar staged in: [${inStaged(bar).join(',') || 'NOT STAGED'}]  dest bar staged in: [${inStaged(toBar).join(',') || 'NOT STAGED'}]`);
  }
}

console.log('\n=== (2) every same-cell fold, by voice, with window membership ===');
const cells = new Map<string, { vel: number; voice: string; bar: number }>();
const folds: string[] = [];
for (const e of kit.events) {
  const stepG = Math.round(e.beat * 4);
  const bar = Math.floor(e.beat / 4) + 1;
  const vel = e.velocity ?? (e.ghost === true ? 40 : e.accent === true ? 120 : 100);
  const key = `${stepG}|${e.voice}`;
  const ex = cells.get(key);
  if (ex === undefined) cells.set(key, { vel, voice: e.voice, bar });
  else {
    folds.push(`${e.voice}\tm${bar} s${stepG % 16}\tv${ex.vel}+v${vel} -> v${Math.max(ex.vel, vel)}\t[${inStaged(bar).join(',') || 'not staged'}]`);
    ex.vel = Math.max(ex.vel, vel);
  }
}
const byVoice = new Map<string, string[]>();
for (const f of folds) {
  const v = f.split('\t')[0];
  (byVoice.get(v) ?? byVoice.set(v, []).get(v)!).push(f);
}
for (const [v, list] of [...byVoice.entries()].sort()) {
  const staged = list.filter((x) => !x.includes('[not staged]'));
  console.log(`\n  ${v}: ${list.length} folds total, ${staged.length} inside a STAGED window`);
  if (v === 'crash') for (const f of list) console.log(`    ${f}`);
  else for (const f of staged) console.log(`    ${f}`);
}
console.log('\nDone.');
