/**
 * Brain Stew post-write verification (read-only, disk only; device captures:
 * samples/circuit-ncs/brainstew-authored-2026-07-29 (slots 33-38) and
 * samples/circuit-ncs/brainstew-redbone-identity-2026-07-29 (slots 25-32)).
 * Run: npx tsx samples/_scratch/brainstew-verify.ts
 *
 * Asserts:
 *  A. Redbone slots 25-32: FULL-FILE byte identity vs redbone-authored-2026-07-29.
 *  B. Slot 33 (silent count-in): name/colour/tempo/swing, synth levels 0/0,
 *     drum1 level 0 (drums 2-4 template 100), template binding, ONE kick hit at
 *     drum1 step 0 (the "mixer 0" silent form), everything else empty,
 *     drum1 chain [0,0] at 32 steps.
 *  C. Slots 34-38: header fields (name @0x10, colour 5 Yellow @0x0c, tempo 76
 *     @0x34, swing 50, scale 0/15 Chromatic, synth levels 0/0, drum levels 0x4,
 *     binding [1,2,5,11]), chains ([0,0]/[0,3]/[0,7]), pattern length bytes
 *     (Outro [32x7,16]), FULL per-step decode vs the staged rows (synth1
 *     pitch+gate+tie+velocity incl. the ring-out chain and the ONE writer
 *     tie-drop at 38/p7/s17; midi2 per-step velocity multiset 112/40 + range
 *     48..61; internal drums velocity in {112,40} with per-slot cell counts),
 *     letter census per slot.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const NEW_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/brainstew-authored-2026-07-29';
const RB_NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/brainstew-redbone-identity-2026-07-29';
const RB_OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/redbone-authored-2026-07-29';
const TEMPLATE = readFileSync('C:/dev/mcp-midi-tools/samples/circuit-tracks/blank_slot20.ncs');
const STAGED = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/_scratch/brainstew-staged.json', 'utf8')) as Array<{
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
const bs = loadDir(NEW_DIR);
const rbNew = loadDir(RB_NEW);
const rbOld = loadDir(RB_OLD);

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);

// == A. Redbone 25-32 byte identity ===================================
console.log('=== A. Redbone slots 25-32: full-file byte identity vs redbone-authored ===');
for (let slot = 25; slot <= 32; slot++) {
  const a = rbOld.get(slot); const b = rbNew.get(slot);
  if (!a || !b) { fail(`slot ${slot}: missing capture (old=${!!a} new=${!!b})`); continue; }
  if (a.equals(b)) ok(`slot ${slot} byte-identical (${b.length} bytes)`);
  else {
    let first = -1; let n = 0;
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
const headerChecks = (buf: Buffer, slot: number, wantName: string): void => {
  const name = getProjectName(buf);
  if (name === wantName) ok(`name "${name}"`); else fail(`slot ${slot} name "${name}" != "${wantName}"`);
  if (buf[0x0c] === 5) ok('colour 5 (Yellow)'); else fail(`slot ${slot} colour ${buf[0x0c]} != 5`);
  if (buf[0x34] === 76) ok('tempo 76'); else fail(`slot ${slot} tempo ${buf[0x34]} != 76`);
  const swing = getProjectSwing(buf);
  if (swing === 50) ok('swing 50'); else fail(`slot ${slot} swing ${swing} != 50`);
  if (buf[0x2701c] === 0 && buf[0x2701d] === 0) ok('synth levels 0/0 @0x2701c/d');
  else fail(`slot ${slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`);
};

// == B. slot 33, the silent count-in ==================================
console.log('\n=== B. slot 33 "BrainStew 1 Solo" (silent count-in) ===');
{
  const buf = bs.get(33);
  if (!buf) fail('slot 33: no capture');
  else {
    headerChecks(buf, 33, 'BrainStew 1 Solo');
    const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
    if (JSON.stringify(dl) === JSON.stringify([0, 100, 100, 100])) ok('drum levels [0,100,100,100] (drum1 silenced, rest template)');
    else fail(`slot 33 drum levels [${dl}] != [0,100,100,100]`);
    // drum_binding omitted -> the writer stamps its documented CANONICAL default
    // [0,1,2,3] (tool contract), not the template's residue. Inert here (one
    // level-0 hit on drum1 -> Pack 2 pool slot 0).
    const bind = [0, 1, 2, 3].map((i) => buf[0x1a278 + i]);
    if (JSON.stringify(bind) === JSON.stringify([0, 1, 2, 3])) ok(`binding == writer canonical default [${bind}] (arg omitted; inert at level 0)`);
    else fail(`slot 33 binding [${bind}] != [0,1,2,3]`);
    // content: ONE kick (drum1) hit at pattern 1 step 0, velocity 100; all else silent
    const d1 = decodeDrumPattern(buf, 0, 0);
    const hits = d1.flatMap((s: any, i: number) => (s.active ? [i] : []));
    if (JSON.stringify(hits) === '[0]' && d1[0].velocity === 100) ok('drum1 pattern 1: one hit @0 vel 100 (level-0 silent)');
    else fail(`slot 33 drum1 hits [${hits}] vel ${d1[0]?.velocity}`);
    for (let t = 1; t < 4; t++) {
      const any = [...Array(8).keys()].some((p) => decodeDrumPattern(buf, t, p).some((s: any) => s.active));
      if (any) fail(`slot 33 drum${t + 1} has content`);
    }
    for (const t of NOTE_TRACKS) {
      const any = [...Array(8).keys()].some((p) => decodeNotePattern(buf, t, p).some((s: any) => s.active));
      if (any) fail(`slot 33 ${t} has content`);
    }
    ok('drums 2-4 + all note tracks empty');
    const [c0, c1] = chainOf(buf, 4); // drum1 chain
    if (c0 === 0 && c1 === 0) ok('drum1 chain [0,0] (single pattern loops)'); else fail(`slot 33 drum1 chain [${c0},${c1}]`);
    const len = drumLens(buf, 0, 1)[0];
    if (len === 32) ok('drum1 pattern length 32 steps'); else fail(`slot 33 drum1 len ${len} != 32`);
    if (buf[0x2c1] === 0) ok('scene end byte 0'); else fail(`slot 33 scene end byte ${buf[0x2c1]}`);
  }
}

// == C. slots 34-38 ====================================================
console.log('\n=== C. slots 34-38: header, chains, lengths, full content ===');
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
// The ONE writer-level tie drop (dry-run-reported: gate 15 steps does not end
// on a matching next onset -- the row-cyclic target is the step-0 g#1).
const TIE_DROPS = new Set(['38/synth1/p7/s17']);
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
const ROLE_OF: Record<string, number> = { kick: 0, snare: 1, hat: 2, openhat: 2, crash: 3, ride: 3 };

for (const st of STAGED.filter((s) => s.slot >= 34)) {
  const buf = bs.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);
  headerChecks(buf, st.slot, st.project_name);
  if (buf[0x26d0c] === 0 && buf[0x26d0d] === 15) ok('scale root 0 / type 15 (Chromatic)');
  else fail(`slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  if (dl.every((x) => x === 0)) ok('drum levels 0x4'); else fail(`slot ${st.slot} drum levels [${dl}] != 0x4`);
  const bind = [0, 1, 2, 3].map((i) => buf[0x1a278 + i]);
  if (JSON.stringify(bind) === JSON.stringify([1, 2, 5, 11])) ok('binding [1,2,5,11] @0x1a278');
  else fail(`slot ${st.slot} binding [${bind}] != [1,2,5,11]`);

  const secOf = new Map(st.sections.map((s) => [s.name, s]));
  const plays = st.order.map((nm) => secOf.get(nm)!);
  const expectSteps = plays.map((p) => p.steps);

  const hasSynth1 = st.sections.some((s) => s.voices.synth1 !== undefined);
  const noteContent: NoteTrack[] = [...(hasSynth1 ? ['synth1' as NoteTrack] : []), 'midi2'];

  if (buf[0x2c1] === 0) ok('scene end byte 0 (plain/loop)'); else fail(`slot ${st.slot} scene end byte ${buf[0x2c1]}`);
  for (const t of noteContent) {
    const [c0, c1] = chainOf(buf, NOTE_CHAIN_IDX[t]);
    if (c0 === 0 && c1 === n - 1) ok(`${t} chain [0,${n - 1}]`); else fail(`slot ${st.slot} ${t} chain [${c0},${c1}] != [0,${n - 1}]`);
  }
  const drumContent: number[] = [];
  for (let t = 0; t < 4; t++) {
    if ([...Array(n).keys()].some((p) => decodeDrumPattern(buf, t, p).some((s: any) => s.active))) drumContent.push(t);
  }
  for (const t of drumContent) {
    const [c0, c1] = chainOf(buf, 4 + t);
    if (c0 === 0 && c1 === n - 1) ok(`drum${t + 1} chain [0,${n - 1}]`); else fail(`slot ${st.slot} drum${t + 1} chain [${c0},${c1}] != [0,${n - 1}]`);
  }
  for (const t of noteContent) {
    const lens = noteLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(expectSteps)) ok(`${t} lens [${lens}]`);
    else fail(`slot ${st.slot} ${t} lens [${lens}] != [${expectSteps}]`);
  }
  for (const t of drumContent) {
    const lens = drumLens(buf, t, n);
    if (JSON.stringify(lens) === JSON.stringify(expectSteps)) ok(`drum${t + 1} lens [${lens}]`);
    else fail(`slot ${st.slot} drum${t + 1} lens [${lens}] != [${expectSteps}]`);
  }

  // synth1 per-step decode vs staged rows
  if (hasSynth1) {
    let bad = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const row = sec.voices.synth1;
      const exp = row !== undefined ? expectedRow(row, sec.steps) : Array(sec.steps).fill(undefined);
      const got = decodeNotePattern(buf, 'synth1', p);
      for (let s = 0; s < sec.steps; s++) {
        const e = exp[s]; const g = got[s];
        const key = `${st.slot}/synth1/p${p + 1}/s${s}`;
        if (e === undefined) {
          if (g.active) { bad++; if (bad < 5) fail(`${key}: unexpected onset [${g.notes.map((x: any) => midiName(x.note))}]`); }
          continue;
        }
        if (!g.active) { bad++; if (bad < 5) fail(`${key}: MISSING onset ${e.notes.map(midiName)}`); continue; }
        const gp = g.notes.map((x: any) => x.note).sort((a: number, b: number) => a - b);
        if (JSON.stringify(gp) !== JSON.stringify(e.notes)) { bad++; if (bad < 5) fail(`${key}: pitches [${gp.map(midiName)}] != [${e.notes.map(midiName)}]`); continue; }
        const wantTie = e.tie && !TIE_DROPS.has(key);
        for (const slotNote of g.notes as any[]) {
          if (e.gateSixths !== undefined && slotNote.gate !== e.gateSixths) { bad++; if (bad < 5) fail(`${key}: gate ${slotNote.gate} != ${e.gateSixths} sixths`); }
          if (slotNote.tie !== wantTie) { bad++; if (bad < 5) fail(`${key}: tie ${slotNote.tie} != ${wantTie}`); }
          if (e.velocity !== undefined && slotNote.velocity !== e.velocity) { bad++; if (bad < 5) fail(`${key}: vel ${slotNote.velocity} != ${e.velocity}`); }
        }
      }
    }
    if (bad === 0) ok(`synth1: all ${n} patterns decode == staged rows (pitch+gate+tie+velocity; ring-out chain + the one named tie-drop)`);
    else fail(`slot ${st.slot} synth1: ${bad} step mismatches`);
  }

  // midi2: per-step velocity multiset (from @vel tokens) + note range 48..61
  {
    let bad = 0; let lo = 127; let hi = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const drumRows = Object.entries(sec.voices).filter(([v]) => !MELODIC.has(v));
      const got = decodeNotePattern(buf, 'midi2', p);
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
        for (const x of g.notes as any[]) { lo = Math.min(lo, x.note); hi = Math.max(hi, x.note); }
        if (JSON.stringify(gotVels) !== JSON.stringify(expVels.sort((a, b) => a - b))) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: vels [${gotVels}] != [${expVels}]`);
        }
      }
    }
    if (bad === 0) ok(`midi2: per-step velocity multiset == staged rows (all ${n} patterns)`);
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
    if (lo >= 48 && hi <= 61) ok(`midi2 note range ${lo}..${hi} within 48..61 (GM+12)`);
    else fail(`slot ${st.slot} midi2 note range ${lo}..${hi} outside 48..61`);
  }

  // internal drums: velocity in {112,40}; cell count per pattern == union of
  // staged rows mapped onto roles (kick->1, snare->2, hat/openhat->3, crash->4)
  {
    let bad = 0; let cells = 0; let ghosts = 0; let expCells = 0; let expGhosts = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const roleSteps = new Map<string, number>(); // "role|step" -> velocity (loudest)
      for (const [v, row] of Object.entries(sec.voices)) {
        if (MELODIC.has(v)) continue;
        const role = ROLE_OF[v];
        row.split(/\s+/).forEach((tok, s) => {
          if (tok === '~') return;
          const m = /@(\d+)/.exec(tok);
          const vel = m ? Number(m[1]) : 100;
          const k = `${role}|${s}`;
          roleSteps.set(k, Math.max(roleSteps.get(k) ?? 0, vel));
        });
      }
      expCells += roleSteps.size;
      expGhosts += [...roleSteps.values()].filter((v) => v === 40).length;
      for (let t = 0; t < 4; t++) {
        decodeDrumPattern(buf, t, p).forEach((s: any, i: number) => {
          if (i >= sec.steps || !s.active) return;
          cells++;
          if (s.velocity === 40) ghosts++;
          else if (s.velocity !== 112) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: velocity ${s.velocity} not in {112,40}`); }
          const k = `${t}|${i}`;
          const want = roleSteps.get(k);
          if (want === undefined) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: hit not in staged role union`); }
          else if (want !== s.velocity) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: vel ${s.velocity} != loudest staged ${want}`); }
        });
      }
    }
    if (cells !== expCells) fail(`slot ${st.slot} internal drum cells ${cells} != expected ${expCells}`);
    if (ghosts !== expGhosts) fail(`slot ${st.slot} internal ghost cells ${ghosts} != expected ${expGhosts}`);
    if (bad === 0) ok(`internal drums: ${cells} cells == role union, velocities {112,40}, ${ghosts} ghost cells`);
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
    // expected: same-name plays store identical patterns
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

// == D. tail spot checks ==============================================
console.log('\n=== D. tail spot checks ===');
{
  // slot 36 pattern 4 has the openhat closer (drum3 role) at step 30 + crash head
  const buf = bs.get(36)!;
  const d3 = decodeDrumPattern(buf, 2, 3);
  if (d3[30]?.active === true && d3[30].velocity === 112) ok('slot 36 pat4: openhat closer @30 on the hat role (m36 closer G)');
  else fail(`slot 36 pat4 drum3 @30: ${JSON.stringify(d3[30])}`);
}
{
  // slot 37 pattern 4: crash closers at 20/24/28 on drum4 (m47-48 closer H)
  const buf = bs.get(37)!;
  const d4 = decodeDrumPattern(buf, 3, 3);
  const hits = d4.flatMap((s: any, i: number) => (s.active ? [i] : []));
  if (JSON.stringify(hits) === JSON.stringify([0, 20, 24, 28])) ok('slot 37 pat4: crash @0/20/24/28 (closer H)');
  else fail(`slot 37 pat4 drum4 hits [${hits}] != [0,20,24,28]`);
}
{
  // slot 38 pattern 8 (m63, 16 steps): crash+kick @0, fuzz g#2 gate 96 vel 90 untied
  const buf = bs.get(38)!;
  const d1 = decodeDrumPattern(buf, 0, 7).flatMap((s: any, i: number) => (s.active ? [i] : []));
  const d4 = decodeDrumPattern(buf, 3, 7).flatMap((s: any, i: number) => (s.active ? [i] : []));
  if (JSON.stringify(d1) === '[0]' && JSON.stringify(d4) === '[0]') ok('slot 38 pat8 (m63): kick+crash @0 only');
  else fail(`slot 38 pat8 drum1 [${d1}] drum4 [${d4}]`);
  const s1 = decodeNotePattern(buf, 'synth1', 7);
  const on = s1.flatMap((s: any, i: number) => (s.active ? [i] : []));
  const n0 = s1[0]?.notes?.[0];
  if (JSON.stringify(on) === '[0]' && n0?.note === 44 && n0?.gate === 96 && n0?.tie === false && n0?.velocity === 90)
    ok('slot 38 pat8: g#2 continuation @0, gate 96 sixths (16 steps), untied, vel 90 (ring-out ends at song end)');
  else fail(`slot 38 pat8 synth1 [${on}] ${JSON.stringify(n0)}`);
  // pattern 7: the ring-out chain start: @1 g#2 gate 96 TIED, @17 g#2 gate 90 UNTIED (writer drop)
  const p7 = decodeNotePattern(buf, 'synth1', 6);
  const a = p7[1]?.notes?.[0]; const b = p7[17]?.notes?.[0];
  if (a?.note === 44 && a?.gate === 96 && a?.tie === true && b?.note === 44 && b?.gate === 90 && b?.tie === false)
    ok('slot 38 pat7: ring-out chain g#2:16_ @1 (tie STORED) + g#2:15 @17 (tie dropped by the writer, length kept)');
  else fail(`slot 38 pat7 synth1 @1=${JSON.stringify(a)} @17=${JSON.stringify(b)}`);
}

console.log(`\n${failures === 0 ? 'ALL VERIFICATION CHECKS PASS' : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
