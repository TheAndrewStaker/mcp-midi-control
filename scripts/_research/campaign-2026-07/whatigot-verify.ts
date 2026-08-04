/**
 * What I Got post-write verification (read-only, disk only; device captures:
 * samples/circuit-ncs/whatigot-authored-2026-07-29 (slots 41-49),
 * whatigot-brainstew-identity-2026-07-29 (33-38),
 * whatigot-redbone-identity-2026-07-29 (25-32)).
 * Run: npx tsx samples/_scratch/whatigot-verify.ts
 *
 * Asserts (plan §4 step 11):
 *  A. Brain Stew 33-38 + Redbone 25-32: FULL-FILE byte identity vs their
 *     canonical authored sweeps.
 *  B. Slots 41-49 headers: name @0x10, colour 3 (Orange) @0x0c, tempo 96
 *     @0x34, swing 50, scale 0/15 Chromatic, synth levels 0/100 @0x2701c/d,
 *     drum levels 0x4, binding [1,2,5,11] @0x1a278, scene end byte 0; chains
 *     [0,2]/[0,0]/[0,1]/[0,5]/[0,3]/[0,3]/[0,2]/[0,3]/[0,1]; length bytes
 *     [23,31,15] on 41, else 31; FULL per-step decode == staged rows
 *     (synth1/synth2/midi1 pitch+gate+tie+velocity; midi2 per-step velocity
 *     multiset + range 48..61 GM+12; internal drums == role union with the
 *     receipts' fold map kick->1 / snare+perc+tom->2 / hat+openhat->3,
 *     velocities in {124,110,90,60,40,28}); KICK-LANE assert (drum1 + the
 *     midi2 note-48 lane populated in every drum-bearing pattern, exact steps
 *     == staged kick rows); letter census == staged order; tail spot checks
 *     (m1 half-bar silence, m67 kick flourish 0/2/3 + openhat).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const NEW_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/whatigot-authored-2026-07-29';
const BS_NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/whatigot-brainstew-identity-2026-07-29';
const BS_OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/brainstew-authored-2026-07-29';
const RB_NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/whatigot-redbone-identity-2026-07-29';
const RB_OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/redbone-authored-2026-07-29';
const STAGED = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/_scratch/whatigot-staged.json', 'utf8')) as Array<{
  slot: number; project_name: string; order: string[];
  sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
}>;

const loadDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /project(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(join(dir, f)));
  }
  return m;
};
const wig = loadDir(NEW_DIR);
const bsNew = loadDir(BS_NEW); const bsOld = loadDir(BS_OLD);
const rbNew = loadDir(RB_NEW); const rbOld = loadDir(RB_OLD);

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);

// == A. neighbour byte identity ======================================
const identity = (label: string, oldM: Map<number, Buffer>, newM: Map<number, Buffer>, from: number, to: number): void => {
  console.log(`=== A. ${label}: full-file byte identity ===`);
  for (let slot = from; slot <= to; slot++) {
    const a = oldM.get(slot); const b = newM.get(slot);
    if (!a || !b) { fail(`slot ${slot}: missing capture (old=${!!a} new=${!!b})`); continue; }
    if (a.equals(b)) ok(`slot ${slot} byte-identical (${b.length} bytes)`);
    else {
      let first = -1; let n = 0;
      for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
      fail(`slot ${slot} DIFFERS: ${n} bytes, first at 0x${first.toString(16)}`);
    }
  }
};
identity('Brain Stew 33-38 vs brainstew-authored', bsOld, bsNew, 33, 38);
identity('Redbone 25-32 vs redbone-authored', rbOld, rbNew, 25, 32);

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
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
// Fold map from the dry-run receipts: perc + tom fold onto the snare-family
// track (drum2); openhat onto the hat track (drum3). ride track (drum4) unused.
const ROLE_OF: Record<string, number> = { kick: 0, snare: 1, perc: 1, tom: 1, hat: 2, openhat: 2 };
const ALLOWED_VELS = new Set([124, 110, 90, 60, 40, 28]);
const EXPECT_CHAINS: Record<number, [number, number]> = {
  41: [0, 2], 42: [0, 0], 43: [0, 1], 44: [0, 5], 45: [0, 3], 46: [0, 3], 47: [0, 2], 48: [0, 3], 49: [0, 1],
};

let kickCellsTotal = 0; let kick48Total = 0;

console.log('\n=== B. slots 41-49: header, chains, lengths, full content ===');
for (const st of STAGED) {
  const buf = wig.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);
  const name = getProjectName(buf);
  if (name === st.project_name) ok(`name "${name}"`); else fail(`slot ${st.slot} name "${name}" != "${st.project_name}"`);
  if (buf[0x0c] === 3) ok('colour 3 (Orange)'); else fail(`slot ${st.slot} colour ${buf[0x0c]} != 3`);
  if (buf[0x34] === 96) ok('tempo 96'); else fail(`slot ${st.slot} tempo ${buf[0x34]} != 96`);
  const swing = getProjectSwing(buf);
  if (swing === 50) ok('swing 50'); else fail(`slot ${st.slot} swing ${swing} != 50`);
  if (buf[0x26d0c] === 0 && buf[0x26d0d] === 15) ok('scale root 0 / type 15 (Chromatic)');
  else fail(`slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  if (buf[0x2701c] === 0 && buf[0x2701d] === 100) ok('synth levels 0/100 @0x2701c/d');
  else fail(`slot ${st.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/100`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  if (dl.every((x) => x === 0)) ok('drum levels 0x4'); else fail(`slot ${st.slot} drum levels [${dl}] != 0x4`);
  const bind = [0, 1, 2, 3].map((i) => buf[0x1a278 + i]);
  if (JSON.stringify(bind) === JSON.stringify([1, 2, 5, 11])) ok('binding [1,2,5,11] @0x1a278');
  else fail(`slot ${st.slot} binding [${bind}] != [1,2,5,11]`);
  if (buf[0x2c1] === 0) ok('scene end byte 0 (plain/loop)'); else fail(`slot ${st.slot} scene end byte ${buf[0x2c1]}`);

  const secOf = new Map(st.sections.map((s) => [s.name, s]));
  const plays = st.order.map((nm) => secOf.get(nm)!);
  const expectSteps = plays.map((p) => p.steps);
  const [ec0, ec1] = EXPECT_CHAINS[st.slot];

  const noteContent: NoteTrack[] = [];
  for (const t of ['synth1', 'synth2', 'midi1'] as NoteTrack[]) {
    if (st.sections.some((s) => s.voices[t] !== undefined)) noteContent.push(t);
  }
  noteContent.push('midi2');
  for (const t of noteContent) {
    const [c0, c1] = chainOf(buf, NOTE_CHAIN_IDX[t]);
    if (c0 === ec0 && c1 === ec1) ok(`${t} chain [${c0},${c1}]`); else fail(`slot ${st.slot} ${t} chain [${c0},${c1}] != [${ec0},${ec1}]`);
    const lens = noteLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(expectSteps)) ok(`${t} lens [${lens}]`);
    else fail(`slot ${st.slot} ${t} lens [${lens}] != [${expectSteps}]`);
  }
  const drumContent: number[] = [];
  for (let t = 0; t < 4; t++) {
    if ([...Array(n).keys()].some((p) => decodeDrumPattern(buf, t, p).some((s: any) => s.active))) drumContent.push(t);
  }
  for (const t of drumContent) {
    const [c0, c1] = chainOf(buf, 4 + t);
    if (c0 === ec0 && c1 === ec1) ok(`drum${t + 1} chain [${c0},${c1}]`); else fail(`slot ${st.slot} drum${t + 1} chain [${c0},${c1}] != [${ec0},${ec1}]`);
    const lens = drumLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(expectSteps)) ok(`drum${t + 1} lens [${lens}]`);
    else fail(`slot ${st.slot} drum${t + 1} lens [${lens}] != [${expectSteps}]`);
  }

  // melodic tracks: per-step decode vs staged rows
  for (const t of noteContent.filter((x) => x !== 'midi2')) {
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
          if (g.active) { bad++; if (bad < 5) fail(`${key}: unexpected onset [${g.notes.map((x: any) => midiName(x.note))}]`); }
          continue;
        }
        if (!g.active) { bad++; if (bad < 5) fail(`${key}: MISSING onset ${e.notes.map(midiName)}`); continue; }
        const gp = g.notes.map((x: any) => x.note).sort((a: number, b: number) => a - b);
        if (JSON.stringify(gp) !== JSON.stringify(e.notes)) { bad++; if (bad < 5) fail(`${key}: pitches [${gp.map(midiName)}] != [${e.notes.map(midiName)}]`); continue; }
        for (const slotNote of g.notes as any[]) {
          if (e.gateSixths !== undefined && slotNote.gate !== e.gateSixths) { bad++; if (bad < 5) fail(`${key}: gate ${slotNote.gate} != ${e.gateSixths} sixths`); }
          if (slotNote.tie !== e.tie) { bad++; if (bad < 5) fail(`${key}: tie ${slotNote.tie} != ${e.tie}`); }
          if (e.velocity !== undefined && slotNote.velocity !== e.velocity) { bad++; if (bad < 5) fail(`${key}: vel ${slotNote.velocity} != ${e.velocity}`); }
        }
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows (pitch+gate+tie+velocity)`);
    else fail(`slot ${st.slot} ${t}: ${bad} step mismatches`);
  }

  // midi2: per-step velocity multiset + the exact GM+12 note set + the note-48
  // kick lane. Voice notes from the SPD-SX descriptor (descriptor.ts GM map):
  // kick 36, snare 38, hat 42, openhat 46, tom 45, perc 56; +12 on the wire =
  // {48, 50, 54, 58, 57, 68}. (The plan's "49 stick / 55 tom" figures were off
  // vs the shipped voice_map; named deviation, content identical.)
  {
    const ALLOWED_NOTES = new Set([48, 50, 54, 57, 58, 68]);
    const strayNotes = new Set<number>();
    let bad = 0; let lo = 127; let hi = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const drumRows = Object.entries(sec.voices).filter(([v]) => !MELODIC.has(v));
      const hasDrums = drumRows.length > 0;
      const got = decodeNotePattern(buf, 'midi2', p);
      const kickRow = sec.voices.kick;
      const expKickSteps = kickRow !== undefined
        ? kickRow.split(/\s+/).flatMap((tok, i) => (tok === '~' ? [] : [i])) : [];
      const got48: number[] = [];
      for (let s = 0; s < sec.steps; s++) {
        const expVels: number[] = [];
        for (const [, row] of drumRows) {
          const tok = row.split(/\s+/)[s];
          if (tok !== undefined && tok !== '~') {
            const m = /@(\d+)/.exec(tok);
            expVels.push(m ? Number(m[1]) : 100);
          }
        }
        const g = got[s];
        const gotVels = (g.notes as any[]).map((x) => x.velocity).sort((a, b) => a - b);
        for (const x of g.notes as any[]) {
          lo = Math.min(lo, x.note); hi = Math.max(hi, x.note);
          if (!ALLOWED_NOTES.has(x.note)) strayNotes.add(x.note);
          if (x.note === 48) got48.push(s);
        }
        if (JSON.stringify(gotVels) !== JSON.stringify(expVels.sort((a, b) => a - b))) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: vels [${gotVels}] != [${expVels}]`);
        }
      }
      // THE KICK-LANE DECODE ASSERT: number-27-derived (and p14) kick hits land
      // on their exact steps as note 48 (GM 36 + 12) on the midi2 leg.
      if (hasDrums) {
        if (JSON.stringify(got48) === JSON.stringify(expKickSteps) && expKickSteps.length > 0) {
          ok(`p${p + 1}: KICK lane on midi2 note 48 at steps [${got48.join(',')}] == staged`);
          kick48Total += got48.length;
        } else fail(`slot ${st.slot} p${p + 1}: midi2 note-48 kick steps [${got48}] != staged [${expKickSteps}]`);
      }
    }
    if (bad === 0) ok(`midi2: per-step velocity multiset == staged rows (all ${n} patterns)`);
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
    if (strayNotes.size === 0) ok(`midi2 notes ${lo}..${hi}, all within the GM+12 set {48,50,54,57,58,68}`);
    else fail(`slot ${st.slot} midi2 stray notes [${[...strayNotes]}] outside the GM+12 voice set`);
  }

  // internal drums: role union, velocities in the six-level set, kick presence
  {
    // Contention rule (the writer's documented condense order): fold DISTANCE
    // first, then velocity. A track's own exact-role voice (drum1=kick,
    // drum2=snare, drum3=hat, drum4=ride) wins the cell over a folded piece
    // (perc/tom onto drum2, openhat onto drum3) regardless of loudness; folded
    // pieces contend among themselves by velocity.
    const EXACT_OF: Record<number, string> = { 0: 'kick', 1: 'snare', 2: 'hat', 3: 'ride' };
    let bad = 0; let cells = 0; let expCells = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const exactSteps = new Map<string, number>();
      const foldedSteps = new Map<string, number>();
      let hasDrums = false;
      for (const [v, row] of Object.entries(sec.voices)) {
        if (MELODIC.has(v)) continue;
        hasDrums = true;
        const role = ROLE_OF[v];
        if (role === undefined) { fail(`slot ${st.slot} p${p + 1}: voice "${v}" has no role mapping`); continue; }
        const isExact = EXACT_OF[role] === v;
        row.split(/\s+/).forEach((tok, s) => {
          if (tok === '~') return;
          const m = /@(\d+)/.exec(tok);
          const vel = m ? Number(m[1]) : 100;
          const k = `${role}|${s}`;
          const target = isExact ? exactSteps : foldedSteps;
          target.set(k, Math.max(target.get(k) ?? 0, vel));
        });
      }
      const roleSteps = new Map<string, number>(foldedSteps);
      for (const [k, v] of exactSteps) roleSteps.set(k, v); // exact wins the cell
      expCells += roleSteps.size;
      let kickCells = 0;
      for (let t = 0; t < 4; t++) {
        decodeDrumPattern(buf, t, p).forEach((s: any, i: number) => {
          if (i >= sec.steps || !s.active) return;
          cells++;
          if (t === 0) { kickCells++; kickCellsTotal++; }
          if (!ALLOWED_VELS.has(s.velocity)) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: velocity ${s.velocity} not in {124,110,90,60,40,28}`); }
          const k = `${t}|${i}`;
          const want = roleSteps.get(k);
          if (want === undefined) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: hit not in staged role union`); }
          else if (want !== s.velocity) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: vel ${s.velocity} != loudest staged ${want}`); }
        });
      }
      if (hasDrums && kickCells === 0) fail(`slot ${st.slot} p${p + 1}: drum-bearing pattern has NO internal kick cell (drum1)`);
    }
    if (cells !== expCells) fail(`slot ${st.slot} internal drum cells ${cells} != expected ${expCells}`);
    if (bad === 0) ok(`internal drums: ${cells} cells == role union (fold kick->1, snare+perc+tom->2, hat+openhat->3), velocities OK`);
  }

  // letter census over stored patterns
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
    const nameSeen = new Map<string, string>();
    const wantLetters = st.order.map((nm) => {
      if (!nameSeen.has(nm)) nameSeen.set(nm, String.fromCharCode(65 + nameSeen.size));
      return nameSeen.get(nm)!;
    }).join(' ');
    const gotLetters = letters.join(' ');
    if (gotLetters === wantLetters) ok(`letter census == staged order (${gotLetters})`);
    else fail(`slot ${st.slot} letter census "${gotLetters}" != "${wantLetters}"`);
  }
}

// == C. tail spot checks ==============================================
console.log('\n=== C. tail spot checks ===');
{
  // slot 41 pattern 1 (m1-2, 24 steps): the 2/4 half bar m1 = steps 0-7 silent everywhere
  const buf = wig.get(41)!;
  let content = 0;
  for (const t of NOTE_TRACKS) decodeNotePattern(buf, t, 0).forEach((s: any, i: number) => { if (i < 8 && s.active) content++; });
  for (let t = 0; t < 4; t++) decodeDrumPattern(buf, t, 0).forEach((s: any, i: number) => { if (i < 8 && s.active) content++; });
  if (content === 0) ok('slot 41 pat1: m1 half bar (steps 0-7) silent on every track (press = bar 1)');
  else fail(`slot 41 pat1 m1 has ${content} active steps`);
  const len = buf[META_OFFSETS[drumBlockIndex(0, 0)]];
  if (len === 23) ok('slot 41 pat1 length byte 23 (24 steps)'); else fail(`slot 41 pat1 length byte ${len} != 23`);
}
{
  // slot 49 pattern 2 (m66-67): drum1 kick at m67 in-bar 0/2/3 = steps 16/18/19; drum3 openhat @24
  const buf = wig.get(49)!;
  const d1 = decodeDrumPattern(buf, 0, 1).flatMap((s: any, i: number) => (s.active && i >= 16 ? [i] : []));
  if (JSON.stringify(d1) === JSON.stringify([16, 18, 19])) ok('slot 49 pat2: m67 kick flourish at in-bar steps 0/2/3 (drum1 @16/18/19)');
  else fail(`slot 49 pat2 drum1 m67 steps [${d1}] != [16,18,19]`);
  const d3 = decodeDrumPattern(buf, 2, 1).flatMap((s: any, i: number) => (s.active && i >= 16 ? [i] : []));
  if (d3.includes(24)) ok('slot 49 pat2: m67 openhat ring @24 on the hat role'); else fail(`slot 49 pat2 drum3 m67 steps [${d3}] missing 24`);
  const s1 = decodeNotePattern(buf, 'synth1', 1).flatMap((s: any, i: number) => (s.active && i >= 16 ? [i] : []));
  if (s1.length === 0) ok('slot 49 pat2: bass silent in m67 (ends m66)'); else fail(`slot 49 pat2 synth1 m67 steps [${s1}]`);
}
{
  // slot 46 pattern 4 (m48-49): the four velocity-28 ghost drags on drum1 steps 3/7/13/15
  const buf = wig.get(46)!;
  const d1 = decodeDrumPattern(buf, 0, 3);
  const got28 = d1.flatMap((s: any, i: number) => (s.active && s.velocity === 28 ? [i] : []));
  if (JSON.stringify(got28) === JSON.stringify([3, 7, 13, 15])) ok('slot 46 pat4: the four vel-28 p15 ghost drags at steps 3/7/13/15 (named deviation, stored faithfully)');
  else fail(`slot 46 pat4 vel-28 cells [${got28}] != [3,7,13,15]`);
}

console.log(`\ninternal kick cells (drum1) total: ${kickCellsTotal}; midi2 note-48 kick hits total: ${kick48Total}`);
console.log(`${failures === 0 ? 'ALL VERIFICATION CHECKS PASS' : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
