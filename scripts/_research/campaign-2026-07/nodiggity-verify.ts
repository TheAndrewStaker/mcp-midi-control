/**
 * No Diggity post-write verification (read-only, disk only; device captures
 * from the Phase-4 backup sweeps). Run:
 *   npx tsx samples/_scratch/nodiggity-verify.ts
 *
 * Asserts (plan §4 step 11, the Brain Stew slot-36 discipline — read-back is
 * load-bearing, acks do not count):
 *  A. Neighbour identity: pack4 strays 1-2 byte-identical to the 07-29 card
 *     backup; Smooth slots 9 + 21 == smooth-authored-2026-07-30; Love Song
 *     slots 25 + 29 == lovesong-authored-2026-07-30 (nothing moved).
 *  B. Slots 33-36: names @0x10; colour 1 (Rose) @0x0c; tempo 89 @0x34; swing
 *     50; scale 0/15 Chromatic; synth levels 0/0 @0x2701c/d (stored-silent
 *     universal); drum levels 0 x4; binding [1,2,5,11] @0x1a278; scene end
 *     byte 0; chains [0,1] per content track; length bytes 31 x2 (32-step
 *     patterns); **the §H rows decode TOKEN-EXACT on synth1 for P1/P2 (main)
 *     and P3 (drop), re-emitted as token strings and string-compared** (the
 *     §3 row 1 acceptance gate; the decoded rows are printed for the
 *     as-executed quote-back); synth1 EMPTY on P4; synth2 + midi1 EMPTY on
 *     all 4; midi2 per-step (note,vel) pairs == staged folded rows with note
 *     set within {48,50,54}; internal drums == the condense role map
 *     (kick->Drum1, snare->Drum2, hat->Drum3); letter census == staged order
 *     (P4's duplicate window stored as identical patterns).
 *  C. Spot checks (§1/§3): the Drop's beat-cut (pattern 1 = riff ALONE, all
 *     drum lanes silent; pattern 2 fill k-s-k at steps 27/28/29 only); the
 *     HeyYo kick-only bed (midi2 note set {48}, internal Drum1 only, §0b [H]
 *     grid); slot 33 synth1 == slot 34 synth1 (identical §H main rows).
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
const NEW_DIR = `${ROOT}/samples/circuit-ncs/nodiggity-authored-2026-07-30`;
const NB_DIR = `${ROOT}/samples/circuit-ncs/nodiggity-neighbour-pack4-2026-07-30`;
const STAGED = JSON.parse(readFileSync(`${ROOT}/samples/_scratch/nodiggity-staged.json`, 'utf8')) as Array<{
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
const nb = loadDir(NB_DIR);

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
byteIdent('pack4 stray slot 1 vs card-backup-2026-07-29', nb.get(1),
  readFileSync(`${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack4/proj01__00_SESSION.ncs`) as Buffer);
byteIdent('pack4 stray slot 2 vs card-backup-2026-07-29', nb.get(2),
  readFileSync(`${ROOT}/samples/circuit-ncs/card-backup-2026-07-29/pack4/proj02__01_SESSION.ncs`) as Buffer);
const smoothDir = loadDir(`${ROOT}/samples/circuit-ncs/smooth-authored-2026-07-30`);
byteIdent('pack4 slot 9 (Smooth 1 Intro) vs smooth-authored-2026-07-30', nb.get(9), smoothDir.get(9));
byteIdent('pack4 slot 21 (Smooth 13 Outro3) vs smooth-authored-2026-07-30', nb.get(21), smoothDir.get(21));
const lovesongDir = loadDir(`${ROOT}/samples/circuit-ncs/lovesong-authored-2026-07-30`);
byteIdent('pack4 slot 25 (Love Song 1 Intro) vs lovesong-authored-2026-07-30', nb.get(25), lovesongDir.get(25));
byteIdent('pack4 slot 29 (Love Song 5 Chor) vs lovesong-authored-2026-07-30', nb.get(29), lovesongDir.get(29));

// == helpers ==========================================================
const NOTE_TRACKS: NoteTrack[] = ['synth1', 'synth2', 'midi1', 'midi2'];
const NOTE_CHAIN_IDX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
const CHAIN_BASE = 0x2c4;
const MELODIC = new Set(['synth1', 'synth2', 'midi1']);
const GM12: Record<string, number> = { kick: 48, snare: 50, hat: 54 };
/** Internal condense: voice -> drum track index (three voices, three pads, no folds). */
const ROLE_TRACK: Record<string, number> = { kick: 0, snare: 1, hat: 2 };
const chainOf = (buf: Buffer, idx: number): [number, number] => [buf[CHAIN_BASE + idx * 4], buf[CHAIN_BASE + idx * 4 + 1]];
const noteLens = (buf: Buffer, t: NoteTrack, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[noteBlockIndex(t, p)]] + 1);
const drumLens = (buf: Buffer, t: number, n: number): number[] =>
  [...Array(n).keys()].map((p) => buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1);
const midiName = (n: number): string => {
  const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  return NAMES[n % 12] + (Math.floor(n / 12) - 1);
};
/** Re-emit a decoded synth pattern as §H-shaped tokens (pitch:gateSteps@vel). */
const reEmitRow = (buf: Buffer, t: NoteTrack, p: number, steps: number): string => {
  const got = decodeNotePattern(buf, t, p) as Array<{ active: boolean; notes: Array<{ note: number; gate: number; tie: boolean; velocity: number }> }>;
  const toks: string[] = [];
  for (let s = 0; s < steps; s++) {
    const g = got[s];
    if (!g.active || g.notes.length === 0) { toks.push('~'); continue; }
    const parts = g.notes.map((x) => {
      const gate = x.gate % 6 === 0 ? String(x.gate / 6) : `${x.gate}/6`;
      return `${midiName(x.note)}:${gate}@${x.velocity}${x.tie ? '_' : ''}`;
    });
    toks.push(parts.join('+'));
  }
  return toks.join(' ');
};
/** Drum-row hit extraction: `voice@vel` tokens only. */
const rowHits = (row: string): Array<number | undefined> =>
  row.trim().split(/\s+/).map((tok) => {
    if (tok === '~') return undefined;
    const m = /@(\d+)/.exec(tok);
    return m ? Number(m[1]) : 100;
  });

console.log('\n=== B. slots 33-36: header, chains, lengths, full content ===');
const hookQuotes: string[] = [];
for (const st of STAGED) {
  const buf = authored.get(st.slot);
  if (!buf) { fail(`slot ${st.slot}: no capture`); continue; }
  const n = st.order.length;
  console.log(`-- slot ${st.slot} "${st.project_name}" (${n} patterns) --`);
  check(n === 2, `${n} plays`, `slot ${st.slot}: ${n} plays != 2`);
  const name = getProjectName(buf);
  check(name === st.project_name, `name "${name}"`, `slot ${st.slot} name "${name}" != "${st.project_name}"`);
  check(buf[0x0c] === 1, 'colour 1 (Rose)', `slot ${st.slot} colour ${buf[0x0c]} != 1`);
  check(buf[0x34] === 89, 'tempo 89', `slot ${st.slot} tempo ${buf[0x34]} != 89`);
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

  // synth1: TOKEN-EXACT re-emit vs the staged §H rows (string identity)
  if (noteContent.includes('synth1')) {
    for (let p = 0; p < n; p++) {
      asserts++;
      const want = plays[p].voices.synth1!;
      const got = reEmitRow(buf, 'synth1', p, plays[p].steps);
      if (got === want) {
        ok(`synth1 p${p + 1}: §H row decodes TOKEN-EXACT from the card`);
        hookQuotes.push(`slot ${st.slot} p${p + 1} (${plays[p].name}): ${got}`);
      } else fail(`slot ${st.slot} synth1 p${p + 1} TOKEN drift:\n  card: ${got}\n  §H:   ${want}`);
    }
  } else {
    // P4: synth1 must be EMPTY
    let active = 0;
    for (let p = 0; p < n; p++) (decodeNotePattern(buf, 'synth1', p) as Array<{ active: boolean }>).forEach((s) => { if (s.active) active++; });
    check(active === 0, 'synth1 EMPTY (P4 carries no hook)', `slot ${st.slot} synth1 has ${active} active steps`);
  }
  // synth2 + midi1 empty everywhere
  for (const t of ['synth2', 'midi1'] as NoteTrack[]) {
    let active = 0;
    for (let p = 0; p < n; p++) (decodeNotePattern(buf, t, p) as Array<{ active: boolean }>).forEach((s) => { if (s.active) active++; });
    check(active === 0, `${t} EMPTY`, `slot ${st.slot} ${t} has ${active} active steps`);
  }

  // midi2: per-step (note, velocity) pairs from the staged rows
  {
    const ALLOWED_NOTES = new Set(Object.values(GM12));
    const strayNotes = new Set<number>();
    let bad = 0;
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
        for (const [nt] of gotPairs) if (!ALLOWED_NOTES.has(nt)) strayNotes.add(nt);
        if (!eq(gotPairs, expPairs)) {
          bad++; if (bad < 5) fail(`${st.slot}/midi2/p${p + 1}/s${s}: pairs ${JSON.stringify(gotPairs)} != ${JSON.stringify(expPairs)}`);
        }
      }
    }
    if (bad === 0) ok(`midi2: per-step (note,vel) pairs == staged rows (all ${n} patterns)`);
    else fail(`slot ${st.slot} midi2: ${bad} step mismatches`);
    check(strayNotes.size === 0, 'midi2 notes within the +12 set {48,50,54} (kick/snare/hat, the tab\'s whole kit)',
      `slot ${st.slot} midi2 stray notes [${[...strayNotes]}]`);
  }

  // internal drums: condense role map (no folds: 3 voices, 3 pads)
  {
    let bad = 0; let cellCount = 0; let expCells = 0;
    for (let p = 0; p < n; p++) {
      const sec = plays[p];
      const winners = new Map<string, number>();
      for (const [v, row] of Object.entries(sec.voices)) {
        if (MELODIC.has(v)) continue;
        const track = ROLE_TRACK[v];
        if (track === undefined) { fail(`slot ${st.slot}: voice "${v}" has no internal track mapping`); continue; }
        rowHits(row).forEach((vel, s) => { if (vel !== undefined) winners.set(`${track}|${s}`, vel); });
      }
      expCells += winners.size;
      for (let t = 0; t < 4; t++) {
        (decodeDrumPattern(buf, t, p) as Array<{ active?: boolean; velocity?: number }>).forEach((s, i) => {
          if (i >= sec.steps || s.active !== true) return;
          cellCount++;
          const want = winners.get(`${t}|${i}`);
          if (want === undefined) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: hit not in condense map`); }
          else if (want !== s.velocity) { bad++; if (bad < 5) fail(`${st.slot}/drum${t + 1}/p${p + 1}/s${i}: vel ${s.velocity} != ${want}`); }
        });
      }
    }
    check(cellCount === expCells, `internal drums: ${cellCount} cells == condense role map (kick->Drum1, snare->Drum2, hat->Drum3)`,
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

// == C. spot checks (§1/§3) ===========================================
console.log('\n=== C. spot checks ===');
{
  // slot 35 (Drop): pattern 1 = the riff ALONE; pattern 2 = fill k-s-k at 27/28/29 only
  const buf = authored.get(35)!;
  let p1drums = 0;
  (decodeNotePattern(buf, 'midi2', 0) as Array<{ active: boolean }>).forEach((s) => { if (s.active) p1drums++; });
  for (let t = 0; t < 4; t++) (decodeDrumPattern(buf, t, 0) as Array<{ active?: boolean }>).forEach((s) => { if (s.active === true) p1drums++; });
  check(p1drums === 0, 'slot 35 p1 (m41-42): the beat-CUT — riff walks alone, midi2 + all internal drum lanes silent',
    `slot 35 p1 has ${p1drums} drum hits`);
  let p1riff = 0;
  (decodeNotePattern(buf, 'synth1', 0) as Array<{ active: boolean }>).forEach((s) => { if (s.active) p1riff++; });
  check(p1riff > 0, `slot 35 p1: the riff sounds (${p1riff} synth1 onsets) while the beat is cut`, 'slot 35 p1 synth1 empty');
  const p2 = decodeNotePattern(buf, 'midi2', 1) as Array<{ active: boolean; notes: Array<{ note: number; velocity: number }> }>;
  const hits: Array<[number, number, number]> = [];
  p2.forEach((s, i) => { if (i < 32) for (const x of (s.notes ?? [])) hits.push([i, x.note, x.velocity]); });
  check(eq(hits, [[27, 48, 100], [28, 50, 100], [29, 48, 100]]),
    'slot 35 p2: the m44 fill k-s-k at steps 27/28/29 @100, NOTHING else — the throw-back-in',
    `slot 35 p2 midi2 hits ${JSON.stringify(hits)}`);
}
{
  // slot 36 (HeyYo): kick-only chant bed, §0b [H] grid, internal Drum1 only
  const buf = authored.get(36)!;
  const kicks: number[] = [];
  const strays = new Set<number>();
  for (let p = 0; p < 2; p++) {
    (decodeNotePattern(buf, 'midi2', p) as Array<{ active: boolean; notes: Array<{ note: number }> }>).forEach((s, i) => {
      if (i >= 32) return;
      for (const x of (s.notes ?? [])) { if (x.note === 48) kicks.push(p * 32 + i); else strays.add(x.note); }
    });
  }
  const HBAR = [0, 4, 5, 8, 12, 13];
  const wantKicks = [0, 1, 2, 3].flatMap((b) => HBAR.map((s) => b * 16 + s));
  check(strays.size === 0 && eq(kicks, wantKicks),
    'slot 36: kick-ONLY chant bed, §0b [H] grid x4 bars (steps 0/4/5/8/12/13 per bar), no other note',
    `slot 36 kicks [${kicks}] strays [${[...strays]}]`);
  let internal = 0; let d1 = 0;
  for (let p = 0; p < 2; p++) for (let t = 0; t < 4; t++)
    (decodeDrumPattern(buf, t, p) as Array<{ active?: boolean }>).forEach((s) => { if (s.active === true) { internal++; if (t === 0) d1++; } });
  check(internal === d1 && d1 === wantKicks.length, `slot 36 internal: Drum1 only (${d1} cells), Drum2-4 silent`,
    `slot 36 internal ${internal} cells, Drum1 ${d1}`);
}
{
  // slot 33 synth1 == slot 34 synth1 (P1 and P2 ride IDENTICAL §H main rows)
  const b33 = authored.get(33)!; const b34 = authored.get(34)!;
  let same = true;
  for (let p = 0; p < 2; p++) if (reEmitRow(b33, 'synth1', p, 32) !== reEmitRow(b34, 'synth1', p, 32)) same = false;
  check(same, 'slot 33 synth1 == slot 34 synth1 (identical §H main rows, decoded from both cards)',
    'slots 33/34 synth1 decode differently');
}

console.log('\n=== §H quote-back (decoded from the card, token-exact) ===');
for (const q of hookQuotes) console.log(`  ${q}`);
console.log(`\n${failures === 0 ? `ALL VERIFICATION CHECKS PASS (${asserts} tracked asserts)` : failures + ' FAILURES'}`);
process.exitCode = failures === 0 ? 0 : 1;
