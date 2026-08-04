/**
 * breakdown-figure-census.ts — Tom Petty "Breakdown" (Songsterr 23527):
 * locate the recurring rhythmic figure, count it, and dump the raw source
 * encoding (dynamics, graceNote, ghost) so the authored grid can be diffed
 * against source truth. READ-ONLY, no device, no file writes.
 *
 *   npx tsx scripts/breakdown-figure-census.ts
 *   npx tsx scripts/breakdown-figure-census.ts --raw   # raw beat records, m1-4
 */

import { fetchSongsterrPart, flattenSongsterrDrums } from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

const SONG_ID = '23527';
const wantRaw = process.argv.includes('--raw');

const partRes: any = await fetchSongsterrPart(SONG_ID);
const part = partRes.part ?? partRes;

// ── raw encoding: what does the source ACTUALLY carry per beat? ──────
if (wantRaw) {
  console.log('RAW SOURCE BEATS, measures 1-4:');
  for (let m = 0; m < 4; m++) {
    console.log(`\n-- measure ${m + 1} --`);
    for (const voice of part.measures[m].voices ?? []) {
      for (const b of voice.beats ?? []) {
        const notes = (b.notes ?? []).map((n: any) =>
          `{fret:${n.fret}${n.ghost ? ',GHOST' : ''}${n.accent ? ',accent' : ''}${n.dead ? ',dead' : ''}}`).join(' ');
        console.log(`  dur=${b.duration?.join('/')} ${b.rest ? 'REST' : ''}` +
          `${b.velocity ? ` vel="${b.velocity}"` : ''}${b.graceNote !== undefined ? ` GRACE="${b.graceNote}"` : ''}` +
          `${b.tuplet ? ` tuplet=${JSON.stringify(b.tuplet)}` : ''}  ${notes}`);
      }
    }
  }
}

// ── global dynamics / flag census ────────────────────────────────────
const dyn = new Map<string, number>();
let graceBeats = 0, ghostNotes = 0, tuplets = 0, restBeats = 0, totalBeats = 0;
const durations = new Map<string, number>();
for (const m of part.measures) {
  for (const voice of m.voices ?? []) {
    for (const b of voice.beats ?? []) {
      totalBeats++;
      if (b.velocity) dyn.set(b.velocity, (dyn.get(b.velocity) ?? 0) + 1);
      if (b.graceNote !== undefined && b.graceNote !== false && b.graceNote !== '') graceBeats++;
      if (b.tuplet) tuplets++;
      if (b.rest) restBeats++;
      durations.set(b.duration?.join('/') ?? '?', (durations.get(b.duration?.join('/') ?? '?') ?? 0) + 1);
      for (const n of b.notes ?? []) if (n.ghost === true) ghostNotes++;
    }
  }
}
console.log('\n=== SOURCE FLAG CENSUS ===');
console.log(`  beats: ${totalBeats} (rest beats: ${restBeats})`);
console.log(`  dynamic marks: ${[...dyn].map(([k, v]) => `${k}×${v}`).join(', ') || 'NONE'}`);
console.log(`  graceNote beats: ${graceBeats}`);
console.log(`  ghost-flagged notes: ${ghostNotes}`);
console.log(`  tuplet beats: ${tuplets}`);
console.log(`  beat durations: ${[...durations].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')}`);

// ── the figure ───────────────────────────────────────────────────────
const flat = flattenSongsterrDrums(part);
const BPM = (flat.signature[0] * 4) / flat.signature[1];

interface MBar { m: number; ev: { voice: string; off: number; accent: boolean }[] }
const bars: MBar[] = [];
for (let m = 0; m < flat.measures.length; m++) {
  const start = flat.measures[m].startBeat;
  bars.push({
    m: m + 1,
    ev: flat.events.filter((e) => e.beat >= start && e.beat < start + BPM)
      .map((e) => ({ voice: e.voice, off: +(e.beat - start).toFixed(4), accent: (e as any).accent === true })),
  });
}

// Signature of the figure: a snare on beat 3.625 (the 32nd after beat 4's "and"
// position, i.e. 16th #14.5) that is NOT accented, preceded by an accented
// snare on beat 3.0. That is the "snare, light-snare-tail-hit" the maintainer hears.
let figureBars = 0;
const figureDetail: string[] = [];
for (const b of bars) {
  const tail = b.ev.find((e) => e.voice === 'snare' && Math.abs(e.off - 3.625) < 1e-6);
  const back = b.ev.find((e) => e.voice === 'snare' && Math.abs(e.off - 3.0) < 1e-6);
  if (tail && back) {
    figureBars++;
    figureDetail.push(`m${b.m}${tail.accent ? ' (tail ACCENTED!)' : ''}`);
  }
}
console.log('\n=== THE FIGURE: accented snare @3.0 + unaccented snare tail @3.625 ===');
console.log(`  occurrences: ${figureBars} of ${bars.length} measures`);
console.log(`  bars: ${figureDetail.join(', ')}`);

// every snare, split by accent + position
const snarePos = new Map<string, { acc: number; un: number }>();
for (const b of bars) for (const e of b.ev.filter((x) => x.voice === 'snare')) {
  const k = e.off.toFixed(3);
  const r = snarePos.get(k) ?? { acc: 0, un: 0 };
  if (e.accent) r.acc++; else r.un++;
  snarePos.set(k, r);
}
console.log('\n  ALL SNARE POSITIONS (beat-in-bar → accented / unaccented):');
for (const [k, v] of [...snarePos].sort((a, b) => +a[0] - +b[0])) {
  console.log(`    beat ${k.padStart(6)} (16th #${(+k * 4).toFixed(2).padStart(5)})  accented ${String(v.acc).padStart(3)}  unaccented ${String(v.un).padStart(3)}`);
}

// kick + hat positions
for (const V of ['kick', 'hat', 'openhat', 'crash', 'tom'] as const) {
  const pos = new Map<string, number>();
  for (const b of bars) for (const e of b.ev.filter((x) => x.voice === V)) {
    pos.set(e.off.toFixed(3), (pos.get(e.off.toFixed(3)) ?? 0) + 1);
  }
  if (pos.size === 0) continue;
  console.log(`\n  ${V.toUpperCase()} positions (beat-in-bar ×count):`);
  console.log(`    ${[...pos].sort((a, b) => +a[0] - +b[0]).map(([k, c]) => `${k}(16th ${(+k * 4).toFixed(1)})×${c}`).join('  ')}`);
}

// ── grid feasibility ─────────────────────────────────────────────────
console.log('\n=== GRID FEASIBILITY (Circuit: 32 steps of 16th, 6 micro-ticks each) ===');
let exact16 = 0, exactMicro = 0, impossible = 0;
const microUse = new Map<number, number>();
for (const e of flat.events) {
  const sixteenth = e.beat * 4;
  const step = Math.floor(sixteenth + 1e-9);
  const tick = (sixteenth - step) * 6;
  if (Math.abs(tick - Math.round(tick)) < 1e-6) {
    if (Math.round(tick) === 0) exact16++; else exactMicro++;
    microUse.set(Math.round(tick), (microUse.get(Math.round(tick)) ?? 0) + 1);
  } else impossible++;
}
console.log(`  land exactly on a 16th step line      : ${exact16}`);
console.log(`  need a micro-tick offset (1..5 of 6)  : ${exactMicro}`);
console.log(`  NOT representable at 96th resolution  : ${impossible}`);
console.log(`  micro-tick histogram: ${[...microUse].sort((a, b) => a[0] - b[0]).map(([t, c]) => `tick${t}×${c}`).join(', ')}`);
console.log(`\n  => micro-tick 3 of 6 is the 32nd-note anticipation; Circuit mask bit 3 = 0x08.`);
