/**
 * Billie Jean post-write verification (read-only, disk only; device captures:
 * samples/circuit-ncs/billiejean-authored-2026-07-30 (slots 57-64),
 * billiejean-whatigot-identity-2026-07-30 (41-49),
 * billiejean-brainstew-identity-2026-07-30 (33-38)).
 * Run: npx tsx samples/_scratch/billiejean-verify.ts
 *
 * Asserts (plan §4 step 10, acks do NOT count):
 *  A. What I Got 41-49 + Brain Stew 33-38: FULL-FILE byte identity vs their
 *     canonical authored sweeps (whatigot-authored-2026-07-29,
 *     brainstew-authored-2026-07-29).
 *  B. Slots 57-64: name @0x10, colour 13 (Pink) @0x0c, tempo 117 @0x34,
 *     swing 50, scale 0/15 Chromatic, synth levels 0/0 @0x2701c/d
 *     (stored-silent universal, maintainer directive 2026-07-30), drum
 *     levels 0 x4, binding [1,2,5,11] @0x1a278, scene end byte 0; chains
 *     [0,0]/[0,3]/[0,5]/[0,7]/[0,5]/[0,5]/[0,5]/[0,6]; all length bytes 31;
 *     FULL per-step decode == staged rows (synth1/synth2/midi1
 *     pitch+gate+tie+velocity, with ONE named exception: slot 61 midi1 pat2
 *     step 31 tie DROPPED by the writer (cyclic-target mismatch, the Redbone
 *     dev.2 mechanism, receipt-warned) — the plan's documented fallback, so
 *     the expectation there is tie=false with gate kept); midi2 exact
 *     (note,vel) pairs per step via the GM+12 map {kick48, snare50, hat54,
 *     tom57, crash61, clap51, maracas82(pinned)}; internal drums == role
 *     union kick->1, snare+tom+clap->2, hat+maracas->3, crash->4 with
 *     exact-role-wins-cell then velocity; the 13 @120 accents; letter census
 *     == staged order; closing-bar spot checks (crash heads m43/m83, tom
 *     m44@120, m110 hat accent, octave stabs, outro vamp identity).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const NEW_DIR = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/billiejean-authored-2026-07-30';
const WIG_NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/billiejean-whatigot-identity-2026-07-30';
const WIG_OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/whatigot-authored-2026-07-29';
const BS_NEW = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/billiejean-brainstew-identity-2026-07-30';
const BS_OLD = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/brainstew-authored-2026-07-29';
const STAGED = JSON.parse(readFileSync('C:/dev/mcp-midi-tools/samples/_scratch/billiejean-staged.json', 'utf8')) as Array<{
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
const bj = loadDir(NEW_DIR);
const wigNew = loadDir(WIG_NEW); const wigOld = loadDir(WIG_OLD);
const bsNew = loadDir(BS_NEW); const bsOld = loadDir(BS_OLD);

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
identity('What I Got 41-49 vs whatigot-authored', wigOld, wigNew, 41, 49);
identity('Brain Stew 33-38 vs brainstew-authored', bsOld, bsNew, 33, 38);

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
// GM+12 wire map for the midi2 external leg (SPD-SX voice_map + the maracas pin 70).
const MIDI2_NOTE: Record<string, number> = {
  kick: 48, snare: 50, hat: 54, tom: 57, crash: 61, clap: 51, maracas: 82,
};
// Internal condense role map (dry-run receipts + drumFold chains): exact roles
// kick/snare/hat own drums 1/2/3; folds tom+clap->2, maracas->3, crash->4.
const ROLE_OF: Record<string, number> = { kick: 0, snare: 1, tom: 1, clap: 1, hat: 2, maracas: 2, crash: 3 };
const EXACT_OF: Record<number, string> = { 0: 'kick', 1: 'snare', 2: 'hat', 3: 'ride' };
const EXPECT_CHAINS: Record<number, [number, number]> = {
  57: [0, 0], 58: [0, 3], 59: [0, 5], 60: [0, 7], 61: [0, 5], 62: [0, 5], 63: [0, 5], 64: [0, 6],
};
// The ONE named melodic exception: slot 61 midi1 pattern 2 (index 1) step 31 —
// staged "f#5:1_", writer dropped the tie (receipt-warned), gate kept.
const TIE_EXCEPTION = new Set(['61|midi1|1|31']);
let tieExceptionSeen = 0;

let total120 = 0;

console.log('\n=== B. slots 57-64: header, chains, lengths, full content ===');
for (const st of STAGED) {
  const buf = bj.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);
  const name = getProjectName(buf);
  if (name === st.project_name) ok(`name "${name}"`); else fail(`slot ${st.slot} name "${name}" != "${st.project_name}"`);
  if (buf[0x0c] === 13) ok('colour 13 (Pink)'); else fail(`slot ${st.slot} colour ${buf[0x0c]} != 13`);
  if (buf[0x34] === 117) ok('tempo 117'); else fail(`slot ${st.slot} tempo ${buf[0x34]} != 117`);
  const swing = getProjectSwing(buf);
  if (swing === 50) ok('swing 50'); else fail(`slot ${st.slot} swing ${swing} != 50`);
  if (buf[0x26d0c] === 0 && buf[0x26d0d] === 15) ok('scale root 0 / type 15 (Chromatic)');
  else fail(`slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  if (buf[0x2701c] === 0 && buf[0x2701d] === 0) ok('synth levels 0/0 @0x2701c/d (stored-silent universal)');
  else fail(`slot ${st.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`);
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
        let expTie = e.tie;
        if (TIE_EXCEPTION.has(`${st.slot}|${t}|${p}|${s}`)) { expTie = false; tieExceptionSeen++; }
        for (const slotNote of g.notes as any[]) {
          if (e.gateSixths !== undefined && slotNote.gate !== e.gateSixths) { bad++; if (bad < 5) fail(`${key}: gate ${slotNote.gate} != ${e.gateSixths} sixths`); }
          if (slotNote.tie !== expTie) { bad++; if (bad < 5) fail(`${key}: tie ${slotNote.tie} != ${expTie}`); }
          if (e.velocity !== undefined && slotNote.velocity !== e.velocity) { bad++; if (bad < 5) fail(`${key}: vel ${slotNote.velocity} != ${e.velocity}`); }
        }
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows (pitch+gate+tie+velocity)`);
    else fail(`slot ${st.slot} ${t}: ${bad} step mismatches`);
  }

  // midi2: EXACT (note, vel) pairs per step via the GM+12 map (voice->note is
  // injective here, so this is a full-content assert, stronger than a multiset)
  {
    let bad = 0; let lo = 127; let hi = 0; let n120 = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const got = decodeNotePattern(buf, 'midi2', p);
      for (let s = 0; s < sec.steps; s++) {
        const expPairs: Array<[number, number]> = [];
        for (const [v, row] of Object.entries(sec.voices)) {
          if (MELODIC.has(v)) continue;
          const tok = row.split(/\s+/)[s];
          if (tok !== undefined && tok !== '~') {
            const m = /@(\d+)/.exec(tok);
            const note = MIDI2_NOTE[v];
            if (note === undefined) { fail(`slot ${st.slot} voice "${v}" has no midi2 note mapping`); continue; }
            expPairs.push([note, m ? Number(m[1]) : 100]);
          }
        }
        expPairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const g = got[s];
        const gotPairs: Array<[number, number]> = (g.notes as any[]).map((x) => [x.note, x.velocity] as [number, number])
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [note, vel] of gotPairs) {
          lo = Math.min(lo, note); hi = Math.max(hi, note);
          if (vel === 120) { n120++; total120++; }
        }
        if (JSON.stringify(gotPairs) !== JSON.stringify(expPairs)) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: pairs ${JSON.stringify(gotPairs)} != ${JSON.stringify(expPairs)}`);
        }
      }
    }
    if (bad === 0) ok(`midi2: exact (note,vel) pairs == staged rows on all ${n} patterns (notes ${lo}..${hi}, ${n120} @120)`);
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
  }

  // internal drums: role union with exact-role-wins-cell, then velocity
  {
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
          if (t === 0) kickCells++;
          const k = `${t}|${i}`;
          const want = roleSteps.get(k);
          if (want === undefined) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: hit not in staged role union`); }
          else if (want !== s.velocity) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: vel ${s.velocity} != expected ${want}`); }
        });
      }
      if (hasDrums && kickCells === 0) fail(`slot ${st.slot} p${p + 1}: drum-bearing pattern has NO internal kick cell (drum1)`);
    }
    if (cells !== expCells) fail(`slot ${st.slot} internal drum cells ${cells} != expected ${expCells}`);
    if (bad === 0) ok(`internal drums: ${cells} cells == role union (kick->1, snare+tom+clap->2, hat+maracas->3, crash->4; exact wins cell)`);
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

// == C. closing-bar / feature spot checks ============================
console.log('\n=== C. spot checks ===');
{
  // crash heads: slot 59 pat1 step 0, slot 60 pat5 step 0 (m43 / m83) on drum4 + midi2 note 61
  for (const [slot, pat, label] of [[59, 0, 'm43'], [60, 4, 'm83']] as const) {
    const buf = bj.get(slot)!;
    const d4 = decodeDrumPattern(buf, 3, pat);
    if (d4[0]?.active === true) ok(`slot ${slot} pat${pat + 1}: crash head ${label} on drum4 step 0`);
    else fail(`slot ${slot} pat${pat + 1}: no drum4 crash cell at step 0`);
    const m2 = decodeNotePattern(buf, 'midi2', pat);
    if ((m2[0].notes as any[]).some((x) => x.note === 61)) ok(`slot ${slot} pat${pat + 1}: crash note 61 on midi2 step 0`);
    else fail(`slot ${slot} pat${pat + 1}: midi2 step 0 missing note 61`);
  }
}
{
  // the m110 hat accent: slot 62 pat4 drum3 step 30 @120 + midi2 note 54 @120
  const buf = bj.get(62)!;
  const d3 = decodeDrumPattern(buf, 2, 3);
  if (d3[30]?.active === true && d3[30].velocity === 120) ok('slot 62 pat4: m110 hat accent @120 on drum3 step 30');
  else fail(`slot 62 pat4 drum3 step 30: ${JSON.stringify(d3[30])}`);
}
{
  // slot 61: the dropped-tie fallback shape — pat2 step 31 f#5(90) gate 6 sixths
  // untied, pat3 step 0 f#5(90) gate 12 sixths (the re-articulated 16th)
  const buf = bj.get(61)!;
  const p2 = decodeNotePattern(buf, 'midi1', 1);
  const p3 = decodeNotePattern(buf, 'midi1', 2);
  const a = (p2[31].notes as any[])[0]; const b = (p3[0].notes as any[])[0];
  if (a?.note === 78 && a.tie !== true && a.gate === 6 && b?.note === 78 && b.gate === 12)
    ok('slot 61: m94 tie chain stored as the DOCUMENTED FALLBACK (tie dropped by the writer, gate kept: f#5 1-step @p2s31 + f#5 2-step @p3s0 re-articulation)');
  else fail(`slot 61 tie fallback shape: p2s31=${JSON.stringify(a)} p3s0=${JSON.stringify(b)}`);
}
{
  // outro vamp identity: slot 64 synth1 pattern images of plays 1,2,5 identical; 3,4,6,7 identical
  const buf = bj.get(64)!;
  const img = (p: number): string => JSON.stringify(decodeNotePattern(buf, 'synth1', p));
  const g1 = [0, 1, 4].map(img); const g2 = [2, 3, 5, 6].map(img);
  if (new Set(g1).size === 1 && new Set(g2).size === 1) ok('slot 64: (j k) strings vamp identical across plays within each stored group (whole-cycle wrap)');
  else fail('slot 64 outro strings differ across plays');
}
if (tieExceptionSeen === 1) ok('tie exception consumed exactly once (slot 61 midi1 p2 s31)');
else fail(`tie exception consumed ${tieExceptionSeen} times != 1`);
if (total120 === 13) ok(`the 13 stored @120 accents all present on the midi2 leg (12 toms + m110 hat)`);
else fail(`midi2 @120 total ${total120} != 13`);

console.log(`\n${failures === 0 ? 'ALL VERIFICATION CHECKS PASS' : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
