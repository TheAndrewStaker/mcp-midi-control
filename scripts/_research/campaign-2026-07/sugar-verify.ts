/**
 * Sugar post-write verification (read-only, disk only; device captures from
 * the Phase-4 backup sweeps). Run: npx tsx samples/_scratch/sugar-verify.ts
 *
 * The Brain Stew slot-36 discipline: READ-BACK IS LOAD-BEARING, acks do not
 * count. Asserts (plan §4 step 12 + the task's discipline line):
 *  A. Neighbour identity: pack5 slots 9+12 (Amber) == amber-authored-2026-07-29
 *     (the post-levels-universal canonical: the 07-30 levels fix touched PACK 2
 *     only, so the amber-authored image IS the levels-universal-era state);
 *     slot 14 (CaughtGlim) + slot 39 (Breakdown) + slot 57 (Offering, the
 *     delete-side neighbour) == card-backup-2026-07-29/pack5. Nothing moved.
 *  B. Slots 46-53: names @0x10; colour 6 (Khaki) @0x0c; tempo 122 @0x34;
 *     swing 50; scale 0/15 Chromatic; synth levels 0/0 @0x2701c/d; drum
 *     levels 0 x4; length bytes 31 (32 steps) on every authored pattern;
 *     layout: plain chains [0,7] on 47-52 (0x2c1==0), scene tables on 46/53
 *     (0x2c1==1, scene0=[0,3], scene1=[0,7]/[0,5] on every union track,
 *     plain chains cleared) — DECODED PLAY SEQUENCE == §1's 4+4+4 / 4+4+2
 *     equivalents; FULL per-step decode == staged rows on every union track
 *     (pitch+gate+tie+vel on synth1/synth2/midi1; per-hit (note,vel) pairs on
 *     midi2); tracks outside each union decode EMPTY; P2/P4 duplicated
 *     patterns byte-consistent (pattern 4+i == pattern i content).
 *  C. STOP-SHIP sweep: zero stored note-51 and zero stored note-68 anywhere
 *     on midi2 across all 8; note set within {48,50,54,57,58,61,63}.
 *  D. Realized harp total == 1176 (decoded cells x the §0d multiplicities,
 *     incl. the m121-128 P1 re-stomp) — the 1176/1176 identity bar.
 *  E. §3 tail assertions from the DECODED bytes: the restored m25-26 head,
 *     the chorus close figure, P5 m88 / P6 m104 / P7 m120 (pad f#5 gate 96),
 *     the P8 drone patterns (8 chords {51,63,75} gate 24, never seven).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneNoteChain } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const NEW_DIR = `${ROOT}/samples/circuit-ncs/sugar-authored-2026-07-30`;
const NB_DIR = `${ROOT}/samples/circuit-ncs/sugar-neighbour-2026-07-30`;
const ORACLE = `${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack5`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/sugar-staged.json`, 'utf8')) as Array<{
  slot: number; project_name: string; layout: string; order: string[];
  sections: Array<{ name: string; steps: number; voices: Record<string, string> }>;
}>;

const loadDir = (dir: string): Map<number, Buffer> => {
  const m = new Map<number, Buffer>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ncs'))) {
    const mm = /(?:project|slot)(\d+)/.exec(f);
    if (mm) m.set(Number(mm[1]), readFileSync(join(dir, f)));
  }
  return m;
};
const authored = loadDir(NEW_DIR);
const nb = loadDir(NB_DIR);

let failures = 0;
let asserts = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);
const info = (msg: string): void => console.log(`info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const check = (cond: boolean, okMsg: string, failMsg: string): void => {
  asserts++;
  if (cond) ok(okMsg); else fail(failMsg);
};

// == A. neighbour identity ============================================
console.log('=== A. neighbour identity ===');
const byteIdent = (label: string, a: Buffer | undefined, b: Buffer | undefined): void => {
  asserts++;
  if (!a || !b) { fail(`${label}: missing capture (a=${!!a} b=${!!b})`); return; }
  if (a.equals(b)) { ok(`${label} byte-identical (${a.length} bytes)`); return; }
  let first = -1; let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
  fail(`${label} DIFFERS: ${n} bytes, first at 0x${first.toString(16)}`);
};
const amber = loadDir(`${ROOT}/samples/circuit-ncs/amber-authored-2026-07-29`);
byteIdent('pack5 slot 9 (Amber 01) vs amber-authored-2026-07-29 (levels-universal-era canonical; the 07-30 fix touched pack2 only)', nb.get(9), amber.get(9));
byteIdent('pack5 slot 12 (Amber 04) vs amber-authored-2026-07-29', nb.get(12), amber.get(12));
byteIdent('pack5 slot 14 (CaughtGlim) vs card-backup-2026-07-29', nb.get(14), readFileSync(`${ORACLE}/proj14__13_SESSION.ncs`) as Buffer);
byteIdent('pack5 slot 39 (Breakdown P5) vs card-backup-2026-07-29', nb.get(39), readFileSync(`${ORACLE}/proj39__38_SESSION.ncs`) as Buffer);
byteIdent('pack5 slot 57 (Offering 1/7, delete-side neighbour) vs card-backup-2026-07-29', nb.get(57), readFileSync(`${ORACLE}/proj57__56_SESSION.ncs`) as Buffer);

// == helpers ==========================================================
const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const CHAIN_BASE = 0x2c4;
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };
const KIT_VOICES = Object.keys(GM12);
const chainOf = (buf: Buffer, idx: number): [number, number] => [buf[CHAIN_BASE + idx * 4], buf[CHAIN_BASE + idx * 4 + 1]];
const midiName = (n: number): string => {
  const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  return NAMES[n % 12] + (Math.floor(n / 12) - 1);
};

interface ExpNote { notes: number[]; gateSixths?: number; tie: boolean; velocity: number }
const expectedRow = (row: string, steps: number): (ExpNote | undefined)[] => {
  const parsed = parseVoice(row, steps) as Array<{
    on?: boolean; notes?: number | number[]; gate_sixths?: number; tie?: boolean; velocity?: number;
  }>;
  return parsed.map((s) => {
    if (s.on !== true) return undefined;
    const notes = Array.isArray(s.notes) ? [...s.notes].sort((a, b) => a - b) : (s.notes !== undefined ? [s.notes] : []);
    return {
      notes,
      ...(s.gate_sixths !== undefined ? { gateSixths: s.gate_sixths } : {}),
      tie: s.tie === true,
      velocity: s.velocity ?? 100,
    };
  });
};
const rowHits = (row: string): Array<number | undefined> =>
  row.trim().split(/\s+/).map((tok) => {
    if (tok === '~') return undefined;
    const m = /@(\d+)/.exec(tok);
    return m ? Number(m[1]) : 100;
  });

// Per-slot pattern->section mapping + in-project play multiplicity:
//  chain slots: pattern p holds section order[p], each plays once.
//  scene slots (46/53): pattern p holds sections[p]; scenes [0-3]+[0-7|0-5]
//  play patterns 0-3 twice, the rest once. Full-song multiplicity adds the
//  m121-128 re-stomp: P1 patterns 0-3 x3.
interface SlotShape { patterns: number; secOfPattern: (p: number) => { name: string; steps: number; voices: Record<string, string> }; inProjMult: (p: number) => number; songMult: (p: number) => number }
const shapeOf = (st: (typeof STAGED)[number]): SlotShape => {
  const secByName = new Map(st.sections.map((s) => [s.name, s]));
  if (st.layout === 'chain') {
    return {
      patterns: st.order.length,
      secOfPattern: (p) => secByName.get(st.order[p])!,
      inProjMult: () => 1,
      songMult: () => 1,
    };
  }
  return {
    patterns: st.sections.length,
    secOfPattern: (p) => st.sections[p],
    inProjMult: (p) => (p <= 3 ? 2 : 1),
    songMult: (p) => (st.slot === 46 ? (p <= 3 ? 3 : 1) : (p <= 3 ? 2 : 1)),
  };
};

let harpRealized = 0;
let stray5168 = 0;
const strayNotes = new Set<number>();
let stored50 = 0;

console.log('\n=== B. slots 46-53: header, layout, full content ===');
for (const st of STAGED) {
  const buf = authored.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const shape = shapeOf(st);
  const n = shape.patterns;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns, ${st.layout}) --`);
  const name = getProjectName(buf as unknown as Uint8Array);
  check(name === st.project_name, `name "${name}"`, `slot ${st.slot} name "${name}" != "${st.project_name}"`);
  check(buf[0x0c] === 6, 'colour 6 (Khaki)', `slot ${st.slot} colour ${buf[0x0c]} != 6`);
  check(buf[0x34] === 122, 'tempo 122', `slot ${st.slot} tempo ${buf[0x34]} != 122`);
  const swing = getProjectSwing(buf as unknown as Uint8Array);
  check(swing === 50, 'swing 50', `slot ${st.slot} swing ${swing} != 50`);
  check(buf[0x26d0c] === 0 && buf[0x26d0d] === 15, 'scale 0/15 Chromatic',
    `slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  check(buf[0x2701c] === 0 && buf[0x2701d] === 0, 'synth levels 0/0 (stored-silent, the song\'s own rule)',
    `slot ${st.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  check(dl.every((x) => x === 0), 'drum levels 0 x4', `slot ${st.slot} drum levels [${dl}]`);

  // union tracks
  const union: NoteTrack[] = [];
  for (const t of ['synth1', 'synth2', 'midi1'] as NoteTrack[]) {
    if (st.sections.some((s) => s.voices[t] !== undefined)) union.push(t);
  }
  const hasKit = st.sections.some((s) => Object.keys(s.voices).some((v) => KIT_VOICES.includes(v)));
  if (hasKit) union.push('midi2');

  // layout
  if (st.layout === 'chain') {
    check(buf[0x2c1] === 0, 'scene end byte 0 (plain chain)', `slot ${st.slot} scene end byte ${buf[0x2c1]}`);
    for (const t of union) {
      const c = chainOf(buf, NOTE_CHAIN_IDX[t]);
      check(eq(c, [0, n - 1]), `${t} chain [${c}]`, `slot ${st.slot} ${t} chain [${c}] != [0,${n - 1}]`);
    }
  } else {
    const lastPat = n - 1;
    check(buf[0x2c1] === 1, 'scene chain end byte 1 (2 scene steps)', `slot ${st.slot} scene end byte ${buf[0x2c1]} != 1`);
    for (const t of union) {
      const s0 = getSceneNoteChain(buf as unknown as Uint8Array, 0, t);
      const s1 = getSceneNoteChain(buf as unknown as Uint8Array, 1, t);
      check(eq(s0, { start: 0, end: 3 }) && eq(s1, { start: 0, end: lastPat }),
        `${t} scenes [0-3]+[0-${lastPat}] (play sequence ${st.slot === 46 ? '4+8 == §1 4+4+4' : '4+6 == §1 4+4+2'})`,
        `slot ${st.slot} ${t} scenes ${JSON.stringify([s0, s1])}`);
      const c = chainOf(buf, NOTE_CHAIN_IDX[t]);
      check(eq(c, [0, 0]), `${t} plain chain cleared [0,0]`, `slot ${st.slot} ${t} plain chain [${c}] not cleared`);
    }
  }
  // length bytes 31 on every authored pattern of every union track
  {
    let bad = 0;
    for (const t of union) for (let p = 0; p < n; p++) {
      if (buf[META_OFFSETS[noteBlockIndex(t, p)]] !== 31) bad++;
    }
    check(bad === 0, 'length bytes 31 (32 steps) on every authored pattern', `slot ${st.slot}: ${bad} length bytes != 31`);
  }

  // full per-step decode == staged rows
  for (const t of union.filter((x) => MELODIC.has(x))) {
    let bad = 0;
    for (let p = 0; p < n; p++) {
      const sec = shape.secOfPattern(p);
      const row = sec.voices[t];
      const exp = row !== undefined ? expectedRow(row, sec.steps) : Array<ExpNote | undefined>(sec.steps).fill(undefined);
      const got = decodeNotePattern(buf as unknown as Uint8Array, t, p) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; tie: boolean; velocity: number }> }>;
      for (let s = 0; s < sec.steps; s++) {
        asserts++;
        const e = exp[s]; const g = got[s];
        const key = `${st.slot}/${t}/p${p + 1}/s${s}`;
        if (e === undefined) {
          if (g.active) { bad++; if (bad < 5) fail(`${key}: unexpected onset [${g.notes.map((x) => midiName(x.note))}]`); }
          continue;
        }
        if (!g.active) { bad++; if (bad < 5) fail(`${key}: MISSING onset ${e.notes.map(midiName)}`); continue; }
        const gp = g.notes.map((x) => x.note).sort((a, b) => a - b);
        if (!eq(gp, e.notes)) { bad++; if (bad < 5) fail(`${key}: pitches [${gp.map(midiName)}] != [${e.notes.map(midiName)}]`); continue; }
        for (const sn of g.notes) {
          if (e.gateSixths !== undefined && sn.gate !== e.gateSixths) { bad++; if (bad < 5) fail(`${key}: gate ${sn.gate} != ${e.gateSixths}`); }
          if (sn.tie !== e.tie) { bad++; if (bad < 5) fail(`${key}: tie ${sn.tie} != ${e.tie}`); }
          if (sn.velocity !== e.velocity) { bad++; if (bad < 5) fail(`${key}: vel ${sn.velocity} != ${e.velocity}`); }
        }
        if (t === 'midi1') harpRealized += gp.length * shape.songMult(p);
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows (pitch+gate+tie+vel exact)`);
    else fail(`slot ${st.slot} ${t}: ${bad} step mismatches`);
  }
  // midi2: per-hit (note, vel) pairs + the stop-ship note sweep
  if (union.includes('midi2')) {
    let bad = 0;
    for (let p = 0; p < n; p++) {
      const sec = shape.secOfPattern(p);
      const got = decodeNotePattern(buf as unknown as Uint8Array, 'midi2', p) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
      for (let s = 0; s < sec.steps; s++) {
        asserts++;
        const expPairs: Array<[number, number]> = [];
        for (const [v, row] of Object.entries(sec.voices)) {
          if (MELODIC.has(v)) continue;
          const vel = rowHits(row)[s];
          if (vel !== undefined) expPairs.push([GM12[v], vel]);
        }
        expPairs.sort((a, b) => a[0] - b[0]);
        const gotPairs: Array<[number, number]> = (got[s]?.notes ?? []).map((x) => [x.note, x.velocity] as [number, number]).sort((a, b) => a[0] - b[0]);
        for (const [nt] of gotPairs) {
          if (nt === 51 || nt === 68) stray5168++;
          if (!Object.values(GM12).includes(nt)) strayNotes.add(nt);
          if (nt === 50) stored50++;
        }
        if (!eq(gotPairs, expPairs)) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: pairs ${JSON.stringify(gotPairs)} != ${JSON.stringify(expPairs)}`);
        }
      }
    }
    if (bad === 0) ok('midi2: per-hit (note,vel) pairs == staged folded rows (clap on the snare pad throughout)');
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
  }
  // tracks OUTSIDE the union decode empty; internal drums always empty
  {
    let stray = 0;
    for (const t of NOTE_TRACKS.filter((x) => !union.includes(x))) {
      for (let p = 0; p < 8; p++) {
        (decodeNotePattern(buf as unknown as Uint8Array, t, p) as Array<{ active: boolean }>).forEach((s) => { if (s.active) stray++; });
      }
    }
    let drumHits = 0;
    for (let d = 0; d < 4; d++) for (let p = 0; p < 8; p++) {
      (decodeDrumPattern(buf as unknown as Uint8Array, d, p) as Array<{ active?: boolean }>).forEach((s) => { if (s.active === true) drumHits++; });
    }
    check(stray === 0, `non-union note tracks empty (${NOTE_TRACKS.filter((x) => !union.includes(x)).join(',') || 'none'})`,
      `slot ${st.slot}: ${stray} active steps on non-union tracks`);
    check(drumHits === 0, 'internal drum tracks empty (no condense, §0f)', `slot ${st.slot}: ${drumHits} internal drum hits`);
  }
  // P2/P4 duplicated-pattern identity (patterns 5-8 == 1-4, chain-stored twice)
  if (st.slot === 47 || st.slot === 49) {
    let diff = 0;
    for (let p = 0; p < 4; p++) {
      for (const t of union) {
        if (!eq(decodeNotePattern(buf as unknown as Uint8Array, t, p), decodeNotePattern(buf as unknown as Uint8Array, t, p + 4))) diff++;
      }
    }
    check(diff === 0, 'patterns 5-8 byte-decode identical to 1-4 (the [Stmt x2] chain)', `slot ${st.slot}: ${diff} pattern pairs differ`);
  }
}

// == C. stop-ship sweep ==============================================
console.log('\n=== C. stop-ship sweep ===');
check(stray5168 === 0, 'ZERO stored note-51 and ZERO stored note-68 anywhere on the SPD-SX leg (all 8 slots, every pattern) — the china/crash fix CARRIED',
  `${stray5168} stored 51/68 hits found — STOP-SHIP`);
check(strayNotes.size === 0, 'midi2 note set within {48,50,54,57,58,61,63} (GM+12, kit-40 pads)',
  `stray midi2 notes [${[...strayNotes]}]`);
info(`stored note-50 cells across the 8 new projects: ${stored50} (snare+clap on the snare pad; the oracle's 116 timeline cells reconciled at staging: 110 reproduced + the old build's 6 misassembled-bar cells corrected to source + the 2 restored m25-26 claps)`);

// == D. realized harp total ==========================================
console.log('\n=== D. realized harp total ===');
check(harpRealized === 1176, 'realized harp total 1176/1176 (decoded cells x §0d multiplicities incl. the P1 outro re-stomp) — the identity part',
  `realized harp total ${harpRealized} != 1176`);

// == E. §3 tail assertions from decoded bytes ========================
console.log('\n=== E. §3 tail assertions (decoded) ===');
const notesAt = (buf: Buffer, t: NoteTrack, p: number, s: number): Array<{ note: number; gate: number; velocity: number }> =>
  ((decodeNotePattern(buf as unknown as Uint8Array, t, p) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; velocity: number }> }>)[s]?.notes ?? []);
{
  const b46 = authored.get(46)!;
  // P1 pattern 8 (m23-24): pad half pair at steps 16/24 (bar m24)
  const s16 = notesAt(b46, 'synth2', 7, 16).map((x) => x.note).sort((a, b) => a - b);
  const s24 = notesAt(b46, 'synth2', 7, 24).map((x) => x.note).sort((a, b) => a - b);
  check(eq(s16, [55, 67]) && eq(s24, [54, 66]), 'P1 m24: pad half pair 55+67 -> 54+66 decoded', `P1 m24 pad ${JSON.stringify([s16, s24])}`);
}
{
  const b47 = authored.get(47)!;
  const m25kick = notesAt(b47, 'midi2', 0, 0);
  const m25clap = notesAt(b47, 'midi2', 0, 8);
  const m26clap = notesAt(b47, 'midi2', 0, 24);
  check(eq(m25kick.map((x) => x.note), [48]) && eq(m25clap.map((x) => x.note), [50]) && eq(m26clap.map((x) => x.note), [50]),
    'P2 head: the RESTORED m25 kick@0 + clap@2 and m26 clap@2, claps stored 50 (row 18)',
    `P2 head decode ${JSON.stringify([m25kick, m25clap, m26clap])}`);
  // close figure in pattern 4 (m31-32), bar 2 = steps 16-31
  const close = [2, 6, 8, 10, 12, 15].map((s) => notesAt(b47, 'midi2', 3, 16 + s).map((x) => x.note));
  check(eq(close, [[50], [48], [50], [48], [48], [48]]),
    'P2 m32 close figure: clap50@0.5 kick@1.5 clap50@2 kick@2.5 kick@3 kick@3.75', `P2 m32 close ${JSON.stringify(close)}`);
}
{
  const b50 = authored.get(50)!;
  // P5 m88 (pattern 8, bar 2): ghost hat v40 at step 12, kicks 7/8/10
  const hat = notesAt(b50, 'midi2', 7, 16 + 12).find((x) => x.note === 54);
  const kicks = [7, 8, 10].every((s) => notesAt(b50, 'midi2', 7, 16 + s).some((x) => x.note === 48));
  check(hat !== undefined && hat.velocity === 40 && kicks,
    'P5 m88: kit-only close decoded (ghost hat v40 + the snapped 32nd kick pair)', `P5 m88 hat ${JSON.stringify(hat)} kicks ${kicks}`);
}
{
  const b52 = authored.get(52)!;
  // P7 m120 (pattern 8 bar 2): pad f#5 (78) gate 96 at step 16; crash+kick+snare present
  const pad = notesAt(b52, 'synth2', 7, 16);
  check(eq(pad.map((x) => [x.note, x.gate]), [[78, 96]]), 'P7 m120: pad f#5 whole note (gate 96) decoded', `P7 m120 pad ${JSON.stringify(pad)}`);
  const bar = [...Array(16).keys()].flatMap((s) => notesAt(b52, 'midi2', 7, 16 + s).map((x) => x.note));
  check(bar.includes(61) && bar.includes(48) && bar.includes(50), 'P7 m120: final drum bar carries crash/kick/snare', `P7 m120 notes [${bar}]`);
}
{
  const b53 = authored.get(53)!;
  // P8: every pattern's pad = 8 chords {51,63,75} gate 24 at steps 0,4,...,28; patterns 5-6 harp empty
  let badDrone = 0;
  for (let p = 0; p < 6; p++) {
    for (const s of [0, 4, 8, 12, 16, 20, 24, 28]) {
      const ns = notesAt(b53, 'synth2', p, s);
      if (!eq(ns.map((x) => [x.note, x.gate]).sort((a, b) => (a[0] as number) - (b[0] as number)), [[51, 24], [63, 24], [75, 24]])) badDrone++;
    }
    const others = [...Array(32).keys()].filter((s) => s % 4 !== 0);
    for (const s of others) if (notesAt(b53, 'synth2', p, s).length > 0) badDrone++;
  }
  check(badDrone === 0, 'P8: all 6 patterns carry the 8-chord drone {51,63,75} gate 24 on the quarters — never seven (row 8)', `P8 drone: ${badDrone} bad cells`);
  let tailHarp = 0;
  for (const p of [4, 5]) (decodeNotePattern(b53 as unknown as Uint8Array, 'midi1', p) as Array<{ active: boolean }>).forEach((s) => { if (s.active) tailHarp++; });
  check(tailHarp === 0, 'P8 tail patterns 5-6: harp EMPTY (drone alone; the song ends itself)', `P8 tail harp ${tailHarp} onsets`);
}

console.log(`\n${failures === 0 ? `ALL VERIFICATION CHECKS PASS (${asserts} tracked asserts)` : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
