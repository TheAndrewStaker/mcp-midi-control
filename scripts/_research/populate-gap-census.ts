/**
 * populate-gap-census.ts — READ-ONLY. Per-song, per-project census of the
 * CONDENSED INTERNAL drum layer: which projects carry drum content on Drum 1..4
 * and which are empty, grouped by song.
 *
 * This is the quantitative half of the "populate gap" question (JOB 3): the
 * maintainer wants every song's four internal drum tracks populated with the
 * condensed layer at level 0. This says who is and is not populated. Whether a
 * gap SHOULD be filled (source has drums vs source genuinely has none) is a
 * documentary question answered alongside this table, not by it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { getProjectName, getDrumLevel, getSynthLevel, NCS_FILE_SIZE } from '../../packages/circuit-tracks/src/ncs/format.js';
import { getDrumSampleBinding } from '../../packages/circuit-tracks/src/ncs/drumBinding.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';

/**
 * Capture directories, OLDEST FIRST: a later directory's capture of a slot wins.
 *
 * This used to be one hardcoded directory (the 2026-07-30 binding pass's
 * PRE-write scan), which quietly turned the census into a snapshot of one
 * moment: after the binding pass and again after the populate pass it reported
 * bindings and drum layers the card no longer had. Layering fixes that without
 * paying for a fresh 125-slot sweep — the broad scan supplies coverage, the
 * later, narrower captures supply currency. Add the newest capture to the END
 * of this list after any write campaign, or point CENSUS_DIRS at your own
 * (comma-separated, same oldest-first rule).
 */
const SCAN_DIRS = (process.env.CENSUS_DIRS ?? [
  'samples/circuit-ncs/bindings-2026-07-30/scan',       // broad: 131 slots, packs 2/4/5, PRE-binding
  'samples/circuit-ncs/bindings-2026-07-30/verify',     // 126 slots, POST-binding ([1,2,5,11])
  'samples/circuit-ncs/populate-authored-2026-07-30',   // 22 slots, POST-populate (condensed drums)
  'samples/circuit-ncs/offering-authored-2026-07-31',   // 9 slots, POST-Offering populate
  'samples/circuit-ncs/offering-scenefix-authored-2026-07-31', // 7 slots, POST-Offering scene chains
  'samples/circuit-ncs/ibelieve-authored-2026-07-31',   // 9 slots, POST-I Believe populate (the last one)
].join(',')).split(',').map(s => s.trim()).filter(Boolean);
const FN_RE = /-pack(\d+)-project(\d+)-/;

interface Row {
  key: string; pack: number; slot: number; name: string;
  steps: number[]; total: number; binding: number[]; drums: number[]; synths: number[];
  synthSteps: number[];
}

const bySlot = new Map<string, { dir: string; file: string; pack: number; slot: number }>();
for (const dir of SCAN_DIRS) {
  for (const f of readdirSync(dir).filter(n => n.endsWith('.ncs'))) {
    const m = FN_RE.exec(f);
    if (!m) continue;
    const pack = Number(m[1]), slot = Number(m[2]);
    const key = `${pack}/${String(slot).padStart(2, '0')}`;
    const prev = bySlot.get(key);
    // Within one directory, the later filename (timestamped) wins; a later
    // DIRECTORY always wins outright, because the list is oldest-first.
    if (!prev || prev.dir !== dir || f > prev.file) bySlot.set(key, { dir, file: f, pack, slot });
  }
}
console.log(`capture layers (oldest first): ${SCAN_DIRS.join(' → ')}`);

const rows: Row[] = [];
for (const { dir, file, pack, slot } of [...bySlot.values()].sort((a, b) => a.pack - b.pack || a.slot - b.slot)) {
  const buf = new Uint8Array(readFileSync(join(dir, file)));
  if (buf.length !== NCS_FILE_SIZE) continue;
  const steps = [0, 1, 2, 3].map(t => {
    let n = 0; for (let p = 0; p < 8; p++) n += decodeDrumPattern(buf, t, p).filter(s => s.active).length; return n;
  });
  // Note-track content, to distinguish "the whole project is an empty stub" from
  // "drums specifically missing while the rest of the part is built". NOTE: the
  // track argument is a NAME ('synth1'|'synth2'|'midi1'|'midi2'), not an index —
  // passing an index throws, and swallowing that throw silently reports 0 content
  // for every project, which is a false "everything is empty" reading.
  const synthSteps = (['synth1', 'synth2', 'midi1', 'midi2'] as const).map(tr => {
    let n = 0;
    for (let p = 0; p < 8; p++) {
      n += decodeNotePattern(buf, tr, p).filter(s => s.notes && s.notes.length > 0).length;
    }
    return n;
  });
  rows.push({
    key: `${pack}/${String(slot).padStart(2, '0')}`, pack, slot,
    name: getProjectName(buf), steps, total: steps.reduce((a, b) => a + b, 0),
    binding: getDrumSampleBinding(buf),
    drums: [0, 1, 2, 3].map(t => getDrumLevel(buf, t)),
    synths: [getSynthLevel(buf, 1), getSynthLevel(buf, 2)],
    synthSteps,
  });
}

/** Group by song from the project-name prefix. */
function song(name: string): string {
  const n = name.trim();
  for (const s of ['AfterDark', 'Schism', 'Redbone', 'BrainStew', 'WhatIGot', 'BillieJean',
    'Stranglehold', 'Amber', 'CaughtGlim', 'I Believe', 'Clint', 'Breakdown', 'Sugar', 'Ofr',
    'Smooth', 'Love Song', 'NoDiggity']) {
    if (n.startsWith(s)) return s;
  }
  return n.split(/\s+/)[0];
}

const groups = new Map<string, Row[]>();
for (const r of rows) {
  const s = song(r.name);
  if (!groups.has(s)) groups.set(s, []);
  groups.get(s)!.push(r);
}

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);

console.log('=== PER-SONG CONDENSED-DRUM POPULATION CENSUS ===\n');
console.log(pad('song', 14), pad('parts', 6), pad('populated', 10), pad('empty', 6), 'empty parts');
console.log('-'.repeat(100));
const summary: { song: string; parts: number; pop: number; empty: Row[] }[] = [];
for (const [s, list] of [...groups.entries()].sort()) {
  const empty = list.filter(r => r.total === 0);
  const pop = list.length - empty.length;
  summary.push({ song: s, parts: list.length, pop, empty });
  console.log(
    pad(s, 14), pad(String(list.length), 6), pad(String(pop), 10), pad(String(empty.length), 6),
    empty.map(r => `${r.key} ${r.name}`).join(' | ').slice(0, 90),
  );
}

console.log('\n\n=== FULLY POPULATED SONGS (no gap) ===');
for (const g of summary.filter(g => g.empty.length === 0)) console.log(`  ${g.song}: ${g.parts}/${g.parts} parts carry condensed drums`);

console.log('\n=== SONGS WITH A GAP ===');
for (const g of summary.filter(g => g.empty.length > 0).sort((a, b) => b.empty.length - a.empty.length)) {
  console.log(`\n  ${g.song}: ${g.pop}/${g.parts} populated, ${g.empty.length} EMPTY`);
  for (const r of g.empty) {
    console.log(`      ${pad(r.key, 7)} ${pad(r.name, 24)} drumSteps=${r.steps.join('/')}  notes(s1/s2/m1/m2)=${r.synthSteps.join("/")}  binding=[${r.binding.join(',')}]`);
  }
}

const totalEmpty = summary.reduce((a, g) => a + g.empty.length, 0);
console.log(`\n\nTOTAL: ${rows.length} live projects, ${rows.length - totalEmpty} populated, ${totalEmpty} with an empty condensed drum layer.`);
