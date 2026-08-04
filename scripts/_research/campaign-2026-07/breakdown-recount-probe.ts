/**
 * Breakdown recount probe: (1) TRUE old project boundaries from the stored
 * pattern LENGTH bytes; (2) pipeline-reproduction re-run on the true windows;
 * (3) deeper harmony hunt (per-slot, shifts -12/0/+12, per-bar overlap);
 * (4) candidate part-set censuses (marker-aligned) with per-project distinct
 * cells, plays and scene-run feasibility -> the honest count.
 * READ-ONLY, disk only. Run: npx tsx samples/_scratch/breakdown-recount-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizeDrumEvents } from '../../packages/core/src/protocol-generic/patterns/drumScore.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { META_OFFSETS, noteBlockIndex, drumBlockIndex, type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const PROJECTS = [35, 36, 37, 38, 39];
const NOTE_VOICE: Record<number, string> = { 48: 'kick', 50: 'snare', 54: 'hat', 57: 'tom', 58: 'openhat', 61: 'crash' };
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const drums = flattenSongsterrDrums(load(6));

console.log('=== 1. true old boundaries from LENGTH bytes ===');
const bufs = PROJECTS.map((slot) => readFileSync(`${ORACLE}/proj${slot}__${slot - 1}_SESSION.ncs`));
const projBars: number[] = [];
for (const [i, slot] of PROJECTS.entries()) {
  const buf = bufs[i];
  const lensM2: number[] = []; const lensD1: number[] = [];
  for (let p = 0; p < 8; p++) {
    lensM2.push(buf[META_OFFSETS[noteBlockIndex('midi2' as NoteTrack, p)]] + 1);
    lensD1.push(buf[META_OFFSETS[drumBlockIndex(0, p)]] + 1);
  }
  // chain end from 0x2c4 table (midi2 = index 3)
  const chainEnd = buf[0x2c4 + 3 * 4 + 1];
  const used = lensM2.slice(0, chainEnd + 1);
  const steps = used.reduce((a, b) => a + b, 0);
  projBars.push(steps / 16);
  console.log(`slot ${slot}: midi2 lens [${lensM2}], d1 lens [${lensD1}], chainEnd ${chainEnd}, used steps ${steps} = ${steps / 16} bars`);
}
const bounds: [number, number][] = [];
let m = 1;
for (const b of projBars) { bounds.push([m, m + b - 1]); m += b; }
console.log(`old boundaries: ${bounds.map(([a, b], i) => `P${i + 1} m${a}-${b}`).join(', ')} (total ${m - 1} bars)`);

console.log('\n=== 2. reproduction re-run on TRUE windows ===');
for (const [i, slot] of PROJECTS.entries()) {
  const [mFrom, mTo] = bounds[i];
  const fromBeat = (mFrom - 1) * 4; const beats = (mTo - mFrom + 1) * 4;
  const windowed = drums.events.filter((e) => e.beat >= fromBeat - 1e-9 && e.beat < fromBeat + beats).map((e) => ({ ...e, beat: e.beat - fromBeat }));
  const q = quantizeDrumEvents(windowed, { beats, stepsPerBeat: 4 });
  const buf = bufs[i];
  const stored = new Map<string, { vel: number; delay: number }>();
  for (let p = 0; p < 8; p++) {
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2' as NoteTrack, p);
    for (const [si, s] of steps.entries()) {
      if (!s.active) continue;
      for (const n of s.notes) stored.set(`${p * 32 + si}|${NOTE_VOICE[n.note] ?? n.note}|${n.delay}`, { vel: n.velocity, delay: n.delay });
    }
  }
  // fresh expands micro lists to (step, voice, delay) events like the writer does
  let velMatch = 0; let velMiss = 0; const velMissDetail: string[] = [];
  let freshOnly = 0; const freshOnlyDetail: string[] = [];
  const freshKeys = new Set<string>();
  // pattern packing: 2 bars per pattern in slot order (matches lens 32*7 + tail)
  for (const [voice, steps] of Object.entries(q.voices)) {
    for (const [gs, s] of steps.entries()) {
      if (!s.on) continue;
      for (const micro of s.micro ?? [0]) {
        const key = `${gs}|${voice}|${micro}`;
        freshKeys.add(key);
        const st = stored.get(key);
        if (!st) { freshOnly++; if (freshOnlyDetail.length < 6) freshOnlyDetail.push(`${voice}@${gs}+${micro}`); continue; }
        const freshVel = s.velocity ?? (s.accent ? 120 : 100);
        if (freshVel === st.vel) velMatch++;
        else { velMiss++; if (velMissDetail.length < 6) velMissDetail.push(`${voice}@${gs}+${micro}: fresh ${freshVel} vs stored ${st.vel}`); }
      }
    }
  }
  let storedOnly = 0; const storedOnlyDetail: string[] = [];
  for (const k of stored.keys()) if (!freshKeys.has(k)) { storedOnly++; if (storedOnlyDetail.length < 6) storedOnlyDetail.push(k); }
  console.log(`slot ${slot} (m${mFrom}-${mTo}): (step,voice,delay)-keyed: vel ${velMatch} match / ${velMiss} differ; fresh-only ${freshOnly}, stored-only ${storedOnly}`);
  if (velMissDetail.length) console.log(`  vel diffs: ${velMissDetail.join('; ')}`);
  if (freshOnlyDetail.length) console.log(`  fresh-only: ${freshOnlyDetail.join('; ')}`);
  if (storedOnlyDetail.length) console.log(`  stored-only: ${storedOnlyDetail.join('; ')}`);
}

console.log('\n=== 3. harmony hunt, per slot and shift ===');
const oldMidi1PerSlot: { slot: number; onsets: { g: number; note: number }[] }[] = [];
for (const [i, slot] of PROJECTS.entries()) {
  const buf = bufs[i];
  const [mFrom] = bounds[i];
  const base = (mFrom - 1) * 16;
  const onsets: { g: number; note: number }[] = [];
  for (let p = 0; p < 8; p++) {
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi1' as NoteTrack, p);
    for (const [si, s] of steps.entries()) {
      if (!s.active) continue;
      for (const n of s.notes) onsets.push({ g: base + p * 32 + si, note: n.note });
    }
  }
  oldMidi1PerSlot.push({ slot, onsets });
}
const allOld = oldMidi1PerSlot.flatMap((s) => s.onsets);
console.log(`old midi1 grand total: ${allOld.length}`);
const meta = JSON.parse(readFileSync(`${CACHE}/meta.json`, 'utf8'));
for (const t of meta.allTracks ?? []) {
  if (t.isDrums) continue;
  let part: SongsterrPart; try { part = load(t.partId); } catch { continue; }
  let flat; try { flat = flattenSongsterrMelodic(part); } catch { continue; }
  for (const shift of [-12, 0, 12]) {
    const srcSet = new Set(flat.notes.map((n) => `${Math.round(n.beat * 4)}|${n.pitch + shift}`));
    const perSlot = oldMidi1PerSlot.map((s) => {
      const hit = s.onsets.filter((o) => srcSet.has(`${o.g}|${o.note}`)).length;
      return `${hit}/${s.onsets.length}`;
    });
    const total = allOld.filter((o) => srcSet.has(`${o.g}|${o.note}`)).length;
    if (total > 100) console.log(`  t${t.partId} ${t.instrument} shift ${shift}: total ${total}/${allOld.length}, per slot ${perSlot.join(' ')}`);
  }
}
// combo: t0 + t3? check union
{
  const f0 = flattenSongsterrMelodic(load(0));
  const f3 = flattenSongsterrMelodic(load(3));
  const s0 = new Set(f0.notes.map((n) => `${Math.round(n.beat * 4)}|${n.pitch}`));
  const s3 = new Set(f3.notes.map((n) => `${Math.round(n.beat * 4)}|${n.pitch}`));
  const both = allOld.filter((o) => s0.has(`${o.g}|${o.note}`) || s3.has(`${o.g}|${o.note}`)).length;
  console.log(`  union t0+t3 at +0: ${both}/${allOld.length}`);
  // sample: bar 1-2 stored vs t0
  const bar12 = oldMidi1PerSlot[0].onsets.filter((o) => o.g < 64);
  console.log(`  old midi1 m1-4: ${bar12.map((o) => `${o.note}@${o.g}`).join(' ')}`);
  const t0m14 = f0.notes.filter((n) => n.beat < 16).map((n) => `${n.pitch}@${(n.beat * 4).toFixed(1)}${n.tie ? 'T' : ''}`);
  console.log(`  t0 m1-4: ${t0m14.join(' ')}`);
}

console.log('\n=== 4. candidate part sets (union windows on drums + t0-harmony) ===');
const harm = flattenSongsterrMelodic(load(0));
const q = quantizeDrumEvents(drums.events, { beats: drums.totalBeats, stepsPerBeat: 4 });
const barsTotal = drums.measures.length;
// per-bar union signature (drums cell image + harmony rows)
const barKey: string[] = [];
for (let b = 0; b < barsTotal; b++) {
  const s0 = b * 16; const s1 = s0 + 16;
  const parts: string[] = [];
  for (const [voice, steps] of Object.entries(q.voices)) {
    for (let s = s0; s < s1 && s < steps.length; s++) {
      const st = steps[s];
      if (!st?.on) continue;
      parts.push(`${voice}:${s - s0}:${st.velocity ?? (st.accent ? 120 : 100)}:${JSON.stringify(st.micro ?? [0])}`);
    }
  }
  for (const n of harm.notes) {
    const g = Math.round(n.beat * 4);
    if (g < s0 || g >= s1) continue;
    parts.push(`H:${g - s0}:${n.pitch}:${(n as any).durationBeats?.toFixed(3) ?? '?'}:${n.tie ? 'T' : ''}`);
  }
  barKey.push(parts.sort().join('|'));
}
function censusFor(name: string, cuts: number[]): void {
  // cuts = 1-based first-bars of each project (ascending), last project ends at barsTotal
  console.log(`  --- ${name}: ${cuts.map((c, i) => `m${c}-${(cuts[i + 1] ?? barsTotal + 1) - 1}`).join(' | ')}`);
  let total = 0; let feasible = true;
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i]; const to = (cuts[i + 1] ?? barsTotal + 1) - 1;
    const wins: string[] = [];
    for (let b = from; b <= to; b += 2) {
      wins.push(b + 1 <= to ? barKey[b - 1] + '||' + barKey[b] : barKey[b - 1] + '||END');
    }
    const distinct = new Map<string, number>(); const seq: string[] = [];
    for (const w of wins) { if (!distinct.has(w)) distinct.set(w, distinct.size); seq.push(String.fromCharCode(97 + distinct.get(w)!)); }
    total += distinct.size;
    // scene-run feasibility: compress seq into runs of contiguous ascending pattern ranges
    const order = seq.join('');
    const runs: string[] = [];
    let ri = 0;
    while (ri < seq.length) {
      let rj = ri;
      while (rj + 1 < seq.length && seq[rj + 1].charCodeAt(0) === seq[rj].charCodeAt(0) + 1) rj++;
      runs.push(seq.slice(ri, rj + 1).join(''));
      ri = rj + 1;
    }
    const plainOk = seq.length <= 8 && distinct.size === seq.length;
    const sceneOk = runs.length <= 4;
    const ok = distinct.size <= 8 && (plainOk || sceneOk);
    if (!ok) feasible = false;
    console.log(`    m${from}-${to}: ${wins.length} plays, ${distinct.size} cells [${order}] runs ${runs.length} (${runs.join(' ')}) ${distinct.size > 8 ? 'OVER-CELLS' : plainOk ? 'plain' : sceneOk ? 'scene' : 'RUNS>4'}`);
  }
  console.log(`    => total cells ${total}, feasible ${feasible}`);
}
censusFor('OLD flat (in place, 5)', bounds.map(([a]) => a));
censusFor('markers 6', [1, 15, 24, 40, 56, 68]);
censusFor('markers 6 alt cuts', [1, 15, 24, 38, 54, 68]);
censusFor('flat-5 at markers-ish', [1, 15, 24, 40, 56]);
censusFor('5 keep old cuts to m62, solo split', [1, 17, 33, 49, 63]);
censusFor('4 (queue target)', [1, 24, 40, 56]);

console.log('\n=== 5. revision drift: 07-27 flatten artifact vs today ===');
{
  const old = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/circuit-ncs/breakdown-analysis.json', 'utf8'));
  const oldEv = old.source.events as { voice: string; beat: number; accent?: boolean }[];
  const now = drums.events;
  const key = (e: { voice: string; beat: number }): string => `${e.voice}@${e.beat.toFixed(4)}`;
  const oldSet = new Map<string, number>(); for (const e of oldEv) oldSet.set(key(e), (oldSet.get(key(e)) ?? 0) + 1);
  const nowSet = new Map<string, number>(); for (const e of now) nowSet.set(key(e), (nowSet.get(key(e)) ?? 0) + 1);
  let onlyOld = 0; const oldDetail: string[] = [];
  for (const [k, c] of oldSet) { const n = nowSet.get(k) ?? 0; if (c > n) { onlyOld += c - n; if (oldDetail.length < 12) oldDetail.push(k); } }
  let onlyNow = 0; const nowDetail: string[] = [];
  for (const [k, c] of nowSet) { const o = oldSet.get(k) ?? 0; if (c > o) { onlyNow += c - o; if (nowDetail.length < 12) nowDetail.push(k); } }
  console.log(`events only in 07-27 artifact: ${onlyOld} (${oldDetail.join(', ')})`);
  console.log(`events only in today's flatten: ${onlyNow} (${nowDetail.join(', ')})`);
  // accent drift
  const accKey = (e: { voice: string; beat: number; accent?: boolean }): string => `${e.voice}@${e.beat.toFixed(4)}|${e.accent ? 'A' : '-'}`;
  const oa = new Set(oldEv.map(accKey)); const na = new Set(now.map((e) => accKey(e)));
  let accDrift = 0; const accDetail: string[] = [];
  for (const k of na) if (!oa.has(k)) { accDrift++; if (accDetail.length < 10 && oa.has(k.replace(/\|.$/, k.endsWith('A') ? '|-' : '|A'))) accDetail.push(k); }
  console.log(`accent-flag drift (same position, different accent): ~${accDetail.length ? accDetail.join(', ') : accDrift}`);
}

console.log('\n=== 6. old internal fold: where did tom/openhat/crash go on D1-4? ===');
for (const [i, slot] of PROJECTS.entries()) {
  const buf = bufs[i];
  const [mFrom] = bounds[i];
  // midi2 image keyed by (globalstep|delay) -> voice
  const m2 = new Map<string, string>();
  for (let p = 0; p < 8; p++) {
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2' as NoteTrack, p);
    for (const [si, s] of steps.entries()) { if (!s.active) continue; for (const n of s.notes) m2.set(`${p * 32 + si}|${n.delay}`, NOTE_VOICE[n.note] ?? String(n.note)); }
  }
  const foldCount = new Map<string, number>();
  for (let d = 0; d < 4; d++) {
    for (let p = 0; p < 8; p++) {
      for (const [si, s] of decodeDrumPattern(buf as unknown as Uint8Array, d, p).entries()) {
        if (!s.active) continue;
        const delay = s.microHits === 0x08 ? 3 : 0;
        const v = m2.get(`${p * 32 + si}|${delay}`) ?? m2.get(`${p * 32 + si}|0`) ?? m2.get(`${p * 32 + si}|3`) ?? '??';
        foldCount.set(`${v}->D${d + 1}`, (foldCount.get(`${v}->D${d + 1}`) ?? 0) + 1);
      }
    }
  }
  console.log(`slot ${slot}: ${[...foldCount].sort().map(([k, c]) => `${k} x${c}`).join(', ')}`);
}
console.log('\ndone.');
