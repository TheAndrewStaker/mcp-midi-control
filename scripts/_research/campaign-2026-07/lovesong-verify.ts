/**
 * Love Song post-write verification (read-only, disk only; device captures
 * from the Phase-4 backup sweeps). Run:
 *   npx tsx samples/_scratch/lovesong-verify.ts
 *
 * Asserts (plan §4 step 11, the Brain Stew slot-36 discipline — read-back is
 * load-bearing, acks do not count):
 *  A. Neighbour identity: pack4 strays 1-2 byte-identical to the 07-29 card
 *     backup; pack4 slot 21 (Smooth 13 Outro3) == smooth-authored-2026-07-30;
 *     pack2 slot 57 (Billie Jean) == smooth-pack2-neighbour-2026-07-30
 *     (cross-PACK identity: pack addressing hit Pack 4 slots 25-29 only).
 *  B. Slots 25-29: names @0x10; colour 9 (Teal) @0x0c; tempo 69 @0x34; swing
 *     50; scale 0/15 Chromatic; synth levels 0/0 @0x2701c/d (stored-silent
 *     universal); drum levels 0 x4; binding [1,2,5,11] @0x1a278; scene end
 *     byte 0; chains [0,plays-1]; length bytes 31 except slot 25 pat1 = 7
 *     and slots 27/29 last = 15; FULL per-step decode == staged rows
 *     (synth2 pitch+gate+tie+vel; midi2 per-step (note,vel) pairs + the
 *     GM+12 note set {48,50,54,57,58,61,63}; internal drums == the condense
 *     role-union with fold distance -> velocity -> name contention); letter
 *     census == staged order (dedupe duplicates stored as identical patterns).
 *  C. Tail spot checks (§3): the m1 8-step pickup (ghost@40 -> backbeat
 *     snare+timbale), the m36 kick/ride@112 turnaround, the V3 dropout
 *     (m45 crash ring / m46-47 kit-silent with the t5 vamp continuing / m48
 *     drag re-entry), the m52 openhat closer, the m60 crash+kick stop hit,
 *     and the m61 ALL-REST ring-out pattern.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  META_OFFSETS, noteBlockIndex, drumBlockIndex, getProjectName, getProjectSwing, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { parseVoice } from '../../packages/core/src/protocol-generic/patterns/miniNotation.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const NEW_DIR = `${ROOT}/samples/circuit-ncs/lovesong-authored-2026-07-30`;
const NB4_DIR = `${ROOT}/samples/circuit-ncs/lovesong-neighbour-pack4-2026-07-30`;
const NB2_DIR = `${ROOT}/samples/circuit-ncs/lovesong-neighbour-pack2-2026-07-30`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/lovesong-staged.json`, 'utf8')) as Array<{
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
const authored = loadDir(NEW_DIR);
const nb4 = loadDir(NB4_DIR);
const nb2 = loadDir(NB2_DIR);

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);
const info = (msg: string): void => console.log(`info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
let asserts = 0;
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
byteIdent('pack4 stray slot 1 vs card-backup-2026-07-29', nb4.get(1),
  readFileSync(`${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack4/proj01__00_SESSION.ncs`) as Buffer);
byteIdent('pack4 stray slot 2 vs card-backup-2026-07-29', nb4.get(2),
  readFileSync(`${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack4/proj02__01_SESSION.ncs`) as Buffer);
byteIdent('pack4 slot 21 (Smooth 13 Outro3) vs smooth-authored-2026-07-30', nb4.get(21),
  loadDir(`${ROOT}/samples/circuit-ncs/smooth-authored-2026-07-30`).get(21));
byteIdent('pack2 slot 57 (Billie Jean) vs smooth-pack2-neighbour-2026-07-30 (cross-pack)', nb2.get(57),
  loadDir(`${ROOT}/samples/circuit-ncs/smooth-pack2-neighbour-2026-07-30`).get(57));

// == helpers ==========================================================
const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const CHAIN_BASE = 0x2c4;
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63 };
/** Internal condense: folded voice -> drum track index, and its fold DISTANCE. */
const ROLE_TRACK: Record<string, number> = { kick: 0, snare: 1, tom: 1, hat: 2, openhat: 2, crash: 3, ride: 3 };
const ROLE_DIST: Record<string, number> = { kick: 0, snare: 0, hat: 0, ride: 0, tom: 1, openhat: 1, crash: 1 };
const chainOf = (buf: Buffer, idx: number): [number, number] => [buf[CHAIN_BASE + idx * 4], buf[CHAIN_BASE + idx * 4 + 1]];
const noteLens = (buf: Buffer, t: NoteTrack, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[noteBlockIndex(t, p)]] + 1);
const drumLens = (buf: Buffer, t: number, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1);
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
/** Drum-row hit extraction: `voice@vel` tokens only. */
const rowHits = (row: string): Array<number | undefined> =>
  row.trim().split(/\s+/).map((tok) => {
    if (tok === '~') return undefined;
    const m = /@(\d+)/.exec(tok);
    return m ? Number(m[1]) : 100;
  });

const EXPECT_PLAYS: Record<number, number> = { 25: 5, 26: 6, 27: 8, 28: 8, 29: 5 };
let note57Total = 0;
const note57BySlot = new Map<number, number>();

console.log('\n=== B. slots 25-29: header, chains, lengths, full content ===');
for (const st of STAGED) {
  const buf = authored.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);
  check(n === EXPECT_PLAYS[st.slot], `${n} plays`, `slot ${st.slot}: ${n} plays != ${EXPECT_PLAYS[st.slot]}`);
  const name = getProjectName(buf);
  check(name === st.project_name, `name "${name}"`, `slot ${st.slot} name "${name}" != "${st.project_name}"`);
  check(buf[0x0c] === 9, 'colour 9 (Teal)', `slot ${st.slot} colour ${buf[0x0c]} != 9`);
  check(buf[0x34] === 69, 'tempo 69', `slot ${st.slot} tempo ${buf[0x34]} != 69`);
  const swing = getProjectSwing(buf);
  check(swing === 50, 'swing 50', `slot ${st.slot} swing ${swing} != 50`);
  check(buf[0x26d0c] === 0 && buf[0x26d0d] === 15, 'scale root 0 / type 15 (Chromatic)',
    `slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  check(buf[0x2701c] === 0 && buf[0x2701d] === 0, 'synth levels 0/0 @0x2701c/d (stored-silent universal)',
    `slot ${st.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  check(dl.every((x) => x === 0), 'drum levels 0x4', `slot ${st.slot} drum levels [${dl}] != 0x4`);
  const bind = [0, 1, 2, 3].map((i) => buf[0x1a278 + i]);
  check(eq(bind, [1, 2, 5, 11]), 'binding [1,2,5,11] @0x1a278', `slot ${st.slot} binding [${bind}]`);
  check(buf[0x2c1] === 0, 'scene end byte 0 (plain/loop)', `slot ${st.slot} scene end byte ${buf[0x2c1]}`);

  const secOf = new Map(st.sections.map((s) => [s.name, s]));
  const plays = st.order.map((nm) => secOf.get(nm)!);
  const expectSteps = plays.map((p) => p.steps);
  const ec: [number, number] = [0, n - 1];

  const noteContent: NoteTrack[] = [];
  for (const t of ['synth1', 'synth2', 'midi1'] as NoteTrack[]) {
    if (st.sections.some((s) => s.voices[t] !== undefined)) noteContent.push(t);
  }
  noteContent.push('midi2');
  for (const t of noteContent) {
    const c = chainOf(buf, NOTE_CHAIN_IDX[t]);
    check(eq(c, ec), `${t} chain [${c}]`, `slot ${st.slot} ${t} chain [${c}] != [${ec}]`);
    const lens = noteLens(buf, t, n);
    check(eq(lens, expectSteps), `${t} lens [${lens}]`, `slot ${st.slot} ${t} lens [${lens}] != [${expectSteps}]`);
  }

  // internal-drum expectation: per pattern, per track, the condense winner map
  const expInternal = (sec: { steps: number; voices: Record<string, string> }): Map<string, number> => {
    interface Cand { voice: string; dist: number; vel: number }
    const byCell = new Map<string, Cand[]>();
    for (const [v, row] of Object.entries(sec.voices)) {
      if (MELODIC.has(v)) continue;
      const track = ROLE_TRACK[v];
      if (track === undefined) { fail(`slot ${st.slot}: voice "${v}" has no internal track mapping`); continue; }
      rowHits(row).forEach((vel, s) => {
        if (vel === undefined) return;
        const k = `${track}|${s}`;
        const arr = byCell.get(k) ?? [];
        arr.push({ voice: v, dist: ROLE_DIST[v], vel });
        byCell.set(k, arr);
      });
    }
    const winners = new Map<string, number>();
    for (const [k, arr] of byCell) {
      arr.sort((a, b) => a.dist - b.dist || b.vel - a.vel || a.voice.localeCompare(b.voice));
      winners.set(k, arr[0].vel);
    }
    return winners;
  };

  const drumContent: number[] = [];
  for (let t = 0; t < 4; t++) {
    if ([...Array(n).keys()].some((p) => decodeDrumPattern(buf, t, p).some((s: { active?: boolean }) => s.active === true))) drumContent.push(t);
  }
  for (const t of drumContent) {
    const c = chainOf(buf, 4 + t);
    check(eq(c, ec), `drum${t + 1} chain [${c}]`, `slot ${st.slot} drum${t + 1} chain [${c}] != [${ec}]`);
    const lens = drumLens(buf, t, n);
    check(eq(lens, expectSteps), `drum${t + 1} lens [${lens}]`, `slot ${st.slot} drum${t + 1} lens [${lens}] != [${expectSteps}]`);
  }

  // synth2: per-step decode vs staged rows
  for (const t of noteContent.filter((x) => x !== 'midi2')) {
    let bad = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const row = sec.voices[t];
      const exp = row !== undefined ? expectedRow(row, sec.steps) : Array<ExpNote | undefined>(sec.steps).fill(undefined);
      const got = decodeNotePattern(buf, t, p) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; tie: boolean; velocity: number }> }>;
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
        for (const slotNote of g.notes) {
          if (e.gateSixths !== undefined && slotNote.gate !== e.gateSixths) { bad++; if (bad < 5) fail(`${key}: gate ${slotNote.gate} != ${e.gateSixths} sixths`); }
          if (slotNote.tie !== e.tie) { bad++; if (bad < 5) fail(`${key}: tie ${slotNote.tie} != ${e.tie}`); }
          if (slotNote.velocity !== e.velocity) { bad++; if (bad < 5) fail(`${key}: vel ${slotNote.velocity} != ${e.velocity}`); }
        }
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows (pitch+gate+tie+vel exact)`);
    else fail(`slot ${st.slot} ${t}: ${bad} step mismatches`);
  }

  // midi2: per-step (note, velocity) pairs from the folded rows
  {
    const ALLOWED_NOTES = new Set(Object.values(GM12));
    const strayNotes = new Set<number>();
    let bad = 0; let n57 = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const got = decodeNotePattern(buf, 'midi2', p) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
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
          if (!ALLOWED_NOTES.has(nt)) strayNotes.add(nt);
          if (nt === 57) { n57++; note57Total++; }
        }
        if (!eq(gotPairs, expPairs)) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: pairs ${JSON.stringify(gotPairs)} != ${JSON.stringify(expPairs)}`);
        }
      }
    }
    note57BySlot.set(st.slot, n57);
    if (bad === 0) ok(`midi2: per-step (note,vel) pairs == staged folded rows (all ${n} patterns; ${n57} timbale/tom-pad hits)`);
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
    check(strayNotes.size === 0, 'midi2 notes within the GM+12 set {48,50,54,57,58,61,63}',
      `slot ${st.slot} midi2 stray notes [${[...strayNotes]}]`);
  }

  // internal drums: condense winner map
  {
    let bad = 0; let cellCount = 0; let expCells = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const winners = expInternal(sec);
      expCells += winners.size;
      for (let t = 0; t < 4; t++) {
        (decodeDrumPattern(buf, t, p) as Array<{ active?: boolean; velocity?: number }>).forEach((s, i) => {
          if (i >= sec.steps || s.active !== true) return;
          cellCount++;
          const want = winners.get(`${t}|${i}`);
          if (want === undefined) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: hit not in condense winner map`); }
          else if (want !== s.velocity) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: vel ${s.velocity} != winner ${want}`); }
        });
      }
    }
    check(cellCount === expCells, `internal drums: ${cellCount} cells == condense role-union (kick->1, snare+timbale->2, hat+openhat->3, crash+ride->4)`,
      `slot ${st.slot} internal drum cells ${cellCount} != expected ${expCells}`);
    if (bad > 0) fail(`slot ${st.slot} internal drums: ${bad} cell mismatches`);
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
    check(gotLetters === wantLetters, `letter census == staged order (${gotLetters})`,
      `slot ${st.slot} letter census "${gotLetters}" != "${wantLetters}"`);
  }
}

// == C. tail spot checks (§3) =========================================
console.log('\n=== C. tail spot checks (§3) ===');
{
  // slot 25 pat1 (m1, 8 steps): the pickup — ghost@40 at step 3, backbeat at 4
  const buf = authored.get(25)!;
  check(buf[META_OFFSETS[noteBlockIndex('midi2', 0)]] === 7, 'slot 25 pat1 length byte 7 (8-step pickup bar)',
    `slot 25 pat1 length byte ${buf[META_OFFSETS[noteBlockIndex('midi2', 0)]]} != 7`);
  const got = decodeNotePattern(buf, 'midi2', 0) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
  const s3 = (got[3]?.notes ?? []).map((x) => [x.note, x.velocity]).sort((a, b) => a[0] - b[0]);
  const s4 = (got[4]?.notes ?? []).map((x) => x.note).sort((a, b) => a - b);
  check(eq(s3, [[50, 40]]), 'slot 25 m1 step 3: the drag survives as a single snare ghost@40 (§0b)',
    `slot 25 m1 step 3 ${JSON.stringify(s3)}`);
  check(eq(s4, [48, 50, 54, 57]), 'slot 25 m1 step 4: backbeat kick+snare+hat+TIMBALE(57) — the 311 signature from the first beat',
    `slot 25 m1 step 4 [${s4}]`);
}
{
  // slot 27 pat8 (m36, 16 steps): the kick/ride@112 turnaround
  const buf = authored.get(27)!;
  check(buf[META_OFFSETS[noteBlockIndex('midi2', 7)]] === 15, 'slot 27 pat8 length byte 15 (16-step m36)',
    `slot 27 pat8 length byte ${buf[META_OFFSETS[noteBlockIndex('midi2', 7)]]} != 15`);
  const got = decodeNotePattern(buf, 'midi2', 7) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
  const has112 = got.slice(0, 16).some((s) => (s.notes ?? []).some((x) => (x.note === 48 || x.note === 63) && x.velocity === 112));
  check(has112, 'slot 27 m36: the kick/ride@112 turnaround stored', 'slot 27 m36 @112 turnaround missing');
  check((got[0]?.notes ?? []).some((x) => x.note === 61), 'slot 27 m36: crash at step 0', 'slot 27 m36 crash@0 missing');
}
{
  // slot 28: the V3 dropout (pat5 = m45-46, pat6 = m47-48)
  const buf = authored.get(28)!;
  const p5 = decodeNotePattern(buf, 'midi2', 4) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  const s0 = (p5[0]?.notes ?? []).map((x) => x.note).sort((a, b) => a - b);
  check(eq(s0, [48, 61]), 'slot 28 m45: crash ring (crash 61 + kick 48 at step 0)', `slot 28 m45 step 0 [${s0}]`);
  const restKit = p5.slice(1, 32).reduce((a, s) => a + (s.active ? 1 : 0), 0);
  const p6 = decodeNotePattern(buf, 'midi2', 5) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
  const m47Kit = p6.slice(0, 16).reduce((a, s) => a + (s.active ? 1 : 0), 0);
  check(restKit === 0 && m47Kit === 0, 'slot 28 m45(rest)+m46+m47: drums OUT (kit-silent through the breakdown)',
    `slot 28 dropout kit hits: m45-46 tail ${restKit}, m47 ${m47Kit}`);
  const t5cont = (decodeNotePattern(buf, 'synth2', 4) as Array<{ active: boolean }>).slice(16, 32).some((s) => s.active);
  check(t5cont, 'slot 28 m46: the t5 vamp CONTINUES through the dropout (synth2 sounds while drums rest)', 'slot 28 m46 synth2 empty');
  const s27 = (p6[27]?.notes ?? []).map((x) => [x.note, x.velocity]);
  const s28 = (p6[28]?.notes ?? []).map((x) => x.note).sort((a, b) => a - b);
  check(eq(s27, [[50, 40]]) && s28.includes(50) && s28.includes(57),
    'slot 28 m48: drag re-entry (snare ghost@40 step 27 -> backbeat snare+timbale step 28, the m1 shape)',
    `slot 28 m48 s27 ${JSON.stringify(s27)} s28 [${s28}]`);
  const p8 = decodeNotePattern(buf, 'midi2', 7) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  check(p8.slice(16, 32).some((s) => (s.notes ?? []).some((x) => x.note === 58)),
    'slot 28 m52: openhat verse closer (note 58)', 'slot 28 m52 openhat missing');
}
{
  // slot 29: m60 stop hit + m61 ALL-REST ring-out
  const buf = authored.get(29)!;
  const p4 = decodeNotePattern(buf, 'midi2', 3) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  const s16 = (p4[16]?.notes ?? []).map((x) => x.note).sort((a, b) => a - b);
  check(eq(s16, [48, 61]), 'slot 29 m60: the crash+kick stop hit at step 16 (pattern 4 bar 2)', `slot 29 m60 [${s16}]`);
  const m60rest = p4.slice(17, 32).reduce((a, s) => a + (s.active ? 1 : 0), 0);
  check(m60rest === 0, 'slot 29 m60: nothing after the stop hit', `slot 29 m60 ${m60rest} extra kit hits`);
  check(buf[META_OFFSETS[noteBlockIndex('midi2', 4)]] === 15, 'slot 29 pat5 length byte 15 (the 16-step ring-out)',
    `slot 29 pat5 length byte ${buf[META_OFFSETS[noteBlockIndex('midi2', 4)]]} != 15`);
  let m61 = 0;
  for (const t of NOTE_TRACKS) (decodeNotePattern(buf, t, 4) as Array<{ active: boolean }>).forEach((s, i) => { if (i < 16 && s.active) m61++; });
  for (let t = 0; t < 4; t++) (decodeDrumPattern(buf, t, 4) as Array<{ active?: boolean }>).forEach((s, i) => { if (i < 16 && s.active === true) m61++; });
  check(m61 === 0, 'slot 29 m61: ALL-REST ring-out pattern on every track (the song ends itself)', `slot 29 m61 has ${m61} active steps`);
}
info(`timbale census: midi2 tom-pad (note 57) hits by slot: ${[...note57BySlot.entries()].map(([s, c]) => `${s}:${c}`).join(' ')} (total ${note57Total}) — the DEDICATED pad, no share`);
console.log(`\n${failures === 0 ? `ALL VERIFICATION CHECKS PASS (${asserts} tracked asserts)` : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
