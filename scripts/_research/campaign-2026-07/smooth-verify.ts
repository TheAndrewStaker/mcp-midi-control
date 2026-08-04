/**
 * Smooth + Havana post-write verification (read-only, disk only; device
 * captures from the Phase-4 backup sweeps). Run:
 *   npx tsx samples/_scratch/smooth-verify.ts
 *
 * Asserts (plan §4 step 12, Brain Stew slot-36 discipline):
 *  A. Neighbour identity: pack4 strays 1-2 byte-identical to the 07-29 card
 *     backup; pack2 slot 57 == billiejean-authored-2026-07-30; pack2 slot 25 ==
 *     levels-universal-fix-2026-07-30 (cross-PACK identity: pack addressing hit
 *     Pack 4 only).
 *  B. Slots 9-21: names @0x10; colour 4 (Sand) @0x0c; tempo 116 @0x34; swing
 *     50; scale 0/15 Chromatic; synth levels 0/0 @0x2701c/d (the stored-silent
 *     universal OVERRIDE, supersedes the plan's 0/100); drum levels 0 x4;
 *     binding [1,2,5,11] @0x1a278; scene end byte 0; chains [0,plays-1];
 *     length bytes 31 except P1 pat1 / P7 pat5 = 15; FULL per-step decode ==
 *     staged rows (synth1/synth2/midi1 pitch+gate+tie+vel, cross-pattern
 *     tie-drops classified as the documented fallback and RECORDED; midi2
 *     per-step (note,vel) pairs + the GM+12 note set {48,50,54,57,58,61,63,
 *     68}; internal drums == the condense role-union with fold distance ->
 *     velocity -> name contention); letter census == staged order.
 *  C. Tail spot checks (P1 pickup roll, P2 organ pickup e5+a5@28, P7 m82
 *     triplet snap 8/9/11, P9 @127 stack, P13 crash/close/silent m144) + the
 *     Havana §H TOKEN-EXACT decode + the timbale fold census (midi2 note 57).
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
const NEW_DIR = `${ROOT}/samples/circuit-ncs/smooth-authored-2026-07-30`;
const STRAYS_DIR = `${ROOT}/samples/circuit-ncs/smooth-pack4-strays-2026-07-30`;
const P2NB_DIR = `${ROOT}/samples/circuit-ncs/smooth-pack2-neighbour-2026-07-30`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/smooth-staged.json`, 'utf8')) as Array<{
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
const strays = loadDir(STRAYS_DIR);
const p2nb = loadDir(P2NB_DIR);

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`ok: ${msg}`);
const info = (msg: string): void => console.log(`info: ${msg}`);
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// == A. neighbour identity ============================================
console.log('=== A. neighbour identity ===');
const byteIdent = (label: string, a: Buffer | undefined, b: Buffer | undefined): void => {
  if (!a || !b) { fail(`${label}: missing capture (a=${!!a} b=${!!b})`); return; }
  if (a.equals(b)) { ok(`${label} byte-identical (${a.length} bytes)`); return; }
  let first = -1; let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; }
  fail(`${label} DIFFERS: ${n} bytes, first at 0x${first.toString(16)}`);
};
byteIdent('pack4 stray slot 1 vs card-backup-2026-07-29', strays.get(1),
  readFileSync(`${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack4/proj01__00_SESSION.ncs`) as Buffer);
byteIdent('pack4 stray slot 2 vs card-backup-2026-07-29', strays.get(2),
  readFileSync(`${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack4/proj02__01_SESSION.ncs`) as Buffer);
byteIdent('pack2 slot 57 (Billie Jean) vs billiejean-authored-2026-07-30', p2nb.get(57),
  loadDir(`${ROOT}/samples/circuit-ncs/billiejean-authored-2026-07-30`).get(57));
byteIdent('pack2 slot 25 (Redbone) vs levels-universal-fix-2026-07-30', p2nb.get(25),
  loadDir(`${ROOT}/samples/circuit-ncs/levels-universal-fix-2026-07-30`).get(25));

// == helpers ==========================================================
const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const CHAIN_BASE = 0x2c4;
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61, ride: 63, perc: 68 };
/** Internal condense: folded voice -> drum track, and its fold DISTANCE (BFS depth). */
const ROLE_TRACK: Record<string, number> = { kick: 0, snare: 1, tom: 1, hat: 2, openhat: 2, perc: 2, crash: 3, ride: 3 };
const ROLE_DIST: Record<string, number> = { kick: 0, snare: 0, hat: 0, ride: 0, tom: 1, openhat: 1, crash: 1, perc: 1 };
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

const EXPECT_PLAYS: Record<number, number> = { 9: 5, 10: 8, 11: 5, 12: 6, 13: 8, 14: 5, 15: 5, 16: 8, 17: 5, 18: 1, 19: 6, 20: 6, 21: 6 };
let tieFallbacks: string[] = [];
let note57Total = 0; let note68Total = 0;
const note57BySlot = new Map<number, number>();

console.log('\n=== B. slots 9-21: header, chains, lengths, full content ===');
for (const st of STAGED) {
  const buf = authored.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);
  if (n !== EXPECT_PLAYS[st.slot]) fail(`slot ${st.slot}: ${n} plays != ${EXPECT_PLAYS[st.slot]}`);
  const name = getProjectName(buf);
  if (name === st.project_name) ok(`name "${name}"`); else fail(`slot ${st.slot} name "${name}" != "${st.project_name}"`);
  if (buf[0x0c] === 4) ok('colour 4 (Sand)'); else fail(`slot ${st.slot} colour ${buf[0x0c]} != 4`);
  if (buf[0x34] === 116) ok('tempo 116'); else fail(`slot ${st.slot} tempo ${buf[0x34]} != 116`);
  const swing = getProjectSwing(buf);
  if (swing === 50) ok('swing 50'); else fail(`slot ${st.slot} swing ${swing} != 50`);
  if (buf[0x26d0c] === 0 && buf[0x26d0d] === 15) ok('scale root 0 / type 15 (Chromatic)');
  else fail(`slot ${st.slot} scale ${buf[0x26d0c]}/${buf[0x26d0d]} != 0/15`);
  if (buf[0x2701c] === 0 && buf[0x2701d] === 0) ok('synth levels 0/0 @0x2701c/d (stored-silent universal)');
  else fail(`slot ${st.slot} synth levels ${buf[0x2701c]}/${buf[0x2701d]} != 0/0`);
  const dl = [0, 1, 2, 3].map((t) => buf[0x26fbd + t * 11]);
  if (dl.every((x) => x === 0)) ok('drum levels 0x4'); else fail(`slot ${st.slot} drum levels [${dl}] != 0x4`);
  const bind = [0, 1, 2, 3].map((i) => buf[0x1a278 + i]);
  if (eq(bind, [1, 2, 5, 11])) ok('binding [1,2,5,11] @0x1a278');
  else fail(`slot ${st.slot} binding [${bind}] != [1,2,5,11]`);
  if (buf[0x2c1] === 0) ok('scene end byte 0 (plain/loop)'); else fail(`slot ${st.slot} scene end byte ${buf[0x2c1]}`);

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
    if (eq(c, ec)) ok(`${t} chain [${c}]`); else fail(`slot ${st.slot} ${t} chain [${c}] != [${ec}]`);
    const lens = noteLens(buf, t, n);
    if (eq(lens, expectSteps)) ok(`${t} lens [${lens}]`);
    else fail(`slot ${st.slot} ${t} lens [${lens}] != [${expectSteps}]`);
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
    if (eq(c, ec)) ok(`drum${t + 1} chain [${c}]`); else fail(`slot ${st.slot} drum${t + 1} chain [${c}] != [${ec}]`);
    const lens = drumLens(buf, t, n);
    if (eq(lens, expectSteps)) ok(`drum${t + 1} lens [${lens}]`);
    else fail(`slot ${st.slot} drum${t + 1} lens [${lens}] != [${expectSteps}]`);
  }

  // melodic tracks: per-step decode vs staged rows (tie-drop fallback recorded)
  for (const t of noteContent.filter((x) => x !== 'midi2')) {
    let bad = 0; let fallbacks = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const row = sec.voices[t];
      const exp = row !== undefined ? expectedRow(row, sec.steps) : Array<ExpNote | undefined>(sec.steps).fill(undefined);
      const got = decodeNotePattern(buf, t, p) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; tie: boolean; velocity: number }> }>;
      for (let s = 0; s < sec.steps; s++) {
        const e = exp[s]; const g = got[s];
        const key = `${st.slot}/${t}/p${p + 1}/s${s}`;
        if (e === undefined) {
          if (g.active) { bad++; if (bad < 5) fail(`${key}: unexpected onset [${g.notes.map((x) => midiName(x.note))}]`); }
          continue;
        }
        if (!g.active) { bad++; if (bad < 5) fail(`${key}: MISSING onset ${e.notes.map(midiName)}`); continue; }
        const gp = g.notes.map((x) => x.note).sort((a, b) => a - b);
        if (!eq(gp, e.notes)) { bad++; if (bad < 5) fail(`${key}: pitches [${gp.map(midiName)}] != [${e.notes.map(midiName)}]`); continue; }
        let tieDropSeen = false;
        for (const slotNote of g.notes) {
          if (e.gateSixths !== undefined && slotNote.gate !== e.gateSixths) { bad++; if (bad < 5) fail(`${key}: gate ${slotNote.gate} != ${e.gateSixths} sixths`); }
          if (slotNote.tie !== e.tie) {
            if (e.tie && !slotNote.tie) { tieDropSeen = true; }
            else { bad++; if (bad < 5) fail(`${key}: tie ${slotNote.tie} != ${e.tie}`); }
          }
          if (slotNote.velocity !== e.velocity) { bad++; if (bad < 5) fail(`${key}: vel ${slotNote.velocity} != ${e.velocity}`); }
        }
        if (tieDropSeen) {
          fallbacks++;
          tieFallbacks.push(`${key}: tie dropped by the writer (gate kept ${e.gateSixths ?? '?'} sixths) - the documented one-16th re-articulation fallback`);
        }
      }
    }
    if (bad === 0) ok(`${t}: all ${n} patterns decode == staged rows (pitch+gate+vel${fallbacks > 0 ? `; ${fallbacks} tie-drop fallback step(s), recorded` : '; ties exact'})`);
    else fail(`slot ${st.slot} ${t}: ${bad} step mismatches`);
  }

  // midi2: per-step (note, velocity) pairs from the folded union rows
  {
    const ALLOWED_NOTES = new Set(Object.values(GM12));
    const strayNotes = new Set<number>();
    let bad = 0; let n57 = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const got = decodeNotePattern(buf, 'midi2', p) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
      for (let s = 0; s < sec.steps; s++) {
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
          if (nt === 68) note68Total++;
        }
        if (!eq(gotPairs, expPairs)) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: pairs ${JSON.stringify(gotPairs)} != ${JSON.stringify(expPairs)}`);
        }
      }
    }
    note57BySlot.set(st.slot, n57);
    if (bad === 0) ok(`midi2: per-step (note,vel) pairs == staged folded rows (all ${n} patterns; ${n57} tom-pad hits)`);
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
    if (strayNotes.size === 0) ok('midi2 notes within the GM+12 set {48,50,54,57,58,61,63,68}');
    else fail(`slot ${st.slot} midi2 stray notes [${[...strayNotes]}]`);
  }

  // internal drums: condense winner map
  {
    let bad = 0; let cells = 0; let expCells = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const winners = expInternal(sec);
      expCells += winners.size;
      for (let t = 0; t < 4; t++) {
        (decodeDrumPattern(buf, t, p) as Array<{ active?: boolean; velocity?: number }>).forEach((s, i) => {
          if (i >= sec.steps || s.active !== true) return;
          cells++;
          const want = winners.get(`${t}|${i}`);
          if (want === undefined) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: hit not in condense winner map`); }
          else if (want !== s.velocity) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: vel ${s.velocity} != winner ${want}`); }
        });
      }
    }
    if (cells !== expCells) fail(`slot ${st.slot} internal drum cells ${cells} != expected ${expCells}`);
    if (bad === 0) ok(`internal drums: ${cells} cells == condense role-union (kick->1, snare+tom->2, hat+openhat+perc->3, crash+ride->4; distance->velocity->name)`);
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

// == C. tail spot checks + Havana token-exact =========================
console.log('\n=== C. tail spot checks + Havana ===');
{
  // P1 pat1 (m1, 16 steps): the pickup roll on midi2 (tom 57 + snare 50 at step 0)
  const buf = authored.get(9)!;
  const got = decodeNotePattern(buf, 'midi2', 0) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  const s0 = (got[0]?.notes ?? []).map((x) => x.note).sort((a, b) => a - b);
  if (eq(s0, [50, 57])) ok('P1 pat1 step 0: the tom+snare pickup roll opens the song (midi2 notes 50+57)');
  else fail(`P1 pat1 step 0 notes [${s0}] != [50,57]`);
  if (buf[META_OFFSETS[noteBlockIndex('midi2', 0)]] === 15) ok('P1 pat1 length byte 15 (16 steps)');
  else fail(`P1 pat1 length byte ${buf[META_OFFSETS[noteBlockIndex('midi2', 0)]]} != 15`);
}
{
  // P2 pat8 step 28: the organ pickup e5+a5 (stored +12), gate 4 steps
  const buf = authored.get(10)!;
  const got = decodeNotePattern(buf, 'midi1', 7) as Array<{ active: boolean; notes: Array<{ note: number; gate: number }> }>;
  const s28 = (got[28]?.notes ?? []).map((x) => x.note).sort((a, b) => a - b);
  if (eq(s28, [76, 81]) && got[28].notes.every((x: { gate: number }) => x.gate === 24))
    ok('P2 m25: organ pickup e5+a5 gate 4 steps at pat8 step 28 (stored +12; sounds e4+a4)');
  else fail(`P2 pat8 step 28 [${s28.map(midiName)}] gate ${got[28]?.notes?.[0]?.gate}`);
}
{
  // P7 pat5 (m82, 16 steps): horn triplet snap 8/9/11, step 10 EMPTY
  const buf = authored.get(15)!;
  const got = decodeNotePattern(buf, 'synth1', 4) as Array<{ active: boolean }>;
  const onsets = got.slice(0, 16).flatMap((s, i) => (s.active ? [i] : []));
  if ([8, 9, 11].every((x) => onsets.includes(x)) && !onsets.includes(10))
    ok(`P7 m82: horn triplet fill snapped 8/9.33/10.67 -> 8/9/11 on the device (onsets [${onsets}])`);
  else fail(`P7 pat5 horn onsets [${onsets}]`);
}
{
  // P9 pat5 bar 2 (m108): a @127 horn stack
  const buf = authored.get(17)!;
  const got = decodeNotePattern(buf, 'synth1', 4) as Array<{ active: boolean; notes: Array<{ velocity: number }> }>;
  const has127 = got.slice(16, 32).some((s) => s.active && s.notes.some((x) => x.velocity === 127));
  if (has127) ok('P9 m108: the fff (@127) horn stack is stored');
  else fail('P9 m108 @127 stack missing');
}
{
  // P13: m141 crash (pat5 step 0 note 61), m143 close, m144 silent
  const buf = authored.get(21)!;
  const p5 = decodeNotePattern(buf, 'midi2', 4) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  if ((p5[0]?.notes ?? []).some((x) => x.note === 61)) ok('P13 m141: final crash at pat5 step 0 (midi2 note 61)');
  else fail('P13 m141 crash missing');
  const p6 = decodeNotePattern(buf, 'midi2', 5) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  const m143perc = p6.slice(0, 16).some((s) => (s.notes ?? []).some((x) => x.note === 68));
  const p6s2 = decodeNotePattern(buf, 'synth2', 5) as Array<{ active: boolean }>;
  const m143piano = p6s2.slice(0, 16).some((s) => s.active);
  if (m143perc && m143piano) ok('P13 m143: guiro (perc 68) + piano close stored');
  else fail(`P13 m143 close missing (perc ${m143perc} piano ${m143piano})`);
  let m144 = 0;
  for (const t of NOTE_TRACKS) (decodeNotePattern(buf, t, 5) as Array<{ active: boolean }>).forEach((s, i) => { if (i >= 16 && s.active) m144++; });
  for (let t = 0; t < 4; t++) (decodeDrumPattern(buf, t, 5) as Array<{ active?: boolean }>).forEach((s, i) => { if (i >= 16 && s.active === true) m144++; });
  if (m144 === 0) ok('P13 m144: silent ring-out bar (steps 16-31 empty on every track)');
  else fail(`P13 m144 has ${m144} active steps`);
}
{
  // HAVANA (slot 18): §H rows TOKEN-EXACT via full decode (already asserted in B
  // generically); here the named spot checks + an explicit token-exact statement.
  const buf = authored.get(18)!;
  const riff = decodeNotePattern(buf, 'midi1', 0) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; velocity: number }> }>;
  const onsets = riff.flatMap((s, i) => (s.active ? [i] : []));
  if (eq(onsets, [0, 6, 8, 14, 16, 22, 24, 28, 30]))
    ok('Havana riff onsets 0/6/8/14/16/22/24/28/30 (the habanera cell x2 + turnaround)');
  else fail(`Havana riff onsets [${onsets}]`);
  const s30 = riff[30];
  if (s30.active && eq(s30.notes.map((x) => x.note), [54]) && s30.notes[0].gate === 12 && s30.notes[0].velocity === 100)
    ok('Havana riff step 30 = f#3:2@100 (the leading tone resolving to the wrap\'s g3)');
  else fail(`Havana riff step 30 decode mismatch`);
  const stabs = decodeNotePattern(buf, 'synth1', 0) as Array<{ active: boolean }>;
  if (eq(stabs.flatMap((s, i) => (s.active ? [i] : [])), [6, 14, 22, 28]))
    ok('Havana stabs on the offbeats 6/14/22/28 only');
  else fail('Havana stab steps drifted');
  const m2 = decodeNotePattern(buf, 'midi2', 0) as Array<{ active: boolean; notes: Array<{ note: number }> }>;
  if ((m2[30]?.notes ?? []).some((x) => x.note === 58)) ok('Havana openhat breath at step 30 (midi2 note 58)');
  else fail('Havana openhat breath missing');
}
info(`timbale-fold census: midi2 tom-pad (note 57) hits by slot: ${[...note57BySlot.entries()].map(([s, c]) => `${s}:${c}`).join(' ')} (total ${note57Total}); perc-pad (note 68) hits total ${note68Total}`);
if (tieFallbacks.length > 0) {
  console.log(`\n=== tie-drop fallbacks (${tieFallbacks.length} step(s), documented mechanism) ===`);
  for (const f of tieFallbacks) console.log(`  ${f}`);
}
console.log(`\n${failures === 0 ? 'ALL VERIFICATION CHECKS PASS' : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
