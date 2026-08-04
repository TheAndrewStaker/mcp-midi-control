/**
 * Redbone post-write verification (read-only, disk only; device captures:
 * samples/circuit-ncs/redbone-authored-2026-07-29 (slots 25-32) and
 * samples/circuit-ncs/redbone-schism-identity-2026-07-29 (slots 9-24)).
 * Run: npx tsx samples/_scratch/redbone-verify.ts
 *
 * Asserts:
 *  A. Schism slots 9-24: FULL-FILE byte identity vs schism-tailfix-verify-2026-07-29.
 *  B. Redbone slots 25-32: header fields (name @0x10, colour 8 @0x0c, tempo 80
 *     @0x34, swing 50, scale 15/0 @0x26d0c/d, synth levels 0/100 @0x2701c/d,
 *     drum levels 0x4, binding [1,2,5,11] @0x1a278), plain chains [0,N-1] on
 *     every content track (scene end byte 0), pattern length bytes, FULL
 *     per-step decode vs the staged rows (pitches, gates in sixths, ties,
 *     velocities) for the note tracks, midi2 census (range 48..61, velocity
 *     multiset per step), internal-drum v127 role checks, letter census.
 *  C. Closing-bar assertions per plan step 12 + the intro drone tie chain
 *     (step 13: no fresh onset at Intro patterns 2-5 step 1).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern, type NoteStep } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const NEW_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/redbone-authored-2026-07-29';
const SCHISM_NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/redbone-schism-identity-2026-07-29';
const SCHISM_OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/schism-tailfix-verify-2026-07-29';
const STAGED = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/_scratch/redbone-staged.json', 'utf8')) as Array<{
  slot: number; project_name: string; order: string[]; letters: string;
  sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
  v127: Array<{ pattern: number; voice: string; step: number }>;
}>;

const loadDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /project(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(join(dir, f)));
  }
  return m;
};
const redbone = loadDir(NEW_DIR);
const schismNew = loadDir(SCHISM_NEW);
const schismOld = loadDir(SCHISM_OLD);

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);

// == A. Schism 9-24 byte identity =====================================
console.log('=== A. Schism slots 9-24: full-file byte identity vs schism-tailfix-verify ===');
for (let slot = 9; slot <= 24; slot++) {
  const a = schismOld.get(slot); const b = schismNew.get(slot);
  if (!a || !b) { fail(`slot ${slot}: missing capture (old=${!!a} new=${!!b})`); continue; }
  if (a.equals(b)) ok(`slot ${slot} byte-identical (${b.length} bytes)`);
  else {
    let first = -1, n = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
    fail(`slot ${slot} DIFFERS: ${n} bytes, first at 0x${first.toString(16)}`);
  }
}

// == helpers ==========================================================
const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const CHAIN_BASE = 0x2c4;
const chainOf = (buf: Buffer, idx: number): [number, number] => [buf[CHAIN_BASE + idx * 4], buf[CHAIN_BASE + idx * 4 + 1]];
const noteLens = (buf: Buffer, t: NoteTrack, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[noteBlockIndex(t, p)]] + 1);
const drumLens = (buf: Buffer, t: number, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1);
const midiName = (n: number): string => {
  const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  return NAMES[n % 12] + (Math.floor(n / 12) - 1);
};

// expected steps for one staged melodic row
interface ExpNote { notes: number[]; gateSixths?: number; tie: boolean; velocity?: number }
const expectedRow = (row: string, steps: number): (ExpNote | undefined)[] => {
  const parsed = parseVoice(row, steps);
  return parsed.map((s: any) => {
    if (!s.on) return undefined;
    const notes = Array.isArray(s.notes) ? [...s.notes].sort((a: number, b: number) => a - b) : [s.notes];
    return {
      notes,
      ...(s.gate_sixths !== undefined ? { gateSixths: s.gate_sixths } : {}),
      tie: s.tie === true,
      ...(s.velocity !== undefined ? { velocity: s.velocity } : {}),
    };
  });
};

// the two known writer-level tie drops (cyclic tie target is a different pitch)
const TIE_DROPS = new Set(['31/midi1/p5/s30', '32/midi1/p5/s30']);

// == B. Redbone slots 25-32 ==========================================
console.log('\n=== B. Redbone slots 25-32: header, chains, lengths, full content ===');
const melodicVelSeen = new Map<number, number>(); // velocity -> count (melodic tracks, unset expected)
for (const st of STAGED) {
  const buf = redbone.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);

  // header
  const name = getProjectName(buf);
  if (name === st.project_name) ok(`name "${name}"`); else fail(`name "${name}" != "${st.project_name}"`);
  if (buf[0x0c] === 8) ok('colour 8 (Green)'); else fail(`colour ${buf[0x0c]} != 8`);
  if (buf[0x34] === 80) ok('tempo 80'); else fail(`tempo ${buf[0x34]} != 80`);
  const swing = getProjectSwing(buf);
  if (swing === 50) ok('swing 50'); else fail(`swing ${swing} != 50`);
  // 0x26D0C = ROOT (0 = C), 0x26D0D = TYPE (15 = Chromatic) - scale.ts offsets
  if (buf[0x26d0c] === 0 && buf[0x26d0d] === 15) ok('scale root 0 (C) / type 15 (Chromatic) @0x26d0c/d');
  else fail(`scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15 (root C / Chromatic)`);
  if (buf[0x2701c] === 0 && buf[0x2701d] === 100) ok('synth levels 0/100 @0x2701c/d');
  else fail(`synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/100`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  if (dl.every((x) => x === 0)) ok('drum levels 0x4'); else fail(`drum levels [${dl}] != 0x4`);
  const bind = [0, 1, 2, 3].map((i) => buf[0x1a278 + i]);
  if (JSON.stringify(bind) === JSON.stringify([1, 2, 5, 11])) ok('binding [1,2,5,11] @0x1a278');
  else fail(`binding [${bind}] != [1,2,5,11]`);

  // per-play expected sections
  const secOf = new Map(st.sections.map((s) => [s.name, s]));
  const plays = st.order.map((nm) => secOf.get(nm)!);
  const expectSteps = plays.map((p) => p.steps);

  // which tracks carry content
  const noteContent = NOTE_TRACKS.filter((t) => t === 'midi2'
    ? st.sections.some((s) => ['kick', 'snare', 'hat', 'tom', 'openhat', 'ride'].some((v) => s.voices[v] !== undefined))
    : st.sections.some((s) => s.voices[t] !== undefined));

  // scene end byte + chains
  if (buf[0x2c1] === 0) ok('scene end byte @0x2c1 == 0 (plain chain)'); else fail(`scene end byte ${buf[0x2c1]} != 0`);
  for (const t of noteContent) {
    const [c0, c1] = chainOf(buf, NOTE_CHAIN_IDX[t]);
    if (c0 === 0 && c1 === n - 1) ok(`${t} chain [0-${n - 1}]`); else fail(`${t} chain [${c0}-${c1}] != [0-${n - 1}]`);
  }
  const drumContent: number[] = [];
  for (let t = 0; t < 4; t++) {
    if ([...Array(n).keys()].some((p) => decodeDrumPattern(buf, t, p).some((s: any) => s.active))) drumContent.push(t);
  }
  for (const t of drumContent) {
    const [c0, c1] = chainOf(buf, 4 + t);
    if (c0 === 0 && c1 === n - 1) ok(`drum${t + 1} chain [0-${n - 1}]`); else fail(`drum${t + 1} chain [${c0}-${c1}] != [0-${n - 1}]`);
  }

  // pattern length bytes
  for (const t of noteContent) {
    const lens = noteLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(expectSteps)) ok(`${t} lens [${lens}]`);
    else fail(`${t} lens [${lens}] != [${expectSteps}]`);
  }
  for (const t of drumContent) {
    const lens = drumLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(expectSteps)) ok(`drum${t + 1} lens [${lens}]`);
    else fail(`drum${t + 1} lens [${lens}] != [${expectSteps}]`);
  }

  // full per-step content: melodic note tracks vs staged rows
  for (const t of ['synth1', 'synth2', 'midi1'] as NoteTrack[]) {
    if (!noteContent.includes(t)) continue;
    let bad = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const row = sec.voices[t];
      const exp = row !== undefined ? expectedRow(row, sec.steps) : Array(sec.steps).fill(undefined);
      const got = decodeNotePattern(buf, t, p);
      for (let s = 0; s < sec.steps; s++) {
        const e = exp[s]; const g = got[s];
        const key = `${st.slot}/${t}/p${p + 1}/s${s}`;
        if (e === undefined) {
          if (g.active) { bad++; if (bad < 4) fail(`${key}: unexpected onset [${g.notes.map((x: any) => midiName(x.note))}]`); }
          continue;
        }
        if (!g.active) { bad++; if (bad < 4) fail(`${key}: MISSING onset ${e.notes.map(midiName)}`); continue; }
        const gp = g.notes.map((x: any) => x.note).sort((a: number, b: number) => a - b);
        if (JSON.stringify(gp) !== JSON.stringify(e.notes)) { bad++; if (bad < 4) fail(`${key}: pitches [${gp.map(midiName)}] != [${e.notes.map(midiName)}]`); continue; }
        const wantTie = e.tie && !TIE_DROPS.has(key);
        for (const slot of g.notes as any[]) {
          if (e.gateSixths !== undefined && slot.gate !== e.gateSixths) { bad++; if (bad < 4) fail(`${key}: gate ${slot.gate} != ${e.gateSixths} sixths`); }
          if (slot.tie !== wantTie) { bad++; if (bad < 4) fail(`${key}: tie ${slot.tie} != ${wantTie}`); }
          if (e.velocity !== undefined) {
            if (slot.velocity !== e.velocity) { bad++; if (bad < 4) fail(`${key}: vel ${slot.velocity} != ${e.velocity}`); }
          } else melodicVelSeen.set(slot.velocity, (melodicVelSeen.get(slot.velocity) ?? 0) + 1);
        }
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows (pitch+gate+tie)`);
    else fail(`${t}: ${bad} step mismatches`);
  }

  // midi2: per-step velocity multiset + note range 48..61
  if (noteContent.includes('midi2')) {
    let bad = 0; let lo = 127; let hi = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const drumRows = Object.entries(sec.voices).filter(([v]) => !['synth1', 'synth2', 'midi1'].includes(v));
      const got = decodeNotePattern(buf, 'midi2', p);
      for (let s = 0; s < sec.steps; s++) {
        const expVels: number[] = [];
        for (const [, row] of drumRows) {
          const tok = row.split(/\s+/)[s];
          if (tok !== undefined && tok !== '~') expVels.push(tok.includes('@127') ? 127 : 100);
        }
        const g = got[s];
        const gotVels = (g.notes as any[]).map((x) => x.velocity).sort((a, b) => a - b);
        for (const x of g.notes as any[]) { lo = Math.min(lo, x.note); hi = Math.max(hi, x.note); }
        if (JSON.stringify(gotVels) !== JSON.stringify(expVels.sort((a, b) => a - b))) {
          bad++; if (bad < 4) fail(`${st.slot}/midi2/p${p + 1}/s${s}: vels [${gotVels}] != [${expVels}]`);
        }
      }
    }
    if (bad === 0) ok(`midi2: per-step velocity multiset matches the staged drum rows (all ${n} patterns)`);
    else fail(`midi2: ${bad} step mismatches`);
    if (lo >= 48 && hi <= 61) ok(`midi2 note range ${lo}..${hi} within 48..61 (GM+12)`);
    else fail(`midi2 note range ${lo}..${hi} outside 48..61`);
  }

  // internal drums: staged v127 hits land on their ROLE track at 127; all other
  // active internal steps are 100; internal v127 total == staged count
  {
    const ROLE: Record<string, number> = { kick: 0, snare: 1, hat: 2, ride: 3 };
    let bad = 0; let v127int = 0;
    for (const v of st.v127) {
      const role = ROLE[v.voice];
      if (role === undefined) { fail(`${st.slot}: v127 on unmapped voice ${v.voice}`); continue; }
      const dec = decodeDrumPattern(buf, role, v.pattern - 1);
      if (!dec[v.step].active || dec[v.step].velocity !== 127) {
        bad++; fail(`${st.slot}/drum${role + 1}/p${v.pattern}/s${v.step}: expected v127 ${v.voice} hit, got active=${dec[v.step].active} vel=${dec[v.step].velocity}`);
      }
    }
    for (let t = 0; t < 4; t++) {
      for (let p = 0; p < n; p++) {
        decodeDrumPattern(buf, t, p).forEach((s: any, i: number) => {
          if (!s.active) return;
          if (s.velocity === 127) v127int++;
          else if (s.velocity !== 100) { bad++; if (bad < 6) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: velocity ${s.velocity} not in {100,127}`); }
        });
      }
    }
    if (v127int !== st.v127.length) fail(`${st.slot}: internal v127 count ${v127int} != staged ${st.v127.length}`);
    if (bad === 0) ok(`internal drums: ${st.v127.length} x v127 on role tracks, everything else 100 (v127 total ${v127int})`);
  }

  // letter census: same-letter plays decode-identical, different letters differ
  {
    const img = (p: number): string => JSON.stringify({
      notes: NOTE_TRACKS.map((t) => decodeNotePattern(buf, t, p)),
      drums: [0, 1, 2, 3].map((t) => decodeDrumPattern(buf, t, p)),
      len: NOTE_TRACKS.map((t) => buf[META_OFFSETS[noteBlockIndex(t, p)]]),
    });
    const seen = new Map<string, string>();
    const letters: string[] = [];
    for (let p = 0; p < n; p++) {
      const k = img(p);
      if (!seen.has(k)) seen.set(k, String.fromCharCode(65 + seen.size));
      letters.push(seen.get(k)!);
    }
    const gotLetters = letters.join(' ');
    // Slot 32 stored census: the ONLY staged difference between m98-99 (play 2)
    // and m104-105 (play 5) was the midi1 tie flag the writer drops (cyclic
    // target differs), so the two patterns store IDENTICAL and play 5 folds to
    // letter B. The held tail still sounds via pattern 6's d#4:16 continuation.
    const wantLetters = st.slot === 32 ? 'A B C A B D' : st.letters;
    if (gotLetters === wantLetters) ok(`letter census == expected (${gotLetters})${st.slot === 32 ? ' [p5 folds to B: tie-drop, see note]' : ''}`);
    else fail(`letter census "${gotLetters}" != expected "${wantLetters}"`);
  }
}
{
  const vels = [...melodicVelSeen.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`melodic default velocity census (unset in source): ${vels.map(([v, c]) => `${v}x${c}`).join(' ')}`);
  if (vels.length === 1) ok(`melodic default velocity uniform (${vels[0][0]})`);
  else fail('melodic default velocity NOT uniform');
}

// == C. closing bars + drone =========================================
console.log('\n=== C. closing-bar assertions + the intro drone ===');
const bufOf = (slot: number): Buffer => redbone.get(slot)!;
const kickSteps = (slot: number, p: number): number[] => {
  const out: number[] = [];
  decodeDrumPattern(bufOf(slot), 0, p).forEach((s: any, i: number) => { if (s.active) out.push(i); });
  return out;
};
// 13. Intro drone: midi1 patterns 1-5 = d#6 (87) @0 gate 96 tie + @16 gate 96 tie,
//     final pattern 5 @16 untied; NO other onsets = no fresh attack at patterns 2-5 step 1.
{
  const buf = bufOf(25);
  let good = true;
  for (let p = 0; p < 5; p++) {
    const dec = decodeNotePattern(buf, 'midi1', p);
    for (let s = 0; s < 32; s++) {
      const g = dec[s];
      if (s === 0 || s === 16) {
        const wantTie = !(p === 4 && s === 16);
        if (!g.active || g.notes.length !== 1 || g.notes[0].note !== 87 || g.notes[0].gate !== 96 || g.notes[0].tie !== wantTie) {
          good = false; fail(`drone p${p + 1}/s${s}: ${JSON.stringify(g.notes)} (want d#6 gate96 tie=${wantTie})`);
        }
      } else if (g.active) { good = false; fail(`drone p${p + 1}/s${s}: unexpected onset`); }
    }
  }
  if (good) ok('slot 25 drone: 10-bar d#6 tied chain intact across patterns 1-5, final untied, zero fresh attacks');
}
// 12. tails
{
  // Verse pat8: midi1 = d#6 chain @0(tie)+@16(untied); 7 v127 kicks (internal + midi2 asserted above)
  const dec = decodeNotePattern(bufOf(26), 'midi1', 7);
  const on = dec.flatMap((s: any, i: number) => (s.active ? [i] : []));
  if (JSON.stringify(on) === '[0,16]' && dec[0].notes[0].note === 87 && dec[0].notes[0].tie === true
    && dec[16].notes[0].note === 87 && dec[16].notes[0].tie === false)
    ok('slot 26 pat8: p9 one m25 d#6 note as tied chain @0_ + @16');
  else fail(`slot 26 pat8 midi1 onsets [${on}]`);
  const k26 = kickSteps(26, 7).length;
  const k127 = decodeDrumPattern(bufOf(26), 0, 7).filter((s: any) => s.active && s.velocity === 127).length;
  if (k127 === 7) ok('slot 26 pat8: 7 v127 kicks (m25-26 fill)'); else fail(`slot 26 pat8: ${k127} v127 kicks of ${k26}`);
}
{
  const k127 = decodeDrumPattern(bufOf(27), 0, 6).filter((s: any) => s.active && s.velocity === 127).length;
  if (k127 === 5) ok('slot 27 pat7: 5 v127 kicks (m39-40 fill)'); else fail(`slot 27 pat7: ${k127} v127 kicks`);
}
{
  const lens = drumLens(bufOf(28), 2, 4);
  const h = decodeDrumPattern(bufOf(28), 2, 3);
  const hit = h.flatMap((s: any, i: number) => (s.active ? [i] : []));
  if (lens[3] === 16 && JSON.stringify(hit) === '[12]' && h[12].velocity === 127)
    ok('slot 28 pat4: 16 steps, ONE hat@127 at step 12 (the m55 fill hit); m56 re-aligns');
  else fail(`slot 28 pat4: lens [${lens}] hat hits [${hit}] vel ${h[12]?.velocity}`);
}
{
  const k127 = decodeDrumPattern(bufOf(29), 0, 7).filter((s: any) => s.active && s.velocity === 127).length;
  if (k127 === 7) ok('slot 29 pat8: 7 v127 kicks (m70-71 close)'); else fail(`slot 29 pat8: ${k127} v127 kicks`);
}
{
  // BridgeA pat6 == pat3 decode-identical (cell close)
  const buf = bufOf(30);
  const same = NOTE_TRACKS.every((t) => JSON.stringify(decodeNotePattern(buf, t, 5)) === JSON.stringify(decodeNotePattern(buf, t, 2)))
    && [0, 1, 2, 3].every((t) => JSON.stringify(decodeDrumPattern(buf, t, 5)) === JSON.stringify(decodeDrumPattern(buf, t, 2)));
  if (same) ok('slot 30 pat6 decode-identical to pat3 (m76-77 cell close; wrap replays whole cycles)');
  else fail('slot 30 pat6 != pat3');
}
{
  // BridgeB pat6 == pat3 on all tracks EXCEPT midi1; midi1 = d#4:16 continuation @0
  const buf = bufOf(31);
  const same = (['synth1', 'synth2', 'midi2'] as NoteTrack[]).every((t) => JSON.stringify(decodeNotePattern(buf, t, 5)) === JSON.stringify(decodeNotePattern(buf, t, 2)))
    && [0, 1, 2, 3].every((t) => JSON.stringify(decodeDrumPattern(buf, t, 5)) === JSON.stringify(decodeDrumPattern(buf, t, 2)));
  const m1 = decodeNotePattern(buf, 'midi1', 5);
  const on = m1.flatMap((s: any, i: number) => (s.active ? [i] : []));
  const contOk = JSON.stringify(on) === '[0]' && m1[0].notes[0].note === 63 && m1[0].notes[0].gate === 96 && m1[0].notes[0].tie === false;
  if (same && contOk) ok('slot 31 pat6 = m88-89 cell close + the d#4:16 strings-tail continuation @0 (the named deviation)');
  else fail(`slot 31 pat6: same-others=${same} midi1 [${on}] ${JSON.stringify(m1[0]?.notes)}`);
  // pat5 midi1 tail: d#4 @30 gate 12 sixths, tie dropped by the writer
  const p5 = decodeNotePattern(buf, 'midi1', 4);
  if (p5[30].active && p5[30].notes[0].note === 63 && p5[30].notes[0].gate === 12 && p5[30].notes[0].tie === false)
    ok('slot 31 pat5 midi1 @30: d#4 gate 2 steps, tie dropped by the writer (cyclic target g#4 differs)');
  else fail(`slot 31 pat5 midi1 @30: ${JSON.stringify(p5[30])}`);
}
{
  // Outro pat6: the m107 ending image (local steps: kick 16/22/24, hat 16/18/20/22/24/28, snare 20)
  const buf = bufOf(32);
  const want: Array<[number, number[]]> = [[0, [16, 22, 24]], [2, [16, 18, 20, 22, 24, 28]], [1, [20]]];
  const bad: string[] = [];
  for (const [t, steps] of want) {
    const got: number[] = [];
    decodeDrumPattern(buf, t, 5).forEach((s: any, i: number) => { if (s.active && i >= 16) got.push(i); });
    if (JSON.stringify(got) !== JSON.stringify(steps)) bad.push(`drum${t + 1} [${got}] != [${steps}]`);
  }
  const m1 = decodeNotePattern(buf, 'midi1', 5);
  const on = m1.flatMap((s: any, i: number) => (s.active ? [i] : []));
  if (bad.length === 0) ok('slot 32 pat6 m107 ending image (0:hat+kick 2:hat 4:hat+snare 6:hat+kick 8:hat+kick 12:hat)');
  else fail(`slot 32 pat6 ending: ${bad.join('; ')}`);
  if (JSON.stringify(on) === '[0]' && m1[0].notes[0].note === 63) ok('slot 32 pat6 midi1 = the d#4:16 continuation @0');
  else fail(`slot 32 pat6 midi1 [${on}]`);
}

console.log(`\n${failures === 0 ? 'ALL VERIFICATION CHECKS PASS' : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
